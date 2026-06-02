/**
 * Queue scoring tests (T076).
 *
 * The auto-sort is the deterministic ordering everything in M16 reasons about, so
 * its behaviour is pinned here against fixed inputs (no DB — the scorer is pure over
 * the flat row shape). We assert the load-bearing properties the spec names:
 *  - a high-priority overdue FRAGILE (low-retrievability) card outscores a fresh
 *    low-priority topic;
 *  - two cards sharing a sibling group are NOT adjacent in the result;
 *  - with both a card and a source present, `review` mode floats the card above an
 *    otherwise equally-scored source while `read` mode does the inverse — neither
 *    type is dropped (the old `modeIncludes` hard filter is gone);
 *  - the function is PURE (same input → same output, no randomness);
 *  - concept de-clumping breaks a run of one concept at the top;
 *  - the de-clumping passes are BOUNDED (a top-scoring item is not starved).
 *
 * The weights are PINNED so a weight change is a deliberate test update.
 */

import { describe, expect, it } from "vitest";
import {
  DECLUMP_MAX_PUSHDOWN,
  DEFAULT_QUEUE_SCORE_WEIGHTS,
  NEUTRAL_RETRIEVABILITY,
  type QueueScoreInput,
  queueItemScore,
  scoreQueueItems,
} from "./queue-score";

const NOW = "2026-05-30T12:00:00.000Z";

/** Build a queue-score row with sensible defaults overridden per test. */
function row(over: Partial<QueueScoreInput> & { id: string }): QueueScoreInput {
  return {
    type: "card",
    priority: 0.625,
    dueAt: NOW,
    scheduler: "fsrs",
    schedulerSignals: { retrievability: 0.9 },
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    ...over,
  };
}

describe("queueItemScore", () => {
  it("pins the default weights (a weight change is a deliberate test update)", () => {
    expect(DEFAULT_QUEUE_SCORE_WEIGHTS).toEqual({
      priority: 1.0,
      dueUrgency: 0.55,
      retrievability: 0.3,
      type: 0.12,
    });
    expect(NEUTRAL_RETRIEVABILITY).toBe(0.5);
  });

  it("is pure — same input yields the same score", () => {
    const r = row({ id: "a", priority: 0.8, dueAt: "2026-05-20T12:00:00.000Z" });
    const a = queueItemScore(r, {
      mode: "full",
      asOfMs: Date.parse(NOW),
      weights: DEFAULT_QUEUE_SCORE_WEIGHTS,
    });
    const b = queueItemScore(r, {
      mode: "full",
      asOfMs: Date.parse(NOW),
      weights: DEFAULT_QUEUE_SCORE_WEIGHTS,
    });
    expect(a).toBe(b);
  });

  it("scores LOWER retrievability HIGHER for a card (about-to-be-forgotten is urgent)", () => {
    const ctx = {
      mode: "full" as const,
      asOfMs: Date.parse(NOW),
      weights: DEFAULT_QUEUE_SCORE_WEIGHTS,
    };
    const fragile = queueItemScore(
      row({ id: "a", schedulerSignals: { retrievability: 0.2 } }),
      ctx,
    );
    const safe = queueItemScore(row({ id: "b", schedulerSignals: { retrievability: 0.95 } }), ctx);
    expect(fragile).toBeGreaterThan(safe);
  });

  it("gives attention rows (no retrievability) the neutral midpoint", () => {
    const ctx = {
      mode: "full" as const,
      asOfMs: Date.parse(NOW),
      weights: DEFAULT_QUEUE_SCORE_WEIGHTS,
    };
    const attention = queueItemScore(
      row({
        id: "a",
        type: "topic",
        scheduler: "attention",
        schedulerSignals: { retrievability: null },
      }),
      ctx,
    );
    const cardAtMid = queueItemScore(
      row({
        id: "b",
        type: "topic",
        scheduler: "attention",
        schedulerSignals: { retrievability: 0.5 },
      }),
      ctx,
    );
    // The neutral attention value matches a 0.5-retrievability card on that factor.
    expect(attention).toBe(cardAtMid);
  });
});

describe("scoreQueueItems — ordering", () => {
  it("floats a high-priority overdue fragile card above a fresh low-priority topic", () => {
    const fragileCard = row({
      id: "card-hi",
      type: "card",
      priority: 0.875, // A
      dueAt: "2026-05-22T12:00:00.000Z", // 8 days overdue
      scheduler: "fsrs",
      schedulerSignals: { retrievability: 0.15 }, // about to be forgotten
    });
    const freshTopic = row({
      id: "topic-lo",
      type: "topic",
      priority: 0.125, // D
      dueAt: NOW, // due today, not overdue
      scheduler: "attention",
      schedulerSignals: { retrievability: null },
    });
    const ordered = scoreQueueItems([freshTopic, fragileCard], { mode: "full", asOf: NOW });
    expect(ordered.map((r) => r.id)).toEqual(["card-hi", "topic-lo"]);
  });

  it("does not place two cards sharing a sibling group adjacent", () => {
    // Two siblings (same group) of equal score would otherwise sort adjacent (tie-
    // broken by id). With interleavable non-sibling rows present (the normal queue
    // condition) the de-clump pass separates them.
    const sibA = row({ id: "sib-a", siblingGroupId: "grp-1", priority: 0.6 });
    const sibB = row({ id: "sib-b", siblingGroupId: "grp-1", priority: 0.6 });
    const o1 = row({ id: "other-1", siblingGroupId: "grp-2", priority: 0.6 });
    const o2 = row({ id: "other-2", siblingGroupId: "grp-3", priority: 0.6 });
    const ordered = scoreQueueItems([sibA, sibB, o1, o2], { mode: "full", asOf: NOW });
    const ids = ordered.map((r) => r.id);
    expect(Math.abs(ids.indexOf("sib-a") - ids.indexOf("sib-b"))).toBeGreaterThan(1);
  });

  it("does not place two same-source rows adjacent", () => {
    const a = row({ id: "src-a", sourceId: "s1", siblingGroupId: null, priority: 0.6 });
    const b = row({ id: "src-b", sourceId: "s1", siblingGroupId: null, priority: 0.6 });
    const o1 = row({ id: "src-c", sourceId: "s2", siblingGroupId: null, priority: 0.6 });
    const o2 = row({ id: "src-d", sourceId: "s3", siblingGroupId: null, priority: 0.6 });
    const ordered = scoreQueueItems([a, b, o1, o2], { mode: "full", asOf: NOW });
    const ids = ordered.map((r) => r.id);
    expect(Math.abs(ids.indexOf("src-a") - ids.indexOf("src-b"))).toBeGreaterThan(1);
  });

  it("review mode floats a card above an equally-scored source; read mode inverts — neither dropped", () => {
    // A card and a source with identical priority/due/retrievability-equivalent, so
    // ONLY the mode-modulated type weight separates them.
    const card = row({
      id: "the-card",
      type: "card",
      priority: 0.625,
      dueAt: NOW,
      scheduler: "fsrs",
      schedulerSignals: { retrievability: NEUTRAL_RETRIEVABILITY },
    });
    const source = row({
      id: "the-source",
      type: "source",
      priority: 0.625,
      dueAt: NOW,
      scheduler: "attention",
      schedulerSignals: { retrievability: null }, // neutral → equals the card on that factor
    });

    const review = scoreQueueItems([source, card], { mode: "review", asOf: NOW });
    expect(review.map((r) => r.id)).toEqual(["the-card", "the-source"]);
    // The source is NOT dropped — both types remain in the list.
    expect(review).toHaveLength(2);

    const read = scoreQueueItems([source, card], { mode: "read", asOf: NOW });
    expect(read.map((r) => r.id)).toEqual(["the-source", "the-card"]);
    expect(read).toHaveLength(2);

    // full mode is neutral on type, so the id tie-break decides (deterministic).
    const full = scoreQueueItems([source, card], { mode: "full", asOf: NOW });
    expect(full).toHaveLength(2);
  });

  it("breaks a run of one concept at the top of the queue", () => {
    // Three high-score rows of concept X and one of concept Y at a slightly lower
    // score. De-clumping should pull the Y row up so the top isn't all-X.
    const x1 = row({ id: "x1", concept: "X", priority: 0.8, siblingGroupId: null, sourceId: null });
    const x2 = row({ id: "x2", concept: "X", priority: 0.8, siblingGroupId: null, sourceId: null });
    const x3 = row({ id: "x3", concept: "X", priority: 0.8, siblingGroupId: null, sourceId: null });
    const y1 = row({
      id: "y1",
      concept: "Y",
      priority: 0.79,
      siblingGroupId: null,
      sourceId: null,
    });
    const ordered = scoreQueueItems([x1, x2, x3, y1], { mode: "full", asOf: NOW });
    const ids = ordered.map((r) => r.id);
    // y1 is no longer last — it was pulled up to break the X run (not three X adjacent).
    expect(ids.indexOf("y1")).toBeLessThan(3);
    // No three consecutive X concepts at the very top.
    expect(ids[0]).toBe("x1");
    expect(ids[1]).toBe("y1");
  });

  it("is deterministic — same input yields the same order, no randomness", () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      row({
        id: `r${i}`,
        priority: (i % 4) / 4 + 0.1,
        dueAt: `2026-05-${10 + (i % 18)}T12:00:00.000Z`,
        concept: `c${i % 3}`,
        siblingGroupId: i % 2 === 0 ? `g${i % 5}` : null,
      }),
    );
    const a = scoreQueueItems(items, { mode: "full", asOf: NOW }).map((r) => r.id);
    const b = scoreQueueItems(items, { mode: "full", asOf: NOW }).map((r) => r.id);
    expect(a).toEqual(b);
  });

  it("never mutates the input array", () => {
    const items = [row({ id: "a" }), row({ id: "b" })];
    const snapshot = items.map((r) => r.id);
    scoreQueueItems(items, { mode: "full", asOf: NOW });
    expect(items.map((r) => r.id)).toEqual(snapshot);
  });

  it("bounds de-clumping — a top-scoring item is never pushed past the window", () => {
    // The #1 item by score shares a concept with #2; even after de-clumping it must
    // stay within DECLUMP_MAX_PUSHDOWN of the front (it is never starved).
    const top = row({
      id: "aaa-top",
      concept: "X",
      priority: 0.99,
      dueAt: "2026-05-01T00:00:00.000Z",
    });
    const rest = Array.from({ length: 6 }, (_, i) =>
      row({ id: `z${i}`, concept: "X", priority: 0.99, dueAt: "2026-05-01T00:00:00.000Z" }),
    );
    const ordered = scoreQueueItems([top, ...rest], { mode: "full", asOf: NOW });
    const idx = ordered.findIndex((r) => r.id === "aaa-top");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThanOrEqual(DECLUMP_MAX_PUSHDOWN);
  });
});
