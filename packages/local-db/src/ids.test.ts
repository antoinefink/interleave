import { describe, expect, it } from "vitest";
import {
  newAssetId,
  newBlockId,
  newElementId,
  newJobId,
  newOperationId,
  newRelationId,
  newReviewLogId,
  newRowId,
  newSiblingGroupId,
  newSourceLocationId,
  nowIso,
} from "./ids";

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("local-db id minting", () => {
  it("mints UUID v4 strings for every stable id kind", () => {
    const ids = [
      newElementId(),
      newRelationId(),
      newSourceLocationId(),
      newAssetId(),
      newOperationId(),
      newReviewLogId(),
      newSiblingGroupId(),
      newJobId(),
      newBlockId(),
      newRowId(),
    ];

    for (const id of ids) {
      expect(id).toMatch(UUID_V4_RE);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns parseable UTC ISO timestamps", () => {
    const timestamp = nowIso();
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(timestamp).toISOString()).toBe(timestamp);
  });
});
