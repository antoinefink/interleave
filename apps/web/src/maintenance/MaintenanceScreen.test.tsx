/**
 * MaintenanceScreen component tests (T099).
 *
 * The maintenance LOGIC lives main-side (`packages/local-db` + the main
 * `MaintenanceService`); this asserts the RENDERER seam of the janitor hub:
 *  - each report card renders from the mocked `maintenance.report` counts;
 *  - expanding a report lists its rows from the drill-down read;
 *  - a cleanup action prompts/calls the right command and shows the Undo snackbar;
 *  - the empty case shows the calm "Nothing to clean up" row;
 *  - the integrity card runs on demand (not auto-run on open).
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring; no
 * SQLite/IPC — the renderer is a pure UI consumer here.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  report: vi.fn(),
  duplicates: vi.fn(),
  cardsWithoutSources: vi.fn(),
  brokenSources: vi.fn(),
  lowValue: vi.fn(),
  integrity: vi.fn(),
  dedupe: vi.fn(),
  orphanMedia: vi.fn(),
  bulkTrash: vi.fn(),
  bulkArchive: vi.fn(),
  bulkPostpone: vi.fn(),
  parkedResurfacing: vi.fn(),
  parkedResurfacingApply: vi.fn(),
  chronicPostpones: vi.fn(),
  chronicPostponesApply: vi.fn(),
  undoLast: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      maintenance: {
        report: h.report,
        duplicates: h.duplicates,
        cardsWithoutSources: h.cardsWithoutSources,
        brokenSources: h.brokenSources,
        lowValue: h.lowValue,
        integrity: h.integrity,
        dedupe: h.dedupe,
        orphanMedia: h.orphanMedia,
        bulkTrash: h.bulkTrash,
        bulkArchive: h.bulkArchive,
        bulkPostpone: h.bulkPostpone,
        parkedResurfacing: h.parkedResurfacing,
        parkedResurfacingApply: h.parkedResurfacingApply,
        chronicPostpones: h.chronicPostpones,
        chronicPostponesApply: h.chronicPostponesApply,
      },
      undoLast: h.undoLast,
    },
  };
});

import { MaintenanceScreen } from "./MaintenanceScreen";

const FULL_REPORT = {
  duplicateCount: 2,
  cardsWithoutSourcesCount: 1,
  schedulerConsistencyCount: 0,
  parkedResurfacingCount: 1,
  chronicPostponeCount: 1,
  orphanFileCount: 3,
  orphanBytes: 4096,
  lowValueCount: 2,
  integrity: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.report.mockResolvedValue(FULL_REPORT);
  h.duplicates.mockResolvedValue({
    sourceClusters: [
      {
        key: "https://example.com/x",
        matchedBy: "canonicalUrl",
        canonical: { id: "keep", type: "source", title: "Keeper", priority: 0.5, createdAt: "" },
        duplicates: [
          { id: "dup1", type: "source", title: "Dupe one", priority: 0.5, createdAt: "" },
        ],
      },
    ],
    cardClusters: [],
    extractClusters: [],
    totalDuplicates: 1,
  });
  h.cardsWithoutSources.mockResolvedValue({
    rows: [
      {
        card: { id: "card1", type: "card", title: "Orphan card", priority: 0.5, createdAt: "" },
        hasSourceLocation: false,
        hasSourceAncestor: false,
        createdAt: "",
      },
    ],
  });
  h.brokenSources.mockResolvedValue({
    rows: [
      {
        source: { id: "src1", type: "source", title: "Broken src", priority: 0.5, createdAt: "" },
        reason: "missingFile",
        missingAssetIds: ["a1"],
      },
    ],
  });
  h.lowValue.mockResolvedValue({
    rows: [
      {
        element: {
          id: "lv1",
          type: "source",
          title: "Stale low",
          priority: 0.1,
          priorityLabel: "D",
          createdAt: "",
        },
        lastActivityAt: "2026-01-01T00:00:00.000Z",
        daysSinceActivity: 90,
      },
    ],
  });
  h.integrity.mockResolvedValue({
    db: { ok: true, integrityCheck: ["ok"], foreignKeyViolations: 0, mode: "quick_check" },
    vault: { ok: 5, mismatched: [], missing: [], extraFiles: [] },
  });
  h.dedupe.mockResolvedValue({ affected: 1, batchId: "b1" });
  h.orphanMedia.mockResolvedValue({ removed: 3, freedBytes: 4096, vectorsPruned: 0 });
  h.bulkTrash.mockResolvedValue({ affected: 1, batchId: "b2" });
  h.bulkArchive.mockResolvedValue({ affected: 2, batchId: "b3" });
  h.bulkPostpone.mockResolvedValue({ affected: 2, batchId: "b4" });
  h.parkedResurfacing.mockResolvedValue({
    rows: [
      {
        element: {
          id: "parked1",
          type: "source",
          title: "Saved article",
          priority: 0.5,
          priorityLabel: "B",
          createdAt: "",
        },
        parkedAt: "2026-03-01T00:00:00.000Z",
        ageDays: 102,
      },
    ],
    totalDue: 1,
    limit: 50,
    asOf: "2026-06-11T12:00:00.000Z",
  });
  h.parkedResurfacingApply.mockResolvedValue({ applied: 1, skipped: [], batchId: "b5" });
  h.chronicPostpones.mockResolvedValue({
    rows: [
      {
        element: {
          id: "chronic1",
          type: "source",
          title: "Always later",
          priority: 0.5,
          priorityLabel: "B",
          status: "scheduled",
          dueAt: "2026-08-01T00:00:00.000Z",
          createdAt: "",
        },
        scheduler: "attention",
        postponeCount: 6,
      },
    ],
    totalDue: 1,
    threshold: 5,
    limit: 50,
  });
  h.chronicPostponesApply.mockResolvedValue({ applied: 1, skipped: [], batchId: "b6" });
  h.undoLast.mockResolvedValue({
    undone: true,
    count: 1,
    label: "Restored",
    opType: null,
    elementId: null,
  });
});

describe("MaintenanceScreen", () => {
  it("renders each report card from the report counts", async () => {
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    expect(screen.getByTestId("metric-duplicates-value").textContent).toContain("2");
    expect(screen.getByTestId("metric-orphan-value").textContent).toContain("3");
    expect(screen.getByTestId("metric-sourceless-value").textContent).toContain("1");
    expect(screen.getByTestId("metric-lowvalue-value").textContent).toContain("2");
    expect(screen.getByTestId("metric-parked-value").textContent).toContain("1");
    expect(screen.getByTestId("metric-chronic-value").textContent).toContain("1");
    expect(screen.getByTestId("metric-parked-toggle")).toHaveAttribute("aria-expanded", "false");
    // Integrity is NOT auto-run — the Run check button is shown, no status yet.
    expect(screen.getByTestId("integrity-run")).toBeInTheDocument();
    expect(h.integrity).not.toHaveBeenCalled();
  });

  it("expands a report and lists its drill-down rows", async () => {
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-duplicates-toggle"));
    await waitFor(() => expect(screen.getByTestId("duplicates-panel")).toBeInTheDocument());
    expect(screen.getByTestId("duplicate-row")).toHaveAttribute("data-element-id", "dup1");
    expect(screen.getByTestId("cluster-keeper").textContent).toContain("Keeper");
  });

  it("runs dedup cleanup and shows the Undo snackbar", async () => {
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-duplicates-toggle"));
    await waitFor(() => expect(screen.getByTestId("dedupe-all")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("dedupe-all"));
    await waitFor(() => expect(h.dedupe).toHaveBeenCalledWith({ removeIds: ["dup1"] }));
    await waitFor(() =>
      expect(screen.getByTestId("maintenance-snackbar-undo")).toBeInTheDocument(),
    );
    // The Undo button drives the shared command-level undo.
    fireEvent.click(screen.getByTestId("maintenance-snackbar-undo"));
    await waitFor(() => expect(h.undoLast).toHaveBeenCalled());
  });

  it("applies parked resurfacing decisions and shows the Undo snackbar", async () => {
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-parked-toggle"));
    expect(screen.getByTestId("metric-parked-toggle")).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(screen.getByTestId("parked-panel")).toBeInTheDocument());
    expect(screen.getByTestId("parked-decision-keep")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("parked-decision-queue"));
    expect(screen.getByTestId("parked-decision-keep")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("parked-decision-queue")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("parked-apply"));

    await waitFor(() =>
      expect(h.parkedResurfacingApply).toHaveBeenCalledWith({
        decisions: [{ id: "parked1", kind: "queueNow" }],
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("maintenance-snackbar-undo")).toBeInTheDocument(),
    );
  });

  it("keeps parked virtualized rows exposed as a semantic list", async () => {
    h.parkedResurfacing.mockResolvedValueOnce({
      rows: Array.from({ length: 82 }, (_, index) => ({
        element: {
          id: `parked-${index}`,
          type: "source",
          title: `Saved article ${index}`,
          priority: 0.5,
          priorityLabel: "B",
          createdAt: "",
        },
        parkedAt: "2026-03-01T00:00:00.000Z",
        ageDays: 102,
      })),
      totalDue: 82,
      limit: 50,
      asOf: "2026-06-11T12:00:00.000Z",
    });
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-parked-toggle"));

    await waitFor(() => expect(screen.getByRole("list")).toBeInTheDocument());
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });

  it("shows skipped parked resurfacing decisions when stale rows are skipped", async () => {
    h.parkedResurfacingApply.mockResolvedValueOnce({
      applied: 1,
      skipped: [{ id: "parked-stale", reason: "not-due" }],
      batchId: "b5",
    });
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-parked-toggle"));
    await waitFor(() => expect(screen.getByTestId("parked-panel")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("parked-decision-queue"));
    fireEvent.click(screen.getByTestId("parked-apply"));

    await waitFor(() => expect(screen.getByTestId("maintenance-snackbar")).toBeInTheDocument());
    expect(screen.getByTestId("maintenance-snackbar").textContent).toContain("1 skipped");
  });

  it("applies only explicitly selected chronic-postpone decisions", async () => {
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-chronic-toggle"));
    await waitFor(() => expect(screen.getByTestId("chronic-panel")).toBeInTheDocument());

    expect(screen.getByTestId("chronic-apply")).toBeDisabled();
    expect(screen.getByTestId("chronic-decision-keep")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("chronic-decision-demote"));
    expect(screen.getByTestId("chronic-decision-demote")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("chronic-apply"));

    await waitFor(() =>
      expect(h.chronicPostponesApply).toHaveBeenCalledWith({
        decisions: [{ id: "chronic1", kind: "demote" }],
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("maintenance-snackbar-undo")).toBeInTheDocument(),
    );
  });

  it("shows chronic skipped reasons and keeps Undo only for applied mutations", async () => {
    h.chronicPostponesApply.mockResolvedValueOnce({
      applied: 1,
      skipped: [{ id: "chronic-stale", reason: "below-threshold" }],
      batchId: "b6",
    });
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-chronic-toggle"));
    await waitFor(() => expect(screen.getByTestId("chronic-panel")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("chronic-decision-demote"));
    fireEvent.click(screen.getByTestId("chronic-apply"));

    await waitFor(() => expect(screen.getByTestId("maintenance-snackbar")).toBeInTheDocument());
    expect(screen.getByTestId("maintenance-snackbar").textContent).toContain(
      "1 skipped: below threshold",
    );
    expect(screen.getByTestId("maintenance-snackbar-undo")).toBeInTheDocument();
  });

  it("does not offer Undo when chronic apply only skips stale rows", async () => {
    h.chronicPostponesApply.mockResolvedValueOnce({
      applied: 0,
      skipped: [{ id: "chronic-stale", reason: "retired-card" }],
      batchId: null,
    });
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-chronic-toggle"));
    await waitFor(() => expect(screen.getByTestId("chronic-panel")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("chronic-decision-keep"));
    fireEvent.click(screen.getByTestId("chronic-apply"));

    await waitFor(() => expect(screen.getByTestId("maintenance-snackbar")).toBeInTheDocument());
    expect(screen.getByTestId("maintenance-snackbar").textContent).toContain(
      "1 skipped: retired card",
    );
    expect(screen.queryByTestId("maintenance-snackbar-undo")).not.toBeInTheDocument();
  });

  it("orphan-media cleanup is confirm-gated, then composes the GC", async () => {
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-orphan-toggle"));
    await waitFor(() => expect(screen.getByTestId("orphan-collect")).toBeInTheDocument());
    // First click asks to confirm; only the confirm actually runs the GC.
    fireEvent.click(screen.getByTestId("orphan-collect"));
    await waitFor(() => expect(screen.getByTestId("orphan-confirm")).toBeInTheDocument());
    expect(h.orphanMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("orphan-confirm-yes"));
    await waitFor(() => expect(h.orphanMedia).toHaveBeenCalledWith({ confirm: true }));
  });

  it("the integrity card runs on demand", async () => {
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("integrity-run")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("integrity-run"));
    await waitFor(() => expect(h.integrity).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("integrity-status").textContent).toBe("OK"));
  });

  it("shows the empty drill-down row when a report has nothing", async () => {
    h.cardsWithoutSources.mockResolvedValue({ rows: [] });
    render(<MaintenanceScreen />);
    await waitFor(() => expect(screen.getByTestId("maintenance-grid")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("metric-sourceless-toggle"));
    await waitFor(() => expect(screen.getByTestId("maintenance-empty-row")).toBeInTheDocument());
  });
});
