/**
 * AutoPostponeService (T077) — the APPLY seam for the overload auto-postpone valve.
 *
 * The pure {@link planAutoPostpone} (in `@interleave/scheduler`) decides WHICH due items
 * recede when the load exceeds the daily budget — low-priority topics/sources/extracts
 * first, then low-priority *mature* cards, NEVER a high-priority *fragile* card (or a
 * leech, or a `protected` item). This service is the only thing that PERSISTS that plan.
 * It composes:
 *
 *  - {@link QueueQuery.autoPostponeCandidates} — the FULL merged due set (not the display-capped
 *    rows), decorated with priority/retrievability/stability/`fsrsState`/lapses and priced by
 *    {@link TimeCostQuery} so the planner trims real minutes, not item counts;
 *  - the pure {@link planAutoPostpone} — deterministic victim selection;
 *  - the TWO apply seams, one per scheduler (the load-bearing split):
 *      · attention item → {@link SchedulerService.rescheduleForAction}(id,"postpone",now,batchId)
 *        (`reschedule_element`, status → `scheduled`);
 *      · card → the shared {@link QueueActionService.cardDeferBy}(id,now,days,batchId) — an
 *        FSRS-aware defer that moves ONLY `review_states.due_at` (+ `elements.due_at`),
 *        leaving the memory state (`stability`/`difficulty`/`reps`/`lapses`/`fsrsState`)
 *        UNTOUCHED and writing NO review log.
 *
 * `preview()` is READ-ONLY (no mutation, no op). `apply()` mints ONE `batchId` so the whole
 * sweep undoes as a single batch via the existing command-level undo (T044). No new op types
 * (the closed 15-op set is unchanged), no schema migration. The renderer reaches this only
 * through the typed `window.appApi.queue.autoPostpone` / `…Apply` commands.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type AutoPostponeDistillationFloor,
  type AutoPostponeInput,
  type AutoPostponePlan,
  type PostponeReason,
  planAutoPostpone,
} from "@interleave/scheduler";
import { newRowId, nowIso } from "./ids";
import type { Repositories } from "./index";
import { QueueActionService } from "./queue-action-service";
import { type QueueFilters, type QueueItemSummary, QueueQuery } from "./queue-query";
import { SchedulerService } from "./scheduler-service";
import { type TimeCostConfidence, TimeCostQuery } from "./time-cost-query";
import type { TransactionClient } from "./types";

/** How many days a mature card is deferred per auto-postpone cycle (the single-shot valve). */
export const AUTO_POSTPONE_CARD_DEFER_DAYS = 7;

/** One row of the auto-postpone preview — what moves, from→to, and why. */
export interface PostponePreviewRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  /** Numeric priority `0.0`–`1.0` (the UI derives the band). */
  readonly priority: number;
  readonly scheduler: "fsrs" | "attention";
  /** The current due time (ISO-8601), or `null`. */
  readonly fromDueAt: string | null;
  /** The projected due time after the postpone (ISO-8601). */
  readonly toDueAt: string;
  /** Why this item was sacrificed. */
  readonly reason: PostponeReason;
  /** Estimated time removed by this postpone, in minutes. */
  readonly estimatedMinutes: number;
  /** Whether the estimate came from learned review timings or documented defaults. */
  readonly estimateConfidence: TimeCostConfidence;
}

/** The JSON-serializable preview the renderer shows BEFORE committing. */
export interface AutoPostponePreview {
  /** Legacy count overflow (`used - target`, clamped at 0). Minute consumers use `overBudgetMinutes`. */
  readonly overBudget: number;
  /** Legacy count target. Minute consumers use `targetMinutes`. */
  readonly target: number;
  /** Legacy due count. Minute consumers use `usedMinutes`. */
  readonly used: number;
  /** Estimated minutes over today's budget (`usedMinutes - targetMinutes`, clamped at 0). */
  readonly overBudgetMinutes: number;
  /** The daily review budget target, in minutes. */
  readonly targetMinutes: number;
  /** The current due cost, in minutes. */
  readonly usedMinutes: number;
  /** Aggregate estimate confidence for the due universe. */
  readonly confidence: TimeCostConfidence;
  /** The ordered postpone victims (cheapest value first). */
  readonly willPostpone: readonly PostponePreviewRow[];
  /** The due count that remains after applying the plan. */
  readonly remainingAfter: number;
  /** Estimated due minutes remaining after applying the plan. */
  readonly remainingMinutesAfter: number;
  /** Distillation quota protection applied while selecting victims. */
  readonly distillationFloor: AutoPostponeDistillationFloor;
}

/** The result of applying the auto-postpone sweep. */
export interface AutoPostponeApplyResult {
  /** How many items were postponed. */
  readonly postponed: number;
  /** Estimated minutes postponed. */
  readonly postponedMinutes: number;
  /** Estimated due minutes remaining after applying the plan. */
  readonly remainingMinutesAfter: number;
  /** Distillation quota protection applied while selecting victims. */
  readonly distillationFloor: AutoPostponeDistillationFloor;
  /** The shared batch id, so the whole sweep undoes as one (T044). */
  readonly batchId: string;
}

const DAY_MS = 86_400_000;

interface AutoPostponeReadOptions {
  readonly asOf?: IsoTimestamp;
  readonly filters?: QueueFilters;
  readonly mode?: "full" | "review" | "read";
}

export type PostponeOriginKind =
  | "manualAutoPostpone"
  | "standingAutoPostpone"
  | "catchUp"
  | "vacation"
  | "recovery"
  | "manualQueueAction";

export interface PostponeOriginPayload {
  readonly kind: PostponeOriginKind;
  readonly localDay?: string;
  readonly overloadPolicy?: "automatic" | "suggest" | "off";
  readonly restored?: boolean;
}

export interface AutoPostponePlanSnapshot {
  readonly now: IsoTimestamp;
  readonly items: readonly (QueueItemSummary & {
    readonly estimatedMinutes: number;
    readonly estimateConfidence: TimeCostConfidence;
  })[];
  readonly minuteBudget: {
    readonly usedMinutes: number;
    readonly targetMinutes: number;
    readonly confidence: TimeCostConfidence;
  };
  readonly countBudget: { readonly used: number; readonly target: number };
  readonly plan: AutoPostponePlan;
}

interface AutoPostponeApplyOptions extends AutoPostponeReadOptions {
  readonly batchId?: string;
  readonly payloadExtras?: Readonly<Record<string, unknown>>;
}

export class AutoPostponeService {
  private readonly queue: QueueQuery;
  private readonly timeCost: TimeCostQuery;
  private readonly scheduler: SchedulerService;
  private readonly queueActions: QueueActionService;
  private readonly repos: Repositories;

  constructor(
    private readonly db: InterleaveDatabase,
    repos: Repositories,
  ) {
    this.queue = new QueueQuery(repos);
    this.timeCost = new TimeCostQuery(db);
    this.scheduler = new SchedulerService(db);
    this.queueActions = new QueueActionService(db);
    this.repos = repos;
  }

  /**
   * The full merged due set as the planner's input. `QueueItemSummary` is structurally a
   * superset of {@link AutoPostponeInput} after we attach T115's `estimatedMinutes`, so the
   * cast is a widening — no DB access in the planner.
   */
  private dueInputs(
    options: Required<Pick<AutoPostponeReadOptions, "asOf">> &
      Omit<AutoPostponeReadOptions, "asOf">,
  ): {
    items: readonly (QueueItemSummary & {
      readonly estimatedMinutes: number;
      readonly estimateConfidence: TimeCostConfidence;
    })[];
    minuteBudget: {
      readonly usedMinutes: number;
      readonly targetMinutes: number;
      readonly confidence: TimeCostConfidence;
    };
    countBudget: { readonly used: number; readonly target: number };
  } {
    const { asOf, filters, mode } = options;
    const candidates = this.queue.autoPostponeCandidates({
      asOf,
      ...(filters ? { filters } : {}),
      ...(mode ? { mode } : {}),
    });
    const estimate = this.timeCost.estimateQueue(candidates.timeCostSummary, {
      asOf,
      visibleItems: candidates.items.map((item) => ({
        id: item.id,
        type: item.type,
        stage: item.stage,
      })),
    });
    const estimatesById = new Map(estimate.items.map((item) => [item.id, item]));
    const items = candidates.items.map((item) => {
      const itemEstimate = estimatesById.get(item.id);
      return {
        ...item,
        estimatedMinutes: itemEstimate?.estimatedMinutes ?? 0,
        estimateConfidence: itemEstimate?.confidence ?? estimate.confidence,
      };
    });
    return {
      items,
      minuteBudget: {
        usedMinutes: estimate.totalMinutes,
        targetMinutes: this.repos.settings.getAppSettings().dailyBudgetMinutes,
        confidence: estimate.confidence,
      },
      countBudget: {
        used: items.length,
        target: this.repos.settings.getAppSettings().dailyReviewBudget,
      },
    };
  }

  /** Run the pure planner over the current due set + budget. */
  private plan(
    items: readonly (QueueItemSummary & { readonly estimatedMinutes: number })[],
    budgetMinutes: number,
    asOf: IsoTimestamp,
    mode?: "full" | "review" | "read",
  ): AutoPostponePlan {
    return planAutoPostpone(items as readonly AutoPostponeInput[], {
      budget: budgetMinutes,
      asOf,
      ...(mode ? { mode } : {}),
      distillationQuotaPercent: this.repos.settings.getAppSettings().distillationQuotaPercent,
    });
  }

  /**
   * Preview the auto-postpone sweep WITHOUT mutating: read the due set + budget, run the pure
   * planner, and project each victim's new due (the attention scheduler / card defer math),
   * returning a flat, JSON-serializable preview the renderer shows before committing.
   */
  preview({ asOf, filters, mode }: AutoPostponeReadOptions = {}): AutoPostponePreview {
    const snapshot = this.planSnapshot({
      ...(asOf !== undefined ? { asOf } : {}),
      ...(filters !== undefined ? { filters } : {}),
      ...(mode !== undefined ? { mode } : {}),
    });
    const { now, items, minuteBudget, countBudget, plan } = snapshot;
    const byId = new Map(items.map((row) => [row.id, row]));
    const willPostpone: PostponePreviewRow[] = plan.items.map((victim) => {
      const row = byId.get(victim.id);
      const fromDueAt = row?.dueAt ?? null;
      return {
        id: victim.id,
        title: row?.title ?? victim.id,
        type: victim.type,
        priority: row?.priority ?? 0,
        scheduler: victim.scheduler,
        fromDueAt,
        toDueAt: this.projectDueAt(victim, fromDueAt, now),
        reason: victim.reason,
        estimatedMinutes: row?.estimatedMinutes ?? 0,
        estimateConfidence: row?.estimateConfidence ?? minuteBudget.confidence,
      };
    });
    const overBudgetMinutes = Math.max(0, minuteBudget.usedMinutes - minuteBudget.targetMinutes);
    return {
      overBudget: Math.max(0, countBudget.used - countBudget.target),
      target: countBudget.target,
      used: countBudget.used,
      overBudgetMinutes,
      targetMinutes: minuteBudget.targetMinutes,
      usedMinutes: minuteBudget.usedMinutes,
      confidence: minuteBudget.confidence,
      willPostpone,
      remainingAfter: plan.remainingAfter,
      remainingMinutesAfter: plan.remainingMinutesAfter,
      distillationFloor: plan.distillationFloor,
    };
  }

  planSnapshot({ asOf, filters, mode }: AutoPostponeReadOptions = {}): AutoPostponePlanSnapshot {
    const now = asOf ?? nowIso();
    const { items, minuteBudget, countBudget } = this.dueInputs({
      asOf: now,
      ...(filters ? { filters } : {}),
      ...(mode ? { mode } : {}),
    });
    const plan = this.plan(items, minuteBudget.targetMinutes, now, mode);
    return { now, items, minuteBudget, countBudget, plan };
  }

  /**
   * Project (read-only) where a victim would land — exactly what {@link apply} will compute:
   *  - a card defers by {@link AUTO_POSTPONE_CARD_DEFER_DAYS} from `max(fromDueAt, now)`;
   *  - an attention item recedes by the heuristic interval (mirrors `rescheduleForAction`
   *    `postpone`, which grows with the postpone count) — projected here via the same
   *    `nextDueAt` the scheduler uses, so the preview matches the apply.
   */
  private projectDueAt(
    victim: AutoPostponePlan["items"][number],
    fromDueAt: string | null,
    now: IsoTimestamp,
  ): string {
    if (victim.postponeKind === "cardDefer") {
      const base = fromDueAt ? Date.parse(fromDueAt) : Date.parse(now);
      const from = Number.isNaN(base) ? Date.parse(now) : Math.max(base, Date.parse(now));
      return new Date(from + AUTO_POSTPONE_CARD_DEFER_DAYS * DAY_MS).toISOString();
    }
    // Attention: project via the same scheduler decision (no mutation) the apply uses.
    return this.scheduler.previewPostpone(victim.id as ElementId, now);
  }

  /**
   * Apply the auto-postpone sweep TRANSACTIONALLY: mint ONE `batchId`, run the planner over
   * the live due set, and dispatch each victim to its correct scheduler — attention items
   * reschedule via {@link SchedulerService.rescheduleForAction} (`reschedule_element`); cards
   * defer via the shared {@link QueueActionService.cardDeferBy} (FSRS due only, memory state
   * untouched, no review log). All victim writes share one transaction and one `batchId`, so
   * the whole sweep commits atomically and undoes as one (T044). Returns the count + the
   * `batchId`.
   */
  apply({
    asOf,
    filters,
    mode,
    batchId,
    payloadExtras,
  }: AutoPostponeApplyOptions = {}): AutoPostponeApplyResult {
    const snapshot = this.planSnapshot({
      ...(asOf !== undefined ? { asOf } : {}),
      ...(filters !== undefined ? { filters } : {}),
      ...(mode !== undefined ? { mode } : {}),
    });
    return this.db.transaction((tx) =>
      this.applySnapshotWithin(tx, snapshot, {
        batchId: batchId ?? newRowId(),
        payloadExtras: {
          postponeOrigin: { kind: "manualAutoPostpone" } satisfies PostponeOriginPayload,
          ...payloadExtras,
        },
      }),
    );
  }

  applySnapshotWithin(
    tx: TransactionClient,
    snapshot: AutoPostponePlanSnapshot,
    options: {
      readonly batchId: string;
      readonly payloadExtras?: Readonly<Record<string, unknown>>;
    },
  ): AutoPostponeApplyResult {
    const { now, items, plan } = snapshot;
    const byId = new Map(items.map((row) => [row.id, row]));
    let postponed = 0;
    let postponedMinutes = 0;
    for (const victim of plan.items) {
      const id = victim.id as ElementId;
      if (victim.postponeKind === "cardDefer") {
        this.queueActions.cardDeferByWithin(
          tx,
          id,
          now,
          AUTO_POSTPONE_CARD_DEFER_DAYS,
          options.batchId,
          options.payloadExtras ?? {},
        );
      } else {
        this.scheduler.rescheduleForActionWithin(
          tx,
          id,
          "postpone",
          now,
          options.batchId,
          options.payloadExtras ?? {},
        );
      }
      postponed += 1;
      postponedMinutes += byId.get(victim.id)?.estimatedMinutes ?? 0;
    }
    return {
      postponed,
      postponedMinutes,
      remainingMinutesAfter: plan.remainingMinutesAfter,
      distillationFloor: plan.distillationFloor,
      batchId: options.batchId,
    };
  }
}
