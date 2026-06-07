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
  createExtraction: vi.fn(),
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
    restore: vi.fn(),
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
      createExtraction: h.createExtraction,
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
  },
};

beforeEach(() => {
  h.desktop = true;
  h.routeId = "src-1";
  h.search = {};
  h.navigate.mockReset();
  h.select.mockReset();
  h.getInspectorData.mockReset();
  h.actOnQueueItem.mockReset();
  h.createExtraction.mockReset();
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
  h.processedState.restore.mockReset();
  h.selectionState.position = null;
  h.selectionState.location = null;
  h.selectionState.dismiss.mockReset();
  h.getInspectorData.mockResolvedValue({ data: inspectorData });
  h.actOnQueueItem.mockResolvedValue({});
  h.createExtraction.mockResolvedValue({ id: "ext-1" });
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
    const { getByTestId, findByTestId } = render(<SourceReader />);

    expect(await findByTestId("reader-title")).toHaveTextContent("Reader source");
    expect(h.select).toHaveBeenCalledWith("src-1");
    expect(h.getInspectorData).toHaveBeenCalledWith({ id: "src-1" });
    expect(getByTestId("reader-url")).toHaveAttribute("href", "https://example.com/source");
    expect(getByTestId("reader-progress")).toHaveTextContent("block 1 of 2");
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
    expect(getByTestId("reader-flash")).toHaveTextContent("Highlighted");

    fireEvent.click(getByTestId("mock-toolbar-cloze"));
    expect(h.createExtraction).not.toHaveBeenCalled();
    expect(h.selectionState.dismiss).toHaveBeenCalled();
  });

  it("switches to the PDF reader and mirrors child page progress", async () => {
    h.documentState.sourceFormat = "pdf";
    const { getByTestId, findByTestId } = render(<SourceReader />);

    expect(await findByTestId("mock-pdf-reader")).toHaveTextContent("PDF src-1");
    expect(getByTestId("reader-pdf-progress")).toHaveTextContent("PDF");

    fireEvent.click(getByTestId("mock-pdf-page-change"));
    expect(getByTestId("reader-pdf-progress")).toHaveTextContent("page 2 of 4");
    expect(getByTestId("reader-pbar-fill")).toHaveStyle({ width: "50%" });

    fireEvent.click(getByTestId("mock-pdf-region"));
    expect(h.refreshInspector).toHaveBeenCalled();
  });

  it("switches to the media reader for video sources", async () => {
    h.documentState.sourceFormat = "video";
    const { findByTestId, getByTestId } = render(<SourceReader />);

    expect(await findByTestId("mock-media-reader")).toHaveTextContent("Media src-1");
    expect(getByTestId("reader-open-original")).toHaveAttribute(
      "href",
      "https://example.com/source",
    );
  });
});
