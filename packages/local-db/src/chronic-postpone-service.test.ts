import { type ElementId, type IsoTimestamp, priorityFromLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChronicPostponeService } from "./chronic-postpone-service";
import { createRepositories, type Repositories } from "./index";
import type { OperationLogRepository } from "./operation-log-repository";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

let handle: DbHandle;
let repos: Repositories;
let log: OperationLogRepository;
let service: ChronicPostponeService;
let undo: UndoService;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  log = repos.operationLog;
  service = repos.chronicPostponeService;
  undo = new UndoService(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function source(title: string, priority = priorityFromLabel("B")): ElementId {
  return repos.sources.create({ title, priority, status: "scheduled", stage: "raw_source" }).element
    .id;
}

function card(title: string): ElementId {
  return repos.review.createCard({
    kind: "qa",
    title,
    prompt: "Q",
    answer: "A",
    priority: priorityFromLabel("B"),
    stage: "active_card",
    firstScheduledAt: "2026-06-01T00:00:00.000Z" as IsoTimestamp,
  }).element.id;
}

function postpone(id: ElementId, times: number): void {
  for (let i = 0; i < times; i++) {
    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: { postpone: true, postponeCount: i + 1 },
        elementId: id,
      });
    });
  }
}

describe("ChronicPostponeService.apply", () => {
  it("keep resets the effective count with a marker and undo restores it", () => {
    const id = source("Keep me");
    postpone(id, 5);

    const result = service.apply({ threshold: 5, decisions: [{ id, kind: "keep" }] });

    expect(result).toMatchObject({ applied: 1, skipped: [] });
    expect(result.batchId).toBeTruthy();
    expect(log.countPostpones(id)).toBe(0);
    expect(log.listAll(1)[0]?.payload).toMatchObject({
      chronicPostponeReset: true,
      prevEffectivePostponeCount: 5,
      batchId: result.batchId,
    });

    const undone = undo.undoLast();
    expect(undone.undone).toBe(true);
    expect(log.countPostpones(id)).toBe(5);
  });

  it("demote lowers one priority band, resets the count, and undoes both as one batch", () => {
    const id = source("Demote me", priorityFromLabel("B"));
    postpone(id, 5);

    const result = service.apply({ threshold: 5, decisions: [{ id, kind: "demote" }] });

    expect(result.applied).toBe(1);
    expect(repos.elements.findById(id)?.priority).toBe(priorityFromLabel("C"));
    expect(log.countPostpones(id)).toBe(0);

    const undone = undo.undoLast();
    expect(undone.undone).toBe(true);
    expect(undone.count).toBe(2);
    expect(repos.elements.findById(id)?.priority).toBe(priorityFromLabel("B"));
    expect(log.countPostpones(id)).toBe(5);
  });

  it("skips demote at the lowest priority without resetting the effective count", () => {
    const id = source("Lowest priority", priorityFromLabel("D"));
    postpone(id, 5);

    const result = service.apply({ threshold: 5, decisions: [{ id, kind: "demote" }] });

    expect(result).toEqual({
      applied: 0,
      skipped: [{ id, reason: "already-lowest" }],
      batchId: null,
    });
    expect(repos.elements.findById(id)?.priority).toBe(priorityFromLabel("D"));
    expect(log.countPostpones(id)).toBe(5);
  });

  it("done clears card FSRS due and undo restores the prior review due", () => {
    const id = card("Finish card");
    const due = "2026-06-01T00:00:00.000Z" as IsoTimestamp;
    postpone(id, 5);
    expect(
      handle.db
        .select({ dueAt: reviewStates.dueAt })
        .from(reviewStates)
        .where(eq(reviewStates.elementId, id))
        .get()?.dueAt,
    ).toBe(due);

    const result = service.apply({ threshold: 5, decisions: [{ id, kind: "done" }] });

    expect(result.applied).toBe(1);
    expect(repos.elements.findById(id)).toMatchObject({ status: "done", dueAt: null });
    expect(
      handle.db
        .select({ dueAt: reviewStates.dueAt })
        .from(reviewStates)
        .where(eq(reviewStates.elementId, id))
        .get()?.dueAt,
    ).toBeNull();

    undo.undoLast();
    expect(repos.elements.findById(id)?.status).toBe("pending");
    expect(
      handle.db
        .select({ dueAt: reviewStates.dueAt })
        .from(reviewStates)
        .where(eq(reviewStates.elementId, id))
        .get()?.dueAt,
    ).toBe(due);
  });

  it("skips source done when unresolved source blocks still gate completion", () => {
    const id = repos.sources.createWithDocument({
      title: "Unresolved source",
      priority: priorityFromLabel("B"),
      status: "scheduled",
      stage: "raw_source",
      body: "First unresolved paragraph.\n\nSecond unresolved paragraph.",
    }).element.id;
    postpone(id, 5);

    const result = service.apply({ threshold: 5, decisions: [{ id, kind: "done" }] });

    expect(result).toEqual({
      applied: 0,
      skipped: [{ id, reason: "source-unresolved-blocks" }],
      batchId: null,
    });
    expect(repos.elements.findById(id)).toMatchObject({ status: "scheduled" });
    expect(log.countPostpones(id)).toBe(5);
  });

  it("delete soft-deletes and stale rows are skipped", () => {
    const deleted = source("Delete me");
    const below = source("Below threshold");
    const task = repos.elements.create({
      type: "task",
      title: "Task",
      priority: priorityFromLabel("C"),
      status: "scheduled",
      stage: "rough_topic",
    }).id;
    postpone(deleted, 5);
    postpone(below, 4);
    postpone(task, 6);

    const result = service.apply({
      threshold: 5,
      decisions: [
        { id: deleted, kind: "delete" },
        { id: below, kind: "keep" },
        { id: task, kind: "keep" },
        { id: "missing" as ElementId, kind: "keep" },
      ],
    });

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([
      { id: below, reason: "below-threshold" },
      { id: task, reason: "unsupported-type" },
      { id: "missing", reason: "missing" },
    ]);
    expect(repos.elements.findById(deleted)?.deletedAt).toBeTruthy();

    undo.undoLast();
    expect(repos.elements.findById(deleted)?.deletedAt).toBeNull();
  });

  it("skips deleted, non-actionable, and retired-card stale rows without mutating", () => {
    const deleted = source("Already deleted");
    const done = source("Already done");
    const retired = card("Retired chronic card");
    postpone(deleted, 5);
    postpone(done, 5);
    postpone(retired, 5);
    repos.elements.softDelete(deleted);
    repos.elements.update(done, { status: "done", dueAt: null });
    handle.db.update(cards).set({ isRetired: true }).where(eq(cards.elementId, retired)).run();
    const beforeOps = log.listAll().length;

    const result = service.apply({
      threshold: 5,
      decisions: [
        { id: deleted, kind: "keep" },
        { id: done, kind: "keep" },
        { id: retired, kind: "keep" },
      ],
    });

    expect(result).toEqual({
      applied: 0,
      skipped: [
        { id: deleted, reason: "deleted" },
        { id: done, reason: "not-actionable" },
        { id: retired, reason: "retired-card" },
      ],
      batchId: null,
    });
    expect(log.listAll().length).toBe(beforeOps);
    expect(log.countPostpones(deleted)).toBe(5);
    expect(log.countPostpones(done)).toBe(5);
    expect(log.countPostpones(retired)).toBe(5);
  });
});
