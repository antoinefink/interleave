/**
 * OCR job integration tests (T066) — the runner + apply, the T058 fake-worker
 * pattern (`utilityProcess` is unavailable under Vitest, so a fake worker is
 * injected via the `fork` factory).
 *
 * Proves the on-device OCR flow end-to-end MINUS the real WASM (the Electron E2E
 * proves the real `tesseract.js` worker offline):
 *  - enqueue an `ocr` job whose fake worker returns a known `{ page, text,
 *    meanConfidence, words }` → MAIN's apply handler UPSERTS an `ocr_pages` row
 *    (status `suggested`) + writes the durable `ocr/page-N.json` to the vault, and
 *    the job lands `succeeded`;
 *  - IDEMPOTENCY/RESTART: a job left `running` by a crash is re-queued by
 *    `recoverRunning` on a fresh runner, completes, and the `ocr_pages` row is
 *    present EXACTLY ONCE (no duplicate) and survives the DB re-open;
 *  - ACCEPT: `acceptOcr` merges the OCR text into the page body (the `plainText`
 *    now contains it) + logs `update_document` + flips the row to `accepted`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerMessage, WorkerRequest } from "../worker/messages";
import { DbService } from "./db-service";
import { createJobApplyHandlers } from "./job-apply-handlers";
import { JobRunner, type WorkerHandle } from "./job-runner";

const FIXTURES = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
);

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-ocr-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The known OCR result the fake worker returns for an `ocr` job. */
const OCR_RESULT = {
  page: 1,
  text: "CARDS AND NOTES",
  meanConfidence: 82,
  words: [
    { text: "CARDS", confidence: 84, bbox: { x0: 0, y0: 0, x1: 50, y1: 12 } },
    { text: "AND", confidence: 80, bbox: { x0: 55, y0: 0, x1: 80, y1: 12 } },
    { text: "NOTES", confidence: 82, bbox: { x0: 85, y0: 0, x1: 135, y1: 12 } },
  ],
};

/** A fake worker that auto-replies to an `ocr` request with {@link OCR_RESULT}. */
class AutoOcrWorker implements WorkerHandle {
  private listener: ((m: WorkerMessage) => void) | null = null;
  readonly posted: WorkerRequest[] = [];
  postMessage(request: WorkerRequest): void {
    this.posted.push(request);
    setTimeout(() => {
      this.listener?.({ kind: "progress", jobId: request.jobId, progress: { ratio: 0.5 } });
      this.listener?.({
        kind: "result",
        jobId: request.jobId,
        data: OCR_RESULT as unknown as Record<string, never>,
      });
    }, 0);
  }
  onMessage(listener: (m: WorkerMessage) => void): void {
    this.listener = listener;
  }
  kill(): void {}
}

/** A fake worker that NEVER replies — leaves a job stuck `running` (a crash). */
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
  const runner = new JobRunner({
    jobsRepo: svc.repos.jobs,
    applyHandlers: createJobApplyHandlers({
      getUrlImportService: () => svc.urlImportService,
      getAssetVaultService: () => svc.assetVaultService,
      getOcrService: () => svc.ocrService,
      getEmbeddingService: () => svc.embeddingService,
    }),
    workerPath: "(unused)",
    fork: () => worker,
    retryBackoffBaseMs: 0,
  });
  svc.setRunner(runner);
  return runner;
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Import the scanned fixture PDF and return its source id. */
async function importScanned(svc: DbService): Promise<string> {
  const { id } = await svc.pdfImportService.importFromFile({
    filePath: path.join(FIXTURES, "ocr-scanned.pdf"),
  });
  return id;
}

/** A tiny 1x1 PNG (a valid `imagePng` the renderer would ship for the page). */
function tinyPng(): ArrayBuffer {
  const bytes = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6360000002000154a24f9f0000000049454e44ae426082",
    "hex",
  );
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("OCR job (T066)", () => {
  it("enqueues + applies an ocr job: worker text → ocr_pages (suggested) + vault json", async () => {
    const svc = openDb();
    const runner = makeRunner(svc, new AutoOcrWorker());
    runner.start();
    const sourceId = await importScanned(svc);

    const { enqueued, jobId } = await svc.runOcr({
      elementId: sourceId,
      page: 1,
      imagePng: tinyPng(),
    });
    expect(enqueued).toBe(1);

    const terminal = await runner.waitForTerminal(jobId as never);
    expect(terminal.status).toBe("succeeded");

    // The page-PNG MAIN wrote before enqueueing is in the vault.
    expect(fs.existsSync(path.join(assetsDir, "sources", sourceId, "ocr", "page-1.png"))).toBe(
      true,
    );
    // The worker only received the VAULT-RELATIVE path — never the bytes.
    const payload = (terminal.payload ?? {}) as { imagePagePath?: string };
    expect(payload.imagePagePath).toBe(`sources/${sourceId}/ocr/page-1.png`);

    // The recognized text is a SUGGESTION in the ocr_pages layer (not in the body).
    const ocr = svc.getOcr({ elementId: sourceId });
    expect(ocr.pages).toHaveLength(1);
    expect(ocr.pages[0]?.text).toBe("CARDS AND NOTES");
    expect(ocr.pages[0]?.meanConfidence).toBe(82);
    expect(ocr.pages[0]?.status).toBe("suggested");

    // The durable vault json was written.
    expect(fs.existsSync(path.join(assetsDir, "sources", sourceId, "ocr", "page-1.json"))).toBe(
      true,
    );

    runner.stop();
    svc.close();
  });

  it("is idempotent + restart-safe: a crashed running job resumes once via recoverRunning", async () => {
    // 1) First runner: the worker never replies, so the job is left `running`.
    let svc = openDb();
    const sourceId = await importScanned(svc);
    let runner = makeRunner(svc, new SilentWorker());
    runner.start();
    const { jobId } = await svc.runOcr({ elementId: sourceId, page: 1, imagePng: tinyPng() });
    await until(() => svc.repos.jobs.findById(jobId as never)?.status === "running");
    runner.stop();
    svc.close();

    // 2) Re-open the DB on the SAME file + a fresh runner with an auto-OCR worker:
    //    recoverRunning re-queues the crashed job, it completes.
    svc = openDb();
    runner = makeRunner(svc, new AutoOcrWorker());
    runner.start();
    await until(() => svc.repos.jobs.findById(jobId as never)?.status === "succeeded");

    // The ocr_pages row is present EXACTLY ONCE (the upsert dedups by (source, page)).
    const ocr = svc.getOcr({ elementId: sourceId });
    expect(ocr.pages.filter((p) => p.page === 1)).toHaveLength(1);
    expect(ocr.pages[0]?.text).toBe("CARDS AND NOTES");

    runner.stop();
    svc.close();

    // 3) The OCR row survives a final DB re-open (restart-persistence).
    svc = openDb();
    const after = svc.getOcr({ elementId: sourceId });
    expect(after.pages).toHaveLength(1);
    expect(after.pages[0]?.text).toBe("CARDS AND NOTES");
    svc.close();
  });

  it("acceptOcr merges the OCR text into the body (searchable) + logs update_document", async () => {
    const svc = openDb();
    const runner = makeRunner(svc, new AutoOcrWorker());
    runner.start();
    const sourceId = await importScanned(svc);
    const { jobId } = await svc.runOcr({ elementId: sourceId, page: 1, imagePng: tinyPng() });
    await runner.waitForTerminal(jobId as never);

    // Before accept: the body has no OCR text (a scanned page = an empty "Page 1" run).
    const before = svc.getDocument({ elementId: sourceId });
    expect(before.document?.plainText.includes("CARDS AND NOTES")).toBe(false);

    const opsBefore = svc.repos.operationLog
      .listForElement(sourceId as never)
      .filter((o) => o.opType === "update_document").length;

    const accepted = svc.acceptOcr({ elementId: sourceId, page: 1 });
    expect(accepted.accepted).toBe(true);

    // After accept: the OCR text is ordinary, searchable body text (plainText mirror).
    const after = svc.getDocument({ elementId: sourceId });
    expect(after.document?.plainText.includes("CARDS AND NOTES")).toBe(true);

    // The merge went through the document-save path → an `update_document` op.
    const opsAfter = svc.repos.operationLog
      .listForElement(sourceId as never)
      .filter((o) => o.opType === "update_document").length;
    expect(opsAfter).toBeGreaterThan(opsBefore);

    // The ocr_pages row flips to `accepted`; a second accept is a no-op.
    expect(svc.getOcr({ elementId: sourceId }).pages[0]?.status).toBe("accepted");
    expect(svc.acceptOcr({ elementId: sourceId, page: 1 }).accepted).toBe(false);

    runner.stop();
    svc.close();
  });
});
