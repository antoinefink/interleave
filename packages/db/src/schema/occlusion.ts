/**
 * Image-occlusion masks (T071): `occlusion_masks`.
 *
 * A mask is a normalized vector region (`{x0,y0,x1,y1}` fractions 0–1) over a
 * `media_fragment` image extract (the figure/diagram T065 cropped out of a PDF
 * page into the vault). Masks are stored HERE — SEPARATELY from the base image
 * — so the cropped PNG in the vault is NEVER mutated or baked into: the review
 * face composites a mask box over the clean base `<img>` at render time, and the
 * same single crop powers every sibling card. (Baking a masked PNG per card would
 * duplicate the figure N times in the vault and break "edit a mask, regenerate".)
 *
 * The masks are NOT bytes — they are vector regions, so they live in SQLite (the
 * "no large blobs in SQLite" rule is about the image bytes, which stay in the
 * vault). Generating cards walks an image's masks and mints one
 * `image_occlusion` `card` per mask (a sibling group), setting that mask's
 * `cardElementId`. One card ↔ one mask (the UNIQUE on `cardElementId`).
 *
 * `imageElementId` cascades from the owning `media_fragment` (delete the diagram
 * → its masks go); `cardElementId` is `set null` so soft-deleting/removing a
 * generated card leaves the mask (a future regenerate can re-link it). Mask
 * writes append NO `operation_log` op — they are card-authoring substrate; the
 * CARD generation logs `create_card` (+ `add_relation`/`add_tag`).
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { elements } from "./elements";

export const occlusionMasks = sqliteTable(
  "occlusion_masks",
  {
    /** Stable id (domain-generated). */
    id: text("id").primaryKey(),
    /** The `media_fragment` image extract these masks occlude (the base image). */
    imageElementId: text("image_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /**
     * The generated `image_occlusion` card that reveals THIS mask — `null` until a
     * card is minted for it. `set null` on delete so removing the card leaves the
     * mask (a future regenerate can re-link). UNIQUE: one card reveals one mask.
     */
    cardElementId: text("card_element_id").references(() => elements.id, {
      onDelete: "set null",
    }),
    /** The normalized bounding box as JSON `{x0,y0,x1,y1}` (fractions 0–1). */
    region: text("region").notNull(),
    /** The text the hidden region stands for (e.g. "Hippocampus"); shown on reveal. */
    label: text("label"),
    /** Draw order within the diagram (stable ordering of the mask set). */
    order: integer("order").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    // Read all masks for a diagram (the editor + the review-face sibling dimming).
    index("occlusion_masks_image_idx").on(table.imageElementId),
    // One card reveals exactly one mask.
    uniqueIndex("occlusion_masks_card_idx").on(table.cardElementId),
  ],
);

export type OcclusionMaskRow = typeof occlusionMasks.$inferSelect;
export type NewOcclusionMaskRow = typeof occlusionMasks.$inferInsert;
