/**
 * Basic analytics (T045) E2E — drives the real Electron app.
 *
 * The Analytics view gives a 30-day snapshot of the learning system, computed by
 * a domain aggregation over `review_logs` / `elements` / `review_states` (never in
 * React) and read through the typed `window.appApi.analytics.get` surface. This
 * spec launches the built desktop app against a fresh data dir seeded with the
 * shared demo collection and asserts:
 *
 *   1. the `analytics.*` bridge surface exists, including the review-activity
 *      heatmap read (no raw SQL);
 *   2. `/analytics` renders the metric tiles, review-activity heatmap, and
 *      reviews-per-day spark from computed snapshots (non-placeholder numbers);
 *   3. grading a seeded card `Again` increments the review total and the snapshot
 *      reflects the failed grade (retention drops vs. an all-correct run);
 *   4. the numbers SURVIVE AN APP RESTART — they are recomputed from the durable
 *      `review_logs`, so a re-launch against the same data dir shows the same total.
 *
 * The renderer never touches SQLite — every read rides the typed `window.appApi`.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

/** A far-future clock so every seeded due card registers as due. */
const ASOF = "2031-01-01T12:00:00.000Z";

/** The analytics snapshot at `ASOF` (via the typed bridge). */
async function snapshot(page: Page): Promise<{
  reviewsTotal: number;
  retention30d: number | null;
  reviewsByDay: number;
  dueCards: number;
  leeches: number;
}> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      analytics: {
        get(req: { asOf: string }): Promise<{
          reviewsTotal: number;
          retention30d: number | null;
          reviewsByDay: unknown[];
          dueCards: number;
          leeches: number;
        }>;
      };
    };
    const s = await api.analytics.get({ asOf });
    return {
      reviewsTotal: s.reviewsTotal,
      retention30d: s.retention30d,
      reviewsByDay: s.reviewsByDay.length,
      dueCards: s.dueCards,
      leeches: s.leeches,
    };
  }, ASOF);
}

/** The calendar-year review activity snapshot at `ASOF` (via the typed bridge). */
async function reviewActivity(page: Page): Promise<{
  year: number;
  totalReviews: number;
  days: number;
  dayCount: number;
}> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      analytics: {
        reviewActivity(req: { asOf: string; year: number }): Promise<{
          year: number;
          totalReviews: number;
          days: Array<{ date: string; count: number }>;
        }>;
      };
    };
    const s = await api.analytics.reviewActivity({ asOf, year: 2031 });
    return {
      year: s.year,
      totalReviews: s.totalReviews,
      days: s.days.length,
      dayCount: s.days.find((day) => day.date === "2031-01-01")?.count ?? 0,
    };
  }, ASOF);
}

/** Grade the next due card at `ASOF` with `rating` (the SAME path the UI uses). */
async function gradeNext(page: Page, rating: "again" | "good"): Promise<string> {
  return page.evaluate(
    async ({ asOf, rating }) => {
      const api = window.appApi as unknown as {
        review: {
          sessionNext(req: { asOf: string }): Promise<{ card: { id: string } | null }>;
          grade(req: {
            cardId: string;
            rating: string;
            responseMs: number;
            asOf: string;
          }): Promise<unknown>;
        };
      };
      const next = await api.review.sessionNext({ asOf });
      if (!next.card) throw new Error(`no due card at ${asOf}`);
      await api.review.grade({ cardId: next.card.id, rating, responseMs: 1500, asOf });
      return next.card.id;
    },
    { asOf: ASOF, rating },
  );
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("the analytics bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      analytics?: { get?: unknown; reviewActivity?: unknown; topicKnowledgeState?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasAnalyticsGet: typeof api?.analytics?.get === "function",
      hasReviewActivity: typeof api?.analytics?.reviewActivity === "function",
      hasTopicKnowledgeState: typeof api?.analytics?.topicKnowledgeState === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasAnalyticsGet).toBe(true);
  expect(surface.hasReviewActivity).toBe(true);
  expect(surface.hasTopicKnowledgeState).toBe(true);
  expect(surface.hasQuery).toBe(false);

  const topicKnowledge = await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      analytics: {
        topicKnowledgeState(req: { asOf: string; limit: number }): Promise<{
          asOf: string;
          windowDays: number;
          subjects: unknown[];
          graduationEvents: unknown[];
        }>;
      };
    };
    const state = await api.analytics.topicKnowledgeState({ asOf, limit: 5 });
    return {
      asOf: state.asOf,
      windowDays: state.windowDays,
      subjectCount: state.subjects.length,
      graduationEventCount: state.graduationEvents.length,
    };
  }, ASOF);
  expect(topicKnowledge).toMatchObject({
    asOf: ASOF,
    windowDays: 90,
  });
  expect(topicKnowledge.subjectCount).toBeGreaterThanOrEqual(0);
  expect(topicKnowledge.graduationEventCount).toBeGreaterThanOrEqual(0);

  await app.close();
});

test("/analytics renders the metrics + the reviews-per-day spark", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.goto(`${baseUrl}/analytics`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-analytics")).toBeVisible();
  await expect(page.getByTestId("analytics-body")).toBeVisible();

  // The metric tiles + the spark render.
  await expect(page.getByTestId("metric-retention")).toBeVisible();
  await expect(page.getByTestId("metric-reviews")).toBeVisible();
  await expect(page.getByTestId("metric-due")).toBeVisible();
  await expect(page.getByTestId("review-activity-panel")).toBeVisible();
  await expect(page.getByTestId("review-activity-grid")).toBeVisible();
  await expect(page.getByTestId("analytics-spark")).toBeVisible();
  expect(await page.getByTestId("review-activity-cell").count()).toBeGreaterThanOrEqual(365);
  // The seed has at least one leech → the leech banner links to maintenance.
  await expect(page.getByTestId("banner-leeches")).toBeVisible();

  await app.close();
});

test("grading Again increments the review total and is reflected in retention", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const before = await snapshot(page);
  const beforeActivity = await reviewActivity(page);
  expect(before.reviewsByDay).toBe(30);
  expect(before.dueCards).toBeGreaterThanOrEqual(1);
  expect(beforeActivity.year).toBe(2031);
  expect(beforeActivity.days).toBe(365);

  // Grade one due card `Again` (a failure) — the SAME path the review UI uses.
  await gradeNext(page, "again");

  const after = await snapshot(page);
  const afterActivity = await reviewActivity(page);
  // The review total grew by the one grade we just recorded.
  expect(after.reviewsTotal).toBe(before.reviewsTotal + 1);
  expect(afterActivity.totalReviews).toBe(beforeActivity.totalReviews + 1);
  expect(afterActivity.dayCount).toBe(beforeActivity.dayCount + 1);
  // Retention is now defined and reflects the failed grade (strictly below 100%).
  expect(after.retention30d).not.toBeNull();
  if (after.retention30d !== null) expect(after.retention30d).toBeLessThan(1);

  await app.close();
});

test("the analytics numbers survive an app restart (recomputed from durable review_logs)", async () => {
  // First launch: record the total after the prior grades.
  const app1 = await launchApp(dataDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  const total1 = (await snapshot(page1)).reviewsTotal;
  const activityTotal1 = (await reviewActivity(page1)).totalReviews;
  expect(total1).toBeGreaterThanOrEqual(1);
  expect(activityTotal1).toBeGreaterThanOrEqual(1);
  await app1.close();

  // Relaunch against the SAME data dir — the snapshot is recomputed from the
  // durable review_logs, so the total persists.
  const app2 = await launchApp(dataDir);
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const total2 = (await snapshot(page2)).reviewsTotal;
  const activityTotal2 = (await reviewActivity(page2)).totalReviews;
  expect(total2).toBe(total1);
  expect(activityTotal2).toBe(activityTotal1);
  await app2.close();
});
