import { describe, expect, it } from "vitest";
import { reverifyDiff } from "./reverifyDiff";

describe("reverifyDiff", () => {
  it("returns a single equal segment for identical text", () => {
    expect(reverifyDiff("the cat sat", "the cat sat")).toEqual([
      { type: "equal", text: "the cat sat" },
    ]);
  });

  it("returns nothing for two empty strings", () => {
    expect(reverifyDiff("", "")).toEqual([]);
  });

  it("marks a pure insertion", () => {
    const segs = reverifyDiff("the cat", "the black cat");
    expect(segs.filter((s) => s.type === "delete")).toHaveLength(0);
    expect(segs.some((s) => s.type === "insert" && s.text.includes("black"))).toBe(true);
    // Reassembling insert+equal reproduces the NEW text.
    expect(
      segs
        .filter((s) => s.type !== "delete")
        .map((s) => s.text)
        .join(""),
    ).toBe("the black cat");
  });

  it("marks a pure deletion", () => {
    const segs = reverifyDiff("the black cat", "the cat");
    expect(segs.filter((s) => s.type === "insert")).toHaveLength(0);
    expect(segs.some((s) => s.type === "delete" && s.text.includes("black"))).toBe(true);
    expect(
      segs
        .filter((s) => s.type !== "insert")
        .map((s) => s.text)
        .join(""),
    ).toBe("the black cat");
  });

  it("marks a replacement as delete + insert", () => {
    const segs = reverifyDiff("the cat sat", "the dog sat");
    expect(segs.some((s) => s.type === "delete" && s.text.includes("cat"))).toBe(true);
    expect(segs.some((s) => s.type === "insert" && s.text.includes("dog"))).toBe(true);
    // OLD text reconstructs from equal+delete; NEW from equal+insert.
    expect(
      segs
        .filter((s) => s.type !== "insert")
        .map((s) => s.text)
        .join(""),
    ).toBe("the cat sat");
    expect(
      segs
        .filter((s) => s.type !== "delete")
        .map((s) => s.text)
        .join(""),
    ).toBe("the dog sat");
  });

  it("handles an empty old (all insert)", () => {
    const segs = reverifyDiff("", "brand new");
    expect(segs.every((s) => s.type === "insert")).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe("brand new");
  });

  it("handles an empty new (all delete)", () => {
    const segs = reverifyDiff("all gone", "");
    expect(segs.every((s) => s.type === "delete")).toBe(true);
    expect(segs.map((s) => s.text).join("")).toBe("all gone");
  });

  it("preserves whitespace so equal+delete reconstructs the original", () => {
    const segs = reverifyDiff("one  two   three", "one two three");
    expect(
      segs
        .filter((s) => s.type !== "insert")
        .map((s) => s.text)
        .join(""),
    ).toBe("one  two   three");
  });
});
