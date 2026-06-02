/**
 * Source-yield scorer tests (T083 — the pure yield rank).
 *
 * Pin the contract the ranked "Source yield" view + the `SourceYieldQuery` depend
 * on: a productive source scores HIGH, a read-but-barren source scores LOW, a
 * leech-heavy source scores LOW, an un-started source is NEUTRAL (never low), and
 * the band boundaries sit either side of the documented thresholds.
 */

import { describe, expect, it } from "vitest";
import {
  type SourceYieldInputs,
  scoreSourceYield,
  YIELD_HIGH_SCORE,
  YIELD_LOW_SCORE,
} from "./source-yield";

/** A neutral baseline; spread + override per case. */
const base: SourceYieldInputs = {
  readPct: 0,
  extractsCreated: 0,
  cardsCreated: 0,
  matureCards: 0,
  leeches: 0,
  timeSpentMs: 0,
};

describe("scoreSourceYield", () => {
  it("scores a productive source (many extracts + mature cards, little wasted time) HIGH", () => {
    const v = scoreSourceYield({
      ...base,
      readPct: 1,
      extractsCreated: 4,
      cardsCreated: 6,
      matureCards: 5,
      leeches: 0,
      timeSpentMs: 60_000, // 1 minute of review across 5 mature cards — trivial
    });
    expect(v.band).toBe("high");
    expect(v.score).toBeGreaterThanOrEqual(YIELD_HIGH_SCORE);
  });

  it("scores a read-but-barren source (high read %, ~0 output) LOW", () => {
    const v = scoreSourceYield({
      ...base,
      readPct: 1, // fully read
      extractsCreated: 0,
      cardsCreated: 0,
      matureCards: 0,
      leeches: 0,
      timeSpentMs: 0,
    });
    expect(v.band).toBe("low");
    expect(v.score).toBeLessThanOrEqual(YIELD_LOW_SCORE);
  });

  it("scores a leech-heavy source LOW even with several cards", () => {
    // 4 cards, all leeches, none mature → reward (4) minus a full leech-ratio
    // penalty + review-time penalty drags it under the low threshold.
    const v = scoreSourceYield({
      ...base,
      readPct: 0.8,
      extractsCreated: 1,
      cardsCreated: 4,
      matureCards: 0,
      leeches: 4,
      timeSpentMs: 30 * 60_000, // 30 min ground into failing cards
    });
    expect(v.band).toBe("low");
  });

  it("treats an un-started source (no reading, no output) as NEUTRAL, not low", () => {
    const v = scoreSourceYield({ ...base });
    expect(v.band).toBe("neutral");
    expect(v.score).toBe(0);
  });

  it("treats a barely-opened source (read below the floor, no output) as NEUTRAL", () => {
    const v = scoreSourceYield({ ...base, readPct: 0.02 });
    expect(v.band).toBe("neutral");
  });

  it("a source with review time but no output is NOT neutral (it has been worked)", () => {
    const v = scoreSourceYield({ ...base, readPct: 0, timeSpentMs: 5 * 60_000 });
    expect(v.band).not.toBe("neutral");
    expect(v.band).toBe("low");
  });

  it("ranks a many-extracts/cards source above a barren one (lower-yield sorts first)", () => {
    const productive = scoreSourceYield({
      ...base,
      readPct: 1,
      extractsCreated: 3,
      cardsCreated: 4,
      matureCards: 3,
    });
    const barren = scoreSourceYield({ ...base, readPct: 1 });
    expect(productive.score).toBeGreaterThan(barren.score);
  });

  it("places band boundaries either side of the documented thresholds", () => {
    // Just one card + nothing read → reward 1, no penalties → exactly 1.0 → medium.
    const oneCard = scoreSourceYield({ ...base, cardsCreated: 1, readPct: 0 });
    expect(oneCard.score).toBeCloseTo(1, 6);
    expect(oneCard.band).toBe("medium");

    // Two mature cards → reward ≥ 6 → high (well past YIELD_HIGH_SCORE = 2).
    const twoMature = scoreSourceYield({
      ...base,
      cardsCreated: 2,
      matureCards: 2,
      readPct: 0,
    });
    expect(twoMature.score).toBeGreaterThanOrEqual(YIELD_HIGH_SCORE);
    expect(twoMature.band).toBe("high");
  });

  it("is defensive against malformed inputs (NaN/negative clamp to neutral baseline)", () => {
    const v = scoreSourceYield({
      readPct: Number.NaN,
      extractsCreated: -3,
      cardsCreated: -1,
      matureCards: Number.POSITIVE_INFINITY,
      leeches: -2,
      timeSpentMs: Number.NaN,
    });
    // No real work → neutral; no throw.
    expect(v.band).toBe("neutral");
    expect(Number.isFinite(v.score)).toBe(true);
  });
});
