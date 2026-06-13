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

  it("reserves a configurable floor for due extract distillation before card fill", () => {
    const plan = planSession(
      [
        candidate("card-a", 10, { type: "card", stage: "active_card" }),
        candidate("card-b", 10, { type: "card", stage: "active_card" }),
        candidate("atomic", 4, { type: "extract", stage: "atomic_statement" }),
        candidate("card-c", 5, { type: "card", stage: "active_card" }),
      ],
      { targetMinutes: 20, distillationQuotaPercent: 15 },
    );

    expect(plan.plannedItems.map((row) => row.item.id)).toEqual(["atomic", "card-a"]);
    expect(plan.cutItems.map((row) => row.item.id)).toEqual(["card-b", "card-c"]);
    expect(plan.composition).toMatchObject({
      status: "active",
      quotaFloorMinutes: 3,
      eligibleDistillationMinutes: 4,
      selectedDistillationMinutes: 4,
      distillationMinutes: 4,
      cardMinutes: 10,
    });
  });

  it("returns the floor to normal queue work when there is no due extract backlog", () => {
    const plan = planSession(
      [
        candidate("card-a", 10, { type: "card", stage: "active_card" }),
        candidate("card-b", 10, { type: "card", stage: "active_card" }),
      ],
      { targetMinutes: 20, distillationQuotaPercent: 25 },
    );

    expect(plan.plannedItems.map((row) => row.item.id)).toEqual(["card-a", "card-b"]);
    expect(plan.composition).toMatchObject({
      status: "returned_empty_backlog",
      quotaFloorMinutes: 5,
      returnedQuotaMinutes: 5,
      distillationMinutes: 0,
      cardMinutes: 20,
    });
  });

  it("reports the quota as inactive when the caller filtered extract work out", () => {
    const plan = planSession(
      [
        candidate("card-a", 10, { type: "card", stage: "active_card" }),
        candidate("card-b", 10, { type: "card", stage: "active_card" }),
      ],
      { targetMinutes: 20, distillationQuotaPercent: 25, distillationQuotaApplies: false },
    );

    expect(plan.plannedItems.map((row) => row.item.id)).toEqual(["card-a", "card-b"]);
    expect(plan.composition.status).toBe("inactive_filtered_out");
    expect(plan.composition.quotaFloorMinutes).toBe(5);
  });

  it("includes an oversized extract as the quota reservation for a positive target", () => {
    const plan = planSession(
      [
        candidate("card-a", 2, { type: "card", stage: "active_card" }),
        candidate("extract-large", 6, { type: "extract", stage: "clean_extract" }),
      ],
      { targetMinutes: 5, distillationQuotaPercent: 15 },
    );

    expect(plan.plannedItems.map((row) => row.item.id)).toEqual(["extract-large"]);
    expect(plan.plannedMinutes).toBe(6);
    expect(plan.overTarget).toBe(true);
    expect(plan.composition.distillationMinutes).toBe(6);
  });

  it("counts quota overshoot against the residual fill capacity", () => {
    const plan = planSession(
      [
        candidate("card-a", 10, { type: "card", stage: "active_card" }),
        candidate("extract", 6, { type: "extract", stage: "clean_extract" }),
        candidate("card-b", 9, { type: "card", stage: "active_card" }),
        candidate("card-c", 1, { type: "card", stage: "active_card" }),
      ],
      { targetMinutes: 25, distillationQuotaPercent: 15 },
    );

    expect(plan.composition.quotaFloorMinutes).toBe(4);
    expect(plan.plannedItems.map((row) => row.item.id)).toEqual(["extract", "card-a", "card-b"]);
    expect(plan.plannedMinutes).toBe(25);
    expect(plan.overTarget).toBe(false);
    expect(plan.cutItems.map((row) => row.item.id)).toEqual(["card-c"]);
  });

  it("does not count non-extract rows with extract stage strings as distillation quota work", () => {
    const plan = planSession(
      [
        candidate("task", 5, { type: "task", stage: "atomic_statement" }),
        candidate("source", 5, { type: "source", stage: "clean_extract" }),
        candidate("card", 5, { type: "card", stage: "raw_extract" }),
      ],
      { targetMinutes: 10, distillationQuotaPercent: 50 },
    );

    expect(plan.composition.status).toBe("returned_empty_backlog");
    expect(plan.composition.distillationMinutes).toBe(0);
    expect(plan.composition.otherMinutes).toBe(10);
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
