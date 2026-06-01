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

import type { ParentPort } from "electron";
import { fetchImportablePage, UrlFetchError } from "../main/url-fetch";
import { type WorkerMessage, WorkerRequestSchema } from "./messages";

/** The `url_import` job payload (validated in main at enqueue; re-validated shape here). */
interface UrlImportPayload {
  /** The url to fetch (the as-entered url; the worker follows redirects). */
  readonly url: string;
  /** DEV/E2E-only: permit loopback hosts (the SSRF-guard escape, forwarded from main). */
  readonly allowLoopback?: boolean;
}

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

/** Dispatch one validated request to its job-execution function. */
async function dispatch(jobId: string, type: string, payload: unknown): Promise<void> {
  try {
    switch (type) {
      case "url_import":
        await runUrlImport(jobId, payload as UrlImportPayload);
        return;
      default:
        // Reserved types (ocr/embed/ai/cleanup/vault_verify/vault_gc) have no
        // worker dispatch yet — fail clearly so a mis-enqueue is visible.
        post({
          kind: "error",
          jobId,
          code: "unsupported_job",
          message: `Worker has no handler for job type "${type}"`,
        });
        return;
    }
  } catch (err) {
    if (err instanceof UrlFetchError) {
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
