/**
 * JobRunner integration tests (T058) — restart-resume + apply-handler on a real DB.
 *
 * `utilityProcess` is an Electron MAIN-process-only API and is NOT available in a
 * plain Vitest/Node process, so we do NOT fork a real worker here — that path is
 * exercised in the Electron E2E. Instead this covers the restart-resume +
 * `recoverRunning` + the REAL `url_import` apply (the shared `UrlImportService`
 * snapshot+createSource pipeline) against a real temp-file SQLite DB + temp
 * `assetsDir`, using the FAKE in-process worker injected via the `fork` factory.
 *
 *  1. Apply: enqueue a `url_import` job whose fake worker returns known HTML →
 *     main applies via `importFromHtml` → a source lands in the inbox with
 *     `original.html`/`cleaned.html` in the vault and the job is `succeeded`.
 *  2. Restart persistence (load-bearing): stop the runner mid-flight leaving a
 *     `running` row, RE-OPEN the DB + start a NEW runner (still with the fake
 *     worker) → `recoverRunning` re-queues it, it completes, and the resulting
 *     source + snapshot files survive across the re-open.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JobJsonValue } from "@interleave/core";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerMessage, WorkerRequest } from "../worker/messages";
import { DbService } from "./db-service";
import { createJobApplyHandlers } from "./job-apply-handlers";
import { JobRunner, type WorkerHandle } from "./job-runner";

const ARTICLE_HTML = `<!DOCTYPE html><html><head><title>Spacing Effect — Guide</title></head>
<body><article><h1>The Spacing Effect</h1>
<p>Spaced repetition exploits the spacing effect: information is retained far better
when study sessions are distributed over time rather than crammed.</p></article></body></html>`;

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-runner-int-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake worker that auto-replies to a `url_import` request with fixed HTML. */
class AutoFetchWorker implements WorkerHandle {
  private listener: ((message: WorkerMessage) => void) | null = null;
  readonly posted: WorkerRequest[] = [];
  killed = false;

  postMessage(request: WorkerRequest): void {
    this.posted.push(request);
    // Reply asynchronously, mimicking a real off-main fetch.
    setTimeout(() => {
      this.listener?.({ kind: "progress", jobId: request.jobId, progress: { ratio: 0.5 } });
      const url = (request.payload as { url: string }).url;
      this.listener?.({
        kind: "result",
        jobId: request.jobId,
        data: { html: ARTICLE_HTML, finalUrl: url } as unknown as JobJsonValue,
      });
    }, 0);
  }
  onMessage(listener: (message: WorkerMessage) => void): void {
    this.listener = listener;
  }
  kill(): void {
    this.killed = true;
  }
}

/** A fake worker that NEVER replies — to leave a job stuck `running` (a crash). */
class SilentWorker implements WorkerHandle {
  readonly posted: WorkerRequest[] = [];
  postMessage(request: WorkerRequest): void {
    this.posted.push(request);
  }
  onMessage(): void {}
  kill(): void {}
}

function openDb(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir });
  return svc;
}

function makeRunner(svc: DbService, worker: WorkerHandle): JobRunner {
  return new JobRunner({
    jobsRepo: svc.repos.jobs,
    applyHandlers: createJobApplyHandlers({
      getUrlImportService: () => svc.urlImportService,
      getAssetVaultService: () => svc.assetVaultService,
      getOcrService: () => svc.ocrService,
    }),
    workerPath: "(unused)",
    fork: () => worker,
    retryBackoffBaseMs: 0,
  });
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("JobRunner integration — apply + restart-resume", () => {
  it("applies a url_import job: worker HTML → main snapshot+createSource → inbox source + vault files", async () => {
    const svc = openDb();
    const runner = makeRunner(svc, new AutoFetchWorker());
    runner.start();

    const job = runner.enqueue("url_import", { url: "https://example.com/spacing" });
    const terminal = await runner.waitForTerminal(job.id);
    expect(terminal.status).toBe("succeeded");

    // A source landed in the inbox with the cleaned article text.
    const { items } = svc.listInbox();
    expect(items).toHaveLength(1);
    const sourceId = items[0]?.id as string;
    const detail = svc.getInboxItem(sourceId);
    expect(detail.detail?.summary.title).toContain("Spacing Effect");

    // BOTH snapshots exist in the vault.
    const sourceDir = path.join(assetsDir, "sources", sourceId);
    expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(true);
    expect(fs.existsSync(path.join(sourceDir, "cleaned.html"))).toBe(true);

    runner.stop();
    svc.close();
  });

  it("re-running an already-applied url_import is a dedup no-op (idempotent / at-least-once safe)", async () => {
    const svc = openDb();
    const runner = makeRunner(svc, new AutoFetchWorker());
    runner.start();

    const first = await runner.waitForTerminal(
      runner.enqueue("url_import", { url: "https://example.com/spacing" }).id,
    );
    expect(first.status).toBe("succeeded");
    expect((first.result as { status: string }).status).toBe("imported");

    // A second identical import is detected as a duplicate — nothing new created.
    const second = await runner.waitForTerminal(
      runner.enqueue("url_import", { url: "https://example.com/spacing" }).id,
    );
    expect(second.status).toBe("succeeded");
    expect((second.result as { status: string }).status).toBe("duplicate");
    expect(svc.listInbox().items).toHaveLength(1);

    runner.stop();
    svc.close();
  });

  it("a job left running by a crash is recovered + completes after an app restart; source + snapshots survive", async () => {
    // --- Session 1: enqueue, post to a SILENT worker, then crash (stop) mid-flight. ---
    const svc1 = openDb();
    const silent = new SilentWorker();
    const runner1 = makeRunner(svc1, silent);
    runner1.start();
    const job = runner1.enqueue("url_import", { url: "https://example.com/spacing" });
    await until(() => silent.posted.length === 1); // posted to the worker → row is `running`
    expect(svc1.repos.jobs.findById(job.id)?.status).toBe("running");
    // Simulate a crash: stop the runner (worker killed) WITHOUT a terminal reply,
    // then close the DB — the `running` row persists.
    runner1.stop();
    svc1.close();

    // --- Session 2: RE-OPEN the same DB + start a NEW runner (auto-fetch worker). ---
    const svc2 = openDb();
    // The crashed row is still `running` on disk before recovery runs.
    expect(svc2.repos.jobs.findById(job.id)?.status).toBe("running");
    const runner2 = makeRunner(svc2, new AutoFetchWorker());
    runner2.start(); // recoverRunning() re-queues the running row; it then re-runs.

    const terminal = await runner2.waitForTerminal(job.id);
    expect(terminal.status).toBe("succeeded");

    // The source + its snapshots survive across the re-open.
    const { items } = svc2.listInbox();
    expect(items).toHaveLength(1);
    const sourceId = items[0]?.id as string;
    const sourceDir = path.join(assetsDir, "sources", sourceId);
    expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(true);
    expect(fs.existsSync(path.join(sourceDir, "cleaned.html"))).toBe(true);

    // No orphan `running` job lingers.
    expect(svc2.repos.jobs.list({ status: "running" })).toHaveLength(0);

    runner2.stop();
    svc2.close();
  });
});
