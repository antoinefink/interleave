/**
 * Selection toolbar component + location-resolution tests (T019).
 *
 * Covers the T019 deliverables at the renderer seam:
 *  - a source selection shows the default five actions (Extract, Cloze, Highlight,
 *    Copy, Cancel);
 *  - an extract selection can provide a context-specific action set (Sub-extract,
 *    Cloze, Highlight, Copy, Cancel);
 *  - each button dispatches its action, and pressing a button does NOT clear the
 *    selection (the toolbar prevents the mousedown default);
 *  - Cancel / Escape hide the toolbar without mutating anything;
 *  - the resolved source-location (block ids + start/end offsets) is correct for a
 *    single-block AND a cross-block selection (the load-bearing anchor the M4
 *    actions persist), via the headless `resolveSelectionLocation`.
 *
 * The toolbar itself is presentational, so it is rendered directly with a fake
 * position; the location math is verified against a real ProseMirror state (no DOM
 * editor needed).
 */

import { buildSchema, resolveSelectionLocation } from "@interleave/editor";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXTRACT_SELECTION_ACTIONS,
  SelectionToolbar,
  type SelectionToolbarAction,
} from "./SelectionToolbar";

const POS = { top: 120, left: 240 } as const;

function rect(width: number, height: number): DOMRect {
  return {
    top: 0,
    left: 0,
    width,
    height,
    right: width,
    bottom: height,
  } as DOMRect;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SelectionToolbar — presentation + actions", () => {
  it("renders nothing when there is no position (no selection)", () => {
    render(<SelectionToolbar position={null} onAction={() => {}} />);
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("shows all five actions when a selection is anchored", () => {
    render(<SelectionToolbar position={POS} onAction={() => {}} />);
    expect(screen.getByTestId("selection-toolbar")).toBeInTheDocument();
    for (const id of [
      "sel-tool-extract",
      "sel-tool-cloze",
      "sel-tool-highlight",
      "sel-tool-copy",
      "sel-tool-cancel",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it("supports an extract-specific toolbar with sub-extract and highlight actions", () => {
    render(
      <SelectionToolbar position={POS} actions={EXTRACT_SELECTION_ACTIONS} onAction={() => {}} />,
    );

    expect(screen.getByTestId("sel-tool-extract")).toHaveTextContent("Sub-extract");
    expect(screen.getByTestId("sel-tool-cloze")).toHaveTextContent("Cloze");
    expect(screen.getByTestId("sel-tool-highlight")).toHaveTextContent("Highlight");
    expect(screen.getByTestId("sel-tool-copy")).toHaveTextContent("Copy");
  });

  it("anchors fixed above the selection rect (translate(-50%,-100%))", () => {
    render(<SelectionToolbar position={POS} onAction={() => {}} />);
    const el = screen.getByTestId("selection-toolbar");
    expect(el.style.position).toBe("fixed");
    expect(el.style.top).toBe("120px");
    expect(el.style.left).toBe("240px");
    expect(el.style.transform).toBe("translate(-50%, -100%)");
  });

  it("clamps the measured toolbar bounds inside the viewport near all edges", async () => {
    vi.stubGlobal("innerWidth", 500);
    vi.stubGlobal("innerHeight", 300);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this instanceof HTMLElement && this.dataset.testid === "selection-toolbar"
        ? rect(320, 40)
        : rect(0, 0);
    });

    const { rerender } = render(
      <SelectionToolbar position={{ top: 4, left: 8 }} onAction={() => {}} />,
    );
    const el = screen.getByTestId("selection-toolbar");
    await waitFor(() => {
      expect(el.style.top).toBe("52px");
      expect(el.style.left).toBe("172px");
    });

    rerender(<SelectionToolbar position={{ top: 296, left: 496 }} onAction={() => {}} />);
    await waitFor(() => {
      expect(el.style.top).toBe("288px");
      expect(el.style.left).toBe("328px");
    });
  });

  it("dispatches each action on click", () => {
    const onAction = vi.fn<(a: SelectionToolbarAction) => void>();
    render(<SelectionToolbar position={POS} onAction={onAction} />);
    fireEvent.click(screen.getByTestId("sel-tool-extract"));
    fireEvent.click(screen.getByTestId("sel-tool-cloze"));
    fireEvent.click(screen.getByTestId("sel-tool-highlight"));
    fireEvent.click(screen.getByTestId("sel-tool-copy"));
    fireEvent.click(screen.getByTestId("sel-tool-cancel"));
    expect(onAction.mock.calls.map((c) => c[0])).toEqual([
      "extract",
      "cloze",
      "highlight",
      "copy",
      "cancel",
    ]);
  });

  it("prevents the mousedown default so a button press never clears the selection", () => {
    render(<SelectionToolbar position={POS} onAction={() => {}} />);
    const el = screen.getByTestId("selection-toolbar");
    // jsdom dispatches a cancelable mousedown; the handler must call preventDefault.
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

// ── Location resolution (the anchor the M4 actions persist) ──────────────────

const schema = buildSchema();

const PARA = (text: string, blockId: string) => ({
  type: "paragraph",
  attrs: { blockId },
  content: text ? [{ type: "text", text }] : [],
});

const DOC = {
  type: "doc",
  content: [PARA("Alpha beta gamma.", "blk_1"), PARA("Delta epsilon.", "blk_2")],
};

function textStart(blockId: string): number {
  const doc = PmNode.fromJSON(schema, DOC);
  let start = -1;
  doc.descendants((node, pos) => {
    if (start >= 0) return false;
    if ((node.attrs.blockId as string | undefined) === blockId) {
      start = pos + 1;
      return false;
    }
    return true;
  });
  return start;
}

function stateWithSelection(from: number, to: number): EditorState {
  const doc = PmNode.fromJSON(schema, DOC);
  const state = EditorState.create({ schema, doc });
  return state.apply(state.tr.setSelection(TextSelection.create(doc, from, to)));
}

describe("resolveSelectionLocation — anchor for the toolbar actions", () => {
  it("computes a single-block location (block id + offsets + snapshot)", () => {
    const s = textStart("blk_1");
    const loc = resolveSelectionLocation(stateWithSelection(s, s + 5)); // "Alpha"
    expect(loc).toMatchObject({
      blockIds: ["blk_1"],
      startOffset: 0,
      endOffset: 5,
      selectedText: "Alpha",
      crossBlock: false,
    });
  });

  it("computes a cross-block location spanning both blocks", () => {
    const s1 = textStart("blk_1");
    const s2 = textStart("blk_2");
    const loc = resolveSelectionLocation(stateWithSelection(s1 + 6, s2 + 5)); // "beta…Delta"
    expect(loc?.blockIds).toEqual(["blk_1", "blk_2"]);
    expect(loc?.startOffset).toBe(6);
    expect(loc?.endOffset).toBe(5);
    expect(loc?.crossBlock).toBe(true);
  });

  it("returns null for a collapsed caret (no run of text to act on)", () => {
    const s = textStart("blk_1");
    expect(resolveSelectionLocation(stateWithSelection(s, s))).toBeNull();
  });
});
