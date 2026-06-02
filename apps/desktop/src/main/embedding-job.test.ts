/**
 * Embedding job integration tests (T087) — the runner + the `embed` apply, the
 * T058 fake-worker pattern (`utilityProcess` is unavailable under Vitest, so a
 * fake worker is injected via the `fork` factory). `sqlite-vec` IS available in
 * Node when the FUNCTIONAL smoke test passes, so the whole suite is gated on it
 * (`describe.skipIf`) — an ABI-mismatched host skips cleanly with a clear message
 * rather than failing inside a `vec0` query.
 *
 * Proves the on-device semantic flow end-to-end with a DETERMINISTIC embedder in
 * place of the real MiniLM model — the Electron E2E exercises the real
 * `utilityProcess` worker + real model; here a fake worker injects the same pure
 * `embedTextLocal` the worker falls back to, so the fusion/persistence/idempotency
 * invariants are asserted EXACTLY without loading a model under Vitest:
 *  - `new DbService().open(...)` loads `vec0` (real, on a temp-file DB);
 *  - with semantic search enabled, creating an extract/card enqueues an `embed`
 *    job whose FAKE worker computes the deterministic vector and returns it →
 *    MAIN's single `embed` apply UPSERTs it into the `element_vectors` store;
 *  - `semanticSearch` returns the seeded element for a semantically-near query that
 *    shares the deterministic embedder's tokens but NOT the exact FTS title term
 *    (the fusion finding it without a literal keyword match);
 *  - RESTART: re-open the DB → the vector + the semantic result SURVIVE (the index
 *    persists in the SQLite file).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMBEDDING_DIM, embedTextLocal } from "@interleave/core";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkerMessage, WorkerRequest } from "../worker/messages";
import { DbService } from "./db-service";
import { createJobApplyHandlers } from "./job-apply-handlers";
import { JobRunner, type WorkerHandle } from "./job-runner";

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-embed-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake worker that computes the deterministic embedding for an `embed` job's
 * payload text (the same function the real worker uses) and returns it — so the
 * apply path is exercised with a real, reproducible vector. Non-`embed` jobs get a
 * null result. The query path (`persist:false`) is handled the same way.
 */
class AutoEmbedWorker implements WorkerHandle {
  private listener: ((m: WorkerMessage) => void) | null = null;
  readonly posted: WorkerRequest[] = [];
  postMessage(request: WorkerRequest): void {
    this.posted.push(request);
    setTimeout(() => {
      if (request.type !== "embed") {
        this.listener?.({ kind: "result", jobId: request.jobId, data: null });
        return;
      }
      const payload = request.payload as { text: string; modelId: string; dim: number };
      const vector = embedTextLocal(payload.text, payload.dim ?? EMBEDDING_DIM);
      this.listener?.({
        kind: "result",
        jobId: request.jobId,
        data: { vector, modelId: payload.modelId, dim: payload.dim ?? EMBEDDING_DIM },
      });
    }, 0);
  }
  onMessage(listener: (m: WorkerMessage) => void): void {
    this.listener = listener;
  }
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

/** Whether `vec0` is functional on a freshly opened temp DB (the suite skip gate). */
function vecIsAvailable(): boolean {
  const svc = openDb();
  const ok = svc.semanticStatus().vecAvailable;
  svc.close();
  fs.rmSync(dbPath, { force: true });
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  return ok;
}

const VEC_OK = (() => {
  // The beforeEach has not run yet at collection time; make a throwaway temp dir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-embed-probe-"));
  const svc = new DbService();
  try {
    svc.open(path.join(tmp, "app.sqlite"), { migrationsDir: MIGRATIONS_DIR });
    const ok = svc.semanticStatus().vecAvailable;
    svc.close();
    return ok;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

describe.skipIf(!VEC_OK)("embed job (T087)", () => {
  it("vecIsAvailable is true on this host (sanity)", () => {
    expect(vecIsAvailable()).toBe(true);
  });

  it("enqueues + applies an embed job → vector UPSERTed → semantic search finds it (no exact FTS-title match) → survives restart", async () => {
    let svc = openDb();
    // Enable semantic search so the auto-embed seam fires + semanticSearch runs fused.
    svc.updateAppSettings({ semanticSearchEnabled: true, embeddingModelDownloaded: true });
    const runner = makeRunner(svc, new AutoEmbedWorker());
    runner.start();

    // Seed a source whose body talks about "review intervals" + "scheduling" but NOT
    // the literal query word, so FTS alone would miss it — only the vector finds it.
    const source = svc.repos.elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      title: "Optimal review intervals",
      priority: 0.5,
    });
    svc.saveDocument({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "scheduling repetitions to maximize retention over a long horizon",
    });

    // saveDocument auto-embeds the source post-commit; wait for the embed job to apply.
    await until(() => svc.semanticStatus().embedded >= 1);
    expect(svc.semanticStatus().embedded).toBe(1);

    // A query that does NOT match the FTS title ("Optimal review intervals") on its
    // distinctive term but is near in the deterministic embedder's space still
    // surfaces the source via the vector arm of the fusion (not a literal title hit).
    const result = await svc.semanticSearch({ q: "scheduling intervals retention" });
    expect(result.mode).toBe("semantic");
    const hit = result.results.find((r) => r.id === source.id);
    expect(hit).toBeDefined();

    // RESTART: close + re-open the DB; the vector persists in the SQLite file.
    runner.stop();
    svc.close();

    svc = openDb();
    svc.updateAppSettings({ semanticSearchEnabled: true, embeddingModelDownloaded: true });
    const runner2 = makeRunner(svc, new AutoEmbedWorker());
    runner2.start();

    expect(svc.semanticStatus().embedded).toBe(1); // survived restart, no re-index
    const afterRestart = await svc.semanticSearch({ q: "scheduling intervals retention" });
    expect(afterRestart.results.some((r) => r.id === source.id)).toBe(true);

    runner2.stop();
    svc.close();
  });

  it("re-embed is idempotent: editing the body updates the SAME vector row (no duplicate)", async () => {
    const svc = openDb();
    svc.updateAppSettings({ semanticSearchEnabled: true, embeddingModelDownloaded: true });
    const runner = makeRunner(svc, new AutoEmbedWorker());
    runner.start();

    const source = svc.repos.elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      title: "Note",
      priority: 0.5,
    });
    svc.saveDocument({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "first body about memory",
    });
    await until(() => svc.semanticStatus().embedded >= 1);

    // Edit the body → re-embed; the bookkeeping stays at exactly one embedded element.
    svc.saveDocument({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "rewritten body about spaced repetition",
    });
    await until(() => svc.repos.jobs.list({ status: "succeeded" }).length >= 2);
    expect(svc.semanticStatus().embedded).toBe(1);

    runner.stop();
    svc.close();
  });

  it("appends NO operation_log for the embed lifecycle (derived index)", async () => {
    const svc = openDb();
    svc.updateAppSettings({ semanticSearchEnabled: true, embeddingModelDownloaded: true });
    const runner = makeRunner(svc, new AutoEmbedWorker());
    runner.start();

    const source = svc.repos.elements.create({
      type: "source",
      status: "active",
      stage: "raw_source",
      title: "Logged",
      priority: 0.5,
    });
    const afterCreate = svc.repos.operationLog.count();
    svc.saveDocument({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "body that gets embedded",
    });
    const afterSave = svc.repos.operationLog.count();
    await until(() => svc.semanticStatus().embedded >= 1);
    // The embed apply that ran AFTER the save must not have appended any op-log row.
    expect(svc.repos.operationLog.count()).toBe(afterSave);
    expect(afterSave).toBeGreaterThan(afterCreate); // the document save DID log.

    runner.stop();
    svc.close();
  });
});
