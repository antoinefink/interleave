import type { ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { occlusionMasks } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElementRepository } from "./element-repository";
import { OcclusionMasksRepository } from "./occlusion-masks-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let elements: ElementRepository;
let masks: OcclusionMasksRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  elements = new ElementRepository(handle.db);
  masks = new OcclusionMasksRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

function createImage(): ElementId {
  return elements.create({
    type: "media_fragment",
    status: "active",
    stage: "raw_extract",
    priority: 0.5,
    title: "Diagram",
  }).id;
}

describe("OcclusionMasksRepository", () => {
  it("replaces a diagram's masks idempotently and preserves draw order", () => {
    const imageId = createImage();
    const first = handle.db.transaction((tx) =>
      masks.replaceMasksForImage(tx, imageId, [
        { id: "mask-a", region: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 }, label: "A" },
        { id: "mask-b", region: { x0: 0.3, y0: 0.3, x1: 0.4, y1: 0.4 }, label: "B" },
      ]),
    );
    expect(first.map((mask) => mask.id)).toEqual(["mask-a", "mask-b"]);

    handle.db.transaction((tx) =>
      masks.replaceMasksForImage(tx, imageId, [
        { id: "mask-c", region: { x0: 0, y0: 0, x1: 1, y1: 1 }, label: null },
      ]),
    );

    expect(masks.listForImage(imageId).map((mask) => mask.id)).toEqual(["mask-c"]);
    expect(masks.findById("mask-a")).toBeNull();
    expect(masks.findById("mask-c")).toMatchObject({
      order: 0,
      label: null,
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
    });
  });

  it("links one mask to the card that reveals it", () => {
    const imageId = createImage();
    const cardId = elements.create({
      type: "card",
      status: "active",
      stage: "active_card",
      priority: 0.5,
      title: "Occlusion card",
    }).id;
    handle.db.transaction((tx) =>
      masks.replaceMasksForImage(tx, imageId, [
        { id: "mask-a", region: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 } },
      ]),
    );

    handle.db.transaction((tx) => masks.setCardForMask(tx, "mask-a", cardId));

    expect(masks.findByCard(cardId)).toMatchObject({ id: "mask-a", cardElementId: cardId });
  });

  it("degrades corrupt stored region JSON to a full-frame mask", () => {
    const imageId = createImage();
    handle.db
      .insert(occlusionMasks)
      .values({
        id: "mask-corrupt",
        imageElementId: imageId,
        cardElementId: null,
        region: "{not-json",
        label: "Corrupt",
        order: 0,
        createdAt: "2026-06-03T00:00:00.000Z",
      })
      .run();

    expect(masks.findById("mask-corrupt")?.region).toEqual({ x0: 0, y0: 0, x1: 1, y1: 1 });
  });
});
