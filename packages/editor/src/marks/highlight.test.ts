/**
 * Highlight mark extension tests (T020).
 *
 * The highlight mark renders `<mark class="hl">` and exposes set/toggle/unset
 * commands that delegate to ProseMirror's `addMark`/`removeMark` (applied through
 * Tiptap COMMANDS, never DOM surgery — the prototype's `range.surroundContents` is
 * forbidden, so undo + serialization stay correct). These run HEADLESSLY (no DOM,
 * matching the sibling `reader-decorations` / `selection-location` tests) against a
 * real ProseMirror schema built from the constrained extension set PLUS the
 * {@link Highlight} mark: they assert the mark is in the schema, applies/removes
 * over a selection range, and round-trips to/from `<mark class="hl">` HTML.
 */

import { DOMParser as PmDOMParser, Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { buildSchema } from "../schema";
import { HIGHLIGHT_MARK_CLASS, HIGHLIGHT_MARK_NAME, Highlight } from "./highlight";

// The constrained schema PLUS the highlight mark, built via the package's own
// `buildSchema` so a single prosemirror-model instance is used (mixing compile
// paths loads two copies and throws).
const schema = buildSchema([Highlight]);

const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "b1" },
      content: [{ type: "text", text: "the quick brown fox" }],
    },
  ],
};

/** Build a headless EditorState over the constrained-plus-highlight schema. */
function buildState(): EditorState {
  return EditorState.create({ schema, doc: PmNode.fromJSON(schema, DOC) });
}

/** The highlight mark type from the schema (asserted present). */
function highlightMark() {
  const markType = schema.marks[HIGHLIGHT_MARK_NAME];
  if (!markType) throw new Error("highlight mark missing from schema");
  return markType;
}

describe("Highlight mark", () => {
  it("registers the `highlight` mark in the schema", () => {
    expect(schema.marks[HIGHLIGHT_MARK_NAME]).toBeDefined();
  });

  it("applies the highlight mark over a selection range (addMark)", () => {
    const state = buildState();
    const markType = highlightMark();
    // Select "quick" (positions 5..10 in the paragraph text).
    const tr = state.tr.setSelection(TextSelection.create(state.doc, 5, 10));
    tr.addMark(5, 10, markType.create());
    const next = state.apply(tr);
    // The selected text now carries the highlight mark.
    expect(next.doc.rangeHasMark(5, 10, markType)).toBe(true);
    expect(next.doc.rangeHasMark(1, 4, markType)).toBe(false);
  });

  it("removes the highlight mark over a selection range (removeMark)", () => {
    const markType = highlightMark();
    let state = buildState();
    state = state.apply(state.tr.addMark(5, 10, markType.create()));
    expect(state.doc.rangeHasMark(5, 10, markType)).toBe(true);
    state = state.apply(state.tr.removeMark(5, 10, markType));
    expect(state.doc.rangeHasMark(5, 10, markType)).toBe(false);
  });

  it('renders the highlight to a `<mark class="hl">` DOM spec (toDOM)', () => {
    const markType = highlightMark();
    // The mark's `toDOM` (derived from the extension's `renderHTML`) emits
    // `["mark", { class: "hl" }, 0]` — a `<mark class="hl">` wrapper. We inspect
    // the spec output structurally so this stays DOM-free (node env, no jsdom).
    const spec = markType.spec.toDOM?.(markType.create(), false);
    expect(Array.isArray(spec)).toBe(true);
    const out = spec as [string, Record<string, string>, number];
    expect(out[0]).toBe("mark");
    expect(out[1].class).toBe(HIGHLIGHT_MARK_CLASS);
  });

  it('parses `<mark class="hl">` HTML back into the highlight mark', () => {
    const div = (globalThis as { document?: Document }).document
      ? document.createElement("div")
      : null;
    if (!div) {
      // No DOM in this environment — parse coverage is exercised by the apps/web
      // jsdom component test; assert the mark's parseHTML rule targets `mark.hl`.
      expect(schema.marks[HIGHLIGHT_MARK_NAME]?.spec.parseDOM?.[0]?.tag).toBe("mark.hl");
      return;
    }
    div.innerHTML = '<p>the <mark class="hl">quick</mark> fox</p>';
    const parsed = PmDOMParser.fromSchema(schema).parse(div);
    const markType = highlightMark();
    let found = false;
    parsed.descendants((node) => {
      if (node.marks.some((m) => m.type === markType)) found = true;
      return true;
    });
    expect(found).toBe(true);
  });
});
