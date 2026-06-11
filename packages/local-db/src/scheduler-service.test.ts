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
import { SchedulerService } from "./scheduler-service";
import { SettingsRepository } from "./settings-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

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

    const ops = rescheduleOps(handle, sourceId);
    expect(ops).toHaveLength(opsBefore + 1);
    expect(ops.at(-1)?.payload).toMatchObject({
      action: "activate",
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
    expect(result.intervalDays).toBe(60);
    expect(result.retirementSuggestion).toBe(true);
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

  it("schedules a manual date, normalized to canonical ISO", () => {
    const sourceId = seedSource(handle);
    const service = new SchedulerService(handle.db);
    const { element } = service.scheduleAt(
      sourceId,
      { manual: "2026-07-01T09:00:00Z" },
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
