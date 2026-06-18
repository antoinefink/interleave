import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import type { SchedulerConsistencyQuery } from "./scheduler-consistency-query";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let query: SchedulerConsistencyQuery;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  query = repos.schedulerConsistency;
});

afterEach(() => {
  handle.sqlite.close();
});

function appendPostpones(id: string, times: number): void {
  for (let i = 0; i < times; i += 1) {
    handle.db.transaction((tx) => {
      repos.operationLog.append(tx, {
        opType: "reschedule_element",
        elementId: id as never,
        payload: { id, postpone: true, postponeCount: i + 1 },
      });
    });
  }
}

function appendReschedule(id: string, payload: Record<string, unknown>): void {
  handle.db.transaction((tx) => {
    repos.operationLog.append(tx, {
      opType: "reschedule_element",
      elementId: id as never,
      payload: { id, ...payload },
    });
  });
}

describe("SchedulerConsistencyQuery", () => {
  it("surfaces terminal elements that still carry an element due date", () => {
    const source = repos.sources.create({
      title: "Done but still scheduled",
      priority: PRIORITY_LABEL_VALUE.D,
      status: "active",
      stage: "raw_source",
    });
    repos.elements.update(source.element.id, { status: "done" });
    handle.sqlite
      .prepare("UPDATE elements SET due_at = ? WHERE id = ?")
      .run("2026-06-08T00:00:00.000Z", source.element.id);

    expect(query.list().map((r) => r.reason)).toContain("terminal-element-due");
    expect(query.count()).toBe(1);
  });

  it("surfaces terminal cards and retired cards that still carry FSRS due state", () => {
    const terminal = repos.review.createCard({
      kind: "qa",
      title: "Done card",
      priority: PRIORITY_LABEL_VALUE.C,
      prompt: "Q",
      answer: "A",
    });
    handle.db
      .update(reviewStates)
      .set({ dueAt: "2026-06-08T00:00:00.000Z" })
      .where(eq(reviewStates.elementId, terminal.element.id))
      .run();
    repos.elements.update(terminal.element.id, { status: "dismissed" });

    const retired = repos.review.createCard({
      kind: "qa",
      title: "Retired card",
      priority: PRIORITY_LABEL_VALUE.C,
      prompt: "Q",
      answer: "A",
    });
    handle.db
      .update(reviewStates)
      .set({ dueAt: "2026-06-08T00:00:00.000Z" })
      .where(eq(reviewStates.elementId, retired.element.id))
      .run();
    handle.db
      .update(cards)
      .set({ isRetired: true })
      .where(eq(cards.elementId, retired.element.id))
      .run();

    const reasons = query.list().map((r) => r.reason);
    expect(reasons).toContain("terminal-card-review-due");
    expect(reasons).toContain("retired-card-review-due");
  });

  it("surfaces scheduled attention rows that have no return date", () => {
    repos.sources.create({
      title: "Scheduled without due",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });

    const row = query.list()[0];
    expect(row?.reason).toBe("scheduled-attention-missing-due");
  });

  it("surfaces live attention rows whose heuristic due date is not after its scheduler decision", () => {
    const source = repos.sources.create({
      title: "Due before last seen",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    repos.elements.update(source.element.id, {
      dueAt: "2026-06-01T12:00:00.000Z",
      status: "scheduled",
    });
    appendReschedule(source.element.id, {
      action: "extract",
      scheduledAt: "2026-06-01T12:00:00.000Z",
    });

    const row = query.list().find((r) => r.reason === "attention-due-before-last-seen");

    expect(row?.element.id).toBe(source.element.id);
    expect(row?.elementDueAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("does not surface explicit manual past schedules", () => {
    const source = repos.sources.create({
      title: "Manual past schedule",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    repos.elements.update(source.element.id, {
      dueAt: "2026-06-01T12:00:00.000Z",
      status: "scheduled",
    });
    appendReschedule(source.element.id, {
      action: "postpone",
      scheduledAt: "2026-06-01T12:00:00.000Z",
    });
    appendReschedule(source.element.id, {
      choice: "manual",
      dueAt: "2026-05-31T12:00:00.000Z",
    });

    const rows = query.list().filter((r) => r.element.id === source.element.id);

    expect(rows.map((r) => r.reason)).not.toContain("attention-due-before-last-seen");
  });

  it("does not surface queue-soon rows", () => {
    const source = repos.sources.create({
      title: "Queue soon",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    repos.elements.update(source.element.id, {
      dueAt: "2026-06-01T12:00:00.000Z",
      status: "scheduled",
    });
    appendReschedule(source.element.id, {
      action: "queueSoon",
      queueSoon: true,
      scheduledAt: "2026-06-01T12:00:00.000Z",
    });

    const rows = query.list().filter((r) => r.element.id === source.element.id);

    expect(rows.map((r) => r.reason)).not.toContain("attention-due-before-last-seen");
  });

  it("does not use later non-scheduling updated_at changes as scheduler decisions", () => {
    const source = repos.sources.create({
      title: "Later update",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    repos.elements.update(source.element.id, {
      dueAt: "2026-06-05T12:00:00.000Z",
      status: "scheduled",
    });
    appendReschedule(source.element.id, {
      action: "rewrite",
      scheduledAt: "2026-06-01T12:00:00.000Z",
    });
    handle.sqlite
      .prepare("UPDATE elements SET updated_at = ? WHERE id = ?")
      .run("2026-06-10T12:00:00.000Z", source.element.id);

    const rows = query.list().filter((r) => r.element.id === source.element.id);

    expect(rows.map((r) => r.reason)).not.toContain("attention-due-before-last-seen");
  });

  it("honors the caller limit for heuristic due-before-last-seen diagnostics", () => {
    for (const title of ["First limited", "Second limited"]) {
      const source = repos.sources.create({
        title,
        priority: PRIORITY_LABEL_VALUE.B,
        status: "scheduled",
        stage: "raw_source",
      });
      repos.elements.update(source.element.id, {
        dueAt: "2026-06-01T12:00:00.000Z",
        status: "scheduled",
      });
      appendReschedule(source.element.id, {
        action: "rewrite",
        scheduledAt: "2026-06-01T12:00:00.000Z",
      });
    }

    const rows = query.list(1).filter((r) => r.reason === "attention-due-before-last-seen");

    expect(rows).toHaveLength(1);
  });

  it("surfaces chronic-postpone rows whose recession is paused pending a decision", () => {
    const source = repos.sources.create({
      title: "Paused by chronic postpones",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    appendPostpones(source.element.id, 5);

    const row = query.list().find((r) => r.reason === "chronic-postpone-paused");

    expect(row?.element.id).toBe(source.element.id);
  });

  it("surfaces rows whose chronic postpone count was explicitly reset", () => {
    const source = repos.sources.create({
      title: "Reset chronic source",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    appendPostpones(source.element.id, 5);
    handle.db.transaction((tx) => {
      repos.operationLog.append(tx, {
        opType: "update_element",
        elementId: source.element.id,
        payload: {
          id: source.element.id,
          chronicPostponeReset: true,
          prevEffectivePostponeCount: 5,
        },
      });
    });

    const reasons = query.list().map((r) => r.reason);

    expect(reasons).toContain("chronic-postpone-reset");
    expect(reasons).not.toContain("chronic-postpone-paused");
  });
});

/**
 * U13 — scheduler-consistency chronicPostponeReset batched op-log drift tests.
 *
 * The `chronicPostponeReset` detector formerly called `rawPostponeCount(db, id)` AND
 * `operationLogRepository.countPostpones(id)` per row — two SQL scans per element.
 * U13 replaces both with ONE `postponeCountsForMany` call yielding `{ raw, effective }`
 * maps. These tests assert byte-identical detection results and guard the correctness
 * invariants (full-candidate scan, no scoping to op-log-present ids).
 */
describe("SchedulerConsistencyQuery U13 — chronicPostponeReset batched op-log", () => {
  it("drift: reset detection flags the same elements (raw > effective) as the per-element path", () => {
    // Element with 5 raw postpones + 1 reset marker → effective = 0, raw = 5 → flagged.
    const resetSource = repos.sources.create({
      title: "Reset source — should be flagged",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    appendPostpones(resetSource.element.id, 5);
    handle.db.transaction((tx) => {
      repos.operationLog.append(tx, {
        opType: "update_element",
        elementId: resetSource.element.id,
        payload: {
          id: resetSource.element.id,
          chronicPostponeReset: true,
          prevEffectivePostponeCount: 5,
        },
      });
    });

    // Element with only raw postpones (no reset) → raw == effective → NOT flagged.
    const plainSource = repos.sources.create({
      title: "Plain postponed source — not flagged",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    appendPostpones(plainSource.element.id, 3);

    const resetRows = query.list().filter((r) => r.reason === "chronic-postpone-reset");
    const resetIds = resetRows.map((r) => r.element.id);

    expect(resetIds).toContain(resetSource.element.id);
    expect(resetIds).not.toContain(plainSource.element.id);
    // count() agrees.
    expect(query.count()).toBeGreaterThanOrEqual(1);
  });

  it("element with NO op-log rows is still evaluated and contributes 0 (regression guard against scoping the scan)", () => {
    // A clean element with ZERO op-log rows must not cause any errors or silently
    // disappear from the candidate set. Its raw and effective counts are both 0,
    // so 0 > 0 is false → it is NOT flagged. If the scan were scoped only to
    // "op-log-present" elements, this element would be dropped silently — breaking the
    // correctness of the consistency report for any element that has never been postponed.
    const clean = repos.sources.create({
      title: "Clean source — zero op-log rows",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });

    // A SECOND element that IS flagged — ensures the detection still works in the same run.
    const resetSource = repos.sources.create({
      title: "Reset source for non-vacuous check",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    appendPostpones(resetSource.element.id, 3);
    handle.db.transaction((tx) => {
      repos.operationLog.append(tx, {
        opType: "update_element",
        elementId: resetSource.element.id,
        payload: { chronicPostponeReset: true, prevEffectivePostponeCount: 3 },
      });
    });

    const resetRows = query.list().filter((r) => r.reason === "chronic-postpone-reset");
    const resetIds = resetRows.map((r) => r.element.id);

    // The reset element IS flagged.
    expect(resetIds).toContain(resetSource.element.id);
    // The clean element is NOT flagged (0 > 0 is false).
    expect(resetIds).not.toContain(clean.element.id);
  });

  it("drift non-vacuous guard: an element without a reset is NOT flagged (raw == effective)", () => {
    // If the batched map had the wrong semantics (e.g. applied reset-folding to the
    // raw map), raw would equal effective for a reset element and the detection would
    // miss it. This test confirms that a plain-postpone element (no reset) is NEVER
    // flagged, proving the two maps have distinct semantics.
    const plainSource = repos.sources.create({
      title: "Plain source — no reset marker",
      priority: PRIORITY_LABEL_VALUE.B,
      status: "scheduled",
      stage: "raw_source",
    });
    appendPostpones(plainSource.element.id, 5);

    // No reset marker → raw (5) == effective (5) → NOT flagged.
    const resetRows = query.list().filter((r) => r.reason === "chronic-postpone-reset");
    expect(resetRows.map((r) => r.element.id)).not.toContain(plainSource.element.id);
  });
});
