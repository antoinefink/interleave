/**
 * ReviewRepository.createCardWithin widening (T070).
 *
 * Asserts the additive `sourceUri` + `reviewSeed` inputs (the mechanism Anki import
 * uses to preserve review history) persist correctly into `cards`/`review_states`,
 * and — critically — that the EXISTING no-seed path is byte-identical to before (no
 * regression to the authored-card shape every M6/M7 caller relies on). Runs against
 * a temporary, fully-migrated in-memory better-sqlite3 DB.
 */

import type { ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elements, operationLog, reviewLogs, reviewStates } from "@interleave/db";
import { CardSchedulerService } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newReviewLogId } from "./ids";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});
afterEach(() => {
  handle.sqlite.close();
});

describe("createCardWithin — reviewSeed + sourceUri (T070)", () => {
  it("persists the seeded reps/lapses/stability/difficulty/dueAt + sourceUri", () => {
    const review = new ReviewRepository(handle.db);
    const due = "2026-07-01T00:00:00.000Z";
    const { element, card } = review.createCard({
      kind: "qa",
      title: "Imported Q&A",
      priority: 0.375,
      prompt: "Capital of France?",
      answer: "Paris",
      sourceUri: "Atlas — https://example.com",
      reviewSeed: {
        reps: 7,
        lapses: 2,
        stability: 12,
        difficulty: 6.5,
        scheduledDays: 12,
        fsrsState: "review",
        dueAt: due,
      },
    });

    // The card row carries the source ref.
    expect(card.sourceUri).toBe("Atlas — https://example.com");

    // The review_states row carries the SEEDED counters + due, NOT the bare defaults.
    const state = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(state?.reps).toBe(7);
    expect(state?.lapses).toBe(2);
    expect(state?.stability).toBe(12);
    expect(state?.difficulty).toBe(6.5);
    expect(state?.scheduledDays).toBe(12);
    expect(state?.fsrsState).toBe("review");
    expect(state?.dueAt).toBe(due);

    // The element due_at mirrors review_states so the deck agrees (read fresh — the
    // returned element object snapshots pre-dueAt-update, like the firstScheduledAt path).
    const el = review.findCardById(element.id);
    expect(el?.element.dueAt).toBe(due);
    // A seeded card is authored straight into active rotation (it has history).
    expect(element.status).toBe("active");
    expect(element.stage).toBe("active_card");

    // No fabricated historical review_logs — the grading history stays truthful.
    const logs = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, element.id))
      .all();
    expect(logs).toHaveLength(0);
  });

  it("a seed activates even with an explicit stage:active_card (the Anki importer's call shape)", () => {
    // The Anki import service authors with BOTH a reviewSeed AND stage:"active_card"
    // explicitly. A seeded card carries full history, so it must land status "active"
    // (in the Library deck facet), not parked as "pending" — regardless of the
    // requested stage. Guards against the importer sidestepping the activation seam.
    const review = new ReviewRepository(handle.db);
    const due = "2026-08-01T00:00:00.000Z";
    const { element } = review.createCard({
      kind: "qa",
      title: "Imported with history",
      priority: 0.375,
      stage: "active_card",
      prompt: "Q",
      answer: "A",
      reviewSeed: {
        reps: 7,
        lapses: 2,
        stability: 30,
        difficulty: 6,
        scheduledDays: 30,
        fsrsState: "review",
        dueAt: due,
      },
    });
    expect(element.status).toBe("active");
    expect(element.stage).toBe("active_card");
  });

  it("the no-seed path is unchanged (authored-card shape: fsrs new, defaults)", () => {
    const review = new ReviewRepository(handle.db);
    const { element } = review.createCard({
      kind: "qa",
      title: "Authored Q&A",
      priority: 0.625,
      prompt: "Q",
      answer: "A",
    });
    const state = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    // Bare defaults — no regression.
    expect(state?.fsrsState).toBe("new");
    expect(state?.stability).toBe(0);
    expect(state?.difficulty).toBe(0);
    expect(state?.reps).toBe(0);
    expect(state?.lapses).toBe(0);
    expect(state?.dueAt).toBeNull(); // un-due (no firstScheduledAt) — the M6 shape.

    // sourceUri defaults to null when not supplied.
    const card = handle.db.select().from(cards).where(eq(cards.elementId, element.id)).get();
    expect(card?.sourceUri).toBeNull();

    // Un-due authored card stays a draft (no first schedule).
    expect(element.status).toBe("pending");
    expect(element.stage).toBe("card_draft");
  });

  it("firstScheduledAt still works (no seed) and is overridden by a seed", () => {
    const review = new ReviewRepository(handle.db);
    const at = "2026-06-20T00:00:00.000Z";
    const { element } = review.createCard({
      kind: "qa",
      title: "First-scheduled",
      priority: 0.5,
      prompt: "Q",
      answer: "A",
      firstScheduledAt: at,
    });
    const state = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(state?.dueAt).toBe(at);
    expect(state?.fsrsState).toBe("new"); // first-schedule does NOT run FSRS math.
    expect(element.status).toBe("active");
  });
});

describe("recordReview — timing and FSRS transition snapshot", () => {
  it("pulls a source sooner when descendant card reviews add enough recent lapses", () => {
    const sources = new SourceRepository(handle.db);
    const review = new ReviewRepository(handle.db);
    const reviewedAt = "2026-06-12T00:00:00.000Z";
    const originalSourceDueAt = "2026-07-12T00:00:00.000Z";
    const originalSourceUpdatedAt = "2026-05-01T00:00:00.000Z";
    const { element: source } = sources.createWithDocument({
      title: "Difficult source",
      priority: 0.375,
      status: "scheduled",
      stage: "raw_source",
      body: "One paragraph.\n\nAnother paragraph.",
    });
    handle.db
      .update(elements)
      .set({ dueAt: originalSourceDueAt, updatedAt: originalSourceUpdatedAt })
      .where(eq(elements.id, source.id))
      .run();

    const seedCard = (title: string) =>
      review.createCard({
        kind: "qa",
        title,
        priority: 0.375,
        prompt: "Q",
        answer: "A",
        sourceId: source.id,
        reviewSeed: {
          reps: 1,
          lapses: 0,
          stability: 10,
          difficulty: 5,
          scheduledDays: 10,
          fsrsState: "review",
          dueAt: reviewedAt,
        },
      }).element.id;

    const recordLapse = (cardId: ElementId, minutes: number) =>
      review.recordReview(cardId, {
        rating: "again",
        reviewedAt: new Date(Date.parse(reviewedAt) + minutes * 60_000).toISOString(),
        responseMs: 900,
        prevState: "review",
        nextState: "relearning",
        nextStability: 5,
        nextDifficulty: 6,
        nextDueAt: new Date(Date.parse(reviewedAt) + (minutes + 10) * 60_000).toISOString(),
        elapsedDays: 10,
        scheduledDays: 0,
        reps: 2,
        lapses: 1,
        nextLearningSteps: 1,
      });

    const cardA = seedCard("A");
    const cardB = seedCard("B");
    const cardC = seedCard("C");

    recordLapse(cardA, 0);
    recordLapse(cardB, 1);
    expect(new SourceRepository(handle.db).findById(source.id)?.element.dueAt).toBe(
      originalSourceDueAt,
    );

    recordLapse(cardC, 2);

    const sourceAfter = new SourceRepository(handle.db).findById(source.id)?.element;
    expect(sourceAfter?.dueAt).toBe("2026-06-24T00:02:00.000Z");
    expect(sourceAfter?.status).toBe("scheduled");
    expect(sourceAfter?.updatedAt).toBe(originalSourceUpdatedAt);
    const sourceOps = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, source.id))
      .all()
      .filter((op) => op.opType === "reschedule_element")
      .map((op) => JSON.parse(op.payload) as Record<string, unknown>);
    expect(sourceOps).toHaveLength(1);
    expect(sourceOps[0]).toMatchObject({
      action: "descendantHealth",
      scheduledAt: "2026-06-12T00:02:00.000Z",
      scheduleReason: {
        kind: "descendant_lapses",
        descendantLapseCount: 3,
        affectedCardCount: 3,
        descendantCardCount: 3,
        descendantLapseRate: 1,
        intervalAfterDescendantDays: 23,
        finalIntervalDays: 12,
      },
    });
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, source.id)).get(),
    ).toBeUndefined();
  });

  it("rolls back descendant source rescheduling when a later review write fails", () => {
    const sources = new SourceRepository(handle.db);
    const review = new ReviewRepository(handle.db);
    const reviewedAt = "2026-06-12T00:00:00.000Z";
    const originalSourceDueAt = "2026-07-12T00:00:00.000Z";
    const { element: source } = sources.createWithDocument({
      title: "Atomic source",
      priority: 0.375,
      status: "scheduled",
      stage: "raw_source",
      body: "One paragraph.\n\nAnother paragraph.",
    });
    handle.db
      .update(elements)
      .set({ dueAt: originalSourceDueAt, updatedAt: reviewedAt })
      .where(eq(elements.id, source.id))
      .run();

    const seedCard = (title: string, lapses = 0) =>
      review.createCard({
        kind: "qa",
        title,
        priority: 0.375,
        prompt: "Q",
        answer: "A",
        sourceId: source.id,
        reviewSeed: {
          reps: 1,
          lapses,
          stability: 10,
          difficulty: 5,
          scheduledDays: 10,
          fsrsState: "review",
          dueAt: reviewedAt,
        },
      }).element.id;

    const seedHistoricalLapse = (cardId: ElementId, minutesBefore: number) => {
      const at = new Date(Date.parse(reviewedAt) - minutesBefore * 60_000).toISOString();
      handle.db
        .insert(reviewLogs)
        .values({
          id: newReviewLogId(),
          elementId: cardId,
          rating: "again",
          reviewedAt: at,
          responseMs: 900,
          prevState: "review",
          nextState: "relearning",
          nextStability: 5,
          nextDifficulty: 6,
          nextDueAt: at,
          prevLapses: 0,
          nextLapses: 1,
        })
        .run();
    };

    const cardA = seedCard("Rollback A");
    const cardB = seedCard("Rollback B");
    const reviewedCard = seedCard("Rollback C", 3);
    seedHistoricalLapse(cardA, 60);
    seedHistoricalLapse(cardB, 30);

    const stateBefore = review.findReviewState(reviewedCard);
    const reviewedLogsBefore = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, reviewedCard))
      .all().length;
    const sourceOpsBefore = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, source.id))
      .all()
      .filter((op) => op.opType === "reschedule_element").length;

    handle.sqlite.exec(`
      CREATE TRIGGER abort_leech_update
      BEFORE UPDATE OF is_leech ON cards
      WHEN NEW.is_leech = 1
      BEGIN
        SELECT RAISE(ABORT, 'abort leech update');
      END;
    `);

    expect(() =>
      review.recordReview(reviewedCard, {
        rating: "again",
        reviewedAt,
        responseMs: 900,
        prevState: "review",
        nextState: "relearning",
        nextStability: 5,
        nextDifficulty: 6,
        nextDueAt: "2026-06-12T00:10:00.000Z",
        elapsedDays: 10,
        scheduledDays: 0,
        reps: 2,
        lapses: 4,
        nextLearningSteps: 1,
      }),
    ).toThrow(/abort leech update/);

    expect(review.findReviewState(reviewedCard)).toEqual(stateBefore);
    expect(new SourceRepository(handle.db).findById(source.id)?.element.dueAt).toBe(
      originalSourceDueAt,
    );
    expect(review.isCardLeech(reviewedCard)).toBe(false);
    expect(
      handle.db.select().from(reviewLogs).where(eq(reviewLogs.elementId, reviewedCard)).all()
        .length,
    ).toBe(reviewedLogsBefore);
    expect(
      handle.db
        .select()
        .from(operationLog)
        .where(eq(operationLog.elementId, source.id))
        .all()
        .filter((op) => op.opType === "reschedule_element").length,
    ).toBe(sourceOpsBefore);
  });

  it("persists prompt time plus the full pre/post FSRS transition on the review log", () => {
    const review = new ReviewRepository(handle.db);
    const { element } = review.createCard({
      kind: "qa",
      title: "Seeded review card",
      priority: 0.625,
      prompt: "Q",
      answer: "A",
      reviewSeed: {
        reps: 7,
        lapses: 2,
        stability: 9.5,
        difficulty: 4.25,
        elapsedDays: 5,
        scheduledDays: 9,
        fsrsState: "review",
        dueAt: "2026-06-10T00:00:00.000Z",
        lastReviewedAt: "2026-06-01T00:00:00.000Z",
      },
    });
    handle.db
      .update(reviewStates)
      .set({ learningSteps: 2 })
      .where(eq(reviewStates.elementId, element.id))
      .run();

    const log = review.recordReview(
      element.id,
      {
        rating: "again",
        reviewedAt: "2026-06-12T00:00:00.000Z",
        responseMs: 900,
        prevState: "review",
        nextState: "relearning",
        nextStability: 8.25,
        nextDifficulty: 6.6,
        nextDueAt: "2026-06-12T00:10:00.000Z",
        elapsedDays: 11,
        scheduledDays: 0,
        reps: 8,
        lapses: 3,
        nextLearningSteps: 1,
      },
      {
        promptMs: 1300,
      },
    );

    expect(log.promptMs).toBe(1300);
    expect(log.responseMs).toBe(900);
    expect(log.prevState).toBe("review");
    expect(log.prevDueAt).toBe("2026-06-10T00:00:00.000Z");
    expect(log.prevStability).toBeCloseTo(9.5);
    expect(log.prevDifficulty).toBeCloseTo(4.25);
    expect(log.prevElapsedDays).toBe(5);
    expect(log.prevScheduledDays).toBe(9);
    expect(log.prevReps).toBe(7);
    expect(log.prevLapses).toBe(2);
    expect(log.prevLearningSteps).toBe(2);
    expect(log.prevLastReviewedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(log.nextElapsedDays).toBe(11);
    expect(log.nextScheduledDays).toBe(0);
    expect(log.nextReps).toBe(8);
    expect(log.nextLapses).toBe(3);
    expect(log.nextLearningSteps).toBe(1);

    const rows = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, element.id))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.promptMs).toBe(1300);
    expect(rows[0]?.prevReps).toBe(7);
    expect(rows[0]?.nextReps).toBe(8);

    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all();
    expect(ops.filter((op) => op.opType === "add_review_log")).toHaveLength(1);
  });

  it("throws and writes no logs or operations when the review state row is missing", () => {
    const review = new ReviewRepository(handle.db);
    const { element } = review.createCard({
      kind: "qa",
      title: "Broken review card",
      priority: 0.625,
      prompt: "Q",
      answer: "A",
    });
    handle.db.delete(reviewStates).where(eq(reviewStates.elementId, element.id)).run();
    const logsBefore = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, element.id))
      .all().length;
    const opsBefore = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all().length;

    expect(() =>
      review.recordReview(element.id, {
        rating: "good",
        reviewedAt: "2026-06-12T00:00:00.000Z",
        responseMs: 900,
        prevState: "new",
        nextState: "review",
        nextStability: 8.25,
        nextDifficulty: 6.6,
        nextDueAt: "2026-06-15T00:00:00.000Z",
        elapsedDays: 0,
        scheduledDays: 3,
        reps: 1,
        lapses: 0,
        nextLearningSteps: 0,
      }),
    ).toThrow(/review state .* missing/);

    const logsAfter = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, element.id))
      .all().length;
    const opsAfter = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all().length;
    expect(logsAfter).toBe(logsBefore);
    expect(opsAfter).toBe(opsBefore);
  });

  it("rejects a same-phase stale scheduler outcome without appending logs or mutating state", () => {
    const review = new ReviewRepository(handle.db);
    const scheduler = new CardSchedulerService({ desiredRetention: 0.9, enableFuzz: false });
    const { element } = review.createCard({
      kind: "qa",
      title: "Review-phase card",
      priority: 0.625,
      prompt: "Q",
      answer: "A",
      reviewSeed: {
        reps: 8,
        lapses: 1,
        stability: 12,
        difficulty: 5,
        elapsedDays: 10,
        scheduledDays: 12,
        fsrsState: "review",
        dueAt: "2026-06-10T00:00:00.000Z",
        lastReviewedAt: "2026-05-31T00:00:00.000Z",
      },
    });
    const before = review.findReviewState(element.id);
    if (!before) throw new Error("missing review state");
    const staleOutcome = scheduler.gradeCard(before, "good", "2026-06-12T00:00:00.000Z", 900);

    review.recordReview(element.id, staleOutcome);
    const stateAfterFirst = review.findReviewState(element.id);
    expect(staleOutcome.prevState).toBe(stateAfterFirst?.fsrsState);
    const elementAfterFirst = handle.db
      .select({ dueAt: elements.dueAt, updatedAt: elements.updatedAt })
      .from(elements)
      .where(eq(elements.id, element.id))
      .get();
    const logsAfterFirst = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, element.id))
      .all().length;
    const opsAfterFirst = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all().length;

    expect(() => review.recordReview(element.id, staleOutcome)).toThrow(/stale review outcome/);

    expect(review.findReviewState(element.id)).toEqual(stateAfterFirst);
    const elementAfterReject = handle.db
      .select({ dueAt: elements.dueAt, updatedAt: elements.updatedAt })
      .from(elements)
      .where(eq(elements.id, element.id))
      .get();
    expect(elementAfterReject).toEqual(elementAfterFirst);
    const logsAfterReject = handle.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, element.id))
      .all().length;
    const opsAfterReject = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all().length;
    expect(logsAfterReject).toBe(logsAfterFirst);
    expect(opsAfterReject).toBe(opsAfterFirst);
  });
});
