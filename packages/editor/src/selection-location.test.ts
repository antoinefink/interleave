/**
 * Selection → source-location resolution tests (T019).
 *
 * These prove the load-bearing part of the text-selection toolbar: turning a
 * ProseMirror selection into the stable block-ids + offsets + verbatim snapshot
 * that highlight (T020) and extraction (T021) persist as a `source_locations`
 * anchor. They run headlessly against a raw `EditorState` (no DOM, mirroring what
 * the live editor wrapper reads), covering a single-block selection, a cross-block
 * selection (which must still return ALL spanned block ids — the T019 risk note),
 * and the empty/no-block cases that must produce no toolbar.
 */

import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { fillMissingBlockIds } from "./block-id";
import type { newBlockId } from "./block-ids";
import { blockIdsOf } from "./blocks";
import { buildSchema } from "./schema";
import { resolveSelectionLocation } from "./selection-location";

const schema = buildSchema();

/** A deterministic, monotonic minter so test expectations are stable. */
function counterMinter(prefix = "id") {
  let n = 0;
  return () => `${prefix}_${String(n++).padStart(3, "0")}` as ReturnType<typeof newBlockId>;
}

/**
 * Run the REAL additive filler over plain (id-less) doc JSON and return the filled
 * doc JSON — the actual id distribution the editor produces at runtime. Nested
 * tests use this so a single list-row / blockquote selection is exercised against
 * the shape the editor really ships (ONE id per row), and the assertions below
 * (single-row → one block id, crossBlock=false) FAIL if a row regrows two ids.
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
  content: [
    HEADING("Title", "blk_h"),
    PARA("First paragraph here.", "blk_a"),
    PARA("Second paragraph.", "blk_b"),
  ],
};

const IMAGE_DOC = {
  type: "doc",
  content: [
    PARA("Before image.", "blk_before"),
    {
      type: "image",
      attrs: {
        blockId: "blk_image",
        src: "article-image://source_1/asset_1",
        alt: "Architecture diagram",
      },
    },
    PARA("After image.", "blk_after"),
  ],
};

/**
 * A document with NESTED block-id nodes, produced by the REAL filler over plain
 * `<ul>` / `<blockquote>` JSON — exactly the id distribution the editor ships:
 * ONE id on the `listItem`, ONE on the `blockquote`, and NONE on their inner
 * paragraphs. A SINGLE list-row / blockquote selection must therefore resolve to
 * exactly one block id with `crossBlock: false`; if a row ever regrew two ids the
 * overlap walk would collect both and falsely report a cross-block span.
 */
const NESTED_DOC = fillOnce({
  type: "doc",
  content: [
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
        },
      ],
    },
    {
      type: "blockquote",
      content: [{ type: "paragraph", content: [{ type: "text", text: "quoted text" }] }],
    },
  ],
});

/** The (filler-minted) ids on the single list item / blockquote of `NESTED_DOC`. */
const NESTED_LI_ID = firstBlockIdOfType(NESTED_DOC, "listItem");
const NESTED_BQ_ID = firstBlockIdOfType(NESTED_DOC, "blockquote");

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
 * Absolute position of the START of a block's flattened text content, by block id
 * — i.e. where char offset 0 lives. For a top-level paragraph this is `pos + 1`;
 * for a nested list item / blockquote it descends one token deeper per level.
 */
function textStartOf(json: unknown, blockId: string): number {
  const doc = PmNode.fromJSON(schema, json);
  let start = -1;
  doc.descendants((node, pos) => {
    if (start >= 0) return false;
    const id = node.attrs.blockId as string | null | undefined;
    if (id === blockId) {
      let s = pos + 1; // step inside the block node to its content
      let n = node;
      while (n.firstChild?.isBlock) {
        s += 1; // descend through wrapping block children to the inline text
        n = n.firstChild;
      }
      start = s;
      return false;
    }
    return true;
  });
  return start;
}

function nodePosOf(json: unknown, blockId: string): number {
  const doc = PmNode.fromJSON(schema, json);
  let found = -1;
  doc.descendants((node, pos) => {
    if (found >= 0) return false;
    if ((node.attrs.blockId as string | null | undefined) === blockId) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`no block ${blockId} in fixture`);
  return found;
}

/**
 * Absolute ProseMirror [from, to] positions of the FIRST occurrence of `needle`
 * within the text of the block identified by `blockId`. Found by scanning the
 * block's actual text nodes for the substring — INDEPENDENT of the offset-mapping
 * under test, so the assertions are not self-referential. Throws if not found.
 */
function absRangeOfSubstring(json: unknown, blockId: string, needle: string): [number, number] {
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
  // `node.descendants` yields each text run's position relative to the block's
  // content start (blockPos + 1); the needle's match within that run gives the
  // absolute range without going through posToBlockOffset/blockOffsetToPos.
  const contentStart = blockPos + 1;
  let range: [number, number] | null = null;
  (blockNode as PmNode).descendants((child, relPos) => {
    if (range) return false;
    if (!child.isText || typeof child.text !== "string") return true;
    const idx = child.text.indexOf(needle);
    if (idx >= 0) {
      const from = contentStart + relPos + idx;
      range = [from, from + needle.length];
      return false;
    }
    return false;
  });
  if (!range) throw new Error(`"${needle}" not found in a single text run of ${blockId}`);
  return range;
}

/** Build an EditorState with a text selection spanning [from, to]. */
function stateWithSelection(json: unknown, from: number, to: number): EditorState {
  const doc = PmNode.fromJSON(schema, json);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, from, to)));
}

function stateWithNodeSelection(json: unknown, blockId: string): EditorState {
  const doc = PmNode.fromJSON(schema, json);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(NodeSelection.create(doc, nodePosOf(json, blockId))));
}

describe("resolveSelectionLocation — single-block selection", () => {
  it("resolves an image atom NodeSelection to its image block anchor", () => {
    const loc = resolveSelectionLocation(stateWithNodeSelection(IMAGE_DOC, "blk_image"));
    expect(loc).toEqual({
      blockIds: ["blk_image"],
      startOffset: 0,
      endOffset: 0,
      selectedText: "Architecture diagram",
      crossBlock: false,
    });
  });

  it("resolves one block id with start/end offsets and the exact snapshot", () => {
    const start = textStartOf(DOC, "blk_a");
    // Select "First" (chars 0..5) inside "First paragraph here."
    const loc = resolveSelectionLocation(stateWithSelection(DOC, start, start + 5));
    expect(loc).not.toBeNull();
    expect(loc?.blockIds).toEqual(["blk_a"]);
    expect(loc?.startOffset).toBe(0);
    expect(loc?.endOffset).toBe(5);
    expect(loc?.selectedText).toBe("First");
    expect(loc?.crossBlock).toBe(false);
  });

  it("resolves a mid-block selection with non-zero start offset", () => {
    const start = textStartOf(DOC, "blk_a");
    // "First " is 6 chars; select "paragraph" (offset 6..15).
    const loc = resolveSelectionLocation(stateWithSelection(DOC, start + 6, start + 15));
    expect(loc?.blockIds).toEqual(["blk_a"]);
    expect(loc?.startOffset).toBe(6);
    expect(loc?.endOffset).toBe(15);
    expect(loc?.selectedText).toBe("paragraph");
  });
});

describe("resolveSelectionLocation — nested blocks (list item / blockquote)", () => {
  it("the fixture (real filler output) carries ONE id per row", () => {
    // The shape these tests run against: a list row + a blockquote row = two ids,
    // on the listItem and blockquote — never a third on an inner paragraph. If a
    // row ever regrew two ids, the single-row selection tests below would break.
    expect(blockIdsOf(NESTED_DOC)).toEqual([NESTED_LI_ID, NESTED_BQ_ID]);
  });

  it("a SINGLE list-row selection resolves exactly ONE block id with crossBlock=false", () => {
    // This is the production scenario the duplicate-id bug corrupted: selecting one
    // list row used to resolve [listItem, paragraph] with crossBlock=true. It must
    // now be exactly one block id (the listItem) and NOT cross-block.
    const start = textStartOf(NESTED_DOC, NESTED_LI_ID);
    const loc = resolveSelectionLocation(stateWithSelection(NESTED_DOC, start + 6, start + 11));
    expect(loc?.blockIds).toEqual([NESTED_LI_ID]);
    expect(loc?.blockIds).toHaveLength(1);
    expect(loc?.crossBlock).toBe(false);
  });

  it("offsets slice selectedText out of the LIST-ITEM text exactly", () => {
    // "hello world": select "world" (chars 6..11). The offsets must index the
    // block's flattened text, so blockText.slice(start,end) === selectedText. The
    // old math returned startOffset 7 here and sliced "orld" — a corrupt anchor.
    const start = textStartOf(NESTED_DOC, NESTED_LI_ID);
    const loc = resolveSelectionLocation(stateWithSelection(NESTED_DOC, start + 6, start + 11));
    expect(loc?.blockIds).toEqual([NESTED_LI_ID]);
    expect(loc?.startOffset).toBe(6);
    expect(loc?.endOffset).toBe(11);
    expect(loc?.selectedText).toBe("world");
    const text = blockTextOf(NESTED_DOC, NESTED_LI_ID);
    expect(text.slice(loc?.startOffset ?? -1, loc?.endOffset ?? -1)).toBe(loc?.selectedText);
  });

  it("a SINGLE blockquote-row selection resolves exactly ONE block id with crossBlock=false", () => {
    const start = textStartOf(NESTED_DOC, NESTED_BQ_ID);
    const loc = resolveSelectionLocation(stateWithSelection(NESTED_DOC, start + 7, start + 11));
    expect(loc?.blockIds).toEqual([NESTED_BQ_ID]);
    expect(loc?.blockIds).toHaveLength(1);
    expect(loc?.crossBlock).toBe(false);
  });

  it("offsets slice selectedText out of the BLOCKQUOTE text exactly", () => {
    // "quoted text": select "text" (chars 7..11).
    const start = textStartOf(NESTED_DOC, NESTED_BQ_ID);
    const loc = resolveSelectionLocation(stateWithSelection(NESTED_DOC, start + 7, start + 11));
    expect(loc?.blockIds).toEqual([NESTED_BQ_ID]);
    expect(loc?.startOffset).toBe(7);
    expect(loc?.endOffset).toBe(11);
    expect(loc?.selectedText).toBe("text");
    const text = blockTextOf(NESTED_DOC, NESTED_BQ_ID);
    expect(text.slice(loc?.startOffset ?? -1, loc?.endOffset ?? -1)).toBe(loc?.selectedText);
  });

  it("a leading sub-range in a list item starts at offset 0 (not the nesting depth)", () => {
    // Select "hello" from the very start of the list item's text.
    const start = textStartOf(NESTED_DOC, NESTED_LI_ID);
    const loc = resolveSelectionLocation(stateWithSelection(NESTED_DOC, start, start + 5));
    expect(loc?.startOffset).toBe(0);
    expect(loc?.endOffset).toBe(5);
    expect(loc?.selectedText).toBe("hello");
  });

  it("a multi-paragraph blockquote is ONE row id and startOffset is measured against it", () => {
    // Finding #3: with one id per row, a selection inside the FIRST paragraph of a
    // multi-paragraph blockquote resolves a single block id (the blockquote) and
    // `startOffset` is measured against that SAME block — blockIds[0] and the
    // offset base agree (the old duplicate-id ambiguity is gone).
    const MULTI = fillOnce({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "alpha line" }] },
            { type: "paragraph", content: [{ type: "text", text: "beta line" }] },
          ],
        },
      ],
    });
    const bqId = firstBlockIdOfType(MULTI, "blockquote");
    const start = textStartOf(MULTI, bqId); // base = first text run of the quote
    // Select "lpha" (chars 1..5) inside the first paragraph.
    const loc = resolveSelectionLocation(stateWithSelection(MULTI, start + 1, start + 5));
    expect(loc?.blockIds).toEqual([bqId]);
    expect(loc?.crossBlock).toBe(false);
    expect(loc?.startOffset).toBe(1);
    expect(loc?.selectedText).toBe("lpha");
  });

  it("offsets are TRUE textContent indices when selecting in the SECOND paragraph of a blockquote", () => {
    // Finding (major): the offset math used to anchor to the FIRST text run only,
    // so a selection past the inter-run open/close tokens overcounted. Here
    // textContent is "alpha linebeta line"; selecting "beta" (indices 10..14) used
    // to yield 12/16 — slicing "ta l", a corrupt anchor. The run-walking mapping
    // must now make blockText.slice(start,end) === selectedText.
    const MULTI = fillOnce({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "alpha line" }] },
            { type: "paragraph", content: [{ type: "text", text: "beta line" }] },
          ],
        },
      ],
    });
    const bqId = firstBlockIdOfType(MULTI, "blockquote");
    const [from, to] = absRangeOfSubstring(MULTI, bqId, "beta");
    const loc = resolveSelectionLocation(stateWithSelection(MULTI, from, to));
    expect(loc?.blockIds).toEqual([bqId]);
    expect(loc?.crossBlock).toBe(false);
    expect(loc?.selectedText).toBe("beta");
    expect(loc?.startOffset).toBe(10);
    expect(loc?.endOffset).toBe(14);
    const text = blockTextOf(MULTI, bqId);
    expect(text.slice(loc?.startOffset ?? -1, loc?.endOffset ?? -1)).toBe("beta");
  });

  it("offsets are TRUE textContent indices when selecting in the SECOND paragraph of a list item", () => {
    // A list item may contain multiple paragraphs (permitted by the schema); its
    // textContent concatenates them with no separator. Selecting in the second
    // paragraph must still slice to the selected text.
    const MULTI = fillOnce({
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "first para" }] },
                { type: "paragraph", content: [{ type: "text", text: "second para" }] },
              ],
            },
          ],
        },
      ],
    });
    const liId = firstBlockIdOfType(MULTI, "listItem");
    const [from, to] = absRangeOfSubstring(MULTI, liId, "second");
    const loc = resolveSelectionLocation(stateWithSelection(MULTI, from, to));
    expect(loc?.blockIds).toEqual([liId]);
    expect(loc?.crossBlock).toBe(false);
    expect(loc?.selectedText).toBe("second");
    const text = blockTextOf(MULTI, liId);
    // "first parasecond para" → "second" starts at index 10.
    expect(loc?.startOffset).toBe(10);
    expect(loc?.endOffset).toBe(16);
    expect(text.slice(loc?.startOffset ?? -1, loc?.endOffset ?? -1)).toBe("second");
  });

  /**
   * A nested list: an OUTER list item with its own leading paragraph text PLUS a
   * nested sub-`bulletList` whose INNER list item carries its own id. The outer
   * row's node span CONTAINS the inner row's span, which is the configuration the
   * source-lineage corruption bug lived in: a naive node-span overlap walk collects
   * BOTH rows for any selection touching the inner row, while the endpoint offsets
   * are resolved against the INNERMOST row — producing an internally inconsistent
   * anchor (blockIds[0] = OUTER, startOffset = an INNER offset). The consumer
   * (apps/web .../useHighlights) then writes the range over the WRONG text in the
   * OUTER block. These tests assert the FULL shape so that inconsistency cannot
   * return.
   */
  const NESTED_SUBLIST = fillOnce({
    type: "doc",
    content: [
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "outer header text" }] },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      { type: "paragraph", content: [{ type: "text", text: "inner body" }] },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const NESTED_OUTER_ID = firstBlockIdOfType(NESTED_SUBLIST, "listItem");
  const NESTED_INNER_ID = blockIdsOf(NESTED_SUBLIST).find((id) => id !== NESTED_OUTER_ID);

  it("a selection WHOLLY inside a nested sub-list row resolves ONLY the inner row", () => {
    // Regression for the source-lineage corruption: selecting "body" — which lives
    // entirely inside the inner row — must NOT drag in the outer (ancestor) row.
    if (!NESTED_INNER_ID) throw new Error("expected an inner list-item id");
    // The OUTER row is genuinely a multi-run block whose textContent flattens both.
    expect(blockTextOf(NESTED_SUBLIST, NESTED_OUTER_ID)).toBe("outer header textinner body");
    expect(blockTextOf(NESTED_SUBLIST, NESTED_INNER_ID)).toBe("inner body");

    const [from, to] = absRangeOfSubstring(NESTED_SUBLIST, NESTED_INNER_ID, "body");
    const loc = resolveSelectionLocation(stateWithSelection(NESTED_SUBLIST, from, to));

    // FULL shape — every field that the old test omitted and the bug corrupted:
    expect(loc?.blockIds).toEqual([NESTED_INNER_ID]); // NOT [OUTER, INNER]
    expect(loc?.crossBlock).toBe(false); // NOT a falsely-true cross-block span
    expect(loc?.selectedText).toBe("body");
    // The two consistency guards: BOTH blockIds[0] AND blockIds.at(-1) (here the
    // same single id) slice the verbatim selection out of their OWN text.
    const first = loc?.blockIds[0] as string;
    const last = loc?.blockIds.at(-1) as string;
    expect(blockTextOf(NESTED_SUBLIST, first).slice(loc?.startOffset, loc?.endOffset)).toBe(
      loc?.selectedText,
    );
    expect(blockTextOf(NESTED_SUBLIST, last).slice(loc?.startOffset, loc?.endOffset)).toBe(
      loc?.selectedText,
    );
    // "inner body": "body" is at chars 6..10.
    expect(loc?.startOffset).toBe(6);
    expect(loc?.endOffset).toBe(10);
  });

  it("a selection from the OUTER row's text into a nested inner row spans both, endpoints anchored", () => {
    // A genuine cross-nesting-level selection (start in the outer row's OWN text,
    // end inside the nested inner row) must return BOTH rows in document order with
    // startOffset measured against blockIds[0] (the OUTER row) and endOffset against
    // blockIds.at(-1) (the INNER row) — never the inverted/mismatched pairing the
    // bug produced. The consumer applies startOffset..end to the first block and
    // 0..endOffset to the last, so the endpoint↔block pairing must hold.
    if (!NESTED_INNER_ID) throw new Error("expected an inner list-item id");
    const [from] = absRangeOfSubstring(NESTED_SUBLIST, NESTED_OUTER_ID, "header");
    const [, to] = absRangeOfSubstring(NESTED_SUBLIST, NESTED_INNER_ID, "body");
    const loc = resolveSelectionLocation(stateWithSelection(NESTED_SUBLIST, from, to));

    expect(loc?.blockIds).toEqual([NESTED_OUTER_ID, NESTED_INNER_ID]);
    expect(loc?.crossBlock).toBe(true);
    // blockIds[0] is the OUTER row and startOffset indexes IT.
    expect(loc?.blockIds[0]).toBe(NESTED_OUTER_ID);
    expect(blockTextOf(NESTED_SUBLIST, NESTED_OUTER_ID).slice(loc?.startOffset)).toMatch(
      /^header text/,
    );
    // blockIds.at(-1) is the INNER row and endOffset indexes IT.
    expect(loc?.blockIds.at(-1)).toBe(NESTED_INNER_ID);
    expect(blockTextOf(NESTED_SUBLIST, NESTED_INNER_ID).slice(0, loc?.endOffset)).toBe(
      "inner body",
    );
  });
});

describe("resolveSelectionLocation — cross-block selection", () => {
  it("includes selected image atom blocks between paragraph endpoints", () => {
    const beforeStart = textStartOf(IMAGE_DOC, "blk_before");
    const afterStart = textStartOf(IMAGE_DOC, "blk_after");

    const loc = resolveSelectionLocation(
      stateWithSelection(IMAGE_DOC, beforeStart + "Before ".length, afterStart + "After".length),
    );

    expect(loc?.blockIds).toEqual(["blk_before", "blk_image", "blk_after"]);
    expect(loc?.startOffset).toBe("Before ".length);
    expect(loc?.endOffset).toBe("After".length);
    expect(loc?.crossBlock).toBe(true);
  });

  it("returns ALL spanned block ids in document order with first/last offsets", () => {
    const aStart = textStartOf(DOC, "blk_a");
    const bStart = textStartOf(DOC, "blk_b");
    // From "paragraph here." in blk_a (offset 6) through "Second" in blk_b (offset 6).
    const loc = resolveSelectionLocation(stateWithSelection(DOC, aStart + 6, bStart + 6));
    expect(loc).not.toBeNull();
    expect(loc?.blockIds).toEqual(["blk_a", "blk_b"]);
    expect(loc?.startOffset).toBe(6); // into blk_a
    expect(loc?.endOffset).toBe(6); // into blk_b
    expect(loc?.crossBlock).toBe(true);
    // The snapshot joins the two paragraphs' text with a newline.
    expect(loc?.selectedText).toBe("paragraph here.\nSecond");
  });

  it("spans the heading + both paragraphs when the selection covers all three", () => {
    const hStart = textStartOf(DOC, "blk_h");
    const bStart = textStartOf(DOC, "blk_b");
    const loc = resolveSelectionLocation(
      stateWithSelection(DOC, hStart, bStart + "Second paragraph.".length),
    );
    expect(loc?.blockIds).toEqual(["blk_h", "blk_a", "blk_b"]);
    expect(loc?.crossBlock).toBe(true);
  });
});

describe("resolveSelectionLocation — nothing-to-act-on cases", () => {
  it("returns null for an empty (collapsed caret) selection", () => {
    const start = textStartOf(DOC, "blk_a");
    expect(resolveSelectionLocation(stateWithSelection(DOC, start, start))).toBeNull();
  });

  it("returns null when the selection is not inside an id'd block", () => {
    const empty = { type: "doc", content: [{ type: "paragraph" }] };
    // The single empty paragraph has no blockId, so there is no anchor to resolve.
    const doc = PmNode.fromJSON(schema, empty);
    const state = EditorState.create({ schema, doc });
    // A whole-doc selection over an un-id'd block resolves no block id.
    const selected = state.apply(
      state.tr.setSelection(TextSelection.create(doc, 0, doc.content.size)),
    );
    expect(resolveSelectionLocation(selected)).toBeNull();
  });
});
