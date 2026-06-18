/**
 * ReviewRepository (T008) — cards + FSRS review state/logs.
 *
 * FSRS scheduling applies to CARDS ONLY (a load-bearing invariant: cards answer
 * "can the user recall this?"; sources/topics/extracts use the separate
 * attention scheduler). Creating a card is a multi-table mutation: an `elements`
 * row (type `card`), its `cards` side-table row (with the `sourceLocationId` that
 * keeps the `card → source location → source` lineage), and a fresh
 * `review_states` row — all in one transaction with a `create_card` op.
 *
 * Recording a review appends an immutable `review_logs` row AND updates the
 * card's `review_states` in the same transaction, logging `add_review_log`.
 * Review logs are append-only — corrections are new rows, never in-place edits —
 * so sessions are repairable and FSRS parameters can later be optimized.
 */

import type {
  CardKind,
  DistillationStage,
  Element,
  ElementId,
  FsrsState,
  IsoTimestamp,
  MediaRef,
  Priority,
  ReviewLog,
  ReviewRating,
  ReviewState,
  SourceLocationId,
} from "@interleave/core";
import {
  type CardRow,
  cards,
  elements,
  type InterleaveDatabase,
  reviewLogs,
  reviewStates,
} from "@interleave/db";
import { isLeech } from "@interleave/scheduler";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { newReviewLogId, nowIso } from "./ids";
import { rowToElement, rowToReviewLog, rowToReviewState } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import { SchedulerService } from "./scheduler-service";
import type { DbClient } from "./types";

/** Arguments to create a card (Q&A or cloze). */
export interface CreateCardInput {
  readonly kind: CardKind;
  readonly title: string;
  readonly priority: Priority;
  readonly stage?: DistillationStage;
  readonly prompt?: string | null;
  readonly answer?: string | null;
  readonly cloze?: string | null;
  /** Origin element (the extract this card was distilled from). */
  readonly parentId?: ElementId | null;
  /** Lineage root (owning source). */
  readonly sourceId?: ElementId | null;
  /** Anchor to the exact source position the card derives from. */
  readonly sourceLocationId?: SourceLocationId | null;
  /**
   * A round-trippable, human-readable source reference (T070) — written verbatim to
   * `cards.source_uri`. Carried OUT to Anki's `Source` field on export and read back
   * IN on Anki import (where there is no in-app `sourceLocationId`). `null`/omitted
   * for cards authored from an in-app extract (whose lineage lives in
   * `sourceLocationId`); the existing card-authoring callers leave it unset.
   */
  readonly sourceUri?: string | null;
  /**
   * Audio-card presentation carrier (T075) — when supplied, written verbatim (as JSON)
   * to `cards.media_ref` so the card LOOPS this clip of the original media on the
   * chosen face. `null`/omitted for every text/occlusion card. This is a presentation
   * modifier, not a new `kind` — no new op (`create_card` already covers the card row).
   */
  readonly mediaRef?: MediaRef | null;
  /**
   * An imported FSRS-state SEED (T070) — used by Anki import to PRESERVE review
   * history when available. When supplied, `createCardWithin` writes the
   * `review_states` row with THESE values (and the matching element `dueAt`) instead
   * of the bare `{ fsrsState: "new", dueAt: firstScheduledAt }` default. When
   * omitted, the existing default behaviour is unchanged (every authored-card caller
   * keeps working untouched). `firstScheduledAt` and `reviewSeed` are mutually
   * exclusive — a seed carries its OWN `dueAt`; if both are supplied the seed wins
   * (its `dueAt` is authoritative). This is an HONEST approximation of Anki's SM-2
   * scheduling into our FSRS state, NOT a faithful FSRS history: `reps`/`lapses`/
   * `dueAt` are carried as-is; `stability`/`difficulty` are seeded plausibly and
   * re-converge over the next few real reviews. No historical `review_logs` are
   * fabricated.
   */
  readonly reviewSeed?: ReviewStateSeed | null;
  /**
   * First FSRS schedule (T036). When supplied, the fresh `review_states` row is
   * created DUE at this time (`dueAt = firstScheduledAt`, still `fsrsState: "new"`)
   * so an authored card immediately enters the due deck (`QueueRepository.dueCards`)
   * and can be surfaced in `/review` for its first grade — which then runs the real
   * FSRS `next()` math. When omitted the row is left UN-DUE (`dueAt = null`), the M6
   * "authored but not yet scheduled" shape. Setting `dueAt = now` for a brand-new
   * card is NOT FSRS math (a new card is due now by definition, Anki/SM style); the
   * first GRADE is where `CardSchedulerService.gradeCard` computes the interval.
   */
  readonly firstScheduledAt?: IsoTimestamp | null;
}

/**
 * An imported FSRS-state seed (T070) — the subset of `review_states` columns the
 * Anki importer maps from Anki's SM-2 scheduling. `stability`/`difficulty` are an
 * approximation (see {@link CreateCardInput.reviewSeed}); `reps`/`lapses`/`dueAt`
 * are carried directly. Omitted numeric fields default to FSRS-neutral values.
 */
export interface ReviewStateSeed {
  readonly reps: number;
  readonly lapses: number;
  readonly stability: number;
  readonly difficulty: number;
  readonly elapsedDays?: number;
  readonly scheduledDays?: number;
  /** The FSRS phase the seeded card lands in (default `review` for a scheduled card). */
  readonly fsrsState?: FsrsState;
  /** The preserved next-due time (the most user-visible continuity); `null` ⇒ due now. */
  readonly dueAt: IsoTimestamp | null;
  /** When the card was last reviewed in Anki, if known. */
  readonly lastReviewedAt?: IsoTimestamp | null;
}

/** A card element + its `cards` side-table row. */
export interface CardWithElement {
  readonly element: Element;
  readonly card: CardRow;
}

/**
 * The comparable answer body of one sibling card (T086) — only the fields the pure
 * `detectInterference` similar-answer heuristic compares. No FSRS state, no lineage.
 */
export interface SiblingCardBody {
  readonly id: ElementId;
  readonly answer: string | null;
  readonly cloze: string | null;
}

/** The full FSRS state assigned by a review (computed by the scheduler upstream). */
export interface ReviewOutcome {
  readonly rating: ReviewRating;
  readonly reviewedAt: IsoTimestamp;
  readonly responseMs: number;
  readonly prevState: FsrsState;
  /**
   * Optional scheduler preimage. Live scheduler outcomes supply these so the
   * repository can reject a stale transition even when the FSRS phase is unchanged.
   * Older hand-built test fixtures may omit them and fall back to the phase check.
   */
  readonly prevDueAt?: IsoTimestamp | null;
  readonly prevStability?: number;
  readonly prevDifficulty?: number;
  readonly prevElapsedDays?: number;
  readonly prevScheduledDays?: number;
  readonly prevReps?: number;
  readonly prevLapses?: number;
  readonly prevLearningSteps?: number;
  readonly prevLastReviewedAt?: IsoTimestamp | null;
  readonly nextState: FsrsState;
  readonly nextStability: number;
  readonly nextDifficulty: number;
  readonly nextDueAt: IsoTimestamp;
  /** Updated cumulative counters from the scheduler. */
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  readonly reps: number;
  readonly lapses: number;
  /**
   * The FSRS short-term (re)learning-step cursor AFTER this review — persisted on
   * `review_states` so it round-trips losslessly into the next grade (without it a
   * card never graduates out of the learning phase).
   */
  readonly nextLearningSteps: number;
}

export class ReviewRepository {
  private readonly elementsRepo: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elementsRepo = new ElementRepository(db);
  }

  /**
   * Create a card element + its `cards` row + a fresh `review_states` row,
   * atomically, logging `create_card`. The card starts in FSRS state `new`.
   */
  createCard(input: CreateCardInput): CardWithElement {
    return this.db.transaction((tx) => this.createCardWithin(tx, input));
  }

  /**
   * Create a card using an EXISTING transaction — the tx-composable seam
   * {@link CardService} (T032) uses to author a card from an extract in ONE outer
   * `db.transaction` (card creation + sibling grouping + tag inheritance all
   * commit together). Mirrors {@link ElementRepository.createWithin} /
   * {@link SourceRepository.createExtractWithin}: it inserts the `elements` row
   * (via `createWithin`, logging `create_element`), the `cards` side-table row,
   * and a FRESH `review_states` row, then logs `create_card` on the SAME `tx`, so
   * a throw anywhere downstream rolls the whole card back (no orphan
   * element/card/review-state row).
   *
   * **Two-scheduler split (load-bearing):** the `review_states` row is created
   * with `fsrsState: "new"`. By default it is left UN-DUE (`dueAt = null`) — M6's
   * "authored but not yet scheduled" shape. When `input.firstScheduledAt` is
   * supplied (the M7/T036 first-schedule), the row is created DUE at that time so
   * the card enters the due deck immediately; the element is also activated
   * (`card_draft → active_card`, `pending → active`) and the activation is logged
   * `update_element` on the SAME `tx`. The first GRADE is where the real FSRS
   * `next()` math runs — setting `dueAt = now` for a brand-new card is not FSRS math.
   */
  createCardWithin(tx: DbClient, input: CreateCardInput): CardWithElement {
    // A `reviewSeed` (T070, Anki import) is mutually exclusive with `firstScheduledAt`
    // and authoritative when present — it carries its OWN due time + FSRS counters.
    const seed = input.reviewSeed ?? null;
    const firstScheduledAt = seed ? null : (input.firstScheduledAt ?? null);
    // A first-scheduled card is authored straight into active rotation; an un-due
    // card stays at its requested stage (default card_draft) until it is graded. A
    // SEEDED card (imported with history) is ALWAYS authored active — it already has a
    // schedule + counters, so it belongs in the deck, not parked as a draft, regardless
    // of the requested stage (the Anki importer passes stage:"active_card" explicitly).
    const requestedStage = input.stage ?? "card_draft";
    const activate = seed != null || (firstScheduledAt != null && requestedStage === "card_draft");
    const element = this.elementsRepo.createWithin(tx, {
      type: "card",
      status: activate ? "active" : "pending",
      stage: activate ? "active_card" : requestedStage,
      priority: input.priority,
      title: input.title,
      parentId: input.parentId ?? null,
      sourceId: input.sourceId ?? null,
    });
    tx.insert(cards)
      .values({
        elementId: element.id,
        kind: input.kind,
        prompt: input.prompt ?? null,
        answer: input.answer ?? null,
        cloze: input.cloze ?? null,
        sourceLocationId: input.sourceLocationId ?? null,
        sourceUri: input.sourceUri ?? null,
        // Audio-card carrier (T075): the clip-to-loop reference, JSON-encoded. `null`
        // for every text/occlusion card. Self-contained — the window is copied from
        // the originating clip fragment so the card needn't re-resolve it.
        mediaRef: input.mediaRef ? JSON.stringify(input.mediaRef) : null,
      })
      .run();
    // The review_states row. WITHOUT a seed it carries fsrsState "new"; its dueAt is
    // the first schedule (so the card is reviewable now) or null (still authored-only).
    // WITH a seed (Anki import) it carries the mapped counters + the preserved due
    // date so scheduling continuity holds. The element's dueAt mirrors review_states
    // so any element-level read agrees with the deck.
    if (seed) {
      tx.insert(reviewStates)
        .values({
          elementId: element.id,
          dueAt: seed.dueAt,
          stability: seed.stability,
          difficulty: seed.difficulty,
          elapsedDays: seed.elapsedDays ?? 0,
          scheduledDays: seed.scheduledDays ?? 0,
          reps: seed.reps,
          lapses: seed.lapses,
          fsrsState: seed.fsrsState ?? "review",
          lastReviewedAt: seed.lastReviewedAt ?? null,
        })
        .run();
      tx.update(elements).set({ dueAt: seed.dueAt }).where(eq(elements.id, element.id)).run();
    } else {
      tx.insert(reviewStates)
        .values({ elementId: element.id, fsrsState: "new", dueAt: firstScheduledAt })
        .run();
      if (firstScheduledAt != null) {
        tx.update(elements)
          .set({ dueAt: firstScheduledAt })
          .where(eq(elements.id, element.id))
          .run();
      }
    }

    new OperationLogRepository(tx).append(tx, {
      opType: "create_card",
      elementId: element.id,
      payload: {
        cardId: element.id,
        kind: input.kind,
        sourceLocationId: input.sourceLocationId ?? null,
        firstScheduledAt,
        // T070: record that this card was imported with a scheduling seed (the
        // counters/due come from Anki, not a fresh first-schedule) for audit/sync.
        ...(seed ? { imported: true, reviewSeed: { reps: seed.reps, lapses: seed.lapses } } : {}),
        ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      },
    });

    // The card_draft → active_card transition (T036) — logged as update_element (no
    // new op type), inside this same creation transaction so authoring + first
    // schedule + activation are atomic (no durable state where a card is due but
    // still a draft).
    if (activate) {
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: element.id,
        payload: {
          id: element.id,
          patch: { stage: "active_card", status: "active" },
          // The pre-activation shape: a draft card was at card_draft/pending; a seeded
          // import that requested active_card only transitions status (stage was already
          // active_card), so the logged prev reflects the actual requested stage.
          prev: { stage: requestedStage, status: "pending" },
          firstScheduledAt,
        },
      });
    }

    const card = tx.select().from(cards).where(eq(cards.elementId, element.id)).get();
    if (!card) throw new Error("ReviewRepository.createCard: card row missing after insert");
    return { element, card };
  }

  /**
   * Link a card's `cards.source_location_id` to an existing `source_locations` row,
   * within an existing transaction (T093 — the AI approve seam). Used when a draft
   * card's grounding anchor is created AFTER the card row (the card id is needed for
   * the location's `element_id`), so the card→location link is patched in the same
   * transaction. No `operation_log` op — the lineage anchor is recorded by the
   * location's own creation; this only wires the back-reference. Pure column update.
   */
  setCardSourceLocationWithin(
    tx: DbClient,
    cardElementId: ElementId,
    sourceLocationId: SourceLocationId,
  ): void {
    tx.update(cards).set({ sourceLocationId }).where(eq(cards.elementId, cardElementId)).run();
  }

  /** Read a card (element + card row) by element id, or `null`. */
  findCardById(elementId: ElementId): CardWithElement | null {
    const elementRow = this.db.select().from(elements).where(eq(elements.id, elementId)).get();
    const card = this.db.select().from(cards).where(eq(cards.elementId, elementId)).get();
    if (!elementRow || !card) return null;
    return { element: rowToElement(elementRow), card };
  }

  /**
   * Batch-read the `cards.source_location_id` for many card element ids. Returns a
   * `Map<ElementId, SourceLocationId | null>` — entries are present for every id that
   * has a `cards` row; ids with no card row are absent. Empty `ids` → empty map.
   *
   * Used by {@link resolveSourceRefMany} to resolve card fallback location anchors in
   * one query instead of a per-card `findCardById` call.
   */
  findCardSourceLocationIds(ids: readonly ElementId[]): Map<ElementId, SourceLocationId | null> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .select({ elementId: cards.elementId, sourceLocationId: cards.sourceLocationId })
      .from(cards)
      .where(inArray(cards.elementId, ids as ElementId[]))
      .all();
    return new Map(
      rows.map((r) => [
        r.elementId as ElementId,
        (r.sourceLocationId as SourceLocationId | null) ?? null,
      ]),
    );
  }

  /**
   * The answer bodies of the live `card` children of an extract (T086) — the read-only
   * candidate set the card builder feeds to the pure `detectInterference` similar-answer
   * heuristic. Joins the `card`-typed live (not soft-deleted) child elements to their
   * `cards` rows and returns ONLY the comparable fields (`answer`/`cloze`); no FSRS state,
   * no lineage resolution. Pure read — no mutation, no `operation_log`.
   */
  listSiblingCardBodies(extractId: ElementId): SiblingCardBody[] {
    return this.db
      .select({ id: cards.elementId, answer: cards.answer, cloze: cards.cloze })
      .from(cards)
      .innerJoin(elements, eq(elements.id, cards.elementId))
      .where(
        and(
          eq(elements.parentId, extractId),
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
        ),
      )
      .all()
      .map((row) => ({
        id: row.id as ElementId,
        answer: row.answer ?? null,
        cloze: row.cloze ?? null,
      }));
  }

  /** Read the FSRS state for a card, or `null`. */
  findReviewState(elementId: ElementId): ReviewState | null {
    const row = this.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, elementId))
      .get();
    return row ? rowToReviewState(row) : null;
  }

  /**
   * Batched twin of {@link findReviewState}: one `inArray(review_states.element_id, ids)`
   * read returning `Map<ElementId, ReviewState>` for the cards that have a row. A card id
   * with no `review_states` row is absent from the map (mirrors `findReviewState` → null).
   * Empty `ids` → empty map.
   *
   * Required by {@link QueueQuery.summaryForMany} (U1): the batched due join
   * (`dueCardsWithState`) is due-filtered, so it cannot serve an ARBITRARY id set (the
   * library/concept inventory passes non-due, retired, parked, and fallow elements).
   * This is the only way to resolve FSRS state for every requested id in one read.
   */
  findReviewStatesForMany(ids: readonly ElementId[]): Map<ElementId, ReviewState> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .select()
      .from(reviewStates)
      .where(inArray(reviewStates.elementId, ids as ElementId[]))
      .all();
    return new Map(rows.map((row) => [row.elementId as ElementId, rowToReviewState(row)]));
  }

  /**
   * Batched twin of {@link findCardById}'s card-row read: one
   * `inArray(cards.element_id, ids)` read returning `Map<ElementId, CardRow>` for the ids
   * that have a `cards` row. A non-card / unknown id is absent. Empty `ids` → empty map.
   *
   * Used by {@link QueueQuery.summaryForMany} (U1) to resolve the per-card RETIRED flag
   * (`card.isRetired` — drives `queueEligibilityFor`) and the card KIND (`card.kind` →
   * `cardType`) in one read instead of a per-row `findCardById`.
   */
  findCardsForMany(ids: readonly ElementId[]): Map<ElementId, CardRow> {
    if (ids.length === 0) return new Map();
    const rows = this.db
      .select()
      .from(cards)
      .where(inArray(cards.elementId, ids as ElementId[]))
      .all();
    return new Map(rows.map((row) => [row.elementId as ElementId, row]));
  }

  /** All review logs for a card, newest first. */
  listReviewLogs(elementId: ElementId): ReviewLog[] {
    return this.db
      .select()
      .from(reviewLogs)
      .where(eq(reviewLogs.elementId, elementId))
      .orderBy(desc(reviewLogs.reviewedAt))
      .all()
      .map(rowToReviewLog);
  }

  /**
   * Record one review: append an immutable `review_logs` row AND update the
   * card's `review_states`, atomically, logging `add_review_log`. The element's
   * `dueAt` is also advanced to the next due time so the queue picks it up.
   *
   * **Leech detection (T040):** after advancing the FSRS state, the new cumulative
   * `lapses` is consulted via the single leech rule (`@interleave/scheduler`'s
   * {@link isLeech} — "warn at 4 lapses"). The flag is set ONLY on a grade that
   * ACTUALLY added a lapse (the running lapse count increased this review) and the
   * card is at/over the threshold and is not already flagged — set in the SAME
   * transaction, logged as `update_element` (no new op type — the closed 15-op set
   * is unchanged). Gating on "added a lapse" (rather than "lapses >= 4 on any
   * review") is load-bearing: a card manually UN-leeched after remediation
   * ({@link setCardLeech}) keeps a high cumulative `lapses` (lapses never decrease),
   * so re-flagging on every subsequent review — even a passing `good` — would
   * silently defeat the un-leech. A remediated card only re-leeches if it fails
   * AGAIN. Leech is flag + warn only — it never suspends or reschedules here (the
   * two-scheduler split: FSRS owns the schedule, the leech flag is a quality
   * attribute).
   *
   * **First-review activation (T036):** when `options.promoteFromDraft` is set and
   * the card is still at stage `card_draft`, the `card_draft → active_card`
   * (`status` → `active`) transition is applied in this SAME transaction (logged
   * `update_element`), so the first review and the activation are atomic — there is
   * no durable state where a review log exists but the card is still a draft.
   */
  recordReview(
    cardElementId: ElementId,
    outcome: ReviewOutcome,
    options?: { readonly promoteFromDraft?: boolean; readonly promptMs?: number },
  ): ReviewLog {
    return this.db.transaction((tx) => {
      const id = newReviewLogId();
      // The lapse count BEFORE this review — so we can tell whether THIS grade added
      // a lapse (vs. a passing grade on an already-high-lapse, possibly-un-leeched card).
      const before = tx
        .select()
        .from(reviewStates)
        .where(eq(reviewStates.elementId, cardElementId))
        .get();
      if (!before) {
        throw new Error(
          `ReviewRepository.recordReview: review state for card ${cardElementId} missing`,
        );
      }
      const hasPreimage =
        outcome.prevDueAt !== undefined ||
        outcome.prevStability !== undefined ||
        outcome.prevDifficulty !== undefined ||
        outcome.prevElapsedDays !== undefined ||
        outcome.prevScheduledDays !== undefined ||
        outcome.prevReps !== undefined ||
        outcome.prevLapses !== undefined ||
        outcome.prevLearningSteps !== undefined ||
        outcome.prevLastReviewedAt !== undefined;
      const stalePreimage =
        hasPreimage &&
        (outcome.prevDueAt !== before.dueAt ||
          outcome.prevStability !== before.stability ||
          outcome.prevDifficulty !== before.difficulty ||
          outcome.prevElapsedDays !== before.elapsedDays ||
          outcome.prevScheduledDays !== before.scheduledDays ||
          outcome.prevReps !== before.reps ||
          outcome.prevLapses !== before.lapses ||
          outcome.prevLearningSteps !== before.learningSteps ||
          outcome.prevLastReviewedAt !== before.lastReviewedAt);
      if (outcome.prevState !== before.fsrsState || stalePreimage) {
        throw new Error(
          `ReviewRepository.recordReview: stale review outcome for card ${cardElementId}`,
        );
      }
      tx.insert(reviewLogs)
        .values({
          id,
          elementId: cardElementId,
          rating: outcome.rating,
          reviewedAt: outcome.reviewedAt,
          responseMs: outcome.responseMs,
          promptMs: options?.promptMs ?? null,
          prevState: before.fsrsState,
          prevDueAt: before.dueAt,
          prevStability: before.stability,
          prevDifficulty: before.difficulty,
          prevElapsedDays: before.elapsedDays,
          prevScheduledDays: before.scheduledDays,
          prevReps: before.reps,
          prevLapses: before.lapses,
          prevLearningSteps: before.learningSteps,
          prevLastReviewedAt: before.lastReviewedAt,
          nextState: outcome.nextState,
          nextStability: outcome.nextStability,
          nextDifficulty: outcome.nextDifficulty,
          nextDueAt: outcome.nextDueAt,
          nextElapsedDays: outcome.elapsedDays,
          nextScheduledDays: outcome.scheduledDays,
          nextReps: outcome.reps,
          nextLapses: outcome.lapses,
          nextLearningSteps: outcome.nextLearningSteps,
        })
        .run();

      tx.update(reviewStates)
        .set({
          dueAt: outcome.nextDueAt,
          stability: outcome.nextStability,
          difficulty: outcome.nextDifficulty,
          elapsedDays: outcome.elapsedDays,
          scheduledDays: outcome.scheduledDays,
          reps: outcome.reps,
          lapses: outcome.lapses,
          fsrsState: outcome.nextState,
          learningSteps: outcome.nextLearningSteps,
          lastReviewedAt: outcome.reviewedAt,
        })
        .where(eq(reviewStates.elementId, cardElementId))
        .run();

      tx.update(elements)
        .set({ dueAt: outcome.nextDueAt, updatedAt: outcome.reviewedAt })
        .where(eq(elements.id, cardElementId))
        .run();

      new OperationLogRepository(tx).append(tx, {
        opType: "add_review_log",
        elementId: cardElementId,
        payload: { reviewLogId: id, rating: outcome.rating, nextDueAt: outcome.nextDueAt },
      });

      // First-review activation (T036): promote a still-draft card to active rotation
      // in this same transaction (idempotent — only when actually a card_draft).
      if (options?.promoteFromDraft) {
        const el = tx
          .select({ stage: elements.stage, status: elements.status })
          .from(elements)
          .where(eq(elements.id, cardElementId))
          .get();
        if (el && el.stage === "card_draft") {
          tx.update(elements)
            .set({ stage: "active_card", status: "active" })
            .where(eq(elements.id, cardElementId))
            .run();
          new OperationLogRepository(tx).append(tx, {
            opType: "update_element",
            elementId: cardElementId,
            payload: {
              id: cardElementId,
              patch: { stage: "active_card", status: "active" },
              prev: { stage: el.stage, status: el.status },
              // This promote rides WITH the review (it fires on the first grade of a
              // still-draft card). The `prev` is kept for audit/sync, but the global
              // ⌘Z undo must treat the promote as part of the non-undoable review: a
              // grade's `add_review_log` is not invertible, so demoting the card back
              // to `card_draft` while the durable review_log row + the advanced FSRS
              // due date persist would be an incoherent PARTIAL undo. `reviewPromote`
              // marks this op so UndoService skips it (see UndoService.isInvertible).
              reviewPromote: true,
            },
          });
        }
      }

      // Leech detection (T040): only when THIS grade added a lapse (the running
      // count increased) AND the card is at/over the threshold AND it is not already
      // flagged — set the durable leech flag + log `update_element`, inside this same
      // review transaction. Gating on "added a lapse" respects a manual un-leech: a
      // remediated card with a high cumulative lapse count is NOT re-flagged on a
      // passing grade, only if it fails again.
      const addedLapse = outcome.lapses > before.lapses;
      if (addedLapse) {
        const cardElement = tx
          .select({ sourceId: elements.sourceId })
          .from(elements)
          .where(eq(elements.id, cardElementId))
          .get();
        if (cardElement?.sourceId) {
          new SchedulerService(this.db).rescheduleSourceForDescendantHealthWithin(
            tx,
            cardElement.sourceId as ElementId,
            outcome.reviewedAt,
          );
        }
      }

      if (addedLapse && isLeech({ lapses: outcome.lapses })) {
        const cardRow = tx
          .select({ isLeech: cards.isLeech })
          .from(cards)
          .where(eq(cards.elementId, cardElementId))
          .get();
        if (cardRow && !cardRow.isLeech) {
          tx.update(cards).set({ isLeech: true }).where(eq(cards.elementId, cardElementId)).run();
          new OperationLogRepository(tx).append(tx, {
            opType: "update_element",
            elementId: cardElementId,
            payload: { id: cardElementId, isLeech: true, lapses: outcome.lapses },
          });
        }
      }

      const log = tx.select().from(reviewLogs).where(eq(reviewLogs.id, id)).get();
      if (!log) throw new Error("ReviewRepository.recordReview: log row missing after insert");
      return rowToReviewLog(log);
    });
  }

  /**
   * Whether a card is currently flagged a leech (T040) — reads the durable
   * `cards.is_leech` flag. Read-only; the cleanup view + the review face use it.
   */
  isCardLeech(cardElementId: ElementId): boolean {
    const row = this.db
      .select({ isLeech: cards.isLeech })
      .from(cards)
      .where(eq(cards.elementId, cardElementId))
      .get();
    return row?.isLeech ?? false;
  }

  /**
   * Count of LIVE retired cards (T082) — the analytics/maintenance inventory badge.
   * Joins `cards` (`is_retired = 1`) to live (non-deleted) `card` elements. Read-only.
   */
  countRetiredCards(): number {
    return this.db
      .select({ id: cards.elementId })
      .from(cards)
      .innerJoin(elements, eq(elements.id, cards.elementId))
      .where(and(eq(cards.isRetired, true), isNull(elements.deletedAt)))
      .all().length;
  }

  /**
   * Whether a card is currently RETIRED (T082) — reads the durable `cards.is_retired`
   * flag. Read-only; the inspector's retire/un-retire row uses it.
   */
  isCardRetired(cardElementId: ElementId): boolean {
    const row = this.db
      .select({ isRetired: cards.isRetired })
      .from(cards)
      .where(eq(cards.elementId, cardElementId))
      .get();
    return row?.isRetired ?? false;
  }

  /**
   * All live leech cards (T040) — the cleanup view's read. Joins `cards`
   * (`is_leech = 1`) to live (non-deleted) `card` elements + their `review_states`
   * lapse count, most-lapsed first. Suspended cards are INCLUDED (the cleanup view
   * is where a user un-suspends/rewrites them); soft-deleted cards are excluded.
   * Read-only — no mutation, no `operation_log`.
   */
  listLeechCards(): LeechCard[] {
    const rows = this.db
      .select({
        element: elements,
        card: cards,
        lapses: reviewStates.lapses,
        reps: reviewStates.reps,
        lastReviewedAt: reviewStates.lastReviewedAt,
      })
      .from(cards)
      .innerJoin(elements, eq(elements.id, cards.elementId))
      .leftJoin(reviewStates, eq(reviewStates.elementId, cards.elementId))
      .where(eq(cards.isLeech, true))
      .all()
      .filter((r) => r.element.deletedAt == null)
      .map((r) => ({
        element: rowToElement(r.element),
        card: r.card,
        lapses: r.lapses ?? 0,
        reps: r.reps ?? 0,
        lastReviewedAt: r.lastReviewedAt ?? null,
      }));
    // Most-lapsed first (then most-recently reviewed) so the worst offenders lead.
    rows.sort((a, b) => b.lapses - a.lapses);
    return rows;
  }

  /**
   * Set / clear a card's durable leech flag (T040) in ONE transaction, logging
   * `update_element` (no new op type). Used by the manual "Mark leech" button and
   * to UN-leech a remediated card. Idempotent: setting the flag to its current
   * value is still logged (the op-log records the user's intent). Returns the card
   * element + its `cards` row after the change.
   */
  setCardLeech(cardElementId: ElementId, leech: boolean): CardWithElement {
    // Guard card-ness up front (like CardEditService.requireCard) so a non-card /
    // unknown id is rejected with a clear error BEFORE any mutation or op-log entry
    // is issued — rather than relying on a blind UPDATE matching zero rows and a
    // post-hoc "missing after update" throw to roll the transaction back.
    const existing = this.findCardById(cardElementId);
    if (existing?.element.type !== "card" || existing.element.deletedAt) {
      throw new Error(`ReviewRepository.setCardLeech: card ${cardElementId} not found`);
    }
    return this.db.transaction((tx) => {
      tx.update(cards).set({ isLeech: leech }).where(eq(cards.elementId, cardElementId)).run();
      const updatedAt = nowIso();
      tx.update(elements).set({ updatedAt }).where(eq(elements.id, cardElementId)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: cardElementId,
        payload: { id: cardElementId, isLeech: leech },
      });
      const card = tx.select().from(cards).where(eq(cards.elementId, cardElementId)).get();
      const elementRow = tx.select().from(elements).where(eq(elements.id, cardElementId)).get();
      if (!card || !elementRow) {
        throw new Error(
          `ReviewRepository.setCardLeech: card ${cardElementId} missing after update`,
        );
      }
      return { element: rowToElement(elementRow), card };
    });
  }
}

/** A leech card row for the cleanup view: the element, its body, + lapse signals. */
export interface LeechCard {
  readonly element: Element;
  readonly card: CardRow;
  /** Cumulative FSRS lapses (failed reviews) — the leech's severity. */
  readonly lapses: number;
  readonly reps: number;
  readonly lastReviewedAt: IsoTimestamp | null;
}
