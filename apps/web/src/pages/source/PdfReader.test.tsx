import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  getSourcePdfData: vi.fn(),
  getOcr: vi.fn(),
  setReadPoint: vi.fn(),
  createExtraction: vi.fn(),
  runOcr: vi.fn(),
  acceptOcr: vi.fn(),
  dismissOcr: vi.fn(),
  subscribeJobs: vi.fn(),
  toast: vi.fn(),
  onActivePageChange: vi.fn(),
  onRegionExtracted: vi.fn(),
  textItemsByPage: new Map<number, unknown[]>([
    [1, [{ str: "Page one" }]],
    [2, [{ str: "Page two" }]],
  ]),
  docDestroy: vi.fn(),
}));

vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "/mock-pdf-worker.mjs" }));

vi.mock("pdfjs-dist", () => {
  class TextLayer {
    container: HTMLElement;

    constructor({ container }: { container: HTMLElement }) {
      this.container = container;
    }

    async render() {
      const span = document.createElement("span");
      span.textContent = "Selectable PDF text";
      this.container.append(span);
    }
  }

  function fakePage(pageNumber: number) {
    return {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 100 * scale,
        height: 140 * scale,
      }),
      getTextContent: vi.fn(async () => ({
        items: h.textItemsByPage.get(pageNumber) ?? [],
      })),
      render: vi.fn(() => ({ promise: Promise.resolve() })),
      cleanup: vi.fn(),
    };
  }

  return {
    GlobalWorkerOptions: { workerSrc: "" },
    TextLayer,
    getDocument: vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: vi.fn((pageNumber: number) => Promise.resolve(fakePage(pageNumber))),
        destroy: h.docDestroy,
      }),
    })),
  };
});

vi.mock("../../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/appApi")>("../../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      getSourcePdfData: h.getSourcePdfData,
      getOcr: h.getOcr,
      setReadPoint: h.setReadPoint,
      createExtraction: h.createExtraction,
      runOcr: h.runOcr,
      acceptOcr: h.acceptOcr,
      dismissOcr: h.dismissOcr,
      subscribeJobs: h.subscribeJobs,
    },
  };
});

import { PdfReader } from "./PdfReader";

beforeEach(() => {
  h.desktop = true;
  h.getSourcePdfData.mockReset();
  h.getOcr.mockReset();
  h.setReadPoint.mockReset();
  h.createExtraction.mockReset();
  h.runOcr.mockReset();
  h.acceptOcr.mockReset();
  h.dismissOcr.mockReset();
  h.subscribeJobs.mockReset();
  h.toast.mockReset();
  h.onActivePageChange.mockReset();
  h.onRegionExtracted.mockReset();
  h.docDestroy.mockReset();
  h.textItemsByPage = new Map<number, unknown[]>([
    [1, [{ str: "Page one" }]],
    [2, [{ str: "Page two" }]],
  ]);
  h.getSourcePdfData.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]).buffer });
  h.getOcr.mockResolvedValue({ pages: [] });
  h.setReadPoint.mockResolvedValue({});
  h.createExtraction.mockResolvedValue({ id: "extract-1" });
  h.runOcr.mockResolvedValue({ jobId: "job-1" });
  h.acceptOcr.mockResolvedValue({ accepted: true });
  h.dismissOcr.mockResolvedValue({});
  h.subscribeJobs.mockReturnValue(vi.fn());

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => ({
      setTransform: vi.fn(),
      drawImage: vi.fn(),
    })),
  });
  HTMLCanvasElement.prototype.toBlob = vi.fn((callback: BlobCallback) => {
    callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  });
});

function renderReader() {
  return render(
    <PdfReader
      elementId="src-1"
      blockPages={{ "blk-page-1": 1, "blk-page-2": 2 }}
      onActivePageChange={h.onActivePageChange}
      onRegionExtracted={h.onRegionExtracted}
      toast={h.toast}
    />,
  );
}

describe("PdfReader", () => {
  it("renders the desktop-only fallback without loading bytes", () => {
    h.desktop = false;
    const { getByTestId } = renderReader();

    expect(getByTestId("pdf-reader-no-desktop")).toHaveTextContent("Open the desktop app");
    expect(h.getSourcePdfData).not.toHaveBeenCalled();
  });

  it("shows the empty-vault state when no PDF bytes are available", async () => {
    h.getSourcePdfData.mockResolvedValueOnce({ bytes: null });
    const { findByTestId } = renderReader();

    expect(await findByTestId("pdf-reader-empty")).toHaveTextContent("no PDF bytes");
  });

  it("loads PDF pages, reports the active page, and persists page read-points", async () => {
    const { getByTestId, findByTestId } = renderReader();

    expect(await findByTestId("pdf-page-1")).toBeInTheDocument();
    expect(getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 2");
    expect(h.getSourcePdfData).toHaveBeenCalledWith({ elementId: "src-1" });
    expect(h.onActivePageChange).toHaveBeenCalledWith(1, 2);

    fireEvent.click(getByTestId("pdf-set-readpoint"));
    await waitFor(() =>
      expect(h.setReadPoint).toHaveBeenCalledWith({
        elementId: "src-1",
        documentId: "src-1",
        blockId: "blk-page-1",
        offset: 0,
      }),
    );
    expect(h.toast).toHaveBeenCalledWith("Read-point set on page 1");
  });

  it("extracts selected page text with the page's first block id", async () => {
    const { getByTestId, findByTestId } = renderReader();
    const page = await findByTestId("pdf-page-1");
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
      toString: () => "Selected PDF text",
      anchorNode: page,
      removeAllRanges: vi.fn(),
    } as unknown as Selection);

    fireEvent.click(getByTestId("pdf-extract"));

    await waitFor(() =>
      expect(h.createExtraction).toHaveBeenCalledWith({
        sourceElementId: "src-1",
        selectedText: "Selected PDF text",
        blockIds: ["blk-page-1"],
        page: 1,
      }),
    );
    expect(h.toast).toHaveBeenCalledWith("Extracted from page 1");
  });

  it("prompts for OCR on scanned pages and accepts recognized text", async () => {
    h.textItemsByPage = new Map<number, unknown[]>([
      [1, []],
      [2, [{ str: "Page two" }]],
    ]);
    h.getOcr.mockResolvedValueOnce({
      pages: [
        {
          page: 1,
          status: "suggested",
          text: "Recognized text",
          meanConfidence: 51,
        },
      ],
    });
    h.getOcr.mockResolvedValue({
      pages: [
        {
          page: 1,
          status: "accepted",
          text: "Recognized text",
          meanConfidence: 51,
        },
      ],
    });

    const { getByTestId, findByTestId } = renderReader();

    expect(await findByTestId("pdf-ocr-suggestion")).toHaveTextContent("Recognized text");
    expect(getByTestId("pdf-ocr-confidence")).toHaveTextContent("low");

    fireEvent.click(getByTestId("pdf-ocr-accept"));
    await waitFor(() => expect(h.acceptOcr).toHaveBeenCalledWith({ elementId: "src-1", page: 1 }));
    expect(h.toast).toHaveBeenCalledWith("OCR accepted into page 1");
  });

  it("shows a friendly extraction prompt when nothing is selected", async () => {
    const { getByTestId, findByTestId } = renderReader();
    await findByTestId("pdf-page-1");
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
      toString: () => "",
    } as unknown as Selection);

    fireEvent.click(getByTestId("pdf-extract"));

    expect(h.createExtraction).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith("Select some text on the page first");
  });
});
