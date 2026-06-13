/**
 * Auto-postpone planner tests (T077 — the deterministic overload valve).
 *
 * These pin the doc's exact victim policy ("Overload handling → Auto-postpone"):
 *  - low-priority attention items (topics/sources/extracts) recede FIRST;
 *  - then low-priority *mature* cards;
 *  - a high-priority *fragile* card is NEVER sacrificed, nor a leech, nor a
 *    `protected` (band-A / pinned) item;
 *  - the plan stops exactly when the remaining due count is within budget;
 *  - the fragile↔mature cutline honors the documented thresholds;
 *  - the plan is fully deterministic (same input → same plan, no randomness).
 */

import { describe, expect, it } from "vitest";
import {
  type AutoPostponeInput,
  CARD_MATURE_RETRIEVABILITY,
  CARD_MATURE_STABILITY_DAYS,
  isCardFragile,
  isCardMature,
  LEECH_LAPSE_THRESHOLD,
  planAutoPostpone,
} from "./index";

const NOW = "2027-06-01T12:00:00.000Z";

/** Build an attention (topic/source/extract) row. */
function attention(
  id: string,
  priority: number,
  type = "topic",
  dueAt: string | null = "2027-05-01T12:00:00.000Z",
  estimatedMinutes = 1,
  stage: string | null = null,
): AutoPostponeInput {
  return {
    id,
    type,
    stage,
    priority,
    dueAt,
    scheduler: "attention",
    schedulerSignals: {
      retrievability: null,
      stability: null,
      fsrsState: null,
      lapses: null,
    },
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    protected: priority >= 0.75,
    estimatedMinutes,
  };
}

/** Build a card row with explicit FSRS signals. */
function card(
  id: string,
  priority: number,
  signals: {
    retrievability: number | null;
    stability: number | null;
    fsrsState: string | null;
    lapses: number | null;
  },
  dueAt: string | null = "2027-05-01T12:00:00.000Z",
  estimatedMinutes = 1,
): AutoPostponeInput {
  return {
    id,
    type: "card",
    priority,
    dueAt,
    scheduler: "fsrs",
    schedulerSignals: signals,
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    protected: priority >= 0.75,
    estimatedMinutes,
  };
}

/** A durable mature card (review phase, high stability, retrievable). */
const matureSignals = {
  retrievability: 0.95,
  stability: CARD_MATURE_STABILITY_DAYS + 30,
  fsrsState: "review" as const,
  lapses: 0,
};
/** A fragile card (learning phase / low stability). */
const fragileSignals = {
  retrievability: 0.4,
  stability: 2,
  fsrsState: "learning" as const,
  lapses: 0,
};

describe("isCardMature / isCardFragile", () => {
  it("a review-phase, high-stability, retrievable card is MATURE", () => {
    expect(isCardMature(matureSignals)).toBe(true);
    expect(isCardFragile(matureSignals)).toBe(false);
  });

  it("a learning-phase card is FRAGILE regardless of stability", () => {
    expect(isCardMature({ ...matureSignals, fsrsState: "learning" })).toBe(false);
    expect(isCardFragile({ ...matureSignals, fsrsState: "learning" })).toBe(true);
  });

  it("a review-phase card below the stability cutline is FRAGILE", () => {
    expect(isCardMature({ ...matureSignals, stability: CARD_MATURE_STABILITY_DAYS - 1 })).toBe(
      false,
    );
  });

  it("a review-phase, high-stability card whose retrievability has decayed is FRAGILE", () => {
    expect(
      isCardMature({ ...matureSignals, retrievability: CARD_MATURE_RETRIEVABILITY - 0.05 }),
    ).toBe(false);
  });

  it("a mature card with unknown retrievability is still MATURE (stability carries it)", () => {
    expect(isCardMature({ ...matureSignals, retrievability: null })).toBe(true);
  });
});

describe("planAutoPostpone", () => {
  it("does nothing when the due set is within budget", () => {
    const items = [attention("a1", 0.375), attention("a2", 0.375)];
    const plan = planAutoPostpone(items, { budget: 5, asOf: NOW, reserveRatio: 1 });
    expect(plan.count).toBe(0);
    expect(plan.items).toEqual([]);
    expect(plan.remainingAfter).toBe(2);
  });

  it("postpones low-priority attention items FIRST, then low-priority mature cards", () => {
    // 5 due, budget 2 → 3 must recede. Two low attention items + one low mature card are
    // eligible; two high-priority items are protected. So all three eligible recede, and
    // the attention items come before the mature card in the plan order.
    const items: AutoPostponeInput[] = [
      attention("topicLow1", 0.375),
      attention("topicLow2", 0.375, "extract"),
      card("cardMatureLow", 0.375, matureSignals),
      attention("topicHigh", 0.875), // protected (band A)
      card("cardHigh", 0.875, matureSignals), // protected (band A)
    ];
    const plan = planAutoPostpone(items, { budget: 2, asOf: NOW, reserveRatio: 1 });
    expect(plan.count).toBe(3);
    expect(plan.remainingAfter).toBe(2);
    // Attention items lead; the mature card is last.
    const kinds = plan.items.map((p) => p.postponeKind);
    expect(kinds.slice(0, 2)).toEqual(["attention", "attention"]);
    expect(kinds[2]).toBe("cardDefer");
    // None of the protected high-priority rows are victims.
    const ids = plan.items.map((p) => p.id);
    expect(ids).not.toContain("topicHigh");
    expect(ids).not.toContain("cardHigh");
    // Reasons are legible.
    expect(plan.items.find((p) => p.id === "cardMatureLow")?.reason).toBe(
      "low-priority-mature-card",
    );
    expect(plan.items.find((p) => p.id === "topicLow1")?.reason).toBe("low-priority-topic");
  });

  it("NEVER postpones a high-priority FRAGILE card (the protection invariant)", () => {
    // Heavily over budget; the only low-value items are attention. The high-priority
    // fragile card must stay even though more budget is needed.
    const items: AutoPostponeInput[] = [
      attention("t1", 0.375),
      card("fragileHigh", 0.875, fragileSignals),
      card("fragileHigh2", 0.875, fragileSignals),
    ];
    const plan = planAutoPostpone(items, { budget: 0, asOf: NOW, reserveRatio: 1 });
    // Only the one low-priority attention item can recede; the fragile high cards stay.
    expect(plan.items.map((p) => p.id)).toEqual(["t1"]);
    // Budget can't be fully met without sacrificing protected memory — that's correct.
    expect(plan.remainingAfter).toBe(2);
  });

  it("NEVER postpones a low-priority FRAGILE card (only mature cards recede)", () => {
    const items: AutoPostponeInput[] = [
      card("fragileLow", 0.375, fragileSignals),
      card("matureLow", 0.375, matureSignals),
      attention("filler", 0.375),
    ];
    const plan = planAutoPostpone(items, { budget: 1, asOf: NOW, reserveRatio: 1 });
    const ids = plan.items.map((p) => p.id);
    // The fragile low card is protected; the attention filler + the mature low card recede.
    expect(ids).not.toContain("fragileLow");
    expect(ids).toContain("filler");
    expect(ids).toContain("matureLow");
  });

  it("NEVER postpones a leech card (under repair)", () => {
    const leechSignals = { ...matureSignals, lapses: LEECH_LAPSE_THRESHOLD };
    const items: AutoPostponeInput[] = [
      card("leechLow", 0.375, leechSignals),
      card("matureLow", 0.375, matureSignals),
    ];
    const plan = planAutoPostpone(items, { budget: 0, asOf: NOW, reserveRatio: 1 });
    const ids = plan.items.map((p) => p.id);
    expect(ids).not.toContain("leechLow");
    expect(ids).toContain("matureLow");
  });

  it("NEVER postpones an explicitly protected item even if low priority", () => {
    const items: AutoPostponeInput[] = [
      { ...attention("pinnedLow", 0.375), protected: true },
      attention("plainLow", 0.375),
    ];
    const plan = planAutoPostpone(items, { budget: 1, asOf: NOW, reserveRatio: 1 });
    expect(plan.items.map((p) => p.id)).toEqual(["plainLow"]);
  });

  it("stops exactly when the remaining due count is within budget", () => {
    const items = [
      attention("a1", 0.375),
      attention("a2", 0.375),
      attention("a3", 0.375),
      attention("a4", 0.375),
    ];
    const plan = planAutoPostpone(items, { budget: 2, asOf: NOW, reserveRatio: 1 });
    expect(plan.count).toBe(2); // only 2 recede to reach the budget
    expect(plan.remainingAfter).toBe(2);
  });

  it("uses minute costs and the default reserve target when trimming overload", () => {
    const items = [
      attention("sourceHeavy", 0.375, "source", "2027-05-30T12:00:00.000Z", 10),
      attention("extractSmall1", 0.375, "extract", "2027-05-01T12:00:00.000Z", 1),
      attention("extractSmall2", 0.375, "extract", "2027-05-01T12:00:00.000Z", 1),
      card("protectedFragile", 0.875, fragileSignals, "2027-05-01T12:00:00.000Z", 2),
    ];
    const plan = planAutoPostpone(items, { budget: 10, asOf: NOW });

    expect(plan.usedMinutes).toBe(14);
    expect(plan.targetMinutes).toBe(10);
    expect(plan.reserveTargetMinutes).toBe(9);
    expect(plan.items.map((p) => p.id)).toEqual(["sourceHeavy"]);
    expect(plan.remainingMinutesAfter).toBe(4);
    expect(plan.remainingAfter).toBe(3);
  });

  it("reports unreachable minute overflow when only protected items remain", () => {
    const items = [
      attention("small", 0.375, "topic", "2027-05-01T12:00:00.000Z", 1),
      card("fragileHigh", 0.875, fragileSignals, "2027-05-01T12:00:00.000Z", 20),
    ];
    const plan = planAutoPostpone(items, { budget: 10, asOf: NOW });

    expect(plan.items.map((p) => p.id)).toEqual(["small"]);
    expect(plan.remainingMinutesAfter).toBe(20);
    expect(plan.remainingAfter).toBe(1);
  });

  it("uses raw fractional minutes for reserve math", () => {
    const items = [
      attention("a", 0.375, "topic", "2027-05-30T12:00:00.000Z", 1.4),
      attention("b", 0.375, "topic", "2027-05-30T12:00:00.000Z", 1.4),
      attention("c", 0.375, "topic", "2027-05-30T12:00:00.000Z", 1.1),
    ];
    const plan = planAutoPostpone(items, { budget: 3, asOf: NOW });

    expect(plan.usedMinutes).toBeCloseTo(3.9);
    expect(plan.reserveTargetMinutes).toBeCloseTo(2.7);
    expect(plan.items).toHaveLength(1);
    expect(plan.remainingMinutesAfter).toBeCloseTo(2.5);
  });

  it("ranks victims by value (least valuable first) within a tier — deterministic", () => {
    // Same band, but different due-urgency → the LESS overdue (less urgent, lower score)
    // recedes first. All else equal, id breaks ties.
    const items: AutoPostponeInput[] = [
      attention("veryOverdue", 0.375, "topic", "2027-01-01T12:00:00.000Z"),
      attention("slightlyOverdue", 0.375, "topic", "2027-05-30T12:00:00.000Z"),
      attention("filler1", 0.375),
      attention("filler2", 0.375),
    ];
    const plan = planAutoPostpone(items, { budget: 3, asOf: NOW, reserveRatio: 1 });
    expect(plan.count).toBe(1);
    // The least urgent (lowest score) recedes — the slightly-overdue one, not the ancient one.
    expect(plan.items[0]?.id).toBe("slightlyOverdue");
  });

  it("is fully deterministic — same input yields the same plan", () => {
    const items: AutoPostponeInput[] = [
      attention("a1", 0.375),
      attention("a2", 0.375),
      card("c1", 0.375, matureSignals),
    ];
    const plan1 = planAutoPostpone(items, { budget: 1, asOf: NOW, reserveRatio: 1 });
    const plan2 = planAutoPostpone(items, { budget: 1, asOf: NOW, reserveRatio: 1 });
    expect(plan2).toEqual(plan1);
  });

  it("protects due extract distillation from auto-postpone until the floor is met", () => {
    const items = [
      attention("extract-a", 0.375, "extract", "2027-05-01T12:00:00.000Z", 6, "clean_extract"),
      attention("topic-a", 0.375, "topic", "2027-05-01T12:00:00.000Z", 6),
      attention("topic-b", 0.375, "topic", "2027-05-01T12:00:00.000Z", 6),
    ];
    const plan = planAutoPostpone(items, {
      budget: 10,
      asOf: NOW,
      reserveRatio: 0.9,
      distillationQuotaPercent: 50,
    });

    expect(plan.distillationFloor).toMatchObject({
      quotaFloorMinutes: 5,
      dueDistillationMinutes: 6,
      postponedDistillationMinutes: 0,
      remainingDueDistillationMinutesAfter: 6,
    });
    expect(plan.items.map((p) => p.id)).not.toContain("extract-a");
  });

  it("can postpone low-priority distillation minutes above the protected floor", () => {
    const items = [
      attention("extract-a", 0.375, "extract", "2027-05-01T12:00:00.000Z", 6, "clean_extract"),
      attention("extract-b", 0.375, "extract", "2027-05-01T12:00:00.000Z", 6, "raw_extract"),
      attention("topic-a", 0.375, "topic", "2027-05-01T12:00:00.000Z", 6),
    ];
    const plan = planAutoPostpone(items, {
      budget: 10,
      asOf: NOW,
      reserveRatio: 0.9,
      distillationQuotaPercent: 50,
    });

    expect(plan.items.map((p) => p.id)).toContain("extract-a");
    expect(plan.distillationFloor).toMatchObject({
      quotaFloorMinutes: 5,
      dueDistillationMinutes: 12,
      postponedDistillationMinutes: 6,
      remainingDueDistillationMinutesAfter: 6,
    });
  });

  it("does not count non-extract rows with extract stages toward the protected floor", () => {
    const items = [
      attention("task-a", 0.375, "task", "2027-05-01T12:00:00.000Z", 6, "clean_extract"),
      attention("topic-a", 0.375, "topic", "2027-05-01T12:00:00.000Z", 6),
    ];
    const plan = planAutoPostpone(items, {
      budget: 5,
      asOf: NOW,
      reserveRatio: 1,
      distillationQuotaPercent: 50,
    });

    expect(plan.distillationFloor.dueDistillationMinutes).toBe(0);
    expect(plan.items.map((p) => p.id)).toContain("task-a");
  });
});
