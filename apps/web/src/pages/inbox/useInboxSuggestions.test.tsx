/**
 * useInboxSuggestions tests (T127 — U6, code-review hardening).
 *
 * Pin the two properties the inbox-row suggestion fetch must hold:
 *  - it refetches only when the inbox id SET changes — a content-only re-render (same
 *    ids, fresh array) must NOT re-issue the batched `triage.suggest` (the storm fix);
 *  - it caps the fetched ids to the IPC bound so a >1000-item inbox still suggests the
 *    first N instead of having the whole batch rejected.
 */

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  suggestTriage: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: { suggestTriage: h.suggestTriage },
  };
});

import { SUGGESTION_FETCH_CAP, useInboxSuggestions } from "./useInboxSuggestions";

beforeEach(() => {
  h.desktop = true;
  h.suggestTriage.mockReset();
  h.suggestTriage.mockImplementation(async ({ ids }: { ids: string[] }) => ({
    results: ids.map((id) => ({
      id,
      suggestion: { kind: "insufficient_signal" as const, reason: "no_signal_fired" as const },
    })),
  }));
});

describe("useInboxSuggestions", () => {
  it("fetches once for an id set and does NOT refetch when the array ref changes but the ids don't", async () => {
    const { rerender } = renderHook(({ ids }) => useInboxSuggestions(ids), {
      initialProps: { ids: ["a", "b", "c"] },
    });
    await waitFor(() => expect(h.suggestTriage).toHaveBeenCalledTimes(1));

    // A content-only change: same ids, brand-new array reference (as InboxScreen produces
    // on every priority write). Must NOT re-issue the batched fetch.
    rerender({ ids: ["a", "b", "c"] });
    rerender({ ids: ["a", "b", "c"] });
    await Promise.resolve();
    expect(h.suggestTriage).toHaveBeenCalledTimes(1);
  });

  it("refetches when the id SET actually changes", async () => {
    const { rerender } = renderHook(({ ids }) => useInboxSuggestions(ids), {
      initialProps: { ids: ["a", "b"] },
    });
    await waitFor(() => expect(h.suggestTriage).toHaveBeenCalledTimes(1));

    rerender({ ids: ["a", "b", "c"] });
    await waitFor(() => expect(h.suggestTriage).toHaveBeenCalledTimes(2));
    expect(h.suggestTriage).toHaveBeenLastCalledWith({ ids: ["a", "b", "c"] });
  });

  it("caps the fetched ids to the IPC bound for a huge inbox", async () => {
    const ids = Array.from({ length: SUGGESTION_FETCH_CAP + 50 }, (_, i) => `id-${i}`);
    renderHook(() => useInboxSuggestions(ids));
    await waitFor(() => expect(h.suggestTriage).toHaveBeenCalledTimes(1));
    const sent = h.suggestTriage.mock.calls[0]?.[0] as { ids: string[] };
    expect(sent.ids).toHaveLength(SUGGESTION_FETCH_CAP);
  });

  it("dropSuggestion marks an id matches_current without a refetch", async () => {
    const { result } = renderHook(() => useInboxSuggestions(["a", "b"]));
    await waitFor(() => expect(result.current.suggestions.size).toBe(2));

    result.current.dropSuggestion("a");
    await waitFor(() =>
      expect(result.current.suggestions.get("a")).toEqual({
        kind: "insufficient_signal",
        reason: "matches_current",
      }),
    );
    expect(h.suggestTriage).toHaveBeenCalledTimes(1);
  });
});
