import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  pickImportFile: vi.fn(),
  importEpubSource: vi.fn(),
  importDocumentSource: vi.fn(),
  importHighlights: vi.fn(),
  importAnki: vi.fn(),
}));

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      pickImportFile: h.pickImportFile,
      importEpubSource: h.importEpubSource,
      importDocumentSource: h.importDocumentSource,
      importHighlights: h.importHighlights,
      importAnki: h.importAnki,
    },
  };
});

import { ImportFileModal } from "./ImportFileModal";

beforeEach(() => {
  h.desktop = true;
  h.pickImportFile.mockReset();
  h.importEpubSource.mockReset();
  h.importDocumentSource.mockReset();
  h.importHighlights.mockReset();
  h.importAnki.mockReset();
  h.pickImportFile.mockResolvedValue({ paths: ["/vault/book.epub"] });
  h.importEpubSource.mockResolvedValue({ status: "imported", bookId: "book-1" });
  h.importDocumentSource.mockResolvedValue({ status: "imported", id: "doc-1" });
  h.importHighlights.mockResolvedValue({
    status: "imported",
    extractCount: 2,
    sourceCount: 1,
    skipped: 1,
    items: [{ id: "source-1" }],
  });
  h.importAnki.mockResolvedValue({
    status: "imported",
    cardCount: 3,
    withHistory: 2,
    item: { id: "deck-1" },
  });
});

describe("ImportFileModal", () => {
  it("renders nothing when closed", () => {
    const { queryByTestId } = render(
      <ImportFileModal open={false} onClose={vi.fn()} onImported={vi.fn()} />,
    );

    expect(queryByTestId("import-file-modal")).toBeNull();
  });

  it("picks and imports an EPUB with priority", async () => {
    const onImported = vi.fn();
    const { getByTestId, findByTestId } = render(
      <ImportFileModal open initialKind="epub" onClose={vi.fn()} onImported={onImported} />,
    );

    fireEvent.click(getByTestId("import-file-priority-A"));
    fireEvent.click(getByTestId("import-file-choose"));
    expect(await findByTestId("import-file-chosen")).toHaveTextContent("book.epub");
    fireEvent.click(getByTestId("import-file-submit"));

    await waitFor(() =>
      expect(h.importEpubSource).toHaveBeenCalledWith({
        path: "/vault/book.epub",
        priority: "A",
      }),
    );
    expect(onImported).toHaveBeenCalledWith("book-1");
  });

  it("switches kind, clears the chosen path, and imports Markdown through document import", async () => {
    h.pickImportFile.mockResolvedValue({ paths: ["/vault/note.md"] });
    const onImported = vi.fn();
    const { getByTestId, queryByTestId, findByTestId } = render(
      <ImportFileModal open initialKind="epub" onClose={vi.fn()} onImported={onImported} />,
    );

    fireEvent.click(getByTestId("import-file-choose"));
    expect(await findByTestId("import-file-chosen")).toHaveTextContent("note.md");
    fireEvent.click(getByTestId("import-file-kind-markdown"));
    expect(queryByTestId("import-file-chosen")).toBeNull();

    fireEvent.click(getByTestId("import-file-choose"));
    await findByTestId("import-file-chosen");
    fireEvent.click(getByTestId("import-file-submit"));

    await waitFor(() =>
      expect(h.importDocumentSource).toHaveBeenCalledWith({
        path: "/vault/note.md",
        format: "markdown",
        priority: "C",
      }),
    );
    expect(onImported).toHaveBeenCalledWith("doc-1");
  });

  it("shows highlight and Anki import summaries while refreshing the parent", async () => {
    const onImported = vi.fn();
    const onHighlightsImported = vi.fn();
    const { getByTestId, findByTestId } = render(
      <ImportFileModal
        open
        initialKind="highlights"
        onClose={vi.fn()}
        onImported={onImported}
        onHighlightsImported={onHighlightsImported}
      />,
    );

    fireEvent.click(getByTestId("import-file-choose"));
    await findByTestId("import-file-chosen");
    fireEvent.click(getByTestId("import-file-submit"));
    expect(await findByTestId("import-file-success")).toHaveTextContent(
      "Imported 2 highlights into 1 source, 1 skipped.",
    );
    expect(onHighlightsImported).toHaveBeenCalledWith("source-1");

    fireEvent.click(getByTestId("import-file-kind-anki"));
    h.pickImportFile.mockResolvedValue({ paths: ["/vault/deck.apkg"] });
    fireEvent.click(getByTestId("import-file-choose"));
    await waitFor(() => expect(getByTestId("import-file-chosen")).toHaveTextContent("deck.apkg"));
    fireEvent.click(getByTestId("import-file-submit"));
    expect(await findByTestId("import-file-success")).toHaveTextContent(
      "Imported 3 cards (2 with scheduling carried over).",
    );
    expect(onHighlightsImported).toHaveBeenCalledWith("deck-1");
    expect(onImported).not.toHaveBeenCalled();
  });

  it("maps picker/import errors and is inert outside desktop", async () => {
    h.pickImportFile.mockRejectedValueOnce(new Error("drm: locked"));
    const { getByTestId, findByTestId, rerender } = render(
      <ImportFileModal open initialKind="epub" onClose={vi.fn()} onImported={vi.fn()} />,
    );

    fireEvent.click(getByTestId("import-file-choose"));
    expect(await findByTestId("import-file-error")).toHaveTextContent("DRM-protected");

    h.desktop = false;
    h.pickImportFile.mockClear();
    rerender(<ImportFileModal open initialKind="epub" onClose={vi.fn()} onImported={vi.fn()} />);
    fireEvent.click(getByTestId("import-file-choose"));
    expect(h.pickImportFile).not.toHaveBeenCalled();
  });
});
