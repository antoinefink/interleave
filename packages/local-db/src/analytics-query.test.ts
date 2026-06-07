/**
 * AnalyticsService tests (T045 — the system-wide learning-health snapshot).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB. They pin
 * the aggregation contract the screen + T046's balance banner depend on:
 *  - `reviewsByDay` buckets `review_logs` by LOCAL calendar day, one bar per day;
 *  - `reviewsTotal` / `reviewsPerDayAvg` over the window;
 *  - `retention30d` = fraction of window reviews NOT graded `again` (e.g. 8/10);
 *  - `newCards` / `newExtracts` by `createdAt` (throughput, counts later-deleted);
 *  - `deletions` by `deletedAt` in the window;
 *  - `dueCards` / `dueTopics` from the two schedulers;
 *  - `leeches` from the durable flag;
 *  - the window boundary (a review just outside the window is excluded);
 *  - the empty case (`retention30d = null`).
 *
 * Timestamps are seeded directly via `db.update` so the window boundary is exact
 * and timezone-independent (local-noon instants keep a calendar day stable).
 */

import type { ElementId, IsoTimestamp, ReviewRating } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, reviewLogs, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsService } from "./analytics-query";
import { ElementRepository } from "./element-repository";
import { newReviewLogId } from "./ids";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

/** A local-noon ISO instant `daysAgo` days before `asOf` (stable calendar day). */
function localNoon(asOf: Date, daysAgo: number): IsoTimestamp {
  const d = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() - daysAgo, 12, 0, 0, 0);
  return d.toISOString() as IsoTimestamp;
}

/** A local-calendar instant for exact boundary tests. */
function localInstant(
  year: number,
  month: number,
  day: number,
  hour = 12,
  minute = 0,
): IsoTimestamp {
  return new Date(year, month, day, hour, minute, 0, 0).toISOString() as IsoTimestamp;
}

/** Insert a `card` element + side rows, with an explicit `createdAt`. */
function seedCard(
  handle: DbHandle,
  createdAt: IsoTimestamp,
  opts: { leech?: boolean } = {},
): ElementId {
  const repo = new ElementRepository(handle.db);
  const el = repo.create({
    type: "card",
    status: "active",
    stage: "active_card",
    priority: 0.5,
    title: "Card",
  });
  handle.db
    .update(elements)
    .set({ createdAt, updatedAt: createdAt })
    .where(eq(elements.id, el.id))
    .run();
  handle.db
    .insert(cards)
    .values({ elementId: el.id, kind: "qa", isLeech: opts.leech ?? false })
    .run();
  handle.db.insert(reviewStates).values({ elementId: el.id, fsrsState: "new" }).run();
  return el.id;
}

/** Insert an `extract` element with an explicit `createdAt`. */
function seedExtract(handle: DbHandle, createdAt: IsoTimestamp): ElementId {
  const repo = new ElementRepository(handle.db);
  const el = repo.create({
    type: "extract",
    status: "active",
    stage: "raw_extract",
    priority: 0.5,
    title: "Extract",
  });
  handle.db
    .update(elements)
    .set({ createdAt, updatedAt: createdAt })
    .where(eq(elements.id, el.id))
    .run();
  return el.id;
}

/** Append a `review_logs` row for a card with an explicit grade + time. */
function seedReview(
  handle: DbHandle,
  elementId: ElementId,
  rating: ReviewRating,
  reviewedAt: IsoTimestamp,
): void {
  handle.db
    .insert(reviewLogs)
    .values({
      id: newReviewLogId(),
      elementId,
      rating,
      reviewedAt,
      responseMs: 1000,
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

describe("AnalyticsService.computeAnalytics", () => {
  it("aggregates reviews, retention, throughput, due counts, deletions, and leeches", () => {
    const asOf = new Date(2026, 4, 30, 18, 0, 0); // local 2026-05-30 18:00
    const asOfIso = asOf.toISOString() as IsoTimestamp;
    const card = seedCard(handle, localNoon(asOf, 5));

    // 10 reviews across 4 days; 2 are `again` → retention = 8/10 = 0.8.
    seedReview(handle, card, "good", localNoon(asOf, 0));
    seedReview(handle, card, "easy", localNoon(asOf, 0));
    seedReview(handle, card, "again", localNoon(asOf, 1));
    seedReview(handle, card, "good", localNoon(asOf, 1));
    seedReview(handle, card, "hard", localNoon(asOf, 1));
    seedReview(handle, card, "again", localNoon(asOf, 2));
    seedReview(handle, card, "good", localNoon(asOf, 2));
    seedReview(handle, card, "good", localNoon(asOf, 3));
    seedReview(handle, card, "good", localNoon(asOf, 3));
    seedReview(handle, card, "easy", localNoon(asOf, 3));

    // 2 new cards + 1 new extract created in the window (counts the seed card too).
    seedCard(handle, localNoon(asOf, 2));
    seedExtract(handle, localNoon(asOf, 1));

    // A leech card (flagged) created in the window.
    seedCard(handle, localNoon(asOf, 4), { leech: true });

    // A soft-deleted element in the window (deletion).
    const repo = new ElementRepository(handle.db);
    const doomed = repo.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "Doomed",
    });
    repo.softDelete(doomed.id);
    // Pin createdAt explicitly (like every other seeded row) so the in-window
    // count is timezone/clock-independent — repo.create stamps the real wall
    // clock, which can fall past `asOf` and drop this out of the window.
    handle.db
      .update(elements)
      .set({ createdAt: localNoon(asOf, 1), deletedAt: localNoon(asOf, 1) })
      .where(eq(elements.id, doomed.id))
      .run();

    const summary = new AnalyticsService(handle.db).computeAnalytics(asOfIso, { windowDays: 30 });

    expect(summary.reviewsTotal).toBe(10);
    expect(summary.reviewsPerDayAvg).toBeCloseTo(10 / 30);
    expect(summary.retention30d).toBeCloseTo(0.8);

    // reviewsByDay has one bucket per window day, oldest first, summing to total.
    expect(summary.reviewsByDay).toHaveLength(30);
    expect(summary.reviewsByDay.reduce((a, b) => a + b.count, 0)).toBe(10);
    // The last 4 days (today back to 3 days ago) carry the reviews: 2,3,2,3.
    const tail = summary.reviewsByDay.slice(-4).map((d) => d.count);
    expect(tail).toEqual([3, 2, 3, 2]); // 3d ago, 2d, 1d, today

    // dayStreak: today has reviews, so streak counts back consecutive review days.
    expect(summary.dayStreak).toBe(4);

    // newCards counts: seed card (5d) + extra card (2d) + leech card (4d) = 3.
    expect(summary.newCards).toBe(3);
    // newExtracts: the in-window extract (1d) + the doomed extract (1d) = 2.
    expect(summary.newExtracts).toBe(2);

    expect(summary.deletions).toBe(1);
    expect(summary.leeches).toBe(1);
  });

  it("counts due cards and due topics from the two separate schedulers", () => {
    const asOf = new Date(2026, 4, 30, 18, 0, 0);
    const asOfIso = asOf.toISOString() as IsoTimestamp;
    const pastIso = localNoon(asOf, 1);

    // A due card: a card element + a due review_states row.
    const repo = new ElementRepository(handle.db);
    const cardEl = repo.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.5,
      title: "Due card",
    });
    handle.db.insert(cards).values({ elementId: cardEl.id, kind: "qa" }).run();
    handle.db
      .insert(reviewStates)
      .values({ elementId: cardEl.id, fsrsState: "review", dueAt: pastIso })
      .run();

    // A due topic: an extract element with a past `elements.due_at`.
    repo.create({
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.5,
      title: "Due extract",
      dueAt: pastIso,
    });

    const summary = new AnalyticsService(handle.db).computeAnalytics(asOfIso);
    expect(summary.dueCards).toBe(1);
    expect(summary.dueTopics).toBe(1);
  });

  it("excludes a review just outside the window boundary", () => {
    const asOf = new Date(2026, 4, 30, 18, 0, 0);
    const asOfIso = asOf.toISOString() as IsoTimestamp;
    const card = seedCard(handle, localNoon(asOf, 40));

    // Inside a 7-day window: 6 days ago (within). Outside: 7 days ago (the 8th day).
    seedReview(handle, card, "good", localNoon(asOf, 6));
    seedReview(handle, card, "good", localNoon(asOf, 7));

    const summary = new AnalyticsService(handle.db).computeAnalytics(asOfIso, { windowDays: 7 });
    expect(summary.reviewsTotal).toBe(1);
    expect(summary.reviewsByDay).toHaveLength(7);
  });

  it("returns retention30d = null and zero counts on an empty database", () => {
    const asOfIso = new Date(2026, 4, 30, 18, 0, 0).toISOString() as IsoTimestamp;
    const summary = new AnalyticsService(handle.db).computeAnalytics(asOfIso);
    expect(summary.reviewsTotal).toBe(0);
    expect(summary.retention30d).toBeNull();
    expect(summary.reviewsByDay).toHaveLength(30);
    expect(summary.reviewsByDay.every((d) => d.count === 0)).toBe(true);
    expect(summary.dueCards).toBe(0);
    expect(summary.dueTopics).toBe(0);
    expect(summary.newCards).toBe(0);
    expect(summary.deletions).toBe(0);
    expect(summary.leeches).toBe(0);
    expect(summary.dayStreak).toBe(0);
  });
});

describe("AnalyticsService.computeReviewActivity", () => {
  it("zero-fills a selected non-leap year and uses exclusive local-year bounds", () => {
    const asOf = localInstant(2026, 5, 15, 18);
    const card = seedCard(handle, localInstant(2026, 0, 1));

    seedReview(handle, card, "good", localInstant(2025, 11, 31, 23, 59));
    seedReview(handle, card, "good", localInstant(2026, 0, 1, 0));
    seedReview(handle, card, "hard", localInstant(2026, 5, 15, 12));
    seedReview(handle, card, "easy", localInstant(2026, 5, 15, 13));
    seedReview(handle, card, "good", localInstant(2026, 11, 31, 23, 59));
    seedReview(handle, card, "again", localInstant(2027, 0, 1, 0));

    const activity = new AnalyticsService(handle.db).computeReviewActivity(asOf, { year: 2026 });
    const counts = new Map(activity.days.map((day) => [day.date, day.count]));

    expect(activity.year).toBe(2026);
    expect(activity.days).toHaveLength(365);
    expect(activity.days[0]?.date).toBe("2026-01-01");
    expect(activity.days.at(-1)?.date).toBe("2026-12-31");
    expect(activity.reviewsTotal).toBe(4);
    expect(activity.maxDailyReviews).toBe(2);
    expect(counts.get("2026-01-01")).toBe(1);
    expect(counts.get("2026-06-15")).toBe(2);
    expect(counts.get("2026-12-31")).toBe(1);
    expect(activity.minYear).toBe(2025);
    expect(activity.maxYear).toBe(2027);
    expect(activity.previousYear).toBe(2025);
    expect(activity.nextYear).toBe(2027);
  });

  it("returns 366 buckets for leap years", () => {
    const asOf = localInstant(2026, 5, 15, 18);
    const card = seedCard(handle, localInstant(2024, 1, 29));
    seedReview(handle, card, "good", localInstant(2024, 1, 29));

    const activity = new AnalyticsService(handle.db).computeReviewActivity(asOf, { year: 2024 });
    const counts = new Map(activity.days.map((day) => [day.date, day.count]));

    expect(activity.year).toBe(2024);
    expect(activity.days).toHaveLength(366);
    expect(counts.get("2024-02-29")).toBe(1);
    expect(activity.reviewsTotal).toBe(1);
    expect(activity.minYear).toBe(2024);
    expect(activity.maxYear).toBe(2024);
    expect(activity.previousYear).toBeNull();
    expect(activity.nextYear).toBeNull();
  });

  it("defaults to asOf's local year and returns empty navigation for empty history", () => {
    const activity = new AnalyticsService(handle.db).computeReviewActivity(
      localInstant(2026, 11, 31, 23),
    );

    expect(activity.year).toBe(2026);
    expect(activity.days).toHaveLength(365);
    expect(activity.days.every((day) => day.count === 0)).toBe(true);
    expect(activity.reviewsTotal).toBe(0);
    expect(activity.maxDailyReviews).toBe(0);
    expect(activity.minYear).toBeNull();
    expect(activity.maxYear).toBeNull();
    expect(activity.previousYear).toBeNull();
    expect(activity.nextYear).toBeNull();
  });

  it("rejects years outside the four-digit heatmap date-key range", () => {
    const service = new AnalyticsService(handle.db);
    const asOf = localInstant(2026, 5, 15, 18);

    expect(() => service.computeReviewActivity(asOf, { year: 999 })).toThrow(RangeError);
    expect(() => service.computeReviewActivity(asOf, { year: 9999 })).toThrow(RangeError);
  });

  it("derives min, max, previous, and next years from sparse local-year history", () => {
    const asOf = localInstant(2026, 5, 15, 18);
    const card = seedCard(handle, localInstant(2020, 0, 1));
    seedReview(handle, card, "good", localInstant(2020, 0, 2));
    seedReview(handle, card, "hard", localInstant(2023, 6, 4));
    seedReview(handle, card, "easy", localInstant(2028, 9, 5));

    const activity = new AnalyticsService(handle.db).computeReviewActivity(asOf, { year: 2026 });

    expect(activity.days).toHaveLength(365);
    expect(activity.reviewsTotal).toBe(0);
    expect(activity.minYear).toBe(2020);
    expect(activity.maxYear).toBe(2028);
    expect(activity.previousYear).toBe(2023);
    expect(activity.nextYear).toBe(2028);
  });
});
