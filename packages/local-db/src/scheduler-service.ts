/**
 * SchedulerService (T028) — the APPLY seam for the attention scheduler.
 *
 * The pure `AttentionScheduler` in `@interleave/scheduler` decides WHEN a non-card
 * attention item (`source`/`topic`/`extract`/`task`/`synthesis_note`) should return;
 * this service is the only thing that PERSISTS that decision. It reads the element
 * + the data the scheduler needs off the op log (postpone count, last action) and
 * the settings (the global `defaultTopicIntervalDays` for topics), computes the new
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
import { SETTINGS_KEYS } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  nextDueAt,
  type Schedulable,
  type ScheduleChoice,
  type SchedulerAction,
  scheduleForChoice,
} from "@interleave/scheduler";
import { ElementRepository } from "./element-repository";
import { nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import { SettingsRepository } from "./settings-repository";

/** The result of applying a schedule: the rescheduled element + the chosen interval. */
export interface ScheduleResult {
  readonly element: Element;
  /** The interval (in days) from `now` that produced the new `due_at`. */
  readonly intervalDays: number;
}

export class SchedulerService {
  private readonly elements: ElementRepository;
  private readonly operationLog: OperationLogRepository;
  private readonly settings: SettingsRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.operationLog = new OperationLogRepository(db);
    this.settings = new SettingsRepository(db);
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
   * Count how many times an element has been postponed, by scanning its
   * `reschedule_element` ops for the `postpone` marker. The schema-churn-free
   * postpone counter the attention scheduler reads (mirrors
   * `ExtractService.countPostpones`, lifted here so any attention element can use
   * it — sources/topics/tasks postpone too, not just extracts).
   */
  countPostpones(id: ElementId): number {
    return this.operationLog.listForElement(id).filter((op) => {
      if (op.opType !== "reschedule_element") return false;
      const payload = op.payload;
      return (
        typeof payload === "object" &&
        payload !== null &&
        (payload as { postpone?: unknown }).postpone === true
      );
    }).length;
  }

  /**
   * Build the pure scheduler's {@link Schedulable} descriptor from an element +
   * the data it needs off the op log/settings. `lastSeenAt` derives from the
   * element's `updatedAt` (the last time it was touched); the topic interval
   * setting is supplied so a `topic` consumes it rather than orphaning it.
   */
  private toSchedulable(element: Element, lastAction?: SchedulerAction): Schedulable {
    const defaultTopicIntervalDays =
      element.type === "topic"
        ? (this.settings.get<number>(SETTINGS_KEYS.defaultTopicIntervalDays) ?? null)
        : null;
    return {
      type: element.type,
      stage: element.stage,
      priority: element.priority,
      lastSeenAt: element.updatedAt,
      postponeCount: this.countPostpones(element.id),
      ...(lastAction ? { lastAction } : {}),
      defaultTopicIntervalDays,
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
      return { element: rescheduled, intervalDays: decision.intervalDays };
    });
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
