/**
 * Read-point helper tests (T017).
 *
 * A read-point is a STABLE block id (from T016) + a character offset within that
 * block. These prove the renderer-side resolution math: capturing a read-point
 * from the selection, advancing it to the end of a block (the M4 extract seam),
 * locating the first unread block (the `.readpoint` divider anchor), computing the
 * progress index, and clamping a stale offset. They run headlessly against a
 * ProseMirror `EditorState` (no DOM) — `resolveReadPointFromState` takes a raw
 * state, mirroring what the live editor wrapper reads.
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import {
  clampOffsetToBlock,
  firstUnreadBlockId,
  type ResolvedReadPoint,
  readPointProgress,
  readThroughBlock,
  resolveReadPointFromState,
} from "./read-point";
import { buildSchema } from "./schema";

const schema = buildSchema();

const PARA = (text: string, blockId: string) => ({
  type: "paragraph",
  attrs: { blockId },
  content: text ? [{ type: "text", text }] : [],
});

const HEADING = (text: string, blockId: string) => ({
  type: "heading",
  attrs: { level: 1, blockId },
  content: [{ type: "text", text }],
});

/** A three-block document: heading + two paragraphs, each with a stable id. */
const DOC = {
  type: "doc",
  content: [HEADING("Title", "blk_h"), PARA("First paragraph.", "blk_a"), PARA("Second.", "blk_b")],
};

/** Build an EditorState with the caret placed at an absolute doc position. */
function stateWithCaret(json: unknown, pos: number): EditorState {
  const doc = PmNode.fromJSON(schema, json);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos)));
}

describe("resolveReadPointFromState", () => {
  it("resolves the enclosing block id + char offset at the caret", () => {
    // "First paragraph." starts after the heading node. Place the caret a few
    // chars into the first paragraph and assert it resolves to blk_a.
    const doc = PmNode.fromJSON(schema, DOC);
    // Find the absolute position of the start of the first paragraph's text.
    let paraStart = -1;
    doc.descendants((node, pos) => {
      if (node.type.name === "paragraph" && (node.attrs.blockId as string) === "blk_a") {
        paraStart = pos + 1; // step inside the block to its text
        return false;
      }
      return true;
    });
    expect(paraStart).toBeGreaterThan(0);
    const state = stateWithCaret(DOC, paraStart + 5); // 5 chars into "First..."
    const rp = resolveReadPointFromState(state);
    expect(rp?.blockId).toBe("blk_a");
    expect(rp?.offset).toBe(5);
  });

  it("resolves the heading block when the caret is in the heading", () => {
    const state = stateWithCaret(DOC, 2); // inside the heading text
    const rp = resolveReadPointFromState(state);
    expect(rp?.blockId).toBe("blk_h");
  });

  it("returns null when no id'd block is in scope (empty doc, no blockId)", () => {
    const empty = { type: "doc", content: [{ type: "paragraph" }] };
    const state = stateWithCaret(empty, 1);
    expect(resolveReadPointFromState(state)).toBeNull();
  });
});

describe("readThroughBlock — the auto-advance-on-extract seam shape (T021)", () => {
  it("returns the block id with the offset at the END of its text", () => {
    const rp = readThroughBlock(DOC, "blk_a");
    expect(rp).toEqual({ blockId: "blk_a", offset: "First paragraph.".length });
  });

  it("returns null when the block id is not in the doc", () => {
    expect(readThroughBlock(DOC, "missing")).toBeNull();
  });
});

describe("firstUnreadBlockId — the `.readpoint` divider anchor", () => {
  it("is the block immediately after the read-point block", () => {
    const rp: ResolvedReadPoint = { blockId: "blk_h", offset: 0 };
    expect(firstUnreadBlockId(DOC, rp)).toBe("blk_a");
  });

  it("is null when the read-point is on the last block", () => {
    const rp: ResolvedReadPoint = { blockId: "blk_b", offset: 0 };
    expect(firstUnreadBlockId(DOC, rp)).toBeNull();
  });

  it("is null with no read-point or a deleted block", () => {
    expect(firstUnreadBlockId(DOC, null)).toBeNull();
    expect(firstUnreadBlockId(DOC, { blockId: "gone", offset: 0 })).toBeNull();
  });
});

describe("readPointProgress — the reading progress bar", () => {
  it("is the 0-based index of the read-point block over the total", () => {
    expect(readPointProgress(DOC, { blockId: "blk_h", offset: 0 })).toEqual({ index: 0, total: 3 });
    expect(readPointProgress(DOC, { blockId: "blk_b", offset: 0 })).toEqual({ index: 2, total: 3 });
  });

  it("degrades to index 0 with no read-point or a stale block", () => {
    expect(readPointProgress(DOC, null)).toEqual({ index: 0, total: 3 });
    expect(readPointProgress(DOC, { blockId: "gone", offset: 0 })).toEqual({ index: 0, total: 3 });
  });
});

describe("clampOffsetToBlock — stale/over-long offset handling", () => {
  it("clamps an offset past the block text to the block length", () => {
    expect(clampOffsetToBlock(DOC, "blk_b", 999)).toBe("Second.".length);
  });

  it("keeps an in-range offset and floors negatives at 0", () => {
    expect(clampOffsetToBlock(DOC, "blk_a", 5)).toBe(5);
    expect(clampOffsetToBlock(DOC, "blk_a", -3)).toBe(0);
  });

  it("returns 0 for a deleted block", () => {
    expect(clampOffsetToBlock(DOC, "gone", 5)).toBe(0);
  });
});
