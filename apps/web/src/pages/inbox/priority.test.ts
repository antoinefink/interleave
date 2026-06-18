import { describe, expect, it } from "vitest";
import { PRIORITY_HINT, priorityToLabel } from "./priority";

describe("priorityToLabel", () => {
  it("maps numeric priority to A/B/C/D at the band thresholds", () => {
    expect(priorityToLabel(1)).toBe("A");
    expect(priorityToLabel(0.75)).toBe("A");
    expect(priorityToLabel(0.7499)).toBe("B");
    expect(priorityToLabel(0.5)).toBe("B");
    expect(priorityToLabel(0.4999)).toBe("C");
    expect(priorityToLabel(0.25)).toBe("C");
    expect(priorityToLabel(0.2499)).toBe("D");
    expect(priorityToLabel(0)).toBe("D");
  });

  it("clamps out-of-range values into [0, 1]", () => {
    expect(priorityToLabel(2)).toBe("A");
    expect(priorityToLabel(-1)).toBe("D");
  });
});

describe("PRIORITY_HINT", () => {
  it("has a cadence hint for every band", () => {
    expect(PRIORITY_HINT.A).toBeTruthy();
    expect(PRIORITY_HINT.B).toBeTruthy();
    expect(PRIORITY_HINT.C).toBe("Normal cadence");
    expect(PRIORITY_HINT.D).toBeTruthy();
  });
});
