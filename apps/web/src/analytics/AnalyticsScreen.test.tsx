/**
 * AnalyticsScreen component tests (T045).
 *
 * The aggregation lives MAIN-side (`packages/local-db` `AnalyticsService`); this
 * asserts the RENDERER seam only:
 *  - the snapshot loads from `appApi.getAnalytics()` and renders the metric tiles
 *    (retention, reviews, due, leeches/deletions) + the reviews-per-day spark;
 *  - the System-health banners link to /maintenance/leeches (leeches) and /trash
 *    (deletions), and are hidden when those counts are 0;
 *  - the empty/no-maintenance state renders when there is nothing to flag.
 *
 * Collaborators (`appApi`, the router's `useNavigate`) are mocked so the test
 * exercises ONLY this component's wiring.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsGetResult, AnalyticsReviewActivityResult } from "../lib/appApi";

const h = vi.hoisted(() => {
  const summary: AnalyticsGetResult = {
    asOf: "2026-05-30T18:00:00.000Z",
    windowDays: 30,
    reviewsByDay: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      count: i % 3,
    })),
    reviewsTotal: 124,
    reviewsPerDayAvg: 4.13,
    retention30d: 0.91,
    dueCards: 7,
    dueTopics: 3,
    newCards: 12,
    newExtracts: 9,
    deletions: 2,
    leeches: 1,
    retired: 0,
    dayStreak: 5,
  };
  const yearDays = (
    year: number,
    counts: Record<string, number> = {},
  ): AnalyticsReviewActivityResult["days"] => {
    const days: Array<{ date: string; count: number }> = [];
    const cursor = new Date(Date.UTC(year, 0, 1));
    while (cursor.getUTCFullYear() === year) {
      const date = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(
        2,
        "0",
      )}-${String(cursor.getUTCDate()).padStart(2, "0")}`;
      days.push({ date, count: counts[date] ?? 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  };
  const activityForYear = (
    year: number,
    overrides: Partial<AnalyticsReviewActivityResult> & { counts?: Record<string, number> } = {},
  ): AnalyticsReviewActivityResult => {
    const days = overrides.days ?? yearDays(year, overrides.counts);
    return {
      asOf: overrides.asOf ?? summary.asOf,
      year,
      minYear: overrides.minYear ?? 2025,
      maxYear: overrides.maxYear ?? 2026,
      previousYear: overrides.previousYear ?? 2025,
      nextYear: overrides.nextYear ?? null,
      days,
      totalReviews: overrides.totalReviews ?? days.reduce((sum, day) => sum + day.count, 0),
    };
  };
  const deferredActivity = (): {
    promise: Promise<AnalyticsReviewActivityResult>;
    resolve: (value: AnalyticsReviewActivityResult) => void;
    reject: (reason: Error) => void;
  } => {
    let resolve!: (value: AnalyticsReviewActivityResult) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<AnalyticsReviewActivityResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  return {
    summary,
    activityForYear,
    deferredActivity,
    getAnalytics: vi.fn(),
    getReviewActivity: vi.fn(),
    getSourceYield: vi.fn(),
    getExtractStagnation: vi.fn(),
    navigateSpy: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      getAnalytics: h.getAnalytics,
      getReviewActivity: h.getReviewActivity,
      getSourceYield: h.getSourceYield,
      getExtractStagnation: h.getExtractStagnation,
    },
  };
});

import { AnalyticsScreen } from "./AnalyticsScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.getAnalytics.mockResolvedValue(h.summary);
  h.getReviewActivity.mockResolvedValue(
    h.activityForYear(2026, {
      counts: {
        "2026-01-02": 1,
        "2026-01-03": 4,
        "2026-01-04": 8,
      },
    }),
  );
  // The screen also reads the low-yield-source count (T083) for its banner.
  h.getSourceYield.mockResolvedValue({ asOf: h.summary.asOf, rows: [], lowYieldCount: 0 });
  // …and the stagnant-extract count (T084) for its banner.
  h.getExtractStagnation.mockResolvedValue({ asOf: h.summary.asOf, rows: [], stagnantCount: 0 });
});

describe("AnalyticsScreen", () => {
  it("renders the metric tiles + the spark from the mocked snapshot", async () => {
    render(<AnalyticsScreen />);
    expect(await screen.findByTestId("analytics-body")).toBeTruthy();

    expect(screen.getByTestId("metric-retention").textContent).toContain("91");
    expect(screen.getByTestId("metric-reviews").textContent).toContain("124");
    expect(screen.getByTestId("metric-due").textContent).toContain("7");
    expect(screen.getByTestId("metric-leeches").textContent).toContain("1");
    expect(screen.getByTestId("metric-deletions").textContent).toContain("2");

    // The spark renders one bar per window day.
    const spark = screen.getByTestId("analytics-spark");
    expect(spark.querySelectorAll(".an-spark__bar").length).toBe(30);
  });

  it("renders the review activity panel before the reviews-per-day spark", async () => {
    render(<AnalyticsScreen />);
    const panel = await screen.findByTestId("review-activity-panel");
    const spark = await screen.findByTestId("analytics-spark");

    expect(panel.compareDocumentPosition(spark) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders one review activity cell per returned day with count intensity classes", async () => {
    render(<AnalyticsScreen />);
    await screen.findByTestId("review-activity-grid");

    const cells = screen.getAllByTestId("review-activity-cell");
    expect(cells.length).toBe(365);
    expect(
      cells.find((cell) => cell.getAttribute("data-date") === "2026-01-01")?.className,
    ).toContain("an-heatmap__cell--i0");
    expect(
      cells.find((cell) => cell.getAttribute("data-date") === "2026-01-02")?.className,
    ).toContain("an-heatmap__cell--i1");
    expect(
      cells.find((cell) => cell.getAttribute("data-date") === "2026-01-03")?.className,
    ).toContain("an-heatmap__cell--i3");
    expect(
      cells.find((cell) => cell.getAttribute("data-date") === "2026-01-04")?.className,
    ).toContain("an-heatmap__cell--i4");
    expect(screen.getByTitle("January 4, 2026: 8 reviews")).toBeTruthy();
  });

  it("disables year arrows from explicit previousYear and nextYear targets", async () => {
    h.getReviewActivity.mockResolvedValue(
      h.activityForYear(2026, { previousYear: 2024, nextYear: null, minYear: 2024, maxYear: 2026 }),
    );
    render(<AnalyticsScreen />);

    const previous = (await screen.findByLabelText(
      "Show 2024 review activity",
    )) as HTMLButtonElement;
    const next = screen.getByLabelText("No later review activity") as HTMLButtonElement;
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(true);
  });

  it("refetches review activity when an enabled year arrow is clicked", async () => {
    h.getReviewActivity.mockImplementation(async (request?: { year?: number }) => {
      const year = request?.year ?? 2026;
      return h.activityForYear(year, {
        previousYear: year === 2026 ? 2024 : null,
        nextYear: year === 2024 ? 2026 : null,
        minYear: 2024,
        maxYear: 2026,
      });
    });
    render(<AnalyticsScreen />);

    fireEvent.click(await screen.findByLabelText("Show 2024 review activity"));

    await waitFor(() => expect(h.getReviewActivity).toHaveBeenLastCalledWith({ year: 2024 }));
    expect(await screen.findByText("2024 · 0 reviews")).toBeTruthy();
  });

  it("refetches review activity when an enabled next-year arrow is clicked", async () => {
    h.getReviewActivity.mockImplementation(async (request?: { year?: number }) => {
      const year = request?.year ?? 2024;
      return h.activityForYear(year, {
        previousYear: year === 2026 ? 2024 : null,
        nextYear: year === 2024 ? 2026 : null,
        minYear: 2024,
        maxYear: 2026,
        counts: year === 2026 ? { "2026-02-01": 2 } : {},
      });
    });
    render(<AnalyticsScreen />);

    fireEvent.click(await screen.findByLabelText("Show 2026 review activity"));

    await waitFor(() => expect(h.getReviewActivity).toHaveBeenLastCalledWith({ year: 2026 }));
    expect(await screen.findByText("2026 · 2 reviews")).toBeTruthy();
  });

  it("ignores stale review activity responses that resolve out of order", async () => {
    const initial = h.deferredActivity();
    const previous = h.deferredActivity();
    h.getReviewActivity
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(previous.promise)
      .mockResolvedValueOnce(
        h.activityForYear(2026, {
          previousYear: 2025,
          nextYear: null,
          minYear: 2024,
          maxYear: 2026,
          counts: { "2026-02-01": 2 },
        }),
      );
    render(<AnalyticsScreen />);

    initial.resolve(
      h.activityForYear(2025, {
        previousYear: 2024,
        nextYear: 2026,
        minYear: 2024,
        maxYear: 2026,
      }),
    );
    fireEvent.click(await screen.findByLabelText("Show 2024 review activity"));
    fireEvent.click(await screen.findByLabelText("Show 2026 review activity"));

    previous.resolve(
      h.activityForYear(2024, {
        previousYear: null,
        nextYear: 2026,
        minYear: 2024,
        maxYear: 2026,
        counts: { "2024-01-10": 9 },
      }),
    );

    await waitFor(() => expect(h.getReviewActivity).toHaveBeenLastCalledWith({ year: 2026 }));
    expect(await screen.findByText("2026 · 2 reviews")).toBeTruthy();
    expect(screen.queryByText("2024 · 9 reviews")).toBeNull();
  });

  it("clears stale review activity when a year reload fails", async () => {
    h.getReviewActivity
      .mockResolvedValueOnce(
        h.activityForYear(2026, {
          previousYear: 2024,
          nextYear: null,
          minYear: 2024,
          maxYear: 2026,
          counts: { "2026-02-01": 2 },
        }),
      )
      .mockRejectedValueOnce(new Error("year read failed"));
    render(<AnalyticsScreen />);

    fireEvent.click(await screen.findByLabelText("Show 2024 review activity"));

    expect(await screen.findByTestId("review-activity-error")).toHaveTextContent(
      "year read failed",
    );
    expect(screen.queryByTestId("review-activity-grid")).toBeNull();
    expect(screen.queryByText("2026 · 2 reviews")).toBeNull();
  });

  it("renders empty review activity intentionally", async () => {
    h.getReviewActivity.mockResolvedValue(
      h.activityForYear(2026, { previousYear: null, nextYear: null, minYear: null, maxYear: null }),
    );
    render(<AnalyticsScreen />);

    expect(await screen.findByTestId("review-activity-empty")).toHaveTextContent(
      "No reviews recorded in 2026.",
    );
    expect(screen.getAllByTestId("review-activity-cell").length).toBe(365);
  });

  it("keeps existing metrics visible when review activity loading fails", async () => {
    h.getReviewActivity.mockRejectedValue(new Error("activity read failed"));
    render(<AnalyticsScreen />);

    expect(await screen.findByTestId("analytics-body")).toBeTruthy();
    expect(screen.getByTestId("metric-reviews").textContent).toContain("124");
    expect(await screen.findByTestId("review-activity-error")).toHaveTextContent(
      "activity read failed",
    );
    expect(screen.queryByTestId("analytics-error")).toBeNull();
  });

  it("links the leech banner to /maintenance/leeches and the deletions banner to /trash", async () => {
    render(<AnalyticsScreen />);
    await screen.findByTestId("analytics-body");

    fireEvent.click(screen.getByTestId("banner-leeches"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/maintenance/leeches" });

    fireEvent.click(screen.getByTestId("banner-deletions"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/trash" });
  });

  it("links the low-yield-sources banner to /analytics/sources when there are low-yield sources", async () => {
    h.getSourceYield.mockResolvedValue({ asOf: h.summary.asOf, rows: [], lowYieldCount: 3 });
    render(<AnalyticsScreen />);
    await screen.findByTestId("analytics-body");

    const banner = await screen.findByTestId("banner-source-yield");
    expect(banner.textContent).toContain("3 low-yield sources");
    fireEvent.click(banner);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/analytics/sources" });
  });

  it("links the stagnant-extracts banner to /maintenance/stagnant when there are stagnant extracts", async () => {
    h.getExtractStagnation.mockResolvedValue({
      asOf: h.summary.asOf,
      rows: [],
      stagnantCount: 2,
    });
    render(<AnalyticsScreen />);
    await screen.findByTestId("analytics-body");

    const banner = await screen.findByTestId("banner-stagnant");
    expect(banner.textContent).toContain("2 stagnant extracts");
    fireEvent.click(banner);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/maintenance/stagnant" });
  });

  it("shows the healthy state and hides the banners when there are no leeches/deletions", async () => {
    h.getAnalytics.mockResolvedValue({ ...h.summary, leeches: 0, deletions: 0 });
    render(<AnalyticsScreen />);
    await screen.findByTestId("analytics-body");
    expect(screen.getByTestId("banner-healthy")).toBeTruthy();
    expect(screen.queryByTestId("banner-leeches")).toBeNull();
    expect(screen.queryByTestId("banner-deletions")).toBeNull();
  });

  it("renders the empty-retention dash when there are no reviews", async () => {
    h.getAnalytics.mockResolvedValue({
      ...h.summary,
      retention30d: null,
      reviewsTotal: 0,
    });
    render(<AnalyticsScreen />);
    await screen.findByTestId("analytics-body");
    expect(screen.getByTestId("metric-retention").textContent).toContain("—");
  });
});
