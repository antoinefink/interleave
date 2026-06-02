/**
 * RetentionService (T079) — assembles the live {@link RetentionTargets} and resolves
 * a card's effective FSRS desired-retention target.
 *
 * This is the COMPOSITION seam between the persisted stores (the `settings` table,
 * the `concepts.desired_retention` column, the per-card `cards.desired_retention`
 * column) and the PURE resolver (`@interleave/scheduler` `resolveDesiredRetention`).
 * It does the DB reads + the per-card override write; the actual rule order +
 * clamping live in the pure resolver, never here. The per-card scheduler factory in
 * the DB service uses {@link targets} + {@link resolveForCard} so FSRS schedules each
 * card against its resolved target.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): this is a CARD-ONLY concern. The override
 * write touches `cards.desired_retention` (+ an `update_element` audit on the card
 * element); it NEVER writes `review_states`/`review_logs` (no FSRS memory state) and
 * NEVER touches a non-card element's `due_at`. Settings writes append no op (T011);
 * the per-card/per-concept writes append `update_element` (the closed op set).
 */

import type { Element, ElementId } from "@interleave/core";
import { DESIRED_RETENTION_MAX, DESIRED_RETENTION_MIN } from "@interleave/core";
import { type CardRow, cards, elements, type InterleaveDatabase } from "@interleave/db";
import {
  type RetentionResolution,
  type RetentionTargets,
  resolveDesiredRetentionDetailed,
} from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { ConceptRepository } from "./concept-repository";
import { nowIso } from "./ids";
import { rowToElement } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import { ReviewRepository } from "./review-repository";
import { SettingsRepository } from "./settings-repository";

/** A card element + its `cards` side-table row, after a retention override write. */
export interface RetentionCardResult {
  readonly card: CardRow;
  readonly element: Element;
}

export class RetentionService {
  private readonly settings: SettingsRepository;
  private readonly concepts: ConceptRepository;
  private readonly review: ReviewRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.settings = new SettingsRepository(db);
    this.concepts = new ConceptRepository(db);
    this.review = new ReviewRepository(db);
  }

  /**
   * Assemble the live {@link RetentionTargets} for the DB:
   *  - `global`    — `settings.defaultDesiredRetention`;
   *  - `byBand`    — `settings.retentionByBand` (a partial map; absent band = inherit);
   *  - `byConcept` — `ConceptRepository.retentionTargets()` (name-keyed, Math.max dedup);
   *  - `enabled`   — `settings.retentionByBandEnabled` OR any per-concept target exists
   *    (so a per-concept target engages the resolver even with the band feature off).
   * Read-only.
   */
  targets(): RetentionTargets {
    const appSettings = this.settings.getAppSettings();
    const byConcept = this.concepts.retentionTargets();
    return {
      global: appSettings.defaultDesiredRetention,
      byBand: appSettings.retentionByBand,
      byConcept,
      enabled: appSettings.retentionByBandEnabled || Object.keys(byConcept).length > 0,
    };
  }

  /**
   * Resolve a card's effective desired-retention target + which rule won (T079).
   * Reads the card's `elements.priority`, its concept memberships mapped to NAMES (so
   * `conceptNames` matches `byConcept`'s name keys), and its `cards.desired_retention`
   * override, then runs the pure resolver over the live {@link targets}. Returns the
   * global default + `source: "global"` for a non-card / unknown id (a safe fallback —
   * the scheduler factory never schedules a non-card). Read-only.
   */
  resolveForCard(cardElementId: ElementId, targets = this.targets()): RetentionResolution {
    const card = this.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) {
      return { target: targets.global, source: "global" };
    }
    const conceptNames = this.concepts.conceptsForElement(cardElementId).map((c) => c.name);
    return resolveDesiredRetentionDetailed({
      priority: card.element.priority,
      conceptNames,
      cardOverride: card.card.desiredRetention ?? null,
      targets,
    });
  }

  /**
   * Set (or clear) a card's per-card FSRS desired-retention OVERRIDE (T079) — the
   * `cards.desired_retention` column — in ONE transaction, logging `update_element`
   * on the OWNING `card` element (the audit; the column is the store the scheduler
   * reads). A finite `value` is CLAMPED to `[DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX]`
   * at this write choke point (so an override can never reach a self-retiring near-zero
   * target — T082's `is_retired` flag is the retirement mechanism, not this); `null`
   * clears the override (inherit concept/band/global). No new op type.
   */
  setCardRetention(cardElementId: ElementId, value: number | null): RetentionCardResult {
    const card = this.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) {
      throw new Error(`RetentionService.setCardRetention: card ${cardElementId} not found`);
    }
    const next =
      value === null || !Number.isFinite(value)
        ? null
        : Math.min(DESIRED_RETENTION_MAX, Math.max(DESIRED_RETENTION_MIN, value));

    return this.db.transaction((tx) => {
      const before = tx.select().from(cards).where(eq(cards.elementId, cardElementId)).get();
      const prev = before?.desiredRetention ?? null;
      tx.update(cards)
        .set({ desiredRetention: next })
        .where(eq(cards.elementId, cardElementId))
        .run();
      tx.update(elements).set({ updatedAt: nowIso() }).where(eq(elements.id, cardElementId)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_element",
        elementId: cardElementId,
        payload: {
          id: cardElementId,
          desiredRetention: next,
          prev: { desiredRetention: prev },
        },
      });
      const row = tx.select().from(cards).where(eq(cards.elementId, cardElementId)).get();
      const elementRow = tx.select().from(elements).where(eq(elements.id, cardElementId)).get();
      if (!row || !elementRow) {
        throw new Error(
          `RetentionService.setCardRetention: card ${cardElementId} missing after write`,
        );
      }
      return { card: row, element: rowToElement(elementRow) };
    });
  }
}
