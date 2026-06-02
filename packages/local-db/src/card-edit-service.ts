/**
 * CardEditService (T038) — in-review card repair.
 *
 * The review session's repair row (`design/kit/app/screen-review.jsx`: Edit /
 * Open source / Suspend / Delete / Flag-as-bad) becomes functional so the user
 * can fix a bad card the MOMENT it surfaces, without leaving review. This service
 * owns the four MUTATING repairs (open-source is renderer navigation, not a
 * mutation); it composes `ElementRepository` + writes the `cards` body row, each
 * in ONE transaction with the correct EXISTING `operation_log` op (the closed
 * 15-op set is unchanged — NO new op types):
 *
 *  - `updateBody`  → edit the card's prompt/answer (Q&A) or cloze text. Writes the
 *    `cards` side-table row AND logs `update_element` on the OWNING `card` element
 *    (the body fields live on the card element / its `cards` row). Lineage
 *    (`sourceLocationId`), the `review_states` FSRS state, and the append-only
 *    `review_logs` history are NEVER touched by an edit — editing the body must not
 *    corrupt the in-flight FSRS state.
 *  - `suspend`     → status `suspended` (`update_element`). The card leaves the due
 *    deck (`QueueRepository.dueCards` already excludes `suspended`) but keeps its
 *    `review_states`/logs — recoverable by un-suspending.
 *  - `delete`      → SOFT delete (`deletedAt` + status `deleted`,
 *    `soft_delete_element`); lineage rows stay valid, recoverable from trash (T044).
 *  - `flag`        → a NON-destructive "flag-as-bad" QUALITY marker for later triage.
 *    Stored WITHOUT a new column (the durable leech/flag migration is T040's, to
 *    keep this milestone to at most one card-attribute migration): the flag state
 *    is recorded in the `update_element` op payload (`{ flagged, reason? }`) and the
 *    LATEST such marker is the card's current flag state — mirrors the schema-churn-
 *    free `ExtractService.countPostpones` pattern. Logs `update_element`.
 *
 * **Two-scheduler split (load-bearing):** a card is the only FSRS-scheduled element.
 * None of these repairs writes `review_states` — an edit changes the body only, a
 * suspend/delete/flag changes status/markers. FSRS math stays in `packages/scheduler`.
 *
 * The renderer never runs any of this; it reaches the service only through the
 * validated `cards.*` IPC commands (T038).
 */

import type { CardKind, ElementId } from "@interleave/core";
import { canonicalizeCloze } from "@interleave/core";
import { type CardRow, cards, elements, type InterleaveDatabase } from "@interleave/db";
import { eq } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { rowToElement } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import { type CardWithElement, ReviewRepository } from "./review-repository";

/** A card body edit. Only the fields valid for the card's `kind` are applied. */
export interface UpdateCardBodyInput {
  readonly prompt?: string | null;
  readonly answer?: string | null;
  readonly cloze?: string | null;
}

/** A card element + its `cards` side-table row, after a repair. */
export type CardEditResult = CardWithElement;

/** The resolved, validated body fields for a card kind. */
export interface CardBodyForKind {
  readonly prompt: string | null;
  readonly answer: string | null;
  readonly cloze: string | null;
}

/**
 * Resolve + validate a card body for its kind — the SINGLE non-empty-per-kind rule
 * shared by {@link CardEditService.updateBody} (the in-review rewrite, T038) and the
 * split composition (T085, {@link CardRemediationService.split}). Only the fields
 * valid for the card's `kind` are written; a `qa` card requires a non-empty prompt
 * AND answer, a `cloze` card requires non-empty cloze text (a bare `{{answer}}` is
 * auto-numbered to the canonical `{{c1::answer}}`). Throws a clear error when the
 * resolved body is empty for the kind. Pure — no DB, no op-log; the validation is
 * single-sourced here so the rewrite path + the split path can never diverge.
 *
 * @param current the existing body to fall back to per field (pass empty strings to
 *   require every field on a fresh authored part, as the split does).
 */
export function resolveCardBodyForKind(
  kind: CardKind,
  current: { prompt?: string | null; answer?: string | null; cloze?: string | null },
  patch: UpdateCardBodyInput,
): CardBodyForKind {
  if (kind === "qa") {
    const prompt = (patch.prompt ?? current.prompt ?? "").trim();
    const answer = (patch.answer ?? current.answer ?? "").trim();
    if (prompt.length === 0) throw new Error("CardEditService: a Q&A card requires a prompt");
    if (answer.length === 0) throw new Error("CardEditService: a Q&A card requires an answer");
    return { prompt, answer, cloze: null };
  }
  // cloze: keep the canonical `{{c1::answer}}` text (auto-number bare markers).
  const raw = (patch.cloze ?? current.cloze ?? "").trim();
  if (raw.length === 0) throw new Error("CardEditService: a cloze card requires cloze text");
  return { prompt: null, answer: null, cloze: canonicalizeCloze(raw) };
}

export class CardEditService {
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
      throw new Error(`CardEditService: card ${id} not found`);
    }
    return card;
  }

  /**
   * Edit a card's body (T038). Updates the `cards` row's prompt/answer (Q&A) or
   * cloze text, stamps `elements.updatedAt`, and logs `update_element` — all in ONE
   * transaction. Only the fields valid for the card's `kind` are written; a `qa`
   * card keeps prompt/answer, a `cloze` card keeps its canonical cloze text (a bare
   * `{{answer}}` is auto-numbered like {@link CardService}). Validates that the edit
   * leaves the card non-empty for its kind (the rich card-quality gate is M6/T035).
   * Lineage, `review_states`, and `review_logs` are NEVER touched.
   */
  updateBody(id: ElementId, patch: UpdateCardBodyInput): CardEditResult {
    const existing = this.requireCard(id);
    const kind = existing.card.kind as CardKind;

    // Resolve the next body fields for this kind (ignore fields foreign to the kind).
    const next = this.nextBodyForKind(kind, existing.card, patch);

    return this.db.transaction((tx) => {
      tx.update(cards)
        .set({ prompt: next.prompt, answer: next.answer, cloze: next.cloze })
        .where(eq(cards.elementId, id))
        .run();

      // The body fields live on the `card` element / its `cards` row, so the edit is
      // logged as `update_element` on the card element (no new op type). This also
      // stamps `elements.updatedAt` so the change is observable + ordered.
      const updatedAt = nowIso();
      tx.update(elements).set({ updatedAt }).where(eq(elements.id, id)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: id,
        payload: { id, body: { prompt: next.prompt, answer: next.answer, cloze: next.cloze } },
      });

      const card = tx.select().from(cards).where(eq(cards.elementId, id)).get();
      const elementRow = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (!card || !elementRow) {
        throw new Error(`CardEditService.updateBody: card ${id} missing after update`);
      }
      return { element: rowToElement(elementRow), card };
    });
  }

  /**
   * Suspend a card (T038): status `suspended` via {@link ElementRepository.update}
   * (`update_element`). The card drops out of `QueueRepository.dueCards` (which only
   * surfaces live, non-suspended cards) but keeps its FSRS `review_states` + the
   * append-only `review_logs` — recoverable by un-suspending.
   */
  suspend(id: ElementId): CardEditResult {
    const card = this.requireCard(id);
    const element = this.elements.update(id, { status: "suspended" });
    return { element, card: card.card };
  }

  /**
   * SOFT-delete a card (T038) via {@link ElementRepository.softDelete}
   * (`soft_delete_element`): `deletedAt` + status `deleted`, never a hard DELETE.
   * Lineage references remain valid and it is restorable from the trash (T044).
   */
  delete(id: ElementId): CardEditResult {
    const card = this.requireCard(id);
    const element = this.elements.softDelete(id);
    return { element, card: card.card };
  }

  /**
   * Flag (or un-flag) a card as bad (T038) — a non-destructive QUALITY marker for
   * later triage, stored WITHOUT a new column. The flag state + optional reason are
   * recorded in the `update_element` op payload (`{ flagged, reason? }`); the LATEST
   * such marker is the card's current flag state (read via {@link isFlagged}). Logs
   * `update_element` and stamps `elements.updatedAt`; the card stays in the deck (a
   * flag is advisory, unlike suspend) and its body/lineage/FSRS state are untouched.
   */
  flag(id: ElementId, flagged: boolean, reason?: string | null): CardEditResult {
    const card = this.requireCard(id);
    const element = this.db.transaction((tx) => {
      const updatedAt = nowIso();
      tx.update(elements).set({ updatedAt }).where(eq(elements.id, id)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: id,
        payload: { id, flagged, ...(reason != null ? { reason } : {}) },
      });
      const elementRow = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (!elementRow) {
        throw new Error(`CardEditService.flag: card ${id} missing after update`);
      }
      return rowToElement(elementRow);
    });
    return { element, card: card.card };
  }

  /**
   * The card's current flag-as-bad state, derived from its op-log: the LATEST
   * `update_element` op carrying a `flagged` marker wins (a later un-flag clears an
   * earlier flag). Read-only; the schema-churn-free flag read the inspector + the
   * review face use. Returns `{ flagged, reason }` (`reason` from the same marker).
   */
  flagState(id: ElementId): { flagged: boolean; reason: string | null } {
    const ops = new OperationLogRepository(this.db).listForElement(id); // newest first
    for (const op of ops) {
      if (
        op.opType === "update_element" &&
        typeof op.payload === "object" &&
        op.payload !== null &&
        "flagged" in (op.payload as Record<string, unknown>)
      ) {
        const payload = op.payload as { flagged?: unknown; reason?: unknown };
        return {
          flagged: payload.flagged === true,
          reason: typeof payload.reason === "string" ? payload.reason : null,
        };
      }
    }
    return { flagged: false, reason: null };
  }

  /** Convenience boolean form of {@link flagState}. */
  isFlagged(id: ElementId): boolean {
    return this.flagState(id).flagged;
  }

  /**
   * Resolve the next body fields for the card's kind, validating non-empty.
   * Delegates to the shared {@link resolveCardBodyForKind} so the rewrite path and
   * the split path (T085) validate by the SAME single-sourced rule.
   */
  private nextBodyForKind(
    kind: CardKind,
    current: CardRow,
    patch: UpdateCardBodyInput,
  ): CardBodyForKind {
    return resolveCardBodyForKind(kind, current, patch);
  }
}
