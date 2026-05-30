/**
 * The FSRS card scheduler (T036) — the CARD half of the two-scheduler split.
 *
 * `SchedulerService` wraps `ts-fsrs` behind OUR own interface so the engine is
 * swappable + testable and the rest of the app never imports `ts-fsrs` types or
 * enums. It is the SINGLE source of FSRS scheduling math. Given a card's current
 * `ReviewState`, the current time, a rating, and the response time, it computes the
 * next FSRS memory state and hands a typed `ReviewOutcome` to
 * `ReviewRepository.recordReview`, which persists it + appends the `review_logs`
 * row in one transaction. It can also PREVIEW the four possible next intervals for
 * the grade buttons WITHOUT mutating state.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): FSRS applies to `card` elements ONLY
 * (cards answer "can the user recall this?"). Sources/topics/extracts schedule on
 * the SEPARATE attention scheduler in `attention-scheduler.ts` (they answer "should
 * the user process this again, and when?"). This service NEVER touches a non-card
 * element; an extract must never get a `review_states`/FSRS row. The
 * `ts-fsrs` `State`/`Rating`/`Card` vocabulary is mapped ↔ our
 * `FsrsState`/`ReviewRating`/`ReviewState` vocabulary in the adapters below and is
 * never allowed to leak past this boundary.
 */

import {
  FSRS_STATES,
  type FsrsState,
  type IsoTimestamp,
  REVIEW_RATINGS,
  type ReviewRating,
  type ReviewState,
} from "@interleave/core";
import {
  createEmptyCard,
  type FSRS,
  type FSRSParameters,
  type Card as FsrsCard,
  fsrs,
  type Grade,
  generatorParameters,
  Rating,
  State,
} from "ts-fsrs";
import { MS_PER_DAY } from "./date-util";

/**
 * The full FSRS state assigned by a review — the typed hand-off
 * `ReviewRepository.recordReview` consumes (prev/next {@link FsrsState}, next
 * stability/difficulty/dueAt, elapsed/scheduled days, reps, lapses). Kept in lock-
 * step with `@interleave/local-db`'s `ReviewOutcome` so the scheduler produces
 * exactly what the repository persists; defined here so the scheduler has no
 * dependency on `local-db` (the dependency flows local-db → scheduler).
 */
export interface ReviewOutcome {
  readonly rating: ReviewRating;
  readonly reviewedAt: IsoTimestamp;
  readonly responseMs: number;
  readonly prevState: FsrsState;
  readonly nextState: FsrsState;
  readonly nextStability: number;
  readonly nextDifficulty: number;
  readonly nextDueAt: IsoTimestamp;
  readonly elapsedDays: number;
  readonly scheduledDays: number;
  readonly reps: number;
  readonly lapses: number;
}

/** One previewed grade outcome: the resulting due time + interval (days) + a human label. */
export interface IntervalPreview {
  readonly dueAt: IsoTimestamp;
  /** Interval from `now` to the previewed due time, in (fractional) days. */
  readonly scheduledDays: number;
  /** Compact human label, e.g. `"10m"`, `"2d"`, `"5d"`, `"3mo"`. */
  readonly label: string;
}

/** Options for constructing a {@link SchedulerService}. */
export interface SchedulerServiceOptions {
  /**
   * FSRS target recall probability (`0.0`–`1.0`), the {@link AppSettings}
   * `defaultDesiredRetention` (T011) read by the live service. A first-class input:
   * higher retention yields shorter intervals.
   */
  readonly desiredRetention: number;
  /**
   * Enable interval fuzzing. OFF in tests (deterministic intervals); the live
   * service may turn it on. Defaults to `false`.
   */
  readonly enableFuzz?: boolean;
  /**
   * Escape hatch for the gold-standard FSRS-parameter optimization (T080) — a seam
   * for per-card/per-concept params. Merged over the derived defaults. Do not build
   * the optimizer here.
   */
  readonly params?: Partial<FSRSParameters>;
}

/**
 * Map our lowercase {@link FsrsState} ↔ the `ts-fsrs` numeric `State` enum. The
 * mapping is positional: `FSRS_STATES[State.X] === "x"` (new=0, learning=1,
 * review=2, relearning=3), asserted by the round-trip test.
 */
function toFsrsStateEnum(state: FsrsState): State {
  switch (state) {
    case "new":
      return State.New;
    case "learning":
      return State.Learning;
    case "review":
      return State.Review;
    case "relearning":
      return State.Relearning;
  }
}

function fromFsrsStateEnum(state: State): FsrsState {
  // FSRS_STATES is ordered to match the numeric `State` enum exactly.
  const mapped = FSRS_STATES[state];
  if (!mapped) throw new Error(`SchedulerService: unknown ts-fsrs State ${String(state)}`);
  return mapped;
}

/**
 * Map our {@link ReviewRating} → the `ts-fsrs` `Grade` (again=1 … easy=4). `Grade`
 * is `Rating` minus `Manual`, so it indexes both `repeat`'s `IPreview` and `next`.
 */
function toFsrsRating(rating: ReviewRating): Grade {
  switch (rating) {
    case "again":
      return Rating.Again;
    case "hard":
      return Rating.Hard;
    case "good":
      return Rating.Good;
    case "easy":
      return Rating.Easy;
  }
}

/** Compact, human-readable interval label from a day count (e.g. `"10m"`, `"2d"`, `"3mo"`). */
export function formatInterval(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return "0m";
  const minutes = days * 24 * 60;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = days * 24;
  if (hours < 24) return `${Math.round(hours)}h`;
  if (days < 30) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round((days / 365) * 10) / 10}y`;
}

export class SchedulerService {
  private readonly engine: FSRS;
  private readonly retention: number;

  constructor(options: SchedulerServiceOptions) {
    this.retention = options.desiredRetention;
    const params = generatorParameters({
      request_retention: options.desiredRetention,
      enable_fuzz: options.enableFuzz ?? false,
      ...options.params,
    });
    this.engine = fsrs(params);
  }

  /** The desired retention this scheduler was built with (a first-class input). */
  get desiredRetention(): number {
    return this.retention;
  }

  /**
   * The {@link ReviewState} for a brand-new card — the `ts-fsrs` `createEmptyCard`
   * shape mapped into our vocabulary (`fsrsState: "new"`, all counters zero, no due
   * date yet). M6/T032 card creation + the seed initialize state to this shape; M7
   * first-schedules it on the first review.
   */
  newCardState(elementId: ReviewState["elementId"]): ReviewState {
    return this.fromFsrsCard(elementId, createEmptyCard(), null);
  }

  /**
   * Adapt our persisted {@link ReviewState} → a `ts-fsrs` `Card` at time `now`.
   * `due`/`last_review` become `Date`s; the lowercase state becomes the numeric
   * enum. `learning_steps` is not persisted on `review_states` (it is an internal
   * `ts-fsrs` learning-step cursor) — a fresh card starts at step 0, which is
   * correct for the MVP (no resumed mid-learning-step state across restarts).
   */
  toFsrsCard(state: ReviewState, now: IsoTimestamp): FsrsCard {
    return {
      due: new Date(state.dueAt ?? now),
      stability: state.stability,
      difficulty: state.difficulty,
      elapsed_days: state.elapsedDays,
      scheduled_days: state.scheduledDays,
      reps: state.reps,
      lapses: state.lapses,
      learning_steps: 0,
      state: toFsrsStateEnum(state.fsrsState),
      ...(state.lastReviewedAt ? { last_review: new Date(state.lastReviewedAt) } : {}),
    };
  }

  /**
   * Adapt a `ts-fsrs` `Card` → our persisted {@link ReviewState} for the given card
   * element. `Date`s become ISO strings; the numeric state becomes our lowercase
   * vocabulary. The round-trip `fromFsrsCard(elementId, toFsrsCard(state)) ≈ state`
   * is stable (asserted in tests).
   */
  fromFsrsCard(
    elementId: ReviewState["elementId"],
    card: FsrsCard,
    lastReviewedAt: IsoTimestamp | null = card.last_review
      ? (card.last_review.toISOString() as IsoTimestamp)
      : null,
  ): ReviewState {
    return {
      elementId,
      dueAt: card.due ? (card.due.toISOString() as IsoTimestamp) : null,
      stability: card.stability,
      difficulty: card.difficulty,
      elapsedDays: card.elapsed_days,
      scheduledDays: card.scheduled_days,
      reps: card.reps,
      lapses: card.lapses,
      fsrsState: fromFsrsStateEnum(card.state),
      lastReviewedAt,
    };
  }

  /**
   * Preview the four possible next intervals (for the grade buttons) using
   * `scheduler.repeat(card, now)`. PURE — mutates nothing (neither the input
   * `state` nor any persisted row). Each interval's `scheduledDays`/`label` are
   * computed from `due - now` so a learning-step card (whose FSRS `scheduled_days`
   * is `0`) still reports its true 10m/1d/etc. spacing and the four are ordered.
   */
  previewIntervals(state: ReviewState, now: IsoTimestamp): Record<ReviewRating, IntervalPreview> {
    const card = this.toFsrsCard(state, now);
    const nowMs = Date.parse(now);
    const record = this.engine.repeat(card, new Date(now));
    const build = (rating: ReviewRating): IntervalPreview => {
      const next = record[toFsrsRating(rating)].card;
      const dueIso = next.due.toISOString() as IsoTimestamp;
      const days = Math.max(0, (Date.parse(dueIso) - nowMs) / MS_PER_DAY);
      return { dueAt: dueIso, scheduledDays: days, label: formatInterval(days) };
    };
    return {
      again: build("again"),
      hard: build("hard"),
      good: build("good"),
      easy: build("easy"),
    };
  }

  /**
   * Grade a card: compute the next FSRS memory state via `scheduler.next(card, now,
   * Rating)` and return the typed {@link ReviewOutcome} `ReviewRepository.recordReview`
   * persists. PURE — it does not write anything; persistence is the repository's job
   * (so the FSRS math stays here, not in the repository or React). `prevState` is the
   * state BEFORE this review (off the input `state`); the counters/`nextState` come
   * from the resulting card. `scheduledDays` is the canonical FSRS field on the
   * resulting card.
   */
  gradeCard(
    state: ReviewState,
    rating: ReviewRating,
    now: IsoTimestamp,
    responseMs: number,
  ): ReviewOutcome {
    const card = this.toFsrsCard(state, now);
    const { card: next } = this.engine.next(card, new Date(now), toFsrsRating(rating));
    return {
      rating,
      reviewedAt: now,
      responseMs,
      prevState: state.fsrsState,
      nextState: fromFsrsStateEnum(next.state),
      nextStability: next.stability,
      nextDifficulty: next.difficulty,
      nextDueAt: next.due.toISOString() as IsoTimestamp,
      elapsedDays: next.elapsed_days,
      scheduledDays: next.scheduled_days,
      reps: next.reps,
      lapses: next.lapses,
    };
  }
}

/** The canonical, ordered rating list (re-exported for callers iterating previews). */
export const SCHEDULER_REVIEW_RATINGS = REVIEW_RATINGS;
