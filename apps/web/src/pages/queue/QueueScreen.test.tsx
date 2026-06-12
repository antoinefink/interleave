/**
 * QueueScreen component tests (T029).
 *
 * The queue read (sorting/filtering/budget) lives in `packages/local-db` and is
 * covered by the QueueQuery Vitest there; this asserts the RENDERER seam:
 *  - it renders one `qitem` per due row with the right `SchedulerChip` side for a
 *    card (FSRS) vs an extract (attention) — the load-bearing two-scheduler split;
 *  - a filter chip narrows the visible list;
 *  - clicking a row selects it in the shell inspector (`useSelection().select`);
 *  - the `next-action` opens the row (source → reader, card → card detail).
 *
 * The collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.queue.list` is a fake whose payload is rendered, and the router +
 * selection seams are stubbed. No SQLite/IPC — the renderer is a pure UI consumer.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DailyWorkSummaryResult,
  KnowledgeGraduationEvent,
  PriorityIntegrityGetResult,
  QueueItemSummary,
  QueueListResult,
} from "../../lib/appApi";

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
      fsrsState: null,
      lapses: null,
      stage: "active_card",
      postponed: 0,
      scheduleReason: null,
      retirementSuggestion: null,
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: "qa",
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
    priority: 0.625, // B
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
  // A verification TASK (T092) linked to the source above — opening it must JUMP TO
  // the protected source's reader, not open the task in /process.
  const taskRow: QueueItemSummary = {
    id: "task-1",
    type: "task",
    status: "scheduled",
    stage: "rough_topic",
    priority: 0.875,
    title: "Verify claim: The Bitter Lesson",
    dueAt: "2026-05-29T08:00:00.000Z",
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
    linkedElementId: "source-1",
    linkedElementType: "source",
    protected: true,
    due: "overdue",
    dueLabel: "Overdue",
    queueEligible: true,
    notInQueueReason: null,
    ...noFallow,
  };
  const cardTaskRow: QueueItemSummary = {
    ...taskRow,
    id: "task-card-1",
    title: "Verify claim: Chollet's definition of intelligence",
    linkedElementId: "card-1",
    linkedElementType: "card",
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
    timeEstimate: {
      confidence: "default",
      totalMinutes: 19,
      pricedItemCount: 4,
      items: [],
    },
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
  const priorityIntegrity: PriorityIntegrityGetResult = {
    asOf: "2026-05-30T18:00:00.000Z",
    windowDays: 30,
    priorityAttribution: "current",
    bands: [
      {
        band: "A",
        attentionServiced: 0,
        fsrsServiced: 0,
        deferred: 3,
        totalEvents: 3,
        serviceRate: 0,
        deferRate: 1,
        postponeDebtDays: 3,
        liveCount: 8,
        liveShare: 0.5,
      },
      {
        band: "B",
        attentionServiced: 0,
        fsrsServiced: 0,
        deferred: 0,
        totalEvents: 0,
        serviceRate: null,
        deferRate: null,
        postponeDebtDays: 0,
        liveCount: 0,
        liveShare: 0,
      },
      {
        band: "C",
        attentionServiced: 0,
        fsrsServiced: 0,
        deferred: 0,
        totalEvents: 0,
        serviceRate: null,
        deferRate: null,
        postponeDebtDays: 0,
        liveCount: 0,
        liveShare: 0,
      },
      {
        band: "D",
        attentionServiced: 0,
        fsrsServiced: 0,
        deferred: 0,
        totalEvents: 0,
        serviceRate: null,
        deferRate: null,
        postponeDebtDays: 0,
        liveCount: 0,
        liveShare: 0,
      },
    ],
    topics: [],
    sacrificed: [],
    resting: [],
    thresholdFlags: {
      aBandInflation: false,
      aBandDeferredRecently: false,
      postponeDebtHigh: false,
    },
  };
  return {
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    // A mock so a test can drive the route search (e.g. the `concept` filter param).
    useSearch: vi.fn(() => ({}) as Record<string, unknown>),
    // A mutable holder so a test can drive the shell's selected id into the rows.
    selectedId: { current: null as string | null },
    listQueue: vi.fn().mockResolvedValue(result),
    getDailyWorkSummary: vi.fn().mockResolvedValue(dailyWork),
    actOnQueueItem: vi.fn(),
    // Descendant-aware delete (T135 / U7): default to a LEAF so the row's Delete takes
    // the quiet single-soft-delete path through `actOnQueueItem({delete})`.
    countDescendants: vi
      .fn()
      .mockResolvedValue({ extracts: 0, cards: 0, cardsWithHistory: 0, total: 0 }),
    softDeleteSubtree: vi.fn().mockResolvedValue({ batchId: "b", affected: [], skipped: [] }),
    restoreBatchFromTrash: vi
      .fn()
      .mockResolvedValue({ restored: [], skipped: [], rootRestored: true }),
    setExtractFate: vi.fn().mockResolvedValue({ extract: {} }),
    fallowTopic: vi.fn().mockResolvedValue({ applied: 1, skipped: [], batchId: "fb" }),
    getBlockProcessingSummary: vi.fn().mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: true,
        unresolvedBlocks: 0,
      },
    }),
    dismissSourceRetirementSuggestion: vi.fn(),
    undoLast: vi.fn().mockResolvedValue({
      undone: true,
      opType: "reschedule_element",
      elementId: "extract-1",
      label: "Undid change",
      count: 1,
    }),
    undoQueueAction: vi.fn().mockResolvedValue({ item: extractRow }),
    getPriorityIntegrity: vi.fn().mockResolvedValue(priorityIntegrity),
    getSettings: vi.fn().mockResolvedValue({ settings: { "ui.noticeDismissals": {} } }),
    updateSetting: vi.fn().mockResolvedValue({ key: "ui.noticeDismissals", value: {} }),
    result,
    dailyWork,
    priorityIntegrity,
    cardRow,
    sourceRow,
    extractRow,
    topicRow,
    taskRow,
    cardTaskRow,
  };
});

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => true,
    appApi: {
      listQueue: h.listQueue,
      getDailyWorkSummary: h.getDailyWorkSummary,
      actOnQueueItem: h.actOnQueueItem,
      countDescendants: h.countDescendants,
      softDeleteSubtree: h.softDeleteSubtree,
      restoreBatchFromTrash: h.restoreBatchFromTrash,
      setExtractFate: h.setExtractFate,
      fallowTopic: h.fallowTopic,
      getBlockProcessingSummary: h.getBlockProcessingSummary,
      dismissSourceRetirementSuggestion: h.dismissSourceRetirementSuggestion,
      undoLast: h.undoLast,
      undoQueueAction: h.undoQueueAction,
      getPriorityIntegrity: h.getPriorityIntegrity,
      getSettings: h.getSettings,
      updateSetting: h.updateSetting,
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
  h.useSearch.mockReturnValue({});
  h.listQueue.mockResolvedValue(h.result);
  h.getDailyWorkSummary.mockResolvedValue(h.dailyWork);
  h.getBlockProcessingSummary.mockResolvedValue({
    summary: {
      canMarkDoneWithoutConfirmation: true,
      unresolvedBlocks: 0,
    },
  });
  h.dismissSourceRetirementSuggestion.mockResolvedValue({
    dismissed: true,
    stale: false,
    suggestion: null,
  });
  h.getPriorityIntegrity.mockResolvedValue(h.priorityIntegrity);
  h.getSettings.mockResolvedValue({ settings: { "ui.noticeDismissals": {} } });
  h.updateSetting.mockResolvedValue({ key: "ui.noticeDismissals", value: {} });
});

describe("QueueScreen", () => {
  it("renders one qitem per due row", async () => {
    render(<QueueScreen />);
    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(4));
  });

  it("renders backend queue minutes with accessible approximate text", async () => {
    render(<QueueScreen />);

    expect(await screen.findByTestId("queue-subtitle")).toHaveTextContent("est. ~19 min");
    expect(screen.getByTestId("queue-subtitle")).toHaveTextContent(
      "About 19 minutes; some estimates use defaults.",
    );
  });

  it("does not invent estimated minutes before the queue read resolves", () => {
    h.listQueue.mockReturnValue(new Promise(() => undefined));

    render(<QueueScreen />);

    expect(screen.getByTestId("queue-subtitle")).not.toHaveTextContent("est.");
  });

  it("renders trusted attention schedule reasons and associates them with the row button", async () => {
    h.listQueue.mockResolvedValue({
      ...h.result,
      items: [
        h.cardRow,
        {
          ...h.extractRow,
          schedulerSignals: {
            ...h.extractRow.schedulerSignals,
            scheduleReason: {
              kind: "yield_shortened",
              baseIntervalDays: 7,
              finalIntervalDays: 6,
              productiveOutputCount: 2,
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
      counts: { ...h.result.counts, all: 3, topic: 1 },
      budget: { used: 3, target: 30 },
    });

    render(<QueueScreen />);

    const reason = await screen.findByText("Returning sooner: last visit produced 2 output(s).");
    const row = reason.closest('[data-testid="queue-item"]');
    if (!(row instanceof HTMLElement)) throw new Error("Missing queue row");
    const openButton = within(row).getByTestId("queue-open");
    expect(openButton).toHaveAccessibleDescription(
      "Returning sooner: last visit produced 2 output(s).",
    );
    expect(screen.getAllByTestId("schedule-reason-line")).toHaveLength(1);
    expect(screen.queryByText("band_base")).not.toBeInTheDocument();
  });

  it("starts the process route only when daily work has due queue items", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");

    fireEvent.click(screen.getByTestId("queue-start-session"));

    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("routes the primary CTA to inbox triage when the due queue is empty but imports are waiting", async () => {
    h.listQueue.mockResolvedValue({
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
    h.getDailyWorkSummary.mockResolvedValue({
      ...h.dailyWork,
      dueQueueItems: 0,
      inboxSources: 2,
      recommendedAction: "triage_inbox",
    });

    render(<QueueScreen />);

    const empty = await screen.findByTestId("queue-inbox-work");
    expect(empty).toHaveTextContent("No due items today");
    expect(empty).toHaveTextContent("2 inbox sources");
    expect(screen.queryByTestId("queue-empty")).toBeNull();
    expect(screen.getByTestId("queue-start-session")).toHaveTextContent("Triage inbox");

    fireEvent.click(screen.getByTestId("queue-go-inbox"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/inbox" });

    h.navigateSpy.mockClear();
    fireEvent.click(screen.getByTestId("queue-start-session"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/inbox" });
    expect(h.navigateSpy).not.toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("routes the clear-state primary CTA to inbox rather than an empty process session", async () => {
    h.listQueue.mockResolvedValue({
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
    h.getDailyWorkSummary.mockResolvedValue({
      ...h.dailyWork,
      dueQueueItems: 0,
      inboxSources: 0,
      activeUnscheduledSources: 0,
      recommendedAction: "clear",
    });

    render(<QueueScreen />);

    expect(await screen.findByTestId("queue-empty")).toHaveTextContent("Queue clear for today");
    expect(screen.getByTestId("queue-start-session")).toHaveTextContent("Open inbox");
    fireEvent.click(screen.getByTestId("queue-start-session"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/inbox" });
    expect(h.navigateSpy).not.toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("routes the primary CTA to an active unscheduled source when that is the next daily action", async () => {
    h.listQueue.mockResolvedValue({
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

    render(<QueueScreen />);

    expect(await screen.findByTestId("queue-resume-source")).toHaveTextContent("Active source");
    expect(screen.getByTestId("queue-start-session")).toHaveTextContent("Resume source");
    fireEvent.click(screen.getByTestId("queue-resume-source-button"));

    expect(h.selectSpy).toHaveBeenCalledWith("source-active");
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "source-active" },
    });

    h.selectSpy.mockClear();
    h.navigateSpy.mockClear();
    fireEvent.click(screen.getByTestId("queue-start-session"));

    expect(h.selectSpy).toHaveBeenCalledWith("source-active");
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "source-active" },
    });
  });

  it("keeps due rows visible but disables the primary CTA if the daily summary read fails", async () => {
    h.getDailyWorkSummary.mockRejectedValue(new Error("daily work down"));
    render(<QueueScreen />);

    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(4));
    expect(screen.getByTestId("queue-error")).toHaveTextContent("daily work down");
    expect(screen.getByTestId("queue-start-session")).toBeDisabled();
    expect(screen.queryByTestId("queue-empty")).toBeNull();
  });

  it("does not render a false clear state when the queue read fails", async () => {
    h.listQueue.mockRejectedValue(new Error("queue down"));
    render(<QueueScreen />);

    expect(await screen.findByTestId("queue-error")).toHaveTextContent("queue down");
    expect(screen.queryByTestId("queue-item")).toBeNull();
    expect(screen.queryByTestId("queue-empty")).toBeNull();
    expect(screen.queryByTestId("queue-inbox-work")).toBeNull();
    expect(screen.queryByTestId("queue-resume-source")).toBeNull();
  });

  it("hides the priority-integrity queue warning when backend flags are healthy", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");

    expect(screen.queryByTestId("queue-priority-integrity")).toBeNull();
  });

  it("forwards route asOf to the priority integrity read", async () => {
    h.useSearch.mockReturnValue({ asOf: "2026-06-06T12:00:00.000Z" });

    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");

    expect(h.getPriorityIntegrity).toHaveBeenCalledWith({
      asOf: "2026-06-06T12:00:00.000Z",
    });
  });

  it("renders the priority-integrity queue warning from backend flags and links to analytics", async () => {
    h.getPriorityIntegrity.mockResolvedValue({
      ...h.priorityIntegrity,
      thresholdFlags: {
        aBandInflation: false,
        aBandDeferredRecently: true,
        postponeDebtHigh: false,
      },
    });
    render(<QueueScreen />);

    const warning = await screen.findByTestId("queue-priority-integrity");
    expect(warning).toHaveTextContent("A-priority work was deferred");

    fireEvent.click(screen.getByTestId("queue-priority-view-analytics"));
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/analytics",
      hash: "priority-integrity",
    });
  });

  it("suppresses the priority-integrity queue warning while its dismissal is still active", async () => {
    h.getPriorityIntegrity.mockResolvedValue({
      ...h.priorityIntegrity,
      thresholdFlags: {
        aBandInflation: true,
        aBandDeferredRecently: false,
        postponeDebtHigh: false,
      },
    });
    h.getSettings.mockResolvedValue({
      settings: {
        "ui.noticeDismissals": {
          "priorityIntegrity.queue": { until: "2099-01-01T00:00:00.000Z" },
        },
      },
    });

    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");

    expect(screen.queryByTestId("queue-priority-integrity")).toBeNull();
  });

  it("shows the priority-integrity queue warning after a stored dismissal expires", async () => {
    h.getPriorityIntegrity.mockResolvedValue({
      ...h.priorityIntegrity,
      thresholdFlags: {
        aBandInflation: true,
        aBandDeferredRecently: false,
        postponeDebtHigh: false,
      },
    });
    h.getSettings.mockResolvedValue({
      settings: {
        "ui.noticeDismissals": {
          "priorityIntegrity.queue": { until: "2000-01-01T00:00:00.000Z" },
        },
      },
    });

    render(<QueueScreen />);

    expect(await screen.findByTestId("queue-priority-integrity")).toHaveTextContent(
      "A-priority items are taking a large share",
    );
  });

  it("persists a one-week priority-integrity queue warning dismissal", async () => {
    h.getPriorityIntegrity.mockResolvedValue({
      ...h.priorityIntegrity,
      thresholdFlags: {
        aBandInflation: true,
        aBandDeferredRecently: false,
        postponeDebtHigh: false,
      },
    });
    render(<QueueScreen />);
    await screen.findByTestId("queue-priority-integrity");

    fireEvent.click(screen.getByTestId("queue-priority-hide-week"));

    await waitFor(() =>
      expect(h.updateSetting).toHaveBeenCalledWith({
        key: "ui.noticeDismissals",
        value: expect.objectContaining({
          "priorityIntegrity.queue": expect.objectContaining({ until: expect.any(String) }),
        }),
      }),
    );
    expect(screen.queryByTestId("queue-priority-integrity")).toBeNull();
  });

  it("keeps the priority-integrity queue warning visible if dismissal persistence fails", async () => {
    h.getPriorityIntegrity.mockResolvedValue({
      ...h.priorityIntegrity,
      thresholdFlags: {
        aBandInflation: true,
        aBandDeferredRecently: false,
        postponeDebtHigh: false,
      },
    });
    h.updateSetting.mockRejectedValue(new Error("settings down"));
    render(<QueueScreen />);
    await screen.findByTestId("queue-priority-integrity");

    fireEvent.click(screen.getByTestId("queue-priority-hide-week"));

    expect(await screen.findByTestId("queue-priority-dismiss-error")).toHaveTextContent(
      "Could not save",
    );
    expect(screen.getByTestId("queue-priority-integrity")).toBeInTheDocument();
  });

  it("keeps queue rows visible if priority integrity loading fails", async () => {
    h.getPriorityIntegrity.mockRejectedValue(new Error("priority read failed"));
    render(<QueueScreen />);

    await waitFor(() => expect(screen.getAllByTestId("queue-item")).toHaveLength(4));
    expect(screen.queryByTestId("queue-error")).toBeNull();
    expect(screen.queryByTestId("queue-priority-integrity")).toBeNull();
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

  it("opens a verification task by JUMPING TO the protected element's reader, not /process", async () => {
    // The task row protects `source-1`; its "Verify" affordance must select the
    // protected element + open ITS reader (T092), never open the task in /process.
    h.listQueue.mockResolvedValueOnce({
      items: [h.taskRow],
      counts: {
        all: 1,
        card: 0,
        source: 0,
        extract: 0,
        topic: 0,
        task: 1,
        highPriority: 1,
        overdue: 1,
        protected: 1,
      },
      budget: { used: 1, target: 30 },
    });
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const task = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "task-1");
    // The affordance reads "Verify" (jump), not the generic "Open".
    expect(task?.querySelector('[data-testid="queue-open"]')).toHaveTextContent("Verify");
    const open = task?.querySelector('[data-testid="queue-open"]') as HTMLElement;
    fireEvent.click(open);
    // Selects the PROTECTED element (not the task) + routes to the source reader.
    expect(h.selectSpy).toHaveBeenCalledWith("source-1");
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "source-1" },
    });
    expect(h.navigateSpy).not.toHaveBeenCalledWith({ to: "/process", search: {} });
  });

  it("opens a card-linked verification task by clearing inspector selection and routing to card detail", async () => {
    h.useSearch.mockReturnValue({ asOf: "2026-06-06T12:00:00.000Z" });
    h.listQueue.mockResolvedValue({
      items: [h.cardTaskRow],
      counts: {
        all: 1,
        card: 0,
        source: 0,
        extract: 0,
        topic: 0,
        task: 1,
        highPriority: 1,
        overdue: 1,
        protected: 1,
      },
      budget: { used: 1, target: 30 },
    });
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");
    const task = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "task-card-1");
    const open = task?.querySelector('[data-testid="queue-open"]') as HTMLElement;
    expect(open).toHaveTextContent("Verify");

    fireEvent.click(open);

    expect(h.selectSpy).toHaveBeenCalledWith(null);
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/card/$id",
      params: { id: "card-1" },
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
  // T030 — quiet in-place per-row actions.
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

  it("lower priority calls queue.act with the lower intent", async () => {
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    const lower = extract?.querySelector('[data-testid="queue-action-lower"]') as HTMLElement;

    h.actOnQueueItem.mockResolvedValueOnce({
      item: { ...h.extractRow, priority: 0.125 },
      removed: false,
      undo: null,
    });

    fireEvent.click(lower);
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "extract-1",
        action: { kind: "lower" },
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Partial-source "Done" intent surface (replaces the old window.confirm gate).
  // A SOURCE's "Mark done" routes through the shared DoneIntentMenu: 0-unresolved
  // marks done immediately (fast path, no popover); ≥1 unresolved opens a non-modal
  // popover offering Finished / Return later / Abandon. The native window.confirm is
  // gone — these assert no dialog is ever raised on the row path (R8).
  // -------------------------------------------------------------------------

  it("marks source rows done immediately (no popover) when block processing is complete", async () => {
    const confirm = vi.spyOn(window, "confirm");
    // The beforeEach mock already returns canMarkDoneWithoutConfirmation: true.
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const source = rows.find((el) => el.getAttribute("data-element-id") === "source-1");
    const done = source?.querySelector('[data-testid="queue-action-markDone"]') as HTMLElement;

    h.actOnQueueItem.mockResolvedValueOnce({ item: null, removed: true, undo: null });

    fireEvent.click(done);

    await waitFor(() =>
      expect(h.getBlockProcessingSummary).toHaveBeenCalledWith({ sourceElementId: "source-1" }),
    );
    // Fast path: the intent is "finished" → markDone with the server gate override.
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "markDone", confirmUnresolvedBlocks: true },
      }),
    );
    // No popover ever opened — the surface marked done with no fuss.
    expect(screen.queryByTestId("done-intent-pop")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("opens the intent surface (no window.confirm) for an unresolved source row", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.getBlockProcessingSummary.mockResolvedValueOnce({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 2,
        stateCounts: { unread: 2, read: 0, needs_later: 0, stale_after_edit: 0 },
      },
    });
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const source = rows.find((el) => el.getAttribute("data-element-id") === "source-1");
    const done = source?.querySelector('[data-testid="queue-action-markDone"]') as HTMLElement;

    fireEvent.click(done);

    // The non-modal popover opens; the native confirm is never called and no mutation runs yet.
    await screen.findByTestId("done-intent-pop");
    expect(confirm).not.toHaveBeenCalled();
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
  });

  it("surfaces a proactive done nudge for source retirement suggestions", async () => {
    const retirementSuggestion = {
      kind: "abandon" as const,
      reason: "mostly_ignored_no_output",
      reasonLabel: "Mostly ignored blocks, no extracts yet",
      signalHash: "hash-retire-1",
      terminalRatio: 1,
      ignoredRatio: 0.75,
      totalBlocks: 4,
      terminalBlocks: 4,
      ignoredBlocks: 3,
      unresolvedBlocks: 0,
      extractedOutputCount: 0,
    };
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: true,
        unresolvedBlocks: 0,
        stateCounts: { unread: 0, read: 0, needs_later: 0, stale_after_edit: 0 },
      },
    });
    h.listQueue.mockResolvedValue({
      ...h.result,
      items: [
        {
          ...h.sourceRow,
          schedulerSignals: { ...h.sourceRow.schedulerSignals, retirementSuggestion },
        },
      ],
    });

    render(<QueueScreen />);
    const row = await screen.findByTestId("queue-item");

    fireEvent.click(row.querySelector('[data-testid="queue-retirement-review"]') as HTMLElement);

    await screen.findByTestId("done-intent-pop");
    expect(screen.getByTestId("done-intent-abandon")).toHaveTextContent("Suggested");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();

    fireEvent.click(row.querySelector('[data-testid="queue-retirement-dismiss"]') as HTMLElement);
    await waitFor(() =>
      expect(h.dismissSourceRetirementSuggestion).toHaveBeenCalledWith({
        sourceElementId: "source-1",
        signalHash: "hash-retire-1",
      }),
    );
  });

  it("keeps the stale retirement-dismissal message after refreshing the queue", async () => {
    const retirementSuggestion = {
      kind: "abandon" as const,
      reason: "mostly_ignored_no_output",
      reasonLabel: "Mostly ignored blocks, no extracts yet",
      signalHash: "hash-stale-retire",
      terminalRatio: 1,
      ignoredRatio: 0.75,
      totalBlocks: 4,
      terminalBlocks: 4,
      ignoredBlocks: 3,
      unresolvedBlocks: 0,
      extractedOutputCount: 0,
    };
    h.dismissSourceRetirementSuggestion.mockResolvedValue({
      dismissed: false,
      stale: true,
      suggestion: null,
    });
    h.listQueue
      .mockResolvedValueOnce({
        ...h.result,
        items: [
          {
            ...h.sourceRow,
            schedulerSignals: { ...h.sourceRow.schedulerSignals, retirementSuggestion },
          },
        ],
      })
      .mockResolvedValue({
        ...h.result,
        items: [{ ...h.sourceRow }],
      });

    render(<QueueScreen />);
    const row = await screen.findByTestId("queue-item");
    fireEvent.click(row.querySelector('[data-testid="queue-retirement-dismiss"]') as HTMLElement);

    await waitFor(() =>
      expect(screen.getByTestId("queue-error")).toHaveTextContent(
        "Source changed; refreshed the done suggestion.",
      ),
    );
  });

  it("Finished routes the unresolved source to markDone with the confirm override and shows an Undo snackbar", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.getBlockProcessingSummary.mockResolvedValueOnce({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 2,
        stateCounts: { unread: 2, read: 0, needs_later: 0, stale_after_edit: 0 },
      },
    });
    h.actOnQueueItem.mockResolvedValueOnce({
      item: null,
      removed: true,
      undo: { kind: "status", previousStatus: "active", previousDueAt: "2026-05-29T08:00:00.000Z" },
    });
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const source = rows.find((el) => el.getAttribute("data-element-id") === "source-1");
    const done = source?.querySelector('[data-testid="queue-action-markDone"]') as HTMLElement;

    fireEvent.click(done);
    await screen.findByTestId("done-intent-pop");
    fireEvent.click(screen.getByTestId("done-intent-finished"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "markDone", confirmUnresolvedBlocks: true },
      }),
    );
    // Finished returns an undo recipe → the single-action Undo snackbar appears, and its
    // Undo hits the row's own queue.act recipe (the same op as the shell ⌘Z).
    const snackbar = await screen.findByTestId("queue-snackbar");
    expect(snackbar).toHaveTextContent("Source done");
    fireEvent.click(screen.getByTestId("queue-snackbar-undo"));
    await waitFor(() =>
      expect(h.undoQueueAction).toHaveBeenCalledWith({
        id: "source-1",
        undo: {
          kind: "status",
          previousStatus: "active",
          previousDueAt: "2026-05-29T08:00:00.000Z",
        },
      }),
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("Return later routes the unresolved source to postpone (no snackbar — non-destructive)", async () => {
    h.getBlockProcessingSummary.mockResolvedValueOnce({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 2,
        stateCounts: { unread: 2, read: 0, needs_later: 0, stale_after_edit: 0 },
      },
    });
    h.actOnQueueItem.mockResolvedValueOnce({ item: null, removed: false, undo: null });
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const source = rows.find((el) => el.getAttribute("data-element-id") === "source-1");
    const done = source?.querySelector('[data-testid="queue-action-markDone"]') as HTMLElement;

    fireEvent.click(done);
    await screen.findByTestId("done-intent-pop");
    fireEvent.click(screen.getByTestId("done-intent-later"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "postpone" },
      }),
    );
    // postpone returns undo:null → no snackbar (it relies on the shell ⌘Z).
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();
  });

  it("Abandon routes the unresolved source to dismiss and shows an Undo snackbar", async () => {
    h.getBlockProcessingSummary.mockResolvedValueOnce({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 2,
        stateCounts: { unread: 2, read: 0, needs_later: 0, stale_after_edit: 0 },
      },
    });
    h.actOnQueueItem.mockResolvedValueOnce({
      item: null,
      removed: true,
      undo: { kind: "status", previousStatus: "active", previousDueAt: "2026-05-29T08:00:00.000Z" },
    });
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const source = rows.find((el) => el.getAttribute("data-element-id") === "source-1");
    const done = source?.querySelector('[data-testid="queue-action-markDone"]') as HTMLElement;

    fireEvent.click(done);
    await screen.findByTestId("done-intent-pop");
    fireEvent.click(screen.getByTestId("done-intent-abandon"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "dismiss" },
      }),
    );
    const snackbar = await screen.findByTestId("queue-snackbar");
    expect(snackbar).toHaveTextContent("Source abandoned");
  });

  it("cancels the intent surface on Esc without mutating (the row stays)", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.getBlockProcessingSummary.mockResolvedValueOnce({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 2,
        stateCounts: { unread: 2, read: 0, needs_later: 0, stale_after_edit: 0 },
      },
    });
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const source = rows.find((el) => el.getAttribute("data-element-id") === "source-1");
    const done = source?.querySelector('[data-testid="queue-action-markDone"]') as HTMLElement;

    fireEvent.click(done);
    await screen.findByTestId("done-intent-pop");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("done-intent-pop")).toBeNull());
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("opening the intent surface on a source row does not disable other rows' actions", async () => {
    h.getBlockProcessingSummary.mockResolvedValueOnce({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 2,
        stateCounts: { unread: 2, read: 0, needs_later: 0, stale_after_edit: 0 },
      },
    });
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const source = rows.find((el) => el.getAttribute("data-element-id") === "source-1");
    const done = source?.querySelector('[data-testid="queue-action-markDone"]') as HTMLElement;

    fireEvent.click(done);
    await screen.findByTestId("done-intent-pop");

    // Another row's action button stays enabled — opening the surface is non-modal and
    // never sets the queue-wide busy (busyId is set only when an intent is submitted).
    const extract = screen
      .getAllByTestId("queue-item")
      .find((el) => el.getAttribute("data-element-id") === "extract-1");
    const postpone = extract?.querySelector('[data-testid="queue-action-postpone"]') as HTMLElement;
    expect(postpone).not.toBeDisabled();
  });

  it("maps the ↑ arrow to raise and the ↓ arrow to lower (direction is not swapped)", async () => {
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    const raise = extract?.querySelector('[data-testid="queue-action-raise"]') as HTMLElement;
    const lower = extract?.querySelector('[data-testid="queue-action-lower"]') as HTMLElement;

    // Guard against an icon swap: the UP arrow must sit on the button that raises
    // priority (toward A) and the DOWN arrow on the one that lowers it (toward D).
    expect(raise.querySelector("svg")?.getAttribute("class")).toMatch(/arrow-up/);
    expect(lower.querySelector("svg")?.getAttribute("class")).toMatch(/arrow-down/);
    expect(raise).toHaveAttribute("aria-label", "Raise priority");
    expect(lower).toHaveAttribute("aria-label", "Lower priority");
  });

  it("shows a styled tooltip with the action label on keyboard focus", async () => {
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    const del = extract?.querySelector('[data-testid="queue-action-delete"]') as HTMLElement;

    expect(screen.queryByTestId("tooltip")).toBeNull();
    fireEvent.focus(del);
    expect(screen.getByTestId("tooltip")).toHaveTextContent("Delete");
    fireEvent.blur(del);
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("shows the tooltip on pointer hover over a row action", async () => {
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    const raise = extract?.querySelector('[data-testid="queue-action-raise"]') as HTMLElement;

    // The Tooltip wrapper (.tt) is the button's parent and carries the hover handlers.
    const wrap = raise.parentElement as HTMLElement;
    fireEvent.mouseEnter(wrap);
    expect(screen.getByTestId("tooltip")).toHaveTextContent("Raise priority");
    fireEvent.mouseLeave(wrap);
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  it("delete removes the row without showing a per-item undo snackbar", async () => {
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
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "extract-1",
        action: { kind: "delete" },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("queue-item")).toBeNull());
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();
    expect(h.undoQueueAction).not.toHaveBeenCalled();
  });

  it("deleting an extract WITH live descendants opens the intent menu, not a silent prune (Covers R15/AE8)", async () => {
    // The queue `delete` path must route a node with live descendants through the
    // descendant-aware menu instead of the single-row `queue.act` prune.
    h.countDescendants.mockResolvedValueOnce({
      extracts: 1,
      cards: 1,
      cardsWithHistory: 1,
      total: 2,
    });
    render(<QueueScreen />);
    const rows = await screen.findAllByTestId("queue-item");
    const extract = rows.find((el) => el.getAttribute("data-element-id") === "extract-1");
    const del = extract?.querySelector('[data-testid="queue-action-delete"]') as HTMLElement;

    fireEvent.click(del);

    const pop = await screen.findByTestId("lineage-delete-pop");
    expect(pop).toBeInTheDocument();
    expect(screen.getByTestId("lineage-delete-radius").textContent).toContain(
      "1 extract, 1 card (1 with review history)",
    );
    // No silent prune happened — the menu is collecting intent.
    expect(h.actOnQueueItem).not.toHaveBeenCalledWith({
      id: "extract-1",
      action: { kind: "delete" },
    });

    // Choosing "Delete the whole branch" soft-cascades under one batch.
    fireEvent.click(screen.getByTestId("lineage-delete-branch"));
    await waitFor(() =>
      expect(h.softDeleteSubtree).toHaveBeenCalledWith({ id: "extract-1", includeSubtree: true }),
    );
  });

  it("re-reads the queue after a global undo event", async () => {
    render(<QueueScreen />);
    await screen.findAllByTestId("queue-item");

    h.listQueue.mockClear();
    window.dispatchEvent(new CustomEvent("interleave:undo"));

    await waitFor(() => expect(h.listQueue).toHaveBeenCalledWith({ includeTimeEstimate: true }));
  });
});
