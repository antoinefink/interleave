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

import type { Element, ElementId, IsoTimestamp } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  nextDueAt,
  type Schedulable,
  type ScheduleChoice,
  type SchedulerAction,
  scheduleForChoice,
} from "@interleave/scheduler";
import { BlockProcessingService } from "./block-processing-service";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import { SettingsRepository } from "./settings-repository";

/** The result of applying a schedule: the rescheduled element + the chosen interval. */
export interface ScheduleResult {
  readonly element: Element;
  /** The interval (in days) from `now` that produced the new `due_at`. */
  readonly intervalDays: number;
  /** Low-yield source signal from block processing, when applicable. */
  readonly retirementSuggestion?: boolean;
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

  /**
   * Build the pure scheduler's {@link Schedulable} descriptor from an element +
   * the data it needs off the op log/settings. `lastSeenAt` derives from the
   * element's `updatedAt` (the last time it was touched) and is supplied as a
   * RESERVED field — `nextDueAt` does not consume it for the MVP (intervals are
   * measured forward from `now`). The topic interval setting is supplied so a
   * `topic` consumes it rather than orphaning it.
   *
   * The topic interval is read through the VALIDATED app-settings surface
   * ({@link SettingsRepository.getAppSettings}) — NOT the raw key — so an unwritten
   * key on a fresh DB resolves to the canonical `defaultTopicIntervalDays` default
   * (7d, `DEFAULT_APP_SETTINGS`) instead of `null` (which would silently drop the
   * topic onto the by-priority band). This mirrors how the queue's budget gauge
   * reads `getAppSettings().dailyReviewBudget`.
   */
  private toSchedulable(element: Element, lastAction?: SchedulerAction): Schedulable {
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
      postponeCount: this.countPostpones(element.id),
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
    const decision = nextDueAt(this.toSchedulable(element, action), now);
    return this.db.transaction((tx) => {
      const opExtras = {
        ...(action === "postpone"
          ? { postpone: true, postponeCount: priorPostpones + 1, action }
          : { action }),
        ...(batchId ? { batchId } : {}),
      };
      const rescheduled = this.elements.rescheduleWithin(
        tx,
        id,
        decision.dueAt,
        "scheduled",
        opExtras,
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
}
