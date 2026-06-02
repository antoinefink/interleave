/**
 * WorkloadSimulator component tests (T081).
 *
 * The projection lives MAIN-side (`packages/scheduler` / `packages/local-db`); this
 * asserts the RENDERER seam only:
 *  - Preview calls `workload.simulate` with the selected lever + value and renders the
 *    peak / over-budget / delta summary + the before/after chart;
 *  - switching levers swaps the value control and builds the right `change` payload;
 *  - the preview never mutates (the component only calls `simulate`, never a setter);
 *  - an error surfaces.
 *
 * `appApi` is mocked so the test exercises only this component's wiring.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkloadSimulateResult } from "../lib/appApi";

const h = vi.hoisted(() => {
  const projection: WorkloadSimulateResult = {
    days: [
      { date: "2026-06-02", before: 10, after: 14 },
      { date: "2026-06-03", before: 8, after: 9 },
    ],
    overBudgetDaysBefore: 1,
    overBudgetDaysAfter: 3,
    peakBefore: 10,
    peakAfter: 14,
    deltaNext7: 12,
    deltaNext30: 30,
    budget: 9,
  };
  return { projection, simulateWorkload: vi.fn() };
});

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: { simulateWorkload: h.simulateWorkload },
  };
});

import { WorkloadSimulator } from "./WorkloadSimulator";

beforeEach(() => {
  vi.clearAllMocks();
  h.simulateWorkload.mockResolvedValue(h.projection);
});

describe("WorkloadSimulator (T081)", () => {
  it("Preview calls workload.simulate with the retention lever and renders the summary", async () => {
    render(<WorkloadSimulator />);
    fireEvent.click(screen.getByTestId("workload-preview"));
    await screen.findByTestId("workload-result");

    // The default lever is retention → global target at the slider's value (90%).
    expect(h.simulateWorkload).toHaveBeenCalledWith({
      change: { kind: "retention", scope: "global", target: 0.9 },
      windowDays: 30,
    });
    // Peak / over-budget / delta summary is rendered.
    expect(screen.getByTestId("workload-peak").textContent).toContain("10");
    expect(screen.getByTestId("workload-peak").textContent).toContain("14");
    expect(screen.getByTestId("workload-over-budget").textContent).toContain("1");
    expect(screen.getByTestId("workload-over-budget").textContent).toContain("3");
    expect(screen.getByTestId("workload-delta").textContent).toContain("+12");
    expect(screen.getByTestId("workload-delta").textContent).toContain("+30");
    expect(screen.getByTestId("workload-chart")).toBeTruthy();
  });

  it("the add-cards lever builds an addCards change with the entered count", async () => {
    render(<WorkloadSimulator />);
    fireEvent.click(screen.getByTestId("workload-lever-addCards"));
    fireEvent.change(screen.getByTestId("workload-add-count"), { target: { value: "42" } });
    fireEvent.click(screen.getByTestId("workload-preview"));
    await screen.findByTestId("workload-result");
    expect(h.simulateWorkload).toHaveBeenCalledWith({
      change: { kind: "addCards", count: 42, priority: 0.5, firstDueInDays: 0 },
      windowDays: 30,
    });
  });

  it("the postpone lever builds a postponeLowPriority change (mature toggle off by default)", async () => {
    render(<WorkloadSimulator />);
    fireEvent.click(screen.getByTestId("workload-lever-postponeLowPriority"));
    fireEvent.change(screen.getByTestId("workload-postpone-days"), { target: { value: "21" } });
    fireEvent.click(screen.getByTestId("workload-preview"));
    await screen.findByTestId("workload-result");
    expect(h.simulateWorkload).toHaveBeenCalledWith({
      change: { kind: "postponeLowPriority", band: "C", days: 21, includeMatureCards: false },
      windowDays: 30,
    });
  });

  it("the postpone lever can include low-priority mature cards", async () => {
    render(<WorkloadSimulator />);
    fireEvent.click(screen.getByTestId("workload-lever-postponeLowPriority"));
    fireEvent.click(screen.getByTestId("workload-include-mature"));
    fireEvent.click(screen.getByTestId("workload-preview"));
    await screen.findByTestId("workload-result");
    expect(h.simulateWorkload).toHaveBeenCalledWith({
      change: { kind: "postponeLowPriority", band: "C", days: 14, includeMatureCards: true },
      windowDays: 30,
    });
  });

  it("surfaces an error when the simulate fails", async () => {
    h.simulateWorkload.mockRejectedValue(new Error("boom"));
    render(<WorkloadSimulator />);
    fireEvent.click(screen.getByTestId("workload-preview"));
    const err = await screen.findByTestId("workload-error");
    expect(err.textContent).toContain("boom");
  });
});
