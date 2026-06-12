/**
 * AttentionScheduler (T028) — the topic/extract ("attention") scheduler.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing, see `docs/scheduling-and-priority.md`):
 * there are two schedulers answering two different questions and they must never
 * collapse into one model.
 *
 *  - **FSRS** (`ts-fsrs`, T036/M7) schedules CARDS ONLY and answers "can the user
 *    recall this?" — it persists on `review_states`.
 *  - **THIS scheduler** schedules NON-CARD attention items — `source`, `topic`,
 *    `extract`, `task`, `synthesis_note` — and answers "should the user process
 *    this again, and when?". It reads/writes ONLY `elements.due_at`. It NEVER
 *    touches `review_states`/FSRS: an extract has no FSRS row.
 *
 * Everything here is a PURE function: no DB, no IPC, no React, no `ts-fsrs`. The
 * `now` clock is always passed in (never `Date.now()` deep inside) so the Vitest
 * suite is deterministic. The 10–20% queue randomness is a QUEUE-SORT concern
 * (T029), not a scheduler concern — `nextDueAt` stays deterministic.
 *
 * The starter interval tables come verbatim from `scheduling-and-priority.md`:
 *
 *   By priority (sources/topics):  A 1–7d · B 7–30d · C 30–60d · D 90d+
 *   By stage (extracts):           raw_extract +1..7d · clean_extract +3..14d
 *                                  atomic_statement convert-now/+1d
 *   Rescheduling by action:        deleted=never · low-value +30..180d
 *                                  medium +7..30d · high +1..7d
 *
 * Higher priority returns SOONER within each band (so high-value material is not
 * buried), and repeated postpones push the interval FURTHER OUT (the stagnation
 * concern). The interval helpers are shared back into `packages/local-db` so the
 * services no longer carry their own copies — one source of truth.
 */

import type { DistillationStage, ElementType, IsoTimestamp, Priority } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import { addDays, MS_PER_DAY } from "./date-util";

/**
 * The ordered extract distillation chain the attention scheduler walks. A strict
 * subset of {@link DistillationStage} — extracts only ever sit in these three
 * stages; `card_draft`+ belong to cards (M6), `raw_source`/`rough_topic` to
 * sources/topics. This is the single source of truth (re-exported from
 * `packages/local-db`'s `extract-service.ts`).
 */
export const EXTRACT_STAGES = [
  "raw_extract",
  "clean_extract",
  "atomic_statement",
] as const satisfies readonly DistillationStage[];

/** An extract's distillation stage (one of the three steps of the chain above). */
export type ExtractStage = (typeof EXTRACT_STAGES)[number];

/** Type guard: is `value` one of the three extract distillation stages? */
export function isExtractStage(value: unknown): value is ExtractStage {
  return typeof value === "string" && (EXTRACT_STAGES as readonly string[]).includes(value);
}

/** The next stage in the chain, or `null` when already at `atomic_statement`. */
export function nextExtractStage(stage: ExtractStage): ExtractStage | null {
  const idx = EXTRACT_STAGES.indexOf(stage);
  if (idx < 0 || idx >= EXTRACT_STAGES.length - 1) return null;
  return EXTRACT_STAGES[idx + 1] as ExtractStage;
}

/**
 * The user's LAST action on an attention item — the axis the rescheduling-by-action
 * table keys off. Distinct from a card review grade (FSRS): these are processing
 * actions on sources/topics/extracts.
 *
 *  - `extract`  — the user lifted a fragment out (productive); come back fairly soon
 *                 to keep mining it.
 *  - `rewrite`  — the user cleaned/edited the body (productive); medium return.
 *  - `activate` — the user pulled it into active rotation (e.g. inbox → active);
 *                 schedule its first heuristic due date.
 *  - `done`     — the user finished with it for now; it leaves the active rotation
 *                 (the service sets status, not this scheduler) but if it is
 *                 rescheduled it recedes far out.
 *  - `postpone` — the user deferred it without progress; push FURTHER out, growing
 *                 with the postpone count (stagnation).
 */
export const SCHEDULER_ACTIONS = ["extract", "rewrite", "activate", "done", "postpone"] as const;
export type SchedulerAction = (typeof SCHEDULER_ACTIONS)[number];

/** Type guard: is `value` one of the canonical scheduler actions? */
export function isSchedulerAction(value: unknown): value is SchedulerAction {
  return typeof value === "string" && (SCHEDULER_ACTIONS as readonly string[]).includes(value);
}

/**
 * The "schedulable descriptor" — the minimal, DB-free snapshot of an attention item
 * the scheduler needs. The SERVICE (`packages/local-db` `SchedulerService`) reads
 * these off the element row + its op log; the scheduler stays pure.
 */
export interface Schedulable {
  /** The element type — branches by-stage (extract) vs by-priority (source/topic). */
  readonly type: ElementType;
  /** Distillation stage; only meaningful for extracts (drives the by-stage band). */
  readonly stage?: DistillationStage | null;
  /** Numeric priority `0.0`–`1.0` (the by-priority band + within-band ordering). */
  readonly priority: Priority;
  /** When the item was last seen/processed (derives from `updatedAt`/last reschedule). */
  readonly lastSeenAt?: IsoTimestamp | null;
  /** How many times the item has been postponed (read from `reschedule_element` ops). */
  readonly postponeCount?: number;
  /** The user's last action on the item; drives the rescheduling-by-action table. */
  readonly lastAction?: SchedulerAction | null;
  /**
   * The global `defaultTopicIntervalDays` setting (T011), supplied by the SERVICE
   * for `topic` items so the setting is CONSUMED, not orphaned. When present and the
   * item is a `topic`, it overrides the by-priority band for the heuristic interval.
   * Ignored for non-topic types (extracts use by-stage; sources use by-priority).
   */
  readonly defaultTopicIntervalDays?: number | null;
  /**
   * Source-only block-processing signals. They are ignored for topics/extracts/cards.
   * These counters come from durable source-block outcomes, not visual marks.
   */
  readonly sourceProcessing?: SourceProcessingSignals | null;
  /**
   * Feature flag for T112 adaptive attention intervals. Default/absent is OFF so
   * the legacy T111 scheduler path remains byte-identical until explainability ships.
   */
  readonly adaptiveAttentionIntervals?: boolean | null;
  /**
   * Persisted per-element multiplier. Existing rows/default callers omit it and
   * use {@link DEFAULT_ATTENTION_INTERVAL_MULTIPLIER}.
   */
  readonly attentionIntervalMultiplier?: number | null;
  /**
   * Visit-scoped value output facts. The service supplies these only for completed
   * source/extract processing visits; broad lifetime yield must not be folded into
   * one adaptive step.
   */
  readonly visitYield?: AttentionVisitYieldInput | null;
}

/** The result of a scheduling decision: the new due time + the interval chosen. */
export interface ScheduleDecision {
  /** The computed next due time, ISO-8601. */
  readonly dueAt: IsoTimestamp;
  /** The interval (in days) from `now` that produced `dueAt` — for tests/telemetry. */
  readonly intervalDays: number;
  /** Structured reason for the interval chosen, consumed by T113 read models. */
  readonly scheduleReason?: AttentionScheduleReason;
  /** Low-yield source signal: mostly processed/ignored with no extracted output. */
  readonly retirementSuggestion?: boolean;
  /** The persisted multiplier to write after an adaptive decision. */
  readonly attentionIntervalMultiplier?: number;
  /** Closed diagnostic payload for T113 explainability and drift checks. */
  readonly adaptiveReason?: AdaptiveIntervalReason;
}

export interface SourceProcessingSignals {
  readonly unresolvedRatio: number;
  readonly terminalRatio: number;
  readonly ignoredRatio: number;
  readonly extractedOutputCount: number;
}

/** Visit-scoped yield facts for one source/extract processing action. */
export interface AttentionVisitYieldInput {
  readonly childExtractsCreated?: number;
  readonly atomicStatementsCreated?: number;
  readonly cardsCreated?: number;
  readonly synthesisOutputsCreated?: number;
  readonly honorableExtractFates?: number;
  readonly unresolvedRatio?: number;
  readonly terminalRatio?: number;
  readonly ignoredRatio?: number;
}

export type AdaptiveIntervalReasonKind =
  | "yield_shortened"
  | "yield_lengthened"
  | "yield_held"
  | "yield_input_malformed";

export interface AdaptiveIntervalMultiplierInput {
  readonly priority: Priority;
  readonly currentMultiplier?: number | null;
  readonly visitYield: AttentionVisitYieldInput;
}

export interface AdaptiveIntervalMultiplierDecision {
  readonly reasonKind: AdaptiveIntervalReasonKind;
  readonly priorMultiplier: number;
  readonly clampedPriorMultiplier: number;
  readonly newMultiplier: number;
  readonly productiveOutputCount: number;
  readonly unresolvedRatio?: number;
  readonly terminalRatio?: number;
  readonly ignoredRatio?: number;
}

export interface AdaptiveIntervalReason extends AdaptiveIntervalMultiplierDecision {
  readonly baseIntervalDays: number;
  readonly intervalAfterMultiplierDays: number;
  readonly finalIntervalDays: number;
}

export const ATTENTION_SCHEDULE_REASON_KINDS = [
  "yield_shortened",
  "yield_lengthened",
  "recency_damped",
  "postpone_recession",
  "source_unresolved_shortened",
  "source_exhausted_lengthened",
  "descendant_lapses",
  "band_base",
] as const;

export type AttentionScheduleReasonKind = (typeof ATTENTION_SCHEDULE_REASON_KINDS)[number];

interface AttentionScheduleReasonBase {
  readonly kind: AttentionScheduleReasonKind;
  readonly baseIntervalDays: number;
  readonly finalIntervalDays: number;
}

export type AttentionScheduleReason =
  | (AttentionScheduleReasonBase & {
      readonly kind: "yield_shortened" | "yield_lengthened";
      readonly intervalAfterMultiplierDays: number;
      readonly priorMultiplier: number;
      readonly clampedPriorMultiplier: number;
      readonly newMultiplier: number;
      readonly productiveOutputCount: number;
      readonly unresolvedRatio?: number;
      readonly terminalRatio?: number;
      readonly ignoredRatio?: number;
    })
  | (AttentionScheduleReasonBase & {
      readonly kind: "recency_damped";
      readonly daysSinceLastSeen: number;
      readonly recencyCreditDays: number;
    })
  | (AttentionScheduleReasonBase & {
      readonly kind: "postpone_recession";
      readonly intervalAfterPostponeDays: number;
      readonly postponeCount: number;
    })
  | (AttentionScheduleReasonBase & {
      readonly kind: "source_unresolved_shortened";
      readonly intervalAfterSourceProcessingDays: number;
      readonly unresolvedRatio: number;
      readonly terminalRatio: number;
      readonly ignoredRatio: number;
      readonly extractedOutputCount: number;
    })
  | (AttentionScheduleReasonBase & {
      readonly kind: "source_exhausted_lengthened";
      readonly intervalAfterSourceProcessingDays: number;
      readonly unresolvedRatio: number;
      readonly terminalRatio: number;
      readonly ignoredRatio: number;
      readonly extractedOutputCount: number;
    })
  | (AttentionScheduleReasonBase & {
      readonly kind: "descendant_lapses";
      readonly descendantLapseCount: number;
    })
  | (AttentionScheduleReasonBase & {
      readonly kind: "band_base";
    });

type PendingAttentionScheduleReason = AttentionScheduleReason extends infer Reason
  ? Reason extends AttentionScheduleReason
    ? Omit<Reason, "finalIntervalDays">
    : never
  : never;

function completeScheduleReason(
  reason: PendingAttentionScheduleReason,
  finalIntervalDays: number,
): AttentionScheduleReason {
  switch (reason.kind) {
    case "yield_shortened":
    case "yield_lengthened":
      return { ...reason, finalIntervalDays };
    case "recency_damped":
      return { ...reason, finalIntervalDays };
    case "postpone_recession":
      return { ...reason, finalIntervalDays };
    case "source_unresolved_shortened":
      return { ...reason, finalIntervalDays };
    case "source_exhausted_lengthened":
      return { ...reason, finalIntervalDays };
    case "descendant_lapses":
      return { ...reason, finalIntervalDays };
    case "band_base":
      return { ...reason, finalIntervalDays };
  }
}

export function attentionScheduleReasonFromAdaptiveReason(
  reason: AdaptiveIntervalReason,
): AttentionScheduleReason | null {
  switch (reason.reasonKind) {
    case "yield_shortened":
    case "yield_lengthened":
      return {
        kind: reason.reasonKind,
        baseIntervalDays: reason.baseIntervalDays,
        intervalAfterMultiplierDays: reason.intervalAfterMultiplierDays,
        finalIntervalDays: reason.finalIntervalDays,
        priorMultiplier: reason.priorMultiplier,
        clampedPriorMultiplier: reason.clampedPriorMultiplier,
        newMultiplier: reason.newMultiplier,
        productiveOutputCount: reason.productiveOutputCount,
        ...(reason.unresolvedRatio !== undefined
          ? { unresolvedRatio: reason.unresolvedRatio }
          : {}),
        ...(reason.terminalRatio !== undefined ? { terminalRatio: reason.terminalRatio } : {}),
        ...(reason.ignoredRatio !== undefined ? { ignoredRatio: reason.ignoredRatio } : {}),
      };
    case "yield_held":
      return {
        kind: "band_base",
        baseIntervalDays: reason.baseIntervalDays,
        finalIntervalDays: reason.finalIntervalDays,
      };
    case "yield_input_malformed":
      return null;
  }
}

interface IntervalAdjustment {
  readonly intervalDays: number;
  readonly retirementSuggestion?: boolean;
  readonly attentionIntervalMultiplier?: number;
  readonly adaptiveReason?: Omit<AdaptiveIntervalReason, "finalIntervalDays">;
  readonly scheduleReason?: PendingAttentionScheduleReason;
}

export interface SourceRetirementSuggestionInput extends SourceProcessingSignals {
  readonly sourceId?: string | null;
  readonly totalBlocks: number;
  readonly terminalBlocks: number;
  readonly ignoredBlocks: number;
  readonly unresolvedBlocks: number;
}

export type SourceRetirementSuggestionKind = "abandon";

export interface SourceRetirementSuggestion {
  readonly kind: SourceRetirementSuggestionKind;
  readonly reason: string;
  readonly reasonLabel: string;
  readonly signalHash: string;
  readonly terminalRatio: number;
  readonly ignoredRatio: number;
  readonly totalBlocks: number;
  readonly terminalBlocks: number;
  readonly ignoredBlocks: number;
  readonly unresolvedBlocks: number;
  readonly extractedOutputCount: number;
}

const RETIREMENT_SIGNAL_VERSION = "v1";
const RETIREMENT_THRESHOLD_SIGNATURE = "thresholds:terminal>=0.9,ignored>=0.5,output=0";

export const MIN_ATTENTION_INTERVAL_MULTIPLIER = 0.5;
export const MAX_ATTENTION_INTERVAL_MULTIPLIER = 4.0;
export const DEFAULT_ATTENTION_INTERVAL_MULTIPLIER = 1.0;

const HIGH_PRIORITY_PRODUCTIVE_STEP = -0.1;
const LOW_PRIORITY_PRODUCTIVE_STEP = -0.15;
const HIGH_PRIORITY_BARREN_STEP = 0.05;
const LOW_PRIORITY_BARREN_STEP = 0.15;
const HIGH_PRIORITY_UNRESOLVED_STEP = -0.05;
const UNRESOLVED_HIGH_VALUE_THRESHOLD = 0.25;
const LOW_UNRESOLVED_BARREN_THRESHOLD = 0.1;

function clampAttentionIntervalMultiplier(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_ATTENTION_INTERVAL_MULTIPLIER;
  return Math.min(
    MAX_ATTENTION_INTERVAL_MULTIPLIER,
    Math.max(MIN_ATTENTION_INTERVAL_MULTIPLIER, value),
  );
}

function finiteNonNegative(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function finiteRatio(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    return undefined;
  }
  return value;
}

function isHighPriority(priority: Priority): boolean {
  const label = priorityToLabel(priority);
  return label === "A" || label === "B";
}

function applyMultiplierStep(multiplier: number, step: number): number {
  return Number(clampAttentionIntervalMultiplier(multiplier + step).toFixed(2));
}

/**
 * Compute exactly one bounded adaptive-multiplier step for a completed
 * source/extract visit. Productive visits shorten, barren visits lengthen, and
 * unresolved high-priority source work can only shorten by a smaller step.
 */
export function adaptiveAttentionIntervalMultiplier(
  input: AdaptiveIntervalMultiplierInput,
): AdaptiveIntervalMultiplierDecision {
  const priorMultiplier =
    typeof input.currentMultiplier === "number"
      ? input.currentMultiplier
      : DEFAULT_ATTENTION_INTERVAL_MULTIPLIER;
  const clampedPriorMultiplier = clampAttentionIntervalMultiplier(priorMultiplier);
  const highPriority = isHighPriority(input.priority);
  const productiveOutputCount =
    (finiteNonNegative(input.visitYield.childExtractsCreated) ?? 0) +
    (finiteNonNegative(input.visitYield.atomicStatementsCreated) ?? 0) +
    (finiteNonNegative(input.visitYield.cardsCreated) ?? 0) +
    (finiteNonNegative(input.visitYield.synthesisOutputsCreated) ?? 0) +
    (finiteNonNegative(input.visitYield.honorableExtractFates) ?? 0);
  const unresolvedRatio = finiteRatio(input.visitYield.unresolvedRatio);
  const terminalRatio = finiteRatio(input.visitYield.terminalRatio);
  const ignoredRatio = finiteRatio(input.visitYield.ignoredRatio);
  const malformed =
    [
      input.visitYield.childExtractsCreated,
      input.visitYield.atomicStatementsCreated,
      input.visitYield.cardsCreated,
      input.visitYield.synthesisOutputsCreated,
      input.visitYield.honorableExtractFates,
    ].some((value) => value !== undefined && finiteNonNegative(value) === null) ||
    (input.visitYield.unresolvedRatio !== undefined && unresolvedRatio === undefined) ||
    (input.visitYield.terminalRatio !== undefined && terminalRatio === undefined) ||
    (input.visitYield.ignoredRatio !== undefined && ignoredRatio === undefined);

  if (malformed) {
    return {
      reasonKind: "yield_input_malformed",
      priorMultiplier,
      clampedPriorMultiplier,
      newMultiplier: clampedPriorMultiplier,
      productiveOutputCount: 0,
      ...(unresolvedRatio !== undefined ? { unresolvedRatio } : {}),
      ...(terminalRatio !== undefined ? { terminalRatio } : {}),
      ...(ignoredRatio !== undefined ? { ignoredRatio } : {}),
    };
  }

  if (productiveOutputCount > 0) {
    return {
      reasonKind: "yield_shortened",
      priorMultiplier,
      clampedPriorMultiplier,
      newMultiplier: applyMultiplierStep(
        clampedPriorMultiplier,
        highPriority ? HIGH_PRIORITY_PRODUCTIVE_STEP : LOW_PRIORITY_PRODUCTIVE_STEP,
      ),
      productiveOutputCount,
      ...(unresolvedRatio !== undefined ? { unresolvedRatio } : {}),
      ...(terminalRatio !== undefined ? { terminalRatio } : {}),
      ...(ignoredRatio !== undefined ? { ignoredRatio } : {}),
    };
  }

  const mostlyExhausted =
    terminalRatio !== undefined &&
    ignoredRatio !== undefined &&
    terminalRatio >= 0.9 &&
    ignoredRatio >= 0.5;
  const barren =
    (unresolvedRatio !== undefined && unresolvedRatio <= LOW_UNRESOLVED_BARREN_THRESHOLD) ||
    mostlyExhausted;

  if (barren) {
    return {
      reasonKind: "yield_lengthened",
      priorMultiplier,
      clampedPriorMultiplier,
      newMultiplier: applyMultiplierStep(
        clampedPriorMultiplier,
        highPriority ? HIGH_PRIORITY_BARREN_STEP : LOW_PRIORITY_BARREN_STEP,
      ),
      productiveOutputCount,
      ...(unresolvedRatio !== undefined ? { unresolvedRatio } : {}),
      ...(terminalRatio !== undefined ? { terminalRatio } : {}),
      ...(ignoredRatio !== undefined ? { ignoredRatio } : {}),
    };
  }

  if (
    highPriority &&
    unresolvedRatio !== undefined &&
    unresolvedRatio > UNRESOLVED_HIGH_VALUE_THRESHOLD
  ) {
    return {
      reasonKind: "yield_shortened",
      priorMultiplier,
      clampedPriorMultiplier,
      newMultiplier: applyMultiplierStep(clampedPriorMultiplier, HIGH_PRIORITY_UNRESOLVED_STEP),
      productiveOutputCount,
      unresolvedRatio,
      ...(terminalRatio !== undefined ? { terminalRatio } : {}),
      ...(ignoredRatio !== undefined ? { ignoredRatio } : {}),
    };
  }

  return {
    reasonKind: "yield_held",
    priorMultiplier,
    clampedPriorMultiplier,
    newMultiplier: clampedPriorMultiplier,
    productiveOutputCount,
    ...(unresolvedRatio !== undefined ? { unresolvedRatio } : {}),
    ...(terminalRatio !== undefined ? { terminalRatio } : {}),
    ...(ignoredRatio !== undefined ? { ignoredRatio } : {}),
  };
}

export function sourceRetirementSignalHash(
  input: SourceRetirementSuggestionInput,
  kind: SourceRetirementSuggestionKind = "abandon",
): string {
  return [
    RETIREMENT_SIGNAL_VERSION,
    input.sourceId ?? "unknown-source",
    kind,
    RETIREMENT_THRESHOLD_SIGNATURE,
    Math.max(0, Math.floor(input.totalBlocks)),
    Math.max(0, Math.floor(input.terminalBlocks)),
    Math.max(0, Math.floor(input.ignoredBlocks)),
    Math.max(0, Math.floor(input.unresolvedBlocks)),
    Math.max(0, Math.floor(input.extractedOutputCount)),
  ].join("|");
}

export function sourceRetirementSuggestion(
  input: SourceRetirementSuggestionInput,
): SourceRetirementSuggestion | null {
  if (input.terminalRatio >= 0.9 && input.extractedOutputCount === 0 && input.ignoredRatio >= 0.5) {
    return {
      kind: "abandon",
      reason: "mostly_ignored_no_output",
      reasonLabel: "Mostly ignored blocks, no extracts yet",
      signalHash: sourceRetirementSignalHash(input, "abandon"),
      terminalRatio: input.terminalRatio,
      ignoredRatio: input.ignoredRatio,
      totalBlocks: input.totalBlocks,
      terminalBlocks: input.terminalBlocks,
      ignoredBlocks: input.ignoredBlocks,
      unresolvedBlocks: input.unresolvedBlocks,
      extractedOutputCount: input.extractedOutputCount,
    };
  }
  return null;
}

/**
 * The attention interval (DAYS) for a SOURCE/TOPIC by priority band — the by-priority
 * table from `scheduling-and-priority.md`. Higher priority returns SOONER within the
 * band so high-value material is not buried:
 *
 * ```txt
 *   A  1–7d    → 1
 *   B  7–30d   → 7
 *   C  30–60d  → 30
 *   D  90d+    → 90
 * ```
 *
 * The band floor is returned (the soonest end of each window); repeated postpones
 * grow it via {@link postponeIntervalForPriority}.
 */
export function sourceIntervalDays(priority: Priority): number {
  return { A: 1, B: 7, C: 30, D: 90 }[priorityToLabel(priority)];
}

/**
 * The attention interval (DAYS) for an EXTRACT at a given stage + priority — the
 * by-stage table from `scheduling-and-priority.md`:
 *
 * ```txt
 *   raw_extract        +1..7d
 *   clean_extract      +3..14d
 *   atomic_statement   convert now, or +1d
 * ```
 *
 * Higher-priority extracts return sooner within each band. This is the SINGLE source
 * of truth — `packages/local-db`'s `extractStageIntervalDays` re-exports it.
 */
export function extractStageIntervalDays(stage: ExtractStage, priority: Priority): number {
  const band = priorityToLabel(priority); // A/B/C/D
  switch (stage) {
    case "raw_extract":
      // +1..7d
      return { A: 1, B: 3, C: 5, D: 7 }[band];
    case "clean_extract":
      // +3..14d
      return { A: 3, B: 6, C: 10, D: 14 }[band];
    case "atomic_statement":
      // card-ready: convert now, or come back tomorrow.
      return 1;
  }
}

/**
 * The starter attention interval (DAYS) for a freshly-created `raw_extract`, by
 * inherited priority band — the MVP `raw_extract +1..7d` heuristic. Identical to
 * `extractStageIntervalDays("raw_extract", priority)`; kept as a named function so
 * `ExtractionService` reads intent at the call site. A=1, B=3, C=5, D=7.
 */
export function rawExtractIntervalDays(priority: Priority): number {
  return extractStageIntervalDays("raw_extract", priority);
}

/**
 * The base postpone interval (DAYS) by priority — the medium-source action heuristic
 * (`+7..30d`, sooner for higher priority). Grows with the postpone count via
 * {@link postponeIntervalForPriority}; this base is `postponeCount === 0`.
 */
export function basePostponeIntervalDays(priority: Priority): number {
  return { A: 7, B: 14, C: 21, D: 30 }[priorityToLabel(priority)];
}

/**
 * The postpone interval (DAYS) for a priority + a running postpone count. Repeatedly
 * postponed items RECEDE: each additional postpone multiplies the base interval by
 * `(1 + 0.5 · postponeCount)`, capped at the low-value `+180d` ceiling from the
 * rescheduling-by-action table. So a B item postponed once = 14d, twice = 21d,
 * three times = 28d… and a low item climbs toward the 180d ceiling. Deterministic.
 */
export function postponeIntervalForPriority(priority: Priority, postponeCount = 0): number {
  const base = basePostponeIntervalDays(priority);
  const count = Math.max(0, Math.floor(postponeCount));
  const grown = Math.round(base * (1 + 0.5 * count));
  return Math.min(grown, POSTPONE_CEILING_DAYS);
}

/** The low-value `+180d` ceiling from the rescheduling-by-action table. */
const POSTPONE_CEILING_DAYS = 180;

/**
 * The interval (DAYS) implied by the user's last ACTION, per the
 * rescheduling-by-action table in `scheduling-and-priority.md`:
 *
 * ```txt
 *   extract / rewrite / activate  → productive: the heuristic by-stage/by-priority
 *                                    interval (the item is making progress)
 *   postpone                      → push out, growing with postponeCount
 *   done                          → recede far out (low-value-style window)
 * ```
 *
 * Returns `null` for the productive actions, meaning "use the heuristic interval"
 * ({@link nextDueAt} then falls back to by-stage/by-priority). The non-productive
 * actions return an explicit interval that overrides the heuristic.
 */
function actionOverrideIntervalDays(input: Schedulable): number | null {
  switch (input.lastAction) {
    case "postpone":
      return postponeIntervalForPriority(input.priority, input.postponeCount ?? 0);
    case "done":
      // Finished for now: come back far out (low-value-source window, by priority).
      return { A: 30, B: 60, C: 120, D: 180 }[priorityToLabel(input.priority)];
    default:
      // extract / rewrite / activate / null → use the heuristic interval.
      return null;
  }
}

/**
 * The pure heuristic interval (DAYS) for an item ignoring the action override:
 * extracts branch by-stage, everything else (source/topic/task/synthesis_note)
 * branches by-priority.
 */
function heuristicIntervalDays(input: Schedulable): number {
  if (input.type === "extract" && isExtractStage(input.stage)) {
    return extractStageIntervalDays(input.stage, input.priority);
  }
  // A topic consumes the global `defaultTopicIntervalDays` setting when the service
  // supplies a positive value, so that user setting is not orphaned; otherwise it
  // falls back to the by-priority band like a source.
  if (
    input.type === "topic" &&
    typeof input.defaultTopicIntervalDays === "number" &&
    input.defaultTopicIntervalDays > 0
  ) {
    return Math.round(input.defaultTopicIntervalDays);
  }
  return sourceIntervalDays(input.priority);
}

function adjustForSourceProcessing(input: Schedulable, intervalDays: number): IntervalAdjustment {
  if (input.type !== "source" || !input.sourceProcessing) return { intervalDays };
  const priorityLabel = priorityToLabel(input.priority);
  const highValue = priorityLabel === "A" || priorityLabel === "B";
  const signals = input.sourceProcessing;
  if (highValue && signals.unresolvedRatio > 0.25) {
    const intervalAfterSourceProcessingDays = Math.max(1, Math.floor(intervalDays / 2));
    return {
      intervalDays: intervalAfterSourceProcessingDays,
      scheduleReason: {
        kind: "source_unresolved_shortened",
        baseIntervalDays: intervalDays,
        intervalAfterSourceProcessingDays,
        unresolvedRatio: signals.unresolvedRatio,
        terminalRatio: signals.terminalRatio,
        ignoredRatio: signals.ignoredRatio,
        extractedOutputCount: signals.extractedOutputCount,
      },
    };
  }
  if (
    sourceRetirementSuggestion({
      ...signals,
      totalBlocks: 0,
      terminalBlocks: 0,
      ignoredBlocks: 0,
      unresolvedBlocks: 0,
    })
  ) {
    const finalIntervalDays = Math.min(POSTPONE_CEILING_DAYS, intervalDays * 2);
    return {
      intervalDays: finalIntervalDays,
      retirementSuggestion: true,
      scheduleReason: {
        kind: "source_exhausted_lengthened",
        baseIntervalDays: intervalDays,
        intervalAfterSourceProcessingDays: finalIntervalDays,
        unresolvedRatio: signals.unresolvedRatio,
        terminalRatio: signals.terminalRatio,
        ignoredRatio: signals.ignoredRatio,
        extractedOutputCount: signals.extractedOutputCount,
      },
    };
  }
  return { intervalDays };
}

function isAdaptiveIntervalCandidate(input: Schedulable): boolean {
  return (
    (input.type === "source" || input.type === "extract") &&
    input.adaptiveAttentionIntervals === true
  );
}

function retirementSuggestionForSource(input: Schedulable): boolean | undefined {
  if (input.type !== "source" || !input.sourceProcessing) return undefined;
  return sourceRetirementSuggestion({
    ...input.sourceProcessing,
    totalBlocks: 0,
    terminalBlocks: 0,
    ignoredBlocks: 0,
    unresolvedBlocks: 0,
  })
    ? true
    : undefined;
}

function applyAdaptiveIntervalMultiplier(
  input: Schedulable,
  baseIntervalDays: number,
): IntervalAdjustment | null {
  if (!isAdaptiveIntervalCandidate(input) || !input.visitYield) return null;
  const multiplierInput: AdaptiveIntervalMultiplierInput =
    input.attentionIntervalMultiplier === undefined
      ? {
          priority: input.priority,
          visitYield: input.visitYield,
        }
      : {
          priority: input.priority,
          currentMultiplier: input.attentionIntervalMultiplier,
          visitYield: input.visitYield,
        };
  const multiplier = adaptiveAttentionIntervalMultiplier(multiplierInput);
  const intervalAfterMultiplierDays = Math.max(
    1,
    Math.round(baseIntervalDays * multiplier.newMultiplier),
  );
  const visibleAdaptiveReason =
    multiplier.reasonKind === "yield_shortened" || multiplier.reasonKind === "yield_lengthened";
  const scheduleReason: PendingAttentionScheduleReason | undefined = visibleAdaptiveReason
    ? {
        kind: multiplier.reasonKind,
        baseIntervalDays,
        intervalAfterMultiplierDays,
        priorMultiplier: multiplier.priorMultiplier,
        clampedPriorMultiplier: multiplier.clampedPriorMultiplier,
        newMultiplier: multiplier.newMultiplier,
        productiveOutputCount: multiplier.productiveOutputCount,
        ...(multiplier.unresolvedRatio !== undefined
          ? { unresolvedRatio: multiplier.unresolvedRatio }
          : {}),
        ...(multiplier.terminalRatio !== undefined
          ? { terminalRatio: multiplier.terminalRatio }
          : {}),
        ...(multiplier.ignoredRatio !== undefined ? { ignoredRatio: multiplier.ignoredRatio } : {}),
      }
    : undefined;
  return {
    intervalDays: intervalAfterMultiplierDays,
    attentionIntervalMultiplier: multiplier.newMultiplier,
    adaptiveReason: {
      ...multiplier,
      baseIntervalDays,
      intervalAfterMultiplierDays,
    },
    ...(scheduleReason ? { scheduleReason } : {}),
    ...(retirementSuggestionForSource(input) ? { retirementSuggestion: true } : {}),
  };
}

function shouldApplySourceProcessingAfterAdaptive(adjustment: IntervalAdjustment | null): boolean {
  if (!adjustment?.adaptiveReason) return adjustment === null;
  if (
    adjustment.adaptiveReason.reasonKind === "yield_held" ||
    adjustment.adaptiveReason.reasonKind === "yield_input_malformed"
  ) {
    return true;
  }
  return (
    adjustment.adaptiveReason.reasonKind === "yield_shortened" &&
    adjustment.adaptiveReason.productiveOutputCount === 0
  );
}

function mergeAdaptiveAndSourceAdjustments(
  adaptive: IntervalAdjustment,
  source: IntervalAdjustment,
): IntervalAdjustment {
  return {
    intervalDays: source.intervalDays,
    ...(source.retirementSuggestion || adaptive.retirementSuggestion
      ? { retirementSuggestion: true }
      : {}),
    ...(adaptive.attentionIntervalMultiplier !== undefined
      ? { attentionIntervalMultiplier: adaptive.attentionIntervalMultiplier }
      : {}),
    ...(adaptive.adaptiveReason ? { adaptiveReason: adaptive.adaptiveReason } : {}),
    ...((source.scheduleReason ?? adaptive.scheduleReason)
      ? { scheduleReason: source.scheduleReason ?? adaptive.scheduleReason }
      : {}),
  };
}

interface RecencyCreditResult {
  readonly intervalDays: number;
  readonly daysSinceLastSeen?: number;
  readonly recencyCreditDays?: number;
}

function applyRecencyCredit(
  baseIntervalDays: number,
  lastSeenAt: IsoTimestamp | null | undefined,
  now: IsoTimestamp,
): RecencyCreditResult {
  if (!lastSeenAt) return { intervalDays: baseIntervalDays };

  const lastSeenMs = Date.parse(lastSeenAt);
  const nowMs = Date.parse(now);
  if (Number.isNaN(lastSeenMs) || Number.isNaN(nowMs) || lastSeenMs > nowMs) {
    return { intervalDays: baseIntervalDays };
  }

  const ageDays = Math.floor((nowMs - lastSeenMs) / MS_PER_DAY);
  if (ageDays < 1) return { intervalDays: baseIntervalDays };

  const creditDays = Math.min(ageDays, Math.floor(baseIntervalDays / 2));
  return {
    intervalDays: Math.max(1, baseIntervalDays - creditDays),
    daysSinceLastSeen: ageDays,
    recencyCreditDays: creditDays,
  };
}

/**
 * Compute the next attention `due_at` for a non-card element from priority, stage,
 * last action, postpone count, source-processing signals, and last-seen recency. The
 * action override (postpone/done) takes precedence over the base heuristic; source
 * processing then adjusts that base; finally, valid older `lastSeenAt` values apply
 * a bounded credit so untouched items return sooner. ALWAYS measured from `now` (the
 * service passes the clock), so the returned date is deterministic for a fixed clock.
 *
 * This is the attention half ONLY — it never produces FSRS state and is never called
 * for a `card`.
 */
export function nextDueAt(input: Schedulable, now: IsoTimestamp): ScheduleDecision {
  const override = actionOverrideIntervalDays(input);
  const heuristicBaseIntervalDays = heuristicIntervalDays(input);
  const baseIntervalDays = override ?? heuristicBaseIntervalDays;
  const adaptiveAdjustment = applyAdaptiveIntervalMultiplier(input, baseIntervalDays);
  const sourceAdjustment = shouldApplySourceProcessingAfterAdaptive(adaptiveAdjustment)
    ? adjustForSourceProcessing(input, adaptiveAdjustment?.intervalDays ?? baseIntervalDays)
    : null;
  const adjusted =
    adaptiveAdjustment && sourceAdjustment
      ? mergeAdaptiveAndSourceAdjustments(adaptiveAdjustment, sourceAdjustment)
      : (adaptiveAdjustment ?? sourceAdjustment ?? { intervalDays: baseIntervalDays });
  const recency = applyRecencyCredit(adjusted.intervalDays, input.lastSeenAt, now);
  const intervalDays = recency.intervalDays;
  const malformedAdaptiveReason = adjusted.adaptiveReason?.reasonKind === "yield_input_malformed";
  const scheduleReason: AttentionScheduleReason | undefined =
    adjusted.scheduleReason !== undefined
      ? completeScheduleReason(adjusted.scheduleReason, intervalDays)
      : malformedAdaptiveReason
        ? undefined
        : input.lastAction === "postpone"
          ? {
              kind: "postpone_recession",
              baseIntervalDays: heuristicBaseIntervalDays,
              intervalAfterPostponeDays: baseIntervalDays,
              finalIntervalDays: intervalDays,
              postponeCount: Math.max(0, Math.floor(input.postponeCount ?? 0)),
            }
          : recency.recencyCreditDays !== undefined &&
              recency.recencyCreditDays > 0 &&
              recency.daysSinceLastSeen !== undefined
            ? {
                kind: "recency_damped",
                baseIntervalDays: adjusted.intervalDays,
                finalIntervalDays: intervalDays,
                daysSinceLastSeen: recency.daysSinceLastSeen,
                recencyCreditDays: recency.recencyCreditDays,
              }
            : { kind: "band_base", baseIntervalDays, finalIntervalDays: intervalDays };
  const decision: ScheduleDecision = {
    dueAt: addDays(now, intervalDays),
    intervalDays,
    ...(scheduleReason ? { scheduleReason } : {}),
  };
  return {
    ...decision,
    ...(adjusted.retirementSuggestion ? { retirementSuggestion: true } : {}),
    ...(adjusted.attentionIntervalMultiplier !== undefined
      ? { attentionIntervalMultiplier: adjusted.attentionIntervalMultiplier }
      : {}),
    ...(adjusted.adaptiveReason
      ? {
          adaptiveReason: {
            ...adjusted.adaptiveReason,
            finalIntervalDays: intervalDays,
          },
        }
      : {}),
  };
}

/** Schedule for TOMORROW (+1 day from `now`). The roadmap's explicit choice. */
export function scheduleTomorrow(now: IsoTimestamp): ScheduleDecision {
  return { dueAt: addDays(now, 1), intervalDays: 1 };
}

/** Schedule for NEXT WEEK (+7 days from `now`). The roadmap's explicit choice. */
export function scheduleNextWeek(now: IsoTimestamp): ScheduleDecision {
  return { dueAt: addDays(now, 7), intervalDays: 7 };
}

/** Schedule for NEXT MONTH (+30 days from `now`). The roadmap's explicit choice. */
export function scheduleNextMonth(now: IsoTimestamp): ScheduleDecision {
  return { dueAt: addDays(now, 30), intervalDays: 30 };
}

/**
 * Normalize + validate a MANUAL pick-a-date choice into a `{ dueAt, intervalDays }`
 * decision relative to `now`. String inputs must already be canonical UTC ISO
 * timestamps; `Date` inputs are normalized. `intervalDays` is the (possibly
 * fractional, possibly negative) day delta from `now` — informational; a past date
 * is allowed (the user may want it due immediately).
 */
export function scheduleManual(date: IsoTimestamp | Date, now: IsoTimestamp): ScheduleDecision {
  const ms = date instanceof Date ? date.getTime() : canonicalUtcIsoMs(date);
  if (Number.isNaN(ms)) {
    throw new Error(`scheduleManual: invalid date "${String(date)}"`);
  }
  const dueAt = new Date(ms).toISOString() as IsoTimestamp;
  const nowMs = Date.parse(now);
  const intervalDays = (ms - nowMs) / 86_400_000;
  return { dueAt, intervalDays };
}

function canonicalUtcIsoMs(value: IsoTimestamp): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return Number.NaN;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return Number.NaN;
  return new Date(ms).toISOString() === value ? ms : Number.NaN;
}

/** The explicit, non-heuristic scheduling choices the queue/loop offer the user. */
export type ScheduleChoice =
  | "tomorrow"
  | "nextWeek"
  | "nextMonth"
  | { readonly manual: IsoTimestamp | Date };

/** Resolve a {@link ScheduleChoice} to a decision relative to `now`. */
export function scheduleForChoice(choice: ScheduleChoice, now: IsoTimestamp): ScheduleDecision {
  if (choice === "tomorrow") return scheduleTomorrow(now);
  if (choice === "nextWeek") return scheduleNextWeek(now);
  if (choice === "nextMonth") return scheduleNextMonth(now);
  return scheduleManual(choice.manual, now);
}
