/**
 * TaskService (T092) — create / schedule / complete / postpone verification tasks,
 * and GENERATE them from T090 expiry.
 *
 * A `task` is the EXISTING core `task`-type {@link Element} — there is NO parallel
 * object model. It is an ATTENTION-scheduled maintenance action (it answers "should
 * the user process this again, and when?" — NEVER FSRS) that protects time-sensitive
 * knowledge from rotting: "verify this claim", "find a better source", "update this
 * outdated card", "check the current version". This service is the composition seam
 * that wires the (already-existing) `task` element + `tasks` side-table into the
 * create/schedule/complete path that did not exist yet.
 *
 * INVARIANTS (load-bearing, see the T092 spec + CLAUDE.md):
 *  - **Element + side-table in ONE transaction.** `createTask` mirrors the M8
 *    `createConcept` pattern: {@link ElementRepository.createWithin} writes the
 *    `task`-type element (logs `create_element`), then the `tasks` row is inserted,
 *    then the `references` edge (task → protected element) is added via
 *    {@link ElementRepository.addRelationWithin} (logs `add_relation`) — all on the
 *    same `tx`.
 *  - **Attention, never FSRS.** A task schedules on `elements.due_at` via the
 *    attention interval helpers / {@link SchedulerService.scheduleAt}. It NEVER gets a
 *    `review_states` row (asserted in a test). `SchedulerService` already rejects cards.
 *  - **The link is dual-modeled.** The `references` edge is the canonical lineage; the
 *    `tasks.linked_element_id` column is a denormalized convenience for cheap reads
 *    (like `cards.source_location_id`). Kept consistent in the create transaction.
 *  - **No new op types.** create → `create_element`, link → `add_relation`, schedule/
 *    complete/postpone → `reschedule_element` (status → `scheduled`/`done`). The closed
 *    15-op set is unchanged.
 *  - **Generation is idempotent + opt-in.** {@link generateVerificationTasks} scans
 *    CARD-BACKED facts (the T090 migration is cards-only — see its SQL comment) whose
 *    `deriveExpiryStatus(now)` is `due_for_review`/`expired`, and creates ONE task per
 *    protected card that does not already have an OPEN task of that kind. The
 *    open-task re-check runs INSIDE the create transaction, backed by the
 *    `tasks_open_link_type_uq` partial unique index, so a duplicate insert fails at the
 *    DB level rather than depending on call serialization. Priority is inherited from
 *    the protected card so a low-priority stale fact does not dominate the queue.
 *
 * The renderer never instantiates this; the Electron main/DB service composes it
 * behind the validated `tasks.*` IPC surface.
 */

import type { ElementId, FactExpiryStatus, Priority, TaskType } from "@interleave/core";
import { deriveExpiryStatus, isTaskType, PRIORITY_LABEL_VALUE } from "@interleave/core";
import {
  cards as cardsTable,
  elements as elementsTable,
  type InterleaveDatabase,
  type TaskRow,
  tasks as tasksTable,
} from "@interleave/db";
import {
  addDays,
  postponeIntervalForPriority,
  type ScheduleChoice,
  scheduleForChoice,
  sourceIntervalDays,
} from "@interleave/scheduler";
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { cardRowToLifetime } from "./card-edit-service";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/**
 * Statuses that count a task as TERMINAL (not "open"). A task in one of these is done
 * with — it does not block generation of a fresh task of the same kind. Mirrors the
 * `tasks_open_link_type_uq` partial-index predicate so the in-tx re-check and the DB
 * constraint agree.
 */
const CLOSED_TASK_STATUSES = ["done", "parked", "dismissed", "deleted"] as const;

/** The distillation stage a verification `task` element sits in. */
export const TASK_STAGE = "rough_topic" as const;

/** A flat, JSON-serializable task summary (the inspector / queue read shape). */
export interface TaskSummary {
  readonly id: ElementId;
  readonly taskType: TaskType;
  readonly title: string;
  readonly note: string | null;
  readonly status: string;
  readonly dueAt: string | null;
  readonly priority: Priority;
  /** The element this task protects (resolved from `linked_element_id`), or `null`. */
  readonly linkedElement: {
    readonly id: ElementId;
    readonly type: string;
    readonly title: string;
  } | null;
}

/** Arguments to create a verification task. */
export interface CreateTaskInput {
  readonly taskType: TaskType;
  /** Display title (the maintenance action, e.g. "Verify Chollet's definition"). */
  readonly title: string;
  /** Free-text detail, or omit/null. */
  readonly note?: string | null;
  /** The element the task protects — links it + inherits its priority. */
  readonly linkedElementId?: ElementId | null;
  /** Explicit priority; default = the linked element's priority, else `B`. */
  readonly priority?: Priority;
  /** Explicit schedule choice; default = an attention interval by priority. */
  readonly dueChoice?: ScheduleChoice;
}

/** The result of an expiry-generation run: the created count + the created tasks. */
export interface GenerateVerificationResult {
  readonly created: number;
  readonly tasks: readonly TaskSummary[];
}

export class TaskService {
  private readonly elements: ElementRepository;
  private readonly operationLog: OperationLogRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.operationLog = new OperationLogRepository(db);
  }

  /**
   * Create a verification task — the `task`-type element + its `tasks` side-table row
   * + the `references` edge to the protected element — in ONE transaction (mirrors
   * `createConcept`). The element is `scheduled` (it lives on the attention scheduler),
   * stage {@link TASK_STAGE}, priority inherited from the linked element by default.
   * The initial `due_at` comes from `dueChoice` (tomorrow/next-week/…) or, by default,
   * the attention by-priority interval (so a high-priority task returns sooner). The
   * `tasks.due_at` mirror is kept consistent with `elements.due_at`. NEVER writes FSRS.
   */
  createTask(input: CreateTaskInput): TaskSummary {
    const title = input.title.trim();
    if (title.length === 0) {
      throw new Error("TaskService.createTask: title must be non-empty");
    }
    if (!isTaskType(input.taskType)) {
      throw new Error(`TaskService.createTask: unknown taskType ${String(input.taskType)}`);
    }
    const linkedElementId = input.linkedElementId ?? null;
    const note = normalizeNote(input.note);
    const now = nowIso();

    // Resolve the linked element (when given) so we can validate it + inherit priority.
    const linked = linkedElementId ? this.elements.findById(linkedElementId) : null;
    if (linkedElementId && (!linked || linked.deletedAt)) {
      throw new Error(`TaskService.createTask: linked element ${linkedElementId} not found`);
    }
    const priority: Priority = input.priority ?? linked?.priority ?? PRIORITY_LABEL_VALUE.B;

    // The initial attention due date: an explicit choice, else the by-priority band.
    const dueAt = input.dueChoice
      ? scheduleForChoice(input.dueChoice, now).dueAt
      : addDays(now, sourceIntervalDays(priority));

    return this.db.transaction((tx) => {
      // 1) The `task` element (logs `create_element`). Status `scheduled` — it is on the
      //    attention scheduler with a `due_at`. Stage {@link TASK_STAGE}. NOTE: a task is
      //    NOT a distillation child of the element it protects — the link is the
      //    `references` edge (3) + the `linked_element_id` column, NOT `parentId`. Setting
      //    `parentId` would wrongly surface the task in the protected element's `children`
      //    lineage + its `LineageTree` (which walk `parentId`), conflating a maintenance
      //    action with the `source → extract → card` distillation tree.
      const element = this.elements.createWithin(tx, {
        type: "task",
        status: "scheduled",
        stage: TASK_STAGE,
        priority,
        title,
        dueAt,
      });

      // 2) The `tasks` side-table row — same transaction. `due_at` mirrors the element's.
      tx.insert(tasksTable)
        .values({
          elementId: element.id,
          taskType: input.taskType,
          dueAt,
          status: "scheduled",
          linkedElementId,
          note,
        })
        .run();

      // 3) The canonical lineage edge: task → protected element (`references`, logs
      //    `add_relation`). The `linked_element_id` column above is the denormalized
      //    convenience; this edge is the source of truth.
      if (linkedElementId) {
        this.elements.addRelationWithin(tx, {
          fromElementId: element.id,
          toElementId: linkedElementId,
          relationType: "references",
        });
      }

      return this.summaryFromRowWithin(tx, element.id);
    });
  }

  /**
   * Open (non-terminal) tasks, optionally narrowed to those protecting one element —
   * the inspector "Maintenance" read + the generation idempotency check. A live
   * (non-deleted) `task` element whose `tasks` status is NOT terminal. Read-only.
   */
  listOpenTasks(options: { linkedElementId?: ElementId | null } = {}): TaskSummary[] {
    const rows = this.db
      .select({ task: tasksTable, element: elementsTable })
      .from(tasksTable)
      .innerJoin(elementsTable, eq(elementsTable.id, tasksTable.elementId))
      .where(
        and(
          isNull(elementsTable.deletedAt),
          notInArray(tasksTable.status, CLOSED_TASK_STATUSES as unknown as string[]),
          ...(options.linkedElementId
            ? [eq(tasksTable.linkedElementId, options.linkedElementId)]
            : []),
        ),
      )
      .all();
    return rows.map((r) => this.summaryFromRow(r.task));
  }

  /**
   * Due (open + `due_at <= now`) tasks — the targeted attention read (the merged queue
   * surfaces tasks via the attention path; this is the focused read). Read-only.
   */
  listDueTasks(now: string = nowIso()): TaskSummary[] {
    return this.listOpenTasks().filter((t) => t.dueAt != null && t.dueAt <= now);
  }

  /** Fetch one task summary by element id, or `null`. */
  findTask(id: ElementId): TaskSummary | null {
    const row = this.db.select().from(tasksTable).where(eq(tasksTable.elementId, id)).get();
    const element = this.elements.findById(id);
    if (!row || !element || element.deletedAt) return null;
    return this.summaryFromRow(row);
  }

  /**
   * Complete a task (T092): set the element AND `tasks` status → `done` via
   * {@link ElementRepository.rescheduleWithin} (logs `reschedule_element`), in ONE
   * transaction. The `tasks.status` mirror is kept in sync. OPTIONALLY — and only as an
   * explicit caller choice — bump the protected card's `review_by` forward (a T090
   * field, `update_element`) when the task resolved an expiry; never automatic.
   */
  completeTask(id: ElementId, options: { bumpReviewByDays?: number } = {}): TaskSummary {
    this.requireTask(id);
    return this.db.transaction((tx) => {
      // Element → done (the due date is cleared; a done task is not "due").
      this.elements.rescheduleWithin(tx, id, null, "done", { action: "done" });
      tx.update(tasksTable)
        .set({ status: "done", dueAt: null })
        .where(eq(tasksTable.elementId, id))
        .run();

      // Optional, EXPLICIT expiry resolution: push the protected card's `review_by`
      // forward so a completed verify/update task stops re-surfacing the same fact.
      if (options.bumpReviewByDays && options.bumpReviewByDays > 0) {
        this.bumpProtectedReviewByWithin(tx, id, options.bumpReviewByDays);
      }

      return this.summaryFromRowWithin(tx, id);
    });
  }

  /**
   * Postpone a task (T092): reschedule further out on the attention scheduler and
   * record the running postpone count in the `reschedule_element` op payload — mirrors
   * {@link ExtractService.postpone}. The interval GROWS with the postpone count
   * (stagnation recedes). One transaction; logs `reschedule_element`. The `tasks.due_at`
   * mirror is kept in sync. An explicit `choice` overrides the heuristic interval.
   */
  postponeTask(id: ElementId, choice?: ScheduleChoice): TaskSummary {
    const element = this.requireTask(id);
    const priorCount = this.operationLog.countPostpones(id);
    const now = nowIso();
    const dueAt = choice
      ? scheduleForChoice(choice, now).dueAt
      : addDays(now, postponeIntervalForPriority(element.priority, priorCount));
    return this.db.transaction((tx) => {
      this.elements.rescheduleWithin(tx, id, dueAt, "scheduled", {
        postpone: true,
        postponeCount: priorCount + 1,
      });
      tx.update(tasksTable)
        .set({ status: "scheduled", dueAt })
        .where(eq(tasksTable.elementId, id))
        .run();
      return this.summaryFromRowWithin(tx, id);
    });
  }

  /**
   * GENERATE verification tasks from T090 expiry (T092). Scans CARD-BACKED facts whose
   * `valid_until`/`review_by` is set (cheap via `cards_review_by_idx`) and whose
   * `deriveExpiryStatus(now)` is `due_for_review`/`expired`, and creates ONE task per
   * protected card that does not already have an OPEN task of the appropriate kind:
   *  - `expired`        → `update_outdated_card`
   *  - `due_for_review` → `verify_claim`
   *
   * The scan shape matches the T090 migration's committed shape (CARDS-ONLY — see its
   * SQL comment). Idempotent: the open-task re-check runs INSIDE the create transaction
   * (via {@link createTask}'s same-tx insert) and is backed by the
   * `tasks_open_link_type_uq` partial unique index, so a duplicate insert FAILS at the
   * DB level. Priority is inherited from the protected card. Explicit/opt-in — never a
   * silent background job.
   */
  generateVerificationTasks(now: string = nowIso()): GenerateVerificationResult {
    // Candidate cards: live `card` elements whose `cards` row carries a `review_by` OR a
    // `valid_until` (a lifetime that CAN expire). Cheap, scoped scan (cards-only).
    const candidates = this.db
      .select({ card: cardsTable, element: elementsTable })
      .from(cardsTable)
      .innerJoin(elementsTable, eq(elementsTable.id, cardsTable.elementId))
      .where(isNull(elementsTable.deletedAt))
      .all();

    const created: TaskSummary[] = [];
    for (const { card, element } of candidates) {
      if (element.type !== "card") continue;
      const lifetime = cardRowToLifetime(card);
      // Skip facts with no expiry constraint at all (cheap common case).
      if (!lifetime.validUntil && !lifetime.reviewBy) continue;
      const status: FactExpiryStatus = deriveExpiryStatus(lifetime, new Date(now));
      if (status === "fresh") continue;

      const taskType: TaskType = status === "expired" ? "update_outdated_card" : "verify_claim";
      const linkedElementId = element.id as ElementId;

      // Idempotency: skip when an OPEN task of this kind already protects the card. This
      // read is advisory (a fast skip); the partial unique index is the hard guarantee
      // — the in-tx insert below fails if a concurrent trigger raced past this check.
      const alreadyOpen = this.listOpenTasks({ linkedElementId }).some(
        (t) => t.taskType === taskType,
      );
      if (alreadyOpen) continue;

      try {
        const summary = this.createTask({
          taskType,
          title: this.generatedTitle(taskType, element.title),
          linkedElementId,
          // Priority inherited from the protected card (createTask default), so a
          // low-priority stale fact does not dominate the queue.
        });
        created.push(summary);
      } catch (err) {
        // The partial unique index rejected a duplicate that raced past the advisory
        // re-check — that is the idempotency guarantee working, not an error to surface.
        if (isDuplicateOpenTaskError(err)) continue;
        throw err;
      }
    }

    return { created: created.length, tasks: created };
  }

  /** Soft-delete reuses the element path (no task-specific delete) — convenience alias. */
  deleteTask(id: ElementId): TaskSummary {
    this.requireTask(id);
    this.elements.softDelete(id);
    const summary = this.findTask(id);
    // After soft-delete the join read drops the row (element deleted); rebuild a summary
    // from the raw `tasks` row so the caller still gets the (now-deleted) shape.
    if (summary) return summary;
    const row = this.db.select().from(tasksTable).where(eq(tasksTable.elementId, id)).get();
    if (!row) throw new Error(`TaskService.deleteTask: task ${id} missing after delete`);
    return this.summaryFromRow(row);
  }

  // ---- internals --------------------------------------------------------------

  /** Load a live `task` element, throwing when missing / deleted / not a task. */
  private requireTask(id: ElementId) {
    const element = this.elements.findById(id);
    if (!element || element.deletedAt) {
      throw new Error(`TaskService: task ${id} not found`);
    }
    if (element.type !== "task") {
      throw new Error(`TaskService: element ${id} is a ${element.type}, not a task`);
    }
    return element;
  }

  /** Bump the protected card's `review_by` forward by N days (T090 `update_element`). */
  private bumpProtectedReviewByWithin(tx: DbClient, taskId: ElementId, days: number): void {
    const taskRow = tx.select().from(tasksTable).where(eq(tasksTable.elementId, taskId)).get();
    const linkedId = (taskRow?.linkedElementId as ElementId | null) ?? null;
    if (!linkedId) return;
    const cardRow = tx.select().from(cardsTable).where(eq(cardsTable.elementId, linkedId)).get();
    if (!cardRow) return; // only a card carries a T090 lifetime
    const nextReviewBy = addDays(nowIso(), days);
    tx.update(cardsTable)
      .set({ reviewBy: nextReviewBy })
      .where(eq(cardsTable.elementId, linkedId))
      .run();
    const updatedAt = nowIso();
    tx.update(elementsTable).set({ updatedAt }).where(eq(elementsTable.id, linkedId)).run();
    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId: linkedId,
      payload: { id: linkedId, lifetime: { reviewBy: nextReviewBy } },
    });
  }

  /** A generated task title from the protected card's title. */
  private generatedTitle(taskType: TaskType, cardTitle: string): string {
    const verb = taskType === "update_outdated_card" ? "Update outdated card" : "Verify claim";
    return `${verb}: ${cardTitle}`;
  }

  /** Build a {@link TaskSummary} from a `tasks` row (resolving its linked element). */
  private summaryFromRow(row: TaskRow): TaskSummary {
    const linkedId = (row.linkedElementId as ElementId | null) ?? null;
    const linkedEl = linkedId ? this.elements.findById(linkedId) : null;
    const element = this.elements.findById(row.elementId as ElementId);
    return {
      id: row.elementId as ElementId,
      taskType: isTaskType(row.taskType) ? row.taskType : "custom",
      title: element?.title ?? "",
      note: row.note ?? null,
      status: row.status,
      dueAt: row.dueAt ?? null,
      priority: element?.priority ?? PRIORITY_LABEL_VALUE.B,
      linkedElement:
        linkedEl && !linkedEl.deletedAt
          ? { id: linkedEl.id as ElementId, type: linkedEl.type, title: linkedEl.title }
          : null,
    };
  }

  /** Build a {@link TaskSummary} within an open transaction (post-mutation read). */
  private summaryFromRowWithin(tx: DbClient, id: ElementId): TaskSummary {
    const row = tx.select().from(tasksTable).where(eq(tasksTable.elementId, id)).get();
    const element = tx.select().from(elementsTable).where(eq(elementsTable.id, id)).get();
    if (!row || !element) {
      throw new Error(`TaskService: task ${id} missing after mutation`);
    }
    const linkedId = (row.linkedElementId as ElementId | null) ?? null;
    const linkedEl = linkedId
      ? tx.select().from(elementsTable).where(eq(elementsTable.id, linkedId)).get()
      : null;
    return {
      id: id,
      taskType: isTaskType(row.taskType) ? row.taskType : "custom",
      title: element.title,
      note: row.note ?? null,
      status: row.status,
      dueAt: row.dueAt ?? null,
      priority: element.priority as Priority,
      linkedElement:
        linkedEl && !linkedEl.deletedAt
          ? {
              id: linkedEl.id as ElementId,
              type: linkedEl.type,
              title: linkedEl.title,
            }
          : null,
    };
  }
}

/** Trim a free-text note, mapping empty → `null`, enforcing the ≤2048 bound. */
function normalizeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const t = note.trim();
  if (t.length === 0) return null;
  return t.slice(0, 2048);
}

/**
 * Whether `err` is the `tasks_open_link_type_uq` partial-unique-index rejection — a
 * duplicate OPEN task of the same kind protecting the same element. better-sqlite3
 * raises a `SqliteError` with code `SQLITE_CONSTRAINT_UNIQUE` and a message naming the
 * index. This is the idempotency guarantee firing, not a real failure.
 */
function isDuplicateOpenTaskError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const message = "message" in err ? String((err as { message: unknown }).message) : "";
  return (
    message.includes("tasks_open_link_type_uq") ||
    message.includes("UNIQUE constraint failed: tasks")
  );
}
