/**
 * QueueScreen component tests (T029).
 *
 * The queue read (sorting/filtering/budget) lives in `packages/local-db` and is
 * covered by the QueueQuery Vitest there; this asserts the RENDERER seam:
 *  - it renders one `qitem` per due row with the right `SchedulerChip` side for a
 *    card (FSRS) vs an extract (attention) — the load-bearing two-scheduler split;
 *  - a filter chip narrows the visible list;
 *  - clicking a row selects it in the shell inspector (`useSelection().select`);
 *  - the `next-action` opens the row (source → reader, card → review).
 *
 * The collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.queue.list` is a fake whose payload is rendered, and the router +
 * selection seams are stubbed. No SQLite/IPC — the renderer is a pure UI consumer.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueItemSummary, QueueListResult } from "../../lib/appApi";

const h = vi.hoisted(() => {
  const cardRow: QueueItemSummary = {
    id: "card-1",
    type: "card",
    status: "scheduled",
    stage: "active_card",
    priority: 0.875, // A — protected
    title: "Chollet's definition of intelligence",
    dueAt: "2026-05-29T08:00:00.000Z",
    scheduler: "fsrs",
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 9.4,
      stage: "active_card",
      postponed: 0,
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    cardType: "qa",
    protected: true,
    due: "overdue",
    dueLabel: "Overdue",
  };
  const extractRow: QueueItemSummary = {
    id: "extract-1",
    type: "extract",
    status: "active",
    stage: "clean_extract",
    priority: 0.625, // B
    title: "Intelligence = skill-acquisition efficiency",
    dueAt: "2026-05-30T06:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      stage: "clean_extract",
      postponed: 1,
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    cardType: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
  };
  const sourceRow: QueueItemSummary = {
    id: "source-1",
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: 0.875,
    title: "The Bitter Lesson",
    dueAt: "2026-05-29T08:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      stage: "raw_source",
      postponed: 0,
    },
    sourceTitle: "The Bitter Lesson",
    author: "Rich Sutton",
    concept: null,
    cardType: null,
    protected: true,
    due: "overdue",
    dueLabel: "Overdue",
  };
  const topicRow: QueueItemSummary = {
    id: "topic-1",
    type: "topic",
    status: "scheduled",
    stage: "rough_topic",
    priority: 0.375, // C
    title: "Measuring intelligence",
    dueAt: "2026-05-30T06:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      stage: "rough_topic",
      postponed: 0,
    },
    sourceTitle: null,
    author: null,
    concept: null,
    cardType: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
  };
  const result: QueueListResult = {
    items: [cardRow, sourceRow, extractRow, topicRow],
    counts: {
      all: 4,
      card: 1,
      source: 1,
      extract: 1,
      topic: 1,
      task: 0,
      highPriority: 2,
      overdue: 2,
      protected: 2,
    },
    budget: { used: 4, target: 30 },
  };
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    // A mock so a test can drive the route search (e.g. the `concept` filter param).
    useSearch: vi.fn(() => ({}) as Record<string, unknown>),
    // A mutable holder so a test can drive the shell's selected id into the rows.
    selectedId: { current: null as string | null },
    listQueue: vi.fn().mockResolvedValue(result),
    actOnQueueItem: vi.fn(),
    undoQueueAction: vi.fn().mockResolvedValue({ item: extractRow }),
    extractRow,
    topicRow,
  };
});

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      listQueue: h.listQueue,
      actOnQueueItem: h.actOnQueueItem,
      undoQueueAction: h.undoQueueAction,
    },
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => h.useSearch(),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: h.selectedId.current, select: h.selectSpy }),
}));

import { QueueScreen } from "./QueueScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.selectedId.current = null;
});

describe("QueueScreen", () => {
  it("renders one qitem per due row", async () => {
    render(<QueueScreen />);
    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(4));
  });

  it("renders the correct SchedulerChip side for a card (FSRS) vs an extract (attention)", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");

    const card = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "card-1");
    const extract = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "extract-1");

    expect(card?.querySelector('[data-scheduler="fsrs"]')).not.toBeNull();
    expect(extract?.querySelector('[data-scheduler="attention"]')).not.toBeNull();
  });

  it("marks A-priority rows with the --protected accent bar", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const card = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "card-1");
    const extract = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "extract-1");
    expect(card?.className).toContain("qitem--protected");
    expect(extract?.className).not.toContain("qitem--protected");
  });

  it("narrows the list when a filter chip is clicked", async () => {
    render(<QueueScreen />);
    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(4));

    fireEvent.click(screen.getByTestId("queue-filter-card"));
    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(1));
    expect(screen.getByTestId("queue-item").getAttribute("data-element-type")).toBe("card");
  });

  it("shows a filtered-empty state when a filter matches nothing", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    fireEvent.click(screen.getByTestId("queue-filter-task"));
    await screen.findByTestId("queue-empty-filtered");
  });

  it("labels the filtered-empty heading with the plural chip noun (No tasks, not No task items)", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    // The Tasks filter matches nothing (no task rows in the fixture).
    fireEvent.click(screen.getByTestId("queue-filter-task"));
    const empty = await screen.findByTestId("queue-empty-filtered");
    const title = empty.querySelector(".q-empty__title");
    // Plural noun matching the chip label — never the raw singular "No task items".
    expect(title?.textContent).toBe("No tasks");
  });

  it("selects a row in the shell inspector when its open zone is clicked", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const extract = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "extract-1");
    // The open click target is the inner `qitem__open` button (the action buttons
    // live in a separate cluster so they don't trigger navigation).
    const open = extract?.querySelector('[data-testid="queue-open"]') as HTMLElement;
    fireEvent.click(open);
    expect(h.selectSpy).toHaveBeenCalledWith("extract-1");
  });

  it("opens a source row in the reader via its next-action", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const source = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "source-1");
    const open = source?.querySelector('[data-testid="queue-open"]') as HTMLElement;
    fireEvent.click(open);
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "source-1" },
    });
  });

  it("renders the BudgetMeter with the items-due / target gauge", async () => {
    render(<QueueScreen />);
    await screen.findByTestId("budget-meter");
    expect(screen.getByTestId("budget-meter")).toHaveTextContent("4");
    expect(screen.getByTestId("budget-meter")).toHaveTextContent("30 today");
  });

  it("marks the row matching the shell selection with the active highlight (aria-current + qitem--active)", async () => {
    // Drive the shell's selected id into the rows; only that row goes active.
    h.selectedId.current = "extract-1";
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const extract = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "extract-1");
    const card = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "card-1");
    expect(extract?.className).toContain("qitem--active");
    expect(extract?.getAttribute("aria-current")).toBe("true");
    // Every other row stays inactive (no stray accent ring).
    expect(card?.className).not.toContain("qitem--active");
    expect(card?.getAttribute("aria-current")).toBeNull();
  });

  it("renders a topic meta sub-line and no orphan separator dot before its chip", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const topic = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "topic-1");
    // The topic row carries a real meta sub-line (the kit renders one per type)…
    const meta = topic?.querySelector(".qitem__meta");
    expect(meta?.querySelector(".qitem__sub")).not.toBeNull();
    expect(meta?.textContent).toContain("Topic");
    // …and exactly ONE separator dot (between the sub-line and the chip) — never a
    // leading orphan dot. (concept is null until T041, so no concept separator.)
    expect(meta?.querySelectorAll(".dot-sep")).toHaveLength(1);
    expect(meta?.querySelector('[data-scheduler="attention"]')).not.toBeNull();
  });

  it("forwards the concept filter param to the read when present in search", async () => {
    h.useSearch.mockReturnValueOnce({ concept: "Intelligence" });
    render(<QueueScreen />);
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(
        expect.objectContaining({ concept: "Intelligence" }),
      ),
    );
  });

  it("forwards the lifecycle status filter to the read when a status chip is active", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");

    // Default ("Any status") sends NO statuses — the full due set.
    expect(h.listQueue).toHaveBeenCalledWith(
      expect.not.objectContaining({ statuses: expect.anything() }),
    );

    // Selecting "Scheduled" forwards exactly its statuses array to the read so the
    // narrowing happens main-side (QueueQuery.matchesFilters), never in React.
    h.listQueue.mockClear();
    fireEvent.click(screen.getByTestId("queue-status-scheduled"));
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(
        expect.objectContaining({ statuses: ["scheduled"] }),
      ),
    );

    // "Active" forwards its (freshly-pulled-in) statuses set.
    h.listQueue.mockClear();
    fireEvent.click(screen.getByTestId("queue-status-active"));
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(
        expect.objectContaining({ statuses: ["active", "pending", "inbox"] }),
      ),
    );
  });

  // -------------------------------------------------------------------------
  // T030 — in-place per-row actions + undo snackbar.
  // -------------------------------------------------------------------------

  it("exposes the in-place action buttons on every row", async () => {
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    for (const kind of ["postpone", "raise", "lower", "markDone", "dismiss", "delete"]) {
      expect(extract?.querySelector(`[data-testid="queue-action-${kind}"]`)).not.toBeNull();
    }
  });

  it("postpone calls queue.act and re-reads the list (no navigation)", async () => {
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    const postpone = extract?.querySelector('[data-testid="queue-action-postpone"]') as HTMLElement;

    // Queue the action result + the post-action re-read AFTER the initial load.
    h.actOnQueueItem.mockResolvedValueOnce({ item: null, removed: false, undo: null });

    fireEvent.click(postpone);
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "extract-1",
        action: { kind: "postpone" },
      }),
    );
    // No navigation happens on an action.
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("raise priority calls queue.act with the raise intent (badge updates in place)", async () => {
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    const raise = extract?.querySelector('[data-testid="queue-action-raise"]') as HTMLElement;

    h.actOnQueueItem.mockResolvedValueOnce({
      item: { ...h.extractRow, priority: 0.875 },
      removed: false,
      undo: null,
    });

    fireEvent.click(raise);
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "extract-1",
        action: { kind: "raise" },
      }),
    );
  });

  it("delete removes the row and shows an undo snackbar that restores it", async () => {
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    const del = extract?.querySelector('[data-testid="queue-action-delete"]') as HTMLElement;

    // Queue the action result + the post-delete re-read AFTER the initial load, so
    // the once-mocks are consumed by the action, not the first render.
    h.actOnQueueItem.mockResolvedValueOnce({
      item: null,
      removed: true,
      undo: { kind: "restore", previousStatus: "scheduled" },
    });
    h.listQueue.mockResolvedValueOnce({
      items: [],
      counts: {
        all: 0,
        card: 0,
        source: 0,
        extract: 0,
        topic: 0,
        task: 0,
        highPriority: 0,
        overdue: 0,
        protected: 0,
      },
      budget: { used: 0, target: 30 },
    });

    fireEvent.click(del);
    // The undo snackbar appears.
    await screen.findByTestId("queue-snackbar");
    expect(screen.getByTestId("queue-snackbar")).toHaveTextContent(/deleted/i);

    // Undo calls the typed undo surface with the recipe.
    fireEvent.click(screen.getByTestId("queue-snackbar-undo"));
    await waitFor(() =>
      expect(h.undoQueueAction).toHaveBeenCalledWith({
        id: "extract-1",
        undo: { kind: "restore", previousStatus: "scheduled" },
      }),
    );
  });
});
