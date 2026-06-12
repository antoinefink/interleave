/**
 * SessionPlanQuery (T118) — read-only assembly for minute-sized due-work sessions.
 *
 * This composes the canonical due queue candidate read with T115 time-cost estimates and
 * the pure scheduler planner. It writes nothing: no due-date changes, no review changes,
 * and no operation_log rows.
 */

import type { IsoTimestamp } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type CutSessionItem,
  type PlannedSessionItem,
  planSession,
  type SessionPlanCutReason,
} from "@interleave/scheduler";
import type { Repositories } from "./index";
import {
  type QueueFilters,
  type QueueItemSummary,
  QueueQuery,
  type QueueSessionPlanCandidateData,
  type SessionMode,
} from "./queue-query";
import { type TimeCostConfidence, TimeCostQuery } from "./time-cost-query";

export const DEFAULT_SESSION_PLAN_CUT_DETAIL_LIMIT = 25;

export interface SessionPlanReadOptions {
  readonly targetMinutes: number;
  readonly asOf?: IsoTimestamp;
  readonly filters?: QueueFilters;
  readonly mode?: SessionMode;
  readonly cutDetailLimit?: number;
}

export interface SessionPlanItemRow {
  readonly item: QueueItemSummary;
  readonly estimatedMinutes: number;
  readonly estimateConfidence: TimeCostConfidence;
  readonly estimateBasis: string;
}

export interface SessionPlanCutRow extends SessionPlanItemRow {
  readonly reason: SessionPlanCutReason;
}

export interface SessionPlanPreview {
  readonly targetMinutes: number;
  readonly plannedItems: readonly SessionPlanItemRow[];
  readonly cutItems: readonly SessionPlanCutRow[];
  readonly plannedMinutes: number;
  readonly cutMinutes: number;
  readonly cutCount: number;
  readonly candidateCount: number;
  readonly totalCandidateMinutes: number;
  readonly overTarget: boolean;
  readonly confidence: TimeCostConfidence;
  readonly hasDefaultEstimates: boolean;
  readonly cutDetailLimit: number;
  readonly cutReasons: Readonly<Record<SessionPlanCutReason, number>>;
  readonly cutByType: Readonly<
    Record<string, { readonly count: number; readonly minutes: number }>
  >;
}

type PricedSessionCandidate = QueueItemSummary & {
  readonly estimatedMinutes: number;
  readonly estimateConfidence: TimeCostConfidence;
  readonly estimateBasis: string;
};

export class SessionPlanQuery {
  private readonly queue: QueueQuery;
  private readonly timeCost: TimeCostQuery;

  constructor(db: InterleaveDatabase, repos: Repositories) {
    this.queue = new QueueQuery(repos);
    this.timeCost = new TimeCostQuery(db);
  }

  preview(options: SessionPlanReadOptions): SessionPlanPreview {
    const asOf = options.asOf ?? (new Date().toISOString() as IsoTimestamp);
    const cutDetailLimit = normalizeCutDetailLimit(options.cutDetailLimit);
    const candidates = this.queue.sessionPlanCandidates({
      asOf,
      ...(options.filters ? { filters: options.filters } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
    });
    const priced = this.priceCandidates(candidates, asOf);
    const plan = planSession(priced, { targetMinutes: options.targetMinutes });
    const cutReasons = { did_not_fit: plan.cutCount };
    const cutByType = aggregateCutByType(plan.cutItems);
    const cutItems = plan.cutItems.slice(0, cutDetailLimit).map((row) => ({
      ...toSessionPlanItemRow(row),
      reason: row.reason,
    }));

    return {
      targetMinutes: plan.targetMinutes,
      plannedItems: plan.plannedItems.map(toSessionPlanItemRow),
      cutItems,
      plannedMinutes: plan.plannedMinutes,
      cutMinutes: plan.cutMinutes,
      cutCount: plan.cutCount,
      candidateCount: priced.length,
      totalCandidateMinutes: plan.plannedMinutes + plan.cutMinutes,
      overTarget: plan.overTarget,
      confidence: priced.every((item) => item.estimateConfidence === "learned")
        ? "learned"
        : "default",
      hasDefaultEstimates:
        plan.usedFallbackEstimate || priced.some((item) => item.estimateConfidence === "default"),
      cutDetailLimit,
      cutReasons,
      cutByType,
    };
  }

  private priceCandidates(
    candidates: QueueSessionPlanCandidateData,
    asOf: IsoTimestamp,
  ): readonly PricedSessionCandidate[] {
    const estimate = this.timeCost.estimateQueue(candidates.timeCostSummary, {
      asOf,
      visibleItems: candidates.items.map((item) => ({
        id: item.id,
        type: item.type,
        stage: item.stage,
      })),
    });
    const estimatesById = new Map(estimate.items.map((item) => [item.id, item]));
    return candidates.items.map((item) => {
      const row = estimatesById.get(item.id);
      return {
        ...item,
        estimatedMinutes: row?.estimatedMinutes ?? 0,
        estimateConfidence: row?.confidence ?? estimate.confidence,
        estimateBasis: row?.basis ?? "time-cost:missing-estimate",
      };
    });
  }
}

function toSessionPlanItemRow(row: PlannedSessionItem<PricedSessionCandidate>): SessionPlanItemRow {
  return {
    item: row.item,
    estimatedMinutes: row.estimatedMinutes,
    estimateConfidence: row.estimateConfidence,
    estimateBasis: row.estimateBasis ?? "time-cost:missing-estimate",
  };
}

function normalizeCutDetailLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_SESSION_PLAN_CUT_DETAIL_LIMIT;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function aggregateCutByType(
  rows: readonly CutSessionItem<PricedSessionCandidate>[],
): Readonly<Record<string, { readonly count: number; readonly minutes: number }>> {
  const aggregate: Record<string, { count: number; minutes: number }> = {};
  for (const row of rows) {
    const type = row.item.type;
    const prev = aggregate[type] ?? { count: 0, minutes: 0 };
    aggregate[type] = { count: prev.count + 1, minutes: prev.minutes + row.estimatedMinutes };
  }
  return aggregate;
}
