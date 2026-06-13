/**
 * CardService (T032) — the keystone of the card milestone (M6).
 *
 * A card is the ONLY element type scheduled by FSRS (it answers "can the user
 * recall this?"). This service AUTHORS a card from an `atomic_statement` extract
 * — it does NOT schedule it. It composes `ReviewRepository`, `ElementRepository`,
 * and `SourceRepository` to create a `card` element from an extract in ONE
 * transaction:
 *
 *   1. resolve the originating extract and DERIVE the card's lineage from it —
 *      `parentId = extractId`, `sourceId = extract.sourceId ?? extractId`, and
 *      `sourceLocationId = SourceRepository.findLocationForElement(extractId)?.id`
 *      (the card inherits the extract's EXACT source anchor, so jump-to-source in
 *      review lands on the originating block — `card → extract → source location →
 *      source`);
 *   2. inherit PRIORITY — default to the extract's numeric priority, overridable
 *      by an explicit A/B/C/D label resolved by the caller (DbService);
 *   3. create the card via `ReviewRepository.createCardWithin` (logs
 *      `create_element` + `create_card`, inserts the UN-DUE `review_states` row),
 *      at stage `card_draft`;
 *   4. inherit the extract's TAGS onto the card (`ElementRepository.addTagWithin`,
 *      logs `add_tag` — mirrors `ExtractionService`'s tag inheritance);
 *   5. record the `derived_from` edge card → extract (`add_relation`) so lineage
 *      graph queries can traverse the card hop explicitly;
 *   6. SIBLING GROUPING — when a `siblingGroupId` is supplied (subsequent cards
 *      from the same extract/cloze-set reuse it; the FIRST card from an extract
 *      mints a fresh one), add a `sibling_group` `element_relations` edge from the
 *      new card to the group (`ElementRepository.addRelationWithin`, logs
 *      `add_relation`). The minted/reused `siblingGroupId` is returned so the
 *      caller can group the next sibling.
 *
 * **Atomicity (load-bearing):** all steps + their `operation_log` appends commit
 * in a SINGLE `db.transaction`, via the tx-composable `*Within(tx, …)` seams. A
 * throw anywhere rolls the WHOLE card back — no orphan element / card /
 * review-state / relation / tag rows. The op-log row is never appended in a
 * transaction separate from the mutation it records.
 *
 * **Two-scheduler split (NON-NEGOTIABLE):** the card's `review_states` row is
 * created with `fsrsState = "new"` and NO FSRS interval math is run here — the
 * card is FIRST-SCHEDULED due now (`dueAt = asOf ?? now`) and activated
 * (`card_draft → active_card`, `pending → active`) in the SAME creation
 * transaction (T036), so an authored card immediately enters the due deck and
 * can be reviewed. Setting `dueAt = now` for a brand-new card is not FSRS math (a
 * new card is due now by definition); the first GRADE is where
 * `CardSchedulerService.gradeCard` computes the real interval. The originating
 * extract is UNCHANGED — it lives on as its own attention-scheduled element;
 * converting it to a card does NOT mutate it and does NOT give it a
 * `review_states`/FSRS row.
 *
 * The renderer never runs any of this; it reaches the service only through the
 * validated `cards.create` IPC command.
 */

import type {
  BlockId,
  CardKind,
  ElementId,
  IsoTimestamp,
  MediaRef,
  Priority,
  SiblingGroupId,
  SourceLocationId,
} from "@interleave/core";
import { canonicalizeCloze, parseCloze } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { elementRelations, elements as elementsTable } from "@interleave/db";
import { and, eq, isNull } from "drizzle-orm";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { newBlockId, newSiblingGroupId, nowIso } from "./ids";
import type { CardWithElement } from "./review-repository";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";
import type { TransactionClient } from "./types";

/** Arguments to author a card from an extract. */
export interface CreateCardFromExtractInput {
  /** The originating extract this card is distilled from (lineage parent). */
  readonly extractId: ElementId;
  /** Card kind — `qa` or `cloze`. */
  readonly kind: CardKind;
  /** Card title; defaults to a derived label when omitted. */
  readonly title?: string;
  /** Q&A prompt (required, non-empty, for `qa`). */
  readonly prompt?: string | null;
  /** Q&A answer (required, non-empty, for `qa`). */
  readonly answer?: string | null;
  /** Canonical `{{c1::answer}}` cloze text (required, non-empty, for `cloze`). */
  readonly cloze?: string | null;
  /**
   * Numeric priority override. When omitted the card INHERITS the extract's
   * numeric priority. The A/B/C/D-label → numeric mapping is the caller's job
   * (DbService) so this service stays free of label concerns.
   */
  readonly priority?: Priority;
  /**
   * The sibling group to add this card to. Omit for the FIRST card from an
   * extract (a fresh group id is minted); pass the previously-returned id to
   * group a subsequent sibling (a Q&A + cloze pair, or a multi-cloze set) so
   * review never shows interfering siblings back-to-back (burying is M7).
   */
  readonly siblingGroupId?: SiblingGroupId;
  /**
   * Audio-card presentation carrier (T075). When supplied EXPLICITLY (the renderer
   * passes "loop this clip on the prompt/answer/both"), it is written verbatim to
   * `cards.media_ref`. When OMITTED and the originating extract is a clip
   * `media_fragment` (its `source_locations` row carries a `clip` window), the service
   * DERIVES the ref from that clip + the media `sourceId` and defaults `on: "prompt"`
   * — so the builder can author an audio card by passing just the clip extract id. An
   * explicit ref always wins (e.g. to put the audio on the answer). `null`/omitted for
   * every text/occlusion card. Audio is a presentation modifier, not a new `kind`.
   */
  readonly mediaRef?: MediaRef | null;
  /**
   * The first FSRS schedule time (T036) — when this authored card becomes due.
   * Defaults to "now" so a freshly created card immediately enters the due deck
   * and can be reviewed (its first grade runs the real FSRS interval math). Passed
   * explicitly only by tests that need a deterministic clock. Setting `dueAt = now`
   * for a brand-new card is not FSRS math — the card stays `fsrsState: "new"` until
   * graded; this just makes it reviewable rather than parked forever un-due.
   */
  readonly asOf?: IsoTimestamp;
  /**
   * Optional caller hook run INSIDE the same card-creation transaction. Conversion
   * uses this to consume a copied AI suggestion atomically with the card mint.
   */
  readonly onWithin?: (
    tx: TransactionClient,
    minted: { readonly cardElementId: ElementId },
  ) => void;
}

/** The authored card element + its `cards` row + the sibling group it joined. */
export interface CreateCardResult {
  readonly element: CardWithElement["element"];
  readonly card: CardWithElement["card"];
  /** The (minted or reused) sibling group id, to thread into the next sibling. */
  readonly siblingGroupId: SiblingGroupId;
  /** The inherited source-location anchor id (lineage), or `null` when the extract has none. */
  readonly sourceLocationId: string | null;
  /** The resolved audio-card clip reference (T075), or `null` for a text/occlusion card. */
  readonly mediaRef: MediaRef | null;
}

/** Build a short fallback title from a card's body. */
function titleFromBody(input: CreateCardFromExtractInput): string {
  const raw =
    input.kind === "cloze"
      ? (input.cloze ?? "")
      : `${input.prompt ?? ""}`.trim() || (input.answer ?? "");
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return input.kind === "cloze" ? "Cloze card" : "Q&A card";
  return normalized.length > 80 ? `${normalized.slice(0, 80).trimEnd()}…` : normalized;
}

export class CardService {
  private readonly elements: ElementRepository;
  private readonly review: ReviewRepository;
  private readonly sources: SourceRepository;
  private readonly documents: DocumentRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.review = new ReviewRepository(db);
    this.sources = new SourceRepository(db);
    this.documents = new DocumentRepository(db);
  }

  /**
   * Author a card from an extract in ONE transaction. See the file header for the
   * five steps + the atomicity + two-scheduler contracts. Returns the new card +
   * its sibling group id + the inherited source-location anchor.
   */
  createFromExtract(input: CreateCardFromExtractInput): CreateCardResult {
    // `image_occlusion` cards are minted only by the occlusion path (which creates
    // the required `occlusion_masks` row atomically); authoring one here would yield
    // a mask-less, permanently-blank, FSRS-scheduled card. Reject defensively even
    // though the IPC contract already blocks it.
    if (input.kind === "image_occlusion") {
      throw new Error(
        "CardService.createFromExtract: image_occlusion cards must be created via the occlusion generator",
      );
    }
    const extract = this.elements.findById(input.extractId);
    if (!extract || extract.deletedAt) {
      throw new Error(`CardService.createFromExtract: extract ${input.extractId} not found`);
    }
    if (
      extract.type === "extract" &&
      (extract.extractFate !== null || this.hasLiveSynthesisReference(input.extractId))
    ) {
      throw new Error(
        "CardService.createFromExtract: reactivate the extract before creating a card",
      );
    }

    // Lineage: parent IS the extract; source root is the extract's source root
    // (or the extract itself when it is its own root); the anchor is the extract's
    // exact source location, so jump-to-source in review (M7) lands correctly.
    const parentId = input.extractId;
    const sourceId = extract.sourceId ?? input.extractId;
    const extractLocation = this.sources.findLocationForElement(input.extractId);
    const sourceLocationId: SourceLocationId | null = extractLocation?.id ?? null;

    // Audio-card carrier (T075). An explicit ref (the renderer chose the face) always
    // wins. Otherwise, when the originating extract is a clip `media_fragment` — its
    // location carries a `clip` window onto a media `sourceElementId` — DERIVE the ref
    // from that window + media source, defaulting the loop to the prompt face. The card
    // is self-contained: it copies the window so it needn't re-resolve the fragment. A
    // non-clip extract yields `null` (every text card). The clip references the original
    // media by time — no re-encoding.
    const mediaRef: MediaRef | null =
      input.mediaRef ??
      (extract.type === "media_fragment" && extractLocation?.clip
        ? {
            sourceElementId: extractLocation.sourceElementId,
            startMs: extractLocation.clip.startMs,
            endMs: extractLocation.clip.endMs,
            on: "prompt",
          }
        : null);

    // Priority: inherit the extract's numeric priority unless overridden.
    const priority: Priority = input.priority ?? extract.priority;

    // Sibling group: the first card from an extract mints one; subsequent cards
    // reuse the supplied id. Resolved up-front so it is returned even when no
    // relation row is needed to be queried.
    const siblingGroupId: SiblingGroupId = input.siblingGroupId ?? newSiblingGroupId();

    // Reads up front (no DB writes): the extract's inherited tags.
    const inheritedTags = this.elements.listTags(input.extractId);

    // Cloze cards store the CANONICAL `{{c1::answer}}` text (T034) — the single
    // source of truth. Bare `{{answer}}` markers from the kit/renderer are
    // auto-numbered here; the structured model (count + index→answer spans) is
    // derived deterministically from this text by `parseCloze`, and the deletion
    // spans are persisted as `cloze` document_marks on the card body below.
    const cloze =
      input.kind === "cloze" && input.cloze != null ? canonicalizeCloze(input.cloze) : input.cloze;

    const title =
      (input.title ?? "").trim() ||
      titleFromBody(cloze !== undefined ? { ...input, cloze } : input);

    // First FSRS schedule (T036): a freshly authored card becomes due NOW so it
    // enters the due deck and is reviewable; its first grade runs the real FSRS math.
    const firstScheduledAt = input.asOf ?? nowIso();

    const { element, card } = this.db.transaction((tx) => {
      // 1–3) the card element + cards row + a DUE review_states row (create_element
      //       + create_card), activated card_draft → active_card (update_element).
      //       fsrsState stays "new"; the first grade is where the interval math runs.
      const created = this.review.createCardWithin(tx, {
        kind: input.kind,
        title,
        priority,
        stage: "card_draft",
        prompt: input.prompt ?? null,
        answer: input.answer ?? null,
        cloze: cloze ?? null,
        parentId,
        sourceId,
        sourceLocationId,
        mediaRef,
        firstScheduledAt,
      });

      // 4) inherit the extract's tags onto the card (add_tag).
      for (const tagName of inheritedTags) {
        this.elements.addTagWithin(tx, created.element.id, tagName);
      }

      // 5) derived_from edge card → extract (lineage; add_relation).
      this.elements.addRelationWithin(tx, {
        fromElementId: created.element.id,
        toElementId: parentId,
        relationType: "derived_from",
      });

      // 6) sibling-group edge card → group (add_relation). Burying in review is M7;
      //    M6 only RECORDS the grouping so a Q&A + cloze pair / multi-cloze set are linked.
      this.elements.addRelationWithin(tx, {
        fromElementId: created.element.id,
        toElementId: parentId,
        relationType: "sibling_group",
        siblingGroupId,
      });

      // 6) CLOZE structured metadata (T034): seed the card's own document body from
      //    the RENDERED prompt (answers inline, on ONE block so all deletions share a
      //    stable anchor) and persist each deletion as a `cloze` document_marks row
      //    keyed by that block id + its `[start,end]` answer range + `{ clozeIndex }`.
      //    Reuses the existing mark surface (markType `cloze`, op `update_document`) —
      //    NO new column, NO new op. Derived from `cards.cloze`, so it re-renders
      //    without re-parsing free text. The markers are NEVER written to the
      //    source/extract body (that would corrupt the extract) — only the card's.
      if (input.kind === "cloze" && cloze != null) {
        this.seedClozeBodyWithin(tx, created.element.id, cloze);
      }

      input.onWithin?.(tx, { cardElementId: created.element.id });

      return created;
    });

    return { element, card, siblingGroupId, sourceLocationId, mediaRef };
  }

  /**
   * Author a PARKED, UN-DUE `card_draft` from an AI suggestion (T093) — the
   * DRAFT-ONLY seam the `approveCard` path routes through. It is deliberately NOT
   * `createFromExtract`: that path hardcodes `firstScheduledAt = now`, which makes
   * `ReviewRepository.createCardWithin` write a DUE `review_states` row AND activate the
   * element (`card_draft → active_card`) — i.e. it would put the card in the deck +
   * engage FSRS. This seam OMITS `firstScheduledAt`, so the same `createCardWithin`
   * leaves the card PARKED: `review_states.dueAt = null`, element stays `card_draft`
   * (NOT `active_card`), `fsrsState: "new"`, NOT in the due deck. Activation /
   * first-schedule stays the user's existing explicit card action.
   *
   * It reuses the EXACT extract→card lineage/op path: `parentId = extractId`,
   * `sourceId = extract.sourceId ?? extractId`, the `create_element`/`create_card` ops,
   * tag inheritance, and the cloze body seed — minus the due-now first-schedule. The
   * AI GROUNDING (T094) is written as a REAL `source_locations` row anchored to the
   * card (via {@link SourceRepository.createElementLocationWithin}) so the minted card's
   * refblock + jump-to-source work identically to an extract-derived card; a
   * `derived_from` edge points the card at its owning extract/source.
   */
  createDraftFromSuggestion(input: {
    /** The owning extract/source the AI action ran on (the lineage parent). */
    readonly owningElementId: ElementId;
    readonly kind: CardKind;
    readonly title?: string;
    readonly prompt?: string | null;
    readonly answer?: string | null;
    readonly cloze?: string | null;
    readonly priority?: Priority;
    /** The AI grounding (T094) written as a `source_locations` anchor for the card. */
    readonly grounding?: {
      readonly sourceElementId: ElementId;
      readonly blockIds: readonly BlockId[];
      readonly startOffset?: number | null;
      readonly endOffset?: number | null;
      readonly selectedText: string;
      readonly label?: string | null;
    };
    /**
     * Optional hook run INSIDE the same card-creation transaction (T093). The
     * `approveCard` path threads the suggestion's `draft → approved` status flip
     * through here so the card mint + the suggestion flip commit atomically — a
     * throw rolls BOTH back, so the suggestion can never end up `draft` with a
     * committed card (no re-approve → no duplicate card).
     */
    readonly onWithin?: (
      tx: TransactionClient,
      minted: { readonly cardElementId: ElementId },
    ) => void;
  }): CreateCardResult {
    if (input.kind === "image_occlusion") {
      throw new Error(
        "CardService.createDraftFromSuggestion: image_occlusion cards must be created via the occlusion generator",
      );
    }
    const owner = this.elements.findById(input.owningElementId);
    if (!owner || owner.deletedAt) {
      throw new Error(
        `CardService.createDraftFromSuggestion: owning element ${input.owningElementId} not found`,
      );
    }
    if (
      owner.type === "extract" &&
      (owner.extractFate !== null || this.hasLiveSynthesisReference(input.owningElementId))
    ) {
      throw new Error(
        "CardService.createDraftFromSuggestion: reactivate the extract before creating a card",
      );
    }

    const parentId = input.owningElementId;
    const sourceId = owner.sourceId ?? input.owningElementId;
    const priority: Priority = input.priority ?? owner.priority;
    const siblingGroupId: SiblingGroupId = newSiblingGroupId();
    const inheritedTags = this.elements.listTags(input.owningElementId);

    const cloze =
      input.kind === "cloze" && input.cloze != null ? canonicalizeCloze(input.cloze) : input.cloze;
    const title =
      (input.title ?? "").trim() ||
      titleFromBody({
        kind: input.kind,
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.answer !== undefined ? { answer: input.answer } : {}),
        ...(cloze !== undefined ? { cloze } : {}),
      } as CreateCardFromExtractInput);

    const { element, card, sourceLocationId } = this.db.transaction((tx) => {
      // The AI grounding (T094) → a REAL source_locations row anchored to the card, so
      // the minted card resolves the SAME SourceRef an extract-derived card does. We
      // create the card element FIRST (so the location can reference its id), but since
      // createCardWithin needs the sourceLocationId up front we mint the location id and
      // write the row after the card. To keep the card→location link, we write the
      // location, then patch the card's source_location_id is unnecessary — instead we
      // pre-create the location id and pass it to createCardWithin.
      // 1) create the card (parked, NO firstScheduledAt → dueAt = null, stays card_draft).
      const created = this.review.createCardWithin(tx, {
        kind: input.kind,
        title,
        priority,
        stage: "card_draft",
        prompt: input.prompt ?? null,
        answer: input.answer ?? null,
        cloze: cloze ?? null,
        parentId,
        sourceId,
        sourceLocationId: null,
        // NO firstScheduledAt — the load-bearing draft-only difference.
      });

      // 2) the grounding as a real source_locations row anchored to the card, then link
      //    the card's source_location_id to it (so refblock + jump-to-source work).
      let locationId: SourceLocationId | null = null;
      if (input.grounding) {
        const location = this.sources.createElementLocationWithin(tx, {
          elementId: created.element.id,
          sourceElementId: input.grounding.sourceElementId,
          blockIds: input.grounding.blockIds,
          startOffset: input.grounding.startOffset ?? null,
          endOffset: input.grounding.endOffset ?? null,
          selectedText: input.grounding.selectedText,
          label: input.grounding.label ?? null,
        });
        locationId = location.id;
        this.review.setCardSourceLocationWithin(tx, created.element.id, location.id);
      }

      // 3) inherit the owner's tags (add_tag).
      for (const tagName of inheritedTags) {
        this.elements.addTagWithin(tx, created.element.id, tagName);
      }

      // 4) the derived_from edge card → owning extract/source (lineage; add_relation).
      this.elements.addRelationWithin(tx, {
        fromElementId: created.element.id,
        toElementId: parentId,
        relationType: "derived_from",
      });

      // 5) cloze structured metadata (same as createFromExtract).
      if (input.kind === "cloze" && cloze != null) {
        this.seedClozeBodyWithin(tx, created.element.id, cloze);
      }

      // 6) caller hook in the SAME transaction (the approve-path suggestion status flip).
      input.onWithin?.(tx, { cardElementId: created.element.id });

      return { element: created.element, card: created.card, sourceLocationId: locationId };
    });

    return { element, card, siblingGroupId, sourceLocationId, mediaRef: null };
  }

  private hasLiveSynthesisReference(id: ElementId): boolean {
    const row = this.db
      .select({ id: elementRelations.id })
      .from(elementRelations)
      .innerJoin(elementsTable, eq(elementRelations.fromElementId, elementsTable.id))
      .where(
        and(
          eq(elementRelations.toElementId, id),
          eq(elementRelations.relationType, "references"),
          eq(elementsTable.type, "synthesis_note"),
          isNull(elementsTable.deletedAt),
        ),
      )
      .get();
    return row != null;
  }

  /**
   * Seed a cloze card's document body + its `cloze` document_marks inside the card
   * transaction (T034). The body is the RENDERED prompt (answers inline) collapsed
   * to a SINGLE paragraph block, so every deletion's `[start,end]` answer range
   * (computed by `parseCloze` against that same rendered text) anchors to one stable
   * block id. One `cloze` mark per deletion, `attrs: { clozeIndex }`. All on the same
   * `tx` (update_document), so the body + marks commit or roll back with the card.
   */
  private seedClozeBodyWithin(
    tx: Parameters<DocumentRepository["upsertWithin"]>[0],
    cardId: ElementId,
    clozeText: string,
  ): void {
    const parsed = parseCloze(clozeText);
    // The card body is `parsed.rendered` (answers inline) on ONE paragraph block, so
    // every deletion's `[start,end]` (offsets parseCloze computed against THIS exact
    // string) lines up. We build the single-block doc directly (not the multi-block
    // splitter) so a `rendered` containing a blank line can never shift the offsets.
    const blockId = newBlockId();
    const prosemirrorJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId },
          ...(parsed.rendered.length > 0
            ? { content: [{ type: "text", text: parsed.rendered }] }
            : {}),
        },
      ],
    };
    this.documents.upsertWithin(tx, {
      elementId: cardId,
      prosemirrorJson,
      plainText: parsed.rendered,
      blocks: [{ blockType: "paragraph", order: 0, stableBlockId: blockId }],
    });
    // One `cloze` mark per deletion, anchored to the single block.
    for (const deletion of parsed.deletions) {
      // Guard against an out-of-range span (defensive; ranges come from the same text).
      if (deletion.end <= deletion.start) continue;
      this.documents.addMarkWithin(tx, {
        elementId: cardId,
        blockId,
        markType: "cloze",
        range: [deletion.start, deletion.end],
        attrs: { clozeIndex: deletion.index },
      });
    }
  }
}
