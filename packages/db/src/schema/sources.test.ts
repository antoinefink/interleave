import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { sourceLocations, sources } from "./sources";

describe("source schema", () => {
  it("pins provenance and source reliability metadata", () => {
    const columns = getTableColumns(sources);

    expect(getTableName(sources)).toBe("sources");
    expect(Object.keys(columns)).toEqual([
      "elementId",
      "url",
      "canonicalUrl",
      "originalUrl",
      "author",
      "publishedAt",
      "accessedAt",
      "snapshotKey",
      "reasonAdded",
      "mediaKind",
      "sourceType",
      "reliabilityTier",
      "confidence",
      "reliabilityNotes",
      "capturedVia",
    ]);
    expect(columns.canonicalUrl.name).toBe("canonical_url");
    expect(columns.reliabilityTier.name).toBe("reliability_tier");
    expect(columns.capturedVia.name).toBe("captured_via");
  });

  it("pins actionable source-location anchors for text, pages, regions, and media clips", () => {
    const columns = getTableColumns(sourceLocations);

    expect(getTableName(sourceLocations)).toBe("source_locations");
    expect(Object.keys(columns)).toEqual([
      "id",
      "elementId",
      "sourceElementId",
      "blockIds",
      "startOffset",
      "endOffset",
      "page",
      "timestampMs",
      "region",
      "clip",
      "label",
      "selectedText",
    ]);
    expect(columns.blockIds.name).toBe("block_ids");
    expect(columns.timestampMs.name).toBe("timestamp_ms");
    expect(columns.selectedText.name).toBe("selected_text");
  });
});
