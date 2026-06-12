/**
 * SchedulerService (T028) — the APPLY seam for the attention scheduler.
 *
 * The pure `AttentionScheduler` in `@interleave/scheduler` decides WHEN a non-card
 * attention item (`source`/`topic`/`extract`/`task`/`synthesis_note`) should return;
 * this service is the only thing that PERSISTS that decision. It reads the element
 * + the data the scheduler needs off the op log (postpone count, last action) and
 * the validated settings (the global `defaultTopicIntervalDays` for topics, which
 * defaults to 7d on a fresh DB), computes the new
 * `due_at`, and writes it through {@link ElementRepository.reschedule}
 * (`reschedule_element`, status → `scheduled`) in ONE transaction.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): this service NEVER writes a
 * `review_states`/FSRS row. An extract has no FSRS row — its schedule lives entirely
 * on `elements.due_at`. Cards are scheduled by FSRS (T036/M7), never here; this
 * service rejects a `card` so the heuristic can never touch a memory item.
 *
 * The queue actions (T030) and the process loop (T031) call this service; the
 * renderer reaches it only through the typed `window.appApi`, never directly.
 */

import { type Element, type ElementId, type IsoTimestamp, SETTINGS_KEYS } from "@interleave/core";
import { elements as elementsTable, type InterleaveDatabase } from "@interleave/db";
import {
  type AttentionVisitYieldInput,
  DEFAULT_ATTENTION_INTERVAL_MULTIPLIER,
  nextDueAt,
  type Schedulable,
  type ScheduleChoice,
  type SchedulerAction,
  scheduleForChoice,
} from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { BlockProcessingService } from "./block-processing-service";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { rowToElement } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import { SettingsRepository } from "./settings-repository";
import {
  emptyVisitCounters,
  SourceYieldQuery,
  type VisitYieldCounters,
} from "./source-yield-query";
import type { TransactionClient } from "./types";

/** The result of applying a schedule: the rescheduled element + the chosen interval. */
export interface ScheduleResult {
  readonly element: Element;
  /** The interval (in days) from `now` that produced the new `due_at`. */
  readonly intervalDays: number;
  /** Low-yield source signal from block processing, when applicable. */
  readonly retirementSuggestion?: boolean;
}

export const ADAPTIVE_ATTENTION_INTERVALS_SETTING_KEY = SETTINGS_KEYS.adaptiveAttentionIntervals;

interface AdaptiveSchedulePayload {
  readonly version: 1;
  readonly enabled: true;
  readonly settingKey: typeof ADAPTIVE_ATTENTION_INTERVALS_SETTING_KEY;
  readonly reason: NonNullable<ReturnType<typeof nextDueAt>["adaptiveReason"]>;
  readonly priorMultiplier: number;
  readonly newMultiplier: number;
  readonly counters: {
    readonly before: VisitYieldCounters;
    readonly after: VisitYieldCounters;
    readonly delta: VisitYieldCounters;
  };
}

export type AdaptiveVisitBaseline = VisitYieldCounters;

interface AdaptiveVisitContext {
  readonly before: VisitYieldCounters;
  readonly after: VisitYieldCounters;
  readonly delta: VisitYieldCounters;
  readonly visitYield: AttentionVisitYieldInput;
}

export class SchedulerService {
  private readonly elements: ElementRepository;
  private readonly operationLog: OperationLogRepository;
  private readonly settings: SettingsRepository;
  private readonly blockProcessing: BlockProcessingService;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.operationLog = new OperationLogRepository(db);
    this.settings = new SettingsRepository(db);
    this.blockProcessing = new BlockProcessingService(db);
  }

  /**
   * Load a live, schedulable (non-card, non-deleted) element by id, throwing when it
   * is missing, deleted, or a `card` (cards are FSRS-only — never the attention
   * heuristic).
   */
  private requireAttentionElement(id: ElementId): Element {
    const element = this.elements.findById(id);
    if (!element || element.deletedAt) {
      throw new Error(`SchedulerService: element ${id} not found`);
    }
    if (element.type === "card") {
      throw new Error(
        `SchedulerService: element ${id} is a card — cards schedule on FSRS, not the attention scheduler`,
      );
    }
    return element;
  }

  private requireAttentionElementWithin(tx: TransactionClient, id: ElementId): Element {
    const row = tx.select().from(elementsTable).where(eq(elementsTable.id, id)).get();
    const element = row ? rowToElement(row) : null;
    if (!element || element.deletedAt) {
      throw new Error(`SchedulerService: element ${id} not found`);
    }
    if (element.type === "card") {
      throw new Error(
        `SchedulerService: element ${id} is a card — cards schedule on FSRS, not the attention scheduler`,
      );
    }
    return element;
  }

  /**
   * Count how many times an element has been postponed — delegates to the ONE
   * canonical {@link OperationLogRepository.countPostpones} so the marker shape is
   * defined in exactly one place (sources/topics/tasks postpone too, not just
   * extracts). Kept as a public method because the queue actions read it to record
   * the running count in the next postpone's op payload.
   */
  countPostpones(id: ElementId): number {
    return this.operationLog.countPostpones(id);
  }

  adaptiveAttentionIntervalsEnabled(): boolean {
    return this.settings.getAppSettings().adaptiveAttentionIntervals;
  }

  getPersistedAttentionIntervalMultiplier(id: ElementId): number {
    const element = this.elements.findById(id);
    return element ? attentionIntervalMultiplierOf(element) : DEFAULT_ATTENTION_INTERVAL_MULTIPLIER;
  }

  captureAdaptiveVisitBaseline(
    id: ElementId,
    action: SchedulerAction,
  ): AdaptiveVisitBaseline | null {
    if (!this.adaptiveAttentionIntervalsEnabled()) return null;
    const element = this.requireAttentionElement(id);
    if (!isAdaptiveVisit(element, action)) return null;
    return this.visitCountersFor(element);
  }

  private postponeCountForScheduling(element: Element): number {
    const count = this.countPostpones(element.id);
    if (element.type === "task") return count;
    const threshold = this.settings.getAppSettings().chronicPostponeThreshold;
    return count >= threshold ? Math.max(0, threshold - 1) : count;
  }

  /**
   * Build the pure scheduler's {@link Schedulable} descriptor from an element +
   * the data it needs off the op log/settings. `lastSeenAt` derives from the
   * element's pre-action `updatedAt` (the last time it was touched), while the
   * injected action clock still anchors the next due calculation. The topic
   * interval setting is supplied so a `topic` consumes it rather than orphaning it.
   *
   * The topic interval is read through the VALIDATED app-settings surface
   * ({@link SettingsRepository.getAppSettings}) — NOT the raw key — so an unwritten
   * key on a fresh DB resolves to the canonical `defaultTopicIntervalDays` default
   * (7d, `DEFAULT_APP_SETTINGS`) instead of `null` (which would silently drop the
   * topic onto the by-priority band). This mirrors how the queue's budget gauge
   * reads `getAppSettings().dailyReviewBudget`.
   */
  private toSchedulable(
    element: Element,
    lastAction?: SchedulerAction,
    visitYield?: AttentionVisitYieldInput | null,
  ): Schedulable {
    const defaultTopicIntervalDays =
      element.type === "topic" ? this.settings.getAppSettings().defaultTopicIntervalDays : null;
    const blockSummary =
      element.type === "source"
        ? this.blockProcessing.getSourceProcessingSummary(element.id)
        : null;
    return {
      type: element.type,
      stage: element.stage,
      priority: element.priority,
      lastSeenAt: element.updatedAt,
      postponeCount: this.postponeCountForScheduling(element),
      ...(lastAction ? { lastAction } : {}),
      defaultTopicIntervalDays,
      sourceProcessing: blockSummary
        ? {
            unresolvedRatio:
              blockSummary.totalBlocks === 0
                ? 0
                : blockSummary.unresolvedBlocks / blockSummary.totalBlocks,
            terminalRatio: blockSummary.terminalRatio,
            ignoredRatio: blockSummary.ignoredRatio,
            extractedOutputCount: blockSummary.extractedOutputCount,
          }
        : null,
      ...(visitYield && this.adaptiveAttentionIntervalsEnabled()
        ? {
            adaptiveAttentionIntervals: true,
            attentionIntervalMultiplier: attentionIntervalMultiplierOf(element),
            visitYield,
          }
        : {}),
    };
  }

  /**
   * Reschedule an attention element based on the user's last ACTION (extract /
   * rewrite / activate / done / postpone), computing the new `due_at` with the pure
   * scheduler and persisting it via {@link ElementRepository.reschedule}
   * (`reschedule_element`, status → `scheduled`), in ONE transaction. A `postpone`
   * action additionally records the running postpone count in the op payload (the
   * schema-churn-free marker) so the next postpone recedes further.
   *
   * Never writes FSRS state — the rescheduled element is a non-card attention item.
   */
  rescheduleForAction(
    id: ElementId,
    action: SchedulerAction,
    now: IsoTimestamp = nowIso(),
    /**
     * When set, recorded in the `reschedule_element` op payload so a BULK action's
     * N rows (e.g. bulk-postpone) share one batch id and undo as one (T044). The
     * closed op set is unchanged — this only enriches the payload.
     */
    batchId?: string,
  ): ScheduleResult {
    const element = this.requireAttentionElement(id);
    const priorPostpones = this.countPostpones(id);
    const adaptive = this.adaptiveVisitContext(element, action);
    const decision = nextDueAt(this.toSchedulable(element, action, adaptive?.visitYield), now);
    return this.db.transaction((tx) => {
      const opExtras = {
        ...(action === "postpone"
          ? { postpone: true, postponeCount: priorPostpones + 1, action, scheduledAt: now }
          : { action, scheduledAt: now }),
        ...(adaptive &&
        decision.adaptiveReason &&
        decision.attentionIntervalMultiplier !== undefined
          ? { attentionAdaptive: adaptivePayload(adaptive, decision.adaptiveReason) }
          : {}),
        ...(decision.scheduleReason ? { scheduleReason: decision.scheduleReason } : {}),
        ...(batchId ? { batchId } : {}),
      };
      const rescheduled = this.elements.rescheduleWithin(
        tx,
        id,
        decision.dueAt,
        "scheduled",
        opExtras,
        {
          updatedAt: now,
          ...(decision.attentionIntervalMultiplier !== undefined
            ? { attentionIntervalMultiplier: decision.attentionIntervalMultiplier }
            : {}),
        },
      );
      return {
        element: rescheduled,
        intervalDays: decision.intervalDays,
        ...(decision.retirementSuggestion
          ? { retirementSuggestion: decision.retirementSuggestion }
          : {}),
      };
    });
  }

  /**
   * Transaction-composable processed-visit reschedule for services that already
   * own a mutation transaction (currently extract stage changes). With the T112
   * flag off, callers should keep their legacy path; this method exists for the
   * adaptive-on path so diagnostics and multiplier state are written through one
   * scheduler seam.
   */
  rescheduleProcessedVisitWithin(
    tx: TransactionClient,
    id: ElementId,
    action: SchedulerAction,
    now: IsoTimestamp = nowIso(),
    baseline?: AdaptiveVisitBaseline | null,
  ): ScheduleResult {
    const element = this.requireAttentionElementWithin(tx, id);
    const adaptive = this.adaptiveVisitContext(element, action, baseline);
    const decision = nextDueAt(this.toSchedulable(element, action, adaptive?.visitYield), now);
    const rescheduled = this.elements.rescheduleWithin(
      tx,
      id,
      decision.dueAt,
      "scheduled",
      {
        action,
        scheduledAt: now,
        ...(adaptive &&
        decision.adaptiveReason &&
        decision.attentionIntervalMultiplier !== undefined
          ? { attentionAdaptive: adaptivePayload(adaptive, decision.adaptiveReason) }
          : {}),
        ...(decision.scheduleReason ? { scheduleReason: decision.scheduleReason } : {}),
      },
      {
        updatedAt: now,
        ...(decision.attentionIntervalMultiplier !== undefined
          ? { attentionIntervalMultiplier: decision.attentionIntervalMultiplier }
          : {}),
      },
    );
    return {
      element: rescheduled,
      intervalDays: decision.intervalDays,
      ...(decision.retirementSuggestion
        ? { retirementSuggestion: decision.retirementSuggestion }
        : {}),
    };
  }

  /**
   * Start a source in active reading while giving it a default return date.
   *
   * This is the inbox `Read now` seam: the source is no longer an untriaged inbox
   * capture, but it remains lifecycle `active` because the user just pulled it into
   * active reading. The attention scheduler still owns the separate `due_at`
   * return path. Read points remain independent and are written by the reader.
   */
  activateSourceWithReturn(id: ElementId, now: IsoTimestamp = nowIso()): ScheduleResult {
    const element = this.requireAttentionElement(id);
    return this.db.transaction((tx) => this.activateSourceWithReturnElement(tx, element, now));
  }

  /**
   * Transaction-composable form for inbox triage. The caller has already loaded and
   * validated the live source row inside its own mutation transaction.
   */
  activateSourceWithReturnWithin(
    tx: TransactionClient,
    id: ElementId,
    now: IsoTimestamp = nowIso(),
  ): ScheduleResult {
    const element = this.requireAttentionElementWithin(tx, id);
    return this.activateSourceWithReturnElement(tx, element, now);
  }

  /**
   * Queue an inbox source for immediate attention without opening it for active reading.
   *
   * This is the inbox `Queue soon` seam: the source leaves the capture inbox and becomes
   * normal due queue work. It writes only the attention schedule (`elements.due_at`) and
   * lifecycle status (`scheduled`); it never creates FSRS state.
   */
  queueSourceSoonWithin(
    tx: TransactionClient,
    id: ElementId,
    now: IsoTimestamp = nowIso(),
  ): ScheduleResult {
    const element = this.requireAttentionElementWithin(tx, id);
    if (element.type !== "source") {
      throw new Error(
        `SchedulerService: element ${element.id} is a ${element.type} — only sources can be queued from inbox`,
      );
    }
    const rescheduled = this.elements.rescheduleWithin(
      tx,
      element.id,
      now,
      "scheduled",
      {
        action: "queueSoon",
        queueSoon: true,
      },
      { updatedAt: now },
    );
    return { element: rescheduled, intervalDays: 0 };
  }

  private activateSourceWithReturnElement(
    tx: TransactionClient | InterleaveDatabase,
    element: Element,
    now: IsoTimestamp,
  ): ScheduleResult {
    if (element.type !== "source") {
      throw new Error(
        `SchedulerService: element ${element.id} is a ${element.type} — only sources can be activated from inbox`,
      );
    }
    const decision = nextDueAt(this.toSchedulable(element, "activate"), now);
    const rescheduled = this.elements.rescheduleWithin(
      tx,
      element.id,
      decision.dueAt,
      "active",
      {
        action: "activate",
        scheduledAt: now,
        ...(decision.scheduleReason ? { scheduleReason: decision.scheduleReason } : {}),
      },
      {
        updatedAt: now,
      },
    );
    return {
      element: rescheduled,
      intervalDays: decision.intervalDays,
      ...(decision.retirementSuggestion
        ? { retirementSuggestion: decision.retirementSuggestion }
        : {}),
    };
  }

  /**
   * READ-ONLY projection of where a `postpone` would land an attention item — the SAME
   * `nextDueAt` decision {@link rescheduleForAction}(id,"postpone",…) computes, but WITHOUT
   * mutating or appending an op. T077's auto-postpone preview uses this so the previewed
   * `toDueAt` matches exactly what the apply will persist (the postpone interval grows with
   * the running postpone count, so the projection must run the same heuristic). Rejects a
   * `card` (cards never use the attention heuristic).
   */
  previewPostpone(id: ElementId, now: IsoTimestamp = nowIso()): IsoTimestamp {
    const element = this.requireAttentionElement(id);
    return nextDueAt(this.toSchedulable(element, "postpone"), now).dueAt;
  }

  /**
   * Schedule an attention element for an EXPLICIT choice — tomorrow / next week /
   * next month / a manual date — computing the date with the pure scheduler and
   * persisting it via {@link ElementRepository.reschedule} (`reschedule_element`,
   * status → `scheduled`), in ONE transaction. Never writes FSRS state.
   *
   * `batchId` (when set) is recorded in the `reschedule_element` op payload — exactly
   * like {@link rescheduleForAction} — so a future BULK explicit-schedule action's N
   * rows share one batch id and undo as one (T044). The closed op set is unchanged;
   * this only enriches the payload.
   */
  scheduleAt(
    id: ElementId,
    choice: ScheduleChoice,
    now: IsoTimestamp = nowIso(),
    batchId?: string,
  ): ScheduleResult {
    this.requireAttentionElement(id);
    const decision = scheduleForChoice(choice, now);
    return this.db.transaction((tx) => {
      const rescheduled = this.elements.rescheduleWithin(tx, id, decision.dueAt, "scheduled", {
        choice: typeof choice === "string" ? choice : "manual",
        ...(batchId ? { batchId } : {}),
      });
      return { element: rescheduled, intervalDays: decision.intervalDays };
    });
  }

  private adaptiveVisitContext(
    element: Element,
    action: SchedulerAction,
    baseline?: AdaptiveVisitBaseline | null,
  ): AdaptiveVisitContext | null {
    if (!this.adaptiveAttentionIntervalsEnabled()) return null;
    if (!isAdaptiveVisit(element, action)) return null;

    const after = this.visitCountersFor(element);
    const previousPayload = this.latestAdaptivePayload(element.id);
    const before = baseline ?? previousPayload?.counters.after ?? after;
    const delta = deltaCounters(before, after);
    const summary =
      element.type === "source"
        ? this.blockProcessing.getSourceProcessingSummary(element.id)
        : null;

    return {
      before,
      after,
      delta,
      visitYield: {
        childExtractsCreated:
          delta.extractsCreated + (element.type === "source" ? delta.extractedOutputCount : 0),
        atomicStatementsCreated: element.type === "extract" ? delta.extractedOutputCount : 0,
        cardsCreated: delta.cardsCreated,
        synthesisOutputsCreated: delta.synthesisNotesCreated,
        honorableExtractFates: delta.productiveExtracts,
        ...(summary
          ? {
              unresolvedRatio:
                summary.totalBlocks === 0 ? 0 : summary.unresolvedBlocks / summary.totalBlocks,
              terminalRatio: summary.terminalRatio,
              ignoredRatio: summary.ignoredRatio,
            }
          : {}),
      },
    };
  }

  private visitCountersFor(element: Element): VisitYieldCounters {
    const query = new SourceYieldQuery(this.db);
    if (element.type === "source") {
      return query.getSourceVisitCounters(element.id);
    }
    if (element.type === "extract") {
      return query.getExtractVisitCounters(element.id);
    }
    return emptyVisitCounters();
  }

  private latestAdaptivePayload(id: ElementId): AdaptiveSchedulePayload | null {
    const adaptive = this.operationLog.latestAttentionAdaptivePayload(id);
    return isAdaptivePayload(adaptive) ? adaptive : null;
  }
}

function isAdaptiveVisit(element: Element, action: SchedulerAction): boolean {
  if (element.type !== "source" && element.type !== "extract") return false;
  return action === "extract" || action === "rewrite";
}

function isAdaptivePayload(value: unknown): value is AdaptiveSchedulePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  const counters = payload.counters;
  return (
    payload.version === 1 &&
    payload.enabled === true &&
    typeof payload.priorMultiplier === "number" &&
    typeof payload.newMultiplier === "number" &&
    typeof payload.reason === "object" &&
    payload.reason !== null &&
    typeof counters === "object" &&
    counters !== null &&
    isVisitYieldCounters((counters as Record<string, unknown>).before) &&
    isVisitYieldCounters((counters as Record<string, unknown>).after) &&
    isVisitYieldCounters((counters as Record<string, unknown>).delta)
  );
}

function isVisitYieldCounters(value: unknown): value is VisitYieldCounters {
  if (!value || typeof value !== "object") return false;
  const counters = value as Record<string, unknown>;
  return [
    counters.extractsCreated,
    counters.productiveExtracts,
    counters.cardsCreated,
    counters.synthesisNotesCreated,
    counters.extractedOutputCount,
    counters.unresolvedBlocks,
    counters.totalOutputCount,
  ].every((counter) => typeof counter === "number" && Number.isFinite(counter) && counter >= 0);
}

function adaptivePayload(
  context: AdaptiveVisitContext,
  reason: NonNullable<ReturnType<typeof nextDueAt>["adaptiveReason"]>,
): AdaptiveSchedulePayload {
  return {
    version: 1,
    enabled: true,
    settingKey: ADAPTIVE_ATTENTION_INTERVALS_SETTING_KEY,
    reason,
    priorMultiplier: reason.priorMultiplier,
    newMultiplier: reason.newMultiplier,
    counters: {
      before: context.before,
      after: context.after,
      delta: context.delta,
    },
  };
}

function attentionIntervalMultiplierOf(element: Element): number {
  const value = element.attentionIntervalMultiplier;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_ATTENTION_INTERVAL_MULTIPLIER;
}

function deltaCounters(before: VisitYieldCounters, after: VisitYieldCounters): VisitYieldCounters {
  return {
    extractsCreated: nonnegativeDelta(before.extractsCreated, after.extractsCreated),
    productiveExtracts: nonnegativeDelta(before.productiveExtracts, after.productiveExtracts),
    cardsCreated: nonnegativeDelta(before.cardsCreated, after.cardsCreated),
    synthesisNotesCreated: nonnegativeDelta(
      before.synthesisNotesCreated,
      after.synthesisNotesCreated,
    ),
    extractedOutputCount: nonnegativeDelta(before.extractedOutputCount, after.extractedOutputCount),
    unresolvedBlocks: nonnegativeDelta(before.unresolvedBlocks, after.unresolvedBlocks),
    totalOutputCount: nonnegativeDelta(before.totalOutputCount, after.totalOutputCount),
  };
}

function nonnegativeDelta(before: number, after: number): number {
  return Math.max(0, after - before);
}
