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
import { type AppSettings, DEFAULT_EMBEDDING_MODEL_ID, EMBEDDING_DIM } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { cards, documents, elements, sourceLocations } from "@interleave/db";
import type { EmbeddableType, Repositories } from "@interleave/local-db";
import { eq, isNull } from "drizzle-orm";
import type { JobRunner } from "./job-runner";

/** Max characters of text fed to the embedder (≈512 tokens) so a huge source is bounded. */
const MAX_EMBED_CHARS = 2_000;
/** Default cap on how many elements one `reindexAll` enqueues (the runner concurrency drains them). */
const REINDEX_BATCH_LIMIT = 5_000;
/** How long `embedQuery` waits for the transient embed job before falling back to FTS-only. */
const QUERY_EMBED_TIMEOUT_MS = 800;
/** Belt-and-braces cap on the pending-query map so a pathological run can't grow it unbounded. */
const PENDING_QUERY_MAX = 64;

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

    const rows = this.db
      .select({ id: elements.id, type: elements.type })
      .from(elements)
      .where(isNull(elements.deletedAt))
      .limit(REINDEX_BATCH_LIMIT)
      .all()
      .filter((r) => r.type === "source" || r.type === "extract" || r.type === "card");

    let enqueued = 0;
    for (const row of rows) {
      const result = this.enqueueElement(row.id as ElementId);
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
    return { elementId: payload.elementId, modelId: result.modelId };
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

  async embedQueryResult(text: string): Promise<QueryEmbeddingResult | null> {
    const settings = this.getSettings();
    if (!this.available) return null;
    if (text.trim().length === 0) return null;

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
      delay(QUERY_EMBED_TIMEOUT_MS).then(() => "timeout" as const),
    ]);

    if (terminal === "timeout" || terminal.status !== "succeeded") {
      // The waiter gave up; the late persist:false apply result must be dropped.
      this.abandonedQueries.add(job.id);
      this.pendingQueryVectors.delete(job.id);
      return null;
    }
    const result = this.pendingQueryVectors.get(job.id) ?? null;
    this.pendingQueryVectors.delete(job.id);
    return result;
  }

  /**
   * Pre-warm the local embedding model on first enable.
   *
   * The spec (`docs/tasks/M18-semantic.md`) pins two ACCEPTABLE first-run mechanisms
   * and asks us to pick one and document the tradeoff: the model lives ONLY in the
   * DB-free worker, which resolves it from the local Transformers.js cache/staged
   * model directory. A tiny transient warm-up job proves the local path can produce
   * a vector and flips `embeddingModelDownloaded`; if the model is not present the
   * worker degrades to the deterministic local fallback.
   *
   * Concretely: this enqueues a tiny TRANSIENT (`persist:false`) `embed` job for a
   * fixed warm-up string and waits for it — a success means the worker loaded the
   * model (fetched + cached on first run, or already on disk), so we flip
   * `embeddingModelDownloaded = true` in settings in one transaction (idempotent —
   * re-running with the model present just re-flips). The worker falls back to the
   * deterministic embedder if the model genuinely cannot be fetched (offline), so
   * this never hangs the UI; it races a bounded timeout (inside {@link embedQuery})
   * and returns the resulting `downloaded` state either way, leaving search FTS-only
   * until the warm-up resolves.
   */
  async downloadModel(): Promise<{ downloaded: boolean }> {
    if (!this.available) return { downloaded: false };

    let result: QueryEmbeddingResult | null = null;
    try {
      // A transient warm-up embed — forces the worker's first local model load.
      result = await this.embedQueryResult("warm up the on-device embedding model");
    } catch {
      // Never block enabling the feature on a warm-up failure — the index path
      // re-attempts the load per job and degrades to FTS-only meanwhile.
    }
    const downloaded = result?.modelId === DEFAULT_EMBEDDING_MODEL_ID;
    if (downloaded) {
      this.repositories.settings.updateAppSettings({
        embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
        embeddingModelDownloaded: true,
      });
    }
    return { downloaded };
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

/** A cancellable-ish delay promise for the query-embed timeout race. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
