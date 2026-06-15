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
import { elements, type InterleaveDatabase, operationLog, reviewStates } from "@interleave/db";
import { desc, eq, sql } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import {
  originStatusFromPayload,
  parsePayload,
  restoreScheduleFromPayload,
} from "./op-payload-helpers";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient, TransactionClient } from "./types";

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

export interface UndoBatchOptions {
  readonly requirePostponeOriginKind?: string;
  readonly requireUpdateOriginKind?: string;
  readonly requireCurrentDueMatch?: boolean;
  readonly requireCurrentReferenceFateMatch?: boolean;
  /**
   * OP-TYPE-AGNOSTIC movement guard for a HETEROGENEOUS bulk batch (T126 inbox bulk
   * triage). A single bulk verb can emit `reschedule_element` (accept/queueSoon),
   * `update_element` (park/setPriority), or `soft_delete_element` (delete) — and a
   * combined verb+priority sweep mixes `update_element` with a reschedule/soft-delete
   * in one batch. Unlike {@link requireCurrentDueMatch} (only validates reschedule ops)
   * or {@link requireCurrentReferenceFateMatch} (only a done/reference update), this
   * checks, per op, that the element's CURRENT state still equals the POST-IMAGE the op
   * wrote — so undo refuses cleanly if ANY victim moved since the batch, regardless of
   * op type, and never clobbers a later edit.
   */
  readonly requireCurrentBulkTriageStateMatch?: boolean;
  readonly restoredPayloadExtras?: Readonly<Record<string, unknown>>;
  readonly afterUndo?: (tx: TransactionClient) => void;
}

interface RawOpRow {
  id: string;
  opType: string;
  payload: string;
  elementId: string | null;
  createdAt: string;
  /** Denormalized `payload.batchId` (migration 0041); `null` for single-op rows. */
  batchId: string | null;
}

interface ParsedOp {
  readonly id: string;
  readonly opType: OperationType;
  readonly elementId: ElementId | null;
  readonly payload: Record<string, unknown>;
}

export class UndoService {
  private readonly elements: ElementRepository;
  private readonly operationLog: OperationLogRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.operationLog = new OperationLogRepository(db);
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
   * Target one known batch id instead of the newest command. This is deliberately
   * narrower than a renderer-facing arbitrary batch undo: callers can require a
   * payload origin, and only invertible ops in that batch are restored.
   */
  undoBatch(batchId: string, options: UndoBatchOptions = {}): UndoResult {
    const batch = this.collectBatch(batchId);
    if (batch.length === 0) {
      return {
        undone: false,
        opType: null,
        elementId: null,
        label: "",
        reason: "Batch not found",
        count: 0,
      };
    }
    if (options.requirePostponeOriginKind && !isOwnedPostponeBatch(batch, options)) {
      return {
        undone: false,
        opType: batch[0]?.opType ?? null,
        elementId: batch[0]?.elementId ?? null,
        label: "",
        reason: "Batch is not owned by this receipt",
        count: 0,
      };
    }
    if (options.requireUpdateOriginKind && !isOwnedUpdateBatch(batch, options)) {
      return {
        undone: false,
        opType: batch[0]?.opType ?? null,
        elementId: batch[0]?.elementId ?? null,
        label: "",
        reason: "Batch is not owned by this receipt",
        count: 0,
      };
    }

    let label = "";
    let undoneCount = 0;
    let conflict = false;
    this.db.transaction((tx) => {
      if (options.requireCurrentDueMatch) {
        conflict = batch.some((op) => !this.currentDueMatchesAppliedWithin(tx, op));
        if (conflict) return;
      }
      if (options.requireCurrentReferenceFateMatch) {
        conflict = batch.some((op) => !this.currentReferenceFateMatchesAppliedWithin(tx, op));
        if (conflict) return;
      }
      if (options.requireCurrentBulkTriageStateMatch) {
        conflict = batch.some((op) => !this.currentBulkTriageStateMatchesAppliedWithin(tx, op));
        if (conflict) return;
      }
      for (const op of batch) {
        const opLabel = this.invertWithin(tx, op, options.restoredPayloadExtras ?? {});
        if (opLabel === null) continue;
        undoneCount += 1;
        if (!label && opLabel) label = opLabel;
      }
      if (undoneCount > 0) options.afterUndo?.(tx);
    });

    if (conflict) {
      return {
        undone: false,
        opType: batch[0]?.opType ?? null,
        elementId: batch[0]?.elementId ?? null,
        label: "",
        reason: options.requireCurrentReferenceFateMatch
          ? "Batch no longer matches current reference state"
          : options.requireCurrentBulkTriageStateMatch
            ? "One or more items have changed since this batch"
            : "Batch no longer matches current schedule",
        count: 0,
      };
    }

    if (undoneCount === 0) {
      return {
        undone: false,
        opType: batch[0]?.opType ?? null,
        elementId: batch[0]?.elementId ?? null,
        label: "",
        reason: "Batch contains no invertible operations",
        count: 0,
      };
    }

    return {
      undone: true,
      opType: batch[0]?.opType ?? null,
      elementId: batch[0]?.elementId ?? null,
      label: undoneCount === 1 ? label : `Undid ${undoneCount} changes`,
      count: undoneCount,
    };
  }

  /**
   * Whether an op CAN actually be inverted (beyond merely having an undoable type).
   * A marker `update_element` op (leech-flag-on-review, manual flag, card-body edit)
   * carries NO object `prev` PRE-IMAGE, so re-applying it would mutate nothing —
   * inverting it must NOT be reported as a success (the bug this guards). Every other
   * undoable op type carries the state it needs in its payload, so it is invertible.
   *
   * The first-grade draft-card PROMOTE (`reviewPromote: true`) is a special case: it
   * DOES carry a real `prev` (for audit/sync), but it rides WITH a review whose
   * `add_review_log` is itself non-invertible. Demoting the card to `card_draft`
   * while the durable review_log row + advanced FSRS due date persist would be an
   * incoherent PARTIAL undo, so it is treated as non-invertible here too.
   */
  private isInvertible(op: ParsedOp): boolean {
    if (!op.elementId) return false;
    if (op.payload.receiptRestore === true) return false;
    // T125 card re-stabilization demotions are a COMPOUND mutation (body edit + FSRS
    // demotion + marker row). Global ⌘Z must not partially reverse them — only the
    // schedule, leaving the new body text on the old schedule would recreate the very
    // contamination T125 prevents. The reversal is the guarded receipt undo
    // (`CardEditService.undoReStabilize`). The body edit itself is already non-invertible
    // (no `prev` preimage), so a re-stabilize commit is fully inert to global ⌘Z.
    if (op.payload.cardReStabilize === true) return false;
    if (op.opType === "update_element") {
      if (
        op.payload.chronicPostponeReset === true ||
        op.payload.chronicPostponeResetUndo === true
      ) {
        return true;
      }
      if (op.payload.reviewPromote === true) return false;
      // T123 content-staleness flag flips carry a real `prev` (for audit + T124
      // resolution-undo) but must NOT be inverted by the global undo: the source-edit
      // `update_document` that caused them is itself non-invertible, so a ⌘Z that
      // cleared the flags while the blocks stayed stale would desync the two layers.
      // The clear path is re-reconciliation (edit the block back), not undo.
      if (op.payload.propagation === true) return false;
      // T124 resolution ops (`reverifyResolution`) are reversed ONLY through the guarded
      // receipt path (`ReverifyResolutionService.undoReceipt` → `restoreResolutionWithin`),
      // never by global ⌘Z. Two reasons: (1) every resolution is immediately followed by a
      // `propagation: true` recompute op, which is the NEWEST op and non-invertible, so
      // `undoLast` short-circuits on it anyway — a "global undo" of a resolution was never
      // actually reachable. (2) A second, unguarded global-undo path would desync the
      // persisted receipt (it would re-insert provenance while leaving the receipt
      // `actionable`, so the snackbar Undo then falsely refuses "source changed"). One
      // authoritative undo path — the receipt, with its four-part current-state guard —
      // keeps the boolean, the provenance, and the receipt status consistent.
      if (
        typeof op.payload.reverifyResolution === "object" &&
        op.payload.reverifyResolution !== null
      ) {
        return false;
      }
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
    // Indexed lookup on the denormalized `batch_id` column (populated at append
    // time + backfilled by migration 0041) — O(batch size), not the O(total ops)
    // full-table scan + JS filter this used to be. Ordering is load-bearing:
    // newest-first so the batch inverts in reverse insertion order.
    const rows = this.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.batchId, batchId))
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .all() as RawOpRow[];
    return rows.map((row) => this.parse(row));
  }

  /**
   * Apply the inverse of one op; returns a snackbar label, or `null` when the op was
   * NOT actually invertible (a marker `update_element` with no usable pre-image), so
   * `undoLast` can skip it rather than report a phantom success.
   */
  private invert(op: ParsedOp): string | null {
    return this.invertWithin(this.db, op);
  }

  private currentDueMatchesAppliedWithin(tx: DbClient, op: ParsedOp): boolean {
    if (
      op.opType !== "reschedule_element" ||
      !op.elementId ||
      !Object.hasOwn(op.payload, "dueAt")
    ) {
      return false;
    }
    const appliedDueAt = (op.payload.dueAt ?? null) as IsoTimestamp | null;
    const element = tx
      .select({ deletedAt: elements.deletedAt, dueAt: elements.dueAt, status: elements.status })
      .from(elements)
      .where(eq(elements.id, op.elementId))
      .get();
    if (!element || (element.dueAt ?? null) !== appliedDueAt) return false;
    if (element.deletedAt !== null) return false;
    const appliedStatus = typeof op.payload.status === "string" ? op.payload.status : undefined;
    if (appliedStatus !== undefined && element.status !== appliedStatus) return false;
    if (op.payload.cardDefer === true) {
      const review = tx
        .select({ dueAt: reviewStates.dueAt })
        .from(reviewStates)
        .where(eq(reviewStates.elementId, op.elementId))
        .get();
      return (review?.dueAt ?? null) === appliedDueAt;
    }
    return true;
  }

  private currentReferenceFateMatchesAppliedWithin(tx: DbClient, op: ParsedOp): boolean {
    if (op.opType !== "update_element" || !op.elementId) return false;
    const patch = op.payload.patch;
    if (typeof patch !== "object" || patch === null) return false;
    const applied = patch as Record<string, unknown>;
    if (applied.status !== "done") return false;
    if ((applied.dueAt ?? null) !== null) return false;
    if (applied.extractFate !== "reference") return false;
    const element = tx
      .select({
        deletedAt: elements.deletedAt,
        status: elements.status,
        dueAt: elements.dueAt,
        extractFate: elements.extractFate,
      })
      .from(elements)
      .where(eq(elements.id, op.elementId))
      .get();
    return (
      Boolean(element) &&
      element?.deletedAt === null &&
      element.status === "done" &&
      (element.dueAt ?? null) === null &&
      element.extractFate === "reference"
    );
  }

  /**
   * Whether the element's CURRENT state still equals the POST-IMAGE this op wrote — the
   * op-type-agnostic conflict check for a bulk inbox-triage batch (T126). Per op type:
   *  - `reschedule_element` (bulk accept/queueSoon): same `due_at` + same `status` the
   *    op wrote, still live;
   *  - `update_element` (bulk park/setPriority): every applied `patch` field still holds
   *    (status / priority / dueAt / parkedAt), still live;
   *  - `soft_delete_element` (bulk delete): the row is still soft-deleted.
   * Anything else (or a row that vanished) is a conflict, so undo refuses cleanly.
   */
  private currentBulkTriageStateMatchesAppliedWithin(tx: DbClient, op: ParsedOp): boolean {
    if (!op.elementId) return false;
    const element = tx
      .select({
        deletedAt: elements.deletedAt,
        status: elements.status,
        dueAt: elements.dueAt,
        priority: elements.priority,
        parkedAt: elements.parkedAt,
      })
      .from(elements)
      .where(eq(elements.id, op.elementId))
      .get();
    if (!element) return false;
    switch (op.opType) {
      case "reschedule_element": {
        if (element.deletedAt !== null) return false;
        if (!Object.hasOwn(op.payload, "dueAt")) return false;
        const appliedDueAt = (op.payload.dueAt ?? null) as IsoTimestamp | null;
        if ((element.dueAt ?? null) !== appliedDueAt) return false;
        const appliedStatus = typeof op.payload.status === "string" ? op.payload.status : undefined;
        return appliedStatus === undefined || element.status === appliedStatus;
      }
      case "update_element": {
        if (element.deletedAt !== null) return false;
        const patch = op.payload.patch;
        if (typeof patch !== "object" || patch === null) return false;
        const applied = patch as Record<string, unknown>;
        if (Object.hasOwn(applied, "status") && element.status !== applied.status) return false;
        if (Object.hasOwn(applied, "priority") && element.priority !== applied.priority) {
          return false;
        }
        if (
          Object.hasOwn(applied, "dueAt") &&
          (element.dueAt ?? null) !== (applied.dueAt ?? null)
        ) {
          return false;
        }
        if (
          Object.hasOwn(applied, "parkedAt") &&
          (element.parkedAt ?? null) !== (applied.parkedAt ?? null)
        ) {
          return false;
        }
        return true;
      }
      case "soft_delete_element":
        return element.deletedAt !== null;
      default:
        return false;
    }
  }

  private invertWithin(
    tx: DbClient,
    op: ParsedOp,
    restoredPayloadExtras: Readonly<Record<string, unknown>> = {},
  ): string | null {
    const id = op.elementId;
    if (!id) return null;
    switch (op.opType) {
      case "soft_delete_element": {
        const origin = originStatusFromPayload(op.payload);
        // The lineage-delete path (T135 / U4) records schedule PRE-IMAGES in the op
        // payload (`prevDueAt`, and for a card `prevReviewDueAt`); when present, the
        // restore must re-establish BOTH stores so an undone card returns to the FSRS
        // due queue exactly where it was — mirrors the `reschedule_element` `cardDefer`
        // two-store inverse. A plain (legacy) soft-delete carries neither field, so
        // restore leaves the schedule untouched (unchanged behaviour).
        const schedule = restoreScheduleFromPayload(op.payload);
        const restored = this.elements.restore(id, origin, schedule ? { schedule } : undefined);
        return `Restored "${restored.title}"`;
      }
      case "restore_element": {
        // Symmetric inverse (T135 / U5): if this restore re-established a schedule
        // from a preimage, re-trashing must clear it again (and record the current
        // due as the next preimage) so undo-the-undo never leaves a phantom "Due
        // today". A legacy restore (no flag) re-trashes with the schedule untouched.
        const clearSchedule = op.payload.scheduleRestored === true;
        const deleted = clearSchedule
          ? this.elements.softDelete(id, { clearSchedule: true })
          : this.elements.softDelete(id);
        return `Moved "${deleted.title}" to trash`;
      }
      case "update_element": {
        if (op.payload.chronicPostponeReset === true) {
          const restored = op.payload.prevEffectivePostponeCount;
          const restoredEffectivePostponeCount =
            typeof restored === "number" && Number.isFinite(restored) && restored >= 0
              ? Math.floor(restored)
              : 0;
          this.appendChronicPostponeResetUndo(id, restoredEffectivePostponeCount);
          return `Restored postpone count`;
        }
        if (op.payload.chronicPostponeResetUndo === true) {
          const current = new OperationLogRepository(this.db).countPostpones(id);
          this.appendChronicPostponeReset(id, current);
          return `Reset postpone count`;
        }
        // The first-grade draft-card promote rides with a (non-invertible) review —
        // skip it so ⌘Z never partially undoes a review (see {@link isInvertible}).
        if (op.payload.reviewPromote === true) return null;
        // T123 content-staleness flag flips are non-invertible markers (see
        // {@link isInvertible}); the clear path is re-reconciliation, not undo.
        if (op.payload.propagation === true) return null;
        // T124 resolution ops are reversed ONLY through the guarded receipt path
        // (`undoReceipt` → `restoreResolutionWithin`), never global ⌘Z — see
        // {@link isInvertible}. Returning null here keeps the single authoritative undo
        // path (the receipt, with its four-part current-state guard) and avoids desyncing
        // the persisted receipt against an unguarded global re-insert.
        if (
          typeof op.payload.reverifyResolution === "object" &&
          op.payload.reverifyResolution !== null
        ) {
          return null;
        }
        const prev = op.payload.prev;
        // A marker op (leech / flag / body edit) carries no object pre-image — there
        // is nothing to re-apply, so this op is non-invertible (return `null`, not a
        // fake success that also blocks undoing the real action behind it).
        if (typeof prev !== "object" || prev === null || Object.keys(prev).length === 0) {
          return null;
        }
        const isQueueExit = op.payload.queueExit === true;
        const prevReviewDueAt =
          isQueueExit && Object.hasOwn(op.payload, "prevReviewDueAt")
            ? ((op.payload.prevReviewDueAt ?? null) as IsoTimestamp | null)
            : undefined;
        const updated = this.db.transaction((tx) => {
          const currentReviewDueAt =
            prevReviewDueAt !== undefined
              ? ((tx
                  .select({ dueAt: reviewStates.dueAt })
                  .from(reviewStates)
                  .where(eq(reviewStates.elementId, id))
                  .get()?.dueAt ?? null) as IsoTimestamp | null)
              : undefined;
          const extras = {
            ...restoredPayloadExtras,
            ...(currentReviewDueAt !== undefined
              ? { queueExit: true, prevReviewDueAt: currentReviewDueAt }
              : {}),
          };
          const el = this.elements.updateWithin(
            tx,
            id,
            prev as Record<string, never>,
            Object.keys(extras).length > 0 ? { extras } : undefined,
          );
          if (prevReviewDueAt !== undefined) {
            tx.update(reviewStates)
              .set({ dueAt: prevReviewDueAt })
              .where(eq(reviewStates.elementId, id))
              .run();
          }
          return el;
        });
        return `Reverted "${updated.title}"`;
      }
      case "reschedule_element": {
        // T125 re-stabilization demotions are reversed ONLY through the guarded receipt
        // undo (`CardEditService.undoReStabilize`), never global ⌘Z (see isInvertible).
        if (op.payload.cardReStabilize === true) return null;
        const prevDueAt = (op.payload.prevDueAt ?? null) as IsoTimestamp | null;
        const prevStatusRaw = op.payload.prevStatus;
        const prevStatus =
          typeof prevStatusRaw === "string" ? (prevStatusRaw as ElementStatus) : undefined;
        const prevAttentionIntervalMultiplierRaw = op.payload.prevAttentionIntervalMultiplier;
        const prevAttentionIntervalMultiplier =
          typeof prevAttentionIntervalMultiplierRaw === "number" &&
          Number.isFinite(prevAttentionIntervalMultiplierRaw)
            ? prevAttentionIntervalMultiplierRaw
            : undefined;
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
        const restoredScheduleEvidence = this.operationLog.scheduleEvidenceForDueAtBefore(
          id,
          prevDueAt,
          op.id,
        );
        const rescheduled = this.elements.rescheduleWithin(
          tx,
          id,
          prevDueAt,
          prevStatus,
          { ...restoredScheduleEvidence, ...restoredPayloadExtras },
          {
            ...(prevAttentionIntervalMultiplier !== undefined
              ? { attentionIntervalMultiplier: prevAttentionIntervalMultiplier }
              : {}),
          },
        );
        if (isCardDefer) {
          tx.update(reviewStates)
            .set({ dueAt: prevReviewDueAt })
            .where(eq(reviewStates.elementId, id))
            .run();
        }
        return `Restored schedule of "${(before ?? rescheduled).title}"`;
      }
      default:
        return null;
    }
  }

  private appendChronicPostponeReset(id: ElementId, prevEffectivePostponeCount: number): void {
    this.db.transaction((tx) => {
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: id,
        payload: {
          id,
          action: "chronicPostpone:redoReset",
          chronicPostponeReset: true,
          prevEffectivePostponeCount,
        },
      });
    });
  }

  private appendChronicPostponeResetUndo(
    id: ElementId,
    restoredEffectivePostponeCount: number,
  ): void {
    this.db.transaction((tx) => {
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: id,
        payload: {
          id,
          action: "chronicPostpone:undoReset",
          chronicPostponeResetUndo: true,
          restoredEffectivePostponeCount,
        },
      });
    });
  }

  private parse(row: RawOpRow): ParsedOp {
    return {
      id: row.id,
      opType: row.opType as OperationType,
      elementId: (row.elementId as ElementId | null) ?? null,
      payload: parsePayload(row.payload),
    };
  }
}

function postponeOriginKind(payload: Record<string, unknown>): string | null {
  const origin = payload.postponeOrigin;
  if (!origin || typeof origin !== "object") return null;
  const kind = (origin as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function isOwnedPostponeBatch(batch: readonly ParsedOp[], options: UndoBatchOptions): boolean {
  return batch.every(
    (op) =>
      op.opType === "reschedule_element" &&
      op.payload.postpone === true &&
      postponeOriginKind(op.payload) === options.requirePostponeOriginKind,
  );
}

function updateOriginKind(payload: Record<string, unknown>): string | null {
  const origin = payload.extractAgingOrigin;
  if (!origin || typeof origin !== "object") return null;
  const kind = (origin as Record<string, unknown>).kind;
  return typeof kind === "string" ? kind : null;
}

function isOwnedUpdateBatch(batch: readonly ParsedOp[], options: UndoBatchOptions): boolean {
  return batch.every(
    (op) =>
      op.opType === "update_element" &&
      updateOriginKind(op.payload) === options.requireUpdateOriginKind,
  );
}
