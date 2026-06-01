/**
 * Background-runner job model (T058) — the local, on-device job queue's domain
 * type.
 *
 * A {@link Job} is a unit of heavy/async work the Electron MAIN process enqueues
 * and a separate Electron `utilityProcess` WORKER executes off-main (so a slow
 * fetch / future OCR / embed never freezes the UI or blocks the single SQLite
 * writer). It is **local infrastructure**, NOT an {@link Element}: it carries no
 * lineage, appends NO `operation_log` entry, and never participates in the
 * element graph. A job MAY reference an element inside its typed
 * `payload`/`result`, but the job row itself is infra.
 *
 * The queue is **persisted** in the `jobs` SQLite table, so an in-flight job
 * survives an app restart: on launch the runner re-queues any row left `running`
 * by a crash (at-least-once delivery; apply handlers must be idempotent /
 * dedup-guarded) and resumes draining `queued` rows. Failed jobs retry with
 * backoff up to `maxAttempts`, then land terminal `failed` with the error
 * recorded.
 *
 * Framework-agnostic: no `fs`, no Electron, no SQLite here — this only models the
 * shape. The `payload`/`result` are job-type-specific and validated with Zod at
 * the enqueue + apply boundaries (mirroring the IPC-contract discipline); here
 * they are typed loosely as serializable JSON values so this leaf type stays
 * dependency-free.
 */

import type { JobStatus, JobType } from "./enums";
import type { IsoTimestamp, JobId } from "./ids";

/** A plain, JSON-serializable value carried in a job `payload`/`result`. */
export type JobJsonValue =
  | string
  | number
  | boolean
  | null
  | JobJsonValue[]
  | { readonly [key: string]: JobJsonValue };

/** Progress reported by the worker during a running job (`ratio` is 0–1). */
export interface JobProgress {
  /** Fraction complete, 0–1. */
  readonly ratio: number;
  /** An optional human-readable note (e.g. "fetching", "snapshotting"). */
  readonly note?: string;
}

/**
 * One background-runner job (`jobs` row). `attempts` counts how many times the
 * runner has STARTED this job; once it reaches `maxAttempts` the job lands
 * terminal `failed` rather than re-queueing. A crash-recovery reset (a `running`
 * row reset on the next launch) consumes a retry too (recovery Option A — the
 * crash counts against the budget), so a job that crashes the worker on every
 * launch is bounded to at most `maxAttempts` runs before it fails.
 */
export interface Job {
  readonly id: JobId;
  readonly type: JobType;
  /** Job-type-specific input, validated per `type` at enqueue. */
  readonly payload: JobJsonValue;
  readonly status: JobStatus;
  /** How many times the runner has started this job (incl. crash-recovery resets). */
  readonly attempts: number;
  /** Retry cap — at `attempts >= maxAttempts` the job lands terminal `failed`. */
  readonly maxAttempts: number;
  /** Progress 0–1 (stored as an integer percent in SQLite, 0–100). */
  readonly progress: JobProgress;
  /** The apply handler's serializable result, or `null` until terminal. */
  readonly result: JobJsonValue | null;
  /** A terminal error message (with a leading `code:` prefix), or `null`. */
  readonly error: string | null;
  /** A backoff gate (ISO) — the job is not claimable before this instant. */
  readonly notBefore: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** When the runner first marked it `running`, or `null`. */
  readonly startedAt: IsoTimestamp | null;
  /** When it reached a terminal state, or `null`. */
  readonly finishedAt: IsoTimestamp | null;
}
