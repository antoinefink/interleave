import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeeklyReviewProgress, WeeklyReviewSummaryResult } from "../lib/appApi";

const h = vi.hoisted(() => ({
  getWeeklyReviewSummary: vi.fn(),
  updateWeeklyReviewProgress: vi.fn(),
  completeWeeklyReview: vi.fn(),
  dismissWeeklyReview: vi.fn(),
  parkedResurfacingApply: vi.fn(),
  chronicPostponesApply: vi.fn(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    appApi: {
      getWeeklyReviewSummary: h.getWeeklyReviewSummary,
      updateWeeklyReviewProgress: h.updateWeeklyReviewProgress,
      completeWeeklyReview: h.completeWeeklyReview,
      dismissWeeklyReview: h.dismissWeeklyReview,
      maintenance: {
        parkedResurfacingApply: h.parkedResurfacingApply,
        chronicPostponesApply: h.chronicPostponesApply,
      },
    },
  };
});

import { WeeklyReviewScreen } from "./WeeklyReviewScreen";

/**
 * A fully-populated, type-valid weekly summary: one parked row, one chronic row,
 * a non-empty `integrity.resting`, active threshold flags, and the four optional
 * `*Prev` ledger values (so the funnel renders week-over-week deltas). Individual
 * tests override slices via `makeSummary(overrides)`.
 */
const BASE_PROGRESS: WeeklyReviewProgress = {
  taskId: "weekly-1",
  windowStart: "2026-06-06T00:00:00.000Z",
  windowEnd: "2026-06-12T12:00:00.000Z",
  sections: {
    ledger: "pending",
    integrity: "pending",
    parked: "pending",
    chronic: "pending",
    fallow: "pending",
  },
};

const BASE_SUMMARY: WeeklyReviewSummaryResult = {
  asOf: "2026-06-12T12:00:00.000Z",
  enabled: true,
  cadenceDays: 7,
  session: {
    id: "weekly-1",
    taskType: "weekly_review",
    title: "Weekly review",
    note: null,
    status: "scheduled",
    dueAt: "2026-06-12T12:00:00.000Z",
    priority: 0.875,
    linkedElement: null,
  },
  due: true,
  window: {
    start: "2026-06-06T00:00:00.000Z",
    end: "2026-06-12T12:00:00.000Z",
    days: 7,
  },
  progress: BASE_PROGRESS,
  ledger: {
    sources: 5,
    extracts: 3,
    cards: 4,
    maturedCards: 2,
    // Prior window: sources up (5 vs 2 → +3), extracts flat (3 vs 3 → ±0),
    // cards down (4 vs 6 → −2), matured up (2 vs 1 → +1). Each delta magnitude is
    // distinct so the funnel-delta test can target stages unambiguously by text.
    sourcesPrev: 2,
    extractsPrev: 3,
    cardsPrev: 6,
    maturedCardsPrev: 1,
    priorityMisses: [
      { band: "A", deferred: 4, postponeDebtDays: 6.5 },
      { band: "C", deferred: 1, postponeDebtDays: 1.25 },
    ],
  },
  integrity: {
    asOf: "2026-06-12T12:00:00.000Z",
    windowDays: 7,
    priorityAttribution: "current",
    bands: [],
    topics: [],
    sacrificed: [],
    resting: [
      {
        topicId: "topic-1",
        title: "Stoic philosophy",
        band: "B",
        fallowUntil: "2026-06-26T00:00:00.000Z",
        fallowReason: "Rested from weekly integrity session",
      },
      {
        topicId: "topic-2",
        title: "Compiler internals",
        band: "C",
        fallowUntil: "2026-06-22T00:00:00.000Z",
        fallowReason: null,
      },
    ],
    thresholdFlags: {
      aBandInflation: false,
      aBandDeferredRecently: true,
      postponeDebtHigh: true,
    },
  },
  decisions: {
    parked: {
      rows: [
        {
          element: {
            id: "parked-1",
            type: "source",
            title: "Parked source",
            priority: 0.875,
            priorityLabel: "A",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
          parkedAt: "2026-03-01T00:00:00.000Z",
          ageDays: 103,
        },
      ],
      totalDue: 1,
      limit: 8,
      asOf: "2026-06-12T12:00:00.000Z",
    },
    chronic: {
      rows: [
        {
          element: {
            id: "chronic-1",
            type: "extract",
            title: "Chronic extract",
            priority: 0.625,
            priorityLabel: "B",
            status: "scheduled",
            dueAt: "2026-06-12T12:00:00.000Z",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
          scheduler: "attention",
          postponeCount: 5,
        },
      ],
      totalDue: 1,
      threshold: 5,
      limit: 8,
    },
    fallowSuggestions: [
      {
        topicId: "fallow-1",
        title: "Dormant topic",
        band: "C",
        deferred: 9,
        postponeDebtDays: 12.5,
      },
    ],
  },
};

function makeSummary(
  overrides: Partial<WeeklyReviewSummaryResult> = {},
): WeeklyReviewSummaryResult {
  return { ...BASE_SUMMARY, ...overrides };
}

/** A calm week: every forced-decision queue empty, no misses, no resting topics. */
function calmSummary(): WeeklyReviewSummaryResult {
  return makeSummary({
    ledger: { ...BASE_SUMMARY.ledger, priorityMisses: [] },
    integrity: { ...BASE_SUMMARY.integrity, resting: [] },
    decisions: {
      parked: { rows: [], totalDue: 0, limit: 8, asOf: BASE_SUMMARY.asOf },
      chronic: { rows: [], totalDue: 0, threshold: 5, limit: 8 },
      fallowSuggestions: [],
    },
  });
}

/** The header window line that carries the date range, cadence label, and sections-left text. */
function windowLine(): HTMLElement {
  const line = screen.getByTestId("weekly-review").querySelector(".wk-window");
  if (!line) throw new Error("window line not found");
  return line as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getWeeklyReviewSummary.mockResolvedValue(BASE_SUMMARY);
  h.updateWeeklyReviewProgress.mockResolvedValue(BASE_SUMMARY.progress);
  h.completeWeeklyReview.mockResolvedValue({ task: null, progress: null });
  h.dismissWeeklyReview.mockResolvedValue({
    task: BASE_SUMMARY.session,
    progress: BASE_SUMMARY.progress,
  });
  h.parkedResurfacingApply.mockResolvedValue({ applied: 1, skipped: [], batchId: "p1" });
  h.chronicPostponesApply.mockResolvedValue({ applied: 1, skipped: [], batchId: "c1" });
});

describe("WeeklyReviewScreen", () => {
  it("applies parked and chronic decisions through the existing maintenance commands", async () => {
    render(<WeeklyReviewScreen />);
    expect(await screen.findByTestId("weekly-review")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Queue"));
    fireEvent.click(screen.getByText("Apply parked decisions"));
    await waitFor(() =>
      expect(h.parkedResurfacingApply).toHaveBeenCalledWith({
        decisions: [{ id: "parked-1", kind: "queueNow" }],
      }),
    );
    expect(h.updateWeeklyReviewProgress).toHaveBeenCalledWith({
      taskId: "weekly-1",
      sections: { parked: "done" },
    });

    fireEvent.click(screen.getByText("Demote"));
    fireEvent.click(screen.getByText("Apply chronic decisions"));
    await waitFor(() =>
      expect(h.chronicPostponesApply).toHaveBeenCalledWith({
        decisions: [{ id: "chronic-1", kind: "demote" }],
      }),
    );
    expect(h.updateWeeklyReviewProgress).toHaveBeenCalledWith({
      taskId: "weekly-1",
      sections: { chronic: "done" },
    });
  });

  it("renders week-over-week funnel deltas (up and ±0) when prior-window counts are present", async () => {
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    // Every stage with a *Prev value shows the delta sub-line.
    const deltas = await screen.findAllByText(/vs last wk/);
    expect(deltas.length).toBe(4);

    // Sources went 2 → 5: an "up" delta of 3.
    const sourcesUp = deltas.find((node) => node.textContent?.includes("3 vs last wk"));
    expect(sourcesUp).toBeTruthy();
    expect(sourcesUp).toHaveClass("up");

    // Extracts were flat (3 → 3): the ±0 case renders on the "down"/neutral track.
    const flat = deltas.find((node) => node.textContent?.includes("±0 vs last wk"));
    expect(flat).toBeTruthy();
    expect(flat).toHaveClass("down");

    // Cards went 6 → 4: a "down" delta of 2.
    const cardsDown = deltas.find((node) => node.textContent?.includes("2 vs last wk"));
    expect(cardsDown).toBeTruthy();
    expect(cardsDown).toHaveClass("down");
  });

  it("renders no delta text when prior-window counts are omitted (R6 graceful degradation)", async () => {
    h.getWeeklyReviewSummary.mockResolvedValue(
      makeSummary({
        ledger: {
          sources: 5,
          extracts: 3,
          cards: 4,
          maturedCards: 2,
          priorityMisses: [],
        },
      }),
    );
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    expect(screen.queryByText(/vs last wk/)).toBeNull();
  });

  it("derives the progress ring from server-persisted section progress", async () => {
    h.getWeeklyReviewSummary.mockResolvedValue(
      makeSummary({
        progress: {
          ...BASE_PROGRESS,
          sections: {
            ledger: "done",
            integrity: "pending",
            parked: "pending",
            chronic: "pending",
            fallow: "pending",
          },
        },
      }),
    );
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    const ring = screen.getByTitle("1 of 5 sections reviewed");
    expect(ring).toBeInTheDocument();
    expect(ring).toHaveTextContent("1/5");
  });

  it("renders active integrity flags as amber cards and resting topics as concept tags", async () => {
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    // The A-band deferred flag is active → amber card showing "Yes".
    const aBandLabel = screen.getByText("A-band deferred");
    const aBandCard = aBandLabel.closest(".wk-flag");
    expect(aBandCard).not.toBeNull();
    expect(aBandCard).toHaveClass("wk-flag--on");
    expect(within(aBandCard as HTMLElement).getByText("Yes")).toBeInTheDocument();

    // The postpone-debt flag is active → amber card showing "High".
    const debtCard = screen.getByText("Postpone debt").closest(".wk-flag");
    expect(debtCard).toHaveClass("wk-flag--on");
    expect(within(debtCard as HTMLElement).getByText("High")).toBeInTheDocument();

    // Resting topics surface their titles as concept-tag pills.
    expect(screen.getByText("Stoic philosophy")).toBeInTheDocument();
    expect(screen.getByText("Compiler internals")).toBeInTheDocument();
  });

  it("renders the calm-week empty states for a fully-empty summary", async () => {
    h.getWeeklyReviewSummary.mockResolvedValue(calmSummary());
    render(<WeeklyReviewScreen />);

    // Still mounts.
    expect(await screen.findByTestId("weekly-review")).toBeInTheDocument();

    expect(
      screen.getByText("No priority misses in this window. Every due band was served."),
    ).toBeInTheDocument();
    expect(screen.getByText("No parked sources are due to resurface.")).toBeInTheDocument();
    expect(screen.getByText("No chronic postpones are due for reckoning.")).toBeInTheDocument();
    expect(
      screen.getByText("No fallow suggestions — nothing is ready to rest."),
    ).toBeInTheDocument();

    // No resting topics → the resting flag reads 0 and no concept pills appear.
    expect(screen.queryByText("Stoic philosophy")).toBeNull();
  });

  it("renders the load error state when the summary fetch rejects", async () => {
    h.getWeeklyReviewSummary.mockRejectedValue(new Error("vault offline"));
    render(<WeeklyReviewScreen />);

    expect(await screen.findByTestId("weekly-error")).toBeInTheDocument();
    expect(screen.getByText("vault offline")).toBeInTheDocument();
  });

  it("surfaces an action error when a decision apply rejects", async () => {
    h.parkedResurfacingApply.mockRejectedValue(new Error("apply failed"));
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    fireEvent.click(screen.getByText("Apply parked decisions"));

    expect(await screen.findByTestId("weekly-action-error")).toBeInTheDocument();
    expect(screen.getByText("apply failed")).toBeInTheDocument();
  });

  it("never flashes the full-page loading placeholder when toggling Done (scroll preserved via background reload)", async () => {
    // Gate the SECOND summary fetch (the post-toggle reload) on a promise we resolve
    // by hand. This freezes the in-flight window so we can assert the body never
    // unmounts into the full-page `Loading weekly review...` placeholder mid-reload.
    // That placeholder zeroing the scroll container is the documented scroll-jump
    // cause; jsdom has no layout/scroll, so "placeholder never rendered" is the
    // provable proxy for "body not remounted → scroll preserved".
    const reloadGate: { resolve: ((value: WeeklyReviewSummaryResult) => void) | null } = {
      resolve: null,
    };
    h.getWeeklyReviewSummary.mockReset();
    h.getWeeklyReviewSummary.mockResolvedValueOnce(BASE_SUMMARY).mockImplementationOnce(
      () =>
        new Promise<WeeklyReviewSummaryResult>((resolve) => {
          reloadGate.resolve = resolve;
        }),
    );

    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    // Once the body is shown the loading placeholder must be gone for good.
    expect(screen.queryByText(/Loading weekly review/i)).toBeNull();

    // Click Done on the Ledger section (scoped to its frame).
    const ledger = screen.getByText("Ledger").closest("section") as HTMLElement;
    fireEvent.click(within(ledger).getByRole("button", { name: /Done/ }));

    // (a) The section is persisted as done…
    await waitFor(() =>
      expect(h.updateWeeklyReviewProgress).toHaveBeenCalledWith({
        taskId: "weekly-1",
        sections: { ledger: "done" },
      }),
    );
    // (b) …and a background re-fetch is dispatched.
    await waitFor(() => expect(h.getWeeklyReviewSummary).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reloadGate.resolve).not.toBeNull());

    // (c) WHILE the reload is in flight, the full-page loading placeholder must NOT
    // appear and the body must stay mounted. Against the unmodified component this
    // is exactly when `load()` flips to `status: "loading"` and unmounts the body.
    expect(screen.queryByText(/Loading weekly review/i)).toBeNull();
    expect(screen.getByTestId("weekly-review")).toBeInTheDocument();

    // Let the reload settle; still no placeholder, body intact.
    reloadGate.resolve?.(BASE_SUMMARY);
    await waitFor(() => expect(screen.getByTestId("weekly-review")).toBeInTheDocument());
    expect(screen.queryByText(/Loading weekly review/i)).toBeNull();
  });

  it("surfaces a failed background reload inline without tearing down the body", async () => {
    // First fetch (initial load) succeeds; the second fetch (the background reload
    // after a toggle) rejects. The screen must stay on the body and show the inline
    // action-error banner — it must NOT switch to the full-page error state.
    h.getWeeklyReviewSummary
      .mockResolvedValueOnce(BASE_SUMMARY)
      .mockRejectedValueOnce(new Error("reload failed"));

    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    const ledger = screen.getByText("Ledger").closest("section") as HTMLElement;
    fireEvent.click(within(ledger).getByRole("button", { name: /Done/ }));

    // The error surfaces inline.
    expect(await screen.findByTestId("weekly-action-error")).toBeInTheDocument();
    expect(screen.getByText("reload failed")).toBeInTheDocument();

    // The body remains mounted: a stable section title is still present, the screen
    // did not switch to the full-page error state, and no loading placeholder showed.
    expect(screen.getByTestId("weekly-review")).toBeInTheDocument();
    expect(screen.getByText("Ledger")).toBeInTheDocument();
    expect(screen.queryByTestId("weekly-error")).toBeNull();
    expect(screen.queryByText(/Loading weekly review/i)).toBeNull();
  });

  it("toggles a finished section back to pending (Done un-toggles done→pending)", async () => {
    h.getWeeklyReviewSummary.mockResolvedValue(
      makeSummary({
        progress: { ...BASE_PROGRESS, sections: { ...BASE_PROGRESS.sections, ledger: "done" } },
      }),
    );
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    // Scope to the Ledger section frame (its stable per-screen label) so we click
    // *its* Done button, not another section's.
    const ledger = screen.getByText("Ledger").closest("section") as HTMLElement;
    fireEvent.click(within(ledger).getByRole("button", { name: /Done/ }));

    await waitFor(() =>
      expect(h.updateWeeklyReviewProgress).toHaveBeenCalledWith({
        taskId: "weekly-1",
        sections: { ledger: "pending" },
      }),
    );
  });

  it("toggles a skipped section back to pending (Skip un-toggles skipped→pending)", async () => {
    h.getWeeklyReviewSummary.mockResolvedValue(
      makeSummary({
        progress: { ...BASE_PROGRESS, sections: { ...BASE_PROGRESS.sections, ledger: "skipped" } },
      }),
    );
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    const ledger = screen.getByText("Ledger").closest("section") as HTMLElement;
    fireEvent.click(within(ledger).getByRole("button", { name: "Skip" }));

    await waitFor(() =>
      expect(h.updateWeeklyReviewProgress).toHaveBeenCalledWith({
        taskId: "weekly-1",
        sections: { ledger: "pending" },
      }),
    );
  });

  it("completes the session through the Complete header action", async () => {
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    fireEvent.click(screen.getByRole("button", { name: /Complete/ }));

    await waitFor(() =>
      expect(h.completeWeeklyReview).toHaveBeenCalledWith({ taskId: "weekly-1" }),
    );
  });

  it("surfaces an action error when Snooze (dismiss) rejects", async () => {
    h.dismissWeeklyReview.mockRejectedValue(new Error("snooze failed"));
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    fireEvent.click(screen.getByRole("button", { name: /Snooze/ }));

    expect(await screen.findByTestId("weekly-action-error")).toBeInTheDocument();
    expect(screen.getByText("snooze failed")).toBeInTheDocument();
    // Snooze dispatches the dismiss command (with the one-day snooze) before failing.
    expect(h.dismissWeeklyReview).toHaveBeenCalledWith({ taskId: "weekly-1", snoozeDays: 1 });
  });

  it("renders the matured-cards funnel delta as 'up' when this week beat the prior window", async () => {
    // Four distinct delta magnitudes so each stage's delta text is unambiguous:
    // sources +1, extracts +2, cards −7, matured +4 (matured is the "up" stage we assert).
    h.getWeeklyReviewSummary.mockResolvedValue(
      makeSummary({
        ledger: {
          sources: 6,
          extracts: 5,
          cards: 4,
          maturedCards: 5,
          sourcesPrev: 5,
          extractsPrev: 3,
          cardsPrev: 11,
          maturedCardsPrev: 1,
          priorityMisses: [],
        },
      }),
    );
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    const deltas = await screen.findAllByText(/vs last wk/);
    const maturedDelta = deltas.find((node) => node.textContent?.includes("4 vs last wk"));
    expect(maturedDelta).toBeTruthy();
    expect(maturedDelta).toHaveClass("up");
    expect(maturedDelta).toHaveTextContent("4 vs last wk");
  });

  it("labels a 3-day cadence as 'Every 3d'", async () => {
    h.getWeeklyReviewSummary.mockResolvedValue(makeSummary({ cadenceDays: 3 }));
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    // The cadence label is a bare text node inside the window line, alongside the
    // date range and sections-left text — assert on the line that carries it.
    expect(windowLine()).toHaveTextContent("Every 3d");
    expect(windowLine()).not.toHaveTextContent("Weekly");
  });

  it("labels a 1-day cadence as 'Daily'", async () => {
    h.getWeeklyReviewSummary.mockResolvedValue(makeSummary({ cadenceDays: 1 }));
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    expect(windowLine()).toHaveTextContent("Daily");
  });

  it("rests a chronic topic via fallow, gating Apply behind a valid return date", async () => {
    // A topic chronic row: the only element type that exposes the "Rest" (fallow) verdict.
    h.getWeeklyReviewSummary.mockResolvedValue(
      makeSummary({
        decisions: {
          ...BASE_SUMMARY.decisions,
          chronic: {
            rows: [
              {
                element: {
                  id: "chronic-topic-1",
                  type: "topic",
                  title: "Chronic topic",
                  priority: 0.625,
                  priorityLabel: "B",
                  status: "scheduled",
                  dueAt: "2026-06-12T12:00:00.000Z",
                  createdAt: "2026-06-01T00:00:00.000Z",
                },
                scheduler: "attention",
                postponeCount: 6,
              },
            ],
            totalDue: 1,
            threshold: 5,
            limit: 8,
          },
        },
      }),
    );
    render(<WeeklyReviewScreen />);
    await screen.findByTestId("weekly-review");

    // Pick the "Rest" verdict on the topic row's decision control.
    const row = screen.getByText("Chronic topic").closest(".wk-decision") as HTMLElement;
    const seg = within(row).getByRole("group", { name: "Decision for Chronic topic" });
    fireEvent.click(within(seg).getByText("Rest"));

    // (a) The return-date input appears once "Rest" is chosen (sibling of the seg in the row).
    const dateInput = await within(row).findByLabelText("Return");
    expect(dateInput).toHaveAttribute("type", "date");

    const applyButton = screen.getByRole("button", { name: /Apply chronic decisions/ });

    // (b) Clearing the date invalidates the verdict: Apply is disabled and the note is
    //     the honest corrective, not a false "N verdicts ready".
    fireEvent.change(dateInput, { target: { value: "" } });
    expect(applyButton).toBeDisabled();
    expect(screen.getByText("Set a valid return date to apply.")).toBeInTheDocument();
    expect(screen.queryByText(/verdict.* ready\./)).toBeNull();

    // (c) A valid future return date re-arms Apply and dispatches a fallow decision
    //     carrying fallowUntil + the integrity-session fallow reason.
    fireEvent.change(dateInput, { target: { value: "2099-12-31" } });
    expect(applyButton).not.toBeDisabled();
    fireEvent.click(applyButton);

    await waitFor(() =>
      expect(h.chronicPostponesApply).toHaveBeenCalledWith({
        decisions: [
          {
            id: "chronic-topic-1",
            kind: "fallow",
            fallowUntil: "2099-12-31T12:00:00.000Z",
            fallowReason: "Rested from weekly integrity session",
          },
        ],
      }),
    );
  });
});
