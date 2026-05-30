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
import { isLeech } from "@interleave/scheduler";
import { desc, eq } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { newReviewLogId, nowIso } from "./ids";
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
   *
   * **Leech detection (T040):** after advancing the FSRS state, the new cumulative
   * `lapses` is consulted via the single leech rule (`@interleave/scheduler`'s
   * {@link isLeech} — "warn at 4 lapses"). When the card CROSSES the threshold and
   * is not already flagged, the durable `cards.is_leech` flag is set in the SAME
   * transaction and the leech-flag change is logged as `update_element` (no new op
   * type — the closed 15-op set is unchanged). Leech is flag + warn only — it never
   * suspends or reschedules here (the two-scheduler split: FSRS owns the schedule,
   * the leech flag is a quality attribute). Once flagged, the flag persists until a
   * user un-leeches it after remediation.
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

      // Leech detection (T040): if this grade pushed the card over the lapse
      // threshold and it is not already flagged, set the durable leech flag + log
      // `update_element` — all inside this same review transaction.
      if (isLeech({ lapses: outcome.lapses })) {
        const cardRow = tx
          .select({ isLeech: cards.isLeech })
          .from(cards)
          .where(eq(cards.elementId, cardElementId))
          .get();
        if (cardRow && !cardRow.isLeech) {
          tx.update(cards).set({ isLeech: true }).where(eq(cards.elementId, cardElementId)).run();
          new OperationLogRepository(tx).append(tx, {
            opType: "update_element",
            elementId: cardElementId,
            payload: { id: cardElementId, isLeech: true, lapses: outcome.lapses },
          });
        }
      }

      const log = tx.select().from(reviewLogs).where(eq(reviewLogs.id, id)).get();
      if (!log) throw new Error("ReviewRepository.recordReview: log row missing after insert");
      return rowToReviewLog(log);
    });
  }

  /**
   * Whether a card is currently flagged a leech (T040) — reads the durable
   * `cards.is_leech` flag. Read-only; the cleanup view + the review face use it.
   */
  isCardLeech(cardElementId: ElementId): boolean {
    const row = this.db
      .select({ isLeech: cards.isLeech })
      .from(cards)
      .where(eq(cards.elementId, cardElementId))
      .get();
    return row?.isLeech ?? false;
  }

  /**
   * All live leech cards (T040) — the cleanup view's read. Joins `cards`
   * (`is_leech = 1`) to live (non-deleted) `card` elements + their `review_states`
   * lapse count, most-lapsed first. Suspended cards are INCLUDED (the cleanup view
   * is where a user un-suspends/rewrites them); soft-deleted cards are excluded.
   * Read-only — no mutation, no `operation_log`.
   */
  listLeechCards(): LeechCard[] {
    const rows = this.db
      .select({
        element: elements,
        card: cards,
        lapses: reviewStates.lapses,
        reps: reviewStates.reps,
        lastReviewedAt: reviewStates.lastReviewedAt,
      })
      .from(cards)
      .innerJoin(elements, eq(elements.id, cards.elementId))
      .leftJoin(reviewStates, eq(reviewStates.elementId, cards.elementId))
      .where(eq(cards.isLeech, true))
      .all()
      .filter((r) => r.element.deletedAt == null)
      .map((r) => ({
        element: rowToElement(r.element),
        card: r.card,
        lapses: r.lapses ?? 0,
        reps: r.reps ?? 0,
        lastReviewedAt: r.lastReviewedAt ?? null,
      }));
    // Most-lapsed first (then most-recently reviewed) so the worst offenders lead.
    rows.sort((a, b) => b.lapses - a.lapses);
    return rows;
  }

  /**
   * Set / clear a card's durable leech flag (T040) in ONE transaction, logging
   * `update_element` (no new op type). Used by the manual "Mark leech" button and
   * to UN-leech a remediated card. Idempotent: setting the flag to its current
   * value is still logged (the op-log records the user's intent). Returns the card
   * element + its `cards` row after the change.
   */
  setCardLeech(cardElementId: ElementId, leech: boolean): CardWithElement {
    return this.db.transaction((tx) => {
      tx.update(cards).set({ isLeech: leech }).where(eq(cards.elementId, cardElementId)).run();
      const updatedAt = nowIso();
      tx.update(elements).set({ updatedAt }).where(eq(elements.id, cardElementId)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: cardElementId,
        payload: { id: cardElementId, isLeech: leech },
      });
      const card = tx.select().from(cards).where(eq(cards.elementId, cardElementId)).get();
      const elementRow = tx.select().from(elements).where(eq(elements.id, cardElementId)).get();
      if (!card || !elementRow) {
        throw new Error(
          `ReviewRepository.setCardLeech: card ${cardElementId} missing after update`,
        );
      }
      return { element: rowToElement(elementRow), card };
    });
  }
}

/** A leech card row for the cleanup view: the element, its body, + lapse signals. */
export interface LeechCard {
  readonly element: Element;
  readonly card: CardRow;
  /** Cumulative FSRS lapses (failed reviews) — the leech's severity. */
  readonly lapses: number;
  readonly reps: number;
  readonly lastReviewedAt: IsoTimestamp | null;
}
