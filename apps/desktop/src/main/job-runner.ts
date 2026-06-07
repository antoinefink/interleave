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
 * An out-of-band secret provider (T087). Returns a small JSON object of secret
 * fields to MERGE into a job's payload AT POST TIME ONLY — these fields are NEVER
 * written to the persisted `jobs` row. This is the side-channel discipline the
 * fork-env vars (`INTERLEAVE_ASSETS_DIR`/`INTERLEAVE_MODEL_DIR`) use for absolute
 * paths, applied to the far-more-sensitive user embedding-API key: it is read LIVE
 * from SQLite settings on every post (so a runtime key change is picked up without
 * an app restart) and injected into the worker request, but the persisted payload
 * stays secret-free. Returns `{}` / `undefined` for a job that needs no secret.
 */
export type JobSecretsProvider = (job: Job) => Record<string, JobJsonValue> | undefined;

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
  /**
   * The local embedding-model directory (`<dataDir>/models`), passed to the forked
   * worker via `INTERLEAVE_MODEL_DIR` (T087) so a DB-free `embed` job can resolve a
   * real ONNX model path — the same fork-env seam as `INTERLEAVE_ASSETS_DIR`, one
   * more var. Optional: the default deterministic embedder reads no model from it,
   * so a runner built without it stays harmless.
   */
  readonly modelDir?: string;
  /**
   * The user's OWN AI-API key (T093), baked into the worker fork env as
   * `INTERLEAVE_AI_API_KEY` when AI is enabled. Unlike the embedding key (which rides
   * the per-job `getJobSecrets` out-of-band channel), the AI key uses the FORK-ENV seam
   * because the single long-lived worker has no per-job env channel — so enabling AI /
   * changing the key requires {@link restartWorker} to re-fork with the new env. NEVER
   * written to a persisted `jobs` row. Optional: a runner built without it has no AI key.
   */
  readonly aiApiKey?: string;
  /** The AI provider kind (T093), baked into the worker fork env as `INTERLEAVE_AI_PROVIDER`. */
  readonly aiProviderKind?: string;
  /**
   * Out-of-band per-job secret provider (T087). When set, the runner calls it at
   * POST time and merges the returned fields into the worker request payload — the
   * persisted `jobs` row never holds them. Used to thread the user's embedding-API
   * key to the DB-free worker WITHOUT writing it to a restart-safe job payload (the
   * same secret-keeping discipline as the `INTERLEAVE_ASSETS_DIR` fork-env var).
   */
  readonly getJobSecrets?: JobSecretsProvider;
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

/** The fork-env values baked into the worker at construction (the secret/path seam). */
interface ForkEnv {
  readonly assetsDir?: string | undefined;
  readonly modelDir?: string | undefined;
  /** The AI model dir (T093) — `INTERLEAVE_AI_MODEL_DIR` (the local instruction model). */
  readonly aiModelDir?: string | undefined;
  /** The user's OWN AI key (T093) — `INTERLEAVE_AI_API_KEY`; NEVER in a persisted row. */
  readonly aiApiKey?: string | undefined;
  /** The AI provider kind (T093) — `INTERLEAVE_AI_PROVIDER`. */
  readonly aiProviderKind?: string | undefined;
}

/**
 * Build the default real-`utilityProcess` fork factory. When `assetsDir` is set,
 * the worker is forked with `INTERLEAVE_ASSETS_DIR` in its env (the fork-env seam,
 * T066) so a DB-free OCR job can resolve the vault-relative page-image path. Env
 * is chosen over the job `payload` deliberately — the absolute vault root + the
 * AI key (T093) must NEVER be written to a persisted, restart-safe `jobs` row. The
 * factory READS the current `forkEnv` on every call, so a `restartWorker()` re-fork
 * picks up a changed AI key/provider.
 */
function defaultFork(workerPath: string, getForkEnv: () => ForkEnv): WorkerForkFactory {
  return () => {
    // Thread the fork-env seam: the vault root (OCR, T066) + the embed model dir (T087)
    // + the AI key/provider/model dir (T093). The absolute roots + the secret key NEVER
    // land in a persisted `jobs` row. Read live so a re-fork picks up a changed AI key.
    const fe = getForkEnv();
    const hasEnv = fe.assetsDir || fe.modelDir || fe.aiModelDir || fe.aiApiKey || fe.aiProviderKind;
    const env = hasEnv
      ? {
          ...process.env,
          ...(fe.assetsDir ? { INTERLEAVE_ASSETS_DIR: fe.assetsDir } : {}),
          ...(fe.modelDir ? { INTERLEAVE_MODEL_DIR: fe.modelDir } : {}),
          ...(fe.aiModelDir ? { INTERLEAVE_AI_MODEL_DIR: fe.aiModelDir } : {}),
          ...(fe.aiApiKey ? { INTERLEAVE_AI_API_KEY: fe.aiApiKey } : {}),
          ...(fe.aiProviderKind ? { INTERLEAVE_AI_PROVIDER: fe.aiProviderKind } : {}),
        }
      : undefined;
    const child = env
      ? utilityProcess.fork(workerPath, [], { env })
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
  private readonly getJobSecrets: JobSecretsProvider | undefined;
  private readonly concurrency: number;
  private readonly retryBackoffBaseMs: number;
  /** Emits `"job:update"` with a {@link Job} snapshot on every state change. */
  private readonly emitter = new EventEmitter();
  private worker: WorkerHandle | null = null;
  private running = false;
  /** Job ids currently posted to the worker and awaiting a terminal message. */
  private readonly inFlight = new Set<string>();
  /** Main-side apply handlers already running after a worker result arrived. */
  private readonly activeApplies = new Set<Promise<void>>();
  /** A pending tick scheduled via `setImmediate`, so we coalesce kicks. */
  private tickScheduled = false;
  /**
   * The mutable fork-env (T093) the default fork factory reads on every fork — so a
   * {@link restartWorker} re-fork picks up a changed AI key/provider. Only the AI
   * fields change at runtime (the vault/model dirs are static); they are read live by
   * the factory closure.
   */
  private forkEnv: ForkEnv;
  /**
   * A deferred restart (T093): set when {@link restartWorker} is requested while jobs
   * are in flight, so the re-fork happens on the transition to an EMPTY `inFlight` set
   * (NOT after just the first of two concurrent jobs finishes) — toggling an AI setting
   * never kills + re-runs an unrelated in-flight OCR/url_import/embed job.
   */
  private pendingRestart = false;

  constructor(deps: JobRunnerDeps) {
    this.jobsRepo = deps.jobsRepo;
    this.applyHandlers = deps.applyHandlers;
    this.forkEnv = {
      ...(deps.assetsDir ? { assetsDir: deps.assetsDir } : {}),
      ...(deps.modelDir ? { modelDir: deps.modelDir } : {}),
      // The AI model dir reuses the embed model dir root (`<dataDir>/models`).
      ...(deps.modelDir ? { aiModelDir: deps.modelDir } : {}),
      ...(deps.aiApiKey ? { aiApiKey: deps.aiApiKey } : {}),
      ...(deps.aiProviderKind ? { aiProviderKind: deps.aiProviderKind } : {}),
    };
    this.forkFactory = deps.fork ?? defaultFork(deps.workerPath, () => this.forkEnv);
    this.getJobSecrets = deps.getJobSecrets;
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
    this.maybeRunPendingRestart();
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
    this.pendingRestart = false;
    this.emitter.removeAllListeners();
  }

  /** Stop worker activity and wait for main-side apply handlers already running. */
  async stopAndDrain(): Promise<void> {
    this.stop();
    if (this.activeApplies.size === 0) return;
    await Promise.allSettled([...this.activeApplies]);
  }

  /**
   * Re-fork the single worker with the current fork env (T093) — used when the AI
   * enable/key/provider settings change, so the new `INTERLEAVE_AI_API_KEY` /
   * `INTERLEAVE_AI_PROVIDER` takes effect (the worker bakes env at construction; there
   * is no per-job env channel today). The persisted queue is UNTOUCHED — only the
   * worker process is replaced.
   *
   * **Gated on IDLE — `inFlight.size === 0` (ALL in-flight jobs drained).** The runner
   * forks ONE worker but posts up to {@link DEFAULT_CONCURRENCY} jobs to it concurrently,
   * so there can be TWO unrelated in-flight jobs at restart time; killing the worker
   * mid-flight would kill BOTH (e.g. an OCR page AND a `url_import`), which would then
   * requeue + re-run purely because the user toggled an AI setting. So if `inFlight` is
   * non-empty we DEFER (set `pendingRestart`) and re-fork on the transition to an EMPTY
   * `inFlight` set ({@link maybeRunPendingRestart}, called when `inFlight` reaches 0) —
   * NOT after just the first of two concurrent jobs finishes.
   *
   * Because the re-fork is gated on idle, NOTHING is in flight at re-fork time — so the
   * idle path does NOT depend on `recoverRunning()` (it runs only in `start()`); a bare
   * re-fork has no kill-mid-job to recover from.
   *
   * @param aiEnv the new AI fork-env fields (key/provider) to bake into the next fork.
   */
  restartWorker(aiEnv?: {
    aiApiKey?: string | undefined;
    aiProviderKind?: string | undefined;
  }): void {
    if (!this.running) return;
    // Update the live fork env the factory reads on the next fork. An empty key clears
    // the env var (a key removal must not leave a stale key baked in the worker).
    if (aiEnv) {
      this.forkEnv = {
        ...this.forkEnv,
        ...(aiEnv.aiApiKey !== undefined
          ? aiEnv.aiApiKey
            ? { aiApiKey: aiEnv.aiApiKey }
            : { aiApiKey: undefined }
          : {}),
        ...(aiEnv.aiProviderKind !== undefined ? { aiProviderKind: aiEnv.aiProviderKind } : {}),
      };
    }
    if (this.inFlight.size > 0) {
      // Defer until the worker is fully idle (the transition to an empty inFlight set).
      this.pendingRestart = true;
      return;
    }
    this.reforkNow();
  }

  // --- internals -----------------------------------------------------------

  /** Kill + re-fork the single worker, re-subscribing the message handler. */
  private reforkNow(): void {
    this.pendingRestart = false;
    this.worker?.kill();
    this.worker = this.forkFactory();
    this.worker.onMessage((message) => this.handleWorkerMessage(message));
    this.kick();
  }

  /**
   * Run a deferred {@link restartWorker} once the worker is fully idle. Called whenever
   * `inFlight` may have just reached 0 (an apply/failure drained the last in-flight job).
   * Re-forks ONLY on the transition to an empty set — not after a single job of two.
   */
  private maybeRunPendingRestart(): void {
    if (this.pendingRestart && this.inFlight.size === 0) {
      this.reforkNow();
    }
  }

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
      // Merge any out-of-band secrets (e.g. the embedding-API key) into the payload
      // sent to the worker — read LIVE here, NEVER from / written back to the
      // persisted `jobs` row, so a runtime key change is picked up and the secret
      // never lands on disk.
      this.worker.postMessage({
        jobId: job.id,
        type: job.type,
        payload: this.payloadWithSecrets(job),
      });
    }
  }

  /**
   * Build the worker-bound payload for a job: the persisted payload, with any
   * out-of-band secrets merged LAST (so a live secret wins over a stale/absent
   * payload field). The returned object is a transient copy — the persisted
   * `job.payload` is untouched and never carries the secret.
   */
  private payloadWithSecrets(job: Job): JobJsonValue {
    const secrets = this.getJobSecrets?.(job);
    if (!secrets || Object.keys(secrets).length === 0) return job.payload;
    const base =
      job.payload && typeof job.payload === "object" && !Array.isArray(job.payload)
        ? job.payload
        : {};
    return { ...base, ...secrets };
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
        const apply = this.applyResult(jobId, message.data);
        this.activeApplies.add(apply);
        void apply.finally(() => {
          this.activeApplies.delete(apply);
        });
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
      this.maybeRunPendingRestart();
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
        this.maybeRunPendingRestart();
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
    // A deferred AI-key restart re-forks ONLY now that the worker is fully idle.
    this.maybeRunPendingRestart();
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
    // A deferred AI-key restart re-forks ONLY now that the worker is fully idle.
    this.maybeRunPendingRestart();
  }
}

/** Whether a job has reached a terminal state. */
export function isTerminal(job: Job): boolean {
  return job.status === "succeeded" || job.status === "failed" || job.status === "cancelled";
}
