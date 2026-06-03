import type { Readable } from "node:stream";
import type { ElementId } from "@interleave/core";
import { describe, expect, it, vi } from "vitest";
import { type OcrResultData, OcrService } from "./ocr-service";

async function streamToBuffer(source: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function makeService() {
  const ocrPages = {
    upsertPage: vi.fn(),
    listForSource: vi.fn(),
    findPage: vi.fn(),
    setStatus: vi.fn(),
  };
  const documents = {
    findById: vi.fn(),
    listBlocks: vi.fn(),
    upsert: vi.fn(),
  };
  const assetVault = { importAsset: vi.fn() };
  const runner = { enqueue: vi.fn() };
  const service = new OcrService({
    db: {} as never,
    repositories: { ocrPages, documents } as never,
    assetVault: assetVault as never,
    getRunner: () => runner as never,
  });

  return { service, ocrPages, documents, assetVault, runner };
}

const sourceElementId = "source-1" as ElementId;

describe("OcrService", () => {
  it("stores page PNG bytes in the vault before enqueueing an OCR job with a relative path", async () => {
    const { service, assetVault, runner } = makeService();
    runner.enqueue.mockReturnValue({ id: "job-1" });

    const bytes = Buffer.from([1, 2, 3, 4]);
    const result = await service.enqueuePage({
      sourceElementId,
      page: 3,
      imagePng: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });

    expect(result).toEqual({ jobId: "job-1" });
    expect(assetVault.importAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        owningElementId: sourceElementId,
        kind: "snapshot",
        mime: "image/png",
        destRelativePath: "sources/source-1/ocr/page-3.png",
      }),
    );
    const importInput = assetVault.importAsset.mock.calls[0]?.[0] as { source: Readable };
    await expect(streamToBuffer(importInput.source)).resolves.toEqual(bytes);
    expect(runner.enqueue).toHaveBeenCalledWith("ocr", {
      sourceElementId,
      page: 3,
      imagePagePath: "sources/source-1/ocr/page-3.png",
    });
  });

  it("upserts worker OCR results and writes the durable JSON copy best-effort", async () => {
    const { service, ocrPages, assetVault } = makeService();
    ocrPages.upsertPage.mockReturnValue({
      page: 4,
      text: "Recognized text",
      meanConfidence: 91.5,
      status: "suggested",
    });
    const result: OcrResultData = {
      page: 4,
      text: "Recognized text",
      meanConfidence: 91.5,
      words: [
        { text: "Recognized", confidence: 92, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } },
        { text: "text", confidence: 91, bbox: { x0: 5, y0: 6, x1: 7, y1: 8 } },
      ],
    };

    await expect(
      service.applyResult(
        { sourceElementId, page: 4, imagePagePath: "sources/source-1/ocr/page-4.png" },
        result,
      ),
    ).resolves.toEqual({
      page: 4,
      text: "Recognized text",
      meanConfidence: 91.5,
      status: "suggested",
    });

    expect(ocrPages.upsertPage).toHaveBeenCalledWith({
      sourceElementId,
      page: 4,
      text: "Recognized text",
      meanConfidence: 91.5,
      words: result.words,
      status: "suggested",
    });
    expect(assetVault.importAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        owningElementId: sourceElementId,
        kind: "snapshot",
        mime: "application/json",
        destRelativePath: "sources/source-1/ocr/page-4.json",
      }),
    );
  });

  it("lists summaries without leaking OCR row internals", () => {
    const { service, ocrPages } = makeService();
    ocrPages.listForSource.mockReturnValue([
      { id: "ocr-1", page: 1, text: "one", meanConfidence: 80, status: "suggested" },
      { id: "ocr-2", page: 2, text: "two", meanConfidence: 70, status: "dismissed" },
    ]);

    expect(service.listForSource(sourceElementId)).toEqual([
      { page: 1, text: "one", meanConfidence: 80, status: "suggested" },
      { page: 2, text: "two", meanConfidence: 70, status: "dismissed" },
    ]);
  });

  it("accepts OCR text by merging paragraphs after the page heading and marking the row accepted", () => {
    const { service, ocrPages, documents } = makeService();
    ocrPages.findPage.mockReturnValue({
      id: "ocr-1",
      page: 1,
      text: "Line one\n\nLine two",
      meanConfidence: 88,
      status: "suggested",
    });
    documents.findById.mockReturnValue({
      prosemirrorJson: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { blockId: "heading-page-1" },
            content: [{ type: "text", text: "Page 1" }],
          },
          {
            type: "heading",
            attrs: { blockId: "heading-page-2" },
            content: [{ type: "text", text: "Page 2" }],
          },
        ],
      },
    });
    documents.listBlocks.mockReturnValue([
      { blockType: "heading", order: 0, stableBlockId: "heading-page-1", page: 1 },
      { blockType: "heading", order: 1, stableBlockId: "heading-page-2", page: 2 },
    ]);

    expect(service.acceptPage(sourceElementId, 1)).toEqual({ accepted: true });

    const upsertInput = documents.upsert.mock.calls[0]?.[0];
    expect(upsertInput).toEqual(
      expect.objectContaining({
        elementId: sourceElementId,
        plainText: "Page 1\nLine one\nLine two\nPage 2",
      }),
    );
    expect(
      upsertInput.blocks.map((block: { blockType: string; page: number | null }) => ({
        blockType: block.blockType,
        page: block.page,
      })),
    ).toEqual([
      { blockType: "heading", page: 1 },
      { blockType: "paragraph", page: 1 },
      { blockType: "paragraph", page: 1 },
      { blockType: "heading", page: 2 },
    ]);
    expect(ocrPages.setStatus).toHaveBeenCalledWith("ocr-1", "accepted");
  });

  it("does not accept missing or already-accepted OCR pages", () => {
    const { service, ocrPages, documents } = makeService();

    ocrPages.findPage.mockReturnValueOnce(null);
    expect(service.acceptPage(sourceElementId, 1)).toEqual({ accepted: false });

    ocrPages.findPage.mockReturnValueOnce({ id: "ocr-1", status: "accepted" });
    expect(service.acceptPage(sourceElementId, 1)).toEqual({ accepted: false });

    expect(documents.upsert).not.toHaveBeenCalled();
    expect(ocrPages.setStatus).not.toHaveBeenCalled();
  });

  it("dismisses existing OCR suggestions only", () => {
    const { service, ocrPages } = makeService();

    ocrPages.findPage.mockReturnValueOnce(null);
    expect(service.dismissPage(sourceElementId, 1)).toEqual({ dismissed: false });

    ocrPages.findPage.mockReturnValueOnce({ id: "ocr-1" });
    expect(service.dismissPage(sourceElementId, 1)).toEqual({ dismissed: true });
    expect(ocrPages.setStatus).toHaveBeenCalledWith("ocr-1", "dismissed");
  });
});
