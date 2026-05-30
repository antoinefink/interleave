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
import { blockOffsetToPos, fillMissingBlockIds } from "./block-id";
import type { newBlockId } from "./block-ids";
import { blockIdsOf } from "./blocks";
import {
  clampOffsetToBlock,
  firstUnreadBlockId,
  isBlockAtOrAfterReadPoint,
  type ResolvedReadPoint,
  readPointProgress,
  readPointProgressFraction,
  readThroughBlock,
  resolveReadPointFromState,
} from "./read-point";
import { buildSchema } from "./schema";

const schema = buildSchema();

/** A deterministic, monotonic minter so test expectations are stable. */
function counterMinter(prefix = "id") {
  let n = 0;
  return () => `${prefix}_${String(n++).padStart(3, "0")}` as ReturnType<typeof newBlockId>;
}

/**
 * Run the REAL additive filler over plain (id-less) doc JSON and return the filled
 * doc JSON — the actual id distribution the editor produces at runtime, NOT a
 * hand-built fixture. Nested-block tests use this so they exercise the shape the
 * editor really ships (one id on the listItem/blockquote, none on the inner
 * paragraph), and would FAIL if a row ever carried two ids again.
 */
function fillOnce(json: unknown, mint = counterMinter()): unknown {
  let state = EditorState.create({ schema, doc: PmNode.fromJSON(schema, json) });
  const tr = fillMissingBlockIds(state, mint);
  if (tr) state = state.apply(tr);
  return state.doc.toJSON();
}

/** The blockId on the FIRST node of a given type in filled doc JSON (helper). */
function firstBlockIdOfType(json: unknown, type: string): string {
  const doc = PmNode.fromJSON(schema, json);
  let id: string | null = null;
  doc.descendants((node) => {
    if (id) return false;
    if (node.type.name === type) {
      id = (node.attrs.blockId as string | null) ?? null;
      return false;
    }
    return true;
  });
  if (!id) throw new Error(`no ${type} with a blockId in fixture`);
  return id;
}

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

/**
 * A document with NESTED block-id nodes, produced by the REAL filler over plain
 * `<ul>` / `<blockquote>` JSON — so it carries exactly the id distribution the
 * editor ships at runtime: ONE id on the `listItem`, ONE on the `blockquote`, and
 * NONE on their inner paragraphs (one id per row). The inner text begins one open
 * token DEEPER than the block's content start, which is exactly where the old
 * `$pos.start(depth)` math inflated the offset by the nesting depth, and where the
 * `blockTextBase` descent is genuinely exercised (not by a fabricated shape).
 */
const NESTED_DOC = fillOnce({
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [{ type: "paragraph", content: [textNode("hello world")] }] },
      ],
    },
    {
      type: "blockquote",
      content: [{ type: "paragraph", content: [textNode("quoted text")] }],
    },
  ],
});

/** The (filler-minted) ids on the single list item / blockquote of `NESTED_DOC`. */
const NESTED_LI_ID = firstBlockIdOfType(NESTED_DOC, "listItem");
const NESTED_BQ_ID = firstBlockIdOfType(NESTED_DOC, "blockquote");

function textNode(text: string) {
  return { type: "text", text };
}

/** Build an EditorState with the caret placed at an absolute doc position. */
function stateWithCaret(json: unknown, pos: number): EditorState {
  const doc = PmNode.fromJSON(schema, json);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, pos)));
}

/**
 * Absolute ProseMirror position of the START of the FIRST occurrence of `needle`
 * within a block's text — found by scanning the block's actual text nodes, so it
 * is INDEPENDENT of the offset mapping under test (no self-reference). For a
 * multi-text-run block (a multi-paragraph blockquote / list item) this lands in a
 * SECOND-or-later run, past the inter-run tokens the old single-base math
 * miscounted.
 */
function absPosOfSubstring(json: unknown, blockId: string, needle: string): number {
  const doc = PmNode.fromJSON(schema, json);
  let blockNode: PmNode | null = null;
  let blockPos = -1;
  doc.descendants((node, pos) => {
    if (blockNode) return false;
    if ((node.attrs.blockId as string | null | undefined) === blockId) {
      blockNode = node;
      blockPos = pos;
      return false;
    }
    return true;
  });
  if (!blockNode || blockPos < 0) throw new Error(`no block ${blockId} in fixture`);
  const contentStart = blockPos + 1;
  let result = -1;
  (blockNode as PmNode).descendants((child, relPos) => {
    if (result >= 0) return false;
    if (!child.isText || typeof child.text !== "string") return true;
    const idx = child.text.indexOf(needle);
    if (idx >= 0) {
      result = contentStart + relPos + idx;
      return false;
    }
    return false;
  });
  if (result < 0) throw new Error(`"${needle}" not found in a text run of ${blockId}`);
  return result;
}

/** The flattened text content of a block, by block id (what offsets index into). */
function blockTextOf(json: unknown, blockId: string): string {
  const doc = PmNode.fromJSON(schema, json);
  let text = "";
  doc.descendants((node) => {
    if ((node.attrs.blockId as string | null | undefined) === blockId) {
      text = node.textContent;
      return false;
    }
    return true;
  });
  return text;
}

/**
 * The absolute position of the START of a block's flattened text content, by
 * block id — i.e. where char offset 0 lives. This is the base `jumpToReadPoint`
 * re-anchors against, so a resolve→jump round-trip is correct iff
 * `textBaseOf(blockId) + storedOffset === originalCaretPos`.
 */
function textBaseOf(json: unknown, blockId: string): number {
  const doc = PmNode.fromJSON(schema, json);
  let base = -1;
  doc.descendants((node, pos) => {
    if (base >= 0) return false;
    if ((node.attrs.blockId as string | null | undefined) === blockId) {
      // Descend through any wrapping block children to the inline-content node.
      let b = pos + 1;
      let n = node;
      while (n.firstChild?.isBlock) {
        b += 1;
        n = n.firstChild;
      }
      base = b;
      return false;
    }
    return true;
  });
  return base;
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

describe("resolveReadPointFromState — nested blocks (list item / blockquote)", () => {
  it("the filler mints ONE id per row: on the listItem/blockquote, none on inner paragraphs", () => {
    // Guards the one-id-per-row invariant on the SHAPE these tests run against.
    // A list row + a blockquote row = exactly two ids; if the inner paragraphs ever
    // carried ids again, `orderedBlocks`/`blockIdsOf` would return more than two and
    // this (and the offset tests below, which assume one anchor per row) would break.
    expect(blockIdsOf(NESTED_DOC)).toEqual([NESTED_LI_ID, NESTED_BQ_ID]);
  });

  it("offset is the TRUE char offset N chars into a list-item paragraph (not inflated)", () => {
    // The list item's text begins one open token deeper than its content start;
    // a caret 6 chars in must resolve to offset 6 (the old math gave 7).
    const base = textBaseOf(NESTED_DOC, NESTED_LI_ID);
    const state = stateWithCaret(NESTED_DOC, base + 6);
    const rp = resolveReadPointFromState(state);
    // Resolves to the listItem (the row anchor), NOT a stray inner-paragraph id.
    expect(rp?.blockId).toBe(NESTED_LI_ID);
    expect(rp?.offset).toBe(6);
  });

  it("offset is the TRUE char offset N chars into a blockquote paragraph", () => {
    const base = textBaseOf(NESTED_DOC, NESTED_BQ_ID);
    const state = stateWithCaret(NESTED_DOC, base + 4);
    const rp = resolveReadPointFromState(state);
    expect(rp?.blockId).toBe(NESTED_BQ_ID);
    expect(rp?.offset).toBe(4);
  });

  it("resolve → jump round-trips to the SAME character inside a list item", () => {
    // Stored offset, re-anchored against the block's text base (what jumpToReadPoint
    // does), must land back on the original caret position — proving resolve and
    // jump share the SAME, correct base (not merely a shared off-by-one).
    const base = textBaseOf(NESTED_DOC, NESTED_LI_ID);
    const caret = base + 6;
    const rp = resolveReadPointFromState(stateWithCaret(NESTED_DOC, caret));
    expect(rp).not.toBeNull();
    if (!rp) throw new Error("expected a resolved read-point");
    const jumpPos = textBaseOf(NESTED_DOC, rp.blockId) + rp.offset;
    expect(jumpPos).toBe(caret);
  });

  it("progress / divider count list rows once (one block per row, not two)", () => {
    // A two-row nested doc has exactly two blocks for progress, and the divider
    // anchor after the list row is the blockquote — never a phantom inner paragraph.
    expect(readPointProgress(NESTED_DOC, { blockId: NESTED_LI_ID, offset: 0 })).toEqual({
      index: 0,
      total: 2,
    });
    expect(firstUnreadBlockId(NESTED_DOC, { blockId: NESTED_LI_ID, offset: 0 })).toBe(NESTED_BQ_ID);
  });
});

describe("resolveReadPointFromState — multi-text-run blocks (2nd-or-later run)", () => {
  // Finding (major): a caret PAST the first inline run used to overcount by the
  // inter-run open/close token count. These place the caret in the SECOND
  // paragraph of a multi-paragraph blockquote / list item and assert the offset is
  // a TRUE `node.textContent` index — i.e. the char at the stored offset is the
  // char the caret sits before.

  const MULTI_BQ = fillOnce({
    type: "doc",
    content: [
      {
        type: "blockquote",
        content: [
          { type: "paragraph", content: [textNode("alpha line")] },
          { type: "paragraph", content: [textNode("beta line")] },
        ],
      },
    ],
  });
  const MULTI_BQ_ID = firstBlockIdOfType(MULTI_BQ, "blockquote");

  const MULTI_LI = fillOnce({
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [textNode("first para")] },
              { type: "paragraph", content: [textNode("second para")] },
            ],
          },
        ],
      },
    ],
  });
  const MULTI_LI_ID = firstBlockIdOfType(MULTI_LI, "listItem");

  it("offset is the TRUE textContent index for a caret in the SECOND blockquote paragraph", () => {
    // textContent "alpha linebeta line"; a caret at the start of "beta" is index 10.
    // The old single-base math returned 12 here (a space inside "beta line").
    const caret = absPosOfSubstring(MULTI_BQ, MULTI_BQ_ID, "beta");
    const rp = resolveReadPointFromState(stateWithCaret(MULTI_BQ, caret));
    expect(rp?.blockId).toBe(MULTI_BQ_ID);
    expect(rp?.offset).toBe(10);
    const text = blockTextOf(MULTI_BQ, MULTI_BQ_ID);
    expect(text.slice(rp?.offset)).toBe("beta line");
  });

  it("offset is the TRUE textContent index for a caret in the SECOND list-item paragraph", () => {
    // textContent "first parasecond para"; a caret at the start of "second" is index 10.
    const caret = absPosOfSubstring(MULTI_LI, MULTI_LI_ID, "second");
    const rp = resolveReadPointFromState(stateWithCaret(MULTI_LI, caret));
    expect(rp?.blockId).toBe(MULTI_LI_ID);
    expect(rp?.offset).toBe(10);
    const text = blockTextOf(MULTI_LI, MULTI_LI_ID);
    expect(text.slice(rp?.offset)).toBe("second para");
  });

  it("resolve → blockOffsetToPos round-trips to the SAME caret inside the 2nd run", () => {
    // Capture the offset, then map it back to an absolute position through the SAME
    // mapping jumpToReadPoint uses (blockOffsetToPos) — it must land on the original
    // caret. (A shared single-base error would NOT round-trip back to `caret` here,
    // because absPosOfSubstring is computed independently from the run text nodes.)
    const caret = absPosOfSubstring(MULTI_BQ, MULTI_BQ_ID, "beta");
    const rp = resolveReadPointFromState(stateWithCaret(MULTI_BQ, caret));
    expect(rp).not.toBeNull();
    if (!rp) throw new Error("expected a resolved read-point");
    const doc = PmNode.fromJSON(schema, MULTI_BQ);
    let node: PmNode | null = null;
    let pos = -1;
    doc.descendants((n, p) => {
      if (node) return false;
      if ((n.attrs.blockId as string | null | undefined) === rp.blockId) {
        node = n;
        pos = p;
        return false;
      }
      return true;
    });
    if (!node) throw new Error("block not found");
    expect(blockOffsetToPos(node, pos, rp.offset)).toBe(caret);
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

describe("readPointProgressFraction — the 1-based progress fill (reaches 100%)", () => {
  it("reaches a FULL 1.0 when the read-point is on the LAST block", () => {
    // The bug this guards: 0-based `index/total` maxed at (total-1)/total (e.g.
    // 2/3 ≈ 0.67) so a fully-read source never hit 100%. The 1-based fraction does.
    expect(readPointProgressFraction(DOC, { blockId: "blk_b", offset: 0 })).toBe(1);
  });

  it("is (index + 1) / total for a mid-document read-point", () => {
    // blk_h = index 0 of 3 → 1/3; blk_a = index 1 of 3 → 2/3.
    expect(readPointProgressFraction(DOC, { blockId: "blk_h", offset: 0 })).toBeCloseTo(1 / 3);
    expect(readPointProgressFraction(DOC, { blockId: "blk_a", offset: 0 })).toBeCloseTo(2 / 3);
  });

  it("is 0 with no read-point, an empty doc, or no blocks", () => {
    expect(readPointProgressFraction(DOC, null)).toBe(0);
    expect(readPointProgressFraction({ type: "doc", content: [] }, null)).toBe(0);
  });

  it("never exceeds 1 even for a stale (deleted-block) read-point", () => {
    // A stale block degrades to index 0 → 1/total, still within [0, 1].
    const f = readPointProgressFraction(DOC, { blockId: "gone", offset: 0 });
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  });
});

describe("isBlockAtOrAfterReadPoint — the forward-only auto-advance guard (T021)", () => {
  it("is true for a block AT or AFTER the read-point (advance allowed)", () => {
    const rp: ResolvedReadPoint = { blockId: "blk_a", offset: 0 }; // index 1
    expect(isBlockAtOrAfterReadPoint(DOC, rp, "blk_a")).toBe(true); // same block
    expect(isBlockAtOrAfterReadPoint(DOC, rp, "blk_b")).toBe(true); // after
  });

  it("is false for a block strictly BEFORE the read-point (no rewind)", () => {
    const rp: ResolvedReadPoint = { blockId: "blk_b", offset: 0 }; // last block
    expect(isBlockAtOrAfterReadPoint(DOC, rp, "blk_h")).toBe(false);
    expect(isBlockAtOrAfterReadPoint(DOC, rp, "blk_a")).toBe(false);
  });

  it("is true when there is no read-point yet (the first extract establishes one)", () => {
    expect(isBlockAtOrAfterReadPoint(DOC, null, "blk_a")).toBe(true);
  });

  it("is true when the read-point block was deleted (degrades to index 0)", () => {
    expect(isBlockAtOrAfterReadPoint(DOC, { blockId: "gone", offset: 0 }, "blk_a")).toBe(true);
  });

  it("is false when the target block is not in the doc (nothing to advance to)", () => {
    expect(isBlockAtOrAfterReadPoint(DOC, { blockId: "blk_a", offset: 0 }, "missing")).toBe(false);
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
