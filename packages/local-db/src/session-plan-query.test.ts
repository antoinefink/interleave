import type { BlockId, ElementId, IsoTimestamp, Priority } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { QueueQuery } from "./queue-query";
import { SessionPlanQuery } from "./session-plan-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;

const NOW = "2026-06-12T12:00:00.000Z" as IsoTimestamp;
const OVERDUE = "2026-06-10T12:00:00.000Z" as IsoTimestamp;
const FUTURE = "2026-06-20T12:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function query(): SessionPlanQuery {
  return new SessionPlanQuery(handle.db, repos);
}

function seedDueSource(
  title: string,
  priority: Priority = PRIORITY_LABEL_VALUE.B,
  dueAt: IsoTimestamp = OVERDUE,
): ElementId {
  const { element } = repos.sources.create({
    title,
    priority,
    status: "active",
    stage: "raw_source",
  });
  repos.elements.reschedule(element.id, dueAt);
  return element.id;
}

function seedDueExtract(sourceId: ElementId, title: string): ElementId {
  const extract = repos.sources.createExtract({
    sourceElementId: sourceId,
    title,
    priority: PRIORITY_LABEL_VALUE.B,
    selectedText: "Selected text",
    blockIds: ["block-1" as BlockId],
    label: "p1",
  });
  repos.elements.update(extract.element.id, { status: "active", stage: "clean_extract" });
  repos.elements.reschedule(extract.element.id, OVERDUE);
  return extract.element.id;
}

function seedDueCard(title: string, priority: Priority = PRIORITY_LABEL_VALUE.B): ElementId {
  const { element } = repos.review.createCard({
    kind: "qa",
    title,
    priority,
    prompt: "Q",
    answer: "A",
    stage: "active_card",
  });
  handle.db
    .update(reviewStates)
    .set({
      dueAt: OVERDUE,
      stability: 8,
      fsrsState: "review",
      reps: 2,
      lapses: 0,
      lastReviewedAt: "2026-06-01T12:00:00.000Z",
    })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

function seedWeeklyReviewTask(): ElementId {
  const weekly = repos.elements.create({
    type: "task",
    status: "scheduled",
    stage: "rough_topic",
    priority: PRIORITY_LABEL_VALUE.A,
    title: "Weekly review",
    dueAt: OVERDUE,
  });
  handle.sqlite
    .prepare(
      `INSERT INTO tasks (element_id, task_type, due_at, status, linked_element_id, note)
       VALUES (?, 'weekly_review', ?, 'scheduled', NULL, NULL)`,
    )
    .run(weekly.id, weekly.dueAt);
  return weekly.id;
}

describe("SessionPlanQuery.preview", () => {
  it("uses full session-plan candidates in queue score order and prices them with T115 estimates", () => {
    repos.settings.updateAppSettings({ distillationQuotaPercent: 0 });
    const source = seedDueSource("High-value source", PRIORITY_LABEL_VALUE.A);
    const extract = seedDueExtract(source, "Clean extract");
    const card = seedDueCard("Review card", PRIORITY_LABEL_VALUE.B);

    const queueCandidates = new QueueQuery(repos).sessionPlanCandidates({ asOf: NOW });
    const preview = query().preview({ asOf: NOW, targetMinutes: 100 });

    expect(preview.plannedItems.map((row) => row.item.id)).toEqual(
      queueCandidates.items.map((row) => row.id),
    );
    expect(preview.cutItems).toEqual([]);
    expect(preview.plannedItems.find((row) => row.item.id === source)?.estimatedMinutes).toBe(10);
    expect(preview.plannedItems.find((row) => row.item.id === extract)?.estimatedMinutes).toBe(6);
    expect(preview.plannedItems.find((row) => row.item.id === card)?.estimatedMinutes).toBe(2);
    expect(preview.plannedMinutes).toBe(18);
    expect(preview.confidence).toBe("default");
    expect(preview.hasDefaultEstimates).toBe(true);
  });

  it("surfaces due extract distillation inside a card-heavy planned session floor", () => {
    repos.settings.updateAppSettings({ distillationQuotaPercent: 50 });
    const source = seedDueSource("Quota source", PRIORITY_LABEL_VALUE.B);
    const extract = seedDueExtract(source, "Quota extract");
    const cardA = seedDueCard("Card A", PRIORITY_LABEL_VALUE.A);
    const cardB = seedDueCard("Card B", PRIORITY_LABEL_VALUE.A);

    const preview = query().preview({
      asOf: NOW,
      targetMinutes: 8,
      filters: { types: ["card", "extract"] },
    });

    expect(preview.composition).toMatchObject({
      status: "active",
      quotaFloorMinutes: 4,
      eligibleDistillationMinutes: 6,
      distillationMinutes: 6,
    });
    const plannedIds = preview.plannedItems.map((row) => row.item.id);
    const plannedCards = plannedIds.filter((id) => id === cardA || id === cardB);
    expect(plannedIds).toContain(extract);
    expect(plannedCards).toHaveLength(1);
  });

  it("returns the distillation share to cards when there is no due extract backlog", () => {
    repos.settings.updateAppSettings({ distillationQuotaPercent: 50 });
    seedDueCard("Card A", PRIORITY_LABEL_VALUE.A);
    seedDueCard("Card B", PRIORITY_LABEL_VALUE.A);

    const preview = query().preview({ asOf: NOW, targetMinutes: 4 });

    expect(preview.composition).toMatchObject({
      status: "returned_empty_backlog",
      quotaFloorMinutes: 2,
      returnedQuotaMinutes: 2,
      distillationMinutes: 0,
      cardMinutes: 4,
    });
  });

  it("marks quota inactive when active filters exclude extract work", () => {
    repos.settings.updateAppSettings({ distillationQuotaPercent: 50 });
    const source = seedDueSource("Filtered source", PRIORITY_LABEL_VALUE.A);
    seedDueExtract(source, "Filtered extract");
    seedDueCard("Visible card", PRIORITY_LABEL_VALUE.A);

    const preview = query().preview({
      asOf: NOW,
      targetMinutes: 4,
      filters: { types: ["card"] },
    });

    expect(preview.composition.status).toBe("inactive_filtered_out");
    expect(preview.plannedItems.every((row) => row.item.type === "card")).toBe(true);
  });

  it("plans from the full due universe even when the display queue is limited", () => {
    for (let i = 0; i < 4; i++) seedDueSource(`Source ${i}`);

    const visibleQueue = new QueueQuery(repos).list({ asOf: NOW, limit: 1 });
    const preview = query().preview({ asOf: NOW, targetMinutes: 10, cutDetailLimit: 2 });

    expect(visibleQueue.items).toHaveLength(1);
    expect(preview.candidateCount).toBe(4);
    expect(preview.plannedItems).toHaveLength(1);
    expect(preview.plannedMinutes).toBe(10);
    expect(preview.cutCount).toBe(3);
    expect(preview.cutItems).toHaveLength(2);
    expect(preview.cutMinutes).toBe(30);
    expect(preview.cutReasons).toEqual({ did_not_fit: 3 });
  });

  it("honors filters and asOf through the same candidate read as QueueQuery", () => {
    const included = seedDueSource("Tagged concept source", PRIORITY_LABEL_VALUE.A);
    const excludedTag = seedDueSource("Wrong tag source", PRIORITY_LABEL_VALUE.A);
    const excludedPriority = seedDueSource("Lower priority source", PRIORITY_LABEL_VALUE.B);
    const future = seedDueSource("Future source", PRIORITY_LABEL_VALUE.A, FUTURE);
    const concept = repos.concepts.createConcept({ name: "Focus" });
    repos.concepts.assignConcept(included, concept.id);
    repos.concepts.assignConcept(excludedPriority, concept.id);
    repos.concepts.assignConcept(future, concept.id);
    repos.elements.addTag(included, "session");
    repos.elements.addTag(excludedPriority, "session");
    repos.elements.addTag(excludedTag, "other");
    repos.elements.addTag(future, "session");

    const filters = {
      types: ["source" as const],
      statuses: ["active" as const],
      protectedOnly: true,
      concept: "Focus",
      tag: "session",
    };
    const queueCandidates = new QueueQuery(repos).sessionPlanCandidates({
      asOf: NOW,
      filters,
      mode: "read",
    });
    const preview = query().preview({
      asOf: NOW,
      filters,
      mode: "read",
      targetMinutes: 100,
    });

    expect(queueCandidates.items.map((row) => row.id)).toEqual([included]);
    expect(preview.plannedItems.map((row) => row.item.id)).toEqual([included]);
    expect(preview.plannedItems.map((row) => row.item.id)).not.toContain(excludedTag);
    expect(preview.plannedItems.map((row) => row.item.id)).not.toContain(excludedPriority);
    expect(preview.plannedItems.map((row) => row.item.id)).not.toContain(future);
  });

  it("keeps protected work eligible while excluding weekly-review system tasks", () => {
    const protectedSource = seedDueSource("Protected source", PRIORITY_LABEL_VALUE.A);
    const weekly = seedWeeklyReviewTask();

    const queueItems = new QueueQuery(repos).list({ asOf: NOW }).items.map((row) => row.id);
    const preview = query().preview({ asOf: NOW, targetMinutes: 100 });

    expect(queueItems).toContain(weekly);
    expect(preview.plannedItems.map((row) => row.item.id)).toContain(protectedSource);
    expect(preview.plannedItems.map((row) => row.item.id)).not.toContain(weekly);
    expect(
      preview.plannedItems.find((row) => row.item.id === protectedSource)?.item.protected,
    ).toBe(true);
    expect(preview.candidateCount).toBe(1);
    expect(preview.plannedMinutes).toBe(10);
  });

  it("is read-only: no operation_log rows, due dates, or review due state change", () => {
    const source = seedDueSource("Read-only source", PRIORITY_LABEL_VALUE.A);
    const card = seedDueCard("Read-only card", PRIORITY_LABEL_VALUE.B);
    const beforeOps = handle.db.select().from(operationLog).all().length;
    const beforeSourceDue = repos.elements.findById(source)?.dueAt;
    const beforeCardDue = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card))
      .get()?.dueAt;

    const preview = query().preview({ asOf: NOW, targetMinutes: 10 });

    expect(preview.plannedItems.length + preview.cutCount).toBe(2);
    expect(handle.db.select().from(operationLog).all().length).toBe(beforeOps);
    expect(repos.elements.findById(source)?.dueAt).toBe(beforeSourceDue);
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, card)).get()?.dueAt,
    ).toBe(beforeCardDue);
  });

  it("accepts a zero target as an empty plan with honest cut totals", () => {
    seedDueSource("Source");

    const preview = query().preview({ asOf: NOW, targetMinutes: 0 });

    expect(preview.plannedItems).toEqual([]);
    expect(preview.plannedMinutes).toBe(0);
    expect(preview.cutCount).toBe(1);
    expect(preview.cutMinutes).toBe(10);
    expect(preview.overTarget).toBe(false);
  });
});
