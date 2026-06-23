import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueueQuotaComposition, QueueTimeEstimate } from "../../lib/appApi";
import { SessionGauge } from "./SessionGauge";

const estimate = (over: Partial<QueueTimeEstimate> = {}): QueueTimeEstimate => ({
  confidence: "learned",
  totalMinutes: 18,
  pricedItemCount: 3,
  items: [],
  ...over,
});

describe("SessionGauge", () => {
  it("shows elapsed-vs-reference and the backend-priced remaining minutes", () => {
    // startedAt 12 minutes ago, reference box of 30.
    const startedAt = Date.now() - 12 * 60_000;
    render(
      <SessionGauge
        startedAt={startedAt}
        estimate={estimate()}
        reference={30}
        composition={null}
      />,
    );
    const gauge = screen.getByTestId("process-gauge");
    expect(gauge).toHaveTextContent("12 / 30 min");
    expect(gauge).toHaveTextContent("18 min left");
  });

  it("prefixes remaining with ~ when the estimate is default-confidence", () => {
    render(
      <SessionGauge
        startedAt={Date.now()}
        estimate={estimate({ confidence: "default" })}
        reference={25}
        composition={null}
      />,
    );
    expect(screen.getByTestId("process-gauge")).toHaveTextContent("~18 min left");
  });

  it("renders an over-reference overrun without negative numbers", () => {
    const startedAt = Date.now() - 33 * 60_000; // 3 min past a 30-min reference
    render(
      <SessionGauge
        startedAt={startedAt}
        estimate={estimate()}
        reference={30}
        composition={null}
      />,
    );
    expect(screen.getByTestId("process-gauge")).toHaveTextContent("+3 over");
  });

  it("degrades to an unavailable readout (not a false 'done') when nothing is priced", () => {
    render(
      <SessionGauge
        startedAt={Date.now()}
        estimate={estimate({ pricedItemCount: 0, totalMinutes: 0 })}
        reference={30}
        composition={null}
      />,
    );
    const gauge = screen.getByTestId("process-gauge");
    expect(gauge).toHaveTextContent("—");
    expect(gauge).not.toHaveTextContent("0 min left");
  });

  it("keeps the distillation share visible when the day composition has due distillation", () => {
    const composition: QueueQuotaComposition = {
      status: "active",
      quotaFloorMinutes: 6,
      eligibleDistillationMinutes: 6,
      selectedDistillationMinutes: 6,
      returnedQuotaMinutes: 0,
      cardMinutes: 10,
      distillationMinutes: 6,
      otherMinutes: 2,
    };
    render(
      <SessionGauge
        startedAt={Date.now()}
        estimate={estimate()}
        reference={30}
        composition={composition}
      />,
    );
    expect(screen.getByTestId("process-gauge-distill")).toHaveTextContent("6 distill");
  });

  it("drops the remaining framing once the deck is done", () => {
    render(
      <SessionGauge
        startedAt={Date.now()}
        estimate={estimate()}
        reference={30}
        composition={null}
        done
      />,
    );
    const gauge = screen.getByTestId("process-gauge");
    expect(gauge).toHaveTextContent("queue clear");
    expect(gauge).not.toHaveTextContent("18 min left");
  });
});
