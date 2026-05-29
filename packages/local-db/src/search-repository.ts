/**
 * SearchRepository (T008) — local lookup over titles + document bodies.
 *
 * FTS5 tables (`source_fts`, `extract_fts`, `card_fts`) arrive with the search
 * milestone later; the M1 surface is a simple, correct substring scan over live
 * `elements.title` and the flattened `documents.plainText` mirror, so the search
 * screen and the command palette have a real (if unranked) backend now. It is
 * read-only and excludes soft-deleted elements. When FTS5 lands this repository
 * keeps the same method surface but swaps the implementation.
 */

import type { Element, ElementType } from "@interleave/core";
import { documents, elements, type InterleaveDatabase } from "@interleave/db";
import { and, eq, isNull, like } from "drizzle-orm";
import { rowToElement } from "./mappers";

/** Options narrowing a search. */
export interface SearchOptions {
  /** Restrict to a single element type. */
  readonly type?: ElementType;
  readonly limit?: number;
}

export class SearchRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Find live elements whose title OR document body contains `query`
   * (case-insensitive substring). Returns deduplicated elements.
   */
  query(query: string, options: SearchOptions = {}): Element[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const pattern = `%${trimmed}%`;

    const matched = new Map<string, Element>();

    // Title matches.
    const titleCondition = options.type
      ? and(
          like(elements.title, pattern),
          eq(elements.type, options.type),
          isNull(elements.deletedAt),
        )
      : and(like(elements.title, pattern), isNull(elements.deletedAt));
    for (const row of this.db.select().from(elements).where(titleCondition).all()) {
      matched.set(row.id, rowToElement(row));
    }

    // Body matches (join document plain-text mirror to its owning element).
    const bodyBase = this.db
      .select({ element: elements })
      .from(documents)
      .innerJoin(elements, eq(elements.id, documents.elementId))
      .where(
        options.type
          ? and(
              like(documents.plainText, pattern),
              eq(elements.type, options.type),
              isNull(elements.deletedAt),
            )
          : and(like(documents.plainText, pattern), isNull(elements.deletedAt)),
      );
    for (const row of bodyBase.all()) {
      matched.set(row.element.id, rowToElement(row.element));
    }

    const results = [...matched.values()];
    return options.limit === undefined ? results : results.slice(0, options.limit);
  }

  /** Title-only prefix-ish lookup used by the command palette (fast path). */
  byTitle(query: string, limit = 20): Element[] {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const pattern = `%${trimmed}%`;
    return this.db
      .select()
      .from(elements)
      .where(and(like(elements.title, pattern), isNull(elements.deletedAt)))
      .limit(limit)
      .all()
      .map(rowToElement);
  }
}
