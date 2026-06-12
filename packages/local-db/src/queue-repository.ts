/**
 * QueueRepository (T008) — the read side of the daily queue.
 *
 * The queue answers two DIFFERENT questions with two different schedulers, and
 * this repository keeps them separate (a load-bearing invariant): cards are due
 * by their FSRS `review_states.due_at` ("can the user recall this?"), while
 * sources/topics/extracts are due by `elements.due_at` from the attention
 * scheduler ("should the user process this again, and when?"). It is read-only —
 * grading/rescheduling mutations live in {@link ReviewRepository} and
 * {@link ElementRepository}. The real scheduling math lands later (T028/T036);
 * here we expose the due-now reads the queue UI needs.
 *
 * Soft-deleted elements are excluded from every query, and the two DUE reads
 * additionally exclude rows whose lifecycle status has taken them out of the queue
 * (`done` / `parked` / `dismissed` / `suspended` / `deleted`) — see
 * {@link QUEUE_EXCLUDED_STATUSES}
 * — plus RETIRED cards (T082, the `cards.is_retired` flag, via a `cards` join).
 */

import type {
  Element,
  ElementId,
  ElementStatus,
  ElementType,
  IsoTimestamp,
  ReviewState,
} from "@interleave/core";
import { cards, elements, type InterleaveDatabase, reviewStates } from "@interleave/db";
import {
  and,
  asc,
  eq,
  gte,
  isNotNull,
  isNull,
  lte,
  notInArray,
  count as sqlCount,
} from "drizzle-orm";
import { rowToElement, rowToReviewState } from "./mappers";

/**
 * Lifecycle statuses that take a row OUT of the due queue, regardless of its
 * `due_at`. A `done`/`parked`/`dismissed`/`suspended`/`deleted` row is no longer due —
 * excluding them here is what lets a queue action (T030) actually remove the row
 * from the list: `markDone`/`dismiss` flip the status (leaving `due_at` in the
 * past), so without this filter the row would still satisfy `due_at <= asOf` and
 * reappear on the next read. (`deleted` is redundant with the `deletedAt` guard
 * but listed for intent.)
 */
export const QUEUE_EXCLUDED_STATUSES: readonly ElementStatus[] = [
  "done",
  "parked",
  "dismissed",
  "suspended",
  "deleted",
];

/** True when the lifecycle status can still put an element into today's work queue. */
export function isQueueActionableStatus(status: ElementStatus): boolean {
  return !QUEUE_EXCLUDED_STATUSES.includes(status);
}

export class QueueRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Cards due for FSRS review at or before `asOf`, soonest first. Joins
   * `review_states` (the FSRS due time) to live, non-suspended `card` elements,
   * and additionally joins `cards` to drop RETIRED cards (T082).
   *
   * Retirement is a DIFFERENT mechanism from the suspended exclusion: suspended
   * filters on `elements.status` (in {@link QUEUE_EXCLUDED_STATUSES}), but
   * `is_retired` is a flag on the `cards` side-table — so dropping a retired card
   * needs an explicit `innerJoin(cards)` + `cards.is_retired = false` predicate, not
   * another status. The review deck + the due counts read through here, so a retired
   * card disappears from review automatically. (The attention reads are untouched —
   * retirement is a card-only concern.)
   */
  dueCards(asOf: IsoTimestamp, limit?: number): Element[] {
    const base = this.db
      .select({ element: elements })
      .from(reviewStates)
      .innerJoin(elements, eq(elements.id, reviewStates.elementId))
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        and(
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          notInArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          eq(cards.isRetired, false),
          isNotNull(reviewStates.dueAt),
          lte(reviewStates.dueAt, asOf),
        ),
      )
      .orderBy(asc(reviewStates.dueAt));
    const rows = limit === undefined ? base.all() : base.limit(limit).all();
    return rows.map((r) => rowToElement(r.element));
  }

  /**
   * Due cards WITH their FSRS `review_states` row, in ONE join (T100). The queue
   * decorator needs each due card's review state (for the retrievability the score
   * reads); returning it from the SAME join that already touches `review_states`
   * avoids a separate whole-table `reviewStateMap()` scan AND a per-row
   * `findReviewState` (the N+1). Same filter/order as {@link dueCards}.
   */
  dueCardsWithState(asOf: IsoTimestamp): {
    element: Element;
    state: ReviewState;
    card: { kind: string; mediaRef: string | null };
  }[] {
    const rows = this.db
      .select({
        element: elements,
        state: reviewStates,
        card: {
          kind: cards.kind,
          mediaRef: cards.mediaRef,
        },
      })
      .from(reviewStates)
      .innerJoin(elements, eq(elements.id, reviewStates.elementId))
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        and(
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          notInArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          eq(cards.isRetired, false),
          isNotNull(reviewStates.dueAt),
          lte(reviewStates.dueAt, asOf),
        ),
      )
      .orderBy(asc(reviewStates.dueAt))
      .all();
    return rows.map((r) => ({
      element: rowToElement(r.element),
      state: rowToReviewState(r.state),
      card: r.card,
    }));
  }

  /**
   * Sources/topics/extracts due for re-processing at or before `asOf` (attention
   * scheduler), soonest first. Excludes cards (those use {@link dueCards}).
   */
  dueAttentionItems(asOf: IsoTimestamp, limit?: number): Element[] {
    const base = this.db
      .select()
      .from(elements)
      .where(
        and(
          notInArray(elements.type, ["card"]),
          isNull(elements.deletedAt),
          notInArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          isNotNull(elements.dueAt),
          lte(elements.dueAt, asOf),
        ),
      )
      .orderBy(asc(elements.dueAt));
    const rows = limit === undefined ? base.all() : base.limit(limit).all();
    return rows.map(rowToElement);
  }

  /** Live elements of a type currently in the inbox (status `inbox`), newest first. */
  inbox(type?: ElementType, limit?: number): Element[] {
    const condition = type
      ? and(eq(elements.status, "inbox"), eq(elements.type, type), isNull(elements.deletedAt))
      : and(eq(elements.status, "inbox"), isNull(elements.deletedAt));
    const base = this.db.select().from(elements).where(condition).orderBy(asc(elements.createdAt));
    const rows = limit === undefined ? base.all() : base.limit(limit).all();
    return rows.map(rowToElement);
  }

  /** Count live elements of a type currently in the inbox; same filter as {@link inbox}. */
  inboxCount(type?: ElementType): number {
    const condition = type
      ? and(eq(elements.status, "inbox"), eq(elements.type, type), isNull(elements.deletedAt))
      : and(eq(elements.status, "inbox"), isNull(elements.deletedAt));
    return this.db.select({ n: sqlCount() }).from(elements).where(condition).get()?.n ?? 0;
  }

  /**
   * Count of cards due at or before `asOf` — a cheap SQL `COUNT(*)` (T100). Previously
   * `this.dueCards(asOf).length` materialized + `rowToElement`-mapped every due row
   * just to count them; at 100k that is tens of thousands of wasted allocations on the
   * analytics path. Same filter as {@link dueCards} (live, non-excluded, non-retired).
   */
  dueCardCount(asOf: IsoTimestamp): number {
    const row = this.db
      .select({ n: sqlCount() })
      .from(reviewStates)
      .innerJoin(elements, eq(elements.id, reviewStates.elementId))
      .innerJoin(cards, eq(cards.elementId, elements.id))
      .where(
        and(
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          notInArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          eq(cards.isRetired, false),
          isNotNull(reviewStates.dueAt),
          lte(reviewStates.dueAt, asOf),
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  /**
   * Count of attention items (sources/topics/extracts) due at or before `asOf` — the
   * cheap SQL `COUNT(*)` counterpart of {@link dueAttentionItems} (T100), same filter.
   */
  dueAttentionCount(asOf: IsoTimestamp): number {
    const row = this.db
      .select({ n: sqlCount() })
      .from(elements)
      .where(
        and(
          notInArray(elements.type, ["card"]),
          isNull(elements.deletedAt),
          notInArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
          isNotNull(elements.dueAt),
          lte(elements.dueAt, asOf),
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  /**
   * Cards whose FSRS `review_states.due_at` falls within `[from, to]` — the
   * FORWARD-looking "reviews due this week" count (T046). Unlike {@link dueCards}
   * (which counts only what is due NOW, `due_at <= asOf`), this counts upcoming
   * reviews in a window, so the balance banner can say "K reviews due this week".
   * Excludes soft-deleted / done / dismissed / suspended / retired cards (same
   * queue filter as {@link dueCards}, including the T082 `cards.is_retired` join).
   */
  dueCardsBetween(from: IsoTimestamp, to: IsoTimestamp): number {
    return (
      this.db
        .select({ n: sqlCount() })
        .from(reviewStates)
        .innerJoin(elements, eq(elements.id, reviewStates.elementId))
        .innerJoin(cards, eq(cards.elementId, elements.id))
        .where(
          and(
            eq(elements.type, "card"),
            isNull(elements.deletedAt),
            notInArray(elements.status, QUEUE_EXCLUDED_STATUSES as ElementStatus[]),
            eq(cards.isRetired, false),
            isNotNull(reviewStates.dueAt),
            gte(reviewStates.dueAt, from),
            lte(reviewStates.dueAt, to),
          ),
        )
        .get()?.n ?? 0
    );
  }

  /** The single next due card (soonest FSRS due time), or `null`. */
  nextCard(asOf: IsoTimestamp, exclude: readonly ElementId[] = []): Element | null {
    const due = this.dueCards(asOf);
    const excluded = new Set<string>(exclude);
    return due.find((card) => !excluded.has(card.id)) ?? null;
  }
}
