import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  type LibraryInspectorPanel,
  LibraryInspectorPanelProvider,
  useLibraryInspectorPanel,
} from "./libraryInspectorPanel";

function wrapper({ children }: { children: ReactNode }) {
  return <LibraryInspectorPanelProvider>{children}</LibraryInspectorPanelProvider>;
}

function samplePanel(overrides: Partial<LibraryInspectorPanel> = {}): LibraryInspectorPanel {
  return {
    targetId: "el-1",
    openLabel: "Open source",
    onOpen: () => {},
    parkedAt: null,
    notInQueueReason: null,
    parked: null,
    ...overrides,
  };
}

describe("libraryInspectorPanel", () => {
  it("throws when used outside the provider", () => {
    expect(() => renderHook(() => useLibraryInspectorPanel())).toThrow(
      /must be used within a <LibraryInspectorPanelProvider>/,
    );
  });

  it("starts with a null panel and round-trips publish/clear", () => {
    const { result } = renderHook(() => useLibraryInspectorPanel(), { wrapper });
    expect(result.current.panel).toBeNull();

    const panel = samplePanel();
    act(() => result.current.setPanel(panel));
    expect(result.current.panel).toBe(panel);

    act(() => result.current.setPanel(null));
    expect(result.current.panel).toBeNull();
  });

  it("re-publishing only the parked busy flag updates the panel without error", () => {
    const { result } = renderHook(() => useLibraryInspectorPanel(), { wrapper });
    const parked = { busy: false, onMoveToInbox() {}, onQueueSoon() {}, onDismiss() {} };

    act(() => result.current.setPanel(samplePanel({ parked })));
    expect(result.current.panel?.parked?.busy).toBe(false);

    act(() => result.current.setPanel(samplePanel({ parked: { ...parked, busy: true } })));
    expect(result.current.panel?.parked?.busy).toBe(true);
  });

  it("keeps setPanel stable across re-renders", () => {
    const { result, rerender } = renderHook(() => useLibraryInspectorPanel(), { wrapper });
    const firstSetPanel = result.current.setPanel;

    act(() => result.current.setPanel(samplePanel()));
    rerender();

    expect(result.current.setPanel).toBe(firstSetPanel);
  });
});
