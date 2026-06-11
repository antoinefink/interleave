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
 * adapter boundary: the `ts-fsrs` `State`/`Rating`/`Card` runtime vocabulary is
 * mapped to our own and never leaks. The ONE deliberate exception is the optional,
 * compile-time-only `CardSchedulerServiceOptions.params: Partial<FSRSParameters>` — a
 * documented escape hatch for the T080 FSRS-parameter optimization. It is a typed
 * seam, not a runtime enum leak; callers that do not optimize parameters never touch
 * a `ts-fsrs` type.
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
  type SourceProcessingSignals,
  type SourceRetirementSuggestion,
  type SourceRetirementSuggestionInput,
  type SourceRetirementSuggestionKind,
  scheduleForChoice,
  scheduleManual,
  scheduleNextMonth,
  scheduleNextWeek,
  scheduleTomorrow,
  sourceIntervalDays,
  sourceRetirementSignalHash,
  sourceRetirementSuggestion,
} from "./attention-scheduler";
export {
  type AutoPostponeInput,
  type AutoPostponeOptions,
  type AutoPostponePlan,
  type AutoPostponeSignals,
  CARD_MATURE_RETRIEVABILITY,
  CARD_MATURE_STABILITY_DAYS,
  isCardFragile,
  isCardMature,
  type PostponeKind,
  type PostponePlanItem,
  type PostponeReason,
  planAutoPostpone,
} from "./auto-postpone";
export {
  CardSchedulerService,
  type CardSchedulerServiceOptions,
  formatInterval,
  type IntervalPreview,
  type ReviewOutcome,
  SCHEDULER_REVIEW_RATINGS,
} from "./card-scheduler";
export { addDays, MS_PER_DAY } from "./date-util";
export {
  defaultParams,
  type FitScore,
  FSRS_PARAM_COUNT,
  type FsrsOptimizer,
  hasSufficientData,
  historyCalibrationOptimizer,
  MIN_CARDS_FOR_FIT,
  MIN_REVIEWS_FOR_FIT,
  nextIntervalDaysForParams,
  nextIntervalDaysForRetention,
  type OptimizationSuggestion,
  type OptimizationSuggestionParts,
  type OptimizerHistory,
  type OptimizerOptions,
  type OptimizerReview,
  optimizationSuggestionFromParts,
  sanitizeParams,
  scoreParameters,
  suggestParameters,
} from "./fsrs-optimizer";
export { isLeech, LEECH_LAPSE_THRESHOLD } from "./leech";
export {
  DECLUMP_MAX_PUSHDOWN,
  DEFAULT_QUEUE_SCORE_WEIGHTS,
  DUE_URGENCY_SATURATION_DAYS,
  NEUTRAL_RETRIEVABILITY,
  type QueueScoreContext,
  type QueueScoreInput,
  type QueueScoreOptions,
  type QueueScoreWeights,
  queueItemScore,
  type SessionMode,
  scoreQueueItems,
} from "./queue-score";
export {
  type CatchUpOptions,
  type CatchUpPlan,
  type LoadCurvePoint,
  type PostponeCostPreview,
  planCatchUp,
  planVacation,
  type RecoveryInput,
  type RecoveryPlanItem,
  type RecoveryScheduler,
  type SlipRow,
  type VacationOptions,
  type VacationPlan,
  type VacationSuspendItem,
} from "./recovery-modes";
export {
  type RetentionResolution,
  type RetentionResolveInput,
  type RetentionSource,
  type RetentionTargets,
  resolveDesiredRetention,
  resolveDesiredRetentionDetailed,
} from "./retention";
export {
  type ExtractStagnationSignals,
  isStagnant,
  STAGNATION_POSTPONE_THRESHOLD,
  STAGNATION_STALE_DAYS,
  type StagnationOptions,
  type StagnationReason,
  type StagnationSuggestion,
  type StagnationVerdict,
} from "./stagnation";
export {
  DEFAULT_WORKLOAD_WINDOW_DAYS,
  projectWorkload,
  type WorkloadAddCardsChange,
  type WorkloadApplyParamsChange,
  type WorkloadAttentionItem,
  type WorkloadCard,
  type WorkloadChange,
  type WorkloadDay,
  type WorkloadOptions,
  type WorkloadPostponeChange,
  type WorkloadProjection,
  type WorkloadRetentionChange,
  type WorkloadSnapshot,
  workloadBand,
} from "./workload";
