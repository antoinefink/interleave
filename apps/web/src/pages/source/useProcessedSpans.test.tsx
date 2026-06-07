import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentMarkPayload } from "../../lib/appApi";

const h = vi.hoisted(() => ({
  desktop: true,
  listDocumentMarks: vi.fn(),
  addDocumentMark: vi.fn(),
  removeDocumentMark: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      listDocumentMarks: h.listDocumentMarks,
      addDocumentMark: h.addDocumentMark,
      removeDocumentMark: h.removeDocumentMark,
    },
  };
});

import { useProcessedSpans } from "./useProcessedSpans";

function mark(id: string, blockId: string): DocumentMarkPayload {
  return {
    id,
    elementId: "src-1",
    blockId,
    markType: "processed_span",
    range: [0, Number.MAX_SAFE_INTEGER],
    attrs: null,
  };
}

beforeEach(() => {
  h.desktop = true;
  h.listDocumentMarks.mockReset();
  h.addDocumentMark.mockReset();
  h.removeDocumentMark.mockReset();
  h.listDocumentMarks.mockResolvedValue({ marks: [mark("m-1", "blk-a")] });
  h.addDocumentMark.mockResolvedValue({ mark: mark("m-new", "blk-b") });
  h.removeDocumentMark.mockResolvedValue({ removed: true });
});

describe("useProcessedSpans", () => {
  it("loads processed-span marks and exposes lookup helpers", async () => {
    const { result } = renderHook(() => useProcessedSpans("src-1"));

    await waitFor(() =>
      expect(result.current.processed).toEqual([{ markId: "m-1", blockId: "blk-a" }]),
    );
    expect(h.listDocumentMarks).toHaveBeenCalledWith({
      elementId: "src-1",
      markType: "processed_span",
    });
    expect(result.current.isProcessed("blk-a")).toBe(true);
    expect(result.current.isProcessed("blk-b")).toBe(false);
    expect(result.current.markIdFor("blk-a")).toBe("m-1");
    expect(result.current.markIdFor("blk-b")).toBeNull();
  });

  it("marks an unprocessed block with a whole-block range and refreshes", async () => {
    h.listDocumentMarks.mockResolvedValueOnce({ marks: [] }).mockResolvedValueOnce({
      marks: [mark("m-new", "blk-b")],
    });
    const { result } = renderHook(() => useProcessedSpans("src-1"));
    await waitFor(() => expect(h.listDocumentMarks).toHaveBeenCalledTimes(1));

    let marked = false;
    await act(async () => {
      marked = await result.current.mark("blk-b");
    });

    expect(marked).toBe(true);
    expect(h.addDocumentMark).toHaveBeenCalledWith({
      elementId: "src-1",
      blockId: "blk-b",
      markType: "processed_span",
      range: [0, Number.MAX_SAFE_INTEGER],
    });
    expect(h.listDocumentMarks).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate an already processed block and toggles restore", async () => {
    const { result } = renderHook(() => useProcessedSpans("src-1"));
    await waitFor(() => expect(result.current.isProcessed("blk-a")).toBe(true));

    let marked = false;
    await act(async () => {
      marked = await result.current.mark("blk-a");
    });
    expect(marked).toBe(true);
    expect(h.addDocumentMark).not.toHaveBeenCalled();

    let toggled: "marked" | "restored" | null = null;
    await act(async () => {
      toggled = await result.current.toggle("blk-a");
    });
    expect(toggled).toBe("restored");
    expect(h.removeDocumentMark).toHaveBeenCalledWith({ markId: "m-1" });
  });

  it("returns a failed toggle result and exposes the mutation error", async () => {
    h.listDocumentMarks.mockResolvedValueOnce({ marks: [] });
    h.addDocumentMark.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useProcessedSpans("src-1"));
    await waitFor(() => expect(h.listDocumentMarks).toHaveBeenCalledTimes(1));

    let toggled: "marked" | "restored" | null = "marked";
    await act(async () => {
      toggled = await result.current.toggle("blk-b");
    });

    expect(toggled).toBeNull();
    expect(result.current.error).toBe("disk full");
  });

  it("does not call IPC outside desktop mode", () => {
    h.desktop = false;
    const { result } = renderHook(() => useProcessedSpans("src-1"));

    expect(result.current.processed).toEqual([]);
    expect(h.listDocumentMarks).not.toHaveBeenCalled();
  });
});
