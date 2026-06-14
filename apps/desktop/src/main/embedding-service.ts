/**
 * EmbeddingService (T087) — the main-side semantic-embedding orchestrator.
 *
 * The OcrService twin for embeddings. Embeddings run on the T058 background runner:
 * a DB-FREE `utilityProcess` worker computes a local vector and posts it back; THIS
 * service is the main-owned glue:
 *
 *  - {@link buildText} — MAIN reads the DB and builds the pure text to embed per
 *    type (source: title + bounded `documents.plain_text`; extract: title +
 *    `source_locations.selected_text`; card: prompt/cloze + answer), so the worker
 *    stays DB-free (it only sees text in the payload).
 *  - {@link enqueueElement} — compute the content hash; skip if unchanged
 *    (`needsEmbedding`), else `enqueue("embed", …)`.
 *  - {@link reindexAll} — enqueue `embed` jobs for every live source/extract/card
 *    that needs (re-)embedding (the `semantic.reindex` build-the-index path).
 *  - {@link applyResult} — the runner's SINGLE `embed` apply handler. It branches on
 *    `payload.persist`: the normal index path (`persist !== false`) UPSERTs the
 *    vector into the `vec0` store (idempotent by element); the transient QUERY path
 *    (`persist === false`) does NOT upsert — it stashes the vector in
 *    `pendingQueryVectors` for {@link embedQuery} to read (or DROPS it if the job
 *    was abandoned on timeout). One handler, one `persist` branch.
 *  - {@link embedQuery} — embed a query string via a transient `persist:false` job,
 *    recovering the vector from the main-side map (because `waitForTerminal`
 *    resolves with the persisted `Job` snapshot, NOT the apply return value), with
 *    an explicit short timeout so `/search` never hangs.
 *  - {@link downloadModel} — pre-warm the local model and flip
 *    `embeddingModelDownloaded`; degrades to the deterministic embedder offline.
 *
 * Embeddings append NO `operation_log` (a derived index, like FTS5). The worker
 * NEVER opens the DB or loads `sqlite-vec`; main is the single writer.
 *
 * SECURITY: the enqueued/persisted `embed` payload carries no secret and no remote
 * endpoint. Semantic embeddings are local-only.
 */

import { createHash } from "node:crypto";
import type { ElementId } from "@interleave/core";
import {
  type AppSettings,
  DEFAULT_EMBEDDING_MODEL_ID,
  EMBEDDING_DIM,
  FALLBACK_EMBEDDING_MODEL_ID,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { cards, documents, elements, sourceLocations } from "@interleave/db";
import type { EmbeddableType, Repositories } from "@interleave/local-db";
import { eq } from "drizzle-orm";
import type { SemanticModelState } from "../shared/contract";
import type { JobRunner } from "./job-runner";

/** Max characters of text fed to the embedder (≈512 tokens) so a huge source is bounded. */
const MAX_EMBED_CHARS = 2_000;
/** Default cap on how many elements one `reindexAll` enqueues (the runner concurrency drains them). */
const REINDEX_BATCH_LIMIT = 5_000;
/** How long `embedQuery` waits for the transient embed job before falling back to FTS-only. */
const QUERY_EMBED_TIMEOUT_MS = 800;
/**
 * How long the model PROBE waits — deliberately NOT the 800ms query timeout. A cold
 * EmbeddingGemma load takes seconds, so a short timeout would misread a healthy model
 * as `fallback`/`loading`. The probe runs off the hot path (launch/supervisor), so a
 * generous ceiling is fine.
 */
const PROBE_EMBED_TIMEOUT_MS = 60_000;
/** The fixed text used to probe / warm up the on-device model. */
const PROBE_TEXT = "warm up the on-device embedding model";
/** Belt-and-braces cap on the pending-query map so a pathological run can't grow it unbounded. */
const PENDING_QUERY_MAX = 64;
/**
 * Cap on the in-memory query-embedding cache (U2). Bounded, insertion-ordered LRU-ish:
 * once full, inserting evicts the oldest key. Repeat query embeds (backspace/retype,
 * re-runs, the palette's tight loop) then hit instantly instead of churning the worker.
 */
const QUERY_CACHE_MAX = 256;
/**
 * Defensive bound on a cache key's length. A normalized query is already short, but a
 * pathological multi-KB "query" must not bloat the cache key; trimming the key only loses
 * cache precision for absurd inputs, never correctness (the embed still uses the full text).
 */
const QUERY_CACHE_KEY_MAX = 512;
/** Rolling window of recent embed completions kept for the ETA estimate. */
const ETA_WINDOW = 20;
/** Minimum completion samples before an ETA is meaningful (else `null`). */
const ETA_MIN_SAMPLES = 3;

/**
 * The `embed` job payload MAIN enqueues + persists. `persist:false` marks the
 * transient query path. NOTE: this payload carries NO secret — the user's API key
 * is threaded out-of-band by the runner's {@link JobSecretsProvider} at post time
 * (read live from settings) so it never lands in the restart-safe `jobs` row.
 */
export interface EmbedJobPayload {
  readonly text: string;
  readonly modelId: string;
  readonly provider: "local";
  readonly dim: number;
  /** Present for the INDEX path (the element to UPSERT); absent for the query path. */
  readonly elementId?: string;
  readonly elementType?: EmbeddableType;
  readonly contentHash?: string;
  /** `false` = the transient query path (return the vector, do NOT upsert). */
  readonly persist?: boolean;
}

/** The worker's `embed` result `data` shape (validated at this apply boundary). */
export interface EmbedResultData {
  readonly vector: number[];
  readonly modelId: string;
  readonly dim: number;
}

export interface QueryEmbeddingResult {
  readonly vector: number[];
  readonly modelId: string;
}

/** Constructor dependencies (built lazily against the open DB). */
export interface EmbeddingServiceDeps {
  readonly db: InterleaveDatabase;
  readonly repositories: Repositories;
  readonly getRunner: () => JobRunner;
  readonly getSettings: () => AppSettings;
}

export class EmbeddingService {
  private readonly db: InterleaveDatabase;
  private readonly repositories: Repositories;
  private readonly getRunner: () => JobRunner;
  private readonly getSettings: () => AppSettings;
  /** Vectors recovered from the transient query embed jobs, keyed by jobId. */
  private readonly pendingQueryVectors = new Map<string, QueryEmbeddingResult>();
  /** Query jobIds whose waiter timed out — their late result is DROPPED, not stashed. */
  private readonly abandonedQueries = new Set<string>();
  /** Cached terminal model state from the last probe (`ready`/`fallback`); undefined until probed. */
  private modelStateCache: SemanticModelState | undefined;
  /**
   * In-memory query-text→vector cache (U2). Bounded + insertion-ordered (oldest evicted
   * past {@link QUERY_CACHE_MAX}). It only ever holds vectors from the single CURRENT
   * real-model space — never a {@link FALLBACK_EMBEDDING_MODEL_ID} vector — and is dropped
   * whole on a model-id change (see {@link cacheModelId}). That invariant is what makes a
   * cache hit always safe to return directly: an embedding belongs to the model that
   * produced it, and equal vector length is NOT cross-model comparability.
   */
  private readonly queryVectorCache = new Map<string, QueryEmbeddingResult>();
  /** The real-model id the {@link queryVectorCache} currently holds, or `null` when empty. */
  private cacheModelId: string | null = null;
  /** Recent index-embed completion epoch-ms (rolling window) — the in-memory ETA source (U2). */
  private readonly completionTimestamps: number[] = [];

  /** The last probed model state, or `null` if not probed yet (cheap read for the status surface). */
  get cachedModelState(): SemanticModelState | null {
    return this.modelStateCache ?? null;
  }

  constructor(deps: EmbeddingServiceDeps) {
    this.db = deps.db;
    this.repositories = deps.repositories;
    this.getRunner = deps.getRunner;
    this.getSettings = deps.getSettings;
  }

  /** Whether the `vec0` store is usable (the embedding repo knows). */
  get available(): boolean {
    return this.repositories.embeddings.available;
  }

  /**
   * Build the pure text to embed for an element, mirroring what the FTS triggers
   * index so keyword + semantic cover the same content. Returns `null` for a
   * non-embeddable / missing element. Bounded to {@link MAX_EMBED_CHARS}.
   */
  buildText(elementId: ElementId): { type: EmbeddableType; text: string } | null {
    const el = this.db
      .select({ type: elements.type, title: elements.title, deletedAt: elements.deletedAt })
      .from(elements)
      .where(eq(elements.id, elementId))
      .get();
    if (!el || el.deletedAt) return null;
    const title = el.title ?? "";

    if (el.type === "source") {
      const doc = this.db
        .select({ plainText: documents.plainText })
        .from(documents)
        .where(eq(documents.elementId, elementId))
        .get();
      return { type: "source", text: bound(`${title}\n${doc?.plainText ?? ""}`) };
    }
    if (el.type === "extract") {
      const loc = this.db
        .select({ selectedText: sourceLocations.selectedText })
        .from(sourceLocations)
        .where(eq(sourceLocations.elementId, elementId))
        .get();
      return { type: "extract", text: bound(`${title}\n${loc?.selectedText ?? ""}`) };
    }
    if (el.type === "card") {
      const card = this.db
        .select({ prompt: cards.prompt, answer: cards.answer, cloze: cards.cloze })
        .from(cards)
        .where(eq(cards.elementId, elementId))
        .get();
      const parts = [title, card?.prompt ?? "", card?.cloze ?? "", card?.answer ?? ""].filter(
        (p) => p.length > 0,
      );
      return { type: "card", text: bound(parts.join("\n")) };
    }
    return null;
  }

  /**
   * Enqueue an `embed` job for `elementId` if it needs (re-)embedding. Returns
   * `{ skipped: true }` when vec is unavailable / the text
   * is empty / the content hash is unchanged; else `{ jobId }`. The provider/model
   * come from settings main-side.
   */
  enqueueElement(elementId: ElementId): { jobId: string } | { skipped: true } {
    const settings = this.getSettings();
    if (!this.available) return { skipped: true };

    const built = this.buildText(elementId);
    if (!built || built.text.trim().length === 0) return { skipped: true };

    const contentHash = sha256(built.text);
    const modelId = settings.embeddingModelId;
    if (!this.repositories.embeddings.needsEmbedding(elementId, contentHash, modelId)) {
      return { skipped: true };
    }

    const payload = this.indexPayload({
      elementId,
      elementType: built.type,
      text: built.text,
      contentHash,
      settings,
    });
    const job = this.getRunner().enqueue("embed", { ...payload });
    return { jobId: job.id };
  }

  /**
   * Enqueue `embed` jobs for every live source/extract/card that needs embedding
   * (the "build the index" path `semantic.reindex` calls). Returns the count
   * enqueued. A no-op (0) when vec is unavailable. `onlyMissing`
   * is honored by `needsEmbedding` either way (a current row is always skipped), so
   * the flag is informational — both paths skip unchanged content.
   */
  reindexAll(_options: { onlyMissing?: boolean } = {}): { enqueued: number } {
    if (!this.available) return { enqueued: 0 };

    // Select rows that actually NEED embedding (missing or model-mismatched), capped
    // at the batch limit. This is progress-guaranteed (R11): unlike a blind LIMIT over
    // all elements, a corpus larger than the cap converges across successive passes
    // because already-current rows are never re-selected.
    const settings = this.getSettings();
    // Exclude elements that already have an in-flight (queued/running) or failed embed
    // job (U4): never double-queue a draining element (e.g. a manual Rebuild racing a
    // supervisor batch), and never auto-re-enqueue a deterministically-failing element
    // every pass — it stays visible/failed until the user explicitly retries.
    const excludeElementIds = this.repositories.jobs.activeOrFailedEmbedElementIds();
    const rows = this.repositories.embeddings.listNeedingEmbedding(
      settings.embeddingModelId,
      REINDEX_BATCH_LIMIT,
      excludeElementIds,
    );

    let enqueued = 0;
    for (const row of rows) {
      const result = this.enqueueElement(row.id);
      if ("jobId" in result) enqueued += 1;
    }
    return { enqueued };
  }

  /**
   * The runner's SINGLE `embed` apply handler. Branches on `payload.persist`:
   *  - INDEX path (`persist !== false`): validate the vector length === dim, then
   *    UPSERT into the `vec0` store (idempotent by element). Returns a small summary.
   *  - QUERY path (`persist === false`): do NOT upsert. If the jobId was abandoned
   *    on timeout, DROP the vector (clearing the abandoned flag) so the map never
   *    leaks; else stash it in `pendingQueryVectors` (bounded) for `embedQuery`.
   * Same function, one branch — there is exactly one `embed` handler.
   */
  applyResult(
    payload: EmbedJobPayload,
    result: EmbedResultData,
    jobId: string,
  ): { elementId?: string; modelId: string } {
    if (payload.persist === false) {
      // Transient query path: recover or drop, never persist.
      if (this.abandonedQueries.has(jobId)) {
        this.abandonedQueries.delete(jobId);
      } else {
        this.stashQueryVector(jobId, result);
      }
      return { modelId: result.modelId };
    }

    // Normal index path: persist the vector for the element.
    if (!payload.elementId || !payload.elementType || !payload.contentHash) {
      throw new Error("EmbeddingService.applyResult: index payload missing element fields");
    }
    // R10 — the no-poison guard. The worker decides real-vs-fallback PER JOB, so a job
    // enqueued while the model was ready can still come back from the deterministic hash
    // embedder (model evicted/failed mid-session). NEVER persist a fallback vector into the
    // index: skip the upsert and leave the element unembedded so a later pass re-embeds it
    // once the real model is back. This makes index poisoning structurally impossible,
    // independent of the launch-time gate.
    if (result.modelId === FALLBACK_EMBEDDING_MODEL_ID) {
      return { elementId: payload.elementId, modelId: result.modelId };
    }
    if (result.vector.length !== result.dim || result.dim !== EMBEDDING_DIM) {
      throw new Error(
        `EmbeddingService.applyResult: vector dim ${result.vector.length}/${result.dim} ` +
          `!= column dim ${EMBEDDING_DIM}`,
      );
    }
    this.repositories.embeddings.upsert({
      elementId: payload.elementId as ElementId,
      elementType: payload.elementType,
      modelId: result.modelId,
      dim: result.dim,
      contentHash: payload.contentHash,
      vector: result.vector,
    });
    this.recordEmbedCompletion();
    return { elementId: payload.elementId, modelId: result.modelId };
  }

  /** Record a successful index-embed completion for the rolling ETA estimate (U2). */
  private recordEmbedCompletion(): void {
    this.completionTimestamps.push(Date.now());
    if (this.completionTimestamps.length > ETA_WINDOW) this.completionTimestamps.shift();
  }

  /**
   * Estimate seconds-to-complete for `remaining` unembedded elements from the
   * observed completion rate (U2). Returns `null` until there are enough samples
   * (the estimate would be noise before then). The observed rate already reflects
   * runner concurrency, so no concurrency division is needed.
   */
  etaSeconds(remaining: number): number | null {
    if (remaining <= 0) return 0;
    const ts = this.completionTimestamps;
    const n = ts.length;
    if (n < ETA_MIN_SAMPLES) return null;
    const first = ts[0];
    const last = ts[n - 1];
    if (first === undefined || last === undefined) return null;
    const spanMs = last - first;
    if (spanMs <= 0) return null;
    const ratePerMs = (n - 1) / spanMs;
    if (ratePerMs <= 0) return null;
    return Math.max(0, Math.round(remaining / ratePerMs / 1000));
  }

  /**
   * Embed a query string for semantic search. Because the model lives only in the
   * worker, this enqueues a TRANSIENT `embed` job with `persist:false` (so the same
   * apply handler returns the vector WITHOUT upserting an embeddings row). The
   * vector reaches us via the main-side `pendingQueryVectors` map (NOT the `Job`
   * row — `waitForTerminal` resolves with the persisted snapshot, which does not
   * carry the apply return value). We race `waitForTerminal(jobId)` against an
   * explicit short timeout; on timeout/non-success we record the jobId as abandoned
   * (so the late apply result is dropped, not leaked) and return `null` so the
   * caller falls back to FTS-only — `/search` never hangs.
   */
  async embedQuery(text: string): Promise<number[] | null> {
    const result = await this.embedQueryResult(text);
    return result?.vector ?? null;
  }

  async embedQueryResult(
    text: string,
    timeoutMs: number = QUERY_EMBED_TIMEOUT_MS,
    opts?: { useCache?: boolean },
  ): Promise<QueryEmbeddingResult | null> {
    const settings = this.getSettings();
    if (!this.available) return null;
    if (text.trim().length === 0) return null;

    // U2 cache: a warm key returns instantly — NO enqueue (so it cannot read as
    // "index building" per commit 49fe02e4) and NO 800ms timeout race. The cache only
    // ever holds vectors from the single current real-model space (cleared on a model-id
    // change), so a hit is always safe to return directly. The model PROBE opts out
    // (`useCache: false`) so it always does a LIVE embed — its whole job is to report
    // the model's CURRENT real/fallback/loading state, which a cached vector would mask.
    const useCache = opts?.useCache !== false;
    const cacheKey = queryCacheKey(text);
    if (useCache) {
      const cached = this.queryVectorCache.get(cacheKey);
      if (cached) return cached;
    }

    const payload: EmbedJobPayload = {
      text: bound(text),
      modelId: settings.embeddingModelId,
      provider: "local",
      dim: EMBEDDING_DIM,
      persist: false,
    };
    const job = this.getRunner().enqueue("embed", { ...payload });

    const terminal = await Promise.race([
      this.getRunner().waitForTerminal(job.id as never),
      delay(timeoutMs).then(() => "timeout" as const),
    ]);

    if (terminal === "timeout" || terminal.status !== "succeeded") {
      // The waiter gave up; the late persist:false apply result must be dropped.
      // A null/timeout result is NEVER cached — a later call retries.
      this.abandonedQueries.add(job.id);
      this.pendingQueryVectors.delete(job.id);
      return null;
    }
    const result = this.pendingQueryVectors.get(job.id) ?? null;
    this.pendingQueryVectors.delete(job.id);
    if (result && useCache) this.cacheQueryVector(cacheKey, result);
    return result;
  }

  /**
   * Populate the query cache from a recovered terminal vector (U2). A
   * {@link FALLBACK_EMBEDDING_MODEL_ID} vector is returned to the caller but NOT cached:
   * the deterministic hash embedder is cheap, and a fallback entry must never linger to be
   * served as if it were a real-model vector. On a real-model result whose `modelId`
   * differs from the cache's current model space, the whole cache is dropped first (so no
   * cross-model vector is ever served), then the new entry is inserted with oldest-first
   * eviction past {@link QUERY_CACHE_MAX}.
   */
  private cacheQueryVector(key: string, result: QueryEmbeddingResult): void {
    if (result.modelId === FALLBACK_EMBEDDING_MODEL_ID) return;
    if (result.modelId !== this.cacheModelId) {
      this.queryVectorCache.clear();
      this.cacheModelId = result.modelId;
    }
    // Refresh recency: a re-set moves the key to the newest insertion slot.
    this.queryVectorCache.delete(key);
    this.queryVectorCache.set(key, result);
    while (this.queryVectorCache.size > QUERY_CACHE_MAX) {
      const oldest = this.queryVectorCache.keys().next().value;
      if (oldest === undefined) break;
      this.queryVectorCache.delete(oldest);
    }
  }

  /**
   * Probe the true on-device model state with an HONEST signal (U1, R4) — not a flag
   * set by a warm-up that can't tell real from fallback.
   *
   * The model lives only in the DB-free worker, so the one reliable signal of "is the
   * REAL model in use" is the `modelId` a probe embed comes back with: the real
   * EmbeddingGemma id ({@link DEFAULT_EMBEDDING_MODEL_ID}) vs the deterministic hash
   * fallback ({@link FALLBACK_EMBEDDING_MODEL_ID}). We run a transient `persist:false`
   * embed with a GENEROUS timeout ({@link PROBE_EMBED_TIMEOUT_MS}) — deliberately NOT the
   * 800ms query timeout, because a cold model load takes seconds and a short race would
   * misreport a healthy model as `fallback`/`loading`.
   *
   * Maps to {@link SemanticModelState}: a real result → `ready`; a fallback result →
   * `fallback`; a timeout (still loading) → `loading`. Terminal states (`ready`/
   * `fallback`) are cached for the session so this isn't re-run every launch, and
   * `embeddingModelDownloaded` is reconciled to the truth (true only on `ready`).
   */
  async probeModelState(opts?: {
    force?: boolean;
    timeoutMs?: number;
  }): Promise<SemanticModelState> {
    if (!this.available) return "fallback";
    if (!opts?.force && this.modelStateCache) return this.modelStateCache;

    let result: QueryEmbeddingResult | null = null;
    try {
      result = await this.embedQueryResult(PROBE_TEXT, opts?.timeoutMs ?? PROBE_EMBED_TIMEOUT_MS, {
        useCache: false,
      });
    } catch {
      // A probe failure is treated as "still loading / unknown" — never throws to the caller.
    }

    let state: SemanticModelState;
    if (result === null) {
      state = "loading";
    } else if (result.modelId === DEFAULT_EMBEDDING_MODEL_ID) {
      state = "ready";
    } else {
      state = "fallback";
    }

    if (state !== "loading") {
      // Only cache + reconcile on a terminal answer; a `loading` probe is retried later.
      this.modelStateCache = state;
      this.reconcileModelDownloaded(state === "ready");
    }
    return state;
  }

  /** Reconcile the persisted `embeddingModelDownloaded` flag to the probed truth. */
  private reconcileModelDownloaded(ready: boolean): void {
    const settings = this.getSettings();
    if (ready && !settings.embeddingModelDownloaded) {
      this.repositories.settings.updateAppSettings({
        embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
        embeddingModelDownloaded: true,
      });
    } else if (!ready && settings.embeddingModelDownloaded) {
      this.repositories.settings.updateAppSettings({ embeddingModelDownloaded: false });
    }
  }

  /**
   * Ensure/repair the local model and report whether it is truly ready (U1, KTD5).
   *
   * This is no longer a "warm-up that flips a flag" — it forces an honest
   * {@link probeModelState} and returns `downloaded: true` only when the REAL model
   * answered. There is no resumable downloader: release builds bundle the model and
   * runtime remote fetching is disabled, so the only "repair" is re-probing the local
   * path. The UI gates the user-facing action so it never promises a fetch it cannot do.
   */
  async downloadModel(): Promise<{ downloaded: boolean }> {
    if (!this.available) return { downloaded: false };
    const state = await this.probeModelState({ force: true });
    return { downloaded: state === "ready" };
  }

  /** Build the INDEX-path embed payload (the element to UPSERT). */
  private indexPayload(input: {
    elementId: ElementId;
    elementType: EmbeddableType;
    text: string;
    contentHash: string;
    settings: AppSettings;
  }): EmbedJobPayload {
    const { settings } = input;
    return {
      text: input.text,
      modelId: settings.embeddingModelId,
      provider: "local",
      dim: EMBEDDING_DIM,
      elementId: input.elementId,
      elementType: input.elementType,
      contentHash: input.contentHash,
      persist: true,
    };
  }

  /** Stash a recovered query vector, evicting the oldest if the bounded map is full. */
  private stashQueryVector(jobId: string, result: QueryEmbeddingResult): void {
    if (this.pendingQueryVectors.size >= PENDING_QUERY_MAX) {
      const oldest = this.pendingQueryVectors.keys().next().value;
      if (oldest !== undefined) this.pendingQueryVectors.delete(oldest);
    }
    this.pendingQueryVectors.set(jobId, result);
  }
}

/** sha256 hex of the exact embedded text (the idempotency / skip-if-unchanged key). */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Bound the text length so a huge source does not blow the model context. */
function bound(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

/**
 * Normalize a query string into a stable cache key (U2): trim, lowercase, and collapse
 * internal runs of whitespace to a single space, then defensively bound the length. So
 * `"  Foo  "` and `"foo"` share one entry. Casefolding is fine for the cache key because
 * the underlying embed text is unchanged; only the cache lookup is normalized.
 */
function queryCacheKey(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > QUERY_CACHE_KEY_MAX
    ? normalized.slice(0, QUERY_CACHE_KEY_MAX)
    : normalized;
}

/** A cancellable-ish delay promise for the query-embed timeout race. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
