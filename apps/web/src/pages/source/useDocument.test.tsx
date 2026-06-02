/**
 * `useDocument` hook tests (T015 — hardening).
 *
 * `useDocument` is the renderer's load/save seam for a source body: it loads the
 * document on mount via `appApi.getDocument`, exposes the body to the editor, and
 * persists edits debounced via `appApi.saveDocument`. The editor/document math
 * lives in `@interleave/editor`; the hook only orchestrates UI state + the typed
 * `window.appApi` bridge (no SQLite/Node/fs).
 *
 * These guard the orchestration the package tests can't reach — especially the
 * CROSS-SOURCE STALE-SAVE invariant: because the `/source/$id` route reuses one
 * `SourceReader` (and one `useDocument`) across param changes, a save queued for
 * source A must NEVER be written under source B's id when the user navigates
 * between sources within the debounce window. The id is snapshotted at enqueue
 * time and an element switch flushes A's pending edit onto A's own row first.
 *
 * Collaborators are mocked so the test exercises ONLY the hook's wiring: `appApi`
 * is a fake recording its `saveDocument` calls, and `isDesktop()` is forced true.
 */

import type { SourceEditorChange } from "@interleave/editor";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentsGetResult, DocumentsSaveRequest } from "../../lib/appApi";

const h = vi.hoisted(() => ({
  getDocument: vi.fn(),
  saveDocument: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      getDocument: h.getDocument,
      saveDocument: h.saveDocument,
    },
  };
});

import { useDocument } from "./useDocument";

/** A minimal valid ProseMirror body with one id'd block. */
function body(text: string, blockId: string): unknown {
  return {
    type: "doc",
    content: [{ type: "paragraph", attrs: { blockId }, content: [{ type: "text", text }] }],
  };
}

/** The `getDocument` payload for a source whose body is `text`. */
function getResult(text: string, blockId: string): DocumentsGetResult {
  return {
    document: {
      prosemirrorJson: body(text, blockId),
      plainText: text,
      schemaVersion: 1,
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
    extractedBlockIds: [],
    sourceFormat: null,
    mediaSource: null,
    mediaKind: null,
    blockPages: {},
    blockTimestamps: {},
  };
}

/** A `SourceEditorChange` carrying a body + plain text. */
function change(text: string, blockId: string): SourceEditorChange {
  return { prosemirrorJson: body(text, blockId), plainText: text };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every source loads instantly with a tiny body.
  h.getDocument.mockResolvedValue(getResult("loaded", "blk_x"));
  h.saveDocument.mockImplementation(async (req: DocumentsSaveRequest) => ({
    document: {
      prosemirrorJson: req.prosemirrorJson,
      plainText: req.plainText,
      schemaVersion: 1,
      updatedAt: "2026-05-30T00:00:00.000Z",
    },
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useDocument — load", () => {
  it("loads the document on mount and reaches `ready`", async () => {
    h.getDocument.mockResolvedValueOnce(getResult("hello", "blk_a"));
    const { result } = renderHook(() => useDocument("src-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(h.getDocument).toHaveBeenCalledWith({ elementId: "src-a" });
    expect(result.current.plainText).toBe("hello");
  });
});

describe("useDocument — debounced save", () => {
  it("coalesces rapid changes into a single save of the last change", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDocument("src-a"));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync(); // resolve the load
    });

    act(() => {
      result.current.save(change("one", "blk_a"));
      result.current.save(change("two", "blk_a"));
      result.current.save(change("three", "blk_a"));
    });
    // Nothing written yet — still inside the debounce window.
    expect(h.saveDocument).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(h.saveDocument).toHaveBeenCalledTimes(1);
    expect(h.saveDocument).toHaveBeenCalledWith(
      expect.objectContaining({ elementId: "src-a", plainText: "three" }),
    );
  });

  it("flush-on-unmount persists the last pending change", async () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useDocument("src-a"));
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.save(change("draft", "blk_a"));
    });
    expect(h.saveDocument).not.toHaveBeenCalled();

    // Unmount BEFORE the debounce fires — the trailing edit must still be saved.
    await act(async () => {
      unmount();
    });
    expect(h.saveDocument).toHaveBeenCalledTimes(1);
    expect(h.saveDocument).toHaveBeenCalledWith(
      expect.objectContaining({ elementId: "src-a", plainText: "draft" }),
    );
  });
});

describe("useDocument — cross-source stale save (the load-bearing invariant)", () => {
  it("a save enqueued for source A is NEVER written under source B's id after the element switches", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDocument(id), {
      initialProps: { id: "src-a" },
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync(); // load A
    });

    // Edit A, then navigate to B WITHIN the debounce window (no remount — the route
    // reuses the hook; only the elementId prop changes).
    act(() => {
      result.current.save(change("A body", "blk_a"));
    });
    expect(h.saveDocument).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ id: "src-b" });
      await vi.runOnlyPendingTimersAsync(); // run the switch flush + B's load
    });

    // The pending edit must have landed on A (the element switch flushed it onto
    // A's own row) and must NEVER have been written under B's id.
    const calls = h.saveDocument.mock.calls.map((c) => c[0] as DocumentsSaveRequest);
    const wroteToB = calls.find((req) => req.elementId === "src-b");
    expect(wroteToB).toBeUndefined();
    const wroteAToA = calls.find((req) => req.elementId === "src-a" && req.plainText === "A body");
    expect(wroteAToA).toBeDefined();
  });

  it("a save still in the debounce timer when the element switches fires under A's id, not B's", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ id }: { id: string }) => useDocument(id), {
      initialProps: { id: "src-a" },
    });
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    act(() => {
      result.current.save(change("A late body", "blk_a"));
    });

    // Switch to B but do NOT advance far enough for the switch-flush to be skipped:
    // the switch itself flushes A's pending change synchronously onto A.
    await act(async () => {
      rerender({ id: "src-b" });
      await vi.advanceTimersByTimeAsync(1000); // well past any debounce window
    });

    const calls = h.saveDocument.mock.calls.map((c) => c[0] as DocumentsSaveRequest);
    expect(calls.some((r) => r.elementId === "src-b")).toBe(false);
    expect(calls.some((r) => r.elementId === "src-a" && r.plainText === "A late body")).toBe(true);
    // And exactly once — the switch-flush must not double-write A.
    expect(calls.filter((r) => r.plainText === "A late body")).toHaveLength(1);
  });
});

describe("useDocument — markExtracted", () => {
  it("merges new extracted block ids idempotently", async () => {
    const { result } = renderHook(() => useDocument("src-a"));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => result.current.markExtracted(["blk_1", "blk_2"]));
    expect([...result.current.extractedBlockIds].sort()).toEqual(["blk_1", "blk_2"]);
    act(() => result.current.markExtracted(["blk_2"])); // duplicate → no change
    expect([...result.current.extractedBlockIds].sort()).toEqual(["blk_1", "blk_2"]);
  });
});
