/**
 * Command palette tests (T048).
 *
 * The ⌘K palette gained ACTION entries (not just route navigation): an entry can
 * carry an `actionId` the shell runs (dispatching the SAME typed `window.appApi`
 * command as the on-screen button) and/or a `to` route. These tests assert:
 *
 *  - choosing an ACTION command runs its handler with the registry's `actionId`;
 *  - an action with a route navigates AND runs the action (e.g. "Start review");
 *  - context-scoped action commands ("Open source"/"Raise priority") are HIDDEN
 *    when nothing is selected and SHOWN when an element is selected (`when` gate);
 *  - a plain navigation command still navigates without an action.
 *
 * The palette is renderer-only: route/action handlers are mocked, and the live
 * source section calls the typed `appApi.searchQuery` bridge (mocked here) rather
 * than touching SQLite, IPC internals, or filesystem APIs.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchQueryResult, SearchResult } from "../lib/appApi";
import { CommandPalette } from "./CommandPalette";

const EMPTY_TEST_SEARCH_COUNTS: SearchQueryResult["counts"] = {
  byType: { source: 0, extract: 0, card: 0 },
  byConcept: {},
  byPriority: { A: 0, B: 0, C: 0, D: 0 },
};

const bridge = vi.hoisted(() => ({
  isDesktop: vi.fn(),
  searchQuery: vi.fn(),
}));

vi.mock("../lib/appApi", () => ({
  appApi: {
    searchQuery: bridge.searchQuery,
  },
  isDesktop: bridge.isDesktop,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function searchResponse(results: readonly SearchResult[]): SearchQueryResult {
  return {
    results,
    counts: EMPTY_TEST_SEARCH_COUNTS,
  };
}

function sourceHit(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "src-1",
    type: "source",
    title: "On the Measure of Intelligence",
    snippet: "...define the intelligence of a system...",
    score: -2.1,
    priority: 0.9,
    priorityLabel: "A",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: null,
    dueAt: null,
    scheduler: {
      kind: "attention",
      retrievability: null,
      stability: null,
      difficulty: null,
      reps: null,
      lapses: null,
      fsrsState: null,
      stage: "raw_source",
      postponed: 0,
      lastProcessedAt: null,
    },
    due: "soon",
    dueLabel: "Scheduled",
    ...overrides,
  };
}

function setup(hasSelection: boolean) {
  const onNavigate = vi.fn();
  const onAction = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <CommandPalette
      open
      onClose={onClose}
      onNavigate={onNavigate}
      onAction={onAction}
      hasSelection={hasSelection}
    />,
  );
  return { ...view, onNavigate, onAction, onClose };
}

beforeEach(() => {
  bridge.isDesktop.mockReset();
  bridge.isDesktop.mockReturnValue(true);
  bridge.searchQuery.mockReset();
  bridge.searchQuery.mockResolvedValue(searchResponse([]));
});

/** Click the palette row whose visible label matches. */
function clickRow(label: string) {
  fireEvent.click(screen.getByText(label));
}

describe("CommandPalette — action entries (T048)", () => {
  it("runs the action handler with the registry actionId when chosen", () => {
    const { onAction } = setup(true);
    clickRow("Raise priority");
    expect(onAction).toHaveBeenCalledWith("raise-priority");
  });

  it("navigates AND runs the action for a routed action (Start review)", () => {
    vi.useFakeTimers();
    try {
      const { onNavigate, onAction } = setup(true);
      clickRow("Start review");
      expect(onNavigate).toHaveBeenCalledWith("/review");
      // A routed action is deferred one tick (so the route settles first).
      vi.runAllTimers();
      expect(onAction).toHaveBeenCalledWith("start-review");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides context-scoped actions when nothing is selected", () => {
    setup(false);
    expect(screen.queryByText("Open source")).toBeNull();
    expect(screen.queryByText("Open parent")).toBeNull();
    expect(screen.queryByText("Raise priority")).toBeNull();
    // Non-context actions stay available.
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Start review")).toBeInTheDocument();
  });

  it("shows context-scoped actions when an element is selected", () => {
    setup(true);
    expect(screen.getByText("Open source")).toBeInTheDocument();
    expect(screen.getByText("Raise priority")).toBeInTheDocument();
  });

  it("a plain navigation command navigates with no action", () => {
    const { onNavigate, onAction } = setup(false);
    clickRow("Daily Queue");
    expect(onNavigate).toHaveBeenCalledWith("/queue");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("finds sidebar maintenance sections such as Trash by search query", () => {
    const { onNavigate, onAction } = setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "trash" } });

    expect(screen.getByText("Trash")).toBeInTheDocument();
    expect(screen.queryByText(/No commands match/)).toBeNull();
    clickRow("Trash");
    expect(onNavigate).toHaveBeenCalledWith("/trash");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("finds route-only sections by aliases and paths", () => {
    setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "retired" } });
    expect(screen.getByText("Retired cards")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "/process" } });
    expect(screen.getByText("Process queue")).toBeInTheDocument();
  });

  it("runs the action on Enter after filtering to it", () => {
    const { onAction } = setup(true);
    const input = screen.getByLabelText("Command palette search");
    // "Lower priority" is a unique label → it is the only/first filtered row, so
    // Enter selects + runs it.
    fireEvent.change(input, { target: { value: "Lower priority" } });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onAction).toHaveBeenCalledWith("lower-priority");
  });

  it("dispatches the shell-only event when a Help command is chosen", () => {
    const spy = vi.fn();
    window.addEventListener("interleave:open-help", spy);

    vi.useFakeTimers();
    try {
      setup(false);
      clickRow("Help: Open help center");

      expect(spy).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(spy).toHaveBeenCalledTimes(1);
      const dispatched = spy.mock.calls.at(0)?.[0];
      expect(dispatched).toBeInstanceOf(Event);
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
      window.removeEventListener("interleave:open-help", spy);
    }
  });

  it("dispatches the tour event when the help tour command is chosen", () => {
    const spy = vi.fn();
    window.addEventListener("interleave:start-tour", spy);

    vi.useFakeTimers();
    try {
      setup(false);
      clickRow("Help: Take the tour");

      expect(spy).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.any(Event));
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
      window.removeEventListener("interleave:start-tour", spy);
    }
  });

  it("requests source-only live search with a bounded limit for non-empty input", async () => {
    setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "  intelligence  " } });

    await waitFor(() => expect(bridge.searchQuery).toHaveBeenCalledTimes(1));
    expect(bridge.searchQuery).toHaveBeenCalledWith({
      q: "intelligence",
      type: "source",
      limit: expect.any(Number),
      includeCounts: false,
    });
    const request = bridge.searchQuery.mock.calls[0]?.[0] as { limit: number };
    expect(request.limit).toBeGreaterThan(0);
    expect(request.limit).toBeLessThanOrEqual(20);
  });

  it("keeps matching command rows above the live Sources section", async () => {
    bridge.searchQuery.mockResolvedValue(
      searchResponse([
        sourceHit({
          id: "src-review",
          title: "Reviewing attention",
          snippet: "A source result that also matches review.",
        }),
      ]),
    );
    setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "review" } });

    const sourceTitle = await screen.findByText("Reviewing attention");
    const commandRow = screen.getByRole("button", { name: /Review session/i });
    const sourceRow = sourceTitle.closest("button");
    expect(sourceRow).not.toBeNull();
    expect(commandRow.compareDocumentPosition(sourceRow as HTMLButtonElement)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("navigates to the selected source route and closes the palette", async () => {
    bridge.searchQuery.mockResolvedValue(
      searchResponse([
        sourceHit({
          id: "src-alpha",
          title: "Alpha source",
          snippet: "Alpha source snippet.",
        }),
      ]),
    );
    const { onNavigate, onClose } = setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "alpha" } });
    await screen.findByText("Alpha source");
    clickRow("Alpha source");

    expect(onNavigate).toHaveBeenCalledWith("/source/$id", { params: { id: "src-alpha" } });
    expect(onClose).toHaveBeenCalled();
  });

  it("runs a selected source row with Enter", async () => {
    bridge.searchQuery.mockResolvedValue(
      searchResponse([
        sourceHit({
          id: "src-keyboard",
          title: "Keyboard source",
          snippet: "Keyboard-selected source snippet.",
        }),
      ]),
    );
    const { onNavigate, onClose } = setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "keyboard" } });
    await screen.findByText("Keyboard source");
    fireEvent.keyDown(window, { key: "Enter" });

    expect(onNavigate).toHaveBeenCalledWith("/source/$id", { params: { id: "src-keyboard" } });
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores stale source-search responses from earlier queries", async () => {
    const first = deferred<SearchQueryResult>();
    const second = deferred<SearchQueryResult>();
    bridge.searchQuery.mockImplementation((request: { q: string }) =>
      request.q === "alpha" ? first.promise : second.promise,
    );
    setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "alpha" } });
    await waitFor(() =>
      expect(bridge.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "alpha", type: "source" }),
      ),
    );

    fireEvent.change(input, { target: { value: "beta" } });
    await waitFor(() =>
      expect(bridge.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "beta", type: "source" }),
      ),
    );

    await act(async () => {
      second.resolve(
        searchResponse([
          sourceHit({
            id: "src-beta",
            title: "Beta source",
            snippet: "The current result.",
          }),
        ]),
      );
    });
    expect(await screen.findByText("Beta source")).toBeInTheDocument();

    await act(async () => {
      first.resolve(
        searchResponse([
          sourceHit({
            id: "src-alpha",
            title: "Alpha source",
            snippet: "The stale result.",
          }),
        ]),
      );
    });

    expect(screen.getByText("Beta source")).toBeInTheDocument();
    expect(screen.queryByText("Alpha source")).toBeNull();
  });

  it("does not issue a stale source search across rapid close and reopen", async () => {
    const { rerender, onClose, onNavigate, onAction } = setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "alpha" } });
    await waitFor(() =>
      expect(bridge.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "alpha", type: "source" }),
      ),
    );
    bridge.searchQuery.mockClear();

    rerender(
      <CommandPalette
        open={false}
        onClose={onClose}
        onNavigate={onNavigate}
        onAction={onAction}
        hasSelection={false}
      />,
    );
    rerender(
      <CommandPalette
        open
        onClose={onClose}
        onNavigate={onNavigate}
        onAction={onAction}
        hasSelection={false}
      />,
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    });

    expect(bridge.searchQuery).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Command palette search") as HTMLInputElement).value).toBe("");
  });

  it("renders a source-search error state while command rows remain usable", async () => {
    bridge.searchQuery.mockRejectedValue(new Error("search failed"));
    const { onNavigate } = setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "review" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not search sources.");
    const commandRow = screen.getByRole("button", { name: /Review session/i });
    expect(commandRow).toBeInTheDocument();
    fireEvent.click(commandRow);
    expect(onNavigate).toHaveBeenCalledWith("/review");
  });

  it("does not search sources for empty, whitespace-only, or too-short input", async () => {
    setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "   " } });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    });

    expect(bridge.searchQuery).not.toHaveBeenCalled();
    expect(screen.getByText("Daily Queue")).toBeInTheDocument();
    expect(screen.queryByText("Sources")).toBeNull();

    fireEvent.change(input, { target: { value: "a" } });
    expect(await screen.findByText("Type at least 2 characters to search sources.")).toBeVisible();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    });
    expect(bridge.searchQuery).not.toHaveBeenCalled();
  });

  it("keeps command rows usable when source search is unavailable outside desktop", async () => {
    bridge.isDesktop.mockReturnValue(false);
    const { onNavigate } = setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "review" } });

    expect(await screen.findByText("Source search is available in the desktop app.")).toBeVisible();
    expect(bridge.searchQuery).not.toHaveBeenCalled();
    const commandRow = screen.getByRole("button", { name: /Review session/i });
    fireEvent.click(commandRow);
    expect(onNavigate).toHaveBeenCalledWith("/review");
  });

  it("renders loading and no-match source states while command rows remain usable", async () => {
    const pending = deferred<SearchQueryResult>();
    bridge.searchQuery.mockReturnValue(pending.promise);
    setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "review" } });

    expect(await screen.findByText("Searching sources...")).toBeInTheDocument();
    await waitFor(() =>
      expect(bridge.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "review", type: "source", includeCounts: false }),
      ),
    );
    await act(async () => {
      pending.resolve(searchResponse([]));
    });

    expect(await screen.findByText("No sources match “review”.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Review session/i })).toBeInTheDocument();
  });

  it("defensively ignores non-source bridge results", async () => {
    bridge.searchQuery.mockResolvedValue(
      searchResponse([
        sourceHit({
          id: "card-1",
          type: "card",
          title: "Card result that should not render",
          snippet: "Malformed palette bridge response.",
        }),
        sourceHit({
          id: "src-real",
          title: "Real source result",
          snippet: "Only source rows render.",
        }),
      ]),
    );
    setup(false);
    const input = screen.getByLabelText("Command palette search");

    fireEvent.change(input, { target: { value: "result" } });

    expect(await screen.findByText("Real source result")).toBeInTheDocument();
    expect(screen.queryByText("Card result that should not render")).toBeNull();
  });
});
