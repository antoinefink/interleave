/**
 * WorkloadService tests (T081) — the composition seam over the pure projector.
 *
 * Pins:
 *  - the projection's BASELINE (`before`) is GROUNDED: the count of cards due at/before
 *    `asOf` in the projection equals what `QueueRepository.dueCards` / the analytics
 *    `dueCards` report for the SAME clock (the projection is grounded in the real reads,
 *    not a parallel guess);
 *  - the snapshot reads the live tables, excludes suspended/done/dismissed/deleted, and
 *    parked/suspended/done/dismissed/deleted rows, and the budget is the
 *    `dailyReviewBudget` setting;
 *  - `simulate` is read-only — it appends no `operation_log` row and changes no due date;
 *  - a retention lever raises near-window load over seeded data without mutating it.
 */

import type { ElementId, IsoTimestamp, ReviewRating } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { CardSchedulerService } from "@interleave/scheduler";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsService } from "./analytics-query";
import { CardEditService } from "./card-edit-service";
import { createRepositories, type Repositories } from "./index";
import { OperationLogRepository } from "./operation-log-repository";
import { QueueRepository } from "./queue-repository";
import { createInMemoryDb } from "./test-db";
import { WorkloadService } from "./workload-service";

let handle: DbHandle;
let repos: Repositories;
let service: WorkloadService;
let queue: QueueRepository;
let analytics: AnalyticsService;
let cardEdit: CardEditService;
let opLog: OperationLogRepository;
const scheduler = new CardSchedulerService({ desiredRetention: 0.9, enableFuzz: false });

const NOW = "2027-06-01T12:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  service = new WorkloadService(handle.db);
  queue = new QueueRepository(handle.db);
  analytics = new AnalyticsService(handle.db);
  cardEdit = new CardEditService(handle.db);
  opLog = new OperationLogRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Create a card and grade it `n` times so it has a `review_states` due date + memory. */
function makeCardWithReviews(
  n: number,
  opts: { gapDays?: number; rating?: ReviewRating; priority?: number; title?: string } = {},
): ElementId {
  const gap = opts.gapDays ?? 3;
  const rating = opts.rating ?? "good";
  const cardId = repos.review.createCard({
    kind: "qa",
    title: opts.title ?? "Card",
    priority: opts.priority ?? 0.5,
    prompt: "Q",
    answer: "A",
  }).element.id;
  // Grade leading up to NOW so the latest due date straddles the projection window.
  let now = Date.parse(NOW) - n * gap * 86_400_000;
  for (let i = 0; i < n; i += 1) {
    const state = repos.review.findReviewState(cardId);
    if (!state) throw new Error("missing review state");
    const iso = new Date(now).toISOString();
    const outcome = scheduler.gradeCard(state, rating, iso as IsoTimestamp, 1200);
    repos.review.recordReview(cardId, outcome);
    now += gap * 86_400_000;
  }
  return cardId;
}

describe("WorkloadService — baseline grounding", () => {
  it("the projection baseline due-at-now count equals QueueRepository.dueCards for the same clock", () => {
    // Short intervals (graded `again`) → overdue; long interval (`easy`) → future-due.
    makeCardWithReviews(3, { gapDays: 1, rating: "again", title: "overdue-a" });
    makeCardWithReviews(3, { gapDays: 1, rating: "again", title: "overdue-b" });
    makeCardWithReviews(5, { gapDays: 30, rating: "easy", title: "future" });

    const dueNow = queue.dueCards(NOW).length;
    const analyticsDue = analytics.computeAnalytics(NOW).dueCards;
    expect(analyticsDue).toBe(dueNow); // the two reads already agree (sanity)

    // The projection's day-0 bucket counts cards due at/before NOW (overdue clamp to day
    // 0), so it must equal the queue's due-now count — the baseline is GROUNDED.
    const projection = service.simulate(
      { kind: "addCards", count: 0, priority: 0.5 },
      { asOf: NOW, windowDays: 30 },
    );
    expect(projection.days[0]?.before).toBe(dueNow);
  });

  it("excludes suspended cards from the baseline (matches the queue filter)", () => {
    const a = makeCardWithReviews(3, { gapDays: 1, rating: "again", title: "due-a" });
    makeCardWithReviews(3, { gapDays: 1, rating: "again", title: "due-b" });

    const total = (asOf: IsoTimestamp): number =>
      service
        .simulate({ kind: "addCards", count: 0, priority: 0.5 }, { asOf, windowDays: 30 })
        .days.reduce((s, d) => s + d.before, 0);

    const before = total(NOW);
    cardEdit.suspend(a);
    const after = total(NOW);
    expect(after).toBe(before - 1);
    // And it agrees with the queue read after suspension.
    expect(after).toBe(queue.dueCards(NOW).length);
  });

  it("excludes parked cards and attention items from the snapshot baseline", () => {
    const cardId = makeCardWithReviews(3, { gapDays: 1, rating: "again", title: "due-card" });
    const attentionId = repos.elements.create({
      type: "extract",
      status: "scheduled",
      stage: "raw_extract",
      priority: 0.6,
      title: "Due attention",
      dueAt: NOW,
    }).id;

    const before = service.buildSnapshot(NOW);
    expect(before.cards.map((card) => card.id)).toContain(cardId);
    expect(before.attention.map((item) => item.id)).toContain(attentionId);

    repos.elements.update(cardId, { status: "parked", parkedAt: NOW, dueAt: null });
    repos.elements.update(attentionId, { status: "parked", parkedAt: NOW });

    const after = service.buildSnapshot(NOW);
    expect(after.cards.map((card) => card.id)).not.toContain(cardId);
    expect(after.attention.map((item) => item.id)).not.toContain(attentionId);
  });

  it("the snapshot budget is the dailyReviewBudget setting", () => {
    repos.settings.updateAppSettings({ dailyReviewBudget: 42 });
    const projection = service.simulate(
      { kind: "addCards", count: 0, priority: 0.5 },
      { asOf: NOW },
    );
    expect(projection.budget).toBe(42);
  });

  it("simulate is read-only — it appends no operation_log row and changes no due date", () => {
    const cardId = makeCardWithReviews(4, { gapDays: 5, rating: "good" });
    const dueBefore = repos.review.findReviewState(cardId)?.dueAt;
    const opsBefore = opLog.count();

    service.simulate(
      { kind: "retention", scope: "global", target: 0.97 },
      { asOf: NOW, windowDays: 30 },
    );

    expect(repos.review.findReviewState(cardId)?.dueAt).toBe(dueBefore); // no mutation
    expect(opLog.count()).toBe(opsBefore); // no op appended
  });
});

describe("WorkloadService — levers over seeded data", () => {
  it("raising the global retention raises near-window load without mutating due dates", () => {
    const cardId = makeCardWithReviews(6, { gapDays: 20, rating: "easy" });
    const dueBefore = repos.review.findReviewState(cardId)?.dueAt;

    const projection = service.simulate(
      { kind: "retention", scope: "global", target: 0.97 },
      { asOf: NOW, windowDays: 120 },
    );
    const nearBefore = projection.days.slice(0, 21).reduce((s, d) => s + d.before, 0);
    const nearAfter = projection.days.slice(0, 21).reduce((s, d) => s + d.after, 0);
    expect(nearAfter).toBeGreaterThanOrEqual(nearBefore);

    expect(repos.review.findReviewState(cardId)?.dueAt).toBe(dueBefore); // preview only
  });
});
