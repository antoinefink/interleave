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
      importPdfSource: h.importPdfSource,
      pickImportFile: h.pickImportFile,
      importMediaSource: h.importMediaSource,
      getAppSettings: h.getAppSettings,
    },
  };
});

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
  },
];

function detail(id = "src-1") {
  const summary = items.find((item) => item.id === id) ?? items[0];
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
  h.importPdfSource.mockReset();
  h.pickImportFile.mockReset();
  h.importMediaSource.mockReset();
  h.getAppSettings.mockReset();
  h.listInbox.mockResolvedValue({ items });
  h.getInboxItem.mockImplementation(({ id }) => Promise.resolve({ detail: detail(id) }));
  h.triageInboxItem.mockResolvedValue({ item: items[0], deleted: false });
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

    await waitFor(() => expect(getByTestId("inbox-preview-title")).toHaveTextContent("Second source"));
    expect(getByTestId("inbox-read-now")).not.toHaveFocus();
    expect(getByTestId("inbox-triage-actions")).not.toHaveAttribute("data-highlighted", "true");
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("reads now by activating the selected item and navigating to the source reader", async () => {
    const { getByTestId, findByTestId, getByRole } = render(<InboxScreen />);

    await findByTestId("inbox-read-now");
    expect(getByRole("button", { name: /read now/i })).toBeInTheDocument();
    fireEvent.click(getByTestId("inbox-read-now"));
    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "accept" },
      }),
    );
    expect(h.navigate).toHaveBeenCalledWith({ to: "/source/$id", params: { id: "src-1" } });
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
