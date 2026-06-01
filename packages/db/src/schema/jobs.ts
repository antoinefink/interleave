/**
 * Background-runner job queue (T058): `jobs`.
 *
 * The persisted queue for the on-device job runner (an Electron `utilityProcess`
 * worker — NOT pg-boss, NOT a server worker). A `jobs` row is local
 * INFRASTRUCTURE, not an {@link Element}: it has **no foreign key into the
 * element graph**, carries no lineage, and never appears in `operation_log`. A
 * job MAY reference an element inside its typed `payload`/`result` JSON, but the
 * row itself is infra — a job that mutates domain data does so in MAIN through
 * the existing repositories, which append the correct existing op.
 *
 * The queue lives in SQLite so it survives an app restart: on launch the runner
 * re-queues any row left `running` by a crash (at-least-once; the
 * crash-recovery reset counts against `attempts`/`maxAttempts` so a poison job is
 * bounded — recovery Option A) and resumes draining `queued` rows. The queue read
 * is "oldest `queued` whose `notBefore` ≤ now", served by `jobs_status_idx` +
 * `jobs_created_idx`. `type`/`status` are CHECK-constrained against the core
 * `JOB_TYPES`/`JOB_STATUSES` tuples so the DB constraint and the domain union can
 * never drift.
 */

import { JOB_STATUSES, JOB_TYPES } from "@interleave/core";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** Job type — one of the canonical `JobType` values. */
    type: text("type").notNull(),
    /** Lifecycle status — one of the canonical `JobStatus` values. */
    status: text("status").notNull(),
    /** Job-type-specific input, stored as JSON; validated per `type` upstream. */
    payload: text("payload").notNull(),
    /** The apply handler's serializable result JSON, or `null` until terminal. */
    result: text("result"),
    /** A terminal error message (with a leading `code:` prefix), or `null`. */
    error: text("error"),
    /** How many times the runner has started this job (incl. crash-recovery resets). */
    attempts: integer("attempts").notNull().default(0),
    /** Retry cap — at `attempts >= maxAttempts` the job lands terminal `failed`. */
    maxAttempts: integer("max_attempts").notNull(),
    /** Progress as an integer percent 0–100 (the domain `ratio` × 100). */
    progressRatio: integer("progress_ratio").notNull().default(0),
    /** An optional human-readable progress note, or `null`. */
    progressNote: text("progress_note"),
    /** Backoff gate (ISO) — the job is not claimable before this instant, or `null`. */
    notBefore: text("not_before"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** When the runner first marked it `running`, or `null`. */
    startedAt: text("started_at"),
    /** When it reached a terminal state, or `null`. */
    finishedAt: text("finished_at"),
  },
  (table) => [
    check("jobs_type_check", inList(table.type, JOB_TYPES)),
    check("jobs_status_check", inList(table.status, JOB_STATUSES)),
    index("jobs_status_idx").on(table.status),
    index("jobs_created_idx").on(table.createdAt),
  ],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
