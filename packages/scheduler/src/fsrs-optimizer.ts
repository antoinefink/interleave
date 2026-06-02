/**
 * FSRS parameter optimizer (T080) — the CARD half of the two-scheduler split.
 *
 * HONESTY NOTE (read before changing this file). `ts-fsrs@5.4.1` exports NO
 * parameter optimizer / trainer / `computeParameters` — the gradient-descent
 * trainer lives in the separate `fsrs-rs` (Rust) / `fsrs-optimizer` (Python)
 * projects, which we do NOT bundle, call a server for, or reimplement as a full
 * autograd trainer here. What this module does, HONESTLY, with the primitives
 * ts-fsrs DOES export (`forgetting_curve`, `default_w`, `clipParameters`,
 * `checkParameters`):
 *
 *  1. EVALUATE any candidate `w` vector against the user's real review history by
 *     replaying each card's review sequence and scoring the model's PREDICTED
 *     recall probability `R = forgetting_curve(w, delta_t, stability)` against the
 *     actual outcome (recalled = rating ≠ `again`) with a proper log-loss + binned
 *     RMSE calibration metric. Exact + cheap + deterministic.
 *  2. SEARCH a small, bounded neighborhood — `default_w` + a handful of presets +
 *     a bounded coordinate / hill-climb over a few influential weights (each
 *     candidate `clipParameters`-clamped + `checkParameters`-validated) — keeping
 *     the best-scoring set. This is a LOCAL SEARCH over a scoring function WE own,
 *     NOT gradient training, and the UI says so ("estimated from your history").
 *
 * The `FsrsOptimizer` interface is deliberately clean so a real `fsrs-rs`/wasm
 * trainer can drop in later BEHIND it without changing callers.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): this scores + suggests FSRS (CARD)
 * parameters only; it never touches the attention scheduler. PURE — no DB, no IPC,
 * no React. The only `ts-fsrs` use is `forgetting_curve`/`default_w`/
 * `clipParameters`/`checkParameters` (math primitives), kept behind this boundary
 * like the rest of the scheduler package.
 */

import type { IsoTimestamp, ReviewRating } from "@interleave/core";
import {
  checkParameters,
  clipParameters,
  default_w,
  type FSRSParameters,
  forgetting_curve,
  fsrs,
  generatorParameters,
} from "ts-fsrs";

/** One replayed review of a card — the DB-free input the evaluator consumes. */
export interface OptimizerReview {
  readonly rating: ReviewRating;
  readonly reviewedAt: IsoTimestamp;
  /**
   * Days elapsed since the PREVIOUS review of this card (`0` for the first review).
   * DERIVED by the service from consecutive `reviewedAt` deltas — `review_logs`
   * has no per-log `elapsedDays` column. Must be ascending per card.
   */
  readonly elapsedDays: number;
}

/** One card's ascending review sequence (built from `review_logs`, DB-free). */
export interface OptimizerHistory {
  readonly cardId: string;
  readonly reviews: readonly OptimizerReview[];
}

/** The calibration score of a candidate parameter set against a history. Lower = better. */
export interface FitScore {
  /** Mean binary cross-entropy (log-loss) of predicted recall vs actual outcome. */
  readonly logLoss: number;
  /** Binned calibration RMSE (predicted-recall buckets vs observed recall rate). */
  readonly rmse: number;
  /** How many reviews actually contributed to the score (a first review can't be scored). */
  readonly reviewsScored: number;
}

/** Options for {@link scoreParameters} / {@link suggestParameters}. */
export interface OptimizerOptions {
  /**
   * Minimum total scored reviews + minimum cards-with-≥3-reviews below which a fit
   * is suppressed (`sufficientData: false`). Defaults to {@link MIN_REVIEWS_FOR_FIT}
   * / {@link MIN_CARDS_FOR_FIT}. Lowered in tests for small synthetic histories.
   */
  readonly minReviews?: number;
  readonly minCards?: number;
}

/** A suggested parameter update (or the current params when there is nothing better). */
export interface OptimizationSuggestion {
  /** The best-scoring FSRS parameters (always `checkParameters`-valid + clamped). */
  readonly params: FSRSParameters;
  /** The score of the BASELINE (current / `default_w`) params. */
  readonly baseline: FitScore;
  /** The score of the SUGGESTED params (≤ baseline, never worse). */
  readonly suggested: FitScore;
  /** `baseline.logLoss - suggested.logLoss` (≥ 0; `0` = no improvement found). */
  readonly improvement: number;
  /** Total reviews scored across the history. */
  readonly reviewsScored: number;
  /** The honest method label surfaced in the UI — NEVER "optimal". */
  readonly method: "history-calibration";
  /**
   * `false` below the data floor — below it we suggest NOTHING (the suggested
   * params equal the baseline) so we never "optimize" on noise.
   */
  readonly sufficientData: boolean;
}

/** Default data floor: suggest nothing below ~200 reviews. */
export const MIN_REVIEWS_FOR_FIT = 200;
/** Default data floor: suggest nothing below 20 cards with ≥ 3 reviews each. */
export const MIN_CARDS_FOR_FIT = 20;

/** The FSRS-6 weight-vector length (`default_w` is 21 numbers in ts-fsrs@5.4.1). */
export const FSRS_PARAM_COUNT = 21;

/** Number of calibration bins for the RMSE metric. */
const CALIBRATION_BINS = 10;
/** Clamp predicted recall away from {0,1} so log-loss stays finite. */
const EPSILON = 1e-6;

/** The `clipParameters` short-term/relearning step count we clamp candidates with. */
const RELEARNING_STEPS = 1;

/** The default `w` vector as a plain mutable array. */
export function defaultParams(): number[] {
  return [...default_w];
}

/**
 * Clamp + validate a candidate `w` vector into a usable FSRS-6 parameter array.
 * Returns `null` when the vector is the wrong length or `checkParameters` rejects
 * it (so a malformed candidate can never be scored or suggested). `clipParameters`
 * bounds each weight to the FSRS-safe range; `checkParameters` then validates it.
 */
export function sanitizeParams(w: readonly number[]): number[] | null {
  if (w.length !== FSRS_PARAM_COUNT) return null;
  if (w.some((value) => !Number.isFinite(value))) return null;
  try {
    const clipped = clipParameters([...w], RELEARNING_STEPS);
    // checkParameters throws on an invalid length/range; it returns the (valid) vector.
    const checked = checkParameters(clipped);
    return [...checked];
  } catch {
    return null;
  }
}

/**
 * Score one candidate `w` vector against a review history (T080).
 *
 * Replays each card's ascending review sequence: at each review (after the first),
 * the model's predicted retrievability `R = forgetting_curve(w, delta_t, stability)`
 * is compared to the actual outcome (recalled = rating ≠ `again`). Accumulates
 * log-loss + a binned calibration RMSE. Lower is better. Deterministic.
 *
 * The `stability` used at each step is itself derived from the candidate `w` via a
 * lightweight FSRS-shaped update (a first-recall stability + a monotone growth on
 * recall / shrink on lapse) — enough that a `w` whose decay/stability scale fits the
 * data scores BETTER than an obviously-wrong one, without re-implementing the full
 * FSRS-6 stability machine (the real trainer's job). Pass the FULL `w` array to
 * `forgetting_curve` (the `parameters[]` overload, which reads decay off `w[20]`) —
 * NOT only a decay scalar.
 */
export function scoreParameters(
  history: readonly OptimizerHistory[],
  w: readonly number[],
  _options: OptimizerOptions = {},
): FitScore {
  const params = sanitizeParams(w);
  if (!params) {
    return { logLoss: Number.POSITIVE_INFINITY, rmse: Number.POSITIVE_INFINITY, reviewsScored: 0 };
  }
  // Initial stabilities for again/hard/good/easy = w[0..3]; growth/decay scale from w.
  const initialStability = (rating: ReviewRating): number => {
    const idx = rating === "again" ? 0 : rating === "hard" ? 1 : rating === "good" ? 2 : 3;
    return Math.max(0.1, params[idx] ?? 1);
  };

  let logLossSum = 0;
  let scored = 0;
  // Calibration bins: [sum predicted, sum actual, count] per bucket.
  const binPred = new Array<number>(CALIBRATION_BINS).fill(0);
  const binActual = new Array<number>(CALIBRATION_BINS).fill(0);
  const binCount = new Array<number>(CALIBRATION_BINS).fill(0);

  for (const card of history) {
    const reviews = card.reviews;
    if (reviews.length < 2) continue;
    // Seed stability from the first review's rating.
    let stability = initialStability(reviews[0]?.rating ?? "good");
    for (let i = 1; i < reviews.length; i += 1) {
      const review = reviews[i];
      if (!review) continue;
      const deltaT = Math.max(0, review.elapsedDays);
      const predicted = clampProb(forgetting_curve(params, deltaT, stability));
      const recalled = review.rating !== "again" ? 1 : 0;
      logLossSum += -(recalled * Math.log(predicted) + (1 - recalled) * Math.log(1 - predicted));
      const bin = Math.min(CALIBRATION_BINS - 1, Math.floor(predicted * CALIBRATION_BINS));
      binPred[bin] = (binPred[bin] ?? 0) + predicted;
      binActual[bin] = (binActual[bin] ?? 0) + recalled;
      binCount[bin] = (binCount[bin] ?? 0) + 1;
      scored += 1;
      // Update stability for the next step: grow on recall, shrink on lapse. The
      // magnitude is scaled by w[8] (growth) / w[11] (lapse) so different `w` move
      // the trajectory differently — a coarse but honest, w-sensitive replay.
      stability = nextStability(stability, recalled === 1, params, deltaT);
    }
  }

  if (scored === 0) {
    return { logLoss: Number.POSITIVE_INFINITY, rmse: Number.POSITIVE_INFINITY, reviewsScored: 0 };
  }

  let rmseSum = 0;
  let nonEmptyBins = 0;
  for (let b = 0; b < CALIBRATION_BINS; b += 1) {
    const count = binCount[b] ?? 0;
    if (count === 0) continue;
    const meanPred = (binPred[b] ?? 0) / count;
    const meanActual = (binActual[b] ?? 0) / count;
    const diff = meanPred - meanActual;
    rmseSum += diff * diff * count;
    nonEmptyBins += count;
  }
  const rmse = nonEmptyBins > 0 ? Math.sqrt(rmseSum / nonEmptyBins) : Number.POSITIVE_INFINITY;
  return { logLoss: logLossSum / scored, rmse, reviewsScored: scored };
}

/** Clamp a probability into `[EPSILON, 1 - EPSILON]` so log-loss stays finite. */
function clampProb(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - EPSILON, Math.max(EPSILON, p));
}

/**
 * A coarse, w-sensitive stability update used during the replay scoring. On recall
 * stability grows (scaled by a growth weight); on a lapse it shrinks toward a small
 * floor (scaled by a lapse weight). NOT the full FSRS-6 stability machine — just
 * enough that different `w` produce different trajectories so the score can
 * discriminate. Bounded to FSRS's `[S_MIN, S_MAX]`-ish range.
 */
function nextStability(stability: number, recalled: boolean, w: number[], deltaT: number): number {
  const growth = Math.max(0.01, w[8] ?? 1.5);
  const lapse = Math.max(0.01, Math.min(1, w[11] ?? 0.5));
  if (recalled) {
    // Longer successful intervals reinforce more (a coarse spacing effect).
    const factor = 1 + growth * (0.1 + Math.log1p(deltaT) / 10);
    return Math.min(36500, stability * factor);
  }
  return Math.max(0.1, stability * lapse * 0.5);
}

/**
 * Whether a history clears the data floor (enough reviews AND enough cards with a
 * meaningful sequence). Below it, {@link suggestParameters} suggests nothing.
 */
export function hasSufficientData(
  history: readonly OptimizerHistory[],
  options: OptimizerOptions = {},
): boolean {
  const minReviews = options.minReviews ?? MIN_REVIEWS_FOR_FIT;
  const minCards = options.minCards ?? MIN_CARDS_FOR_FIT;
  let totalReviews = 0;
  let richCards = 0;
  for (const card of history) {
    totalReviews += card.reviews.length;
    if (card.reviews.length >= 3) richCards += 1;
  }
  return totalReviews >= minReviews && richCards >= minCards;
}

/**
 * The bounded candidate set: `default_w`, the current params, a few fixed presets
 * (higher / lower default-stability variants), and a coordinate hill-climb over a
 * few influential weights. Each candidate is sanitized (clamped + validated); a
 * rejected candidate is dropped. Small + bounded so an inline fit finishes fast.
 */
function candidateSet(current: readonly number[]): number[][] {
  const out: number[][] = [];
  const base = sanitizeParams(current) ?? defaultParams();
  out.push(defaultParams());
  out.push([...base]);
  // Fixed presets: scale the four initial-stability weights up / down.
  for (const scale of [0.8, 1.25]) {
    const variant = [...base];
    for (let i = 0; i < 4; i += 1) variant[i] = (variant[i] ?? 1) * scale;
    out.push(variant);
  }
  return out;
}

/** The influential-weight indices the hill-climb perturbs (initial stabilities + decay). */
const HILL_CLIMB_INDICES = [0, 1, 2, 3, 20] as const;
/** Multiplicative step sizes tried per coordinate, each direction. */
const HILL_CLIMB_STEPS = [0.9, 1.1] as const;

/**
 * Suggest a better FSRS parameter set from a review history (T080) — the bounded
 * search. Starts from `default_w` (and the current params), evaluates the fixed
 * preset set, then runs a bounded coordinate hill-climb over a few influential
 * weights, and returns the best-scoring (lowest log-loss) candidate. NEVER returns
 * params worse than the baseline (it keeps the baseline when no candidate beats it).
 * Below the data floor it returns the current params with `sufficientData: false`.
 *
 * Deterministic: no randomness, fixed candidate order, fixed step schedule.
 */
export function suggestParameters(
  history: readonly OptimizerHistory[],
  options: OptimizerOptions & { current?: readonly number[] } = {},
): OptimizationSuggestion {
  const current = sanitizeParams(options.current ?? defaultParams()) ?? defaultParams();
  const baselineScore = scoreParameters(history, current, options);

  if (!hasSufficientData(history, options)) {
    return {
      params: generatorParameters({ w: current }),
      baseline: baselineScore,
      suggested: baselineScore,
      improvement: 0,
      reviewsScored: baselineScore.reviewsScored,
      method: "history-calibration",
      sufficientData: false,
    };
  }

  let bestW = current;
  let bestScore = baselineScore;

  const consider = (candidate: readonly number[]): void => {
    const sane = sanitizeParams(candidate);
    if (!sane) return;
    const score = scoreParameters(history, sane, options);
    if (score.logLoss < bestScore.logLoss) {
      bestScore = score;
      bestW = sane;
    }
  };

  for (const candidate of candidateSet(current)) consider(candidate);

  // Bounded coordinate hill-climb: a fixed number of passes over the influential
  // weights, each tried up/down; keep an improving move, then continue from it.
  const MAX_PASSES = 3;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    let improvedThisPass = false;
    for (const idx of HILL_CLIMB_INDICES) {
      for (const step of HILL_CLIMB_STEPS) {
        const candidate = [...bestW];
        candidate[idx] = (candidate[idx] ?? 0) * step;
        const sane = sanitizeParams(candidate);
        if (!sane) continue;
        const score = scoreParameters(history, sane, options);
        if (score.logLoss < bestScore.logLoss) {
          bestScore = score;
          bestW = sane;
          improvedThisPass = true;
        }
      }
    }
    if (!improvedThisPass) break;
  }

  const improvement = Math.max(0, baselineScore.logLoss - bestScore.logLoss);
  return {
    params: generatorParameters({ w: bestW }),
    baseline: baselineScore,
    suggested: bestScore,
    improvement,
    reviewsScored: bestScore.reviewsScored,
    method: "history-calibration",
    sufficientData: true,
  };
}

/** The plain-JSON shape the off-main `fsrs_optimize` worker posts (a `w` vector + scores). */
export interface OptimizationSuggestionParts {
  readonly params: readonly number[];
  readonly baseline: FitScore;
  readonly suggested: FitScore;
  readonly improvement: number;
  readonly reviewsScored: number;
  readonly method: "history-calibration";
  readonly sufficientData: boolean;
}

/**
 * Rebuild a typed {@link OptimizationSuggestion} from the off-main runner's plain-JSON
 * result (T080). The worker runs `suggestParameters` and posts only a `w` vector + the
 * scores (a DB-free, ts-fsrs-free serializable shape); MAIN re-wraps the `w` into a
 * valid {@link FSRSParameters} via `generatorParameters` here — keeping the ts-fsrs
 * dependency behind this scheduler boundary (`@interleave/local-db` and the Electron
 * main process never import ts-fsrs). The `w` is sanitized again so a malformed
 * runner payload can never produce invalid params.
 */
export function optimizationSuggestionFromParts(
  parts: OptimizationSuggestionParts,
): OptimizationSuggestion {
  const w = sanitizeParams(parts.params) ?? defaultParams();
  return {
    params: generatorParameters({ w }),
    baseline: parts.baseline,
    suggested: parts.suggested,
    improvement: parts.improvement,
    reviewsScored: parts.reviewsScored,
    method: parts.method,
    sufficientData: parts.sufficientData,
  };
}

/**
 * The next FSRS review INTERVAL (days) a card with the given `stability` would be
 * scheduled at under a candidate parameter vector (T080's workload preview). A pure
 * single-step `next_interval` projection at the params' `request_retention` (NOT a
 * full multi-grade replay) — deterministic, fuzz off. Used by the `OptimizationService`
 * workload-impact projection so the FSRS math stays behind THIS package boundary
 * (`@interleave/local-db` never imports `ts-fsrs`). A malformed `w` or non-finite
 * input yields `null` (the caller keeps the card's current due date).
 */
export function nextIntervalDaysForParams(
  w: readonly number[],
  stability: number,
  elapsedDays: number,
): number | null {
  const sane = sanitizeParams(w);
  if (!sane) return null;
  if (!Number.isFinite(stability) || stability <= 0) return null;
  const engine = fsrs(generatorParameters({ w: sane, enable_fuzz: false }));
  const interval = engine.next_interval(stability, Math.max(0, elapsedDays));
  return Number.isFinite(interval) ? interval : null;
}

/**
 * The next FSRS review INTERVAL (days) a card with the given `stability` would be
 * scheduled at if its desired-retention TARGET were `requestRetention` (T081's workload
 * preview — the retention lever). FSRS's `next_interval` is
 * `clamp(round(stability * intervalModifier), 1, maxInterval)`, where the interval
 * modifier is `(requestRetention^(1/decay) - 1) / factor` — so a HIGHER target shortens
 * the interval (load pulls earlier) and a LOWER target lengthens it (load pushes later).
 * This builds the FSRS engine with the new `request_retention` and calls `next_interval`,
 * so the math is IDENTICAL to what the card scheduler would produce at that target (no
 * parallel re-implementation). Fuzz off, so the projection is deterministic. Pass the
 * same `params` the card is scheduled with (its resolved preset, or `default_w`) so only
 * the target changes.
 *
 * Returns `null` for a non-finite/<=0 stability or an out-of-range target (the caller
 * then keeps the card's current due date). The FSRS dependency stays behind THIS boundary
 * (`@interleave/local-db` never imports `ts-fsrs`).
 */
export function nextIntervalDaysForRetention(
  stability: number,
  requestRetention: number,
  params?: readonly number[],
): number | null {
  if (!Number.isFinite(stability) || stability <= 0) return null;
  if (!Number.isFinite(requestRetention) || requestRetention <= 0 || requestRetention > 1) {
    return null;
  }
  const w = params ? (sanitizeParams(params) ?? defaultParams()) : defaultParams();
  const engine = fsrs(
    generatorParameters({ w, request_retention: requestRetention, enable_fuzz: false }),
  );
  // `next_interval`'s modifier is independent of `elapsed_days` (elapsed only feeds the
  // fuzz, which is off), so the interval is anchored purely at the card's last review.
  const interval = engine.next_interval(stability, 0);
  return Number.isFinite(interval) ? interval : null;
}

/**
 * The clean interface a real `fsrs-rs`/wasm trainer can later implement WITHOUT
 * changing callers. The on-device `suggestParameters` is the v1 implementation.
 */
export interface FsrsOptimizer {
  suggest(
    history: readonly OptimizerHistory[],
    options?: OptimizerOptions & { current?: readonly number[] },
  ): OptimizationSuggestion;
}

/** The v1 on-device optimizer (the bounded calibration search above). */
export const historyCalibrationOptimizer: FsrsOptimizer = {
  suggest: (history, options) => suggestParameters(history, options),
};
