import { fireEvent, render, waitFor } from "@testing-library/react";
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
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));

vi.mock("../../components/BalanceBanner", () => ({
  BalanceBanner: ({ refreshKey }: { refreshKey: number }) => (
    <div data-testid="mock-balance-banner">{refreshKey}</div>
  ),
}));

vi.mock("../../shell/selection", () => ({
  useSelection: () => ({ selectedId: h.selectedId, select: h.select }),
}));

vi.mock("./NewSourceModal", () => ({
  NewSourceModal: ({
    open,
    onCreated,
    onClose,
  }: {
    open: boolean;
    onCreated: (id: string) => void;
    onClose: () => void;
  }) =>
    open ? (
      <div data-testid="mock-new-source-modal">
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
  ImportUrlModal: ({ open, onImported }: { open: boolean; onImported: (id: string) => void }) =>
    open ? (
      <button type="button" data-testid="mock-url-import" onClick={() => onImported("url-1")}>
        URL import
      </button>
    ) : null,
}));

vi.mock("./ImportFileModal", () => ({
  ImportFileModal: ({
    open,
    onImported,
    onHighlightsImported,
  }: {
    open: boolean;
    onImported: (id: string) => void;
    onHighlightsImported: (id: string) => void;
  }) =>
    open ? (
      <div data-testid="mock-file-modal">
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
  h.listInbox.mockResolvedValue({ items });
  h.getInboxItem.mockImplementation(({ id }) => Promise.resolve({ detail: detail(id) }));
  h.triageInboxItem.mockResolvedValue({});
  h.importPdfSource.mockResolvedValue({ status: "imported", id: "pdf-1" });
  h.pickImportFile
    .mockResolvedValueOnce({ paths: ["/vault/video.mp4"] })
    .mockResolvedValueOnce({ cancelled: true });
  h.importMediaSource.mockResolvedValue({ status: "imported", id: "media-1" });
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
    await waitFor(() => expect(h.getInboxItem).toHaveBeenCalledWith({ id: "src-1" }));
    expect(h.select).toHaveBeenCalledWith("src-1");
    expect(getByTestId("inbox-preview-title")).toHaveTextContent("Inbox source");
    expect(getByTestId("inbox-count")).toHaveTextContent("2 items awaiting triage");
  });

  it("triages and reprioritizes the selected item through the bridge", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-accept");
    fireEvent.click(getByTestId("inbox-accept"));
    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "accept" },
      }),
    );

    fireEvent.click(getByTestId("inbox-priority-A"));
    await waitFor(() =>
      expect(h.triageInboxItem).toHaveBeenCalledWith({
        id: "src-1",
        action: { kind: "setPriority", priority: "A" },
      }),
    );
  });

  it("opens import modals and refreshes after child imports", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-import-paste-text");
    fireEvent.click(getByTestId("inbox-import-paste-text"));
    fireEvent.click(await findByTestId("mock-new-source-create"));
    await waitFor(() => expect(h.listInbox).toHaveBeenLastCalledWith());

    fireEvent.click(getByTestId("inbox-import-paste-url"));
    fireEvent.click(await findByTestId("mock-url-import"));
    await waitFor(() => expect(h.listInbox).toHaveBeenCalledTimes(3));

    fireEvent.click(getByTestId("inbox-import-import-file"));
    fireEvent.click(await findByTestId("mock-highlights-import"));
    await waitFor(() => expect(h.listInbox).toHaveBeenCalledTimes(4));
  });

  it("imports PDF/media and routes browser capture to settings", async () => {
    const { getByTestId, findByTestId } = render(<InboxScreen />);

    await findByTestId("inbox-import-import-pdf");
    fireEvent.click(getByTestId("inbox-import-import-pdf"));
    await waitFor(() => expect(h.importPdfSource).toHaveBeenCalledWith({}));

    fireEvent.click(getByTestId("inbox-import-import-media"));
    await waitFor(() =>
      expect(h.importMediaSource).toHaveBeenCalledWith({
        path: "/vault/video.mp4",
        subtitlesPath: null,
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
