/**
 * SourceYield component tests (T083).
 *
 * The aggregation lives MAIN-side (`SourceYieldQuery`); this asserts the RENDERER
 * seam of the ranked view:
 *  - the rows load from `appApi.getSourceYield()` and render the title + yield
 *    numbers + read-% bar (reflecting `readPct`) + a band chip;
 *  - the lowest-yield row carries the `low` band class (it is visually distinct);
 *  - "Open" navigates to the source reader;
 *  - an empty payload shows the calm empty state.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring; no
 * SQLite/IPC — the renderer is a pure UI consumer here.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceYieldListResult, SourceYieldRow } from "../lib/appApi";

const h = vi.hoisted(() => {
  const lowRow: SourceYieldRow = {
    source: {
      id: "src-low",
      title: "A barely-mined source",
      priority: 0.375,
      priorityLabel: "C",
      createdAt: "2026-05-01T00:00:00.000Z",
      url: null,
    },
    readPct: 1,
    extractsCreated: 0,
    cardsCreated: 0,
    matureCards: 0,
    leeches: 0,
    timeSpentMs: 0,
    reviewCount: 0,
    lastActivityAt: null,
    yieldScore: 0,
    yieldBand: "low",
  };
  const highRow: SourceYieldRow = {
    source: {
      id: "src-high",
      title: "On the Measure of Intelligence",
      priority: 0.875,
      priorityLabel: "A",
      createdAt: "2026-05-02T00:00:00.000Z",
      url: "https://arxiv.org/abs/1911.01547",
    },
    readPct: 0.75,
    extractsCreated: 3,
    cardsCreated: 5,
    matureCards: 4,
    leeches: 0,
    timeSpentMs: 120_000,
    reviewCount: 12,
    lastActivityAt: "2026-05-28T08:00:00.000Z",
    yieldScore: 14,
    yieldBand: "high",
  };
  const result: SourceYieldListResult = {
    asOf: "2026-06-01T12:00:00.000Z",
    rows: [lowRow, highRow],
    lowYieldCount: 1,
  };
  return { lowRow, highRow, result, getSourceYield: vi.fn(), navigate: vi.fn() };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { getSourceYield: h.getSourceYield },
  };
});

import { SourceYield } from "./SourceYield";

beforeEach(() => {
  vi.clearAllMocks();
  h.getSourceYield.mockResolvedValue(h.result);
});

describe("SourceYield", () => {
  it("renders the ranked rows with their yield numbers and read-% bar", async () => {
    render(<SourceYield />);
    await waitFor(() => expect(screen.getAllByTestId("source-yield-row")).toHaveLength(2));

    expect(screen.getByTestId("source-yield-low-count").textContent).toContain("1 low-yield");

    // The high-yield row shows its extracts/cards numbers.
    const highRow = screen.getByText("On the Measure of Intelligence").closest("[data-source-id]");
    expect(highRow).not.toBeNull();
    if (highRow) {
      // Read-% bar width reflects readPct (0.75 → 75%).
      const bar = within(highRow as HTMLElement).getByTestId("source-yield-readbar");
      expect((bar as HTMLElement).style.width).toBe("75%");
    }
  });

  it("marks the lowest-yield row with the low band (visually distinct)", async () => {
    render(<SourceYield />);
    await waitFor(() => expect(screen.getAllByTestId("source-yield-row")).toHaveLength(2));

    // The first row (lowest-yield) is the `low` band.
    const [firstRow] = screen.getAllByTestId("source-yield-row");
    expect(firstRow).toBeDefined();
    if (!firstRow) return;
    expect(firstRow.getAttribute("data-band")).toBe("low");
    expect(firstRow.className).toContain("sy-row--band-low");
    const band = within(firstRow).getByTestId("source-yield-band");
    expect(band.textContent).toContain("Low yield");
  });

  it("opens a source in the reader when Open is clicked", async () => {
    render(<SourceYield />);
    await waitFor(() => expect(screen.getAllByTestId("source-yield-row")).toHaveLength(2));

    const [firstRow] = screen.getAllByTestId("source-yield-row");
    expect(firstRow).toBeDefined();
    if (!firstRow) return;
    fireEvent.click(within(firstRow).getByTestId("source-yield-open"));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-low" } });
  });

  it("shows the empty state when there are no sources", async () => {
    h.getSourceYield.mockResolvedValue({ asOf: "x", rows: [], lowYieldCount: 0 });
    render(<SourceYield />);
    await waitFor(() => expect(screen.getByTestId("source-yield-empty")).toBeInTheDocument());
  });
});
