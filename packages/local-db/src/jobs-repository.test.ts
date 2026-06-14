/**
 * JobsRepository unit tests (T058) — the persisted background-runner queue.
 *
 * Runs against this package's own in-memory `createInMemoryDb()` harness (the
 * same one the other repo tests use). Covers the load-bearing queue invariants:
 * single-claim (no double-claim), the `notBefore` backoff gate, succeed/fail/
 * requeue state, the bounded crash-recovery (`recoverRunning`), and the
 * "jobs append NO operation_log row" infra rule.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DbHandle, MIGRATIONS_DIR, migrateDatabase, openDatabase } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JobsRepository } from "./jobs-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repo: JobsRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  repo = new JobsRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Add `ms` to `now` and return an ISO string (future `notBefore` gate). */
function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

describe("JobsRepository", () => {
  it("enqueue writes a queued row with defaults", () => {
    const job = repo.enqueue({ type: "url_import", payload: { url: "https://x.test" } });
    expect(job.status).toBe("queued");
    expect(job.attempts).toBe(0);
    expect(job.maxAttempts).toBeGreaterThan(0);
    expect(job.progress.ratio).toBe(0);
    expect(job.result).toBeNull();
    expect(job.error).toBeNull();
    expect(repo.findById(job.id)?.payload).toEqual({ url: "https://x.test" });
  });

  it("embedJobStats counts INDEX embeds only — transient query embeds are excluded (U2)", () => {
    // Two INDEX embed jobs: one queued, one failed (with an error). A non-embed failed
    // job must NOT be counted, and its error must NOT leak into lastError.
    repo.enqueue({ type: "embed", payload: { elementId: "el_q", persist: true } });
    const toFail = repo.enqueue({ type: "embed", payload: { elementId: "el_f", persist: true } });
    repo.fail(toFail.id, "OVERSIZED: element text too large");
    const otherFail = repo.enqueue({ type: "ocr", payload: { elementId: "el_o" } });
    repo.fail(otherFail.id, "ocr boom");
    // Transient QUERY embeds (persist:false, no elementId) are search-time work, not
    // the index building — a queued one (in flight) and a failed one (timed out). They
    // must NOT inflate the counts, and the query timeout must NOT surface as lastError
    // (else typing a search would report "Indexing…" on a fully-embedded vault).
    repo.enqueue({ type: "embed", payload: { persist: false } });
    const queryFail = repo.enqueue({ type: "embed", payload: { persist: false } });
    repo.fail(queryFail.id, "QUERY_EMBED_TIMEOUT");

    const stats = repo.embedJobStats();
    expect(stats.queued).toBe(1);
    expect(stats.running).toBe(0);
    expect(stats.failed).toBe(1);
    expect(stats.lastError).toBe("OVERSIZED: element text too large");
  });

  it("embedJobStats is all-zero / null with no embed jobs", () => {
    repo.enqueue({ type: "ocr", payload: {} });
    const stats = repo.embedJobStats();
    expect(stats).toEqual({ queued: 0, running: 0, failed: 0, lastError: null });
  });

  it("activeOrFailedEmbedElementIds + clearFailedEmbedJobs surface/clear embed work (U4)", () => {
    const a = repo.enqueue({ type: "embed", payload: { elementId: "el_a", persist: true } });
    repo.fail(a.id, "OVERSIZED: element text too large");
    const b = repo.enqueue({ type: "embed", payload: { elementId: "el_b", persist: true } });
    repo.fail(b.id, "WORKER_CRASH: utility process died");
    // A still-queued embed (in-flight) is ALSO excluded so a manual reindex can't double-queue it.
    repo.enqueue({ type: "embed", payload: { elementId: "el_queued", persist: true } });
    // A query embed (no elementId) contributes no element id.
    const q = repo.enqueue({ type: "embed", payload: { persist: false } });
    repo.fail(q.id, "timeout");
    // A non-embed failed job is ignored entirely.
    const ocr = repo.enqueue({ type: "ocr", payload: { elementId: "el_o" } });
    repo.fail(ocr.id, "ocr boom");

    // queued + running + failed embed elements are all excluded from reindex.
    expect(repo.activeOrFailedEmbedElementIds().sort()).toEqual(["el_a", "el_b", "el_queued"]);

    // clearFailedEmbedJobs only clears FAILED rows (not the still-queued one).
    expect(repo.clearFailedEmbedJobs().sort()).toEqual(["el_a", "el_b"]);
    // After clearing, no failed embed jobs remain — failedCount is honest post-retry.
    expect(repo.embedJobStats().failed).toBe(0);
    // Only the still-queued element remains excluded (the failed ones were cleared).
    expect(repo.activeOrFailedEmbedElementIds()).toEqual(["el_queued"]);
    // The non-embed failed job is untouched.
    expect(repo.findById(ocr.id)?.status).toBe("failed");
  });

  it("accepts the fsrs_optimize job type (T080 — the widened jobs_type_check CHECK)", () => {
    // The 0019 table-rebuild migration widened the `jobs.type` CHECK to include
    // `fsrs_optimize`; enqueuing it must NOT throw a CHECK-constraint error.
    const job = repo.enqueue({ type: "fsrs_optimize", payload: { history: [] } });
    expect(job.type).toBe("fsrs_optimize");
    expect(repo.findById(job.id)?.type).toBe("fsrs_optimize");
  });

  it("claimNext flips exactly one row to running; a second claim returns null (no double-claim)", () => {
    const job = repo.enqueue({ type: "url_import", payload: { url: "a" } });
    const claimed = repo.claimNext();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).not.toBeNull();
    expect(claimed?.attempts).toBe(1); // incremented at claim time

    // No other queued job remains, so a second claim finds nothing.
    expect(repo.claimNext()).toBeNull();
  });

  it("claimNext returns the OLDEST queued job (FIFO)", () => {
    const first = repo.enqueue({ type: "url_import", payload: { n: 1 } });
    const second = repo.enqueue({ type: "url_import", payload: { n: 2 } });
    expect(repo.claimNext()?.id).toBe(first.id);
    // Mark the first done so only the second remains claimable.
    repo.succeed(first.id, null);
    expect(repo.claimNext()?.id).toBe(second.id);
  });

  it("does NOT claim a job whose notBefore is in the future", () => {
    const job = repo.enqueue({ type: "url_import", payload: {} });
    // Move it into the future via a requeue backoff gate.
    repo.requeue(job.id, { notBefore: isoIn(60_000) });
    expect(repo.claimNext()).toBeNull();
    // Once the gate passes (claim with a `now` after it), it is claimable again.
    expect(repo.claimNext(isoIn(120_000))?.id).toBe(job.id);
  });

  it("succeed records the terminal succeeded state + result + 100% progress", () => {
    const job = repo.enqueue({ type: "url_import", payload: {} });
    repo.claimNext();
    repo.succeed(job.id, { status: "imported", id: "src-1" });
    const stored = repo.findById(job.id);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.result).toEqual({ status: "imported", id: "src-1" });
    expect(stored?.progress.ratio).toBe(1);
    expect(stored?.finishedAt).not.toBeNull();
  });

  it("fail records the terminal failed state + error", () => {
    const job = repo.enqueue({ type: "url_import", payload: {} });
    repo.claimNext();
    repo.fail(job.id, "fetch_failed: could not reach host");
    const stored = repo.findById(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toContain("fetch_failed");
    expect(stored?.finishedAt).not.toBeNull();
  });

  it("requeue(incrementAttempts) re-queues with a backoff gate and bumps attempts", () => {
    const job = repo.enqueue({ type: "url_import", payload: {} });
    repo.claimNext(); // attempts → 1
    repo.requeue(job.id, { notBefore: isoIn(5_000), incrementAttempts: true });
    const stored = repo.findById(job.id);
    expect(stored?.status).toBe("queued");
    expect(stored?.attempts).toBe(2);
    expect(stored?.notBefore).not.toBeNull();
    expect(stored?.startedAt).toBeNull();
    expect(stored?.error).toBeNull();
  });

  it("markProgress updates the ratio + note on a running job", () => {
    const job = repo.enqueue({ type: "url_import", payload: {} });
    repo.claimNext();
    repo.markProgress(job.id, { ratio: 0.5, note: "fetching" });
    const stored = repo.findById(job.id);
    expect(stored?.progress.ratio).toBe(0.5);
    expect(stored?.progress.note).toBe("fetching");
  });

  it("cancel on a queued job yields cancelled (the job never runs)", () => {
    const job = repo.enqueue({ type: "url_import", payload: {} });
    repo.cancel(job.id);
    expect(repo.findById(job.id)?.status).toBe("cancelled");
    // A cancelled job is not claimable.
    expect(repo.claimNext()).toBeNull();
  });

  it("recoverRunning re-queues a running row left by a crash (within budget)", () => {
    const job = repo.enqueue({ type: "url_import", payload: {} });
    repo.claimNext(); // attempts → 1, status running (simulates a crash mid-run)
    const result = repo.recoverRunning();
    expect(result).toEqual({ requeued: 1, failed: 0 });
    const stored = repo.findById(job.id);
    expect(stored?.status).toBe("queued");
    expect(stored?.startedAt).toBeNull();
    expect(stored?.notBefore).toBeNull(); // re-runs promptly
  });

  it("recoverRunning marks a poison-on-start job terminal failed once its budget is spent", () => {
    const job = repo.enqueue({ type: "url_import", payload: {}, maxAttempts: 2 });
    // Two crash cycles: claim (attempts→1) + recover (re-queue), claim (attempts→2) + recover.
    repo.claimNext();
    expect(repo.recoverRunning()).toEqual({ requeued: 1, failed: 0 });
    repo.claimNext();
    // Now attempts === maxAttempts → the next crash-recovery marks it failed, not re-queued.
    const result = repo.recoverRunning();
    expect(result).toEqual({ requeued: 0, failed: 1 });
    const stored = repo.findById(job.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toMatch(/crashed/i);
    // It is bounded — never re-runs again.
    expect(repo.claimNext()).toBeNull();
  });

  it("list filters by status/type and returns newest-first", () => {
    const a = repo.enqueue({ type: "url_import", payload: { n: 1 } });
    const b = repo.enqueue({ type: "url_import", payload: { n: 2 } });
    repo.succeed(a.id, null);
    const queued = repo.list({ status: "queued" });
    expect(queued.map((j) => j.id)).toEqual([b.id]);
    expect(repo.list({ type: "url_import" })).toHaveLength(2);
    expect(repo.list({ type: "ocr" })).toHaveLength(0);
  });

  it("a job's full lifecycle appends NO operation_log row (jobs are infra)", () => {
    const ops = new OperationLogRepository(handle.db);
    const before = ops.count();
    const job = repo.enqueue({ type: "url_import", payload: {} });
    repo.claimNext();
    repo.markProgress(job.id, { ratio: 0.5 });
    repo.succeed(job.id, { ok: true });
    repo.recoverRunning();
    expect(ops.count()).toBe(before);
  });
});

/**
 * The 0019 migration is a `jobs` TABLE REBUILD (a new table + `INSERT…SELECT` +
 * drop/rename) that widens the `jobs_type_check` CHECK to admit `fsrs_optimize`
 * (T080). Because a rebuild copies rows out and back, this explicitly asserts the
 * rebuild PRESERVES existing `jobs` rows: stage the schema at 0018 (the narrow
 * CHECK), insert a job, apply ONLY 0019, then verify the pre-existing row survived
 * unchanged AND the widened CHECK now accepts `fsrs_optimize`.
 */
describe("0019 jobs rebuild — row preservation", () => {
  /** Copy migrations 0000..=0018 + a journal trimmed to those entries into a temp dir. */
  function stageMigrationsThrough18(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-mig18-"));
    const drizzle = path.join(dir, "drizzle");
    const meta = path.join(drizzle, "meta");
    fs.mkdirSync(meta, { recursive: true });
    const journal = JSON.parse(
      fs.readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const kept = journal.entries.filter((e) => e.idx <= 18);
    for (const entry of kept) {
      fs.copyFileSync(
        path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
        path.join(drizzle, `${entry.tag}.sql`),
      );
    }
    fs.writeFileSync(
      path.join(meta, "_journal.json"),
      JSON.stringify({ ...journal, entries: kept }),
    );
    return drizzle;
  }

  it("preserves a pre-existing jobs row across the 0019 table rebuild", () => {
    const stagedDir = stageMigrationsThrough18();
    const db = openDatabase(":memory:");
    try {
      // Schema at 0018 — the narrow CHECK (no `fsrs_optimize` yet).
      migrateDatabase(db.db, stagedDir);
      const repo18 = new JobsRepository(db.db);
      const existing = repo18.enqueue({
        type: "url_import",
        payload: { url: "https://x.test/before-0019" },
        maxAttempts: 7,
      });
      repo18.markProgress(existing.id, { ratio: 0.5, note: "mid-flight" });

      // Apply ONLY 0019 (the same handle; the drizzle journal skips 0000..=0018).
      migrateDatabase(db.db, MIGRATIONS_DIR);

      // The pre-existing row survived the INSERT…SELECT rebuild, unchanged.
      const repo19 = new JobsRepository(db.db);
      const survived = repo19.findById(existing.id);
      expect(survived).not.toBeNull();
      expect(survived?.type).toBe("url_import");
      expect(survived?.payload).toEqual({ url: "https://x.test/before-0019" });
      expect(survived?.maxAttempts).toBe(7);
      expect(survived?.progress.ratio).toBe(0.5);
      expect(survived?.progress.note).toBe("mid-flight");

      // And the widened CHECK now accepts the new type.
      const optimized = repo19.enqueue({ type: "fsrs_optimize", payload: { history: [] } });
      expect(repo19.findById(optimized.id)?.type).toBe("fsrs_optimize");
    } finally {
      db.sqlite.close();
      fs.rmSync(path.dirname(stagedDir), { recursive: true, force: true });
    }
  });
});
