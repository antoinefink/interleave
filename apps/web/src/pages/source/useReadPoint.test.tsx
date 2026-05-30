/**
 * `useReadPoint` hook tests (T017 — hardening).
 *
 * `useReadPoint` is the renderer's load/set/jump seam for a read-point (a STABLE
 * block id + offset). It loads the element's read-point on mount via
 * `appApi.getReadPoint`, persists a captured point via `appApi.setReadPoint`, and
 * exposes the derived divider/progress helpers + the forward-only auto-advance
 * guard the extraction path (T021) uses. All read-point math lives in
 * `@interleave/editor`; the hook only orchestrates UI state + the typed
 * `window.appApi` bridge (no SQLite/Node/fs).
 *
 * Collaborators are mocked so the test exercises ONLY the hook's wiring: `appApi`
 * is a fake recording `setReadPoint`, `isDesktop()` is forced true, and a real
 * ProseMirror `EditorState` stands behind a minimal fake editor so the package's
 * `resolveReadPointFromSelection` resolves a genuine block + offset.
 */

import { buildSchema, type Editor } from "@interleave/editor";
import { act, renderHook, waitFor } from "@testing-library/react";
import { Node as PmNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadPointGetResult, ReadPointSetRequest } from "../../lib/appApi";

const h = vi.hoisted(() => ({
  getReadPoint: vi.fn(),
  setReadPoint: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      getReadPoint: h.getReadPoint,
      setReadPoint: h.setReadPoint,
    },
  };
});

import { useReadPoint } from "./useReadPoint";

const schema = buildSchema();

/** A three-block doc (heading + two paragraphs), the same shape the package uses. */
const DOC = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1, blockId: "blk_h" },
      content: [{ type: "text", text: "Title" }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "blk_a" },
      content: [{ type: "text", text: "First paragraph." }],
    },
    {
      type: "paragraph",
      attrs: { blockId: "blk_b" },
      content: [{ type: "text", text: "Second." }],
    },
  ],
};

/** A minimal fake editor with the caret placed at an absolute doc position. */
function fakeEditor(caretPos: number): Editor {
  const doc = PmNode.fromJSON(schema, DOC);
  let state = EditorState.create({ schema, doc });
  state = state.apply(state.tr.setSelection(TextSelection.create(doc, caretPos)));
  return { state, getJSON: () => DOC } as unknown as Editor;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getReadPoint.mockResolvedValue({ readPoint: null } as ReadPointGetResult);
  h.setReadPoint.mockImplementation(async (req: ReadPointSetRequest) => ({
    readPoint: { blockId: req.blockId, offset: req.offset, updatedAt: "2026-05-30T00:00:00.000Z" },
  }));
});

afterEach(() => vi.restoreAllMocks());

describe("useReadPoint — load", () => {
  it("loads the stored read-point on mount", async () => {
    h.getReadPoint.mockResolvedValueOnce({
      readPoint: { blockId: "blk_a", offset: 4, updatedAt: "2026-05-30T00:00:00.000Z" },
    } as ReadPointGetResult);
    const { result } = renderHook(() => useReadPoint("src-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.readPoint).toEqual({ blockId: "blk_a", offset: 4 });
  });
});

describe("useReadPoint — setFromSelection", () => {
  it("captures the block id + offset at the caret and persists it through the bridge", async () => {
    const { result } = renderHook(() => useReadPoint("src-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    // Place the caret 5 chars into "First paragraph." (blk_a). The heading node
    // occupies positions 0..6, so the paragraph text starts at pos 8 → +5 = 13.
    const editor = fakeEditor(13);
    let captured: { blockId: string; offset: number } | null = null;
    await act(async () => {
      captured = await result.current.setFromSelection(editor);
    });
    expect(captured).toEqual({ blockId: "blk_a", offset: 5 });
    expect(h.setReadPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        elementId: "src-a",
        documentId: "src-a",
        blockId: "blk_a",
        offset: 5,
      }),
    );
    expect(result.current.readPoint).toEqual({ blockId: "blk_a", offset: 5 });
  });
});

describe("useReadPoint — derived helpers reflect the current read-point", () => {
  it("progressFraction reaches 100% when the read-point is on the last block", async () => {
    h.getReadPoint.mockResolvedValueOnce({
      readPoint: { blockId: "blk_b", offset: 0, updatedAt: "2026-05-30T00:00:00.000Z" },
    } as ReadPointGetResult);
    const { result } = renderHook(() => useReadPoint("src-a"));
    await waitFor(() => expect(result.current.readPoint).not.toBeNull());
    expect(result.current.progress(DOC)).toEqual({ index: 2, total: 3 });
    expect(result.current.progressFraction(DOC)).toBe(1);
  });

  it("isAtOrAfterReadPoint guards forward-only auto-advance", async () => {
    h.getReadPoint.mockResolvedValueOnce({
      readPoint: { blockId: "blk_a", offset: 0, updatedAt: "2026-05-30T00:00:00.000Z" },
    } as ReadPointGetResult);
    const { result } = renderHook(() => useReadPoint("src-a"));
    await waitFor(() => expect(result.current.readPoint).not.toBeNull());
    // blk_b is after blk_a → advance allowed; blk_h is before → blocked.
    expect(result.current.isAtOrAfterReadPoint(DOC, "blk_b")).toBe(true);
    expect(result.current.isAtOrAfterReadPoint(DOC, "blk_h")).toBe(false);
  });

  it("markReadThrough advances the read-point to the END of the given block", async () => {
    const { result } = renderHook(() => useReadPoint("src-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    const editor = fakeEditor(1);
    await act(async () => {
      await result.current.markReadThrough(editor, "blk_a");
    });
    // "First paragraph." has length 16 → offset at the end of the block.
    expect(h.setReadPoint).toHaveBeenCalledWith(
      expect.objectContaining({ blockId: "blk_a", offset: "First paragraph.".length }),
    );
  });
});
