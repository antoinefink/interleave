/**
 * OcclusionMasksRepository (T071) — typed, transactional access to the
 * `occlusion_masks` table (the vector masks an image-occlusion card hides).
 *
 * Masks are stored SEPARATELY from the base image (the cropped PNG in the vault is
 * NEVER mutated). A mask is a normalized region (`{x0,y0,x1,y1}` fractions 0–1,
 * stored as JSON) over a `media_fragment` image extract, plus an optional `label`
 * (the text the hidden region stands for, shown on reveal) and a stable draw
 * `order`. {@link replaceMasksForImage} is the IDEMPOTENT "edit the masks,
 * regenerate" write: it clears the prior mask set for a diagram and inserts the
 * new one in one tx, so re-running generation is deterministic (no duplicate rows).
 *
 * Mask writes append NO `operation_log` op — they are card-authoring substrate
 * (like document blocks). The CARD generation ({@link OcclusionService}) logs
 * `create_card` (+ `add_relation`/`add_tag`).
 */

import type { ElementId, RegionRect } from "@interleave/core";
import { type InterleaveDatabase, occlusionMasks } from "@interleave/db";
import { asc, eq } from "drizzle-orm";
import { newRowId, nowIso } from "./ids";
import type { DbClient } from "./types";

/** A persisted occlusion mask (the domain shape the repository returns). */
export interface OcclusionMask {
  readonly id: string;
  /** The `media_fragment` image extract this mask occludes. */
  readonly imageElementId: string;
  /** The generated `image_occlusion` card revealing this mask, or `null`. */
  readonly cardElementId: string | null;
  /** The normalized bounding box (fractions 0–1). */
  readonly region: RegionRect;
  /** The text the hidden region stands for, or `null`. */
  readonly label: string | null;
  /** Draw order within the diagram. */
  readonly order: number;
  readonly createdAt: string;
}

/** One mask to (re)write for an image — region + optional label, in draw order. */
export interface OcclusionMaskInput {
  /** An optional explicit id; minted when absent (a fresh mask). */
  readonly id?: string;
  readonly region: RegionRect;
  readonly label?: string | null;
}

function parseRegion(raw: string): RegionRect {
  // Stored as JSON `{x0,y0,x1,y1}`; the writer validated it, so a parse failure
  // means corrupt data — return a degenerate full-frame box rather than throwing
  // (the review face degrades to a fully-masked image, never crashes).
  try {
    const value = JSON.parse(raw) as Partial<RegionRect>;
    return {
      x0: typeof value.x0 === "number" ? value.x0 : 0,
      y0: typeof value.y0 === "number" ? value.y0 : 0,
      x1: typeof value.x1 === "number" ? value.x1 : 1,
      y1: typeof value.y1 === "number" ? value.y1 : 1,
    };
  } catch {
    return { x0: 0, y0: 0, x1: 1, y1: 1 };
  }
}

function rowToMask(row: typeof occlusionMasks.$inferSelect): OcclusionMask {
  return {
    id: row.id,
    imageElementId: row.imageElementId,
    cardElementId: row.cardElementId ?? null,
    region: parseRegion(row.region),
    label: row.label ?? null,
    order: row.order,
    createdAt: row.createdAt,
  };
}

export class OcclusionMasksRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Insert-or-replace the WHOLE mask set for one image, using an existing
   * transaction — the idempotent "edit the masks, regenerate" write. Clears the
   * prior set for `imageElementId` (cascading any `cardElementId` links away with
   * the deleted rows) and inserts the new set in draw order. Returns the persisted
   * masks (with their minted ids) so the caller can mint one card per mask.
   */
  replaceMasksForImage(
    tx: DbClient,
    imageElementId: ElementId,
    masks: readonly OcclusionMaskInput[],
  ): OcclusionMask[] {
    tx.delete(occlusionMasks).where(eq(occlusionMasks.imageElementId, imageElementId)).run();
    const createdAt = nowIso();
    const out: OcclusionMask[] = [];
    masks.forEach((mask, index) => {
      const id = mask.id ?? newRowId();
      const region = mask.region;
      tx.insert(occlusionMasks)
        .values({
          id,
          imageElementId,
          cardElementId: null,
          region: JSON.stringify(region),
          label: mask.label ?? null,
          order: index,
          createdAt,
        })
        .run();
      out.push({
        id,
        imageElementId,
        cardElementId: null,
        region,
        label: mask.label ?? null,
        order: index,
        createdAt,
      });
    });
    return out;
  }

  /** All masks for a diagram, in draw order. */
  listForImage(imageElementId: ElementId): OcclusionMask[] {
    return this.db
      .select()
      .from(occlusionMasks)
      .where(eq(occlusionMasks.imageElementId, imageElementId))
      .orderBy(asc(occlusionMasks.order))
      .all()
      .map(rowToMask);
  }

  /** The mask a given `image_occlusion` card reveals, or `null`. */
  findByCard(cardElementId: ElementId): OcclusionMask | null {
    const row = this.db
      .select()
      .from(occlusionMasks)
      .where(eq(occlusionMasks.cardElementId, cardElementId))
      .get();
    return row ? rowToMask(row) : null;
  }

  /** A mask by its own id, or `null`. */
  findById(maskId: string): OcclusionMask | null {
    const row = this.db.select().from(occlusionMasks).where(eq(occlusionMasks.id, maskId)).get();
    return row ? rowToMask(row) : null;
  }

  /**
   * Link a mask to the `image_occlusion` card that reveals it, using an existing
   * transaction — called once per mask during generation. One card ↔ one mask (the
   * UNIQUE on `cardElementId` enforces it).
   */
  setCardForMask(tx: DbClient, maskId: string, cardElementId: ElementId): void {
    tx.update(occlusionMasks).set({ cardElementId }).where(eq(occlusionMasks.id, maskId)).run();
  }
}
