/**
 * AttentionScheduler tests (T028).
 *
 * The attention (topic/extract) scheduler is the load-bearing half of the
 * two-scheduler split. These pure-function tests pin its contract from a FIXED
 * injected clock so the dates are deterministic, asserting:
 *
 *  - each priority band's SOURCE interval (A 1d · B 7d · C 30d · D 90d), higher
 *    priority returning sooner;
 *  - each extract STAGE interval (raw +1..7d, clean +3..14d, atomic +1d), and that
 *    `rawExtractIntervalDays` matches `extractStageIntervalDays("raw_extract", …)`;
 *  - last-seen recency credit shortens valid older attention intervals after the
 *    base heuristic and source-processing adjustment;
 *  - the action-based reschedule table (extract/rewrite/activate use the heuristic;
 *    postpone pushes out and grows with postponeCount; done recedes far out);
 *  - postpone intervals GROW with the postpone count and cap at the 180d ceiling;
 *  - tomorrow/next-week/next-month land on exactly +1/+7/+30 days from `now`;
 *  - manual dates are normalized (to canonical ISO) and validated (throw on garbage).
 *
 * These are framework-agnostic and never touch a DB — the FSRS-isolation assertion
 * (no `review_states` row for an extract) lives in the local-db `SchedulerService`
 * test, which exercises the persistence seam.
 */

import type { IsoTimestamp, Priority } from "@interleave/core";
import { PRIORITY_LABEL_VALUE } from "@interleave/core";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_SCHEDULE_REASON_KINDS,
  adaptiveAttentionIntervalMultiplier,
  attentionScheduleReasonFromAdaptiveReason,
  basePostponeIntervalDays,
  DEFAULT_ATTENTION_INTERVAL_MULTIPLIER,
  EXTRACT_STAGES,
  extractStageIntervalDays,
  isExtractStage,
  isSchedulerAction,
  MAX_ATTENTION_INTERVAL_MULTIPLIER,
  MIN_ATTENTION_INTERVAL_MULTIPLIER,
  nextDueAt,
  nextExtractStage,
  postponeIntervalForPriority,
  rawExtractIntervalDays,
  type Schedulable,
  scheduleForChoice,
  scheduleManual,
  scheduleNextMonth,
  scheduleNextWeek,
  scheduleTomorrow,
  sourceIntervalDays,
  sourceRetirementSignalHash,
  sourceRetirementSuggestion,
} from "./attention-scheduler";
import { addDays, MS_PER_DAY } from "./date-util";

/** A fixed, deterministic clock for every test. */
const NOW = "2026-05-30T12:00:00.000Z" as IsoTimestamp;

const A: Priority = PRIORITY_LABEL_VALUE.A;
const B: Priority = PRIORITY_LABEL_VALUE.B;
const C: Priority = PRIORITY_LABEL_VALUE.C;
const D: Priority = PRIORITY_LABEL_VALUE.D;

/** Whole-day delta between `now` and a computed due time. */
function daysBetween(now: IsoTimestamp, dueAt: IsoTimestamp): number {
  return Math.round((Date.parse(dueAt) - Date.parse(now)) / MS_PER_DAY);
}

function hoursBefore(now: IsoTimestamp, hours: number): IsoTimestamp {
  return new Date(Date.parse(now) - hours * 60 * 60 * 1000).toISOString() as IsoTimestamp;
}

describe("date-util: addDays", () => {
  it("adds whole, fractional, and negative days, returning canonical ISO", () => {
    expect(addDays(NOW, 1)).toBe("2026-05-31T12:00:00.000Z");
    expect(addDays(NOW, 0.5)).toBe("2026-05-31T00:00:00.000Z");
    expect(addDays(NOW, -1)).toBe("2026-05-29T12:00:00.000Z");
  });

  it("throws on an unparseable timestamp", () => {
    expect(() => addDays("not-a-date" as IsoTimestamp, 1)).toThrow(/invalid ISO/);
  });
});

describe("EXTRACT_STAGES / nextExtractStage / isExtractStage", () => {
  it("is the three-step chain in order", () => {
    expect(EXTRACT_STAGES).toEqual(["raw_extract", "clean_extract", "atomic_statement"]);
  });

  it("walks raw → clean → atomic then stops", () => {
    expect(nextExtractStage("raw_extract")).toBe("clean_extract");
    expect(nextExtractStage("clean_extract")).toBe("atomic_statement");
    expect(nextExtractStage("atomic_statement")).toBeNull();
  });

  it("recognises only the three extract stages", () => {
    expect(isExtractStage("raw_extract")).toBe(true);
    expect(isExtractStage("card_draft")).toBe(false);
    expect(isExtractStage("raw_source")).toBe(false);
    expect(isExtractStage(42)).toBe(false);
  });
});

describe("sourceIntervalDays (by priority band)", () => {
  it("returns the band floor per scheduling-and-priority.md", () => {
    expect(sourceIntervalDays(A)).toBe(1); // A 1–7d
    expect(sourceIntervalDays(B)).toBe(7); // B 7–30d
    expect(sourceIntervalDays(C)).toBe(30); // C 30–60d
    expect(sourceIntervalDays(D)).toBe(90); // D 90d+
  });

  it("returns sooner intervals for higher priority", () => {
    expect(sourceIntervalDays(A)).toBeLessThan(sourceIntervalDays(B));
    expect(sourceIntervalDays(B)).toBeLessThan(sourceIntervalDays(C));
    expect(sourceIntervalDays(C)).toBeLessThan(sourceIntervalDays(D));
  });
});

describe("extractStageIntervalDays (by stage)", () => {
  it("matches the raw +1..7d window", () => {
    expect(extractStageIntervalDays("raw_extract", A)).toBe(1);
    expect(extractStageIntervalDays("raw_extract", B)).toBe(3);
    expect(extractStageIntervalDays("raw_extract", C)).toBe(5);
    expect(extractStageIntervalDays("raw_extract", D)).toBe(7);
  });

  it("matches the clean +3..14d window", () => {
    expect(extractStageIntervalDays("clean_extract", A)).toBe(3);
    expect(extractStageIntervalDays("clean_extract", B)).toBe(6);
    expect(extractStageIntervalDays("clean_extract", C)).toBe(10);
    expect(extractStageIntervalDays("clean_extract", D)).toBe(14);
  });

  it("atomic_statement is card-ready: +1d regardless of priority", () => {
    expect(extractStageIntervalDays("atomic_statement", A)).toBe(1);
    expect(extractStageIntervalDays("atomic_statement", D)).toBe(1);
  });

  it("higher priority returns sooner; clean pushes further out than raw", () => {
    expect(extractStageIntervalDays("raw_extract", A)).toBeLessThan(
      extractStageIntervalDays("raw_extract", D),
    );
    expect(extractStageIntervalDays("clean_extract", B)).toBeGreaterThan(
      extractStageIntervalDays("raw_extract", B),
    );
  });
});

describe("rawExtractIntervalDays", () => {
  it("equals the raw_extract stage interval (single source of truth)", () => {
    expect(rawExtractIntervalDays(A)).toBe(extractStageIntervalDays("raw_extract", A));
    expect(rawExtractIntervalDays(A)).toBe(1); // A
    expect(rawExtractIntervalDays(B)).toBe(3); // B
    expect(rawExtractIntervalDays(C)).toBe(5); // C
    expect(rawExtractIntervalDays(D)).toBe(7); // D
  });
});

describe("postponeIntervalForPriority (grows with postpone count)", () => {
  it("base interval (count 0) is the medium +7..30d window by priority", () => {
    expect(postponeIntervalForPriority(A, 0)).toBe(7);
    expect(postponeIntervalForPriority(B, 0)).toBe(14);
    expect(postponeIntervalForPriority(C, 0)).toBe(21);
    expect(postponeIntervalForPriority(D, 0)).toBe(30);
    expect(postponeIntervalForPriority(B, 0)).toBe(basePostponeIntervalDays(B));
  });

  it("grows monotonically as the postpone count climbs (stagnation recedes)", () => {
    const i0 = postponeIntervalForPriority(B, 0);
    const i1 = postponeIntervalForPriority(B, 1);
    const i2 = postponeIntervalForPriority(B, 2);
    const i3 = postponeIntervalForPriority(B, 3);
    expect(i1).toBeGreaterThan(i0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    // B base 14 → ×1.5 = 21 → ×2 = 28 → ×2.5 = 35
    expect([i0, i1, i2, i3]).toEqual([14, 21, 28, 35]);
  });

  it("caps at the 180d low-value ceiling for repeatedly-postponed low items", () => {
    expect(postponeIntervalForPriority(D, 100)).toBe(180);
  });

  it("treats a missing/negative count as zero", () => {
    expect(postponeIntervalForPriority(B)).toBe(14);
    expect(postponeIntervalForPriority(B, -5)).toBe(14);
  });
});

describe("adaptiveAttentionIntervalMultiplier", () => {
  it("shortens a productive high-priority visit by only one bounded step", () => {
    const decision = adaptiveAttentionIntervalMultiplier({
      priority: A,
      currentMultiplier: DEFAULT_ATTENTION_INTERVAL_MULTIPLIER,
      visitYield: { childExtractsCreated: 2 },
    });

    expect(decision.reasonKind).toBe("yield_shortened");
    expect(decision.priorMultiplier).toBe(1);
    expect(decision.newMultiplier).toBe(0.9);
    expect(decision.productiveOutputCount).toBe(2);
  });

  it("lengthens barren lower-priority visits faster than high-priority visits", () => {
    const high = adaptiveAttentionIntervalMultiplier({
      priority: B,
      currentMultiplier: 1,
      visitYield: { unresolvedRatio: 0, terminalRatio: 1, ignoredRatio: 0.75 },
    });
    const low = adaptiveAttentionIntervalMultiplier({
      priority: C,
      currentMultiplier: 1,
      visitYield: { unresolvedRatio: 0, terminalRatio: 1, ignoredRatio: 0.75 },
    });

    expect(high.reasonKind).toBe("yield_lengthened");
    expect(high.newMultiplier).toBe(1.05);
    expect(low.reasonKind).toBe("yield_lengthened");
    expect(low.newMultiplier).toBe(1.15);
  });

  it("counts synthesis output and honorable extract fates as productive value", () => {
    expect(
      adaptiveAttentionIntervalMultiplier({
        priority: C,
        currentMultiplier: 1,
        visitYield: { synthesisOutputsCreated: 1 },
      }).newMultiplier,
    ).toBe(0.85);
    expect(
      adaptiveAttentionIntervalMultiplier({
        priority: C,
        currentMultiplier: 1,
        visitYield: { honorableExtractFates: 1 },
      }).newMultiplier,
    ).toBe(0.85);
  });

  it("clamps malformed persisted multipliers to the bounded range", () => {
    expect(
      adaptiveAttentionIntervalMultiplier({
        priority: C,
        currentMultiplier: -10,
        visitYield: { cardsCreated: 1 },
      }).newMultiplier,
    ).toBe(MIN_ATTENTION_INTERVAL_MULTIPLIER);
    expect(
      adaptiveAttentionIntervalMultiplier({
        priority: C,
        currentMultiplier: 10,
        visitYield: { unresolvedRatio: 0 },
      }).newMultiplier,
    ).toBe(MAX_ATTENTION_INTERVAL_MULTIPLIER);
  });

  it("clamps and holds when visit-yield input is malformed", () => {
    const decision = adaptiveAttentionIntervalMultiplier({
      priority: C,
      currentMultiplier: 10,
      visitYield: { cardsCreated: -1, unresolvedRatio: 2 },
    });

    expect(decision.reasonKind).toBe("yield_input_malformed");
    expect(decision.priorMultiplier).toBe(10);
    expect(decision.clampedPriorMultiplier).toBe(MAX_ATTENTION_INTERVAL_MULTIPLIER);
    expect(decision.newMultiplier).toBe(MAX_ATTENTION_INTERVAL_MULTIPLIER);
  });
});

describe("attention schedule reason vocabulary", () => {
  it("exports the closed T113 reason vocabulary including the reserved descendant-lapse kind", () => {
    expect(ATTENTION_SCHEDULE_REASON_KINDS).toEqual([
      "yield_shortened",
      "yield_lengthened",
      "recency_damped",
      "postpone_recession",
      "source_unresolved_shortened",
      "source_exhausted_lengthened",
      "descendant_lapses",
      "band_base",
    ]);
  });

  it("normalizes legacy adaptive diagnostics into T113 schedule reasons", () => {
    expect(
      attentionScheduleReasonFromAdaptiveReason({
        reasonKind: "yield_shortened",
        priorMultiplier: 1,
        clampedPriorMultiplier: 1,
        newMultiplier: 0.9,
        productiveOutputCount: 2,
        baseIntervalDays: 10,
        intervalAfterMultiplierDays: 9,
        finalIntervalDays: 8,
      }),
    ).toMatchObject({
      kind: "yield_shortened",
      priorMultiplier: 1,
      clampedPriorMultiplier: 1,
      newMultiplier: 0.9,
      productiveOutputCount: 2,
      baseIntervalDays: 10,
      intervalAfterMultiplierDays: 9,
      finalIntervalDays: 8,
    });

    expect(
      attentionScheduleReasonFromAdaptiveReason({
        reasonKind: "yield_held",
        priorMultiplier: 1,
        clampedPriorMultiplier: 1,
        newMultiplier: 1,
        productiveOutputCount: 0,
        baseIntervalDays: 10,
        intervalAfterMultiplierDays: 10,
        finalIntervalDays: 10,
      }),
    ).toEqual({ kind: "band_base", baseIntervalDays: 10, finalIntervalDays: 10 });

    expect(
      attentionScheduleReasonFromAdaptiveReason({
        reasonKind: "yield_input_malformed",
        priorMultiplier: 1,
        clampedPriorMultiplier: 1,
        newMultiplier: 1,
        productiveOutputCount: 0,
        baseIntervalDays: 10,
        intervalAfterMultiplierDays: 10,
        finalIntervalDays: 10,
      }),
    ).toBeNull();
  });
});

describe("nextDueAt (heuristic + action override)", () => {
  it("schedules an extract by its STAGE band", () => {
    const input: Schedulable = { type: "extract", stage: "clean_extract", priority: B };
    const { dueAt, intervalDays } = nextDueAt(input, NOW);
    expect(intervalDays).toBe(extractStageIntervalDays("clean_extract", B));
    expect(daysBetween(NOW, dueAt)).toBe(6);
  });

  it("schedules a source/topic by its PRIORITY band", () => {
    for (const [priority, days] of [
      [A, 1],
      [B, 7],
      [C, 30],
      [D, 90],
    ] as const) {
      const { dueAt, intervalDays } = nextDueAt({ type: "source", priority }, NOW);
      expect(intervalDays).toBe(days);
      expect(daysBetween(NOW, dueAt)).toBe(days);
    }
  });

  it("brings high-priority sources with unresolved block text back sooner", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: B,
        sourceProcessing: {
          unresolvedRatio: 0.5,
          terminalRatio: 0.5,
          ignoredRatio: 0,
          extractedOutputCount: 1,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(3);
    expect(decision.scheduleReason).toMatchObject({
      kind: "source_unresolved_shortened",
      baseIntervalDays: 7,
      finalIntervalDays: 3,
      unresolvedRatio: 0.5,
    });
  });

  it("pushes mostly ignored no-output sources later and suggests retirement", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: C,
        sourceProcessing: {
          unresolvedRatio: 0,
          terminalRatio: 1,
          ignoredRatio: 0.75,
          extractedOutputCount: 0,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(60);
    expect(decision.retirementSuggestion).toBe(true);
    expect(decision.scheduleReason).toMatchObject({
      kind: "source_exhausted_lengthened",
      baseIntervalDays: 30,
      finalIntervalDays: 60,
      ignoredRatio: 0.75,
    });
  });

  it("a topic falls back to the by-priority band when no setting is supplied", () => {
    expect(nextDueAt({ type: "topic", priority: C }, NOW).intervalDays).toBe(sourceIntervalDays(C));
  });

  it("a topic CONSUMES the global defaultTopicIntervalDays setting when supplied", () => {
    const { dueAt, intervalDays } = nextDueAt(
      { type: "topic", priority: C, defaultTopicIntervalDays: 14 },
      NOW,
    );
    expect(intervalDays).toBe(14);
    expect(daysBetween(NOW, dueAt)).toBe(14);
  });

  it("ignores defaultTopicIntervalDays for non-topic types", () => {
    expect(
      nextDueAt({ type: "source", priority: B, defaultTopicIntervalDays: 14 }, NOW).intervalDays,
    ).toBe(sourceIntervalDays(B));
    expect(
      nextDueAt(
        { type: "extract", stage: "raw_extract", priority: B, defaultTopicIntervalDays: 14 },
        NOW,
      ).intervalDays,
    ).toBe(extractStageIntervalDays("raw_extract", B));
  });

  it("productive actions (extract/rewrite/activate) use the heuristic interval", () => {
    const base = nextDueAt({ type: "extract", stage: "raw_extract", priority: B }, NOW);
    for (const lastAction of ["extract", "rewrite", "activate"] as const) {
      const withAction = nextDueAt(
        { type: "extract", stage: "raw_extract", priority: B, lastAction },
        NOW,
      );
      expect(withAction.intervalDays).toBe(base.intervalDays);
    }
  });

  it("postpone overrides the heuristic and grows with the postpone count", () => {
    const once = nextDueAt(
      {
        type: "extract",
        stage: "raw_extract",
        priority: B,
        lastAction: "postpone",
        postponeCount: 1,
      },
      NOW,
    );
    const twice = nextDueAt(
      {
        type: "extract",
        stage: "raw_extract",
        priority: B,
        lastAction: "postpone",
        postponeCount: 2,
      },
      NOW,
    );
    expect(once.intervalDays).toBe(postponeIntervalForPriority(B, 1));
    expect(twice.intervalDays).toBeGreaterThan(once.intervalDays);
  });

  it("done recedes far out (much later than the productive heuristic)", () => {
    const productive = nextDueAt({ type: "source", priority: B }, NOW);
    const done = nextDueAt({ type: "source", priority: B, lastAction: "done" }, NOW);
    expect(done.intervalDays).toBeGreaterThan(productive.intervalDays);
    expect(done.intervalDays).toBe(60); // B done window
  });

  it.each([
    ["never seen", null, 7],
    ["seen now", NOW, 7],
    ["seen 23 hours ago", hoursBefore(NOW, 23), 7],
    ["seen exactly 1 day ago", addDays(NOW, -1), 6],
    ["seen 3 days ago", addDays(NOW, -3), 4],
    ["seen 30 days ago caps at half the base interval", addDays(NOW, -30), 4],
    ["invalid lastSeenAt", "not-a-date" as IsoTimestamp, 7],
    ["future lastSeenAt", addDays(NOW, 1), 7],
  ])("applies bounded source recency credit for %s", (_, lastSeenAt, expectedIntervalDays) => {
    const decision = nextDueAt({ type: "source", priority: B, lastSeenAt }, NOW);
    expect(decision.intervalDays).toBe(expectedIntervalDays);
    expect(daysBetween(NOW, decision.dueAt)).toBe(expectedIntervalDays);
    if (expectedIntervalDays < 7) {
      expect(decision.scheduleReason).toMatchObject({
        kind: "recency_damped",
        baseIntervalDays: 7,
        finalIntervalDays: expectedIntervalDays,
      });
    } else {
      expect(decision.scheduleReason).toMatchObject({ kind: "band_base" });
    }
  });

  it.each([
    ["topic default interval", { type: "topic", priority: C, defaultTopicIntervalDays: 14 }, 11],
    ["raw extract", { type: "extract", stage: "raw_extract", priority: D }, 4],
    ["postpone action", { type: "source", priority: B, lastAction: "postpone" }, 11],
    ["done action", { type: "source", priority: B, lastAction: "done" }, 57],
  ] as const)("applies recency credit after the %s base interval", (_, input, expectedIntervalDays) => {
    const decision = nextDueAt({ ...input, lastSeenAt: addDays(NOW, -3) }, NOW);
    expect(decision.intervalDays).toBe(expectedIntervalDays);
    expect(daysBetween(NOW, decision.dueAt)).toBe(expectedIntervalDays);
  });

  it("applies recency after high-value unresolved source-processing adjustment", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: B,
        lastSeenAt: addDays(NOW, -3),
        sourceProcessing: {
          unresolvedRatio: 0.5,
          terminalRatio: 0.5,
          ignoredRatio: 0,
          extractedOutputCount: 1,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(2);
    expect(daysBetween(NOW, decision.dueAt)).toBe(2);
    expect(decision.scheduleReason).toMatchObject({
      kind: "source_unresolved_shortened",
      baseIntervalDays: 7,
      finalIntervalDays: 2,
    });
  });

  it("applies recency after mostly ignored no-output source-processing adjustment", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: C,
        lastSeenAt: addDays(NOW, -30),
        sourceProcessing: {
          unresolvedRatio: 0,
          terminalRatio: 1,
          ignoredRatio: 0.75,
          extractedOutputCount: 0,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(30);
    expect(daysBetween(NOW, decision.dueAt)).toBe(30);
    expect(decision.retirementSuggestion).toBe(true);
    expect(decision.scheduleReason).toMatchObject({
      kind: "source_exhausted_lengthened",
      baseIntervalDays: 30,
      finalIntervalDays: 30,
    });
  });

  it("with adaptive intervals on, applies the multiplier between action interval and recency", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: B,
        lastAction: "done",
        lastSeenAt: addDays(NOW, -3),
        adaptiveAttentionIntervals: true,
        attentionIntervalMultiplier: 1,
        visitYield: { childExtractsCreated: 1 },
      },
      NOW,
    );

    expect(decision.attentionIntervalMultiplier).toBe(0.9);
    expect(decision.adaptiveReason).toMatchObject({
      reasonKind: "yield_shortened",
      priorMultiplier: 1,
      newMultiplier: 0.9,
      baseIntervalDays: 60,
      intervalAfterMultiplierDays: 54,
      finalIntervalDays: 51,
    });
    expect(decision.scheduleReason).toMatchObject({
      kind: "yield_shortened",
      priorMultiplier: 1,
      newMultiplier: 0.9,
      baseIntervalDays: 60,
      intervalAfterMultiplierDays: 54,
      finalIntervalDays: 51,
      productiveOutputCount: 1,
    });
    expect(decision.intervalDays).toBe(51);
    expect(daysBetween(NOW, decision.dueAt)).toBe(51);
  });

  it("with adaptive intervals on, lengthens barren sources without the legacy binary double", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: C,
        adaptiveAttentionIntervals: true,
        attentionIntervalMultiplier: 1,
        visitYield: { unresolvedRatio: 0, terminalRatio: 1, ignoredRatio: 0.75 },
        sourceProcessing: {
          unresolvedRatio: 0,
          terminalRatio: 1,
          ignoredRatio: 0.75,
          extractedOutputCount: 0,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(35);
    expect(decision.attentionIntervalMultiplier).toBe(1.15);
    expect(decision.retirementSuggestion).toBe(true);
    expect(decision.adaptiveReason).toMatchObject({
      reasonKind: "yield_lengthened",
      baseIntervalDays: 30,
      intervalAfterMultiplierDays: 35,
      finalIntervalDays: 35,
    });
    expect(decision.scheduleReason).toMatchObject({
      kind: "yield_lengthened",
      baseIntervalDays: 30,
      intervalAfterMultiplierDays: 35,
      finalIntervalDays: 35,
      productiveOutputCount: 0,
    });
  });

  it("with adaptive intervals on, explains high-unresolved no-output source visits as source processing", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: B,
        adaptiveAttentionIntervals: true,
        attentionIntervalMultiplier: 1,
        visitYield: { unresolvedRatio: 0.5, terminalRatio: 0.5, ignoredRatio: 0 },
        sourceProcessing: {
          unresolvedRatio: 0.5,
          terminalRatio: 0.5,
          ignoredRatio: 0,
          extractedOutputCount: 0,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(3);
    expect(decision.attentionIntervalMultiplier).toBe(0.95);
    expect(decision.adaptiveReason).toMatchObject({
      reasonKind: "yield_shortened",
      productiveOutputCount: 0,
      baseIntervalDays: 7,
      intervalAfterMultiplierDays: 7,
      finalIntervalDays: 3,
    });
    expect(decision.scheduleReason).toMatchObject({
      kind: "source_unresolved_shortened",
      baseIntervalDays: 7,
      finalIntervalDays: 3,
      extractedOutputCount: 0,
    });
  });

  it("with adaptive intervals on, productive extract visits emit structured reason data", () => {
    const decision = nextDueAt(
      {
        type: "extract",
        stage: "clean_extract",
        priority: C,
        adaptiveAttentionIntervals: true,
        attentionIntervalMultiplier: 1,
        visitYield: { synthesisOutputsCreated: 1 },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(9);
    expect(decision.attentionIntervalMultiplier).toBe(0.85);
    expect(decision.adaptiveReason).toMatchObject({
      reasonKind: "yield_shortened",
      productiveOutputCount: 1,
      baseIntervalDays: 10,
      intervalAfterMultiplierDays: 9,
      finalIntervalDays: 9,
    });
    expect(decision.scheduleReason).toMatchObject({
      kind: "yield_shortened",
      productiveOutputCount: 1,
      baseIntervalDays: 10,
      intervalAfterMultiplierDays: 9,
      finalIntervalDays: 9,
    });
  });

  it("maps malformed adaptive input to no visible schedule reason", () => {
    const decision = nextDueAt(
      {
        type: "extract",
        stage: "clean_extract",
        priority: C,
        adaptiveAttentionIntervals: true,
        attentionIntervalMultiplier: 1,
        visitYield: { cardsCreated: -1 },
      },
      NOW,
    );

    expect(decision.adaptiveReason?.reasonKind).toBe("yield_input_malformed");
    expect(decision.scheduleReason).toBeUndefined();
  });

  it("emits postpone recession as a schedule reason", () => {
    const decision = nextDueAt(
      {
        type: "extract",
        stage: "raw_extract",
        priority: B,
        lastAction: "postpone",
        postponeCount: 2,
      },
      NOW,
    );

    expect(decision.scheduleReason).toMatchObject({
      kind: "postpone_recession",
      baseIntervalDays: extractStageIntervalDays("raw_extract", B),
      intervalAfterPostponeDays: postponeIntervalForPriority(B, 2),
      finalIntervalDays: postponeIntervalForPriority(B, 2),
      postponeCount: 2,
    });
  });

  it("shortens struggling sources within the descendant-pressure cap and emits the reason", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: C,
        descendantHealth: {
          descendantLapseCount: 4,
          affectedCardCount: 2,
          descendantCardCount: 5,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(23);
    expect(decision.scheduleReason).toMatchObject({
      kind: "descendant_lapses",
      baseIntervalDays: 30,
      intervalAfterDescendantDays: 23,
      finalIntervalDays: 23,
      descendantLapseCount: 4,
      affectedCardCount: 2,
      descendantCardCount: 5,
      descendantLapseRate: 0.8,
    });
  });

  it("does not compound descendant pressure below the adaptive multiplier floor", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: C,
        adaptiveAttentionIntervals: true,
        attentionIntervalMultiplier: MIN_ATTENTION_INTERVAL_MULTIPLIER,
        visitYield: { childExtractsCreated: 1 },
        descendantHealth: {
          descendantLapseCount: 4,
          affectedCardCount: 2,
          descendantCardCount: 5,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(15);
    expect(daysBetween(NOW, decision.dueAt)).toBe(15);
    expect(decision.attentionIntervalMultiplier).toBe(MIN_ATTENTION_INTERVAL_MULTIPLIER);
    expect(decision.adaptiveReason).toMatchObject({
      reasonKind: "yield_shortened",
      baseIntervalDays: 30,
      intervalAfterMultiplierDays: 15,
      finalIntervalDays: 15,
    });
    expect(decision.scheduleReason).toMatchObject({
      kind: "yield_shortened",
      baseIntervalDays: 30,
      intervalAfterMultiplierDays: 15,
      finalIntervalDays: 15,
    });
  });

  it.each([
    [
      "below lapse floor",
      { descendantLapseCount: 2, affectedCardCount: 2, descendantCardCount: 5 },
    ],
    [
      "one affected card",
      { descendantLapseCount: 3, affectedCardCount: 1, descendantCardCount: 5 },
    ],
    [
      "below rate floor",
      { descendantLapseCount: 3, affectedCardCount: 2, descendantCardCount: 31 },
    ],
    [
      "zero descendant cards",
      { descendantLapseCount: 3, affectedCardCount: 2, descendantCardCount: 0 },
    ],
    [
      "non-integer counts",
      { descendantLapseCount: 3.5, affectedCardCount: 2, descendantCardCount: 5 },
    ],
    [
      "affected exceeds total",
      { descendantLapseCount: 4, affectedCardCount: 3, descendantCardCount: 2 },
    ],
  ])("treats %s as a no-op", (_, descendantHealth) => {
    const withSignal = nextDueAt(
      {
        type: "source",
        priority: C,
        descendantHealth,
      },
      NOW,
    );
    const baseline = nextDueAt({ type: "source", priority: C }, NOW);

    expect(withSignal).toEqual(baseline);
  });

  it("applies stronger pressure for denser lapse rates and caps at 25%", () => {
    const dense = nextDueAt(
      {
        type: "source",
        priority: C,
        descendantHealth: {
          descendantLapseCount: 3,
          affectedCardCount: 2,
          descendantCardCount: 3,
        },
      },
      NOW,
    );
    const sparse = nextDueAt(
      {
        type: "source",
        priority: C,
        descendantHealth: {
          descendantLapseCount: 3,
          affectedCardCount: 2,
          descendantCardCount: 20,
        },
      },
      NOW,
    );

    expect(dense.intervalDays).toBe(23);
    expect(sparse.intervalDays).toBe(26);
    expect(dense.intervalDays).toBeLessThan(sparse.intervalDays);
  });

  it("never lengthens a source already at the 1-day interval floor", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: A,
        descendantHealth: {
          descendantLapseCount: 4,
          affectedCardCount: 2,
          descendantCardCount: 4,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(1);
    expect(decision.scheduleReason).toMatchObject({
      kind: "band_base",
      finalIntervalDays: 1,
    });
  });

  it("applies descendant pressure before recency and reports the earlier final due date", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: C,
        lastSeenAt: addDays(NOW, -3),
        descendantHealth: {
          descendantLapseCount: 4,
          affectedCardCount: 2,
          descendantCardCount: 5,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(20);
    expect(decision.scheduleReason).toMatchObject({
      kind: "descendant_lapses",
      baseIntervalDays: 30,
      intervalAfterDescendantDays: 23,
      finalIntervalDays: 20,
    });
  });

  it("keeps the stronger existing reason when descendant pressure does not beat the baseline", () => {
    const decision = nextDueAt(
      {
        type: "source",
        priority: B,
        sourceProcessing: {
          unresolvedRatio: 0.5,
          terminalRatio: 0.5,
          ignoredRatio: 0,
          extractedOutputCount: 1,
        },
        descendantHealth: {
          descendantLapseCount: 3,
          affectedCardCount: 2,
          descendantCardCount: 20,
        },
      },
      NOW,
    );

    expect(decision.intervalDays).toBe(3);
    expect(decision.scheduleReason).toMatchObject({
      kind: "source_unresolved_shortened",
      baseIntervalDays: 7,
      finalIntervalDays: 3,
    });
  });

  it("ignores descendant health for non-source inputs", () => {
    const decision = nextDueAt(
      {
        type: "extract",
        stage: "clean_extract",
        priority: C,
        descendantHealth: {
          descendantLapseCount: 4,
          affectedCardCount: 2,
          descendantCardCount: 5,
        },
      },
      NOW,
    );

    expect(decision.scheduleReason).toMatchObject({
      kind: "band_base",
      baseIntervalDays: 10,
      finalIntervalDays: 10,
    });
  });

  it.each([
    [
      "source processing",
      {
        type: "source",
        priority: B,
        sourceProcessing: {
          unresolvedRatio: 0.5,
          terminalRatio: 0.5,
          ignoredRatio: 0,
          extractedOutputCount: 1,
        },
      },
    ],
    [
      "extract",
      {
        type: "extract",
        stage: "raw_extract",
        priority: B,
      },
    ],
    [
      "topic default",
      {
        type: "topic",
        priority: C,
        defaultTopicIntervalDays: 14,
      },
    ],
    [
      "postpone",
      {
        type: "source",
        priority: B,
        lastAction: "postpone",
        postponeCount: 2,
      },
    ],
    [
      "done with recency",
      {
        type: "source",
        priority: B,
        lastAction: "done",
        lastSeenAt: addDays(NOW, -3),
      },
    ],
  ] as const)("keeps flag-off behavior byte-identical for %s", (_, input) => {
    const legacy = nextDueAt(input, NOW);
    const flagOff = nextDueAt(
      {
        ...input,
        adaptiveAttentionIntervals: false,
        attentionIntervalMultiplier: 4,
        visitYield: { childExtractsCreated: 10, cardsCreated: 10, unresolvedRatio: 0 },
      },
      NOW,
    );

    expect(flagOff).toEqual(legacy);
  });
});

describe("sourceRetirementSuggestion", () => {
  const deadSource = {
    sourceId: "src_1",
    totalBlocks: 4,
    terminalBlocks: 4,
    ignoredBlocks: 3,
    unresolvedBlocks: 0,
    unresolvedRatio: 0,
    terminalRatio: 1,
    ignoredRatio: 0.75,
    extractedOutputCount: 0,
  };

  it("returns the low-yield abandon suggestion for mostly ignored no-output sources", () => {
    expect(sourceRetirementSuggestion(deadSource)).toEqual({
      kind: "abandon",
      reason: "mostly_ignored_no_output",
      reasonLabel: "Mostly ignored blocks, no extracts yet",
      signalHash: "v1|src_1|abandon|thresholds:terminal>=0.9,ignored>=0.5,output=0|4|4|3|0|0",
      terminalRatio: 1,
      ignoredRatio: 0.75,
      totalBlocks: 4,
      terminalBlocks: 4,
      ignoredBlocks: 3,
      unresolvedBlocks: 0,
      extractedOutputCount: 0,
    });
  });

  it("does not suggest retirement below threshold or when output exists", () => {
    expect(sourceRetirementSuggestion({ ...deadSource, terminalRatio: 0.89 })).toBeNull();
    expect(sourceRetirementSuggestion({ ...deadSource, ignoredRatio: 0.49 })).toBeNull();
    expect(sourceRetirementSuggestion({ ...deadSource, extractedOutputCount: 1 })).toBeNull();
  });

  it("uses a versioned integer-count hash rather than ratio precision", () => {
    const baseHash = sourceRetirementSignalHash(deadSource);
    expect(sourceRetirementSignalHash({ ...deadSource, ignoredRatio: 0.75000001 })).toBe(baseHash);
    expect(sourceRetirementSignalHash({ ...deadSource, ignoredBlocks: 4 })).not.toBe(baseHash);
    expect(sourceRetirementSignalHash({ ...deadSource, sourceId: "src_2" })).not.toBe(baseHash);
  });
});

describe("explicit choices: tomorrow / next week / next month", () => {
  it("land on exactly +1 / +7 / +30 days from the fixed clock", () => {
    expect(scheduleTomorrow(NOW)).toEqual({ dueAt: "2026-05-31T12:00:00.000Z", intervalDays: 1 });
    expect(scheduleNextWeek(NOW)).toEqual({ dueAt: "2026-06-06T12:00:00.000Z", intervalDays: 7 });
    expect(scheduleNextMonth(NOW)).toEqual({ dueAt: "2026-06-29T12:00:00.000Z", intervalDays: 30 });
  });

  it("scheduleForChoice dispatches to the right explicit choice", () => {
    expect(scheduleForChoice("tomorrow", NOW)).toEqual(scheduleTomorrow(NOW));
    expect(scheduleForChoice("nextWeek", NOW)).toEqual(scheduleNextWeek(NOW));
    expect(scheduleForChoice("nextMonth", NOW)).toEqual(scheduleNextMonth(NOW));
  });
});

describe("scheduleManual (normalize + validate)", () => {
  it("accepts a canonical ISO string and computes the day delta", () => {
    const decision = scheduleManual("2026-06-09T12:00:00.000Z", NOW);
    expect(decision.dueAt).toBe("2026-06-09T12:00:00.000Z");
    expect(decision.intervalDays).toBe(10);
  });

  it("accepts a Date instance", () => {
    const decision = scheduleManual(new Date("2026-05-31T12:00:00Z"), NOW);
    expect(decision.dueAt).toBe("2026-05-31T12:00:00.000Z");
    expect(decision.intervalDays).toBe(1);
  });

  it("allows a past canonical date (due immediately)", () => {
    const decision = scheduleManual("2026-05-29T12:00:00.000Z", NOW);
    expect(decision.dueAt).toBe("2026-05-29T12:00:00.000Z");
    expect(decision.intervalDays).toBe(-1);
  });

  it("throws on unparseable or non-canonical date strings", () => {
    for (const bad of [
      "garbage",
      "0",
      "2026-02-31T00:00:00.000Z",
      "2026-06-09T12:00:00Z",
      "2026-06-09T12:00:00.000+00:00",
    ]) {
      expect(() => scheduleManual(bad as IsoTimestamp, NOW)).toThrow(/invalid date/);
    }
  });

  it("scheduleForChoice routes a manual choice through scheduleManual", () => {
    expect(scheduleForChoice({ manual: "2026-06-09T12:00:00.000Z" }, NOW)).toEqual(
      scheduleManual("2026-06-09T12:00:00.000Z", NOW),
    );
  });
});

describe("isSchedulerAction", () => {
  it("recognises the five canonical actions only", () => {
    for (const a of ["extract", "rewrite", "activate", "done", "postpone"]) {
      expect(isSchedulerAction(a)).toBe(true);
    }
    expect(isSchedulerAction("grade")).toBe(false);
    expect(isSchedulerAction(undefined)).toBe(false);
  });
});
