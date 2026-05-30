/**
 * UndoService (T044) — the single, general, command-level undo.
 *
 * Distinct from the queue's removing-only recipe undo (T030,
 * `QueueActionService.undo`): this one works ANYWHERE (reader, review, inspector,
 * trash, bulk actions) by reading the MOST-RECENT `operation_log` op and applying
 * its INVERSE through the existing repository write paths. It adds NO op type — the
 * inverse is one of the closed 15, and is itself logged, so the log stays
 * append-only and auditable (undo is undoable / redo-able).
 *
 * MVP undo scope = the four the roadmap names: delete / mark-done / suspend /
 * bulk-postpone, i.e. these op types:
 *  - `soft_delete_element` → `ElementRepository.restore(id, originStatus)`
 *    (appends `restore_element`). `originStatus` is the prior status from the op's
 *    `prev.status` payload (recorded at delete time), so the element returns to
 *    exactly where it was, lineage intact.
 *  - `restore_element` → `ElementRepository.softDelete(id)` (appends
 *    `soft_delete_element`), so undoing a restore re-trashes it (redo-friendly).
 *  - `update_element` (covers mark-done / dismiss / suspend / priority raise-lower /
 *    title) → re-apply the captured `prev` PRE-IMAGE (appends another
 *    `update_element`). The exact prior values are read from the op payload's `prev`
 *    that `updateWithin` records at write time.
 *  - `reschedule_element` (covers postpone, incl. BULK-postpone) → restore the
 *    captured `prevDueAt`/`prevStatus` (appends another `reschedule_element`).
 *
 * Everything else (`create_*`, `add_review_log`, `update_document`,
 * `set_read_point`, `add_relation`/`remove_relation`, `add_tag`/`remove_tag`) is
 * NOT inverted by the global undo for the MVP — `undoLast` returns
 * `{ undone: false, reason }` and mutates nothing (those have their own
 * affordances; creates are undone by deleting, out of this MVP's scope).
 *
 * BULK actions: a bulk-postpone (or bulk status change) writes N ops sharing a
 * `batchId` in their payload. `undoLast` reverses EVERY op that shares the
 * most-recent op's `batchId` (in reverse insertion order), so a whole batch undoes
 * as one. A single op (no `batchId`) reverses just that op. Undo is a stack of ONE
 * (the last op/batch) for the MVP; a multi-step undo/redo stack is a later refinement.
 */

import type { ElementId, ElementStatus, IsoTimestamp, OperationType } from "@interleave/core";
import { type InterleaveDatabase, operationLog, reviewStates } from "@interleave/db";
import { desc, eq, sql } from "drizzle-orm";
import { ElementRepository } from "./element-repository";

/** The op types the global command-level undo can invert (the MVP scope). */
const UNDOABLE_OP_TYPES: ReadonlySet<OperationType> = new Set<OperationType>([
  "soft_delete_element",
  "restore_element",
  "update_element",
  "reschedule_element",
]);

/** The outcome of a single `undoLast` call. */
export interface UndoResult {
  /** Whether anything was undone. `false` when the last op is non-invertible. */
  readonly undone: boolean;
  /** The op type that was inverted (or the un-invertible last op's type). */
  readonly opType: OperationType | null;
  /** The element the undo concerned, or `null`. */
  readonly elementId: string | null;
  /** A human label for the snackbar ("Restored 'Spaced repetition'"), or `""`. */
  readonly label: string;
  /** Why nothing was undone, when `undone` is `false`. */
  readonly reason?: string;
  /** How many ops were reversed (>1 for a bulk batch). */
  readonly count: number;
}

interface RawOpRow {
  id: string;
  opType: string;
  payload: string;
  elementId: string | null;
  createdAt: string;
}

interface ParsedOp {
  readonly opType: OperationType;
  readonly elementId: ElementId | null;
  readonly payload: Record<string, unknown>;
}

export class UndoService {
  private readonly elements: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
  }

  /**
   * Read the most-recent op (with a deterministic `rowid` tie-break) and apply its
   * inverse. When that op carries a `batchId`, reverse every op sharing it (the
   * whole bulk action) in reverse insertion order. Returns `{ undone: false }`
   * (mutating nothing) when the last op is non-invertible or the log is empty.
   */
  undoLast(): UndoResult {
    const lastRow = this.db
      .select()
      .from(operationLog)
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .limit(1)
      .get() as RawOpRow | undefined;

    if (!lastRow) {
      return {
        undone: false,
        opType: null,
        elementId: null,
        label: "",
        reason: "Nothing to undo",
        count: 0,
      };
    }

    const last = this.parse(lastRow);
    if (!UNDOABLE_OP_TYPES.has(last.opType) || !this.isInvertible(last)) {
      return {
        undone: false,
        opType: last.opType,
        elementId: last.elementId,
        label: "",
        reason: `Can't undo "${last.opType}"`,
        count: 0,
      };
    }

    const batchId = typeof last.payload.batchId === "string" ? last.payload.batchId : null;
    const batch = batchId ? this.collectBatch(batchId) : [last];

    // Apply each inverse through the existing write paths (each appends its own
    // inverting op). One element may appear once per op — that is fine: applying in
    // reverse insertion order yields the correct prior state. `invert` returns `null`
    // for a marker op that carries no usable pre-image (see {@link isInvertible}); we
    // skip those so a batch undoes every op that DID carry a pre-image and never
    // reports a phantom success for an op that mutated nothing.
    let label = "";
    let undoneCount = 0;
    for (const op of batch) {
      const opLabel = this.invert(op);
      if (opLabel === null) continue;
      undoneCount += 1;
      if (!label && opLabel) label = opLabel;
    }

    if (undoneCount === 0) {
      return {
        undone: false,
        opType: last.opType,
        elementId: last.elementId,
        label: "",
        reason: `Can't undo "${last.opType}"`,
        count: 0,
      };
    }

    const single = undoneCount === 1;
    return {
      undone: true,
      opType: last.opType,
      elementId: last.elementId,
      label: single ? label : `Undid ${undoneCount} changes`,
      count: undoneCount,
    };
  }

  /**
   * Whether an op CAN actually be inverted (beyond merely having an undoable type).
   * A marker `update_element` op (leech-flag-on-review, manual flag, card-body edit)
   * carries NO object `prev` PRE-IMAGE, so re-applying it would mutate nothing —
   * inverting it must NOT be reported as a success (the bug this guards). Every other
   * undoable op type carries the state it needs in its payload, so it is invertible.
   */
  private isInvertible(op: ParsedOp): boolean {
    if (!op.elementId) return false;
    if (op.opType === "update_element") {
      const prev = op.payload.prev;
      return typeof prev === "object" && prev !== null && Object.keys(prev).length > 0;
    }
    return true;
  }

  /**
   * All ops sharing the given `batchId`, newest first (so we invert in reverse
   * insertion order — the inverse of how they were applied).
   */
  private collectBatch(batchId: string): ParsedOp[] {
    const rows = this.db
      .select()
      .from(operationLog)
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .all() as RawOpRow[];
    const out: ParsedOp[] = [];
    for (const row of rows) {
      const op = this.parse(row);
      if (op.payload.batchId === batchId) out.push(op);
    }
    return out;
  }

  /**
   * Apply the inverse of one op; returns a snackbar label, or `null` when the op was
   * NOT actually invertible (a marker `update_element` with no usable pre-image), so
   * `undoLast` can skip it rather than report a phantom success.
   */
  private invert(op: ParsedOp): string | null {
    const id = op.elementId;
    if (!id) return null;
    switch (op.opType) {
      case "soft_delete_element": {
        const origin = this.originStatus(op);
        const restored = this.elements.restore(id, origin);
        return `Restored "${restored.title}"`;
      }
      case "restore_element": {
        const deleted = this.elements.softDelete(id);
        return `Moved "${deleted.title}" to trash`;
      }
      case "update_element": {
        const prev = op.payload.prev;
        // A marker op (leech / flag / body edit) carries no object pre-image — there
        // is nothing to re-apply, so this op is non-invertible (return `null`, not a
        // fake success that also blocks undoing the real action behind it).
        if (typeof prev !== "object" || prev === null || Object.keys(prev).length === 0) {
          return null;
        }
        const updated = this.elements.update(id, prev as Record<string, never>);
        return `Reverted "${updated.title}"`;
      }
      case "reschedule_element": {
        const prevDueAt = (op.payload.prevDueAt ?? null) as IsoTimestamp | null;
        const prevStatusRaw = op.payload.prevStatus;
        const prevStatus =
          typeof prevStatusRaw === "string" ? (prevStatusRaw as ElementStatus) : undefined;
        const before = this.elements.findById(id);
        // A card postpone-defer (T030) advances BOTH `elements.due_at` AND the FSRS
        // `review_states.due_at` (the queue reads the latter for cards). Restoring
        // only `elements.due_at` would leave the card out of the FSRS due queue, so a
        // `cardDefer` op also restores `review_states.due_at` to its captured prior
        // value — both stores in ONE transaction (the two-scheduler split stays
        // consistent: the card returns to review after undo).
        const isCardDefer = op.payload.cardDefer === true;
        const prevReviewDueAt = isCardDefer
          ? ((op.payload.prevReviewDueAt ?? null) as IsoTimestamp | null)
          : null;
        const rescheduled = this.db.transaction((tx) => {
          const el = this.elements.rescheduleWithin(tx, id, prevDueAt, prevStatus);
          if (isCardDefer) {
            tx.update(reviewStates)
              .set({ dueAt: prevReviewDueAt })
              .where(eq(reviewStates.elementId, id))
              .run();
          }
          return el;
        });
        return `Restored schedule of "${(before ?? rescheduled).title}"`;
      }
      default:
        return null;
    }
  }

  /**
   * The prior status from a `soft_delete_element` op's `prev.status` payload, used
   * to restore the element to where it was. Defaults to `active` when absent.
   */
  private originStatus(op: ParsedOp): ElementStatus {
    const prev = op.payload.prev as { status?: unknown } | undefined;
    const prior = prev?.status;
    if (typeof prior === "string" && prior !== "deleted") return prior as ElementStatus;
    return "active";
  }

  private parse(row: RawOpRow): ParsedOp {
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (parsed && typeof parsed === "object") payload = parsed as Record<string, unknown>;
    } catch {
      payload = {};
    }
    return {
      opType: row.opType as OperationType,
      elementId: (row.elementId as ElementId | null) ?? null,
      payload,
    };
  }
}
