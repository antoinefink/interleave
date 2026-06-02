import { describe, expect, it } from "vitest";
import {
  CONTRADICTION_RECENCY_GAP_YEARS,
  CONTRADICTION_SIMILARITY_MIN,
  type ContradictionPair,
  type ContradictionSide,
  detectContradictions,
} from "./contradiction";

/** Build a side with sane defaults; override only what a case needs. */
function side(over: Partial<ContradictionSide> & { id: string }): ContradictionSide {
  return {
    type: "card",
    text: "",
    sourcePublishedAt: null,
    sourceAccessedAt: null,
    ...over,
  };
}

/** A pair above the similarity gate unless `similarity` is overridden. */
function pair(a: ContradictionSide, b: ContradictionSide, similarity = 0.95): ContradictionPair {
  return { a, b, similarity };
}

describe("detectContradictions (T089)", () => {
  it("flags a high-similarity pair with a negation divergence", () => {
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "Caffeine improves long-term memory consolidation." }),
        side({ id: "b", text: "Caffeine does not improve long-term memory consolidation." }),
      ),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reasons).toContain("negation");
    expect(flags[0]?.severity).toBe("low");
    expect(flags[0]?.newerSide).toBeNull();
    expect(flags[0]?.aId).toBe("a");
    expect(flags[0]?.bId).toBe("b");
  });

  it("flags a numeric divergence past tolerance (7 days vs 14 days)", () => {
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "The optimal review interval is 7 days." }),
        side({ id: "b", text: "The optimal review interval is 14 days." }),
      ),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reasons).toContain("numeric");
  });

  it("does NOT flag numbers within tolerance (7 vs 7.1 days)", () => {
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "The interval is 7 days." }),
        side({ id: "b", text: "The interval is 7.1 days." }),
      ),
    ]);
    expect(flags).toHaveLength(0);
  });

  it("does NOT flag a numeric divergence for DIFFERENT units (7 days vs 50 percent)", () => {
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "Reviews happen every 7 days." }),
        side({ id: "b", text: "Retention is 50 percent." }),
      ),
    ]);
    // Different units → no numeric signal; same-era undated sources → no recency;
    // no polarity cue → no negation. Nothing fires.
    expect(flags).toHaveLength(0);
  });

  it("flags a recency supersession (2026 vs 2019) with newerSide set", () => {
    const flags = detectContradictions([
      pair(
        side({
          id: "newCard",
          text: "Spaced repetition uses the FSRS algorithm.",
          sourcePublishedAt: "2026-01-01",
        }),
        side({
          id: "oldCard",
          text: "Spaced repetition uses the FSRS algorithm.",
          sourcePublishedAt: "2019-05-01",
        }),
      ),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reasons).toEqual(["recency"]);
    expect(flags[0]?.newerSide).toBe("a");
  });

  it("sets newerSide to b when b's source is the newer one", () => {
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "Same claim.", sourcePublishedAt: "2018" }),
        side({ id: "b", text: "Same claim.", sourcePublishedAt: "2025" }),
      ),
    ]);
    expect(flags[0]?.newerSide).toBe("b");
  });

  it("falls back to accessedAt when publishedAt is missing for the recency signal", () => {
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "Claim X.", sourceAccessedAt: "2026-03-01" }),
        side({ id: "b", text: "Claim X.", sourceAccessedAt: "2019-03-01" }),
      ),
    ]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reasons).toContain("recency");
    expect(flags[0]?.newerSide).toBe("a");
  });

  it("does NOT flag same-era sources (gap below the recency threshold)", () => {
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "Identical claim.", sourcePublishedAt: "2020" }),
        side({ id: "b", text: "Identical claim.", sourcePublishedAt: "2021" }),
      ),
    ]);
    expect(flags).toHaveLength(0);
  });

  it("escalates to medium severity when two signals fire", () => {
    const flags = detectContradictions([
      pair(
        side({
          id: "a",
          text: "The dose should be 100 mg and it is safe.",
          sourcePublishedAt: "2026",
        }),
        side({
          id: "b",
          text: "The dose should be 400 mg and it is dangerous.",
          sourcePublishedAt: "2018",
        }),
      ),
    ]);
    expect(flags).toHaveLength(1);
    // numeric (100 vs 400 mg) + antonym (safe/dangerous) + recency (2026 vs 2018).
    expect(flags[0]?.reasons.length).toBeGreaterThanOrEqual(2);
    expect(flags[0]?.severity).toBe("medium");
    // No flag is ever high-severity.
    expect(flags[0]?.severity).not.toBe("high" as unknown);
  });

  it("does NOT flag a high-similarity pair that AGREES", () => {
    const flags = detectContradictions([
      pair(
        side({
          id: "a",
          text: "The optimal interval is 7 days for new cards.",
          sourcePublishedAt: "2020",
        }),
        side({
          id: "b",
          text: "The optimal interval is 7 days for new cards.",
          sourcePublishedAt: "2020",
        }),
      ),
    ]);
    expect(flags).toHaveLength(0);
  });

  it("does NOT flag a low-similarity pair regardless of metadata", () => {
    const below = CONTRADICTION_SIMILARITY_MIN - 0.2;
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "Caffeine does not help.", sourcePublishedAt: "2026" }),
        side({ id: "b", text: "Caffeine helps a lot.", sourcePublishedAt: "2019" }),
        below,
      ),
    ]);
    expect(flags).toHaveLength(0);
  });

  it("handles missing dates and numbers cleanly (no throw, just fewer signals)", () => {
    expect(() =>
      detectContradictions([
        pair(
          side({ id: "a", text: "A vague qualitative claim." }),
          side({ id: "b", text: "Another vague qualitative claim." }),
        ),
      ]),
    ).not.toThrow();
    const flags = detectContradictions([
      pair(
        side({ id: "a", text: "A vague qualitative claim." }),
        side({ id: "b", text: "Another vague qualitative claim." }),
      ),
    ]);
    // No polarity divergence, no numbers, no dates → no signal → no flag.
    expect(flags).toHaveLength(0);
  });

  it("preserves input order and evaluates each pair independently", () => {
    const flags = detectContradictions([
      pair(side({ id: "x1", text: "It is true." }), side({ id: "x2", text: "It is false." })),
      pair(
        side({ id: "y1", text: "Same.", sourcePublishedAt: "2020" }),
        side({ id: "y2", text: "Same.", sourcePublishedAt: "2020" }),
      ),
      pair(
        side({ id: "z1", text: "Value is 10 units." }),
        side({ id: "z2", text: "Value is 90 units." }),
      ),
    ]);
    // x (negation) flagged, y (agrees) skipped, z (numeric) flagged — order kept.
    expect(flags.map((f) => f.aId)).toEqual(["x1", "z1"]);
  });

  it("recency threshold uses the exported gap constant", () => {
    // A gap exactly at the threshold flags; one below does not.
    const atThreshold = String(2020 + CONTRADICTION_RECENCY_GAP_YEARS);
    const flagged = detectContradictions([
      pair(
        side({ id: "a", text: "Same claim.", sourcePublishedAt: atThreshold }),
        side({ id: "b", text: "Same claim.", sourcePublishedAt: "2020" }),
      ),
    ]);
    expect(flagged).toHaveLength(1);
  });
});
