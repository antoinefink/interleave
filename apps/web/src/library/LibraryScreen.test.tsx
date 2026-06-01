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
  };
  return {
    sourceHit,
    cardHit,
    concept,
    navigateSpy: vi.fn(),
    searchQuery: vi.fn(),
    listConcepts: vi.fn(),
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
});

describe("LibraryScreen", () => {
  it("starts with the search prompt and no query call", async () => {
    render(<LibraryScreen />);
    expect(screen.getByTestId("library-prompt")).toBeTruthy();
    // The concept list loads for the filterbar/map.
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    expect(h.searchQuery).not.toHaveBeenCalled();
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

  it("opens a result in context on click + open button", async () => {
    render(<LibraryScreen />);
    fireEvent.change(screen.getByTestId("library-search-input"), {
      target: { value: "intelligence" },
    });
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));

    // The detail panel shows; clicking Open navigates to the source reader.
    fireEvent.click(await screen.findByTestId("library-detail-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });
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
