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
  basePostponeIntervalDays,
  EXTRACT_STAGES,
  extractStageIntervalDays,
  isExtractStage,
  isSchedulerAction,
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

  it("lastSeenAt is RESERVED — it does NOT change the interval for the MVP", () => {
    // The interval is measured forward from `now`; lastSeenAt has zero effect today.
    // Pin that contract so a future heuristic that consumes it must update this test.
    const base = nextDueAt({ type: "source", priority: B }, NOW);
    const recent = nextDueAt({ type: "source", priority: B, lastSeenAt: NOW }, NOW);
    const ancient = nextDueAt(
      { type: "source", priority: B, lastSeenAt: "2000-01-01T00:00:00.000Z" },
      NOW,
    );
    expect(recent.intervalDays).toBe(base.intervalDays);
    expect(ancient.intervalDays).toBe(base.intervalDays);
    expect(recent.dueAt).toBe(base.dueAt);
    expect(ancient.dueAt).toBe(base.dueAt);
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
  it("normalizes an ISO string to canonical ISO and computes the day delta", () => {
    const decision = scheduleManual("2026-06-09T12:00:00Z", NOW);
    expect(decision.dueAt).toBe("2026-06-09T12:00:00.000Z");
    expect(decision.intervalDays).toBe(10);
  });

  it("accepts a Date instance", () => {
    const decision = scheduleManual(new Date("2026-05-31T12:00:00Z"), NOW);
    expect(decision.dueAt).toBe("2026-05-31T12:00:00.000Z");
    expect(decision.intervalDays).toBe(1);
  });

  it("allows a past date (due immediately) but still normalizes it", () => {
    const decision = scheduleManual("2026-05-29T12:00:00Z", NOW);
    expect(decision.dueAt).toBe("2026-05-29T12:00:00.000Z");
    expect(decision.intervalDays).toBe(-1);
  });

  it("throws on an unparseable date", () => {
    expect(() => scheduleManual("garbage" as IsoTimestamp, NOW)).toThrow(/invalid date/);
  });

  it("scheduleForChoice routes a manual choice through scheduleManual", () => {
    expect(scheduleForChoice({ manual: "2026-06-09T12:00:00Z" }, NOW)).toEqual(
      scheduleManual("2026-06-09T12:00:00Z", NOW),
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
