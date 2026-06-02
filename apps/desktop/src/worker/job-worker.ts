/**
 * Background-job WORKER entry (T058) — the Electron `utilityProcess` child.
 *
 * Why `utilityProcess` (not `worker_threads`, not pg-boss): the worker must be
 * cleanly isolated from the Electron main's V8 heap + event loop — a hostile/huge
 * fetch or a future native OCR/PDF/embed job must not be able to corrupt or stall
 * main, and must NEVER share the `better-sqlite3` handle. `utilityProcess` is
 * Electron's first-class out-of-process Node child with a message channel and
 * proper lifecycle; the `JobRunner` in main owns it. (See the runner module
 * docblock for the full justification.)
 *
 * This file is bundled by esbuild into its OWN self-contained `dist/job-worker.cjs`
 * (a third build.mjs target) and spawned with `utilityProcess.fork(...)`. It is
 * **DB-FREE**: it imports NO `@interleave/db`, `better-sqlite3`, repository, or
 * `DbService`. It does pure compute + network I/O only — for `url_import`, it
 * fetches the page off-main (reusing the shared SSRF guard / timeout / size-cap /
 * non-HTML reject in `url-fetch.ts`, which depends only on the pure host
 * classifier) and posts the HTML back. MAIN then runs the snapshot + createSource
 * pipeline through the repositories. All messages are Zod-validated both ways via
 * the shared `messages.ts` so a malformed message is rejected at the boundary.
 *
 * Runs in a plain Node `utilityProcess` (no `electron` import) — it talks to main
 * over `process.parentPort`.
 */

import { type OptimizerHistory, suggestParameters } from "@interleave/scheduler";
import type { ParentPort } from "electron";
import { fetchImportablePage, UrlFetchError } from "../main/url-fetch";
import { computeEmbedding, EmbedError, type EmbedJobPayload } from "./embedding-model";
import { type WorkerMessage, WorkerRequestSchema } from "./messages";
import { recognizePageImage, resolveVaultImagePath } from "./ocr";

/** The `url_import` job payload (validated in main at enqueue; re-validated shape here). */
interface UrlImportPayload {
  /** The url to fetch (the as-entered url; the worker follows redirects). */
  readonly url: string;
  /** DEV/E2E-only: permit loopback hosts (the SSRF-guard escape, forwarded from main). */
  readonly allowLoopback?: boolean;
}

/**
 * The `ocr` job payload (T066). MAIN renders the text-free page to a PNG in the
 * vault FIRST, then enqueues only the VAULT-RELATIVE path here — NEVER the bytes
 * (a persisted `jobs` row must not hold a binary blob; see the payload rule in the
 * M14 spec). The worker resolves it against the vault root it reads from
 * `INTERLEAVE_ASSETS_DIR` (the fork-env seam) and OCRs the image.
 */
interface OcrPayload {
  readonly sourceElementId: string;
  readonly page: number;
  /** Vault-relative path to the page PNG MAIN already rendered + wrote. */
  readonly imagePagePath: string;
}

/**
 * The vault asset-root, read ONCE at module load from the fork-env seam
 * (`utilityProcess.fork(workerPath, [], { env: { …, INTERLEAVE_ASSETS_DIR } })`,
 * JobRunner). The DB-free worker uses it to resolve a job's vault-relative
 * page-image path — the absolute root is NEVER written to a persisted `jobs` row.
 * Empty for the existing `url_import`/`vault_*` jobs, which do not read it.
 */
const ASSETS_DIR = process.env.INTERLEAVE_ASSETS_DIR ?? "";

/** `process.parentPort` is the utilityProcess → parent channel. */
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

/** Post a typed worker → main message (validated shape lives in `messages.ts`). */
function post(message: WorkerMessage): void {
  parentPort?.postMessage(message);
}

/** Execute one `url_import` job: fetch the page off-main, post progress + result. */
async function runUrlImport(jobId: string, payload: UrlImportPayload): Promise<void> {
  post({ kind: "progress", jobId, progress: { ratio: 0.1, note: "fetching" } });
  const { html, finalUrl } = await fetchImportablePage(payload.url, {
    ...(payload.allowLoopback ? { allowLoopback: true } : {}),
  });
  post({ kind: "progress", jobId, progress: { ratio: 0.7, note: "fetched" } });
  post({ kind: "result", jobId, data: { html, finalUrl } });
}

/**
 * Execute one `ocr` job (T066): resolve the vault-relative page-image path
 * against the vault root, run `tesseract.js` (WASM) ON-DEVICE against the local
 * bundled core/lang, and post the recognized text + confidence. The worker stays
 * DB-FREE — it reads the PNG MAIN prepared and returns text only; MAIN persists
 * the `ocr_pages` row + the durable vault json.
 */
async function runOcr(jobId: string, payload: OcrPayload): Promise<void> {
  if (!ASSETS_DIR) {
    post({
      kind: "error",
      jobId,
      code: "ocr_no_assets_dir",
      message: "OCR worker has no INTERLEAVE_ASSETS_DIR — cannot resolve the page image",
    });
    return;
  }
  const imagePath = resolveVaultImagePath(ASSETS_DIR, payload.imagePagePath);
  post({ kind: "progress", jobId, progress: { ratio: 0.05, note: "starting OCR" } });
  const result = await recognizePageImage(imagePath, (ratio) => {
    // Map the engine's 0–1 recognition progress into the back half of the bar.
    post({ kind: "progress", jobId, progress: { ratio: 0.1 + ratio * 0.85, note: "recognizing" } });
  });
  post({ kind: "progress", jobId, progress: { ratio: 0.98, note: "done" } });
  post({
    kind: "result",
    jobId,
    data: {
      page: payload.page,
      text: result.text,
      meanConfidence: result.meanConfidence,
      words: result.words.map((w) => ({
        text: w.text,
        confidence: w.confidence,
        bbox: { x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 },
      })),
    },
  });
}

/**
 * The `fsrs_optimize` job payload (T080). MAIN builds the DB-free
 * {@link OptimizerHistory} (from `review_logs`) and the scope's current params and
 * enqueues them here — the worker runs the PURE bounded calibration search
 * (`suggestParameters`) OFF the main thread for a large history, and returns the
 * suggestion. MAIN then computes the workload preview + applies on the user's
 * explicit accept. The worker stays DB-FREE (it imports `@interleave/scheduler`'s
 * pure optimizer only — no `@interleave/db`/repository).
 */
interface FsrsOptimizePayload {
  readonly history: OptimizerHistory[];
  readonly current?: number[];
}

/** Execute one `fsrs_optimize` job: run the pure bounded search off-main. */
function runFsrsOptimize(jobId: string, payload: FsrsOptimizePayload): void {
  post({ kind: "progress", jobId, progress: { ratio: 0.1, note: "scoring history" } });
  const suggestion = suggestParameters(
    payload.history,
    payload.current ? { current: payload.current } : {},
  );
  post({ kind: "progress", jobId, progress: { ratio: 0.95, note: "done" } });
  // Serialize the suggestion to a plain JSON shape (the params vector + scores).
  post({
    kind: "result",
    jobId,
    data: {
      params: [...suggestion.params.w],
      baseline: { ...suggestion.baseline },
      suggested: { ...suggestion.suggested },
      improvement: suggestion.improvement,
      reviewsScored: suggestion.reviewsScored,
      method: suggestion.method,
      sufficientData: suggestion.sufficientData,
    },
  });
}

/**
 * Execute one `embed` job (T087): compute the element/query embedding OFF the main
 * thread (the deterministic on-device model by default, or the user's OWN API
 * endpoint when `provider === "api"`) and post the vector back. MAIN writes it into
 * the `sqlite-vec` store (single writer). The worker stays DB-FREE — it imports NO
 * `@interleave/db`/`better-sqlite3`/`sqlite-vec`, only the pure model compute. The
 * payload's `persist` flag (the transient query path) is passed THROUGH untouched —
 * it lives in the job payload, so MAIN's single `embed` apply handler reads it.
 */
async function runEmbed(jobId: string, payload: EmbedJobPayload): Promise<void> {
  post({ kind: "progress", jobId, progress: { ratio: 0.2, note: "embedding" } });
  const result = await computeEmbedding(payload);
  post({ kind: "progress", jobId, progress: { ratio: 0.95, note: "done" } });
  post({
    kind: "result",
    jobId,
    data: { vector: result.vector, modelId: result.modelId, dim: result.dim },
  });
}

/** Dispatch one validated request to its job-execution function. */
async function dispatch(jobId: string, type: string, payload: unknown): Promise<void> {
  try {
    switch (type) {
      case "url_import":
        await runUrlImport(jobId, payload as UrlImportPayload);
        return;
      case "ocr":
        await runOcr(jobId, payload as OcrPayload);
        return;
      case "embed":
        await runEmbed(jobId, payload as EmbedJobPayload);
        return;
      case "fsrs_optimize":
        runFsrsOptimize(jobId, payload as FsrsOptimizePayload);
        return;
      case "vault_verify":
      case "vault_gc":
        // The vault integrity-verify + orphan-scan (T059) are MAIN-side work: they
        // read the asset rows + stream the vault bytes, which the DB-FREE worker
        // cannot do. The worker is a pure pass-through here — it posts an empty
        // result so the runner's MAIN-side apply handler runs the actual heavy
        // hashing/walk OFF-MAIN. (Keeping them on the runner mechanism gives a slow
        // large-vault sweep the same off-main scheduling + observe surface as any
        // other job, without ever opening the DB in the worker.)
        post({ kind: "result", jobId, data: null });
        return;
      default:
        // Reserved types (embed/ai/cleanup) have no worker dispatch yet — fail
        // clearly so a mis-enqueue is visible.
        post({
          kind: "error",
          jobId,
          code: "unsupported_job",
          message: `Worker has no handler for job type "${type}"`,
        });
        return;
    }
  } catch (err) {
    if (err instanceof UrlFetchError || err instanceof EmbedError) {
      post({ kind: "error", jobId, code: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    post({ kind: "error", jobId, code: "worker_error", message });
  }
}

parentPort?.on("message", (event) => {
  const parsed = WorkerRequestSchema.safeParse(event.data);
  if (!parsed.success) {
    // A malformed request carries no usable jobId; drop it. Main bounds a job
    // that never replies via its own bookkeeping. Log for diagnosis.
    console.error("[job-worker] rejected malformed request:", parsed.error.message);
    return;
  }
  const { jobId, type, payload } = parsed.data;
  void dispatch(jobId, type, payload);
});
