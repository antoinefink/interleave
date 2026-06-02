/**
 * Extract-stagnation detection (T084) — the attention-side MIRROR of the leech rule.
 *
 * A card that keeps failing is a "leech" (`leech.ts`): repeated FSRS `lapses` cost
 * more review time than the knowledge is worth, so it is flagged for cleanup. The
 * EXACT analogue on the *attention* scheduler is an extract that keeps **coming
 * back** (attention-due, again and again) but never **progresses** — its stage never
 * advances (`raw_extract → clean_extract → atomic_statement`), it never produced a
 * child (a sub-extract or a card), and it has been postponed repeatedly. That is
 * dead weight in the attention rotation: a "stagnant" extract.
 *
 * The two predicates are SIBLINGS on purpose (co-located here + `leech.ts`) but are
 * NEVER computed from each other's signals: a leech is an FSRS *card* concern read
 * off `review_states.lapses`; stagnation is an attention *extract* concern read off
 * `stage` / child count / postpone markers. An extract has no `review_states` row and
 * is NEVER called a "leech"; a card is never called "stagnant". (See CLAUDE.md
 * "Scheduling rules" — the two-scheduler split.)
 *
 * **The rule (the charter's verbatim extract-scheduler inputs):** an extract is
 * stagnant when it has been **postponed ≥ {@link STAGNATION_POSTPONE_THRESHOLD}**
 * times AND has **not progressed** — i.e. it is still at `raw_extract`/`clean_extract`
 * (NOT `atomic_statement`), produced **no children** (`childCount === 0`), and its
 * stage has not advanced for at least {@link STAGNATION_STALE_DAYS} (measured from the
 * last stage advance, or `createdAt` when it never advanced). Like `isLeech`, false
 * positives are acceptable advisory flags — the user always chooses the remedy.
 *
 * The thresholds are named exported constants so a future per-collection setting can
 * tune them; the query NEVER hard-codes the numbers. The predicate is PURE / DB-free /
 * `now`-injected so it is deterministic + unit-testable.
 *
 * It is **advisory + read-only**. It never mutates, never schedules, never deletes —
 * it only LABELS an extract stagnant and RECOMMENDS one of the existing T024
 * `extracts.*` remediations (rewrite / convert / postpone / delete).
 */

import type { IsoTimestamp, Priority } from "@interleave/core";
import { MS_PER_DAY } from "./date-util";

/**
 * The postpone count at which a non-progressing extract is flagged stagnant — the
 * attention analogue of {@link import("./leech").LEECH_LAPSE_THRESHOLD}. "Returned
 * (and pushed out) ≥ 3 times without ever advancing." A named constant so a future
 * `stagnationPostponeThreshold` setting can override it; never hard-code `3`.
 */
export const STAGNATION_POSTPONE_THRESHOLD = 3 as const;

/**
 * Days without a stage advance after which a postponed, child-less extract is
 * considered stale. Measured from the last stage advance (or `createdAt` when it
 * never advanced). A named constant so a future `stagnationStaleDays` setting can
 * override it; never hard-code `30`.
 */
export const STAGNATION_STALE_DAYS = 30 as const;

/** The terminal extract stage — an extract that reached it has fully progressed. */
const ATOMIC_STAGE = "atomic_statement";

/** A single reason the stagnation predicate fired (human-readable, surfaced as chips). */
export type StagnationReason = "postponed-repeatedly" | "no-progress" | "no-children" | "stale";

/**
 * The recommended remediation — each maps to an EXISTING T024 `extracts.*` command
 * (or the extract→card path); T084 adds no new mutation primitive, it only points.
 */
export type StagnationSuggestion = "rewrite" | "convert" | "postpone" | "delete";

/**
 * The minimal DB-free snapshot the SERVICE reads off the extract + its op log. All
 * timestamps are ISO-8601; counts are non-negative integers.
 */
export interface ExtractStagnationSignals {
  /** The extract's current distillation stage (`raw_extract`/`clean_extract`/`atomic_statement`). */
  readonly stage: string;
  /** The extract's normalized numeric priority (`0.0`–`1.0`). */
  readonly priority: Priority;
  /** When the extract was created (the fallback "last progress" instant). */
  readonly createdAt: IsoTimestamp;
  /**
   * The last time the extract was processed (advanced / rewritten / postponed), when
   * known — advisory context for the suggestion; the predicate keys off the stage
   * advance + postpones, not this.
   */
  readonly lastProcessedAt?: IsoTimestamp | null;
  /** The extract's current attention due time (when it next returns), or `null`. */
  readonly dueAt?: IsoTimestamp | null;
  /** How many times the extract has been postponed (from the op-log postpone markers). */
  readonly postponeCount: number;
  /** How many live children (sub-extracts / cards) the extract produced. */
  readonly childCount: number;
  /**
   * When the extract's stage last ADVANCED (the newest `update_element` whose
   * `patch.stage` changed it), or `null` when it never advanced — then staleness is
   * measured from `createdAt`.
   */
  readonly lastStageAdvanceAt?: IsoTimestamp | null;
}

/** The verdict {@link isStagnant} produces. */
export interface StagnationVerdict {
  /** Whether the extract is stagnant (all the AND conditions fired). */
  readonly stagnant: boolean;
  /** The subset of reasons that fired (for the maintenance view's chips). */
  readonly reasons: readonly StagnationReason[];
  /** The recommended remediation (pure function of the signals; advisory). */
  readonly suggestion: StagnationSuggestion;
  /** Whole days since the last stage advance (or `createdAt`) — the staleness measure. */
  readonly daysSinceProgress: number;
}

/** Overridable thresholds (a future per-collection setting injects these). */
export interface StagnationOptions {
  readonly postponeThreshold?: number;
  readonly staleDays?: number;
}

/** Whole days between two ISO instants (>= 0; 0 when `now` precedes `since`). */
function daysBetween(since: IsoTimestamp, now: IsoTimestamp): number {
  const ms = Date.parse(now) - Date.parse(since);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * Choose the recommended remediation from the signals (pure, advisory, documented):
 *  - a `clean_extract` with no children → **convert** (it is already cleaned up — the
 *    next step is a card);
 *  - a deeply-stale (≥ 2× stale window), low-priority, heavily-postponed `raw_extract`
 *    → **delete** (it has had every chance and is low value — drop it);
 *  - any other still-`raw_extract` → **rewrite** (clean it up so it can move forward);
 *  - otherwise → **postpone** (a deliberate deferral).
 * This is advisory: the user always chooses. `daysSinceProgress`/`postponeCount` and
 * the thresholds it compares against are passed in so the mapping stays in one place.
 */
function suggestRemediation(
  signals: ExtractStagnationSignals,
  daysSinceProgress: number,
  staleDays: number,
  postponeThreshold: number,
): StagnationSuggestion {
  // Already cleaned up (clean_extract) with nothing derived → it is card-ready.
  if (signals.stage === "clean_extract" && signals.childCount === 0) {
    return "convert";
  }
  // A deeply-stale, low-priority, heavily-postponed raw extract has had its chances.
  // `priority < 0.4` is the low/background band (A/B/C/D ≈ 0.85/0.6/0.35/0.1).
  const deeplyStale = daysSinceProgress >= staleDays * 2;
  const heavilyPostponed = signals.postponeCount >= postponeThreshold + 1;
  if (
    signals.stage === "raw_extract" &&
    signals.priority < 0.4 &&
    deeplyStale &&
    heavilyPostponed
  ) {
    return "delete";
  }
  // A raw extract that is still worth keeping → rewrite to push it forward.
  if (signals.stage === "raw_extract") {
    return "rewrite";
  }
  // Anything else (e.g. a clean_extract that DID spawn a child but still stalls) →
  // a deliberate postpone.
  return "postpone";
}

/**
 * Whether an extract is stagnant + WHY + the recommended remediation. PURE — no I/O,
 * `now` injected, deterministic. The rule (see the file header):
 *
 *   stagnant ⇔  postponeCount ≥ threshold
 *           AND  stage ≠ atomic_statement   (never progressed to the end)
 *           AND  childCount === 0           (produced no children)
 *           AND  daysSinceProgress ≥ staleDays
 *
 * `reasons` lists which conditions fired (the maintenance view shows them as chips):
 * `postponed-repeatedly` / `no-progress` / `no-children` / `stale`. `daysSinceProgress`
 * is whole days since the last stage advance (or `createdAt`). The `suggestion` is
 * always computed (even when not stagnant) so callers can preview it; only `stagnant`
 * rows are surfaced.
 */
export function isStagnant(
  signals: ExtractStagnationSignals,
  now: IsoTimestamp,
  options: StagnationOptions = {},
): StagnationVerdict {
  const postponeThreshold = options.postponeThreshold ?? STAGNATION_POSTPONE_THRESHOLD;
  const staleDays = options.staleDays ?? STAGNATION_STALE_DAYS;

  const since = signals.lastStageAdvanceAt ?? signals.createdAt;
  const daysSinceProgress = daysBetween(since, now);

  const postponedRepeatedly = signals.postponeCount >= postponeThreshold;
  // "No progress" = still short of the terminal stage (raw_extract / clean_extract).
  const noProgress = signals.stage !== ATOMIC_STAGE;
  const noChildren = signals.childCount <= 0;
  const stale = daysSinceProgress >= staleDays;

  const reasons: StagnationReason[] = [];
  if (postponedRepeatedly) reasons.push("postponed-repeatedly");
  if (noProgress) reasons.push("no-progress");
  if (noChildren) reasons.push("no-children");
  if (stale) reasons.push("stale");

  // All four AND conditions must hold to flag stagnant (false positives are advisory,
  // but the bar is deliberately conservative so a productive/advancing extract is safe).
  const stagnant = postponedRepeatedly && noProgress && noChildren && stale;

  const suggestion = suggestRemediation(signals, daysSinceProgress, staleDays, postponeThreshold);

  return { stagnant, reasons, suggestion, daysSinceProgress };
}
