/**
 * FSRS grade-path integration (T036).
 *
 * Exercises the persistence seam end to end against a TEMPORARY, fully-migrated
 * in-memory `better-sqlite3` DB: the FSRS `CardSchedulerService` (`@interleave/scheduler`)
 * computes a `ReviewOutcome` and `ReviewRepository.recordReview` PERSISTS it. This is
 * the contract T037's `review.grade` IPC composes. It asserts:
 *
 *  - `recordReview` advances the card's `review_states` (due/stability/difficulty/
 *    elapsed/scheduled/reps/lapses/fsrs_state) to the scheduler's outcome;
 *  - exactly ONE `review_logs` row is appended per grade (append-only history);
 *  - `elements.due_at` is advanced to the new due time (so the queue re-picks it);
 *  - exactly ONE `add_review_log` op is logged (no new op type), in the SAME
 *    transaction as the state advance;
 *  - the FSRS scheduler is for CARDS ONLY: a freshly created card has a
 *    `review_states` row but the originating EXTRACT never does (the two-scheduler
 *    split holds at the persistence layer).
 */

import type { BlockId, ElementId, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, operationLog, reviewLogs, reviewStates } from "@interleave/db";
import { CardSchedulerService } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardService } from "./card-service";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const NOW = "2026-06-15T00:00:00.000Z";

/** Seed a source + an anchored extract, then author one Q&A card from it. */
function seedCard(priority: Priority = 0.875): { cardId: ElementId; extractId: ElementId } {
  const sources = new SourceRepository(handle.db);
  const cardService = new CardService(handle.db);
  const { element: source } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority,
    status: "active",
    stage: "raw_source",
    body: "The definition paragraph.\n\nAnother paragraph.",
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
  const { element: card } = cardService.createFromExtract({
    extractId: extract.id,
    kind: "qa",
    prompt: "What is intelligence?",
    answer: "Skill-acquisition efficiency.",
  });
  return { cardId: card.id, extractId: extract.id };
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("FSRS grade path: CardSchedulerService → ReviewRepository.recordReview", () => {
  it("persists the advanced review_states, one review_logs row, advances elements.due_at, logs add_review_log", () => {
    const { cardId } = seedCard();
    const review = new ReviewRepository(handle.db);
    const scheduler = new CardSchedulerService({ desiredRetention: 0.9, enableFuzz: false });

    // A newly authored card is first-scheduled DUE (so it enters the deck) but its
    // FSRS memory state is still `new` with no reps — no interval math has run yet.
    const before = review.findReviewState(cardId);
    expect(before).not.toBeNull();
    expect(before?.fsrsState).toBe("new");
    expect(before?.dueAt).not.toBeNull();
    expect(before?.reps).toBe(0);

    if (!before) throw new Error("review state missing");
    const outcome = scheduler.gradeCard(before, "good", NOW as never, 1500);
    const log = review.recordReview(cardId, outcome);

    // review_states advanced to the scheduler's outcome.
    const after = review.findReviewState(cardId);
    expect(after?.fsrsState).toBe(outcome.nextState);
    expect(after?.fsrsState).not.toBe("new");
    expect(after?.stability).toBeCloseTo(outcome.nextStability, 6);
    expect(after?.difficulty).toBeCloseTo(outcome.nextDifficulty, 6);
    expect(after?.elapsedDays).toBeCloseTo(outcome.elapsedDays, 6);
    expect(after?.scheduledDays).toBeCloseTo(outcome.scheduledDays, 6);
    expect(after?.reps).toBe(1);
    expect(after?.lapses).toBe(outcome.lapses);
    expect(after?.dueAt).toBe(outcome.nextDueAt);
    expect(after?.lastReviewedAt).toBe(NOW);

    // Exactly one review_logs row was appended, mirroring the outcome.
    const logs = handle.db.select().from(reviewLogs).where(eq(reviewLogs.elementId, cardId)).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]?.id).toBe(log.id);
    expect(logs[0]?.rating).toBe("good");
    expect(logs[0]?.prevState).toBe("new");
    expect(logs[0]?.nextState).toBe(outcome.nextState);
    expect(logs[0]?.nextDueAt).toBe(outcome.nextDueAt);
    expect(logs[0]?.responseMs).toBe(1500);

    // elements.due_at advanced so the queue re-picks the card.
    const elementRow = handle.db.select().from(elements).where(eq(elements.id, cardId)).get();
    expect(elementRow?.dueAt).toBe(outcome.nextDueAt);

    // Exactly one add_review_log op was logged (no new op type).
    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, cardId))
      .all();
    const reviewOps = ops.filter((o) => o.opType === "add_review_log");
    expect(reviewOps).toHaveLength(1);
  });

  it("grading Again on a graded card increments lapses and appends a second log row", () => {
    const { cardId } = seedCard();
    const review = new ReviewRepository(handle.db);
    const scheduler = new CardSchedulerService({ desiredRetention: 0.9, enableFuzz: false });

    // First grade Good to leave the `new` state.
    const s0 = review.findReviewState(cardId);
    if (!s0) throw new Error("missing");
    review.recordReview(cardId, scheduler.gradeCard(s0, "good", NOW as never, 1000));

    // Drive into a real review state, then lapse it.
    const s1 = review.findReviewState(cardId);
    if (!s1) throw new Error("missing");
    const later = "2026-07-20T00:00:00.000Z";
    const out2 = scheduler.gradeCard(s1, "again", later as never, 1000);
    review.recordReview(cardId, out2);

    const after = review.findReviewState(cardId);
    expect(after?.lapses).toBe(out2.lapses);
    const logs = handle.db.select().from(reviewLogs).where(eq(reviewLogs.elementId, cardId)).all();
    expect(logs).toHaveLength(2);
  });

  it("graduates a card from learning to review across repeated Good grades (learning-step cursor persists)", () => {
    const { cardId } = seedCard();
    const review = new ReviewRepository(handle.db);
    const scheduler = new CardSchedulerService({ desiredRetention: 0.9, enableFuzz: false });

    // Drive the real recordReview loop: read state, grade Good, persist, advance the
    // clock to the new due time, repeat. Regression guard for the learning-step reset
    // bug — without the persisted `learning_steps` cursor the card would stay in
    // `learning` and be rescheduled in minutes forever, never reaching `review`.
    let now = NOW;
    const states: { fsrsState: string; intervalDays: number }[] = [];
    for (let i = 0; i < 5; i++) {
      const state = review.findReviewState(cardId);
      if (!state) throw new Error("review state missing");
      const outcome = scheduler.gradeCard(state, "good", now as never, 1200);
      review.recordReview(cardId, outcome);
      const after = review.findReviewState(cardId);
      if (!after?.dueAt) throw new Error("due missing");
      const intervalDays = (Date.parse(after.dueAt) - Date.parse(now)) / 86_400_000;
      states.push({ fsrsState: after.fsrsState, intervalDays });
      now = after.dueAt;
    }

    const final = review.findReviewState(cardId);
    // The card MUST graduate out of learning into review with a multi-day interval.
    expect(final?.fsrsState).toBe("review");
    expect(final?.reps).toBe(5);
    expect(final?.learningSteps).toBe(0); // back to step 0 once it has graduated
    expect(states.at(-1)?.intervalDays).toBeGreaterThanOrEqual(1);
    // It does not loop in `learning` on every grade.
    expect(states.filter((s) => s.fsrsState === "learning").length).toBeLessThanOrEqual(1);
  });

  it("FSRS is cards-only: the card has a review_states row but its extract never does", () => {
    const { cardId, extractId } = seedCard();
    const cardState = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, cardId))
      .get();
    const extractState = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, extractId))
      .get();
    expect(cardState).toBeDefined();
    expect(extractState).toBeUndefined();
  });
});
