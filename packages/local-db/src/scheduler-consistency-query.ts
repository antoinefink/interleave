/**
 * SchedulerConsistencyQuery — read-only maintenance scan for queue/scheduler drift.
 *
 * Queue membership intentionally excludes terminal statuses and retired cards. This
 * query surfaces leftover scheduling state that should not silently look actionable
 * in inventory views: terminal elements with `elements.due_at`, terminal/retired
 * cards with `review_states.due_at`, and scheduled attention rows missing a due.
 */

import { type ElementStatus, type IsoTimestamp, priorityToLabel } from "@interleave/core";
import { cards, elements, type InterleaveDatabase, reviewStates } from "@interleave/db";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { CHRONIC_POSTPONE_TYPES, ChronicPostponeQuery } from "./chronic-postpone-query";
import { OperationLogRepository } from "./operation-log-repository";
import { QUEUE_EXCLUDED_STATUSES } from "./queue-repository";
import { SettingsRepository } from "./settings-repository";

export type SchedulerConsistencyReason =
  | "terminal-element-due"
  | "terminal-card-review-due"
  | "retired-card-review-due"
  | "scheduled-attention-missing-due"
  | "attention-due-before-last-seen"
  | "chronic-postpone-paused"
  | "chronic-postpone-reset";

const HEURISTIC_SCHEDULER_ACTIONS = new Set(["extract", "rewrite", "activate", "done", "postpone"]);

interface AttentionDueBeforeLastSeenRow {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly priority: number;
  readonly status: string;
  readonly createdAt: string;
  readonly dueAt: string;
}

export interface SchedulerConsistencyRow {
  readonly element: {
    readonly id: string;
    readonly type: string;
    readonly title: string;
    readonly priority: number;
    readonly priorityLabel: string;
    readonly status: string;
    readonly createdAt: string;
  };
  readonly reason: SchedulerConsistencyReason;
  readonly elementDueAt: IsoTimestamp | null;
  readonly reviewDueAt: IsoTimestamp | null;
}

export class SchedulerConsistencyQuery {
  constructor(private readonly db: InterleaveDatabase) {}

  list(limit = 100): SchedulerConsistencyRow[] {
    const rows = new Map<string, SchedulerConsistencyRow>();
    const push = (row: SchedulerConsistencyRow) => {
      if (rows.size >= limit || rows.has(`${row.element.id}:${row.reason}`)) return;
      rows.set(`${row.element.id}:${row.reason}`, row);
    };

    for (const row of this.terminalElementDue()) push(row);
    for (const row of this.terminalCardReviewDue()) push(row);
    for (const row of this.retiredCardReviewDue()) push(row);
    for (const row of this.scheduledAttentionMissingDue()) push(row);
    for (const row of this.attentionDueBeforeLastSeen(limit - rows.size)) push(row);
    for (const row of this.chronicPostponePaused()) push(row);
    for (const row of this.chronicPostponeReset()) push(row);
    return [...rows.values()];
  }

  count(): number {
    return this.list(Number.MAX_SAFE_INTEGER).length;
  }

  private terminalElementDue(): SchedulerConsistencyRow[] {
    return this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        dueAt: elements.dueAt,
      })
      .from(elements)
      .where(
        and(
          isNull(elements.deletedAt),
          inArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          isNotNull(elements.dueAt),
        ),
      )
      .all()
      .map((r) => ({
        element: ref(r),
        reason: "terminal-element-due" as const,
        elementDueAt: r.dueAt as IsoTimestamp | null,
        reviewDueAt: null,
      }));
  }

  private terminalCardReviewDue(): SchedulerConsistencyRow[] {
    return this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        elementDueAt: elements.dueAt,
        reviewDueAt: reviewStates.dueAt,
      })
      .from(elements)
      .innerJoin(reviewStates, eq(reviewStates.elementId, elements.id))
      .where(
        and(
          isNull(elements.deletedAt),
          eq(elements.type, "card"),
          inArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          isNotNull(reviewStates.dueAt),
        ),
      )
      .all()
      .map((r) => ({
        element: ref(r),
        reason: "terminal-card-review-due" as const,
        elementDueAt: r.elementDueAt as IsoTimestamp | null,
        reviewDueAt: r.reviewDueAt as IsoTimestamp | null,
      }));
  }

  private retiredCardReviewDue(): SchedulerConsistencyRow[] {
    return this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        elementDueAt: elements.dueAt,
        reviewDueAt: reviewStates.dueAt,
      })
      .from(elements)
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .innerJoin(reviewStates, eq(reviewStates.elementId, elements.id))
      .where(
        and(isNull(elements.deletedAt), eq(cards.isRetired, true), isNotNull(reviewStates.dueAt)),
      )
      .all()
      .map((r) => ({
        element: ref(r),
        reason: "retired-card-review-due" as const,
        elementDueAt: r.elementDueAt as IsoTimestamp | null,
        reviewDueAt: r.reviewDueAt as IsoTimestamp | null,
      }));
  }

  private scheduledAttentionMissingDue(): SchedulerConsistencyRow[] {
    return this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        dueAt: elements.dueAt,
      })
      .from(elements)
      .where(
        and(
          isNull(elements.deletedAt),
          eq(elements.status, "scheduled"),
          ne(elements.type, "card"),
          isNull(elements.dueAt),
        ),
      )
      .all()
      .map((r) => ({
        element: ref(r),
        reason: "scheduled-attention-missing-due" as const,
        elementDueAt: r.dueAt as IsoTimestamp | null,
        reviewDueAt: null,
      }));
  }

  private attentionDueBeforeLastSeen(limit = Number.MAX_SAFE_INTEGER): SchedulerConsistencyRow[] {
    if (limit <= 0) return [];

    const excludedStatuses = sql.join(
      QUEUE_EXCLUDED_STATUSES.map((status) => sql`${status}`),
      sql`, `,
    );
    const heuristicActions = sql.join(
      [...HEURISTIC_SCHEDULER_ACTIONS].map((action) => sql`${action}`),
      sql`, `,
    );
    const rows = this.db.all<AttentionDueBeforeLastSeenRow>(sql`
      WITH latest_reschedule AS (
        SELECT element_id, payload
        FROM (
          SELECT
            element_id,
            payload,
            row_number() OVER (
              PARTITION BY element_id
              ORDER BY created_at DESC, rowid DESC
            ) AS rn
          FROM operation_log
          WHERE op_type = 'reschedule_element'
            AND element_id IS NOT NULL
        )
        WHERE rn = 1
      )
      SELECT
        e.id AS id,
        e.type AS type,
        e.title AS title,
        e.priority AS priority,
        e.status AS status,
        e.created_at AS createdAt,
        e.due_at AS dueAt
      FROM elements e
      JOIN latest_reschedule lr ON lr.element_id = e.id
      WHERE e.deleted_at IS NULL
        AND e.type <> 'card'
        AND e.status NOT IN (${excludedStatuses})
        AND e.due_at IS NOT NULL
        AND json_valid(lr.payload)
        AND json_type(lr.payload, '$.choice') IS NULL
        AND COALESCE(json_extract(lr.payload, '$.queueSoon'), 0) != 1
        AND json_extract(lr.payload, '$.action') IN (${heuristicActions})
        AND julianday(json_extract(lr.payload, '$.scheduledAt')) IS NOT NULL
        AND julianday(e.due_at) <= julianday(json_extract(lr.payload, '$.scheduledAt'))
      ORDER BY e.created_at ASC
      LIMIT ${limit}
    `);

    return rows.map((r) => ({
      element: ref(r),
      reason: "attention-due-before-last-seen" as const,
      elementDueAt: r.dueAt as IsoTimestamp | null,
      reviewDueAt: null,
    }));
  }

  private chronicPostponePaused(): SchedulerConsistencyRow[] {
    const threshold = new SettingsRepository(this.db).getAppSettings().chronicPostponeThreshold;
    return new ChronicPostponeQuery(this.db).listDue({ threshold }).rows.map((row) => ({
      element: {
        id: row.element.id,
        type: row.element.type,
        title: row.element.title,
        priority: row.element.priority,
        priorityLabel: row.element.priorityLabel,
        status: row.element.status,
        createdAt: row.element.createdAt,
      },
      reason: "chronic-postpone-paused" as const,
      elementDueAt: row.element.dueAt,
      reviewDueAt: null,
    }));
  }

  private chronicPostponeReset(): SchedulerConsistencyRow[] {
    // U13: Fetch the SAME full live-element set the old per-element code scanned, then
    // build BOTH the `effective` and `raw` maps in ONE batched op-log scan instead of
    // two per-element SQL calls per row (`rawPostponeCount` + `countPostpones`). An
    // element absent from the op-log correctly contributes 0 to both maps (the
    // `map.get(id) ?? 0` default), matching the per-element behaviour. The candidate
    // scan covers all CHRONIC_POSTPONE_TYPES live elements — NOT scoped to "elements
    // that have a postpone op" — to avoid dropping elements the old full scan evaluated
    // (correctness guard; adversarial review anchor in U13 plan).
    const operationLogRepository = new OperationLogRepository(this.db);
    const allRows = this.db
      .select({
        id: elements.id,
        type: elements.type,
        title: elements.title,
        priority: elements.priority,
        status: elements.status,
        createdAt: elements.createdAt,
        dueAt: elements.dueAt,
      })
      .from(elements)
      .where(
        and(
          isNull(elements.deletedAt),
          inArray(elements.type, CHRONIC_POSTPONE_TYPES as readonly string[]),
        ),
      )
      .all();

    const candidateIds = allRows.map((r) => r.id as never);
    const { effective, raw } = operationLogRepository.postponeCountsForMany(candidateIds);

    return allRows
      .filter((row) => (raw.get(row.id as never) ?? 0) > (effective.get(row.id as never) ?? 0))
      .map((r) => ({
        element: ref(r),
        reason: "chronic-postpone-reset" as const,
        elementDueAt: r.dueAt as IsoTimestamp | null,
        reviewDueAt: null,
      }));
  }
}

function ref(row: {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly priority: number;
  readonly status: string;
  readonly createdAt: string;
}) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    priority: row.priority,
    priorityLabel: priorityToLabel(row.priority),
    status: row.status,
    createdAt: row.createdAt,
  };
}
