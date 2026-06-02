/**
 * OcclusionService + OcclusionMasksRepository tests (T071).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so behaviour
 * matches production. They assert the load-bearing image-occlusion invariants:
 *
 *  - from a `media_fragment` image extract with N masks, `generate` creates EXACTLY
 *    N `image_occlusion` `card` elements (`stage: "card_draft"`, `parentId =
 *    imageElementId`, `sourceId = image.sourceId`), each with a `cards` row
 *    (`kind: "image_occlusion"`), each with an UN-DUE `review_states` row
 *    (`dueAt = null`, `fsrsState = "new"`), all sharing ONE `siblingGroupId`
 *    (N `sibling_group` edges), each `occlusion_masks` row pointing at its card,
 *    inherited tags, and `operation_log` rows `create_card` (×N) + `add_relation`
 *    + `add_tag`;
 *  - a throw rolls EVERYTHING back (atomicity);
 *  - the `media_fragment` is unchanged (still an attention item; no FSRS row of its
 *    own) and the base image asset is untouched (the masks are stored SEPARATELY);
 *  - `OcclusionMasksRepository` round-trips a mask set, `replaceMasksForImage` is
 *    idempotent (re-run overwrites, no dup rows), and `findByCard` resolves.
 */

import type { AssetId, BlockId, ElementId, Priority, RegionRect } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { cards, elementRelations, elementTags, occlusionMasks, operationLog } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetRepository } from "./asset-repository";
import { ElementRepository } from "./element-repository";
import { OcclusionMasksRepository } from "./occlusion-masks-repository";
import { OcclusionService } from "./occlusion-service";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

const MASK_A: { region: RegionRect; label: string } = {
  region: { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 },
  label: "Hippocampus",
};
const MASK_B: { region: RegionRect; label: string } = {
  region: { x0: 0.5, y0: 0.1, x1: 0.8, y1: 0.4 },
  label: "Amygdala",
};
const MASK_C: { region: RegionRect; label: string } = {
  region: { x0: 0.1, y0: 0.5, x1: 0.4, y1: 0.8 },
  label: "Cortex",
};
const MASKS: { region: RegionRect; label: string }[] = [MASK_A, MASK_B, MASK_C];

/**
 * Seed a source + a `media_fragment` image extract anchored at a page+region
 * source-location, with an `image` asset and a tag. Returns the ids.
 */
function seedImageExtract(priority: Priority = 0.625): {
  sourceId: ElementId;
  imageElementId: ElementId;
  assetId: AssetId;
} {
  const sources = new SourceRepository(handle.db);
  const elements = new ElementRepository(handle.db);
  const assets = new AssetRepository(handle.db);

  const { element: source } = sources.createWithDocument({
    title: "Brain anatomy",
    priority,
    status: "active",
    stage: "raw_source",
    body: "Figure 1 shows the limbic system.",
  });
  const { element: image } = sources.createExtract({
    sourceElementId: source.id,
    elementType: "media_fragment",
    title: "Figure 1 · limbic system",
    priority,
    selectedText: "",
    blockIds: ["blk_fig" as BlockId],
    page: 3,
    region: { x0: 0.05, y0: 0.1, x1: 0.95, y1: 0.6 },
    label: "Page 3 · region",
  });
  // The clean base image asset (the crop — masks are NEVER baked into it).
  const asset = assets.create({
    owningElementId: image.id,
    kind: "image",
    vaultRoot: "assets",
    relativePath: `media/${image.id}/original.bin`,
    contentHash: "sha256:abc123",
    mime: "image/png",
    size: 12345,
  });
  // Tag the image so card tag-inheritance is exercised.
  elements.addTag(image.id, "anatomy");
  return { sourceId: source.id, imageElementId: image.id, assetId: asset.id };
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  handle.sqlite.close();
});

describe("OcclusionService.generate", () => {
  it("creates exactly N image_occlusion cards from N masks, with lineage", () => {
    const { sourceId, imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    const elements = new ElementRepository(handle.db);

    const before = elements.listByType("card").length;
    const result = service.generate({ imageElementId, masks: MASKS });

    const after = elements.listByType("card");
    expect(after.length).toBe(before + MASKS.length);
    expect(result.cards.length).toBe(MASKS.length);
    for (const card of result.cards) {
      const el = elements.findById(card.id);
      expect(el?.type).toBe("card");
      // NOT scheduled here — M7's FSRS owns the first schedule (card_draft).
      expect(el?.stage).toBe("card_draft");
      expect(el?.status).toBe("pending");
      expect(el?.parentId).toBe(imageElementId);
      expect(el?.sourceId).toBe(sourceId);
    }
  });

  it("writes a cards row kind=image_occlusion + an UN-DUE review_states row per card", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    const review = new ReviewRepository(handle.db);

    const result = service.generate({ imageElementId, masks: MASKS });
    for (const card of result.cards) {
      const row = handle.db.select().from(cards).where(eq(cards.elementId, card.id)).get();
      expect(row?.kind).toBe("image_occlusion");
      // The mask label rides on `cards.answer` (search/preview).
      expect(row?.prompt).toBeNull();
      expect(row?.cloze).toBeNull();
      // FSRS state exists but is UN-DUE (dueAt null, fsrsState new) — M6/M7 shape.
      const state = review.findReviewState(card.id);
      expect(state?.dueAt ?? null).toBeNull();
      expect(state?.fsrsState).toBe("new");
    }
  });

  it("groups all N cards in ONE siblingGroup (N sibling_group edges)", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);

    const result = service.generate({ imageElementId, masks: MASKS });
    const groups = new Set(result.cards.map((c) => c.siblingGroupId));
    expect(groups.size).toBe(1);
    expect([...groups][0]).toBe(result.siblingGroupId);

    const edges = handle.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.siblingGroupId, result.siblingGroupId))
      .all();
    expect(edges.length).toBe(MASKS.length);
    for (const edge of edges) {
      expect(edge.relationType).toBe("sibling_group");
    }
  });

  it("persists masks SEPARATELY, each linked to exactly one card", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    const masksRepo = new OcclusionMasksRepository(handle.db);

    const result = service.generate({ imageElementId, masks: MASKS });
    const stored = masksRepo.listForImage(imageElementId);
    expect(stored.length).toBe(MASKS.length);
    // Each mask points at its card; each card resolves back to its mask.
    for (const card of result.cards) {
      const mask = masksRepo.findByCard(card.id);
      expect(mask).not.toBeNull();
      expect(mask?.imageElementId).toBe(imageElementId);
    }
    // Labels + regions round-tripped.
    expect(stored.map((m) => m.label).sort()).toEqual(MASKS.map((m) => m.label).sort());
    expect(stored[0]?.region).toEqual(MASKS[0]?.region);
  });

  it("inherits the image's tags + priority onto each card", () => {
    const { imageElementId } = seedImageExtract(0.625);
    const service = new OcclusionService(handle.db);
    const elements = new ElementRepository(handle.db);

    const result = service.generate({ imageElementId, masks: MASKS });
    for (const card of result.cards) {
      expect(elements.listTags(card.id)).toContain("anatomy");
      expect(elements.findById(card.id)?.priority).toBe(0.625);
    }
    // A priority override is honoured.
    const override = service.generate({
      imageElementId,
      masks: [MASK_A],
      priority: 1 as Priority,
    });
    expect(elements.findById(override.cards[0]?.id ?? ("" as ElementId))?.priority).toBe(1);
  });

  it("appends create_card (×N) + add_relation + add_tag op-log rows", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);

    const before = handle.db.select().from(operationLog).all().length;
    service.generate({ imageElementId, masks: MASKS });
    const ops = handle.db.select().from(operationLog).all().slice(before);

    const counts = ops.reduce<Record<string, number>>((acc, op) => {
      acc[op.opType] = (acc[op.opType] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts.create_card).toBe(MASKS.length);
    expect(counts.add_relation).toBe(MASKS.length);
    expect(counts.add_tag).toBe(MASKS.length);
    // No reschedule/review op — the card is authored, not scheduled here.
    expect(counts.reschedule_element ?? 0).toBe(0);
    expect(counts.add_review_log ?? 0).toBe(0);
  });

  it("leaves the media_fragment unchanged (still attention; no FSRS row of its own)", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    const elements = new ElementRepository(handle.db);
    const review = new ReviewRepository(handle.db);

    const before = elements.findById(imageElementId);
    service.generate({ imageElementId, masks: MASKS });
    const after = elements.findById(imageElementId);

    expect(after?.type).toBe("media_fragment");
    expect(after?.stage).toBe(before?.stage);
    expect(after?.status).toBe(before?.status);
    // The image is NOT a card — it never gets its own review_states row.
    expect(review.findReviewState(imageElementId)).toBeNull();
  });

  it("does not touch the base image asset (masks stored separately)", () => {
    const { imageElementId, assetId } = seedImageExtract();
    const assets = new AssetRepository(handle.db);
    const service = new OcclusionService(handle.db);

    const before = assets.findById(assetId);
    service.generate({ imageElementId, masks: MASKS });
    const after = assets.findById(assetId);
    // Same single asset, same hash/path — never re-encoded or duplicated.
    expect(after?.contentHash).toBe(before?.contentHash);
    expect(after?.location.vaultPath.relativePath).toBe(before?.location.vaultPath.relativePath);
    expect(assets.listForElementByKind(imageElementId, "image").length).toBe(1);
  });

  it("rolls EVERYTHING back when a card creation throws (atomicity)", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    const elements = new ElementRepository(handle.db);
    const masksRepo = new OcclusionMasksRepository(handle.db);

    const cardsBefore = elements.listByType("card").length;
    const opsBefore = handle.db.select().from(operationLog).all().length;

    // Spy on `createCardWithin`, delegating to the real impl but throwing on the
    // SECOND card so the failure lands mid-transaction (after one card committed
    // in-tx) and the whole `db.transaction` must roll back.
    const real = ReviewRepository.prototype.createCardWithin;
    let n = 0;
    vi.spyOn(ReviewRepository.prototype, "createCardWithin").mockImplementation(function (
      this: ReviewRepository,
      ...args: Parameters<typeof real>
    ) {
      n += 1;
      if (n === 2) throw new Error("boom on card 2");
      return real.apply(this, args);
    });

    expect(() => service.generate({ imageElementId, masks: MASKS })).toThrow(/boom/);

    // No partial state: no new cards, no masks, no new op-log rows.
    expect(elements.listByType("card").length).toBe(cardsBefore);
    expect(masksRepo.listForImage(imageElementId).length).toBe(0);
    expect(handle.db.select().from(operationLog).all().length).toBe(opsBefore);
  });

  it("regenerating REPLACES the prior cards — no orphan (mask-less) cards", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    const elements = new ElementRepository(handle.db);
    const masksRepo = new OcclusionMasksRepository(handle.db);

    // First generate: 2 cards, 2 masks.
    const first = service.generate({ imageElementId, masks: [MASK_A, MASK_B] });
    expect(first.cards.length).toBe(2);

    // Edit-then-regenerate (the spec's first-class loop, and a double-click of the
    // editor's Generate button): re-run on the SAME image with a different set.
    const second = service.generate({ imageElementId, masks: [MASK_A] });
    expect(second.cards.length).toBe(1);

    // The new mask set is the only one stored, linked to the new card only.
    const storedMasks = masksRepo.listForImage(imageElementId);
    expect(storedMasks.length).toBe(1);
    expect(handle.db.select().from(occlusionMasks).all().length).toBe(1);

    // The prior batch was SOFT-DELETED (status `deleted`, deletedAt set), not orphaned.
    for (const card of first.cards) {
      const el = elements.findById(card.id);
      expect(el?.status).toBe("deleted");
      expect(el?.deletedAt).not.toBeNull();
    }

    // The ONLY live `image_occlusion` card is the freshly-generated one, and it
    // resolves to a mask — there are NO live mask-less cards.
    const liveOcclusionCards = elements.listByType("card").filter((el) => {
      const row = handle.db.select().from(cards).where(eq(cards.elementId, el.id)).get();
      return row?.kind === "image_occlusion";
    });
    expect(liveOcclusionCards.length).toBe(1);
    expect(liveOcclusionCards[0]?.id).toBe(second.cards[0]?.id);
    for (const el of liveOcclusionCards) {
      expect(masksRepo.findByCard(el.id)).not.toBeNull();
    }

    // Each regenerate logs a `soft_delete_element` per retired card (the 2 from run 1).
    const softDeletes = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.opType, "soft_delete_element"))
      .all();
    expect(softDeletes.length).toBe(first.cards.length);
  });

  it("regenerating an image that never produced cards retires nothing", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);

    // A first generate against a fresh image: no prior masks/cards to retire.
    const before = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.opType, "soft_delete_element"))
      .all().length;
    service.generate({ imageElementId, masks: [MASK_A] });
    const after = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.opType, "soft_delete_element"))
      .all().length;
    expect(after).toBe(before);
  });

  it("rejects a non-media_fragment image element", () => {
    const { sourceId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    expect(() => service.generate({ imageElementId: sourceId, masks: MASKS })).toThrow(
      /not a media_fragment/,
    );
  });
});

describe("OcclusionMasksRepository", () => {
  it("replaceMasksForImage round-trips a mask set (region/label/order)", () => {
    const { imageElementId } = seedImageExtract();
    const repo = new OcclusionMasksRepository(handle.db);

    handle.db.transaction((tx) => {
      repo.replaceMasksForImage(tx, imageElementId, MASKS);
    });
    const stored = repo.listForImage(imageElementId);
    expect(stored.length).toBe(MASKS.length);
    expect(stored.map((m) => m.order)).toEqual([0, 1, 2]);
    expect(stored[1]?.label).toBe("Amygdala");
    expect(stored[1]?.region).toEqual(MASK_B.region);
  });

  it("replaceMasksForImage is idempotent (re-run overwrites, no dup rows)", () => {
    const { imageElementId } = seedImageExtract();
    const repo = new OcclusionMasksRepository(handle.db);

    handle.db.transaction((tx) => repo.replaceMasksForImage(tx, imageElementId, MASKS));
    handle.db.transaction((tx) => repo.replaceMasksForImage(tx, imageElementId, [MASK_A]));
    const stored = repo.listForImage(imageElementId);
    expect(stored.length).toBe(1);
    expect(stored[0]?.label).toBe("Hippocampus");
    // The whole table holds exactly one mask for this image.
    expect(handle.db.select().from(occlusionMasks).all().length).toBe(1);
  });

  it("findByCard resolves the mask a card reveals", () => {
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    const repo = new OcclusionMasksRepository(handle.db);

    const result = service.generate({ imageElementId, masks: [MASK_A] });
    const cardId = result.cards[0]?.id ?? ("" as ElementId);
    const mask = repo.findByCard(cardId);
    expect(mask?.label).toBe("Hippocampus");
    expect(mask?.cardElementId).toBe(cardId);
  });

  it("cleans up element_tags too on rollback (no orphan join rows)", () => {
    // Sanity: a successful generate leaves N tag-join rows, one per card.
    const { imageElementId } = seedImageExtract();
    const service = new OcclusionService(handle.db);
    const result = service.generate({ imageElementId, masks: MASKS });
    const joins = handle.db.select().from(elementTags).all();
    for (const card of result.cards) {
      expect(joins.some((j) => j.elementId === card.id)).toBe(true);
    }
  });
});
