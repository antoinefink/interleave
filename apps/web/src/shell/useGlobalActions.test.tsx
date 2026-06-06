import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  selectedId: "el-1" as string | null,
  navigate: vi.fn(),
  navigateToLocation: vi.fn(),
  getInspectorData: vi.fn(),
  setElementPriority: vi.fn(),
  requestInspectorRefresh: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../reader/navigateToLocation", () => ({
  useNavigateToLocation: () => h.navigateToLocation,
}));

vi.mock("./selection", () => ({
  useSelection: () => ({ selectedId: h.selectedId, select: vi.fn() }),
}));

vi.mock("../components/inspector/Inspector", () => ({
  requestInspectorRefresh: () => h.requestInspectorRefresh(),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      getInspectorData: h.getInspectorData,
      setElementPriority: h.setElementPriority,
    },
  };
});

import { pushActiveScope } from "./activeScope";
import { useGlobalActions } from "./useGlobalActions";

const location = {
  id: "loc-1",
  sourceElementId: "src-1",
  blockIds: ["blk-a"],
  startOffset: 0,
  endOffset: 5,
  label: "P1",
  selectedText: "hello",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  h.desktop = true;
  h.selectedId = "el-1";
  h.navigate.mockReset();
  h.navigateToLocation.mockReset();
  h.getInspectorData.mockReset();
  h.setElementPriority.mockReset();
  h.requestInspectorRefresh.mockReset();
  h.setElementPriority.mockResolvedValue({ priority: 1 });
});

describe("useGlobalActions", () => {
  it("opens a selected element's stored source location", async () => {
    h.getInspectorData.mockResolvedValue({ data: { location } });
    const { result } = renderHook(() => useGlobalActions());

    act(() => result.current.openSource());

    await waitFor(() => expect(h.navigateToLocation).toHaveBeenCalledWith(location));
    expect(h.getInspectorData).toHaveBeenCalledWith({ id: "el-1" });
  });

  it("falls back to opening the source reader when no explicit location exists", async () => {
    h.getInspectorData.mockResolvedValue({
      data: { location: null, source: { id: "src-1" }, element: { type: "extract" } },
    });
    const { result } = renderHook(() => useGlobalActions());

    act(() => result.current.openSource());

    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } }),
    );
  });

  it("opens source and extract parents on the matching route", async () => {
    const { result, rerender } = renderHook(() => useGlobalActions());

    h.getInspectorData.mockResolvedValueOnce({ data: { parent: { id: "src-1", type: "source" } } });
    act(() => result.current.openParent());
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } }),
    );

    h.navigate.mockReset();
    h.getInspectorData.mockResolvedValueOnce({
      data: { parent: { id: "ext-1", type: "extract" } },
    });
    rerender();
    act(() => result.current.openParent());
    await waitFor(() =>
      expect(h.navigate).toHaveBeenCalledWith({ to: "/extract/$id", params: { id: "ext-1" } }),
    );
  });

  it("raises and lowers priority through the universal priority command then refreshes inspector", async () => {
    const { result } = renderHook(() => useGlobalActions());

    act(() => result.current.raisePriority());
    await waitFor(() =>
      expect(h.setElementPriority).toHaveBeenCalledWith({
        id: "el-1",
        action: { kind: "raise" },
      }),
    );
    await waitFor(() => expect(h.requestInspectorRefresh).toHaveBeenCalledTimes(1));

    act(() => result.current.lowerPriority());
    await waitFor(() =>
      expect(h.setElementPriority).toHaveBeenCalledWith({
        id: "el-1",
        action: { kind: "lower" },
      }),
    );
  });

  it("search navigates even without desktop, but element actions stay inert", () => {
    h.desktop = false;
    const { result } = renderHook(() => useGlobalActions());

    act(() => {
      result.current.openSource();
      result.current.raisePriority();
      result.current.search();
    });

    expect(h.getInspectorData).not.toHaveBeenCalled();
    expect(h.setElementPriority).not.toHaveBeenCalled();
    expect(h.navigate).toHaveBeenCalledWith({ to: "/search" });
  });

  it("suppresses element actions while a screen scope owns the selected element", () => {
    const release = pushActiveScope("review");
    try {
      const { result } = renderHook(() => useGlobalActions());

      act(() => {
        result.current.openSource();
        result.current.openParent();
        result.current.raisePriority();
        result.current.search();
      });

      expect(h.getInspectorData).not.toHaveBeenCalled();
      expect(h.setElementPriority).not.toHaveBeenCalled();
      expect(h.navigate).toHaveBeenCalledWith({ to: "/search" });
    } finally {
      release();
    }
  });

  it("ignores delayed open-source responses after the selected element changes", async () => {
    const sourceRead = deferred<{
      data: { location: typeof location; element: { type: string } };
    }>();
    h.getInspectorData.mockReturnValueOnce(sourceRead.promise);
    const { result, rerender } = renderHook(() => useGlobalActions());

    act(() => result.current.openSource());
    expect(h.getInspectorData).toHaveBeenCalledWith({ id: "el-1" });

    h.selectedId = "el-2";
    rerender();
    sourceRead.resolve({ data: { location, element: { type: "extract" } } });

    await sourceRead.promise;
    await Promise.resolve();
    expect(h.navigateToLocation).not.toHaveBeenCalled();
  });
});
