/**
 * Tests for the on-device embedding primitives (T087).
 *
 * The deterministic local embedder is the shipped default; these pin the
 * properties KNN relies on: fixed dimension, determinism (so re-embed is a no-op
 * and tests can assert exact neighbors), unit-norm output, and that shared tokens
 * → a nearer vector than disjoint text.
 */

import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, embedTextLocal } from "./embedding";

/** Cosine distance (1 − cos) between two equal-length vectors. */
function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  if (na === 0 || nb === 0) return 1;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe("embedTextLocal", () => {
  it("returns a fixed-dimension vector", () => {
    expect(embedTextLocal("hello world")).toHaveLength(EMBEDDING_DIM);
  });

  it("is deterministic (same text → identical vector)", () => {
    expect(embedTextLocal("spaced repetition review intervals")).toEqual(
      embedTextLocal("spaced repetition review intervals"),
    );
  });

  it("produces a unit-norm vector for non-empty text", () => {
    const v = embedTextLocal("intelligence is skill acquisition efficiency");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("returns the zero vector for empty/whitespace text", () => {
    expect(embedTextLocal("   ")).toEqual(new Array(EMBEDDING_DIM).fill(0));
  });

  it("places text sharing tokens nearer than fully disjoint text", () => {
    const query = embedTextLocal("review intervals scheduling");
    const related = embedTextLocal("scheduling review intervals for memory");
    const unrelated = embedTextLocal("photosynthesis chlorophyll sunlight");
    expect(cosineDistance(query, related)).toBeLessThan(cosineDistance(query, unrelated));
  });
});
