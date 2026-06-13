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

import { DEFAULT_EMBEDDING_MODEL_ID, EMBEDDING_DIM } from "@interleave/core";
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
        modelId: "local:embeddinggemma-hash-768",
        dim: EMBEDDING_DIM,
      },
      job.id,
    );
    runner.resolveSucceeded(job.id);

    await expect(promise).resolves.toEqual({ downloaded: false });
    expect(updateAppSettings).not.toHaveBeenCalled();
  });
});
