import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let documents: DocumentRepository;
let elements: ElementRepository;
let ops: OperationLogRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  documents = new DocumentRepository(handle.db);
  elements = new ElementRepository(handle.db);
  ops = new OperationLogRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function createSource() {
  return elements.create({
    type: "source",
    status: "active",
    stage: "raw_source",
    priority: 0.5,
    title: "Source",
  });
}

function seedDocument(elementId: ElementId) {
  documents.upsert({
    elementId,
    prosemirrorJson: { type: "doc", content: [] },
    plainText: "seed",
    blocks: [
      { blockType: "paragraph", order: 0, stableBlockId: "blk-a" as BlockId },
      { blockType: "paragraph", order: 1, stableBlockId: "blk-b" as BlockId },
    ],
  });
}

describe("DocumentRepository direct behavior", () => {
  it("upserts document bodies and replaces stable block metadata atomically", () => {
    const source = createSource();

    documents.upsert({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "old",
      blocks: [
        {
          blockType: "heading",
          order: 0,
          stableBlockId: "blk-old" as BlockId,
          page: 1,
          timestampMs: 1000,
        },
      ],
    });
    documents.upsert({
      elementId: source.id,
      prosemirrorJson: { type: "doc", content: [{ type: "paragraph" }] },
      plainText: "new",
      schemaVersion: 2,
      blocks: [
        {
          blockType: "paragraph",
          order: 0,
          stableBlockId: "blk-new" as BlockId,
          page: 3,
          timestampMs: 2500,
        },
      ],
    });

    expect(documents.findById(source.id)).toMatchObject({
      plainText: "new",
      schemaVersion: 2,
    });
    const blocks = documents.listBlocks(source.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      stableBlockId: "blk-new",
      page: 3,
      timestampMs: 2500,
    });
    expect(
      ops.listForElement(source.id).filter((op) => op.opType === "update_document"),
    ).toHaveLength(2);
  });

  it("upserts read-points and logs each set_read_point mutation", () => {
    const source = createSource();
    seedDocument(source.id);

    documents.setReadPoint({
      elementId: source.id,
      documentId: source.id,
      blockId: "blk-a" as BlockId,
      offset: 3,
    });
    documents.setReadPoint({
      elementId: source.id,
      documentId: source.id,
      blockId: "blk-b" as BlockId,
      offset: 7,
    });

    expect(documents.getReadPoint(source.id)).toMatchObject({ blockId: "blk-b", offset: 7 });
    const readPointOps = ops
      .listForElement(source.id)
      .filter((op) => op.opType === "set_read_point");
    expect(readPointOps).toHaveLength(2);
    expect(readPointOps[0]?.payload).toMatchObject({ blockId: "blk-b", offset: 7 });
  });

  it("adds, filters, and removes document marks with parsed attrs/ranges", () => {
    const source = createSource();
    seedDocument(source.id);
    const highlight = documents.addMark({
      elementId: source.id,
      blockId: "blk-a" as BlockId,
      markType: "highlight",
      range: [2, 8],
      attrs: { color: "yellow" },
    });
    const processed = documents.addMark({
      elementId: source.id,
      blockId: "blk-b" as BlockId,
      markType: "processed_span",
      range: [0, 4],
    });

    expect(documents.listMarks(source.id).map((mark) => mark.id)).toEqual([
      highlight.id,
      processed.id,
    ]);
    expect(documents.listMarksByType(source.id, "highlight")).toEqual([
      expect.objectContaining({
        id: highlight.id,
        range: [2, 8],
        attrs: { color: "yellow" },
      }),
    ]);
    expect(documents.removeMark(highlight.id)).toBe(true);
    expect(documents.removeMark("missing")).toBe(false);
    expect(documents.listMarks(source.id).map((mark) => mark.id)).toEqual([processed.id]);
  });
});
