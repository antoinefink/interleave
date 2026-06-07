import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  documentBlocks,
  documentMarks,
  documents,
  sourceBlockProcessing,
  sourceBlockProcessingOutputs,
} from "./documents";

describe("document schema", () => {
  it("stores editable bodies and stable block lineage anchors separately", () => {
    expect(getTableName(documents)).toBe("documents");
    expect(Object.keys(getTableColumns(documents))).toEqual([
      "elementId",
      "prosemirrorJson",
      "plainText",
      "schemaVersion",
      "updatedAt",
    ]);

    const blockColumns = getTableColumns(documentBlocks);
    expect(getTableName(documentBlocks)).toBe("document_blocks");
    expect(Object.keys(blockColumns)).toEqual([
      "id",
      "documentId",
      "blockType",
      "order",
      "stableBlockId",
      "page",
      "timestampMs",
    ]);
    expect(blockColumns.stableBlockId.name).toBe("stable_block_id");
    expect(blockColumns.timestampMs.name).toBe("timestamp_ms");
  });

  it("keeps editor marks keyed by document and stable block id", () => {
    const columns = getTableColumns(documentMarks);

    expect(getTableName(documentMarks)).toBe("document_marks");
    expect(Object.keys(columns)).toEqual([
      "id",
      "documentId",
      "blockId",
      "markType",
      "range",
      "attrs",
    ]);
    expect(columns.blockId.name).toBe("block_id");
  });

  it("stores durable source block processing separately from visual marks", () => {
    const columns = getTableColumns(sourceBlockProcessing);

    expect(getTableName(sourceBlockProcessing)).toBe("source_block_processing");
    expect(Object.keys(columns)).toEqual([
      "id",
      "sourceElementId",
      "stableBlockId",
      "state",
      "blockContentHash",
      "metadata",
      "createdAt",
      "updatedAt",
      "lastAction",
      "lastActionAt",
    ]);
    expect(columns.sourceElementId.name).toBe("source_element_id");
    expect(columns.stableBlockId.name).toBe("stable_block_id");
    expect(columns.blockContentHash.name).toBe("block_content_hash");
  });

  it("links source block processing rows to multiple durable outputs", () => {
    const columns = getTableColumns(sourceBlockProcessingOutputs);

    expect(getTableName(sourceBlockProcessingOutputs)).toBe("source_block_processing_outputs");
    expect(Object.keys(columns)).toEqual([
      "id",
      "sourceElementId",
      "stableBlockId",
      "outputElementId",
      "outputType",
      "sourceLocationId",
      "createdAt",
    ]);
    expect(columns.outputElementId.name).toBe("output_element_id");
    expect(columns.sourceLocationId.name).toBe("source_location_id");
  });
});
