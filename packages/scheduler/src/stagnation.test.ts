/**
 * Extract-stagnation heuristic tests (T084).
 *
 * Pins the attention-side mirror of the leech rule: an extract is stagnant iff it has
 * been postponed ≥ threshold AND has not progressed (stage ≠ atomic_statement) AND
 * produced no children AND is stale (≥ staleDays since the last stage advance). Covers
 * the boundary either side of each threshold, the reason set, and the suggestion
 * mapping per stage/priority. Deterministic with a fixed `now`.
 */

import type { IsoTimestamp, Priority } from "@interleave/core";
import { describe, expect, it } from "vitest";
import {
  type ExtractStagnationSignals,
  isStagnant,
  STAGNATION_POSTPONE_THRESHOLD,
  STAGNATION_STALE_DAYS,
} from "./stagnation";

const NOW = "2026-06-01T00:00:00.000Z" as IsoTimestamp;

/** ISO N days before NOW. */
function daysAgo(n: number): IsoTimestamp {
  return new Date(Date.parse(NOW) - n * 86_400_000).toISOString() as IsoTimestamp;
}

function signals(overrides: Partial<ExtractStagnationSignals> = {}): ExtractStagnationSignals {
  return {
    stage: "raw_extract",
    priority: 0.6 as Priority,
    createdAt: daysAgo(STAGNATION_STALE_DAYS + 10),
    lastProcessedAt: null,
    dueAt: null,
    postponeCount: STAGNATION_POSTPONE_THRESHOLD,
    childCount: 0,
    honorableFate: null,
    synthesizedReferenceCount: 0,
    lastStageAdvanceAt: null,
    ...overrides,
  };
}

describe("isStagnant", () => {
  it("flags a repeatedly-postponed, never-advanced, child-less, stale raw extract", () => {
    const v = isStagnant(signals(), NOW);
    expect(v.stagnant).toBe(true);
    expect(v.reasons).toEqual(
      expect.arrayContaining(["postponed-repeatedly", "no-progress", "no-children", "stale"]),
    );
    expect(v.daysSinceProgress).toBeGreaterThanOrEqual(STAGNATION_STALE_DAYS);
  });

  it("does NOT flag an extract that advanced to atomic_statement (it progressed)", () => {
    const v = isStagnant(signals({ stage: "atomic_statement" }), NOW);
    expect(v.stagnant).toBe(false);
    expect(v.reasons).not.toContain("no-progress");
  });

  it("does NOT flag an extract with children (it was productive)", () => {
    const v = isStagnant(signals({ childCount: 2 }), NOW);
    expect(v.stagnant).toBe(false);
    expect(v.reasons).not.toContain("no-children");
  });

  it("does NOT flag an extract with an honorable fate", () => {
    const v = isStagnant(signals({ honorableFate: "reference" }), NOW);
    expect(v.stagnant).toBe(false);
    expect(v.reasons).not.toContain("no-progress");
    expect(v.reasons).not.toContain("no-children");
    expect(v.suggestion).toBe("keep_as_reference");
  });

  it("does NOT flag an extract referenced by a live synthesis note", () => {
    const v = isStagnant(signals({ synthesizedReferenceCount: 1 }), NOW);
    expect(v.stagnant).toBe(false);
    expect(v.reasons).not.toContain("no-progress");
    expect(v.reasons).not.toContain("no-children");
    expect(v.suggestion).toBe("mark_synthesized");
  });

  it("does NOT flag a once-postponed extract (below the postpone threshold)", () => {
    const v = isStagnant(signals({ postponeCount: STAGNATION_POSTPONE_THRESHOLD - 1 }), NOW);
    expect(v.stagnant).toBe(false);
    expect(v.reasons).not.toContain("postponed-repeatedly");
  });

  it("flags exactly at the postpone threshold (boundary)", () => {
    const v = isStagnant(signals({ postponeCount: STAGNATION_POSTPONE_THRESHOLD }), NOW);
    expect(v.stagnant).toBe(true);
  });

  it("does NOT flag a recently-created extract even if heavily postponed (not stale)", () => {
    const v = isStagnant(
      signals({ createdAt: daysAgo(STAGNATION_STALE_DAYS - 1), lastStageAdvanceAt: null }),
      NOW,
    );
    expect(v.stagnant).toBe(false);
    expect(v.reasons).not.toContain("stale");
  });

  it("flags exactly at the stale-days boundary", () => {
    const v = isStagnant(signals({ createdAt: daysAgo(STAGNATION_STALE_DAYS) }), NOW);
    expect(v.stagnant).toBe(true);
    expect(v.reasons).toContain("stale");
  });

  it("measures staleness from the last stage advance, not createdAt", () => {
    // Created long ago but advanced recently → NOT stale (progress IS recent).
    const v = isStagnant(
      signals({
        stage: "clean_extract",
        createdAt: daysAgo(STAGNATION_STALE_DAYS * 3),
        lastStageAdvanceAt: daysAgo(2),
        childCount: 0,
      }),
      NOW,
    );
    expect(v.stagnant).toBe(false);
    expect(v.daysSinceProgress).toBe(2);
  });

  it("respects overridden thresholds", () => {
    const base = signals({ postponeCount: 1, createdAt: daysAgo(10) });
    expect(isStagnant(base, NOW).stagnant).toBe(false);
    expect(isStagnant(base, NOW, { postponeThreshold: 1, staleDays: 5 }).stagnant).toBe(true);
  });

  describe("suggestion mapping", () => {
    it("suggests CONVERT for a clean_extract with no children (card-ready)", () => {
      const v = isStagnant(signals({ stage: "clean_extract", childCount: 0 }), NOW);
      expect(v.suggestion).toBe("convert");
    });

    it("suggests DELETE for a deeply-stale, low-priority, heavily-postponed raw extract", () => {
      const v = isStagnant(
        signals({
          stage: "raw_extract",
          priority: 0.1 as Priority,
          postponeCount: STAGNATION_POSTPONE_THRESHOLD + 1,
          createdAt: daysAgo(STAGNATION_STALE_DAYS * 2 + 5),
        }),
        NOW,
      );
      expect(v.suggestion).toBe("delete");
    });

    it("suggests REWRITE for a still-raw extract worth keeping", () => {
      const v = isStagnant(signals({ stage: "raw_extract", priority: 0.85 as Priority }), NOW);
      expect(v.suggestion).toBe("rewrite");
    });

    it("suggests POSTPONE for a clean_extract that did spawn a child but still stalls", () => {
      const v = isStagnant(signals({ stage: "clean_extract", childCount: 1 }), NOW);
      expect(v.suggestion).toBe("postpone");
    });
  });
});
