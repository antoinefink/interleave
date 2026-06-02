/**
 * CardRetirementService (T082) — graceful mature-card retirement.
 *
 * A low-value MATURE card (high stability, low priority, well-learned) can be
 * RETIRED so it leaves active review gracefully — WITHOUT being deleted or losing
 * its lineage/history. Retirement is REVERSIBLE: un-retire restores the card to
 * normal scheduling at its existing `review_states.due_at`.
 *
 * **The mechanism (decided, documented):** a durable `cards.is_retired` BOOLEAN
 * FLAG (mirroring T040's `is_leech`), the SINGLE SOURCE OF TRUTH for "leave active
 * review". The considered alternative — adding a new `retired` value to
 * `ELEMENT_STATUSES` — was rejected: an element status has a far wider blast radius
 * (every status switch, the inspector, the queue filters, the design `Status` badge
 * set, a status migration), and "retired" is a CARD-QUALITY attribute like leech,
 * NOT a lifecycle stage. The card stays `active`/`scheduled` underneath, so
 * un-retire is a pure flag flip. (See the spec's "Flag vs status" note.)
 *
 * The flag removes a card from the due read via `QueueRepository.dueCards`'s
 * `cards`-join + `is_retired = 0` predicate — a DIFFERENT mechanism from the
 * `suspended` status exclusion (which filters `elements.status`). The review deck
 * (`ReviewSessionService`) and the queue/analytics due counts then drop retired
 * cards automatically (they all read through `dueCards`). The attention reads are
 * UNTOUCHED — no card-retirement logic leaks to sources/extracts.
 *
 * **Retire ≠ suspend ≠ delete (kept independent):** suspend is "temporarily out,
 * will return"; delete is a soft delete to trash; RETIRE is "done with, kept for
 * reference, low-value" — a distinct, reversible exit. A card can be un-retired
 * without un-deleting, etc.
 *
 * **Optional low-retention lever (NOT the retirement mechanism):** `retire` may
 * ALSO set the card's `cards.desired_retention` to the FLOOR (`DESIRED_RETENTION_MIN`
 * = 0.8 — the lowest the T079 resolver honors; a lower value is clamped UP to it),
 * which lengthens the card's intervals somewhat IF it is ever un-retired without
 * clearing the override. This is a CONVENIENCE only — the `is_retired` flag is the
 * sole source of truth for "skip in review", and the resolver clamp means the
 * override can NEVER on its own remove a card from rotation. The two are kept
 * INDEPENDENT: un-retire clears the flag (and the card returns to its existing
 * `review_states.due_at`); clearing the low-retention override is a separate
 * `retention.setCard(cardId, null)` call.
 *
 * **Two-scheduler split (load-bearing):** a card is the only FSRS-scheduled
 * element. Retiring touches the `cards` row (a flag) + optionally the per-card
 * retention override — it NEVER writes `review_states` (the FSRS memory state) or
 * the append-only `review_logs`, and NEVER touches a non-card's `due_at`. Each
 * mutation runs in ONE transaction with the correct EXISTING `operation_log` op
 * (`update_element` — the closed 15-op set is unchanged, NO new op types).
 *
 * The renderer never runs any of this; it reaches the service only through the
 * validated `cards.retire` / `cards.unretire` / `cards.retired` IPC commands.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import { DESIRED_RETENTION_MIN } from "@interleave/core";
import { cards, elements, type InterleaveDatabase, reviewStates } from "@interleave/db";
import { and, eq, isNull } from "drizzle-orm";
import { nowIso } from "./ids";
import { rowToElement } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import { RetentionService } from "./retention-service";
import { type CardWithElement, ReviewRepository } from "./review-repository";
import type { DbClient } from "./types";

/** A retire/un-retire result: the card element + its `cards` side-table row. */
export type CardRetirementResult = CardWithElement;

/** Options for {@link CardRetirementService.retire}. */
export interface RetireCardInput {
  /** Optional human reason, stored in the `update_element` op payload (audit). */
  readonly reason?: string | null;
  /**
   * When `true`, ALSO floor-clamp the card's per-card desired-retention override to
   * `DESIRED_RETENTION_MIN` (a convenience interval-lengthener for an eventual
   * un-retire). NOT the retirement mechanism — the `is_retired` flag is. Default
   * `false` (retire is a pure flag flip; the override is untouched).
   */
  readonly lowRetention?: boolean;
}

/**
 * A live retired card for the inventory/cleanup view: the element + its body +
 * the memory signals that make it readable as "low-value, well-learned, kept".
 */
export interface RetiredCard {
  readonly element: import("@interleave/core").Element;
  readonly card: import("@interleave/db").CardRow;
  /** FSRS stability (days) — high for a mature, well-learned card. */
  readonly stability: number;
  readonly reps: number;
  readonly lapses: number;
  readonly lastReviewedAt: IsoTimestamp | null;
}

export class CardRetirementService {
  private readonly review: ReviewRepository;
  private readonly retention: RetentionService;

  constructor(private readonly db: InterleaveDatabase) {
    this.review = new ReviewRepository(db);
    this.retention = new RetentionService(db);
  }

  /** Load a live (non-deleted) card, throwing when the id is not a live card. */
  private requireCard(id: ElementId): CardWithElement {
    const card = this.review.findCardById(id);
    if (card?.element.type !== "card" || card.element.deletedAt) {
      throw new Error(`CardRetirementService: card ${id} not found`);
    }
    return card;
  }

  /**
   * Retire a card (T082): set `cards.is_retired = true` in ONE transaction and log
   * `update_element` (payload `{ id, retired: true, reason?, retiredAt }`). The card
   * drops out of the due/review reads by the FLAG (`QueueRepository.dueCards` joins
   * `cards` and filters `is_retired = 0`) while keeping its `review_states`,
   * `review_logs`, and lineage. Reversible; NEVER a soft delete.
   *
   * When `input.lowRetention` is `true`, ALSO floor-clamps the card's
   * `cards.desired_retention` to `DESIRED_RETENTION_MIN` (a separate
   * `RetentionService.setCardRetention` write in the SAME transaction — a
   * convenience interval-lengthener, NOT the retirement mechanism).
   */
  retire(id: ElementId, input: RetireCardInput = {}): CardRetirementResult {
    this.requireCard(id);
    const reason = input.reason ?? null;
    return this.db.transaction((tx) => {
      const retiredAt = nowIso();
      tx.update(cards).set({ isRetired: true }).where(eq(cards.elementId, id)).run();
      tx.update(elements).set({ updatedAt: retiredAt }).where(eq(elements.id, id)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: id,
        payload: { id, retired: true, retiredAt, ...(reason != null ? { reason } : {}) },
      });

      // Optional, INDEPENDENT low-retention lever (floor-clamped; NOT retirement).
      // The RetentionService write clamps the value UP to DESIRED_RETENTION_MIN, so
      // it can never reach a self-retiring near-zero target. Runs inside this same
      // transaction so the whole retire is atomic.
      if (input.lowRetention) {
        this.retention.setCardRetention(id, DESIRED_RETENTION_MIN, tx);
      }

      return this.readCard(tx, id, "retire");
    });
  }

  /**
   * Un-retire a card (T082): clear `cards.is_retired` (`update_element`), restoring
   * the card to the normal due read at its EXISTING `review_states.due_at`. Does NOT
   * clear any low-retention override the user set (that is a separate
   * `retention.setCard(id, null)` — the flag and the override are independent).
   */
  unretire(id: ElementId): CardRetirementResult {
    this.requireCard(id);
    return this.db.transaction((tx) => {
      const updatedAt = nowIso();
      tx.update(cards).set({ isRetired: false }).where(eq(cards.elementId, id)).run();
      tx.update(elements).set({ updatedAt }).where(eq(elements.id, id)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: id,
        payload: { id, retired: false, unretiredAt: updatedAt },
      });
      return this.readCard(tx, id, "unretire");
    });
  }

  /** Whether a card is currently retired — reads the durable `cards.is_retired` flag. */
  isRetired(id: ElementId): boolean {
    const row = this.db
      .select({ isRetired: cards.isRetired })
      .from(cards)
      .where(eq(cards.elementId, id))
      .get();
    return row?.isRetired ?? false;
  }

  /**
   * All LIVE retired cards (T082) — the inventory/cleanup view's read. Joins `cards`
   * (`is_retired = 1`) to live (non-deleted) `card` elements + their `review_states`
   * memory signals, most-stable first (the most mature lead). Read-only — no
   * mutation, no `operation_log`. Soft-deleted cards are excluded; suspended retired
   * cards are kept (a card can be both, and the inventory is where they are reviewed).
   */
  listRetired(): RetiredCard[] {
    const rows = this.db
      .select({
        element: elements,
        card: cards,
        stability: reviewStates.stability,
        reps: reviewStates.reps,
        lapses: reviewStates.lapses,
        lastReviewedAt: reviewStates.lastReviewedAt,
      })
      .from(cards)
      .innerJoin(elements, eq(elements.id, cards.elementId))
      .leftJoin(reviewStates, eq(reviewStates.elementId, cards.elementId))
      .where(and(eq(cards.isRetired, true), isNull(elements.deletedAt)))
      .all()
      .map((r) => ({
        element: rowToElement(r.element),
        card: r.card,
        stability: r.stability ?? 0,
        reps: r.reps ?? 0,
        lapses: r.lapses ?? 0,
        lastReviewedAt: r.lastReviewedAt ?? null,
      }));
    // Most-stable (most mature) first; ties break on most-recently reviewed.
    rows.sort((a, b) => b.stability - a.stability);
    return rows;
  }

  /** Read back the card element + `cards` row after a write, throwing if missing. */
  private readCard(tx: DbClient, id: ElementId, op: string): CardRetirementResult {
    const card = tx.select().from(cards).where(eq(cards.elementId, id)).get();
    const elementRow = tx.select().from(elements).where(eq(elements.id, id)).get();
    if (!card || !elementRow) {
      throw new Error(`CardRetirementService.${op}: card ${id} missing after update`);
    }
    return { element: rowToElement(elementRow), card };
  }
}
