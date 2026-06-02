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

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsGetResult } from "../lib/appApi";

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
  return { summary, getAnalytics: vi.fn(), getSourceYield: vi.fn(), navigateSpy: vi.fn() };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { getAnalytics: h.getAnalytics, getSourceYield: h.getSourceYield },
  };
});

import { AnalyticsScreen } from "./AnalyticsScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.getAnalytics.mockResolvedValue(h.summary);
  // The screen also reads the low-yield-source count (T083) for its banner.
  h.getSourceYield.mockResolvedValue({ asOf: h.summary.asOf, rows: [], lowYieldCount: 0 });
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
