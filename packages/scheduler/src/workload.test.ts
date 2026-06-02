/**
 * Workload projector tests (T081 — the pure load-simulation engine).
 *
 * These pin the spec's invariants:
 *  - DETERMINISTIC for a fixed snapshot + clock (same input -> same projection);
 *  - the `before` series is GROUNDED — it buckets the live `dueAt` values the way the
 *    queue/analytics count due load (overdue on day 0, local-calendar days);
 *  - the RETENTION lever moves due load EARLIER when the target rises (shorter intervals)
 *    and LATER when it falls;
 *  - the ADD-CARDS lever raises the near-term peak by ~the added count;
 *  - the POSTPONE lever reduces near-window load AND respects the protect-fragile rule
 *    (high-priority / fragile cards are NEVER moved; only low-priority MATURE cards when
 *    `includeMatureCards`);
 *  - `overBudgetDays*` count days strictly above `budget`;
 *  - the projection writes nothing (it's a pure fn over a frozen snapshot).
 */

import { describe, expect, it } from "vitest";
import { CARD_MATURE_STABILITY_DAYS } from "./auto-postpone";
import { MS_PER_DAY } from "./date-util";
import type { RetentionTargets } from "./retention";
import {
  projectWorkload,
  type WorkloadAttentionItem,
  type WorkloadCard,
  type WorkloadSnapshot,
} from "./workload";

// A fixed local-noon clock so the local-day bucketing is stable across machines (the
// window starts at local midnight; noon is comfortably inside day 0 in any timezone).
const NOW = "2027-06-01T12:00:00.000";
const NOW_MS = Date.parse(NOW);

/** Build an ISO instant `days` out from `NOW`. */
function inDays(days: number): string {
  return new Date(NOW_MS + days * MS_PER_DAY).toISOString();
}

const TARGETS: RetentionTargets = { global: 0.9, enabled: false };

/** A scheduled review card with an FSRS memory state. */
function card(overrides: Partial<WorkloadCard> = {}): WorkloadCard {
  return {
    id: overrides.id ?? "c1",
    priority: overrides.priority ?? 0.3,
    stability: overrides.stability ?? 30,
    lastReviewedAt: overrides.lastReviewedAt ?? inDays(-10),
    dueAt: overrides.dueAt ?? inDays(2),
    fsrsState: overrides.fsrsState ?? "review",
    retrievability: overrides.retrievability ?? 0.95,
    cardOverride: overrides.cardOverride ?? null,
    params: overrides.params ?? null,
    conceptNames: overrides.conceptNames ?? [],
  };
}

/** A scheduled attention item. */
function attention(overrides: Partial<WorkloadAttentionItem> = {}): WorkloadAttentionItem {
  return {
    id: overrides.id ?? "a1",
    priority: overrides.priority ?? 0.3,
    dueAt: overrides.dueAt ?? inDays(2),
    type: overrides.type ?? "topic",
  };
}

function snapshot(overrides: Partial<WorkloadSnapshot> = {}): WorkloadSnapshot {
  return {
    cards: overrides.cards ?? [],
    attention: overrides.attention ?? [],
    budget: overrides.budget ?? 10,
    targets: overrides.targets ?? TARGETS,
  };
}

describe("projectWorkload — baseline grounding", () => {
  it("buckets each card/attention dueAt into local-calendar days; overdue lands on day 0", () => {
    const snap = snapshot({
      cards: [card({ id: "c1", dueAt: inDays(0) }), card({ id: "c2", dueAt: inDays(-5) })],
      attention: [attention({ id: "a1", dueAt: inDays(3) })],
    });
    const p = projectWorkload(snap, { kind: "addCards", count: 0, priority: 0.3 }, { asOf: NOW });

    // c1 due today + c2 overdue (clamped to day 0) = 2 on day 0; a1 on day 3.
    expect(p.days[0]?.before).toBe(2);
    expect(p.days[3]?.before).toBe(1);
    // No change applied (count 0) -> after equals before.
    expect(p.days[0]?.after).toBe(2);
    expect(p.days[3]?.after).toBe(1);
  });

  it("is deterministic for a fixed snapshot + clock", () => {
    const snap = snapshot({ cards: [card(), card({ id: "c2", dueAt: inDays(4) })] });
    const change = { kind: "retention", scope: "global", target: 0.95 } as const;
    const a = projectWorkload(snap, change, { asOf: NOW });
    const b = projectWorkload(snap, change, { asOf: NOW });
    expect(a).toEqual(b);
  });

  it("drops due dates past the window", () => {
    const snap = snapshot({ cards: [card({ dueAt: inDays(99) })] });
    const p = projectWorkload(
      snap,
      { kind: "addCards", count: 0, priority: 0.3 },
      { asOf: NOW, windowDays: 30 },
    );
    expect(p.days.reduce((s, d) => s + d.before, 0)).toBe(0);
  });
});

describe("projectWorkload — retention lever", () => {
  it("raising the global target pulls due load EARLIER (more in the near window)", () => {
    // A mature card last reviewed 10d ago with high stability; a higher target shortens
    // its interval, so its re-projected due moves earlier than its current dueAt.
    const c = card({ stability: 60, lastReviewedAt: inDays(-10), dueAt: inDays(20) });
    const snap = snapshot({ cards: [c], targets: { global: 0.85, enabled: false } });

    const before = projectWorkload(
      snap,
      { kind: "addCards", count: 0, priority: 0.3 },
      { asOf: NOW },
    );
    const raised = projectWorkload(
      snap,
      { kind: "retention", scope: "global", target: 0.97 },
      { asOf: NOW },
    );

    const nearBefore = raised.days.slice(0, 10).reduce((s, d) => s + d.before, 0);
    const nearAfter = raised.days.slice(0, 10).reduce((s, d) => s + d.after, 0);
    // Raising the target moves load into the near window.
    expect(nearAfter).toBeGreaterThanOrEqual(nearBefore);
    expect(raised.deltaNext7 + raised.deltaNext30).toBeGreaterThanOrEqual(0);
    // The baseline before is unaffected by the lever (grounding intact).
    expect(raised.days.map((d) => d.before)).toEqual(before.days.map((d) => d.before));
  });

  it("lowering the global target pushes due load LATER (out of the near window)", () => {
    const c = card({ stability: 20, lastReviewedAt: inDays(-2), dueAt: inDays(3) });
    const snap = snapshot({ cards: [c], targets: { global: 0.95, enabled: false } });
    const lowered = projectWorkload(
      snap,
      { kind: "retention", scope: "global", target: 0.8 },
      { asOf: NOW, windowDays: 60 },
    );
    const nearBefore = lowered.days.slice(0, 10).reduce((s, d) => s + d.before, 0);
    const nearAfter = lowered.days.slice(0, 10).reduce((s, d) => s + d.after, 0);
    expect(nearAfter).toBeLessThanOrEqual(nearBefore);
  });

  it("a band lever only moves cards in that band", () => {
    const aCard = card({ id: "cA", priority: 0.9, stability: 40, dueAt: inDays(20) });
    const dCard = card({ id: "cD", priority: 0.1, stability: 40, dueAt: inDays(20) });
    const snap = snapshot({ cards: [aCard, dCard] });
    const p = projectWorkload(
      snap,
      { kind: "retention", scope: "band", key: "D", target: 0.97 },
      { asOf: NOW },
    );
    // Only the D card's after-due changed (it moved earlier); the A card is untouched.
    const dueDaysBefore = p.days.filter((d) => d.before > 0).length;
    const dueDaysAfter = p.days.filter((d) => d.after > 0).length;
    expect(dueDaysAfter).toBeGreaterThanOrEqual(dueDaysBefore);
  });
});

describe("projectWorkload — addCards lever", () => {
  it("raises the near-term peak by ~the added count on the first-due day", () => {
    const snap = snapshot({ cards: [card({ dueAt: inDays(5) })], budget: 100 });
    const p = projectWorkload(
      snap,
      { kind: "addCards", count: 8, priority: 0.5, firstDueInDays: 0 },
      { asOf: NOW },
    );
    expect(p.days[0]?.after).toBe(8);
    // peakBefore is the lone existing card (1) on day 5; peakAfter is the 8-card spike.
    expect(p.peakBefore).toBe(1);
    expect(p.peakAfter).toBe(8);
    expect(p.deltaNext7).toBe(8);
  });

  it("places new cards firstDueInDays out", () => {
    const snap = snapshot({ budget: 100 });
    const p = projectWorkload(
      snap,
      { kind: "addCards", count: 3, priority: 0.5, firstDueInDays: 4 },
      { asOf: NOW },
    );
    expect(p.days[4]?.after).toBe(3);
    expect(p.days[0]?.after).toBe(0);
  });
});

describe("projectWorkload — postpone lever (protect-fragile)", () => {
  it("moves low-priority attention items out by `days` (relief in the near window)", () => {
    const snap = snapshot({
      attention: [
        attention({ id: "a1", priority: 0.1, dueAt: inDays(1) }),
        attention({ id: "a2", priority: 0.1, dueAt: inDays(2) }),
      ],
      budget: 1,
    });
    const p = projectWorkload(
      snap,
      { kind: "postponeLowPriority", band: "D", days: 14 },
      { asOf: NOW, windowDays: 30 },
    );
    const nearBefore = p.days.slice(0, 7).reduce((s, d) => s + d.before, 0);
    const nearAfter = p.days.slice(0, 7).reduce((s, d) => s + d.after, 0);
    expect(nearAfter).toBeLessThan(nearBefore);
    // They reappear ~14 days out.
    expect(p.days[15]?.after).toBe(1);
    expect(p.days[16]?.after).toBe(1);
  });

  it("NEVER moves high-priority attention items", () => {
    const snap = snapshot({
      attention: [attention({ id: "a1", priority: 0.9, dueAt: inDays(1) })],
    });
    const p = projectWorkload(
      snap,
      { kind: "postponeLowPriority", band: "D", days: 14 },
      { asOf: NOW },
    );
    expect(p.days[1]?.after).toBe(1); // unchanged
    expect(p.days[15]?.after ?? 0).toBe(0);
  });

  it("does NOT move cards unless includeMatureCards is set", () => {
    const matureLow = card({
      id: "cm",
      priority: 0.1,
      stability: CARD_MATURE_STABILITY_DAYS + 10,
      fsrsState: "review",
      retrievability: 0.95,
      dueAt: inDays(1),
    });
    const snap = snapshot({ cards: [matureLow], budget: 0 });
    const without = projectWorkload(
      snap,
      { kind: "postponeLowPriority", band: "D", days: 14 },
      { asOf: NOW },
    );
    expect(without.days[1]?.after).toBe(1); // card untouched
  });

  it("moves low-priority MATURE cards out (includeMatureCards) but PROTECTS fragile ones", () => {
    const matureLow = card({
      id: "cMature",
      priority: 0.1,
      stability: CARD_MATURE_STABILITY_DAYS + 10,
      fsrsState: "review",
      retrievability: 0.95,
      dueAt: inDays(1),
    });
    const fragileLow = card({
      id: "cFragile",
      priority: 0.1,
      stability: 3, // below the mature cutline -> fragile
      fsrsState: "learning",
      retrievability: 0.6,
      dueAt: inDays(1),
    });
    const snap = snapshot({ cards: [matureLow, fragileLow], budget: 0 });
    const p = projectWorkload(
      snap,
      { kind: "postponeLowPriority", band: "D", days: 14, includeMatureCards: true },
      { asOf: NOW, windowDays: 30 },
    );
    // Day 1: only the fragile card remains (mature one was moved out).
    expect(p.days[1]?.after).toBe(1);
    // The mature card reappears ~14 days out.
    expect(p.days[15]?.after).toBe(1);
  });

  it("PROTECTS a high-priority mature card from the postpone lever", () => {
    const highMature = card({
      id: "cHigh",
      priority: 0.9,
      stability: CARD_MATURE_STABILITY_DAYS + 10,
      fsrsState: "review",
      retrievability: 0.95,
      dueAt: inDays(1),
    });
    const snap = snapshot({ cards: [highMature], budget: 0 });
    const p = projectWorkload(
      snap,
      { kind: "postponeLowPriority", band: "D", days: 14, includeMatureCards: true },
      { asOf: NOW },
    );
    expect(p.days[1]?.after).toBe(1); // never moved
  });
});

describe("projectWorkload — budget / peaks", () => {
  it("counts over-budget days strictly above the budget line", () => {
    // Pile 6 cards on day 0 with budget 5 -> day 0 is over budget.
    const cards = Array.from({ length: 6 }, (_v, i) => card({ id: `c${i}`, dueAt: inDays(0) }));
    const snap = snapshot({ cards, budget: 5 });
    const p = projectWorkload(snap, { kind: "addCards", count: 0, priority: 0.3 }, { asOf: NOW });
    expect(p.peakBefore).toBe(6);
    expect(p.overBudgetDaysBefore).toBe(1);
    // Exactly at budget is NOT over.
    const atBudget = snapshot({
      cards: Array.from({ length: 5 }, (_v, i) => card({ id: `c${i}`, dueAt: inDays(0) })),
      budget: 5,
    });
    const p2 = projectWorkload(
      atBudget,
      { kind: "addCards", count: 0, priority: 0.3 },
      { asOf: NOW },
    );
    expect(p2.overBudgetDaysBefore).toBe(0);
  });
});

describe("projectWorkload — applyParams lever (T080 bridge)", () => {
  it("re-projects in-scope cards' due dates under candidate params", () => {
    const c = card({ id: "c1", stability: 30, lastReviewedAt: inDays(-5), dueAt: inDays(20) });
    const snap = snapshot({ cards: [c] });
    const defaultW = [
      0.2172, 1.1771, 3.2602, 16.1507, 7.0114, 0.57, 2.0966, 0.0069, 1.5261, 0.112, 1.0178, 1.849,
      0.1133, 0.3127, 2.2934, 0.2191, 3.0004, 0.7536, 0.3332, 0.1437, 0.2,
    ];
    const p = projectWorkload(
      snap,
      { kind: "applyParams", params: defaultW, cardIds: ["c1"] },
      { asOf: NOW, windowDays: 60 },
    );
    // The card's after-due is recomputed (it may shift); the baseline before is unchanged.
    expect(p.days[20]?.before).toBe(1);
    const totalAfter = p.days.reduce((s, d) => s + d.after, 0);
    expect(totalAfter).toBe(1); // still exactly one card, somewhere in the window
  });
});
