/**
 * Plain-text → ProseMirror converter tests (T013).
 *
 * Pins the deterministic conversion the document upsert + the later editor both
 * rely on: blank-line splitting → paragraph count, an empty body → a valid empty
 * doc, plainText round-trips the normalized input, and each block gets a unique
 * stable id.
 */

import { describe, expect, it } from "vitest";
import type { BlockId } from "./ids";
import { plainTextToProseMirrorDoc } from "./prosemirror";

describe("plainTextToProseMirrorDoc", () => {
  it("splits on blank lines into one paragraph node + block each", () => {
    const { doc, blocks } = plainTextToProseMirrorDoc("First para.\n\nSecond para.\n\nThird.");
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(3);
    expect(doc.content.map((p) => p.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(doc.content[0]?.content?.[0]).toEqual({ type: "text", text: "First para." });
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.order)).toEqual([0, 1, 2]);
    expect(blocks.every((b) => b.blockType === "paragraph")).toBe(true);
  });

  it("treats a single paragraph (no blank lines) as one paragraph", () => {
    const { doc, blocks } = plainTextToProseMirrorDoc("Just one line of text here.");
    expect(doc.content).toHaveLength(1);
    expect(blocks).toHaveLength(1);
    expect(doc.content[0]?.content?.[0]?.text).toBe("Just one line of text here.");
  });

  it("collapses runs of blank lines and inline whitespace", () => {
    const { doc } = plainTextToProseMirrorDoc("A\n\n\n\nB   B\twith   spaces");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]?.content?.[0]?.text).toBe("A");
    expect(doc.content[1]?.content?.[0]?.text).toBe("B B with spaces");
  });

  it("normalizes CRLF / CR line endings", () => {
    const { doc } = plainTextToProseMirrorDoc("One\r\n\r\nTwo\r\rThree");
    expect(doc.content).toHaveLength(3);
    expect(doc.content.map((p) => p.content?.[0]?.text)).toEqual(["One", "Two", "Three"]);
  });

  it("returns a valid EMPTY doc for an empty or whitespace-only body", () => {
    for (const body of ["", "   ", "\n\n\t\n  \n"]) {
      const { doc, plainText, blocks } = plainTextToProseMirrorDoc(body);
      expect(doc).toEqual({ type: "doc", content: [] });
      expect(plainText).toBe("");
      expect(blocks).toHaveLength(0);
    }
  });

  it("round-trips: plainText re-splits into the same paragraphs", () => {
    const { plainText } = plainTextToProseMirrorDoc("Alpha.\n\n\nBeta line.\n\nGamma.");
    expect(plainText).toBe("Alpha.\n\nBeta line.\n\nGamma.");
    // Re-converting the normalized plainText yields the same paragraph count.
    const again = plainTextToProseMirrorDoc(plainText);
    expect(again.doc.content).toHaveLength(3);
    expect(again.plainText).toBe(plainText);
  });

  it("assigns a unique stable id to each block", () => {
    const { blocks } = plainTextToProseMirrorDoc("a\n\nb\n\nc\n\nd");
    const ids = blocks.map((b) => b.stableBlockId);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  it("uses an injected id minter deterministically (purity)", () => {
    let n = 0;
    const mint = () => `blk-${n++}` as BlockId;
    const { blocks } = plainTextToProseMirrorDoc("x\n\ny", mint);
    expect(blocks.map((b) => b.stableBlockId)).toEqual(["blk-0", "blk-1"]);
  });

  it("embeds each block id in the paragraph's `blockId` attr (T016: editor adopts it)", () => {
    let n = 0;
    const mint = () => `blk-${n++}` as BlockId;
    const { doc, blocks } = plainTextToProseMirrorDoc("alpha\n\nbeta", mint);
    // The node attr and the parallel block list carry the SAME id, in order.
    expect(doc.content.map((p) => p.attrs?.blockId)).toEqual(["blk-0", "blk-1"]);
    expect(blocks.map((b) => b.stableBlockId)).toEqual(["blk-0", "blk-1"]);
  });
});
