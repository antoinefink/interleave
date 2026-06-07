import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SourceBlockProcessingSummaryPayload,
  SourceBlockProcessingViewPayload,
} from "../../lib/appApi";

const h = vi.hoisted(() => ({
  desktop: true,
  listBlockProcessing: vi.fn(),
  markBlockProcessed: vi.fn(),
  markBlockIgnored: vi.fn(),
  markBlockNeedsLater: vi.fn(),
  markBlockUnread: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      listBlockProcessing: h.listBlockProcessing,
      markBlockProcessed: h.markBlockProcessed,
      markBlockIgnored: h.markBlockIgnored,
      markBlockNeedsLater: h.markBlockNeedsLater,
      markBlockUnread: h.markBlockUnread,
    },
  };
});

import { useProcessedSpans } from "./useProcessedSpans";

function block(
  stableBlockId: string,
  state: SourceBlockProcessingViewPayload["state"],
  order = 0,
): SourceBlockProcessingViewPayload {
  return {
    sourceElementId: "src-1",
    stableBlockId,
    order,
    state,
    storedState: state,
    blockContentHash: null,
    outputElementIds: [],
    derivedFrom: "explicit",
  };
}

function summary(overrides: Partial<SourceBlockProcessingSummaryPayload> = {}) {
  return {
    sourceElementId: "src-1",
    totalBlocks: 2,
    processedBlocks: 1,
    terminalBlocks: 1,
    unresolvedBlocks: 1,
    highPriorityUnresolvedBlocks: 1,
    extractedBlockCount: 0,
    extractedOutputCount: 0,
    ignoredBlocks: 0,
    ignoredRatio: 0,
    terminalRatio: 0.5,
    staleAfterEditBlocks: 0,
    legacyProjectedBlocks: 0,
    canMarkDoneWithoutConfirmation: false,
    stateCounts: {
      unread: 1,
      read: 0,
      extracted: 0,
      ignored: 0,
      processed_without_output: 1,
      needs_later: 0,
      stale_after_edit: 0,
    },
    ...overrides,
  } satisfies SourceBlockProcessingSummaryPayload;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  h.desktop = true;
  h.listBlockProcessing.mockReset();
  h.markBlockProcessed.mockReset();
  h.markBlockIgnored.mockReset();
  h.markBlockNeedsLater.mockReset();
  h.markBlockUnread.mockReset();
  h.listBlockProcessing.mockResolvedValue({
    blocks: [block("blk-a", "processed_without_output"), block("blk-b", "unread", 1)],
    summary: summary(),
  });
  h.markBlockProcessed.mockImplementation(async (request) => ({
    block: block(request.stableBlockId, "processed_without_output", 1),
    summary: summary({ processedBlocks: 2, unresolvedBlocks: 0, terminalRatio: 1 }),
  }));
  h.markBlockIgnored.mockImplementation(async (request) => ({
    block: block(request.stableBlockId, "ignored", 1),
    summary: summary({ ignoredBlocks: 1 }),
  }));
  h.markBlockNeedsLater.mockImplementation(async (request) => ({
    block: block(request.stableBlockId, "needs_later", 1),
    summary: summary(),
  }));
  h.markBlockUnread.mockImplementation(async (request) => ({
    block: block(request.stableBlockId, "unread", 1),
    summary: summary({ processedBlocks: 0, unresolvedBlocks: 2, terminalRatio: 0 }),
  }));
});

describe("useProcessedSpans", () => {
  it("loads block-processing views and exposes decoration/lookup helpers", async () => {
    const { result } = renderHook(() => useProcessedSpans("src-1"));

    await waitFor(() =>
      expect(result.current.processed).toEqual([
        {
          markId: "bp:blk-a",
          blockId: "blk-a",
          state: "processed_without_output",
          derivedFrom: "explicit",
        },
        { markId: "bp:blk-b", blockId: "blk-b", state: "unread", derivedFrom: "explicit" },
      ]),
    );
    expect(h.listBlockProcessing).toHaveBeenCalledWith({ sourceElementId: "src-1" });
    expect(result.current.isProcessed("blk-a")).toBe(true);
    expect(result.current.isProcessed("blk-b")).toBe(false);
    expect(result.current.markIdFor("blk-a")).toBe("bp:blk-a");
    expect(result.current.stateFor("blk-b")).toBe("unread");
    expect(result.current.summary?.processedBlocks).toBe(1);
  });

  it("marks an unread block processed via blockProcessing and updates summary", async () => {
    const { result } = renderHook(() => useProcessedSpans("src-1"));
    await waitFor(() => expect(h.listBlockProcessing).toHaveBeenCalledTimes(1));

    let marked = false;
    await act(async () => {
      marked = await result.current.mark("blk-b");
    });

    expect(marked).toBe(true);
    expect(h.markBlockProcessed).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      stableBlockId: "blk-b",
    });
    expect(result.current.summary?.unresolvedBlocks).toBe(0);
  });

  it("toggles a terminal block back to unread through its synthetic id", async () => {
    const { result } = renderHook(() => useProcessedSpans("src-1"));
    await waitFor(() => expect(result.current.isProcessed("blk-a")).toBe(true));

    let toggled: "marked" | "restored" | null = null;
    await act(async () => {
      toggled = await result.current.toggle("blk-a");
    });

    expect(toggled).toBe("restored");
    expect(h.markBlockUnread).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      stableBlockId: "blk-a",
    });
  });

  it("does not restore extracted blocks while live output lineage governs state", async () => {
    h.listBlockProcessing.mockResolvedValueOnce({
      blocks: [block("blk-a", "extracted")],
      summary: summary({
        processedBlocks: 1,
        terminalBlocks: 1,
        unresolvedBlocks: 0,
        extractedBlockCount: 1,
        extractedOutputCount: 1,
      }),
    });
    const { result } = renderHook(() => useProcessedSpans("src-1"));
    await waitFor(() => expect(result.current.stateFor("blk-a")).toBe("extracted"));

    let toggled: "marked" | "restored" | null = "marked";
    await act(async () => {
      toggled = await result.current.toggle("blk-a");
      expect(await result.current.markIgnored("blk-a")).toBe(false);
      expect(await result.current.markNeedsLater("blk-a")).toBe(false);
    });

    expect(toggled).toBeNull();
    expect(h.markBlockUnread).not.toHaveBeenCalled();
    expect(h.markBlockIgnored).not.toHaveBeenCalled();
    expect(h.markBlockNeedsLater).not.toHaveBeenCalled();
  });

  it("routes explicit ignored and needs-later actions", async () => {
    const { result } = renderHook(() => useProcessedSpans("src-1"));
    await waitFor(() => expect(h.listBlockProcessing).toHaveBeenCalledTimes(1));

    await act(async () => {
      expect(await result.current.markIgnored("blk-b")).toBe(true);
      expect(await result.current.markNeedsLater("blk-b")).toBe(true);
    });

    expect(h.markBlockIgnored).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      stableBlockId: "blk-b",
    });
    expect(h.markBlockNeedsLater).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      stableBlockId: "blk-b",
    });
  });

  it("returns a failed toggle result and exposes the mutation error", async () => {
    h.markBlockProcessed.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useProcessedSpans("src-1"));
    await waitFor(() => expect(h.listBlockProcessing).toHaveBeenCalledTimes(1));

    let toggled: "marked" | "restored" | null = "marked";
    await act(async () => {
      toggled = await result.current.toggle("blk-b");
    });

    expect(toggled).toBeNull();
    expect(result.current.error).toBe("disk full");
  });

  it("ignores mutation responses that resolve after switching sources", async () => {
    h.listBlockProcessing.mockResolvedValue({
      blocks: [block("blk-a", "processed_without_output")],
      summary: summary(),
    });
    const pending = deferred<{
      readonly block: SourceBlockProcessingViewPayload;
      readonly summary: SourceBlockProcessingSummaryPayload;
    }>();
    h.markBlockProcessed.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ sourceId }: { sourceId: string }) => useProcessedSpans(sourceId),
      { initialProps: { sourceId: "src-1" } },
    );
    await waitFor(() => expect(result.current.stateFor("blk-a")).toBe("processed_without_output"));

    let marked = true;
    let markPromise!: Promise<void>;
    await act(async () => {
      markPromise = result.current.mark("blk-b").then((value) => {
        marked = value;
      });
    });
    await act(async () => {
      rerender({ sourceId: "src-2" });
    });
    await waitFor(() =>
      expect(h.listBlockProcessing).toHaveBeenLastCalledWith({ sourceElementId: "src-2" }),
    );

    await act(async () => {
      pending.resolve({
        block: {
          ...block("blk-b", "processed_without_output", 1),
          sourceElementId: "src-1",
        },
        summary: summary({ sourceElementId: "src-1", processedBlocks: 2 }),
      });
      await markPromise;
    });

    expect(marked).toBe(false);
    expect(result.current.blocks.some((current) => current.stableBlockId === "blk-b")).toBe(false);
  });

  it("does not call IPC outside desktop mode", () => {
    h.desktop = false;
    const { result } = renderHook(() => useProcessedSpans("src-1"));

    expect(result.current.processed).toEqual([]);
    expect(h.listBlockProcessing).not.toHaveBeenCalled();
  });
});
