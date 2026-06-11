/**
 * WorkloadService (T081) — the COMPOSITION seam for the pure workload projector.
 *
 * It builds the DB-free {@link WorkloadSnapshot} from the live tables (`review_states`
 * + `elements` for cards, `elements` for attention items, `concepts` for the per-card
 * concept names / preset, the `RetentionService` for the live targets, the settings for
 * the budget) and calls the pure `@interleave/scheduler` {@link projectWorkload}. The
 * projection math lives in the scheduler package; this seam only READS + assembles.
 *
 * READ-ONLY (load-bearing): the simulation NEVER mutates `review_states`/`due_at`/
 * settings and appends NO `operation_log` row — there is nothing to undo about
 * previewing load. The user `Commit`s a previewed change through the relevant EXISTING
 * command (retention set / import / postpone), never through here.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): the snapshot carries cards (FSRS due dates +
 * memory state) and attention items (attention due dates) SEPARATELY; the projector
 * keeps them distinct (a retention lever moves only cards, a postpone lever moves
 * attention items + optional mature cards). This seam never crosses them.
 *
 * GROUNDING: the snapshot's card due dates are the live `review_states.dueAt` and the
 * attention due dates are the live `elements.dueAt` — the SAME values
 * `QueueRepository.dueCards`/`dueAttentionItems` read — and the projector buckets them
 * the way the analytics screen does, so the projection's `before` series equals what the
 * queue/analytics report for the same clock (pinned in the tests).
 *
 * T080's `OptimizationService.workloadImpactOf` is the DB-backed wrapper over THIS
 * projector for the `applyParams` lever (it shares the same engine, not a fork).
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import { cards, elements, type InterleaveDatabase, reviewStates } from "@interleave/db";
import {
  projectWorkload,
  type WorkloadAttentionItem,
  type WorkloadCard,
  type WorkloadChange,
  type WorkloadProjection,
  type WorkloadSnapshot,
} from "@interleave/scheduler";
import { and, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { ConceptRepository } from "./concept-repository";
import { RetentionService } from "./retention-service";
import { SettingsRepository } from "./settings-repository";

/** Options for {@link WorkloadService.simulate}. */
export interface WorkloadSimulateOptions {
  /** "Now" the projection window starts at (ISO-8601); defaults to the wall clock. */
  readonly asOf?: IsoTimestamp;
  /** The projection window length in days (default in the projector). */
  readonly windowDays?: number;
}

/** The FSRS forgetting-curve constants (mirrors `queue-query.ts` / `inspector-query.ts`). */
const FSRS_DECAY = -0.5;
const FSRS_FACTOR = 19 / 81;
const DAY_MS = 86_400_000;

/**
 * Lifecycle statuses that take a row OUT of the due queue (mirrors
 * `QueueRepository.QUEUE_EXCLUDED_STATUSES`), so the snapshot's baseline matches the
 * queue's due reads exactly — a `done`/`parked`/`dismissed`/`suspended`/`deleted` row is not
 * "due", so it must not appear in the projection's baseline either.
 */
const QUEUE_EXCLUDED_STATUSES = ["done", "parked", "dismissed", "suspended", "deleted"] as const;

/**
 * Approximate retrievability `R(t) = (1 + FACTOR · t / S)^DECAY` (days since last review),
 * the SAME approximation the queue/inspector use until FSRS owns the authoritative number
 * — so the maturity classification in the projector agrees with the queue's. `null` for a
 * never-reviewed card / non-positive stability.
 */
function approximateRetrievability(
  stability: number,
  lastReviewedAt: string | null,
  asOfMs: number,
): number | null {
  if (!lastReviewedAt || stability <= 0) return null;
  const last = Date.parse(lastReviewedAt);
  if (Number.isNaN(last)) return null;
  const elapsedDays = Math.max(0, (asOfMs - last) / DAY_MS);
  const r = (1 + (FSRS_FACTOR * elapsedDays) / stability) ** FSRS_DECAY;
  return Math.min(1, Math.max(0, r));
}

export class WorkloadService {
  private readonly concepts: ConceptRepository;
  private readonly retention: RetentionService;
  private readonly settings: SettingsRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.concepts = new ConceptRepository(db);
    this.retention = new RetentionService(db);
    this.settings = new SettingsRepository(db);
  }

  /**
   * Build the DB-free {@link WorkloadSnapshot} for the live DB at `asOf` (read-only):
   *  - CARDS: live, non-excluded `card` elements joined to `review_states` (the FSRS due
   *    + memory state), each decorated with its concept NAMES (for the retention
   *    resolver), its resolved FSRS preset, its per-card override, and an approximate
   *    retrievability (for the mature/fragile classification);
   *  - ATTENTION: live, non-excluded non-`card` elements with an attention `due_at`;
   *  - BUDGET: `settings.dailyReviewBudget` (the overload line);
   *  - TARGETS: the live {@link RetentionService.targets} (so the retention lever resolves).
   */
  buildSnapshot(asOf: IsoTimestamp = new Date().toISOString() as IsoTimestamp): WorkloadSnapshot {
    const asOfMs = Date.parse(asOf);

    // Concept id -> name (for mapping a card's memberships to the resolver's name keys).
    const conceptNameById = new Map<ElementId, string>();
    for (const node of this.concepts.listConcepts()) conceptNameById.set(node.id, node.name);
    const membership = this.concepts.liveMembershipMap(); // member -> Set<conceptId>

    // ---- CARDS: review_states ⋈ live, non-excluded card elements ----
    const cardRows = this.db
      .select({
        elementId: reviewStates.elementId,
        dueAt: reviewStates.dueAt,
        stability: reviewStates.stability,
        fsrsState: reviewStates.fsrsState,
        lastReviewedAt: reviewStates.lastReviewedAt,
        priority: elements.priority,
        cardOverride: cards.desiredRetention,
      })
      .from(reviewStates)
      .innerJoin(elements, eq(elements.id, reviewStates.elementId))
      .innerJoin(cards, eq(cards.elementId, reviewStates.elementId))
      .where(
        and(
          eq(elements.type, "card"),
          isNull(elements.deletedAt),
          notInArray(elements.status, QUEUE_EXCLUDED_STATUSES as unknown as string[]),
        ),
      )
      .all();

    const snapshotCards: WorkloadCard[] = cardRows.map((row) => {
      const id = row.elementId as ElementId;
      const conceptIds = membership.get(id);
      const conceptNames = conceptIds
        ? [...conceptIds]
            .map((cid) => conceptNameById.get(cid))
            .filter((n): n is string => typeof n === "string")
        : [];
      return {
        id,
        priority: row.priority,
        stability: row.stability,
        lastReviewedAt: row.lastReviewedAt ?? null,
        dueAt: row.dueAt ?? null,
        fsrsState: row.fsrsState,
        retrievability: approximateRetrievability(
          row.stability,
          row.lastReviewedAt ?? null,
          asOfMs,
        ),
        cardOverride: row.cardOverride ?? null,
        params: this.retention.resolveParamsForCard(id),
        conceptNames,
      };
    });

    // ---- ATTENTION: live, non-excluded non-card elements with a due_at ----
    const attentionRows = this.db
      .select({
        id: elements.id,
        priority: elements.priority,
        dueAt: elements.dueAt,
        type: elements.type,
      })
      .from(elements)
      .where(
        and(
          notInArray(elements.type, ["card"]),
          isNull(elements.deletedAt),
          notInArray(elements.status, QUEUE_EXCLUDED_STATUSES as unknown as string[]),
          isNotNull(elements.dueAt),
        ),
      )
      .all();

    const snapshotAttention: WorkloadAttentionItem[] = attentionRows.map((row) => ({
      id: row.id as ElementId,
      priority: row.priority,
      dueAt: row.dueAt ?? null,
      type: row.type,
    }));

    return {
      cards: snapshotCards,
      attention: snapshotAttention,
      budget: this.settings.getAppSettings().dailyReviewBudget,
      targets: this.retention.targets(),
    };
  }

  /**
   * Simulate how the daily workload shifts under a hypothetical `change` (T081) — the
   * one read command behind `workload.simulate`. Builds the snapshot from the live tables
   * and runs the pure projector. READ-ONLY: writes nothing, appends no op.
   */
  simulate(change: WorkloadChange, options: WorkloadSimulateOptions = {}): WorkloadProjection {
    const asOf = options.asOf ?? (new Date().toISOString() as IsoTimestamp);
    const snapshot = this.buildSnapshot(asOf);
    return projectWorkload(
      snapshot,
      change,
      options.windowDays === undefined ? { asOf } : { asOf, windowDays: options.windowDays },
    );
  }
}
