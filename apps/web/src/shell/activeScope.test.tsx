import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { hasActiveScope, isScopeActive, pushActiveScope, useActiveScope } from "./activeScope";

const releases: Array<() => void> = [];

afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
});

describe("active scope registry", () => {
  it("tracks pushed scopes until their release function runs", () => {
    const releaseReader = pushActiveScope("reader");
    releases.push(releaseReader);
    const releaseQueue = pushActiveScope("queue");
    releases.push(releaseQueue);

    expect(hasActiveScope()).toBe(true);
    expect(isScopeActive("reader")).toBe(true);
    expect(isScopeActive("queue")).toBe(true);
    expect(isScopeActive("review")).toBe(false);

    releaseReader();
    expect(isScopeActive("reader")).toBe(false);
    expect(hasActiveScope()).toBe(true);

    releaseQueue();
    expect(hasActiveScope()).toBe(false);
  });

  it("treats the inbox `triage` scope as active so global keys defer to it (T126)", () => {
    expect(hasActiveScope()).toBe(false);
    const release = pushActiveScope("triage");
    releases.push(release);

    // While triage is active the global shell handler reads `hasActiveScope()` and
    // defers its overlapping `o`/`u`/`+`/`-` keys to the inbox keymap.
    expect(hasActiveScope()).toBe(true);
    expect(isScopeActive("triage")).toBe(true);
    expect(isScopeActive("queue")).toBe(false);

    release();
    expect(isScopeActive("triage")).toBe(false);
    expect(hasActiveScope()).toBe(false);
  });

  it("registers a scope only while the hook is enabled and mounted", () => {
    const { rerender, unmount } = renderHook(
      ({ enabled }: { enabled: boolean }) => useActiveScope("review", enabled),
      { initialProps: { enabled: false } },
    );
    expect(hasActiveScope()).toBe(false);

    rerender({ enabled: true });
    expect(isScopeActive("review")).toBe(true);

    rerender({ enabled: false });
    expect(isScopeActive("review")).toBe(false);

    rerender({ enabled: true });
    unmount();
    expect(isScopeActive("review")).toBe(false);
  });
});
