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
 * Soft-deleted elements are excluded from every query.
 */

import type { Element, ElementId, ElementType, IsoTimestamp } from "@interleave/core";
import { elements, type InterleaveDatabase, reviewStates } from "@interleave/db";
import { and, asc, eq, isNotNull, isNull, lte, ne } from "drizzle-orm";
import { rowToElement } from "./mappers";

export class QueueRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Cards due for FSRS review at or before `asOf`, soonest first. Joins
   * `review_states` (the FSRS due time) to live, non-suspended `card` elements.
   */
  dueCards(asOf: IsoTimestamp, limit?: number): Element[] {
    const base = this.db
      .select({ element: elements })
      .from(reviewStates)
      .innerJoin(elements, eq(elements.id, reviewStates.elementId))
      .where(
        and(
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          ne(elements.status, "suspended"),
          isNotNull(reviewStates.dueAt),
          lte(reviewStates.dueAt, asOf),
        ),
      )
      .orderBy(asc(reviewStates.dueAt));
    const rows = limit === undefined ? base.all() : base.limit(limit).all();
    return rows.map((r) => rowToElement(r.element));
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
          ne(elements.type, "card"),
          isNull(elements.deletedAt),
          ne(elements.status, "suspended"),
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

  /** Count of cards due at or before `asOf` (cheap badge query). */
  dueCardCount(asOf: IsoTimestamp): number {
    return this.dueCards(asOf).length;
  }

  /** The single next due card (soonest FSRS due time), or `null`. */
  nextCard(asOf: IsoTimestamp, exclude: readonly ElementId[] = []): Element | null {
    const due = this.dueCards(asOf);
    const excluded = new Set<string>(exclude);
    return due.find((card) => !excluded.has(card.id)) ?? null;
  }
}
