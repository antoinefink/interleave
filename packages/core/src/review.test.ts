import { describe, expect, it } from "vitest";
import type { ElementId, ReviewLogId } from "./ids";
import type { ReviewLog, ReviewState } from "./review";

describe("review model shapes", () => {
  it("represents the persisted FSRS state and immutable review log", () => {
    const cardId = "card" as ElementId;
    const state = {
      elementId: cardId,
      dueAt: "2026-06-10T00:00:00.000Z",
      stability: 12.5,
      difficulty: 5.4,
      elapsedDays: 3,
      scheduledDays: 7,
      reps: 8,
      lapses: 1,
      fsrsState: "review",
      learningSteps: 0,
      lastReviewedAt: "2026-06-03T00:00:00.000Z",
    } satisfies ReviewState;

    const log = {
      id: "log" as ReviewLogId,
      elementId: cardId,
      rating: "good",
      reviewedAt: "2026-06-03T00:00:00.000Z",
      responseMs: 1800,
      prevState: "learning",
      nextState: "review",
      nextStability: state.stability,
      nextDifficulty: state.difficulty,
      nextDueAt: state.dueAt,
    } satisfies ReviewLog;

    expect(state.fsrsState).toBe("review");
    expect(log.rating).toBe("good");
    expect(log.nextDueAt).toBe(state.dueAt);
  });
});
