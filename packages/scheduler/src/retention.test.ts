/**
 * Retention RESOLVER tests (T079).
 *
 * Pins the ordered rule set (override → concept → band → global), the
 * strictest-concept-wins rule, the clamping at every branch, and the `enabled:
 * false` clean-revert behavior. Plus a smoke check that two cards (A vs D band)
 * built via the resolved retention schedule DIFFERENT intervals for the same grade
 * (higher target → shorter interval — the T036 "higher retention → shorter
 * interval" assertion, applied through the resolver).
 */

import {
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  type IsoTimestamp,
  PRIORITY_LABEL_VALUE,
  type ReviewState,
} from "@interleave/core";
import { describe, expect, it } from "vitest";
import { CardSchedulerService } from "./card-scheduler";
import { MS_PER_DAY } from "./date-util";
import {
  type RetentionTargets,
  resolveDesiredRetention,
  resolveDesiredRetentionDetailed,
} from "./retention";

const A = PRIORITY_LABEL_VALUE.A;
const C = PRIORITY_LABEL_VALUE.C;
const D = PRIORITY_LABEL_VALUE.D;

function targets(overrides: Partial<RetentionTargets> = {}): RetentionTargets {
  return { global: 0.9, enabled: true, ...overrides };
}

describe("resolveDesiredRetention — resolution order", () => {
  it("a finite per-card override wins over everything", () => {
    const r = resolveDesiredRetentionDetailed({
      priority: A,
      conceptNames: ["Fragile"],
      cardOverride: 0.95,
      targets: targets({ byConcept: { Fragile: 0.92 }, byBand: { A: 0.93 } }),
    });
    expect(r.source).toBe("card");
    expect(r.target).toBeCloseTo(0.95, 6);
  });

  it("the HIGHEST concept target wins among multiple memberships (strictest concept)", () => {
    const r = resolveDesiredRetentionDetailed({
      priority: C,
      conceptNames: ["Background", "Fragile", "Mid"],
      targets: targets({ byConcept: { Background: 0.82, Fragile: 0.94, Mid: 0.88 } }),
    });
    expect(r.source).toBe("concept");
    expect(r.target).toBeCloseTo(0.94, 6);
  });

  it("the band target applies when no concept entry matches", () => {
    const r = resolveDesiredRetentionDetailed({
      priority: A,
      conceptNames: ["NoTargetHere"],
      targets: targets({ byBand: { A: 0.93 }, byConcept: { Other: 0.95 } }),
    });
    expect(r.source).toBe("band");
    expect(r.target).toBeCloseTo(0.93, 6);
  });

  it("an ABSENT band inherits global (not a stored duplicate)", () => {
    const r = resolveDesiredRetentionDetailed({
      priority: D, // no D entry in byBand
      targets: targets({ global: 0.86, byBand: { A: 0.93 } }),
    });
    expect(r.source).toBe("global");
    expect(r.target).toBeCloseTo(0.86, 6);
  });

  it("falls back to global when nothing else matches", () => {
    const r = resolveDesiredRetentionDetailed({
      priority: C,
      targets: targets({ global: 0.88 }),
    });
    expect(r.source).toBe("global");
    expect(r.target).toBeCloseTo(0.88, 6);
  });
});

describe("resolveDesiredRetention — clamping", () => {
  it("clamps an override below the floor UP to DESIRED_RETENTION_MIN", () => {
    const t = resolveDesiredRetention({
      priority: C,
      cardOverride: 0.01, // a near-zero self-retiring value
      targets: targets(),
    });
    expect(t).toBe(DESIRED_RETENTION_MIN);
  });

  it("clamps an override above the ceiling DOWN to DESIRED_RETENTION_MAX", () => {
    const t = resolveDesiredRetention({ priority: C, cardOverride: 1.5, targets: targets() });
    expect(t).toBe(DESIRED_RETENTION_MAX);
  });

  it("clamps a concept target out of range", () => {
    const t = resolveDesiredRetention({
      priority: C,
      conceptNames: ["X"],
      targets: targets({ byConcept: { X: 0.5 } }),
    });
    expect(t).toBe(DESIRED_RETENTION_MIN);
  });

  it("clamps a band target out of range", () => {
    const t = resolveDesiredRetention({
      priority: A,
      targets: targets({ byBand: { A: 0.999 } }),
    });
    expect(t).toBe(DESIRED_RETENTION_MAX);
  });

  it("clamps the global fallback and survives a non-finite override", () => {
    expect(
      resolveDesiredRetention({
        priority: C,
        cardOverride: Number.NaN,
        targets: targets({ global: 2 }),
      }),
    ).toBe(DESIRED_RETENTION_MAX);
  });
});

describe("resolveDesiredRetention — enabled flag", () => {
  it("when disabled, band + concept are ignored (only override + global apply)", () => {
    const r = resolveDesiredRetentionDetailed({
      priority: A,
      conceptNames: ["Fragile"],
      targets: targets({ enabled: false, byBand: { A: 0.95 }, byConcept: { Fragile: 0.96 } }),
    });
    expect(r.source).toBe("global");
    expect(r.target).toBeCloseTo(0.9, 6);
  });

  it("when disabled, a per-card override STILL wins (clean revert to T036 otherwise)", () => {
    const r = resolveDesiredRetentionDetailed({
      priority: A,
      conceptNames: ["Fragile"],
      cardOverride: 0.91,
      targets: targets({ enabled: false, byBand: { A: 0.95 } }),
    });
    expect(r.source).toBe("card");
    expect(r.target).toBeCloseTo(0.91, 6);
  });
});

/** A hand-built matured `review`-state card so the interval is multi-day + stable. */
function reviewStateCard(): ReviewState {
  return {
    elementId: "card-1" as ReviewState["elementId"],
    dueAt: "2026-06-15T00:00:00.000Z" as IsoTimestamp,
    stability: 30,
    difficulty: 5,
    elapsedDays: 30,
    scheduledDays: 30,
    reps: 5,
    lapses: 0,
    fsrsState: "review",
    learningSteps: 0,
    lastReviewedAt: "2026-05-16T00:00:00.000Z" as IsoTimestamp,
  };
}

describe("resolved retention drives FSRS intervals (factory smoke)", () => {
  const NOW = "2026-06-15T00:00:00.000Z" as IsoTimestamp;
  const intervalDays = (o: { nextDueAt: IsoTimestamp }) =>
    (Date.parse(o.nextDueAt) - Date.parse(NOW)) / MS_PER_DAY;

  it("an A-band card (higher target) schedules a SHORTER interval than a D-band card", () => {
    const t = targets({ global: 0.9, byBand: { A: 0.93, D: 0.85 } });

    const aTarget = resolveDesiredRetention({ priority: A, targets: t });
    const dTarget = resolveDesiredRetention({ priority: D, targets: t });
    expect(aTarget).toBeGreaterThan(dTarget);

    const aScheduler = new CardSchedulerService({ desiredRetention: aTarget, enableFuzz: false });
    const dScheduler = new CardSchedulerService({ desiredRetention: dTarget, enableFuzz: false });

    const aOut = aScheduler.gradeCard(reviewStateCard(), "good", NOW, 1000);
    const dOut = dScheduler.gradeCard(reviewStateCard(), "good", NOW, 1000);

    // Higher target (A) → shorter interval; lower target (D) → longer interval.
    expect(intervalDays(aOut)).toBeLessThan(intervalDays(dOut));
  });
});
