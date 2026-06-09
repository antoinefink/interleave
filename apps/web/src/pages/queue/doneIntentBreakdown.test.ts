import {
  isTerminalSourceBlockProcessingState,
  SOURCE_BLOCK_PROCESSING_STATES,
  type SourceBlockProcessingState,
} from "@interleave/core";
import { describe, expect, it } from "vitest";
import { describeUnresolved, pluralizeBlocks, resumeLabel } from "./doneIntentBreakdown";

/** Build a full stateCounts record (every state 0) with the given overrides. */
function counts(
  overrides: Partial<Record<SourceBlockProcessingState, number>> = {},
): Record<SourceBlockProcessingState, number> {
  const base = Object.fromEntries(SOURCE_BLOCK_PROCESSING_STATES.map((s) => [s, 0])) as Record<
    SourceBlockProcessingState,
    number
  >;
  return { ...base, ...overrides };
}

describe("describeUnresolved", () => {
  it("returns ordered, friendly-labeled segments for mixed non-terminal counts", () => {
    const segments = describeUnresolved(
      counts({ unread: 60, read: 5, needs_later: 3, stale_after_edit: 1 }),
    );
    expect(segments).toEqual([
      { key: "unread", label: "unread", count: 60 },
      { key: "read", label: "read, not extracted", count: 5 },
      { key: "needs_later", label: "deferred", count: 3 },
      { key: "stale_after_edit", label: "stale after edit", count: 1 },
    ]);
  });

  it("hides zero-count buckets", () => {
    const segments = describeUnresolved(counts({ unread: 4, read: 0, needs_later: 0 }));
    expect(segments).toEqual([{ key: "unread", label: "unread", count: 4 }]);
  });

  it("returns an empty list when there are no non-terminal blocks", () => {
    expect(describeUnresolved(counts())).toEqual([]);
  });

  it("frames only needs_later as 'deferred'", () => {
    expect(describeUnresolved(counts({ needs_later: 2 }))).toEqual([
      { key: "needs_later", label: "deferred", count: 2 },
    ]);
  });

  it("frames only stale_after_edit as 'stale after edit'", () => {
    expect(describeUnresolved(counts({ stale_after_edit: 1 }))).toEqual([
      { key: "stale_after_edit", label: "stale after edit", count: 1 },
    ]);
  });

  it("excludes terminal states (extracted / ignored / processed_without_output)", () => {
    const segments = describeUnresolved(
      counts({ extracted: 9, ignored: 4, processed_without_output: 2, unread: 1 }),
    );
    expect(segments).toEqual([{ key: "unread", label: "unread", count: 1 }]);
  });

  it("only ever returns non-terminal keys (stays in sync with the domain classification)", () => {
    const allNonZero = counts(
      Object.fromEntries(SOURCE_BLOCK_PROCESSING_STATES.map((s) => [s, 1])) as Record<
        SourceBlockProcessingState,
        number
      >,
    );
    for (const seg of describeUnresolved(allNonZero)) {
      expect(isTerminalSourceBlockProcessingState(seg.key)).toBe(false);
    }
  });
});

describe("pluralizeBlocks", () => {
  it("uses the singular for exactly one", () => {
    expect(pluralizeBlocks(1)).toBe("1 block");
  });
  it("uses the plural for more than one and for zero", () => {
    expect(pluralizeBlocks(3)).toBe("3 blocks");
    expect(pluralizeBlocks(0)).toBe("0 blocks");
  });
});

describe("resumeLabel", () => {
  it("renders 'block N of M' when a read-point and total exist", () => {
    expect(resumeLabel(12, 68)).toBe("block 12 of 68");
  });
  it("returns null when there is no read-point position", () => {
    expect(resumeLabel(null, 68)).toBeNull();
    expect(resumeLabel(undefined, 68)).toBeNull();
    expect(resumeLabel(0, 68)).toBeNull();
  });
  it("returns null when there is no total", () => {
    expect(resumeLabel(1, null)).toBeNull();
    expect(resumeLabel(1, 0)).toBeNull();
  });
});
