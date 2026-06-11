import { priorityFromLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChronicPostponeQuery } from "./chronic-postpone-query";
import { createRepositories, type Repositories } from "./index";
import type { OperationLogRepository } from "./operation-log-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let log: OperationLogRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  log = repos.operationLog;
});

afterEach(() => {
  handle.sqlite.close();
});

function postpone(id: string, times: number): void {
  for (let i = 0; i < times; i++) {
    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "reschedule_element",
        payload: { postpone: true, postponeCount: i + 1 },
        elementId: id as never,
      });
    });
  }
}

describe("ChronicPostponeQuery", () => {
  it("lists live supported non-task items whose effective postpone count reaches the threshold, even when due in the future", () => {
    const source = repos.sources.create({
      title: "Repeated source",
      priority: priorityFromLabel("A"),
      status: "scheduled",
      stage: "raw_source",
    }).element.id;
    const futureDue = "2030-01-01T00:00:00.000Z" as never;
    repos.elements.update(source, { dueAt: futureDue });
    const topic = repos.elements.create({
      type: "topic",
      title: "Almost topic",
      priority: priorityFromLabel("B"),
      status: "scheduled",
      stage: "rough_topic",
    }).id;
    const task = repos.elements.create({
      type: "task",
      title: "Verification task",
      priority: priorityFromLabel("C"),
      status: "scheduled",
      stage: "rough_topic",
    }).id;
    const done = repos.sources.create({
      title: "Done source",
      priority: priorityFromLabel("A"),
      status: "done",
      stage: "raw_source",
    }).element.id;
    const parked = repos.sources.create({
      title: "Parked source",
      priority: priorityFromLabel("A"),
      status: "parked",
      stage: "raw_source",
    }).element.id;
    const deleted = repos.sources.create({
      title: "Deleted source",
      priority: priorityFromLabel("A"),
      status: "scheduled",
      stage: "raw_source",
    }).element.id;
    const card = repos.review.createCard({
      kind: "qa",
      title: "Repeated card",
      prompt: "Q",
      answer: "A",
      priority: priorityFromLabel("B"),
      stage: "active_card",
      firstScheduledAt: "2026-06-01T00:00:00.000Z" as never,
    }).element.id;
    const retired = repos.review.createCard({
      kind: "qa",
      title: "Retired card",
      prompt: "Q",
      answer: "A",
      priority: priorityFromLabel("B"),
      stage: "active_card",
      firstScheduledAt: "2026-06-01T00:00:00.000Z" as never,
    }).element.id;
    handle.db.update(cards).set({ isRetired: true }).where(eq(cards.elementId, retired)).run();

    postpone(source, 5);
    postpone(topic, 4);
    postpone(task, 6);
    postpone(done, 6);
    postpone(parked, 6);
    postpone(deleted, 6);
    postpone(card, 5);
    postpone(retired, 6);
    repos.elements.softDelete(deleted);

    const result = new ChronicPostponeQuery(handle.db).listDue({ threshold: 5 });

    expect(result.totalDue).toBe(2);
    expect(result.rows.map((row) => row.element.id)).toEqual([source, card]);
    expect(result.rows[0]).toMatchObject({
      scheduler: "attention",
      postponeCount: 5,
      element: { type: "source", priorityLabel: "A", dueAt: futureDue },
    });
    expect(result.rows[1]).toMatchObject({
      scheduler: "fsrs",
      postponeCount: 5,
      element: { type: "card", priorityLabel: "B" },
    });
  });

  it("uses the folded effective count after a chronic reset marker", () => {
    const source = repos.sources.create({
      title: "Reset source",
      priority: priorityFromLabel("C"),
      status: "scheduled",
      stage: "raw_source",
    }).element.id;
    postpone(source, 5);
    handle.db.transaction((tx) => {
      log.append(tx, {
        opType: "update_element",
        payload: { chronicPostponeReset: true, prevEffectivePostponeCount: 5 },
        elementId: source as never,
      });
    });

    const result = new ChronicPostponeQuery(handle.db).listDue({ threshold: 5 });

    expect(result.totalDue).toBe(0);
    expect(result.rows).toEqual([]);
  });
});
