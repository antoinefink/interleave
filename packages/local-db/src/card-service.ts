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
 *   5. SIBLING GROUPING — when a `siblingGroupId` is supplied (subsequent cards
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
  CardKind,
  ElementId,
  IsoTimestamp,
  Priority,
  SiblingGroupId,
  SourceLocationId,
} from "@interleave/core";
import { canonicalizeCloze, parseCloze } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { newBlockId, newSiblingGroupId, nowIso } from "./ids";
import type { CardWithElement } from "./review-repository";
import { ReviewRepository } from "./review-repository";
import { SourceRepository } from "./source-repository";

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
   * The first FSRS schedule time (T036) — when this authored card becomes due.
   * Defaults to "now" so a freshly created card immediately enters the due deck
   * and can be reviewed (its first grade runs the real FSRS interval math). Passed
   * explicitly only by tests that need a deterministic clock. Setting `dueAt = now`
   * for a brand-new card is not FSRS math — the card stays `fsrsState: "new"` until
   * graded; this just makes it reviewable rather than parked forever un-due.
   */
  readonly asOf?: IsoTimestamp;
}

/** The authored card element + its `cards` row + the sibling group it joined. */
export interface CreateCardResult {
  readonly element: CardWithElement["element"];
  readonly card: CardWithElement["card"];
  /** The (minted or reused) sibling group id, to thread into the next sibling. */
  readonly siblingGroupId: SiblingGroupId;
  /** The inherited source-location anchor id (lineage), or `null` when the extract has none. */
  readonly sourceLocationId: string | null;
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

    // Lineage: parent IS the extract; source root is the extract's source root
    // (or the extract itself when it is its own root); the anchor is the extract's
    // exact source location, so jump-to-source in review (M7) lands correctly.
    const parentId = input.extractId;
    const sourceId = extract.sourceId ?? input.extractId;
    const sourceLocationId: SourceLocationId | null =
      this.sources.findLocationForElement(input.extractId)?.id ?? null;

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
        firstScheduledAt,
      });

      // 4) inherit the extract's tags onto the card (add_tag).
      for (const tagName of inheritedTags) {
        this.elements.addTagWithin(tx, created.element.id, tagName);
      }

      // 5) sibling-group edge card → group (add_relation). Burying in review is M7;
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

      return created;
    });

    return { element, card, siblingGroupId, sourceLocationId };
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
