/**
 * JobsRepository unit tests (T058) — the persisted background-runner queue.
 *
 * Runs against this package's own in-memory `createInMemoryDb()` harness (the
 * same one the other repo tests use). Covers the load-bearing queue invariants:
 * single-claim (no double-claim), the `notBefore` backoff gate, succeed/fail/
 * requeue state, the bounded crash-recovery (`recoverRunning`), and the
 * "jobs append NO operation_log row" infra rule.
 */

import type { DbHandle } from "@interleave/db";
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
