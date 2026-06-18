/**
 * LibraryScreen component tests (T042).
 *
 * Search/index/ranking all live MAIN-side (`SearchRepository` + the FTS migration);
 * this asserts the RENDERER seam of the library view:
 *  - typing a query calls `appApi.searchQuery` (debounced) with the trimmed term;
 *  - grouped results render the row text (query highlighting is applied paint-only via the
 *    CSS Custom Highlight API, not a per-row `<em>`, so it is not observable in jsdom);
 *  - clicking a type/concept filter narrows the call;
 *  - an empty Search stays on the prompt while Type/Concept/Priority filters are pending.
 *
 * `appApi` + the router are mocked so the test exercises ONLY this component's
 * wiring; no SQLite/IPC — the renderer is a pure UI consumer here.
 */

import { DEFAULT_EMBEDDING_MODEL_ID } from "@interleave/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConceptNode,
  LibraryBrowseRequest,
  LibraryBrowseResult,
  LibraryItem,
  SearchQueryRequest,
  SearchQueryResult,
  SearchResult,
} from "../lib/appApi";
import type { LibraryInspectorPanel } from "../shell/libraryInspectorPanel";

const EMPTY_TEST_SEARCH_COUNTS: SearchQueryResult["counts"] = {
  byType: { source: 0, extract: 0, card: 0 },
  byConcept: {},
  byPriority: { A: 0, B: 0, C: 0, D: 0 },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The latest non-null payload published to the shell inspector bridge. */
function latestPanel(): LibraryInspectorPanel | null {
  const calls = h.setLibraryPanelSpy.mock.calls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const arg = calls[i]?.[0];
    if (arg) return arg as LibraryInspectorPanel;
  }
  return null;
}

/** Wait until a payload for `id` is published to the bridge, then return it. */
async function panelFor(id: string): Promise<LibraryInspectorPanel> {
  return await waitFor(() => {
    const p = latestPanel();
    expect(p?.targetId).toBe(id);
    return p as LibraryInspectorPanel;
  });
}

const h = vi.hoisted(() => {
  const attentionScheduler: SearchResult["scheduler"] = {
    kind: "attention",
    retrievability: null,
    stability: null,
    difficulty: null,
    reps: null,
    lapses: null,
    fsrsState: null,
    stage: "raw_source",
    postponed: 0,
    scheduleReason: null,
    lastProcessedAt: null,
  };
  const fsrsScheduler: SearchResult["scheduler"] = {
    kind: "fsrs",
    retrievability: 0.92,
    stability: 12,
    difficulty: 5,
    reps: 3,
    lapses: 0,
    fsrsState: "review",
    stage: "active_card",
    postponed: 0,
    scheduleReason: null,
    lastProcessedAt: "2026-05-01T00:00:00.000Z",
  };
  const sourceHit: SearchResult = {
    id: "src-1",
    type: "source",
    title: "On the Measure of Intelligence",
    snippet: "…define the intelligence of a system…",
    score: -2.1,
    priority: 0.9,
    priorityLabel: "A",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: null,
    dueAt: null,
    scheduler: attentionScheduler,
    due: "soon",
    dueLabel: "No return scheduled",
    queueEligible: false,
    notInQueueReason: "Not in queue: no return scheduled",
  };
  const cardHit: SearchResult = {
    id: "card-1",
    type: "card",
    title: "Chollet's definition of intelligence",
    snippet: "How does Chollet define…",
    score: -1.4,
    priority: 0.9,
    priorityLabel: "A",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "Definition · ¶1",
    dueAt: "2026-06-01T00:00:00.000Z",
    scheduler: fsrsScheduler,
    due: "today",
    dueLabel: "Due today",
    queueEligible: true,
    notInQueueReason: null,
  };
  const sourceBrowseItem: LibraryItem = {
    id: sourceHit.id,
    type: sourceHit.type,
    title: sourceHit.title,
    priority: sourceHit.priority,
    priorityLabel: sourceHit.priorityLabel,
    status: "active",
    stage: "raw_source",
    concept: sourceHit.concept,
    sourceTitle: sourceHit.sourceTitle,
    sourceLocationLabel: sourceHit.sourceLocationLabel,
    dueAt: sourceHit.dueAt,
    parkedAt: null,
    scheduler: sourceHit.scheduler,
    due: sourceHit.due,
    dueLabel: sourceHit.dueLabel,
    queueEligible: sourceHit.queueEligible,
    notInQueueReason: sourceHit.notInQueueReason,
    linkedElementId: null,
    linkedElementType: null,
    taskType: null,
  };
  const cardBrowseItem: LibraryItem = {
    id: cardHit.id,
    type: cardHit.type,
    title: cardHit.title,
    priority: cardHit.priority,
    priorityLabel: cardHit.priorityLabel,
    status: "scheduled",
    stage: "active_card",
    concept: cardHit.concept,
    sourceTitle: cardHit.sourceTitle,
    sourceLocationLabel: cardHit.sourceLocationLabel,
    dueAt: cardHit.dueAt,
    parkedAt: null,
    scheduler: cardHit.scheduler,
    due: cardHit.due,
    dueLabel: cardHit.dueLabel,
    queueEligible: cardHit.queueEligible,
    notInQueueReason: cardHit.notInQueueReason,
    linkedElementId: null,
    linkedElementType: null,
    taskType: null,
  };
  const topicBrowseItem: LibraryItem = {
    id: "topic-1",
    type: "topic",
    title: "General learning topic",
    priority: 0.4,
    priorityLabel: "C",
    status: "active",
    stage: "rough_topic",
    concept: "Intelligence",
    sourceTitle: null,
    sourceLocationLabel: null,
    dueAt: null,
    parkedAt: null,
    scheduler: attentionScheduler,
    due: "soon",
    dueLabel: "No return scheduled",
    queueEligible: false,
    notInQueueReason: "Not in queue: no return scheduled",
    linkedElementId: null,
    linkedElementType: null,
    taskType: null,
  };
  const concept: ConceptNode = {
    id: "concept-1",
    name: "Intelligence",
    parentConceptId: null,
    childCount: 0,
    memberCount: 9,
    desiredRetention: null,
  };
  const browseCounts: LibraryBrowseResult["counts"] = {
    all: 2,
    byType: { source: 11, extract: 5, card: 7, topic: 4, synthesis_note: 0, task: 1 },
    byConcept: { "concept-1": 6 },
    byPriority: { A: 8, B: 3, C: 2, D: 1 },
    byStatus: { active: 2, scheduled: 1, inbox: 0, pending: 0, done: 0, suspended: 0 },
  };
  return {
    sourceHit,
    cardHit,
    sourceBrowseItem,
    cardBrowseItem,
    topicBrowseItem,
    concept,
    browseCounts,
    navigateSpy: vi.fn(),
    routeSearch: {} as Record<string, unknown>,
    selectSpy: vi.fn(),
    setLibraryPanelSpy: vi.fn(),
    searchQuery: vi.fn(),
    libraryBrowse: vi.fn(),
    listConcepts: vi.fn(),
    // U1 regression guard — counts each render of the per-row `Prio` badge. Typing
    // into the isolated search field must NOT re-render the heavy results subtree,
    // so this counter must stay flat across keystrokes within the debounce window.
    prioRenderCount: { current: 0 },
    // Semantic search (T087) — vector index unavailable by default so these tests exercise the FTS path.
    semanticStatus: vi.fn(),
    semanticSearch: vi.fn(),
    semanticReindex: vi.fn(),
    subscribeJobs: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => h.routeSearch,
}));

vi.mock("../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

// The relocated "Open" control now publishes to the shared shell inspector bridge.
// The inspector isn't mounted here, so capture the published payload and assert on
// it (and invoke its `onOpen`) instead of clicking the old detail-column button.
vi.mock("../shell/libraryInspectorPanel", () => ({
  useLibraryInspectorPanel: () => ({ panel: null, setPanel: h.setLibraryPanelSpy }),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      searchQuery: h.searchQuery,
      libraryBrowse: h.libraryBrowse,
      listConcepts: h.listConcepts,
      semanticStatus: h.semanticStatus,
      semanticSearch: h.semanticSearch,
      semanticReindex: h.semanticReindex,
      subscribeJobs: h.subscribeJobs,
    },
  };
});

// Partial-mock the inspector primitives so `Prio` (rendered once per result row)
// becomes a render counter — the load-bearing stutter regression signal. Every other
// primitive stays real so the rest of the screen renders normally.
vi.mock("../components/inspector/primitives", async () => {
  const actual = await vi.importActual<typeof import("../components/inspector/primitives")>(
    "../components/inspector/primitives",
  );
  return {
    ...actual,
    Prio: (props: { priority: number }) => {
      h.prioRenderCount.current += 1;
      return actual.Prio(props);
    },
  };
});

import { firstMatchIndex, LibraryScreen } from "./LibraryScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.routeSearch = {};
  h.prioRenderCount.current = 0;
  // The backend now returns DRILL-DOWN per-concept counts alongside the rows; the
  // chip renders these (NOT the global ConceptNode.memberCount). The mock honors
  // the active type facet so empty Search count reads behave like the real bridge.
  h.searchQuery.mockImplementation((request: SearchQueryRequest) => {
    const allResults = [h.sourceHit, h.cardHit];
    const results = allResults.filter((result) => {
      if (request.type && result.type !== request.type) return false;
      if (request.priorityLabel && result.priorityLabel !== request.priorityLabel) return false;
      if (request.conceptId && result.concept !== h.concept.name) return false;
      return true;
    });
    return Promise.resolve({
      results,
      counts: {
        byType: { source: 1, extract: 0, card: 1 },
        byConcept: { "concept-1": results.length },
        byPriority: { A: results.length, B: 0, C: 0, D: 0 },
      },
    });
  });
  h.listConcepts.mockResolvedValue({ concepts: [h.concept] });
  h.libraryBrowse.mockImplementation((request?: LibraryBrowseRequest) => {
    const items = [h.sourceBrowseItem, h.cardBrowseItem, h.topicBrowseItem].filter((item) => {
      if (request?.types && !request.types.includes(item.type)) return false;
      if (request?.priorityLabel && item.priorityLabel !== request.priorityLabel) return false;
      // All concept-bearing fixtures belong to concept-1; keep the mock focused on
      // the renderer request shape instead of duplicating the main-side membership read.
      if (request?.conceptId && item.concept !== h.concept.name) return false;
      return true;
    });
    return Promise.resolve({
      items,
      counts: h.browseCounts,
    });
  });
  // Vector index unavailable by default → the library uses the FTS `searchQuery` path.
  h.semanticStatus.mockResolvedValue({
    enabled: false,
    vecAvailable: false,
    modelDownloaded: false,
    embedded: 0,
    total: 0,
    modelId: "",
    modelState: "fallback",
    indexHealth: "degraded",
    coverageRatio: 0,
    failedCount: 0,
    lastError: null,
    etaSeconds: null,
  });
  h.semanticSearch.mockResolvedValue({
    results: [],
    mode: "disabled",
    counts: EMPTY_TEST_SEARCH_COUNTS,
  });
  h.semanticReindex.mockResolvedValue({ enqueued: 0 });
  h.subscribeJobs.mockReturnValue(() => {});
});

describe("firstMatchIndex (query-highlight match rule)", () => {
  it("finds the first case-insensitive occurrence", () => {
    expect(firstMatchIndex("On the Measure of Intelligence", "intelligence")).toBe(18);
    expect(firstMatchIndex("Intelligence everywhere", "INTEL")).toBe(0);
  });
  it("returns -1 for no match and for an empty/whitespace term", () => {
    expect(firstMatchIndex("nothing here", "xyz")).toBe(-1);
    expect(firstMatchIndex("anything", "")).toBe(-1);
    expect(firstMatchIndex("anything", "   ")).toBe(-1);
  });
});

describe("LibraryScreen", () => {
  it("throttles embed-progress refreshes so an indexing flood can't re-render per event", async () => {
    // Regression guard for the typing-stutter-DURING-indexing path: the job runner emits
    // hundreds of `embed` events/sec while a large add indexes, and refreshing per event
    // floods the renderer (IPC + setState each time). The subscription must coalesce a burst
    // into a bounded number of `semanticStatus` reads (one immediate + one trailing), not one
    // per event. (The per-keystroke result repaint is fixed separately via the CSS highlight.)
    render(<LibraryScreen />);
    await waitFor(() => expect(h.subscribeJobs).toHaveBeenCalled());
    const onJob = h.subscribeJobs.mock.calls[0]?.[0] as (job: { type: string }) => void;
    await waitFor(() => expect(h.semanticStatus.mock.calls.length).toBeGreaterThan(0));

    vi.useFakeTimers();
    try {
      h.semanticStatus.mockClear();
      // A burst of 25 embed events in one tick → 1 immediate refresh, the rest coalesced.
      act(() => {
        for (let i = 0; i < 25; i++) onJob({ type: "embed" });
      });
      expect(h.semanticStatus).toHaveBeenCalledTimes(1);
      // The window elapses → exactly ONE trailing refresh (not 24 more).
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(h.semanticStatus).toHaveBeenCalledTimes(2);
      // Non-embed jobs never trigger a semantic refresh.
      act(() => {
        onJob({ type: "extract-clean" });
        vi.advanceTimersByTime(1000);
      });
      expect(h.semanticStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts on the search prompt with no default Source browse rows", async () => {
    render(<LibraryScreen />);
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    // The concept list loads for the filterbar/map, and the browse bridge loads
    // empty-query counts only. Search no longer renders default Source rows.
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({
        types: ["source", "extract", "card"],
      }),
    );
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(screen.queryByTestId("library-group-card")).toBeNull();
    expect(h.searchQuery).not.toHaveBeenCalled();
  });

  it("shows empty-query browse counts on Type, Concept, and Priority chips", async () => {
    // The concept's GLOBAL memberCount is 9, but the /search empty-query filterbar
    // is bounded to source/extract/card and reads the browse drill-down count (6).
    render(<LibraryScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());
    // Counts apply via startTransition, so wait for the commit rather than reading
    // synchronously right after the browse mock was merely called.
    await waitFor(() => {
      expect(
        within(screen.getByTestId("library-filter-type-source")).getByText("11", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("library-filter-type-extract")).getByText("5", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("library-filter-type-card")).getByText("7", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
    });
    const chip = await screen.findByTestId("library-filter-concept-concept-1");
    await waitFor(() =>
      expect(within(chip).getByText("6", { selector: ".filter-opt__count" })).toBeTruthy(),
    );
    expect(within(chip).queryByText("9", { selector: ".filter-opt__count" })).toBeNull();
    expect(
      within(screen.getByTestId("library-filter-prio-A")).getByText("8", {
        selector: ".filter-opt__count",
      }),
    ).toBeTruthy();
    // And no keyword query was issued (the chip numbers came from libraryBrowse).
    expect(h.searchQuery).not.toHaveBeenCalled();
  });

  it("keeps an empty Type facet selection as a pending Search constraint", async () => {
    render(<LibraryScreen />);
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source", "extract", "card"] }),
    );

    h.libraryBrowse.mockClear();
    h.libraryBrowse.mockResolvedValueOnce({
      items: [h.sourceBrowseItem],
      counts: h.browseCounts,
    });
    fireEvent.click(screen.getByTestId("library-filter-type-source"));

    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source"] }));
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.getByTestId("library-filter-type-source").className).toContain(
      "filter-opt--pending",
    );
    expect(screen.getByTestId("library-pending-filters").textContent).toContain(
      "Pending constraints: Sources",
    );
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(screen.queryByTestId("library-group-card")).toBeNull();
    expect(h.searchQuery).not.toHaveBeenCalled();
  });

  it("keeps an empty Concept selection pending while staying bounded to searchable counts", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    h.libraryBrowse.mockClear();
    h.libraryBrowse.mockResolvedValueOnce({
      items: [h.sourceBrowseItem, h.topicBrowseItem],
      counts: h.browseCounts,
    });
    fireEvent.click(await screen.findByTestId("library-filter-concept-concept-1"));

    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({
        types: ["source", "extract", "card"],
        conceptId: "concept-1",
      }),
    );
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.getByTestId("library-pending-filters")).toBeTruthy();
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(screen.queryByTestId("library-group-topic")).toBeNull();
    expect(document.querySelector('[data-result-type="topic"]')).toBeNull();
  });

  it("keeps an empty Priority selection pending while staying bounded to searchable counts", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    h.libraryBrowse.mockClear();
    h.libraryBrowse.mockResolvedValueOnce({
      items: [h.sourceBrowseItem, h.topicBrowseItem],
      counts: h.browseCounts,
    });
    fireEvent.click(screen.getByTestId("library-filter-prio-A"));

    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({
        types: ["source", "extract", "card"],
        priorityLabel: "A",
      }),
    );
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.getByTestId("library-pending-filters")).toBeTruthy();
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(document.querySelector('[data-result-type="topic"]')).toBeNull();
  });

  it("hydrates query and filters from Search route params", async () => {
    h.routeSearch = {
      q: "intelligence",
      type: "card",
      conceptId: "concept-1",
      priority: "A",
    };

    render(<LibraryScreen />);

    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          q: "intelligence",
          type: "card",
          conceptId: "concept-1",
          priorityLabel: "A",
        }),
      ),
    );
    expect((screen.getByTestId("library-search-input") as HTMLInputElement).value).toBe(
      "intelligence",
    );
    expect(screen.getByTestId("library-filter-type-card").className).toContain("filter-opt--on");
    expect(screen.getByTestId("library-filter-prio-A").className).toContain("filter-opt--on");
    expect((await screen.findByTestId("library-filter-concept-concept-1")).className).toContain(
      "filter-opt--on",
    );
  });

  it("resets query and filters when the same Search route clears URL params", async () => {
    h.routeSearch = { q: "memory", type: "card", priority: "A" };
    const { rerender } = render(<LibraryScreen />);
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "memory", type: "card", priorityLabel: "A" }),
      ),
    );

    h.searchQuery.mockClear();
    h.libraryBrowse.mockClear();
    h.routeSearch = {};
    rerender(<LibraryScreen />);

    await waitFor(() =>
      expect((screen.getByTestId("library-search-input") as HTMLInputElement).value).toBe(""),
    );
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source", "extract", "card"] }),
    );
    expect(h.searchQuery).not.toHaveBeenCalled();
    expect(screen.getByTestId("library-filter-type-card").className).not.toContain(
      "filter-opt--on",
    );
    expect(screen.getByTestId("library-filter-prio-A").className).not.toContain("filter-opt--on");
  });

  it("switches to Browse with compatible pending filters preserved", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("library-filter-type-source"));
    fireEvent.click(await screen.findByTestId("library-filter-concept-concept-1"));
    fireEvent.click(screen.getByTestId("library-filter-prio-A"));
    fireEvent.click(screen.getByTestId("collection-mode-browse"));

    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/library",
      search: { type: "source", conceptId: "concept-1", priority: "A" },
    });
  });

  it("shows the 'Build index (N of M embedded)' affordance when semantic indexing is available but incomplete, and reindexes on click (T087)", async () => {
    // Vec available, but only 1 of 3 elements embedded.
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 1,
      total: 3,
      modelId: DEFAULT_EMBEDDING_MODEL_ID,
      modelState: "ready",
      indexHealth: "stale",
      coverageRatio: 1 / 3,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    render(<LibraryScreen />);

    const button = await screen.findByTestId("library-build-index");
    expect(button.textContent).toContain("1 of 3 embedded");

    fireEvent.click(button);
    await waitFor(() =>
      expect(h.semanticReindex).toHaveBeenCalledWith(
        expect.objectContaining({ onlyMissing: false }),
      ),
    );
  });

  it("hides the Build-index affordance once everything is embedded (T087)", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 3,
      total: 3,
      modelId: DEFAULT_EMBEDDING_MODEL_ID,
      modelState: "ready",
      indexHealth: "healthy",
      coverageRatio: 1,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    render(<LibraryScreen />);
    // The no-query prompt is shown, but with the index complete there is no button.
    expect(await screen.findByTestId("library-prompt")).toBeTruthy();
    await waitFor(() => expect(h.semanticStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("library-build-index")).toBeNull();
  });

  it("searches (debounced) on input with no default Type facet", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });

    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "intelligence" })),
    );

    const lastCall = h.searchQuery.mock.calls[h.searchQuery.mock.calls.length - 1]?.[0];
    expect(lastCall).not.toHaveProperty("type");
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(screen.getByTestId("library-group-card")).toBeTruthy();

    // The matched title renders as PLAIN text — highlighting is applied paint-only via the
    // CSS Custom Highlight API (not a per-row `<em>`), which is the fix for the typing
    // stutter and is not observable in jsdom. Guard that no inline highlight markup remains
    // (a regression to `<em>` per row would reintroduce the per-keystroke re-render/repaint).
    const rows = screen.getAllByTestId("library-result");
    expect(rows.length).toBe(2);
    expect(rows.some((r) => /intelligence/i.test(r.textContent ?? ""))).toBe(true);
    expect(rows.some((r) => r.querySelector("em"))).toBe(false);
    expect(await screen.findByTestId("library-semantic-off")).toHaveTextContent(
      /semantic indexing is unavailable on this build/i,
    );
    expect(screen.getByTestId("library-semantic-off")).not.toHaveTextContent(/settings/i);
  });

  it("renders backend byType counts on Type chips after a keyword query", async () => {
    h.searchQuery.mockResolvedValue({
      results: [h.sourceHit, h.cardHit],
      counts: {
        byType: { source: 7, extract: 3, card: 2 },
        byConcept: { "concept-1": 9 },
        byPriority: { A: 6, B: 4, C: 2, D: 0 },
      },
    });

    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    await waitFor(() => {
      expect(
        within(screen.getByTestId("library-filter-type-source")).getByText("7", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("library-filter-type-extract")).getByText("3", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("library-filter-type-card")).getByText("2", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
    });
  });

  it("renders backend byPriority counts on Priority chips after a keyword query", async () => {
    h.searchQuery.mockResolvedValue({
      results: [h.sourceHit, h.cardHit],
      counts: {
        byType: { source: 2, extract: 1, card: 1 },
        byConcept: { "concept-1": 4 },
        byPriority: { A: 5, B: 4, C: 3, D: 2 },
      },
    });

    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    await waitFor(() => {
      for (const [priority, count] of [
        ["A", "5"],
        ["B", "4"],
        ["C", "3"],
        ["D", "2"],
      ] as const) {
        expect(
          within(screen.getByTestId(`library-filter-prio-${priority}`)).getByText(count, {
            selector: ".filter-opt__count",
          }),
        ).toBeTruthy();
      }
    });
  });

  it("renders semantic-search counts instead of zeroing the filterbar", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 2,
      total: 2,
      modelId: "test-model",
      modelState: "ready",
      indexHealth: "healthy",
      coverageRatio: 1,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    h.semanticSearch.mockResolvedValue({
      results: [
        { ...h.sourceHit, semantic: true, vecDistance: 0.12 },
        { ...h.cardHit, semantic: false, vecDistance: null },
      ],
      mode: "semantic",
      counts: {
        byType: { source: 3, extract: 1, card: 2 },
        byConcept: { "concept-1": 4 },
        byPriority: { A: 5, B: 1, C: 0, D: 0 },
      },
    });

    render(<LibraryScreen />);
    await waitFor(() => expect(h.semanticStatus).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });

    await waitFor(() =>
      expect(h.semanticSearch).toHaveBeenCalledWith(expect.objectContaining({ q: "intelligence" })),
    );
    expect(h.searchQuery).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        within(screen.getByTestId("library-filter-type-source")).getByText("3", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("library-filter-prio-A")).getByText("5", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
    });
  });

  it("shows NO standing hint on the happy path — semantic ran, index healthy (per-row badge carries it)", async () => {
    // The removed "Semantic search on — …" banner was pure chrome: when the index is
    // healthy and the search ran in semantic mode, the meaning-only `related` badges
    // already mark which rows came from vectors. Assert none of the hint variants render.
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 2,
      total: 2,
      modelId: "test-model",
      modelState: "ready",
      indexHealth: "healthy",
      coverageRatio: 1,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    h.semanticSearch.mockResolvedValue({
      results: [{ ...h.sourceHit, semantic: true, vecDistance: 0.12 }],
      mode: "semantic",
      counts: {
        byType: { source: 1, extract: 0, card: 0 },
        byConcept: {},
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
      },
    });
    render(<LibraryScreen />);
    await waitFor(() => expect(h.semanticStatus).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.semanticSearch).toHaveBeenCalled());
    // The result row rendered, but no semantic hint banner of any kind did.
    expect(await screen.findByTestId("library-result")).toBeInTheDocument();
    expect(screen.queryByTestId("library-semantic-on")).toBeNull();
    expect(screen.queryByTestId("library-semantic-building")).toBeNull();
    expect(screen.queryByTestId("library-semantic-partial")).toBeNull();
    expect(screen.queryByTestId("library-semantic-off")).toBeNull();
  });

  it("shows a reassuring 'Indexing…' hint while the index is actively building (U6)", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 2,
      total: 10,
      modelId: "test-model",
      modelState: "ready",
      indexHealth: "building",
      coverageRatio: 0.2,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    h.semanticSearch.mockResolvedValue({
      results: [{ ...h.sourceHit, semantic: true, vecDistance: 0.12 }],
      mode: "semantic",
      counts: {
        byType: { source: 1, extract: 0, card: 0 },
        byConcept: {},
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
      },
    });
    render(<LibraryScreen />);
    await waitFor(() => expect(h.semanticStatus).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    expect(await screen.findByTestId("library-semantic-building")).toHaveTextContent(/indexing/i);
  });

  it("shows an honest 'partial coverage' hint when the index is stale and idle (U6)", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 1,
      total: 10,
      modelId: "test-model",
      modelState: "ready",
      indexHealth: "stale",
      coverageRatio: 0.1,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    h.semanticSearch.mockResolvedValue({
      results: [{ ...h.sourceHit, semantic: true, vecDistance: 0.12 }],
      mode: "semantic",
      counts: {
        byType: { source: 1, extract: 0, card: 0 },
        byConcept: {},
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
      },
    });
    render(<LibraryScreen />);
    await waitFor(() => expect(h.semanticStatus).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    expect(await screen.findByTestId("library-semantic-partial")).toHaveTextContent(
      /partial coverage/i,
    );
  });

  it("keeps semantic byType counts populated when a type filter is active", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 2,
      total: 2,
      modelId: "test-model",
      modelState: "ready",
      indexHealth: "healthy",
      coverageRatio: 1,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    h.semanticSearch.mockResolvedValue({
      results: [{ ...h.sourceHit, semantic: true, vecDistance: 0.12 }],
      mode: "semantic",
      counts: {
        byType: { source: 1, extract: 2, card: 3 },
        byConcept: { "concept-1": 1 },
        byPriority: { A: 1, B: 2, C: 3, D: 0 },
      },
    });

    render(<LibraryScreen />);
    await waitFor(() => expect(h.semanticStatus).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.semanticSearch).toHaveBeenCalled());

    h.semanticSearch.mockClear();
    fireEvent.click(screen.getByTestId("library-filter-type-card"));

    await waitFor(() =>
      expect(h.semanticSearch).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", type: "card" }),
      ),
    );
    await waitFor(() => {
      expect(
        within(screen.getByTestId("library-filter-type-extract")).getByText("2", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("library-filter-type-card")).getByText("3", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
    });
  });

  it("restores empty-query counts and prompt when the query becomes empty", async () => {
    h.searchQuery.mockResolvedValue({
      results: [h.sourceHit, h.cardHit],
      counts: {
        byType: { source: 7, extract: 3, card: 2 },
        byConcept: { "concept-1": 9 },
        byPriority: { A: 6, B: 4, C: 2, D: 0 },
      },
    });

    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        within(screen.getByTestId("library-filter-type-source")).getByText("7", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy(),
    );

    h.searchQuery.mockClear();
    h.libraryBrowse.mockClear();
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "" },
    });

    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source", "extract", "card"] }),
    );
    expect(await screen.findByTestId("library-prompt")).toBeTruthy();
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(h.searchQuery).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        within(screen.getByTestId("library-filter-type-source")).getByText("11", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy(),
    );
    const chip = screen.getByTestId("library-filter-concept-concept-1");
    await waitFor(() =>
      expect(within(chip).getByText("6", { selector: ".filter-opt__count" })).toBeTruthy(),
    );
    expect(within(chip).queryByText("9", { selector: ".filter-opt__count" })).toBeNull();
  });

  it("keeps stale async search responses from overwriting filterbar counters", async () => {
    const first = deferred<SearchQueryResult>();
    const second = deferred<SearchQueryResult>();
    h.searchQuery.mockImplementation((request: { q: string }) => {
      if (request.q === "alpha") return first.promise;
      if (request.q === "beta") return second.promise;
      return Promise.resolve({
        results: [],
        counts: EMPTY_TEST_SEARCH_COUNTS,
      } satisfies SearchQueryResult);
    });

    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "alpha" },
    });
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "alpha" })),
    );

    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "beta" },
    });
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "beta" })),
    );

    await act(async () => {
      second.resolve({
        results: [h.cardHit],
        counts: {
          byType: { source: 4, extract: 2, card: 1 },
          byConcept: { "concept-1": 1 },
          byPriority: { A: 9, B: 8, C: 0, D: 0 },
        },
      });
    });

    // Counts now apply via startTransition; wait for the commit (act flushes it, but the
    // waitFor keeps this read robust to future flush-order changes).
    await waitFor(() => {
      expect(
        within(screen.getByTestId("library-filter-type-source")).getByText("4", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
      expect(
        within(screen.getByTestId("library-filter-prio-A")).getByText("9", {
          selector: ".filter-opt__count",
        }),
      ).toBeTruthy();
    });

    await act(async () => {
      first.resolve({
        results: [h.sourceHit],
        counts: {
          byType: { source: 99, extract: 99, card: 99 },
          byConcept: { "concept-1": 99 },
          byPriority: { A: 99, B: 99, C: 99, D: 99 },
        },
      });
    });

    expect(
      within(screen.getByTestId("library-filter-type-source")).getByText("4", {
        selector: ".filter-opt__count",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("library-filter-prio-A")).getByText("9", {
        selector: ".filter-opt__count",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("library-filter-type-source")).queryByText("99", {
        selector: ".filter-opt__count",
      }),
    ).toBeNull();
  });

  it("keeps a stale empty-query browse response from overwriting a later keyword search", async () => {
    const initialBrowse = {
      items: [],
      counts: h.browseCounts,
    } satisfies LibraryBrowseResult;
    const facetBrowse = deferred<LibraryBrowseResult>();
    const keywordSearch = deferred<SearchQueryResult>();
    h.libraryBrowse
      .mockResolvedValueOnce(initialBrowse)
      .mockImplementationOnce(() => facetBrowse.promise);
    h.searchQuery.mockImplementation((request: { q: string }) => {
      if (request.q === "intelligence") return keywordSearch.promise;
      return Promise.resolve({ results: [], counts: EMPTY_TEST_SEARCH_COUNTS });
    });

    render(<LibraryScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByTestId("library-filter-concept-concept-1"));
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledTimes(2));

    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "intelligence" })),
    );

    await act(async () => {
      keywordSearch.resolve({
        results: [h.cardHit],
        counts: {
          byType: { source: 4, extract: 2, card: 1 },
          byConcept: { "concept-1": 1 },
          byPriority: { A: 9, B: 8, C: 0, D: 0 },
        },
      });
    });
    expect(await screen.findByTestId("library-group-card")).toBeTruthy();
    expect(
      within(screen.getByTestId("library-filter-type-source")).getByText("4", {
        selector: ".filter-opt__count",
      }),
    ).toBeTruthy();

    await act(async () => {
      facetBrowse.resolve({
        items: [h.sourceBrowseItem],
        counts: {
          all: 1,
          byType: { source: 99, extract: 99, card: 99, topic: 0, synthesis_note: 0, task: 0 },
          byConcept: { "concept-1": 99 },
          byPriority: { A: 99, B: 99, C: 99, D: 99 },
          byStatus: { active: 1, scheduled: 0, inbox: 0, pending: 0, done: 0, suspended: 0 },
        },
      });
    });

    expect(screen.getByTestId("library-group-card")).toBeTruthy();
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(
      within(screen.getByTestId("library-filter-type-source")).getByText("4", {
        selector: ".filter-opt__count",
      }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("library-filter-type-source")).queryByText("99", {
        selector: ".filter-opt__count",
      }),
    ).toBeNull();
  });

  it("keeps empty-query rows cleared while the next pending-filter count read fails", async () => {
    render(<LibraryScreen />);
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source", "extract", "card"] }),
    );

    const cardBrowse = deferred<LibraryBrowseResult>();
    h.libraryBrowse.mockClear();
    h.libraryBrowse.mockImplementationOnce(() => cardBrowse.promise);
    fireEvent.click(screen.getByTestId("library-filter-type-card"));

    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["card"] }));
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.getByTestId("library-pending-filters")).toBeTruthy();
    expect(screen.queryByTestId("library-group-card")).toBeNull();
    expect(screen.queryByTestId("library-detail")).toBeNull();

    await act(async () => {
      cardBrowse.reject(new Error("browse failed"));
    });

    expect((await screen.findByTestId("library-error")).textContent).toContain("browse failed");
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.queryByTestId("library-group-card")).toBeNull();
    expect(screen.queryByTestId("library-detail")).toBeNull();
  });

  it("keeps empty-query rows cleared when the final pending facet is cleared", async () => {
    render(<LibraryScreen />);
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source", "extract", "card"] }),
    );

    const promptCountsBrowse = deferred<LibraryBrowseResult>();
    h.libraryBrowse.mockClear();
    h.libraryBrowse.mockImplementationOnce(() => promptCountsBrowse.promise);
    fireEvent.click(screen.getByTestId("library-filter-type-source"));

    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source"] }));
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.getByTestId("library-pending-filters")).toBeTruthy();
    expect(screen.queryByTestId("library-group-source")).toBeNull();

    h.libraryBrowse.mockClear();
    h.libraryBrowse.mockImplementationOnce(() => promptCountsBrowse.promise);
    fireEvent.click(screen.getByTestId("library-filter-type-source"));
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({
        types: ["source", "extract", "card"],
      }),
    );
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(screen.queryByTestId("library-detail")).toBeNull();

    await act(async () => {
      promptCountsBrowse.resolve({
        items: [h.sourceBrowseItem, h.cardBrowseItem],
        counts: h.browseCounts,
      });
    });

    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(screen.queryByTestId("library-detail")).toBeNull();
  });

  it("narrows the query when a type filter is clicked", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    h.searchQuery.mockClear();
    h.searchQuery.mockResolvedValue({
      results: [h.cardHit],
      counts: {
        byType: { source: 0, extract: 0, card: 1 },
        byConcept: { "concept-1": 1 },
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
      },
    });
    fireEvent.click(screen.getByTestId("library-filter-type-card"));

    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", type: "card" }),
      ),
    );
  });

  it("narrows the query when a concept filter is clicked", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    h.searchQuery.mockClear();
    fireEvent.click(await screen.findByTestId("library-filter-concept-concept-1"));
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", conceptId: "concept-1" }),
      ),
    );
  });

  it("sends the priority facet to the backend (priorityLabel), not just client-side", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    h.searchQuery.mockClear();
    // Backend now returns the A-priority-narrowed set (both fixtures are A).
    h.searchQuery.mockResolvedValue({
      results: [h.sourceHit, h.cardHit],
      counts: {
        byType: { source: 1, extract: 0, card: 1 },
        byConcept: { "concept-1": 2 },
        byPriority: { A: 2, B: 0, C: 0, D: 0 },
      },
    });
    fireEvent.click(screen.getByTestId("library-filter-prio-A"));

    // The priority facet MUST be threaded to the query so the byConcept counts respect
    // it (the count-vs-list invariant) — it is no longer applied client-side only.
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", priorityLabel: "A" }),
      ),
    );
  });

  it("priority + concept active: the chip count equals the visible row count (count-vs-list)", async () => {
    // The /search count-vs-list invariant finding #1 fixed, at the renderer seam: with
    // a Priority facet AND a concept active, the chip's byConcept number must equal the
    // number of result rows shown. The backend returns the priority-narrowed list +
    // a byConcept already scoped to that priority; the renderer must render them in sync
    // (no client-side priority re-filtering that would desync the chip from the list).
    render(<LibraryScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    // Activate priority A: the backend returns ONE A-priority member (the card) of the
    // concept and a byConcept of 1 (priority-scoped) — chip 1 must equal the 1 visible row.
    h.searchQuery.mockResolvedValue({
      results: [h.cardHit],
      counts: {
        byType: { source: 0, extract: 0, card: 1 },
        byConcept: { "concept-1": 1 },
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
      },
    });
    fireEvent.click(screen.getByTestId("library-filter-prio-A"));

    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ priorityLabel: "A" })),
    );

    // The visible rows narrowed to 1…
    await waitFor(() => expect(screen.getAllByTestId("library-result").length).toBe(1));
    // …and the concept chip count matches that 1 (the count-vs-list invariant).
    const chip = await screen.findByTestId("library-filter-concept-concept-1");
    expect(within(chip).getByText("1", { selector: ".filter-opt__count" })).toBeTruthy();
  });

  it("renders the DRILL-DOWN byConcept count on the chip, NOT the global memberCount", async () => {
    // The concept's GLOBAL memberCount is 9 (the Map volume), but under the active
    // keyword the drill-down count is 1 — the chip must show the drill-down value so
    // it matches the narrowed result list (the reported chip/list mismatch fix).
    h.searchQuery.mockResolvedValue({
      results: [h.cardHit],
      counts: {
        byType: { source: 0, extract: 0, card: 1 },
        byConcept: { "concept-1": 1 },
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
      },
    });
    render(<LibraryScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(h.searchQuery).toHaveBeenCalled());

    const chip = await screen.findByTestId("library-filter-concept-concept-1");
    await waitFor(() =>
      expect(within(chip).getByText("1", { selector: ".filter-opt__count" })).toBeTruthy(),
    );
    // The global memberCount (9) must NOT be what the chip shows.
    expect(within(chip).queryByText("9", { selector: ".filter-opt__count" })).toBeNull();
  });

  it("shows the empty state when there are no matches", async () => {
    h.searchQuery.mockResolvedValue({
      results: [],
      counts: {
        byType: { source: 0, extract: 0, card: 0 },
        byConcept: {},
        byPriority: { A: 0, B: 0, C: 0, D: 0 },
      },
    });
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "zzzznope" },
    });
    expect(await screen.findByTestId("library-empty")).toBeTruthy();
  });

  it("opens source and card results in their detail surfaces", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "intelligence" })),
    );
    expect(h.searchQuery.mock.calls[0]?.[0]).not.toHaveProperty("type");
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));

    // The Open control is published to the inspector bridge; invoking it navigates.
    const sourcePanel = await panelFor("src-1");
    expect(sourcePanel.openLabel).toBe("Open source");
    act(() => sourcePanel.onOpen());
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });
    // The load-bearing leak guard: the payload is cleared before navigating away.
    expect(h.setLibraryPanelSpy).toHaveBeenLastCalledWith(null);

    h.searchQuery.mockClear();
    fireEvent.click(screen.getByTestId("library-filter-type-card"));
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", type: "card" }),
      ),
    );
    // Result application runs in a startTransition; the warm list keeps the old rows
    // until it commits. Wait for the type=card set to settle (sources gone) so we
    // select a live card row, not a stale node the transition is about to replace.
    await waitFor(() => expect(screen.queryByTestId("library-group-source")).toBeNull());
    const cardGroup = await screen.findByTestId("library-group-card");
    fireEvent.click(within(cardGroup).getByTestId("library-result"));
    const cardPanel = await panelFor("card-1");
    act(() => cardPanel.onOpen());
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
    });
  });

  it("clears the published payload on unmount (cross-route leak guard)", async () => {
    const { unmount } = render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "intelligence" })),
    );
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));
    await panelFor("src-1");

    unmount();
    // The belt of the leak guard: the bridge payload is cleared on unmount.
    expect(h.setLibraryPanelSpy).toHaveBeenLastCalledWith(null);
  });

  it("selecting a search result publishes the open payload and sets universal selection", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "intelligence" })),
    );

    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));

    expect(h.selectSpy).toHaveBeenCalledWith("src-1");
    const panel = await panelFor("src-1");
    expect(panel.openLabel).toBe("Open source");
    expect(panel.parked).toBeNull();
  });

  it("does NOT re-render the heavy results subtree on a keystroke (U1 stutter regression)", async () => {
    vi.useFakeTimers();
    try {
      render(<LibraryScreen />);
      // Drive a query and let the debounced search resolve so result rows (each with
      // a counted `Prio`) are on screen.
      fireEvent.change(screen.getByTestId("library-search-input"), {
        target: { value: "intelligence" },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200); // debounce (150 ms) + the search promise
      });
      // Sanity: result rows rendered (so the heavy subtree is actually present).
      expect(screen.getAllByTestId("library-result").length).toBeGreaterThan(0);

      // Snapshot the render count, then type another character. Within the debounce
      // window the parent must not re-render — the isolated field owns the raw text.
      const before = h.prioRenderCount.current;
      // Guard against a vacuous pass: the counter must actually be counting Prio
      // renders, else `toBe(before)` below would hold trivially at 0 if Prio were
      // ever refactored out of the row.
      expect(before).toBeGreaterThan(0);
      fireEvent.change(screen.getByTestId("library-search-input"), {
        target: { value: "intelligencee" },
      });
      // The visible input reflects the keystroke immediately…
      expect((screen.getByTestId("library-search-input") as HTMLInputElement).value).toBe(
        "intelligencee",
      );
      // …but the heavy results subtree did NOT re-render (Prio count unchanged).
      expect(h.prioRenderCount.current).toBe(before);

      // Drain the pending debounce timer so no act() warning leaks past the test.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-renders only the affected rows on selection — memoized rows, not the whole list (Fix 2)", async () => {
    // Seed a multi-row result set so the memoization win is observable: selecting a row
    // must re-render only the newly-selected row (+ the detail), NOT every row. Before
    // the rows were memoized, a selId change re-rendered the entire list.
    const rows = Array.from({ length: 6 }, (_, i) => ({
      ...h.sourceHit,
      id: `src-${i}`,
      title: `Intelligence source ${i}`,
    }));
    h.searchQuery.mockResolvedValue({
      results: rows,
      counts: {
        byType: { source: 6, extract: 0, card: 0 },
        byConcept: {},
        byPriority: { A: 6, B: 0, C: 0, D: 0 },
      },
    });

    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() => expect(screen.getAllByTestId("library-result").length).toBe(6));

    const before = h.prioRenderCount.current;
    expect(before).toBeGreaterThan(0); // guard against a vacuous pass
    const firstRow = screen.getAllByTestId("library-result")[0];
    if (!firstRow) throw new Error("expected at least one result row");
    fireEvent.click(firstRow);
    await waitFor(() => expect(latestPanel()).not.toBeNull());

    // Only the selected row's `Prio` re-rendered — a small, bounded delta, NOT the
    // 6+ a full-list reconciliation would cost.
    const delta = h.prioRenderCount.current - before;
    expect(delta).toBeLessThanOrEqual(3);
    expect(delta).toBeLessThan(rows.length);
  });

  it("applies a cold search via a transition: Searching… then results, never the empty flash (solution #1)", async () => {
    // Result application (setResults/setSearchCounts/setSearchMode/setLoading) is wrapped
    // in startTransition so the heavy reconcile is interruptible and yields to keystrokes.
    // setLoading(false) co-commits with the rows so a COLD search never flashes the empty
    // state between the spinner turning off and the deferred results landing. (The
    // interruptibility itself isn't observable in jsdom, where act() flushes transitions;
    // it's verified before/after in the running app. This guards the loading↔results
    // coordination + that we don't drop/reorder the applied result set.)
    const pending = deferred<SearchQueryResult>();
    h.searchQuery.mockReturnValue(pending.promise);

    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });

    // Cold search (no prior rows): the loading placeholder shows while in flight, and the
    // empty state is NOT rendered for a query that will return matches.
    expect(await screen.findByTestId("library-loading")).toBeTruthy();
    expect(screen.queryByTestId("library-empty")).toBeNull();

    await act(async () => {
      pending.resolve({
        results: [h.sourceHit, h.cardHit],
        counts: {
          byType: { source: 1, extract: 0, card: 1 },
          byConcept: { "concept-1": 2 },
          byPriority: { A: 2, B: 0, C: 0, D: 0 },
        },
      });
    });

    // Both rows applied; the spinner cleared WITH the results (no lingering spinner) and
    // the empty state never appeared for this non-empty result.
    await waitFor(() => expect(screen.getAllByTestId("library-result").length).toBe(2));
    expect(screen.queryByTestId("library-loading")).toBeNull();
    expect(screen.queryByTestId("library-empty")).toBeNull();
  });

  it("clears the spinner and shows an error when a search rejects (.catch, no stuck loading)", async () => {
    // Guards the removal of `.finally`: setLoading(false) now lives in the success
    // transition AND the failure `.catch`. A rejected search must still clear the spinner
    // (urgently) and surface the error — never leave "Searching…" stuck.
    const pending = deferred<SearchQueryResult>();
    h.searchQuery.mockReturnValue(pending.promise);

    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    expect(await screen.findByTestId("library-loading")).toBeTruthy();

    await act(async () => {
      pending.reject(new Error("search failed"));
    });

    expect((await screen.findByTestId("library-error")).textContent).toContain("search failed");
    expect(screen.queryByTestId("library-loading")).toBeNull();
  });

  // The selection's scheduler chip + due badge moved out of the deleted detail
  // column into the shared shell inspector (covered by Inspector.test.tsx). The
  // Library screen no longer renders them, so the kit-parity assertion lives there.
});
