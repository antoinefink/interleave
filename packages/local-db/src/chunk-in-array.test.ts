import { describe, expect, it } from "vitest";
import { chunkIds, SQLITE_SAFE_IN_ARRAY_SIZE } from "./chunk-in-array";

describe("chunkIds", () => {
  it("keeps the safe size comfortably under SQLite's 999 variable floor", () => {
    expect(SQLITE_SAFE_IN_ARRAY_SIZE).toBeLessThan(999);
    expect(SQLITE_SAFE_IN_ARRAY_SIZE).toBe(900);
  });

  it("empty input → no chunks", () => {
    expect(chunkIds([])).toEqual([]);
  });

  it("a sub-chunk-size list stays a single chunk", () => {
    const ids = Array.from({ length: 10 }, (_, i) => i);
    expect(chunkIds(ids)).toEqual([ids]);
  });

  it("splits into contiguous chunks of at most the safe size, preserving order", () => {
    const ids = Array.from({ length: SQLITE_SAFE_IN_ARRAY_SIZE + 10 }, (_, i) => i);
    const chunks = chunkIds(ids);
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.length).toBe(SQLITE_SAFE_IN_ARRAY_SIZE);
    expect(chunks[1]?.length).toBe(10);
    // Flattening is identical to the input (order preserved, nothing dropped/dup'd).
    expect(chunks.flat()).toEqual(ids);
  });

  it("respects an explicit chunk size", () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
