import type { ElementId, IsoTimestamp } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import { type DbHandle, elements, operationLog, tasks } from "@interleave/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepositories, type Repositories } from "./index";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;

const NOW = "2026-06-12T12:00:00.000Z" as IsoTimestamp;

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

describe("WeeklyReviewQuery / WeeklyReviewService", () => {
  it("creates one scheduled weekly_review task for the next cadence in an empty vault", () => {
    const summary = repos.weeklyReview.summary(NOW);
    expect(summary.enabled).toBe(true);
    expect(summary.session?.taskType).toBe("weekly_review");
    expect(summary.session?.dueAt).toBe("2026-06-19T12:00:00.000Z");
    expect(summary.due).toBe(false);

    const again = repos.weeklyReview.summary(NOW);
    expect(again.session?.id).toBe(summary.session?.id);
    expect(repos.queue.dueAttentionItems(NOW).map((row) => row.id)).not.toContain(
      summary.session?.id,
    );
  });

  it("creates an immediately due weekly_review task when there is weekly material", () => {
    repos.sources.create({
      title: "Weekly source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
    });

    const summary = repos.weeklyReview.summary(NOW);
    expect(summary.session?.taskType).toBe("weekly_review");
    expect(summary.session?.dueAt).toBe(NOW);
    expect(summary.due).toBe(true);
    expect(repos.queue.dueAttentionItems(NOW).map((row) => row.id)).toContain(summary.session?.id);
  });

  it("persists section progress across dismiss and clears it on complete", () => {
    const summary = repos.weeklyReview.summary(NOW);
    const taskId = required(summary.session?.id);
    repos.weeklyReviewService.updateProgress({
      taskId,
      sections: { ledger: "done", chronic: "skipped" },
    });

    const dismissed = repos.weeklyReviewService.dismissSession(taskId, {
      asOf: NOW,
      snoozeDays: 2,
    });
    expect(dismissed.task?.dueAt).toBe("2026-06-14T12:00:00.000Z");
    expect(dismissed.progress?.sections.ledger).toBe("done");

    const afterDismiss = repos.weeklyReview.summary(NOW);
    expect(afterDismiss.progress?.sections.chronic).toBe("skipped");

    const completed = repos.weeklyReviewService.completeSession(taskId, NOW);
    expect(completed.task?.dueAt).toBe("2026-06-19T12:00:00.000Z");
    expect(completed.task?.id).not.toBe(taskId);
    expect(completed.progress).toBeNull();
    expect(handle.db.select().from(tasks).where(eq(tasks.elementId, taskId)).get()?.status).toBe(
      "done",
    );
    const afterComplete = repos.weeklyReview.summary(NOW);
    expect(afterComplete.progress?.sections.ledger).toBe("pending");
  });

  it("repairs soft-deleted weekly rows before creating a replacement", () => {
    const source = repos.sources.create({
      title: "Source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
    });
    expect(source.element.id).toBeTruthy();
    const first = repos.weeklyReview.summary(NOW);
    const taskId = required(first.session?.id);

    repos.elements.softDelete(taskId);
    const next = repos.weeklyReview.summary(NOW);

    expect(next.session?.id).not.toBe(taskId);
    expect(handle.db.select().from(tasks).where(eq(tasks.elementId, taskId)).get()?.status).toBe(
      "deleted",
    );
    expect(next.session?.taskType).toBe("weekly_review");
  });

  it("audits progress writes against the weekly task", () => {
    repos.sources.create({
      title: "Audited source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
    });
    const summary = repos.weeklyReview.summary(NOW);
    const taskId = required(summary.session?.id);

    repos.weeklyReviewService.updateProgress({ taskId, sections: { ledger: "done" } });

    const rows = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, taskId))
      .all();
    expect(rows.some((row) => row.payload.includes("weeklyReviewProgress"))).toBe(true);
  });

  it("composes weekly ledger counts and decision queues from existing read models", () => {
    const source = repos.sources.create({
      title: "Priority source",
      priority: PRIORITY_LABEL_VALUE.A,
      status: "active",
    });
    const extract = repos.sources.createExtract({
      sourceElementId: source.element.id,
      title: "Important extract",
      priority: PRIORITY_LABEL_VALUE.A,
      selectedText: "Important",
      blockIds: [],
      label: null,
    });
    const card = repos.review.createCard({
      kind: "qa",
      title: "Mature card",
      priority: PRIORITY_LABEL_VALUE.A,
      prompt: "Q",
      answer: "A",
      parentId: extract.element.id,
      sourceId: source.element.id,
      sourceLocationId: extract.location.id,
      stage: "active_card",
    });
    repos.review.recordReview(card.element.id, {
      rating: "good",
      reviewedAt: NOW,
      responseMs: 1000,
      prevState: "new",
      nextState: "review",
      nextStability: 10,
      nextDifficulty: 5,
      nextDueAt: "2026-06-20T12:00:00.000Z" as IsoTimestamp,
      elapsedDays: 1,
      scheduledDays: 8,
      reps: 2,
      lapses: 0,
      nextLearningSteps: 0,
    });
    repos.elements.reschedule(source.element.id, "2026-06-10T12:00:00.000Z" as IsoTimestamp);
    handle.db
      .update(elements)
      .set({
        createdAt: "2026-06-10T12:00:00.000Z",
        updatedAt: "2026-06-10T12:00:00.000Z",
      })
      .where(inArray(elements.id, [source.element.id, extract.element.id, card.element.id]))
      .run();
    handle.db.transaction((tx) => {
      repos.elements.rescheduleWithin(
        tx,
        source.element.id,
        "2026-06-20T12:00:00.000Z" as IsoTimestamp,
        "scheduled",
        {
          dueAt: "2026-06-20T12:00:00.000Z",
          postpone: true,
          postponeCount: 1,
          prevDueAt: "2026-06-10T12:00:00.000Z",
        },
        { updatedAt: NOW },
      );
    });
    handle.db
      .update(operationLog)
      .set({ createdAt: NOW })
      .where(
        and(
          eq(operationLog.elementId, source.element.id),
          eq(operationLog.opType, "reschedule_element"),
        ),
      )
      .run();

    const summary = repos.weeklyReview.summary(NOW);
    expect(summary.ledger.sources).toBeGreaterThanOrEqual(1);
    expect(summary.ledger.extracts).toBeGreaterThanOrEqual(1);
    expect(summary.ledger.cards).toBeGreaterThanOrEqual(1);
    expect(summary.ledger.maturedCards).toBe(1);
    expect(summary.ledger.priorityMisses.some((miss) => miss.band === "A")).toBe(true);
  });

  it("counts the prior window symmetrically for week-over-week deltas", () => {
    // Current window for NOW (2026-06-12) is [2026-06-06T00:00Z, 2026-06-12T12:00Z];
    // the prior window is the equal-length window [2026-05-30T00:00Z, 2026-06-06T00:00Z).
    const current = "2026-06-08T09:00:00.000Z" as IsoTimestamp;
    const prior = "2026-06-02T09:00:00.000Z" as IsoTimestamp;

    // Two sources + one extract + one card in the current window.
    const currentSource = createSourceAt(current);
    createSourceAt(current);
    const currentExtract = createExtractAt(currentSource, current);
    createCardAt(currentExtract, currentSource, current);
    // One matured card in the current window.
    matureCardAt(createCardAt(currentExtract, currentSource, current), current);

    // One source + three extracts (two standalone, one parents the matured card) +
    // one matured card in the prior window.
    const priorSource = createSourceAt(prior);
    createExtractAt(priorSource, prior);
    createExtractAt(priorSource, prior);
    matureCardAt(createCardAt(createExtractAt(priorSource, prior), priorSource, prior), prior);

    const { ledger } = repos.weeklyReview.summary(NOW);

    expect(ledger.sources).toBe(2);
    expect(ledger.extracts).toBe(1);
    expect(ledger.cards).toBe(2);
    expect(ledger.maturedCards).toBe(1);

    expect(ledger.sourcesPrev).toBe(1);
    expect(ledger.extractsPrev).toBe(3);
    expect(ledger.cardsPrev).toBe(1);
    expect(ledger.maturedCardsPrev).toBe(1);
  });

  it("returns zero prior counts when the prior window is empty", () => {
    const current = "2026-06-08T09:00:00.000Z" as IsoTimestamp;
    const source = createSourceAt(current);
    createExtractAt(source, current);

    const { ledger } = repos.weeklyReview.summary(NOW);

    expect(ledger.sources).toBe(1);
    expect(ledger.extracts).toBe(1);
    expect(ledger.sourcesPrev).toBe(0);
    expect(ledger.extractsPrev).toBe(0);
    expect(ledger.cardsPrev).toBe(0);
    expect(ledger.maturedCardsPrev).toBe(0);
  });

  it("attributes a boundary-dated item to exactly one window", () => {
    // The current window starts at 2026-06-06T00:00Z. An element created exactly at the
    // boundary belongs to the current window (gte start) and is excluded from the prior
    // window (lt start), so it must never be double counted.
    const boundary = "2026-06-06T00:00:00.000Z" as IsoTimestamp;
    createSourceAt(boundary);

    const { ledger } = repos.weeklyReview.summary(NOW);

    expect(ledger.sources).toBe(1);
    expect(ledger.sourcesPrev).toBe(0);
  });

  it("returns zero prior counts when there is no full prior window of data", () => {
    // Only current-window material exists; the prior window has no data at all.
    const current = "2026-06-09T09:00:00.000Z" as IsoTimestamp;
    const source = createSourceAt(current);
    createCardAt(createExtractAt(source, current), source, current);

    const { ledger } = repos.weeklyReview.summary(NOW);

    expect(ledger.cards).toBe(1);
    expect(ledger.cardsPrev).toBe(0);
    expect(ledger.sourcesPrev).toBe(0);
    expect(ledger.extractsPrev).toBe(0);
    expect(ledger.maturedCardsPrev).toBe(0);
  });
});

function createSourceAt(at: IsoTimestamp): ElementId {
  const source = repos.sources.create({
    title: "Source",
    priority: PRIORITY_LABEL_VALUE.A,
    status: "active",
  });
  stampCreatedAt(source.element.id, at);
  return source.element.id;
}

function createExtractAt(sourceId: ElementId, at: IsoTimestamp): ElementId {
  const extract = repos.sources.createExtract({
    sourceElementId: sourceId,
    title: "Extract",
    priority: PRIORITY_LABEL_VALUE.A,
    selectedText: "Selected",
    blockIds: [],
    label: null,
  });
  stampCreatedAt(extract.element.id, at);
  return extract.element.id;
}

function createCardAt(parentId: ElementId, sourceId: ElementId, at: IsoTimestamp): ElementId {
  const card = repos.review.createCard({
    kind: "qa",
    title: "Card",
    priority: PRIORITY_LABEL_VALUE.A,
    prompt: "Q",
    answer: "A",
    parentId,
    sourceId,
    sourceLocationId: null,
    stage: "active_card",
  });
  stampCreatedAt(card.element.id, at);
  return card.element.id;
}

function matureCardAt(cardId: ElementId, reviewedAt: IsoTimestamp): void {
  repos.review.recordReview(cardId, {
    rating: "good",
    reviewedAt,
    responseMs: 1000,
    prevState: "new",
    nextState: "review",
    nextStability: 10,
    nextDifficulty: 5,
    nextDueAt: "2026-07-01T12:00:00.000Z" as IsoTimestamp,
    elapsedDays: 1,
    scheduledDays: 8,
    reps: 2,
    lapses: 0,
    nextLearningSteps: 0,
  });
}

function stampCreatedAt(id: ElementId, at: IsoTimestamp): void {
  handle.db.update(elements).set({ createdAt: at, updatedAt: at }).where(eq(elements.id, id)).run();
}

function required(id: ElementId | undefined): ElementId {
  if (!id) throw new Error("expected weekly task id");
  return id;
}
