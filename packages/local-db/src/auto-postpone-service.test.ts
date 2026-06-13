/**
 * AutoPostponeService tests (T077 — the APPLY seam for the overload valve).
 *
 * These run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so behaviour
 * matches production exactly. They pin the contract:
 *
 *  - `preview` mutates NOTHING (no due-date change, no op appended);
 *  - `apply` postpones the planned items — low-priority topics first, then low-priority
 *    *mature* cards — leaving high-priority *fragile* cards due;
 *  - exactly ONE `reschedule_element` op per postponed item, all sharing ONE `batchId`;
 *  - cards defer on `review_states.due_at` (FSRS memory state — stability/difficulty/reps/
 *    lapses/fsrsState — UNCHANGED) while topics reschedule on `elements.due_at`;
 *  - NO `review_logs` row is written by the sweep (a postpone is not a graded review);
 *  - the two-scheduler split is never crossed (a card never lands on `scheduled`).
 */

import type { BlockId, ElementId, IsoTimestamp, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog, reviewLogs, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoPostponeService } from "./auto-postpone-service";
import { ElementRepository } from "./element-repository";
import { createRepositories } from "./index";
import { QueueQuery } from "./queue-query";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const NOW = "2027-06-01T12:00:00.000Z" as IsoTimestamp;
const OVERDUE = "2027-05-01T12:00:00.000Z" as IsoTimestamp;

/** Seed a topic (attention item) and force it overdue so it reads as due. */
function seedTopic(priority: Priority, title = "topic"): ElementId {
  const sources = new SourceRepository(handle.db);
  // A source is an attention item; use it as the low-priority "topic/source" victim.
  const { element } = sources.createWithDocument({
    title,
    priority,
    status: "scheduled",
    stage: "raw_source",
    body: "Body.",
  });
  new ElementRepository(handle.db).reschedule(element.id, OVERDUE);
  return element.id;
}

function seedExtract(priority: Priority, title = "extract"): ElementId {
  const repos = createRepositories(handle.db);
  const { element: source } = repos.sources.create({
    title: `${title} source`,
    priority,
    status: "active",
    stage: "raw_source",
  });
  const extract = repos.sources.createExtract({
    sourceElementId: source.id,
    title,
    priority,
    selectedText: "Selected text",
    blockIds: ["block-1" as BlockId],
    label: "p1",
  });
  repos.elements.update(extract.element.id, { status: "active", stage: "clean_extract" });
  repos.elements.reschedule(extract.element.id, OVERDUE);
  return extract.element.id;
}

/**
 * Seed a card with explicit FSRS state, made due (overdue) so it reads as a queue card.
 * `mature` ⇒ review phase + high stability; otherwise a fragile (learning) card.
 */
function seedCard(
  priority: Priority,
  opts: { mature: boolean; lapses?: number; title?: string },
): ElementId {
  const review = new ReviewRepository(handle.db);
  const { element } = review.createCard({
    kind: "qa",
    title: opts.title ?? "card",
    priority,
    prompt: "Q",
    answer: "A",
  });
  handle.db
    .update(reviewStates)
    .set({
      dueAt: OVERDUE,
      stability: opts.mature ? 90 : 2,
      fsrsState: opts.mature ? "review" : "learning",
      lapses: opts.lapses ?? 0,
      reps: opts.mature ? 5 : 1,
      lastReviewedAt: "2027-04-01T12:00:00.000Z",
    })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

/** Count ops of a given type for an element. */
function opCount(id: ElementId, opType: string): number {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, id))
    .all()
    .filter((op) => op.opType === opType).length;
}

/** The set of element ids currently due in the queue (at NOW). */
function dueIds(): Set<string> {
  const queue = new QueueQuery(createRepositories(handle.db));
  return new Set(queue.list({ asOf: NOW }).items.map((r) => r.id));
}

/**
 * Seed `n` HIGH-priority FRAGILE filler cards so a due set can exceed the daily budget
 * (which has a hard floor of {@link BUDGET_MIN}) WITHOUT those filler cards ever being
 * eligible victims — they are protected, so they only inflate `used`, never the plan.
 */
function seedProtectedFiller(n: number): ElementId[] {
  const ids: ElementId[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(seedCard(0.875, { mature: false, title: `filler ${i}` }));
  }
  return ids;
}

/** Build the service over the open DB. */
function service(): AutoPostponeService {
  return new AutoPostponeService(handle.db, createRepositories(handle.db));
}

const BUDGET_MINUTES = 20;

/** Set the daily review budget in estimated minutes. */
function setBudget(n: number): void {
  createRepositories(handle.db).settings.updateAppSettings({ dailyBudgetMinutes: n });
}

function setDistillationQuotaPercent(n: number): void {
  createRepositories(handle.db).settings.updateAppSettings({ distillationQuotaPercent: n });
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

// T115 defaults used here: a source costs 10 minutes, a QA card costs 2 minutes.
// Protected filler cards inflate due minutes without ever being eligible victims.

describe("AutoPostponeService.preview", () => {
  it("mutates nothing — no due-date change, no op appended", () => {
    setBudget(BUDGET_MINUTES);
    const topicLow = seedTopic(0.375, "low topic");
    const cardMature = seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const elements = new ElementRepository(handle.db);
    const beforeTopicDue = elements.findById(topicLow)?.dueAt;
    const beforeCardDue = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, cardMature))
      .get()?.dueAt;
    const beforeOps = handle.db.select().from(operationLog).all().length;

    const preview = service().preview({ asOf: NOW });
    expect(preview.willPostpone.length).toBe(2);
    expect(preview.overBudgetMinutes).toBe(10);
    expect(preview.usedMinutes).toBe(30);
    expect(preview.targetMinutes).toBe(BUDGET_MINUTES);
    expect(preview.remainingMinutesAfter).toBe(18);
    expect(preview.remainingAfter).toBe(9);
    expect(preview.willPostpone.map((row) => row.estimatedMinutes)).toEqual([10, 2]);

    // Nothing changed.
    expect(elements.findById(topicLow)?.dueAt).toBe(beforeTopicDue);
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, cardMature)).get()
        ?.dueAt,
    ).toBe(beforeCardDue);
    expect(handle.db.select().from(operationLog).all().length).toBe(beforeOps);
  });

  it("orders victims low-priority topics first, then low-priority mature cards", () => {
    setBudget(BUDGET_MINUTES);
    seedTopic(0.375, "low topic");
    seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const preview = service().preview({ asOf: NOW });
    const reasons = preview.willPostpone.map((r) => r.reason);
    expect(reasons[0]).toBe("low-priority-topic");
    expect(reasons[1]).toBe("low-priority-mature-card");
    // Each preview row reports a future toDueAt.
    for (const row of preview.willPostpone) {
      expect(Date.parse(row.toDueAt)).toBeGreaterThan(Date.parse(NOW));
    }
  });

  it("uses the filtered due universe for candidate minutes", () => {
    setBudget(BUDGET_MINUTES);
    seedTopic(0.375, "low source");
    seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const queue = new QueueQuery(createRepositories(handle.db));
    const sourceQueue = queue.list({
      asOf: NOW,
      filters: { types: ["source"] },
    });
    const preview = service().preview({ asOf: NOW, filters: { types: ["source"] } });

    expect(sourceQueue.timeCostSummary.pricedItemCount).toBe(1);
    expect(preview.usedMinutes).toBe(10);
    expect(preview.usedMinutes).toBeGreaterThan(0);
    expect(preview.usedMinutes).toBeLessThan(BUDGET_MINUTES);
    expect(preview.willPostpone).toEqual([]);
  });

  it("does not postpone due extract distillation below the protected floor", () => {
    setBudget(BUDGET_MINUTES);
    setDistillationQuotaPercent(50);
    const extract = seedExtract(0.375, "protected extract");
    seedTopic(0.375, "low source");
    seedProtectedFiller(9);

    const preview = service().preview({ asOf: NOW });

    expect(preview.distillationFloor).toMatchObject({
      quotaFloorMinutes: 10,
      dueDistillationMinutes: 6,
      postponedDistillationMinutes: 0,
      remainingDueDistillationMinutesAfter: 6,
    });
    expect(preview.willPostpone.map((row) => row.id)).not.toContain(extract);
  });
});

describe("AutoPostponeService.apply", () => {
  it("postpones planned items under ONE batchId, exactly one reschedule_element op each", () => {
    setBudget(BUDGET_MINUTES);
    const topicLow = seedTopic(0.375, "low topic");
    const cardMature = seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const beforeTopicOps = opCount(topicLow, "reschedule_element");
    const beforeCardOps = opCount(cardMature, "reschedule_element");

    const result = service().apply({ asOf: NOW });
    expect(result.postponed).toBe(2);
    expect(result.postponedMinutes).toBe(12);
    expect(result.remainingMinutesAfter).toBe(18);
    expect(result.batchId).toBeTruthy();

    // Exactly one reschedule_element op per item.
    expect(opCount(topicLow, "reschedule_element")).toBe(beforeTopicOps + 1);
    expect(opCount(cardMature, "reschedule_element")).toBe(beforeCardOps + 1);

    // The TWO postpone ops (on our victims) carry the SAME batchId (the whole sweep undoes
    // as one). The payload is stored as a JSON string, so parse it. Filter to the victims
    // so the seed's own reschedule ops don't confuse this.
    const batchIds = handle.db
      .select()
      .from(operationLog)
      .all()
      .filter((op) => op.opType === "reschedule_element")
      .map((op) => JSON.parse(op.payload as string) as { postpone?: boolean; batchId?: string })
      .filter((p) => p.postpone === true)
      .map((p) => p.batchId);
    expect(batchIds).toEqual([result.batchId, result.batchId]);

    // Both left the due set.
    const due = dueIds();
    expect(due.has(topicLow)).toBe(false);
    expect(due.has(cardMature)).toBe(false);
  });

  it("keeps protected extract distillation due after applying the sweep", () => {
    setBudget(BUDGET_MINUTES);
    setDistillationQuotaPercent(50);
    const extract = seedExtract(0.375, "protected extract");
    const source = seedTopic(0.375, "low source");
    seedProtectedFiller(9);

    const result = service().apply({ asOf: NOW });

    expect(result.distillationFloor).toMatchObject({
      quotaFloorMinutes: 10,
      dueDistillationMinutes: 6,
      postponedDistillationMinutes: 0,
      remainingDueDistillationMinutesAfter: 6,
    });
    expect(result.postponed).toBe(1);
    const due = dueIds();
    expect(due.has(extract)).toBe(true);
    expect(due.has(source)).toBe(false);
  });

  it("defers a card on review_states.due_at WITHOUT touching FSRS memory state or writing a review log", () => {
    setBudget(BUDGET_MINUTES);
    const cardMature = seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(10);

    const before = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, cardMature))
      .get();
    const reviewLogsBefore = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, cardMature))
      .all().length;

    const result = service().apply({ asOf: NOW });
    expect(result.postponed).toBe(1);

    const after = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, cardMature))
      .get();
    // The FSRS due moved forward…
    expect(Date.parse(after?.dueAt as string)).toBeGreaterThan(Date.parse(before?.dueAt as string));
    // …but the MEMORY STATE is byte-for-byte unchanged (the protection invariant).
    expect(after?.stability).toBe(before?.stability);
    expect(after?.difficulty).toBe(before?.difficulty);
    expect(after?.reps).toBe(before?.reps);
    expect(after?.lapses).toBe(before?.lapses);
    expect(after?.fsrsState).toBe(before?.fsrsState);
    // NO review log was written (a postpone is not a graded review).
    expect(
      handle.db.select().from(reviewLogs).where(eq(reviewLogs.elementId, cardMature)).all().length,
    ).toBe(reviewLogsBefore);
    // The card's element status was preserved (never the attention-side `scheduled`).
    expect(new ElementRepository(handle.db).findById(cardMature)?.status).not.toBe("scheduled");
  });

  it("PROTECTS high-priority fragile cards — they stay due after the sweep", () => {
    setBudget(BUDGET_MINUTES);
    const fragileHigh = seedCard(0.875, { mature: false, title: "fragile high card" });
    const topicLow = seedTopic(0.375, "low topic");
    seedProtectedFiller(6);

    expect(dueIds().has(fragileHigh)).toBe(true);
    service().apply({ asOf: NOW });

    // The protected fragile high card is STILL due; the low topic receded.
    const due = dueIds();
    expect(due.has(fragileHigh)).toBe(true);
    expect(due.has(topicLow)).toBe(false);
  });

  it("never postpones a leech card", () => {
    setBudget(BUDGET_MINUTES);
    const leech = seedCard(0.375, { mature: true, lapses: 4, title: "leech card" });
    const topicLow = seedTopic(0.375);
    seedProtectedFiller(6);

    service().apply({ asOf: NOW });
    const due = dueIds();
    expect(due.has(leech)).toBe(true); // leech stays (under repair)
    expect(due.has(topicLow)).toBe(false);
  });

  it("does nothing when the due load is within budget", () => {
    setBudget(BUDGET_MINUTES);
    seedCard(0.375, { mature: true, title: "small card" }); // 2 min, well within budget
    const beforeOps = handle.db.select().from(operationLog).all().length;
    const result = service().apply({ asOf: NOW });
    expect(result.postponed).toBe(0);
    expect(handle.db.select().from(operationLog).all().length).toBe(beforeOps);
  });
});
