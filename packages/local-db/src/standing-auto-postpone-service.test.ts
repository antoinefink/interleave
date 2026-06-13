import type { BlockId, ElementId, IsoTimestamp, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { DailyWorkQuery } from "./daily-work-query";
import { ElementRepository } from "./element-repository";
import { createRepositories } from "./index";
import { PriorityIntegrityQuery } from "./priority-integrity-query";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import {
  STANDING_AUTO_POSTPONE_STATE_KEY,
  StandingAutoPostponeService,
} from "./standing-auto-postpone-service";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;

const NOW = "2026-06-12T09:00:00.000Z" as IsoTimestamp;
const OVERDUE = "2026-06-01T09:00:00.000Z" as IsoTimestamp;
const BUDGET_MINUTES = 20;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

function repos() {
  return createRepositories(handle.db);
}

function service(clock: IsoTimestamp = NOW): StandingAutoPostponeService {
  return new StandingAutoPostponeService(handle.db, repos(), () => clock);
}

function seedTopic(priority: Priority, title = "low source"): ElementId {
  const { element } = new SourceRepository(handle.db).createWithDocument({
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
  const r = repos();
  const { element: source } = r.sources.create({
    title: `${title} source`,
    priority,
    status: "active",
    stage: "raw_source",
  });
  const extract = r.sources.createExtract({
    sourceElementId: source.id,
    title,
    priority,
    selectedText: "Selected text",
    blockIds: ["block-1" as BlockId],
    label: "p1",
  });
  r.elements.update(extract.element.id, { status: "active", stage: "clean_extract" });
  r.elements.reschedule(extract.element.id, OVERDUE);
  return extract.element.id;
}

function seedCard(
  priority: Priority,
  opts: { mature: boolean; title?: string; lapses?: number },
): ElementId {
  const { element } = new ReviewRepository(handle.db).createCard({
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
      lastReviewedAt: "2026-05-01T09:00:00.000Z",
    })
    .where(eq(reviewStates.elementId, element.id))
    .run();
  return element.id;
}

function seedProtectedFiller(n: number): void {
  for (let i = 0; i < n; i += 1) {
    seedCard(0.875, { mature: false, title: `protected ${i}` });
  }
}

function configure(policy: "off" | "suggest" | "automatic"): void {
  repos().settings.updateAppSettings({
    dailyBudgetMinutes: BUDGET_MINUTES,
    overloadPolicy: policy,
  });
}

function rescheduleOps() {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.opType, "reschedule_element"))
    .all();
}

function payloadsForBatch(batchId: string): Record<string, unknown>[] {
  return rescheduleOps()
    .map((op) => JSON.parse(op.payload) as Record<string, unknown>)
    .filter((payload) => payload.batchId === batchId);
}

describe("StandingAutoPostponeService", () => {
  it("applies automatic safe victims once per local day and exposes the daily receipt", () => {
    configure("automatic");
    seedTopic(0.375, "low topic");
    seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const result = service().materializeToday();
    expect(result.evaluated).toBe(true);
    expect(result.applied).toBe(true);
    expect(result.receipt).toMatchObject({
      localDay: "2026-06-12",
      postponed: 2,
      postponedMinutes: 12,
      remainingMinutesAfter: 18,
      status: "actionable",
    });

    const batchId = result.receipt?.batchId ?? "";
    const payloads = payloadsForBatch(batchId);
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload) => payload.postpone === true)).toBe(true);
    expect(payloads.map((payload) => payload.postponeOrigin)).toEqual([
      expect.objectContaining({
        kind: "standingAutoPostpone",
        localDay: "2026-06-12",
        overloadPolicy: "automatic",
      }),
      expect.objectContaining({
        kind: "standingAutoPostpone",
        localDay: "2026-06-12",
        overloadPolicy: "automatic",
      }),
    ]);

    const second = service().materializeToday();
    expect(second.receipt?.batchId).toBe(batchId);
    expect(payloadsForBatch(batchId)).toHaveLength(2);

    const summary = new DailyWorkQuery(repos(), new BlockProcessingService(handle.db)).summary(NOW);
    expect(summary.autoPostponeReceipt?.batchId).toBe(batchId);
  });

  it("persists distillation floor metadata in the automatic receipt", () => {
    configure("automatic");
    repos().settings.updateAppSettings({ distillationQuotaPercent: 50 });
    seedExtract(0.375, "protected extract");
    seedTopic(0.375, "low source");
    seedProtectedFiller(9);

    const first = service().materializeToday();
    expect(first.receipt?.distillationFloor).toMatchObject({
      quotaFloorMinutes: 10,
      dueDistillationMinutes: 6,
      postponedDistillationMinutes: 0,
      remainingDueDistillationMinutesAfter: 6,
    });

    const batchId = first.receipt?.batchId ?? "";
    const second = service().materializeToday();
    expect(second.receipt?.batchId).toBe(batchId);
    expect(second.receipt?.distillationFloor).toEqual(first.receipt?.distillationFloor);

    const summary = new DailyWorkQuery(repos(), new BlockProcessingService(handle.db)).summary(NOW);
    expect(summary.autoPostponeReceipt?.distillationFloor).toEqual(
      first.receipt?.distillationFloor,
    );
  });

  it("does not mutate schedules in suggest or off mode", () => {
    for (const policy of ["suggest", "off"] as const) {
      handle.sqlite.close();
      handle = createInMemoryDb();
      configure(policy);
      seedTopic(0.375, "low topic");
      seedCard(0.375, { mature: true, title: "mature low card" });
      seedProtectedFiller(9);

      const before = rescheduleOps().length;
      const result = service().materializeToday();
      expect(result).toMatchObject({ evaluated: false, applied: false, receipt: null });
      expect(rescheduleOps()).toHaveLength(before);
      expect(repos().settings.get(STANDING_AUTO_POSTPONE_STATE_KEY)).toBeNull();
    }
  });

  it("marks protected-only automatic days evaluated without a false receipt", () => {
    configure("automatic");
    seedProtectedFiller(11);

    const result = service().materializeToday();
    expect(result).toMatchObject({ evaluated: true, applied: false, receipt: null });
    expect(service().materializeToday()).toMatchObject({ evaluated: true, applied: false });
  });

  it("undoes the receipt batch after later commands and suppresses restored ledger sacrifice", () => {
    configure("automatic");
    const topic = seedTopic(0.375, "low topic");
    const card = seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const applied = service().materializeToday();
    const batchId = applied.receipt?.batchId ?? "";
    const postponedTopicDue = new ElementRepository(handle.db).findById(topic)?.dueAt;
    const postponedCardDue = handle.db
      .select({ dueAt: reviewStates.dueAt })
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card))
      .get()?.dueAt;
    expect(postponedTopicDue).not.toBe(OVERDUE);
    expect(postponedCardDue).not.toBe(OVERDUE);

    new ElementRepository(handle.db).update(topic, { title: "later user edit" });
    const undo = service().undoReceipt(batchId);
    expect(undo.undo.undone).toBe(true);
    expect(undo.receipt?.status).toBe("undone");
    expect(new ElementRepository(handle.db).findById(topic)?.dueAt).toBe(OVERDUE);
    expect(
      handle.db
        .select({ dueAt: reviewStates.dueAt })
        .from(reviewStates)
        .where(eq(reviewStates.elementId, card))
        .get()?.dueAt,
    ).toBe(OVERDUE);

    expect(service().materializeToday().receipt?.status).toBe("undone");
    const ledger = new PriorityIntegrityQuery(handle.db).compute(new Date().toISOString());
    expect(ledger.sacrificed.some((row) => row.postponeOrigin === "standingAutoPostpone")).toBe(
      false,
    );

    const afterUndoOps = rescheduleOps().length;
    expect(new UndoService(handle.db).undoLast()).toMatchObject({
      undone: false,
      reason: 'Can\'t undo "reschedule_element"',
    });
    expect(rescheduleOps()).toHaveLength(afterUndoOps);

    const secondUndo = service().undoReceipt(batchId);
    expect(secondUndo.undo).toMatchObject({
      undone: false,
      reason: "Receipt already undone",
    });
    expect(rescheduleOps()).toHaveLength(afterUndoOps);
  });

  it("refuses receipt undo when a victim was rescheduled after the automatic batch", () => {
    configure("automatic");
    const topic = seedTopic(0.375, "low topic");
    const card = seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const applied = service().materializeToday();
    const batchId = applied.receipt?.batchId ?? "";
    const postponedCardDue = handle.db
      .select({ dueAt: reviewStates.dueAt })
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card))
      .get()?.dueAt;
    const laterDue = "2026-07-01T09:00:00.000Z" as IsoTimestamp;
    new ElementRepository(handle.db).reschedule(topic, laterDue);
    const beforeUndoOps = rescheduleOps().length;

    const undo = service().undoReceipt(batchId);
    expect(undo.undo).toMatchObject({
      undone: false,
      reason: "Batch no longer matches current schedule",
    });
    expect(undo.receipt?.status).toBe("actionable");
    expect(new ElementRepository(handle.db).findById(topic)?.dueAt).toBe(laterDue);
    expect(
      handle.db
        .select({ dueAt: reviewStates.dueAt })
        .from(reviewStates)
        .where(eq(reviewStates.elementId, card))
        .get()?.dueAt,
    ).toBe(postponedCardDue);
    expect(rescheduleOps()).toHaveLength(beforeUndoOps);
  });

  it("refuses receipt undo when a victim was deleted after the automatic batch", () => {
    configure("automatic");
    const topic = seedTopic(0.375, "low topic");
    const card = seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const applied = service().materializeToday();
    const batchId = applied.receipt?.batchId ?? "";
    const postponedTopicDue = new ElementRepository(handle.db).findById(topic)?.dueAt;
    const postponedCardDue = handle.db
      .select({ dueAt: reviewStates.dueAt })
      .from(reviewStates)
      .where(eq(reviewStates.elementId, card))
      .get()?.dueAt;
    new ElementRepository(handle.db).softDelete(topic);
    const beforeUndoOps = rescheduleOps().length;

    const undo = service().undoReceipt(batchId);
    expect(undo.undo).toMatchObject({
      undone: false,
      reason: "Batch no longer matches current schedule",
    });
    expect(undo.receipt?.status).toBe("actionable");
    const deletedTopic = new ElementRepository(handle.db).findById(topic);
    expect(deletedTopic?.deletedAt).not.toBeNull();
    expect(deletedTopic?.dueAt).toBe(postponedTopicDue);
    expect(
      handle.db
        .select({ dueAt: reviewStates.dueAt })
        .from(reviewStates)
        .where(eq(reviewStates.elementId, card))
        .get()?.dueAt,
    ).toBe(postponedCardDue);
    expect(rescheduleOps()).toHaveLength(beforeUndoOps);
  });

  it("refuses receipt undo when the batch no longer contains only owned postpone ops", () => {
    configure("automatic");
    const topic = seedTopic(0.375, "low topic");
    seedCard(0.375, { mature: true, title: "mature low card" });
    seedProtectedFiller(9);

    const applied = service().materializeToday();
    const batchId = applied.receipt?.batchId ?? "";
    const postponedTopicDue = new ElementRepository(handle.db).findById(topic)?.dueAt;
    const op = rescheduleOps().find((row) => {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      return payload.batchId === batchId;
    });
    expect(op).toBeDefined();
    const payload = JSON.parse(op?.payload ?? "{}") as Record<string, unknown>;
    handle.db
      .update(operationLog)
      .set({ payload: JSON.stringify({ ...payload, postpone: false }) })
      .where(eq(operationLog.id, op?.id ?? "missing"))
      .run();

    const undo = service().undoReceipt(batchId);
    expect(undo.undo).toMatchObject({
      undone: false,
      reason: "Batch is not owned by this receipt",
    });
    expect(undo.receipt?.status).toBe("actionable");
    expect(new ElementRepository(handle.db).findById(topic)?.dueAt).toBe(postponedTopicDue);
  });
});
