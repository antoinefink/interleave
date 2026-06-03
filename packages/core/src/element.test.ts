import { describe, expect, it } from "vitest";
import type { Element, ElementLocation, ElementRelation, ReadPoint } from "./element";
import type { BlockId, ElementId, RelationId, SourceLocationId } from "./ids";

describe("element model shapes", () => {
  it("represents lineage fields for elements, relations, locations, and read-points", () => {
    const sourceId = "src" as ElementId;
    const extractId = "ext" as ElementId;
    const blockId = "blk" as BlockId;

    const extract = {
      id: extractId,
      type: "extract",
      status: "active",
      stage: "raw_extract",
      priority: 0.625,
      dueAt: "2026-06-10T00:00:00.000Z",
      title: "Selected passage",
      parentId: sourceId,
      sourceId,
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
      deletedAt: null,
    } satisfies Element;

    const relation = {
      id: "rel" as RelationId,
      fromElementId: extractId,
      toElementId: sourceId,
      relationType: "derived_from",
      siblingGroupId: null,
      createdAt: "2026-06-03T00:00:00.000Z",
    } satisfies ElementRelation;

    const location = {
      id: "loc" as SourceLocationId,
      elementId: extractId,
      sourceElementId: sourceId,
      blockIds: [blockId],
      startOffset: 2,
      endOffset: 12,
      page: 4,
      timestampMs: 9000,
      region: { x0: 0.1, y0: 0.2, x1: 0.7, y1: 0.8 },
      clip: { startMs: 9000, endMs: 15000 },
      label: "p. 4",
      selectedText: "lineage text",
    } satisfies ElementLocation;

    const readPoint = {
      elementId: sourceId,
      blockId,
      offset: 9,
      updatedAt: "2026-06-03T00:00:00.000Z",
    } satisfies ReadPoint;

    expect(extract.parentId).toBe(sourceId);
    expect(relation.relationType).toBe("derived_from");
    expect(location.blockIds).toEqual([blockId]);
    expect(location.region?.x1).toBeGreaterThan(location.region?.x0 ?? 1);
    expect(location.clip?.endMs).toBeGreaterThan(location.clip?.startMs ?? 0);
    expect(readPoint.offset).toBe(9);
  });
});
