/**
 * CardRemediationService (T085) — the leech remediation compositions.
 *
 * The leech remediation screen (`apps/web/src/maintenance/LeechRemediation.tsx`)
 * turns the minimal T040 cleanup view into the full repair workflow for repeatedly-
 * failing cards. Most of its actions REUSE existing paths (open-source = T022
 * navigation; lower-priority = T027 `elements.setPriority`; suspend/delete/rewrite/
 * un-leech = T038/T040 `cards.*`). This service owns the THREE new domain
 * compositions those reuses don't cover — each one transaction + the correct
 * EXISTING `operation_log` op (the closed op set is unchanged — NO new op types),
 * with `card → source location → source` and `card → extract` lineage preserved and
 * the card's append-only `review_logs` history NEVER destroyed:
 *
 *  - **split** — split a multi-fact failing card into 2+ ATOMIC sibling cards. Each
 *    new card inherits the original's lineage (`parentId` extract,
 *    `sourceLocationId`, numeric priority, tags) and starts a FRESH `review_states`
 *    row (a split card is a NEW card to re-learn — never copies the original's FSRS
 *    memory state). All new cards are grouped as `sibling_group` siblings (so review
 *    never shows them back-to-back, T039). The original is soft-deleted (default) or
 *    suspended (the user's choice) — its `review_logs` survive, recoverable from
 *    trash. All in ONE transaction; logs `create_element`/`create_card` per new card,
 *    `add_relation` (`sibling_group`) per grouping, and `soft_delete_element` (or
 *    `update_element` for suspend) for the original.
 *  - **addContext** — append a clarifying CONTEXT NOTE to a card so the prompt is
 *    answerable, WITHOUT a new column: the note is recorded as a durable op-payload
 *    marker (`{ context: note }`) read back via an op-log scan (mirrors
 *    `CardEditService.flagState`). The card body / `review_states` / lineage are
 *    untouched and it STAYS in rotation (context is a fix, not an exit). Logs
 *    `update_element`.
 *  - **backToExtract** — send the card's originating EXTRACT (its `parentId`, an
 *    ATTENTION item) back into the attention queue for re-distillation by
 *    rescheduling it to DUE-NOW via {@link ElementRepository.rescheduleWithin}
 *    (attention op `reschedule_element`, NOT FSRS — the extract never gets a
 *    `review_states` row). The leech card is suspended (default), soft-deleted, or
 *    kept. This is the ONLY T085 action that touches the attention scheduler.
 *
 * **Two-scheduler split (load-bearing):** a card is the only FSRS-scheduled element;
 * an extract is an attention item. split + addContext are card-side (they author /
 * mark cards, fresh FSRS state); backToExtract is the single attention-side action
 * and it reactivates the parent extract via the EXISTING attention reschedule seam —
 * it NEVER writes `review_states` for the extract (that would break the split).
 *
 * The renderer never runs any of this; it reaches the service only through the
 * validated `cards.split` / `cards.addContext` / `cards.backToExtract` IPC commands.
 */

import type {
  CardKind,
  ElementId,
  Priority,
  SiblingGroupId,
  SourceLocationId,
} from "@interleave/core";
import { elements, type InterleaveDatabase } from "@interleave/db";
import { eq } from "drizzle-orm";
import { type CardBodyForKind, resolveCardBodyForKind } from "./card-edit-service";
import { ElementRepository } from "./element-repository";
import { newSiblingGroupId, nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import { type CardWithElement, ReviewRepository } from "./review-repository";

/** One authored atomic part of a split. Only fields valid for its kind are used. */
export interface CardRemediationPart {
  readonly kind: CardKind;
  readonly prompt?: string | null;
  readonly answer?: string | null;
  readonly cloze?: string | null;
}

/** What to do with the original card after a split (default: soft-delete it). */
export type SplitOriginalDisposition = "delete" | "suspend";

/** Arguments to split a leech card into atomic siblings. */
export interface SplitLeechCardInput {
  readonly cardId: ElementId;
  /** The authored atomic parts (≥2) — one new sibling card per part. */
  readonly parts: readonly CardRemediationPart[];
  /** Disposition of the ORIGINAL card; default `delete` (soft, recoverable). */
  readonly originalDisposition?: SplitOriginalDisposition;
}

/** The cards produced by a split. */
export interface SplitLeechCardResult {
  readonly cards: readonly CardWithElement[];
  /** The sibling group all the split cards joined. */
  readonly siblingGroupId: SiblingGroupId;
}

/** The card after an add-context action. */
export interface AddContextResult {
  readonly card: CardWithElement;
  /** The accumulated context note now on the card (op-log-derived). */
  readonly context: string | null;
}

/** What to do with the leech card after a back-to-extract action. */
export type BackToExtractCardDisposition = "suspend" | "delete" | "keep";

/** The result of a back-to-extract reactivation. */
export interface BackToExtractResult {
  /** The reactivated parent extract (due-now), or `null` when the card has none live. */
  readonly extract: CardWithElement["element"] | null;
}

export class CardRemediationService {
  private readonly elements: ElementRepository;
  private readonly review: ReviewRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.review = new ReviewRepository(db);
  }

  /** Load a live (non-deleted) card, throwing when the id is not a live card. */
  private requireCard(id: ElementId): CardWithElement {
    const card = this.review.findCardById(id);
    if (card?.element.type !== "card" || card.element.deletedAt) {
      throw new Error(`CardRemediationService: card ${id} not found`);
    }
    return card;
  }

  /**
   * Split a failing card into 2+ ATOMIC sibling cards (T085). See the file header
   * for the lineage + fresh-FSRS + sibling-grouping + disposition contract. Returns
   * the new cards (in the authored order). Each part is validated non-empty for its
   * kind by the SAME {@link resolveCardBodyForKind} rule the rewrite path uses.
   */
  split(input: SplitLeechCardInput): SplitLeechCardResult {
    const original = this.requireCard(input.cardId);
    if (input.parts.length < 2) {
      throw new Error("CardRemediationService.split: a split needs at least 2 parts");
    }
    // Validate + normalize every part UP FRONT (before any write) so a bad part
    // rejects the whole split with a clear error and no partial mutation.
    const bodies: { kind: CardKind; body: CardBodyForKind }[] = input.parts.map((part) => ({
      kind: part.kind,
      body: resolveCardBodyForKind(
        part.kind,
        { prompt: "", answer: "", cloze: "" },
        { prompt: part.prompt ?? null, answer: part.answer ?? null, cloze: part.cloze ?? null },
      ),
    }));

    // Lineage to inherit from the original (read up front — no writes yet).
    const parentId = original.element.parentId ?? null;
    const sourceId = original.element.sourceId ?? null;
    const sourceLocationId = (original.card.sourceLocationId as SourceLocationId | null) ?? null;
    const priority: Priority = original.element.priority;
    const inheritedTags = this.elements.listTags(input.cardId);
    const disposition: SplitOriginalDisposition = input.originalDisposition ?? "delete";

    // All split cards share one sibling group so review never pairs them back-to-back.
    const siblingGroupId: SiblingGroupId = newSiblingGroupId();
    // A split card is a NEW card to learn — author it DUE NOW so it enters the deck
    // (its fresh `review_states` is `fsrsState: "new"`; the first grade runs FSRS).
    const firstScheduledAt = nowIso();

    return this.db.transaction((tx) => {
      const created: CardWithElement[] = [];
      for (const { kind, body } of bodies) {
        const title = titleForBody(kind, body);
        // Fresh card + fresh `review_states` (NEVER the original's FSRS memory).
        const card = this.review.createCardWithin(tx, {
          kind,
          title,
          priority,
          stage: "card_draft",
          prompt: body.prompt,
          answer: body.answer,
          cloze: body.cloze,
          parentId,
          sourceId,
          sourceLocationId,
          firstScheduledAt,
        });
        // Inherit the original's tags onto each split card (add_tag).
        for (const tagName of inheritedTags) {
          this.elements.addTagWithin(tx, card.element.id, tagName);
        }
        // Sibling-group edge card → group (add_relation), mirroring CardService: the
        // edge points at the lineage parent (the extract) when present, else the
        // original card, so the grouping is recorded even for an Anki-imported leech.
        this.elements.addRelationWithin(tx, {
          fromElementId: card.element.id,
          toElementId: parentId ?? input.cardId,
          relationType: "sibling_group",
          siblingGroupId,
        });
        created.push(card);
      }

      // The original card is REPLACED by the atomic parts. Default: soft-delete it
      // (its `review_logs` history survives, recoverable from trash); optionally
      // suspend it instead. Either way its lineage rows stay valid.
      if (disposition === "suspend") {
        this.elements.updateWithin(tx, input.cardId, { status: "suspended" });
      } else {
        this.elements.softDeleteWithin(tx, input.cardId);
      }

      return { cards: created, siblingGroupId };
    });
  }

  /**
   * Append a clarifying CONTEXT NOTE to a card (T085) so the prompt becomes
   * answerable, WITHOUT a new column. The note is recorded as a durable op-payload
   * marker (`{ context: note }`) read back via {@link contextNote} (mirrors
   * `CardEditService.flagState`). The card body, `review_states`, and lineage are
   * untouched and the card STAYS in rotation (context is a fix, not an exit). Logs
   * `update_element` and stamps `elements.updatedAt`, in ONE transaction.
   */
  addContext(cardId: ElementId, note: string): AddContextResult {
    this.requireCard(cardId); // validate live card before any write
    const trimmed = note.trim();
    if (trimmed.length === 0) {
      throw new Error("CardRemediationService.addContext: a context note cannot be empty");
    }
    this.db.transaction((tx) => {
      // The context lives only in the op-log marker (no new column); stamp
      // `elements.updatedAt` so the change is observable + ordered (mirrors
      // `CardEditService.flag`). The card body / `review_states` are untouched.
      const updatedAt = nowIso();
      tx.update(elements).set({ updatedAt }).where(eq(elements.id, cardId)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: cardId,
        payload: { id: cardId, context: trimmed },
      });
    });
    return { card: this.requireCard(cardId), context: this.contextNote(cardId) };
  }

  /**
   * The card's current context note (T085) — the LATEST `update_element` op carrying
   * a `context` marker wins (a later add-context replaces an earlier one). Read-only;
   * the inspector / review face surface it as a separate "context" line. Mirrors
   * `CardEditService.flagState`'s op-log-derived read.
   */
  contextNote(cardId: ElementId): string | null {
    const ops = new OperationLogRepository(this.db).listForElement(cardId); // newest first
    for (const op of ops) {
      if (
        op.opType === "update_element" &&
        typeof op.payload === "object" &&
        op.payload !== null &&
        "context" in (op.payload as Record<string, unknown>)
      ) {
        const payload = op.payload as { context?: unknown };
        return typeof payload.context === "string" ? payload.context : null;
      }
    }
    return null;
  }

  /**
   * Send a card's originating EXTRACT back into the attention queue (T085) for
   * re-distillation by rescheduling it to DUE-NOW. Resolves the card's `parentId`
   * filtered to a LIVE `extract` element; when absent (e.g. an Anki-imported card)
   * returns `{ extract: null }` and mutates nothing destructive. Otherwise, in ONE
   * transaction: reschedule the extract to due-now (status `scheduled`,
   * `reschedule_element` on the ATTENTION scheduler — never `review_states`) and
   * apply the chosen card disposition (default suspend; the card is being replaced by
   * re-distilled material). This is the ONLY T085 action touching attention.
   */
  backToExtract(
    cardId: ElementId,
    cardDisposition: BackToExtractCardDisposition = "suspend",
  ): BackToExtractResult {
    const card = this.requireCard(cardId);
    const parentId = card.element.parentId ?? null;
    const parent = parentId ? this.elements.findById(parentId) : null;
    if (!parent || parent.deletedAt || parent.type !== "extract") {
      // No live parent extract to send back (e.g. an Anki-imported card). Do NOT
      // touch the card — the screen disables the action via `parentExtractId`.
      return { extract: null };
    }
    return this.db.transaction((tx) => {
      // Reactivate the parent extract to DUE-NOW on the ATTENTION scheduler. Going
      // through `rescheduleWithin` (not `setStage`, which schedules a FUTURE stage
      // interval, nor `postpone`, which pushes further out) is load-bearing: this is
      // an attention reschedule (`reschedule_element`), never an FSRS write.
      const extract = this.elements.rescheduleWithin(tx, parent.id, nowIso(), "scheduled", {
        backToExtract: true,
        fromCardId: cardId,
      });
      // The leech card is replaced by re-distilled material — default suspend
      // (recoverable), optionally soft-delete, or keep it.
      if (cardDisposition === "suspend") {
        this.elements.updateWithin(tx, cardId, { status: "suspended" });
      } else if (cardDisposition === "delete") {
        this.elements.softDeleteWithin(tx, cardId);
      }
      return { extract };
    });
  }
}

/** A short fallback title derived from an authored split part's body. */
function titleForBody(kind: CardKind, body: CardBodyForKind): string {
  const raw = kind === "cloze" ? (body.cloze ?? "") : (body.prompt ?? "") || (body.answer ?? "");
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return kind === "cloze" ? "Cloze card" : "Q&A card";
  return normalized.length > 80 ? `${normalized.slice(0, 80).trimEnd()}…` : normalized;
}
