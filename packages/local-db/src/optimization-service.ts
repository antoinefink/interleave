/**
 * OptimizationService (T080) — the COMPOSITION seam for on-device FSRS parameter
 * optimization. The CARD half of the two-scheduler split.
 *
 * It maps `review_logs` → the pure `@interleave/scheduler` evaluator's DB-free
 * `OptimizerHistory`, runs the bounded calibration search (`suggestParameters`),
 * computes a read-only workload-impact preview, and — only on an explicit
 * `apply` — writes the accepted params to a QUERYABLE store: the global preset to
 * the `fsrs.params.global` SETTING, a per-concept preset to the
 * `concepts.fsrs_params` COLUMN (+ an `update_element` audit). `schedulerForCard`
 * (T079) then READS those stores so resolved scheduling actually uses the params.
 *
 * HONESTY: ts-fsrs ships NO optimizer (see `fsrs-optimizer.ts`). `suggest` returns
 * an ESTIMATE from the user's history (calibration), never a claim of optimality,
 * and it is NEVER auto-applied — `apply` is the only persisting method.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): this touches FSRS (card) params only. The
 * apply is a `settings` write (no op, T011) or an `update_element` (the closed op
 * set) — NEVER a new op type, NEVER a `review_states`/`review_logs` write, NEVER an
 * attention item's `due_at`. `suggest` + the workload preview are READ-ONLY.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import { elements, type InterleaveDatabase } from "@interleave/db";
import {
  MS_PER_DAY,
  type OptimizationSuggestion,
  type OptimizerHistory,
  type OptimizerReview,
  sanitizeParams,
  suggestParameters,
} from "@interleave/scheduler";
import { and, eq, isNull } from "drizzle-orm";
import { ConceptRepository } from "./concept-repository";
import { ReviewRepository } from "./review-repository";
import { SettingsRepository } from "./settings-repository";
import { WorkloadService } from "./workload-service";

/** A bucketed daily due count for the workload preview. */
export interface WorkloadDay {
  readonly date: string;
  readonly count: number;
}

/**
 * The read-only workload-impact preview (T080): the per-day due counts BEFORE the
 * change (the live schedule) and AFTER applying candidate params, plus summary
 * deltas over the next 7 / 30 days. Recomputed in memory; writes nothing.
 */
export interface WorkloadImpact {
  readonly before: readonly WorkloadDay[];
  readonly after: readonly WorkloadDay[];
  readonly deltaDueNext7: number;
  readonly deltaDueNext30: number;
}

/** The optimization scope: the global preset, or one concept's preset. */
export type OptimizationScope =
  | { readonly scope: "global" }
  | { readonly scope: "concept"; readonly conceptId: ElementId };

/** A suggestion plus its workload preview (the `optimization.suggest` result). */
export interface OptimizationSuggestionWithWorkload extends OptimizationSuggestion {
  readonly workload: WorkloadImpact;
}

/** How many days the inline suggest's history must reach to count as "large" (→ runner). */
export const HEAVY_FIT_REVIEW_THRESHOLD = 5000;

/** Default workload-preview window (days). */
const WORKLOAD_WINDOW_DAYS = 30;

export class OptimizationService {
  private readonly review: ReviewRepository;
  private readonly concepts: ConceptRepository;
  private readonly settings: SettingsRepository;
  private readonly workload: WorkloadService;

  constructor(private readonly db: InterleaveDatabase) {
    this.review = new ReviewRepository(db);
    this.concepts = new ConceptRepository(db);
    this.settings = new SettingsRepository(db);
    this.workload = new WorkloadService(db);
  }

  /** All LIVE `card` element ids (the global-scope history). */
  private liveCardIds(): ElementId[] {
    return this.db
      .select({ id: elements.id })
      .from(elements)
      .where(and(eq(elements.type, "card"), isNull(elements.deletedAt)))
      .all()
      .map((r) => r.id as ElementId);
  }

  /** The LIVE `card` member ids of one concept (the concept-scope history). */
  private conceptCardIds(conceptId: ElementId): ElementId[] {
    const memberIds = this.concepts.elementsForConcept(conceptId);
    if (memberIds.length === 0) return [];
    const cardIds = new Set(this.liveCardIds());
    return memberIds.filter((id) => cardIds.has(id));
  }

  /**
   * Build the DB-free {@link OptimizerHistory} for a set of card ids from
   * `review_logs`. The evaluator assumes a CLEAN, ASCENDING input, so this mapper:
   *  - re-sorts each card's logs ASCENDING by `reviewedAt` (`listReviewLogs` returns
   *    them DESC — newest first — so the `delta_t` signs would invert otherwise), and
   *  - DERIVES `elapsedDays` from consecutive `reviewedAt` deltas (`review_logs` has
   *    no per-log `elapsedDays` column; the first review's `elapsedDays` is `0`).
   * Cards with no logs are dropped. Read-only.
   */
  buildHistory(cardIds: readonly ElementId[]): OptimizerHistory[] {
    const out: OptimizerHistory[] = [];
    for (const cardId of cardIds) {
      const logs = this.review.listReviewLogs(cardId);
      if (logs.length === 0) continue;
      // Re-sort ASCENDING (listReviewLogs is DESC). A stable copy.
      const ascending = [...logs].sort(
        (a, b) => Date.parse(a.reviewedAt) - Date.parse(b.reviewedAt),
      );
      const reviews: OptimizerReview[] = [];
      let prevMs: number | null = null;
      for (const log of ascending) {
        const ms = Date.parse(log.reviewedAt);
        const elapsedDays = prevMs === null ? 0 : Math.max(0, (ms - prevMs) / MS_PER_DAY);
        reviews.push({ rating: log.rating, reviewedAt: log.reviewedAt, elapsedDays });
        prevMs = ms;
      }
      out.push({ cardId, reviews });
    }
    return out;
  }

  /**
   * Total review-log rows across a card set — used to route a LARGE history to the
   * runner (the heavy fit) instead of the inline path. Read-only.
   */
  reviewCount(cardIds: readonly ElementId[]): number {
    let total = 0;
    for (const cardId of cardIds) total += this.review.listReviewLogs(cardId).length;
    return total;
  }

  /** The card ids in scope (all cards, or one concept's member cards). */
  cardIdsForScope(scope: OptimizationScope): ElementId[] {
    return scope.scope === "global" ? this.liveCardIds() : this.conceptCardIds(scope.conceptId);
  }

  /**
   * Suggest a parameter set for a scope (T080) WITHOUT persisting anything: builds
   * the history (all cards, or the concept's member cards), runs the bounded
   * calibration search starting from the scope's CURRENT params (the concept preset
   * or the global preset or `default_w`), and computes the workload-impact preview.
   * Read-only.
   */
  suggest(scope: OptimizationScope): OptimizationSuggestionWithWorkload {
    const cardIds = this.cardIdsForScope(scope);
    const history = this.buildHistory(cardIds);
    const current = this.currentParamsForScope(scope) ?? undefined;
    const suggestion = suggestParameters(history, current ? { current } : {});
    return this.withWorkload(suggestion, scope);
  }

  /**
   * Build the off-main `fsrs_optimize` job payload for a scope (T080) — the DB-free
   * {@link OptimizerHistory} + the scope's current params — WITHOUT running the fit.
   * MAIN enqueues this on the runner for a LARGE history (see
   * {@link HEAVY_FIT_REVIEW_THRESHOLD}) so the bounded search runs OFF the main
   * thread; the worker imports only `@interleave/scheduler` (never the DB). Read-only.
   */
  buildJobPayload(scope: OptimizationScope): {
    readonly history: OptimizerHistory[];
    readonly current?: number[];
  } {
    const history = this.buildHistory(this.cardIdsForScope(scope));
    const current = this.currentParamsForScope(scope);
    return current ? { history, current } : { history };
  }

  /**
   * Compose a {@link OptimizationSuggestion} (produced inline OR by the off-main
   * runner) with the scope's read-only workload-impact preview (T080). MAIN calls
   * this after a runner `fsrs_optimize` job lands so the DB-backed workload preview is
   * always computed on the main side (the worker stays DB-free). Read-only.
   */
  withWorkload(
    suggestion: OptimizationSuggestion,
    scope: OptimizationScope,
  ): OptimizationSuggestionWithWorkload {
    const workload = this.workloadImpactOf([...suggestion.params.w], scope);
    return { ...suggestion, workload };
  }

  /** The current stored params for a scope (concept preset / global preset), or `null`. */
  private currentParamsForScope(scope: OptimizationScope): number[] | null {
    if (scope.scope === "concept") {
      const summary = this.concepts.findById(scope.conceptId);
      if (summary?.fsrsParams) return summary.fsrsParams;
    }
    return this.settings.getAppSettings().fsrsParamsGlobal;
  }

  /**
   * Apply an accepted parameter set (T080) — the ONLY persisting method. Writes to
   * the QUERYABLE store: `scope: "global"` → the `fsrs.params.global` SETTING (via
   * `SettingsRepository.updateAppSettings`, no op); `scope: "concept"` →
   * `concepts.fsrs_params` (+ an `update_element` audit on the concept element), in
   * one transaction. Validates the vector through `@interleave/scheduler`
   * `sanitizeParams` first (a malformed vector is rejected, never stored). Apply does
   * NOT retroactively reschedule existing cards — new grades use the new params.
   */
  apply(scope: OptimizationScope, params: readonly number[]): { applied: true } {
    const sane = sanitizeParams(params);
    if (!sane) {
      throw new Error("OptimizationService.apply: invalid FSRS parameter vector");
    }
    if (scope.scope === "global") {
      // Settings write (no op) — the queryable global preset store.
      this.settings.updateAppSettings({ fsrsParamsGlobal: sane });
    } else {
      // Concept column + update_element audit (one transaction inside the repo).
      this.concepts.setConceptFsrsParams(scope.conceptId, sane);
    }
    return { applied: true };
  }

  /**
   * The read-only workload-impact preview (T080) — now a THIN WRAPPER over the shared
   * T081 workload projector (`WorkloadService.simulate` → `projectWorkload`), so the
   * optimization apply-preview and the T081 simulator share ONE engine (not a fork).
   *
   * It runs the projector's `applyParams` lever (re-project each in-scope card's due to
   * `lastReviewedAt + next_interval(stability, elapsed)` under `candidateParams`) and
   * maps the projection's `{ date, before, after }` series back to this surface's
   * `{ before: { date, count }[], after: { date, count }[] }` shape (the IPC contract is
   * unchanged). A concept scope restricts the re-projection to that concept's member
   * cards. APPROXIMATION (labeled an estimate, deterministic). Read-only.
   */
  workloadImpactOf(
    candidateParams: readonly number[],
    scope: OptimizationScope = { scope: "global" },
    asOf: IsoTimestamp = new Date().toISOString() as IsoTimestamp,
  ): WorkloadImpact {
    const cardIds = scope.scope === "concept" ? this.cardIdsForScope(scope) : undefined;
    const change =
      cardIds === undefined
        ? ({ kind: "applyParams", params: [...candidateParams] } as const)
        : ({ kind: "applyParams", params: [...candidateParams], cardIds } as const);
    const projection = this.workload.simulate(change, { asOf, windowDays: WORKLOAD_WINDOW_DAYS });
    const before: WorkloadDay[] = projection.days.map((d) => ({ date: d.date, count: d.before }));
    const after: WorkloadDay[] = projection.days.map((d) => ({ date: d.date, count: d.after }));
    return {
      before,
      after,
      deltaDueNext7: projection.deltaNext7,
      deltaDueNext30: projection.deltaNext30,
    };
  }
}
