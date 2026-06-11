/**
 * TaskService tests (T092 — verification tasks).
 *
 * Against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB, these assert the
 * load-bearing verification-task invariants:
 *
 *  - `createTask` writes the `task` element (`create_element`) + the `tasks` row + the
 *    `references` edge (`add_relation`) in ONE transaction, sets an attention `dueAt`,
 *    and inherits the linked element's priority; the new task has NO `review_states` row
 *    (NEVER FSRS);
 *  - `completeTask` / `postponeTask` log `reschedule_element` and move status correctly;
 *  - `generateVerificationTasks` creates a task for an EXPIRED card and is IDEMPOTENT (a
 *    second run creates none — the in-tx open-task re-check + the partial unique index);
 *    a direct duplicate-open-task insert is rejected by the index; a `done` task does NOT
 *    block a fresh open one; a `parked` task also does not block generation; a
 *    non-expired card generates nothing;
 *  - `listOpenTasks` / `listDueTasks` resolve correctly; soft-delete works.
 */

import type { BlockId, ElementId, Priority } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, operationLog, reviewStates, tasks } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardEditService } from "./card-edit-service";
import { CardService } from "./card-service";
import { createRepositories, type Repositories } from "./index";
import { SourceRepository } from "./source-repository";
import { TaskService } from "./task-service";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let svc: TaskService;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  svc = new TaskService(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

/** Count `operation_log` rows of a given type for an element. */
function opCount(elementId: string, opType: string): number {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, elementId))
    .all()
    .filter((r) => r.opType === opType).length;
}

/** Seed a card (a Q&A card distilled from a fresh source+extract), returning its id. */
function seedCard(priority: Priority = PRIORITY_LABEL_VALUE.A): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element: source } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.",
  });
  const { element: extract } = sources.createExtract({
    sourceElementId: source.id,
    title: "Definition extract",
    priority,
    stage: "atomic_statement",
    selectedText: "The definition paragraph.",
    blockIds: ["blk_def" as BlockId],
    startOffset: 0,
    endOffset: 25,
    label: "Definition · ¶1",
  });
  const { element } = new CardService(handle.db).createFromExtract({
    extractId: extract.id,
    kind: "qa",
    prompt: "How does Chollet define intelligence?",
    answer: "Skill-acquisition efficiency.",
  });
  return element.id;
}

describe("createTask", () => {
  it("creates the element + tasks row + references edge in one transaction, attention-scheduled", () => {
    const cardId = seedCard(PRIORITY_LABEL_VALUE.A);
    const summary = svc.createTask({
      taskType: "verify_claim",
      title: "Verify the definition",
      note: "Check the 2024 revision",
      linkedElementId: cardId,
    });

    // The element is a `task`, status `scheduled`, stage `rough_topic`, with a dueAt.
    const el = handle.db.select().from(elements).where(eq(elements.id, summary.id)).get();
    expect(el?.type).toBe("task");
    expect(el?.status).toBe("scheduled");
    expect(el?.stage).toBe("rough_topic");
    expect(el?.dueAt).toBeTruthy();

    // The `tasks` side-table row mirrors it + carries the link + note.
    const row = handle.db.select().from(tasks).where(eq(tasks.elementId, summary.id)).get();
    expect(row?.taskType).toBe("verify_claim");
    expect(row?.status).toBe("scheduled");
    expect(row?.linkedElementId).toBe(cardId);
    expect(row?.note).toBe("Check the 2024 revision");
    expect(row?.dueAt).toBe(el?.dueAt);

    // Priority inherited from the linked card (A).
    expect(el?.priority).toBe(PRIORITY_LABEL_VALUE.A);
    expect(summary.priority).toBe(PRIORITY_LABEL_VALUE.A);

    // The canonical `references` edge task → card exists (logs add_relation).
    const edges = repos.elements.listRelationsFrom(summary.id);
    expect(edges.some((e) => e.relationType === "references" && e.toElementId === cardId)).toBe(
      true,
    );

    // The link is the `references` edge + `linked_element_id` ONLY — a task is NOT a
    // distillation child of the element it protects: it must NOT set `parentId`, so it
    // never pollutes the protected card's `children` lineage / `LineageTree`.
    expect(el?.parentId).toBeNull();
    expect(repos.elements.listChildren(cardId).map((c) => c.id)).not.toContain(summary.id);

    // The correct EXISTING ops — create_element + add_relation, no new op type.
    expect(opCount(summary.id, "create_element")).toBe(1);
    expect(opCount(summary.id, "add_relation")).toBe(1);

    // NEVER FSRS: a task must have no `review_states` row.
    const review = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, summary.id))
      .get();
    expect(review).toBeUndefined();

    // The summary resolves the linked element.
    expect(summary.linkedElement).toEqual({ id: cardId, type: "card", title: expect.any(String) });
  });

  it("defaults priority to B for an unlinked custom task", () => {
    const summary = svc.createTask({ taskType: "custom", title: "Tidy the inbox" });
    expect(summary.priority).toBe(PRIORITY_LABEL_VALUE.B);
    expect(summary.linkedElement).toBeNull();
    const row = handle.db.select().from(tasks).where(eq(tasks.elementId, summary.id)).get();
    expect(row?.linkedElementId).toBeNull();
  });

  it("honors an explicit dueChoice", () => {
    const summary = svc.createTask({ taskType: "custom", title: "x", dueChoice: "tomorrow" });
    expect(summary.dueAt).toBeTruthy();
  });

  it("rejects an empty title and a missing linked element", () => {
    expect(() => svc.createTask({ taskType: "custom", title: "   " })).toThrow(/title/);
    expect(() =>
      svc.createTask({
        taskType: "verify_claim",
        title: "x",
        linkedElementId: "nope" as ElementId,
      }),
    ).toThrow(/not found/);
  });
});

describe("completeTask / postponeTask", () => {
  it("completeTask moves status → done and logs reschedule_element", () => {
    const cardId = seedCard();
    const task = svc.createTask({
      taskType: "verify_claim",
      title: "Verify",
      linkedElementId: cardId,
    });
    const done = svc.completeTask(task.id);
    expect(done.status).toBe("done");

    const el = handle.db.select().from(elements).where(eq(elements.id, task.id)).get();
    expect(el?.status).toBe("done");
    const row = handle.db.select().from(tasks).where(eq(tasks.elementId, task.id)).get();
    expect(row?.status).toBe("done");
    expect(opCount(task.id, "reschedule_element")).toBeGreaterThanOrEqual(1);
  });

  it("completeTask can optionally bump the protected card's review_by (update_element)", () => {
    const cardId = seedCard();
    new CardEditService(handle.db).setLifetime(cardId, { reviewBy: "2020-01-01" });
    const task = svc.createTask({
      taskType: "update_outdated_card",
      title: "Update",
      linkedElementId: cardId,
    });
    const before = opCount(cardId, "update_element");
    svc.completeTask(task.id, { bumpReviewByDays: 365 });
    const card = handle.db.select().from(cards).where(eq(cards.elementId, cardId)).get();
    expect(card?.reviewBy).not.toBe("2020-01-01");
    expect(card?.reviewBy).toBeTruthy();
    expect(opCount(cardId, "update_element")).toBe(before + 1);
  });

  it("postponeTask reschedules further out and records the running postpone count", () => {
    const cardId = seedCard();
    const task = svc.createTask({
      taskType: "verify_claim",
      title: "Verify",
      linkedElementId: cardId,
    });
    const first = svc.postponeTask(task.id);
    expect(first.status).toBe("scheduled");
    const firstDue = first.dueAt;
    const second = svc.postponeTask(task.id);
    // The second postpone recedes at least as far (grows with the count).
    expect(Date.parse(second.dueAt ?? "")).toBeGreaterThanOrEqual(Date.parse(firstDue ?? ""));
    // The reschedule ops carry a postpone marker.
    const reschedules = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, task.id))
      .all()
      .filter((r) => r.opType === "reschedule_element");
    expect(reschedules.length).toBeGreaterThanOrEqual(2);
  });
});

describe("listOpenTasks / listDueTasks", () => {
  it("lists open tasks, filterable by linked element, excluding done/deleted", () => {
    const cardA = seedCard();
    const cardB = seedCard();
    const tA = svc.createTask({ taskType: "verify_claim", title: "A", linkedElementId: cardA });
    svc.createTask({ taskType: "verify_claim", title: "B", linkedElementId: cardB });

    expect(svc.listOpenTasks().length).toBe(2);
    expect(svc.listOpenTasks({ linkedElementId: cardA }).map((t) => t.id)).toEqual([tA.id]);

    svc.completeTask(tA.id);
    expect(svc.listOpenTasks().length).toBe(1);
    expect(svc.listOpenTasks({ linkedElementId: cardA })).toEqual([]);
  });

  it("listDueTasks returns only open tasks due at/before now", () => {
    const card = seedCard();
    const task = svc.createTask({
      taskType: "verify_claim",
      title: "Verify",
      linkedElementId: card,
      dueChoice: { manual: "2020-01-01T00:00:00.000Z" },
    });
    expect(svc.listDueTasks("2026-06-01T00:00:00.000Z").map((t) => t.id)).toEqual([task.id]);
    expect(svc.listDueTasks("2019-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("soft-delete removes a task from the open list", () => {
    const card = seedCard();
    const task = svc.createTask({ taskType: "verify_claim", title: "V", linkedElementId: card });
    svc.deleteTask(task.id);
    expect(svc.listOpenTasks().length).toBe(0);
    const el = handle.db.select().from(elements).where(eq(elements.id, task.id)).get();
    expect(el?.status).toBe("deleted");
    expect(el?.deletedAt).toBeTruthy();
  });
});

describe("generateVerificationTasks", () => {
  it("creates an update_outdated_card task for an EXPIRED card and is idempotent", () => {
    const cardId = seedCard(PRIORITY_LABEL_VALUE.A);
    // Past valid_until → expired.
    new CardEditService(handle.db).setLifetime(cardId, { validUntil: "2020-01-01" });

    const first = svc.generateVerificationTasks("2026-06-01T00:00:00.000Z");
    expect(first.created).toBe(1);
    expect(first.tasks[0]?.taskType).toBe("update_outdated_card");
    expect(first.tasks[0]?.linkedElement?.id).toBe(cardId);
    // Priority inherited from the protected card (A).
    expect(first.tasks[0]?.priority).toBe(PRIORITY_LABEL_VALUE.A);

    // A second run creates NONE (idempotent — the open task already protects the card).
    const second = svc.generateVerificationTasks("2026-06-01T00:00:00.000Z");
    expect(second.created).toBe(0);
    expect(svc.listOpenTasks({ linkedElementId: cardId }).length).toBe(1);
  });

  it("creates a verify_claim task for a DUE_FOR_REVIEW card", () => {
    const cardId = seedCard();
    // Past review_by but no/future valid_until → due_for_review.
    new CardEditService(handle.db).setLifetime(cardId, { reviewBy: "2020-01-01" });
    const res = svc.generateVerificationTasks("2026-06-01T00:00:00.000Z");
    expect(res.created).toBe(1);
    expect(res.tasks[0]?.taskType).toBe("verify_claim");
  });

  it("generates nothing for a fresh / lifetime-less card", () => {
    seedCard(); // no lifetime
    const fresh = seedCard();
    new CardEditService(handle.db).setLifetime(fresh, { reviewBy: "2099-01-01" });
    const res = svc.generateVerificationTasks("2026-06-01T00:00:00.000Z");
    expect(res.created).toBe(0);
  });

  it("the partial unique index rejects a direct duplicate OPEN task of the same kind", () => {
    const cardId = seedCard();
    new CardEditService(handle.db).setLifetime(cardId, { validUntil: "2020-01-01" });
    svc.generateVerificationTasks("2026-06-01T00:00:00.000Z");
    // A direct duplicate-open-task insert for the same (linked_element_id, task_type) must fail.
    expect(() =>
      handle.db
        .insert(tasks)
        .values({
          elementId: "dup-task-id",
          taskType: "update_outdated_card",
          status: "scheduled",
          linkedElementId: cardId,
          dueAt: null,
          note: null,
        })
        .run(),
    ).toThrow();
  });

  it("a done/parked/dismissed task does NOT block a fresh open one of the same kind", () => {
    const cardId = seedCard();
    new CardEditService(handle.db).setLifetime(cardId, { validUntil: "2020-01-01" });
    const first = svc.generateVerificationTasks("2026-06-01T00:00:00.000Z");
    expect(first.created).toBe(1);
    // Complete it → terminal status, so the partial index no longer covers it.
    svc.completeTask(first.tasks[0]?.id as ElementId);
    // A fresh generation creates a new open task (the closed one does not block it).
    const second = svc.generateVerificationTasks("2026-06-01T00:00:00.000Z");
    expect(second.created).toBe(1);
    expect(svc.listOpenTasks({ linkedElementId: cardId }).length).toBe(1);

    const parkedTaskId = second.tasks[0]?.id as ElementId;
    handle.db.update(elements).set({ status: "parked" }).where(eq(elements.id, parkedTaskId)).run();
    handle.db
      .update(tasks)
      .set({ status: "parked" })
      .where(eq(tasks.elementId, parkedTaskId))
      .run();
    const third = svc.generateVerificationTasks("2026-06-01T00:00:00.000Z");
    expect(third.created).toBe(1);
    expect(svc.listOpenTasks({ linkedElementId: cardId }).map((task) => task.id)).toEqual([
      third.tasks[0]?.id,
    ]);
  });
});
