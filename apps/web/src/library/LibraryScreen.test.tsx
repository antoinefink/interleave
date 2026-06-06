/**
 * LibraryScreen component tests (T042).
 *
 * Search/index/ranking all live MAIN-side (`SearchRepository` + the FTS migration);
 * this asserts the RENDERER seam of the library view:
 *  - typing a query calls `appApi.searchQuery` (debounced) with the trimmed term;
 *  - grouped results render with the query highlighted (`<em>`);
 *  - clicking a type/concept filter narrows the call;
 *  - an empty result set shows the EmptyState; an empty query shows the prompt.
 *
 * `appApi` + the router are mocked so the test exercises ONLY this component's
 * wiring; no SQLite/IPC — the renderer is a pure UI consumer here.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConceptNode, SearchResult } from "../lib/appApi";

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
  const concept: ConceptNode = {
    id: "concept-1",
    name: "Intelligence",
    parentConceptId: null,
    childCount: 0,
    memberCount: 2,
    desiredRetention: null,
  };
  return {
    sourceHit,
    cardHit,
    concept,
    navigateSpy: vi.fn(),
    searchQuery: vi.fn(),
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
  // chip renders these (NOT the global ConceptNode.memberCount). Default world: 2
  // matched members of concept-1 (a source + a card).
  h.searchQuery.mockResolvedValue({
    results: [h.sourceHit, h.cardHit],
    counts: { byConcept: { "concept-1": 2 } },
  });
  h.listConcepts.mockResolvedValue({ concepts: [h.concept] });
  // Semantic search OFF by default → the library uses the FTS `searchQuery` path.
  h.semanticStatus.mockResolvedValue({
    enabled: false,
    vecAvailable: false,
    modelDownloaded: false,
    embedded: 0,
    total: 0,
    modelId: "",
  });
  h.semanticSearch.mockResolvedValue({ results: [], mode: "disabled" });
  h.semanticReindex.mockResolvedValue({ enqueued: 0 });
  h.subscribeJobs.mockReturnValue(() => {});
});

describe("LibraryScreen", () => {
  it("starts with the search prompt and no query call", async () => {
    render(<LibraryScreen />);
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    // The concept list loads for the filterbar/map.
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    expect(h.searchQuery).not.toHaveBeenCalled();
  });

  it("shows the GLOBAL concept memberCount on the chip when there is NO query (not a wall of 0s)", async () => {
    // Empty-query state: keyword search returns [] (no drill-down `byConcept`), so the
    // chip must fall back to the concept's GLOBAL memberCount (2) — the same number the
    // Map shows — rather than `0`. (The reported symptom was every concept chip reading
    // `0` on the empty `/search` screen even though members exist.)
    render(<LibraryScreen />);
    const chip = await screen.findByTestId("library-filter-concept-concept-1");
    await waitFor(() =>
      expect(within(chip).getByText("2", { selector: ".filter-opt__count" })).toBeTruthy(),
    );
    // And no query was issued (the chip number came from listConcepts, not searchQuery).
    expect(h.searchQuery).not.toHaveBeenCalled();
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
    // The no-query prompt is shown, but with the index complete there is no button.
    expect(await screen.findByTestId("library-prompt")).toBeTruthy();
    await waitFor(() => expect(h.semanticStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("library-build-index")).toBeNull();
  });

  it("searches (debounced) on input and renders grouped, highlighted results", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });

    await waitFor(() =>
      expect(h.searchQuery).toHaveBeenCalledWith(expect.objectContaining({ q: "intelligence" })),
    );

    // Both groups render.
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(screen.getByTestId("library-group-card")).toBeTruthy();

    // The matched term is highlighted in a result title.
    const rows = screen.getAllByTestId("library-result");
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.querySelector("em"))).toBe(true);
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
      counts: { byConcept: { "concept-1": 1 } },
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
      counts: { byConcept: { "concept-1": 2 } },
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
      counts: { byConcept: { "concept-1": 1 } },
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
    // The concept's GLOBAL memberCount is 2 (the Map volume), but under the active
    // keyword the drill-down count is 1 — the chip must show the drill-down value so
    // it matches the narrowed result list (the reported chip/list mismatch fix).
    h.searchQuery.mockResolvedValue({
      results: [h.cardHit],
      counts: { byConcept: { "concept-1": 1 } },
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
    // The global memberCount (2) must NOT be what the chip shows.
    expect(within(chip).queryByText("2", { selector: ".filter-opt__count" })).toBeNull();
  });

  it("shows the empty state when there are no matches", async () => {
    h.searchQuery.mockResolvedValue({ results: [], counts: { byConcept: {} } });
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
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));

    // The detail panel shows; clicking Open navigates to the source reader.
    fireEvent.click(await screen.findByTestId("library-detail-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });

    const cardGroup = screen.getByTestId("library-group-card");
    fireEvent.click(within(cardGroup).getByTestId("library-result"));
    fireEvent.click(await screen.findByTestId("library-detail-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
    });
  });

  it("shows the scheduler chip + due badge in the selection detail (kit parity)", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
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
