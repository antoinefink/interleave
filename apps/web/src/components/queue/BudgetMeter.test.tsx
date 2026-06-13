import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BudgetMeter } from "./BudgetMeter";

describe("BudgetMeter", () => {
  it("renders within-budget usage without an over-budget segment", () => {
    const { container, getByText, queryByTestId } = render(<BudgetMeter used={4} target={10} />);

    expect(getByText("/ 10 min today")).toBeInTheDocument();
    expect(queryByTestId("budget-over")).not.toBeInTheDocument();
    expect(container.querySelector(".budget__used")).toHaveStyle({ width: "40%" });
    expect(container.querySelector(".budget__over")).not.toBeInTheDocument();
  });

  it("splits usage between within-budget and over-budget segments", () => {
    const { container, getByTestId, getByText } = render(<BudgetMeter used={12} target={10} />);

    expect(getByTestId("budget-over")).toHaveTextContent("2 min over budget");
    expect(getByText("Over budget")).toBeInTheDocument();
    expect(container.querySelector(".budget__used")).toHaveStyle({ width: `${(10 / 12) * 100}%` });
    expect(container.querySelector(".budget__over")).toHaveStyle({ width: `${(2 / 12) * 100}%` });
  });

  it("handles a zero target without invalid widths", () => {
    const { container } = render(<BudgetMeter used={0} target={0} />);

    expect(container.querySelector(".budget__used")).toHaveStyle({ width: "0%" });
    expect(container.querySelector(".budget__over")).not.toBeInTheDocument();
  });

  it("renders active distillation composition and split chips", () => {
    const { getByTestId, getByText } = render(
      <BudgetMeter
        used={18}
        target={20}
        composition={{
          status: "active",
          quotaFloorMinutes: 4,
          eligibleDistillationMinutes: 6,
          selectedDistillationMinutes: 6,
          returnedQuotaMinutes: 0,
          cardMinutes: 10,
          distillationMinutes: 6,
          otherMinutes: 2,
        }}
      />,
    );

    expect(getByTestId("budget-composition")).toHaveTextContent(
      "Distillation floor active: 4 min reserved.",
    );
    expect(getByText("Cards 10 min")).toBeInTheDocument();
    expect(getByText("Distillation 6 min")).toBeInTheDocument();
    expect(getByText("Other 2 min")).toBeInTheDocument();
    expect(getByTestId("budget-meter")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Distillation floor active"),
    );
  });

  it("renders returned quota copy", () => {
    const { getByTestId } = render(
      <BudgetMeter
        used={4}
        target={10}
        composition={{
          status: "returned_empty_backlog",
          quotaFloorMinutes: 2,
          eligibleDistillationMinutes: 0,
          selectedDistillationMinutes: 0,
          returnedQuotaMinutes: 2,
          cardMinutes: 4,
          distillationMinutes: 0,
          otherMinutes: 0,
        }}
      />,
    );

    expect(getByTestId("budget-composition")).toHaveTextContent(
      "Distillation share returned: no due extracts.",
    );
  });

  it("omits composition when estimates are unavailable", () => {
    const { queryByTestId } = render(
      <BudgetMeter
        used={4}
        target={10}
        composition={{
          status: "unavailable_no_time_estimate",
          quotaFloorMinutes: 0,
          eligibleDistillationMinutes: 0,
          selectedDistillationMinutes: 0,
          returnedQuotaMinutes: 0,
          cardMinutes: 0,
          distillationMinutes: 0,
          otherMinutes: 0,
        }}
      />,
    );

    expect(queryByTestId("budget-composition")).not.toBeInTheDocument();
  });
});
