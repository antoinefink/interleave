import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewLogs } from "@interleave/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { newReviewLogId } from "./ids";
import { LIVE_CARD_STATUSES, liveCardLapseWhere, windowStart } from "./lapse-window";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const AS_OF = "2026-06-12T12:00:00.000Z" as IsoTimestamp;
const WINDOW_DAYS = 30;

function daysAgo(days: number): IsoTimestamp {
  return new Date(Date.parse(AS_OF) - days * 86_400_000).toISOString() as IsoTimestamp;
}

function seedCard(): ElementId {
  const repo = new ElementRepository(handle.db);
  const card = repo.create({
    type: "card",
    status: "active",
    stage: "active_card",
    priority: 0.5,
    title: "Card",
  });
  handle.db.insert(cards).values({ elementId: card.id, kind: "qa", isRetired: false }).run();
  return card.id;
}

function seedLog(
  cardId: ElementId,
  reviewedAt: IsoTimestamp,
  options: {
    prevLapses?: number | null;
    nextLapses?: number | null;
    marker?: boolean;
  } = {},
): void {
  handle.db
    .insert(reviewLogs)
    .values({
      id: newReviewLogId(),
      elementId: cardId,
      rating: options.marker ? "good" : "again",
      reviewedAt,
      responseMs: 1000,
      prevState: "review",
      nextState: options.marker ? "review" : "relearning",
      nextStability: 1,
      nextDifficulty: 5,
      nextDueAt: reviewedAt,
      prevLapses: "prevLapses" in options ? options.prevLapses : 0,
      nextLapses: "nextLapses" in options ? options.nextLapses : 1,
      ...(options.marker
        ? { editMarkerAt: reviewedAt, editClass: "substantive", editChoice: "re_stabilize" }
        : {}),
    })
    .run();
}

function sumLapses(since: IsoTimestamp): number {
  const row = handle.db
    .select({ value: sql<number>`sum(${reviewLogs.nextLapses} - ${reviewLogs.prevLapses})` })
    .from(reviewLogs)
    .innerJoin(elements, eq(elements.id, reviewLogs.elementId))
    .innerJoin(cards, eq(cards.elementId, elements.id))
    .where(liveCardLapseWhere(since, AS_OF))
    .get();
  return Number(row?.value ?? 0);
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("windowStart", () => {
  it("returns asOf minus windowDays as an ISO timestamp", () => {
    expect(windowStart(AS_OF, WINDOW_DAYS)).toBe(daysAgo(30));
  });

  it("throws on an unparseable asOf", () => {
    expect(() => windowStart("not-a-date" as IsoTimestamp, WINDOW_DAYS)).toThrow(
      /Invalid asOf timestamp/,
    );
  });
});

describe("LIVE_CARD_STATUSES", () => {
  it("is exactly active + scheduled (the in-rotation statuses)", () => {
    expect([...LIVE_CARD_STATUSES]).toEqual(["active", "scheduled"]);
  });
});

describe("liveCardLapseWhere", () => {
  it("counts a lapse stamped exactly at the window start and at asOf (inclusive bounds)", () => {
    const card = seedCard();
    const since = windowStart(AS_OF, WINDOW_DAYS);
    seedLog(card, since, { prevLapses: 0, nextLapses: 1 }); // exactly at `since`
    seedLog(card, AS_OF, { prevLapses: 1, nextLapses: 2 }); // exactly at `asOf`
    expect(sumLapses(since)).toBe(2);
  });

  it("excludes a lapse stamped just before the window start", () => {
    const card = seedCard();
    const since = windowStart(AS_OF, WINDOW_DAYS);
    seedLog(card, daysAgo(31), { prevLapses: 0, nextLapses: 1 });
    expect(sumLapses(since)).toBe(0);
  });

  it("excludes T125 marker rows even with a fabricated lapse increment", () => {
    const card = seedCard();
    const since = windowStart(AS_OF, WINDOW_DAYS);
    seedLog(card, daysAgo(1), { prevLapses: 0, nextLapses: 5, marker: true });
    expect(sumLapses(since)).toBe(0);
  });

  it("ignores non-incrementing rows and is NULL-safe for legacy lapse columns", () => {
    const card = seedCard();
    const since = windowStart(AS_OF, WINDOW_DAYS);
    seedLog(card, daysAgo(2), { prevLapses: 2, nextLapses: 2 }); // no increment
    seedLog(card, daysAgo(3), { prevLapses: null, nextLapses: null }); // legacy NULL
    expect(sumLapses(since)).toBe(0);
  });

  it("ignores retired and soft-deleted cards", () => {
    const since = windowStart(AS_OF, WINDOW_DAYS);
    const retired = seedCard();
    handle.db.update(cards).set({ isRetired: true }).where(eq(cards.elementId, retired)).run();
    seedLog(retired, daysAgo(1), { prevLapses: 0, nextLapses: 1 });

    const deleted = seedCard();
    handle.db
      .update(elements)
      .set({ deletedAt: daysAgo(1), status: "deleted" })
      .where(eq(elements.id, deleted))
      .run();
    seedLog(deleted, daysAgo(1), { prevLapses: 0, nextLapses: 1 });

    expect(sumLapses(since)).toBe(0);
  });
});
