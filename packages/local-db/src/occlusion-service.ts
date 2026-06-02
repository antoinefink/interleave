/**
 * OcclusionService (T071) — generate N sibling `image_occlusion` cards from one
 * `media_fragment` image extract + its masks, in ONE transaction.
 *
 * This mirrors {@link CardService.createFromExtract} exactly — it is the SAME card
 * authoring + sibling-grouping + lineage/tag/priority-inheritance seam, only the
 * card kind is `image_occlusion` and the "body" is not a prompt/answer string but a
 * row in `occlusion_masks` (which mask the card hides). Image occlusion is a card
 * VARIANT, not a parallel system: each generated card is a real `card` element with
 * a `cards` row + an un-due `review_states` row, FSRS-scheduled like any card.
 *
 * The flow, all in ONE `db.transaction` (a throw rolls back EVERY card/mask/edge/
 * tag row):
 *   1. resolve the `media_fragment` image extract; derive its lineage —
 *      `parentId = imageElementId`, `sourceId = image.sourceId ?? imageElementId`,
 *      `sourceLocationId = SourceRepository.findLocationForElement(...)` (the
 *      page+region anchor the cards inherit, so jump-to-source works in review);
 *   0. RETIRE the prior batch: re-running on the same image is a first-class
 *      edit-then-regenerate, but `replaceMasksForImage` DELETES the old mask rows —
 *      so the previously-generated cards would be left mask-less ORPHANS (a blank
 *      review face). Before replacing the masks we soft-delete the prior cards
 *      (`soft_delete_element`) in the SAME tx, so a regenerate REPLACES the diagram's
 *      cards rather than accumulating them;
 *   2. persist the mask set via `replaceMasksForImage` (overwriting a prior set so
 *      an edit-then-regenerate is deterministic);
 *   3. for EACH mask, mint a `siblingGroupId` ONCE (on the first mask) and create
 *      the card via `ReviewRepository.createCardWithin` (kind `image_occlusion`,
 *      stage `card_draft`, the image's inherited priority — `priority` is REQUIRED
 *      on `createCardWithin`), link the mask to its card (`setCardForMask`), add a
 *      `sibling_group` edge (logs `add_relation`), and inherit the image's tags
 *      (logs `add_tag`).
 *
 * **Two-scheduler split (load-bearing):** each card is `card_draft` with an UN-DUE
 * `review_states` row (`fsrsState: "new"`); M7's FSRS owns the first schedule + the
 * `card_draft → active_card` transition. We do NOT schedule the card here. The
 * originating `media_fragment` stays an ATTENTION item (it is never given an FSRS
 * row of its own — only the CARDS get `review_states` rows).
 *
 * The renderer never runs any of this; it reaches the service only through the
 * validated `cards.generateOcclusion` IPC command.
 */

import type { ElementId, Priority, RegionRect, SiblingGroupId } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { AssetRepository } from "./asset-repository";
import { ElementRepository } from "./element-repository";
import { newSiblingGroupId } from "./ids";
import { type OcclusionMask, OcclusionMasksRepository } from "./occlusion-masks-repository";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";

/** One mask to occlude — a normalized region + an optional reveal label. */
export interface OcclusionMaskRequest {
  readonly region: RegionRect;
  readonly label?: string | null;
}

/** Arguments to generate occlusion cards from an image extract + masks. */
export interface GenerateOcclusionInput {
  /** The `media_fragment` image extract (the base the masks are drawn over). */
  readonly imageElementId: ElementId;
  /** The masks to occlude — one `image_occlusion` card is minted per mask. */
  readonly masks: readonly OcclusionMaskRequest[];
  /**
   * Numeric priority override. When omitted the cards INHERIT the image's numeric
   * priority. The A/B/C/D-label → numeric mapping is the caller's job (DbService).
   */
  readonly priority?: Priority;
}

/** A generated `image_occlusion` card — the flat summary the IPC result carries. */
export interface GeneratedOcclusionCard {
  readonly id: ElementId;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly kind: string;
  readonly parentId: ElementId | null;
  readonly sourceId: ElementId | null;
  readonly siblingGroupId: SiblingGroupId;
  /** The mask this card reveals (region + label). */
  readonly maskId: string;
}

/** The result of generating occlusion cards from a diagram. */
export interface GenerateOcclusionResult {
  readonly siblingGroupId: SiblingGroupId;
  readonly cards: GeneratedOcclusionCard[];
  readonly masks: OcclusionMask[];
  /** The inherited source-location anchor id (lineage), or `null`. */
  readonly sourceLocationId: string | null;
}

export class OcclusionService {
  private readonly elements: ElementRepository;
  private readonly review: ReviewRepository;
  private readonly sources: SourceRepository;
  private readonly masks: OcclusionMasksRepository;
  private readonly assets: AssetRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.review = new ReviewRepository(db);
    this.sources = new SourceRepository(db);
    this.masks = new OcclusionMasksRepository(db);
    this.assets = new AssetRepository(db);
  }

  /**
   * Generate N sibling `image_occlusion` cards (one per mask) from a
   * `media_fragment` image extract, in ONE transaction. See the file header for
   * the steps + the atomicity + two-scheduler contracts.
   */
  generate(input: GenerateOcclusionInput): GenerateOcclusionResult {
    const image = this.elements.findById(input.imageElementId);
    if (!image || image.deletedAt) {
      throw new Error(`OcclusionService.generate: image extract ${input.imageElementId} not found`);
    }
    if (image.type !== "media_fragment") {
      throw new Error(
        `OcclusionService.generate: ${input.imageElementId} is a ${image.type}, not a media_fragment image extract`,
      );
    }
    // Occlusion needs a base IMAGE (the crop the masks composite over). Gate on the
    // owning asset being an `image`, not just on the element type — a future audio/
    // video `media_fragment` (T073–T075) is a `media_fragment` too, but can't be
    // occluded. Today T065 only produces image media_fragments, so this is belt-and-
    // suspenders; it keeps the editor/service from mounting on non-image media.
    if (this.assets.listForElementByKind(input.imageElementId, "image").length === 0) {
      throw new Error(
        `OcclusionService.generate: ${input.imageElementId} has no image asset to occlude`,
      );
    }
    if (input.masks.length === 0) {
      throw new Error("OcclusionService.generate: at least one mask is required");
    }

    // Lineage: parent IS the image extract; the source root is the image's source
    // root (or the image itself when it is its own root); the anchor is the image's
    // exact page+region location, so jump-to-source in review lands on the figure.
    const parentId = input.imageElementId;
    const sourceId = image.sourceId ?? input.imageElementId;
    const sourceLocationId = this.sources.findLocationForElement(input.imageElementId)?.id ?? null;

    // Priority: inherit the image's numeric priority unless overridden.
    const priority: Priority = input.priority ?? image.priority;

    // The inherited tags (read up front — no DB writes).
    const inheritedTags = this.elements.listTags(input.imageElementId);

    // One sibling group for the whole diagram (minted once).
    const siblingGroupId: SiblingGroupId = newSiblingGroupId();

    return this.db.transaction((tx) => {
      // 0) RETIRE the prior batch first. `replaceMasksForImage` (next step) DELETES
      //    the existing mask rows, so any cards generated by a previous run would be
      //    left mask-less ORPHANS (a blank review face). An edit-then-regenerate must
      //    REPLACE the diagram's cards, not accumulate them — so soft-delete the prior
      //    cards (logs `soft_delete_element`) in THIS SAME tx before re-minting. Reads
      //    the prior masks up front; only live, non-null card links are retired.
      const priorMasks = this.masks.listForImage(input.imageElementId);
      for (const prior of priorMasks) {
        if (!prior.cardElementId) continue;
        const priorCardId = prior.cardElementId as ElementId;
        const priorCard = this.elements.findById(priorCardId);
        if (priorCard && !priorCard.deletedAt) {
          this.elements.softDeleteWithin(tx, priorCardId);
        }
      }

      // 2) persist the mask set (idempotent — overwrites any prior set).
      const masks = this.masks.replaceMasksForImage(tx, input.imageElementId, input.masks);

      const cards: GeneratedOcclusionCard[] = [];
      masks.forEach((mask, index) => {
        const title = mask.label?.trim() || `Region ${index + 1}`;
        // 3) the card element + cards row + an UN-DUE review_states row (create_card).
        //    fsrsState stays "new"; M7's first grade runs the interval math. The mask
        //    label rides along on `cards.answer` (for search/preview); the authoritative
        //    reveal target is the mask's `label` + the un-occluded region.
        const { element } = this.review.createCardWithin(tx, {
          kind: "image_occlusion",
          title,
          priority,
          stage: "card_draft",
          prompt: null,
          answer: mask.label ?? null,
          cloze: null,
          parentId,
          sourceId,
          sourceLocationId,
        });

        // Link this card to the mask it reveals (one card ↔ one mask).
        this.masks.setCardForMask(tx, mask.id, element.id);

        // Inherit the image's tags onto the card (add_tag).
        for (const tagName of inheritedTags) {
          this.elements.addTagWithin(tx, element.id, tagName);
        }

        // Sibling-group edge card → group (add_relation). Burying in review (T039)
        // reuses the SAME mechanism — the 6 cards of a diagram won't appear back-to-back.
        this.elements.addRelationWithin(tx, {
          fromElementId: element.id,
          toElementId: parentId,
          relationType: "sibling_group",
          siblingGroupId,
        });

        cards.push({
          id: element.id,
          type: element.type,
          status: element.status,
          stage: element.stage,
          priority: element.priority,
          title: element.title,
          kind: "image_occlusion",
          parentId: element.parentId,
          sourceId: element.sourceId,
          siblingGroupId,
          maskId: mask.id,
        });
      });

      // Re-read the masks so the returned set carries the linked `cardElementId`.
      const linkedMasks = masks.map((mask, index) => ({
        ...mask,
        cardElementId: cards[index]?.id ?? null,
      }));

      return { siblingGroupId, cards, masks: linkedMasks, sourceLocationId };
    });
  }
}
