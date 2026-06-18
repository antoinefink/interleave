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
  suggestTriage: vi.fn(),
  assignConcept: vi.fn(),
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
      suggestTriage: h.suggestTriage,
      assignConcept: h.assignConcept,
    },
  };
});

import { hasActiveScope, isScopeActive } from "../../shell/activeScope";
import { InboxTriagePanelProvider, useInboxTriagePanel } from "../../shell/inboxTriagePanel";
import { InboxScreen } from "./InboxScreen";
import { InboxTriageSection } from "./InboxTriageSection";

/**
 * Test harness: the triage cluster now renders in the shell inspector, not the
 * inbox preview. The inspector is not mounted here, so this probe renders the real
 * `InboxTriageSection` from the payload `InboxScreen` publishes — giving the same
 * triage testids in the DOM, driven by the real handlers/state. This keeps the
 * triage button / picker / suggestion / reveal tests exercising the live code path.
 */
function TriagePanelProbe() {
  const { panel, registerSection, registerReadNowButton } = useInboxTriagePanel();
  if (!panel) return null;
  return (
    <InboxTriageSection
      panel={panel}
      registerSection={registerSection}
      registerReadNowButton={registerReadNowButton}
    />
  );
}

function InboxHarness() {
  return (
    <InboxTriagePanelProvider>
      <InboxScreen />
      <TriagePanelProbe />
    </InboxTriagePanelProvider>
  );
}

// Mounts InboxScreen conditionally under a persistent provider + probe, so a test
// can unmount InboxScreen (mount=false) while the probe stays mounted to observe
// that the published triage payload is cleared on unmount (no cross-route leak).
function ConditionalInboxHarness({ mount }: { mount: boolean }) {
  return (
    <InboxTriagePanelProvider>
      {mount ? <InboxScreen /> : null}
      <TriagePanelProbe />
    </InboxTriagePanelProvider>
  );
}

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
  h.suggestTriage.mockReset();
  h.assignConcept.mockReset();
  // Default: every listed id resolves to an insufficient verdict, so existing tests
  // see no chip. T127 tests override this with a banded suggestion per id.
  h.suggestTriage.mockImplementation(({ ids }: { ids: readonly string[] }) =>
    Promise.resolve({
      results: ids.map((id) => ({
        id,
        suggestion: { kind: "insufficient_signal", reason: "no_signal_fired" },
      })),
    }),
  );
  h.assignConcept.mockResolvedValue({ element: null });
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
    const { getByTestId, getByText } = render(<InboxHarness />);

    expect(getByTestId("route-inbox")).toBeInTheDocument();
    expect(getByText(/open the Electron app/i)).toBeInTheDocument();
    expect(h.listInbox).not.toHaveBeenCalled();
  });

  it("loads inbox rows, selects the first item, and renders its preview", async () => {
    const { getAllByTestId, getByTestId, findByTestId } = render(<InboxHarness />);

    expect(await findByTestId("inbox-list")).toBeInTheDocument();
    expect(getAllByTestId("inbox-row")).toHaveLength(2);
    expect(getAllByTestId("inbox-row")[0]).toHaveClass("cursor-pointer");
    expect(getAllByTestId("inbox-row")[1]).toHaveClass("cursor-pointer");
    await waitFor(() => expect(h.getInboxItem).toHaveBeenCalledWith({ id: "src-1" }));
    expect(h.select).toHaveBeenCalledWith("src-1");
    expect(getByTestId("inbox-preview-title")).toHaveTextContent("Inbox source");
    expect(getByTestId("inbox-preview-url")).toHaveAttribute("href", "https://example.com/article");
    expect(getByTestId("inbox-preview-url")).toHaveAttribute("target", "_blank");
    // Canonical/author/accessed metadata moved to the shell inspector's Source
    // section (covered by Inspector.test.tsx); the inbox preview is article-only.
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

    const { findByTestId, getAllByTestId } = render(<InboxHarness />);

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
    const { getByTestId, findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-read-now");
    expect(getByTestId("mock-balance-triage-inbox")).toHaveTextContent("Show triage actions");
    fireEvent.click(getByTestId("mock-balance-triage-inbox"));

    // Focus is set synchronously by the reveal; the highlight rides the payload
    // re-publish (InboxScreen → inspector section), so it can land a cycle later.
    await waitFor(() => expect(getByTestId("inbox-read-now")).toHaveFocus());
    await waitFor(() =>
      expect(getByTestId("inbox-triage-actions")).toHaveAttribute("data-highlighted", "true"),
    );
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("honors a balance banner triage click while the selected item is still loading", async () => {
    let resolveDetail!: (value: { detail: ReturnType<typeof detail> }) => void;
    h.getInboxItem.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDetail = resolve;
      }),
    );
    const { getByTestId, findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("mock-balance-triage-inbox"));
    resolveDetail({ detail: detail("src-1") });

    await findByTestId("inbox-read-now");
    await waitFor(() => expect(getByTestId("inbox-read-now")).toHaveFocus());
    // The highlight flows through the payload re-publish (InboxScreen → inspector
    // section), so it lands a render cycle after focus — wait for it.
    await waitFor(() =>
      expect(getByTestId("inbox-triage-actions")).toHaveAttribute("data-highlighted", "true"),
    );
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
    const { getAllByTestId, getByTestId, findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("mock-balance-triage-inbox"));
    const secondRow = getAllByTestId("inbox-row")[1];
    if (!secondRow) throw new Error("expected a second inbox row");
    fireEvent.click(secondRow);
    resolveFirstDetail({ detail: detail("src-1") });

    await waitFor(() =>
      expect(getByTestId("inbox-preview-title")).toHaveTextContent("Second source"),
    );
    // Wait for the relocated triage section to settle on the second source before
    // asserting the no-replay-focus guarantee — under parallel test load the section
    // can mount a tick after the preview title updates, so a synchronous getByTestId
    // here is load-flaky. The intent stands: read-now is present but NOT auto-focused.
    const readNow = await findByTestId("inbox-read-now");
    expect(readNow).not.toHaveFocus();
    expect(getByTestId("inbox-triage-actions")).not.toHaveAttribute("data-highlighted", "true");
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("clears the published triage payload when InboxScreen unmounts (no cross-route leak)", async () => {
    const { findByTestId, queryByTestId, rerender } = render(
      <ConditionalInboxHarness mount={true} />,
    );

    // The payload publishes for the selected inbox source -> the probe renders the section.
    await findByTestId("inbox-read-now");

    // Unmounting InboxScreen (e.g. navigating to another route) must clear the payload
    // via its cleanup effect, so the triage section can never paint on other routes.
    rerender(<ConditionalInboxHarness mount={false} />);
    await waitFor(() => expect(queryByTestId("inbox-read-now")).not.toBeInTheDocument());
  });

  it("reads now by activating the selected item and navigating to the source reader", async () => {
    const { getByTestId, findByTestId, getByRole } = render(<InboxHarness />);

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
    const { getByTestId, findByTestId } = render(<InboxHarness />);

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
    const { getByTestId, findByTestId, queryByText } = render(<InboxHarness />);

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
    const { getAllByTestId, getByTestId, findByTestId } = render(<InboxHarness />);

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
    const { findByTestId } = render(<InboxHarness />);

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

    const { findByTestId, queryByTestId } = render(<InboxHarness />);

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

    const { findByTestId, queryByTestId } = render(<InboxHarness />);

    expect(await findByTestId("inbox-preview-body")).toHaveTextContent(
      "Full text survives malformed formatted JSON.",
    );
    expect(queryByTestId("mock-source-editor")).not.toBeInTheDocument();
  });

  it("reprioritizes the selected item through the bridge", async () => {
    const { getByTestId, findByTestId } = render(<InboxHarness />);

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
    const { findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-read-now");
    fireEvent.keyDown(window, { key: "1" });

    expect(await findByTestId("inbox-error")).toHaveTextContent("cannot activate");
    expect(h.navigate).not.toHaveBeenCalled();
  });

  it("uses the 2 shortcut for Queue soon and does not navigate", async () => {
    const { findByTestId } = render(<InboxHarness />);

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
    const { findByTestId, getByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-read-now");
    h.listInbox.mockClear();
    fireEvent.click(getByTestId("inbox-read-now"));

    expect(await findByTestId("inbox-error")).toHaveTextContent("no longer available");
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.listInbox).toHaveBeenCalled();
  });

  it("opens import modals and refreshes after child imports", async () => {
    const { getByTestId, findByTestId } = render(<InboxHarness />);

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
    const { getByTestId, findByTestId, queryByTestId } = render(<InboxHarness />);

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
    const { getByTestId, findByTestId, queryByTestId } = render(<InboxHarness />);

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
    const { getByTestId, findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-import-paste-url");
    expect(getByTestId("inbox-import-paste-url")).toHaveClass("cursor-pointer");
    expect(getByTestId("inbox-import-import-pdf")).toHaveClass("cursor-pointer");
    expect(getByTestId("inbox-import-browser-capture")).toHaveClass("cursor-pointer");
  });

  it("imports PDF/media and routes browser capture to settings", async () => {
    const { getByTestId, findByTestId } = render(<InboxHarness />);

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
    const { getByTestId, findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-import-import-pdf");
    fireEvent.click(getByTestId("inbox-import-import-pdf"));
    expect(await findByTestId("inbox-error")).toHaveTextContent("password-protected");
  });

  it("renders inbox zero when there are no items", async () => {
    h.listInbox.mockResolvedValue({ items: [] });
    const { findByTestId } = render(<InboxHarness />);

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
    const { findAllByTestId, getAllByTestId, getByTestId } = render(<InboxHarness />);

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
    const { findByTestId, getByTestId, getAllByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-group-by-domain"));
    const labels = getAllByTestId("inbox-group-label").map((n) => n.textContent);
    expect(labels).toContain("other.com");
  });

  it("click selects a single row; the bulk panel stays hidden at size 1", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));

    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");
    expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument();
    // size === 1 keeps the per-item detail pane.
    expect(getByTestId("inbox-preview")).toBeInTheDocument();
  });

  it("shift-click selects the contiguous range from the anchor", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId, getAllByTestId, getByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-select-all"));
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("4 selected");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument();
    expect(rowById(container, "u1")).not.toHaveAttribute("data-selected", "true");
  });

  it("switching the group-by axis keeps the selected id set", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxHarness />);

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

  it("clears the relocated triage payload when entering multi-select", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.click(rowById(container, "u1"));
    // Single selection -> the inspector triage section is published (probe renders it).
    await findByTestId("inbox-read-now");

    // Extend to two -> multi-select -> the payload is cleared, so triage disappears
    // (it must never show while the bulk panel owns the surface).
    fireEvent.click(rowById(container, "u2"), { metaKey: true });
    expect(getByTestId("inbox-bulk-panel")).toBeInTheDocument();
    expect(queryByTestId("inbox-read-now")).not.toBeInTheDocument();
  });

  it("reverts to the cursor row's detail when the selection empties to 0", async () => {
    mountBulk();
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId, getByTestId } = render(<InboxHarness />);

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
    const { findByTestId, getAllByTestId, getByTestId } = render(<InboxHarness />);

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
    const { findByTestId, getAllByTestId, getByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId, getAllByTestId, getByTestId } = render(<InboxHarness />);

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
    const { findByTestId, getByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-select-all"));
    fireEvent.click(getByTestId("inbox-bulk-queue-soon"));

    expect(await findByTestId("inbox-snackbar")).toHaveTextContent("Queued 12 · 2 skipped");
  });

  it("does not show the bulk panel for an empty selection", async () => {
    mountBulk();
    const { findByTestId, queryByTestId } = render(<InboxHarness />);

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
      <InboxHarness />,
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
    const { findByTestId, getByTestId } = render(<InboxHarness />);

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
    const { findByTestId, getAllByTestId, getByTestId } = render(<InboxHarness />);

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
    const { findByTestId, getAllByTestId, getByTestId } = render(<InboxHarness />);

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

  it("the snackbar Undo calls bulkTriageInboxUndo with the batch id, refreshes, and dispatches UNDO_EVENT", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-undo",
      applied: 2,
      skipped: [],
      errored: [],
    });
    h.bulkTriageInboxUndo.mockResolvedValue({ undone: true, count: 2 });
    const undoListener = vi.fn();
    window.addEventListener("interleave:undo", undoListener);
    const { findByTestId, getByTestId, queryByTestId } = render(<InboxHarness />);

    try {
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
      // A successful undo dispatches the global UNDO_EVENT and surfaces no error.
      await waitFor(() => expect(undoListener).toHaveBeenCalledTimes(1));
      expect(queryByTestId("inbox-error")).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("interleave:undo", undoListener);
    }
  });

  it("surfaces a REFUSED bulk undo as an inbox error and does NOT dispatch UNDO_EVENT", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-refuse",
      applied: 2,
      skipped: [],
      errored: [],
    });
    // The movement guard refused — a victim moved since the batch wrote it.
    h.bulkTriageInboxUndo.mockResolvedValue({
      undone: false,
      count: 0,
      reason: "One or more items changed",
    });
    const undoListener = vi.fn();
    window.addEventListener("interleave:undo", undoListener);
    const { findByTestId, getByTestId } = render(<InboxHarness />);

    try {
      await findByTestId("inbox-list");
      fireEvent.click(getByTestId("inbox-select-all"));
      fireEvent.click(getByTestId("inbox-bulk-queue-soon"));

      const undo = await findByTestId("inbox-snackbar-undo");
      fireEvent.click(undo);

      await waitFor(() =>
        expect(h.bulkTriageInboxUndo).toHaveBeenCalledWith({ batchId: "batch-refuse" }),
      );
      // The refusal reason is surfaced honestly via the inbox error UI...
      expect(await findByTestId("inbox-error")).toHaveTextContent("One or more items changed");
      // ...and a refused undo must NOT look like a success: no UNDO_EVENT fires.
      expect(undoListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("interleave:undo", undoListener);
    }
  });

  it("fires only ONE undo call when the snackbar Undo is double-clicked", async () => {
    mountBulk();
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-dbl",
      applied: 2,
      skipped: [],
      errored: [],
    });
    // Keep the undo in-flight so a second click can race the first.
    let resolveUndo!: (value: { undone: boolean; count: number }) => void;
    h.bulkTriageInboxUndo.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveUndo = resolve;
      }),
    );
    const { findByTestId, getByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.click(getByTestId("inbox-select-all"));
    fireEvent.click(getByTestId("inbox-bulk-queue-soon"));

    const undo = await findByTestId("inbox-snackbar-undo");
    fireEvent.click(undo);
    fireEvent.click(undo);

    // The in-flight guard collapses the double-click into exactly one undo IPC call.
    await waitFor(() => expect(h.bulkTriageInboxUndo).toHaveBeenCalledTimes(1));
    resolveUndo({ undone: true, count: 2 });
    await waitFor(() => expect(h.bulkTriageInboxUndo).toHaveBeenCalledTimes(1));
  });

  it("an errored sweep surfaces 'failed' and a fully-errored removing sweep KEEPS the selection", async () => {
    mountBulk();
    // One id errored, applied 0 — the whole tx aborted (the errored-channel shape).
    h.bulkTriageInbox.mockResolvedValue({
      batchId: "batch-err",
      applied: 0,
      skipped: [],
      errored: [{ id: "u1", error: "disk on fire" }],
    });
    const { container, findByTestId, getAllByTestId, getByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    // Select the two URL rows (u1, u2), then fire a REMOVING verb (Queue soon).
    fireEvent.click(getAllByTestId("inbox-select-group")[0] as HTMLElement);
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("2 selected");
    fireEvent.click(getByTestId("inbox-bulk-queue-soon"));

    await waitFor(() => expect(h.bulkTriageInbox).toHaveBeenCalledTimes(1));
    // The snackbar message includes the "N failed" tally (via bulkResultMessage).
    expect(await findByTestId("inbox-snackbar")).toHaveTextContent("1 failed");
    // The aria-live announce string also includes the "N failed." tally.
    expect(getByTestId("inbox-announce")).toHaveTextContent("1 failed.");
    // applied === 0 on a removing verb must NOT clear the selection (so the user retries):
    // the bulk panel still shows the count and the rows stay selected.
    expect(getByTestId("inbox-bulk-panel")).toBeInTheDocument();
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("2 selected");
    expect(rowById(container, "u1")).toHaveAttribute("data-selected", "true");
    expect(rowById(container, "u2")).toHaveAttribute("data-selected", "true");
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
    const { findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    // The inbox is the active triage surface — the shell defers `o`/`u`/`+`/`-`.
    await waitFor(() => expect(isScopeActive("triage")).toBe(true));
    expect(hasActiveScope()).toBe(true);
  });

  it("⌘Z is NOT bound by the inbox scope — it never fires a bulk undo (global undo always works)", async () => {
    mountBulk();
    const { container, findByTestId } = render(<InboxHarness />);

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
    const { findByTestId } = render(<InboxHarness />);

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
    const { findByTestId } = render(<InboxHarness />);

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
    const { findByTestId } = render(<InboxHarness />);

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
    const { findByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId, getByTestId } = render(<InboxHarness />);

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
    const { container, findByTestId, getByTestId, queryByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    fireEvent.keyDown(window, { key: "a", metaKey: true });
    expect(getByTestId("inbox-bulk-headline")).toHaveTextContent("4 selected");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(queryByTestId("inbox-bulk-panel")).not.toBeInTheDocument();
    expect(rowById(container, "u1")).not.toHaveAttribute("data-selected", "true");
  });
});

// --- Suggested priority & placement (T127 — U6): chip / justification / accept. ---

/** A banded suggestion DTO for one id (semantic + author-yield signals). */
function bandedSuggestion(
  band: "A" | "B" | "C" | "D",
  extra?: { placement?: { conceptId: string; conceptName: string } },
) {
  return {
    kind: "suggestion" as const,
    band,
    justification: {
      signals: [
        { kind: "semantic" as const, neighborCount: 2, lean: band },
        {
          kind: "authorYield" as const,
          workedSourceCount: 3,
          totalCards: 11,
          totalMatureCards: 4,
          band: "high" as const,
        },
      ],
    },
    signalHash: `hash-${band}`,
    ...extra,
  };
}

describe("InboxScreen triage suggestions (T127 — U6)", () => {
  it("renders a band chip + justification for a suggestion; no chip for insufficient_signal", async () => {
    // src-1 (priority 0.375 = band C) gets a band-A suggestion; src-2 stays insufficient.
    h.suggestTriage.mockResolvedValue({
      results: [
        { id: "src-1", suggestion: bandedSuggestion("A") },
        { id: "src-2", suggestion: { kind: "insufficient_signal", reason: "no_signal_fired" } },
      ],
    });
    const { container, findByTestId, getAllByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    // The suggested row carries the chip + the formatted justification line.
    await waitFor(() => {
      const chips = getAllByTestId("inbox-suggestion-chip");
      expect(chips.length).toBeGreaterThan(0);
    });
    const row1 = rowById(container, "src-1");
    const chip = within(row1).getByTestId("inbox-suggestion-chip");
    expect(chip).toHaveAttribute("data-suggested-band", "A");
    expect(within(row1).getByTestId("inbox-row-justification")).toHaveTextContent(
      "Near 2 priority-A neighbors · This author's last 3 sources made 11 cards",
    );

    // The insufficient row renders NO chip (and no pending placeholder once resolved).
    const row2 = rowById(container, "src-2");
    expect(within(row2).queryByTestId("inbox-suggestion-chip")).not.toBeInTheDocument();
    expect(within(row2).queryByTestId("inbox-suggestion-pending")).not.toBeInTheDocument();
  });

  it("shows a pending placeholder while the batch fetch is in flight, then resolves", async () => {
    let resolveSuggest!: (value: {
      results: { id: string; suggestion: ReturnType<typeof bandedSuggestion> }[];
    }) => void;
    h.suggestTriage.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSuggest = resolve;
      }),
    );
    const { container, findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    // In flight: the row shows the neutral pending placeholder, not a blank.
    const row1 = rowById(container, "src-1");
    expect(within(row1).getByTestId("inbox-suggestion-pending")).toBeInTheDocument();
    expect(within(row1).queryByTestId("inbox-suggestion-chip")).not.toBeInTheDocument();

    resolveSuggest({ results: [{ id: "src-1", suggestion: bandedSuggestion("A") }] });
    await waitFor(() =>
      expect(
        within(rowById(container, "src-1")).getByTestId("inbox-suggestion-chip"),
      ).toBeInTheDocument(),
    );
  });

  it("Enter on the cursor row accepts the suggested band with `accepted` provenance", async () => {
    h.suggestTriage.mockResolvedValue({
      results: [
        { id: "src-1", suggestion: bandedSuggestion("A") },
        { id: "src-2", suggestion: { kind: "insufficient_signal", reason: "no_signal_fired" } },
      ],
    });
    h.triageInboxItem.mockResolvedValue({
      item: { ...items[0], priority: 0.875 },
      deleted: false,
    });
    const { container, findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    await waitFor(() =>
      expect(
        within(rowById(container, "src-1")).getByTestId("inbox-suggestion-chip"),
      ).toBeInTheDocument(),
    );
    // The first row (src-1) is the cursor row.
    fireEvent.keyDown(window, { key: "Enter" });

    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: {
          kind: "setPriority",
          priority: "A",
          suggestion: {
            decision: "accepted",
            suggestedBand: "A",
            signalKinds: ["semantic", "authorYield"],
            signalHash: "hash-A",
          },
        },
      }),
    );
  });

  it("the preview accept affordance accepts the suggested band (accepted provenance)", async () => {
    h.suggestTriage.mockResolvedValue({
      results: [{ id: "src-1", suggestion: bandedSuggestion("A") }],
    });
    h.triageInboxItem.mockResolvedValue({
      item: { ...items[0], priority: 0.875 },
      deleted: false,
    });
    const { findByTestId, queryByTestId } = render(<InboxHarness />);

    // The preview pane suggestion block carries the accept chip + the justification.
    const suggestion = await findByTestId("inbox-suggestion");
    expect(within(suggestion).getByTestId("inbox-suggestion-justification")).toHaveTextContent(
      "Near 2 priority-A",
    );
    const accept = within(suggestion).getByTestId("inbox-suggestion-chip");
    fireEvent.click(accept);

    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: expect.objectContaining({
          kind: "setPriority",
          priority: "A",
          suggestion: expect.objectContaining({ decision: "accepted", suggestedBand: "A" }),
        }),
      }),
    );
    // After a successful accept the chip drops (suppress-when-equal, no clobber).
    await waitFor(() => expect(queryByTestId("inbox-suggestion-justification")).toBeNull());
  });

  it("picking a DIFFERENT priority chip overrides with `overridden` provenance", async () => {
    // src-1 suggests A; the user clicks B instead → overridden.
    h.suggestTriage.mockResolvedValue({
      results: [{ id: "src-1", suggestion: bandedSuggestion("A") }],
    });
    h.triageInboxItem.mockResolvedValue({
      item: { ...items[0], priority: 0.625 },
      deleted: false,
    });
    const { findByTestId, getByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-suggestion");
    fireEvent.click(getByTestId("inbox-priority-B"));

    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: {
          kind: "setPriority",
          priority: "B",
          suggestion: {
            decision: "overridden",
            suggestedBand: "A",
            signalKinds: ["semantic", "authorYield"],
            signalHash: "hash-A",
          },
        },
      }),
    );
  });

  it("a plain priority set with no suggestion carries no provenance marker", async () => {
    // No suggestion for src-1 (default insufficient) → a chip click is a manual set.
    h.triageInboxItem.mockResolvedValue({
      item: { ...items[0], priority: 0.875 },
      deleted: false,
    });
    const { findByTestId, getByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-priority-A");
    await waitFor(() => expect(h.suggestTriage).toHaveBeenCalled());
    fireEvent.click(getByTestId("inbox-priority-A"));

    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "setPriority", priority: "A" },
      }),
    );
  });

  it("placement accept calls assignConcept; the chip flips to assigned; re-accept is a no-op", async () => {
    h.suggestTriage.mockResolvedValue({
      results: [
        {
          id: "src-1",
          suggestion: bandedSuggestion("A", {
            placement: { conceptId: "concept-1", conceptName: "Statistics" },
          }),
        },
      ],
    });
    const { findByTestId, getByTestId, queryByTestId } = render(<InboxHarness />);

    const accept = await findByTestId("inbox-suggestion-placement-accept");
    expect(accept).toHaveTextContent("Statistics");
    fireEvent.click(accept);

    await waitFor(() =>
      expect(h.assignConcept).toHaveBeenCalledWith({
        elementId: "src-1",
        conceptId: "concept-1",
      }),
    );
    // The chip flips to the confirmed "assigned" state; the accept button is gone.
    expect(await findByTestId("inbox-suggestion-placement-assigned")).toHaveTextContent(
      "Statistics",
    );
    expect(queryByTestId("inbox-suggestion-placement-accept")).not.toBeInTheDocument();

    // Re-accept is a no-op (only one assignConcept call ever fired).
    h.assignConcept.mockClear();
    void getByTestId; // (assigned state has no accept button to click)
    expect(h.assignConcept).not.toHaveBeenCalled();
  });

  it("staleness: accepting a band that already matches the live priority does not clobber", async () => {
    // src-2's live priority is 0.875 (band A); a stale suggestion still says A.
    // Selecting src-2 then Enter must NOT write (the band already matches) — drop the chip.
    h.selectedId = "src-2";
    h.suggestTriage.mockResolvedValue({
      results: [
        { id: "src-1", suggestion: { kind: "insufficient_signal", reason: "no_signal_fired" } },
        { id: "src-2", suggestion: bandedSuggestion("A") },
      ],
    });
    const { container, findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    // Move the cursor to src-2 (the band-A row whose live priority is already A).
    fireEvent.click(rowById(container, "src-2"));
    await waitFor(() =>
      expect(
        within(rowById(container, "src-2")).getByTestId("inbox-suggestion-chip"),
      ).toBeInTheDocument(),
    );
    h.triageInboxItem.mockClear();

    fireEvent.keyDown(window, { key: "Enter" });
    // No write — accepting a no-op band must not clobber, and the chip drops.
    await waitFor(() =>
      expect(
        within(rowById(container, "src-2")).queryByTestId("inbox-suggestion-chip"),
      ).not.toBeInTheDocument(),
    );
    expect(h.triageInboxItem).not.toHaveBeenCalled();
  });

  it("Enter is a no-op when the cursor row has no suggestion", async () => {
    // Default: every row is insufficient → Enter writes nothing.
    const { findByTestId } = render(<InboxHarness />);

    await findByTestId("inbox-list");
    await waitFor(() => expect(h.suggestTriage).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "Enter" });

    // A short grace period, then assert nothing was written.
    await waitFor(() => expect(h.suggestTriage).toHaveBeenCalled());
    expect(h.triageInboxItem).not.toHaveBeenCalled();
  });
});
