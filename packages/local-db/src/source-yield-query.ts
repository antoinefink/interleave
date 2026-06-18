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
  authorDomainYieldBand,
  type ElementId,
  type ExtractFate,
  type IsoTimestamp,
  priorityToLabel,
  type SourceYieldInputs,
  scoreSourceYield,
  type YieldBand,
} from "@interleave/core";
import {
  cards as cardsTable,
  documentBlocks,
  elementRelations,
  elements,
  type InterleaveDatabase,
  readPoints,
  reviewLogs,
  reviewStates,
  sources as sourcesTable,
} from "@interleave/db";
import { isCardMature } from "@interleave/scheduler";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { BlockProcessingService } from "./block-processing-service";
import { chunkIds } from "./chunk-in-array";
import { DocumentRepository } from "./document-repository";
import { inboxSourceDomain } from "./inbox-query";

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
  /** Live fated/reference extracts plus synthesis-referenced extracts, de-duplicated. */
  readonly productiveExtracts: number;
  /** Live fated extracts with `extract_fate = 'reference'`. */
  readonly referenceExtracts: number;
  /** Live fated extracts with `extract_fate = 'synthesized'`. */
  readonly synthesizedExtracts: number;
  /** Live fated extracts with `extract_fate = 'done_without_card'`. */
  readonly doneWithoutCardExtracts: number;
  /** Live extract targets referenced by live synthesis notes. */
  readonly synthesisReferencedExtracts: number;
  /** Live synthesis notes that reference material from this source. */
  readonly synthesisNotesCreated: number;
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

/**
 * Compact, monotone counters for one adaptive scheduling visit. These are not the
 * ranked analytics view; they are the small durable facts the write path can store
 * in `operation_log` so diagnostics do not need to reconstruct old yield from
 * mutable current rows.
 */
export interface VisitYieldCounters {
  readonly extractsCreated: number;
  readonly productiveExtracts: number;
  readonly cardsCreated: number;
  readonly synthesisNotesCreated: number;
  readonly extractedOutputCount: number;
  readonly unresolvedBlocks: number;
  readonly totalOutputCount: number;
}

/** Options for {@link SourceYieldQuery.listSourceYield}. */
export interface SourceYieldOptions {
  /** Cap the row count (defaults to {@link DEFAULT_SOURCE_YIELD_LIMIT}). */
  readonly limit?: number;
  /** Skip the first `offset` rows (after sorting). */
  readonly offset?: number;
}

/**
 * One author's or domain's aggregate yield over its **worked** (non-`neutral`)
 * prior sources — the T127 "per-source yield history" suggestion signal (KTD4). The
 * band is NOT a per-row average or majority vote: it is `scoreSourceYield(summed
 * tallies).band` via the shared {@link authorDomainYieldBand} collapse rule, so the
 * aggregate and the per-source rollup can never disagree.
 */
export interface AuthorDomainYieldEntry {
  /** How many non-`neutral` worked prior sources backed the aggregate. */
  readonly workedSourceCount: number;
  /** The collapsed yield band (`high`/`medium`/`low`/`neutral`) over the summed tallies. */
  readonly yieldBand: YieldBand;
  /** Summed cards across the worked sources (an integer cited in the justification). */
  readonly totalCards: number;
  /** Summed mature cards across the worked sources (an integer cited in the justification). */
  readonly totalMatureCards: number;
}

/**
 * Per-author and per-domain yield aggregates. Keys are exact-string author and
 * normalized domain (via {@link inboxSourceDomain}). Known limitations (documented,
 * acceptable at this scope): author match is exact-string (no fuzzy/normalized
 * identity — "J. Smith" and "John Smith" do not merge), and subdomains bucket
 * separately (`blog.example.com` ≠ `example.com`).
 */
export interface AuthorDomainYieldAggregate {
  readonly byAuthor: ReadonlyMap<string, AuthorDomainYieldEntry>;
  readonly byDomain: ReadonlyMap<string, AuthorDomainYieldEntry>;
}

/** A single author/domain yield lookup result for the per-item path. */
export interface AuthorDomainYieldLookup {
  readonly author: AuthorDomainYieldEntry | null;
  readonly domain: AuthorDomainYieldEntry | null;
}

/** Mutable accumulator summing per-source yield tallies for one author/domain key. */
interface YieldAcc {
  count: number;
  /** Sum of per-source readPct — averaged at finalize (readPct is a `[0,1]` ratio per source). */
  readPctSum: number;
  extractsCreated: number;
  honorableExtracts: number;
  synthesisNotesCreated: number;
  cardsCreated: number;
  matureCards: number;
  leeches: number;
  timeSpentMs: number;
}

/** The per-source descendant tallies, accumulated in one grouped pass. */
interface DescendantTally {
  extracts: number;
  referenceExtracts: number;
  synthesizedExtracts: number;
  doneWithoutCardExtracts: number;
  fatedExtractIds: Set<string>;
  synthesisReferencedExtractIds: Set<string>;
  synthesisNoteIds: Set<string>;
  cards: number;
  mature: number;
  leeches: number;
  /** The live card element ids under this source (for the review-logs join). */
  cardIds: string[];
  /** Most recent descendant `updatedAt`. */
  lastUpdatedAt: string | null;
}

interface YieldTarget {
  readonly id: string;
  readonly type: string;
  readonly sourceId: string;
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
        t = {
          extracts: 0,
          referenceExtracts: 0,
          synthesizedExtracts: 0,
          doneWithoutCardExtracts: 0,
          fatedExtractIds: new Set(),
          synthesisReferencedExtractIds: new Set(),
          synthesisNoteIds: new Set(),
          cards: 0,
          mature: 0,
          leeches: 0,
          cardIds: [],
          lastUpdatedAt: null,
        };
        tallies.set(sourceId, t);
      }
      return t;
    };

    const liveTargets = new Map<string, YieldTarget>();
    const descendants = this.db
      .select({
        id: elements.id,
        type: elements.type,
        sourceId: elements.sourceId,
        extractFate: elements.extractFate,
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
      liveTargets.set(d.id, { id: d.id, type: d.type, sourceId: d.sourceId });
      const t = ensure(d.sourceId);
      if (d.updatedAt && (t.lastUpdatedAt === null || d.updatedAt > t.lastUpdatedAt)) {
        t.lastUpdatedAt = d.updatedAt;
      }
      if (d.type === "extract") {
        t.extracts += 1;
        const fate = d.extractFate as ExtractFate | null;
        if (fate) {
          t.fatedExtractIds.add(d.id);
          if (fate === "reference") t.referenceExtracts += 1;
          else if (fate === "synthesized") t.synthesizedExtracts += 1;
          else if (fate === "done_without_card") t.doneWithoutCardExtracts += 1;
        }
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

    // 4) Synthesis-note lineage: a live synthesis note that references live source
    //    material counts once per represented source. Extract targets also count as
    //    productive extract output, de-duplicated with explicit extract fates.
    const liveSynthesisNoteIds = this.db
      .select({ id: elements.id })
      .from(elements)
      .where(and(eq(elements.type, "synthesis_note"), isNull(elements.deletedAt)))
      .all()
      .map((row) => row.id);
    if (liveSynthesisNoteIds.length > 0 && liveTargets.size > 0) {
      // Chunk the IN (...) list so a whole-library synthesis-note set stays under
      // SQLite's variable limit; the fold below accumulates per source/target and
      // is order-independent across chunks.
      for (const noteChunk of chunkIds(liveSynthesisNoteIds)) {
        const referenceEdges = this.db
          .select({
            noteId: elementRelations.fromElementId,
            targetId: elementRelations.toElementId,
          })
          .from(elementRelations)
          .where(
            and(
              eq(elementRelations.relationType, "references"),
              inArray(elementRelations.fromElementId, noteChunk),
            ),
          )
          .all();
        for (const edge of referenceEdges) {
          const target = liveTargets.get(edge.targetId);
          if (!target) continue;
          const t = ensure(target.sourceId);
          t.synthesisNoteIds.add(edge.noteId);
          if (target.type === "extract") {
            t.synthesisReferencedExtractIds.add(target.id);
          }
        }
      }
    }

    // 5) One batched `review_logs` read over EVERY descendant card across all sources,
    //    accumulated per card id → summed/counted per source below.
    const allCardIds = [...tallies.values()].flatMap((t) => t.cardIds);
    const timeByCard = new Map<
      string,
      { ms: number; count: number; lastReviewedAt: string | null }
    >();
    if (allCardIds.length > 0) {
      // Chunk the IN (...) list so a whole-library card set stays under SQLite's
      // variable limit; the per-card aggregation below is order-independent across
      // chunks (sum/count accumulate, lastReviewedAt takes the max).
      for (const cardChunk of chunkIds(allCardIds)) {
        const logs = this.db
          .select({
            elementId: reviewLogs.elementId,
            responseMs: reviewLogs.responseMs,
            reviewedAt: reviewLogs.reviewedAt,
          })
          .from(reviewLogs)
          // Exclude T125 re-stabilization marker rows — not reviews; they must not inflate
          // a source's review ms/count or advance its lastReviewedAt.
          .where(and(inArray(reviewLogs.elementId, cardChunk), isNull(reviewLogs.editMarkerAt)))
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
    }

    const emptyTally = (): DescendantTally => ({
      extracts: 0,
      referenceExtracts: 0,
      synthesizedExtracts: 0,
      doneWithoutCardExtracts: 0,
      fatedExtractIds: new Set(),
      synthesisReferencedExtractIds: new Set(),
      synthesisNoteIds: new Set(),
      cards: 0,
      mature: 0,
      leeches: 0,
      cardIds: [],
      lastUpdatedAt: null,
    });

    // 6) Batch the remaining per-source rollups (U10): read-% + block-processing
    //    summary, both over the live source ids in grouped passes BEFORE the assembly
    //    loop, replacing the per-source `computeReadPct` + `getSourceProcessingSummary`
    //    N+1. `sourceRows` is already the LIVE source set, so the batched
    //    block-processing path is safe to skip `requireSourceElement` (stale ids can't
    //    appear here; the batched read tolerates them regardless — U10 stale-source
    //    safety). Both batched reads guard the empty id list internally (`IN ()`).
    const liveSourceIds = sourceRows.map((s) => s.id as ElementId);
    const readPctBySource = this.computeReadPctForMany(liveSourceIds);
    const blockSummaryBySource =
      this.blockProcessing.getSourceProcessingSummaryForMany(liveSourceIds);

    // 7) Assemble each source's row through the shared builder so the per-source math
    //    here is byte-identical to the single-source `getSourceYield` path.
    const rows: SourceYieldRow[] = sourceRows.map((s) => {
      const t = tallies.get(s.id) ?? emptyTally();

      let timeSpentMs = 0;
      let reviewCount = 0;
      let lastReviewedAt: string | null = null;
      for (const cardId of t.cardIds) {
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

      // getSourceProcessingSummaryForMany is stale-tolerant: it always returns an entry
      // for every input id (zero-summary when no blocks exist), so the fallback to the
      // strict single-source path (which throws on a stale id) is dead and removed.
      const blockSummary = blockSummaryBySource.get(s.id as ElementId) ?? {
        terminalRatio: 1,
        ignoredRatio: 0,
        unresolvedBlocks: 0,
        extractedOutputCount: 0,
      };

      return this.assembleRow(
        s,
        urlById.get(s.id) ?? null,
        t,
        { timeSpentMs, reviewCount, lastReviewedAt },
        { readPct: readPctBySource.get(s.id as ElementId) ?? 0, blockSummary },
      );
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
   * The yield rollup for ONE source (the inspector "yield" chip), or `null` when the
   * id is not a live source. A genuinely single-source query path: every pass is
   * scoped to `sourceId` (its `sources` meta, its `extract`/`card` descendants, its
   * synthesis-reference edges, its review logs, its read-% and block-processing
   * summary) so the inspector chip does NOT scan the whole library. The per-source
   * math is byte-identical to the row {@link listSourceYield} produces for the same
   * id — including the R3 dual-signal `productiveExtracts` (the de-duplicated union
   * of fated extract ids and live-synthesis-`references` extract ids) — so the chip
   * and the ranked view can never disagree.
   */
  getSourceYield(sourceId: ElementId, asOf: IsoTimestamp): SourceYieldRow | null {
    void asOf; // point-in-time over current durable state; kept for surface symmetry.

    // 1) The one source element (must be a live `source`), with its url/title meta.
    const source = this.db
      .select({
        id: elements.id,
        title: elements.title,
        priority: elements.priority,
        createdAt: elements.createdAt,
      })
      .from(elements)
      .where(
        and(eq(elements.id, sourceId), eq(elements.type, "source"), isNull(elements.deletedAt)),
      )
      .get();
    if (!source) return null;

    const sourceMeta = this.db
      .select({ url: sourcesTable.url })
      .from(sourcesTable)
      .where(eq(sourcesTable.elementId, sourceId))
      .get();

    // 2) One grouped pass over THIS source's live extract/card descendants, joined to
    //    their FSRS state + leech flag (scoped by `eq(elements.sourceId, sourceId)`).
    const t: DescendantTally = {
      extracts: 0,
      referenceExtracts: 0,
      synthesizedExtracts: 0,
      doneWithoutCardExtracts: 0,
      fatedExtractIds: new Set(),
      synthesisReferencedExtractIds: new Set(),
      synthesisNoteIds: new Set(),
      cards: 0,
      mature: 0,
      leeches: 0,
      cardIds: [],
      lastUpdatedAt: null,
    };
    const liveTargets = new Map<string, YieldTarget>();
    const descendants = this.db
      .select({
        id: elements.id,
        type: elements.type,
        extractFate: elements.extractFate,
        updatedAt: elements.updatedAt,
        isLeech: cardsTable.isLeech,
        stability: reviewStates.stability,
        fsrsState: reviewStates.fsrsState,
      })
      .from(elements)
      .leftJoin(cardsTable, eq(cardsTable.elementId, elements.id))
      .leftJoin(reviewStates, eq(reviewStates.elementId, elements.id))
      .where(
        and(
          eq(elements.sourceId, sourceId),
          inArray(elements.type, ["extract", "card"]),
          isNull(elements.deletedAt),
        ),
      )
      .all();

    for (const d of descendants) {
      liveTargets.set(d.id, { id: d.id, type: d.type, sourceId });
      if (d.updatedAt && (t.lastUpdatedAt === null || d.updatedAt > t.lastUpdatedAt)) {
        t.lastUpdatedAt = d.updatedAt;
      }
      if (d.type === "extract") {
        t.extracts += 1;
        const fate = d.extractFate as ExtractFate | null;
        if (fate) {
          t.fatedExtractIds.add(d.id);
          if (fate === "reference") t.referenceExtracts += 1;
          else if (fate === "synthesized") t.synthesizedExtracts += 1;
          else if (fate === "done_without_card") t.doneWithoutCardExtracts += 1;
        }
      } else if (d.type === "card") {
        t.cards += 1;
        t.cardIds.push(d.id);
        if (d.isLeech) t.leeches += 1;
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

    // 3) Synthesis-note lineage scoped to THIS source's live targets: a live synthesis
    //    note referencing this source's material counts once; referenced extracts also
    //    count as productive output (de-duplicated with explicit fates — R3 dual-signal).
    this.collectSynthesisCounters(liveTargets, t.synthesisNoteIds, t.synthesisReferencedExtractIds);

    // 4) Review logs over THIS source's cards (scoped by `inArray(cardIds)`).
    let timeSpentMs = 0;
    let reviewCount = 0;
    let lastReviewedAt: string | null = null;
    if (t.cardIds.length > 0) {
      // Chunk the IN (...) list so a source with a very large card set stays under
      // SQLite's variable limit; sum/count accumulate and lastReviewedAt takes the
      // max, so the result is order-independent across chunks.
      for (const cardChunk of chunkIds(t.cardIds)) {
        const logs = this.db
          .select({
            responseMs: reviewLogs.responseMs,
            reviewedAt: reviewLogs.reviewedAt,
          })
          .from(reviewLogs)
          // Exclude T125 re-stabilization marker rows — not reviews.
          .where(and(inArray(reviewLogs.elementId, cardChunk), isNull(reviewLogs.editMarkerAt)))
          .all();
        for (const log of logs) {
          timeSpentMs += log.responseMs;
          reviewCount += 1;
          if (lastReviewedAt === null || log.reviewedAt > lastReviewedAt) {
            lastReviewedAt = log.reviewedAt;
          }
        }
      }
    }

    return this.assembleRow(source, sourceMeta?.url ?? null, t, {
      timeSpentMs,
      reviewCount,
      lastReviewedAt,
    });
  }

  /**
   * Build one {@link SourceYieldRow} from a tally + its review aggregates. The single
   * source of truth for row shape — both {@link listSourceYield}'s assembly loop and
   * {@link getSourceYield} call it so the two paths can never drift. Computes the R3
   * dual-signal `productiveExtracts` (fated ∪ synthesis-referenced extract ids) and
   * reads read-% + block-processing per source.
   */
  private assembleRow(
    source: { id: string; title: string; priority: number; createdAt: string },
    url: string | null,
    t: DescendantTally,
    review: { timeSpentMs: number; reviewCount: number; lastReviewedAt: string | null },
    precomputed?: {
      readPct: number;
      blockSummary: Pick<
        ReturnType<BlockProcessingService["getSourceProcessingSummary"]>,
        "terminalRatio" | "ignoredRatio" | "unresolvedBlocks" | "extractedOutputCount"
      >;
    },
  ): SourceYieldRow {
    const extractsCreated = t.extracts;
    const productiveExtracts = new Set([...t.fatedExtractIds, ...t.synthesisReferencedExtractIds])
      .size;
    const synthesisReferencedExtracts = t.synthesisReferencedExtractIds.size;
    const synthesisNotesCreated = t.synthesisNoteIds.size;

    // Batched callers (listSourceYield, U10) pass pre-built read-% + block-processing
    // maps; the single-source getSourceYield path falls back to per-source reads.
    const readPct = precomputed?.readPct ?? this.computeReadPct(source.id as ElementId);
    const blockSummary =
      precomputed?.blockSummary ??
      this.blockProcessing.getSourceProcessingSummary(source.id as ElementId);
    const lastActivityAt = maxIso(t.lastUpdatedAt, review.lastReviewedAt);

    const verdict = scoreSourceYield({
      readPct,
      extractsCreated,
      honorableExtracts: productiveExtracts,
      synthesisNotesCreated,
      cardsCreated: t.cards,
      matureCards: t.mature,
      leeches: t.leeches,
      timeSpentMs: review.timeSpentMs,
    });

    return {
      source: {
        id: source.id,
        title: source.title,
        priority: source.priority,
        priorityLabel: priorityToLabel(source.priority),
        createdAt: source.createdAt as IsoTimestamp,
        url,
      },
      readPct,
      extractsCreated,
      productiveExtracts,
      referenceExtracts: t.referenceExtracts,
      synthesizedExtracts: t.synthesizedExtracts,
      doneWithoutCardExtracts: t.doneWithoutCardExtracts,
      synthesisReferencedExtracts,
      synthesisNotesCreated,
      cardsCreated: t.cards,
      matureCards: t.mature,
      leeches: t.leeches,
      timeSpentMs: review.timeSpentMs,
      reviewCount: review.reviewCount,
      processedBlockRatio: blockSummary.terminalRatio,
      ignoredBlockRatio: blockSummary.ignoredRatio,
      unresolvedBlocks: blockSummary.unresolvedBlocks,
      extractedOutputCount: blockSummary.extractedOutputCount,
      lastActivityAt,
      yieldScore: verdict.score,
      yieldBand: verdict.band,
    };
  }

  /**
   * Roll the durable per-source yield up into per-author and per-domain aggregates
   * (the T127 yield suggestion signal — KTD4). Read-only. Reuses {@link listSourceYield}'s
   * per-source rollup (so it inherits the fate-aware, de-duplicated yield definition —
   * never a naive card count) and joins it to a fresh `sources` read for `author` +
   * `canonicalUrl`/`url` (the yield rows carry neither). `neutral` (un-started) sources
   * are EXCLUDED from both the count and the summed tallies so a pile of un-started
   * imports is never read as evidence (R8). For each key the worked sources' tallies
   * are summed and collapsed to one band via {@link authorDomainYieldBand} —
   * `scoreSourceYield(summed tallies).band`, the single shared collapse rule.
   *
   * The N=2 worked-source floor is NOT enforced here — this returns whatever it
   * computed (including `workedSourceCount`); the floor is applied downstream in the
   * pure scorer (`scoreTriageSuggestion`) so the floor lives in one tunable place.
   *
   * Runs the full library rollup (like {@link getSourceYield}); the per-item suggestion
   * path calls this ONCE per batch and indexes the returned maps rather than calling it
   * per item.
   */
  aggregateYieldByAuthorAndDomain(asOf: IsoTimestamp): AuthorDomainYieldAggregate {
    const summary = this.listSourceYield(asOf, { limit: Number.MAX_SAFE_INTEGER });

    // Fresh `sources` read for author + URLs (the yield rows carry only id/title/url).
    const metaById = new Map<
      string,
      { author: string | null; canonicalUrl: string | null; url: string | null }
    >();
    const meta = this.db
      .select({
        elementId: sourcesTable.elementId,
        author: sourcesTable.author,
        canonicalUrl: sourcesTable.canonicalUrl,
        url: sourcesTable.url,
      })
      .from(sourcesTable)
      .all();
    for (const m of meta) {
      metaById.set(m.elementId, {
        author: m.author ?? null,
        canonicalUrl: m.canonicalUrl ?? null,
        url: m.url ?? null,
      });
    }

    const byAuthorAcc = new Map<string, YieldAcc>();
    const byDomainAcc = new Map<string, YieldAcc>();
    const ensureAcc = (map: Map<string, YieldAcc>, key: string): YieldAcc => {
      let acc = map.get(key);
      if (!acc) {
        acc = {
          count: 0,
          readPctSum: 0,
          extractsCreated: 0,
          honorableExtracts: 0,
          synthesisNotesCreated: 0,
          cardsCreated: 0,
          matureCards: 0,
          leeches: 0,
          timeSpentMs: 0,
        };
        map.set(key, acc);
      }
      return acc;
    };
    const addRow = (acc: YieldAcc, row: SourceYieldRow): void => {
      acc.count += 1;
      acc.readPctSum += row.readPct;
      acc.extractsCreated += row.extractsCreated;
      acc.honorableExtracts += row.productiveExtracts;
      acc.synthesisNotesCreated += row.synthesisNotesCreated;
      acc.cardsCreated += row.cardsCreated;
      acc.matureCards += row.matureCards;
      acc.leeches += row.leeches;
      acc.timeSpentMs += row.timeSpentMs;
    };

    for (const row of summary.rows) {
      // Exclude un-started sources — an un-started import (or a suggestion-elevated but
      // still-un-worked source) is `neutral` and is not evidence of yield (R8).
      if (row.yieldBand === "neutral") continue;
      const m = metaById.get(row.source.id);
      const author = m?.author?.trim() ? m.author.trim() : null;
      const domain = inboxSourceDomain(m ?? null);
      if (author) addRow(ensureAcc(byAuthorAcc, author), row);
      if (domain) addRow(ensureAcc(byDomainAcc, domain), row);
    }

    const finalize = (map: Map<string, YieldAcc>): Map<string, AuthorDomainYieldEntry> => {
      const out = new Map<string, AuthorDomainYieldEntry>();
      for (const [key, acc] of map) {
        const summed: SourceYieldInputs = {
          // readPct is a per-source ratio; average it across the key's worked sources
          // rather than summing (a sum would exceed 1 and distort the barren penalty).
          readPct: acc.count > 0 ? acc.readPctSum / acc.count : 0,
          extractsCreated: acc.extractsCreated,
          honorableExtracts: acc.honorableExtracts,
          synthesisNotesCreated: acc.synthesisNotesCreated,
          cardsCreated: acc.cardsCreated,
          matureCards: acc.matureCards,
          leeches: acc.leeches,
          timeSpentMs: acc.timeSpentMs,
        };
        out.set(key, {
          workedSourceCount: acc.count,
          yieldBand: authorDomainYieldBand(summed),
          totalCards: acc.cardsCreated,
          totalMatureCards: acc.matureCards,
        });
      }
      return out;
    };

    return { byAuthor: finalize(byAuthorAcc), byDomain: finalize(byDomainAcc) };
  }

  /**
   * Single-item convenience over {@link aggregateYieldByAuthorAndDomain}: the author and
   * domain aggregates for one item, or `null` per key when absent. Runs the full rollup
   * (like {@link getSourceYield}) — the batched per-item suggestion path should call
   * {@link aggregateYieldByAuthorAndDomain} once and index the maps instead.
   */
  getAuthorDomainYield(
    asOf: IsoTimestamp,
    author: string | null,
    domain: string | null,
  ): AuthorDomainYieldLookup {
    const agg = this.aggregateYieldByAuthorAndDomain(asOf);
    const authorKey = author?.trim() ? author.trim() : null;
    return {
      author: authorKey ? (agg.byAuthor.get(authorKey) ?? null) : null,
      domain: domain ? (agg.byDomain.get(domain) ?? null) : null,
    };
  }

  /**
   * Scoped source counters for T112's write path. Unlike `listSourceYield`, this
   * only reads the requested source's descendants and block-processing summary, so
   * scheduling a processed visit does not scan the whole library.
   */
  getSourceVisitCounters(sourceId: ElementId): VisitYieldCounters {
    const liveTargets = new Map<string, YieldTarget>();
    const fatedExtractIds = new Set<string>();
    const synthesisReferencedExtractIds = new Set<string>();
    const synthesisNoteIds = new Set<string>();
    let extractsCreated = 0;
    let cardsCreated = 0;

    const descendants = this.db
      .select({
        id: elements.id,
        type: elements.type,
        extractFate: elements.extractFate,
      })
      .from(elements)
      .where(
        and(
          eq(elements.sourceId, sourceId),
          inArray(elements.type, ["extract", "card"]),
          isNull(elements.deletedAt),
        ),
      )
      .all();

    for (const row of descendants) {
      liveTargets.set(row.id, { id: row.id, type: row.type, sourceId });
      if (row.type === "extract") {
        extractsCreated += 1;
        if (row.extractFate) fatedExtractIds.add(row.id);
      } else if (row.type === "card") {
        cardsCreated += 1;
      }
    }

    this.collectSynthesisCounters(liveTargets, synthesisNoteIds, synthesisReferencedExtractIds);

    const blockSummary = this.blockProcessing.getSourceProcessingSummary(sourceId);
    const productiveExtracts = new Set([...fatedExtractIds, ...synthesisReferencedExtractIds]).size;
    const totalOutputCount =
      extractsCreated + productiveExtracts + cardsCreated + synthesisNoteIds.size;

    return {
      extractsCreated,
      productiveExtracts,
      cardsCreated,
      synthesisNotesCreated: synthesisNoteIds.size,
      extractedOutputCount: blockSummary.extractedOutputCount,
      unresolvedBlocks: blockSummary.unresolvedBlocks,
      totalOutputCount,
    };
  }

  /**
   * Scoped extract counters for T112's write path. Counts only output that can be
   * attributed to this extract: child extracts/cards, synthesis references, an
   * honorable fate on the extract itself, and the atomic-statement stage.
   */
  getExtractVisitCounters(extractId: ElementId): VisitYieldCounters {
    const extract = this.db
      .select({
        id: elements.id,
        type: elements.type,
        stage: elements.stage,
        extractFate: elements.extractFate,
      })
      .from(elements)
      .where(and(eq(elements.id, extractId), isNull(elements.deletedAt)))
      .get();
    if (extract?.type !== "extract") {
      return emptyVisitCounters();
    }

    const childRows = this.db
      .select({
        id: elements.id,
        type: elements.type,
        extractFate: elements.extractFate,
      })
      .from(elementRelations)
      .innerJoin(elements, eq(elementRelations.fromElementId, elements.id))
      .where(
        and(
          eq(elementRelations.toElementId, extractId),
          eq(elementRelations.relationType, "derived_from"),
          inArray(elements.type, ["extract", "card"]),
          isNull(elements.deletedAt),
        ),
      )
      .all();

    const liveTargets = new Map<string, YieldTarget>();
    const fatedExtractIds = new Set<string>();
    const synthesisReferencedExtractIds = new Set<string>();
    const synthesisNoteIds = new Set<string>();
    let extractsCreated = 0;
    let cardsCreated = 0;

    liveTargets.set(extract.id, { id: extract.id, type: "extract", sourceId: "" });
    if (extract.extractFate) fatedExtractIds.add(extract.id);

    for (const row of childRows) {
      liveTargets.set(row.id, { id: row.id, type: row.type, sourceId: "" });
      if (row.type === "extract") {
        extractsCreated += 1;
        if (row.extractFate) fatedExtractIds.add(row.id);
      } else if (row.type === "card") {
        cardsCreated += 1;
      }
    }

    this.collectSynthesisCounters(liveTargets, synthesisNoteIds, synthesisReferencedExtractIds);

    const productiveExtracts = new Set([...fatedExtractIds, ...synthesisReferencedExtractIds]).size;
    const atomicStatements = extract.stage === "atomic_statement" ? 1 : 0;
    const totalOutputCount =
      extractsCreated +
      productiveExtracts +
      cardsCreated +
      synthesisNoteIds.size +
      atomicStatements;

    return {
      extractsCreated,
      productiveExtracts,
      cardsCreated,
      synthesisNotesCreated: synthesisNoteIds.size,
      extractedOutputCount: atomicStatements,
      unresolvedBlocks: 0,
      totalOutputCount,
    };
  }

  private collectSynthesisCounters(
    liveTargets: ReadonlyMap<string, YieldTarget>,
    synthesisNoteIds: Set<string>,
    synthesisReferencedExtractIds: Set<string>,
  ): void {
    if (liveTargets.size === 0) return;
    // Chunk the IN (...) list so a source with a very large extract/card subtree
    // stays under SQLite's variable limit; the fold accumulates into shared sets
    // and is order-independent across chunks.
    for (const targetChunk of chunkIds([...liveTargets.keys()])) {
      const referenceEdges = this.db
        .select({
          noteId: elementRelations.fromElementId,
          targetId: elementRelations.toElementId,
        })
        .from(elementRelations)
        .innerJoin(elements, eq(elementRelations.fromElementId, elements.id))
        .where(
          and(
            eq(elementRelations.relationType, "references"),
            eq(elements.type, "synthesis_note"),
            isNull(elements.deletedAt),
            inArray(elementRelations.toElementId, targetChunk),
          ),
        )
        .all();

      for (const edge of referenceEdges) {
        const target = liveTargets.get(edge.targetId);
        if (!target) continue;
        synthesisNoteIds.add(edge.noteId);
        if (target.type === "extract") {
          synthesisReferencedExtractIds.add(target.id);
        }
      }
    }
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

  /**
   * Batched (perf U10) read-% map over many sources — the grouped equivalent of
   * {@link computeReadPct}, byte-identical per source. Reads every source's blocks +
   * read-point in two `IN (sourceIds)` passes instead of N per-source pairs. Empty id
   * list → empty map (guarded; `IN ()` would be a SQLite syntax error). A source with
   * no blocks or no read-point is `0`; a stale read-point whose block is gone is `1`.
   */
  private computeReadPctForMany(sourceIds: readonly ElementId[]): Map<ElementId, number> {
    const out = new Map<ElementId, number>();
    if (sourceIds.length === 0) return out;
    const ids = sourceIds as ElementId[];

    // All blocks for these sources, grouped + ordered exactly like `listBlocks`.
    // Chunk the IN (...) list so an unbounded (whole-library) source set stays
    // under SQLite's variable limit; per-source accumulation + the final sort make
    // the result chunk-independent.
    const blocksBySource = new Map<string, { stableBlockId: string; order: number }[]>();
    for (const chunk of chunkIds(ids)) {
      const blockRows = this.db
        .select({
          documentId: documentBlocks.documentId,
          stableBlockId: documentBlocks.stableBlockId,
          order: documentBlocks.order,
        })
        .from(documentBlocks)
        .where(inArray(documentBlocks.documentId, chunk))
        .all();
      for (const b of blockRows) {
        const list = blocksBySource.get(b.documentId) ?? [];
        list.push({ stableBlockId: b.stableBlockId, order: b.order });
        blocksBySource.set(b.documentId, list);
      }
    }
    for (const list of blocksBySource.values()) list.sort((a, b) => a.order - b.order);

    // The read-point block id per source (one per element). Chunked for the same
    // variable-limit reason; one row per source, so set() is order-independent.
    const readPointBlockBySource = new Map<string, string>();
    for (const chunk of chunkIds(ids)) {
      const rpRows = this.db
        .select({ elementId: readPoints.elementId, blockId: readPoints.blockId })
        .from(readPoints)
        .where(inArray(readPoints.elementId, chunk))
        .all();
      for (const rp of rpRows) readPointBlockBySource.set(rp.elementId, rp.blockId);
    }

    for (const id of sourceIds) {
      const blocks = blocksBySource.get(id) ?? [];
      if (blocks.length === 0) {
        out.set(id, 0);
        continue;
      }
      const readPointBlockId = readPointBlockBySource.get(id);
      if (readPointBlockId === undefined) {
        out.set(id, 0);
        continue;
      }
      const index = blocks.findIndex((b) => b.stableBlockId === readPointBlockId);
      if (index < 0) {
        out.set(id, 1);
        continue;
      }
      out.set(id, Math.min(1, Math.max(0, (index + 1) / blocks.length)));
    }
    return out;
  }
}

export function emptyVisitCounters(): VisitYieldCounters {
  return {
    extractsCreated: 0,
    productiveExtracts: 0,
    cardsCreated: 0,
    synthesisNotesCreated: 0,
    extractedOutputCount: 0,
    unresolvedBlocks: 0,
    totalOutputCount: 0,
  };
}

/** The later (greater) of two nullable ISO timestamps, or `null` when both are null. */
function maxIso(a: string | null, b: string | null): IsoTimestamp | null {
  if (a === null) return (b as IsoTimestamp | null) ?? null;
  if (b === null) return a as IsoTimestamp;
  return (a > b ? a : b) as IsoTimestamp;
}
