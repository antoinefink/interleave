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
import type { DbClient } from "./types";

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
   * Resolve a card's effective FSRS PARAMETER vector (T080) — the queryable preset
   * the per-card scheduler factory passes through `CardSchedulerServiceOptions.params`
   * (the documented escape hatch). Resolution order: the card's STRICTEST/first
   * concept preset (`concepts.fsrs_params`) → the global preset
   * (`settings.fsrsParamsGlobal`) → `null` (inherit ts-fsrs `default_w`). Returns
   * `null` for a non-card / unknown id (a safe inherit). Read-only.
   *
   * "Strictest/first concept preset": among the card's concepts that carry a stored
   * preset, the one whose concept name has the HIGHEST retention target wins (so the
   * preset tracks the same fragile-concept-wins rule as the retention resolver);
   * absent a target tie-break, the first membership order is used — deterministic.
   */
  resolveParamsForCard(cardElementId: ElementId): number[] | null {
    const card = this.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) return null;
    const conceptSummaries = this.concepts.conceptsForElement(cardElementId);
    // Pick the concept preset belonging to the strictest (highest-target) concept;
    // fall back to membership order for concepts without a target.
    let best: { params: number[]; target: number; order: number } | null = null;
    let order = 0;
    for (const summary of conceptSummaries) {
      if (summary.fsrsParams) {
        const target = summary.desiredRetention ?? -1;
        if (
          best === null ||
          target > best.target ||
          (target === best.target && order < best.order)
        ) {
          best = { params: summary.fsrsParams, target, order };
        }
      }
      order += 1;
    }
    if (best) return best.params;
    return this.settings.getAppSettings().fsrsParamsGlobal;
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
   *
   * An optional `tx` executor lets a CALLER run this write inside a LARGER
   * transaction (T082's `retire` floor-clamps the override in the SAME transaction
   * as the retirement flag flip) — when omitted the write opens its own transaction,
   * so existing callers are unchanged.
   */
  setCardRetention(
    cardElementId: ElementId,
    value: number | null,
    tx?: DbClient,
  ): RetentionCardResult {
    const card = this.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) {
      throw new Error(`RetentionService.setCardRetention: card ${cardElementId} not found`);
    }
    const next =
      value === null || !Number.isFinite(value)
        ? null
        : Math.min(DESIRED_RETENTION_MAX, Math.max(DESIRED_RETENTION_MIN, value));

    const write = (exec: DbClient): RetentionCardResult => {
      const before = exec.select().from(cards).where(eq(cards.elementId, cardElementId)).get();
      const prev = before?.desiredRetention ?? null;
      exec
        .update(cards)
        .set({ desiredRetention: next })
        .where(eq(cards.elementId, cardElementId))
        .run();
      exec
        .update(elements)
        .set({ updatedAt: nowIso() })
        .where(eq(elements.id, cardElementId))
        .run();
      new OperationLogRepository(exec).append(exec, {
        opType: "update_element",
        elementId: cardElementId,
        payload: {
          id: cardElementId,
          desiredRetention: next,
          prev: { desiredRetention: prev },
        },
      });
      const row = exec.select().from(cards).where(eq(cards.elementId, cardElementId)).get();
      const elementRow = exec.select().from(elements).where(eq(elements.id, cardElementId)).get();
      if (!row || !elementRow) {
        throw new Error(
          `RetentionService.setCardRetention: card ${cardElementId} missing after write`,
        );
      }
      return { card: row, element: rowToElement(elementRow) };
    };

    return tx ? write(tx) : this.db.transaction((inner) => write(inner));
  }
}
