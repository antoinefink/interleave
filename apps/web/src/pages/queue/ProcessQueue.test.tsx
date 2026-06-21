/**
 * ProcessQueue loop component tests (T031 + T037 inline card review).
 *
 * The queue read (sorting/filtering/budget) lives in `packages/local-db`; this
 * asserts the RENDERER seam of the one-at-a-time loop:
 *  - it renders ONE item at a time (the current cursor item only);
 *  - acting on an item calls the SAME typed `queue.act` mutation path as the list
 *    (no new channel) and ADVANCES the cursor to the next item;
 *  - reaching the end shows the "Queue clear" done state;
 *  - a CARD reveals its answer INLINE (cloze unmasked / Q&A answer), renders the
 *    four interval previews from `review.preview`, and grading it calls the SAME
 *    `review.grade` the review session uses (with prompt/response timings + rating)
 *    then advances the cursor — NO detour to /review.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.queue.list` returns a fixed payload, `queue.act` / `review.*` are
 * spies, and the router + selection seams are stubbed. No SQLite/IPC — the renderer
 * is a pure UI consumer.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestQueueRefresh } from "../../components/queue/queueRefresh";
import type {
  DailyWorkSummaryResult,
  KnowledgeGraduationEvent,
  QueueItemSummary,
  QueueListResult,
  ReviewCardView,
  ReviewIntervalPreview,
  ReviewRating,
} from "../../lib/appApi";

const h = vi.hoisted(() => {
  type DailyWorkWithGraduations = DailyWorkSummaryResult & {
    readonly graduationEvents?: readonly KnowledgeGraduationEvent[];
  };
  const mk = (over: Partial<QueueItemSummary> & { id: string }): QueueItemSummary => ({
    type: "extract",
    status: "scheduled",
    stage: "clean_extract",
    priority: 0.625,
    title: `Item ${over.id}`,
    dueAt: "2026-05-30T06:00:00.000Z",
    scheduler: "attention",
    schedulerSignals: {
      kind: "attention",
      retrievability: null,
      stability: null,
      fsrsState: null,
      lapses: null,
      stage: "clean_extract",
      postponed: 0,
      scheduleReason: null,
      retirementSuggestion: null,
      needsReverify: false,
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
    linkedSourceId: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
    queueEligible: true,
    notInQueueReason: null,
    fallowState: null,
    fallowUntil: null,
    fallowReason: null,
    fallowTopicId: null,
    extractAging: null,
    ...over,
  });
  const card = mk({
    id: "card-1",
    type: "card",
    scheduler: "fsrs",
    stage: "active_card",
    cardType: "qa",
    priority: 0.875,
    protected: true,
    title: "What does Chollet define intelligence as?",
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
      needsReverify: false,
    },
  });
  const extractA = mk({
    id: "extract-1",
    title: "skill-acquisition efficiency",
    sourceId: "source-1",
  });
  const source = mk({
    id: "source-1",
    type: "source",
    stage: "raw_source",
    title: "The Bitter Lesson",
  });
  const result: QueueListResult = {
    items: [card, source, extractA],
    counts: {
      all: 3,
      card: 1,
      source: 1,
      extract: 1,
      topic: 0,
      task: 0,
      highPriority: 2,
      overdue: 0,
      protected: 2,
    },
    budget: { used: 3, target: 30 },
    minuteBudget: { usedMinutes: 18, targetMinutes: 30, confidence: "default" },
    timeEstimate: {
      confidence: "default",
      totalMinutes: 18,
      pricedItemCount: 3,
      items: [],
    },
  };
  const dailyWork: DailyWorkWithGraduations = {
    asOf: "2026-05-30T18:00:00.000Z",
    dueQueueItems: 3,
    inboxSources: 0,
    activeUnscheduledSources: 0,
    resumeSource: null,
    recommendedAction: "process_due_queue",
    graduationEvents: [],
    autoPostponeReceipt: null,
    extractAgingReceipts: [],
  };
  // The full reveal-ready view for card-1 (the answer + source ref ship with the
  // card; the renderer hides them until reveal — exactly like the review session).
  const cardView: ReviewCardView = {
    id: "card-1",
    kind: "qa",
    prompt: "What does Chollet define intelligence as?",
    answer: "Skill-acquisition efficiency.",
    cloze: null,
    priority: 0.875,
    stage: "active_card",
    concept: null,
    sourceTitle: "On the Measure of Intelligence",
    sourceLocationLabel: "¶ 4",
    ref: "intelligence is skill-acquisition efficiency",
    sourceRef: {
      sourceElementId: "source-9",
      sourceTitle: "On the Measure of Intelligence",
      url: null,
      author: "François Chollet",
      publishedAt: null,
      locationLabel: "¶ 4",
      snippet: "intelligence is skill-acquisition efficiency",
      sourceType: null,
      reliabilityTier: null,
      confidence: null,
      reliabilityNotes: null,
    },
    expiry: null,
    schedulerSignals: {
      kind: "fsrs",
      retrievability: 0.82,
      stability: 9.4,
      difficulty: 5.1,
      reps: 3,
      lapses: 0,
      fsrsState: "review",
    },
    leech: false,
    lapses: 0,
    flagged: false,
    siblingGroupId: null,
    fallowContext: null,
    occlusion: null,
    mediaRef: null,
    mediaSource: null,
    youtubeId: null,
  };
  const previews: Record<ReviewRating, ReviewIntervalPreview> = {
    again: { dueAt: "2026-05-30T08:10:00.000Z", scheduledDays: 0.007, label: "10m" },
    hard: { dueAt: "2026-05-31T08:00:00.000Z", scheduledDays: 1, label: "1d" },
    good: { dueAt: "2026-06-03T08:00:00.000Z", scheduledDays: 4, label: "4d" },
    easy: { dueAt: "2026-06-09T08:00:00.000Z", scheduledDays: 10, label: "10d" },
  };
  return {
    search: {} as { asOf?: string; mode?: string; assembled?: string | number | boolean },
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    setHintSpy: vi.fn(),
    listQueue: vi.fn().mockResolvedValue(result),
    getDailyWorkSummary: vi.fn().mockResolvedValue(dailyWork),
    actOnQueueItem: vi.fn().mockResolvedValue({ item: null, removed: true, undo: null }),
    // Descendant-aware delete (T135 / U7): default to a LEAF so the loop's Delete takes
    // the quiet path through `actOnQueueItem({delete})`.
    countDescendants: vi
      .fn()
      .mockResolvedValue({ extracts: 0, cards: 0, cardsWithHistory: 0, total: 0 }),
    softDeleteSubtree: vi.fn().mockResolvedValue({ batchId: "b", affected: [], skipped: [] }),
    restoreBatchFromTrash: vi
      .fn()
      .mockResolvedValue({ restored: [], skipped: [], rootRestored: true }),
    fallowTopic: vi.fn().mockResolvedValue({ applied: 1, skipped: [], batchId: "fb" }),
    getBlockProcessingSummary: vi.fn().mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: true,
        unresolvedBlocks: 0,
      },
    }),
    scheduleQueueItem: vi.fn().mockResolvedValue({
      item: null,
      dueAt: "2026-06-01T12:00:00.000Z",
      intervalDays: 1,
    }),
    undoQueueAction: vi.fn().mockResolvedValue({ item: null }),
    undoLast: vi.fn().mockResolvedValue({
      undone: true,
      opType: "reschedule_element",
      elementId: "source-1",
      label: "Undid change",
      count: 1,
    }),
    getDocument: vi.fn().mockResolvedValue({
      document: {
        prosemirrorJson: { type: "doc", content: [], mockPlainText: "Body preview text." },
        plainText: "Body preview text.",
      },
      extractedBlockIds: [],
    }),
    saveDocument: vi.fn().mockResolvedValue({
      document: {
        prosemirrorJson: { type: "doc", content: [], mockPlainText: "Edited source body." },
        plainText: "Edited source body.",
      },
    }),
    getInspectorData: vi.fn().mockResolvedValue({ data: null }),
    updateExtractStage: vi.fn().mockResolvedValue({
      extract: {
        id: "extract-1",
        type: "extract",
        status: "scheduled",
        stage: "atomic_statement",
        priority: 0.625,
        title: "skill-acquisition efficiency",
        dueAt: "2026-05-31T06:00:00.000Z",
        extractFate: null,
        sourceId: "source-1",
        parentId: null,
      },
    }),
    rewriteExtract: vi.fn().mockResolvedValue({
      extract: {
        id: "extract-1",
        type: "extract",
        status: "scheduled",
        stage: "clean_extract",
        priority: 0.625,
        title: "skill-acquisition efficiency",
        dueAt: "2026-05-31T06:00:00.000Z",
        extractFate: null,
        sourceId: "source-1",
        parentId: null,
      },
      plainText: "Edited extract body.",
    }),
    setExtractFate: vi.fn().mockResolvedValue({
      extract: {
        id: "extract-1",
        type: "extract",
        status: "done",
        stage: "clean_extract",
        priority: 0.625,
        title: "skill-acquisition efficiency",
        dueAt: null,
        extractFate: "reference",
        sourceId: "source-1",
        parentId: null,
      },
    }),
    siblingCardAnswers: vi.fn().mockResolvedValue({ cards: [] }),
    createExtraction: vi.fn().mockResolvedValue({
      extract: {
        id: "subextract-1",
        type: "extract",
        status: "scheduled",
        stage: "raw_extract",
        priority: 0.625,
        title: "Sub extract",
        dueAt: "2026-06-10T00:00:00.000Z",
        parentId: "extract-1",
        sourceId: "source-1",
      },
      location: {
        id: "loc-subextract-1",
        sourceElementId: "extract-1",
        blockIds: ["extract-block-1"],
        startOffset: 0,
        endOffset: 1,
        label: "¶1",
        selectedText: "Sub extract",
      },
    }),
    createCard: vi.fn().mockResolvedValue({
      card: { id: "card-new", siblingGroupId: "sib-1" },
    }),
    selectionLocation: {
      current: null as null | {
        selectedText: string;
        blockIds: string[];
        startOffset: number;
        endOffset: number;
      },
    },
    selectionPosition: { current: null as null | { top: number; left: number } },
    dismissSelection: vi.fn(),
    markExtracted: vi.fn(),
    readPointState: {
      status: "ready",
      readPoint: null as null | { blockId: string; offset: number },
      saving: false,
      error: null as string | null,
      setFromSelection: vi.fn().mockResolvedValue({ blockId: "blk_source", offset: 42 }),
      markReadThrough: vi.fn().mockResolvedValue({ blockId: "blk_source", offset: 99 }),
      jump: vi.fn(),
      firstUnreadBlockId: vi.fn(() => "blk_source"),
      progress: vi.fn(() => ({ index: 0, total: 4 })),
      progressFraction: vi.fn(() => 0.25),
      isAtOrAfterReadPoint: vi.fn(() => true),
    },
    highlightsState: {
      highlights: [] as unknown[],
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      error: null as string | null,
    },
    staleEditorJson: false,
    reviewCard: vi.fn().mockResolvedValue({ card: cardView }),
    reviewPreview: vi.fn().mockResolvedValue({ intervals: previews }),
    reviewGrade: vi.fn().mockResolvedValue({
      reviewLog: {
        id: "log-1",
        elementId: "card-1",
        rating: "good",
        reviewedAt: "2026-05-30T08:00:05.000Z",
        promptMs: 0,
        responseMs: 1234,
        nextDueAt: "2026-06-03T08:00:00.000Z",
      },
      reviewState: {
        dueAt: "2026-06-03T08:00:00.000Z",
        stability: 12.1,
        difficulty: 5.0,
        reps: 4,
        lapses: 0,
        fsrsState: "review",
        lastReviewedAt: "2026-05-30T08:00:05.000Z",
      },
    }),
    cardView,
    result,
    dailyWork,
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
      fallowTopic: h.fallowTopic,
      getBlockProcessingSummary: h.getBlockProcessingSummary,
      scheduleQueueItem: h.scheduleQueueItem,
      undoQueueAction: h.undoQueueAction,
      undoLast: h.undoLast,
      getDocument: h.getDocument,
      saveDocument: h.saveDocument,
      getInspectorData: h.getInspectorData,
      updateExtractStage: h.updateExtractStage,
      rewriteExtract: h.rewriteExtract,
      setExtractFate: h.setExtractFate,
      siblingCardAnswers: h.siblingCardAnswers,
      createExtraction: h.createExtraction,
      createCard: h.createCard,
      reviewCard: h.reviewCard,
      reviewPreview: h.reviewPreview,
      reviewGrade: h.reviewGrade,
    },
  };
});

vi.mock("@interleave/editor", async () => {
  const actual = await vi.importActual<typeof import("@interleave/editor")>("@interleave/editor");
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    emptyDoc: () => ({ type: "doc", content: [], mockPlainText: "" }),
    setReaderDecorations: vi.fn(),
    toPlainText: (doc: { mockPlainText?: string } | null | undefined) =>
      doc?.mockPlainText ?? "Edited extract body.",
    toBlockInputs: vi.fn(() => [
      { blockType: "paragraph", order: 0, stableBlockId: "blk_process_extract" },
    ]),
    SourceEditor: ({
      onChange,
      onEditorReady,
    }: {
      onChange?: (change: { prosemirrorJson: unknown; plainText: string }) => void;
      onEditorReady?: (editor: { getJSON(): unknown } | null) => void;
    }) => {
      const [value, setValue] = React.useState("Body preview text.");
      const valueRef = React.useRef(value);
      valueRef.current = value;
      React.useEffect(() => {
        onEditorReady?.({
          getJSON: () => ({
            type: "doc",
            content: [],
            mockPlainText: h.staleEditorJson ? "Body preview text." : valueRef.current,
          }),
        });
        return () => onEditorReady?.(null);
      }, [onEditorReady]);
      if (h.staleEditorJson) {
        return (
          <div className="reader" data-testid="mock-source-editor">
            <div
              className="ProseMirror"
              contentEditable
              suppressContentEditableWarning
              onInput={(e) => {
                const plainText = e.currentTarget.textContent ?? "";
                valueRef.current = plainText;
                setValue(plainText);
              }}
            >
              {value}
            </div>
          </div>
        );
      }
      return (
        <div className="reader">
          <textarea
            data-testid="mock-source-editor"
            value={value}
            onChange={(e) => {
              const plainText = e.target.value;
              valueRef.current = plainText;
              setValue(plainText);
              onChange?.({
                prosemirrorJson: { type: "doc", content: [], mockPlainText: plainText },
                plainText,
              });
            }}
          />
        </div>
      );
    },
  };
});

vi.mock("../../reader/useTextSelection", () => ({
  useTextSelection: () => ({
    position: h.selectionPosition.current,
    location: h.selectionLocation.current,
    dismiss: h.dismissSelection,
  }),
}));

vi.mock("../source/useReadPoint", () => ({
  useReadPoint: () => h.readPointState,
}));

vi.mock("../source/useHighlights", () => ({
  useHighlights: () => h.highlightsState,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigateSpy,
  useSearch: () => h.search,
  Link: ({ to, children, ...props }: { to: string; children?: import("react").ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
}));

vi.mock("../../shell/statusHint", () => ({
  useStatusHint: () => ({ hint: null, setHint: h.setHintSpy }),
}));

// The seeded daily jitter (T029) is a presentation collaborator that reorders the
// queue by the calendar day — its shuffle is covered by `jitter.test.ts`. Stub it to
// the identity here so this test exercises ONLY the loop's cursor wiring against the
// deterministic input order (card-1 → source-1 → extract-1), instead of depending on
// today's wall-clock seed (which would make these assertions flaky day to day).
vi.mock("./jitter", () => ({
  jitterOrder: <T,>(rows: readonly T[]): T[] => [...rows],
  daySeed: () => "2026-01-01",
}));

import { ProcessQueue } from "./ProcessQueue";
import { acceptSessionAssembly, clearAcceptedSessionAssembly } from "./sessionAssemblyState";

beforeEach(() => {
  vi.clearAllMocks();
  clearAcceptedSessionAssembly();
  h.search = {};
  h.listQueue.mockResolvedValue(h.result);
  h.actOnQueueItem.mockResolvedValue({ item: null, removed: true, undo: null });
  h.getDailyWorkSummary.mockResolvedValue(h.dailyWork);
  h.getBlockProcessingSummary.mockResolvedValue({
    summary: {
      canMarkDoneWithoutConfirmation: true,
      unresolvedBlocks: 0,
    },
  });
  h.scheduleQueueItem.mockResolvedValue({
    item: null,
    dueAt: "2026-06-01T12:00:00.000Z",
    intervalDays: 1,
  });
  h.undoQueueAction.mockResolvedValue({ item: null });
  h.undoLast.mockResolvedValue({
    undone: true,
    opType: "reschedule_element",
    elementId: "source-1",
    label: "Undid change",
    count: 1,
  });
  h.getDocument.mockResolvedValue({
    document: {
      prosemirrorJson: { type: "doc", content: [], mockPlainText: "Body preview text." },
      plainText: "Body preview text.",
    },
    extractedBlockIds: [],
  });
  h.getInspectorData.mockResolvedValue({ data: null });
  h.setHintSpy.mockClear();
  h.search = {};
  h.staleEditorJson = false;
  h.selectionLocation.current = null;
  h.selectionPosition.current = null;
  h.readPointState.readPoint = null;
  h.readPointState.saving = false;
  h.readPointState.error = null;
  h.readPointState.setFromSelection.mockClear();
  h.readPointState.markReadThrough.mockClear();
  h.readPointState.jump.mockClear();
  h.readPointState.firstUnreadBlockId.mockClear();
  h.readPointState.progress.mockClear();
  h.readPointState.progressFraction.mockClear();
  h.readPointState.isAtOrAfterReadPoint.mockClear();
  h.highlightsState.highlights = [];
  h.highlightsState.add.mockClear();
  h.highlightsState.remove.mockClear();
  h.highlightsState.error = null;
  h.saveDocument.mockResolvedValue({
    document: {
      prosemirrorJson: { type: "doc", content: [], mockPlainText: "Edited source body." },
      plainText: "Edited source body.",
    },
  });
});

function acceptTestAssembly(
  rows: readonly { readonly item: QueueItemSummary; readonly estimatedMinutes: number }[],
  cut: { readonly totalCount: number; readonly totalMinutes: number } = {
    totalCount: 0,
    totalMinutes: 0,
  },
) {
  acceptSessionAssembly({
    origin: "queue",
    mode: "full",
    plan: {
      targetMinutes: 25,
      plannedMinutes: rows.reduce((sum, row) => sum + row.estimatedMinutes, 0),
      candidateMinutes: rows.reduce((sum, row) => sum + row.estimatedMinutes, 0) + cut.totalMinutes,
      plannedCount: rows.length,
      candidateCount: rows.length + cut.totalCount,
      overTarget: false,
      confidence: "default",
      usesDefaultEstimate: true,
      composition: {
        status: "inactive_zero_target",
        quotaFloorMinutes: 0,
        eligibleDistillationMinutes: 0,
        selectedDistillationMinutes: 0,
        returnedQuotaMinutes: 0,
        cardMinutes: 0,
        distillationMinutes: 0,
        otherMinutes: 0,
      },
      items: rows.map((row) => ({
        item: row.item,
        estimatedMinutes: row.estimatedMinutes,
        estimateConfidence: "default",
        estimateBasis: "test",
      })),
      cut: {
        totalCount: cut.totalCount,
        totalMinutes: cut.totalMinutes,
        detailLimit: 25,
        items: [],
        byReason: { did_not_fit: { count: cut.totalCount, minutes: cut.totalMinutes } },
        byType: {},
      },
    },
  });
}

/** The id of the single rendered process item (the cursor item), or null. */
function currentItemId(): string | null {
  return screen.queryByTestId("process-item")?.getAttribute("data-element-id") ?? null;
}

function stageMutation(stage: string) {
  return {
    extract: {
      id: "extract-1",
      type: "extract",
      status: "scheduled",
      stage,
      priority: 0.625,
      title: "skill-acquisition efficiency",
      dueAt: "2026-05-31T06:00:00.000Z",
      extractFate: null,
      sourceId: "source-1",
      parentId: null,
    },
  };
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, "m"));
  return match?.groups?.body ?? "";
}

async function moveToExtract(): Promise<void> {
  // The deterministic mock order is card -> source -> extract.
  await screen.findByTestId("process-item");
  fireEvent.click(screen.getByTestId("process-action-skip"));
  await waitFor(() => expect(currentItemId()).toBe("source-1"));
  fireEvent.click(screen.getByTestId("process-action-skip"));
  await waitFor(() => expect(currentItemId()).toBe("extract-1"));
  await screen.findByTestId("process-extract-workbench");
}

async function moveToSource(): Promise<void> {
  await screen.findByTestId("process-item");
  fireEvent.click(screen.getByTestId("process-action-skip"));
  await waitFor(() => expect(currentItemId()).toBe("source-1"));
  await screen.findByTestId("process-source-workbench");
  await screen.findByTestId("mock-source-editor");
}

describe("ProcessQueue", () => {
  it("keeps the centered process card flat instead of shadowed", () => {
    const css = readFileSync(resolve(import.meta.dirname, "process-queue.css"), "utf8");
    const card = cssRule(css, ".pq-card");

    expect(card).toContain("border: 1px solid var(--border);");
    expect(card).not.toMatch(/\bbox-shadow\s*:/);
  });

  it("renders exactly ONE element at a time (the cursor item)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(screen.getAllByTestId("process-item")).toHaveLength(1);
    expect(screen.getByTestId("process-center")).toHaveClass("pq-center");
    expect(screen.getByTestId("process-center")).not.toHaveClass("pq-center--extract");
    expect(screen.getByTestId("process-item")).not.toHaveClass("pq-card--extract");
  });

  it("shows the progress readout (N / total)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-progress");
    expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3");
  });

  it("removes the dedicated process header bar without removing session controls", async () => {
    render(<ProcessQueue />);

    await screen.findByTestId("process-item");

    expect(screen.getByTestId("process-session-controls")).toContainElement(
      screen.getByTestId("process-progress"),
    );
    expect(screen.getByTestId("process-session-controls")).toContainElement(
      screen.getByTestId("process-modes"),
    );
    expect(screen.getByTestId("process-session-controls")).toContainElement(
      screen.getByTestId("process-end"),
    );
  });

  it("ends the process session back to the dated queue when scoped by asOf", async () => {
    h.search = { asOf: "2026-05-30T18:00:00.000Z" };
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");

    fireEvent.click(screen.getByTestId("process-end"));

    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/queue",
      search: { asOf: "2026-05-30T18:00:00.000Z" },
    });
  });

  it("advances to the next item after an action, using the queue.act path", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    const first = currentItemId();

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: first,
        action: { kind: "markDone" },
      }),
    );
    // The cursor advanced: a DIFFERENT item is now shown (no return to a list).
    await waitFor(() => expect(currentItemId()).not.toBe(first));
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("keeps recipe undo after a lifecycle action without showing a snackbar", async () => {
    h.actOnQueueItem.mockResolvedValueOnce({
      item: null,
      removed: true,
      undo: { kind: "status", previousStatus: "scheduled" },
    });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");

    fireEvent.click(screen.getByTestId("process-action-markDone"));

    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();

    fireEvent.keyDown(window, { key: "z", metaKey: true });

    await waitFor(() =>
      expect(h.undoQueueAction).toHaveBeenCalledWith({
        id: "card-1",
        undo: { kind: "status", previousStatus: "scheduled" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("card-1"));
    expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3");
  });

  it("undoes a process lifecycle action from the keyboard with command-z", async () => {
    h.actOnQueueItem.mockResolvedValueOnce({
      item: null,
      removed: true,
      undo: { kind: "status", previousStatus: "scheduled" },
    });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();

    fireEvent.keyDown(window, { key: "z", metaKey: true });

    await waitFor(() =>
      expect(h.undoQueueAction).toHaveBeenCalledWith({
        id: "card-1",
        undo: { kind: "status", previousStatus: "scheduled" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("card-1"));
  });

  it("marks complete source rows done without confirmation", async () => {
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-action-markDone"));

    await waitFor(() =>
      expect(h.getBlockProcessingSummary).toHaveBeenCalledWith({ sourceElementId: "source-1" }),
    );
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "markDone" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
  });

  it("opens the in-app done-intent surface for an unresolved source instead of a native confirm", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 3,
        stateCounts: { unread: 2, read: 1 },
      },
    });
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-action-markDone"));

    // The non-modal intent popover appears with the three choices — no native dialog, no mutation.
    expect(await screen.findByTestId("done-intent-pop")).toBeInTheDocument();
    expect(screen.getByTestId("done-intent-later")).toBeInTheDocument();
    expect(screen.getByTestId("done-intent-finished")).toBeInTheDocument();
    expect(screen.getByTestId("done-intent-abandon")).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(currentItemId()).toBe("source-1");
  });

  it("marks an unresolved source done with the confirm override from the Finished intent", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 3,
        stateCounts: { unread: 3 },
      },
    });
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    fireEvent.click(await screen.findByTestId("done-intent-finished"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "markDone", confirmUnresolvedBlocks: true },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("shows an Undo snackbar after finishing an unresolved source and undoes the same op", async () => {
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 3,
        stateCounts: { unread: 3 },
      },
    });
    h.actOnQueueItem.mockResolvedValueOnce({
      item: null,
      removed: true,
      undo: { kind: "status", previousStatus: "scheduled" },
    });
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    fireEvent.click(await screen.findByTestId("done-intent-finished"));
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));

    // A VISIBLE Undo affordance appears for the destructive intent (not the silent ⌘Z-only path).
    const snackbar = await screen.findByTestId("queue-snackbar");
    fireEvent.click(within(snackbar).getByRole("button", { name: /undo/i }));

    await waitFor(() =>
      expect(h.undoQueueAction).toHaveBeenCalledWith({
        id: "source-1",
        undo: { kind: "status", previousStatus: "scheduled" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
  });

  it("postpones an unresolved source through the Return later intent", async () => {
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 3,
        stateCounts: { unread: 3 },
      },
    });
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    fireEvent.click(await screen.findByTestId("done-intent-later"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "postpone" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    // Return later is non-destructive — no visible Undo snackbar (⌘Z only).
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();
  });

  it("abandons an unresolved source through the Abandon intent", async () => {
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 3,
        stateCounts: { unread: 3 },
      },
    });
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    fireEvent.click(await screen.findByTestId("done-intent-abandon"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "dismiss" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));

    // Abandon is destructive — it raises the visible "Source abandoned" Undo snackbar.
    const snackbar = await screen.findByTestId("queue-snackbar");
    expect(snackbar).toHaveTextContent("Source abandoned");
    fireEvent.click(within(snackbar).getByRole("button", { name: /undo/i }));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
  });

  it("closes the done-intent surface on Escape without mutating", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 3,
        stateCounts: { unread: 3 },
      },
    });
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await screen.findByTestId("done-intent-pop");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("done-intent-pop")).toBeNull());
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(currentItemId()).toBe("source-1");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("opens the done-intent surface from the d shortcut on an unresolved source", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: {
        canMarkDoneWithoutConfirmation: false,
        unresolvedBlocks: 3,
        stateCounts: { unread: 3 },
      },
    });
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.keyDown(window, { key: "d" });

    expect(await screen.findByTestId("done-intent-pop")).toBeInTheDocument();
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("marks a complete source done from the d shortcut with no popover", async () => {
    const confirm = vi.spyOn(window, "confirm");
    // The default summary mock reports 0 unresolved (fast path).
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.keyDown(window, { key: "d" });

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        action: { kind: "markDone" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    expect(screen.queryByTestId("done-intent-pop")).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("marks a card done immediately from the d shortcut (source-only gate)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");

    fireEvent.keyDown(window, { key: "d" });

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "card-1",
        action: { kind: "markDone" },
      }),
    );
    // No source done-gate read for a card, and no intent popover.
    expect(h.getBlockProcessingSummary).not.toHaveBeenCalled();
    expect(screen.queryByTestId("done-intent-pop")).toBeNull();
  });

  it("keeps command-log undo after postponing through the merged menu", async () => {
    render(<ProcessQueue />);
    await moveToSource();

    expect(screen.queryByTestId("schedule-menu-trigger")).toBeNull();
    expect(screen.getByTestId("process-action-postpone")).toHaveTextContent("Postpone");
    fireEvent.click(screen.getByTestId("process-action-postpone"));
    expect(await screen.findByTestId("schedule-menu-pop")).toBeInTheDocument();
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("schedule-tomorrow"));

    await waitFor(() =>
      expect(h.scheduleQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        choice: { kind: "tomorrow" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();

    fireEvent.keyDown(window, { key: "z", metaKey: true });

    await waitFor(() => expect(h.undoLast).toHaveBeenCalledTimes(1));
    expect(h.undoQueueAction).not.toHaveBeenCalled();
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    expect(screen.getByTestId("process-progress")).toHaveTextContent("2 / 3");
  });

  it("opens the merged Postpone menu from the p shortcut on attention items", async () => {
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.keyDown(window, { key: "p" });
    expect(await screen.findByTestId("schedule-menu-pop")).toBeInTheDocument();
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(h.scheduleQueueItem).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("schedule-nextWeek"));

    await waitFor(() =>
      expect(h.scheduleQueueItem).toHaveBeenCalledWith({
        id: "source-1",
        choice: { kind: "nextWeek" },
      }),
    );
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();

    fireEvent.keyDown(window, { key: "z", metaKey: true });

    await waitFor(() => expect(h.undoLast).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
  });

  it("keeps card Postpone as the immediate queue action", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");
    expect(screen.queryByTestId("schedule-menu")).toBeNull();

    fireEvent.click(screen.getByTestId("process-action-postpone"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "card-1",
        action: { kind: "postpone" },
      }),
    );
    expect(h.scheduleQueueItem).not.toHaveBeenCalled();
  });

  it("replaces a pending silent undo with the next process mutation", async () => {
    h.actOnQueueItem.mockResolvedValueOnce({
      item: null,
      removed: true,
      undo: { kind: "status", previousStatus: "scheduled" },
    });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();

    fireEvent.click(screen.getByTestId("process-action-postpone"));
    fireEvent.click(await screen.findByTestId("schedule-tomorrow"));
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    await waitFor(() => expect(h.scheduleQueueItem).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();

    fireEvent.keyDown(window, { key: "z", metaKey: true });

    await waitFor(() => expect(h.undoLast).toHaveBeenCalledTimes(1));
    expect(h.undoQueueAction).not.toHaveBeenCalled();
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
  });

  it("processes all items one at a time and reaches the done state", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // Act on each of the three items in turn.
    for (let i = 0; i < 3; i++) {
      await screen.findByTestId("process-item");
      fireEvent.click(screen.getByTestId("process-action-markDone"));
      // wait for this action to register before the next
      await waitFor(() => expect(h.actOnQueueItem).toHaveBeenCalledTimes(i + 1));
    }
    await screen.findByTestId("process-done");
    expect(screen.getByTestId("process-done")).toHaveTextContent(/queue clear/i);
    expect(screen.getByTestId("process-done")).toContainElement(
      screen.getByTestId("process-session-controls"),
    );
    expect(screen.getByTestId("process-session-controls")).toContainElement(
      screen.getByTestId("process-progress"),
    );
  });

  it("shows an honest zero-load state and triage action when no due items load but inbox work exists", async () => {
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

    render(<ProcessQueue />);

    const done = await screen.findByTestId("process-done");
    expect(done).toHaveTextContent("No due items today");
    expect(done).not.toHaveTextContent("You processed 0 items");
    expect(done).toHaveTextContent("2 inbox sources still need triage");
    expect(screen.getByTestId("process-next-work")).toHaveTextContent("Triage inbox");

    fireEvent.click(screen.getByTestId("process-next-work"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/inbox" });
  });

  it("shows the loading state before the first due queue read settles", async () => {
    let resolveQueue!: (result: QueueListResult) => void;
    h.listQueue.mockReturnValue(
      new Promise<QueueListResult>((resolve) => {
        resolveQueue = resolve;
      }),
    );

    render(<ProcessQueue />);

    expect(await screen.findByTestId("process-loading")).toHaveTextContent("Loading due queue");
    expect(screen.getByTestId("process-loading")).toContainElement(
      screen.getByTestId("process-session-controls"),
    );
    expect(screen.getByTestId("process-session-controls")).toContainElement(
      screen.getByTestId("process-end"),
    );
    expect(screen.queryByTestId("process-done")).toBeNull();

    resolveQueue(h.result);
    await screen.findByTestId("process-item");
  });

  it("keeps the due session usable if the daily summary read fails", async () => {
    h.getDailyWorkSummary.mockRejectedValue(new Error("daily work down"));

    render(<ProcessQueue />);

    expect(await screen.findByTestId("process-item")).toHaveTextContent(
      "What does Chollet define intelligence as?",
    );
    expect(screen.getByTestId("process-error")).toHaveTextContent("daily work down");
    expect(screen.queryByTestId("process-done")).toBeNull();
  });

  it("does not render a false zero-load clear state when the queue read fails", async () => {
    h.listQueue.mockRejectedValue(new Error("queue down"));

    render(<ProcessQueue />);

    expect(await screen.findByTestId("process-error")).toHaveTextContent("queue down");
    expect(screen.queryByTestId("process-item")).toBeNull();
    expect(screen.queryByTestId("process-done")).toBeNull();
  });

  it("shows an honest zero-load state and resume action for active unscheduled source work", async () => {
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

    render(<ProcessQueue />);

    const done = await screen.findByTestId("process-done");
    expect(done).toHaveTextContent("No due items today");
    expect(done).toHaveTextContent("Active source is active without a return date");
    expect(screen.getByTestId("process-next-work")).toHaveTextContent("Resume source");

    fireEvent.click(screen.getByTestId("process-next-work"));
    expect(h.selectSpy).toHaveBeenCalledWith("source-active");
    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "source-active" },
    });
  });

  it("shows an honest zero-load clear state without a next-work action", async () => {
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
      resumeSource: null,
      recommendedAction: "clear",
    });

    render(<ProcessQueue />);

    const done = await screen.findByTestId("process-done");
    expect(done).toHaveTextContent("No due items today");
    expect(done).not.toHaveTextContent("You processed 0 items");
    expect(screen.queryByTestId("process-next-work")).toBeNull();
  });

  it("skip advances WITHOUT mutating (no queue.act call)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    const first = currentItemId();
    fireEvent.click(screen.getByTestId("process-action-skip"));
    await waitFor(() => expect(currentItemId()).not.toBe(first));
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
  });

  it("renders the card surface with the FSRS chip + a reveal for a card item", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // The first item is the FSRS card.
    expect(currentItemId()).toBe("card-1");
    expect(screen.getByTestId("process-card-face")).toBeInTheDocument();
    expect(screen.getByTestId("process-card-reveal")).toBeInTheDocument();
    // Its chip is the FSRS side (the two-scheduler split holds in the loop).
    expect(
      screen.getByTestId("process-item").querySelector('[data-scheduler="fsrs"]'),
    ).not.toBeNull();
    // The answer is hidden until reveal — no detour-to-review placeholder note.
    expect(screen.queryByTestId("process-card-answer")).toBeNull();
  });

  it("publishes the item's action keys to the status bar instead of an in-card row", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");

    // The standalone keys row inside the scrolling card is gone — the space it took
    // is reclaimed for the body, and the keys live in the shell status bar instead.
    expect(document.querySelector(".pq-keys")).toBeNull();
    expect(h.setHintSpy).toHaveBeenCalled();

    // The published node carries the CARD variant for the first (card) item.
    const node = h.setHintSpy.mock.calls.at(-1)?.[0];
    const { container } = render(<div>{node}</div>);
    expect(container.textContent).toContain("reveal");
    expect(container.textContent).toContain("grade");
  });

  it("publishes the attention-item (non-card) action keys for a source item", async () => {
    render(<ProcessQueue />);
    await moveToSource();
    expect(currentItemId()).toBe("source-1");

    const node = h.setHintSpy.mock.calls.at(-1)?.[0];
    const { container } = render(<div>{node}</div>);
    // Non-card variant: postpone / dismiss / priority — not the card reveal/grade keys.
    expect(container.textContent).toContain("postpone");
    expect(container.textContent).toContain("dismiss");
    expect(container.textContent).toContain("priority");
    expect(container.textContent).not.toContain("reveal");
    // No undo key until an undoable action has happened.
    expect(container.textContent).not.toContain("undo");
  });

  it("adds the undo key to the published hint after an undoable action", async () => {
    h.actOnQueueItem.mockResolvedValueOnce({
      item: null,
      removed: true,
      undo: { kind: "status", previousStatus: "scheduled" },
    });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    fireEvent.click(screen.getByTestId("process-action-markDone"));
    // The cursor advances to the source item, now with a pending undo.
    await waitFor(() => expect(currentItemId()).toBe("source-1"));

    const node = h.setHintSpy.mock.calls.at(-1)?.[0];
    const { container } = render(<div>{node}</div>);
    expect(container.textContent).toContain("undo");
  });

  it("frames the card as a three-zone .pq-rc surface and drops the duplicated FSRS box + redundant open link", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");

    // The card gets the review layout frame, not the source/extract workbench modifiers.
    const item = screen.getByTestId("process-item");
    const center = screen.getByTestId("process-center");
    expect(item).toHaveClass("pq-card--review");
    expect(item).not.toHaveClass("pq-card--extract");
    expect(center).toHaveClass("pq-center--review");

    // The card face is the bordered .pq-rc box with a pinned header + a scrolling body.
    const face = screen.getByTestId("process-card-face");
    expect(face).toHaveClass("pq-rc");
    expect(face.querySelector(".pq-rc__head")).not.toBeNull();
    expect(face.querySelector(".pq-rc__body")).not.toBeNull();
    // Pre-reveal: no pinned footer (grades stay absent so they can't leak the answer).
    expect(face.querySelector(".pq-rc__foot")).toBeNull();
    expect(screen.queryByTestId("process-card-grades")).toBeNull();

    // Reveal → the pinned grade footer + the single compact recall readout appear, while the
    // FSRS triple-stat box and the "Open in review" link stay GONE (de-duplicated; the inspector
    // owns the full readout, the action bar owns "Open in full").
    fireEvent.click(screen.getByTestId("process-card-reveal"));
    await screen.findByTestId("process-card-answer");
    expect(face.querySelector(".pq-rc__foot")).not.toBeNull();
    expect(screen.getByTestId("process-card-grades")).toBeInTheDocument();
    expect(screen.getByTestId("process-card-recall")).toBeInTheDocument();
    expect(screen.queryByTestId("process-card-review")).toBeNull();
    expect(screen.queryByTestId("fsrs-stats")).toBeNull();
  });

  it("renders the compact recall readout with the card's real FSRS values + provenance crumb", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    await screen.findByTestId("process-card-prompt", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByTestId("process-card-reveal"));
    const recall = await screen.findByTestId("process-card-recall", undefined, { timeout: 3000 });
    // The de-duplicated readout must show the card's ACTUAL FSRS values (stability 9.4d,
    // difficulty 5.1/10, retrievability 82%), not merely exist.
    expect(recall).toHaveTextContent("9.4d stability");
    expect(recall).toHaveTextContent("5.1/10 difficulty");
    expect(recall).toHaveTextContent("82% retrievability");
    // The prompt lives inside the scrolling body (the scroll-containment contract), and the
    // header carries the provenance crumb derived from the card's source location.
    const face = screen.getByTestId("process-card-face");
    expect(face.querySelector(".pq-rc__body")).toContainElement(
      screen.getByTestId("process-card-prompt"),
    );
    expect(face.querySelector(".pq-rc__crumb")).toHaveTextContent("from extract · ¶ 4");
  });

  it("shows an em-dash for retrievability when the card is new (null retrievability)", async () => {
    h.reviewCard.mockResolvedValueOnce({
      card: {
        ...h.cardView,
        schedulerSignals: { ...h.cardView.schedulerSignals, retrievability: null },
      },
    });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    fireEvent.click(screen.getByTestId("process-card-reveal"));
    const recall = await screen.findByTestId("process-card-recall");
    expect(recall).toHaveTextContent("— retrievability");
  });

  it("surfaces the leech badge in the card header for a leech card", async () => {
    h.reviewCard.mockResolvedValueOnce({ card: { ...h.cardView, leech: true, lapses: 5 } });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // The leech badge rides the header sub-row — it appears once the card view loads, no reveal.
    const leech = await screen.findByTestId("process-card-leech");
    expect(leech).toHaveTextContent("5 lapses");
  });

  it("omits the Source section for a source-less card", async () => {
    h.reviewCard.mockResolvedValueOnce({ card: { ...h.cardView, sourceRef: null } });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    fireEvent.click(screen.getByTestId("process-card-reveal"));
    const answer = await screen.findByTestId("process-card-answer");
    expect(screen.queryByTestId("process-card-refblock")).toBeNull();
    // No "Source" eyebrow when there is nothing to cite.
    expect(answer).not.toHaveTextContent("Source");
  });

  it("omits the provenance crumb when the card has no source location", async () => {
    h.reviewCard.mockResolvedValueOnce({ card: { ...h.cardView, sourceLocationLabel: null } });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    fireEvent.click(screen.getByTestId("process-card-reveal"));
    await screen.findByTestId("process-card-answer"); // the card view is now loaded
    expect(screen.getByTestId("process-card-face").querySelector(".pq-rc__crumb")).toBeNull();
  });

  it("renders a cloze card in the three-zone surface (Cloze label + cloze answer)", async () => {
    h.listQueue.mockResolvedValue({
      ...h.result,
      items: [{ ...h.result.items[0], cardType: "cloze" }, ...h.result.items.slice(1)],
    });
    h.reviewCard.mockResolvedValueOnce({
      card: {
        ...h.cardView,
        kind: "cloze",
        prompt: "Intelligence is {{c1::skill-acquisition efficiency}}",
        cloze: "Intelligence is {{c1::skill-acquisition efficiency}}",
        answer: null,
      },
    });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // The header reflects the cloze kind (not the Q&A default).
    const face = screen.getByTestId("process-card-face");
    expect(face.querySelector(".pq-rc__kind")).toHaveTextContent("Cloze");
    // Reveal → the answer renders via the cloze face (deletion revealed), not CardBody.
    fireEvent.click(screen.getByTestId("process-card-reveal"));
    const answer = await screen.findByTestId("process-card-answer");
    expect(answer).toHaveTextContent("skill-acquisition efficiency");
  });

  it("reveals a card's answer INLINE with the four interval previews (no navigation)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");
    // The full reveal-ready view is fetched by id (the architectural seam closing
    // the original stub) before the answer can show.
    await waitFor(() => expect(h.reviewCard).toHaveBeenCalledWith({ cardId: "card-1" }));

    fireEvent.click(screen.getByTestId("process-card-reveal"));

    // The answer reveals inline (Q&A answer), with the four previews from review.preview.
    const answer = await screen.findByTestId("process-card-answer");
    expect(answer).toHaveTextContent("Skill-acquisition efficiency.");
    await waitFor(() =>
      expect(screen.getByTestId("process-interval-good")).toHaveTextContent("4d"),
    );
    expect(h.reviewPreview).toHaveBeenCalledWith(expect.objectContaining({ cardId: "card-1" }));
    // No detour to /review — still on the loop.
    expect(h.navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("route-process")).toBeInTheDocument();
  });

  it("does not repeat a duplicate source snippet in the inline card answer", async () => {
    const duplicateCard: ReviewCardView = {
      ...h.cardView,
      answer:
        "p - by focusing on admiration, i.e., the way we fawn over people we respect. Admiration evolved to help us curry favor with actual or potential teammates.",
      sourceRef: {
        sourceElementId: "src-2",
        sourceTitle: "Social Status II: Cults and Loyalty",
        url: "https://meltingasphalt.com/social-status-ii-cults-and-loyalty/",
        author: "Kevin Simler",
        publishedAt: null,
        locationLabel: "¶1",
        snippet:
          "p - by focusing on admiration, i.e., the way we fawn over people we respect. Admiration evolved to help us curry favor with actual or potential teammates.",
        sourceType: null,
        reliabilityTier: null,
        confidence: null,
        reliabilityNotes: null,
      },
      sourceTitle: "Social Status II: Cults and Loyalty",
      sourceLocationLabel: "¶1",
    };
    h.reviewCard.mockResolvedValueOnce({ card: duplicateCard });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    await screen.findByTestId("process-card-prompt", undefined, { timeout: 3000 });

    fireEvent.click(screen.getByTestId("process-card-reveal"));

    const answer = await screen.findByTestId("process-card-answer", undefined, { timeout: 3000 });
    expect(answer).toHaveTextContent(/focusing on admiration/i);
    await screen.findByTestId("process-card-refblock");
    expect(screen.queryByTestId("process-card-refblock-quote")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-card-refblock-citation")).toHaveTextContent("Kevin Simler");
  });

  it("grades a revealed card via review.grade with prompt/response timings and advances the cursor", async () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      render(<ProcessQueue />);
      await screen.findByTestId("process-item");
      expect(currentItemId()).toBe("card-1");
      await waitFor(() => expect(h.reviewCard).toHaveBeenCalledWith({ cardId: "card-1" }));

      now = 14_200;
      fireEvent.click(screen.getByTestId("process-card-reveal"));
      await screen.findByTestId("process-card-answer");

      now = 15_450;
      fireEvent.click(screen.getByTestId("process-grade-good"));

      await waitFor(() => expect(h.reviewGrade).toHaveBeenCalledTimes(1));
      expect(h.reviewGrade).toHaveBeenCalledWith({
        cardId: "card-1",
        rating: "good",
        promptMs: 4200,
        responseMs: 1250,
      });
      // The grade does NOT go through the attention queue.act path (FSRS only).
      expect(h.actOnQueueItem).not.toHaveBeenCalled();
      // The cursor advanced to the next item; no detour to /review.
      await waitFor(() => expect(currentItemId()).not.toBe("card-1"));
      expect(h.navigateSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does NOT offer the attention ScheduleMenu on a card (FSRS only)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");
    expect(screen.queryByTestId("schedule-menu")).toBeNull();
  });

  it("renders a source as an inline reading workbench", async () => {
    render(<ProcessQueue />);
    await moveToSource();

    expect(screen.getByTestId("process-center")).toHaveClass("pq-center--source");
    expect(screen.getByTestId("process-item")).toHaveClass("pq-card--workbench");
    expect(screen.getByTestId("process-item")).toHaveClass("pq-card--source");
    expect(screen.getByTestId("process-item")).not.toHaveClass("pq-card--extract");
    expect(screen.getByTestId("process-source-workbench")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "The Bitter Lesson" })).toHaveLength(1);
    expect(screen.getByTestId("process-source-header")).toContainElement(
      screen.getByTestId("process-source-title"),
    );
    expect(screen.getByTestId("process-source-header")).toContainElement(
      screen.getByTestId("process-source-readpoint"),
    );
    // The duplicated metadata row is gone (the Inspector owns identity); the
    // reading-position caption now lives in the rail, not the header.
    expect(screen.getByTestId("process-source-rail")).toContainElement(
      screen.getByTestId("process-source-progress"),
    );
    expect(screen.getByTestId("process-source-rail")).toContainElement(
      screen.getByTestId("process-source-words"),
    );
    expect(screen.getByTestId("process-source-rail")).toHaveTextContent("block 1 of 4");
    expect(screen.getByTestId("process-source-rail")).toHaveTextContent("3 words");
    expect(screen.getByTestId("process-source-header")).not.toHaveTextContent("block 1 of 4");
    expect(screen.getByTestId("process-item")).toContainElement(
      screen.getByTestId("process-session-controls"),
    );
    expect(screen.getByTestId("process-source-rail")).toContainElement(
      screen.getByTestId("process-source-pbar"),
    );
    expect(screen.getByTestId("process-source-pbar-fill")).toHaveStyle({ width: "25%" });
    expect(screen.getByTestId("process-source-readpoint")).toBeInTheDocument();
    expect(screen.queryByTestId("process-source-extract")).not.toBeInTheDocument();
    expect(screen.queryByText("Extract selection")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Select text to extract, highlight, or copy."),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-source-editor")).toBeInTheDocument();
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("uses the inspector title for the workbench heading without duplicating identity chips", async () => {
    // The workbench no longer renders author / URL / status / priority — the
    // right-hand Inspector SOURCE column is the single owner of that identity.
    // (URL http/https guarding is covered by ExternalUrlLink + Inspector tests.)
    h.getInspectorData.mockImplementation(async ({ id }: { id: string }) => ({
      data:
        id === "source-1"
          ? {
              element: {
                id: "source-1",
                type: "source",
                status: "scheduled",
                stage: "raw_source",
                priority: 0.875,
                title: "Inspector source title",
                dueAt: "2026-06-02T12:00:00.000Z",
              },
              scheduler: {
                kind: "attention",
                retrievability: null,
                stability: null,
                difficulty: null,
                reps: null,
                lapses: null,
                fsrsState: null,
                stage: "raw_source",
                postponed: 1,
                lastProcessedAt: "2026-06-01T12:00:00.000Z",
              },
              provenance: {
                title: "Inspector source title",
                url: "https://example.com/source/path",
                canonicalUrl: null,
                originalUrl: null,
                author: "Source Author",
                publishedAt: null,
                accessedAt: null,
                snapshotKey: null,
              },
              source: null,
              sourceRef: null,
              location: null,
              children: [],
            }
          : null,
    }));
    render(<ProcessQueue />);
    await moveToSource();

    expect(await screen.findByRole("heading", { name: "Inspector source title" })).toBeVisible();
    // Identity that used to be duplicated in the metadata row is no longer here.
    expect(screen.queryByTestId("process-source-url")).not.toBeInTheDocument();
    expect(screen.queryByText("Source Author")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-source-header")).not.toHaveTextContent("Scheduled");
  });

  it.each([
    "pdf",
    "video",
  ] as const)("keeps specialized %s sources out of the inline text reader while preserving header context", async (sourceFormat) => {
    h.getDocument.mockResolvedValue({
      document: {
        prosemirrorJson: { type: "doc", content: [], mockPlainText: "Specialized body text." },
        plainText: "Specialized body text.",
      },
      extractedBlockIds: [],
      sourceFormat,
    });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    fireEvent.click(screen.getByTestId("process-action-skip"));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));

    expect(await screen.findByTestId("process-source-workbench")).toBeInTheDocument();
    expect(screen.getByTestId("process-source-title")).toHaveTextContent("The Bitter Lesson");
    expect(screen.queryByTestId("process-source-progress")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-source-words")).not.toBeInTheDocument();
    expect(screen.getByText(/specialized reader/i)).toBeInTheDocument();
    expect(screen.queryByTestId("process-source-rail")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-source-editor")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-source-readpoint")).not.toBeInTheDocument();
  });

  it("persists source edits through the document save path", async () => {
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.change(screen.getByTestId("mock-source-editor"), {
      target: { value: "Edited source body." },
    });

    await waitFor(
      () =>
        expect(h.saveDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            elementId: "source-1",
            plainText: "Edited source body.",
          }),
        ),
      { timeout: 1200 },
    );
    expect(h.rewriteExtract).not.toHaveBeenCalled();
  });

  it("sets a source read-point inline without advancing the process cursor", async () => {
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-source-readpoint"));

    await waitFor(() => expect(h.readPointState.setFromSelection).toHaveBeenCalledTimes(1));
    expect(currentItemId()).toBe("source-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("shows source-specific selection actions inside the inline source workbench", async () => {
    h.selectionLocation.current = {
      selectedText: "source passage",
      blockIds: ["blk_source"],
      startOffset: 3,
      endOffset: 17,
    };
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToSource();

    await screen.findByTestId("selection-toolbar");
    expect(screen.getByTestId("sel-tool-extract")).toHaveTextContent("Extract");
    expect(screen.getByTestId("sel-tool-highlight")).toHaveTextContent("Highlight");
    expect(screen.getByTestId("sel-tool-copy")).toHaveTextContent("Copy");
    expect(screen.queryByTestId("sel-tool-cloze")).not.toBeInTheDocument();
  });

  it("creates an extract from selected source text without advancing the process cursor", async () => {
    h.selectionLocation.current = {
      selectedText: "source passage",
      blockIds: ["blk_source"],
      startOffset: 3,
      endOffset: 17,
    };
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(await screen.findByTestId("sel-tool-extract"));

    await waitFor(() =>
      expect(h.createExtraction).toHaveBeenCalledWith({
        sourceElementId: "source-1",
        selectedText: "source passage",
        blockIds: ["blk_source"],
        startOffset: 3,
        endOffset: 17,
      }),
    );
    expect(h.readPointState.markReadThrough).toHaveBeenCalled();
    expect(currentItemId()).toBe("source-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(h.navigateSpy).not.toHaveBeenCalled();
    expect(h.dismissSelection).toHaveBeenCalled();
  });

  it("offers convert-now from process queue when a source extraction is born atomic", async () => {
    h.createExtraction.mockResolvedValueOnce({
      extract: {
        id: "atomic-process-extract",
        type: "extract",
        status: "scheduled",
        stage: "atomic_statement",
        priority: 0.625,
        title: "Atomic queue fact",
        dueAt: "2026-06-10T00:00:00.000Z",
        parentId: "source-1",
        sourceId: "source-1",
      },
      location: {
        id: "loc-atomic-process-extract",
        sourceElementId: "source-1",
        blockIds: ["blk_source"],
        startOffset: 3,
        endOffset: 17,
        label: "¶1",
        selectedText: "source passage",
      },
    });
    h.selectionLocation.current = {
      selectedText: "source passage",
      blockIds: ["blk_source"],
      startOffset: 3,
      endOffset: 17,
    };
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(await screen.findByTestId("sel-tool-extract"));
    fireEvent.click(await screen.findByTestId("atomic-extract-convert-now"));

    expect(h.navigateSpy).toHaveBeenCalledWith({
      to: "/extract/$id",
      params: { id: "atomic-process-extract" },
      search: { cardBuilder: "qa" },
    });
  });

  it("highlights selected source text without advancing the process cursor", async () => {
    const location = {
      selectedText: "source passage",
      blockIds: ["blk_source"],
      startOffset: 3,
      endOffset: 17,
    };
    h.selectionLocation.current = location;
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(await screen.findByTestId("sel-tool-highlight"));

    await waitFor(() => expect(h.highlightsState.add).toHaveBeenCalledWith(location));
    expect(currentItemId()).toBe("source-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(h.navigateSpy).not.toHaveBeenCalled();
    expect(h.dismissSelection).toHaveBeenCalled();
  });

  it("renders an extract as an inline distillation workbench", async () => {
    render(<ProcessQueue />);
    await moveToExtract();

    expect(screen.getByTestId("process-extract-workbench")).toBeInTheDocument();
    expect(screen.getByTestId("process-extract-stage-stepper")).toBeInTheDocument();
    expect(screen.getByTestId("mock-source-editor")).toBeInTheDocument();
    expect(screen.queryByTestId("process-extract-save")).not.toBeInTheDocument();
    expect(screen.queryByTestId("process-extract-subextract")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-extract-make-qa")).toBeInTheDocument();
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("sets extract fates inline without advancing the process cursor", async () => {
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.click(screen.getByTestId("process-extract-fate-reference"));
    await waitFor(() =>
      expect(h.setExtractFate).toHaveBeenCalledWith({ id: "extract-1", fate: "reference" }),
    );
    expect(currentItemId()).toBe("extract-1");

    fireEvent.click(screen.getByTestId("process-extract-fate-done-without-card"));
    await waitFor(() =>
      expect(h.setExtractFate).toHaveBeenCalledWith({
        id: "extract-1",
        fate: "done_without_card",
      }),
    );
    expect(currentItemId()).toBe("extract-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
  });

  it("keeps the process extract body scroll-contained above normal-flow footer controls", async () => {
    render(<ProcessQueue />);
    await moveToExtract();

    expect(screen.getByTestId("process-item")).toContainElement(
      screen.getByTestId("process-session-controls"),
    );
    expect(screen.getByTestId("process-center")).toHaveClass("pq-center--extract");
    expect(screen.getByTestId("process-item")).toHaveClass("pq-card--workbench");
    expect(screen.getByTestId("process-item")).toHaveClass("pq-card--extract");

    const editor = screen.getByTestId("process-extract-editor");
    const reader = editor.querySelector(".reader");
    const meta = editor.querySelector(".pq-extract__meta");
    const tools = screen.getByTestId("process-extract-tools");
    if (!reader || !meta) throw new Error("process extract editor structure changed");
    expect(reader.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(editor.nextElementSibling).toBe(tools);

    const css = readFileSync(resolve(import.meta.dirname, "process-queue.css"), "utf8");
    expect(cssRule(css, ".pq-center--extract")).toContain("justify-content: flex-start");
    expect(cssRule(css, ".pq-center--extract")).toContain("overflow: hidden");
    expect(cssRule(css, ".pq-card--workbench")).toContain("max-width: 820px");
    expect(cssRule(css, ".pq-card--workbench")).toContain("min-height: 0");
    expect(cssRule(css, ".pq-card--extract")).toContain("box-sizing: border-box");
    expect(cssRule(css, ".pq-card--extract")).toContain("flex: 1 1 0");
    expect(cssRule(css, ".pq-card--extract")).toContain("min-height: 0");
    expect(cssRule(css, ".pq-card--extract")).toContain("height: auto");
    expect(cssRule(css, ".pq-card--extract")).toContain("max-height: 100%");
    expect(cssRule(css, ".pq-card--extract")).toContain("overflow: hidden");
    expect(cssRule(css, ".pq-card--extract .pq-extract")).toContain("flex: 1 1 auto");
    expect(cssRule(css, ".pq-card--extract .pq-extract")).toContain("min-height: 0");
    expect(cssRule(css, ".pq-card--extract .pq-extract")).toContain("overflow: hidden");
    expect(cssRule(css, ".pq-extract__ref")).toContain("flex: 0 1 auto");
    expect(cssRule(css, ".pq-extract__ref")).toContain("max-height: 160px");
    expect(cssRule(css, ".pq-extract__ref")).toContain("overflow-y: auto");
    expect(cssRule(css, ".pq-extract__editor")).toContain("display: flex");
    expect(cssRule(css, ".pq-extract__editor")).toContain("flex-direction: column");
    expect(cssRule(css, ".pq-extract__editor")).toContain("flex: 1 1 auto");
    expect(cssRule(css, ".pq-extract__editor")).toContain("min-height: 0");
    expect(cssRule(css, ".pq-extract__editor")).toContain("max-height: none");
    expect(cssRule(css, ".pq-extract__editor")).toContain("overflow: hidden");
    expect(cssRule(css, ".pq-extract__editor")).not.toContain("46vh");
    expect(cssRule(css, ".pq-extract__editor .reader")).toContain("flex: 1 1 auto");
    expect(cssRule(css, ".pq-extract__editor .reader")).toContain("min-height: 0");
    expect(cssRule(css, ".pq-extract__editor .reader")).toContain("max-height: none");
    expect(cssRule(css, ".pq-extract__editor .reader")).toContain("overflow-y: auto");
    expect(cssRule(css, ".pq-extract__editor .reader")).toContain("padding-bottom: var(--s-4)");
    expect(cssRule(css, ".pq-extract__meta")).toContain("flex: 0 0 auto");
    expect(cssRule(css, ".pq-extract__tools")).toContain("flex: 0 0 auto");
    expect(cssRule(css, ".pq-card--extract .pq-actions")).toContain("flex: none");
  });

  it("does not repeat the source quote when it duplicates the inline extract body", async () => {
    h.getInspectorData.mockImplementation(async ({ id }: { id: string }) => ({
      data:
        id === "extract-1"
          ? {
              element: {
                id: "extract-1",
                type: "extract",
                status: "scheduled",
                stage: "clean_extract",
                priority: 0.625,
                title: "skill-acquisition efficiency",
                dueAt: "2026-05-31T06:00:00.000Z",
              },
              scheduler: { stage: "clean_extract" },
              source: { id: "source-1", type: "source", title: "On the Measure of Intelligence" },
              sourceRef: {
                sourceElementId: "source-1",
                sourceTitle: "On the Measure of Intelligence",
                url: null,
                author: "François Chollet",
                publishedAt: null,
                locationLabel: "¶1",
                snippet: "Body preview text.",
                sourceType: null,
                reliabilityTier: null,
                confidence: null,
                reliabilityNotes: null,
              },
              location: {
                sourceElementId: "source-1",
                blockIds: ["blk_process_extract"],
                startOffset: 0,
                endOffset: 18,
                selectedText: "Body preview text.",
                label: "¶1",
                page: null,
              },
              provenance: null,
              children: [],
            }
          : null,
    }));
    render(<ProcessQueue />);
    await moveToExtract();

    await screen.findByTestId("process-extract-refblock");
    expect(screen.queryByTestId("process-extract-refblock-quote")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-extract-refblock-citation")).toHaveTextContent(
      "François Chollet",
    );
  });

  it("shows extract-specific selection actions inside the inline workbench", async () => {
    h.selectionLocation.current = {
      selectedText: "skill-acquisition efficiency",
      blockIds: ["blk_process_extract"],
      startOffset: 0,
      endOffset: 28,
    };
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToExtract();

    await screen.findByTestId("selection-toolbar");
    expect(screen.getByTestId("sel-tool-extract")).toHaveTextContent("Sub-extract");
    expect(screen.getByTestId("sel-tool-cloze")).toHaveTextContent("Cloze");
    expect(screen.getByTestId("sel-tool-highlight")).toHaveTextContent("Highlight");
    expect(screen.getByTestId("sel-tool-copy")).toHaveTextContent("Copy");
  });

  it("highlights selected extract text without advancing the process cursor", async () => {
    const location = {
      selectedText: "skill-acquisition efficiency",
      blockIds: ["blk_process_extract"],
      startOffset: 0,
      endOffset: 28,
    };
    h.selectionLocation.current = location;
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.click(await screen.findByTestId("sel-tool-highlight"));

    await waitFor(() => expect(h.highlightsState.add).toHaveBeenCalledWith(location));
    expect(currentItemId()).toBe("extract-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(h.navigateSpy).not.toHaveBeenCalled();
    expect(h.dismissSelection).toHaveBeenCalled();
  });

  it("highlights selected extract text from the H keyboard shortcut", async () => {
    const location = {
      selectedText: "skill-acquisition efficiency",
      blockIds: ["blk_process_extract"],
      startOffset: 0,
      endOffset: 28,
    };
    h.selectionLocation.current = location;
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToExtract();
    await screen.findByTestId("selection-toolbar");

    fireEvent.keyDown(window, { key: "h" });

    await waitFor(() => expect(h.highlightsState.add).toHaveBeenCalledWith(location));
    expect(currentItemId()).toBe("extract-1");
  });

  it("creates a sub-extract from selected text without advancing the process cursor", async () => {
    h.selectionLocation.current = {
      selectedText: "skill-acquisition efficiency",
      blockIds: ["blk_process_extract"],
      startOffset: 0,
      endOffset: 28,
    };
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.click(await screen.findByTestId("sel-tool-extract"));

    await waitFor(() =>
      expect(h.createExtraction).toHaveBeenCalledWith({
        sourceElementId: "source-1",
        parentId: "extract-1",
        selectedText: "skill-acquisition efficiency",
        blockIds: ["blk_process_extract"],
        startOffset: 0,
        endOffset: 28,
      }),
    );
    expect(currentItemId()).toBe("extract-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(h.navigateSpy).not.toHaveBeenCalled();
    expect(h.dismissSelection).toHaveBeenCalled();
  });

  it("opens the cloze builder from selected text with the deletion pre-wrapped", async () => {
    h.selectionLocation.current = {
      selectedText: "skill-acquisition efficiency",
      blockIds: ["blk_process_extract"],
      startOffset: 0,
      endOffset: 28,
    };
    h.selectionPosition.current = { top: 120, left: 240 };
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.click(await screen.findByTestId("sel-tool-cloze"));

    await screen.findByTestId("process-extract-builder");
    expect(screen.getByTestId("cb-tab-cloze")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("cb-cloze-text")).toHaveValue("{{c1::skill-acquisition efficiency}}");
    expect(currentItemId()).toBe("extract-1");
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("advances an extract stage inline without leaving /process", async () => {
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.click(screen.getByTestId("process-extract-advance"));

    await waitFor(() => expect(h.updateExtractStage).toHaveBeenCalledWith({ id: "extract-1" }));
    await waitFor(() =>
      expect(screen.getByTestId("process-extract-stage-atomic_statement")).toHaveAttribute(
        "data-active",
        "true",
      ),
    );
    expect(currentItemId()).toBe("extract-1");
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("sets an explicit extract stage inline without queue-acting or navigating", async () => {
    h.updateExtractStage.mockResolvedValueOnce(stageMutation("raw_extract"));
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.click(screen.getByTestId("process-extract-stage-raw_extract"));

    await waitFor(() =>
      expect(h.updateExtractStage).toHaveBeenCalledWith({
        id: "extract-1",
        stage: "raw_extract",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("process-extract-stage-raw_extract")).toHaveAttribute(
        "data-active",
        "true",
      ),
    );
    expect(currentItemId()).toBe("extract-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("autosaves an edited extract body through the document save path", async () => {
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.change(screen.getByTestId("mock-source-editor"), {
      target: { value: "Edited extract body." },
    });

    await waitFor(
      () =>
        expect(h.saveDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            elementId: "extract-1",
            plainText: "Edited extract body.",
            blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "blk_process_extract" }],
          }),
        ),
      { timeout: 1200 },
    );
    expect(h.rewriteExtract).not.toHaveBeenCalled();
    expect(currentItemId()).toBe("extract-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
  });

  it("trims an extract body through the same rewrite path without advancing the queue", async () => {
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.change(screen.getByTestId("mock-source-editor"), {
      target: { value: "  Messy    extract  \n\n\n second   line  " },
    });
    fireEvent.click(screen.getByTestId("process-extract-trim"));

    await waitFor(() =>
      expect(h.rewriteExtract).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "extract-1",
          plainText: "Messy extract\n\nsecond line",
        }),
      ),
    );
    expect(currentItemId()).toBe("extract-1");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
  });

  it("trims the visible editor text when editor JSON lags behind the DOM", async () => {
    h.staleEditorJson = true;
    render(<ProcessQueue />);
    await moveToExtract();

    const editor = screen.getByTestId("mock-source-editor").querySelector(".ProseMirror");
    if (!editor) throw new Error("mock ProseMirror surface not found");
    editor.textContent = "Visible edited extract body.";
    fireEvent.input(editor);
    fireEvent.click(screen.getByTestId("process-extract-trim"));

    await waitFor(() =>
      expect(h.rewriteExtract).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "extract-1",
          plainText: "Visible edited extract body.",
        }),
      ),
    );
  });

  it("opens the existing card builder inline and creates a Q&A card from the extract", async () => {
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.click(screen.getByTestId("process-extract-make-qa"));
    await screen.findByTestId("process-extract-builder");
    expect(screen.getByTestId("cb-quality-summary")).toHaveAttribute("data-severity", "block");
    expect(screen.getByTestId("cb-qc-empty")).toHaveAttribute("data-severity", "block");
    expect(screen.queryByTestId("cb-quality-passed")).toBeNull();

    fireEvent.change(screen.getByTestId("cb-qa-front"), {
      target: { value: "What is skill-acquisition efficiency?" },
    });
    fireEvent.click(screen.getByTestId("cb-create"));

    await waitFor(() =>
      expect(h.createCard).toHaveBeenCalledWith(
        expect.objectContaining({
          extractId: "extract-1",
          kind: "qa",
          prompt: "What is skill-acquisition efficiency?",
          answer: "Body preview text.",
        }),
      ),
    );
    expect(currentItemId()).toBe("extract-1");
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("opens the cloze builder inline with the extract body and creates a cloze card", async () => {
    render(<ProcessQueue />);
    await moveToExtract();

    fireEvent.click(screen.getByTestId("process-extract-make-cloze"));
    await screen.findByTestId("process-extract-builder");
    expect(screen.getByTestId("cb-tab-cloze")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("cb-cloze-text")).toHaveValue("Body preview text.");

    fireEvent.change(screen.getByTestId("cb-cloze-text"), {
      target: { value: "{{Body}} preview text." },
    });
    fireEvent.click(screen.getByTestId("cb-create"));

    await waitFor(() =>
      expect(h.createCard).toHaveBeenCalledWith(
        expect.objectContaining({
          extractId: "extract-1",
          kind: "cloze",
          cloze: "{{c1::Body}} preview text.",
        }),
      ),
    );
    expect(currentItemId()).toBe("extract-1");
    expect(h.navigateSpy).not.toHaveBeenCalled();
  });

  it("opens the current item in full via the open action (the only navigation)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    // Advance past the card to the source item.
    fireEvent.click(screen.getByTestId("process-action-skip"));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    fireEvent.click(screen.getByTestId("process-action-open"));
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "source-1" } });
  });

  it("opens a card-linked task by clearing inspector selection and routing to card detail", async () => {
    const task: QueueItemSummary = {
      id: "task-1",
      type: "task",
      status: "scheduled",
      stage: "rough_topic",
      priority: 0.875,
      title: "Verify claim: What does Chollet define intelligence as?",
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
        needsReverify: false,
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
      linkedSourceId: null,
      protected: true,
      due: "today",
      dueLabel: "Due today",
      queueEligible: true,
      notInQueueReason: null,
      fallowState: null,
      fallowUntil: null,
      fallowReason: null,
      fallowTopicId: null,
      extractAging: null,
    };
    h.listQueue.mockResolvedValueOnce({
      items: [task],
      counts: {
        all: 1,
        card: 0,
        source: 0,
        extract: 0,
        topic: 0,
        task: 1,
        highPriority: 1,
        overdue: 0,
        protected: 1,
      },
      budget: { used: 1, target: 30 },
    });

    render(<ProcessQueue />);
    await waitFor(() => expect(currentItemId()).toBe("task-1"));
    fireEvent.click(screen.getByTestId("process-action-open"));

    expect(h.selectSpy).toHaveBeenCalledWith(null);
    expect(h.navigateSpy).toHaveBeenCalledWith({ to: "/card/$id", params: { id: "card-1" } });
  });

  it("keeps a mode-reload loading panel centered even when the stale cursor is an extract", async () => {
    render(<ProcessQueue />);
    await moveToExtract();
    expect(screen.getByTestId("process-center")).toHaveClass("pq-center--extract");

    let resolveQueue!: (result: QueueListResult) => void;
    h.listQueue.mockReturnValueOnce(
      new Promise<QueueListResult>((resolve) => {
        resolveQueue = resolve;
      }),
    );

    fireEvent.click(screen.getByTestId("process-mode-review"));

    expect(await screen.findByTestId("process-loading")).toHaveTextContent("Loading due queue");
    expect(screen.getByTestId("process-center")).toHaveClass("pq-center");
    expect(screen.getByTestId("process-center")).not.toHaveClass("pq-center--extract");

    resolveQueue(h.result);
    await waitFor(() => expect(screen.queryByTestId("process-loading")).not.toBeInTheDocument());
  });

  it("T076: requests queue.list with mode `full` on mount", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(h.listQueue).toHaveBeenCalledWith(expect.objectContaining({ mode: "full" }));
  });

  it("T076: switching the SessionMode re-requests queue.list with the new mode (soft re-order, not a slice)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    h.listQueue.mockClear();

    fireEvent.click(screen.getByTestId("process-mode-review"));
    // The mode flows to the read as a soft ordering bias — a deliberate re-fetch.
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(expect.objectContaining({ mode: "review" })),
    );

    fireEvent.click(screen.getByTestId("process-mode-read"));
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(expect.objectContaining({ mode: "read" })),
    );
  });

  it("T118: assembled mode consumes the accepted deck without re-reading queue.list", async () => {
    h.search = { assembled: 1 };
    const sourceItem = h.result.items.find((item) => item.id === "source-1");
    if (!sourceItem) throw new Error("Missing source fixture");
    acceptTestAssembly([{ item: sourceItem, estimatedMinutes: 10 }], {
      totalCount: 1,
      totalMinutes: 2,
    });

    render(<ProcessQueue />);

    await screen.findByTestId("process-item");
    expect(h.listQueue).not.toHaveBeenCalled();
    expect(screen.queryByTestId("process-modes")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-assembled-mode")).toHaveTextContent("Planned deck");
  });

  it("T118: queue refresh does not restart an active assembled deck", async () => {
    h.search = { assembled: 1 };
    const card = h.result.items.find((item) => item.id === "card-1");
    const extract = h.result.items.find((item) => item.id === "extract-1");
    if (!card || !extract) throw new Error("Missing assembled fixtures");
    acceptTestAssembly([
      { item: card, estimatedMinutes: 2 },
      { item: extract, estimatedMinutes: 6 },
    ]);

    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));

    h.getDailyWorkSummary.mockClear();
    requestQueueRefresh();

    await waitFor(() => expect(h.getDailyWorkSummary).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("process-progress")).toHaveTextContent("2 / 2");
    expect(currentItemId()).toBe("extract-1");
    expect(h.listQueue).not.toHaveBeenCalled();
  });

  it("T118: daily-work read failure does not invalidate the assembled deck", async () => {
    h.search = { assembled: 1 };
    const extract = h.result.items.find((item) => item.id === "extract-1");
    if (!extract) throw new Error("Missing extract fixture");
    h.getDailyWorkSummary.mockRejectedValueOnce(new Error("daily failed"));
    acceptTestAssembly([{ item: extract, estimatedMinutes: 6 }]);

    render(<ProcessQueue />);

    await screen.findByTestId("process-item");
    fireEvent.click(screen.getByTestId("process-action-markDone"));

    expect(await screen.findByTestId("process-session-summary")).toHaveTextContent(
      "Completed 6 min",
    );
  });

  it("T118: undo subtracts completed minutes before a repeated assembled action", async () => {
    h.search = { assembled: 1 };
    const card = h.result.items.find((item) => item.id === "card-1");
    const extract = h.result.items.find((item) => item.id === "extract-1");
    if (!card || !extract) throw new Error("Missing assembled fixtures");
    acceptTestAssembly([
      { item: card, estimatedMinutes: 2 },
      { item: extract, estimatedMinutes: 6 },
    ]);

    render(<ProcessQueue />);
    await screen.findByTestId("process-item");

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(currentItemId()).toBe("card-1"));
    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    fireEvent.click(screen.getByTestId("process-action-markDone"));

    expect(await screen.findByTestId("process-session-summary")).toHaveTextContent(
      "Completed 8 min",
    );
  });

  it("T118: lineage branch-delete undo restores assembled cursor and minutes", async () => {
    h.search = { assembled: 1 };
    const card = h.result.items.find((item) => item.id === "card-1");
    const extract = h.result.items.find((item) => item.id === "extract-1");
    if (!card || !extract) throw new Error("Missing assembled fixtures");
    h.countDescendants.mockResolvedValueOnce({
      extracts: 0,
      cards: 1,
      cardsWithHistory: 0,
      total: 1,
    });
    h.softDeleteSubtree.mockResolvedValueOnce({
      batchId: "branch-1",
      affected: ["extract-1"],
      skipped: [],
    });
    acceptTestAssembly([
      { item: extract, estimatedMinutes: 6 },
      { item: card, estimatedMinutes: 2 },
    ]);

    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("extract-1");

    fireEvent.click(screen.getByTestId("process-action-delete"));
    fireEvent.click(await screen.findByTestId("lineage-delete-branch"));
    await waitFor(() => expect(currentItemId()).toBe("card-1"));

    const snackbar = await screen.findByTestId("process-delete-snackbar");
    fireEvent.click(within(snackbar).getByRole("button", { name: /undo/i }));

    await waitFor(() =>
      expect(h.restoreBatchFromTrash).toHaveBeenCalledWith({ batchId: "branch-1" }),
    );
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 2");

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() => expect(currentItemId()).toBe("card-1"));
    fireEvent.click(screen.getByTestId("process-action-markDone"));

    expect(await screen.findByTestId("process-session-summary")).toHaveTextContent(
      "Completed 8 min",
    );
  });

  it("T118: assembled mode recovers when the accepted plan state is missing", async () => {
    h.search = { assembled: 1 };

    render(<ProcessQueue />);

    expect(await screen.findByTestId("process-session-expired")).toHaveTextContent(
      "Session plan expired",
    );
    expect(h.listQueue).not.toHaveBeenCalled();
  });

  it("T076: the 'N left' counter reflects the FULL mixed deck, not a type-filtered slice", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-progress");
    // The seeded mock returns a card + a source + an extract (3 mixed items): the deck
    // total is 3 and "N left" counts the full mixed remainder.
    expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3");
    expect(screen.getByTestId("process-progress")).toHaveTextContent("3 left");

    // Switching to review mode keeps the FULL deck (cards AND reading items) — the
    // old `modeIncludes` hard filter is gone, so the total never drops to a 1-card slice.
    fireEvent.click(screen.getByTestId("process-mode-review"));
    await waitFor(() =>
      expect(h.listQueue).toHaveBeenCalledWith(expect.objectContaining({ mode: "review" })),
    );
    await waitFor(() => expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3"));
    expect(screen.getByTestId("process-progress")).toHaveTextContent("3 left");
  });
});
