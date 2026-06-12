import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewLogs } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DescendantHealthQuery,
  MIN_DESCENDANT_AFFECTED_CARD_COUNT,
  MIN_DESCENDANT_LAPSE_COUNT,
  MIN_DESCENDANT_LAPSE_RATE,
} from "./descendant-health-query";
import { ElementRepository } from "./element-repository";
import { newReviewLogId } from "./ids";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const AS_OF = "2026-06-12T12:00:00.000Z" as IsoTimestamp;
const SOURCE_PRIORITY = 0.5;

function daysAgo(days: number): IsoTimestamp {
  return new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString() as IsoTimestamp;
}

function seedSource(title: string): ElementId {
  return new ElementRepository(handle.db).create({
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: SOURCE_PRIORITY,
    title,
  }).id;
}

function seedCard(
  sourceId: ElementId,
  options: {
    status?: "active" | "scheduled" | "suspended";
    retired?: boolean;
    deletedAt?: IsoTimestamp | null;
  } = {},
): ElementId {
  const repo = new ElementRepository(handle.db);
  const card = repo.create({
    type: "card",
    status: options.status ?? "active",
    stage: "active_card",
    priority: SOURCE_PRIORITY,
    title: "Card",
    sourceId,
  });
  handle.db
    .insert(cards)
    .values({
      elementId: card.id,
      kind: "qa",
      isRetired: options.retired ?? false,
    })
    .run();
  if (options.deletedAt) {
    handle.db
      .update(elements)
      .set({ deletedAt: options.deletedAt, status: "deleted" })
      .where(eq(elements.id, card.id))
      .run();
  }
  return card.id;
}

function seedLapseLog(
  cardId: ElementId,
  reviewedAt: IsoTimestamp,
  options: { prevLapses?: number | null; nextLapses?: number | null } = {},
): void {
  handle.db
    .insert(reviewLogs)
    .values({
      id: newReviewLogId(),
      elementId: cardId,
      rating: "again",
      reviewedAt,
      responseMs: 1000,
      prevState: "review",
      nextState: "relearning",
      nextStability: 1,
      nextDifficulty: 5,
      nextDueAt: reviewedAt,
      prevLapses: options.prevLapses ?? 0,
      nextLapses: options.nextLapses ?? 1,
    })
    .run();
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("DescendantHealthQuery.getSourceDescendantHealth", () => {
  it("counts true in-window lapse increments across live descendant cards", () => {
    const sourceId = seedSource("Source");
    const cardA = seedCard(sourceId, { status: "active" });
    const cardB = seedCard(sourceId, { status: "scheduled" });
    const cardC = seedCard(sourceId, { status: "active" });

    seedLapseLog(cardA, daysAgo(2), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(cardA, daysAgo(1), { prevLapses: 1, nextLapses: 3 });
    seedLapseLog(cardB, daysAgo(3), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(cardC, daysAgo(4), { prevLapses: 2, nextLapses: 2 });
    seedLapseLog(cardB, daysAgo(31), { prevLapses: 1, nextLapses: 2 });

    expect(
      new DescendantHealthQuery(handle.db).getSourceDescendantHealth({ sourceId, asOf: AS_OF }),
    ).toEqual({
      descendantLapseCount: 4,
      affectedCardCount: 2,
      descendantCardCount: 3,
      descendantLapseRate: 4 / 3,
    });
  });

  it("ignores soft-deleted, suspended, and retired descendant cards", () => {
    const sourceId = seedSource("Source");
    const activeA = seedCard(sourceId);
    const activeB = seedCard(sourceId, { status: "scheduled" });
    const suspended = seedCard(sourceId, { status: "suspended" });
    const retired = seedCard(sourceId, { retired: true });
    const deleted = seedCard(sourceId, { deletedAt: daysAgo(1) });

    seedLapseLog(activeA, daysAgo(2), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(activeA, daysAgo(1), { prevLapses: 1, nextLapses: 2 });
    seedLapseLog(activeB, daysAgo(3), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(suspended, daysAgo(2), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(retired, daysAgo(2), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(deleted, daysAgo(2), { prevLapses: 0, nextLapses: 1 });

    expect(
      new DescendantHealthQuery(handle.db).getSourceDescendantHealth({ sourceId, asOf: AS_OF }),
    ).toEqual({
      descendantLapseCount: 3,
      affectedCardCount: 2,
      descendantCardCount: 2,
      descendantLapseRate: 1.5,
    });
  });

  it("returns null below the lapse-count, affected-card, and lapse-rate floors", () => {
    const belowLapses = seedSource("Below lapses");
    const lapseCardA = seedCard(belowLapses);
    const lapseCardB = seedCard(belowLapses);
    seedLapseLog(lapseCardA, daysAgo(1), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(lapseCardB, daysAgo(2), { prevLapses: 0, nextLapses: 1 });
    expect(
      new DescendantHealthQuery(handle.db).getSourceDescendantHealth({
        sourceId: belowLapses,
        asOf: AS_OF,
      }),
    ).toBeNull();

    const belowAffectedCards = seedSource("Below affected");
    const affectedCard = seedCard(belowAffectedCards);
    seedLapseLog(affectedCard, daysAgo(1), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(affectedCard, daysAgo(2), { prevLapses: 1, nextLapses: 2 });
    seedLapseLog(affectedCard, daysAgo(3), { prevLapses: 2, nextLapses: 3 });
    expect(
      new DescendantHealthQuery(handle.db).getSourceDescendantHealth({
        sourceId: belowAffectedCards,
        asOf: AS_OF,
      }),
    ).toBeNull();

    const belowRate = seedSource("Below rate");
    const rateCards = Array.from({ length: 31 }, () => seedCard(belowRate));
    rateCards.slice(0, 3).forEach((cardId, index) => {
      seedLapseLog(cardId, daysAgo(index + 1), { prevLapses: 0, nextLapses: 1 });
    });
    expect(
      new DescendantHealthQuery(handle.db).getSourceDescendantHealth({
        sourceId: belowRate,
        asOf: AS_OF,
      }),
    ).toBeNull();

    expect(MIN_DESCENDANT_LAPSE_COUNT).toBe(3);
    expect(MIN_DESCENDANT_AFFECTED_CARD_COUNT).toBe(2);
    expect(MIN_DESCENDANT_LAPSE_RATE).toBe(0.1);
  });

  it("preserves source_id scope and ignores other sources' descendant reviews", () => {
    const sourceA = seedSource("A");
    const sourceB = seedSource("B");
    const cardA = seedCard(sourceA);
    const cardB1 = seedCard(sourceB);
    const cardB2 = seedCard(sourceB);

    seedLapseLog(cardA, daysAgo(1), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(cardB1, daysAgo(1), { prevLapses: 0, nextLapses: 1 });
    seedLapseLog(cardB1, daysAgo(2), { prevLapses: 1, nextLapses: 2 });
    seedLapseLog(cardB2, daysAgo(3), { prevLapses: 0, nextLapses: 1 });

    const query = new DescendantHealthQuery(handle.db);
    expect(query.getSourceDescendantHealth({ sourceId: sourceA, asOf: AS_OF })).toBeNull();
    expect(query.getSourceDescendantHealth({ sourceId: sourceB, asOf: AS_OF })).toEqual({
      descendantLapseCount: 3,
      affectedCardCount: 2,
      descendantCardCount: 2,
      descendantLapseRate: 1.5,
    });
  });

  it("sees review logs inserted earlier in the same transaction", () => {
    const sourceId = seedSource("Transactional");
    const cardA = seedCard(sourceId);
    const cardB = seedCard(sourceId);
    const cardC = seedCard(sourceId);

    const result = handle.db.transaction((tx) => {
      tx.insert(reviewLogs)
        .values([
          {
            id: newReviewLogId(),
            elementId: cardA,
            rating: "again",
            reviewedAt: daysAgo(1),
            responseMs: 1000,
            prevState: "review",
            nextState: "relearning",
            nextStability: 1,
            nextDifficulty: 5,
            nextDueAt: daysAgo(1),
            prevLapses: 0,
            nextLapses: 1,
          },
          {
            id: newReviewLogId(),
            elementId: cardB,
            rating: "again",
            reviewedAt: daysAgo(2),
            responseMs: 1000,
            prevState: "review",
            nextState: "relearning",
            nextStability: 1,
            nextDifficulty: 5,
            nextDueAt: daysAgo(2),
            prevLapses: 0,
            nextLapses: 1,
          },
          {
            id: newReviewLogId(),
            elementId: cardC,
            rating: "again",
            reviewedAt: daysAgo(3),
            responseMs: 1000,
            prevState: "review",
            nextState: "relearning",
            nextStability: 1,
            nextDifficulty: 5,
            nextDueAt: daysAgo(3),
            prevLapses: 0,
            nextLapses: 1,
          },
        ])
        .run();

      return new DescendantHealthQuery(tx).getSourceDescendantHealth({ sourceId, asOf: AS_OF });
    });

    expect(result).toEqual({
      descendantLapseCount: 3,
      affectedCardCount: 3,
      descendantCardCount: 3,
      descendantLapseRate: 1,
    });
  });
});
