import { describe, expect, it } from "vitest";
import { planSession, type SessionPlanCandidate } from "./session-plan";

function candidate(
  id: string,
  estimatedMinutes: number | null | undefined,
  extra: Partial<SessionPlanCandidate> = {},
): SessionPlanCandidate {
  return estimatedMinutes === undefined ? { id, ...extra } : { id, estimatedMinutes, ...extra };
}

describe("planSession", () => {
  it("fills candidates in score order and cuts the rows that do not fit", () => {
    const plan = planSession(
      [candidate("a", 10), candidate("b", 8), candidate("c", 6), candidate("d", 4)],
      { targetMinutes: 25 },
    );

    expect(plan.plannedItems.map((row) => row.item.id)).toEqual(["a", "b", "c"]);
    expect(plan.cutItems.map((row) => [row.item.id, row.reason, row.estimatedMinutes])).toEqual([
      ["d", "did_not_fit", 4],
    ]);
    expect(plan.plannedMinutes).toBe(24);
    expect(plan.cutMinutes).toBe(4);
    expect(plan.cutCount).toBe(1);
    expect(plan.overTarget).toBe(false);
  });

  it("includes one valid oversized first item for a positive target", () => {
    const plan = planSession(
      [candidate("protected-large", 10, { protected: true }), candidate("later", 2)],
      { targetMinutes: 5 },
    );

    expect(plan.plannedItems.map((row) => row.item.id)).toEqual(["protected-large"]);
    expect(plan.plannedMinutes).toBe(10);
    expect(plan.overTarget).toBe(true);
    expect(plan.cutItems.map((row) => row.item.id)).toEqual(["later"]);
  });

  it("treats zero target as an empty plan and cuts all candidates", () => {
    const plan = planSession([candidate("a", 1), candidate("b", 2)], { targetMinutes: 0 });

    expect(plan.plannedItems).toEqual([]);
    expect(plan.plannedMinutes).toBe(0);
    expect(plan.cutItems.map((row) => row.item.id)).toEqual(["a", "b"]);
    expect(plan.cutMinutes).toBe(3);
  });

  it("uses finite non-fitting fallback estimates for malformed item prices", () => {
    const plan = planSession(
      [
        candidate("valid", 2),
        candidate("missing", undefined),
        candidate("zero", 0),
        candidate("negative", -2),
        candidate("nan", Number.NaN),
      ],
      { targetMinutes: 5 },
    );

    expect(plan.usedFallbackEstimate).toBe(true);
    expect(plan.plannedItems.map((row) => row.item.id)).toEqual(["valid"]);
    expect(plan.cutItems.map((row) => row.item.id)).toEqual(["missing", "zero", "negative", "nan"]);
    expect(Number.isFinite(plan.plannedMinutes)).toBe(true);
    expect(Number.isFinite(plan.cutMinutes)).toBe(true);
    expect(plan.cutItems.every((row) => row.estimatedMinutes === 6)).toBe(true);
  });

  it("keeps omitted quota behavior identical to raw score-order filling", () => {
    const candidates = [candidate("first", 3), candidate("second", 3), candidate("third", 3)];

    const first = planSession(candidates, { targetMinutes: 6 });
    const second = planSession(candidates, { targetMinutes: 6 });

    expect(first).toEqual(second);
    expect(first.plannedItems.map((row) => row.item.id)).toEqual(["first", "second"]);
    expect(first.cutItems.map((row) => row.item.id)).toEqual(["third"]);
  });

  it("sanitizes non-finite and negative targets to zero so totals never become NaN", () => {
    for (const targetMinutes of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const plan = planSession([candidate("a", 1)], { targetMinutes });
      expect(plan.targetMinutes).toBe(0);
      expect(plan.plannedItems).toEqual([]);
      expect(plan.cutCount).toBe(1);
      expect(Number.isFinite(plan.cutMinutes)).toBe(true);
    }
  });
});
