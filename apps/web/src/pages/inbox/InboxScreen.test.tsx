import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  navigate: vi.fn(),
  selectedId: null as string | null,
  select: vi.fn(),
  listInbox: vi.fn(),
  getInboxItem: vi.fn(),
  triageInboxItem: vi.fn(),
  bulkTriageInbox: vi.fn(),
  bulkTriageInboxUndo: vi.fn(),
  importPdfSource: vi.fn(),
  pickImportFile: vi.fn(),
  importMediaSource: vi.fn(),
  getAppSettings: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("@interleave/editor", () => ({
  buildSchema: () => ({
    nodeFromJSON(value: unknown) {
      function validate(node: unknown) {
        if (!node || typeof node !== "object" || Array.isArray(node)) {
          throw new Error("Invalid ProseMirror node");
        }
        const typed = node as { type?: unknown; content?: unknown };
        if (typeof typed.type !== "string") throw new Error("Invalid ProseMirror node");
        if (typed.content === undefined) return;
        if (!Array.isArray(typed.content)) throw new Error("Invalid ProseMirror content");
        for (const child of typed.content) validate(child);
      }
      validate(value);
    },
  }),
  SourceEditor: ({
    initialDoc,
    editable,
    className,
  }: {
    initialDoc: unknown;
    editable: boolean;
    className?: string;
  }) => (
    <div className={className} data-editable={String(editable)} data-testid="mock-source-editor">
      {JSON.stringify(initialDoc)}
    </div>
  ),
}));

vi.mock("../../components/BalanceBanner", () => ({
  BalanceBanner: ({
    refreshKey,
    onTriageInbox,
    triageInboxLabel,
  }: {
    refreshKey: number;
    onTriageInbox?: () => void;
    triageInboxLabel?: string;
  }) => (
    <div data-testid="mock-balance-banner">
      {refreshKey}
      <button type="button" data-testid="mock-balance-triage-inbox" onClick={onTriageInbox}>
        {triageInboxLabel ?? "Triage inbox"}
      </button>
    </div>
  ),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: h.selectedId, select: h.select }),
}));

vi.mock("./NewSourceModal", () => ({
  NewSourceModal: ({
    open,
    defaultPriority,
    onCreated,
    onClose,
  }: {
    open: boolean;
    defaultPriority?: string;
    onCreated: (id: string) => void;
    onClose: () => void;
  }) =>
    open ? (
      <div data-default-priority={defaultPriority} data-testid="mock-new-source-modal">
        <button
          type="button"
          data-testid="mock-new-source-create"
          onClick={() => onCreated("new-1")}
        >
          Create
        </button>
        <button type="button" data-testid="mock-new-source-close" onClick={onClose}>
          Close
        </button>
      </div>
    ) : null,
}));

vi.mock("./ImportUrlModal", () => ({
  ImportUrlModal: ({
    open,
    defaultPriority,
    onImported,
    onOpenExisting,
  }: {
    open: boolean;
    defaultPriority?: string;
    onImported: (id: string) => void;
    onOpenExisting?: (match: {
      elementId: string;
      title: string;
      status: string;
      accessedAt: string | null;
      matchedBy: "canonicalUrl" | "contentHash";
    }) => void;
  }) =>
    open ? (
      <div data-default-priority={defaultPriority} data-testid="mock-url-import-modal">
        <button type="button" data-testid="mock-url-import" onClick={() => onImported("url-1")}>
          URL import
        </button>
        <button
          type="button"
          data-testid="mock-url-open-existing-active"
          onClick={() =>
            onOpenExisting
              ? onOpenExisting({
                  elementId: "existing-active-1",
                  title: "Existing active",
                  status: "active",
                  accessedAt: null,
                  matchedBy: "canonicalUrl",
                })
              : onImported("existing-active-1")
          }
        >
          Open active existing
        </button>
        <button
          type="button"
          data-testid="mock-url-open-existing-inbox"
          onClick={() =>
            onOpenExisting
              ? onOpenExisting({
                  elementId: "existing-inbox-1",
                  title: "Existing inbox",
                  status: "inbox",
                  accessedAt: null,
                  matchedBy: "canonicalUrl",
                })
              : onImported("existing-inbox-1")
          }
        >
          Open inbox existing
        </button>
      </div>
    ) : null,
}));

vi.mock("./ImportFileModal", () => ({
  ImportFileModal: ({
    open,
    defaultPriority,
    onImported,
    onHighlightsImported,
  }: {
    open: boolean;
    defaultPriority?: string;
    onImported: (id: string) => void;
    onHighlightsImported: (id: string) => void;
  }) =>
    open ? (
      <div data-default-priority={defaultPriority} data-testid="mock-file-modal">
        <button type="button" data-testid="mock-file-import" onClick={() => onImported("file-1")}>
          File import
        </button>
        <button
          type="button"
          data-testid="mock-highlights-import"
          onClick={() => onHighlightsImported("hl-1")}
        >
          Highlights import
        </button>
      </div>
    ) : null,
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      listInbox: h.listInbox,
      getInboxItem: h.getInboxItem,
      triageInboxItem: h.triageInboxItem,
      bulkTriageInbox: h.bulkTriageInbox,
      bulkTriageInboxUndo: h.bulkTriageInboxUndo,
      importPdfSource: h.importPdfSource,
      pickImportFile: h.pickImportFile,
      importMediaSource: h.importMediaSource,
      getAppSettings: h.getAppSettings,
    },
  };
});

import { hasActiveScope, isScopeActive } from "../../shell/activeScope";
import { InboxScreen } from "./InboxScreen";

const items = [
  {
    id: "src-1",
    type: "source",
    status: "inbox",
    title: "Inbox source",
    srcType: "article",
    author: "Author",
    charCount: 1234,
    priority: 0.375,
    accessedAt: "2026-06-03T00:00:00.000Z",
    origin: "url" as const,
    domain: "example.com",
  },
  {
    id: "src-2",
    type: "source",
    status: "inbox",
    title: "Second source",
    srcType: "pdf",
    author: null,
    charCount: 456,
    priority: 0.875,
    accessedAt: null,
    origin: "file" as const,
    domain: null,
  },
];

function inboxItem(index: number): (typeof items)[number] {
  const item = items[index];
  if (!item) throw new Error(`expected inbox fixture at index ${index}`);
  return item;
}

function detail(id = "src-1") {
  const summary = items.find((item) => item.id === id) ?? inboxItem(0);
  return {
    summary,
    provenance: {
      url: "https://example.com/article",
      canonicalUrl: "https://example.com/article",
      author: "Author",
      publishedAt: "2026-05-20T00:00:00.000Z",
      accessedAt: "2026-06-03T00:00:00.000Z",
      reasonAdded: "Research",
    },
    bodyDoc: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1, blockId: "blk-title" },
          content: [{ type: "text", text: "Formatted article" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "blk-body" },
          content: [{ type: "text", text: "Full article body" }],
        },
        {
          type: "paragraph",
          attrs: { blockId: "blk-tail" },
          content: [{ type: "text", text: "Formatted tail sentinel" }],
        },
      ],
    },
    bodyText: "First paragraph.\n\nSecond paragraph.",
    bodyPreview: "First paragraph.\n\nSecond paragraph.",
  };
}

beforeEach(() => {
  h.desktop = true;
  h.selectedId = null;
  h.navigate.mockReset();
  h.select.mockReset();
  h.listInbox.mockReset();
  h.getInboxItem.mockReset();
  h.triageInboxItem.mockReset();
  h.bulkTriageInbox.mockReset();
  h.bulkTriageInboxUndo.mockReset();
  h.importPdfSource.mockReset();
  h.pickImportFile.mockReset();
  h.importMediaSource.mockReset();
  h.getAppSettings.mockReset();
  h.listInbox.mockResolvedValue({ items });
  h.getInboxItem.mockImplementation(({ id }) => Promise.resolve({ detail: detail(id) }));
  h.triageInboxItem.mockResolvedValue({ item: items[0], deleted: false });
  h.bulkTriageInbox.mockResolvedValue({
    batchId: "batch-1",
    applied: 0,
    skipped: [],
    errored: [],
  });
  h.bulkTriageInboxUndo.mockResolvedValue({ undone: true, count: 0 });
  h.importPdfSource.mockResolvedValue({ status: "imported", id: "pdf-1" });
  h.getAppSettings.mockResolvedValue({ settings: { defaultSourcePriority: 0.875 } });
  h.pickImportFile
    .mockResolvedValueOnce({ paths: ["/vault/video.mp4"] })
    .mockResolvedValueOnce({ cancelled: true });
  h.importMediaSource.mockResolvedValue({ status: "imported", id: "media-1" });
  Element.prototype.scrollIntoView = vi.fn();
});

describe("InboxScreen", () => {
  it("renders the desktop-only fallback without the bridge", () => {
    h.desktop = false;
    const { getByTestId, getByText } = render(<InboxScreen />);

    expect(getByTestId("route-inbox")).toBeInTheDocument();
    expect(getByText(/open the Electron app/i)).toBeInTheDocument();
    expect(h.listInbox).not.toHaveBeenCalled();
  });

  it("loads inbox rows, selects the first item, and renders its preview", async () => {
    const { getAllByTestId, getByTestId, findByTestId } = render(<InboxScreen />);

    expect(await findByTestId("inbox-list")).toBeInTheDocument();
    expect(getAllByTestId("inbox-row")).toHaveLength(2);
    expect(getAllByTestId("inbox-row")[0]).toHaveClass("cursor-pointer");
    expect(getAllByTestId("inbox-row")[1]).toHaveClass("cursor-pointer");
    await waitFor(() => expect(h.getInboxItem).toHaveBeenCalledWith({ id: "src-1" }));
    expect(h.select).toHaveBeenCalledWith("src-1");
    expect(getByTestId("inbox-preview-title")).toHaveTextContent("Inbox source");
    expect(getByTestId("inbox-preview-url")).toHaveAttribute("href", "https://example.com/article");
    expect(getByTestId("inbox-preview-url")).toHaveAttribute("target", "_blank");
    expect(getByTestId("inbox-preview-canonical")).toHaveAttribute(
      "href",
      "https://example.com/article",
    );
    expect(getByTestId("inbox-preview-canonical")).toHaveAttribute("target", "_blank");
    expect(getByTestId("inbox-preview-canonical")).toHaveClass("external-url-link");
    expect(getByTestId("mock-source-editor")).toHaveTextContent("Formatted article");
    expect(getByTestId("mock-source-editor")).toHaveTextContent("Formatted tail sentinel");
    expect(getByTestId("mock-source-editor")).toHaveClass("inbox-preview-reader");
    expect(getByTestId("mock-source-editor")).toHaveAttribute("data-editable", "false");
    expect(getByTestId("inbox-count")).toHaveTextContent("2 items awaiting triage");
    expect(getByTestId("mock-balance-banner").parentElement).toHaveClass("px-2");
    expect(getByTestId("mock-balance-banner").parentElement).not.toHaveClass("px-6");
  });

  it("keeps inbox row metadata on one line with compact character counts", async () => {
    const longSourceLabel = "very-long-import-source-label-that-should-not-wrap";
    const longAuthor =
      "A very long author name that should truncate in the flexible middle metadata slot";
    h.listInbox.mockResolvedValue({
      items: [
        ...items,
        {
          id: "src-long",
          type: "source",
          status: "inbox",
          title: "A long source row",
          srcType: longSourceLabel,
          author: longAuthor,
          charCount: 20_971,
          priority: 0.625,
          accessedAt: null,
        },
      ],
    });

    const { findByTestId, getAllByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    const rows = getAllByTestId("inbox-row");
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1.2k ch"),
        expect.stringContaining("456 ch"),
        expect.stringContaining("21k ch"),
      ]),
    );

    const row = rows.find((node) => node.getAttribute("data-element-id") === "src-long");
    if (!row) throw new Error("Expected long inbox row to render");

    const label = within(row).getByText(longSourceLabel);
    const metadata = label.parentElement;
    if (!metadata) throw new Error("Expected source label to live inside the metadata row");
    const author = within(row).getByText(longAuthor);
    const size = within(row).getByText("21k ch");
    const separators = Array.from(metadata.children).filter(
      (child) => child.getAttribute("aria-hidden") === "true",
    );
    const priority = row.lastElementChild;
    if (!priority) throw new Error("Expected inbox row to render a priority chip");

    expect(metadata).toHaveClass("min-w-0", "overflow-hidden", "whitespace-nowrap");
    expect(label).toHaveClass("shrink-0", "truncate", "whitespace-nowrap");
    expect(label).toHaveClass("max-w-[calc(var(--s-12)+var(--s-10))]");
    expect(author).toHaveClass("min-w-0", "flex-1", "truncate", "whitespace-nowrap");
    expect(size).toHaveClass("shrink-0", "whitespace-nowrap");
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(separator).toHaveClass("shrink-0");
    }
    expect(priority).toHaveClass("shrink-0");
  });

  it("shows and focuses the selected item's triage actions when the balance banner action is clicked", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-read-now");
    expect(getByTestId("mock-balance-triage-inbox")).toHaveTextContent("Show triage actions");
    fireEvent.click(getByTestId("mock-balance-triage-inbox"));

    expect(getByTestId("inbox-triage-actions")).toHaveAttribute("data-highlighted", "true");
    expect(getByTestId("inbox-read-now")).toHaveFocus();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("honors a balance banner triage click while the selected item is still loading", async () => {
    let resolveDetail!: (value: { detail: ReturnType<typeof detail> }) => void;
    h.getInboxItem.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("mock-balance-triage-inbox"));
    resolveDetail({ detail: detail("src-1") });

    await findByTestId("inbox-read-now");
    await waitFor(() => expect(getByTestId("inbox-read-now")).toHaveFocus());
    expect(getByTestId("inbox-triage-actions")).toHaveAttribute("data-highlighted", "true");
  });

  it("does not replay a pending balance banner triage click onto a newly selected item", async () => {
    let resolveFirstDetail!: (value: { detail: ReturnType<typeof detail> }) => void;
    h.getInboxItem
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstDetail = resolve;
        }),
      )
      .mockResolvedValueOnce({ detail: detail("src-2") });
    const { getAllByTestId, getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("mock-balance-triage-inbox"));
    const secondRow = getAllByTestId("inbox-row")[1];
    if (!secondRow) throw new Error("expected a second inbox row");
    fireEvent.click(secondRow);
    resolveFirstDetail({ detail: detail("src-1") });

    await waitFor(() =>
      expect(getByTestId("inbox-preview-title")).toHaveTextContent("Second source"),
    );
    expect(getByTestId("inbox-read-now")).not.toHaveFocus();
    expect(getByTestId("inbox-triage-actions")).not.toHaveAttribute("data-highlighted", "true");
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("reads now by activating the selected item and navigating to the source reader", async () => {
    const { getByTestId, findByTestId, getByRole } = render(<InboxScreen />);

    await findByTestId("inbox-read-now");
    expect(getByRole("button", { name: /read now/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /queue soon/i })).toBeInTheDocument();
    expect(getByTestId("inbox-triage-actions")).toHaveTextContent("1 · 2 · 3 · 6");
    fireEvent.click(getByTestId("inbox-read-now"));
    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "accept" },
      }),
    );
    expect(h.navigate).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });
  });

  it("queues the selected item soon without navigating away from inbox", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-queue-soon");
    h.listInbox.mockClear();
    fireEvent.click(getByTestId("inbox-queue-soon"));

    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "queueSoon" },
      }),
    );
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.listInbox).toHaveBeenCalled();
  });

  it("keeps a queue-soon refresh error visible and removes the acted row locally", async () => {
    const { getByTestId, findByTestId, queryByText } = render(<InboxScreen />);

    await findByTestId("inbox-queue-soon");
    h.listInbox.mockClear();
    h.listInbox.mockRejectedValueOnce(new Error("reload failed"));
    fireEvent.click(getByTestId("inbox-queue-soon"));

    expect(await findByTestId("inbox-error")).toHaveTextContent("reload failed");
    expect(h.navigate).not.toHaveBeenCalled();
    expect(queryByText("Inbox source")).not.toBeInTheDocument();
  });

  it("preserves a newer selected row when queue soon resolves", async () => {
    let resolveTriage!: (value: { item: (typeof items)[number]; deleted: boolean }) => void;
    h.triageInboxItem.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTriage = resolve;
      }),
    );
    const { getAllByTestId, getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-queue-soon");
    h.listInbox.mockClear();
    h.listInbox.mockResolvedValue({ items: [inboxItem(1)] });
    fireEvent.click(getByTestId("inbox-queue-soon"));
    const secondRow = getAllByTestId("inbox-row")[1];
    if (!secondRow) throw new Error("expected a second inbox row");
    fireEvent.click(secondRow);

    await waitFor(() =>
      expect(getByTestId("inbox-preview-title")).toHaveTextContent("Second source"),
    );
    resolveTriage({ item: inboxItem(0), deleted: false });

    await waitFor(() => expect(h.listInbox).toHaveBeenCalled());
    expect(h.select).not.toHaveBeenCalledWith(null);
    expect(getByTestId("inbox-preview-title")).toHaveTextContent("Second source");
  });

  it("does not repeat the queue-soon shortcut while the triage mutation is unresolved", async () => {
    let resolveTriage!: (value: { item: (typeof items)[number]; deleted: boolean }) => void;
    h.triageInboxItem.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTriage = resolve;
      }),
    );
    const { findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-queue-soon");
    fireEvent.keyDown(window, { key: "2" });
    fireEvent.keyDown(window, { key: "2" });

    await waitFor(() => expect(h.triageInboxItem).toHaveBeenCalledTimes(1));
    resolveTriage({ item: inboxItem(0), deleted: false });
    await waitFor(() => expect(h.listInbox).toHaveBeenCalledTimes(2));
  });

  it("falls back to full body text when a formatted body is unavailable", async () => {
    h.getInboxItem.mockResolvedValueOnce({
      detail: {
        ...detail("src-1"),
        bodyDoc: null,
        bodyText: "Full first paragraph.\n\nFull second paragraph with every word.",
        bodyPreview: "Full first paragraph.",
      },
    });

    const { findByTestId, queryByTestId } = render(<InboxScreen />);

    expect(await findByTestId("inbox-preview-body")).toHaveTextContent(
      "Full second paragraph with every word.",
    );
    expect(queryByTestId("mock-source-editor")).not.toBeInTheDocument();
  });

  it("falls back to full body text when the formatted body is malformed", async () => {
    h.getInboxItem.mockResolvedValueOnce({
      detail: {
        ...detail("src-1"),
        bodyDoc: { type: "doc", content: [{}] },
        bodyText: "Full text survives malformed formatted JSON.",
        bodyPreview: "Full text",
      },
    });

    const { findByTestId, queryByTestId } = render(<InboxScreen />);

    expect(await findByTestId("inbox-preview-body")).toHaveTextContent(
      "Full text survives malformed formatted JSON.",
    );
    expect(queryByTestId("mock-source-editor")).not.toBeInTheDocument();
  });

  it("reprioritizes the selected item through the bridge", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-priority-A");
    await waitFor(() => expect(h.getInboxItem).toHaveBeenCalledWith({ id: "src-1" }));
    h.getInboxItem.mockClear();
    h.listInbox.mockClear();
    h.triageInboxItem.mockResolvedValueOnce({
      item: { ...items[0], priority: 0.875 },
      deleted: false,
    });

    fireEvent.click(getByTestId("inbox-priority-A"));
    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "setPriority", priority: "A" },
      }),
    );
    expect(h.getInboxItem).not.toHaveBeenCalled();
    expect(h.listInbox).not.toHaveBeenCalled();
  });

  it("uses the 1 shortcut for Read now and does not navigate when activation fails", async () => {
    h.triageInboxItem.mockRejectedValueOnce(new Error("cannot activate"));
    const { findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-read-now");
    fireEvent.keyDown(window, { key: "1" });

    expect(await findByTestId("inbox-error")).toHaveTextContent("cannot activate");
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("uses the 2 shortcut for Queue soon and does not navigate", async () => {
    const { findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-queue-soon");
    h.listInbox.mockClear();
    fireEvent.keyDown(window, { key: "2" });

    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "queueSoon" },
      }),
    );
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.listInbox).toHaveBeenCalled();
  });

  it("does not navigate when Read now returns a stale inbox result", async () => {
    h.triageInboxItem.mockResolvedValueOnce({ item: null, deleted: false });
    const { findByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-read-now");
    h.listInbox.mockClear();
    fireEvent.click(getByTestId("inbox-read-now"));

    expect(await findByTestId("inbox-error")).toHaveTextContent("no longer available");
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.listInbox).toHaveBeenCalled();
  });

  it("opens import modals and refreshes after child imports", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-import-paste-text");
    fireEvent.click(getByTestId("inbox-import-paste-text"));
    await waitFor(() =>
      expect(getByTestId("mock-new-source-modal")).toHaveAttribute("data-default-priority", "A"),
    );
    fireEvent.click(await findByTestId("mock-new-source-create"));
    await waitFor(() => expect(h.listInbox).toHaveBeenLastCalledWith());

    fireEvent.click(getByTestId("inbox-import-paste-url"));
    await waitFor(() =>
      expect(getByTestId("mock-url-import-modal")).toHaveAttribute("data-default-priority", "A"),
    );
    fireEvent.click(await findByTestId("mock-url-import"));
    await waitFor(() => expect(h.listInbox).toHaveBeenCalledTimes(3));

    fireEvent.click(getByTestId("inbox-import-import-file"));
    await waitFor(() =>
      expect(getByTestId("mock-file-modal")).toHaveAttribute("data-default-priority", "A"),
    );
    fireEvent.click(await findByTestId("mock-highlights-import"));
    await waitFor(() => expect(h.listInbox).toHaveBeenCalledTimes(4));
  });

  it("opens an existing URL duplicate by closing the modal and navigating to its source", async () => {
    const { getByTestId, findByTestId, queryByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-import-paste-url");
    fireEvent.click(getByTestId("inbox-import-paste-url"));
    expect(await findByTestId("mock-url-import-modal")).toBeInTheDocument();

    h.listInbox.mockClear();
    fireEvent.click(getByTestId("mock-url-open-existing-active"));

    await waitFor(() => expect(queryByTestId("mock-url-import-modal")).not.toBeInTheDocument());
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "existing-active-1" },
    });
    expect(h.triageInboxItem).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "existing-active-1" }),
    );
    expect(h.listInbox).not.toHaveBeenCalled();
  });

  it("activates an inbox-status URL duplicate before navigating to its source", async () => {
    h.triageInboxItem.mockResolvedValueOnce({
      item: { ...items[0], id: "existing-inbox-1", status: "active" },
      deleted: false,
    });
    const { getByTestId, findByTestId, queryByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-import-paste-url");
    fireEvent.click(getByTestId("inbox-import-paste-url"));
    expect(await findByTestId("mock-url-import-modal")).toBeInTheDocument();

    h.listInbox.mockClear();
    fireEvent.click(getByTestId("mock-url-open-existing-inbox"));

    await waitFor(() => expect(queryByTestId("mock-url-import-modal")).not.toBeInTheDocument());
    expect(h.triageInboxItem).toHaveBeenCalledWith({
      id: "existing-inbox-1",
      action: { kind: "accept" },
    });
    expect(h.navigate).toHaveBeenCalledWith({
      to: "/source/$id",
      params: { id: "existing-inbox-1" },
    });
    expect(h.listInbox).not.toHaveBeenCalled();
  });

  it("marks enabled import options as clickable", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-import-paste-url");
    expect(getByTestId("inbox-import-paste-url")).toHaveClass("cursor-pointer");
    expect(getByTestId("inbox-import-import-pdf")).toHaveClass("cursor-pointer");
    expect(getByTestId("inbox-import-browser-capture")).toHaveClass("cursor-pointer");
  });

  it("imports PDF/media and routes browser capture to settings", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-import-import-pdf");
    fireEvent.click(getByTestId("inbox-import-paste-text"));
    await waitFor(() =>
      expect(getByTestId("mock-new-source-modal")).toHaveAttribute("data-default-priority", "A"),
    );
    fireEvent.click(getByTestId("mock-new-source-close"));

    fireEvent.click(getByTestId("inbox-import-import-pdf"));
    await waitFor(() => expect(h.importPdfSource).toHaveBeenCalledWith({ priority: "A" }));

    fireEvent.click(getByTestId("inbox-import-import-media"));
    await waitFor(() =>
      expect(h.importMediaSource).toHaveBeenCalledWith({
        path: "/vault/video.mp4",
        subtitlesPath: null,
        priority: "A",
      }),
    );

    fireEvent.click(getByTestId("inbox-import-browser-capture"));
    expect(h.navigate).toHaveBeenCalledWith({ to: "/settings", hash: "browser-capture" });
  });

  it("shows friendly PDF import errors", async () => {
    h.importPdfSource.mockRejectedValueOnce(new Error("encrypted: locked"));
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-import-import-pdf");
    fireEvent.click(getByTestId("inbox-import-import-pdf"));
    expect(await findByTestId("inbox-error")).toHaveTextContent("password-protected");
  });

  it("renders inbox zero when there are no items", async () => {
    h.listInbox.mockResolvedValue({ items: [] });
    const { findByTestId } = render(<InboxScreen />);

    expect(await findByTestId("inbox-empty")).toBeInTheDocument();
  });
});

// --- Bulk triage (T126 — U5): multi-select + grouping + the bulk panel + undo. ---

type BulkRow = Omit<(typeof items)[number], "origin" | "domain"> & {
  origin: "manual" | "url" | "extension" | "highlight_import" | "file" | null;
  domain: string | null;
};

const bulkRows: readonly BulkRow[] = [
  {
    id: "u1",
    type: "source",
    status: "inbox",
    title: "URL one",
    srcType: "Web article",
    author: null,
    charCount: 100,
    priority: 0.375,
    accessedAt: null,
    origin: "url",
    domain: "example.com",
  },
  {
    id: "u2",
    type: "source",
    status: "inbox",
    title: "URL two",
    srcType: "Web article",
    author: null,
    charCount: 200,
    priority: 0.375,
    accessedAt: null,
    origin: "url",
    domain: "other.com",
  },
  {
    id: "m1",
    type: "source",
    status: "inbox",
    title: "Manual one",
    srcType: "Note",
    author: null,
    charCount: 300,
    priority: 0.375,
    accessedAt: null,
    origin: "manual",
    domain: null,
  },
  {
    id: "x1",
    type: "source",
    status: "inbox",
    title: "Unknown origin",
    srcType: "Note",
    author: null,
    charCount: 400,
    priority: 0.375,
    accessedAt: null,
    origin: null,
    domain: null,
  },
];

/** Resolve the bulk fixtures into the inbox list + detail responses. */
function mountBulk(rows: readonly BulkRow[] = bulkRows) {
  h.listInbox.mockResolvedValue({ items: rows });
  h.getInboxItem.mockImplementation(({ id }: { id: string }) => {
    const summary = rows.find((r) => r.id === id) ?? rows[0];
    return Promise.resolve({
      detail: {
        summary,
        provenance: {
          url: null,
          canonicalUrl: null,
          author: null,
          publishedAt: null,
          accessedAt: null,
          reasonAdded: null,
        },
        bodyDoc: null,
        bodyText: null,
        bodyPreview: null,
      },
    });
  });
}

function rowById(container: HTMLElement, id: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(
    `[data-testid="inbox-row"][data-element-id="${id}"]`,
  );
  if (!node) throw new Error(`expected inbox row ${id}`);
  return node;
}

describe("InboxScreen bulk triage (T126)", () => {
  it("buckets rows by origin, domain, and type with a stable Other group", async () => {
    mountBulk();
    const { findAllByTestId, getAllByTestId, getByTestId } = render(<InboxScreen />);

    await findAllByTestId("inbox-row");
    // Origin axis: URL / Manual / Other (null origin -> Other), counts correct.
    let labels = getAllByTestId("inbox-group-label").map((n) => n.textContent);
    expect(labels).toEqual(["URL", "Manual", "Other"]);
    const counts = getAllByTestId("inbox-group-count").map((n) => n.textContent);
    expect(counts).toEqual(["2", "1", "1"]);

    // Domain axis: example.com / other.com / Other (null domain rows -> Other).
    fireEvent.click(getByTestId("inbox-group-by-domain"));
    labels = getAllByTestId("inbox-group-label").map((n) => n.textContent);
    expect(labels).toEqual(["example.com", "other.com", "Other"]);

    // Type axis: the existing source-type label.
    fireEvent.click(getByTestId("inbox-group-by-type"));
    labels = getAllByTestId("inbox-group-label").map((n) => n.textContent);
    expect(labels).toEqual(["Web article", "Note"]);
  });

  it("renders a single-item domain group", async () => {
    mountBulk();
    const { findByTestId, getByTestId, getAllByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-group-by-domain"));
    const labels = getAllByTestId("inbox-group-label").map((n) => n.textContent);
    expect(labels).toContain("other.com");
  });

  it("click selects a single row; the bulk panel stays hidden at size 1", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));

    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");
    expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument();
    // size === 1 keeps the per-item detail pane.
    expect(getByTestId("inbox-preview")).toBeInTheDocument();
  });

  it("shift-click selects the contiguous range from the anchor", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));
    fireEvent.click(rowById(container, "m1"), { shiftKey: true });

    // u1, u2, m1 are contiguous in display order; x1 is not.
    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");
    expect(rowById(container, "u2")).toHaveAttribute("data-selected", "true");
    expect(rowById(container, "m1")).toHaveAttribute("data-selected", "true");
    expect(rowById(container, "x1")).not.toHaveAttribute("data-selected", "true");
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("3 selected");
  });

  it("ctrl/cmd-click toggles a single id in and out of the set", async () => {
    mountBulk();
    const { container, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));
    fireEvent.click(rowById(container, "x1"), { metaKey: true });
    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");
    expect(rowById(container, "x1")).toHaveAttribute("data-selected", "true");

    fireEvent.click(rowById(container, "x1"), { metaKey: true });
    expect(rowById(container, "x1")).not.toHaveAttribute("data-selected", "true");
  });

  it("select-group selects every id in the group", async () => {
    mountBulk();
    const { container, findByTestId, getAllByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    // The first group header (URL) — select its two rows.
    fireEvent.click(getAllByTestId("inbox-select-group")[0] as HTMLElement);
    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");
    expect(rowById(container, "u2")).toHaveAttribute("data-selected", "true");
    expect(rowById(container, "m1")).not.toHaveAttribute("data-selected", "true");
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("2 selected");
  });

  it("select-all selects the whole inbox and Esc clears it", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-select-all"));
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("4 selected");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument();
    expect(rowById(container, "u1")).not.toHaveAttribute("data-selected", "true");
  });

  it("switching the group-by axis keeps the selected id set", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));
    fireEvent.click(rowById(container, "x1"), { metaKey: true });
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("2 selected");

    fireEvent.click(getByTestId("inbox-group-by-domain"));
    // Same ids stay selected across the axis switch.
    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");
    expect(rowById(container, "x1")).toHaveAttribute("data-selected", "true");
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("2 selected");
  });

  it("size>=2 shows the bulk panel and suppresses the per-cursor detail fetch", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));
    await waitFor(() => expect(h.getInboxItem).toHaveBeenCalledWith({ id: "u1" }));
    h.getInboxItem.mockClear();

    // Extend to two — the bulk panel replaces the detail pane; no new detail fetch.
    fireEvent.click(rowById(container, "u2"), { metaKey: true });
    expect(getByTestId("inbox-bulk-panel")).toBeInTheDocument();
    expect(queryByTestId("inbox-preview")).not.toBeInTheDocument();
    expect(h.getInboxItem).not.toHaveBeenCalled();
  });

  it("reverts to the cursor row's detail when the selection empties to 0", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));
    fireEvent.click(rowById(container, "u2"), { metaKey: true });
    expect(getByTestId("inbox-bulk-panel")).toBeInTheDocument();

    // Toggle both back off -> size 0 -> the cursor row's detail pane returns.
    fireEvent.click(rowById(container, "u1"), { metaKey: true });
    fireEvent.click(rowById(container, "u2"), { metaKey: true });
    expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument();
    await waitFor(() => expect(getByTestId("inbox-preview")).toBeInTheDocument());
  });

  it("a verb fires exactly ONE bulk call with the selected ids + action", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-q",
      applied: 2,
      skipped: [],
      errored: [],
    });
    const { container, findByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-select-all"));
    h.listInbox.mockClear();
    fireEvent.click(getByTestId("inbox-bulk-queue-soon"));

    await waitFor(() => expect(h.bulkTriageInbox).toHaveBeenCalledTimes(1));
    expect(h.bulkTriageInbox).toHaveBeenCalledWith({
      ids: ["u1", "u2", "m1", "x1"],
      action: "queueSoon",
    });
    expect(h.navigate).not.toHaveBeenCalled();
    // Removing verb refreshes the list.
    await waitFor(() => expect(h.listInbox).toHaveBeenCalled());
    void container;
  });

  it("clicking a priority chip ARMS it without firing any IPC call", async () => {
    mountBulk();
    const { findByTestId, getAllByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getAllByTestId("inbox-select-group")[0] as HTMLElement); // URL group (u1,u2)

    fireEvent.click(getByTestId("inbox-bulk-priority-B"));
    // The chip reads armed, but NO batch fired — it is a pure UI toggle.
    expect(getByTestId("inbox-bulk-priority-B")).toHaveAttribute("aria-pressed", "true");
    expect(h.bulkTriageInbox).not.toHaveBeenCalled();

    // Clicking the armed band again disarms it (still no IPC).
    fireEvent.click(getByTestId("inbox-bulk-priority-B"));
    expect(getByTestId("inbox-bulk-priority-B")).toHaveAttribute("aria-pressed", "false");
    expect(h.bulkTriageInbox).not.toHaveBeenCalled();
  });

  it("a verb with an armed band fires exactly ONE combined bulk call (queue at B)", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-qb",
      applied: 2,
      skipped: [],
      errored: [],
    });
    const { findByTestId, getAllByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getAllByTestId("inbox-select-group")[0] as HTMLElement); // URL group (u1,u2)

    // Arm B (no batch), then queue — ONE combined batch carrying the band.
    fireEvent.click(getByTestId("inbox-bulk-priority-B"));
    fireEvent.click(getByTestId("inbox-bulk-queue-soon"));

    await waitFor(() => expect(h.bulkTriageInbox).toHaveBeenCalledTimes(1));
    expect(h.bulkTriageInbox).toHaveBeenCalledWith({
      ids: ["u1", "u2"],
      action: "queueSoon",
      priority: "B",
    });
    // Exactly one batch (one snackbar / one undo).
    expect(h.bulkTriageInbox).toHaveBeenCalledTimes(1);
  });

  it("the Set priority button fires one setPriority call and KEEPS the selection + armed band", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-sp",
      applied: 2,
      skipped: [],
      errored: [],
    });
    const { container, findByTestId, getAllByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getAllByTestId("inbox-select-group")[0] as HTMLElement); // URL group (u1,u2)

    // Set priority is disabled until a band is armed.
    expect(getByTestId("inbox-bulk-set-priority")).toBeDisabled();
    fireEvent.click(getByTestId("inbox-bulk-priority-B"));
    expect(getByTestId("inbox-bulk-set-priority")).not.toBeDisabled();

    fireEvent.click(getByTestId("inbox-bulk-set-priority"));
    await waitFor(() => expect(h.bulkTriageInbox).toHaveBeenCalledTimes(1));
    expect(h.bulkTriageInbox).toHaveBeenCalledWith({
      ids: ["u1", "u2"],
      action: "setPriority",
      priority: "B",
    });

    // Priority-only sweep KEEPS the selection AND the armed band (chain a verb next).
    expect(getByTestId("inbox-bulk-panel")).toBeInTheDocument();
    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");
    expect(getByTestId("inbox-bulk-priority-B")).toHaveAttribute("aria-pressed", "true");
    expect(await findByTestId("inbox-snackbar")).toHaveTextContent("Set priority on 2");
  });

  it("surfaces applied + skipped honestly in the snackbar", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-s",
      applied: 12,
      skipped: [
        { id: "a", reason: "deleted" },
        { id: "b", reason: "not_inbox" },
      ],
      errored: [],
    });
    const { findByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-select-all"));
    fireEvent.click(getByTestId("inbox-bulk-queue-soon"));

    expect(await findByTestId("inbox-snackbar")).toHaveTextContent("Queued 12 · 2 skipped");
  });

  it("does not show the bulk panel for an empty selection", async () => {
    mountBulk();
    const { findByTestId, queryByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument();
    expect(queryByTestId("inbox-bulk-queue-soon")).not.toBeInTheDocument();
    expect(h.bulkTriageInbox).not.toHaveBeenCalled();
  });

  it("a removing verb clears the selection; a priority-only sweep keeps it", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-p",
      applied: 2,
      skipped: [],
      errored: [],
    });
    const { container, findByTestId, getAllByTestId, getByTestId, queryByTestId } = render(
      <InboxScreen />,
    );

    await findByTestId("inbox-list");
    fireEvent.click(getAllByTestId("inbox-select-group")[0] as HTMLElement); // u1,u2

    // A committed priority-only sweep KEEPS the selection (so a verb can chain).
    fireEvent.click(getByTestId("inbox-bulk-priority-A")); // arm A (no batch)
    fireEvent.click(getByTestId("inbox-bulk-set-priority")); // commit the priority-only sweep
    await waitFor(() => expect(h.bulkTriageInbox).toHaveBeenCalled());
    expect(getByTestId("inbox-bulk-panel")).toBeInTheDocument();
    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");

    // A removing verb CLEARS the selection.
    fireEvent.click(getByTestId("inbox-bulk-delete"));
    await waitFor(() => expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument());
  });

  it("recomputes group headers + the count and shows inbox-zero after a sweep empties the inbox", async () => {
    mountBulk([bulkRows[0] as BulkRow, bulkRows[1] as BulkRow]); // two URL rows only
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-z",
      applied: 2,
      skipped: [],
      errored: [],
    });
    const { findByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-select-all"));
    // After the sweep the backend returns an empty inbox -> inbox-zero.
    h.listInbox.mockResolvedValue({ items: [] });
    fireEvent.click(getByTestId("inbox-bulk-delete"));

    expect(await findByTestId("inbox-empty")).toBeInTheDocument();
    expect(getByTestId("inbox-count")).toHaveTextContent("0 items awaiting triage");
  });

  it("drops a whole group header and recomputes the count when a sweep empties one group", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-g",
      applied: 2,
      skipped: [],
      errored: [],
    });
    const { findByTestId, getAllByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getAllByTestId("inbox-select-group")[0] as HTMLElement); // URL group
    // The backend list after the sweep no longer has the URL rows.
    h.listInbox.mockResolvedValue({
      items: [bulkRows[2] as BulkRow, bulkRows[3] as BulkRow],
    });
    fireEvent.click(getByTestId("inbox-bulk-delete"));

    await waitFor(() => {
      const labels = getAllByTestId("inbox-group-label").map((n) => n.textContent);
      expect(labels).toEqual(["Manual", "Other"]);
    });
    expect(getByTestId("inbox-count")).toHaveTextContent("2 items awaiting triage");
  });

  it("announces the selection count and the batch result via the live region", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-a",
      applied: 2,
      skipped: [{ id: "z", reason: "deleted" }],
      errored: [],
    });
    const { findByTestId, getAllByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getAllByTestId("inbox-select-group")[0] as HTMLElement);
    expect(getByTestId("inbox-announce")).toHaveTextContent("2 items selected");

    fireEvent.click(getByTestId("inbox-bulk-queue-soon"));
    await waitFor(() =>
      expect(getByTestId("inbox-announce")).toHaveTextContent(
        "Queued applied to 2 items. 1 skipped.",
      ),
    );
  });

  it("the snackbar Undo calls bulkTriageInboxUndo with the batch id and refreshes", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-undo",
      applied: 2,
      skipped: [],
      errored: [],
    });
    const { findByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-select-all"));
    fireEvent.click(getByTestId("inbox-bulk-queue-soon"));

    const undo = await findByTestId("inbox-snackbar-undo");
    h.listInbox.mockClear();
    fireEvent.click(undo);

    await waitFor(() =>
      expect(h.bulkTriageInboxUndo).toHaveBeenCalledWith({ batchId: "batch-undo" }),
    );
    await waitFor(() => expect(h.listInbox).toHaveBeenCalled());
  });
});

describe("InboxScreen keyboard triage scope (T126 — U6)", () => {
  /** Build N URL-origin rows so a single group holds the whole sweep. */
  function bigGroup(n: number): readonly BulkRow[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `g${i + 1}`,
      type: "source" as const,
      status: "inbox" as const,
      title: `Group row ${i + 1}`,
      srcType: "Web article",
      author: null,
      charCount: 100,
      priority: 0.375,
      accessedAt: null,
      origin: "url" as const,
      domain: "example.com",
    }));
  }

  it("registers the `triage` active scope while the inbox list is shown so global keys defer", async () => {
    mountBulk();
    const { findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    // The inbox is the active triage surface — the shell defers `o`/`u`/`+`/`-`.
    await waitFor(() => expect(isScopeActive("triage")).toBe(true));
    expect(hasActiveScope()).toBe(true);
  });

  it("⌘Z is NOT bound by the inbox scope — it never fires a bulk undo (global undo always works)", async () => {
    mountBulk();
    const { container, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));
    fireEvent.click(rowById(container, "u2"), { metaKey: true });
    await findByTestId("inbox-bulk-panel");

    // ⌘Z must pass straight through to the global undo handler — the inbox scope
    // does not consume it, so no bulk-undo IPC fires.
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(h.bulkTriageInboxUndo).not.toHaveBeenCalled();
    expect(h.bulkTriageInbox).not.toHaveBeenCalled();
  });

  it("select-rest-of-group (s) + a verb key dispatch ONE bulk over a 30-item group", async () => {
    const rows = bigGroup(30);
    mountBulk(rows);
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-kbd",
      applied: 30,
      skipped: [],
      errored: [],
    });
    const { findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    // One keypress selects the whole 30-item group (NOT 30 keypresses), then one
    // verb key fires exactly ONE bulk command over every id in the group.
    fireEvent.keyDown(window, { key: "s" });
    fireEvent.keyDown(window, { key: "2" }); // Queue soon

    await waitFor(() => expect(h.bulkTriageInbox).toHaveBeenCalledTimes(1));
    const call = h.bulkTriageInbox.mock.calls[0]?.[0] as {
      ids: string[];
      action: string;
    };
    expect(call.action).toBe("queueSoon");
    expect(call.ids).toHaveLength(30);
    expect(call.ids).toEqual(rows.map((r) => r.id));
  });

  it("an armed band rides with a keyboard verb in one combined batch (a then 2)", async () => {
    const rows = bigGroup(4);
    mountBulk(rows);
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-kbd-b",
      applied: 4,
      skipped: [],
      errored: [],
    });
    const { findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.keyDown(window, { key: "s" }); // select the whole group
    fireEvent.keyDown(window, { key: "b" }); // arm band B (no IPC)
    expect(h.bulkTriageInbox).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "2" }); // queue soon, combined with B

    await waitFor(() => expect(h.bulkTriageInbox).toHaveBeenCalledTimes(1));
    expect(h.bulkTriageInbox).toHaveBeenCalledWith({
      ids: rows.map((r) => r.id),
      action: "queueSoon",
      priority: "B",
    });
  });

  it("with an EMPTY selection a verb key acts on exactly the cursor row (no widening)", async () => {
    mountBulk();
    const { findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    // No multi-select — the verb falls back to the single cursor row via the
    // per-item command, NOT a bulk sweep over the whole list.
    fireEvent.keyDown(window, { key: "2" }); // Queue soon

    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "u1",
        action: { kind: "queueSoon" },
      }),
    );
    expect(h.bulkTriageInbox).not.toHaveBeenCalled();
    expect(h.triageInboxItem).toHaveBeenCalledTimes(1);
  });

  it("the empty-selection 1 key reads the cursor row now and falls back to per-item accept", async () => {
    mountBulk();
    h.triageInboxItem.mockResolvedValue({ item: { ...bulkRows[0] }, deleted: false });
    const { findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.keyDown(window, { key: "1" }); // Read now (cursor row)

    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "u1",
        action: { kind: "accept" },
      }),
    );
    expect(h.bulkTriageInbox).not.toHaveBeenCalled();
  });

  it("j / k move the roving cursor without changing the selection", async () => {
    mountBulk();
    const { container, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    // The first row (u1) is the initial cursor.
    await waitFor(() => expect(rowById(container, "u1")).toHaveAttribute("data-cursor", "true"));

    fireEvent.keyDown(window, { key: "j" });
    expect(rowById(container, "u2")).toHaveAttribute("data-cursor", "true");
    expect(rowById(container, "u1")).not.toHaveAttribute("data-cursor", "true");
    // Moving the cursor selects nothing on its own.
    expect(rowById(container, "u2")).not.toHaveAttribute("data-selected", "true");

    fireEvent.keyDown(window, { key: "k" });
    expect(rowById(container, "u1")).toHaveAttribute("data-cursor", "true");
  });

  it("x toggles the cursor row into the set; ⇧j extends the range", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    await waitFor(() => expect(rowById(container, "u1")).toHaveAttribute("data-cursor", "true"));

    fireEvent.keyDown(window, { key: "x" }); // toggle u1 in
    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");

    fireEvent.keyDown(window, { key: "j", shiftKey: true }); // extend to u2
    expect(rowById(container, "u2")).toHaveAttribute("data-selected", "true");
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("2 selected");
  });

  it("⌘A selects all and Esc clears via the keyboard", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-list");
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("4 selected");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument();
    expect(rowById(container, "u1")).not.toHaveAttribute("data-selected", "true");
  });
});
