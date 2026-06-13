/**
 * JobsRepository (T058) — the typed, transactional persistence seam for the
 * on-device background-runner queue.
 *
 * This is the ONLY place the `jobs` table is read/written. The runner in the
 * Electron MAIN process calls it; nothing else does (the worker is DB-free, and
 * the renderer only OBSERVES jobs via `window.appApi`). The queue lives in SQLite
 * so it survives an app restart — see {@link JobsRepository.recoverRunning}.
 *
 * Jobs append NO `operation_log` entry. A job is local INFRASTRUCTURE, not a
 * domain mutation (mirroring `AssetRepository`'s "asset rows have no dedicated
 * operation" note): the job lifecycle — enqueue / claim / progress / succeed /
 * fail / requeue / cancel — is infra bookkeeping. A job that mutates DOMAIN data
 * does so in MAIN through the existing repositories, which append the correct
 * existing op (`create_source` / `update_document` / …) inside their own
 * transaction. So a job's full lifecycle leaves the op-log count unchanged.
 *
 * **Poison-job bound (recovery Option A).** {@link recoverRunning} resets each
 * row left `running` by a crash to `queued` AND increments `attempts` — a crash
 * consumes a retry. If that pushes `attempts >= maxAttempts`, the row is marked
 * terminal `failed` instead of re-queueing. This needs no extra column (it reuses
 * `attempts`/`maxAttempts`) and bounds a job that crashes the worker on every
 * launch to at most `maxAttempts` runs before it lands `failed`. The
 * retry-vs-terminal decision for a normal worker failure lives in the
 * `JobRunner` (it calls {@link requeue} or {@link fail}); this repository only
 * persists the chosen state.
 */

import type { Job, JobId, JobJsonValue, JobProgress, JobStatus, JobType } from "@interleave/core";
import { type InterleaveDatabase, type JobRow, jobs } from "@interleave/db";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { newJobId, nowIso } from "./ids";
import type { DbClient } from "./types";

/** A terminal-state error message a crash-recovery reset records. */
const CRASH_FAIL_ERROR = "crashed: job exceeded its retry budget after a crash-recovery reset";

/** Input to {@link JobsRepository.enqueue}. */
export interface EnqueueJobInput {
  readonly type: JobType;
  readonly payload: JobJsonValue;
  /** Retry cap; defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number;
}

/** Filter for {@link JobsRepository.list} (the observe surface). */
export interface JobListFilter {
  /** Only jobs with this status. */
  readonly status?: JobStatus;
  /** Only jobs of this type. */
  readonly type?: JobType;
  /** Cap the number of rows returned (newest-first). */
  readonly limit?: number;
}

/** Default retry cap for an enqueued job (start + up to 2 retries). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Cap on how many element ids {@link JobsRepository.activeOrFailedEmbedElementIds}
 * returns, so the downstream `NOT IN (...)` exclusion stays well under SQLite's
 * bound-parameter limit even under a pathological mass-failure. Safe to cap: a few
 * uncovered elements just get re-enqueued (idempotent UPSERT), not corrupted.
 */
const EXCLUDE_IDS_CAP = 500;

/** Clamp a 0–1 ratio to an integer percent 0–100 for storage. */
function ratioToPercent(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

/** Parse a stored JSON column to a {@link JobJsonValue}, or `null` on absence/parse error. */
function parseJson(value: string | null): JobJsonValue | null {
  if (value == null) return null;
  try {
    return JSON.parse(value) as JobJsonValue;
  } catch {
    return null;
  }
}

/** Map a `jobs` row to the domain {@link Job}. */
export function rowToJob(row: JobRow): Job {
  const progress: JobProgress = {
    ratio: row.progressRatio / 100,
    ...(row.progressNote != null ? { note: row.progressNote } : {}),
  };
  return {
    id: row.id as JobId,
    type: row.type as JobType,
    payload: parseJson(row.payload) ?? null,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    progress,
    result: parseJson(row.result),
    error: row.error,
    notBefore: row.notBefore,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export class JobsRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /** Insert a fresh `queued` job and return the domain {@link Job}. */
  enqueue(input: EnqueueJobInput): Job {
    const id = newJobId();
    const now = nowIso();
    const row: JobRow = {
      id,
      type: input.type,
      status: "queued",
      payload: JSON.stringify(input.payload),
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      progressRatio: 0,
      progressNote: null,
      notBefore: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    this.db.insert(jobs).values(row).run();
    return rowToJob(row);
  }

  /**
   * Atomically claim the oldest runnable job — the oldest `queued` row whose
   * `notBefore` is null or ≤ `now` — and flip it to `running` (+ `startedAt`,
   * + `attempts`) in ONE transaction so two runner ticks never claim the same
   * job. Returns the claimed {@link Job}, or `null` if nothing is runnable.
   *
   * `attempts` is incremented HERE (on claim/start), so a job that the worker
   * crashes mid-run has already consumed the attempt — consistent with the
   * crash-recovery budget in {@link recoverRunning}.
   */
  claimNext(now: string = nowIso()): Job | null {
    return this.db.transaction((tx) => {
      const candidate = tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, "queued"), or(isNull(jobs.notBefore), lte(jobs.notBefore, now))))
        .orderBy(asc(jobs.createdAt))
        .limit(1)
        .get();
      if (!candidate) return null;
      tx.update(jobs)
        .set({
          status: "running",
          startedAt: now,
          attempts: candidate.attempts + 1,
          updatedAt: now,
        })
        .where(eq(jobs.id, candidate.id))
        .run();
      const claimed = tx.select().from(jobs).where(eq(jobs.id, candidate.id)).get();
      if (!claimed) throw new Error("JobsRepository.claimNext: row missing after claim");
      return rowToJob(claimed);
    });
  }

  /** Record progress (0–1 ratio + optional note) on a running job. */
  markProgress(id: JobId, progress: JobProgress): void {
    this.db
      .update(jobs)
      .set({
        progressRatio: ratioToPercent(progress.ratio),
        progressNote: progress.note ?? null,
        updatedAt: nowIso(),
      })
      .where(eq(jobs.id, id))
      .run();
  }

  /** Mark a job `succeeded` with its serializable result + 100% progress. */
  succeed(id: JobId, result: JobJsonValue): void {
    const now = nowIso();
    this.db
      .update(jobs)
      .set({
        status: "succeeded",
        result: JSON.stringify(result ?? null),
        error: null,
        progressRatio: 100,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(jobs.id, id))
      .run();
  }

  /**
   * Mark a job terminal `failed` with its error. The retry-vs-terminal decision
   * lives in the runner (it calls {@link requeue} for a retry, or this for a
   * terminal failure once the budget is spent); this only writes the failed row.
   */
  fail(id: JobId, error: string): void {
    const now = nowIso();
    this.db
      .update(jobs)
      .set({ status: "failed", error, finishedAt: now, updatedAt: now })
      .where(eq(jobs.id, id))
      .run();
  }

  /**
   * Re-queue a job for a retry with a backoff gate. `attempts` was already
   * incremented at {@link claimNext}, so the runner passes
   * `incrementAttempts: false` here normally; the flag exists for callers that
   * re-queue WITHOUT a prior claim. Clears `startedAt`/`error` so the next claim
   * is a fresh start.
   */
  requeue(id: JobId, options: { notBefore: string; incrementAttempts?: boolean }): void {
    const now = nowIso();
    const set: Record<string, unknown> = {
      status: "queued",
      notBefore: options.notBefore,
      startedAt: null,
      error: null,
      updatedAt: now,
    };
    if (options.incrementAttempts) {
      set.attempts = sql`${jobs.attempts} + 1`;
    }
    this.db.update(jobs).set(set).where(eq(jobs.id, id)).run();
  }

  /**
   * Cancel a job. A `queued` job is marked `cancelled` so it never runs; a
   * `running` job is also marked `cancelled` (its worker result is ignored by the
   * runner on arrival — best-effort, no hard kill). A terminal job is left as-is.
   */
  cancel(id: JobId): void {
    const now = nowIso();
    this.db
      .update(jobs)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(and(eq(jobs.id, id), or(eq(jobs.status, "queued"), eq(jobs.status, "running"))))
      .run();
  }

  /**
   * Restart-resume primitive (run ONCE on startup). Every row left `running` was
   * interrupted by a crash (the app died mid-job). For each such row, recovery
   * Option A applies: the crash consumes a retry, so it is reset to `queued` —
   * BUT if it has already spent its budget (`attempts >= maxAttempts`, where
   * `attempts` was incremented at claim time), it is marked terminal `failed`
   * instead, so a job that crashes the worker on every launch is bounded, not
   * looping forever. Returns how many it re-queued vs. failed.
   *
   * This is at-least-once delivery — a re-queued job that had already (partially
   * or fully) applied will re-run, so every apply handler MUST be idempotent or
   * dedup-guarded (the `url_import` apply is: T061 dedup turns a re-run into a
   * `"duplicate"` no-op).
   */
  recoverRunning(): { requeued: number; failed: number } {
    return this.db.transaction((tx) => {
      const stuck = tx.select().from(jobs).where(eq(jobs.status, "running")).all();
      let requeued = 0;
      let failed = 0;
      const now = nowIso();
      for (const row of stuck) {
        if (row.attempts >= row.maxAttempts) {
          tx.update(jobs)
            .set({ status: "failed", error: CRASH_FAIL_ERROR, finishedAt: now, updatedAt: now })
            .where(eq(jobs.id, row.id))
            .run();
          failed += 1;
        } else {
          // The crash already consumed the attempt at claim time; reset to queued
          // (no notBefore — it should re-run promptly) and clear startedAt.
          tx.update(jobs)
            .set({ status: "queued", startedAt: null, notBefore: null, updatedAt: now })
            .where(eq(jobs.id, row.id))
            .run();
          requeued += 1;
        }
      }
      return { requeued, failed };
    });
  }

  /** Fetch one job by id, or `null`. */
  findById(id: JobId): Job | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? rowToJob(row) : null;
  }

  /** List jobs (newest-first) for the observe surface, optionally filtered. */
  list(filter: JobListFilter = {}): Job[] {
    const conditions = [];
    if (filter.status) conditions.push(eq(jobs.status, filter.status));
    if (filter.type) conditions.push(eq(jobs.type, filter.type));
    const base = this.db
      .select()
      .from(jobs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(sql`${jobs.createdAt} DESC`);
    const rows = filter.limit != null ? base.limit(filter.limit).all() : base.all();
    return rows.map(rowToJob);
  }

  /**
   * Aggregate `embed` job state for the semantic status surface (U2). Returns how
   * many embed jobs are `queued`/`running` (the index is "building") and `failed`
   * (retries exhausted, surfaced + retryable), plus the most recent failed embed's
   * raw error text (the UI renders it in plain language). Pure read; no op-log.
   */
  embedJobStats(): {
    queued: number;
    running: number;
    failed: number;
    lastError: string | null;
  } {
    const counts = this.db.get<{ queued: number; running: number; failed: number }>(sql`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
        COALESCE(SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END), 0) AS running,
        COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
      FROM jobs
      WHERE type = 'embed'
    `);
    const errRow = this.db.get<{ error: string | null }>(sql`
      SELECT error FROM jobs
      WHERE type = 'embed' AND status = 'failed' AND error IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `);
    return {
      queued: counts?.queued ?? 0,
      running: counts?.running ?? 0,
      failed: counts?.failed ?? 0,
      lastError: errRow?.error ?? null,
    };
  }

  /**
   * Element ids that already have an in-flight (`queued`/`running`) OR `failed`
   * `embed` index job (U4). Reindex excludes these so it never (a) double-queues an
   * element whose embed job is still draining — closing the gap where a manual
   * "Rebuild"/"Build index" runs concurrently with a supervisor batch — nor
   * (b) re-enqueues a deterministically-failing element every catch-up pass (it stays
   * failed + visible until the user explicitly retries, which clears the failed rows).
   * Query jobs (no `elementId`) contribute nothing. Capped at {@link EXCLUDE_IDS_CAP}
   * to stay under SQLite's bound-parameter limit when the set is pathologically large
   * — the cap is safe because re-enqueue is idempotent (UPSERT by element).
   */
  activeOrFailedEmbedElementIds(): string[] {
    const rows = this.db.all<{ element_id: string | null }>(sql`
      SELECT DISTINCT json_extract(payload, '$.elementId') AS element_id FROM jobs
      WHERE type = 'embed'
        AND status IN ('queued', 'running', 'failed')
        AND json_extract(payload, '$.elementId') IS NOT NULL
      LIMIT ${EXCLUDE_IDS_CAP}
    `);
    const ids: string[] = [];
    for (const row of rows) {
      if (typeof row.element_id === "string" && row.element_id.length > 0) {
        ids.push(row.element_id);
      }
    }
    return ids;
  }

  /**
   * Clear all FAILED `embed` jobs and return the distinct element ids they targeted
   * (U4 — the "retry failed" path). A failed row has already spent its attempt budget,
   * so re-queueing the SAME row would re-fail immediately; the caller instead enqueues
   * FRESH embed jobs (full budget) for the returned element ids. Deleting the stale
   * rows keeps `failedCount` honest after the retry. Jobs are infra (no op-log).
   */
  clearFailedEmbedJobs(): string[] {
    return this.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.type, "embed"), eq(jobs.status, "failed")))
        .all();
      const ids = new Set<string>();
      for (const row of rows) {
        const payload = parseJson(row.payload);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const id = (payload as Record<string, unknown>).elementId;
          if (typeof id === "string" && id.length > 0) ids.add(id);
        }
      }
      tx.delete(jobs)
        .where(and(eq(jobs.type, "embed"), eq(jobs.status, "failed")))
        .run();
      return [...ids];
    });
  }

  /**
   * Insert a job on an EXISTING transaction (tx-composable seam) — used if a
   * future caller wants to enqueue a job atomically with another mutation. Not
   * used by the normal enqueue path.
   */
  enqueueWithin(tx: DbClient, input: EnqueueJobInput): Job {
    const id = newJobId();
    const now = nowIso();
    const row: JobRow = {
      id,
      type: input.type,
      status: "queued",
      payload: JSON.stringify(input.payload),
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      progressRatio: 0,
      progressNote: null,
      notBefore: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    tx.insert(jobs).values(row).run();
    return rowToJob(row);
  }
}
