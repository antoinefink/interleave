/**
 * ReviewRepository (T008) — cards + FSRS review state/logs.
 *
 * FSRS scheduling applies to CARDS ONLY (a load-bearing invariant: cards answer
 * "can the user recall this?"; sources/topics/extracts use the separate
 * attention scheduler). Creating a card is a multi-table mutation: an `elements`
 * row (type `card`), its `cards` side-table row (with the `sourceLocationId` that
 * keeps the `card → source location → source` lineage), and a fresh
 * `review_states` row — all in one transaction with a `create_card` op.
 *
 * Recording a review appends an immutable `review_logs` row AND updates the
 * card's `review_states` in the same transaction, logging `add_review_log`.
 * Review logs are append-only — corrections are new rows, never in-place edits —
 * so sessions are repairable and FSRS parameters can later be optimized.
 */

import type {
  CardKind,
  DistillationStage,
  Element,
  ElementId,
  FsrsState,
  IsoTimestamp,
  Priority,
  ReviewLog,
  ReviewRating,
  ReviewState,
  SourceLocationId,
} from "@interleave/core";
import {
  type CardRow,
  cards,
  elements,
  type InterleaveDatabase,
  reviewLogs,
  reviewStates,
} from "@interleave/db";
import { desc, eq } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { newReviewLogId } from "./ids";
import { rowToElement, rowToReviewLog, rowToReviewState } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/** Arguments to create a card (Q&A or cloze). */
export interface CreateCardInput {
  readonly kind: CardKind;
  readonly title: string;
  readonly priority: Priority;
  readonly stage?: DistillationStage;
  readonly prompt?: string | null;
  readonly answer?: string | null;
  readonly cloze?: string | null;
  /** Origin element (the extract this card was distilled from). */
  readonly parentId?: ElementId | null;
  /** Lineage root (owning source). */
  readonly sourceId?: ElementId | null;
  /** Anchor to the exact source position the card derives from. */
  readonly sourceLocationId?: SourceLocationId | null;
}

/** A card element + its `cards` side-table row. */
export interface CardWithElement {
  readonly element: Element;
  readonly card: CardRow;
}

/** The full FSRS state assigned by a review (computed by the scheduler upstream). */
export interface ReviewOutcome {
  readonly rating: ReviewRating;
  readonly reviewedAt: IsoTimestamp;
  readonly responseMs: number;
  readonly prevState: FsrsState;
  readonly nextState: FsrsState;
  readonly nextStability: number;
  readonly nextDifficulty: number;
  readonly nextDueAt: IsoTimestamp;
  /** Updated cumulative counters from the scheduler. */
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  readonly reps: number;
  readonly lapses: number;
}

export class ReviewRepository {
  private readonly elementsRepo: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elementsRepo = new ElementRepository(db);
  }

  /**
   * Create a card element + its `cards` row + a fresh `review_states` row,
   * atomically, logging `create_card`. The card starts in FSRS state `new`.
   */
  createCard(input: CreateCardInput): CardWithElement {
    return this.db.transaction((tx) => this.createCardWithin(tx, input));
  }

  /**
   * Create a card using an EXISTING transaction — the tx-composable seam
   * {@link CardService} (T032) uses to author a card from an extract in ONE outer
   * `db.transaction` (card creation + sibling grouping + tag inheritance all
   * commit together). Mirrors {@link ElementRepository.createWithin} /
   * {@link SourceRepository.createExtractWithin}: it inserts the `elements` row
   * (via `createWithin`, logging `create_element`), the `cards` side-table row,
   * and a FRESH `review_states` row, then logs `create_card` on the SAME `tx`, so
   * a throw anywhere downstream rolls the whole card back (no orphan
   * element/card/review-state row).
   *
   * **Two-scheduler split (load-bearing):** the `review_states` row is created
   * but left UN-DUE — `dueAt` defaults to `null` and `fsrsState` to `"new"`. M6
   * authors the card and initializes its FSRS state; it does NO FSRS math. The
   * first FSRS schedule + the `card_draft → active_card` transition are M7 (T036).
   */
  createCardWithin(tx: DbClient, input: CreateCardInput): CardWithElement {
    const element = this.elementsRepo.createWithin(tx, {
      type: "card",
      status: "pending",
      stage: input.stage ?? "card_draft",
      priority: input.priority,
      title: input.title,
      parentId: input.parentId ?? null,
      sourceId: input.sourceId ?? null,
    });
    tx.insert(cards)
      .values({
        elementId: element.id,
        kind: input.kind,
        prompt: input.prompt ?? null,
        answer: input.answer ?? null,
        cloze: input.cloze ?? null,
        sourceLocationId: input.sourceLocationId ?? null,
      })
      .run();
    // The review_states row is created but NOT due (dueAt null, fsrsState "new"):
    // a card_draft card is authored, not yet in FSRS rotation (M7 first-schedules it).
    tx.insert(reviewStates).values({ elementId: element.id, fsrsState: "new" }).run();

    new OperationLogRepository(tx).append(tx, {
      opType: "create_card",
      elementId: element.id,
      payload: {
        cardId: element.id,
        kind: input.kind,
        sourceLocationId: input.sourceLocationId ?? null,
      },
    });

    const card = tx.select().from(cards).where(eq(cards.elementId, element.id)).get();
    if (!card) throw new Error("ReviewRepository.createCard: card row missing after insert");
    return { element, card };
  }

  /** Read a card (element + card row) by element id, or `null`. */
  findCardById(elementId: ElementId): CardWithElement | null {
    const elementRow = this.db.select().from(elements).where(eq(elements.id, elementId)).get();
    const card = this.db.select().from(cards).where(eq(cards.elementId, elementId)).get();
    if (!elementRow || !card) return null;
    return { element: rowToElement(elementRow), card };
  }

  /** Read the FSRS state for a card, or `null`. */
  findReviewState(elementId: ElementId): ReviewState | null {
    const row = this.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, elementId))
      .get();
    return row ? rowToReviewState(row) : null;
  }

  /** All review logs for a card, newest first. */
  listReviewLogs(elementId: ElementId): ReviewLog[] {
    return this.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, elementId))
      .orderBy(desc(reviewLogs.reviewedAt))
      .all()
      .map(rowToReviewLog);
  }

  /**
   * Record one review: append an immutable `review_logs` row AND update the
   * card's `review_states`, atomically, logging `add_review_log`. The element's
   * `dueAt` is also advanced to the next due time so the queue picks it up.
   */
  recordReview(cardElementId: ElementId, outcome: ReviewOutcome): ReviewLog {
    return this.db.transaction((tx) => {
      const id = newReviewLogId();
      tx.insert(reviewLogs)
        .values({
          id,
          elementId: cardElementId,
          rating: outcome.rating,
          reviewedAt: outcome.reviewedAt,
          responseMs: outcome.responseMs,
          prevState: outcome.prevState,
          nextState: outcome.nextState,
          nextStability: outcome.nextStability,
          nextDifficulty: outcome.nextDifficulty,
          nextDueAt: outcome.nextDueAt,
        })
        .run();

      tx.update(reviewStates)
        .set({
          dueAt: outcome.nextDueAt,
          stability: outcome.nextStability,
          difficulty: outcome.nextDifficulty,
          elapsedDays: outcome.elapsedDays,
          scheduledDays: outcome.scheduledDays,
          reps: outcome.reps,
          lapses: outcome.lapses,
          fsrsState: outcome.nextState,
          lastReviewedAt: outcome.reviewedAt,
        })
        .where(eq(reviewStates.elementId, cardElementId))
        .run();

      tx.update(elements)
        .set({ dueAt: outcome.nextDueAt, updatedAt: outcome.reviewedAt })
        .where(eq(elements.id, cardElementId))
        .run();

      new OperationLogRepository(tx).append(tx, {
        opType: "add_review_log",
        elementId: cardElementId,
        payload: { reviewLogId: id, rating: outcome.rating, nextDueAt: outcome.nextDueAt },
      });

      const log = tx.select().from(reviewLogs).where(eq(reviewLogs.id, id)).get();
      if (!log) throw new Error("ReviewRepository.recordReview: log row missing after insert");
      return rowToReviewLog(log);
    });
  }
}
