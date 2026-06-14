/**
 * BrowseScreen component tests (`/library`).
 *
 * The browse list/ordering/counts/enrichment all live MAIN-side (`LibraryQuery` +
 * the `library.browse` bridge); this asserts the RENDERER seam of the browse view:
 *  - it lists ALL groups from a mocked browse payload with NO query/facet
 *    (the browse-first default — unlike /search, which shows a prompt when empty);
 *  - toggling a Type / Priority / Status / Concept facet re-calls `libraryBrowse`
 *    with the right filter (the renderer holds no SQL — it toggles facet state);
 *  - selecting a row shows the detail panel + RefBlock + the load-bearing chip;
 *  - Open navigates per type;
 *  - the Map tab renders the shared ConceptGraph.
 *
 * `appApi` + the router are mocked so the test exercises ONLY this component's
 * wiring; no SQLite/IPC — the renderer is a pure UI consumer here.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConceptNode, LibraryItem } from "../lib/appApi";

const h = vi.hoisted(() => {
  const attentionScheduler: LibraryItem["scheduler"] = {
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
  const fsrsScheduler: LibraryItem["scheduler"] = {
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
  const sourceRow: LibraryItem = {
    id: "src-1",
    type: "source",
    title: "On the Measure of Intelligence",
    priority: 0.9,
    priorityLabel: "A",
    status: "active",
    stage: "raw_source",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
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
  const topicRow: LibraryItem = {
    id: "topic-1",
    type: "topic",
    title: "Machine learning fundamentals",
    priority: 0.9,
    priorityLabel: "A",
    status: "active",
    stage: "rough_topic",
    concept: null,
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
  const parkedRow: LibraryItem = {
    ...sourceRow,
    id: "src-parked-1",
    title: "Parked reading",
    status: "parked",
    dueAt: null,
    parkedAt: "2026-06-09T10:00:00.000Z",
    dueLabel: "Parked",
    queueEligible: false,
    notInQueueReason: "Not in queue: status is Parked",
  };
  const cardRow: LibraryItem = {
    id: "card-1",
    type: "card",
    title: "Chollet's definition of intelligence",
    priority: 0.9,
    priorityLabel: "A",
    status: "scheduled",
    stage: "active_card",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "Definition · ¶1",
    dueAt: "2026-06-01T00:00:00.000Z",
    parkedAt: null,
    scheduler: fsrsScheduler,
    due: "today",
    dueLabel: "Due today",
    queueEligible: true,
    notInQueueReason: null,
    linkedElementId: null,
    linkedElementType: null,
    taskType: null,
  };
  const taskRow: LibraryItem = {
    id: "task-1",
    type: "task",
    title: "Verify claim: this item",
    priority: 0.9,
    priorityLabel: "A",
    status: "pending",
    stage: "rough_topic",
    concept: "Intelligence",
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "Definition · ¶1",
    dueAt: "2026-06-02T00:00:00.000Z",
    parkedAt: null,
    scheduler: attentionScheduler,
    due: "soon",
    dueLabel: "in 1d",
    queueEligible: false,
    notInQueueReason: "Not in queue: returns Jun 2",
    linkedElementId: "card-1",
    linkedElementType: "card",
    taskType: "verify_claim",
  };
  // A system "Weekly review" task: no linked element, routed by its taskType to the
  // dedicated /weekly surface (NOT the process loop / next due card). Regression guard
  // for the contract carrying `taskType` through to `openQueueItem`.
  const weeklyTaskRow: LibraryItem = {
    ...taskRow,
    id: "task-weekly-1",
    title: "Weekly review",
    priorityLabel: "D",
    status: "scheduled",
    stage: "rough_topic",
    concept: null,
    sourceTitle: null,
    sourceLocationLabel: null,
    notInQueueReason: "Not in queue: summary unavailable",
    linkedElementId: null,
    linkedElementType: null,
    taskType: "weekly_review",
  };
  const concept: ConceptNode = {
    id: "concept-1",
    name: "Intelligence",
    parentConceptId: null,
    childCount: 0,
    // The GLOBAL member count (Map-tab volume) — deliberately DIFFERENT from the
    // drill-down `byConcept` count below, so a test can prove the filterbar chip
    // reads the filter-scoped count, not this global total.
    memberCount: 9,
    desiredRetention: null,
  };
  const counts = {
    all: 3,
    byType: { source: 1, extract: 0, card: 1, topic: 1, synthesis_note: 0, task: 0 },
    // Drill-down per-concept counts (keyed by concept element id): the source + card
    // are both members of "Intelligence" (concept-1), so its chip drill-down is 2.
    byConcept: { "concept-1": 2 },
    byPriority: { A: 3, B: 0, C: 0, D: 0 },
    byStatus: { active: 2, scheduled: 1, inbox: 0, pending: 0, done: 0, parked: 0, suspended: 0 },
  };
  return {
    sourceRow,
    topicRow,
    parkedRow,
    cardRow,
    taskRow,
    weeklyTaskRow,
    concept,
    counts,
    navigateSpy: vi.fn(),
    routeSearch: {} as Record<string, unknown>,
    selectSpy: vi.fn(),
    libraryBrowse: vi.fn(),
    libraryParkedAction: vi.fn(),
    listConcepts: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => h.routeSearch,
}));

vi.mock("../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      libraryBrowse: h.libraryBrowse,
      libraryParkedAction: h.libraryParkedAction,
      listConcepts: h.listConcepts,
    },
  };
});

import { BrowseScreen } from "./BrowseScreen";

function parkedCounts(count: number) {
  return {
    ...h.counts,
    all: count,
    byType: { ...h.counts.byType, source: count },
    byStatus: {
      active: 0,
      scheduled: 0,
      inbox: 0,
      pending: 0,
      done: 0,
      parked: count,
      suspended: 0,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.routeSearch = {};
  h.libraryBrowse.mockResolvedValue({
    items: [h.sourceRow, h.topicRow, h.cardRow],
    counts: h.counts,
  });
  h.libraryParkedAction.mockResolvedValue({
    item: { ...h.parkedRow, status: "inbox", parkedAt: null },
  });
  h.listConcepts.mockResolvedValue({ concepts: [h.concept] });
});

describe("BrowseScreen", () => {
  it("lists ALL groups from the browse payload with no query (browse-first default)", async () => {
    render(<BrowseScreen />);
    // No keyword required — the browse runs immediately and renders the groups.
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());
    expect(await screen.findByTestId("library-group-source")).toBeTruthy();
    expect(screen.getByTestId("library-group-topic")).toBeTruthy();
    expect(screen.getByTestId("library-group-card")).toBeTruthy();
    // The calm count summary reflects the payload total.
    expect(screen.getByTestId("library-count").textContent).toContain("3 elements");
    // The very first call carried no facet filters.
    expect(h.libraryBrowse).toHaveBeenCalledWith({});
  });

  it("hydrates Browse facets and the visible-title filter from route params", async () => {
    h.routeSearch = {
      type: "card",
      conceptId: "concept-1",
      priority: "A",
      status: "scheduled",
      q: "Chollet",
    };

    render(<BrowseScreen />);

    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({
        types: ["card"],
        conceptId: "concept-1",
        priorityLabel: "A",
        statuses: ["scheduled"],
      }),
    );
    expect((screen.getByTestId("library-title-filter") as HTMLInputElement).value).toBe("Chollet");
    expect(screen.getByTestId("library-filter-type-card").className).toContain("filter-opt--on");
    expect(screen.getByTestId("library-filter-prio-A").className).toContain("filter-opt--on");
    expect(screen.getByTestId("library-filter-status-scheduled").className).toContain(
      "filter-opt--on",
    );
    expect((await screen.findByTestId("library-filter-concept-concept-1")).className).toContain(
      "filter-opt--on",
    );
  });

  it("resets Browse filters when the same Library route clears URL params", async () => {
    h.routeSearch = { type: "topic", status: "scheduled", q: "machine" };
    const { rerender } = render(<BrowseScreen />);
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith({
        types: ["topic"],
        statuses: ["scheduled"],
      }),
    );

    h.libraryBrowse.mockClear();
    h.routeSearch = {};
    rerender(<BrowseScreen />);

    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledWith({}));
    expect((screen.getByTestId("library-title-filter") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("library-filter-type-topic").className).not.toContain(
      "filter-opt--on",
    );
    expect(screen.getByTestId("library-filter-status-scheduled").className).not.toContain(
      "filter-opt--on",
    );
  });

  it("re-calls libraryBrowse with a type filter when a Type facet is toggled", async () => {
    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    h.libraryBrowse.mockClear();
    fireEvent.click(screen.getByTestId("library-filter-type-card"));
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith(expect.objectContaining({ types: ["card"] })),
    );
  });

  it("re-calls libraryBrowse with a priority filter when a Priority facet is toggled", async () => {
    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    h.libraryBrowse.mockClear();
    fireEvent.click(screen.getByTestId("library-filter-prio-A"));
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith(expect.objectContaining({ priorityLabel: "A" })),
    );
  });

  it("re-calls libraryBrowse with a status filter when a Status facet is toggled", async () => {
    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    h.libraryBrowse.mockClear();
    fireEvent.click(screen.getByTestId("library-filter-status-active"));
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith(
        expect.objectContaining({ statuses: ["active"] }),
      ),
    );
  });

  it.each([
    ["library-unpark-inbox", "moveToInbox"],
    ["library-unpark-schedule", "queueSoon"],
    ["library-unpark-dismiss", "dismiss"],
  ] as const)("sends %s parked action and refreshes counts", async (testId, kind) => {
    h.libraryBrowse
      .mockResolvedValueOnce({ items: [h.sourceRow, h.topicRow, h.cardRow], counts: h.counts })
      .mockResolvedValueOnce({ items: [h.parkedRow], counts: parkedCounts(1) })
      .mockResolvedValueOnce({ items: [], counts: parkedCounts(0) });
    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("library-filter-status-parked"));
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith(
        expect.objectContaining({ statuses: ["parked"] }),
      ),
    );
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));

    const detail = await screen.findByTestId("library-detail");
    expect(within(detail).getByTestId("library-detail-parked-date").textContent).toContain(
      "Parked",
    );
    fireEvent.click(within(detail).getByTestId(testId));
    await waitFor(() =>
      expect(h.libraryParkedAction).toHaveBeenCalledWith({
        id: "src-parked-1",
        action: { kind },
      }),
    );
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenLastCalledWith({ statuses: ["parked"] }));
    expect(screen.getByTestId("library-count").textContent).toContain("0 elements");
    expect(screen.queryByTestId("library-detail")).toBeNull();
    expect(h.selectSpy).toHaveBeenLastCalledWith(null);
  });

  it("renders parked action errors without removing the selected row", async () => {
    h.libraryBrowse
      .mockResolvedValueOnce({ items: [h.sourceRow, h.topicRow, h.cardRow], counts: h.counts })
      .mockResolvedValueOnce({ items: [h.parkedRow], counts: parkedCounts(1) });
    h.libraryParkedAction.mockRejectedValueOnce(new Error("Unable to move parked source"));

    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("library-filter-status-parked"));
    await screen.findByTestId("library-group-source");
    fireEvent.click(screen.getByTestId("library-result"));
    fireEvent.click(
      within(await screen.findByTestId("library-detail")).getByTestId("library-unpark-inbox"),
    );

    expect(await screen.findByTestId("library-error")).toHaveTextContent(
      "Unable to move parked source",
    );
    expect(screen.getAllByText("Parked reading").length).toBeGreaterThan(0);
  });

  it("disables all parked action buttons while one action is pending", async () => {
    let resolveAction!: (value: { item: LibraryItem }) => void;
    h.libraryBrowse
      .mockResolvedValueOnce({ items: [h.sourceRow, h.topicRow, h.cardRow], counts: h.counts })
      .mockResolvedValueOnce({ items: [h.parkedRow], counts: parkedCounts(1) })
      .mockResolvedValueOnce({ items: [], counts: parkedCounts(0) });
    h.libraryParkedAction.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAction = resolve;
      }),
    );

    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("library-filter-status-parked"));
    await screen.findByTestId("library-group-source");
    fireEvent.click(screen.getByTestId("library-result"));

    const detail = await screen.findByTestId("library-detail");
    fireEvent.click(within(detail).getByTestId("library-unpark-schedule"));
    await waitFor(() => {
      expect(within(detail).getByTestId("library-unpark-inbox")).toBeDisabled();
      expect(within(detail).getByTestId("library-unpark-schedule")).toBeDisabled();
      expect(within(detail).getByTestId("library-unpark-dismiss")).toBeDisabled();
    });

    await act(async () => {
      resolveAction({ item: { ...h.parkedRow, status: "scheduled", parkedAt: null } });
    });
    await waitFor(() => expect(screen.queryByTestId("library-detail")).toBeNull());
  });

  it("re-calls libraryBrowse with a concept filter when a Concept facet is toggled", async () => {
    render(<BrowseScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    h.libraryBrowse.mockClear();
    fireEvent.click(await screen.findByTestId("library-filter-concept-concept-1"));
    await waitFor(() =>
      expect(h.libraryBrowse).toHaveBeenCalledWith(
        expect.objectContaining({ conceptId: "concept-1" }),
      ),
    );
  });

  it("narrows the visible list by the inline title filter (client-side, no FTS call)", async () => {
    render(<BrowseScreen />);
    await screen.findByTestId("library-group-topic");

    h.libraryBrowse.mockClear();
    fireEvent.change(screen.getByTestId("library-title-filter"), {
      target: { value: "machine" },
    });
    // Only the topic title matches "machine"; the source/card groups disappear.
    await waitFor(() => expect(screen.queryByTestId("library-group-source")).toBeNull());
    expect(screen.getByTestId("library-group-topic")).toBeTruthy();
    // The title filter is client-side only — it does NOT re-hit the bridge.
    expect(h.libraryBrowse).not.toHaveBeenCalled();
  });

  it("typing in the shared query switches to Search with compatible filters", async () => {
    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("library-filter-type-card"));
    fireEvent.click(screen.getByTestId("library-filter-prio-A"));
    fireEvent.change(screen.getByTestId("collection-query-input"), {
      target: { value: "intelligence" },
    });

    await waitFor(() =>
      expect(h.navigateSpy).toHaveBeenCalledWith({
        to: "/search",
        search: { q: "intelligence", type: "card", priority: "A" },
      }),
    );
  });

  it("drops non-searchable Browse types when typing into the shared query", async () => {
    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("library-filter-type-topic"));
    fireEvent.change(screen.getByTestId("collection-query-input"), {
      target: { value: "memory" },
    });

    await waitFor(() =>
      expect(h.navigateSpy).toHaveBeenCalledWith({
        to: "/search",
        search: { q: "memory" },
      }),
    );
  });

  it("top count agrees with the visible sections while a title filter is active", async () => {
    render(<BrowseScreen />);
    await screen.findByTestId("library-group-topic");
    // Before any title filter: the calm total reads the backend facet total.
    expect(screen.getByTestId("library-count").textContent).toContain("3 elements");

    fireEvent.change(screen.getByTestId("library-title-filter"), {
      target: { value: "machine" },
    });
    // Only the topic matches -> exactly one section, one row visible. The top count
    // must agree ("1 of 3"), not keep reporting the pre-title facet total ("3").
    await waitFor(() => expect(screen.queryByTestId("library-group-source")).toBeNull());
    expect(screen.getByTestId("library-group-topic")).toBeTruthy();
    const count = screen.getByTestId("library-count").textContent ?? "";
    expect(count).toContain("1 of 3 elements");
  });

  it("title-driven empty state distinguishes itself from the facet-driven one", async () => {
    render(<BrowseScreen />);
    await screen.findByTestId("library-group-topic");

    // Type a title that matches NOTHING in the fetched payload. Facets matched 3
    // rows, so the title filter — not the facets — is what empties the list.
    fireEvent.change(screen.getByTestId("library-title-filter"), {
      target: { value: "zzzz-no-such-title" },
    });
    // The title-aware empty state appears...
    const empty = await screen.findByTestId("library-empty-title");
    expect(empty.textContent).toContain("No matches for");
    expect(empty.textContent).toContain("zzzz-no-such-title");
    // ...and the facet-remediation copy is NOT shown (it would wrongly tell the
    // user to clear filters they never set).
    expect(screen.queryByTestId("library-empty")).toBeNull();
  });

  it("shows the FACET empty state (not the title one) when facets exclude everything even with a title typed", async () => {
    // Facets return zero items; a title filter is also typed. The cause is the
    // facets (items.length === 0), so the facet-remediation copy must win.
    h.libraryBrowse.mockResolvedValue({
      items: [],
      counts: {
        all: 0,
        byType: { source: 0, extract: 0, card: 0, topic: 0, synthesis_note: 0, task: 0 },
        byConcept: { "concept-1": 0 },
        byPriority: { A: 0, B: 0, C: 0, D: 0 },
        byStatus: { active: 0, scheduled: 0, inbox: 0, pending: 0, done: 0, suspended: 0 },
      },
    });
    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("library-title-filter"), {
      target: { value: "anything" },
    });
    // Facet empty state wins (items.length === 0), not the title-aware one.
    expect(await screen.findByTestId("library-empty")).toBeTruthy();
    expect(screen.queryByTestId("library-empty-title")).toBeNull();
  });

  it("selecting a row shows the detail panel, the RefBlock, and the scheduler chip", async () => {
    render(<BrowseScreen />);
    const cardGroup = await screen.findByTestId("library-group-card");
    fireEvent.click(within(cardGroup).getByTestId("library-result"));

    expect(h.selectSpy).toHaveBeenCalledWith("card-1");
    const detail = await screen.findByTestId("library-detail");
    // The load-bearing scheduler split (FSRS chip for the card).
    expect(within(detail).getByTestId("scheduler-chip").getAttribute("data-scheduler")).toBe(
      "fsrs",
    );
    expect(within(detail).getByTestId("library-detail-due").textContent).toContain("Due today");
    // The shared RefBlock shows the owning source.
    expect(within(detail).getByTestId("library-detail-ref").textContent).toContain(
      "On the Measure of Intelligence",
    );
  });

  it("Open navigates per type (source → reader, card → detail)", async () => {
    render(<BrowseScreen />);
    const sourceGroup = await screen.findByTestId("library-group-source");
    fireEvent.click(within(sourceGroup).getByTestId("library-result"));
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

  it("Open task jumps to the protected card detail surface, not the task row itself", async () => {
    h.libraryBrowse.mockResolvedValue({
      items: [h.taskRow],
      counts: {
        all: 1,
        byType: { source: 0, extract: 0, card: 0, topic: 0, synthesis_note: 0, task: 1 },
        byConcept: { "concept-1": 1 },
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
        byStatus: { active: 0, scheduled: 0, inbox: 0, pending: 1, done: 0, suspended: 0 },
      },
    });
    render(<BrowseScreen />);
    const taskGroup = await screen.findByTestId("library-group-task");
    fireEvent.click(within(taskGroup).getByTestId("library-result"));
    fireEvent.click(await screen.findByTestId("library-detail-open"));

    expect(h.selectSpy).toHaveBeenCalledWith(null);
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
    });
    expect(h.navigateSpy).not.toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "task-1" },
    });
  });

  it("Open task on a weekly-review task routes to /weekly, not the next due card", async () => {
    h.libraryBrowse.mockResolvedValue({
      items: [h.weeklyTaskRow],
      counts: {
        all: 1,
        byType: { source: 0, extract: 0, card: 0, topic: 0, synthesis_note: 0, task: 1 },
        byConcept: {},
        byPriority: { A: 0, B: 0, C: 0, D: 1 },
        byStatus: { active: 0, scheduled: 1, inbox: 0, pending: 0, done: 0, suspended: 0 },
      },
    });
    render(<BrowseScreen />);
    const taskGroup = await screen.findByTestId("library-group-task");
    fireEvent.click(within(taskGroup).getByTestId("library-result"));
    fireEvent.click(await screen.findByTestId("library-detail-open"));

    expect(h.selectSpy).toHaveBeenCalledWith("task-weekly-1");
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/weekly", search: {} });
    // The bug: with `taskType` dropped from the browse row, the weekly task fell
    // through to the /process loop (which surfaces the next due card → looks like a
    // Q&A card opened). It must reach the dedicated weekly surface instead.
    expect(h.navigateSpy).not.toHaveBeenCalledWith({ to: "/process", search: {} });
    expect(h.navigateSpy).not.toHaveBeenCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
    });
  });

  it("Open unlinked task enters the process loop instead of doing nothing", async () => {
    h.libraryBrowse.mockResolvedValue({
      items: [
        {
          ...h.taskRow,
          id: "task-unlinked",
          title: "Custom task: sweep loose notes",
          sourceTitle: null,
          sourceLocationLabel: null,
          linkedElementId: null,
          linkedElementType: null,
          // A genuinely unlinked task is a `custom` task — verify_claim always has a
          // link. Keep the fixture authentic so it can't accidentally enter a future
          // taskType-specific routing branch.
          taskType: "custom",
        },
      ],
      counts: {
        all: 1,
        byType: { source: 0, extract: 0, card: 0, topic: 0, synthesis_note: 0, task: 1 },
        byConcept: {},
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
        byStatus: { active: 0, scheduled: 0, inbox: 0, pending: 1, done: 0, suspended: 0 },
      },
    });
    render(<BrowseScreen />);
    const taskGroup = await screen.findByTestId("library-group-task");
    fireEvent.click(within(taskGroup).getByTestId("library-result"));
    fireEvent.click(await screen.findByTestId("library-detail-open"));

    expect(h.selectSpy).toHaveBeenCalledWith("task-unlinked");
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("the filterbar concept chip shows the DRILL-DOWN byConcept count, not the global memberCount", async () => {
    render(<BrowseScreen />);
    const chip = await screen.findByTestId("library-filter-concept-concept-1");
    // byConcept["concept-1"] === 2 (filter-scoped); memberCount === 9 (global) — the
    // chip must show 2 so its number always matches the filtered result list.
    expect(within(chip).getByText("2")).toBeTruthy();
    expect(within(chip).queryByText("9")).toBeNull();
  });

  it("the Map tab keeps the global memberCount volume (not filter-scoped)", async () => {
    render(<BrowseScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("library-tab-map"));
    const map = await screen.findByTestId("library-map");
    // The Map's "Concepts by volume" side keeps the true global total (9 members).
    expect(within(map).getByText("9").textContent).toBe("9");
  });

  it("renders the read-only ConceptGraph on the Map tab", async () => {
    render(<BrowseScreen />);
    await waitFor(() => expect(h.listConcepts).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("library-tab-map"));
    expect(await screen.findByTestId("concept-graph")).toBeTruthy();
    expect(screen.getByTestId("library-map")).toBeTruthy();
  });

  it("ignores a stale (out-of-order) browse response when facets switch rapidly", async () => {
    // Simulate a slow FIRST response (the initial no-facet browse) that only
    // resolves AFTER a faster SECOND response (a type facet). The renderer's
    // cancelled-flag closure must keep the LATEST result and never let the stale
    // first response overwrite it — and must not get stuck on "Loading…".
    const cardOnly = {
      items: [h.cardRow],
      counts: {
        all: 1,
        byType: { source: 0, extract: 0, card: 1, topic: 0, synthesis_note: 0, task: 0 },
        byConcept: { "concept-1": 1 },
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
        byStatus: { active: 0, scheduled: 1, inbox: 0, pending: 0, done: 0, suspended: 0 },
      },
    };
    const resolvers: ((v: unknown) => void)[] = [];
    h.libraryBrowse
      // First (no-facet) call: stays pending until we resolve it by hand.
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            resolvers.push(res);
          }),
      )
      // Second (type=card) call: resolves immediately with the card-only payload.
      .mockResolvedValueOnce(cardOnly);

    render(<BrowseScreen />);
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledTimes(1));

    // Switch the type facet before the first response lands -> a second browse.
    fireEvent.click(screen.getByTestId("library-filter-type-card"));
    await waitFor(() => expect(h.libraryBrowse).toHaveBeenCalledTimes(2));

    // The newer (card-only) response is rendered.
    await screen.findByTestId("library-group-card");
    expect(screen.getByTestId("library-count").textContent).toContain("1 element");
    expect(screen.queryByTestId("library-group-topic")).toBeNull();

    // Now the STALE first response finally resolves — it must NOT overwrite the list.
    resolvers[0]?.({ items: [h.sourceRow, h.topicRow, h.cardRow], counts: h.counts });
    await waitFor(() => {
      // Still the card-only view (no topic group, count still 1) — no stale overwrite.
      expect(screen.queryByTestId("library-group-topic")).toBeNull();
    });
    expect(screen.getByTestId("library-count").textContent).toContain("1 element");
    // And never stuck on "Loading…".
    expect(screen.queryByTestId("library-loading")).toBeNull();
  });

  it("resets the row selection when the active facets exclude the selected row", async () => {
    // Select a row, then change a facet so the new payload no longer contains it.
    // The detail panel must close (selId is reset) rather than dangling on a gone row.
    render(<BrowseScreen />);
    const cardGroup = await screen.findByTestId("library-group-card");
    fireEvent.click(within(cardGroup).getByTestId("library-result"));
    await screen.findByTestId("library-detail");

    // The next browse returns only the source row (the selected card is gone).
    h.libraryBrowse.mockResolvedValueOnce({
      items: [h.sourceRow],
      counts: {
        all: 1,
        byType: { source: 1, extract: 0, card: 0, topic: 0, synthesis_note: 0, task: 0 },
        byConcept: { "concept-1": 1 },
        byPriority: { A: 1, B: 0, C: 0, D: 0 },
        byStatus: { active: 1, scheduled: 0, inbox: 0, pending: 0, done: 0, suspended: 0 },
      },
    });
    fireEvent.click(screen.getByTestId("library-filter-type-source"));
    // The detail panel closes because the previously-selected card is no longer present.
    await waitFor(() => expect(screen.queryByTestId("library-detail")).toBeNull());
  });

  it("shows the empty state when facets exclude everything", async () => {
    h.libraryBrowse.mockResolvedValue({
      items: [],
      counts: {
        all: 0,
        byType: { source: 0, extract: 0, card: 0, topic: 0, synthesis_note: 0, task: 0 },
        byConcept: { "concept-1": 0 },
        byPriority: { A: 0, B: 0, C: 0, D: 0 },
        byStatus: { active: 0, scheduled: 0, inbox: 0, pending: 0, done: 0, suspended: 0 },
      },
    });
    render(<BrowseScreen />);
    expect(await screen.findByTestId("library-empty")).toBeTruthy();
  });
});
