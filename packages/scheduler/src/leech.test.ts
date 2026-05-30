/**
 * Leech detector tests (T040).
 *
 * Pins the single leech rule: a card is a leech once its cumulative `lapses`
 * reaches the threshold (default 4 — "warn at 4 lapses"), false below it, with an
 * overridable threshold and a safe `null`/undefined fallthrough.
 */

import type { ElementId, IsoTimestamp, ReviewState } from "@interleave/core";
import { describe, expect, it } from "vitest";
import { isLeech, LEECH_LAPSE_THRESHOLD } from "./leech";

const CARD_ID = "card-1" as ElementId;

function stateWithLapses(lapses: number): ReviewState {
  return {
    elementId: CARD_ID,
    dueAt: "2026-06-10T00:00:00.000Z" as IsoTimestamp,
    stability: 1,
    difficulty: 7,
    elapsedDays: 1,
    scheduledDays: 1,
    reps: lapses + 2,
    lapses,
    fsrsState: "relearning",
    lastReviewedAt: "2026-06-09T00:00:00.000Z" as IsoTimestamp,
  };
}

describe("LEECH_LAPSE_THRESHOLD", () => {
  it("is the SuperMemo/Anki-style default of 4", () => {
    expect(LEECH_LAPSE_THRESHOLD).toBe(4);
  });
});

describe("isLeech", () => {
  it("is false below the threshold", () => {
    for (const lapses of [0, 1, 2, 3]) {
      expect(isLeech(stateWithLapses(lapses))).toBe(false);
    }
  });

  it("is true at and above the threshold (warn at 4 lapses)", () => {
    expect(isLeech(stateWithLapses(4))).toBe(true);
    expect(isLeech(stateWithLapses(7))).toBe(true);
  });

  it("accepts an overridable threshold (for a future setting)", () => {
    expect(isLeech(stateWithLapses(2), 2)).toBe(true);
    expect(isLeech(stateWithLapses(2), 3)).toBe(false);
  });

  it("treats a null / undefined / never-reviewed state as not a leech", () => {
    expect(isLeech(null)).toBe(false);
    expect(isLeech(undefined)).toBe(false);
    expect(isLeech({ lapses: 0 })).toBe(false);
  });
});
