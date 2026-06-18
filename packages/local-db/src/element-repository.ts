/**
 * ElementRepository (T008) — CRUD for the universal `Element` primitive.
 *
 * Every source, topic, extract, card, task, concept, media fragment, and
 * synthesis note IS an `elements` row, so this is the most-used repository. It
 * owns the soft-delete (`deleted_at`) and restore semantics for the whole app —
 * user data is never destroyed; it is moved to the trash and recoverable.
 *
 * Every mutation here runs inside a SQLite transaction together with an
 * `operation_log` append (`create_element`, `update_element`,
 * `soft_delete_element`, `restore_element`, `reschedule_element`), so the data
 * change and its command-shaped log row commit or roll back atomically. IDs are
 * minted in this layer (never by SQLite), and `createdAt`/`updatedAt` are stamped
 * here so the timestamp format is consistent across the codebase.
 */

import type {
  DistillationStage,
  Element,
  ElementId,
  ElementRelation,
  ElementStatus,
  ElementType,
  ExtractFate,
  IsoTimestamp,
  Priority,
  RelationId,
  RelationType,
  SiblingGroupId,
} from "@interleave/core";
import {
  type ElementTagRow,
  elementRelations,
  elements,
  elementTags,
  type InterleaveDatabase,
  reviewStates,
  tags,
} from "@interleave/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { chunkIds } from "./chunk-in-array";
import { liveDescendantsWithin } from "./descendant-query";
import { newElementId, newRelationId, newRowId, nowIso } from "./ids";
import { rowToElement } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/** Arguments to add a typed lineage/relationship edge. */
export interface AddRelationInput {
  readonly fromElementId: ElementId;
  readonly toElementId: ElementId;
  readonly relationType: RelationType;
  /** Set when `relationType` is `sibling_group`; groups interfering siblings. */
  readonly siblingGroupId?: SiblingGroupId | null;
}

/** Fields required to create a new element. */
export interface CreateElementInput {
  readonly type: ElementType;
  readonly status: ElementStatus;
  readonly stage: DistillationStage;
  readonly priority: Priority;
  readonly attentionIntervalMultiplier?: number;
  readonly title: string;
  readonly dueAt?: IsoTimestamp | null;
  readonly fallowUntil?: IsoTimestamp | null;
  readonly fallowReason?: string | null;
  readonly fallowBatchId?: string | null;
  readonly parentId?: ElementId | null;
  readonly sourceId?: ElementId | null;
  /** Optional explicit id (e.g. when a side-table is created first). */
  readonly id?: ElementId;
}

/** Patchable fields on an existing element (lineage fields are immutable here). */
export interface UpdateElementInput {
  readonly status?: ElementStatus;
  readonly stage?: DistillationStage;
  readonly priority?: Priority;
  readonly attentionIntervalMultiplier?: number;
  readonly title?: string;
  readonly dueAt?: IsoTimestamp | null;
  readonly parkedAt?: IsoTimestamp | null;
  readonly fallowUntil?: IsoTimestamp | null;
  readonly fallowReason?: string | null;
  readonly fallowBatchId?: string | null;
  readonly extractFate?: ExtractFate | null;
}

/**
 * Optional command-context extras merged into a mutation's `operation_log`
 * payload WITHOUT growing the closed op set (T044). These enrich the existing
 * `update_element`/`reschedule_element` payloads so command-level undo can apply
 * an EXACT inverse, and so a bulk action's N rows can be undone as one batch:
 *  - `batchId` groups the N rows of a single bulk action (e.g. bulk-postpone), so
 *    `UndoService.undoLast` reverses every op that shares the most-recent op's id.
 *
 * `updateWithin`/`rescheduleWithin` additionally record a `prev` pre-image of the
 * changed fields automatically — the caller never supplies it.
 */
export interface OpContext {
  /** Groups the ops of one bulk action so undo reverses the whole batch. */
  readonly batchId?: string;
  /** Command-specific audit/undo metadata merged into the existing op payload. */
  readonly extras?: Readonly<Record<string, unknown>>;
  /**
   * Opt-in for the lineage-delete path (T135 / U4): when `true`, a soft-delete also
   * CLEARS the element's active attention schedule (`elements.due_at`) and — for a
   * `card` — its FSRS `review_states.due_at`, recording BOTH cleared values as
   * `prevDueAt`/`prevReviewDueAt` PRE-IMAGES in the `soft_delete_element` payload so
   * a restore re-establishes the exact pre-delete schedule (the deleted node never
   * lingers as a phantom "Due today"). Off by default, so every existing
   * `softDeleteWithin` caller keeps its single-row, schedule-untouched behaviour and
   * the optional payload fields stay absent.
   */
  readonly clearSchedule?: boolean;
}

export interface RescheduleOptions {
  /** Override the mutation timestamp; defaults to the repository wall-clock stamp. */
  readonly updatedAt?: IsoTimestamp;
  /** Optional T112 attention cadence multiplier to persist with the schedule. */
  readonly attentionIntervalMultiplier?: number;
}

/**
 * The schedule PRE-IMAGE to re-establish on restore (T135 / U5), read from the
 * `soft_delete_element` op payload that the lineage-delete path recorded.
 */
export interface RestoreSchedule {
  /** The `elements.due_at` to restore (the value cleared at delete time). */
  readonly dueAt: IsoTimestamp | null;
  /**
   * The card's FSRS `review_states.due_at` to restore. Only present (and only
   * written) for a card whose review due was cleared at delete time; `undefined`
   * leaves `review_states` untouched (a non-card, or a card with no FSRS state).
   */
  readonly reviewDueAt?: IsoTimestamp | null;
}

/** Options for {@link ElementRepository.restore}. */
export interface RestoreOptions {
  /** When set, re-establish the attention (+ FSRS, for cards) schedule from the preimage. */
  readonly schedule?: RestoreSchedule;
  /**
   * Groups the N `restore_element` ops of ONE atomic restore (a `restoreBatch` /
   * `restoreAncestorChain` call) under a shared id (T135 / A1), threaded into the
   * `restore_element` payload so `UndoService.undoLast` (which reverses every op
   * sharing the most-recent op's `batchId`) reverses the WHOLE restore as one unit.
   * Absent for a single-row restore (which undoes on its own).
   */
  readonly batchId?: string;
}

export class ElementRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /** Insert an element + log `create_element`, atomically. Returns the row. */
  create(input: CreateElementInput): Element {
    return this.db.transaction((tx) => this.createWithin(tx, input));
  }

  /**
   * Insert an element using an existing transaction — used by side-table
   * repositories (sources, cards, …) that create the element and its side-table
   * row in ONE transaction. Logs `create_element` on the same `tx`.
   */
  createWithin(tx: DbClient, input: CreateElementInput): Element {
    const id = input.id ?? newElementId();
    const ts = nowIso();
    const element: Element = {
      id,
      type: input.type,
      status: input.status,
      stage: input.stage,
      priority: input.priority,
      attentionIntervalMultiplier: input.attentionIntervalMultiplier ?? 1.0,
      dueAt: input.dueAt ?? null,
      parkedAt: null,
      fallowUntil: input.fallowUntil ?? null,
      fallowReason: input.fallowReason ?? null,
      fallowBatchId: input.fallowBatchId ?? null,
      extractFate: null,
      // T123 — a freshly created element is never content-stale; it gains the flag only
      // when a source block it derives from is later edited (via propagateReverify).
      needsReverify: false,
      staleSince: null,
      title: input.title,
      parentId: input.parentId ?? null,
      sourceId: input.sourceId ?? null,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    tx.insert(elements)
      .values({
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        attentionIntervalMultiplier: element.attentionIntervalMultiplier,
        dueAt: element.dueAt,
        parkedAt: element.parkedAt,
        fallowUntil: element.fallowUntil,
        fallowReason: element.fallowReason,
        fallowBatchId: element.fallowBatchId,
        extractFate: element.extractFate,
        title: element.title,
        parentId: element.parentId,
        sourceId: element.sourceId,
        createdAt: element.createdAt,
        updatedAt: element.updatedAt,
        deletedAt: null,
      })
      .run();
    new OperationLogRepository(tx).append(tx, {
      opType: "create_element",
      elementId: id,
      payload: { element },
    });
    return element;
  }

  /** Fetch one element by id (including soft-deleted), or `null`. */
  findById(id: ElementId): Element | null {
    const row = this.db.select().from(elements).where(eq(elements.id, id)).get();
    return row ? rowToElement(row) : null;
  }

  /** List live (not soft-deleted) elements of a given type. */
  listByType(type: ElementType): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(and(eq(elements.type, type), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /** List live elements with a given status. */
  listByStatus(status: ElementStatus): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(and(eq(elements.status, status), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /** List live direct children of a parent element. */
  listChildren(parentId: ElementId): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(and(eq(elements.parentId, parentId), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /**
   * List direct children of a parent element INCLUDING soft-deleted ones. Used by
   * the tombstone-aware lineage walk so a deleted middle node still surfaces its
   * (live or deleted) descendants; the default lineage path uses {@link
   * listChildren} (live-only) and is unaffected.
   */
  listChildrenIncludingDeleted(parentId: ElementId): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(eq(elements.parentId, parentId))
      .all()
      .map(rowToElement);
  }

  /** List live elements belonging to a given source (lineage root). */
  listBySource(sourceId: ElementId): Element[] {
    return this.db
      .select()
      .from(elements)
      .where(and(eq(elements.sourceId, sourceId), isNull(elements.deletedAt)))
      .all()
      .map(rowToElement);
  }

  /** Apply a patch + log `update_element`, atomically. Returns the new row. */
  update(id: ElementId, patch: UpdateElementInput, opContext?: OpContext): Element {
    return this.db.transaction((tx) => this.updateWithin(tx, id, patch, opContext));
  }

  /**
   * Set an element's numeric {@link Priority} + log `update_element`, atomically
   * (T027). A thin, named alias over {@link update} for the universal raise / lower
   * / set-priority write path: priority is first-class on EVERY element type
   * (source/extract/card/task/topic/synthesis_note), so this works for any of them.
   * The band math lives in `@interleave/core` (`raisePriority`/`lowerPriority`/
   * `priorityFromLabel`); this layer just persists the resulting numeric value.
   */
  setPriority(id: ElementId, priority: Priority): Element {
    return this.update(id, { priority });
  }

  /**
   * Apply a patch using an EXISTING transaction, logging `update_element` on the
   * SAME `tx`. The tx-composable seam {@link ExtractService} (T024) uses to move an
   * extract's stage AND reschedule it in ONE transaction (stage update +
   * reschedule + both op rows commit together).
   *
   * The `update_element` op payload is enriched (T044) with a `prev` PRE-IMAGE of
   * exactly the fields being patched (read BEFORE the write), so command-level undo
   * can re-apply the prior values for an EXACT inverse (re-applying logs another
   * `update_element`). This is a payload enrichment within the closed op set — NOT a
   * new op type and NOT a schema migration. `opContext.batchId` (when set) is also
   * recorded so a bulk action's N rows undo as one batch.
   */
  updateWithin(
    tx: DbClient,
    id: ElementId,
    patch: UpdateElementInput,
    opContext?: OpContext,
  ): Element {
    // Read the PRE-IMAGE before mutating so undo can restore the exact prior values.
    const before = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!before) throw new Error(`ElementRepository.update: element ${id} not found`);
    const prev: Record<string, unknown> = {};
    if (patch.status !== undefined) prev.status = before.status;
    if (patch.stage !== undefined) prev.stage = before.stage;
    if (patch.priority !== undefined) prev.priority = before.priority;
    if (patch.attentionIntervalMultiplier !== undefined) {
      prev.attentionIntervalMultiplier = before.attentionIntervalMultiplier;
    }
    if (patch.title !== undefined) prev.title = before.title;
    if (patch.dueAt !== undefined) prev.dueAt = before.dueAt;
    if (patch.parkedAt !== undefined) prev.parkedAt = before.parkedAt;
    if (patch.fallowUntil !== undefined) prev.fallowUntil = before.fallowUntil;
    if (patch.fallowReason !== undefined) prev.fallowReason = before.fallowReason;
    if (patch.fallowBatchId !== undefined) prev.fallowBatchId = before.fallowBatchId;
    if (patch.extractFate !== undefined) prev.extractFate = before.extractFate;

    const updatedAt = nowIso();
    const set: Record<string, unknown> = { updatedAt };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.stage !== undefined) set.stage = patch.stage;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.attentionIntervalMultiplier !== undefined) {
      set.attentionIntervalMultiplier = patch.attentionIntervalMultiplier;
    }
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
    if (patch.parkedAt !== undefined) set.parkedAt = patch.parkedAt;
    if (patch.fallowUntil !== undefined) set.fallowUntil = patch.fallowUntil;
    if (patch.fallowReason !== undefined) set.fallowReason = patch.fallowReason;
    if (patch.fallowBatchId !== undefined) set.fallowBatchId = patch.fallowBatchId;
    if (patch.extractFate !== undefined) set.extractFate = patch.extractFate;

    tx.update(elements).set(set).where(eq(elements.id, id)).run();
    const row = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!row) throw new Error(`ElementRepository.update: element ${id} not found`);
    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId: id,
      payload: {
        id,
        patch,
        prev,
        ...(opContext?.batchId ? { batchId: opContext.batchId } : {}),
        ...(opContext?.extras ?? {}),
      },
    });
    return rowToElement(row);
  }

  /**
   * Set the next due time + log `reschedule_element`, atomically. This is the
   * generic "process this again later" hook used by the attention scheduler and
   * the FSRS review flow alike (the scheduler decides the date elsewhere).
   */
  reschedule(id: ElementId, dueAt: IsoTimestamp | null, options?: RescheduleOptions): Element {
    return this.db.transaction((tx) =>
      this.rescheduleWithin(tx, id, dueAt, undefined, undefined, options),
    );
  }

  /**
   * Set the next due time using an EXISTING transaction, logging
   * `reschedule_element` on the SAME `tx`. Optionally also updates `status` (e.g.
   * `pending` → `scheduled` when an extract gets its first attention due date). The
   * tx-composable seam {@link ExtractionService} (T021) uses to give a new extract
   * its initial attention `due_at` inside the single extraction transaction.
   *
   * The `reschedule_element` op payload is enriched (T044) with a PRE-IMAGE
   * (`prevDueAt`/`prevStatus`, read BEFORE the write) so command-level undo can
   * restore the prior schedule for an EXACT inverse (covers postpone, incl.
   * bulk-postpone). Re-applying logs another `reschedule_element`. This is a payload
   * enrichment within the closed op set — NOT a new op type. A `batchId` in
   * `opExtras` (when set) groups a bulk action's N rows so undo reverses them as one.
   */
  rescheduleWithin(
    tx: DbClient,
    id: ElementId,
    dueAt: IsoTimestamp | null,
    status?: ElementStatus,
    /**
     * Extra, command-specific fields merged into the `reschedule_element` op
     * payload. The attention scheduler (T024 postpone) records a `postpone` marker
     * + running count here so the postpone history is queryable WITHOUT a schema
     * migration (the closed op set is unchanged — this only enriches the payload).
     */
    opExtras?: Readonly<Record<string, unknown>>,
    options?: RescheduleOptions,
  ): Element {
    // Read the PRE-IMAGE before mutating so undo can restore the exact prior schedule.
    const before = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!before) throw new Error(`ElementRepository.reschedule: element ${id} not found`);
    const prevDueAt = before.dueAt;
    const prevStatus = before.status;
    const prevAttentionIntervalMultiplier = before.attentionIntervalMultiplier;

    const updatedAt = options?.updatedAt ?? nowIso();
    const set: Record<string, unknown> = { dueAt, updatedAt };
    if (status !== undefined) set.status = status;
    if (options?.attentionIntervalMultiplier !== undefined) {
      set.attentionIntervalMultiplier = options.attentionIntervalMultiplier;
    }
    tx.update(elements).set(set).where(eq(elements.id, id)).run();
    const row = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!row) throw new Error(`ElementRepository.reschedule: element ${id} not found`);
    new OperationLogRepository(tx).append(tx, {
      opType: "reschedule_element",
      elementId: id,
      payload: {
        id,
        dueAt,
        ...(status !== undefined ? { status } : {}),
        prevDueAt,
        prevStatus,
        ...(options?.attentionIntervalMultiplier !== undefined
          ? {
              attentionIntervalMultiplier: options.attentionIntervalMultiplier,
              prevAttentionIntervalMultiplier,
            }
          : {}),
        ...(opExtras ?? {}),
      },
    });
    return rowToElement(row);
  }

  /**
   * Soft-delete: set `deletedAt` + status `deleted`, never DELETE the row, and
   * log `soft_delete_element`. The element moves to the trash and stays
   * recoverable; lineage references remain valid.
   *
   * `opContext.batchId` (when set) is threaded into the `soft_delete_element`
   * payload so a BULK soft-delete's N rows undo as ONE batch (T044/T099) — the same
   * payload-enrichment pattern as `updateWithin`/`rescheduleWithin`, within the
   * closed op set (NOT a new op type, NOT a migration).
   */
  softDelete(id: ElementId, opContext?: OpContext): Element {
    return this.db.transaction((tx) => this.softDeleteWithin(tx, id, opContext));
  }

  /**
   * Soft-delete using an EXISTING transaction, logging `soft_delete_element` on
   * the SAME `tx`. The tx-composable seam {@link OcclusionService} (T071) uses to
   * retire the prior batch of `image_occlusion` cards in the SAME transaction that
   * regenerates a diagram's masks + new cards — so an edit-then-regenerate REPLACES
   * the cards atomically instead of accumulating orphan, mask-less cards.
   *
   * `opContext.batchId` (when set) is recorded in the op payload so the general
   * `UndoService.undoLast` reverses an entire bulk sweep in one call (T099).
   */
  softDeleteWithin(tx: DbClient, id: ElementId, opContext?: OpContext): Element {
    // Capture the PRE-IMAGE status so the Trash view + undo can restore the
    // element to where it was (the op payload is the undo/origin source of truth).
    const before = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!before) throw new Error(`ElementRepository.softDelete: element ${id} not found`);
    if (before.type === "synthesis_note") {
      this.clearSynthesisFatesForNoteWithin(tx, id);
    }
    const prevStatus = before.status;
    const ts = nowIso();

    // The lineage-delete path (U4) clears the element's active schedule in the SAME
    // transaction and records the cleared values as PRE-IMAGES so restore is exact.
    // For a CARD the governing due date is the FSRS `review_states.due_at`, not only
    // `elements.due_at` — so both stores must be read+cleared (mirrors the queue-exit
    // and `cardDefer` two-store precedent). Off by default: every other caller keeps
    // the legacy single-row, schedule-untouched behaviour (these fields stay absent).
    const clearSchedule = opContext?.clearSchedule === true;
    const prevDueAt = clearSchedule ? (before.dueAt ?? null) : undefined;
    let prevReviewDueAt: IsoTimestamp | null | undefined;
    if (clearSchedule && before.type === "card") {
      const reviewRow = tx
        .select({ dueAt: reviewStates.dueAt })
        .from(reviewStates)
        .where(eq(reviewStates.elementId, id))
        .get();
      // `null` means a review_states row exists but is un-due; `undefined` means no
      // row at all (don't write a phantom preimage for a card that has no FSRS state).
      prevReviewDueAt = reviewRow ? ((reviewRow.dueAt ?? null) as IsoTimestamp | null) : undefined;
    }

    const set: Record<string, unknown> = { deletedAt: ts, status: "deleted", updatedAt: ts };
    if (clearSchedule) set.dueAt = null;
    tx.update(elements).set(set).where(eq(elements.id, id)).run();
    if (clearSchedule && prevReviewDueAt !== undefined) {
      tx.update(reviewStates).set({ dueAt: null }).where(eq(reviewStates.elementId, id)).run();
    }
    const row = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!row) throw new Error(`ElementRepository.softDelete: element ${id} not found`);
    new OperationLogRepository(tx).append(tx, {
      opType: "soft_delete_element",
      elementId: id,
      payload: {
        id,
        deletedAt: ts,
        prev: { status: prevStatus },
        ...(opContext?.batchId ? { batchId: opContext.batchId } : {}),
        ...(prevDueAt !== undefined ? { prevDueAt } : {}),
        ...(prevReviewDueAt !== undefined ? { prevReviewDueAt } : {}),
      },
    });
    return rowToElement(row);
  }

  /**
   * Soft-delete a target node and OPTIONALLY its entire live subtree in ONE
   * transaction under a single shared `batchId` (T135 / U4). This is the one path
   * behind BOTH lineage-delete intents (KTD7):
   *  - "keep descendants" (`includeSubtree: false`) tombstones only the target node;
   *  - "delete the whole branch" (`includeSubtree: true`) soft-deletes the node AND
   *    every live descendant (walked via the shared {@link liveDescendantsWithin}
   *    DFS, the same set the fallow walk and the blast-radius inventory use).
   *
   * Every per-node delete is PREIMAGE-AWARE ({@link OpContext.clearSchedule}): it
   * clears `elements.due_at` (+ a card's `review_states.due_at`) and records the
   * cleared values in the `soft_delete_element` payload, so no deleted node lingers
   * as a phantom "Due today" and restore re-establishes the exact pre-delete
   * schedule. Synthesis direction (a) is inherited for free — `softDeleteWithin`
   * already clears a `synthesis_note`'s cached `synthesized` fates on its still-live
   * targets; direction (b) (a deleted TARGET extract whose live note stays outside
   * the set) is reconciled by the {@link ExtractService} entry that wraps this.
   *
   * DELETE ORDER is root-first (the root, then descendants in DFS order). The op
   * rows therefore appear root-first within the batch; the batch restore inverts
   * them root-first too (see {@link TrashRepository.restoreBatch}). Rows already
   * soft-deleted are skipped (idempotent) rather than re-stamped, so a partial
   * subtree that was deleted earlier does not get a duplicate tombstone op.
   *
   * Returns the ids actually soft-deleted by THIS call (excludes already-deleted
   * rows) so the caller can report the affected count.
   */
  softDeleteSubtreeWithin(
    tx: DbClient,
    id: ElementId,
    options: { readonly batchId: string; readonly includeSubtree: boolean },
  ): { readonly affected: readonly ElementId[] } {
    const root = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!root) throw new Error(`ElementRepository.softDeleteSubtree: element ${id} not found`);

    // Root first, then live descendants (only when cascading). The descendant walk
    // already skips soft-deleted rows, so the set is exactly the live subtree.
    const targets: ElementId[] = [id];
    if (options.includeSubtree) {
      for (const descendant of liveDescendantsWithin(tx, id)) {
        targets.push(descendant.id as ElementId);
      }
    }

    const affected: ElementId[] = [];
    for (const targetId of targets) {
      const row = tx.select().from(elements).where(eq(elements.id, targetId)).get();
      // Revalidate inside the tx: skip a row that is missing or already in the trash
      // rather than re-stamping it (maintenance-sweep shape — never fail the batch).
      if (!row || row.deletedAt) continue;
      this.softDeleteWithin(tx, targetId, { batchId: options.batchId, clearSchedule: true });
      affected.push(targetId);
    }
    return { affected };
  }

  /**
   * Restore a soft-deleted element to the given status (default `active`), clear
   * `deletedAt`, and log `restore_element`.
   *
   * {@link RestoreOptions.schedule} (T135 / U5) re-establishes the element's
   * attention schedule from the PRE-IMAGE the lineage-delete path recorded: it
   * writes `elements.due_at` back to `prevDueAt` and, for a card, `review_states.due_at`
   * back to `prevReviewDueAt`, IN THE SAME transaction as the restore. Without it,
   * restore (the legacy behaviour) touches only `status`/`deletedAt`, which would
   * leave a lineage-deleted node out of its queue because its due was cleared at
   * delete time. Callers pass the preimage they read from the `soft_delete_element`
   * op payload; absent (the legacy callers), restore leaves the schedule untouched.
   */
  restore(id: ElementId, status: ElementStatus = "active", options?: RestoreOptions): Element {
    return this.db.transaction((tx) => this.restoreWithin(tx, id, status, options));
  }

  /**
   * Restore using an EXISTING transaction, logging `restore_element` on the SAME
   * `tx` (so a batch restore reuses one op-logging path). See {@link restore}.
   */
  restoreWithin(
    tx: DbClient,
    id: ElementId,
    status: ElementStatus = "active",
    options?: RestoreOptions,
  ): Element {
    const before = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!before) throw new Error(`ElementRepository.restore: element ${id} not found`);
    if (before.type === "synthesis_note") {
      this.setSynthesisFatesForNoteWithin(tx, id);
    }
    const ts = nowIso();
    const set: Record<string, unknown> = { deletedAt: null, status, updatedAt: ts };
    const schedule = options?.schedule;
    if (schedule) set.dueAt = schedule.dueAt ?? null;
    tx.update(elements).set(set).where(eq(elements.id, id)).run();
    // A card's governing due lives in FSRS `review_states` — re-establish it too so a
    // restored card returns to the FSRS due queue exactly where it was before delete.
    if (schedule && before.type === "card" && schedule.reviewDueAt !== undefined) {
      tx.update(reviewStates)
        .set({ dueAt: schedule.reviewDueAt ?? null })
        .where(eq(reviewStates.elementId, id))
        .run();
    }
    const row = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!row) throw new Error(`ElementRepository.restore: element ${id} not found`);
    new OperationLogRepository(tx).append(tx, {
      opType: "restore_element",
      elementId: id,
      payload: {
        id,
        status,
        // Group the ops of one atomic restore (a `restoreBatch` / `restoreAncestorChain`
        // call) so `UndoService.undoLast` reverses the WHOLE restore as one unit (T135 / A1).
        ...(options?.batchId ? { batchId: options.batchId } : {}),
        // Mark that this restore re-established a schedule from a preimage, so the
        // inverse (undo-the-undo) re-clears the schedule symmetrically (T135 / U5):
        // a re-trash of a node whose due was set by THIS restore must clear that due
        // again (and record it as the next preimage) instead of leaving a phantom.
        ...(schedule ? { scheduleRestored: true } : {}),
      },
    });
    return rowToElement(row);
  }

  private clearSynthesisFatesForNoteWithin(tx: DbClient, noteId: ElementId): void {
    for (const target of this.listReferencedExtractRowsWithin(tx, noteId)) {
      if (target.extractFate !== "synthesized") continue;
      if (this.hasOtherLiveSynthesisReferenceWithin(tx, target.id as ElementId, noteId)) continue;
      if (target.deletedAt) {
        this.updateWithin(tx, target.id as ElementId, { extractFate: null });
      } else {
        this.updateWithin(tx, target.id as ElementId, {
          status: "scheduled",
          dueAt: nowIso(),
          parkedAt: null,
          extractFate: null,
        });
      }
    }
  }

  private setSynthesisFatesForNoteWithin(tx: DbClient, noteId: ElementId): void {
    for (const target of this.listReferencedExtractRowsWithin(tx, noteId)) {
      if (target.deletedAt || target.extractFate !== null) continue;
      this.updateWithin(tx, target.id as ElementId, {
        status: "done",
        dueAt: null,
        parkedAt: null,
        extractFate: "synthesized",
      });
    }
  }

  private listReferencedExtractRowsWithin(tx: DbClient, noteId: ElementId) {
    return tx
      .select({
        id: elements.id,
        deletedAt: elements.deletedAt,
        extractFate: elements.extractFate,
      })
      .from(elementRelations)
      .innerJoin(elements, eq(elementRelations.toElementId, elements.id))
      .where(
        and(
          eq(elementRelations.fromElementId, noteId),
          eq(elementRelations.relationType, "references"),
          eq(elements.type, "extract"),
        ),
      )
      .all();
  }

  private hasOtherLiveSynthesisReferenceWithin(
    tx: DbClient,
    targetId: ElementId,
    noteId: ElementId,
  ): boolean {
    const row = tx
      .select({ fromElementId: elementRelations.fromElementId })
      .from(elementRelations)
      .innerJoin(elements, eq(elementRelations.fromElementId, elements.id))
      .where(
        and(
          eq(elementRelations.toElementId, targetId),
          eq(elementRelations.relationType, "references"),
          eq(elements.type, "synthesis_note"),
          isNull(elements.deletedAt),
        ),
      )
      .all()
      .find((ref) => ref.fromElementId !== noteId);
    return row != null;
  }

  /** Live (not soft-deleted) elements whose ids are in `ids`, preserving none of the order. */
  findManyLive(ids: readonly ElementId[]): Element[] {
    if (ids.length === 0) return [];
    // Chunk the IN (...) list so an unbounded id set (e.g. concept members over
    // the whole vault) stays under SQLite's variable limit. Merging chunks is
    // output-identical: this read does not depend on order across the id list.
    const out: Element[] = [];
    for (const chunk of chunkIds(ids as ElementId[])) {
      out.push(
        ...this.db
          .select()
          .from(elements)
          .where(and(inArray(elements.id, chunk), isNull(elements.deletedAt)))
          .all()
          .map(rowToElement),
      );
    }
    return out;
  }

  /**
   * Batched twin of {@link findById}: elements whose ids are in `ids`, INCLUDING
   * soft-deleted rows (no `deleted_at` filter — matching `findById`'s liveness-agnostic
   * read). Order is not preserved; missing ids are simply absent.
   *
   * Used where a batched path must reproduce a `findById` parent-chain walk exactly — e.g.
   * {@link QueueQuery.buildFallowContextMap} resolves fallow-topic ancestors with `findById`
   * semantics, so a soft-deleted ancestor stays visible to the walk (parity with the
   * single-row `fallowContextFor`).
   */
  findManyById(ids: readonly ElementId[]): Element[] {
    if (ids.length === 0) return [];
    // Chunk the IN (...) list so an unbounded id set stays under SQLite's
    // variable limit. Merging chunks is output-identical: this read does not
    // depend on order across the id list.
    const out: Element[] = [];
    for (const chunk of chunkIds(ids as ElementId[])) {
      out.push(
        ...this.db
          .select()
          .from(elements)
          .where(inArray(elements.id, chunk))
          .all()
          .map(rowToElement),
      );
    }
    return out;
  }

  /**
   * Add a typed edge between two elements + log `add_relation`, atomically.
   * Lineage is modeled as explicit rows (not implicit nesting), and sibling
   * groups keep interfering cloze/Q&A siblings from being shown back-to-back.
   */
  addRelation(input: AddRelationInput): ElementRelation {
    return this.db.transaction((tx) => this.addRelationWithin(tx, input));
  }

  /**
   * Add a typed edge using an EXISTING transaction, logging `add_relation` on the
   * SAME `tx`. The tx-composable seam {@link ExtractionService} (T021) uses to record
   * the `derived_from` extract→source/parent edge inside the single extraction
   * transaction.
   */
  addRelationWithin(tx: DbClient, input: AddRelationInput): ElementRelation {
    const id: RelationId = newRelationId();
    const createdAt = nowIso();
    tx.insert(elementRelations)
      .values({
        id,
        fromElementId: input.fromElementId,
        toElementId: input.toElementId,
        relationType: input.relationType,
        siblingGroupId: input.siblingGroupId ?? null,
        createdAt,
      })
      .run();
    new OperationLogRepository(tx).append(tx, {
      opType: "add_relation",
      elementId: input.fromElementId,
      payload: { id, ...input },
    });
    return {
      id,
      fromElementId: input.fromElementId,
      toElementId: input.toElementId,
      relationType: input.relationType,
      siblingGroupId: input.siblingGroupId ?? null,
      createdAt,
    };
  }

  /**
   * Remove a relation edge by id + log `remove_relation`, atomically. A no-op delete
   * (the relation id does not exist) does NOT append an op — mirrors {@link removeTag},
   * keeping phantom ops out of the append-only log (a phantom op could otherwise be the
   * latest op a future undo inspects).
   */
  removeRelation(id: RelationId): void {
    this.db.transaction((tx) => this.removeRelationWithin(tx, id));
  }

  /**
   * Remove a relation using an EXISTING transaction, logging `remove_relation` on the
   * SAME `tx`. A missing relation remains a no-op.
   */
  removeRelationWithin(tx: DbClient, id: RelationId): void {
    const row = tx.select().from(elementRelations).where(eq(elementRelations.id, id)).get();
    if (!row) return;
    tx.delete(elementRelations).where(eq(elementRelations.id, id)).run();
    new OperationLogRepository(tx).append(tx, {
      opType: "remove_relation",
      elementId: (row.fromElementId as ElementId | undefined) ?? null,
      payload: { id },
    });
  }

  /** All outgoing edges from an element. */
  listRelationsFrom(fromElementId: ElementId): ElementRelation[] {
    return this.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.fromElementId, fromElementId))
      .all()
      .map((row) => ({
        id: row.id as RelationId,
        fromElementId: row.fromElementId as ElementId,
        toElementId: row.toElementId as ElementId,
        relationType: row.relationType as RelationType,
        siblingGroupId: (row.siblingGroupId as SiblingGroupId | null) ?? null,
        createdAt: row.createdAt,
      }));
  }

  /**
   * A BATCHED `card element id -> sibling group id` map built from ONE
   * `sibling_group` relations read (T076). The review session resolves a card's
   * group per card via {@link ReviewSessionService.siblingGroupOf}; doing that for
   * every row of a large due-card set would be N+1, so the queue read builds this map
   * once per `list()` and looks up each row. Mirrors the M6 shape: the
   * `sibling_group` `element_relations` edge FROM the card carries the grouping
   * `siblingGroupId`. A card with several edges keeps the first non-null group (a
   * card belongs to one group). Read-only; mutates nothing.
   */
  liveSiblingGroupMap(): Map<ElementId, SiblingGroupId> {
    const rows = this.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.relationType, "sibling_group"))
      .all();
    const byCard = new Map<ElementId, SiblingGroupId>();
    for (const row of rows) {
      const group = (row.siblingGroupId as SiblingGroupId | null) ?? null;
      if (group == null) continue;
      const cardId = row.fromElementId as ElementId;
      if (!byCard.has(cardId)) byCard.set(cardId, group);
    }
    return byCard;
  }

  /**
   * Attach a tag (by name, created on demand) to an element + log `add_tag`,
   * atomically. Idempotent: re-tagging is a no-op on the join.
   */
  addTag(elementId: ElementId, tagName: string): void {
    this.db.transaction((tx) => this.addTagWithin(tx, elementId, tagName));
  }

  /**
   * Attach a tag using an EXISTING transaction, logging `add_tag` on the SAME `tx`.
   * The tx-composable seam {@link ExtractionService} (T021) uses to inherit the
   * source's tags onto a new extract inside the single extraction transaction.
   * Idempotent: re-tagging is a no-op on the join.
   */
  addTagWithin(tx: DbClient, elementId: ElementId, tagName: string): void {
    let tagRow = tx.select().from(tags).where(eq(tags.name, tagName)).get();
    if (!tagRow) {
      const tagId = newRowId();
      tx.insert(tags).values({ id: tagId, name: tagName }).run();
      tagRow = { id: tagId, name: tagName };
    }
    tx.insert(elementTags).values({ elementId, tagId: tagRow.id }).onConflictDoNothing().run();
    new OperationLogRepository(tx).append(tx, {
      opType: "add_tag",
      elementId,
      payload: { elementId, tagId: tagRow.id, tagName },
    });
  }

  /** Detach a tag (by name) from an element + log `remove_tag`, atomically. */
  removeTag(elementId: ElementId, tagName: string): void {
    this.db.transaction((tx) => {
      const tagRow = tx.select().from(tags).where(eq(tags.name, tagName)).get();
      if (!tagRow) return;
      tx.delete(elementTags)
        .where(and(eq(elementTags.elementId, elementId), eq(elementTags.tagId, tagRow.id)))
        .run();
      new OperationLogRepository(tx).append(tx, {
        opType: "remove_tag",
        elementId,
        payload: { elementId, tagId: tagRow.id, tagName },
      });
    });
  }

  /** Tag names attached to an element. */
  listTags(elementId: ElementId): string[] {
    const rows: ElementTagRow[] = this.db
      .select()
      .from(elementTags)
      .where(eq(elementTags.elementId, elementId))
      .all();
    if (rows.length === 0) return [];
    const tagIds = rows.map((r) => r.tagId);
    return this.db
      .select()
      .from(tags)
      .where(inArray(tags.id, tagIds))
      .all()
      .map((t) => t.name);
  }

  /**
   * Tag names for MANY elements in one query — the batched twin of {@link listTags}.
   * Returns a `Map<ElementId, string[]>` where each value preserves the SAME
   * ordering `listTags` returns (by `tags.id`, which is insertion order). Elements
   * with no tags are absent from the map. Empty `ids` → empty map.
   */
  listTagsForMany(ids: readonly ElementId[]): Map<ElementId, string[]> {
    if (ids.length === 0) return new Map();

    // One join query per chunk: element_tags ⋈ tags, filtered to the requested
    // element ids. We chunk the IN (...) list so an unbounded id set (e.g. the
    // full uncapped due set) stays under SQLite's variable limit. We order by
    // elementId then tagId so the fold builds each element's list in the same
    // order listTags returns (tag rows sorted by id). Chunking by element id is
    // safe: every row for a given element comes back within ITS chunk and stays
    // ordered, so merging into the map is output-identical to one big read.
    const out = new Map<ElementId, string[]>();
    for (const chunk of chunkIds(ids as ElementId[])) {
      const rows = this.db
        .select({ elementId: elementTags.elementId, tagName: tags.name, tagId: tags.id })
        .from(elementTags)
        .innerJoin(tags, eq(elementTags.tagId, tags.id))
        .where(inArray(elementTags.elementId, chunk))
        .orderBy(elementTags.elementId, tags.id)
        .all();

      for (const row of rows) {
        const eid = row.elementId as ElementId;
        const list = out.get(eid);
        if (list) {
          list.push(row.tagName);
        } else {
          out.set(eid, [row.tagName]);
        }
      }
    }
    return out;
  }

  /**
   * All tags with their LIVE usage count (T041) — the read behind the library
   * filterbar's tag list. Counts only assignments to live (not soft-deleted)
   * elements, so a tag whose only owners were trashed reports `0`. Read-only.
   */
  listAllTags(): { name: string; count: number }[] {
    const tagRows = this.db.select().from(tags).all();
    if (tagRows.length === 0) return [];
    const counts = new Map<string, number>();
    const joinRows = this.db.select().from(elementTags).all();
    for (const join of joinRows) {
      const el = this.db
        .select({ deletedAt: elements.deletedAt })
        .from(elements)
        .where(eq(elements.id, join.elementId as ElementId))
        .get();
      if (!el || el.deletedAt) continue;
      counts.set(join.tagId, (counts.get(join.tagId) ?? 0) + 1);
    }
    return tagRows
      .map((t) => ({ name: t.name, count: counts.get(t.id) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * The LIVE element ids tagged with a given tag name (T041) — feeds tag
   * filtering. Returns `[]` when the tag is unknown. Read-only.
   */
  elementsForTag(tagName: string): ElementId[] {
    const tagRow = this.db.select().from(tags).where(eq(tags.name, tagName)).get();
    if (!tagRow) return [];
    const joinRows = this.db
      .select()
      .from(elementTags)
      .where(eq(elementTags.tagId, tagRow.id))
      .all();
    const out: ElementId[] = [];
    for (const join of joinRows) {
      const id = join.elementId as ElementId;
      const el = this.db
        .select({ deletedAt: elements.deletedAt })
        .from(elements)
        .where(eq(elements.id, id))
        .get();
      if (el && !el.deletedAt) out.push(id);
    }
    return out;
  }
}
