/**
 * LibraryScreen component tests (T042).
 *
 * Search/index/ranking all live MAIN-side (`SearchRepository` + the FTS migration);
 * this asserts the RENDERER seam of the library view:
 *  - typing a query calls `appApi.searchQuery` (debounced) with the trimmed term;
 *  - grouped results render with the query highlighted (`<em>`);
 *  - clicking a type/concept filter narrows the call;
 *  - an empty result set shows the EmptyState; the empty default view browses Sources.
 *
 * `appApi` + the router are mocked so the test exercises ONLY this component's
 * wiring; no SQLite/IPC — the renderer is a pure UI consumer here.
 */

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
    dueLabel: "Scheduled",
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
    scheduler: sourceHit.scheduler,
    due: sourceHit.due,
    dueLabel: sourceHit.dueLabel,
    linkedElementId: null,
    linkedElementType: null,
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
    scheduler: cardHit.scheduler,
    due: cardHit.due,
    dueLabel: cardHit.dueLabel,
    linkedElementId: null,
    linkedElementType: null,
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
    scheduler: attentionScheduler,
    due: "soon",
    dueLabel: "Scheduled",
    linkedElementId: null,
    linkedElementType: null,
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
    searchQuery: vi.fn(),
    libraryBrowse: vi.fn(),
    listConcepts: vi.fn(),
    // Semantic search (T087) — default OFF so these tests exercise the FTS path.
    semanticStatus: vi.fn(),
    semanticSearch: vi.fn(),
    semanticReindex: vi.fn(),
    subscribeJobs: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
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

import { LibraryScreen } from "./LibraryScreen";

beforeEach(() => {
  vi.clearAllMocks();
  // The backend now returns DRILL-DOWN per-concept counts alongside the rows; the
  // chip renders these (NOT the global ConceptNode.memberCount). The mock honors
  // the active type facet so the default Sources view behaves like the real bridge.
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
  // Semantic search OFF by default → the library uses the FTS `searchQuery` path.
  h.semanticStatus.mockResolvedValue({
    enabled: false,
    vecAvailable: false,
    modelDownloaded: false,
    embedded: 0,
    total: 0,
    modelId: "",
  });
  h.semanticSearch.mockResolvedValue({
    results: [],
    mode: "disabled",
    counts: EMPTY_TEST_SEARCH_COUNTS,
  });
  h.semanticReindex.mockResolvedValue({ enqueued: 0 });
  h.subscribeJobs.mockReturnValue(() => {});
});

describe("LibraryScreen", () => {
  it("starts by browsing Sources and no query call", async () => {
    render(<LibraryScreen />);
    expect(screen.queryByTestId("library-prompt")).toBeNull();
    // The concept list loads for the filterbar/map, and the browse bridge loads
    // the default Sources view instead of leaving the page on a blank prompt.
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({
        types: ["source"],
      }),
    );
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(screen.queryByTestId("library-group-card")).toBeNull();
    expect(h.searchQuery).not.toHaveBeenCalled();
  });

  it("shows empty-query browse counts on Type, Concept, and Priority chips", async () => {
    // The concept's GLOBAL memberCount is 9, but the /search empty-query filterbar
    // is bounded to source/extract/card and reads the browse drill-down count (6).
    render(<LibraryScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());
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

  it("clears the default Sources facet back to the search prompt", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source"] }));
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();

    h.libraryBrowse.mockClear();
    h.libraryBrowse.mockResolvedValueOnce({
      items: [h.sourceBrowseItem, h.cardBrowseItem],
      counts: h.browseCounts,
    });
    fireEvent.click(screen.getByTestId("library-filter-type-source"));

    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({
        types: ["source", "extract", "card"],
      }),
    );
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(screen.queryByTestId("library-group-card")).toBeNull();
    expect(h.searchQuery).not.toHaveBeenCalled();
  });

  it("browses concepts with no query while staying bounded to searchable rows", async () => {
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
        types: ["source"],
        conceptId: "concept-1",
      }),
    );
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(screen.queryByTestId("library-group-topic")).toBeNull();
    expect(document.querySelector('[data-result-type="topic"]')).toBeNull();
  });

  it("browses priority with no query while staying bounded to searchable rows", async () => {
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
        types: ["source"],
        priorityLabel: "A",
      }),
    );
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(document.querySelector('[data-result-type="topic"]')).toBeNull();
  });

  it("shows the 'Build index (N of M embedded)' affordance when semantics are enabled but the index is incomplete, and reindexes on click (T087)", async () => {
    // Semantics ON + vec available, but only 1 of 3 elements embedded.
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 1,
      total: 3,
      modelId: "local:all-MiniLM-L6-v2",
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
      modelId: "local:all-MiniLM-L6-v2",
    });
    render(<LibraryScreen />);
    // The no-query default Sources view is shown, but with the index complete there is no button.
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    await waitFor(() => expect(h.semanticStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("library-build-index")).toBeNull();
  });

  it("searches (debounced) on input inside the default Sources view", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });

    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", type: "source" }),
      ),
    );

    // The default Source facet remains active until the user changes it.
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(screen.queryByTestId("library-group-card")).toBeNull();

    // The matched term is highlighted in a result title.
    const rows = screen.getAllByTestId("library-result");
    expect(rows.length).toBe(1);
    expect(rows.some((r) => r.querySelector("em"))).toBe(true);
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

  it("renders semantic-search counts instead of zeroing the filterbar", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 2,
      total: 2,
      modelId: "test-model",
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

  it("keeps semantic byType counts populated when a type filter is active", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 2,
      total: 2,
      modelId: "test-model",
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

  it("restores empty-query browse counters when the query becomes empty", async () => {
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
    expect(
      within(screen.getByTestId("library-filter-type-source")).getByText("7", {
        selector: ".filter-opt__count",
      }),
    ).toBeTruthy();

    h.searchQuery.mockClear();
    h.libraryBrowse.mockClear();
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "" },
    });

    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source"] }));
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(screen.queryByTestId("library-prompt")).toBeNull();
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

  it("clears stale empty-query facet rows while the next facet browse is pending or failed", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source"] }));
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));
    expect(await screen.findByTestId("library-detail")).toBeTruthy();

    const cardBrowse = deferred<LibraryBrowseResult>();
    h.libraryBrowse.mockClear();
    h.libraryBrowse.mockImplementationOnce(() => cardBrowse.promise);
    fireEvent.click(screen.getByTestId("library-filter-type-card"));

    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["card"] }));
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(screen.queryByTestId("library-detail")).toBeNull();
    expect(screen.getByTestId("library-loading")).toBeTruthy();

    await act(async () => {
      cardBrowse.reject(new Error("browse failed"));
    });

    expect((await screen.findByTestId("library-error")).textContent).toContain("browse failed");
    expect(screen.queryByTestId("library-group-source")).toBeNull();
    expect(screen.queryByTestId("library-detail")).toBeNull();
  });

  it("clears empty-query rows and selection immediately when the final facet is cleared", async () => {
    render(<LibraryScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({ types: ["source"] }));
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));
    expect(await screen.findByTestId("library-detail")).toBeTruthy();

    const promptCountsBrowse = deferred<LibraryBrowseResult>();
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
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", type: "source" }),
      ),
    );
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));

    // The detail panel shows; clicking Open navigates to the source reader.
    fireEvent.click(await screen.findByTestId("library-detail-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });

    h.searchQuery.mockClear();
    fireEvent.click(screen.getByTestId("library-filter-type-card"));
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", type: "card" }),
      ),
    );
    const cardGroup = await screen.findByTestId("library-group-card");
    fireEvent.click(within(cardGroup).getByTestId("library-result"));
    fireEvent.click(await screen.findByTestId("library-detail-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
    });
  });

  it("shows the scheduler chip + due badge in the selection detail (kit parity)", async () => {
    render(<LibraryScreen />);
    fireEvent.click(screen.getByTestId("library-filter-type-card"));
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(
        expect.objectContaining({ q: "intelligence", type: "card" }),
      ),
    );
    // Select the card hit (FSRS scheduler + a due date).
    const cardGroup = await screen.findByTestId("library-group-card");
    fireEvent.click(within(cardGroup).getByTestId("library-result"));

    const detail = await screen.findByTestId("library-detail");
    // The load-bearing scheduler split is surfaced (FSRS chip for the card).
    const chip = within(detail).getByTestId("scheduler-chip");
    expect(chip.getAttribute("data-scheduler")).toBe("fsrs");
    // And the due badge reflects the result's dueLabel.
    expect(within(detail).getByTestId("library-detail-due").textContent).toContain("Due today");
  });
});
