/**
 * QueueActionService (T030) — the in-place ACT seam for the daily queue.
 *
 * The `/queue` screen (T029) lists everything due; this service is what makes every
 * row ACT in place. It is a thin DISPATCHER over the already-built mutation paths —
 * it invents no scheduling or priority math of its own:
 *
 *  - `postpone` → the ATTENTION item reschedules further out via {@link SchedulerService}
 *    (`reschedule_element` + the postpone marker/count in the op payload); a CARD
 *    defers its FSRS `review_states.due_at` forward via {@link ReviewRepository}
 *    (a deliberate THIN defer for M5 — full FSRS grade-driven rescheduling is M7);
 *  - `raise` / `lower` → the `@interleave/core` band helpers + {@link ElementRepository.setPriority}
 *    (`update_element`);
 *  - `markDone` → status `done` via {@link ElementRepository.update} (`update_element`);
 *  - `dismiss` → status `dismissed` via {@link ElementRepository.update} (`update_element`);
 *  - `delete` → SOFT delete via {@link ElementRepository.softDelete} (`soft_delete_element`),
 *    recoverable via {@link ElementRepository.restore}.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing) holds here: an attention item postpones on
 * the attention scheduler; a card defers on FSRS. A card is NEVER put on the
 * attention heuristic, and an extract NEVER gets an FSRS row. Each action is ONE
 * transaction appending exactly the right existing op (no new op types — the closed
 * 15-op set is unchanged). Delete is soft + undoable; undo for done/dismiss re-sets
 * the prior status, undo for delete restores the row.
 *
 * The queue actions (this service) and the process loop (T031) call into here; the
 * renderer reaches it only through the typed `window.appApi.queue.act` command,
 * never directly.
 */

import type { Element, ElementId, ElementStatus, IsoTimestamp, Priority } from "@interleave/core";
import { lowerPriority, raisePriority } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { BlockProcessingService } from "./block-processing-service";
import { ElementRepository } from "./element-repository";
import { newRowId, nowIso } from "./ids";
import { ReviewRepository } from "./review-repository";
import { SchedulerService } from "./scheduler-service";
import type { DbClient } from "./types";

/** The mutating queue actions (open is renderer-only navigation, never an IPC call). */
export type QueueActionKind = "postpone" | "raise" | "lower" | "markDone" | "dismiss" | "delete";

export interface QueueActionOptions {
  readonly confirmUnresolvedBlocks?: boolean;
}

/** How far forward a card's FSRS due is nudged on an M5 thin postpone-defer. */
export const CARD_DEFER_DAYS = 1;

const DAY_MS = 86_400_000;

/**
 * The SHARED FSRS-defer helper (T077) — the ONE place a card's schedule is pushed forward
 * WITHOUT a re-grade. It is the heart of the two-scheduler split's card half: it moves ONLY
 * `review_states.due_at` (+ `elements.due_at` in lockstep, since the queue reads
 * `review_states.due_at` for cards), in ONE transaction, logging `reschedule_element` with
 * the EXACT existing payload shape (`{ postpone: true, cardDefer: true, prevReviewDueAt,
 * batchId? }`), PRESERVING the card's element status (a card lives in active/pending/
 * suspended, never the attention-side `scheduled`), and writing NO review log. FSRS memory
 * state (`stability`/`difficulty`/`reps`/`lapses`/`fsrsState`) is left UNTOUCHED — a deferred
 * card resumes its exact FSRS trajectory when it next comes due.
 *
 * Two variants share this core so the new due is the ONLY difference:
 *  - {@link cardDeferBy} — RELATIVE: `nextDue = max(prevReviewDueAt, now) + days` (what T077's
 *    single-shot "postpone by one cycle" valve uses);
 *  - {@link cardDeferTo} — ABSOLUTE: `nextDue = targetDueAt` (what T078 catch-up uses so each
 *    card lands on the EXACT planned calendar day the per-day load curve was computed for —
 *    converting an absolute date back to a relative delta is lossy when `prevDue` is already
 *    overdue, which would break catch-up's "each day ≤ budget" guarantee).
 *
 * Exported (not private) so a separate `AutoPostponeService` / `RecoveryModeService` can call
 * it directly without a visibility wall (the spec's option (a) — a shared, exported helper).
 */
export function cardDeferWithin(
  tx: DbClient,
  elements: ElementRepository,
  id: ElementId,
  nextDue: IsoTimestamp,
  prevReviewDueAt: IsoTimestamp | null,
  batchId?: string,
): Element {
  // Keep the FSRS due (review_states) and the element due in lockstep so the queue (which
  // reads review_states.due_at for cards) picks up the new date.
  tx.update(reviewStates).set({ dueAt: nextDue }).where(eq(reviewStates.elementId, id)).run();
  // Capture the FSRS due PRE-IMAGE in the `reschedule_element` op so command-level undo
  // restores BOTH `elements.due_at` and `review_states.due_at` (T044). PRESERVE the card's
  // status (pass no `status`): a card never wears the attention-side `scheduled`.
  return elements.rescheduleWithin(tx, id, nextDue, undefined, {
    postpone: true,
    cardDefer: true,
    prevReviewDueAt,
    ...(batchId ? { batchId } : {}),
  });
}

/**
 * Read a card's current FSRS due (the pre-image), or `null` for a never-scheduled card.
 * The base the RELATIVE {@link cardDeferBy} pushes forward from.
 */
function reviewDueOf(review: ReviewRepository, id: ElementId): IsoTimestamp | null {
  return review.findReviewState(id)?.dueAt ?? null;
}

/** The result of applying one queue action. */
export interface QueueActionResult {
  /** The element after the action (live row). For a delete this is the soft-deleted row. */
  readonly element: Element;
  /**
   * Whether the row should LEAVE the due list (it is no longer due / no longer
   * active): `true` for done / dismiss / delete, `false` for postpone / raise /
   * lower (the row stays but its summary changed — possibly re-sorted).
   */
  readonly removed: boolean;
  /** Whether this action is undoable (and how the renderer's undo snackbar restores it). */
  readonly undo: QueueActionUndo | null;
}

/** The undo recipe for a destructive/removing action. */
export interface QueueActionUndo {
  /** `restore` → `ElementRepository.restore`; `status` → re-set the prior status. */
  readonly kind: "restore" | "status";
  /** The status to restore to (the row's status BEFORE the action). */
  readonly previousStatus: ElementStatus;
}

export class QueueActionService {
  private readonly elements: ElementRepository;
  private readonly scheduler: SchedulerService;
  private readonly review: ReviewRepository;
  private readonly blockProcessing: BlockProcessingService;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.scheduler = new SchedulerService(db);
    this.review = new ReviewRepository(db);
    this.blockProcessing = new BlockProcessingService(db);
  }

  /** Load a live (non-deleted) element by id, throwing when missing/deleted. */
  private requireLive(id: ElementId): Element {
    const element = this.elements.findById(id);
    if (!element || element.deletedAt) {
      throw new Error(`QueueActionService: element ${id} not found`);
    }
    return element;
  }

  /**
   * Apply one queue action to a due row, dispatching by `kind`. Each branch runs in
   * ONE transaction (inside the repository/service it delegates to) and appends the
   * correct existing op. Returns the post-action element + whether the row leaves
   * the list + the undo recipe for the snackbar.
   */
  act(
    id: ElementId,
    kind: QueueActionKind,
    now: IsoTimestamp = nowIso(),
    options: QueueActionOptions = {},
  ): QueueActionResult {
    const element = this.requireLive(id);
    switch (kind) {
      case "postpone":
        return this.postpone(element, now);
      case "raise":
        return this.changePriority(element, raisePriority(element.priority));
      case "lower":
        return this.changePriority(element, lowerPriority(element.priority));
      case "markDone":
        return this.markDone(element, options);
      case "dismiss":
        return this.setStatus(element, "dismissed");
      case "delete":
        return this.softDelete(element);
    }
  }

  private markDone(element: Element, options: QueueActionOptions): QueueActionResult {
    if (element.type === "source" && !options.confirmUnresolvedBlocks) {
      const gate = this.blockProcessing.getDoneGate(element.id);
      if (!gate.canMarkDone) {
        throw new Error(
          `QueueActionService.markDone: source has ${gate.unresolvedBlocks} unresolved block(s)`,
        );
      }
    }
    return this.setStatus(element, "done");
  }

  /**
   * Postpone a due row. The two schedulers stay separate: a CARD defers its FSRS
   * `review_states.due_at` forward (a thin M5 defer — full FSRS grading is M7); any
   * other (attention) item reschedules further out on the attention scheduler. The
   * row remains in the system (not removed) but recedes from the due set.
   *
   * `batchId` (when set) is recorded in the `reschedule_element` op payload so a
   * BULK postpone's rows undo as one batch (T044).
   */
  private postpone(element: Element, now: IsoTimestamp, batchId?: string): QueueActionResult {
    if (element.type === "card") {
      const deferred = this.cardDeferBy(element.id, now, CARD_DEFER_DAYS, batchId);
      return { element: deferred, removed: false, undo: null };
    }
    const { element: rescheduled } = this.scheduler.rescheduleForAction(
      element.id,
      "postpone",
      now,
      batchId,
    );
    return { element: rescheduled, removed: false, undo: null };
  }

  /**
   * Postpone MANY due rows as ONE undoable bulk action (T044). Every row's
   * `reschedule_element` op shares a freshly-minted `batchId`, so the general
   * command-level undo (`UndoService.undoLast`) reverses the WHOLE batch in one
   * call (each row's prior `dueAt`/`status` was captured in its op pre-image). Each
   * row still postpones through the SAME per-row path (the two schedulers stay
   * separate); a missing/deleted id is skipped. Returns the post-action elements +
   * the shared `batchId`.
   */
  bulkPostpone(
    ids: readonly ElementId[],
    now: IsoTimestamp = nowIso(),
  ): { readonly elements: Element[]; readonly batchId: string } {
    const batchId = newRowId();
    const results: Element[] = [];
    for (const id of ids) {
      const element = this.elements.findById(id);
      if (!element || element.deletedAt) continue;
      results.push(this.postpone(element, now, batchId).element);
    }
    return { elements: results, batchId };
  }

  /**
   * RELATIVE FSRS defer: push a card's `review_states.due_at` (+ the element's `dueAt`)
   * forward by `days` (default {@link CARD_DEFER_DAYS}), in ONE transaction, logging
   * `reschedule_element` (the existing op). `nextDue = max(prevReviewDueAt, now) + days`.
   * The card's element STATUS is preserved (cards live in active/pending/suspended, never
   * the attention-side `scheduled`); FSRS memory state is left UNTOUCHED and NO review log
   * is written (a postpone is not a graded review).
   *
   * Generalized from the M5 single-day thin defer so T077's auto-postpone can push a mature
   * card out by N days. The single-day callers (`postpone`/`bulkPostpone`) are unaffected
   * (default arg). Public so a separate `AutoPostponeService` can call it without a
   * visibility wall (the spec's option (a) — a shared, exported card-defer helper).
   *
   * TODO(T036/M7): full FSRS grade-driven rescheduling lives in `review.grade`; this defer
   * is the deliberate NON-graded "postpone a card" path used by the queue + overload tools.
   */
  cardDeferBy(
    id: ElementId,
    now: IsoTimestamp = nowIso(),
    days: number = CARD_DEFER_DAYS,
    batchId?: string,
  ): Element {
    const prevReviewDueAt = reviewDueOf(this.review, id);
    const base = prevReviewDueAt ? Date.parse(prevReviewDueAt) : Date.parse(now);
    const from = Number.isNaN(base) ? Date.parse(now) : Math.max(base, Date.parse(now));
    const nextDue = new Date(from + days * DAY_MS).toISOString() as IsoTimestamp;
    return this.db.transaction((tx) =>
      cardDeferWithin(tx, this.elements, id, nextDue, prevReviewDueAt, batchId),
    );
  }

  /**
   * ABSOLUTE FSRS defer: set a card's `review_states.due_at` (+ the element's `dueAt`) to the
   * EXACT `targetDueAt` (a specific calendar day), in ONE transaction, with the SAME op shape
   * + pre-image + status-preservation + no-review-log guarantees as {@link cardDeferBy}. T078
   * catch-up uses this so each card lands on its precise planned day (a relative delta would
   * mis-place a card whose `prevDue` is already overdue, breaking the per-day load curve).
   * Public for the same reason as {@link cardDeferBy}.
   */
  cardDeferTo(
    id: ElementId,
    _now: IsoTimestamp,
    targetDueAt: IsoTimestamp,
    batchId?: string,
  ): Element {
    const prevReviewDueAt = reviewDueOf(this.review, id);
    return this.db.transaction((tx) =>
      cardDeferWithin(tx, this.elements, id, targetDueAt, prevReviewDueAt, batchId),
    );
  }

  /**
   * Raise / lower priority — the universal write path (T027 band helpers +
   * {@link ElementRepository.setPriority}, `update_element`). The row stays in the
   * list; its `Prio` badge changes in place (and the queue may re-sort). Priority is
   * first-class on EVERY element type, so this works for a card as well as an
   * attention item.
   */
  private changePriority(element: Element, next: Priority): QueueActionResult {
    const updated = this.elements.setPriority(element.id, next);
    return { element: updated, removed: false, undo: null };
  }

  /**
   * Mark done / dismiss — set the lifecycle status (`update_element`). The row
   * LEAVES the due list; the undo snackbar re-sets the PRIOR status. Lineage, body,
   * and anchors are untouched.
   */
  private setStatus(element: Element, status: ElementStatus): QueueActionResult {
    const updated = this.elements.update(element.id, { status });
    return {
      element: updated,
      removed: true,
      undo: { kind: "status", previousStatus: element.status },
    };
  }

  /**
   * SOFT-delete a row (`soft_delete_element`): `deletedAt` + status `deleted`, never
   * a hard DELETE — user data is never destroyed. The row leaves the list; the undo
   * snackbar restores it via {@link ElementRepository.restore} to its prior status.
   */
  private softDelete(element: Element): QueueActionResult {
    const deleted = this.elements.softDelete(element.id);
    return {
      element: deleted,
      removed: true,
      undo: { kind: "restore", previousStatus: element.status },
    };
  }

  /**
   * Undo a removing action: for a soft delete, restore the element to its prior
   * status (`restore_element`); for done/dismiss, re-set the prior status
   * (`update_element`). The renderer drives this from the snackbar's "Undo".
   */
  undo(id: ElementId, undo: QueueActionUndo): Element {
    if (undo.kind === "restore") {
      return this.elements.restore(id, undo.previousStatus);
    }
    return this.elements.update(id, { status: undo.previousStatus });
  }
}
