/**
 * Session planning (T118) — pure minute-envelope assembly for due queue work.
 *
 * Queue membership and score order are owned by trusted read models. This planner only
 * consumes an already ordered, already priced due universe and decides which rows fit in a
 * requested session. It never mutates, never re-scores, and never applies future quota policy.
 */

export type SessionPlanCutReason = "did_not_fit";
export type SessionPlanEstimateConfidence = "learned" | "default";

export interface SessionPlanCandidate {
  readonly id: string;
  readonly estimatedMinutes?: number | null;
  readonly estimateConfidence?: SessionPlanEstimateConfidence;
  readonly estimateBasis?: string;
  /** Present for future policy composition; T118 never cuts protected work by policy. */
  readonly protected?: boolean;
}

export interface PlannedSessionItem<T extends SessionPlanCandidate = SessionPlanCandidate> {
  readonly item: T;
  readonly estimatedMinutes: number;
  readonly estimateConfidence: SessionPlanEstimateConfidence;
  readonly estimateBasis: string | null;
}

export interface CutSessionItem<T extends SessionPlanCandidate = SessionPlanCandidate>
  extends PlannedSessionItem<T> {
  readonly reason: SessionPlanCutReason;
}

export interface SessionPlan<T extends SessionPlanCandidate = SessionPlanCandidate> {
  readonly targetMinutes: number;
  readonly plannedItems: readonly PlannedSessionItem<T>[];
  readonly cutItems: readonly CutSessionItem<T>[];
  readonly plannedMinutes: number;
  readonly cutMinutes: number;
  readonly cutCount: number;
  readonly overTarget: boolean;
  readonly usedFallbackEstimate: boolean;
}

export interface SessionPlanOptions {
  readonly targetMinutes: number;
}

const INVALID_ESTIMATE_BASIS = "session-plan:invalid-estimate-fallback";

function finiteTargetMinutes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function priced<T extends SessionPlanCandidate>(
  item: T,
  targetMinutes: number,
): PlannedSessionItem<T> & { readonly validEstimate: boolean } {
  const raw = item.estimatedMinutes;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return {
      item,
      estimatedMinutes: raw,
      estimateConfidence: item.estimateConfidence ?? "default",
      estimateBasis: item.estimateBasis ?? null,
      validEstimate: true,
    };
  }
  return {
    item,
    estimatedMinutes: Math.max(1, targetMinutes + 1),
    estimateConfidence: "default",
    estimateBasis: item.estimateBasis ?? INVALID_ESTIMATE_BASIS,
    validEstimate: false,
  };
}

/**
 * Fill a session in the input order. The planner stops before exceeding the target when
 * avoidable, but for a positive target it includes one valid first item even when that
 * item alone is oversized so the user can still start useful work.
 */
export function planSession<T extends SessionPlanCandidate>(
  candidates: readonly T[],
  options: SessionPlanOptions,
): SessionPlan<T> {
  const targetMinutes = finiteTargetMinutes(options.targetMinutes);
  const plannedItems: PlannedSessionItem<T>[] = [];
  const cutItems: CutSessionItem<T>[] = [];
  let plannedMinutes = 0;
  let cutMinutes = 0;
  let usedFallbackEstimate = false;
  let cutTail = false;

  for (const item of candidates) {
    const estimate = priced(item, targetMinutes);
    if (!estimate.validEstimate) usedFallbackEstimate = true;
    const wouldFit = plannedMinutes + estimate.estimatedMinutes <= targetMinutes;
    const oversizedFirst =
      targetMinutes > 0 &&
      plannedItems.length === 0 &&
      estimate.validEstimate &&
      estimate.estimatedMinutes > targetMinutes;

    if (!cutTail && (wouldFit || oversizedFirst)) {
      plannedItems.push(estimate);
      plannedMinutes += estimate.estimatedMinutes;
    } else {
      cutTail = true;
      cutItems.push({ ...estimate, reason: "did_not_fit" });
      cutMinutes += estimate.estimatedMinutes;
    }
  }

  return {
    targetMinutes,
    plannedItems,
    cutItems,
    plannedMinutes,
    cutMinutes,
    cutCount: cutItems.length,
    overTarget: plannedMinutes > targetMinutes,
    usedFallbackEstimate,
  };
}
