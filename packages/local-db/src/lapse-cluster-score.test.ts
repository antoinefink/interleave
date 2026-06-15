import { describe, expect, it } from "vitest";
import { scoreLapseCluster } from "./lapse-cluster-score";

describe("scoreLapseCluster", () => {
  it("is strictly monotonic in total lapse count (cards fixed)", () => {
    const a = scoreLapseCluster({ totalWindowLapses: 4, affectedCardCount: 2 });
    const b = scoreLapseCluster({ totalWindowLapses: 6, affectedCardCount: 2 });
    expect(b).toBeGreaterThan(a);
  });

  it("is strictly monotonic in affected-card count (lapses fixed)", () => {
    const a = scoreLapseCluster({ totalWindowLapses: 5, affectedCardCount: 2 });
    const b = scoreLapseCluster({ totalWindowLapses: 5, affectedCardCount: 4 });
    expect(b).toBeGreaterThan(a);
  });

  it("ranks breadth over depth at equal total lapses (5 cards x 1 > 1 card x 5)", () => {
    const breadth = scoreLapseCluster({ totalWindowLapses: 5, affectedCardCount: 5 });
    const depth = scoreLapseCluster({ totalWindowLapses: 5, affectedCardCount: 1 });
    expect(breadth).toBeGreaterThan(depth);
  });

  it("is finite and non-negative for degenerate / non-finite inputs", () => {
    expect(scoreLapseCluster({ totalWindowLapses: 0, affectedCardCount: 0 })).toBe(0);
    expect(
      scoreLapseCluster({ totalWindowLapses: Number.NaN, affectedCardCount: Number.NaN }),
    ).toBe(0);
    expect(
      scoreLapseCluster({
        totalWindowLapses: Number.POSITIVE_INFINITY,
        affectedCardCount: -3,
      }),
    ).toBe(0);
  });

  it("is deterministic for identical input", () => {
    const input = { totalWindowLapses: 7, affectedCardCount: 3 };
    expect(scoreLapseCluster(input)).toBe(scoreLapseCluster(input));
  });
});
