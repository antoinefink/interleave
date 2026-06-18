import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  type InboxTriagePanel,
  InboxTriagePanelProvider,
  useInboxTriagePanel,
} from "./inboxTriagePanel";

function wrapper({ children }: { children: ReactNode }) {
  return <InboxTriagePanelProvider>{children}</InboxTriagePanelProvider>;
}

function samplePanel(overrides: Partial<InboxTriagePanel> = {}): InboxTriagePanel {
  return {
    targetId: "src-1",
    priority: 0.5,
    busy: false,
    suggestion: null,
    placementAssigned: false,
    triageHighlighted: false,
    onReadNow: () => {},
    onTriage: () => {},
    onPickPriority: () => {},
    onAcceptSuggestion: () => {},
    onAcceptPlacement: () => {},
    ...overrides,
  };
}

describe("inboxTriagePanel", () => {
  it("throws when used outside the provider", () => {
    expect(() => renderHook(() => useInboxTriagePanel())).toThrow(
      /must be used within an <InboxTriagePanelProvider>/,
    );
  });

  it("starts with a null panel and round-trips publish/clear", () => {
    const { result } = renderHook(() => useInboxTriagePanel(), { wrapper });
    expect(result.current.panel).toBeNull();

    const panel = samplePanel();
    act(() => result.current.setPanel(panel));
    expect(result.current.panel).toBe(panel);

    act(() => result.current.setPanel(null));
    expect(result.current.panel).toBeNull();
  });

  it("keeps the register callbacks stable across re-renders (no detach loop)", () => {
    const { result, rerender } = renderHook(() => useInboxTriagePanel(), { wrapper });
    const firstRegisterSection = result.current.registerSection;
    const firstRegisterReadNow = result.current.registerReadNowButton;

    // A payload re-publish must not change the register-callback identities, or the
    // inspector's `ref` callbacks would detach/reattach on every busy/highlight tick.
    act(() => result.current.setPanel(samplePanel({ busy: true })));
    rerender();

    expect(result.current.registerSection).toBe(firstRegisterSection);
    expect(result.current.registerReadNowButton).toBe(firstRegisterReadNow);
  });

  it("registers section + read-now nodes into the shared refs", () => {
    const { result } = renderHook(() => useInboxTriagePanel(), { wrapper });
    const section = document.createElement("div");
    const button = document.createElement("button");

    act(() => {
      result.current.registerSection(section);
      result.current.registerReadNowButton(button);
    });
    expect(result.current.sectionRef.current).toBe(section);
    expect(result.current.readNowRef.current).toBe(button);

    act(() => {
      result.current.registerSection(null);
      result.current.registerReadNowButton(null);
    });
    expect(result.current.sectionRef.current).toBeNull();
    expect(result.current.readNowRef.current).toBeNull();
  });

  it("bumps registrationTick when the read-now node registers (reveal retry trigger)", () => {
    const { result } = renderHook(() => useInboxTriagePanel(), { wrapper });
    const before = result.current.registrationTick;

    act(() => result.current.registerReadNowButton(document.createElement("button")));
    expect(result.current.registrationTick).toBe(before + 1);

    // Clearing (null) does not bump — only a real node registration retries a reveal.
    act(() => result.current.registerReadNowButton(null));
    expect(result.current.registrationTick).toBe(before + 1);
  });
});
