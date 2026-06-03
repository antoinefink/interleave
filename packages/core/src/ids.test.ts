import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AssetId,
  BlockId,
  DocumentId,
  ElementId,
  IsoTimestamp,
  JobId,
  OperationId,
  RelationId,
  ReviewLogId,
  SiblingGroupId,
  SourceLocationId,
} from "./ids";

describe("branded ids", () => {
  it("are strings at runtime but distinct at compile time", () => {
    const elementId = "element-1" as ElementId;
    expect(elementId).toBe("element-1");

    expectTypeOf<ElementId>().toMatchTypeOf<string>();
    expectTypeOf<DocumentId>().toMatchTypeOf<string>();
    expectTypeOf<BlockId>().toMatchTypeOf<string>();
    expectTypeOf<RelationId>().toMatchTypeOf<string>();
    expectTypeOf<SourceLocationId>().toMatchTypeOf<string>();
    expectTypeOf<AssetId>().toMatchTypeOf<string>();
    expectTypeOf<OperationId>().toMatchTypeOf<string>();
    expectTypeOf<ReviewLogId>().toMatchTypeOf<string>();
    expectTypeOf<SiblingGroupId>().toMatchTypeOf<string>();
    expectTypeOf<JobId>().toMatchTypeOf<string>();

    expectTypeOf<ElementId>().not.toEqualTypeOf<SourceLocationId>();
    expectTypeOf<ElementId>().not.toEqualTypeOf<AssetId>();
    expectTypeOf<ReviewLogId>().not.toEqualTypeOf<OperationId>();
  });

  it("keeps timestamps as ISO string aliases", () => {
    const timestamp: IsoTimestamp = "2026-06-03T12:00:00.000Z";
    expect(timestamp).toBe("2026-06-03T12:00:00.000Z");
    expectTypeOf<IsoTimestamp>().toEqualTypeOf<string>();
  });
});
