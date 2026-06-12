/**
 * HomeScreen component tests (Home command center, `/`).
 *
 * The Home dashboard is READ-ONLY UI orchestration over two existing typed reads —
 * `appApi.listQueue()` and `appApi.getAnalytics()` (the domain work lives main-side
 * in `packages/local-db`). This asserts the RENDERER seam only:
 *  - the due counts + budget render from the mocked `listQueue`;
 *  - the streak + retention banner, the due-cards/topics/new metric tiles, and the
 *    reviews-per-day spark render from the mocked `getAnalytics`;
 *  - the empty "Queue clear" state shows when `counts.all === 0`;
 *  - the streak banner is hidden when `dayStreak === 0`;
 *  - the leech maintenance banner shows ONLY when `leeches > 0`, and clicking it
 *    routes to /maintenance/leeches;
 *  - "Start session" navigates to /process and a top-due preview row navigates to
 *    the right element route, RESPECTING the FSRS-vs-attention split and linked
 *    task jumps (source → /source/$id, extract → /extract/$id, card → /card/$id,
 *    topic/unlinked task → /process, linked task → protected element surface);
 *  - a failed read shows the error line + a calm "—" placeholder (never fabricated
 *    zeros / a false "Queue clear" empty state);
 *  - the `asOf` clock is forwarded to BOTH reads and into /process;
 *  - a global undo (UNDO_EVENT) re-reads both sources so the dashboard stays live;
 *  - the non-desktop fallback still exposes data-testid="route-home" (the smoke E2E
 *    route marker).
 *
 * Collaborators (`appApi`, the router's `useNavigate`/`useSearch`) are mocked so the
 * test exercises ONLY this component's wiring — no SQLite/IPC.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AnalyticsGetResult,
  DailyWorkSummaryResult,
  KnowledgeGraduationEvent,
  QueueItemSummary,
  QueueListResult,
} from "../../lib/appApi";

/**
 * The global-undo event name HomeScreen listens on. We use the literal here (rather
 * than importing `UNDO_EVENT` from `../../shell/nav`) to keep this mock-heavy suite's
 * module graph minimal; it is the same stable string `shell/nav` exports and the
 * shell dispatches, and a test below asserts the dashboard re-reads when it fires.
 */
const UNDO_EVENT = "interleave:undo";

const h = vi.hoisted(() => {
  type DailyWorkWithGraduations = DailyWorkSummaryResult & {
    readonly graduationEvents?: readonly KnowledgeGraduationEvent[];
  };
  const noFallow = {
    fallowState: null,
    fallowUntil: null,
    fallowReason: null,
    fallowTopicId: null,
  } as const;
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
      fsrsState: null,
      lapses: null,
      stage: "raw_source",
      postponed: 0,
      scheduleReason: null,
      retirementSuggestion: null,
    },
    sourceTitle: "The Bitter Lesson",
    author: "Rich Sutton",
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: null,
    taskType: null,
    linkedElementId: null,
    linkedElementType: null,
    protected: true,
    due: "overdue",
    dueLabel: "Overdue",
    queueEligible: true,
    notInQueueReason: null,
    ...noFallow,
  };
  const extractRow: QueueItemSummary = {
    id: "extract-1",
    type: "extract",
    status: "active",
    stage: "clean_extract",
    priority: 0.625,
    title: "Intelligence = skill-acquisition efficiency",
    dueAt: "2026-05-30T06:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      fsrsState: null,
      lapses: null,
      stage: "clean_extract",
      postponed: 1,
      scheduleReason: null,
      retirementSuggestion: null,
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: null,
    taskType: null,
    linkedElementId: null,
    linkedElementType: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
    queueEligible: true,
    notInQueueReason: null,
    ...noFallow,
  };
  // A due TOPIC — an attention-scheduled element. Clicking it must route into the
  // one-at-a-time /process loop (NOT the FSRS /review session, which has no card to
  // show), preserving the load-bearing FSRS-vs-attention split.
  const topicRow: QueueItemSummary = {
    id: "topic-1",
    type: "topic",
    status: "active",
    stage: "rough_topic",
    priority: 0.5,
    title: "Reinforcement learning fundamentals",
    dueAt: "2026-05-30T07:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      fsrsState: null,
      lapses: null,
      stage: "rough_topic",
      postponed: 0,
      scheduleReason: null,
      retirementSuggestion: null,
    },
    sourceTitle: null,
    author: null,
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: null,
    taskType: null,
    linkedElementId: null,
    linkedElementType: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
    queueEligible: true,
    notInQueueReason: null,
    ...noFallow,
  };
  // A due CARD — an FSRS-scheduled element. Clicking it must route into direct
  // card detail, while batch review stays behind the dedicated /review affordances.
  const cardRow: QueueItemSummary = {
    id: "card-1",
    type: "card",
    status: "active",
    stage: "active_card",
    priority: 0.75,
    title: "What does FSRS schedule?",
    dueAt: "2026-05-30T05:00:00.000Z",
    scheduler: "fsrs",
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 12.4,
      fsrsState: null,
      lapses: null,
      stage: "active_card",
      scheduleReason: null,
      postponed: 0,
      retirementSuggestion: null,
    },
    sourceTitle: "The Bitter Lesson",
    author: null,
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: "qa",
    taskType: null,
    linkedElementId: null,
    linkedElementType: null,
    protected: false,
    due: "overdue",
    dueLabel: "Overdue",
    queueEligible: true,
    notInQueueReason: null,
    ...noFallow,
  };
  const queue: QueueListResult = {
    items: [sourceRow, extractRow, topicRow, cardRow],
    counts: {
      all: 4,
      card: 1,
      source: 1,
      extract: 1,
      topic: 1,
      task: 0,
      highPriority: 1,
      overdue: 2,
      protected: 1,
    },
    budget: { used: 4, target: 30 },
    timeEstimate: {
      confidence: "default",
      totalMinutes: 19,
      pricedItemCount: 4,
      items: [],
    },
  };
  const taskRow: QueueItemSummary = {
    id: "task-1",
    type: "task",
    status: "scheduled",
    stage: "rough_topic",
    priority: 0.75,
    title: "Verify claim: What does FSRS schedule?",
    dueAt: "2026-05-30T04:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      fsrsState: null,
      lapses: null,
      stage: "rough_topic",
      postponed: 0,
      scheduleReason: null,
      retirementSuggestion: null,
    },
    sourceTitle: null,
    author: null,
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: null,
    taskType: null,
    linkedElementId: "card-1",
    linkedElementType: "card",
    protected: false,
    due: "overdue",
    dueLabel: "Overdue",
    queueEligible: true,
    notInQueueReason: null,
    ...noFallow,
  };
  const analytics: AnalyticsGetResult = {
    asOf: "2026-05-30T18:00:00.000Z",
    windowDays: 30,
    reviewsByDay: Array.from({ length: 30 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      count: i % 3,
    })),
    reviewsTotal: 124,
    reviewsPerDayAvg: 4.13,
    retention30d: 0.91,
    dueCards: 7,
    dueTopics: 3,
    newCards: 12,
    newExtracts: 9,
    deletions: 2,
    leeches: 1,
    retired: 0,
    dayStreak: 5,
  };
  const dailyWork: DailyWorkWithGraduations = {
    asOf: "2026-05-30T18:00:00.000Z",
    dueQueueItems: 4,
    inboxSources: 0,
    activeUnscheduledSources: 0,
    resumeSource: null,
    recommendedAction: "process_due_queue",
    graduationEvents: [],
  };
  return {
    queue,
    analytics,
    dailyWork,
    listQueue: vi.fn(),
    getAnalytics: vi.fn(),
    getDailyWorkSummary: vi.fn(),
    ackDailyWorkGraduationEvents: vi.fn(),
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    // Flipped per-test so the non-desktop fallback can be exercised without a
    // module reset (the global mock delegates `isDesktop` to this spy).
    isDesktop: vi.fn(() => true),
    // The loosely-typed route search; per-test override drives the `asOf` clock.
    search: vi.fn(() => ({}) as { asOf?: string }),
    sourceRow,
    extractRow,
    topicRow,
    cardRow,
    taskRow,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => h.search(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.isDesktop(),
    appApi: {
      listQueue: h.listQueue,
      getAnalytics: h.getAnalytics,
      getDailyWorkSummary: h.getDailyWorkSummary,
      ackDailyWorkGraduationEvents: h.ackDailyWorkGraduationEvents,
    },
  };
});

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

import { HomeScreen } from "./HomeScreen";

beforeEach(() => {
  vi.clearAllMocks();
  h.isDesktop.mockReturnValue(true);
  h.search.mockReturnValue({});
  h.listQueue.mockResolvedValue(h.queue);
  h.getAnalytics.mockResolvedValue(h.analytics);
  h.getDailyWorkSummary.mockResolvedValue(h.dailyWork);
  h.ackDailyWorkGraduationEvents.mockResolvedValue({
    asOf: h.dailyWork.asOf,
    acknowledgedEventIds: [],
    observedSubjectCount: 0,
  });
});

describe("HomeScreen", () => {
  it("renders the due counts + budget from the mocked listQueue", async () => {
    render(<HomeScreen />);
    expect(await screen.findByTestId("home-due-today")).toBeTruthy();
    expect(screen.getByTestId("home-subtitle")).toHaveTextContent("est. ~19 min");
    expect(screen.getByTestId("home-subtitle")).toHaveTextContent(
      "About 19 minutes; some estimates use defaults.",
    );
    expect(screen.getByTestId("home-due-today").textContent).toBe("4");
    expect(screen.getByTestId("home-overdue-count").textContent).toBe("2");
    expect(screen.getByTestId("home-protected-count").textContent).toBe("1");
    // The budget gauge renders used / target from the read.
    expect(screen.getByTestId("budget-meter").textContent).toContain("4");
    expect(screen.getByTestId("budget-meter").textContent).toContain("30");
  });

  it("does not invent estimated minutes before the queue read resolves", () => {
    h.listQueue.mockReturnValue(new Promise(() => undefined));

    render(<HomeScreen />);

    expect(screen.getByTestId("home-subtitle")).not.toHaveTextContent("est.");
  });

  it("renders the streak/retention banner, the metric tiles, and the spark from getAnalytics", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");

    expect(screen.getByTestId("home-streak").textContent).toContain("5-day streak");
    expect(screen.getByTestId("home-streak-retention").textContent).toContain("91");

    expect(screen.getByTestId("metric-due").textContent).toContain("7");
    expect(screen.getByTestId("metric-topics").textContent).toContain("3");
    expect(screen.getByTestId("metric-new-cards").textContent).toContain("12");
    expect(screen.getByTestId("metric-new-extracts").textContent).toContain("9");

    // The spark renders one bar per window day.
    expect(screen.getByTestId("home-spark").querySelectorAll(".an-spark__bar").length).toBe(30);
  });

  it("renders quiet graduation receipts, links concepts, and acknowledges after render", async () => {
    h.getDailyWorkSummary.mockResolvedValue({
      ...h.dailyWork,
      graduationEvents: [
        {
          eventId: "concept:concept-bayes:graduated:v1",
          eventType: "current_graduated",
          subjectType: "concept",
          subjectId: "concept-bayes",
          title: "Bayesian statistics",
          asOf: h.dailyWork.asOf,
          thresholdVersion: "v1",
        },
      ],
    });

    render(<HomeScreen />);

    const receipts = await screen.findByTestId("home-graduation-events");
    expect(receipts).toHaveTextContent("Bayesian statistics");
    expect(receipts).toHaveTextContent("concept reached mature knowledge state");

    fireEvent.click(screen.getByTestId("home-graduation-link"));
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/concepts",
      search: { conceptId: "concept-bayes" },
    });

    await waitFor(() =>
      expect(h.ackDailyWorkGraduationEvents).toHaveBeenCalledWith({
        asOf: h.dailyWork.asOf,
        eventIds: ["concept:concept-bayes:graduated:v1"],
      }),
    );
  });

  it("renders a top-due preview (read-only) with the sorted items, not the full list", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-preview");
    const rows = screen.getAllByTestId("home-preview-row");
    expect(rows).toHaveLength(4);
    // No actionable queue controls leak into the preview.
    expect(screen.queryByTestId("queue-actions")).toBeNull();
  });

  it("renders trusted attention schedule reasons in the top-due preview", async () => {
    h.listQueue.mockResolvedValue({
      ...h.queue,
      items: [
        {
          ...h.extractRow,
          schedulerSignals: {
            ...h.extractRow.schedulerSignals,
            scheduleReason: {
              kind: "postpone_recession",
              baseIntervalDays: 7,
              finalIntervalDays: 28,
              postponeCount: 2,
            },
          },
        },
        {
          ...h.topicRow,
          schedulerSignals: {
            ...h.topicRow.schedulerSignals,
            scheduleReason: { kind: "band_base", baseIntervalDays: 7, finalIntervalDays: 7 },
          },
        },
      ],
      counts: { ...h.queue.counts, all: 2, extract: 1, topic: 1 },
      budget: { used: 2, target: 30 },
    });

    render(<HomeScreen />);

    const reason = await screen.findByText("Receding after postpone x2.");
    const row = reason.closest('[data-testid="home-preview-row"]');
    if (!(row instanceof HTMLElement)) throw new Error("Missing home preview row");
    expect(row).toHaveAccessibleDescription("Receding after postpone x2.");
    expect(screen.getAllByTestId("schedule-reason-line")).toHaveLength(1);
    expect(screen.queryByText("band_base")).not.toBeInTheDocument();
  });

  it("shows the empty 'Queue clear' state when counts.all === 0", async () => {
    h.listQueue.mockResolvedValue({
      ...h.queue,
      items: [],
      counts: { ...h.queue.counts, all: 0, overdue: 0, protected: 0 },
      budget: { used: 0, target: 30 },
    });
    h.getDailyWorkSummary.mockResolvedValue({
      ...h.dailyWork,
      dueQueueItems: 0,
      recommendedAction: "clear",
    });
    render(<HomeScreen />);
    expect(await screen.findByTestId("home-empty")).toBeTruthy();
    expect(screen.queryByTestId("home-preview")).toBeNull();
  });

  it("routes the clear-state primary CTA to inbox rather than an empty process session", async () => {
    h.listQueue.mockResolvedValue({
      ...h.queue,
      items: [],
      counts: { ...h.queue.counts, all: 0, overdue: 0, protected: 0 },
      budget: { used: 0, target: 30 },
    });
    h.getDailyWorkSummary.mockResolvedValue({
      ...h.dailyWork,
      dueQueueItems: 0,
      inboxSources: 0,
      activeUnscheduledSources: 0,
      recommendedAction: "clear",
    });

    render(<HomeScreen />);

    expect(await screen.findByTestId("home-empty")).toBeTruthy();
    expect(screen.getByTestId("home-start-session")).toHaveTextContent("Open inbox");
    fireEvent.click(screen.getByTestId("home-start-session"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/inbox" });
    expect(h.navigateSpy).not.toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("routes the primary CTA to inbox triage when due queue is empty but imports are waiting", async () => {
    h.listQueue.mockResolvedValue({
      ...h.queue,
      items: [],
      counts: { ...h.queue.counts, all: 0, overdue: 0, protected: 0 },
      budget: { used: 0, target: 30 },
    });
    h.getDailyWorkSummary.mockResolvedValue({
      ...h.dailyWork,
      dueQueueItems: 0,
      inboxSources: 3,
      recommendedAction: "triage_inbox",
    });
    render(<HomeScreen />);

    expect(await screen.findByTestId("home-inbox-work")).toHaveTextContent("3 imported sources");
    expect(screen.getByTestId("home-start-session")).toHaveTextContent("Triage inbox");
    fireEvent.click(screen.getByTestId("home-go-inbox"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/inbox" });

    h.navigateSpy.mockClear();
    fireEvent.click(screen.getByTestId("home-start-session"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/inbox" });
    expect(h.navigateSpy).not.toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("routes the primary CTA to an active unscheduled source when that is the next daily action", async () => {
    h.listQueue.mockResolvedValue({
      ...h.queue,
      items: [],
      counts: { ...h.queue.counts, all: 0, overdue: 0, protected: 0 },
      budget: { used: 0, target: 30 },
    });
    h.getDailyWorkSummary.mockResolvedValue({
      ...h.dailyWork,
      dueQueueItems: 0,
      inboxSources: 0,
      activeUnscheduledSources: 1,
      resumeSource: {
        id: "source-active",
        title: "Active source",
        priority: 0.75,
        priorityLabel: "B",
        status: "active",
        stage: "raw_source",
        updatedAt: "2026-06-08T09:00:00.000Z",
        unresolvedBlocks: 2,
      },
      recommendedAction: "resume_unscheduled_source",
    });
    render(<HomeScreen />);

    expect(await screen.findByTestId("home-resume-source")).toHaveTextContent("Active source");
    expect(screen.getByTestId("home-start-session")).toHaveTextContent("Resume source");
    fireEvent.click(screen.getByTestId("home-resume-source-button"));

    expect(h.selectSpy).toHaveBeenCalledWith("source-active");
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "source-active" },
    });

    h.selectSpy.mockClear();
    h.navigateSpy.mockClear();
    fireEvent.click(screen.getByTestId("home-start-session"));

    expect(h.selectSpy).toHaveBeenCalledWith("source-active");
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "source-active" },
    });
  });

  it("keeps due queue data visible but disables the primary CTA if the daily summary read fails", async () => {
    h.getDailyWorkSummary.mockRejectedValue(new Error("daily work down"));
    render(<HomeScreen />);

    expect(await screen.findByTestId("home-due-today")).toHaveTextContent("4");
    expect(screen.getByTestId("home-error")).toHaveTextContent("daily work down");
    expect(screen.getByTestId("home-start-session")).toBeDisabled();
  });

  it("hides the streak banner when dayStreak === 0", async () => {
    h.getAnalytics.mockResolvedValue({ ...h.analytics, dayStreak: 0 });
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");
    expect(screen.queryByTestId("home-streak")).toBeNull();
  });

  it("shows the leech banner only when leeches > 0", async () => {
    h.getAnalytics.mockResolvedValue({ ...h.analytics, leeches: 0 });
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");
    expect(screen.queryByTestId("home-banner-leeches")).toBeNull();
  });

  it("Start session navigates to /process", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");
    fireEvent.click(screen.getByTestId("home-start-session"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("a top-due preview row navigates per type, respecting the FSRS-vs-attention split", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-preview");
    const rows = screen.getAllByTestId("home-preview-row");
    const rowFor = (id: string) =>
      rows.find((r) => r.getAttribute("data-element-id") === id) as HTMLElement;

    // source → reader, extract → extract view (their own surfaces).
    fireEvent.click(rowFor("source-1"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "source-1" } });

    fireEvent.click(rowFor("extract-1"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/extract/$id", params: { id: "extract-1" } });

    // card → the direct card detail surface.
    fireEvent.click(rowFor("card-1"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/card/$id", params: { id: "card-1" } });

    // topic (an attention element) → the one-at-a-time /process loop, NOT /review —
    // sending an attention-scheduled element into the card review would land on an
    // empty deck and cross the load-bearing two-scheduler boundary.
    h.navigateSpy.mockClear();
    fireEvent.click(rowFor("topic-1"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/process", search: {} });
    expect(h.navigateSpy).not.toHaveBeenCalledWith({ to: "/review" });
  });

  it("a linked task preview row jumps to the protected card detail surface", async () => {
    h.listQueue.mockResolvedValue({
      ...h.queue,
      items: [h.taskRow],
      counts: { ...h.queue.counts, all: 1, task: 1, overdue: 1 },
      budget: { used: 1, target: 30 },
    });
    render(<HomeScreen />);
    await screen.findByTestId("home-preview");

    fireEvent.click(screen.getByTestId("home-preview-row"));

    expect(h.selectSpy).toHaveBeenCalledWith(null);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/card/$id", params: { id: "card-1" } });
  });

  it("'See full queue' navigates to /queue", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-see-queue");
    fireEvent.click(screen.getByTestId("home-see-queue"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/queue" });
  });

  it("the Library quick tile uses collection browse copy and navigates to /library", async () => {
    render(<HomeScreen />);
    const tile = await screen.findByTestId("home-tile-library");

    expect(tile.textContent).toContain("Library");
    expect(tile.textContent).toContain("Browse your collection");
    expect(tile.textContent).not.toContain("Search");

    fireEvent.click(tile);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/library" });
  });

  it("the leech maintenance nudge navigates to /maintenance/leeches", async () => {
    render(<HomeScreen />);
    const banner = await screen.findByTestId("home-banner-leeches");
    fireEvent.click(banner);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/maintenance/leeches" });
  });

  it("renders the error branch and does NOT fabricate zeros when a read fails", async () => {
    h.listQueue.mockRejectedValue(new Error("bridge down"));
    h.getAnalytics.mockRejectedValue(new Error("bridge down"));
    render(<HomeScreen />);
    const err = await screen.findByTestId("home-error");
    expect(err.textContent).toContain("bridge down");
    // A failed read shows a calm "—" placeholder, never a fabricated "0 due today".
    expect(screen.getByTestId("home-due-today").textContent).toBe("—");
    expect(screen.getByTestId("metric-due").textContent).toContain("—");
    // The "Queue clear" empty state must NOT show on a failed read (queue is null,
    // not an empty due set).
    expect(screen.queryByTestId("home-empty")).toBeNull();
  });

  it("treats a failed analytics read as UNKNOWN, not zero, for the Review link and danger class", async () => {
    // Queue resolves but analytics fails: dueCards is unknown, NOT a real 0. The
    // analytics-derived affordances must behave as "unknown" (Review link hidden, no
    // danger emphasis) rather than "zero" — matching the em-dash metric-value treatment.
    h.getAnalytics.mockRejectedValue(new Error("analytics down"));
    render(<HomeScreen />);
    await screen.findByTestId("home-error");

    // The Due-cards metric value is the calm em-dash (analytics unknown)…
    expect(screen.getByTestId("metric-due").textContent).toContain("—");
    // …and its danger emphasis is dropped as UNKNOWN, not asserted as a genuine 0 — the
    // first half of the self-contradiction this fix closes (em-dash value + 0-treated class).
    expect(screen.getByTestId("metric-due").className).not.toContain("an-metric--danger");
    // The session-bar Review quick-link is hidden (unknown), not silently dropped as 0 due —
    // the second half of that same contradiction.
    expect(screen.queryByTestId("home-open-review")).toBeNull();
  });

  it("shows the Review quick-link with danger emphasis when analytics loaded with due cards", async () => {
    // Sanity check the positive path the gate must preserve: a successful analytics read
    // with dueCards > 0 still surfaces the Review link AND the danger class.
    render(<HomeScreen />);
    expect(await screen.findByTestId("home-open-review")).toBeTruthy();
    expect(screen.getByTestId("metric-due").className).toContain("an-metric--danger");
  });

  it("hides the Review quick-link and danger class when analytics loaded with zero due cards", async () => {
    // A genuine 0 (analytics resolved, dueCards === 0) also hides the link and drops the
    // danger class — distinct from the failed-read path above but identical presentation.
    h.getAnalytics.mockResolvedValue({ ...h.analytics, dueCards: 0 });
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");
    expect(screen.queryByTestId("home-open-review")).toBeNull();
    expect(screen.getByTestId("metric-due").className).not.toContain("an-metric--danger");
    // Value is a real 0 here (not an em-dash), since analytics loaded.
    expect(screen.getByTestId("metric-due").textContent).toContain("0");
  });

  it("forwards the asOf clock to /process and to the daily reads", async () => {
    const asOf = "2031-01-01T12:00:00.000Z";
    h.search.mockReturnValue({ asOf });
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");

    // All reads are date-scoped by the same clock the dashboard renders.
    expect(h.listQueue).toHaveBeenCalledWith({ asOf, includeTimeEstimate: true });
    expect(h.getAnalytics).toHaveBeenCalledWith({ asOf });
    expect(h.getDailyWorkSummary).toHaveBeenCalledWith({ asOf });

    // Start session carries the clock so the /process loop reads the SAME due set.
    fireEvent.click(screen.getByTestId("home-start-session"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/process", search: { asOf } });

    // An attention preview row (the topic) also carries the clock into /process.
    const rows = screen.getAllByTestId("home-preview-row");
    const topic = rows.find((r) => r.getAttribute("data-element-id") === "topic-1") as HTMLElement;
    fireEvent.click(topic);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/process", search: { asOf } });
  });

  it("re-reads all daily sources when a global undo fires (UNDO_EVENT)", async () => {
    render(<HomeScreen />);
    await screen.findByTestId("home-due-today");
    // The initial load reads each source once.
    expect(h.listQueue).toHaveBeenCalledTimes(1);
    expect(h.getAnalytics).toHaveBeenCalledTimes(1);
    expect(h.getDailyWorkSummary).toHaveBeenCalledTimes(1);

    // A global undo elsewhere should refresh the live dashboard numbers.
    window.dispatchEvent(new Event(UNDO_EVENT));
    await waitFor(() => expect(h.listQueue).toHaveBeenCalledTimes(2));
    expect(h.getAnalytics).toHaveBeenCalledTimes(2);
    expect(h.getDailyWorkSummary).toHaveBeenCalledTimes(2);
  });
});

describe("HomeScreen — non-desktop fallback", () => {
  it("still exposes the route-home marker so the smoke E2E finds the route", async () => {
    h.isDesktop.mockReturnValue(false);
    render(<HomeScreen />);
    await waitFor(() => expect(screen.getByTestId("route-home")).toBeTruthy());
    // The fallback reads nothing through the bridge.
    expect(h.listQueue).not.toHaveBeenCalled();
    expect(h.getAnalytics).not.toHaveBeenCalled();
    expect(h.getDailyWorkSummary).not.toHaveBeenCalled();
  });
});
