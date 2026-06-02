/**
 * Job apply-handler registry (T058) — the MAIN-side functions that apply a
 * worker result by committing through the existing repositories.
 *
 * The worker does pure compute/I/O and posts a result back; THESE handlers run in
 * main and do the DB write (in a transaction, appending the correct existing
 * `operation_log` ops via the repositories). They MUST be idempotent / dedup-
 * guarded — at-least-once delivery means a crash-then-resume can re-run an
 * already-applied job (see `JobRunner`). The `url_import` apply is safe: T061
 * canonical-URL/content-hash dedup turns a re-run into a `"duplicate"` no-op.
 *
 * The handlers are bound to the open `DbService`'s `urlImportService` accessor
 * (built lazily once), so the single-writer SQLite connection stays main-owned.
 */

import type { JobJsonValue } from "@interleave/core";
import type { AssetVaultService } from "./asset-vault-service";
import type { EmbeddingService, EmbedJobPayload, EmbedResultData } from "./embedding-service";
import type { JobApplyHandlers } from "./job-runner";
import type { OcrJobPayload, OcrResultData, OcrService } from "./ocr-service";
import type { UrlImportService } from "./url-import-service";

/** The `url_import` job payload (enqueued by main, fetched by the worker). */
export interface UrlImportJobPayload {
  /** The as-entered url (worker follows redirects). */
  readonly url: string;
  readonly priority?: "A" | "B" | "C" | "D";
  readonly reasonAdded?: string | null;
  readonly forceNewVersion?: boolean;
  /** DEV/E2E-only loopback escape, forwarded to the worker's fetch. */
  readonly allowLoopback?: boolean;
}

/** The worker's `url_import` result (the fetched HTML + final url). */
interface UrlImportFetchResult {
  readonly html: string;
  readonly finalUrl: string;
}

/** Lazy accessors for the services the apply handlers compose (built against the open DB). */
export interface JobApplyHandlerDeps {
  /** The shared, fully-wired URL-import service (built against the open DB + vault). */
  readonly getUrlImportService: () => UrlImportService;
  /** The asset-vault scaling service (T059), for the `vault_verify`/`vault_gc` sweeps. */
  readonly getAssetVaultService: () => AssetVaultService;
  /** The OCR service (T066) — persists the worker's recognized text into `ocr_pages`. */
  readonly getOcrService: () => OcrService;
  /** The embedding service (T087) — UPSERTs the worker's vector OR recovers a query vector. */
  readonly getEmbeddingService: () => EmbeddingService;
}

/**
 * Build the apply-handler registry. The accessors lazily resolve the shared,
 * fully-wired services (built against the open DB + vault), so the runner never
 * holds a half-wired service and every DB write / vault sweep happens here in main.
 *
 * The `vault_verify` / `vault_gc` handlers (T059) run the I/O walk off the UI work
 * by being scheduled through the runner, but their hash COMPUTE runs in main: the
 * DB-FREE worker passes these job types straight through (it posts an empty result
 * — there is no fetch/compute it can do without the DB + `assetsDir`), then THESE
 * main-side handlers run the actual sweep through the `AssetVaultService` (which
 * reads the asset rows + STREAMS the vault bytes, hashing chunk-by-chunk so no whole
 * file is buffered, yielding to the event loop between chunks). They are read-only/
 * idempotent: `vault_verify` reports, `vault_gc` here only SCANS for orphans (it
 * returns the candidate set; the destructive `collectOrphans` stays a confirmable
 * direct `vault.collectOrphans` command, never an unattended background deletion),
 * so an at-least-once re-run is always safe.
 *
 * Inherent-to-the-invariants note (future hardening, NOT a bug): because the worker
 * is DB-free it cannot read asset rows, so the verify/GC sweep must run here in main;
 * the SHA-256 compute therefore executes on main's thread. Streamed I/O keeps memory
 * flat and yields between chunks, but a multi-GB-vault verify still spends CPU on
 * main. A later optimization could stream the vault bytes (whose paths main resolves)
 * to the worker purely for hashing and return only the digest — keeping the DB write
 * + single-writer connection in main while moving the CPU off it. Not done now: it is
 * a cross-process redesign that no current invariant requires.
 */
export function createJobApplyHandlers(deps: JobApplyHandlerDeps): JobApplyHandlers {
  const { getUrlImportService, getAssetVaultService, getOcrService, getEmbeddingService } = deps;
  return {
    /**
     * Apply an `embed` worker result (T087) — the SINGLE `embed` handler. It
     * delegates to `EmbeddingService.applyResult`, which branches on
     * `job.payload.persist`: the normal INDEX path UPSERTs the vector into the
     * `sqlite-vec` store (idempotent by element — at-least-once safe); the
     * transient QUERY path (`persist:false`) recovers the vector into a main-side
     * map WITHOUT upserting (and drops it if the query was abandoned on timeout).
     * There is exactly ONE `embed` handler — both paths are this same function.
     * Embeddings append NO `operation_log` (a derived index).
     */
    embed: (job, resultData) => {
      const payload = job.payload as unknown as EmbedJobPayload;
      const result = resultData as unknown as EmbedResultData;
      const summary = getEmbeddingService().applyResult(payload, result, job.id);
      return summary as unknown as JobJsonValue;
    },
    /**
     * Persist a worker OCR result (T066): UPSERT the recognized text into the
     * `ocr_pages` layer (status `suggested`) + write the durable `ocr/page-N.json`
     * to the vault. IDEMPOTENT — upsert by `(source, page)`, so an at-least-once
     * re-run overwrites the page's record rather than duplicating it (the worker
     * never reads the DB; this main-owned handler does the write). The text is a
     * confidence-flagged suggestion — it is NOT merged into the body here (the user
     * accepts it explicitly via `sources.acceptOcr`).
     */
    ocr: async (job, resultData) => {
      const payload = job.payload as unknown as OcrJobPayload;
      const result = resultData as unknown as OcrResultData;
      const summary = await getOcrService().applyResult(payload, result);
      return summary as unknown as JobJsonValue;
    },
    /**
     * Surface a worker FSRS-fit suggestion (T080) — a PASS-THROUGH. The DB-free
     * worker ran the pure bounded calibration search off-main on the MAIN-built
     * history (the heavy fit); this handler writes NOTHING (optimization is never
     * auto-applied), it only carries the suggestion through to the job's terminal
     * result so the renderer can observe it via `jobs.list` / `jobs:updated` and let
     * the user explicitly `optimization.apply` it. Idempotent (no side effect).
     */
    fsrs_optimize: (_job, resultData) => resultData,
    /** Re-hash stored bytes (streamed) and report integrity (read-only). */
    vault_verify: async () => {
      const report = await getAssetVaultService().verifyIntegrity();
      return {
        ok: report.ok,
        mismatched: report.mismatched,
        missing: report.missing,
        extraFiles: report.extraFiles,
      } as unknown as JobJsonValue;
    },
    /**
     * SCAN for orphan vault files (read-only). It never deletes — surfacing the
     * candidate set is the off-main work; the confirmable removal stays the direct
     * `vault.collectOrphans` command (a destructive sweep is never unattended).
     */
    vault_gc: async () => {
      const report = await getAssetVaultService().findOrphans();
      return {
        orphans: report.orphans,
        totalBytes: report.totalBytes,
      } as unknown as JobJsonValue;
    },
    /**
     * Apply a fetched page: run the EXISTING Readability → sanitize → vault-write
     * → createSource transaction over the worker-supplied HTML. The fetch already
     * ran off-main in the worker; this only does the (main-owned) DB write. Throws
     * a `UrlImportError` on a snapshot/persist failure, which the runner records
     * as the job's terminal error.
     */
    url_import: async (job, resultData) => {
      const payload = job.payload as unknown as UrlImportJobPayload;
      const fetched = resultData as unknown as UrlImportFetchResult;
      const result = await getUrlImportService().importFromHtml({
        // The post-redirect final url becomes the source url/canonical url; the
        // as-entered url is preserved as originalUrl.
        url: fetched.finalUrl,
        originalUrl: payload.url,
        html: fetched.html,
        ...(payload.priority ? { priority: payload.priority } : {}),
        ...(payload.reasonAdded !== undefined ? { reasonAdded: payload.reasonAdded } : {}),
        ...(payload.forceNewVersion !== undefined
          ? { forceNewVersion: payload.forceNewVersion }
          : {}),
      });
      // The result is the discriminated import outcome (imported | duplicate) —
      // serializable JSON the IPC handler maps back to SourcesImportUrlResult.
      return result as unknown as JobJsonValue;
    },
  };
}
