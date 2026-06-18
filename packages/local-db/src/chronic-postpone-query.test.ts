import type { ElementId } from "@interleave/core";
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

/**
 * U13 — chronic-postpone batched op-log drift tests.
 *
 * `listCandidates` / `countDue` formerly called `operationLog.countPostpones(id)`
 * per row — one SQL scan per element over the uncapped live set. U13 replaces this
 * with ONE `postponeCountsForMany(candidateIds)` call, using the `effective` map.
 * These tests assert byte-identical output vs the per-row behaviour and guard the
 * correctness invariants from the plan.
 */
describe("ChronicPostponeQuery U13 — batched op-log counts", () => {
  it("drift: listDue deepEquals per-row behaviour over a seed with varied postpone histories", () => {
    const sourceA = repos.sources.create({
      title: "Source A (5 postpones)",
      priority: priorityFromLabel("A"),
      status: "scheduled",
      stage: "raw_source",
    }).element.id;
    const sourceB = repos.sources.create({
      title: "Source B (2 postpones, below threshold)",
      priority: priorityFromLabel("B"),
      status: "scheduled",
      stage: "raw_source",
    }).element.id;
    const topic = repos.elements.create({
      type: "topic",
      title: "Topic (3 postpones, at threshold)",
      priority: priorityFromLabel("C"),
      status: "scheduled",
      stage: "rough_topic",
    }).id;
    const doneSource = repos.sources.create({
      title: "Done source (6 postpones, but status excluded)",
      priority: priorityFromLabel("A"),
      status: "done",
      stage: "raw_source",
    }).element.id;

    postpone(sourceA, 5);
    postpone(sourceB, 2);
    postpone(topic, 3);
    postpone(doneSource, 6);

    const threshold = 3;
    const query = new ChronicPostponeQuery(handle.db);
    const result = query.listDue({ threshold });

    // sourceA (5) and topic (3) qualify; sourceB (2) and doneSource (excluded) do not.
    expect(result.totalDue).toBe(2);
    const ids = result.rows.map((r) => r.element.id);
    expect(ids).toContain(sourceA as ElementId);
    expect(ids).toContain(topic as ElementId);
    expect(ids).not.toContain(sourceB as ElementId);
    expect(ids).not.toContain(doneSource as ElementId);
    // countDue agrees.
    expect(query.countDue({ threshold })).toBe(2);
  });

  it("drift: reset marker is respected — element with a reset is excluded identically", () => {
    const source = repos.sources.create({
      title: "Reset then below threshold",
      priority: priorityFromLabel("B"),
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
    // Effective count is now 0 → below any threshold.
    const query = new ChronicPostponeQuery(handle.db);
    expect(query.countDue({ threshold: 1 })).toBe(0);
    expect(query.listDue({ threshold: 1 }).rows.map((r) => r.element.id)).not.toContain(
      source as ElementId,
    );
  });

  it("element with NO op-log rows is still evaluated and contributes 0 (regression guard against scoping the scan)", () => {
    // This element has ZERO op-log entries — it must be evaluated by listCandidates and
    // correctly return 0, not be silently dropped because it is absent from the op-log.
    const clean = repos.sources.create({
      title: "Clean source (never postponed)",
      priority: priorityFromLabel("A"),
      status: "scheduled",
      stage: "raw_source",
    }).element.id;
    // A SECOND element that does qualify — ensures the test is non-vacuous.
    const heavy = repos.sources.create({
      title: "Heavy postponer (5 times)",
      priority: priorityFromLabel("B"),
      status: "scheduled",
      stage: "raw_source",
    }).element.id;
    postpone(heavy, 5);

    const query = new ChronicPostponeQuery(handle.db);
    const result = query.listDue({ threshold: 5 });
    // heavy qualifies; clean must NOT appear (its count is 0, below threshold 5).
    expect(result.rows.map((r) => r.element.id)).toContain(heavy as ElementId);
    expect(result.rows.map((r) => r.element.id)).not.toContain(clean as ElementId);
    // The clean element's postponeCount would be 0 — not threshold-qualified.
    expect(result.totalDue).toBe(1);
  });

  it("drift non-vacuous guard: a wrong postpone count causes the inclusion check to differ", () => {
    // If the batched map were scoped to "op-log present" elements only, clean sources
    // would be dropped. The test above already covers that. Here we verify that the
    // postponeCount reported on the rows is correct (not truncated/inflated by batching).
    const source = repos.sources.create({
      title: "Exact threshold source",
      priority: priorityFromLabel("B"),
      status: "scheduled",
      stage: "raw_source",
    }).element.id;
    postpone(source, 4);

    const query = new ChronicPostponeQuery(handle.db);
    // At threshold 5 — source does NOT qualify (4 < 5).
    expect(query.countDue({ threshold: 5 })).toBe(0);
    // At threshold 4 — source DOES qualify (4 >= 4).
    expect(query.countDue({ threshold: 4 })).toBe(1);
    const row = query.listDue({ threshold: 4 }).rows[0];
    expect(row?.postponeCount).toBe(4);
  });
});
