/**
 * EmbeddingService.embedQuery leak/cleanup tests (T087).
 *
 * The query-embed path rides the runner (the model lives only in the worker) with
 * an explicit short timeout, recovering the vector from a main-side map. These pin
 * the REQUIRED leak guard: a timed-out query (a) returns `null` so `/search` falls
 * back to FTS-only, and (b) its LATE `persist:false` apply result is DROPPED (not
 * stashed) so the `pendingQueryVectors` map never grows across a long session.
 *
 * The runner + settings + repositories are faked (no DB, no real worker) so the
 * timing is deterministic. The fake runner lets the test decide WHEN (and whether)
 * `waitForTerminal` resolves and WHEN the apply result arrives.
 */

import {
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_DIM,
  FALLBACK_EMBEDDING_MODEL_ID,
} from "@interleave/core";
import { describe, expect, it, vi } from "vitest";
import { EmbeddingService } from "./embedding-service";

/** A controllable fake runner: records enqueues + lets the test resolve terminals. */
function makeFakeRunner() {
  let seq = 0;
  const terminals = new Map<string, (value: { status: string }) => void>();
  return {
    enqueued: [] as Array<{ id: string; payload: unknown }>,
    enqueue(_type: string, payload: unknown) {
      seq += 1;
      const id = `q-${seq}`;
      this.enqueued.push({ id, payload });
      return { id };
    },
    waitForTerminal(id: string): Promise<{ status: string }> {
      // Never resolves unless the test explicitly resolves it (simulating a slow
      // model that misses the timeout window).
      return new Promise((resolve) => terminals.set(id, resolve));
    },
    /** Test hook: resolve a job's terminal snapshot as succeeded. */
    resolveSucceeded(id: string) {
      terminals.get(id)?.({ status: "succeeded" });
    },
  };
}

function makeService(runner: ReturnType<typeof makeFakeRunner>) {
  // Minimal fakes — embedQuery only touches getSettings + the runner + the embedding
  // repo's `available` flag.
  return new EmbeddingService({
    db: {} as never,
    repositories: { embeddings: { available: true } } as never,
    getRunner: () => runner as never,
    getSettings: () =>
      ({
        semanticSearchEnabled: true,
        embeddingProvider: "local",
        embeddingApiKey: "",
        embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
        embeddingModelDownloaded: true,
      }) as never,
  });
}

function makeServiceWithSettingsUpdate(
  runner: ReturnType<typeof makeFakeRunner>,
  updateAppSettings = vi.fn(),
) {
  return {
    service: new EmbeddingService({
      db: {} as never,
      repositories: {
        embeddings: { available: true },
        settings: { updateAppSettings },
      } as never,
      getRunner: () => runner as never,
      getSettings: () =>
        ({
          semanticSearchEnabled: true,
          embeddingProvider: "local",
          embeddingApiKey: "",
          embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
          embeddingModelDownloaded: false,
        }) as never,
    }),
    updateAppSettings,
  };
}

describe("EmbeddingService.embedQuery (T087 leak guard)", () => {
  it("returns null on timeout and DROPS the late persist:false result (no map leak)", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    // The runner never resolves within the 800ms window → embedQuery times out.
    const result = await service.embedQuery("scheduling intervals");
    expect(result).toBeNull();

    // The job was enqueued as a transient query job (persist:false).
    expect(runner.enqueued).toHaveLength(1);
    const job = runner.enqueued[0];
    if (!job) throw new Error("expected an enqueued query job");
    expect((job.payload as { persist?: boolean }).persist).toBe(false);

    // The LATE apply result arrives AFTER the timeout — it must be DROPPED, not
    // stashed (the jobId is in the abandoned set), so the map does not retain it.
    const vector = new Array(EMBEDDING_DIM).fill(0.1);
    service.applyResult(
      {
        text: "scheduling intervals",
        modelId: "m",
        provider: "local",
        dim: EMBEDDING_DIM,
        persist: false,
      },
      { vector, modelId: "m", dim: EMBEDDING_DIM },
      job.id,
    );

    // Inspect the private map via a typed cast — it must NOT have grown.
    const pending = (service as unknown as { pendingQueryVectors: Map<string, number[]> })
      .pendingQueryVectors;
    expect(pending.size).toBe(0);
  });

  it("the pending map does not grow across many timed-out queries", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    // Run several queries; each times out (the runner never resolves in-window).
    await Promise.all([0, 1, 2, 3, 4].map((i) => service.embedQuery(`query ${i}`)));
    // Every query timed out; each late result (if any) is dropped. The map stays empty.
    for (const job of runner.enqueued) {
      service.applyResult(
        { text: "x", modelId: "m", provider: "local", dim: EMBEDDING_DIM, persist: false },
        { vector: new Array(EMBEDDING_DIM).fill(0.2), modelId: "m", dim: EMBEDDING_DIM },
        job.id,
      );
    }
    const pending = (service as unknown as { pendingQueryVectors: Map<string, number[]> })
      .pendingQueryVectors;
    expect(pending.size).toBe(0);
  });

  it("returns the recovered vector when the job succeeds before the timeout", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    const promise = service.embedQuery("fast query");
    // Simulate the apply handler stashing the vector, THEN the terminal resolving —
    // the order the real runner guarantees (apply runs before succeed()).
    const vector = new Array(EMBEDDING_DIM).fill(0.3);
    // The enqueue is synchronous; grab the jobId and drive the success path.
    const job = runner.enqueued[0];
    if (!job) throw new Error("expected an enqueued query job");
    service.applyResult(
      { text: "fast query", modelId: "m", provider: "local", dim: EMBEDDING_DIM, persist: false },
      { vector, modelId: "m", dim: EMBEDDING_DIM },
      job.id,
    );
    runner.resolveSucceeded(job.id);

    const result = await promise;
    expect(result).toEqual(vector);
    // The map was cleared after the read (no lingering entry).
    const pending = (service as unknown as { pendingQueryVectors: Map<string, number[]> })
      .pendingQueryVectors;
    expect(pending.size).toBe(0);
  });

  it("the enqueued query payload is local-only and never carries API routing", async () => {
    const runner = makeFakeRunner();
    const service = new EmbeddingService({
      db: {} as never,
      repositories: { embeddings: { available: true } } as never,
      getRunner: () => runner as never,
      getSettings: () =>
        ({
          semanticSearchEnabled: true,
          embeddingProvider: "local",
          embeddingApiKey: "sk-user-own-key",
          embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
          embeddingModelDownloaded: true,
        }) as never,
    });
    // Times out (the fake runner never resolves) but the enqueue still happened.
    await service.embedQuery("semantic query");
    expect(runner.enqueued).toHaveLength(1);
    const payload = runner.enqueued[0]?.payload as {
      apiKey?: string;
      apiModel?: string;
      provider?: string;
    };
    expect(payload.provider).toBe("local");
    expect(payload.apiKey).toBeUndefined();
    expect(payload.apiModel).toBeUndefined();
  });

  it("downloadModel marks downloaded only when the real EmbeddingGemma model answered", async () => {
    const runner = makeFakeRunner();
    const { service, updateAppSettings } = makeServiceWithSettingsUpdate(runner);

    const promise = service.downloadModel();
    const job = runner.enqueued[0];
    if (!job) throw new Error("expected an enqueued warm-up job");
    service.applyResult(
      {
        text: "warm up the on-device embedding model",
        modelId: DEFAULT_EMBEDDING_MODEL_ID,
        provider: "local",
        dim: EMBEDDING_DIM,
        persist: false,
      },
      {
        vector: new Array(EMBEDDING_DIM).fill(0.4),
        modelId: DEFAULT_EMBEDDING_MODEL_ID,
        dim: EMBEDDING_DIM,
      },
      job.id,
    );
    runner.resolveSucceeded(job.id);

    await expect(promise).resolves.toEqual({ downloaded: true });
    expect(updateAppSettings).toHaveBeenCalledWith({
      embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
      embeddingModelDownloaded: true,
    });
  });

  it("downloadModel leaves downloaded false when the worker fell back", async () => {
    const runner = makeFakeRunner();
    const { service, updateAppSettings } = makeServiceWithSettingsUpdate(runner);

    const promise = service.downloadModel();
    const job = runner.enqueued[0];
    if (!job) throw new Error("expected an enqueued warm-up job");
    service.applyResult(
      {
        text: "warm up the on-device embedding model",
        modelId: DEFAULT_EMBEDDING_MODEL_ID,
        provider: "local",
        dim: EMBEDDING_DIM,
        persist: false,
      },
      {
        vector: new Array(EMBEDDING_DIM).fill(0.5),
        modelId: FALLBACK_EMBEDDING_MODEL_ID,
        dim: EMBEDDING_DIM,
      },
      job.id,
    );
    runner.resolveSucceeded(job.id);

    await expect(promise).resolves.toEqual({ downloaded: false });
    expect(updateAppSettings).not.toHaveBeenCalled();
  });
});

describe("EmbeddingService query-embedding cache (U2)", () => {
  /**
   * Drive the LAST enqueued query job to a successful terminal under `modelId`, so the
   * recovered vector is returned and (for a real model) cached. Mirrors the order the
   * real runner guarantees: apply stashes the vector, THEN the terminal resolves.
   */
  function settleQuery(
    runner: ReturnType<typeof makeFakeRunner>,
    service: EmbeddingService,
    text: string,
    modelId: string,
    vector: number[],
  ): void {
    const job = runner.enqueued.at(-1);
    if (!job) throw new Error("expected an enqueued query job");
    service.applyResult(
      { text, modelId, provider: "local", dim: EMBEDDING_DIM, persist: false },
      { vector, modelId, dim: EMBEDDING_DIM },
      job.id,
    );
    runner.resolveSucceeded(job.id);
  }

  it("misses then hits: a repeat query returns the cached vector WITHOUT enqueueing", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    const vector = new Array(EMBEDDING_DIM).fill(0.7);
    const first = service.embedQueryResult("foo");
    settleQuery(runner, service, "foo", DEFAULT_EMBEDDING_MODEL_ID, vector);
    await expect(first).resolves.toMatchObject({ vector, modelId: DEFAULT_EMBEDDING_MODEL_ID });
    expect(runner.enqueued).toHaveLength(1);

    // Second identical call is a cache hit: no new enqueue, no timeout race needed.
    await expect(service.embedQueryResult("foo")).resolves.toMatchObject({
      vector,
      modelId: DEFAULT_EMBEDDING_MODEL_ID,
    });
    expect(runner.enqueued).toHaveLength(1);
  });

  it("the model probe bypasses the cache and always does a LIVE embed", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);
    // The fixed probe text — a normal query for it WOULD be cacheable.
    const probeText = "warm up the on-device embedding model";

    // Warm the cache for the probe text via a normal (cacheable) query.
    const warm = service.embedQueryResult(probeText);
    settleQuery(
      runner,
      service,
      probeText,
      DEFAULT_EMBEDDING_MODEL_ID,
      new Array(EMBEDDING_DIM).fill(0.2),
    );
    await warm;
    expect(runner.enqueued).toHaveLength(1);

    // A forced probe must NOT short-circuit on the cached vector — its job is to report
    // the model's CURRENT real/fallback state, which a stale cache would mask. It enqueues
    // a fresh live embed instead.
    const probe = service.probeModelState({ force: true });
    expect(runner.enqueued).toHaveLength(2);
    settleQuery(
      runner,
      service,
      probeText,
      DEFAULT_EMBEDDING_MODEL_ID,
      new Array(EMBEDDING_DIM).fill(0.2),
    );
    await expect(probe).resolves.toBe("ready");
  });

  it("normalizes the key: '  Foo  ' and 'foo' share one cache entry", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    const vector = new Array(EMBEDDING_DIM).fill(0.8);
    const first = service.embedQueryResult("  Foo  ");
    settleQuery(runner, service, "  Foo  ", DEFAULT_EMBEDDING_MODEL_ID, vector);
    await first;
    expect(runner.enqueued).toHaveLength(1);

    // Different casing/whitespace normalizes to the same key → hit, no new enqueue.
    await expect(service.embedQueryResult("foo")).resolves.toMatchObject({
      vector,
      modelId: DEFAULT_EMBEDDING_MODEL_ID,
    });
    expect(runner.enqueued).toHaveLength(1);
  });

  it("does NOT cache a fallback-model result: a subsequent identical call re-enqueues", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    const vector = new Array(EMBEDDING_DIM).fill(0.9);
    const first = service.embedQueryResult("bar");
    settleQuery(runner, service, "bar", FALLBACK_EMBEDDING_MODEL_ID, vector);
    await expect(first).resolves.toMatchObject({ vector, modelId: FALLBACK_EMBEDDING_MODEL_ID });
    expect(runner.enqueued).toHaveLength(1);

    // Fallback was returned but not cached → the next identical call enqueues again.
    const second = service.embedQueryResult("bar");
    expect(runner.enqueued).toHaveLength(2);
    settleQuery(runner, service, "bar", FALLBACK_EMBEDDING_MODEL_ID, vector);
    await second;
  });

  it("a fallback result then a real result for the same text populates the cache", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    // First answer falls back → not cached.
    const fb = service.embedQueryResult("baz");
    settleQuery(
      runner,
      service,
      "baz",
      FALLBACK_EMBEDDING_MODEL_ID,
      new Array(EMBEDDING_DIM).fill(0.1),
    );
    await fb;
    expect(runner.enqueued).toHaveLength(1);

    // Same text re-enqueues; this time the real model answers → cached.
    const realVector = new Array(EMBEDDING_DIM).fill(0.2);
    const real = service.embedQueryResult("baz");
    expect(runner.enqueued).toHaveLength(2);
    settleQuery(runner, service, "baz", DEFAULT_EMBEDDING_MODEL_ID, realVector);
    await real;

    // Now it's a hit: no third enqueue.
    await expect(service.embedQueryResult("baz")).resolves.toMatchObject({
      vector: realVector,
      modelId: DEFAULT_EMBEDDING_MODEL_ID,
    });
    expect(runner.enqueued).toHaveLength(2);
  });

  it("clears the whole cache on a model-id change so no cross-model vector is served", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);
    const modelA = "model-a";
    const modelB = "model-b";

    // Cache "alpha" under model A.
    const a = service.embedQueryResult("alpha");
    settleQuery(runner, service, "alpha", modelA, new Array(EMBEDDING_DIM).fill(0.3));
    await a;
    expect(runner.enqueued).toHaveLength(1);

    // A different text answers under model B → the model-space changed, so A's entry is dropped.
    const b = service.embedQueryResult("beta");
    settleQuery(runner, service, "beta", modelB, new Array(EMBEDDING_DIM).fill(0.4));
    await b;
    expect(runner.enqueued).toHaveLength(2);

    // "alpha" must now MISS (its model-A vector was cleared) and re-embed under model B.
    const aAgain = service.embedQueryResult("alpha");
    expect(runner.enqueued).toHaveLength(3);
    settleQuery(runner, service, "alpha", modelB, new Array(EMBEDDING_DIM).fill(0.5));
    await aAgain;
  });

  it("is bounded: exceeding the cap evicts the oldest entry (it misses again)", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);
    const cap = (service as unknown as { queryVectorCache: Map<string, unknown> }).queryVectorCache;
    // Read the cap off the service's behavior by overflowing it; the constant is 256.
    const QUERY_CACHE_MAX = 256;

    // Fill the cache to exactly the cap with unique keys.
    for (let i = 0; i < QUERY_CACHE_MAX; i += 1) {
      const text = `q${i}`;
      const p = service.embedQueryResult(text);
      settleQuery(
        runner,
        service,
        text,
        DEFAULT_EMBEDDING_MODEL_ID,
        new Array(EMBEDDING_DIM).fill(0.01 * i),
      );
      await p;
    }
    expect(cap.size).toBe(QUERY_CACHE_MAX);
    const enqueuedAtCap = runner.enqueued.length;

    // Insert one more unique key → evicts the OLDEST ("q0").
    const overflow = service.embedQueryResult("overflow");
    settleQuery(
      runner,
      service,
      "overflow",
      DEFAULT_EMBEDDING_MODEL_ID,
      new Array(EMBEDDING_DIM).fill(0.99),
    );
    await overflow;
    expect(cap.size).toBe(QUERY_CACHE_MAX);
    expect(runner.enqueued).toHaveLength(enqueuedAtCap + 1);

    // "q0" was evicted → it MISSES and re-enqueues; a still-resident key ("q255") HITS.
    const evicted = service.embedQueryResult("q0");
    expect(runner.enqueued).toHaveLength(enqueuedAtCap + 2);
    settleQuery(
      runner,
      service,
      "q0",
      DEFAULT_EMBEDDING_MODEL_ID,
      new Array(EMBEDDING_DIM).fill(0.0),
    );
    await evicted;

    const stillEnqueued = runner.enqueued.length;
    await service.embedQueryResult(`q${QUERY_CACHE_MAX - 1}`);
    expect(runner.enqueued).toHaveLength(stillEnqueued);
  });

  it("does NOT cache a timed-out (null) query: a later call retries", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    // The runner never resolves in-window → timeout → null, not cached.
    await expect(service.embedQueryResult("never")).resolves.toBeNull();
    expect(runner.enqueued).toHaveLength(1);

    // A later identical call retries (enqueues again); this time it succeeds and caches.
    const vector = new Array(EMBEDDING_DIM).fill(0.6);
    const retry = service.embedQueryResult("never");
    expect(runner.enqueued).toHaveLength(2);
    settleQuery(runner, service, "never", DEFAULT_EMBEDDING_MODEL_ID, vector);
    await expect(retry).resolves.toMatchObject({ vector, modelId: DEFAULT_EMBEDDING_MODEL_ID });

    // Now it's warm: a third call hits, no new enqueue.
    await service.embedQueryResult("never");
    expect(runner.enqueued).toHaveLength(2);
  });

  it("a cache hit enqueues NO embed job (ties to the index-health guarantee)", async () => {
    const runner = makeFakeRunner();
    const service = makeService(runner);

    const vector = new Array(EMBEDDING_DIM).fill(0.42);
    const first = service.embedQueryResult("indexed?");
    settleQuery(runner, service, "indexed?", DEFAULT_EMBEDDING_MODEL_ID, vector);
    await first;
    const enqueuedAfterMiss = runner.enqueued.length;

    // Several warm repeats — none may enqueue an embed job.
    await service.embedQueryResult("indexed?");
    await service.embedQueryResult("  INDEXED?  ");
    expect(runner.enqueued).toHaveLength(enqueuedAfterMiss);
  });
});

describe("EmbeddingService.probeModelState (U1 honest probe)", () => {
  /** Drive a probe to a terminal result by stashing the apply result then resolving. */
  function settleProbe(
    runner: ReturnType<typeof makeFakeRunner>,
    service: EmbeddingService,
    modelId: string,
  ): void {
    const job = runner.enqueued.at(-1);
    if (!job) throw new Error("expected a probe job to be enqueued");
    service.applyResult(
      { text: "probe", modelId, provider: "local", dim: EMBEDDING_DIM, persist: false },
      { vector: new Array(EMBEDDING_DIM).fill(0.4), modelId, dim: EMBEDDING_DIM },
      job.id,
    );
    runner.resolveSucceeded(job.id);
  }

  it("returns 'ready' when the real model answers and reconciles downloaded=true", async () => {
    const runner = makeFakeRunner();
    const { service, updateAppSettings } = makeServiceWithSettingsUpdate(runner);
    const promise = service.probeModelState({ force: true });
    settleProbe(runner, service, DEFAULT_EMBEDDING_MODEL_ID);
    await expect(promise).resolves.toBe("ready");
    expect(updateAppSettings).toHaveBeenCalledWith({
      embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
      embeddingModelDownloaded: true,
    });
  });

  it("returns 'fallback' when the worker fell back and leaves downloaded false", async () => {
    const runner = makeFakeRunner();
    const { service, updateAppSettings } = makeServiceWithSettingsUpdate(runner);
    const promise = service.probeModelState({ force: true });
    settleProbe(runner, service, FALLBACK_EMBEDDING_MODEL_ID);
    await expect(promise).resolves.toBe("fallback");
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("returns 'loading' on a slow cold load instead of a false 'fallback'", async () => {
    const runner = makeFakeRunner();
    const { service } = makeServiceWithSettingsUpdate(runner);
    // The terminal never resolves; a short probe timeout simulates the in-flight window.
    // The 800ms query timeout is NOT used — the probe owns its own (here: tiny) timeout.
    await expect(service.probeModelState({ force: true, timeoutMs: 20 })).resolves.toBe("loading");
  });

  it("caches a terminal result so it is not re-probed within the session", async () => {
    const runner = makeFakeRunner();
    const { service } = makeServiceWithSettingsUpdate(runner);
    const promise = service.probeModelState();
    settleProbe(runner, service, DEFAULT_EMBEDDING_MODEL_ID);
    await expect(promise).resolves.toBe("ready");

    const enqueuedBefore = runner.enqueued.length;
    await expect(service.probeModelState()).resolves.toBe("ready");
    expect(runner.enqueued).toHaveLength(enqueuedBefore);
  });
});

describe("EmbeddingService.applyResult (U1 R10 no-poison guard)", () => {
  function makeIndexService(upsert = vi.fn()) {
    const runner = makeFakeRunner();
    const service = new EmbeddingService({
      db: {} as never,
      repositories: { embeddings: { available: true, upsert } } as never,
      getRunner: () => runner as never,
      getSettings: () => ({ embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID }) as never,
    });
    return { service, upsert };
  }
  const indexPayload = (modelId: string) =>
    ({
      text: "t",
      modelId,
      provider: "local",
      dim: EMBEDDING_DIM,
      elementId: "el_1",
      elementType: "extract",
      contentHash: "h",
      persist: true,
    }) as const;

  it("does NOT upsert a fallback (hash) vector — leaves the element unembedded", () => {
    const { service, upsert } = makeIndexService();
    const out = service.applyResult(
      indexPayload(FALLBACK_EMBEDDING_MODEL_ID),
      {
        vector: new Array(EMBEDDING_DIM).fill(0.1),
        modelId: FALLBACK_EMBEDDING_MODEL_ID,
        dim: EMBEDDING_DIM,
      },
      "j-1",
    );
    expect(upsert).not.toHaveBeenCalled();
    expect(out.modelId).toBe(FALLBACK_EMBEDDING_MODEL_ID);
    expect(out.elementId).toBe("el_1");
  });

  it("upserts a real-model vector", () => {
    const { service, upsert } = makeIndexService();
    service.applyResult(
      indexPayload(DEFAULT_EMBEDDING_MODEL_ID),
      {
        vector: new Array(EMBEDDING_DIM).fill(0.1),
        modelId: DEFAULT_EMBEDDING_MODEL_ID,
        dim: EMBEDDING_DIM,
      },
      "j-2",
    );
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});

describe("EmbeddingService.etaSeconds (U2)", () => {
  function svcWith(timestamps: number[]) {
    const service = makeService(makeFakeRunner());
    (service as unknown as { completionTimestamps: number[] }).completionTimestamps.push(
      ...timestamps,
    );
    return service;
  }

  it("returns 0 when nothing remains", () => {
    expect(svcWith([]).etaSeconds(0)).toBe(0);
  });

  it("returns null with fewer than 3 samples", () => {
    expect(svcWith([1000, 2000]).etaSeconds(10)).toBeNull();
  });

  it("returns null when all samples share a timestamp (zero span)", () => {
    expect(svcWith([5000, 5000, 5000]).etaSeconds(10)).toBeNull();
  });

  it("returns a positive estimate from the observed completion rate", () => {
    // 3 samples over 2000ms -> 0.001 completions/ms -> 10 remaining ~= 10s.
    expect(svcWith([1000, 2000, 3000]).etaSeconds(10)).toBe(10);
  });
});

describe("EmbeddingService.probeModelState reconcile (U1)", () => {
  it("flips downloaded=false when a previously-ready model degrades to fallback", async () => {
    const runner = makeFakeRunner();
    const updateAppSettings = vi.fn();
    const service = new EmbeddingService({
      db: {} as never,
      repositories: { embeddings: { available: true }, settings: { updateAppSettings } } as never,
      getRunner: () => runner as never,
      getSettings: () =>
        ({
          semanticSearchEnabled: true,
          embeddingProvider: "local",
          embeddingApiKey: "",
          embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
          embeddingModelDownloaded: true,
        }) as never,
    });
    const promise = service.probeModelState({ force: true });
    const job = runner.enqueued.at(-1);
    if (!job) throw new Error("expected a probe job");
    service.applyResult(
      {
        text: "x",
        modelId: FALLBACK_EMBEDDING_MODEL_ID,
        provider: "local",
        dim: EMBEDDING_DIM,
        persist: false,
      },
      {
        vector: new Array(EMBEDDING_DIM).fill(0.5),
        modelId: FALLBACK_EMBEDDING_MODEL_ID,
        dim: EMBEDDING_DIM,
      },
      job.id,
    );
    runner.resolveSucceeded(job.id);
    await expect(promise).resolves.toBe("fallback");
    expect(updateAppSettings).toHaveBeenCalledWith({ embeddingModelDownloaded: false });
  });
});
