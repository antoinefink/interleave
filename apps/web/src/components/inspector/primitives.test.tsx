import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SchedulerSignals } from "../../lib/appApi";
import {
  FsrsStats,
  formatAttentionScheduleReason,
  ScheduleReasonLine,
  SchedulerChip,
} from "./primitives";

/** A complete FSRS `SchedulerSignals` with the raw doubles from the screenshots. */
function fsrsSignals(overrides: Partial<SchedulerSignals> = {}): SchedulerSignals {
  return {
    kind: "fsrs",
    retrievability: 0.93,
    stability: 4.88681033,
    difficulty: 7.37018264,
    reps: 5,
    lapses: 1,
    fsrsState: "review",
    stage: "active_card",
    postponed: 0,
    scheduleReason: null,
    lastProcessedAt: "2026-06-01T08:00:00.000Z",
    ...overrides,
  };
}

function attentionSignals(overrides: Partial<SchedulerSignals> = {}): SchedulerSignals {
  return {
    kind: "attention",
    retrievability: null,
    stability: null,
    difficulty: null,
    reps: null,
    lapses: null,
    fsrsState: null,
    stage: "clean_extract",
    postponed: 0,
    scheduleReason: null,
    lastProcessedAt: "2026-06-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("SchedulerChip (FSRS)", () => {
  it("truncates the raw stability double for display but keeps full precision in the title", () => {
    const { container } = render(<SchedulerChip scheduler={fsrsSignals()} />);
    const stability = container.querySelector('span[title^="Stability"]') as HTMLElement;
    expect(stability.textContent).toBe("S 4.9d");
    // The exact value never reaches the visible chip…
    expect(container.textContent).not.toContain("4.88681033");
    // …but is preserved verbatim on hover.
    expect(stability).toHaveAttribute("title", "Stability 4.88681033 days");
  });

  it("rounds retrievability to a whole percent", () => {
    const { container } = render(
      <SchedulerChip scheduler={fsrsSignals({ retrievability: 0.934 })} />,
    );
    expect(container.textContent).toContain("93%");
  });

  it("omits the stability segment entirely for a brand-new card", () => {
    const { container } = render(
      <SchedulerChip scheduler={fsrsSignals({ stability: null, retrievability: null })} />,
    );
    expect(container.textContent).toContain("new");
    expect(container.querySelector('span[title^="Stability"]')).toBeNull();
  });
});

describe("FsrsStats", () => {
  it("truncates stability and difficulty in the cards, keeping full precision in the title", () => {
    const { container } = render(<FsrsStats scheduler={fsrsSignals()} />);
    const values = container.querySelectorAll(".fstat__v");
    const stability = values[0] as HTMLElement;
    const difficulty = values[1] as HTMLElement;
    const retrievability = values[2] as HTMLElement;

    expect(stability.textContent).toBe("4.9d");
    expect(stability).toHaveAttribute("title", "4.88681033 days");
    expect(difficulty.textContent).toBe("7.4/10");
    expect(difficulty).toHaveAttribute("title", "7.37018264 / 10");
    expect(retrievability.textContent).toBe("93%");

    // No absurd precision leaks into the visible readout.
    expect(container.textContent).not.toContain("4.88681033");
    expect(container.textContent).not.toContain("7.37018264");
  });

  it("renders an em dash for an unknown retrievability", () => {
    const { container } = render(<FsrsStats scheduler={fsrsSignals({ retrievability: null })} />);
    const retrievability = container.querySelectorAll(".fstat__v")[2] as HTMLElement;
    expect(retrievability.textContent).toBe("—");
  });

  it("falls back to 0 for a card with no stability/difficulty yet", () => {
    const { container } = render(
      <FsrsStats scheduler={fsrsSignals({ stability: null, difficulty: null })} />,
    );
    const values = container.querySelectorAll(".fstat__v");
    expect((values[0] as HTMLElement).textContent).toBe("0d");
    expect((values[1] as HTMLElement).textContent).toBe("0/10");
  });
});

describe("ScheduleReasonLine", () => {
  it("formats every visible attention schedule reason with the T113 templates", () => {
    expect(
      formatAttentionScheduleReason(
        attentionSignals({
          scheduleReason: {
            kind: "yield_shortened",
            baseIntervalDays: 7,
            finalIntervalDays: 6,
            productiveOutputCount: 2,
          },
        }),
      ),
    ).toBe("Returning sooner: last visit produced 2 output(s).");
    expect(
      formatAttentionScheduleReason(
        attentionSignals({
          scheduleReason: {
            kind: "yield_lengthened",
            baseIntervalDays: 30,
            finalIntervalDays: 35,
            productiveOutputCount: 0,
          },
        }),
      ),
    ).toBe("Receding: recent visit produced no output.");
    expect(
      formatAttentionScheduleReason(
        attentionSignals({
          scheduleReason: {
            kind: "recency_damped",
            baseIntervalDays: 7,
            finalIntervalDays: 4,
            daysSinceLastSeen: 14,
          },
        }),
      ),
    ).toBe("Returning sooner: untouched for 14d.");
    expect(
      formatAttentionScheduleReason(
        attentionSignals({
          scheduleReason: {
            kind: "postpone_recession",
            baseIntervalDays: 7,
            finalIntervalDays: 21,
            postponeCount: 3,
          },
        }),
      ),
    ).toBe("Receding after postpone x3.");
    expect(
      formatAttentionScheduleReason(
        attentionSignals({
          scheduleReason: {
            kind: "source_unresolved_shortened",
            baseIntervalDays: 7,
            finalIntervalDays: 3,
            unresolvedRatio: 0.5,
            terminalRatio: 0.5,
            ignoredRatio: 0,
            extractedOutputCount: 0,
          },
        }),
      ),
    ).toBe("Returning sooner: source still has unresolved blocks.");
    expect(
      formatAttentionScheduleReason(
        attentionSignals({
          scheduleReason: {
            kind: "source_exhausted_lengthened",
            baseIntervalDays: 30,
            finalIntervalDays: 60,
            unresolvedRatio: 0,
            terminalRatio: 1,
            ignoredRatio: 0.75,
            extractedOutputCount: 0,
          },
        }),
      ),
    ).toBe("Receding: source produced no extractable output.");
    expect(
      formatAttentionScheduleReason(
        attentionSignals({
          scheduleReason: {
            kind: "descendant_lapses",
            baseIntervalDays: 7,
            finalIntervalDays: 4,
            descendantLapseCount: 3,
            affectedCardCount: 2,
            descendantCardCount: 20,
            descendantLapseRate: 0.15,
            intervalAfterDescendantDays: 6,
          },
        }),
      ),
    ).toBe("Returning sooner: descendant cards are struggling.");
  });

  it("does not mount for band-base, missing evidence, or FSRS card signals", () => {
    const { rerender, queryByTestId } = render(
      <ScheduleReasonLine
        scheduler={attentionSignals({
          scheduleReason: { kind: "band_base", baseIntervalDays: 7, finalIntervalDays: 7 },
        })}
      />,
    );
    expect(queryByTestId("schedule-reason-line")).toBeNull();

    rerender(
      <ScheduleReasonLine
        scheduler={attentionSignals({
          scheduleReason: {
            kind: "yield_shortened",
            baseIntervalDays: 7,
            finalIntervalDays: 6,
            productiveOutputCount: null,
          },
        })}
      />,
    );
    expect(queryByTestId("schedule-reason-line")).toBeNull();

    rerender(
      <ScheduleReasonLine
        scheduler={attentionSignals({
          scheduleReason: {
            kind: "descendant_lapses",
            baseIntervalDays: 7,
            finalIntervalDays: 4,
            descendantLapseCount: 3,
          },
        })}
      />,
    );
    expect(queryByTestId("schedule-reason-line")).toBeNull();

    rerender(
      <ScheduleReasonLine
        scheduler={attentionSignals({
          scheduleReason: {
            kind: "yield_shortened",
            baseIntervalDays: 7,
            finalIntervalDays: 6,
            productiveOutputCount: 0,
          },
        })}
      />,
    );
    expect(queryByTestId("schedule-reason-line")).toBeNull();

    rerender(
      <ScheduleReasonLine
        scheduler={fsrsSignals({
          scheduleReason: {
            kind: "postpone_recession",
            baseIntervalDays: 7,
            finalIntervalDays: 28,
            postponeCount: 4,
          },
        })}
      />,
    );
    expect(queryByTestId("schedule-reason-line")).toBeNull();
  });
});
