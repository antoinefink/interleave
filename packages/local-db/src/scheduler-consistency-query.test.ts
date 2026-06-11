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
