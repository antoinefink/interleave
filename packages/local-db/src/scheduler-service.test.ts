/**
 * SchedulerService tests (T028 — the attention-scheduler APPLY seam).
 *
 * These run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so
 * behaviour matches production exactly. They pin the persistence contract of the
 * attention scheduler:
 *
 *  - `rescheduleForAction` / `scheduleAt` PERSIST the computed `due_at` (a real
 *    future date), set status `scheduled`, and append EXACTLY ONE
 *    `reschedule_element` op per call;
 *  - a `postpone` action records the running postpone count in the op payload and
 *    the next postpone recedes FURTHER out (grows with the count);
 *  - tomorrow / next week / next month / manual land on the right dates;
 *  - the FSRS-ISOLATION assertion: scheduling an EXTRACT creates NO `review_states`
 *    row (an extract has no FSRS row — the two-scheduler split holds);
 *  - a `card` is REJECTED (cards schedule on FSRS, never the attention heuristic).
 */

import type { BlockId, ElementId, ElementStatus, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, operationLog, reviewStates } from "@interleave/db";
import { postponeIntervalForPriority } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractionService } from "./extraction-service";
import { ReviewRepository } from "./review-repository";
import { ADAPTIVE_ATTENTION_INTERVALS_SETTING_KEY, SchedulerService } from "./scheduler-service";
import { SettingsRepository } from "./settings-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;

function seedSource(
  handle: DbHandle,
  priority: Priority = 0.625,
  status: ElementStatus = "active",
): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority,
    status,
    stage: "raw_source",
    body: "Intro paragraph one.\n\nThe definition paragraph two.\n\nA third paragraph.",
  });
  return element.id;
}

function seedExtract(
  handle: DbHandle,
  priority: Priority = 0.625,
): { sourceId: ElementId; extractId: ElementId } {
  const sourceId = seedSource(handle, priority);
  const blocks = new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((b) => b.stableBlockId as BlockId);
  const extraction = new ExtractionService(handle.db);
  const { element } = extraction.createExtraction({
    sourceElementId: sourceId,
    selectedText: "The definition paragraph two.",
    blockIds: [blocks[1] as BlockId],
    startOffset: 0,
    endOffset: 29,
    priority,
  });
  return { sourceId, extractId: element.id };
}

/** All reschedule_element ops for an element, with parsed payloads. */
function rescheduleOps(handle: DbHandle, id: ElementId): { payload: Record<string, unknown> }[] {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, id))
    .all()
    .filter((op) => op.opType === "reschedule_element")
    .map((op) => ({ payload: JSON.parse(op.payload) as Record<string, unknown> }));
}

function setElementUpdatedAt(id: ElementId, updatedAt: string): void {
  handle.db.update(elements).set({ updatedAt }).where(eq(elements.id, id)).run();
}

function attentionIntervalMultiplierOf(id: ElementId): number {
  const element = new ElementRepository(handle.db).findById(id);
  return element?.attentionIntervalMultiplier ?? 1;
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("SchedulerService.rescheduleForAction", () => {
  it("activates a source with a return due_at while keeping lifecycle active", () => {
    const sourceId = seedSource(handle, 0.625); // band B
    const service = new SchedulerService(handle.db);
    const now = "2026-05-30T12:00:00.000Z";

    const opsBefore = rescheduleOps(handle, sourceId).length;
    const { element, intervalDays } = service.activateSourceWithReturn(sourceId, now);

    expect(element.status).toBe("active");
    expect(element.dueAt).toBeTruthy();
    expect(intervalDays).toBe(3);
    expect(Math.round((Date.parse(element.dueAt as string) - Date.parse(now)) / 86_400_000)).toBe(
      3,
    );

    const persisted = new ElementRepository(handle.db).findById(sourceId);
    expect(persisted?.status).toBe("active");
    expect(persisted?.dueAt).toBe(element.dueAt);
    expect(persisted?.updatedAt).toBe(now);

    const ops = rescheduleOps(handle, sourceId);
    expect(ops).toHaveLength(opsBefore + 1);
    expect(ops.at(-1)?.payload).toMatchObject({
      action: "activate",
      scheduledAt: now,
      status: "active",
      prevStatus: "active",
    });

    const reviewRow = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, sourceId))
      .get();
    expect(reviewRow).toBeUndefined();
  });

  it("only activates sources with the inbox return-path seam", () => {
    const { extractId } = seedExtract(handle);
    const review = new ReviewRepository(handle.db);
    const { element: card } = review.createCard({
      kind: "qa",
      title: "Capital of France",
      prompt: "What is the capital of France?",
      answer: "Paris",
      priority: 0.625,
    });
    const service = new SchedulerService(handle.db);

    expect(() => service.activateSourceWithReturn(extractId)).toThrow(/only sources/i);
    expect(() => service.activateSourceWithReturn(card.id)).toThrow(/card/i);
  });

  it("queues a source for immediate attention without creating FSRS state", () => {
    const sourceId = seedSource(handle, 0.625, "inbox");
    const service = new SchedulerService(handle.db);
    const now = "2026-05-30T12:00:00.000Z";

    const { element, intervalDays } = handle.db.transaction((tx) =>
      service.queueSourceSoonWithin(tx, sourceId, now),
    );

    expect(intervalDays).toBe(0);
    expect(element.status).toBe("scheduled");
    expect(element.dueAt).toBe(now);

    const persisted = new ElementRepository(handle.db).findById(sourceId);
    expect(persisted?.status).toBe("scheduled");
    expect(persisted?.dueAt).toBe(now);
    expect(persisted?.updatedAt).toBe(now);

    const ops = rescheduleOps(handle, sourceId);
    expect(ops.at(-1)?.payload).toMatchObject({
      action: "queueSoon",
      queueSoon: true,
      status: "scheduled",
      prevStatus: "inbox",
      prevDueAt: null,
    });

    const reviewRow = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, sourceId))
      .get();
    expect(reviewRow).toBeUndefined();
  });

  it("only queues sources with the inbox queue-soon seam", () => {
    const { extractId } = seedExtract(handle);
    const service = new SchedulerService(handle.db);
    const before = rescheduleOps(handle, extractId).length;

    expect(() =>
      handle.db.transaction((tx) => service.queueSourceSoonWithin(tx, extractId)),
    ).toThrow(/only sources/i);
    expect(rescheduleOps(handle, extractId).length).toBe(before);
  });

  it("persists a future due_at, status scheduled, and exactly one reschedule_element op", () => {
    const sourceId = seedSource(handle, 0.625); // band B
    const service = new SchedulerService(handle.db);
    const before = Date.now();

    const opsBefore = rescheduleOps(handle, sourceId).length;
    const { element, intervalDays } = service.rescheduleForAction(sourceId, "extract");

    expect(element.status).toBe("scheduled");
    expect(element.dueAt).toBeTruthy();
    expect(Date.parse(element.dueAt as string)).toBeGreaterThan(before);
    // B source base interval is 7 days, halved because its high-priority blocks
    // are still unresolved.
    expect(intervalDays).toBe(3);

    // Persisted: re-reading the row reflects the new schedule.
    const persisted = new ElementRepository(handle.db).findById(sourceId);
    expect(persisted?.status).toBe("scheduled");
    expect(persisted?.dueAt).toBe(element.dueAt);

    // Exactly ONE new reschedule_element op for this action.
    expect(rescheduleOps(handle, sourceId).length).toBe(opsBefore + 1);
  });

  it("postpone records a running postpone count and the next postpone recedes further", () => {
    const sourceId = seedSource(handle, 0.625); // band B base postpone = 14d
    const service = new SchedulerService(handle.db);

    const before = Date.now();
    const first = service.rescheduleForAction(sourceId, "postpone");
    const firstDays = Math.round((Date.parse(first.element.dueAt as string) - before) / 86_400_000);
    expect(firstDays).toBe(7); // base 14d, pulled sooner by unresolved B-priority text
    expect(service.countPostpones(sourceId)).toBe(1);

    const second = service.rescheduleForAction(sourceId, "postpone");
    expect(second.intervalDays).toBeGreaterThan(first.intervalDays); // grows
    expect(service.countPostpones(sourceId)).toBe(2);

    // The postpone marker + count rides on the op payload (no schema column).
    const lastPayload = rescheduleOps(handle, sourceId).at(-1)?.payload;
    expect(lastPayload?.postpone).toBe(true);
    expect(lastPayload?.postponeCount).toBe(2);
  });

  it("caps non-task chronic postpone intervals at threshold minus one while task intervals keep growing", () => {
    new SettingsRepository(handle.db).updateAppSettings({ chronicPostponeThreshold: 3 });
    const elementsRepo = new ElementRepository(handle.db);
    const topic = elementsRepo.create({
      type: "topic",
      title: "Chronic topic",
      priority: 0.625,
      status: "scheduled",
      stage: "rough_topic",
    });
    const task = elementsRepo.create({
      type: "task",
      title: "Chronic task",
      priority: 0.625,
      status: "scheduled",
      stage: "rough_topic",
    });
    const service = new SchedulerService(handle.db);
    const now = "2026-05-30T12:00:00.000Z";

    const topicIntervals = [
      service.rescheduleForAction(topic.id, "postpone", now).intervalDays,
      service.rescheduleForAction(topic.id, "postpone", now).intervalDays,
      service.rescheduleForAction(topic.id, "postpone", now).intervalDays,
      service.rescheduleForAction(topic.id, "postpone", now).intervalDays,
    ];
    const taskIntervals = [
      service.rescheduleForAction(task.id, "postpone", now).intervalDays,
      service.rescheduleForAction(task.id, "postpone", now).intervalDays,
      service.rescheduleForAction(task.id, "postpone", now).intervalDays,
      service.rescheduleForAction(task.id, "postpone", now).intervalDays,
    ];

    expect(topicIntervals).toEqual([
      postponeIntervalForPriority(0.625, 0),
      postponeIntervalForPriority(0.625, 1),
      postponeIntervalForPriority(0.625, 2),
      postponeIntervalForPriority(0.625, 2),
    ]);
    expect(taskIntervals).toEqual([
      postponeIntervalForPriority(0.625, 0),
      postponeIntervalForPriority(0.625, 1),
      postponeIntervalForPriority(0.625, 2),
      postponeIntervalForPriority(0.625, 3),
    ]);
    expect(service.countPostpones(topic.id)).toBe(4);
    expect(service.countPostpones(task.id)).toBe(4);
  });

  it("rejects a card — cards schedule on FSRS, never the attention heuristic", () => {
    const review = new ReviewRepository(handle.db);
    const { element: card } = review.createCard({
      kind: "qa",
      title: "Capital of France",
      prompt: "What is the capital of France?",
      answer: "Paris",
      priority: 0.625,
    });
    const service = new SchedulerService(handle.db);
    expect(() => service.rescheduleForAction(card.id, "extract")).toThrow(/card/i);
  });

  it("a topic on a fresh DB (unconfigured setting) uses the 7d default, not the by-priority band", () => {
    // No setting is written — the row does not exist. The service must resolve the
    // canonical DEFAULT_APP_SETTINGS.defaultTopicIntervalDays (7), NOT fall through
    // to the by-priority band (which for a C topic would be 30d, for an A topic 1d).
    const elementsRepo = new ElementRepository(handle.db);
    const topic = elementsRepo.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.375, // band C → by-priority would be 30d
      title: "An unconfigured topic",
    });
    const service = new SchedulerService(handle.db);
    const { intervalDays } = service.rescheduleForAction(topic.id, "rewrite");
    expect(intervalDays).toBe(7); // the canonical default, not the 30d C-band
  });

  it("uses pre-action recency but persists the action clock for heuristic schedules", () => {
    const elementsRepo = new ElementRepository(handle.db);
    const oldTopic = elementsRepo.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.625,
      title: "Old topic",
    });
    const recentTopic = elementsRepo.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.625,
      title: "Recent topic",
    });
    const now = "2026-05-30T12:00:00.000Z";
    setElementUpdatedAt(oldTopic.id, "2026-05-20T12:00:00.000Z");
    setElementUpdatedAt(recentTopic.id, now);
    const service = new SchedulerService(handle.db);

    const oldResult = service.rescheduleForAction(oldTopic.id, "rewrite", now);
    const recentResult = service.rescheduleForAction(recentTopic.id, "rewrite", now);

    expect(oldResult.intervalDays).toBe(4);
    expect(recentResult.intervalDays).toBe(7);
    expect(oldResult.element.dueAt).toBe("2026-06-03T12:00:00.000Z");
    expect(recentResult.element.dueAt).toBe("2026-06-06T12:00:00.000Z");
    expect(new ElementRepository(handle.db).findById(oldTopic.id)?.updatedAt).toBe(now);
    expect(rescheduleOps(handle, oldTopic.id).at(-1)?.payload).toMatchObject({
      action: "rewrite",
      scheduledAt: now,
    });
  });

  it("consumes the global defaultTopicIntervalDays setting for a topic", () => {
    new SettingsRepository(handle.db).set("scheduler.defaultTopicIntervalDays", 14);
    const elementsRepo = new ElementRepository(handle.db);
    const topic = elementsRepo.create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.375, // band C → by-priority would be 30d
      title: "A topic",
    });
    const service = new SchedulerService(handle.db);
    const { intervalDays } = service.rescheduleForAction(topic.id, "rewrite");
    expect(intervalDays).toBe(14); // the setting, not the 30d band
  });

  it("drifts mostly ignored no-output sources later and flags retirement", () => {
    const sourceId = seedSource(handle, 0.375); // C source base = 30d
    const blocks = new DocumentRepository(handle.db).listBlocks(sourceId);
    const blockProcessing = new BlockProcessingService(handle.db);
    for (const block of blocks) {
      blockProcessing.markBlockIgnored({
        sourceElementId: sourceId,
        stableBlockId: block.stableBlockId as BlockId,
      });
    }

    const service = new SchedulerService(handle.db);
    const result = service.rescheduleForAction(sourceId, "rewrite", "2026-05-30T12:00:00.000Z");
    expect(result.intervalDays).toBe(35);
    expect(result.retirementSuggestion).toBe(true);
    expect(rescheduleOps(handle, sourceId).at(-1)?.payload.scheduleReason).toMatchObject({
      kind: "yield_lengthened",
      finalIntervalDays: 35,
      productiveOutputCount: 0,
    });
  });

  it("keeps flag-off source visits on the legacy payload shape with multiplier unchanged", () => {
    new SettingsRepository(handle.db).updateAppSettings({ adaptiveAttentionIntervals: false });
    const { sourceId } = seedExtract(handle, 0.375); // C source; extraction creates yield.
    const service = new SchedulerService(handle.db);
    const now = "2026-05-30T12:00:00.000Z";

    const result = service.rescheduleForAction(sourceId, "extract", now);

    expect(result.intervalDays).toBe(30);
    expect(attentionIntervalMultiplierOf(sourceId)).toBe(1);
    const payload = rescheduleOps(handle, sourceId).at(-1)?.payload;
    expect(payload).toMatchObject({ action: "extract", scheduledAt: now });
    expect(payload?.attentionAdaptive).toBeUndefined();
  });

  it("when enabled, ignores pre-existing lifetime output without a visit baseline", () => {
    new SettingsRepository(handle.db).updateAppSettings({ adaptiveAttentionIntervals: false });
    const { sourceId } = seedExtract(handle, 0.375); // C source; one older child extract exists.
    new SettingsRepository(handle.db).updateAppSettings({ adaptiveAttentionIntervals: true });
    const service = new SchedulerService(handle.db);
    const now = "2026-05-30T12:00:00.000Z";

    const result = service.rescheduleForAction(sourceId, "extract", now);

    expect(result.intervalDays).toBe(30);
    expect(service.getPersistedAttentionIntervalMultiplier(sourceId)).toBe(1);
    expect(attentionIntervalMultiplierOf(sourceId)).toBe(1);

    const adaptive = rescheduleOps(handle, sourceId).at(-1)?.payload.attentionAdaptive;
    expect(adaptive).toMatchObject({
      version: 1,
      enabled: true,
      settingKey: ADAPTIVE_ATTENTION_INTERVALS_SETTING_KEY,
      priorMultiplier: 1,
      newMultiplier: 1,
      reason: {
        reasonKind: "yield_held",
        baseIntervalDays: 30,
        intervalAfterMultiplierDays: 30,
        finalIntervalDays: 30,
      },
      counters: {
        before: { extractsCreated: 1, totalOutputCount: 1 },
        after: { extractsCreated: 1, totalOutputCount: 1 },
        delta: { extractsCreated: 0, totalOutputCount: 0 },
      },
    });
    expect(rescheduleOps(handle, sourceId).at(-1)?.payload).toMatchObject({
      prevAttentionIntervalMultiplier: 1,
      attentionIntervalMultiplier: 1,
    });
  });

  it("undo restores an adaptive source multiplier with its schedule", () => {
    const sourceId = seedSource(handle, 0.375);
    new SettingsRepository(handle.db).updateAppSettings({ adaptiveAttentionIntervals: true });
    const repo = new ElementRepository(handle.db);
    const scheduler = new SchedulerService(handle.db);
    const baseline = scheduler.captureAdaptiveVisitBaseline(sourceId, "extract");
    const before = repo.findById(sourceId);

    handle.db.transaction((tx) => {
      repo.createWithin(tx, {
        type: "extract",
        status: "active",
        stage: "raw_extract",
        priority: 0.375,
        title: "New output",
        parentId: sourceId,
        sourceId,
      });
      scheduler.rescheduleProcessedVisitWithin(
        tx,
        sourceId,
        "extract",
        "2026-05-30T12:00:00.000Z",
        baseline,
      );
    });
    expect(attentionIntervalMultiplierOf(sourceId)).toBe(0.85);

    new UndoService(handle.db).undoLast();

    const restored = repo.findById(sourceId);
    expect(restored?.dueAt).toBe(before?.dueAt);
    expect(restored?.status).toBe(before?.status);
    expect(restored?.attentionIntervalMultiplier).toBe(before?.attentionIntervalMultiplier);
  });

  it("when enabled, lengthens a barren source without the legacy binary double", () => {
    const sourceId = seedSource(handle, 0.375); // C source base = 30d
    const blocks = new DocumentRepository(handle.db).listBlocks(sourceId);
    const blockProcessing = new BlockProcessingService(handle.db);
    for (const block of blocks) {
      blockProcessing.markBlockIgnored({
        sourceElementId: sourceId,
        stableBlockId: block.stableBlockId as BlockId,
      });
    }
    new SettingsRepository(handle.db).updateAppSettings({ adaptiveAttentionIntervals: true });
    const service = new SchedulerService(handle.db);

    const result = service.rescheduleForAction(sourceId, "rewrite", "2026-05-30T12:00:00.000Z");

    expect(result.intervalDays).toBe(35);
    expect(result.retirementSuggestion).toBe(true);
    expect(service.getPersistedAttentionIntervalMultiplier(sourceId)).toBe(1.15);
    const adaptive = rescheduleOps(handle, sourceId).at(-1)?.payload.attentionAdaptive;
    expect(adaptive).toMatchObject({
      newMultiplier: 1.15,
      reason: {
        reasonKind: "yield_lengthened",
        baseIntervalDays: 30,
        intervalAfterMultiplierDays: 35,
        finalIntervalDays: 35,
      },
    });
  });
});

describe("SchedulerService.scheduleAt (explicit choices)", () => {
  it("schedules tomorrow / next week / next month with status scheduled", () => {
    const service = new SchedulerService(handle.db);
    const now = "2026-05-30T12:00:00.000Z";

    for (const [choice, expectedDays] of [
      ["tomorrow", 1],
      ["nextWeek", 7],
      ["nextMonth", 30],
    ] as const) {
      const sourceId = seedSource(handle);
      const { element, intervalDays } = service.scheduleAt(sourceId, choice, now);
      expect(element.status).toBe("scheduled");
      expect(intervalDays).toBe(expectedDays);
      const days = Math.round((Date.parse(element.dueAt as string) - Date.parse(now)) / 86_400_000);
      expect(days).toBe(expectedDays);
    }
  });

  it("does not persist an explicit schedule planner clock as scheduler recency", () => {
    const sourceId = seedSource(handle);
    const service = new SchedulerService(handle.db);
    const asOf = "2099-01-01T00:00:00.000Z";

    const { element } = service.scheduleAt(sourceId, "nextWeek", asOf);

    const persisted = new ElementRepository(handle.db).findById(sourceId);
    expect(element.dueAt).toBe("2099-01-08T00:00:00.000Z");
    expect(persisted?.updatedAt).not.toBe(asOf);
  });

  it("schedules a manual date, normalized to canonical ISO", () => {
    const sourceId = seedSource(handle);
    const service = new SchedulerService(handle.db);
    const { element } = service.scheduleAt(
      sourceId,
      { manual: "2026-07-01T09:00:00.000Z" },
      "2026-05-30T12:00:00.000Z",
    );
    expect(element.dueAt).toBe("2026-07-01T09:00:00.000Z");
    expect(element.status).toBe("scheduled");
  });
});

describe("FSRS isolation (the two-scheduler split)", () => {
  it("scheduling an EXTRACT creates NO review_states row", () => {
    const { extractId } = seedExtract(handle, 0.875); // band A
    const service = new SchedulerService(handle.db);

    service.rescheduleForAction(extractId, "extract");
    service.scheduleAt(extractId, "nextWeek");

    const reviewRow = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, extractId))
      .get();
    expect(reviewRow).toBeUndefined();

    // And the extract's schedule lives on elements.due_at only.
    const row = handle.db.select().from(elements).where(eq(elements.id, extractId)).get();
    expect(row?.dueAt).toBeTruthy();
    expect(row?.status).toBe("scheduled");
  });
});
