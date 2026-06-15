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

import type {
  CardKind,
  ElementId,
  FactLifetime,
  FactStability,
  IsoTimestamp,
  ReviewState,
} from "@interleave/core";
import { canonicalizeCloze, isFactStability } from "@interleave/core";
import {
  type CardRow,
  cards,
  elements,
  type InterleaveDatabase,
  reviewLogs,
  reviewStates,
} from "@interleave/db";
import type { ReStabilizeOutcome } from "@interleave/scheduler";
import { and, eq, gt } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { newReviewLogId, nowIso } from "./ids";
import { rowToElement } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import { type CardWithElement, ReviewRepository } from "./review-repository";
import type { DbClient } from "./types";

/** A card body edit. Only the fields valid for the card's `kind` are applied. */
export interface UpdateCardBodyInput {
  readonly prompt?: string | null;
  readonly answer?: string | null;
  readonly cloze?: string | null;
}

/**
 * A claim-lifetime edit (T090) — the six fields a fact may carry. Each is OPTIONAL: an
 * omitted field is LEFT UNCHANGED; an explicit `null`/`""` CLEARS it (a fact with no
 * lifetime never expires). Mirrors {@link FactLifetime} as a partial patch. The dates
 * are stored as-entered (ISO preferred); `factStability` is validated against the core
 * tuple. Editing these is `update_element` (no new op type, no status change).
 */
export interface UpdateCardLifetimeInput {
  readonly factStability?: FactStability | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly jurisdiction?: string | null;
  readonly softwareVersion?: string | null;
  readonly reviewBy?: string | null;
}

/** Read a card row's six claim-lifetime columns as a {@link FactLifetime} (T090). */
export function cardRowToLifetime(card: CardRow): FactLifetime {
  return {
    factStability: isFactStability(card.factStability) ? card.factStability : null,
    validFrom: card.validFrom ?? null,
    validUntil: card.validUntil ?? null,
    jurisdiction: card.jurisdiction ?? null,
    softwareVersion: card.softwareVersion ?? null,
    reviewBy: card.reviewBy ?? null,
  };
}

/** A card element + its `cards` side-table row, after a repair. */
export type CardEditResult = CardWithElement;

/**
 * The receipt of a re-stabilization (T125): the marker `review_logs` row that was written,
 * and the schedule before/after the demotion. `null` on a body edit that did NOT
 * re-stabilize. Backs the "Keep schedule instead" undo and the renderer receipt.
 */
export interface ReStabilizeReceipt {
  readonly reviewLogId: string;
  readonly previousDueAt: IsoTimestamp | null;
  readonly newDueAt: IsoTimestamp | null;
}

/** A body edit result that also reports whether the card was re-stabilized (T125). */
export interface CardReStabilizeResult extends CardWithElement {
  /** The re-stabilization receipt, or `null` when the edit kept the schedule. */
  readonly reStabilized: ReStabilizeReceipt | null;
}

/** The outcome of an attempt to undo a re-stabilization (T125). */
export interface ReStabilizeUndoResult {
  readonly undone: boolean;
  /** The restored due date when undone, else `null`. */
  readonly restoredDueAt: IsoTimestamp | null;
  /** Why nothing was undone, when `undone` is `false`. */
  readonly reason?: string;
}

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
   * Edit a card's body (T038 + T125 write barrier). Updates the `cards` row's
   * prompt/answer (Q&A) or cloze text, stamps `elements.updatedAt`, and logs
   * `update_element` — all in ONE transaction. Only the fields valid for the card's
   * `kind` are written; a `qa` card keeps prompt/answer, a `cloze` card keeps its
   * canonical cloze text. Validates that the edit leaves the card non-empty for its kind.
   *
   * **The refined M7 invariant (T125):** an edit never corrupts *in-flight* review state,
   * but a SUBSTANTIVE edit may re-stabilize the *persisted* state. When `reStabilize` is
   * supplied (the caller resolved the demotion through the scheduler service), this method
   * ALSO — in the SAME transaction — demotes `review_states` to the confirmation interval,
   * mirrors `elements.due_at`, writes a non-grade MARKER row to `review_logs` carrying the
   * full FSRS preimage, and logs the demotion as `reschedule_element` (marked
   * `cardReStabilize` so global ⌘Z defers to the receipt undo). When `reStabilize` is
   * absent (a typo edit, or the user kept the schedule), lineage / `review_states` /
   * `review_logs` are untouched — the unchanged T038 behaviour.
   */
  updateBody(
    id: ElementId,
    patch: UpdateCardBodyInput,
    reStabilize?: { readonly outcome: ReStabilizeOutcome; readonly at: IsoTimestamp } | null,
  ): CardReStabilizeResult {
    const existing = this.requireCard(id);
    const kind = existing.card.kind as CardKind;

    // Resolve the next body fields for this kind (ignore fields foreign to the kind).
    const next = this.nextBodyForKind(kind, existing.card, patch);

    return this.db.transaction((tx) => {
      const at = reStabilize?.at ?? (nowIso() as IsoTimestamp);
      tx.update(cards)
        .set({ prompt: next.prompt, answer: next.answer, cloze: next.cloze })
        .where(eq(cards.elementId, id))
        .run();

      // The body fields live on the `card` element / its `cards` row, so the edit is
      // logged as `update_element` on the card element (no new op type). This also
      // stamps `elements.updatedAt` so the change is observable + ordered.
      tx.update(elements).set({ updatedAt: at }).where(eq(elements.id, id)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: id,
        payload: { id, body: { prompt: next.prompt, answer: next.answer, cloze: next.cloze } },
      });

      const reStabilized = reStabilize
        ? this.applyReStabilizeWithin(tx, id, reStabilize.outcome, at)
        : null;

      const card = tx.select().from(cards).where(eq(cards.elementId, id)).get();
      const elementRow = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (!card || !elementRow) {
        throw new Error(`CardEditService.updateBody: card ${id} missing after update`);
      }
      return { element: rowToElement(elementRow), card, reStabilized };
    });
  }

  /**
   * Apply a re-stabilization within the body-edit transaction (T125). Writes the marker
   * `review_logs` row (the demotion's exact FSRS preimage + the edit class/choice — NOT a
   * graded review: a CHECK-valid placeholder `rating`, excluded from every reader by
   * `edit_marker_at IS NOT NULL`), demotes `review_states` to the confirmation interval,
   * mirrors `elements.due_at`, and logs the demotion as `reschedule_element` carrying the
   * full preimage and a `cardReStabilize` marker (so global ⌘Z defers — the reversal is
   * the guarded receipt undo {@link undoReStabilize}). `last_reviewed_at` is NOT advanced
   * (the demotion is not a review), so a subsequently-landing in-flight grade keeps its
   * true elapsed-days.
   */
  private applyReStabilizeWithin(
    tx: DbClient,
    id: ElementId,
    outcome: ReStabilizeOutcome,
    at: IsoTimestamp,
  ): ReStabilizeReceipt {
    const { prev, next } = outcome;
    const reviewLogId = newReviewLogId();
    tx.insert(reviewLogs)
      .values({
        id: reviewLogId,
        elementId: id,
        // Placeholder rating: a re-stabilization is NOT a recall observation. Every
        // `review_logs` reader excludes marker rows via `edit_marker_at IS NOT NULL`, so
        // this value is never read as a grade (KTD-3); it only satisfies the rating CHECK.
        rating: "good",
        reviewedAt: at,
        responseMs: 0,
        promptMs: null,
        prevState: prev.fsrsState,
        prevDueAt: prev.dueAt,
        prevStability: prev.stability,
        prevDifficulty: prev.difficulty,
        prevElapsedDays: prev.elapsedDays,
        prevScheduledDays: prev.scheduledDays,
        prevReps: prev.reps,
        prevLapses: prev.lapses,
        prevLearningSteps: prev.learningSteps,
        prevLastReviewedAt: prev.lastReviewedAt,
        nextState: next.fsrsState,
        nextStability: next.stability,
        nextDifficulty: next.difficulty,
        nextDueAt: next.dueAt ?? at,
        nextElapsedDays: next.elapsedDays,
        nextScheduledDays: next.scheduledDays,
        nextReps: next.reps,
        nextLapses: next.lapses,
        nextLearningSteps: next.learningSteps,
        editMarkerAt: at,
        editClass: "substantive",
        editChoice: "re_stabilize",
      })
      .run();

    tx.update(reviewStates)
      .set({
        dueAt: next.dueAt,
        stability: next.stability,
        difficulty: next.difficulty,
        elapsedDays: next.elapsedDays,
        scheduledDays: next.scheduledDays,
        reps: next.reps,
        lapses: next.lapses,
        fsrsState: next.fsrsState,
        learningSteps: next.learningSteps,
        // last_reviewed_at PRESERVED (the demotion is not a review).
        lastReviewedAt: next.lastReviewedAt,
      })
      .where(eq(reviewStates.elementId, id))
      .run();

    // Mirror the FSRS due into elements.due_at so element-level reads agree with the deck.
    tx.update(elements).set({ dueAt: next.dueAt }).where(eq(elements.id, id)).run();

    new OperationLogRepository(tx).append(tx, {
      opType: "reschedule_element",
      elementId: id,
      payload: {
        id,
        dueAt: next.dueAt,
        prevDueAt: prev.dueAt,
        // The compound-mutation marker: global ⌘Z defers (see UndoService.isInvertible);
        // the reversal is the guarded receipt undo, which reads the marker review_logs row.
        cardReStabilize: true,
        reviewLogId,
      },
    });

    return { reviewLogId, previousDueAt: prev.dueAt, newDueAt: next.dueAt };
  }

  /**
   * Undo a re-stabilization (T125 "Keep schedule instead") — the single, guarded,
   * receipt-scoped reversal of {@link applyReStabilizeWithin}. Restores `review_states` to
   * the EXACT prior FSRS tuple from the marker row's `prev*` preimage (and mirrors
   * `elements.due_at`), under a four-part current-state guard: the marker row must exist,
   * belong to this card, be a `re_stabilize` marker, AND the card's current FSRS state must
   * still match what the demotion wrote (`due`/`stability`/`difficulty`/`state`/`reps`/
   * `lapses`). If the card was REVIEWED since the edit, the guard fails and nothing is
   * restored — newer FSRS intent wins.
   *
   * The body text stays as edited (the demotion is the only thing reversed — "keep the
   * schedule"), and the marker row stays in the append-only `review_logs` (the optimizer
   * cut reflects a permanent fact: the text changed, so pre-edit grades stay excluded). The
   * reversal is logged `reschedule_element` with `receiptRestore` so global ⌘Z never
   * re-reverses it.
   */
  undoReStabilize(cardElementId: ElementId, reviewLogId: string): ReStabilizeUndoResult {
    const markerRow = this.db.select().from(reviewLogs).where(eq(reviewLogs.id, reviewLogId)).get();
    if (
      !markerRow ||
      markerRow.elementId !== cardElementId ||
      markerRow.editMarkerAt == null ||
      markerRow.editChoice !== "re_stabilize"
    ) {
      return { undone: false, restoredDueAt: null, reason: "Re-stabilization not found" };
    }
    // Liveness guard: never restore a schedule onto a soft-deleted / non-card element (it
    // sits in the trash; restoring the old long schedule there would surface it wrong on
    // recovery). A suspended card is still live and recoverable, so undo is allowed.
    const cardRow = this.review.findCardById(cardElementId);
    if (cardRow?.element.type !== "card" || cardRow.element.deletedAt) {
      return { undone: false, restoredDueAt: null, reason: "Card is not available" };
    }
    // Newer-marker guard: back-to-back re-stabilizations converge to an identical demoted
    // state (stability floored to 1, due floored to the soonest), so the four-part guard
    // below would PASS for an OLD marker even though a newer demotion happened on top of it.
    // Undoing the old marker would then revert past BOTH demotions to the genuine original
    // schedule. Refuse: only the latest re-stabilization is undoable through its receipt.
    const newerMarker = this.db
      .select({ id: reviewLogs.id })
      .from(reviewLogs)
      .where(
        and(
          eq(reviewLogs.elementId, cardElementId),
          eq(reviewLogs.editChoice, "re_stabilize"),
          gt(reviewLogs.editMarkerAt, markerRow.editMarkerAt),
        ),
      )
      .limit(1)
      .get();
    if (newerMarker) {
      return { undone: false, restoredDueAt: null, reason: "A newer re-stabilization exists" };
    }
    const current = this.review.findReviewState(cardElementId);
    if (!current) {
      return { undone: false, restoredDueAt: null, reason: "Card has no review state" };
    }
    // Four-part guard: refuse if the card was reviewed (or otherwise rescheduled) since the
    // demotion — the live FSRS state must still equal what the demotion wrote. Distinguish an
    // already-restored card (a prior undo succeeded; the marker stays append-only) from a card
    // genuinely reviewed since the edit, so the receipt reports the honest reason.
    if (!this.matchesDemotedState(current, markerRow)) {
      const reason = this.matchesRestoredState(current, markerRow)
        ? "Schedule already restored"
        : "Card was reviewed since the edit";
      return { undone: false, restoredDueAt: null, reason };
    }
    const restoredDueAt = (markerRow.prevDueAt ?? null) as IsoTimestamp | null;
    this.db.transaction((tx) => {
      tx.update(reviewStates)
        .set({
          dueAt: markerRow.prevDueAt,
          stability: markerRow.prevStability ?? 0,
          difficulty: markerRow.prevDifficulty ?? 0,
          elapsedDays: markerRow.prevElapsedDays ?? 0,
          scheduledDays: markerRow.prevScheduledDays ?? 0,
          reps: markerRow.prevReps ?? 0,
          lapses: markerRow.prevLapses ?? 0,
          fsrsState: markerRow.prevState,
          learningSteps: markerRow.prevLearningSteps ?? 0,
          lastReviewedAt: markerRow.prevLastReviewedAt,
        })
        .where(eq(reviewStates.elementId, cardElementId))
        .run();
      tx.update(elements)
        .set({ dueAt: markerRow.prevDueAt, updatedAt: nowIso() })
        .where(eq(elements.id, cardElementId))
        .run();
      new OperationLogRepository(tx).append(tx, {
        opType: "reschedule_element",
        elementId: cardElementId,
        payload: {
          id: cardElementId,
          dueAt: markerRow.prevDueAt,
          prevDueAt: markerRow.nextDueAt,
          // Receipt-scoped reversal: never re-reversed by global ⌘Z (UndoService.isInvertible).
          cardReStabilizeUndo: true,
          receiptRestore: true,
          reviewLogId,
        },
      });
    });
    return { undone: true, restoredDueAt };
  }

  /**
   * Whether the card's CURRENT FSRS state still equals what the re-stabilization wrote
   * (the marker row's `next*`). Used by {@link undoReStabilize}'s guard so a card reviewed
   * since the edit is not clobbered. Compares the fields a real review would change.
   */
  private matchesDemotedState(
    current: ReviewState,
    markerRow: {
      readonly nextDueAt: string | null;
      readonly nextStability: number;
      readonly nextDifficulty: number;
      readonly nextState: string;
      readonly nextReps: number | null;
      readonly nextLapses: number | null;
    },
  ): boolean {
    return (
      (current.dueAt ?? null) === (markerRow.nextDueAt ?? null) &&
      current.stability === markerRow.nextStability &&
      current.difficulty === markerRow.nextDifficulty &&
      current.fsrsState === markerRow.nextState &&
      current.reps === (markerRow.nextReps ?? current.reps) &&
      current.lapses === (markerRow.nextLapses ?? current.lapses)
    );
  }

  /**
   * Whether the card's CURRENT FSRS state equals the marker row's `prev*` preimage — i.e.
   * a prior undo already restored this schedule. Lets {@link undoReStabilize} report
   * "already restored" instead of the misleading "reviewed since the edit" on a repeated undo.
   */
  private matchesRestoredState(
    current: ReviewState,
    markerRow: {
      readonly prevDueAt: string | null;
      readonly prevStability: number | null;
      readonly prevDifficulty: number | null;
      readonly prevState: string;
      readonly prevReps: number | null;
      readonly prevLapses: number | null;
    },
  ): boolean {
    return (
      (current.dueAt ?? null) === (markerRow.prevDueAt ?? null) &&
      current.stability === (markerRow.prevStability ?? current.stability) &&
      current.difficulty === (markerRow.prevDifficulty ?? current.difficulty) &&
      current.fsrsState === markerRow.prevState &&
      current.reps === (markerRow.prevReps ?? current.reps) &&
      current.lapses === (markerRow.prevLapses ?? current.lapses)
    );
  }

  /**
   * Set / clear a card's claim-lifetime fields (T090). Writes the six `cards` columns
   * (`fact_stability`/`valid_from`/`valid_until`/`jurisdiction`/`software_version`/
   * `review_by`), stamps `elements.updatedAt`, and logs `update_element` — all in ONE
   * transaction (NO new op type; "expired" is a DERIVED attribute, the card never
   * leaves `active`/`scheduled`). An OMITTED field is left unchanged; an explicit
   * `null` (or empty string for the text/date fields) CLEARS it. Dates are stored
   * as-entered (trimmed; empty → `null`); `factStability` is normalized to the core
   * tuple or cleared. Lineage, `review_states`, and `review_logs` are NEVER touched.
   */
  setLifetime(id: ElementId, patch: UpdateCardLifetimeInput): CardEditResult {
    const existing = this.requireCard(id);

    // Resolve the next value of each field: omitted → keep; provided → trim/normalize
    // (empty → null). `factStability` clears on any non-tuple value.
    const next = this.nextLifetime(existing.card, patch);

    return this.db.transaction((tx) => {
      tx.update(cards)
        .set({
          factStability: next.factStability,
          validFrom: next.validFrom,
          validUntil: next.validUntil,
          jurisdiction: next.jurisdiction,
          softwareVersion: next.softwareVersion,
          reviewBy: next.reviewBy,
        })
        .where(eq(cards.elementId, id))
        .run();

      // The lifetime fields live on the `card` element / its `cards` row, so the edit
      // is logged as `update_element` on the card element (no new op type). This also
      // stamps `elements.updatedAt` so the change is observable + ordered.
      const updatedAt = nowIso();
      tx.update(elements).set({ updatedAt }).where(eq(elements.id, id)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: id,
        payload: { id, lifetime: next },
      });

      const card = tx.select().from(cards).where(eq(cards.elementId, id)).get();
      const elementRow = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (!card || !elementRow) {
        throw new Error(`CardEditService.setLifetime: card ${id} missing after update`);
      }
      return { element: rowToElement(elementRow), card };
    });
  }

  /** Resolve the next lifetime fields: omitted → keep current; provided → normalize. */
  private nextLifetime(current: CardRow, patch: UpdateCardLifetimeInput): FactLifetime {
    const text = (provided: string | null | undefined, existing: string | null): string | null => {
      if (provided === undefined) return existing ?? null;
      const t = (provided ?? "").trim();
      return t === "" ? null : t;
    };
    const stability =
      patch.factStability === undefined
        ? isFactStability(current.factStability)
          ? current.factStability
          : null
        : isFactStability(patch.factStability)
          ? patch.factStability
          : null;
    return {
      factStability: stability,
      validFrom: text(patch.validFrom, current.validFrom),
      validUntil: text(patch.validUntil, current.validUntil),
      jurisdiction: text(patch.jurisdiction, current.jurisdiction),
      softwareVersion: text(patch.softwareVersion, current.softwareVersion),
      reviewBy: text(patch.reviewBy, current.reviewBy),
    };
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
