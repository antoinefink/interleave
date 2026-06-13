/**
 * Session planning (T118) — pure minute-envelope assembly for due queue work.
 *
 * Queue membership and score order are owned by trusted read models. This planner only
 * consumes an already ordered, already priced due universe and decides which rows fit in a
 * requested session. It never mutates and never re-scores; composition policy is expressed
 * only as deterministic minute selection over the trusted ordered input.
 */

import { isExtractStage } from "./attention-scheduler";

export type SessionPlanCutReason = "did_not_fit";
export type SessionPlanEstimateConfidence = "learned" | "default";
export type DistillationQuotaStatus =
  | "active"
  | "returned_empty_backlog"
  | "inactive_filtered_out"
  | "inactive_zero_target"
  | "unavailable_no_time_estimate";

export interface SessionPlanCandidate {
  readonly id: string;
  readonly type?: string | null;
  readonly stage?: string | null;
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
  readonly composition: SessionPlanComposition;
  readonly plannedMinutes: number;
  readonly cutMinutes: number;
  readonly cutCount: number;
  readonly overTarget: boolean;
  readonly usedFallbackEstimate: boolean;
}

export interface SessionPlanComposition {
  readonly status: DistillationQuotaStatus;
  readonly quotaFloorMinutes: number;
  readonly eligibleDistillationMinutes: number;
  readonly selectedDistillationMinutes: number;
  readonly returnedQuotaMinutes: number;
  readonly cardMinutes: number;
  readonly distillationMinutes: number;
  readonly otherMinutes: number;
}

export interface SessionPlanOptions {
  readonly targetMinutes: number;
  readonly distillationQuotaPercent?: number;
  readonly distillationQuotaApplies?: boolean;
}

const INVALID_ESTIMATE_BASIS = "session-plan:invalid-estimate-fallback";

function finiteTargetMinutes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function boundedPercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function distillationQuotaFloorMinutes(
  targetMinutes: number,
  percent: number | undefined,
): number {
  const target = finiteTargetMinutes(targetMinutes);
  const bounded = boundedPercent(percent);
  if (target === 0 || bounded === 0) return 0;
  return Math.min(target, Math.ceil((target * bounded) / 100));
}

export function isDistillationQuotaCandidate(item: {
  readonly type?: string | null;
  readonly stage?: string | null;
}): boolean {
  return item.type === "extract" && isExtractStage(item.stage);
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

function fillInOrder<T extends SessionPlanCandidate>(
  items: readonly (PlannedSessionItem<T> & { readonly validEstimate: boolean })[],
  targetMinutes: number,
  initialPlannedItems: readonly (PlannedSessionItem<T> & { readonly validEstimate: boolean })[],
): {
  readonly plannedItems: readonly (PlannedSessionItem<T> & { readonly validEstimate: boolean })[];
  readonly cutItems: readonly CutSessionItem<T>[];
  readonly plannedMinutes: number;
  readonly cutMinutes: number;
} {
  const plannedItems = [...initialPlannedItems];
  const cutItems: CutSessionItem<T>[] = [];
  let plannedMinutes = plannedItems.reduce((sum, row) => sum + row.estimatedMinutes, 0);
  let cutMinutes = 0;
  let cutTail = false;

  for (const estimate of items) {
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

  return { plannedItems, cutItems, plannedMinutes, cutMinutes };
}

function emptyComposition(status: DistillationQuotaStatus): SessionPlanComposition {
  return {
    status,
    quotaFloorMinutes: 0,
    eligibleDistillationMinutes: 0,
    selectedDistillationMinutes: 0,
    returnedQuotaMinutes: 0,
    cardMinutes: 0,
    distillationMinutes: 0,
    otherMinutes: 0,
  };
}

function compositionFor<T extends SessionPlanCandidate>(
  plannedItems: readonly PlannedSessionItem<T>[],
  quotaFloorMinutes: number,
  eligibleDistillationMinutes: number,
  returnedQuotaMinutes: number,
  status: DistillationQuotaStatus,
): SessionPlanComposition {
  let cardMinutes = 0;
  let distillationMinutes = 0;
  let otherMinutes = 0;
  for (const row of plannedItems) {
    if (isDistillationQuotaCandidate(row.item)) distillationMinutes += row.estimatedMinutes;
    else if (row.item.type === "card") cardMinutes += row.estimatedMinutes;
    else otherMinutes += row.estimatedMinutes;
  }
  return {
    status,
    quotaFloorMinutes,
    eligibleDistillationMinutes,
    selectedDistillationMinutes: distillationMinutes,
    returnedQuotaMinutes,
    cardMinutes,
    distillationMinutes,
    otherMinutes,
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
  const pricedItems = candidates.map((item) => priced(item, targetMinutes));
  const usedFallbackEstimate = pricedItems.some((item) => !item.validEstimate);
  const quotaFloorMinutes = distillationQuotaFloorMinutes(
    targetMinutes,
    options.distillationQuotaPercent,
  );
  const quotaApplies = options.distillationQuotaApplies ?? true;

  if (targetMinutes === 0) {
    const cutItems = pricedItems.map((estimate) => ({
      ...estimate,
      reason: "did_not_fit" as const,
    }));
    return {
      targetMinutes,
      plannedItems: [],
      cutItems,
      composition: emptyComposition("inactive_zero_target"),
      plannedMinutes: 0,
      cutMinutes: cutItems.reduce((sum, row) => sum + row.estimatedMinutes, 0),
      cutCount: cutItems.length,
      overTarget: false,
      usedFallbackEstimate,
    };
  }

  const quotaCandidates = pricedItems.filter((row) => isDistillationQuotaCandidate(row.item));
  let reservedDistillation: readonly (PlannedSessionItem<T> & {
    readonly validEstimate: boolean;
  })[] = [];
  let status: DistillationQuotaStatus = quotaFloorMinutes === 0 ? "inactive_zero_target" : "active";
  let returnedQuotaMinutes = 0;
  const eligibleDistillationMinutes = quotaCandidates.reduce(
    (sum, row) => sum + row.estimatedMinutes,
    0,
  );

  if (quotaFloorMinutes > 0 && !quotaApplies) {
    status = "inactive_filtered_out";
  } else if (quotaFloorMinutes > 0 && quotaCandidates.length === 0) {
    status = "returned_empty_backlog";
    returnedQuotaMinutes = quotaFloorMinutes;
  } else if (quotaFloorMinutes > 0) {
    const selected: (PlannedSessionItem<T> & { readonly validEstimate: boolean })[] = [];
    let selectedMinutes = 0;
    for (const row of quotaCandidates) {
      if (selectedMinutes >= quotaFloorMinutes) break;
      selected.push(row);
      selectedMinutes += row.estimatedMinutes;
    }
    reservedDistillation = selected;
    returnedQuotaMinutes = Math.max(0, quotaFloorMinutes - selectedMinutes);
  }

  const reserveIds = new Set(reservedDistillation.map((row) => row.item.id));
  const residualCandidates =
    quotaFloorMinutes > 0 && status === "active"
      ? pricedItems.filter((row) => !reserveIds.has(row.item.id))
      : pricedItems;
  const fill = fillInOrder(residualCandidates, targetMinutes, reservedDistillation);
  const cutItems = fill.cutItems;
  const plannedItems = fill.plannedItems;
  const plannedMinutes = fill.plannedMinutes;
  const cutMinutes = cutItems.reduce((sum, row) => sum + row.estimatedMinutes, 0);
  const composition = compositionFor(
    plannedItems,
    quotaFloorMinutes,
    eligibleDistillationMinutes,
    returnedQuotaMinutes,
    status,
  );

  return {
    targetMinutes,
    plannedItems,
    cutItems,
    composition,
    plannedMinutes,
    cutMinutes,
    cutCount: cutItems.length,
    overTarget: plannedMinutes > targetMinutes,
    usedFallbackEstimate,
  };
}
