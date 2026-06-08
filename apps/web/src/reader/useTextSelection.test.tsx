/**
 * `useTextSelection` hook tests (T019).
 *
 * Verifies the reader's selection seam: a ≥3-char selection inside the editor
 * surfaces a toolbar anchor + resolved location on mouseup, Escape dismisses it
 * without mutating the document, and the document/selection are only ever READ.
 *
 * The hook reads `editor.state` (a real ProseMirror `EditorState`) and the DOM
 * selection rects, so the test stands up a real state behind a minimal fake editor
 * and stubs `window.getSelection()` to return a range with visible client rects.
 */

import { buildSchema, type Editor } from "@interleave/editor";
import { act, renderHook } from "@testing-library/react";
import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTextSelection } from "./useTextSelection";

const schema = buildSchema();
const DOC = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      attrs: { blockId: "blk_1" },
      content: [{ type: "text", text: "Alpha beta gamma." }],
    },
  ],
};

/** A minimal fake Tiptap editor exposing the `.state`, `.view.dom`, and `.isFocused` the hook reads. */
function fakeEditor(from: number, to: number): { editor: Editor; selectedNode: Text } {
  const doc = PmNode.fromJSON(schema, DOC);
  let state = EditorState.create({ schema, doc });
  state = state.apply(state.tr.setSelection(TextSelection.create(doc, from, to)));
  const editorDom = document.createElement("div");
  const selectedNode = document.createTextNode("Alpha beta gamma.");
  editorDom.append(selectedNode);
  document.body.append(editorDom);

  return {
    editor: { state, isFocused: true, view: { dom: editorDom } } as unknown as Editor,
    selectedNode,
  };
}

type TestRect = Pick<DOMRect, "top" | "left" | "right" | "bottom" | "width" | "height">;

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
  } as DOMRect;
}

function rectList(rects: readonly TestRect[]): DOMRectList {
  return {
    length: rects.length,
    item: (index: number) => (rects[index] as DOMRect | undefined) ?? null,
    [Symbol.iterator]: function* () {
      for (const r of rects) yield r as DOMRect;
    },
  } as DOMRectList;
}

/** Stub the DOM selection so the hook can read selection geometry on mouseup. */
function stubDomSelection(
  anchorNode: Node,
  options: { bounding?: DOMRect; clientRects?: readonly DOMRect[] } = {},
) {
  const bounding = options.bounding ?? rect(100, 200, 80, 18);
  const clientRects = options.clientRects ?? [bounding];
  const range = {
    getBoundingClientRect: () => bounding,
    getClientRects: () => rectList(clientRects),
  };
  vi.spyOn(window, "getSelection").mockReturnValue({
    rangeCount: 1,
    anchorNode,
    focusNode: anchorNode,
    getRangeAt: () => range,
  } as unknown as Selection);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useTextSelection", () => {
  beforeEach(() => {
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
  });

  it("surfaces a position + location for a ≥3-char selection on mouseup", () => {
    vi.useFakeTimers();
    // "Alpha" = positions 1..6 inside the single paragraph.
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode);
    const { result } = renderHook(() => useTextSelection(editor, true));

    expect(result.current.position).toBeNull();
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });
    expect(result.current.position).toEqual({ top: 92, left: 240 }); // top-8, left+width/2
    expect(result.current.location?.blockIds).toEqual(["blk_1"]);
    expect(result.current.location?.selectedText).toBe("Alpha");
  });

  it("anchors a huge multi-viewport selection to a visible client rect, not the off-screen union rect", () => {
    vi.useFakeTimers();
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode, {
      // The failure mode: the union rect starts far above the current viewport.
      bounding: rect(-1400, 180, 620, 1800),
      clientRects: [rect(-1400, 180, 620, 20), rect(-40, 180, 620, 20), rect(420, 180, 620, 20)],
    });
    const { result } = renderHook(() => useTextSelection(editor, true));

    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });

    expect(result.current.position).toEqual({ top: 412, left: 490 });
  });

  it("uses the first positively visible client rect for a huge selection", () => {
    vi.useFakeTimers();
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode, {
      bounding: rect(-1200, 180, 620, 1800),
      clientRects: [
        rect(-2, 180, 620, 20),
        // Taller, but lower: the toolbar belongs to the first visible line.
        rect(420, 180, 620, 80),
      ],
    });
    const { result } = renderHook(() => useTextSelection(editor, true));

    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });

    expect(result.current.position).toEqual({ top: 12, left: 490 });
  });

  it("ignores zero-size client rects when choosing the visible anchor", () => {
    vi.useFakeTimers();
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode, {
      bounding: rect(-600, 50, 300, 900),
      clientRects: [rect(0, 0, 0, 0), rect(180, 210, 120, 18)],
    });
    const { result } = renderHook(() => useTextSelection(editor, true));

    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });

    expect(result.current.position).toEqual({ top: 172, left: 270 });
  });

  it("clamps a visible near-edge selection anchor point into the viewport", () => {
    vi.useFakeTimers();
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode, {
      bounding: rect(6, -40, 20, 16),
      clientRects: [rect(6, -40, 20, 16)],
    });
    const { result } = renderHook(() => useTextSelection(editor, true));

    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });

    expect(result.current.position).toEqual({ top: 12, left: 12 });
  });

  it("keeps toolbar anchors in viewport coordinates when window and reader scrollers are non-zero", () => {
    vi.useFakeTimers();
    vi.stubGlobal("scrollY", 9000);
    const { editor, selectedNode } = fakeEditor(1, 6);
    const scroller = document.createElement("div");
    scroller.className = "reader-page";
    scroller.scrollTop = 3200;
    document.body.append(scroller);
    stubDomSelection(selectedNode, {
      bounding: rect(260, 220, 100, 18),
      clientRects: [rect(260, 220, 100, 18)],
    });
    const { result } = renderHook(() => useTextSelection(editor, true));

    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });

    expect(result.current.position).toEqual({ top: 252, left: 270 });
  });

  it("Escape dismisses the toolbar", () => {
    vi.useFakeTimers();
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode);
    const { result } = renderHook(() => useTextSelection(editor, true));
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });
    expect(result.current.position).not.toBeNull();

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.position).toBeNull();
    expect(result.current.location).toBeNull();
  });

  it("does not reopen after dismissing while a deferred mouseup recompute is pending", () => {
    vi.useFakeTimers();
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode);
    const { result } = renderHook(() => useTextSelection(editor, true));
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });
    expect(result.current.position).not.toBeNull();

    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      result.current.dismiss();
      vi.runAllTimers();
    });

    expect(result.current.position).toBeNull();
    expect(result.current.location).toBeNull();
  });

  it("ignores toolbar-originated mouseup events so action clicks cannot reopen it", () => {
    vi.useFakeTimers();
    const { editor, selectedNode } = fakeEditor(1, 6);
    stubDomSelection(selectedNode);
    const toolbar = document.createElement("div");
    toolbar.dataset.testid = "selection-toolbar";
    document.body.append(toolbar);
    const { result } = renderHook(() => useTextSelection(editor, true));
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });
    expect(result.current.position).not.toBeNull();

    act(() => {
      result.current.dismiss();
      toolbar.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      vi.runAllTimers();
    });

    expect(result.current.position).toBeNull();
    expect(result.current.location).toBeNull();
  });

  it("does not show the toolbar for a sub-3-char selection", () => {
    vi.useFakeTimers();
    // "Al" = positions 1..3 → 2 chars, below the threshold.
    const { editor, selectedNode } = fakeEditor(1, 3);
    stubDomSelection(selectedNode);
    const { result } = renderHook(() => useTextSelection(editor, true));
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });
    expect(result.current.position).toBeNull();
  });

  it("does not anchor the toolbar to a selection outside the editor, such as a quality check row", () => {
    vi.useFakeTimers();
    const { editor } = fakeEditor(1, 6);
    const qualityCheck = document.createElement("div");
    qualityCheck.className = "qc qc--warn";
    qualityCheck.textContent =
      "Nearly identical to another card — they may interfere; merge or differentiate";
    document.body.append(qualityCheck);
    const qualityText = qualityCheck.firstChild;
    if (!qualityText) throw new Error("Expected quality-check text node.");
    stubDomSelection(qualityText);

    const { result } = renderHook(() => useTextSelection(editor, true));
    act(() => {
      window.dispatchEvent(new MouseEvent("mouseup"));
      vi.runAllTimers();
    });

    expect(result.current.position).toBeNull();
    expect(result.current.location).toBeNull();
  });
});
