/**
 * LibraryQuery (Library route) — the facet-driven "browse everything" read.
 *
 * The Library surface is DISTINCT from search (`SearchRepository`): search is
 * keyword-driven over the FTS5 index and returns `[]` for an empty query (and
 * only covers source/extract/card). Library DEFAULTS to listing ALL live
 * elements and narrows by FACETS (type / concept / priority / status) — no
 * keyword required — and covers the element types that have no FTS index
 * (topic / synthesis_note / task) which keyword search can never return.
 *
 * This is a READ-ONLY query layer (it appends nothing to the operation log),
 * constructed once per open database alongside {@link Repositories} (the same
 * pattern as {@link QueueQuery} / {@link InspectorQuery}). It composes the
 * existing repositories — the live `elements` read narrowed by
 * type/status/priority + the `concept_membership` join via
 * {@link ConceptRepository.elementsForConcept} — and returns plain element ids
 * (ordered priority desc, then `updated_at` desc, capped by `limit`) plus the
 * unfiltered per-facet counts. The DB service enriches each id with the SAME
 * scheduler/due/concept/refblock fields the search/queue rows carry (no
 * duplicated scheduling math). The renderer never issues SQL.
 */

import {
  type Element,
  type ElementId,
  type ElementStatus,
  type ElementType,
  priorityToLabel,
} from "@interleave/core";
import { elements, type InterleaveDatabase } from "@interleave/db";
import { and, inArray, isNull } from "drizzle-orm";
import type { Repositories } from "./index";
import { rowToElement } from "./mappers";

/** The four coarse priority labels the facet column exposes. */
export type LibraryPriorityLabel = "A" | "B" | "C" | "D";

/**
 * The six BROWSABLE element types — every distillation type EXCEPT `concept`
 * (concepts are a FACET column, not a browsed row) and `media_fragment` (not yet
 * a first-class browse row in the MVP; it has no reader target). Kept in display
 * order so the grouped result sections render deterministically.
 */
export const LIBRARY_TYPES: readonly ElementType[] = [
  "source",
  "extract",
  "card",
  "topic",
  "synthesis_note",
  "task",
] as const;
const LIBRARY_TYPE_SET = new Set<ElementType>(LIBRARY_TYPES);

/** The statuses the facet column exposes (live, non-deleted lifecycle states). */
export const LIBRARY_STATUSES: readonly ElementStatus[] = [
  "active",
  "scheduled",
  "inbox",
  "pending",
  "done",
  "parked",
  "suspended",
] as const;

/** Default cap so a broad browse can't return an unbounded list. */
const DEFAULT_LIMIT = 200;

/** The facet filters a browse accepts. All optional; absent = no narrowing. */
export interface LibraryBrowseFilters {
  /** Keep only these element types (from {@link LIBRARY_TYPES}). */
  readonly types?: readonly ElementType[];
  /** Keep only members of this concept (`concept_membership` edge). */
  readonly conceptId?: ElementId;
  /** Keep only elements whose priority maps to this A/B/C/D band. */
  readonly priorityLabel?: LibraryPriorityLabel;
  /** Keep only these lifecycle statuses. */
  readonly statuses?: readonly ElementStatus[];
  /** Cap the result count (defaults to {@link DEFAULT_LIMIT}). */
  readonly limit?: number;
}

/**
 * DRILL-DOWN faceted counts. Each dimension's counts respect ALL OTHER currently
 * active filters but NOT its own selected value — so the number next to any facet
 * value V equals the number of result rows you get if V is selected TOGETHER with
 * the other already-active filters. (Previously these were over the unfiltered
 * universe, which made a chip count never match the filtered list — the reported
 * bug.) `all` is the count matching ALL active filters (= the rows shown, before
 * the optional client-side title narrow).
 */
export interface LibraryBrowseCounts {
  /**
   * Count of the rows ACTUALLY shown — i.e. matching ALL active filters AND capped by
   * `limit`. This is exactly `items.length` (before the optional client-side title
   * narrow), so the top "N elements" label can NEVER exceed the rendered list even when
   * the match set is larger than the cap. The per-facet `byType`/`byConcept`/`byPriority`/
   * `byStatus` counts are pre-limit (drill-down: count == rows-if-V-selected); only this
   * top-line total tracks the rendered list.
   */
  readonly all: number;
  /** Per browsable type, ignoring the active type filter (but honouring the rest). */
  readonly byType: Readonly<Record<ElementType, number>>;
  /** Per concept (keyed by concept element id), ignoring the active concept filter. */
  readonly byConcept: Readonly<Record<string, number>>;
  /** Per priority band A/B/C/D, ignoring the active priority filter. */
  readonly byPriority: Readonly<Record<LibraryPriorityLabel, number>>;
  /** Per lifecycle status, ignoring the active status filter. */
  readonly byStatus: Readonly<Record<string, number>>;
}

/** The browse read: the ordered live element rows + the per-facet counts. */
export interface LibraryBrowseData {
  /** The narrowed, ordered (priority desc, updated_at desc), capped rows. */
  readonly items: readonly Element[];
  readonly counts: LibraryBrowseCounts;
}

/**
 * Read-only library browse query layer. Constructed once per open database
 * (alongside {@link Repositories}); the main process exposes it over validated IPC.
 */
export class LibraryQuery {
  constructor(
    private readonly db: InterleaveDatabase,
    private readonly repos: Repositories,
  ) {}

  /**
   * The facet-driven browse-all read. Reads the live browsable universe (every
   * non-deleted element of a {@link LIBRARY_TYPES} type), narrows by the
   * type/status/priority/concept facets, orders by **priority desc then
   * `updated_at` desc**, caps by `limit`, and computes DRILL-DOWN faceted counts
   * (each dimension respects every OTHER active filter but not its own value — see
   * {@link LibraryBrowseCounts}). With NO filters it returns everything
   * (newest/priority-ranked) — the browse-first default that distinguishes Library
   * from keyword search.
   *
   * Performance: a single in-memory pass over the universe to match, plus one read
   * of the live `concept_membership` edges (the shared
   * {@link ConceptRepository.liveMembershipMap} — built ONCE, never per-concept), so
   * concept matching/counting never becomes an N+1 over concepts.
   */
  browse(filters: LibraryBrowseFilters = {}): LibraryBrowseData {
    // The live browsable universe — every non-deleted element of a browsable type
    // (concepts/media_fragments excluded). One indexed read; the row count is the
    // user's whole collection, well within an in-memory pass.
    const universe = this.db
      .select()
      .from(elements)
      .where(
        and(inArray(elements.type, LIBRARY_TYPES as ElementType[]), isNull(elements.deletedAt)),
      )
      .all()
      .map(rowToElement);

    // The canonical member->Set<liveConceptId> map, built ONCE (3 reads, deduped,
    // both-endpoint liveness) — the SAME substrate queue/search filtering uses, so a
    // member matches identically. Used for BOTH concept filtering and byConcept counts;
    // no per-concept `elementsForConcept` loop.
    const membership = this.repos.concepts.liveMembershipMap();

    const typeFilter =
      filters.types && filters.types.length > 0
        ? new Set<ElementType>(filters.types.filter((t) => LIBRARY_TYPE_SET.has(t)))
        : null;
    const statusFilter =
      filters.statuses && filters.statuses.length > 0
        ? new Set<ElementStatus>(filters.statuses)
        : null;
    const { priorityLabel, conceptId } = filters;

    // Per-dimension predicates: does an element pass the type / status / priority /
    // concept facet? A `null` filter passes everything. These are composed so each
    // facet dimension's count can OMIT its own predicate (drill-down semantics).
    const passesType = (el: Element) => !typeFilter || typeFilter.has(el.type);
    const passesStatus = (el: Element) => !statusFilter || statusFilter.has(el.status);
    const passesPriority = (el: Element) =>
      !priorityLabel || priorityToLabel(el.priority) === priorityLabel;
    const passesConcept = (el: Element) =>
      !conceptId || (membership.get(el.id)?.has(conceptId) ?? false);

    // The result set: every active filter applied.
    const matched = universe.filter(
      (el) => passesType(el) && passesStatus(el) && passesPriority(el) && passesConcept(el),
    );

    const ordered = this.order(matched);
    const limit = filters.limit ?? DEFAULT_LIMIT;
    const items = ordered.slice(0, limit);

    const counts = this.countFacets(universe, membership, {
      passesType,
      passesStatus,
      passesPriority,
      passesConcept,
      // `all` tracks the RENDERED rows (post-limit), so the top "N elements" label can
      // never exceed the visible list when the match set is larger than the cap.
      shownCount: items.length,
    });

    return { items, counts };
  }

  /** Order by priority DESCending, then `updated_at` DESCending (newest first). Stable. */
  private order(rows: readonly Element[]): Element[] {
    return [...rows].sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const au = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const bu = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return bu - au;
    });
  }

  /**
   * Build the DRILL-DOWN per-type / per-concept / per-priority / per-status counts.
   *
   * For each dimension, an element contributes to a value V iff it passes EVERY
   * OTHER active facet (the dimension's own predicate is omitted) AND its value for
   * this dimension is V. So `byType[t]` counts elements that pass concept+status+
   * priority and are of type `t`; `byConcept[c]` counts elements that pass
   * type+status+priority and are a live member of `c`; etc. The HARD INVARIANT is
   * that `counts[dim][V]` equals the number of rows you'd get if V were selected
   * alongside the other active filters — so a chip count always matches the list.
   *
   * `all` is the count of the RENDERED rows (`items.length`, post-limit), so the
   * top-line total never exceeds the visible list when the match set is larger than
   * the cap.
   */
  private countFacets(
    universe: readonly Element[],
    membership: ReadonlyMap<ElementId, ReadonlySet<ElementId>>,
    p: {
      passesType: (el: Element) => boolean;
      passesStatus: (el: Element) => boolean;
      passesPriority: (el: Element) => boolean;
      passesConcept: (el: Element) => boolean;
      shownCount: number;
    },
  ): LibraryBrowseCounts {
    const byType = Object.fromEntries(LIBRARY_TYPES.map((t) => [t, 0])) as Record<
      ElementType,
      number
    >;
    const byConcept: Record<string, number> = {};
    const byPriority: Record<LibraryPriorityLabel, number> = { A: 0, B: 0, C: 0, D: 0 };
    const byStatus: Record<string, number> = {};
    for (const status of LIBRARY_STATUSES) byStatus[status] = 0;

    for (const el of universe) {
      const okType = p.passesType(el);
      const okStatus = p.passesStatus(el);
      const okPriority = p.passesPriority(el);
      const okConcept = p.passesConcept(el);

      // byType: drop the type predicate, require the rest.
      if (okStatus && okPriority && okConcept) {
        byType[el.type] = (byType[el.type] ?? 0) + 1;
      }
      // byPriority: drop the priority predicate, require the rest.
      if (okType && okStatus && okConcept) {
        byPriority[priorityToLabel(el.priority)] += 1;
      }
      // byStatus: drop the status predicate, require the rest.
      if (okType && okPriority && okConcept) {
        byStatus[el.status] = (byStatus[el.status] ?? 0) + 1;
      }
      // byConcept: drop the concept predicate, require the rest; count once per LIVE
      // concept this element is a member of (the Set dedups duplicate edges already).
      if (okType && okStatus && okPriority) {
        const conceptIds = membership.get(el.id);
        if (conceptIds) {
          for (const conceptId of conceptIds) {
            byConcept[conceptId] = (byConcept[conceptId] ?? 0) + 1;
          }
        }
      }
    }
    return { all: p.shownCount, byType, byConcept, byPriority, byStatus };
  }
}
