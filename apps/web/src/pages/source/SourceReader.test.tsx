import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  routeId: "src-1",
  search: {} as Record<string, unknown>,
  navigate: vi.fn(),
  select: vi.fn(),
  getInspectorData: vi.fn(),
  actOnQueueItem: vi.fn(),
  dismissSourceRetirementSuggestion: vi.fn(),
  scheduleQueueItem: vi.fn(),
  setElementPriority: vi.fn(),
  createExtraction: vi.fn(),
  getBlockProcessingSummary: vi.fn(),
  refreshInspector: vi.fn(),
  editor: {
    state: { selection: { empty: true, from: 1 } },
    commands: { focus: vi.fn() },
  },
  documentState: {
    status: "ready",
    error: null,
    sourceFormat: null as string | null,
    currentDoc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "blk-1" },
          content: [{ type: "text", text: "First block" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "blk-2" },
          content: [{ type: "text", text: "Second block" }],
        },
      ],
    },
    initialDoc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "blk-1" },
          content: [{ type: "text", text: "First block" }],
        },
      ],
    },
    blockPages: { "blk-1": 1, "blk-2": 2 } as Record<string, number>,
    blockTimestamps: {} as Record<string, number>,
    extractedBlockIds: new Set<string>(),
    save: vi.fn(),
    markExtracted: vi.fn(),
  },
  readPointState: {
    status: "ready",
    readPoint: null as { blockId: string; offset: number } | null,
    firstUnreadBlockId: vi.fn(() => "blk-1"),
    progress: vi.fn(() => ({ index: 0, total: 2 })),
    progressFraction: vi.fn(() => 0.5),
    setFromSelection: vi.fn(),
    markReadThrough: vi.fn(),
    isAtOrAfterReadPoint: vi.fn(() => true),
  },
  highlightsState: {
    highlights: [] as unknown[],
    add: vi.fn(),
    remove: vi.fn(),
  },
  processedState: {
    processed: [] as unknown[],
    blocks: [] as unknown[],
    summary: {
      sourceElementId: "src-1",
      totalBlocks: 2,
      processedBlocks: 1,
      terminalBlocks: 1,
      unresolvedBlocks: 1,
      highPriorityUnresolvedBlocks: 1,
      extractedBlockCount: 0,
      extractedOutputCount: 0,
      ignoredBlocks: 0,
      ignoredRatio: 0,
      terminalRatio: 0.5,
      staleAfterEditBlocks: 0,
      legacyProjectedBlocks: 0,
      canMarkDoneWithoutConfirmation: false,
      stateCounts: {
        unread: 1,
        read: 0,
        extracted: 0,
        ignored: 0,
        processed_without_output: 1,
        needs_later: 0,
        stale_after_edit: 0,
      },
    },
    isProcessed: vi.fn(() => false),
    markIdFor: vi.fn(() => null),
    stateFor: vi.fn(() => "unread"),
    mark: vi.fn(),
    restore: vi.fn(),
    toggle: vi.fn(),
    markIgnored: vi.fn(),
    markNeedsLater: vi.fn(),
    reload: vi.fn(),
    error: null as string | null,
  },
  selectionState: {
    position: null as { x: number; y: number } | null,
    location: null as {
      selectedText: string;
      blockIds: string[];
      startOffset: number;
      endOffset: number;
    } | null,
    dismiss: vi.fn(),
  },
}));

vi.mock("@interleave/editor", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    SourceEditor: ({ onEditorReady }: { onEditorReady?: (editor: unknown | null) => void }) => {
      React.useEffect(() => {
        onEditorReady?.(h.editor);
        return () => onEditorReady?.(null);
      }, [onEditorReady]);
      return <div data-testid="mock-source-editor">Editor body</div>;
    },
    jumpToReadPoint: vi.fn(),
    jumpToSource: vi.fn(() => ({ result: { kind: "exact" }, dispose: vi.fn() })),
    readerDecorationsKey: { getState: vi.fn(() => null) },
    setReaderDecorations: vi.fn(),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ id: h.routeId }),
  useSearch: () => h.search,
  useNavigate: () => h.navigate,
}));

vi.mock("../../components/inspector/Inspector", () => ({
  requestInspectorRefresh: () => h.refreshInspector(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      getInspectorData: h.getInspectorData,
      actOnQueueItem: h.actOnQueueItem,
      dismissSourceRetirementSuggestion: h.dismissSourceRetirementSuggestion,
      scheduleQueueItem: h.scheduleQueueItem,
      setElementPriority: h.setElementPriority,
      createExtraction: h.createExtraction,
      getBlockProcessingSummary: h.getBlockProcessingSummary,
    },
  };
});

vi.mock("../../reader/SelectionToolbar", () => ({
  SelectionToolbar: ({
    position,
    onAction,
  }: {
    position: { x: number; y: number } | null;
    onAction: (action: string) => void;
  }) =>
    position ? (
      <div data-testid="mock-selection-toolbar">
        <button
          type="button"
          data-testid="mock-toolbar-extract"
          onClick={() => onAction("extract")}
        >
          Extract
        </button>
        <button
          type="button"
          data-testid="mock-toolbar-highlight"
          onClick={() => onAction("highlight")}
        >
          Highlight
        </button>
        <button type="button" data-testid="mock-toolbar-cloze" onClick={() => onAction("cloze")}>
          Cloze
        </button>
      </div>
    ) : null,
}));

vi.mock("../../reader/useTextSelection", () => ({
  useTextSelection: () => h.selectionState,
}));

vi.mock("../../shell/activeScope", () => ({
  useActiveScope: vi.fn(),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: null, select: h.select }),
}));

vi.mock("./MediaReader", () => ({
  MediaReader: ({ elementId }: { elementId: string }) => (
    <div data-testid="mock-media-reader">Media {elementId}</div>
  ),
}));

vi.mock("./PdfReader", () => ({
  PdfReader: ({
    elementId,
    onActivePageChange,
    onRegionExtracted,
  }: {
    elementId: string;
    onActivePageChange: (page: number, total: number) => void;
    onRegionExtracted: () => void;
  }) => (
    <div data-testid="mock-pdf-reader">
      PDF {elementId}
      <button
        type="button"
        data-testid="mock-pdf-page-change"
        onClick={() => onActivePageChange(2, 4)}
      >
        Page
      </button>
      <button type="button" data-testid="mock-pdf-region" onClick={onRegionExtracted}>
        Region
      </button>
    </div>
  ),
}));

vi.mock("./ProcessedSpanButtons", () => ({
  ProcessedSpanButtons: () => <div data-testid="mock-processed-buttons" />,
}));

vi.mock("./useDocument", () => ({
  useDocument: () => h.documentState,
}));

vi.mock("./useHighlights", () => ({
  useHighlights: () => h.highlightsState,
}));

vi.mock("./useProcessedSpans", () => ({
  useProcessedSpans: () => h.processedState,
}));

vi.mock("./useReadPoint", () => ({
  useReadPoint: () => h.readPointState,
}));

import { SourceReader } from "./SourceReader";

const inspectorData = {
  element: {
    id: "src-1",
    type: "source",
    title: "Reader source",
    priority: 0.875,
    status: "active",
    dueAt: "2026-06-10T00:00:00.000Z",
  },
  provenance: {
    url: "https://example.com/source",
    canonicalUrl: "https://example.com/source",
    author: "Ada",
    publishedAt: null,
    accessedAt: "2026-06-03T00:00:00.000Z",
    reasonAdded: null,
  },
  scheduler: {
    kind: "attention",
    label: "Attention",
    dueAt: "2026-06-10T00:00:00.000Z",
    lastProcessedAt: "2026-06-01T00:00:00.000Z",
    intervalDays: 7,
    retirementSuggestion: null,
  },
};

/**
 * Build a block-processing summary for the DoneIntentMenu's `getSummary` read. Defaults
 * to a partially-processed source with 1 unresolved (`unread`) block — `getSummary` then
 * opens the surface. Pass `canMarkDoneWithoutConfirmation: true` (with zeroed counts) to
 * exercise the 0-unresolved fast path.
 */
function summaryFor(overrides: Record<string, unknown> = {}) {
  return {
    sourceElementId: "src-1",
    totalBlocks: 2,
    processedBlocks: 1,
    terminalBlocks: 1,
    unresolvedBlocks: 1,
    highPriorityUnresolvedBlocks: 1,
    extractedBlockCount: 0,
    extractedOutputCount: 0,
    ignoredBlocks: 0,
    ignoredRatio: 0,
    terminalRatio: 0.5,
    staleAfterEditBlocks: 0,
    legacyProjectedBlocks: 0,
    canMarkDoneWithoutConfirmation: false,
    stateCounts: {
      unread: 1,
      read: 0,
      extracted: 0,
      ignored: 0,
      processed_without_output: 1,
      needs_later: 0,
      stale_after_edit: 0,
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  h.desktop = true;
  h.routeId = "src-1";
  h.search = {};
  h.navigate.mockReset();
  h.select.mockReset();
  h.getInspectorData.mockReset();
  h.actOnQueueItem.mockReset();
  h.dismissSourceRetirementSuggestion.mockReset();
  h.scheduleQueueItem.mockReset();
  h.setElementPriority.mockReset();
  h.createExtraction.mockReset();
  h.getBlockProcessingSummary.mockReset();
  h.refreshInspector.mockReset();
  h.editor.commands.focus.mockReset();
  h.documentState.status = "ready";
  h.documentState.error = null;
  h.documentState.sourceFormat = null;
  h.documentState.blockPages = { "blk-1": 1, "blk-2": 2 };
  h.documentState.blockTimestamps = {};
  h.documentState.extractedBlockIds = new Set();
  h.documentState.save.mockReset();
  h.documentState.markExtracted.mockReset();
  h.readPointState.readPoint = null;
  h.readPointState.firstUnreadBlockId.mockClear();
  h.readPointState.progress.mockReturnValue({ index: 0, total: 2 });
  h.readPointState.progressFraction.mockReturnValue(0.5);
  h.readPointState.setFromSelection.mockReset();
  h.readPointState.setFromSelection.mockResolvedValue({ blockId: "blk-1", offset: 0 });
  h.readPointState.markReadThrough.mockReset();
  h.readPointState.isAtOrAfterReadPoint.mockReturnValue(true);
  h.highlightsState.highlights = [];
  h.highlightsState.add.mockReset();
  h.highlightsState.add.mockResolvedValue(undefined);
  h.highlightsState.remove.mockReset();
  h.processedState.processed = [];
  h.processedState.summary = {
    sourceElementId: "src-1",
    totalBlocks: 2,
    processedBlocks: 1,
    terminalBlocks: 1,
    unresolvedBlocks: 1,
    highPriorityUnresolvedBlocks: 1,
    extractedBlockCount: 0,
    extractedOutputCount: 0,
    ignoredBlocks: 0,
    ignoredRatio: 0,
    terminalRatio: 0.5,
    staleAfterEditBlocks: 0,
    legacyProjectedBlocks: 0,
    canMarkDoneWithoutConfirmation: false,
    stateCounts: {
      unread: 1,
      read: 0,
      extracted: 0,
      ignored: 0,
      processed_without_output: 1,
      needs_later: 0,
      stale_after_edit: 0,
    },
  };
  h.processedState.isProcessed.mockReset();
  h.processedState.isProcessed.mockReturnValue(false);
  h.processedState.markIdFor.mockReset();
  h.processedState.markIdFor.mockReturnValue(null);
  h.processedState.stateFor.mockReset();
  h.processedState.stateFor.mockReturnValue("unread");
  h.processedState.mark.mockReset();
  h.processedState.restore.mockReset();
  h.processedState.toggle.mockReset();
  h.processedState.markIgnored.mockReset();
  h.processedState.markNeedsLater.mockReset();
  h.processedState.reload.mockReset();
  h.processedState.error = null;
  h.selectionState.position = null;
  h.selectionState.location = null;
  h.selectionState.dismiss.mockReset();
  h.getInspectorData.mockResolvedValue({ data: inspectorData });
  h.actOnQueueItem.mockResolvedValue({});
  h.dismissSourceRetirementSuggestion.mockResolvedValue({
    dismissed: true,
    stale: false,
    suggestion: null,
  });
  h.scheduleQueueItem.mockResolvedValue({
    item: null,
    dueAt: "2026-06-09T00:00:00.000Z",
    intervalDays: 1,
  });
  h.setElementPriority.mockResolvedValue({
    element: { ...inspectorData.element, priorityLabel: "B" },
  });
  h.createExtraction.mockResolvedValue({ id: "ext-1" });
  // The Done surface reads the summary itself (fast-path vs popover); default to the
  // unresolved summary so pressing Done opens the surface. Fast-path tests override it.
  h.getBlockProcessingSummary.mockResolvedValue({ summary: summaryFor() });
});

describe("SourceReader", () => {
  it("renders the desktop-only fallback without querying the bridge", () => {
    h.desktop = false;
    const { getByTestId, getByText } = render(<SourceReader />);

    expect(getByTestId("route-source")).toBeInTheDocument();
    expect(getByText(/open the Electron app/i)).toBeInTheDocument();
    expect(h.getInspectorData).not.toHaveBeenCalled();
    expect(h.select).not.toHaveBeenCalled();
  });

  it("loads source metadata, selects the route element, and renders article controls", async () => {
    const { getAllByTestId, getByTestId, findByTestId } = render(<SourceReader />);

    expect(await findByTestId("reader-title")).toHaveTextContent("Reader source");
    expect(h.select).toHaveBeenCalledWith("src-1");
    expect(h.getInspectorData).toHaveBeenCalledWith({ id: "src-1" });
    expect(getAllByTestId("reader-header")).toHaveLength(1);
    expect(getByTestId("reader-url")).toHaveAttribute("href", "https://example.com/source");
    expect(getByTestId("reader-set-readpoint")).toBeInTheDocument();
    expect(getByTestId("reader-open-original")).toBeInTheDocument();
    expect(getByTestId("reader-progress")).toHaveTextContent("1/2 processed");
    expect(getByTestId("reader-pbar-fill")).toHaveStyle({ width: "50%" });
    expect(getByTestId("mock-source-editor")).toBeInTheDocument();
  });

  it("navigates to Library from the breadcrumb", async () => {
    const { findByRole } = render(<SourceReader />);

    fireEvent.click(await findByRole("button", { name: "Library" }));

    expect(h.navigate).toHaveBeenCalledWith({ to: "/library" });
  });

  it("sets read-points and soft-deletes through the bridge", async () => {
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-set-readpoint"));
    await waitFor(() => expect(h.readPointState.setFromSelection).toHaveBeenCalledWith(h.editor));

    fireEvent.click(getByTestId("reader-delete"));
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "delete" },
      }),
    );
    expect(h.navigate).toHaveBeenCalledWith({ to: "/queue" });
  });

  it("keeps the reader open and controls usable after a delete failure", async () => {
    h.actOnQueueItem.mockRejectedValue(new Error("delete failed"));
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-delete"));

    await waitFor(() =>
      expect(getByTestId("reader-flash")).toHaveTextContent("Could not delete source"),
    );
    expect(h.navigate).not.toHaveBeenCalledWith({ to: "/queue" });
    expect(getByTestId("reader-postpone")).not.toBeDisabled();
    expect(getByTestId("reader-delete")).not.toBeDisabled();
  });

  it("schedules the source return through the existing schedule queue command", async () => {
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-postpone"));
    fireEvent.click(getByTestId("schedule-nextWeek"));

    await waitFor(() =>
      expect(h.scheduleQueueItem).toHaveBeenCalledWith({
        id: "src-1",
        choice: { kind: "nextWeek" },
      }),
    );
  });

  it("refreshes source metadata after scheduling a return", async () => {
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("reader-title");
    h.getInspectorData.mockClear();

    fireEvent.click(getByTestId("reader-postpone"));
    fireEvent.click(getByTestId("schedule-nextWeek"));

    await waitFor(() =>
      expect(h.scheduleQueueItem).toHaveBeenCalledWith({
        id: "src-1",
        choice: { kind: "nextWeek" },
      }),
    );
    await waitFor(() => expect(h.getInspectorData).toHaveBeenCalledWith({ id: "src-1" }));
    expect(h.refreshInspector).toHaveBeenCalled();
    expect(getByTestId("reader-flash")).toHaveTextContent("Scheduled return");
  });

  it("keeps reader exit controls usable after a schedule failure", async () => {
    h.scheduleQueueItem.mockRejectedValue(new Error("schedule failed"));
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-postpone"));
    fireEvent.click(getByTestId("schedule-nextWeek"));

    await waitFor(() =>
      expect(getByTestId("reader-flash")).toHaveTextContent("Could not schedule return"),
    );
    expect(getByTestId("reader-postpone")).not.toBeDisabled();
    expect(getByTestId("reader-lower-priority")).not.toBeDisabled();
  });

  it("lowers source priority through the element priority command", async () => {
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-lower-priority"));

    await waitFor(() =>
      expect(h.setElementPriority).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "lower" },
      }),
    );
  });

  it("keeps reader exit controls usable after a lower-priority failure", async () => {
    h.setElementPriority.mockRejectedValue(new Error("priority failed"));
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-lower-priority"));

    await waitFor(() =>
      expect(getByTestId("reader-flash")).toHaveTextContent("Could not lower priority"),
    );
    expect(getByTestId("reader-postpone")).not.toBeDisabled();
    expect(getByTestId("reader-lower-priority")).not.toBeDisabled();
  });

  it("blocks overlapping reader exit mutations while one exit action is pending", async () => {
    const pending = deferred<{
      item: null;
      dueAt: string;
      intervalDays: number;
    }>();
    h.scheduleQueueItem.mockReturnValue(pending.promise);
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-postpone"));
    fireEvent.click(getByTestId("schedule-nextWeek"));

    await waitFor(() => expect(getByTestId("reader-lower-priority")).toBeDisabled());
    expect(getByTestId("reader-mark-done")).toBeDisabled();
    expect(getByTestId("reader-delete")).toBeDisabled();

    fireEvent.click(getByTestId("reader-lower-priority"));
    fireEvent.click(getByTestId("reader-mark-done"));
    fireEvent.click(getByTestId("reader-delete"));

    expect(h.setElementPriority).not.toHaveBeenCalled();
    expect(h.actOnQueueItem).not.toHaveBeenCalled();

    pending.resolve({
      item: null,
      dueAt: "2026-06-09T00:00:00.000Z",
      intervalDays: 1,
    });
    await waitFor(() => expect(getByTestId("reader-lower-priority")).not.toBeDisabled());
    expect(h.scheduleQueueItem).toHaveBeenCalledTimes(1);
  });

  it("marks a 0-unresolved source done immediately, with no intent surface", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.getBlockProcessingSummary.mockResolvedValue({
      summary: summaryFor({
        unresolvedBlocks: 0,
        highPriorityUnresolvedBlocks: 0,
        processedBlocks: 2,
        terminalBlocks: 2,
        terminalRatio: 1,
        canMarkDoneWithoutConfirmation: true,
        stateCounts: {
          unread: 0,
          read: 0,
          extracted: 2,
          ignored: 0,
          processed_without_output: 0,
          needs_later: 0,
          stale_after_edit: 0,
        },
      }),
    });
    const { getByTestId, findByTestId, queryByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-mark-done"));

    // Fast path: mark done + ⌘Z-undo toast + navigate to /queue, no popover.
    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "markDone", confirmUnresolvedBlocks: true },
      }),
    );
    expect(queryByTestId("done-intent-pop")).not.toBeInTheDocument();
    expect(h.navigate).toHaveBeenCalledWith({ to: "/queue" });
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("opens the intent surface (no window.confirm) when unresolved blocks remain", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-mark-done"));

    await waitFor(() => expect(getByTestId("done-intent-pop")).toBeInTheDocument());
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("surfaces a proactive done nudge from the source retirement suggestion", async () => {
    const initialInspector = {
      data: {
        ...inspectorData,
        scheduler: {
          ...inspectorData.scheduler,
          retirementSuggestion: {
            kind: "abandon" as const,
            reason: "mostly_ignored_no_output",
            reasonLabel: "Mostly ignored blocks, no extracts yet",
            signalHash: "hash-retire-reader",
            terminalRatio: 1,
            ignoredRatio: 0.75,
            totalBlocks: 4,
            terminalBlocks: 4,
            ignoredBlocks: 3,
            unresolvedBlocks: 0,
            extractedOutputCount: 0,
          },
        },
      },
    };
    h.getInspectorData.mockResolvedValue({
      data: {
        ...inspectorData,
        scheduler: {
          ...inspectorData.scheduler,
          retirementSuggestion: null,
        },
      },
    });
    h.getInspectorData.mockResolvedValueOnce(initialInspector);
    const { getByTestId, queryByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-retirement-review"));

    await findByTestId("done-intent-pop");
    expect(getByTestId("done-intent-abandon")).toHaveTextContent("Suggested");
    expect(h.actOnQueueItem).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("reader-retirement-dismiss"));
    await waitFor(() =>
      expect(h.dismissSourceRetirementSuggestion).toHaveBeenCalledWith({
        sourceElementId: "src-1",
        signalHash: "hash-retire-reader",
      }),
    );
    await waitFor(() => expect(h.getInspectorData).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(queryByTestId("reader-retirement-suggestion")).toBeNull());
    expect(getByTestId("reader-flash")).toHaveTextContent("Suggestion dismissed");
  });

  it("Finished marks the source done with the confirm override and navigates to /queue", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-mark-done"));
    fireEvent.click(await findByTestId("done-intent-finished"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "markDone", confirmUnresolvedBlocks: true },
      }),
    );
    expect(h.navigate).toHaveBeenCalledWith({ to: "/queue" });
    expect(getByTestId("reader-flash")).toHaveTextContent("Source done — ⌘Z to undo");
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("Abandon dismisses the source and navigates to /queue", async () => {
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-mark-done"));
    fireEvent.click(await findByTestId("done-intent-abandon"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "dismiss" },
      }),
    );
    expect(h.navigate).toHaveBeenCalledWith({ to: "/queue" });
    expect(getByTestId("reader-flash")).toHaveTextContent("Source dismissed");
  });

  it("Return later postpones, refreshes the inspector, and stays on the reader", async () => {
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("reader-title");
    h.getInspectorData.mockClear();

    fireEvent.click(getByTestId("reader-mark-done"));
    fireEvent.click(await findByTestId("done-intent-later"));

    await waitFor(() =>
      expect(h.actOnQueueItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "postpone" },
      }),
    );
    await waitFor(() => expect(h.getInspectorData).toHaveBeenCalledWith({ id: "src-1" }));
    expect(h.refreshInspector).toHaveBeenCalled();
    expect(getByTestId("reader-flash")).toHaveTextContent("Returned to the queue");
    // Return later keeps reading where it is — the read-point/due-date stay decoupled.
    expect(h.navigate).not.toHaveBeenCalledWith({ to: "/queue" });
    expect(getByTestId("route-source")).toBeInTheDocument();
  });

  it("cancels the intent surface on Escape without mutating", async () => {
    const { getByTestId, findByTestId, queryByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-mark-done"));
    await findByTestId("done-intent-pop");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(queryByTestId("done-intent-pop")).not.toBeInTheDocument());
    expect(h.actOnQueueItem).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalledWith({ to: "/queue" });
    expect(getByTestId("route-source")).toBeInTheDocument();
  });

  it("keeps reader exit controls usable after a mark-done (Finished) failure", async () => {
    const confirm = vi.spyOn(window, "confirm");
    h.actOnQueueItem.mockRejectedValue(new Error("mark done failed"));
    const { getByTestId, findByTestId } = render(<SourceReader />);
    await findByTestId("mock-source-editor");

    fireEvent.click(getByTestId("reader-mark-done"));
    fireEvent.click(await findByTestId("done-intent-finished"));

    await waitFor(() =>
      expect(getByTestId("reader-flash")).toHaveTextContent("Could not mark source done"),
    );
    expect(h.navigate).not.toHaveBeenCalledWith({ to: "/queue" });
    expect(getByTestId("reader-postpone")).not.toBeDisabled();
    expect(getByTestId("reader-mark-done")).not.toBeDisabled();
    expect(getByTestId("reader-lower-priority")).not.toBeDisabled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("lifts a selection into an extract and refreshes lineage", async () => {
    h.selectionState.position = { x: 12, y: 34 };
    h.selectionState.location = {
      selectedText: "selected text",
      blockIds: ["blk-1", "blk-2"],
      startOffset: 2,
      endOffset: 15,
    };
    const { getByTestId, findByTestId } = render(<SourceReader />);

    fireEvent.click(await findByTestId("mock-toolbar-extract"));

    await waitFor(() =>
      expect(h.createExtraction).toHaveBeenCalledWith({
        sourceElementId: "src-1",
        selectedText: "selected text",
        blockIds: ["blk-1", "blk-2"],
        startOffset: 2,
        endOffset: 15,
      }),
    );
    expect(h.documentState.markExtracted).toHaveBeenCalledWith(["blk-1", "blk-2"]);
    expect(h.readPointState.markReadThrough).toHaveBeenCalledWith(h.editor, "blk-2");
    expect(h.refreshInspector).toHaveBeenCalled();
    expect(h.processedState.reload).toHaveBeenCalled();
    expect(h.selectionState.dismiss).toHaveBeenCalled();
    expect(getByTestId("reader-flash")).toHaveTextContent("Extracted");
  });

  it("delegates highlight and cloze actions without creating extracts", async () => {
    h.selectionState.position = { x: 12, y: 34 };
    h.selectionState.location = {
      selectedText: "selected text",
      blockIds: ["blk-1"],
      startOffset: 0,
      endOffset: 13,
    };
    const { getByTestId, findByTestId } = render(<SourceReader />);

    fireEvent.click(await findByTestId("mock-toolbar-highlight"));
    await waitFor(() =>
      expect(h.highlightsState.add).toHaveBeenCalledWith(h.selectionState.location),
    );
    await waitFor(() => expect(getByTestId("reader-flash")).toHaveTextContent("Highlighted"));

    fireEvent.click(getByTestId("mock-toolbar-cloze"));
    expect(h.createExtraction).not.toHaveBeenCalled();
    expect(h.selectionState.dismiss).toHaveBeenCalled();
  });

  it("switches to the PDF reader and mirrors child page progress", async () => {
    h.documentState.sourceFormat = "pdf";
    const { getAllByTestId, getByTestId, findByTestId } = render(<SourceReader />);

    expect(await findByTestId("mock-pdf-reader")).toHaveTextContent("PDF src-1");
    expect(getAllByTestId("reader-header")).toHaveLength(1);
    expect(getByTestId("reader-pdf-progress")).toHaveTextContent("PDF");
    expect(getByTestId("reader-postpone")).toBeInTheDocument();
    expect(getByTestId("reader-mark-done")).toBeInTheDocument();
    expect(getByTestId("reader-lower-priority")).toBeInTheDocument();
    expect(getByTestId("reader-open-original")).toHaveAttribute(
      "href",
      "https://example.com/source",
    );

    fireEvent.click(getByTestId("mock-pdf-page-change"));
    expect(getByTestId("reader-pdf-progress")).toHaveTextContent("page 2 of 4");
    expect(getByTestId("reader-pbar-fill")).toHaveStyle({ width: "50%" });

    fireEvent.click(getByTestId("mock-pdf-region"));
    expect(h.refreshInspector).toHaveBeenCalled();
  });

  it("switches to the media reader for video sources", async () => {
    h.documentState.sourceFormat = "video";
    const { findByTestId, getAllByTestId, getByTestId } = render(<SourceReader />);

    expect(await findByTestId("mock-media-reader")).toHaveTextContent("Media src-1");
    expect(getAllByTestId("reader-header")).toHaveLength(1);
    expect(getByTestId("reader-postpone")).toBeInTheDocument();
    expect(getByTestId("reader-mark-done")).toBeInTheDocument();
    expect(getByTestId("reader-lower-priority")).toBeInTheDocument();
    expect(getByTestId("reader-open-original")).toHaveAttribute(
      "href",
      "https://example.com/source",
    );
  });
});
