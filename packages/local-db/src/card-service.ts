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
 * **Two-scheduler split (NON-NEGOTIABLE):** M6 does NO FSRS math. The card's
 * `review_states` row is created (`fsrsState = "new"`) but left UN-DUE
 * (`dueAt = null`), so a `card_draft` card never appears in a due query before
 * activation. M7 (T036) owns the first FSRS schedule + the
 * `card_draft → active_card` transition. The originating extract is UNCHANGED —
 * it lives on as its own attention-scheduled element; converting it to a card
 * does NOT mutate it and does NOT give it a `review_states`/FSRS row.
 *
 * The renderer never runs any of this; it reaches the service only through the
 * validated `cards.create` IPC command.
 */

import type {
  CardKind,
  ElementId,
  Priority,
  SiblingGroupId,
  SourceLocationId,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { ElementRepository } from "./element-repository";
import { newSiblingGroupId } from "./ids";
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

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.review = new ReviewRepository(db);
    this.sources = new SourceRepository(db);
  }

  /**
   * Author a card from an extract in ONE transaction. See the file header for the
   * five steps + the atomicity + two-scheduler contracts. Returns the new card +
   * its sibling group id + the inherited source-location anchor.
   */
  createFromExtract(input: CreateCardFromExtractInput): CreateCardResult {
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

    const title = (input.title ?? "").trim() || titleFromBody(input);

    const { element, card } = this.db.transaction((tx) => {
      // 1–3) the card element + cards row + UN-DUE review_states row (create_element
      //       + create_card), at stage card_draft. NO FSRS math here.
      const created = this.review.createCardWithin(tx, {
        kind: input.kind,
        title,
        priority,
        stage: "card_draft",
        prompt: input.prompt ?? null,
        answer: input.answer ?? null,
        cloze: input.cloze ?? null,
        parentId,
        sourceId,
        sourceLocationId,
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

      return created;
    });

    return { element, card, siblingGroupId, sourceLocationId };
  }
}
