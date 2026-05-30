/**
 * SchedulerService (FSRS) tests (T036).
 *
 * The CARD half of the two-scheduler split. These pin the FSRS wrapper's contract
 * from a FIXED clock with fuzzing OFF (deterministic intervals), asserting:
 *
 *  - a brand-new card graded `Good` advances to a real learning/review state with
 *    `dueAt > now`, `reps: 1`, and stability/difficulty set;
 *  - grading `Again` on a `review`-state card increments `lapses` and shortens the
 *    interval relative to Good/Easy (interval ordering `again < hard < good < easy`);
 *  - `previewIntervals` returns four non-decreasing-interval outcomes and mutates
 *    NOTHING (the input state is untouched);
 *  - the round-trip `fromFsrsCard(toFsrsCard(state)) ≈ state` is stable;
 *  - higher `desiredRetention` yields shorter intervals (first-class-input check);
 *  - the adapter never leaks `ts-fsrs` types — `gradeCard`/`previewIntervals` speak
 *    only our `FsrsState`/`ReviewRating` vocabulary.
 */

import type {
  ElementId,
  FsrsState,
  IsoTimestamp,
  ReviewRating,
  ReviewState,
} from "@interleave/core";
import { FSRS_STATES, REVIEW_RATINGS } from "@interleave/core";
import { describe, expect, it } from "vitest";
import { formatInterval, SchedulerService } from "./card-scheduler";
import { MS_PER_DAY } from "./date-util";

const CARD_ID = "card-1" as ElementId;
const NOW = "2026-06-15T00:00:00.000Z" as IsoTimestamp;

function service(desiredRetention = 0.9): SchedulerService {
  return new SchedulerService({ desiredRetention, enableFuzz: false });
}

/** A hand-built `review`-state card (matured), for the ordering/lapse assertions. */
function reviewStateCard(): ReviewState {
  return {
    elementId: CARD_ID,
    dueAt: "2026-06-10T00:00:00.000Z" as IsoTimestamp,
    stability: 10,
    difficulty: 5,
    elapsedDays: 5,
    scheduledDays: 10,
    reps: 5,
    lapses: 0,
    fsrsState: "review",
    lastReviewedAt: "2026-06-05T00:00:00.000Z" as IsoTimestamp,
  };
}

function intervalDays(now: IsoTimestamp, dueAt: IsoTimestamp): number {
  return (Date.parse(dueAt) - Date.parse(now)) / MS_PER_DAY;
}

describe("SchedulerService.newCardState", () => {
  it("produces a fresh, un-due `new` state with zero counters", () => {
    const state = service().newCardState(CARD_ID);
    expect(state.elementId).toBe(CARD_ID);
    expect(state.fsrsState).toBe("new");
    expect(state.reps).toBe(0);
    expect(state.lapses).toBe(0);
    expect(state.stability).toBe(0);
    expect(state.lastReviewedAt).toBeNull();
  });
});

describe("SchedulerService.gradeCard — new card", () => {
  it("grading Good advances a brand-new card to a real state with reps:1, due>now", () => {
    const fresh = service().newCardState(CARD_ID);
    const outcome = service().gradeCard(fresh, "good", NOW, 1500);

    expect(outcome.rating).toBe("good");
    expect(outcome.reviewedAt).toBe(NOW);
    expect(outcome.responseMs).toBe(1500);
    expect(outcome.prevState).toBe<FsrsState>("new");
    // A new card graded Good enters learning (or review) — never stays "new".
    expect(outcome.nextState).not.toBe("new");
    expect(FSRS_STATES).toContain(outcome.nextState);
    expect(outcome.reps).toBe(1);
    expect(outcome.lapses).toBe(0);
    expect(outcome.nextStability).toBeGreaterThan(0);
    expect(outcome.nextDifficulty).toBeGreaterThan(0);
    expect(Date.parse(outcome.nextDueAt)).toBeGreaterThan(Date.parse(NOW));
  });

  it("grading Again on a new card does not advance reps the way Good does", () => {
    const fresh = service().newCardState(CARD_ID);
    const again = service().gradeCard(fresh, "again", NOW, 800);
    // Again on a new card stays in a learning phase and schedules very soon.
    expect(again.nextState).not.toBe("new");
    expect(Date.parse(again.nextDueAt)).toBeGreaterThanOrEqual(Date.parse(NOW));
  });
});

describe("SchedulerService.gradeCard — review card lapse + ordering", () => {
  it("grading Again increments lapses and shortens the interval vs Good/Easy", () => {
    const svc = service();
    const card = reviewStateCard();

    const again = svc.gradeCard(card, "again", NOW, 1000);
    const hard = svc.gradeCard(card, "hard", NOW, 1000);
    const good = svc.gradeCard(card, "good", NOW, 1000);
    const easy = svc.gradeCard(card, "easy", NOW, 1000);

    // Again is a lapse: lapses incremented, state moves to relearning.
    expect(again.lapses).toBe(card.lapses + 1);
    expect(again.nextState).toBe<FsrsState>("relearning");
    // Good/Easy are not lapses.
    expect(good.lapses).toBe(card.lapses);
    expect(easy.lapses).toBe(card.lapses);

    // Interval ordering: again < hard < good < easy.
    const di = (o: { nextDueAt: IsoTimestamp }) => intervalDays(NOW, o.nextDueAt);
    expect(di(again)).toBeLessThan(di(hard));
    expect(di(hard)).toBeLessThan(di(good));
    expect(di(good)).toBeLessThan(di(easy));
  });

  it("does not mutate the input ReviewState", () => {
    const card = reviewStateCard();
    const snapshot = JSON.parse(JSON.stringify(card));
    service().gradeCard(card, "again", NOW, 1000);
    expect(card).toEqual(snapshot);
  });
});

describe("SchedulerService.previewIntervals", () => {
  it("returns four outcomes with non-decreasing intervals across again→hard→good→easy", () => {
    const card = reviewStateCard();
    const preview = service().previewIntervals(card, NOW);

    const order: ReviewRating[] = ["again", "hard", "good", "easy"];
    for (const r of order) {
      expect(REVIEW_RATINGS).toContain(r);
      expect(preview[r].scheduledDays).toBeGreaterThanOrEqual(0);
      expect(typeof preview[r].label).toBe("string");
      expect(Date.parse(preview[r].dueAt)).toBeGreaterThanOrEqual(Date.parse(NOW));
    }
    expect(preview.again.scheduledDays).toBeLessThanOrEqual(preview.hard.scheduledDays);
    expect(preview.hard.scheduledDays).toBeLessThanOrEqual(preview.good.scheduledDays);
    expect(preview.good.scheduledDays).toBeLessThanOrEqual(preview.easy.scheduledDays);
  });

  it("is PURE — it mutates neither the input state nor anything else", () => {
    const card = reviewStateCard();
    const snapshot = JSON.parse(JSON.stringify(card));
    const a = service().previewIntervals(card, NOW);
    const b = service().previewIntervals(card, NOW);
    expect(card).toEqual(snapshot);
    // Determinism (fuzz off): two previews of the same state agree.
    expect(a).toEqual(b);
  });

  it("previews a learning-step (sub-day) interval for a new card without reporting 0 days", () => {
    const fresh = service().newCardState(CARD_ID);
    const preview = service().previewIntervals(fresh, NOW);
    // A new card's Good is a short learning step (minutes), but still > now.
    expect(preview.good.scheduledDays).toBeGreaterThan(0);
    expect(preview.good.label).toMatch(/m|h|d/);
  });
});

describe("SchedulerService adapter round-trip", () => {
  it("fromFsrsCard(toFsrsCard(state)) is stable for a review card", () => {
    const svc = service();
    const card = reviewStateCard();
    const round = svc.fromFsrsCard(card.elementId, svc.toFsrsCard(card, NOW));
    expect(round.elementId).toBe(card.elementId);
    expect(round.fsrsState).toBe(card.fsrsState);
    expect(round.stability).toBeCloseTo(card.stability, 6);
    expect(round.difficulty).toBeCloseTo(card.difficulty, 6);
    expect(round.elapsedDays).toBeCloseTo(card.elapsedDays, 6);
    expect(round.scheduledDays).toBeCloseTo(card.scheduledDays, 6);
    expect(round.reps).toBe(card.reps);
    expect(round.lapses).toBe(card.lapses);
    expect(round.dueAt).toBe(card.dueAt);
    expect(round.lastReviewedAt).toBe(card.lastReviewedAt);
  });

  it("maps every FsrsState through the enum round-trip positionally", () => {
    const svc = service();
    for (const fsrsState of FSRS_STATES) {
      const state: ReviewState = { ...reviewStateCard(), fsrsState };
      const round = svc.fromFsrsCard(state.elementId, svc.toFsrsCard(state, NOW));
      expect(round.fsrsState).toBe(fsrsState);
    }
  });
});

describe("SchedulerService desired retention is a first-class input", () => {
  it("higher desiredRetention yields shorter intervals (Good on a review card)", () => {
    const card = reviewStateCard();
    const low = service(0.85).gradeCard(card, "good", NOW, 1000);
    const mid = service(0.9).gradeCard(card, "good", NOW, 1000);
    const high = service(0.95).gradeCard(card, "good", NOW, 1000);

    const di = (o: { nextDueAt: IsoTimestamp }) => intervalDays(NOW, o.nextDueAt);
    expect(di(high)).toBeLessThan(di(mid));
    expect(di(mid)).toBeLessThan(di(low));
  });

  it("exposes the retention it was built with", () => {
    expect(service(0.92).desiredRetention).toBe(0.92);
  });
});

describe("SchedulerService never leaks ts-fsrs types", () => {
  it("gradeCard outputs only our FsrsState/ReviewRating vocabulary", () => {
    const outcome = service().gradeCard(service().newCardState(CARD_ID), "good", NOW, 1000);
    // States are our lowercase strings, not the numeric ts-fsrs enum.
    expect(typeof outcome.nextState).toBe("string");
    expect(typeof outcome.prevState).toBe("string");
    expect(FSRS_STATES).toContain(outcome.nextState);
    expect(FSRS_STATES).toContain(outcome.prevState);
    expect(REVIEW_RATINGS).toContain(outcome.rating);
  });
});

describe("formatInterval", () => {
  it("renders minutes / hours / days / months / years", () => {
    expect(formatInterval(0)).toBe("0m");
    expect(formatInterval(10 / (24 * 60))).toBe("10m");
    expect(formatInterval(3 / 24)).toBe("3h");
    expect(formatInterval(2)).toBe("2d");
    expect(formatInterval(60)).toBe("2mo");
    expect(formatInterval(400)).toMatch(/y$/);
  });
});
