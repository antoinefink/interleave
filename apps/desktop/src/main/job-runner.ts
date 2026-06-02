/**
 * JobRunner (T058) — the MAIN-side orchestrator for the on-device background job
 * queue.
 *
 * It OWNS the Electron `utilityProcess` worker, the in-memory tick loop, and the
 * job-type **apply** handlers; it is the only thing that calls
 * {@link JobsRepository}. The renderer never runs a job — it only OBSERVES job
 * state through `window.appApi.jobs.*`, which subscribes to this runner's
 * {@link observe} emitter.
 *
 * ## Mechanism decision: Electron `utilityProcess` (NOT `worker_threads`, NOT pg-boss)
 *
 * - **`utilityProcess` over `worker_threads`:** the worker must be cleanly
 *   isolated from the Electron main's V8 heap and event loop — a hostile/huge
 *   fetch or a future native OCR/PDF/embed job must not be able to corrupt or
 *   stall main. `utilityProcess` is Electron's first-class, supported out-of-
 *   process Node child with a message channel (`child.postMessage` /
 *   `child.on("message")`), proper lifecycle (`child.kill()`), and Electron-ABI
 *   compatibility. A same-process `worker_threads` worker could be tempted to
 *   share the `better-sqlite3` handle (forbidden — a single connection + WAL is
 *   the only safe model; a second connection from another thread invites
 *   `SQLITE_BUSY` / a corruptible WAL) and could crash the whole app on an
 *   unhandled native fault. We choose the stronger isolation.
 * - **The worker NEVER touches SQLite or the vault rows.** It does pure compute +
 *   network I/O and returns serializable data; ALL DB writes happen HERE in main,
 *   in a transaction, through the existing repositories (which append the correct
 *   existing `operation_log` entries). The single-writer invariant stays intact.
 * - **Bundling:** the worker is bundled into its own `dist/job-worker.cjs`
 *   (a third esbuild target) and forked by absolute path. It imports NO
 *   `@interleave/db` / `better-sqlite3` / repositories — only pure transforms.
 *
 * ## At-least-once + idempotency (apply-handler contract)
 *
 * Delivery is at-least-once: a crash-then-resume can re-run a job that had
 * already (partially or fully) applied. Therefore **every apply handler MUST be
 * idempotent or dedup-guarded.** The `url_import` apply is safe — T061 dedup
 * turns a re-run into a `"duplicate"` no-op. M14/M18 job types (OCR/embed/AI/
 * cleanup) inherit this requirement. Exactly-once is intentionally NOT attempted
 * (it would need a 2-phase commit across the process boundary).
 *
 * ## Persistence / restart
 *
 * The queue lives in the `jobs` SQLite table. {@link start} runs
 * `jobsRepo.recoverRunning()` once: a row left `running` by a crash is re-queued
 * (the crash consumed a retry — recovery Option A) or, if its budget is spent,
 * marked terminal `failed`. {@link stop} stops the loop and kills the worker but
 * leaves the persisted queue intact (pending jobs resume next launch). `stop()`
 * MUST run before `dbService.close()` so no apply handler writes to a closed DB.
 */

import { EventEmitter } from "node:events";
import type { Job, JobId, JobJsonValue, JobType } from "@interleave/core";
import type { JobsRepository } from "@interleave/local-db";
import { utilityProcess } from "electron";
import { type WorkerMessage, WorkerMessageSchema, type WorkerRequest } from "../worker/messages";

/**
 * A handler that APPLIES a job's worker result (the heavy DB write that stays in
 * main). It receives the original job (for its payload) + the worker's result
 * data and returns the serializable result to persist. It MUST be idempotent /
 * dedup-guarded (see the module docblock). It runs inside the runner's result
 * handling; throwing triggers the retry-or-fail decision.
 */
export type JobApplyHandler = (
  job: Job,
  resultData: JobJsonValue,
) => Promise<JobJsonValue> | JobJsonValue;

/** The apply-handler registry, keyed by job type. */
export type JobApplyHandlers = Partial<Record<JobType, JobApplyHandler>>;

/**
 * The minimal worker-handle surface the runner needs. The real implementation
 * wraps Electron's `utilityProcess`; a unit test injects a fake (no real child
 * process) via the `fork` factory.
 */
export interface WorkerHandle {
  /** Send a request to the worker. */
  postMessage(request: WorkerRequest): void;
  /** Subscribe to worker → main messages. */
  onMessage(listener: (message: WorkerMessage) => void): void;
  /** Terminate the worker. */
  kill(): void;
}

/** Factory that spawns a {@link WorkerHandle} (injectable for tests). */
export type WorkerForkFactory = () => WorkerHandle;

/** Constructor dependencies for {@link JobRunner}. */
export interface JobRunnerDeps {
  readonly jobsRepo: JobsRepository;
  readonly applyHandlers: JobApplyHandlers;
  /** Absolute path to the bundled `dist/job-worker.cjs` (real-fork mode). */
  readonly workerPath: string;
  /**
   * The asset-vault root (`<dataDir>/assets`), passed to the forked worker via
   * its env (`INTERLEAVE_ASSETS_DIR`) so a DB-free OCR job (T066) can resolve the
   * vault-relative page-image path MAIN prepared — the absolute root NEVER lands
   * in a persisted `jobs` row. Optional: the existing `url_import`/`vault_*` jobs
   * do not read it, so a runner built without it stays harmless.
   */
  readonly assetsDir?: string;
  /** Optional fork factory override (a fake worker for unit tests). */
  readonly fork?: WorkerForkFactory;
  /** Max in-flight jobs (fixed small concurrency); defaults to {@link DEFAULT_CONCURRENCY}. */
  readonly concurrency?: number;
  /**
   * Retry backoff base in ms (the gate is `base × 2^(attempts-1)`, capped).
   * Defaults to {@link RETRY_BACKOFF_BASE_MS}; a unit test sets it to 0 so a
   * retried job is immediately re-claimable without waiting on real time.
   */
  readonly retryBackoffBaseMs?: number;
}

/**
 * Fixed concurrency — small, so a slow job never starves the UI but the queue
 * still drains. 2 in-flight is plenty for T058 (the only real job is a network
 * fetch). Documented as a constant per the spec.
 */
export const DEFAULT_CONCURRENCY = 2;

/** Backoff for a retry: base × 2^(attempts-1), capped, in milliseconds. */
export const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_MAX_MS = 30_000;

function backoffMs(attempts: number, baseMs: number): number {
  const exp = baseMs * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, RETRY_BACKOFF_MAX_MS);
}

/**
 * Build the default real-`utilityProcess` fork factory. When `assetsDir` is set,
 * the worker is forked with `INTERLEAVE_ASSETS_DIR` in its env (the fork-env seam,
 * T066) so a DB-free OCR job can resolve the vault-relative page-image path. Env
 * is chosen over the job `payload` deliberately — the absolute vault root must
 * NEVER be written to a persisted, restart-safe `jobs` row.
 */
function defaultFork(workerPath: string, assetsDir?: string): WorkerForkFactory {
  return () => {
    const child = assetsDir
      ? utilityProcess.fork(workerPath, [], {
          env: { ...process.env, INTERLEAVE_ASSETS_DIR: assetsDir },
        })
      : utilityProcess.fork(workerPath);
    return {
      postMessage: (request) => child.postMessage(request),
      onMessage: (listener) => {
        child.on("message", (raw: unknown) => {
          const parsed = WorkerMessageSchema.safeParse(raw);
          if (!parsed.success) {
            console.error("[job-runner] rejected malformed worker message:", parsed.error.message);
            return;
          }
          listener(parsed.data);
        });
      },
      kill: () => {
        child.kill();
      },
    };
  };
}

export class JobRunner {
  private readonly jobsRepo: JobsRepository;
  private readonly applyHandlers: JobApplyHandlers;
  private readonly forkFactory: WorkerForkFactory;
  private readonly concurrency: number;
  private readonly retryBackoffBaseMs: number;
  /** Emits `"job:update"` with a {@link Job} snapshot on every state change. */
  private readonly emitter = new EventEmitter();
  private worker: WorkerHandle | null = null;
  private running = false;
  /** Job ids currently posted to the worker and awaiting a terminal message. */
  private readonly inFlight = new Set<string>();
  /** A pending tick scheduled via `setImmediate`, so we coalesce kicks. */
  private tickScheduled = false;

  constructor(deps: JobRunnerDeps) {
    this.jobsRepo = deps.jobsRepo;
    this.applyHandlers = deps.applyHandlers;
    this.forkFactory = deps.fork ?? defaultFork(deps.workerPath, deps.assetsDir);
    this.concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;
    this.retryBackoffBaseMs = deps.retryBackoffBaseMs ?? RETRY_BACKOFF_BASE_MS;
  }

  /** Spawn the worker, recover crashed jobs, and begin draining the queue. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.worker = this.forkFactory();
    this.worker.onMessage((message) => this.handleWorkerMessage(message));
    const recovered = this.jobsRepo.recoverRunning();
    if (recovered.requeued > 0 || recovered.failed > 0) {
      console.log(
        `[job-runner] recovered crashed jobs: ${recovered.requeued} re-queued, ${recovered.failed} failed`,
      );
    }
    this.kick();
  }

  /** Enqueue a `queued` job, kick the loop, and return the persisted row. */
  enqueue(type: JobType, payload: JobJsonValue, options?: { maxAttempts?: number }): Job {
    const job = this.jobsRepo.enqueue({
      type,
      payload,
      ...(options?.maxAttempts != null ? { maxAttempts: options.maxAttempts } : {}),
    });
    this.emit(job);
    this.kick();
    return job;
  }

  /** Cancel a queued/running job (best-effort; a running job's result is ignored). */
  cancel(id: JobId): void {
    this.jobsRepo.cancel(id);
    this.inFlight.delete(id);
    const job = this.jobsRepo.findById(id);
    if (job) this.emit(job);
    this.kick();
  }

  /** Subscribe to `job:update` snapshots; returns an unsubscribe fn. */
  observe(listener: (job: Job) => void): () => void {
    this.emitter.on("job:update", listener);
    return () => this.emitter.off("job:update", listener);
  }

  /**
   * Resolve when job `id` reaches a terminal state (`succeeded`/`failed`/
   * `cancelled`), built on the same `job:update` emitter. Resolves immediately if
   * the job is already terminal when called. This is the primitive the
   * await-terminal `importUrl` IPC path uses so main never blocks on the network
   * — only on the job's terminal snapshot.
   */
  waitForTerminal(id: JobId): Promise<Job> {
    const existing = this.jobsRepo.findById(id);
    if (existing && isTerminal(existing)) return Promise.resolve(existing);
    return new Promise<Job>((resolve) => {
      const unsubscribe = this.observe((job) => {
        if (job.id === id && isTerminal(job)) {
          unsubscribe();
          resolve(job);
        }
      });
    });
  }

  /** List jobs for the observe surface (delegates to the repo). */
  list(filter?: Parameters<JobsRepository["list"]>[0]): Job[] {
    return this.jobsRepo.list(filter);
  }

  /** Stop the loop and kill the worker; the persisted queue is left intact. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.worker?.kill();
    this.worker = null;
    this.inFlight.clear();
    this.emitter.removeAllListeners();
  }

  // --- internals -----------------------------------------------------------

  private emit(job: Job): void {
    this.emitter.emit("job:update", job);
  }

  /** Coalesce a tick onto the next microtask so rapid enqueues batch. */
  private kick(): void {
    if (!this.running || this.tickScheduled) return;
    this.tickScheduled = true;
    setImmediate(() => {
      this.tickScheduled = false;
      this.tick();
    });
  }

  /** Claim and post runnable jobs up to the concurrency cap. */
  private tick(): void {
    if (!this.running || !this.worker) return;
    while (this.inFlight.size < this.concurrency) {
      const job = this.jobsRepo.claimNext();
      if (!job) break;
      this.inFlight.add(job.id);
      this.emit(job);
      this.worker.postMessage({ jobId: job.id, type: job.type, payload: job.payload });
    }
  }

  private handleWorkerMessage(message: WorkerMessage): void {
    const jobId = message.jobId as JobId;
    // A cancelled job's worker result is ignored on arrival (best-effort cancel).
    if (!this.inFlight.has(jobId)) return;

    switch (message.kind) {
      case "progress": {
        // Normalize to a clean JobProgress (drop an undefined `note` under
        // exactOptionalPropertyTypes).
        this.jobsRepo.markProgress(jobId, {
          ratio: message.progress.ratio,
          ...(message.progress.note !== undefined ? { note: message.progress.note } : {}),
        });
        const job = this.jobsRepo.findById(jobId);
        if (job) this.emit(job);
        return;
      }
      case "result": {
        void this.applyResult(jobId, message.data);
        return;
      }
      case "error": {
        this.handleFailure(jobId, message.code, message.message);
        return;
      }
    }
  }

  /** Run the type's apply handler (the DB write in main) then mark succeeded. */
  private async applyResult(jobId: JobId, data: JobJsonValue): Promise<void> {
    const job = this.jobsRepo.findById(jobId);
    if (!job) {
      this.inFlight.delete(jobId);
      return;
    }
    const handler = this.applyHandlers[job.type];
    try {
      const result = handler ? await handler(job, data) : data;
      // The job may have been cancelled while applying; re-check before committing.
      const current = this.jobsRepo.findById(jobId);
      if (current && current.status === "cancelled") {
        this.inFlight.delete(jobId);
        this.kick();
        return;
      }
      this.jobsRepo.succeed(jobId, result ?? null);
    } catch (err) {
      const code = err instanceof Error && "code" in err ? String(err.code) : "apply_error";
      const messageText = err instanceof Error ? err.message : String(err);
      this.handleFailure(jobId, code, messageText);
      return;
    } finally {
      this.inFlight.delete(jobId);
    }
    const done = this.jobsRepo.findById(jobId);
    if (done) this.emit(done);
    this.kick();
  }

  /**
   * The retry-or-fail decision for a worker error or an apply throw. `attempts`
   * was incremented at claim time, so if it is still below `maxAttempts` the job
   * is re-queued with a backoff `notBefore`; otherwise it lands terminal `failed`.
   * The error message carries a leading `code:` so the IPC layer can reconstruct
   * the typed error.
   */
  private handleFailure(jobId: JobId, code: string, messageText: string): void {
    this.inFlight.delete(jobId);
    const job = this.jobsRepo.findById(jobId);
    if (!job) {
      this.kick();
      return;
    }
    const errorLine = `${code}: ${messageText}`;
    if (job.attempts < job.maxAttempts) {
      const notBefore = new Date(
        Date.now() + backoffMs(job.attempts, this.retryBackoffBaseMs),
      ).toISOString();
      this.jobsRepo.requeue(jobId, { notBefore });
    } else {
      this.jobsRepo.fail(jobId, errorLine);
    }
    const after = this.jobsRepo.findById(jobId);
    if (after) this.emit(after);
    this.kick();
  }
}

/** Whether a job has reached a terminal state. */
export function isTerminal(job: Job): boolean {
  return job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
}
