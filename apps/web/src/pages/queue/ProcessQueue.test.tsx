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
 *    `review.grade` the review session uses (with a plausible responseMs + rating)
 *    then advances the cursor — NO detour to /review.
 *
 * Collaborators are mocked so the test exercises ONLY this component's wiring:
 * `window.appApi.queue.list` returns a fixed payload, `queue.act` / `review.*` are
 * spies, and the router + selection seams are stubbed. No SQLite/IPC — the renderer
 * is a pure UI consumer.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QueueItemSummary,
  QueueListResult,
  ReviewCardView,
  ReviewIntervalPreview,
  ReviewRating,
} from "../../lib/appApi";

const h = vi.hoisted(() => {
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
    },
    sourceTitle: "On the Measure of Intelligence",
    author: "François Chollet",
    concept: null,
    siblingGroupId: null,
    sourceId: null,
    cardType: null,
    linkedElementId: null,
    linkedElementType: null,
    protected: false,
    due: "today",
    dueLabel: "Due today",
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
    navigateSpy: vi.fn(),
    selectSpy: vi.fn(),
    listQueue: vi.fn().mockResolvedValue(result),
    actOnQueueItem: vi.fn().mockResolvedValue({ item: null, removed: true, undo: null }),
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
        sourceId: "source-1",
        parentId: null,
      },
      plainText: "Edited extract body.",
    }),
    siblingCardAnswers: vi.fn().mockResolvedValue({ cards: [] }),
    createExtraction: vi.fn().mockResolvedValue({
      extract: { id: "subextract-1", parentId: "extract-1", sourceId: "source-1" },
      location: { sourceElementId: "extract-1" },
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
      scheduleQueueItem: h.scheduleQueueItem,
      undoQueueAction: h.undoQueueAction,
      undoLast: h.undoLast,
      getDocument: h.getDocument,
      saveDocument: h.saveDocument,
      getInspectorData: h.getInspectorData,
      updateExtractStage: h.updateExtractStage,
      rewriteExtract: h.rewriteExtract,
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
          <div data-testid="mock-source-editor">
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
  useSearch: () => ({}),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.selectSpy }),
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

beforeEach(() => {
  vi.clearAllMocks();
  h.actOnQueueItem.mockResolvedValue({ item: null, removed: true, undo: null });
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
  h.getInspectorData.mockResolvedValue({ data: null });
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
      sourceId: "source-1",
      parentId: null,
    },
  };
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
  it("renders exactly ONE element at a time (the cursor item)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(screen.getAllByTestId("process-item")).toHaveLength(1);
  });

  it("shows the progress readout (N / total)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-progress");
    expect(screen.getByTestId("process-progress")).toHaveTextContent("1 / 3");
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

  it("keeps command-log undo after postponing and restores the process cursor", async () => {
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("process-action-postpone"));

    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();

    fireEvent.keyDown(window, { key: "z", metaKey: true });

    await waitFor(() => expect(h.undoLast).toHaveBeenCalledTimes(1));
    expect(h.undoQueueAction).not.toHaveBeenCalled();
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    expect(screen.getByTestId("process-progress")).toHaveTextContent("2 / 3");
  });

  it("keeps command-log undo after explicit scheduling and restores the process cursor", async () => {
    render(<ProcessQueue />);
    await moveToSource();

    fireEvent.click(screen.getByTestId("schedule-menu-trigger"));
    fireEvent.click(await screen.findByTestId("schedule-tomorrow"));

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
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
  });

  it("replaces a pending silent undo with the next process mutation", async () => {
    h.actOnQueueItem
      .mockResolvedValueOnce({
        item: null,
        removed: true,
        undo: { kind: "status", previousStatus: "scheduled" },
      })
      .mockResolvedValueOnce({ item: null, removed: false, undo: null });
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");

    fireEvent.click(screen.getByTestId("process-action-markDone"));
    await waitFor(() => expect(currentItemId()).toBe("source-1"));
    expect(screen.queryByTestId("queue-snackbar")).toBeNull();

    fireEvent.click(screen.getByTestId("process-action-postpone"));
    await waitFor(() => expect(currentItemId()).toBe("extract-1"));
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

    fireEvent.click(screen.getByTestId("process-card-reveal"));

    const answer = await screen.findByTestId("process-card-answer");
    expect(answer).toHaveTextContent(/focusing on admiration/i);
    await screen.findByTestId("process-card-refblock");
    expect(screen.queryByTestId("process-card-refblock-quote")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-card-refblock-citation")).toHaveTextContent("Kevin Simler");
  });

  it("grades a revealed card via review.grade and advances the cursor (no navigation)", async () => {
    render(<ProcessQueue />);
    await screen.findByTestId("process-item");
    expect(currentItemId()).toBe("card-1");
    await waitFor(() => expect(h.reviewCard).toHaveBeenCalledWith({ cardId: "card-1" }));

    fireEvent.click(screen.getByTestId("process-card-reveal"));
    await screen.findByTestId("process-card-answer");

    fireEvent.click(screen.getByTestId("process-grade-good"));

    await waitFor(() => expect(h.reviewGrade).toHaveBeenCalledTimes(1));
    const arg = h.reviewGrade.mock.calls[0]?.[0] as {
      cardId: string;
      rating: string;
      responseMs: number;
    };
    expect(arg.cardId).toBe("card-1");
    expect(arg.rating).toBe("good");
    expect(typeof arg.responseMs).toBe("number");
    expect(arg.responseMs).toBeGreaterThanOrEqual(0);
    // The grade does NOT go through the attention queue.act path (FSRS only).
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    // The cursor advanced to the next item; no detour to /review.
    await waitFor(() => expect(currentItemId()).not.toBe("card-1"));
    expect(h.navigateSpy).not.toHaveBeenCalled();
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

    expect(screen.getByTestId("process-source-workbench")).toBeInTheDocument();
    expect(screen.getByTestId("process-source-progress")).toHaveTextContent("block 1 of 4");
    expect(screen.getByTestId("process-source-readpoint")).toBeInTheDocument();
    expect(screen.getByTestId("process-source-extract")).toBeInTheDocument();
    expect(screen.getByTestId("mock-source-editor")).toBeInTheDocument();
    expect(h.navigateSpy).not.toHaveBeenCalled();
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
    expect(screen.getByTestId("process-extract-subextract")).toBeInTheDocument();
    expect(screen.getByTestId("process-extract-make-qa")).toBeInTheDocument();
    expect(h.navigateSpy).not.toHaveBeenCalled();
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
      },
      sourceTitle: null,
      author: null,
      concept: null,
      siblingGroupId: null,
      sourceId: null,
      cardType: null,
      linkedElementId: "card-1",
      linkedElementType: "card",
      protected: true,
      due: "today",
      dueLabel: "Due today",
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
