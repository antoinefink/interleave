/**
 * @interleave/scheduler — the attention (topic/extract) scheduler.
 *
 * Two distinct mental models live under this package (see
 * `docs/scheduling-and-priority.md`): FSRS (via `ts-fsrs`, landing in T036/M7)
 * answers "can the user recall this?" for CARDS, while the custom attention
 * scheduler exported below answers "should the user process this again, and when?"
 * for sources/topics/extracts. They must NEVER collapse into one model.
 *
 * T028 fills in the attention half: a set of PURE functions (no DB, no IPC, no
 * React, no `ts-fsrs`) that compute `due_at` from priority/stage/last-seen/
 * last-action/postpone-count and offer explicit tomorrow/next-week/next-month/manual
 * choices. It is also the SINGLE source of truth for the extract interval math that
 * previously lived (duplicated) inside `packages/local-db` — those services now
 * import from here. FSRS lands in a sibling module in M7 and stays behind its own
 * adapter boundary (no `ts-fsrs` types leak through this package).
 */

export const SCHEDULER_PACKAGE = "@interleave/scheduler" as const;

export {
  basePostponeIntervalDays,
  EXTRACT_STAGES,
  type ExtractStage,
  extractStageIntervalDays,
  isExtractStage,
  isSchedulerAction,
  nextDueAt,
  nextExtractStage,
  postponeIntervalForPriority,
  rawExtractIntervalDays,
  SCHEDULER_ACTIONS,
  type Schedulable,
  type ScheduleChoice,
  type ScheduleDecision,
  type SchedulerAction,
  scheduleForChoice,
  scheduleManual,
  scheduleNextMonth,
  scheduleNextWeek,
  scheduleTomorrow,
  sourceIntervalDays,
} from "./attention-scheduler";
export {
  formatInterval,
  type IntervalPreview,
  type ReviewOutcome,
  SCHEDULER_REVIEW_RATINGS,
  SchedulerService,
  type SchedulerServiceOptions,
} from "./card-scheduler";
export { addDays, MS_PER_DAY } from "./date-util";
export { isLeech, LEECH_LAPSE_THRESHOLD } from "./leech";
