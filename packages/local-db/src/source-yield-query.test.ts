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

import type { BlockId, ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, reviewLogs, reviewStates } from "@interleave/db";
import { CARD_MATURE_STABILITY_DAYS } from "@interleave/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
function seedExtract(handle: DbHandle, sourceId: ElementId): ElementId {
  const el = new ElementRepository(handle.db).create({
    type: "extract",
    status: "active",
    stage: "raw_extract",
    priority: 0.5,
    title: "Extract",
    sourceId,
  });
  return el.id;
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
