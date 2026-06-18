/**
 * SourceYieldQuery tests (T083 — the per-source yield rollup).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB. They pin
 * the aggregation contract the ranked view + the inspector chip depend on:
 *  - read % = `(orderIndex + 1) / blockCount` from `read_points` vs `document_blocks`;
 *  - extracts/cards per source via the persisted `sourceId` lineage;
 *  - mature cards via `review_states.stability >= CARD_MATURE_STABILITY_DAYS` (+ review);
 *  - leeches via the durable `cards.is_leech` flag;
 *  - time spent / review count via `SUM(review_logs.responseMs)` over the cards;
 *  - lowest-yield-first sort + `lowYieldCount`;
 *  - the no-read-point (0%), no-document (0%), and no-cards edges;
 *  - soft-deleted extracts/cards are excluded.
 */

import type { BlockId, ElementId, ExtractFate, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, reviewLogs, reviewStates, sources } from "@interleave/db";
import { CARD_MATURE_STABILITY_DAYS } from "@interleave/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { newReviewLogId } from "./ids";
import { SourceYieldQuery } from "./source-yield-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
const ASOF = "2026-06-01T12:00:00.000Z" as IsoTimestamp;

/** Create a live `source` element with a document body + `n` stable blocks. */
function seedSource(
  handle: DbHandle,
  title: string,
  blockCount: number,
  priority = 0.5,
): ElementId {
  const repo = new ElementRepository(handle.db);
  const docs = new DocumentRepository(handle.db);
  const el = repo.create({
    type: "source",
    status: "active",
    stage: "raw_source",
    priority,
    title,
  });
  if (blockCount > 0) {
    const blocks = Array.from({ length: blockCount }, (_, i) => ({
      blockType: "paragraph",
      order: i,
      stableBlockId: `${el.id}-blk-${i}` as BlockId,
    }));
    docs.upsert({
      elementId: el.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "x",
      blocks,
    });
  }
  return el.id;
}

/** Set the read-point at block index `k` of a source's document. */
function setReadPoint(handle: DbHandle, sourceId: ElementId, k: number): void {
  new DocumentRepository(handle.db).setReadPoint({
    elementId: sourceId,
    documentId: sourceId,
    blockId: `${sourceId}-blk-${k}` as BlockId,
    offset: 0,
  });
}

/** Create a live `extract` under `sourceId` (via the lineage column). */
function seedExtract(
  handle: DbHandle,
  sourceId: ElementId,
  opts: { fate?: ExtractFate } = {},
): ElementId {
  const repo = new ElementRepository(handle.db);
  const el = repo.create({
    type: "extract",
    status: "active",
    stage: "raw_extract",
    priority: 0.5,
    title: "Extract",
    sourceId,
  });
  if (opts.fate) repo.update(el.id, { status: "done", dueAt: null, extractFate: opts.fate });
  return el.id;
}

/** Create a live synthesis note and optionally reference material from it. */
function seedSynthesisNote(handle: DbHandle, targetIds: readonly ElementId[] = []): ElementId {
  const repo = new ElementRepository(handle.db);
  const note = repo.create({
    type: "synthesis_note",
    status: "active",
    stage: "synthesis",
    priority: 0.5,
    title: "Synthesis note",
  });
  for (const targetId of targetIds) {
    repo.addRelation({
      fromElementId: note.id,
      toElementId: targetId,
      relationType: "references",
    });
  }
  return note.id;
}

/** Create a live `card` under `sourceId`, with an FSRS state + optional leech/stability. */
function seedCard(
  handle: DbHandle,
  sourceId: ElementId,
  opts: { leech?: boolean; stability?: number; fsrsState?: string } = {},
): ElementId {
  const el = new ElementRepository(handle.db).create({
    type: "card",
    status: "active",
    stage: "active_card",
    priority: 0.5,
    title: "Card",
    sourceId,
  });
  handle.db
    .insert(cards)
    .values({ elementId: el.id, kind: "qa", isLeech: opts.leech ?? false })
    .run();
  handle.db
    .insert(reviewStates)
    .values({
      elementId: el.id,
      fsrsState: opts.fsrsState ?? "review",
      stability: opts.stability ?? 0,
    })
    .run();
  return el.id;
}

/** Append a `review_logs` row with a known `responseMs`. */
function seedReview(
  handle: DbHandle,
  cardId: ElementId,
  responseMs: number,
  reviewedAt: string,
): void {
  handle.db
    .insert(reviewLogs)
    .values({
      id: newReviewLogId(),
      elementId: cardId,
      rating: "good",
      reviewedAt,
      responseMs,
      prevState: "review",
      nextState: "review",
      nextStability: 10,
      nextDifficulty: 5,
      nextDueAt: reviewedAt,
    })
    .run();
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("SourceYieldQuery.listSourceYield", () => {
  it("computes read % = (orderIndex + 1) / blockCount", () => {
    const src = seedSource(handle, "Read 2/4", 4);
    setReadPoint(handle, src, 1); // index 1 of 4 → (1+1)/4 = 0.5
    const summary = new SourceYieldQuery(handle.db).listSourceYield(ASOF);
    const row = summary.rows.find((r) => r.source.id === src);
    expect(row?.readPct).toBeCloseTo(0.5);
  });

  it("reads as 100% at the last block and 0% with no read-point / no document", () => {
    const last = seedSource(handle, "Read fully", 5);
    setReadPoint(handle, last, 4); // last index of 5 → 5/5 = 1
    const noRp = seedSource(handle, "No read-point", 3);
    const noDoc = seedSource(handle, "No document", 0);

    const q = new SourceYieldQuery(handle.db);
    const rows = q.listSourceYield(ASOF).rows;
    expect(rows.find((r) => r.source.id === last)?.readPct).toBeCloseTo(1);
    expect(rows.find((r) => r.source.id === noRp)?.readPct).toBe(0);
    expect(rows.find((r) => r.source.id === noDoc)?.readPct).toBe(0);
  });

  it("rolls up extracts/cards/mature-cards/leeches/time via the sourceId lineage", () => {
    const src = seedSource(handle, "Productive", 4);
    setReadPoint(handle, src, 3); // fully read
    // 2 extracts, 3 cards: one mature (stability ≥ 21, review), one leech, one plain.
    seedExtract(handle, src);
    seedExtract(handle, src);
    const matureCard = seedCard(handle, src, { stability: CARD_MATURE_STABILITY_DAYS + 5 });
    const leechCard = seedCard(handle, src, { leech: true, stability: 1 });
    const plainCard = seedCard(handle, src, { stability: 1 });
    // Review time on two of the cards.
    seedReview(handle, matureCard, 4000, "2026-05-30T08:00:00.000Z");
    seedReview(handle, matureCard, 2000, "2026-05-31T08:00:00.000Z");
    seedReview(handle, plainCard, 1500, "2026-05-29T08:00:00.000Z");
    void leechCard;

    const row = new SourceYieldQuery(handle.db)
      .listSourceYield(ASOF)
      .rows.find((r) => r.source.id === src);
    expect(row?.extractsCreated).toBe(2);
    expect(row?.cardsCreated).toBe(3);
    expect(row?.matureCards).toBe(1);
    expect(row?.leeches).toBe(1);
    expect(row?.timeSpentMs).toBe(4000 + 2000 + 1500);
    expect(row?.reviewCount).toBe(3);
    // lastActivityAt = max(descendant updatedAt, latest review). The descendants'
    // updatedAt is stamped at create-time (wall clock), so it is at/after the seeded
    // reviews — just assert it is present and not before the latest review.
    expect(row?.lastActivityAt).not.toBeNull();
    expect(row?.lastActivityAt && row.lastActivityAt >= "2026-05-31T08:00:00.000Z").toBe(true);
  });

  it("counts fated extracts as non-card value so a read source is not low-yield", () => {
    const src = seedSource(handle, "Reference source", 4);
    setReadPoint(handle, src, 3);
    seedExtract(handle, src, { fate: "reference" });

    const row = new SourceYieldQuery(handle.db)
      .listSourceYield(ASOF)
      .rows.find((r) => r.source.id === src);

    expect(row?.extractsCreated).toBe(1);
    expect(row?.productiveExtracts).toBe(1);
    expect(row?.referenceExtracts).toBe(1);
    expect(row?.synthesizedExtracts).toBe(0);
    expect(row?.doneWithoutCardExtracts).toBe(0);
    expect(row?.yieldBand).not.toBe("low");
  });

  it("counts one live synthesis note once per source for multiple extract references", () => {
    const src = seedSource(handle, "Synthesized source", 4);
    setReadPoint(handle, src, 3);
    const first = seedExtract(handle, src);
    const second = seedExtract(handle, src);
    seedSynthesisNote(handle, [first, second]);

    const row = new SourceYieldQuery(handle.db)
      .listSourceYield(ASOF)
      .rows.find((r) => r.source.id === src);

    expect(row?.synthesisNotesCreated).toBe(1);
    expect(row?.synthesisReferencedExtracts).toBe(2);
    expect(row?.productiveExtracts).toBe(2);
    expect(row?.yieldBand).not.toBe("low");
  });

  it("counts one synthesis note once for each represented source", () => {
    const firstSource = seedSource(handle, "First source", 2);
    const secondSource = seedSource(handle, "Second source", 2);
    const firstExtract = seedExtract(handle, firstSource);
    const secondExtract = seedExtract(handle, secondSource);
    seedSynthesisNote(handle, [firstExtract, secondExtract]);

    const rows = new SourceYieldQuery(handle.db).listSourceYield(ASOF).rows;
    expect(rows.find((r) => r.source.id === firstSource)?.synthesisNotesCreated).toBe(1);
    expect(rows.find((r) => r.source.id === secondSource)?.synthesisNotesCreated).toBe(1);
  });

  it("does not count deleted synthesis notes or deleted referenced targets", () => {
    const deletedNoteSource = seedSource(handle, "Deleted note source", 2);
    const deletedTargetSource = seedSource(handle, "Deleted target source", 2);
    const noteTarget = seedExtract(handle, deletedNoteSource);
    const deletedTarget = seedExtract(handle, deletedTargetSource);
    const repo = new ElementRepository(handle.db);
    const note = seedSynthesisNote(handle, [noteTarget]);
    seedSynthesisNote(handle, [deletedTarget]);
    repo.softDelete(note);
    repo.softDelete(deletedTarget);

    const rows = new SourceYieldQuery(handle.db).listSourceYield(ASOF).rows;
    expect(rows.find((r) => r.source.id === deletedNoteSource)?.synthesisNotesCreated).toBe(0);
    expect(rows.find((r) => r.source.id === deletedTargetSource)?.synthesisNotesCreated).toBe(0);
    const deletedTargetRow = rows.find((r) => r.source.id === deletedTargetSource);
    expect(deletedTargetRow?.synthesisReferencedExtracts).toBe(0);
  });

  it("does not double-count an extract with both a fate and synthesis reference", () => {
    const src = seedSource(handle, "Deduped source", 2);
    const extract = seedExtract(handle, src, { fate: "synthesized" });
    seedSynthesisNote(handle, [extract]);

    const row = new SourceYieldQuery(handle.db)
      .listSourceYield(ASOF)
      .rows.find((r) => r.source.id === src);

    expect(row?.synthesizedExtracts).toBe(1);
    expect(row?.synthesisReferencedExtracts).toBe(1);
    expect(row?.productiveExtracts).toBe(1);
    expect(row?.synthesisNotesCreated).toBe(1);
  });

  it("includes durable block-processing ratios and unresolved counts", () => {
    const src = seedSource(handle, "Block outcomes", 4);
    const blocks = new DocumentRepository(handle.db).listBlocks(src);
    const service = new BlockProcessingService(handle.db);
    service.markBlockProcessed({
      sourceElementId: src,
      stableBlockId: blocks[0]?.stableBlockId as BlockId,
    });
    service.markBlockIgnored({
      sourceElementId: src,
      stableBlockId: blocks[1]?.stableBlockId as BlockId,
    });

    const row = new SourceYieldQuery(handle.db)
      .listSourceYield(ASOF)
      .rows.find((r) => r.source.id === src);
    expect(row?.processedBlockRatio).toBeCloseTo(0.5);
    expect(row?.ignoredBlockRatio).toBeCloseTo(0.25);
    expect(row?.unresolvedBlocks).toBe(2);
    expect(row?.extractedOutputCount).toBe(0);
  });

  it("does NOT count a card mature when stability is high but fsrsState is not review", () => {
    const src = seedSource(handle, "Not yet review", 2);
    setReadPoint(handle, src, 1);
    seedCard(handle, src, { stability: CARD_MATURE_STABILITY_DAYS + 10, fsrsState: "learning" });
    const row = new SourceYieldQuery(handle.db)
      .listSourceYield(ASOF)
      .rows.find((r) => r.source.id === src);
    expect(row?.cardsCreated).toBe(1);
    expect(row?.matureCards).toBe(0);
  });

  it("sorts lowest-yield first and counts the low band", () => {
    // A productive source (mature cards) and a read-but-barren source (fully read, no output).
    const productive = seedSource(handle, "Productive", 4);
    setReadPoint(handle, productive, 3);
    seedExtract(handle, productive);
    const m1 = seedCard(handle, productive, { stability: CARD_MATURE_STABILITY_DAYS + 1 });
    const m2 = seedCard(handle, productive, { stability: CARD_MATURE_STABILITY_DAYS + 1 });
    void m1;
    void m2;

    const barren = seedSource(handle, "Barren", 4);
    setReadPoint(handle, barren, 3); // fully read, nothing produced → low

    // An un-started source (no reading, no output) → neutral, never low, never first.
    seedSource(handle, "Fresh import", 3);

    const summary = new SourceYieldQuery(handle.db).listSourceYield(ASOF);
    // Lowest-yield first: the barren source sorts ahead of the productive one.
    const ids = summary.rows.map((r) => r.source.id);
    expect(ids.indexOf(barren)).toBeLessThan(ids.indexOf(productive));
    expect(summary.lowYieldCount).toBe(1);
    expect(summary.rows.find((r) => r.source.id === barren)?.yieldBand).toBe("low");
    expect(summary.rows.find((r) => r.source.id === productive)?.yieldBand).toBe("high");
  });

  it("excludes soft-deleted extracts and cards from the rollup", () => {
    const src = seedSource(handle, "With deletions", 2);
    setReadPoint(handle, src, 1);
    const repo = new ElementRepository(handle.db);
    const liveExtract = seedExtract(handle, src);
    const deadExtract = seedExtract(handle, src);
    const liveCard = seedCard(handle, src, { stability: 1 });
    const deadCard = seedCard(handle, src, { stability: 1 });
    void liveExtract;
    void liveCard;
    repo.softDelete(deadExtract);
    repo.softDelete(deadCard);

    const row = new SourceYieldQuery(handle.db)
      .listSourceYield(ASOF)
      .rows.find((r) => r.source.id === src);
    expect(row?.extractsCreated).toBe(1);
    expect(row?.cardsCreated).toBe(1);
  });

  it("excludes a soft-deleted source entirely", () => {
    const repo = new ElementRepository(handle.db);
    const live = seedSource(handle, "Live", 2);
    const dead = seedSource(handle, "Dead", 2);
    repo.softDelete(dead);
    const ids = new SourceYieldQuery(handle.db).listSourceYield(ASOF).rows.map((r) => r.source.id);
    expect(ids).toContain(live);
    expect(ids).not.toContain(dead);
  });

  it("returns an empty summary on an empty database", () => {
    const summary = new SourceYieldQuery(handle.db).listSourceYield(ASOF);
    expect(summary.rows).toEqual([]);
    expect(summary.lowYieldCount).toBe(0);
  });

  it("getSourceYield returns one source's row or null", () => {
    const src = seedSource(handle, "Solo", 2);
    setReadPoint(handle, src, 0); // (0+1)/2 = 0.5
    const q = new SourceYieldQuery(handle.db);
    expect(q.getSourceYield(src, ASOF)?.readPct).toBeCloseTo(0.5);
    expect(q.getSourceYield("missing" as ElementId, ASOF)).toBeNull();
  });

  it("honours limit + offset (after lowest-first sort)", () => {
    for (let i = 0; i < 5; i++) {
      const s = seedSource(handle, `S${i}`, 2);
      setReadPoint(handle, s, 1);
    }
    const summary = new SourceYieldQuery(handle.db).listSourceYield(ASOF, { limit: 2, offset: 1 });
    expect(summary.rows).toHaveLength(2);
    // lowYieldCount is over the FULL set, not the page.
    expect(summary.lowYieldCount).toBe(5);
  });
});

describe("SourceYieldQuery.getSourceYield (single-source drift)", () => {
  it("deepEquals the listSourceYield row across sources with/without extracts, cards, and synthesis refs", () => {
    // A) Barren read source (read, no output).
    const barren = seedSource(handle, "Barren", 4);
    setReadPoint(handle, barren, 3);

    // B) Source with extracts + cards + reviews + block processing.
    const productive = seedSource(handle, "Productive", 4);
    setReadPoint(handle, productive, 1);
    seedExtract(handle, productive, { fate: "reference" });
    seedExtract(handle, productive);
    const mature = seedCard(handle, productive, { stability: CARD_MATURE_STABILITY_DAYS + 5 });
    seedCard(handle, productive, { leech: true, stability: 1 });
    seedReview(handle, mature, 3000, "2026-05-30T08:00:00.000Z");
    const pBlocks = new DocumentRepository(handle.db).listBlocks(productive);
    const bps = new BlockProcessingService(handle.db);
    bps.markBlockProcessed({
      sourceElementId: productive,
      stableBlockId: pBlocks[0]?.stableBlockId as BlockId,
    });
    bps.markBlockIgnored({
      sourceElementId: productive,
      stableBlockId: pBlocks[1]?.stableBlockId as BlockId,
    });
    setSourceMeta(handle, productive, { url: "https://example.com/p" });

    // C) Source with a synthesis note referencing two of its extracts.
    const synth = seedSource(handle, "Synthesized", 4);
    setReadPoint(handle, synth, 3);
    const e1 = seedExtract(handle, synth);
    const e2 = seedExtract(handle, synth);
    seedSynthesisNote(handle, [e1, e2]);

    // D) Un-started neutral source (no read, no output).
    const fresh = seedSource(handle, "Fresh import", 3);

    const q = new SourceYieldQuery(handle.db);
    const list = q.listSourceYield(ASOF, { limit: Number.MAX_SAFE_INTEGER }).rows;
    for (const id of [barren, productive, synth, fresh]) {
      const listed = list.find((r) => r.source.id === id);
      expect(q.getSourceYield(id, ASOF)).toEqual(listed);
    }
  });

  it("reports identical productiveExtracts for a source whose ONLY productive extract is a live synthesis reference (no extract_fate)", () => {
    const src = seedSource(handle, "Synthesis-only productivity", 4);
    setReadPoint(handle, src, 3);
    const extract = seedExtract(handle, src); // NO fate
    seedSynthesisNote(handle, [extract]);

    const q = new SourceYieldQuery(handle.db);
    const single = q.getSourceYield(src, ASOF);
    const listed = q
      .listSourceYield(ASOF, { limit: Number.MAX_SAFE_INTEGER })
      .rows.find((r) => r.source.id === src);

    // Dual-signal: productive via the synthesis edge, NOT via extract_fate.
    expect(single?.productiveExtracts).toBe(1);
    expect(single?.synthesisReferencedExtracts).toBe(1);
    expect(single?.referenceExtracts).toBe(0);
    expect(single).toEqual(listed);
  });

  it("returns null for an unknown / non-source / soft-deleted id (matching the old behavior)", () => {
    const repo = new ElementRepository(handle.db);
    const dead = seedSource(handle, "Dead", 2);
    repo.softDelete(dead);
    const extract = seedExtract(handle, seedSource(handle, "Owner", 2));

    const q = new SourceYieldQuery(handle.db);
    expect(q.getSourceYield("missing" as ElementId, ASOF)).toBeNull();
    expect(q.getSourceYield(dead, ASOF)).toBeNull();
    expect(q.getSourceYield(extract, ASOF)).toBeNull(); // an extract is not a source
  });

  it("drift guard is non-vacuous: a wrong productiveExtracts would fail the deepEquals", () => {
    const src = seedSource(handle, "Guard", 4);
    setReadPoint(handle, src, 3);
    const extract = seedExtract(handle, src);
    seedSynthesisNote(handle, [extract]);

    const q = new SourceYieldQuery(handle.db);
    const single = q.getSourceYield(src, ASOF);
    const listed = q
      .listSourceYield(ASOF, { limit: Number.MAX_SAFE_INTEGER })
      .rows.find((r) => r.source.id === src);
    // Sanity: deepEquals holds for the real value...
    expect(single).toEqual(listed);
    // ...and a deliberately corrupted copy would NOT (proving the assertion has teeth).
    const corrupted = { ...(single as object), productiveExtracts: 999 };
    expect(corrupted).not.toEqual(listed);
  });
});

describe("SourceYieldQuery.listSourceYield (U10 batched read-pct + block-processing)", () => {
  it("per-source read-% + processed-block counts equal the single-source helpers (drift guard)", () => {
    // A spread of shapes: read partial, fully read, no read-point, no document,
    // some with block-processing outcomes, some with extracts/cards.
    const partial = seedSource(handle, "Partial", 4);
    setReadPoint(handle, partial, 1);
    const full = seedSource(handle, "Full", 5);
    setReadPoint(handle, full, 4);
    const noRp = seedSource(handle, "No read-point", 3);
    const noDoc = seedSource(handle, "No document", 0);

    const processed = seedSource(handle, "Processed", 4);
    setReadPoint(handle, processed, 2);
    seedExtract(handle, processed, { fate: "reference" });
    const pBlocks = new DocumentRepository(handle.db).listBlocks(processed);
    const bps = new BlockProcessingService(handle.db);
    bps.markBlockProcessed({
      sourceElementId: processed,
      stableBlockId: pBlocks[0]?.stableBlockId as BlockId,
    });
    bps.markBlockIgnored({
      sourceElementId: processed,
      stableBlockId: pBlocks[1]?.stableBlockId as BlockId,
    });

    const q = new SourceYieldQuery(handle.db);
    const rows = q.listSourceYield(ASOF, { limit: Number.MAX_SAFE_INTEGER }).rows;
    const truthBps = new BlockProcessingService(handle.db);

    for (const id of [partial, full, noRp, noDoc, processed]) {
      const row = rows.find((r) => r.source.id === id);
      expect(row).toBeDefined();
      // read-% source of truth: the single-source getSourceYield path (computeReadPct).
      expect(row?.readPct).toBe(q.getSourceYield(id, ASOF)?.readPct);
      // block-processing source of truth: the per-source getSourceProcessingSummary.
      const summary = truthBps.getSourceProcessingSummary(id);
      expect(row?.processedBlockRatio).toBe(summary.terminalRatio);
      expect(row?.ignoredBlockRatio).toBe(summary.ignoredRatio);
      expect(row?.unresolvedBlocks).toBe(summary.unresolvedBlocks);
      expect(row?.extractedOutputCount).toBe(summary.extractedOutputCount);
    }
  });

  it("whole-library output is internally consistent: every row deepEquals its single-source getSourceYield", () => {
    seedSource(handle, "Empty edge", 0);
    const a = seedSource(handle, "A", 3);
    setReadPoint(handle, a, 1);
    seedExtract(handle, a);
    seedCard(handle, a, { stability: CARD_MATURE_STABILITY_DAYS + 2 });
    const b = seedSource(handle, "B", 2);
    const e = seedExtract(handle, b);
    seedSynthesisNote(handle, [e]);

    const q = new SourceYieldQuery(handle.db);
    const rows = q.listSourceYield(ASOF, { limit: Number.MAX_SAFE_INTEGER }).rows;
    for (const row of rows) {
      expect(q.getSourceYield(row.source.id as ElementId, ASOF)).toEqual(row);
    }
  });

  it("zero-sources vault returns an empty valid result with no IN () error", () => {
    const q = new SourceYieldQuery(handle.db);
    expect(() => q.listSourceYield(ASOF)).not.toThrow();
    expect(q.listSourceYield(ASOF).rows).toEqual([]);
  });

  it("sources but no synthesis notes returns a valid result with no IN () error", () => {
    const s1 = seedSource(handle, "S1", 3);
    setReadPoint(handle, s1, 1);
    seedExtract(handle, s1);
    seedSource(handle, "S2", 0); // no document, no synthesis
    const q = new SourceYieldQuery(handle.db);
    expect(() => q.listSourceYield(ASOF)).not.toThrow();
    expect(q.listSourceYield(ASOF).rows).toHaveLength(2);
  });

  it("tolerates a source soft-deleted from the live set without crashing the whole call", () => {
    // The batched block-processing path must NOT route through requireSourceElement,
    // which throws on a soft-deleted/missing source. A soft-deleted source is simply
    // absent from the live set; the remaining sources still roll up cleanly.
    const repo = new ElementRepository(handle.db);
    const live = seedSource(handle, "Live", 3);
    setReadPoint(handle, live, 2);
    const blocks = new DocumentRepository(handle.db).listBlocks(live);
    new BlockProcessingService(handle.db).markBlockIgnored({
      sourceElementId: live,
      stableBlockId: blocks[0]?.stableBlockId as BlockId,
    });
    const dead = seedSource(handle, "Dead", 3);
    setReadPoint(handle, dead, 1);
    repo.softDelete(dead);

    const q = new SourceYieldQuery(handle.db);
    expect(() => q.listSourceYield(ASOF)).not.toThrow();
    const rows = q.listSourceYield(ASOF).rows;
    expect(rows.map((r) => r.source.id)).toEqual([live]);
    expect(rows[0]?.ignoredBlockRatio).toBeCloseTo(1 / 3);
  });

  it("getSourceProcessingSummaryForMany matches the per-source summary and tolerates a stale id (no throw)", () => {
    const src = seedSource(handle, "Has blocks", 4);
    const blocks = new DocumentRepository(handle.db).listBlocks(src);
    const bps = new BlockProcessingService(handle.db);
    bps.markBlockProcessed({
      sourceElementId: src,
      stableBlockId: blocks[0]?.stableBlockId as BlockId,
    });

    const stale = "ghost-source" as ElementId;
    const map = bps.getSourceProcessingSummaryForMany([src, stale]);
    // Live source: identical to the single-source summary.
    expect(map.get(src)).toEqual(bps.getSourceProcessingSummary(src));
    // Stale id: zero summary, NOT a throw (the single-source path WOULD throw).
    expect(() => bps.getSourceProcessingSummary(stale)).toThrow();
    expect(map.get(stale)?.totalBlocks).toBe(0);
    expect(map.get(stale)?.terminalRatio).toBe(1);
    expect(map.get(stale)?.canMarkDoneWithoutConfirmation).toBe(true);
  });

  it("drift guard is non-vacuous: a wrong batched read-% would fail vs the single-source truth", () => {
    const src = seedSource(handle, "Guard", 4);
    setReadPoint(handle, src, 1); // (1+1)/4 = 0.5
    const q = new SourceYieldQuery(handle.db);
    const row = q
      .listSourceYield(ASOF, { limit: Number.MAX_SAFE_INTEGER })
      .rows.find((r) => r.source.id === src);
    expect(row?.readPct).toBe(q.getSourceYield(src, ASOF)?.readPct);
    // A wrong value would not match the single-source truth (proving teeth).
    expect(0.99).not.toBe(q.getSourceYield(src, ASOF)?.readPct);
  });
});

/** Insert the `sources` side-table row carrying author + URL for an existing source element. */
function setSourceMeta(
  handle: DbHandle,
  id: ElementId,
  meta: { author?: string | null; url?: string | null; canonicalUrl?: string | null },
): void {
  handle.db
    .insert(sources)
    .values({
      elementId: id,
      author: meta.author ?? null,
      url: meta.url ?? null,
      canonicalUrl: meta.canonicalUrl ?? null,
    })
    .run();
}

/** A fully-read source with 2 mature cards (+ reviews) → unambiguously a worked, high-yield source. */
function seedWorkedSource(
  handle: DbHandle,
  title: string,
  meta: { author?: string | null; url?: string | null; canonicalUrl?: string | null } = {},
): ElementId {
  const src = seedSource(handle, title, 4);
  setReadPoint(handle, src, 3);
  const m1 = seedCard(handle, src, { stability: CARD_MATURE_STABILITY_DAYS + 5 });
  const m2 = seedCard(handle, src, { stability: CARD_MATURE_STABILITY_DAYS + 5 });
  seedReview(handle, m1, 1500, "2026-05-30T08:00:00.000Z");
  seedReview(handle, m2, 1500, "2026-05-30T08:05:00.000Z");
  setSourceMeta(handle, src, meta);
  return src;
}

describe("SourceYieldQuery.aggregateYieldByAuthorAndDomain", () => {
  it("aggregates an author's worked sources via the shared collapse rule", () => {
    seedWorkedSource(handle, "Ada 1", { author: "Ada Lovelace" });
    seedWorkedSource(handle, "Ada 2", { author: "Ada Lovelace" });
    seedWorkedSource(handle, "Ada 3", { author: "Ada Lovelace" });

    const agg = new SourceYieldQuery(handle.db).aggregateYieldByAuthorAndDomain(ASOF);
    const ada = agg.byAuthor.get("Ada Lovelace");
    expect(ada).toBeDefined();
    expect(ada?.workedSourceCount).toBe(3);
    // 3 sources × 2 mature cards = 6 mature → scoreSourceYield(summed) is well past "high".
    expect(ada?.yieldBand).toBe("high");
    expect(ada?.totalMatureCards).toBe(6);
    expect(ada?.totalCards).toBe(6);
  });

  it("excludes neutral (un-started) sources from the count and the tallies (R8)", () => {
    // 2 worked + 1 neutral (no read, no output) by the same author.
    seedWorkedSource(handle, "Cy 1", { author: "Cy" });
    seedWorkedSource(handle, "Cy 2", { author: "Cy" });
    const neutral = seedSource(handle, "Cy neutral", 4);
    setSourceMeta(handle, neutral, { author: "Cy" });

    const agg = new SourceYieldQuery(handle.db).aggregateYieldByAuthorAndDomain(ASOF);
    expect(agg.byAuthor.get("Cy")?.workedSourceCount).toBe(2);
  });

  it("an author with only neutral sources is absent from the aggregate", () => {
    const n = seedSource(handle, "Ben neutral", 4);
    setSourceMeta(handle, n, { author: "Ben" });

    const agg = new SourceYieldQuery(handle.db).aggregateYieldByAuthorAndDomain(ASOF);
    expect(agg.byAuthor.has("Ben")).toBe(false);
  });

  it("buckets subdomains separately (blog.example.com ≠ example.com)", () => {
    seedWorkedSource(handle, "Blog A", { canonicalUrl: "https://blog.example.com/a" });
    seedWorkedSource(handle, "Blog B", { canonicalUrl: "https://www.blog.example.com/b" });
    seedWorkedSource(handle, "Root C", { canonicalUrl: "https://example.com/c" });

    const agg = new SourceYieldQuery(handle.db).aggregateYieldByAuthorAndDomain(ASOF);
    expect(agg.byDomain.get("blog.example.com")?.workedSourceCount).toBe(2);
    expect(agg.byDomain.get("example.com")?.workedSourceCount).toBe(1);
  });

  it("a worked source with null author and null domain lands in neither map", () => {
    seedWorkedSource(handle, "Anon", {}); // sources row exists but author + urls null
    const agg = new SourceYieldQuery(handle.db).aggregateYieldByAuthorAndDomain(ASOF);
    expect(agg.byAuthor.size).toBe(0);
    expect(agg.byDomain.size).toBe(0);
  });

  it("the single-key lookup helper returns the author and domain entries", () => {
    seedWorkedSource(handle, "Site 1", {
      author: "Carl Sagan",
      canonicalUrl: "https://cosmos.example.org/1",
    });
    seedWorkedSource(handle, "Site 2", {
      author: "Carl Sagan",
      canonicalUrl: "https://cosmos.example.org/2",
    });

    const q = new SourceYieldQuery(handle.db);
    const lookup = q.getAuthorDomainYield(ASOF, "Carl Sagan", "cosmos.example.org");
    expect(lookup.author?.workedSourceCount).toBe(2);
    expect(lookup.domain?.workedSourceCount).toBe(2);
    expect(q.getAuthorDomainYield(ASOF, "Unknown", "nowhere.example").author).toBeNull();
  });

  it("is deterministic across back-to-back calls", () => {
    seedWorkedSource(handle, "D1", { author: "Det", canonicalUrl: "https://det.example/1" });
    seedWorkedSource(handle, "D2", { author: "Det", canonicalUrl: "https://det.example/2" });
    const q = new SourceYieldQuery(handle.db);
    const first = q.aggregateYieldByAuthorAndDomain(ASOF);
    const second = q.aggregateYieldByAuthorAndDomain(ASOF);
    expect([...first.byAuthor.entries()]).toEqual([...second.byAuthor.entries()]);
    expect([...first.byDomain.entries()]).toEqual([...second.byDomain.entries()]);
  });
});

describe("SourceYieldQuery.listSourceYield — chunk-boundary parity (SQLITE_SAFE_IN_ARRAY_SIZE)", () => {
  it("rolls up > one IN-chunk worth of live sources without a SQLite var-limit crash, readPct intact across the boundary", () => {
    // SQLITE_SAFE_IN_ARRAY_SIZE is 900; 905 live sources force the batched
    // read-% + block-processing passes (computeReadPctForMany / *ForMany) to
    // split into multiple IN (...) chunks. Cheap fixture: 905 tiny 2-block
    // sources; two carry read-points (one in each chunk) plus a card+review so
    // the whole-library review-log read is also exercised across the boundary.
    const COUNT = 905;
    const ids: ElementId[] = [];
    for (let i = 0; i < COUNT; i++) {
      ids.push(seedSource(handle, `boundary-${i}`, 2));
    }
    const firstChunkSource = ids[0] as ElementId;
    const secondChunkSource = ids[902] as ElementId; // index >= 900
    const midSource = ids[500] as ElementId;
    // First chunk: read-point fully read (index 1 of 2 → 100%).
    setReadPoint(handle, firstChunkSource, 1);
    // Second chunk (index >= 900): read-point at first block (index 0 of 2 → 50%)
    // plus a card with a review so review-log rollup spans the boundary too.
    setReadPoint(handle, secondChunkSource, 0);
    const card = seedCard(handle, secondChunkSource, { stability: CARD_MATURE_STABILITY_DAYS + 1 });
    seedReview(handle, card, 4321, "2024-01-01T00:00:00.000Z");

    const q = new SourceYieldQuery(handle.db);
    const rows = q.listSourceYield(ASOF, { limit: Number.MAX_SAFE_INTEGER }).rows;

    // Every live source resolved (no var-limit crash, chunked == single big read).
    expect(rows.length).toBe(COUNT);
    const byId = new Map(rows.map((r) => [r.source.id, r]));
    expect(byId.get(firstChunkSource)?.readPct).toBeCloseTo(1);
    expect(byId.get(secondChunkSource)?.readPct).toBeCloseTo(0.5);
    expect(byId.get(secondChunkSource)?.timeSpentMs).toBe(4321);
    expect(byId.get(secondChunkSource)?.reviewCount).toBe(1);
    expect(byId.get(secondChunkSource)?.cardsCreated).toBe(1);
    // A source with no read-point reads as 0 regardless of which chunk it's in.
    expect(byId.get(midSource)?.readPct).toBe(0);
  });
});
