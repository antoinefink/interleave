/**
 * SourceYieldQuery (T083) — the per-source "what did it actually produce?" rollup.
 *
 * The system-wide T045 `AnalyticsService` answers "how is the whole system doing?".
 * This is its PER-UNIT mirror: for every live `source` it computes what that source
 * yielded — how far it was read, how many extracts/cards/mature-cards it produced,
 * how many of its cards are leeches, and how much review time it cost — plus a
 * derived `yieldScore`/`yieldBand` (the pure `@interleave/core` `scoreSourceYield`
 * rule) so the lowest-yield sources are identifiable in a ranked, lowest-first view.
 *
 * Architecture (non-negotiable, mirrors `analytics-query.ts`):
 *  - **Read-only.** It NEVER mutates and NEVER appends an `operation_log` row — there
 *    is nothing to undo about looking at your stats. No schedule change.
 *  - All aggregation lives HERE (the domain layer), never in React. The renderer
 *    reads one `SourceYieldSummary` payload over the typed `window.appApi` bridge.
 *  - Computed from durable tables, so the numbers survive an app restart and match
 *    exactly what the user produced.
 *  - The FSRS-vs-attention split stays LABELED: the source itself is an *attention*
 *    item; its leeches/mature-cards are the FSRS-card outputs of that source.
 *
 * ## Definitions (the contract the ranked view + the inspector chip depend on)
 *
 * - **read %** = the read-point block's 0-based position in `document_blocks` order,
 *   plus one, over the live block count: `readPct = (orderIndex + 1) / blockCount`,
 *   clamped to `[0, 1]`. So block index `0` of `N` reads as `1/N` and the last block
 *   (index `N-1`) reads as `N/N = 100%`. A source with NO read-point or NO document
 *   is **0%**; a stale read-point at/after the last block is **100%**. Paginated
 *   (PDF) / media bodies use the SAME block-order math (their blocks are still
 *   `document_blocks` rows).
 * - **extracts/cards per source** = live `extract` / `card` elements whose
 *   `elements.sourceId = source.id` (the denormalized lineage root every descendant
 *   carries; the `derived_from` edge agrees with it by construction). Soft-deleted
 *   descendants are excluded.
 * - **mature cards** = those cards whose `review_states.stability` crosses the
 *   EXISTING `CARD_MATURE_STABILITY_DAYS = 21` threshold (the T077 maturity
 *   convention). We reuse `@interleave/scheduler`'s `isCardMature` predicate with
 *   `retrievability: null` — which short-circuits to `stability >= 21 && fsrsState
 *   === "review"` — so no `ts-fsrs` is pulled into the query and no parallel
 *   maturity rule is minted.
 * - **leeches** = those cards with `cards.is_leech = 1` (the durable flag).
 * - **time spent** = `SUM(review_logs.responseMs)` over the source's cards' review
 *   logs — the only durable "time" signal we record. This is *review* time, NOT
 *   total reading time (reading time is not tracked; see the T083 note). `reviewCount`
 *   carries the row count for denominator context.
 * - **last activity** = the most recent of the source's/descendants' `updatedAt` and
 *   the latest review on its cards (`MAX(review_logs.reviewedAt)`), read off the same
 *   grouped descendant set — for the "stale source" read.
 *
 * ## Performance
 *
 * The yield/read/review rollups use grouped reads for sources, descendants, review
 * logs, and source metadata. Read-% and block-processing progress need each source's
 * own block/read-point state, so they use indexed per-source reads
 * (`read_points_element_idx`, `document_blocks_document_idx`, and the
 * `source_block_processing_*` indexes). This keeps the MVP implementation simple
 * while preserving a clear seam for a batched block-processing aggregate if the
 * analytics table grows large.
 */

import {
  type ElementId,
  type IsoTimestamp,
  priorityToLabel,
  scoreSourceYield,
  type YieldBand,
} from "@interleave/core";
import {
  cards as cardsTable,
  elements,
  type InterleaveDatabase,
  reviewLogs,
  reviewStates,
  sources as sourcesTable,
} from "@interleave/db";
import { isCardMature } from "@interleave/scheduler";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { BlockProcessingService } from "./block-processing-service";
import { DocumentRepository } from "./document-repository";

/** Default cap so a broad rollup can't return an unbounded list (like `LibraryQuery`). */
export const DEFAULT_SOURCE_YIELD_LIMIT = 200;

/** A small source descriptor embedded in each yield row. */
export interface SourceYieldSourceRef {
  readonly id: string;
  readonly title: string;
  /** Normalized numeric priority `0.0`–`1.0`. */
  readonly priority: number;
  /** The A/B/C/D label for the priority (convenience for the row). */
  readonly priorityLabel: "A" | "B" | "C" | "D";
  readonly createdAt: IsoTimestamp;
  /** The source's URL, or `null` for a manual/import-less source. */
  readonly url: string | null;
}

/** One source's complete yield rollup. */
export interface SourceYieldRow {
  readonly source: SourceYieldSourceRef;
  /** How far the source has been read, in `[0, 1]` (read-point position / block count). */
  readonly readPct: number;
  /** Live `extract` descendants created from the source. */
  readonly extractsCreated: number;
  /** Live `card` descendants created from the source. */
  readonly cardsCreated: number;
  /** Cards whose FSRS stability crosses the maturity threshold (durable knowledge). */
  readonly matureCards: number;
  /** Cards currently flagged a leech (failing repeatedly). */
  readonly leeches: number;
  /** Summed review response time on the source's cards, in ms (review time, not reading). */
  readonly timeSpentMs: number;
  /** Number of `review_logs` rows on the source's cards (denominator context). */
  readonly reviewCount: number;
  /** Terminal source blocks / total blocks from durable block processing. */
  readonly processedBlockRatio: number;
  /** Ignored source blocks / total blocks from durable block processing. */
  readonly ignoredBlockRatio: number;
  /** Unresolved source blocks that remain in the block-processing model. */
  readonly unresolvedBlocks: number;
  /** Output links created from extracted blocks. */
  readonly extractedOutputCount: number;
  /** Most recent activity (descendant `updatedAt` / latest review), or `null`. */
  readonly lastActivityAt: IsoTimestamp | null;
  /** The derived productivity score (higher = better) — ranks the view. */
  readonly yieldScore: number;
  /** The coarse band: `high` / `medium` / `low` / `neutral` (un-started). */
  readonly yieldBand: YieldBand;
}

/** The complete source-yield snapshot the ranked view reads (one payload). */
export interface SourceYieldSummary {
  /** The `asOf` instant the snapshot was computed for (ISO-8601). */
  readonly asOf: IsoTimestamp;
  /** The rows, sorted by `yieldScore` ASCENDING (lowest-yield first — the point). */
  readonly rows: readonly SourceYieldRow[];
  /** How many rows are in the `low` band (the "needs attention" count). */
  readonly lowYieldCount: number;
}

/** Options for {@link SourceYieldQuery.listSourceYield}. */
export interface SourceYieldOptions {
  /** Cap the row count (defaults to {@link DEFAULT_SOURCE_YIELD_LIMIT}). */
  readonly limit?: number;
  /** Skip the first `offset` rows (after sorting). */
  readonly offset?: number;
}

/** The per-source descendant tallies, accumulated in one grouped pass. */
interface DescendantTally {
  extracts: number;
  cards: number;
  mature: number;
  leeches: number;
  /** The live card element ids under this source (for the review-logs join). */
  cardIds: string[];
  /** Most recent descendant `updatedAt`. */
  lastUpdatedAt: string | null;
}

/**
 * Read-only per-source yield aggregation. Constructed once per open database
 * (alongside {@link Repositories}); the main process exposes it over validated IPC.
 */
export class SourceYieldQuery {
  private readonly documents: DocumentRepository;
  private readonly blockProcessing: BlockProcessingService;

  constructor(private readonly db: InterleaveDatabase) {
    this.documents = new DocumentRepository(db);
    this.blockProcessing = new BlockProcessingService(db);
  }

  /**
   * Compute the full {@link SourceYieldSummary} for `asOf`. Read-only. See the file
   * header for every definition + the grouped (non-N+1) query plan. `asOf` is part
   * of the contract (kept for symmetry with the analytics surface) though the rollup
   * itself is point-in-time over the current durable state.
   */
  listSourceYield(asOf: IsoTimestamp, options: SourceYieldOptions = {}): SourceYieldSummary {
    const limit = options.limit ?? DEFAULT_SOURCE_YIELD_LIMIT;
    const offset = Math.max(0, options.offset ?? 0);

    // 1) Every live source element (the universe the view ranks).
    const sourceRows = this.db
      .select({
        id: elements.id,
        title: elements.title,
        priority: elements.priority,
        createdAt: elements.createdAt,
      })
      .from(elements)
      .where(and(eq(elements.type, "source"), isNull(elements.deletedAt)))
      .all();

    if (sourceRows.length === 0) {
      return { asOf, rows: [], lowYieldCount: 0 };
    }

    // 2) The source url/title (one batched read of the `sources` side-table).
    const urlById = new Map<string, string | null>();
    const sourceMeta = this.db
      .select({ elementId: sourcesTable.elementId, url: sourcesTable.url })
      .from(sourcesTable)
      .all();
    for (const m of sourceMeta) urlById.set(m.elementId, m.url ?? null);

    // 3) One grouped pass over LIVE extract/card descendants, joined to their FSRS
    //    state + leech flag, tallied by `sourceId`. (`sourceId` is a single indexed
    //    column; soft-deleted descendants are excluded by the `deletedAt` filter.)
    const tallies = new Map<string, DescendantTally>();
    const ensure = (sourceId: string): DescendantTally => {
      let t = tallies.get(sourceId);
      if (!t) {
        t = { extracts: 0, cards: 0, mature: 0, leeches: 0, cardIds: [], lastUpdatedAt: null };
        tallies.set(sourceId, t);
      }
      return t;
    };

    const descendants = this.db
      .select({
        id: elements.id,
        type: elements.type,
        sourceId: elements.sourceId,
        updatedAt: elements.updatedAt,
        isLeech: cardsTable.isLeech,
        stability: reviewStates.stability,
        fsrsState: reviewStates.fsrsState,
      })
      .from(elements)
      .leftJoin(cardsTable, eq(cardsTable.elementId, elements.id))
      .leftJoin(reviewStates, eq(reviewStates.elementId, elements.id))
      .where(and(inArray(elements.type, ["extract", "card"]), isNull(elements.deletedAt)))
      .all();

    for (const d of descendants) {
      // A descendant with no `sourceId` (or one pointing at a non-source) is not part
      // of any source's rollup; skip it.
      if (!d.sourceId) continue;
      const t = ensure(d.sourceId);
      if (d.updatedAt && (t.lastUpdatedAt === null || d.updatedAt > t.lastUpdatedAt)) {
        t.lastUpdatedAt = d.updatedAt;
      }
      if (d.type === "extract") {
        t.extracts += 1;
      } else if (d.type === "card") {
        t.cards += 1;
        t.cardIds.push(d.id);
        if (d.isLeech) t.leeches += 1;
        // Mature reuses the EXISTING T077 predicate with retrievability:null, which
        // degrades to `stability >= CARD_MATURE_STABILITY_DAYS && fsrsState === "review"`.
        if (
          isCardMature({
            retrievability: null,
            stability: d.stability ?? null,
            fsrsState: d.fsrsState ?? null,
            lapses: null,
          })
        ) {
          t.mature += 1;
        }
      }
    }

    // 4) One batched `review_logs` read over EVERY descendant card across all sources,
    //    accumulated per card id → summed/counted per source below.
    const allCardIds = [...tallies.values()].flatMap((t) => t.cardIds);
    const timeByCard = new Map<
      string,
      { ms: number; count: number; lastReviewedAt: string | null }
    >();
    if (allCardIds.length > 0) {
      const logs = this.db
        .select({
          elementId: reviewLogs.elementId,
          responseMs: reviewLogs.responseMs,
          reviewedAt: reviewLogs.reviewedAt,
        })
        .from(reviewLogs)
        .where(inArray(reviewLogs.elementId, allCardIds))
        .all();
      for (const log of logs) {
        let agg = timeByCard.get(log.elementId);
        if (!agg) {
          agg = { ms: 0, count: 0, lastReviewedAt: null };
          timeByCard.set(log.elementId, agg);
        }
        agg.ms += log.responseMs;
        agg.count += 1;
        if (agg.lastReviewedAt === null || log.reviewedAt > agg.lastReviewedAt) {
          agg.lastReviewedAt = log.reviewedAt;
        }
      }
    }

    // 5) Assemble each source's row, computing read-% from its own read-point + blocks.
    const rows: SourceYieldRow[] = sourceRows.map((s) => {
      const t = tallies.get(s.id);
      const extractsCreated = t?.extracts ?? 0;
      const cardsCreated = t?.cards ?? 0;
      const matureCards = t?.mature ?? 0;
      const leeches = t?.leeches ?? 0;

      let timeSpentMs = 0;
      let reviewCount = 0;
      let lastReviewedAt: string | null = null;
      for (const cardId of t?.cardIds ?? []) {
        const agg = timeByCard.get(cardId);
        if (!agg) continue;
        timeSpentMs += agg.ms;
        reviewCount += agg.count;
        if (
          agg.lastReviewedAt &&
          (lastReviewedAt === null || agg.lastReviewedAt > lastReviewedAt)
        ) {
          lastReviewedAt = agg.lastReviewedAt;
        }
      }

      const readPct = this.computeReadPct(s.id as ElementId);
      const blockSummary = this.blockProcessing.getSourceProcessingSummary(s.id as ElementId);

      // Most recent activity: the latest of the descendant updatedAt + the latest
      // review on its cards (the source itself has no review_logs of its own).
      const lastActivityAt = maxIso(t?.lastUpdatedAt ?? null, lastReviewedAt);

      const verdict = scoreSourceYield({
        readPct,
        extractsCreated,
        cardsCreated,
        matureCards,
        leeches,
        timeSpentMs,
      });

      return {
        source: {
          id: s.id,
          title: s.title,
          priority: s.priority,
          priorityLabel: priorityToLabel(s.priority),
          createdAt: s.createdAt as IsoTimestamp,
          url: urlById.get(s.id) ?? null,
        },
        readPct,
        extractsCreated,
        cardsCreated,
        matureCards,
        leeches,
        timeSpentMs,
        reviewCount,
        processedBlockRatio: blockSummary.terminalRatio,
        ignoredBlockRatio: blockSummary.ignoredRatio,
        unresolvedBlocks: blockSummary.unresolvedBlocks,
        extractedOutputCount: blockSummary.extractedOutputCount,
        lastActivityAt,
        yieldScore: verdict.score,
        yieldBand: verdict.band,
      };
    });

    // Sort lowest-yield first (the whole point); tie-break by id ASC for stability.
    rows.sort((a, b) => {
      if (a.yieldScore !== b.yieldScore) return a.yieldScore - b.yieldScore;
      return a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0;
    });

    const lowYieldCount = rows.filter((r) => r.yieldBand === "low").length;
    const paged = rows.slice(offset, offset + limit);
    return { asOf, rows: paged, lowYieldCount };
  }

  /**
   * Convenience: the yield rollup for ONE source (the inspector "yield" chip),
   * or `null` when the id is not a live source. Reuses {@link listSourceYield}'s
   * per-row math so the chip and the ranked view can never disagree. (This runs the
   * full grouped rollup and picks the one row — fine at MVP scale; the inspector
   * opens infrequently. A genuinely single-source path is a T099 scale refinement.)
   */
  getSourceYield(sourceId: ElementId, asOf: IsoTimestamp): SourceYieldRow | null {
    const summary = this.listSourceYield(asOf, { limit: Number.MAX_SAFE_INTEGER });
    return summary.rows.find((r) => r.source.id === sourceId) ?? null;
  }

  /**
   * The read %: the read-point's block position over the source's live block count.
   * `(orderIndex + 1) / blockCount`, clamped to `[0, 1]`. **0** when there is no
   * read-point or no blocks; **100%** when the read-point is at/after the last block.
   */
  private computeReadPct(elementId: ElementId): number {
    const blocks = this.documents.listBlocks(elementId);
    if (blocks.length === 0) return 0;
    const readPoint = this.documents.getReadPoint(elementId);
    if (!readPoint) return 0;
    const index = blocks.findIndex((b) => b.stableBlockId === readPoint.blockId);
    if (index < 0) {
      // A stale read-point whose block no longer exists: treat as fully read (the
      // furthest the user reached is gone, but they did reach the end of an older body).
      return 1;
    }
    const pct = (index + 1) / blocks.length;
    return Math.min(1, Math.max(0, pct));
  }
}

/** The later (greater) of two nullable ISO timestamps, or `null` when both are null. */
function maxIso(a: string | null, b: string | null): IsoTimestamp | null {
  if (a === null) return (b as IsoTimestamp | null) ?? null;
  if (b === null) return a as IsoTimestamp;
  return (a > b ? a : b) as IsoTimestamp;
}
