/**
 * JobRunner unit tests (T058) — the main-side runner orchestration.
 *
 * Runs against a real temp-file SQLite DB (the desktop-main pattern: `new
 * DbService()` + `open()` under `mkdtempSync`) with a FAKE in-process worker
 * injected via the `fork` factory — so no real `utilityProcess` child is spawned
 * (that is an Electron-runtime-only API; it is exercised in the Electron E2E).
 * The fake worker lets the test drive `progress` / `result` / `error` replies and
 * assert the runner's claim → post → apply → succeed / retry-then-fail / cancel
 * behavior, plus that an observer saw the progress + completion.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Job } from "@interleave/core";
import { MIGRATIONS_DIR } from "@interleave/db";
import type { JobsRepository } from "@interleave/local-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerMessage, WorkerRequest } from "../worker/messages";
import { DbService } from "./db-service";
import { JobRunner, type WorkerHandle } from "./job-runner";

let dir: string;
let svc: DbService;
let jobsRepo: JobsRepository;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-runner-"));
  svc = new DbService();
  svc.open(path.join(dir, "app.sqlite"), {
    migrationsDir: MIGRATIONS_DIR,
    assetsDir: path.join(dir, "assets"),
  });
  jobsRepo = svc.repos.jobs;
});

afterEach(() => {
  svc.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A controllable fake worker: capture posted requests + push replies on demand. */
class FakeWorker implements WorkerHandle {
  readonly posted: WorkerRequest[] = [];
  private listener: ((message: WorkerMessage) => void) | null = null;
  killed = false;

  postMessage(request: WorkerRequest): void {
    this.posted.push(request);
  }
  onMessage(listener: (message: WorkerMessage) => void): void {
    this.listener = listener;
  }
  kill(): void {
    this.killed = true;
  }
  /** Push a worker → main message into the runner (simulates a worker reply). */
  reply(message: WorkerMessage): void {
    this.listener?.(message);
  }
  /** The most recent posted request (the one currently in flight). */
  get last(): WorkerRequest | undefined {
    return this.posted[this.posted.length - 1];
  }
}

/** Wait one macrotask so the runner's `setImmediate` tick has run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait until `predicate` holds (polling), or throw after a timeout. */
async function until(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: timed out");
    await flush();
  }
}

describe("JobRunner", () => {
  it("enqueue → post → progress → result → apply → succeeded; observer sees progress + completion", async () => {
    const fake = new FakeWorker();
    const applied: Array<{ job: Job; data: unknown }> = [];
    const runner = new JobRunner({
      jobsRepo,
      applyHandlers: {
        url_import: (job, data) => {
          applied.push({ job, data });
          return { status: "imported", id: "src-1" };
        },
      },
      workerPath: "(unused)",
      fork: () => fake,
    });
    const seen: string[] = [];
    runner.observe((j) => seen.push(j.status));
    runner.start();

    const job = runner.enqueue("url_import", { url: "https://x.test" });
    await until(() => fake.last !== undefined);
    expect(fake.last?.jobId).toBe(job.id);
    expect(fake.last?.type).toBe("url_import");

    // The worker reports progress, then a result; main applies + marks succeeded.
    fake.reply({ kind: "progress", jobId: job.id, progress: { ratio: 0.5, note: "fetching" } });
    fake.reply({
      kind: "result",
      jobId: job.id,
      data: { html: "<h1/>", finalUrl: "https://x.test" },
    });
    await until(() => jobsRepo.findById(job.id)?.status === "succeeded");

    const stored = jobsRepo.findById(job.id);
    expect(stored?.status).toBe("succeeded");
    expect(stored?.result).toEqual({ status: "imported", id: "src-1" });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.data).toEqual({ html: "<h1/>", finalUrl: "https://x.test" });
    expect(seen).toContain("running");
    expect(seen).toContain("succeeded");

    runner.stop();
    expect(fake.killed).toBe(true);
  });

  it("a worker error RETRIES up to maxAttempts (with backoff) then marks failed", async () => {
    const fake = new FakeWorker();
    // Zero backoff so a retried job is immediately re-claimable in-test.
    const runner = new JobRunner({
      jobsRepo,
      applyHandlers: {},
      workerPath: "(unused)",
      fork: () => fake,
      retryBackoffBaseMs: 0,
    });
    runner.start();

    const job = runner.enqueue("url_import", { url: "https://x.test" }, { maxAttempts: 2 });

    // Attempt 1: claimed (attempts→1), worker errors → requeued with a (zero) gate;
    // the runner's post-failure kick re-claims it for attempt 2.
    await until(() => fake.posted.length === 1);
    fake.reply({ kind: "error", jobId: job.id, code: "fetch_failed", message: "boom" });

    // Attempt 2: claimed (attempts→2 === maxAttempts), worker errors → terminal failed.
    await until(() => fake.posted.length === 2);
    fake.reply({ kind: "error", jobId: job.id, code: "fetch_failed", message: "boom again" });
    await until(() => jobsRepo.findById(job.id)?.status === "failed");

    const failed = jobsRepo.findById(job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(2);
    expect(failed?.error).toContain("fetch_failed");
    runner.stop();
  });

  it("cancel on a queued job yields cancelled and the job never runs", async () => {
    const fake = new FakeWorker();
    // Concurrency 0-ish: hold the worker by never letting the first job post —
    // simplest is to cancel BEFORE the tick posts it. Enqueue then cancel in the
    // same synchronous turn (before the setImmediate tick runs).
    const runner = new JobRunner({
      jobsRepo,
      applyHandlers: {},
      workerPath: "(unused)",
      fork: () => fake,
    });
    runner.start();
    const job = runner.enqueue("url_import", { url: "https://x.test" });
    runner.cancel(job.id); // synchronous, before the tick posts it
    await flush();
    expect(jobsRepo.findById(job.id)?.status).toBe("cancelled");
    expect(fake.posted).toHaveLength(0); // never posted to the worker
    runner.stop();
  });

  it("waitForTerminal resolves on the first terminal snapshot (and immediately if already terminal)", async () => {
    const fake = new FakeWorker();
    const runner = new JobRunner({
      jobsRepo,
      applyHandlers: { url_import: () => ({ status: "imported", id: "s" }) },
      workerPath: "(unused)",
      fork: () => fake,
    });
    runner.start();
    const job = runner.enqueue("url_import", { url: "https://x.test" });
    const terminalP = runner.waitForTerminal(job.id);
    await until(() => fake.last !== undefined);
    fake.reply({ kind: "result", jobId: job.id, data: { html: "", finalUrl: "https://x.test" } });
    const terminal = await terminalP;
    expect(terminal.status).toBe("succeeded");

    // Already-terminal job resolves immediately.
    await expect(runner.waitForTerminal(job.id)).resolves.toMatchObject({ status: "succeeded" });
    runner.stop();
  });

  it("start() runs recoverRunning (a crash-left running row is re-queued)", async () => {
    // Simulate a job left `running` by a previous crashed session.
    const stuck = jobsRepo.enqueue({ type: "url_import", payload: { url: "https://x.test" } });
    jobsRepo.claimNext(); // attempts → 1, status running
    expect(jobsRepo.findById(stuck.id)?.status).toBe("running");

    const fake = new FakeWorker();
    const spy = vi.spyOn(jobsRepo, "recoverRunning");
    const runner = new JobRunner({
      jobsRepo,
      applyHandlers: { url_import: () => ({ status: "imported", id: "s" }) },
      workerPath: "(unused)",
      fork: () => fake,
    });
    runner.start();
    expect(spy).toHaveBeenCalledTimes(1);
    // The recovered job re-runs: it is claimed + posted again.
    await until(() => fake.posted.some((r) => r.jobId === stuck.id));
    runner.stop();
  });

  it("getJobSecrets injects a secret into the POSTED payload but NEVER persists it (T087 key leak guard)", async () => {
    const fake = new FakeWorker();
    // The "live" secret the provider reads — mutated mid-run to prove it is read
    // at POST time (a runtime key change is picked up without a restart/re-enqueue).
    let liveKey = "sk-first";
    const runner = new JobRunner({
      jobsRepo,
      applyHandlers: { embed: () => ({ ok: true }) },
      workerPath: "(unused)",
      fork: () => fake,
      // Mirror the index.ts wiring: only `embed` jobs get the key, read live.
      getJobSecrets: (job) => (job.type === "embed" ? { apiKey: liveKey } : {}),
    });
    runner.start();

    const job = runner.enqueue("embed", { text: "hello", provider: "api", persist: true });

    // The PERSISTED row must NOT carry the key (the whole point of the fix).
    const stored = jobsRepo.findById(job.id);
    expect((stored?.payload as { apiKey?: string }).apiKey).toBeUndefined();
    expect((stored?.payload as { text?: string }).text).toBe("hello");

    // The POSTED payload (worker-bound, transient) DOES carry the live key.
    await until(() => fake.last !== undefined);
    expect((fake.last?.payload as { apiKey?: string }).apiKey).toBe("sk-first");
    expect((fake.last?.payload as { text?: string }).text).toBe("hello");

    // Finish the first job, change the key, run a second job: the NEW key is posted.
    fake.reply({ kind: "result", jobId: job.id, data: null });
    await until(() => jobsRepo.findById(job.id)?.status === "succeeded");
    liveKey = "sk-second";
    const job2 = runner.enqueue("embed", { text: "world", provider: "api", persist: true });
    await until(() => fake.posted.some((r) => r.jobId === job2.id));
    const posted2 = fake.posted.find((r) => r.jobId === job2.id);
    expect((posted2?.payload as { apiKey?: string }).apiKey).toBe("sk-second");
    // And the second persisted row is still secret-free.
    expect((jobsRepo.findById(job2.id)?.payload as { apiKey?: string }).apiKey).toBeUndefined();

    runner.stop();
  });

  it("getJobSecrets adds nothing for a job type that needs no secret", async () => {
    const fake = new FakeWorker();
    const runner = new JobRunner({
      jobsRepo,
      applyHandlers: { url_import: () => ({ status: "imported", id: "s" }) },
      workerPath: "(unused)",
      fork: () => fake,
      getJobSecrets: (job) => (job.type === "embed" ? { apiKey: "sk" } : {}),
    });
    runner.start();
    runner.enqueue("url_import", { url: "https://x.test" });
    await until(() => fake.last !== undefined);
    // A url_import post carries exactly its payload — no injected secret.
    expect(fake.last?.payload).toEqual({ url: "https://x.test" });
    expect((fake.last?.payload as { apiKey?: string }).apiKey).toBeUndefined();
    runner.stop();
  });
});
