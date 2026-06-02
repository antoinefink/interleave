/**
 * Workload projector (T081) — the PURE, deterministic load-simulation engine.
 *
 * `docs/scheduling-and-priority.md` ("Overload handling → Workload simulation") asks
 * for a preview of how the user's DAILY load (cards/items due per day over the next N
 * days) would shift BEFORE they commit a change — so they never alter desired
 * retention / queue a big import / postpone material blind. This module is that
 * projection, as PURE domain logic: no DB, no IPC, no React. The `WorkloadService`
 * (`packages/local-db`) builds the DB-free {@link WorkloadSnapshot} from the live
 * tables and calls {@link projectWorkload}; the math lives HERE so it is unit-testable
 * and can never drift into a React component.
 *
 * Three levers (the spec's three change kinds):
 *  - `retention`  — re-project each affected CARD's next due at a new resolved target
 *    via the FSRS interval math (a higher target pulls load earlier, a lower target
 *    pushes it later) — the T079 resolver decides which cards are affected;
 *  - `addCards`   — distribute N new cards' first-due dates near `now` (the spike a
 *    planned import / batch of new extracts creates);
 *  - `postponeLowPriority` — move low-priority ATTENTION items (and, only when
 *    `includeMatureCards`, low-priority MATURE cards — never fragile, per T077's
 *    protect-fragile rule) out by `days` and show the relief.
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): a retention lever moves CARDS (FSRS); a
 * postpone lever moves ATTENTION items and — only with `includeMatureCards` — low-
 * priority mature cards. The projection NEVER reschedules a card through the attention
 * heuristic or an attention item through FSRS. It is READ-ONLY: it recomputes due days
 * in memory and returns counts; there is no mutation possible (a pure function over a
 * snapshot), so it writes nothing and appends no op.
 *
 * GROUNDING: the `before` series buckets the SAME `dueAt` values, by the SAME local-
 * calendar day, with overdue items on day 0 — exactly the way `QueueRepository.dueCards`
 * / the analytics screen count due load — so the baseline equals what the user already
 * sees and the "after" delta is meaningful. The clock (`asOf`) is injected; there is no
 * hidden `Date.now()` and no `Math.random()` (fuzz off), so the projection is fully
 * reproducible.
 */

import {
  type Priority,
  type PriorityLabel,
  priorityFromLabel,
  priorityToLabel,
} from "@interleave/core";
import { isCardMature } from "./auto-postpone";
import { MS_PER_DAY } from "./date-util";
import { nextIntervalDaysForParams, nextIntervalDaysForRetention } from "./fsrs-optimizer";
import { type RetentionTargets, resolveDesiredRetention } from "./retention";

/** Default projection window (days) — the analytics screen's "30 days". */
export const DEFAULT_WORKLOAD_WINDOW_DAYS = 30;

/** Band-A threshold (mirrors `@interleave/core` `priorityToLabel`: A >= 0.75). */
const HIGH_PRIORITY_THRESHOLD = 0.75;
/** "Low priority" is below band B (B >= 0.5), i.e. band C/D — the only postpone victims. */
const LOW_PRIORITY_THRESHOLD = 0.5;

/**
 * One CARD's snapshot row (DB-free). The projector needs only the FSRS memory signals
 * + priority + concept names (to resolve a new retention target). `conceptNames` are
 * concept NAMES (not ids), matching `RetentionTargets.byConcept`'s name keys — the
 * service maps memberships to names before building the snapshot.
 */
export interface WorkloadCard {
  readonly id: string;
  readonly priority: Priority;
  /** FSRS memory stability (days); `0`/negative = never meaningfully scheduled. */
  readonly stability: number;
  /** The card's last review instant (ISO-8601), or `null` if never reviewed. */
  readonly lastReviewedAt: string | null;
  /** The card's current FSRS due instant (ISO-8601), or `null` if unscheduled. */
  readonly dueAt: string | null;
  /** Current FSRS phase (`new`/`learning`/`review`/`relearning`). */
  readonly fsrsState: string;
  /** Card recall probability now (`0.0`-`1.0`), or `null` when unknown — for maturity. */
  readonly retrievability: number | null;
  /** The card's per-card desired-retention override (`cards.desired_retention`), or `null`. */
  readonly cardOverride: number | null;
  /** The card's resolved FSRS preset (or `null` = the global preset / `default_w`). */
  readonly params: readonly number[] | null;
  /** The NAMES of the live concepts the card belongs to (for the retention resolver). */
  readonly conceptNames: readonly string[];
}

/** One ATTENTION item's snapshot row (DB-free) — sources/topics/extracts/tasks. */
export interface WorkloadAttentionItem {
  readonly id: string;
  readonly priority: Priority;
  /** The item's current attention due instant (ISO-8601), or `null` if unscheduled. */
  readonly dueAt: string | null;
  /** The element type (`source`/`topic`/`extract`/`task`/`synthesis_note`). */
  readonly type: string;
}

/** The DB-free input the projector consumes — the live schedule + the retention targets. */
export interface WorkloadSnapshot {
  readonly cards: readonly WorkloadCard[];
  readonly attention: readonly WorkloadAttentionItem[];
  /** The daily review budget (the overload line); `overBudgetDays*` count days above it. */
  readonly budget: number;
  /** The live retention targets (so the retention lever resolves a card's NEW target). */
  readonly targets: RetentionTargets;
}

/** The retention lever: shift the effective target for the global default / a band / a concept. */
export interface WorkloadRetentionChange {
  readonly kind: "retention";
  readonly scope: "global" | "band" | "concept";
  /** The band label (scope `band`) or concept name (scope `concept`); omitted for `global`. */
  readonly key?: string;
  /** The NEW desired-retention target for that scope. */
  readonly target: number;
}

/** The add-cards lever: a planned import / batch of N new cards. */
export interface WorkloadAddCardsChange {
  readonly kind: "addCards";
  readonly count: number;
  readonly priority: Priority;
  /** How many days out the first review lands (default `0` = due ~now). */
  readonly firstDueInDays?: number;
}

/** The postpone lever: push low-priority material out by `days`. */
export interface WorkloadPostponeChange {
  readonly kind: "postponeLowPriority";
  /** The band whose items recede — only its level AND below (C postpones C+D). */
  readonly band: PriorityLabel;
  /** How many days to push the matching items out. */
  readonly days: number;
  /** Also postpone low-priority MATURE cards (never fragile) — default `false` (attention only). */
  readonly includeMatureCards?: boolean;
}

/** The applied-params lever (T080): re-project cards' due dates under a candidate FSRS preset. */
export interface WorkloadApplyParamsChange {
  readonly kind: "applyParams";
  /** The candidate 21-number FSRS-6 `w` vector. */
  readonly params: readonly number[];
  /** Restrict the re-projection to these card ids (a concept scope); omitted = all cards. */
  readonly cardIds?: readonly string[];
}

/** The discriminated change union the projector accepts. */
export type WorkloadChange =
  | WorkloadRetentionChange
  | WorkloadAddCardsChange
  | WorkloadPostponeChange
  | WorkloadApplyParamsChange;

/** Options for {@link projectWorkload}. */
export interface WorkloadOptions {
  /** "Now" the window starts at (ISO-8601); defaults to the wall clock. */
  readonly asOf?: string;
  /** The projection window length in days (default {@link DEFAULT_WORKLOAD_WINDOW_DAYS}). */
  readonly windowDays?: number;
}

/** One local-calendar day's before/after due counts. `date` is `YYYY-MM-DD` (local). */
export interface WorkloadDay {
  readonly date: string;
  readonly before: number;
  readonly after: number;
}

/** The complete projection: the per-day series + the summary deltas. */
export interface WorkloadProjection {
  readonly days: readonly WorkloadDay[];
  /** Days in the window strictly above `budget` BEFORE the change. */
  readonly overBudgetDaysBefore: number;
  /** Days in the window strictly above `budget` AFTER the change. */
  readonly overBudgetDaysAfter: number;
  /** The largest single-day due count BEFORE the change. */
  readonly peakBefore: number;
  /** The largest single-day due count AFTER the change. */
  readonly peakAfter: number;
  /** `after - before` total over the next 7 days (positive = more load). */
  readonly deltaNext7: number;
  /** `after - before` total over the next 30 days (positive = more load). */
  readonly deltaNext30: number;
  /** The daily review budget (the overload line) echoed for the chart. */
  readonly budget: number;
}

/** Whether a priority is high (band A) — fragile-protection keys off the band. */
function isHighPriority(priority: Priority): boolean {
  return priority >= HIGH_PRIORITY_THRESHOLD;
}

/** Whether a priority is low (band C/D) — the only postpone victims. */
function isLowPriority(priority: Priority): boolean {
  return priority < LOW_PRIORITY_THRESHOLD;
}

/** The local-day key (`YYYY-MM-DD`) for a Date. */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** The start-of-local-day instant for a date (matches the analytics bucketing). */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/**
 * The local-day bucket index a due instant falls in, relative to `start` (day 0). An
 * overdue instant (before `start`) lands on day 0 — the same way the queue counts a
 * past-due card as "due now". Returns `-1` when the instant is past the window's end
 * (the caller drops it). A `null`/unparseable instant is also dropped.
 */
function dayIndex(start: Date, dueIso: string | null, windowDays: number): number {
  if (!dueIso) return -1;
  const dueMs = Date.parse(dueIso);
  if (Number.isNaN(dueMs)) return -1;
  const idx = Math.floor((dueMs - start.getTime()) / MS_PER_DAY);
  const clamped = idx < 0 ? 0 : idx;
  return clamped >= windowDays ? -1 : clamped;
}

/**
 * Project how the daily workload shifts under a hypothetical `change` (T081). PURE +
 * deterministic: a fixed `snapshot` + `asOf` always yields the same projection.
 *
 * Buckets each card's `review_states.dueAt` and each attention item's `elements.dueAt`
 * into the next `windowDays` LOCAL-calendar days (overdue on day 0) for the `before`
 * series, then re-buckets after applying the change for the `after` series:
 *  - `retention`           — each AFFECTED card's due becomes `lastReviewedAt +
 *    next_interval(stability, newTarget)` (the T079 resolver picks which cards the
 *    scope's new target reaches); a higher target pulls load EARLIER, a lower later;
 *  - `applyParams`         — each in-scope card's due becomes `lastReviewedAt +
 *    next_interval(stability, elapsed)` under the candidate FSRS preset (T080's lever);
 *  - `addCards`            — N new cards' first reviews land near `now` (the import spike);
 *  - `postponeLowPriority` — low-priority attention items (and, only when
 *    `includeMatureCards`, low-priority MATURE cards) move out by `days` — fragile /
 *    high-priority memory is NEVER moved.
 *
 * Read-only: it never mutates the snapshot (a fresh `after` series is built). FSRS vs
 * attention stay distinct (a retention/params lever touches only cards; a postpone lever
 * touches attention items + optional mature cards).
 */
export function projectWorkload(
  snapshot: WorkloadSnapshot,
  change: WorkloadChange,
  options: WorkloadOptions = {},
): WorkloadProjection {
  const windowDays = Math.max(1, Math.floor(options.windowDays ?? DEFAULT_WORKLOAD_WINDOW_DAYS));
  const parsedAsOf = options.asOf ? Date.parse(options.asOf) : Date.now();
  const asOfMs = Number.isNaN(parsedAsOf) ? Date.now() : parsedAsOf;
  const start = startOfLocalDay(new Date(asOfMs));

  // Pre-seed every day bucket (a bar per day, even at 0).
  const before = new Array<number>(windowDays).fill(0);
  const after = new Array<number>(windowDays).fill(0);
  const dates: string[] = [];
  for (let i = 0; i < windowDays; i += 1) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    dates.push(dayKey(d));
  }

  const addBefore = (dueIso: string | null): void => {
    const idx = dayIndex(start, dueIso, windowDays);
    if (idx >= 0) before[idx] = (before[idx] ?? 0) + 1;
  };
  const addAfter = (dueIso: string | null): void => {
    const idx = dayIndex(start, dueIso, windowDays);
    if (idx >= 0) after[idx] = (after[idx] ?? 0) + 1;
  };

  // ---- BEFORE: ground the baseline in the live due dates (cards + attention) ----
  for (const card of snapshot.cards) addBefore(card.dueAt);
  for (const item of snapshot.attention) addBefore(item.dueAt);

  // ---- AFTER: apply the change to a fresh projection ----
  switch (change.kind) {
    case "retention":
      projectRetention(snapshot, change, addAfter);
      break;
    case "applyParams":
      projectApplyParams(snapshot, change, asOfMs, addAfter);
      break;
    case "addCards":
      projectAddCards(snapshot, change, addAfter, start);
      break;
    case "postponeLowPriority":
      projectPostpone(snapshot, change, addAfter);
      break;
  }

  const days: WorkloadDay[] = dates.map((date, i) => ({
    date,
    before: before[i] ?? 0,
    after: after[i] ?? 0,
  }));

  return {
    days,
    overBudgetDaysBefore: before.filter((c) => c > snapshot.budget).length,
    overBudgetDaysAfter: after.filter((c) => c > snapshot.budget).length,
    peakBefore: before.reduce((m, c) => Math.max(m, c), 0),
    peakAfter: after.reduce((m, c) => Math.max(m, c), 0),
    deltaNext7: sumWindow(after, 7) - sumWindow(before, 7),
    deltaNext30: sumWindow(after, 30) - sumWindow(before, 30),
    budget: snapshot.budget,
  };
}

/**
 * Apply the RETENTION lever: build the candidate targets (the scope's new target laid
 * over the live targets), resolve each card's NEW effective target, and — when it
 * actually changed and the card has the FSRS signals — re-project its due date to
 * `lastReviewedAt + next_interval(stability, newTarget)`. Cards the scope doesn't reach
 * (or that lack the signals) keep their current due date.
 */
function projectRetention(
  snapshot: WorkloadSnapshot,
  change: WorkloadRetentionChange,
  addAfter: (dueIso: string | null) => void,
): void {
  const candidateTargets = applyRetentionScope(snapshot.targets, change);
  for (const card of snapshot.cards) {
    const baseTarget = resolveDesiredRetention({
      priority: card.priority,
      conceptNames: card.conceptNames,
      cardOverride: card.cardOverride,
      targets: snapshot.targets,
    });
    const newTarget = resolveDesiredRetention({
      priority: card.priority,
      conceptNames: card.conceptNames,
      cardOverride: card.cardOverride,
      targets: candidateTargets,
    });
    // Unchanged target, or a card with no projectable memory → keep its current due.
    if (
      newTarget === baseTarget ||
      card.stability <= 0 ||
      !card.lastReviewedAt ||
      card.fsrsState === "new"
    ) {
      addAfter(card.dueAt);
      continue;
    }
    addAfter(reprojectAtRetention(card, newTarget));
  }
  // Attention items are untouched by a retention lever (the two-scheduler split).
  for (const item of snapshot.attention) addAfter(item.dueAt);
}

/**
 * Lay the scope's new target over the live {@link RetentionTargets} as a CANDIDATE set
 * (enabling the feature so a band/concept lever actually engages the resolver). Pure —
 * returns a fresh object; the snapshot's targets are never mutated.
 */
function applyRetentionScope(
  targets: RetentionTargets,
  change: WorkloadRetentionChange,
): RetentionTargets {
  if (change.scope === "global") {
    return { ...targets, global: change.target };
  }
  if (change.scope === "band") {
    const label = (change.key ?? "C") as PriorityLabel;
    return {
      ...targets,
      enabled: true,
      byBand: { ...(targets.byBand ?? {}), [label]: change.target },
    };
  }
  // concept
  const name = change.key ?? "";
  return {
    ...targets,
    enabled: true,
    byConcept: { ...(targets.byConcept ?? {}), [name]: change.target },
  };
}

/** Re-project a card's due date at a new desired-retention target (FSRS interval math). */
function reprojectAtRetention(card: WorkloadCard, newTarget: number): string | null {
  const intervalDays = nextIntervalDaysForRetention(
    card.stability,
    newTarget,
    card.params ?? undefined,
  );
  if (intervalDays === null || !card.lastReviewedAt) return card.dueAt;
  const lastMs = Date.parse(card.lastReviewedAt);
  if (Number.isNaN(lastMs)) return card.dueAt;
  return new Date(lastMs + intervalDays * MS_PER_DAY).toISOString();
}

/**
 * Apply the T080 APPLY-PARAMS lever: re-project each in-scope card's due date to
 * `lastReviewedAt + next_interval(stability, elapsed)` under the candidate FSRS preset.
 * (T080's `OptimizationService.workloadImpactOf` is the DB-backed wrapper over this.)
 */
function projectApplyParams(
  snapshot: WorkloadSnapshot,
  change: WorkloadApplyParamsChange,
  asOfMs: number,
  addAfter: (dueIso: string | null) => void,
): void {
  const inScope = change.cardIds ? new Set(change.cardIds) : null;
  for (const card of snapshot.cards) {
    if (
      (inScope && !inScope.has(card.id)) ||
      card.stability <= 0 ||
      !card.lastReviewedAt ||
      card.fsrsState === "new"
    ) {
      addAfter(card.dueAt);
      continue;
    }
    const lastMs = Date.parse(card.lastReviewedAt);
    if (Number.isNaN(lastMs)) {
      addAfter(card.dueAt);
      continue;
    }
    const elapsedDays = Math.max(0, (asOfMs - lastMs) / MS_PER_DAY);
    const intervalDays = nextIntervalDaysForParams(change.params, card.stability, elapsedDays);
    if (intervalDays === null) {
      addAfter(card.dueAt);
      continue;
    }
    addAfter(new Date(lastMs + intervalDays * MS_PER_DAY).toISOString());
  }
  for (const item of snapshot.attention) addAfter(item.dueAt);
}

/**
 * Apply the ADD-CARDS lever: keep the whole existing schedule, then add `count` new
 * cards whose first review lands `firstDueInDays` out (default `0` = day 0). New cards
 * land on a single near-term day to reflect the spike a batch of new cards / an import
 * creates; this is the coarse, honest near-term load a preview needs (the full learning-
 * step cadence is a deeper refinement and is intentionally not modeled here).
 */
function projectAddCards(
  snapshot: WorkloadSnapshot,
  change: WorkloadAddCardsChange,
  addAfter: (dueIso: string | null) => void,
  start: Date,
): void {
  // The existing schedule is unchanged.
  for (const card of snapshot.cards) addAfter(card.dueAt);
  for (const item of snapshot.attention) addAfter(item.dueAt);
  // The new cards' first review lands `firstDueInDays` out (clamped to >= 0).
  const offsetDays = Math.max(0, Math.floor(change.firstDueInDays ?? 0));
  const firstDue = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + offsetDays,
  ).toISOString();
  const count = Math.max(0, Math.floor(change.count));
  for (let i = 0; i < count; i += 1) addAfter(firstDue);
}

/**
 * Apply the POSTPONE lever: move the matching low-priority material out by `days`.
 * ATTENTION items whose band is at/below the chosen band recede; CARDS recede ONLY when
 * `includeMatureCards` AND the card is low-priority AND mature (never fragile, never high
 * priority) — exactly T077's protect-fragile rule. Everything else keeps its due date.
 */
function projectPostpone(
  snapshot: WorkloadSnapshot,
  change: WorkloadPostponeChange,
  addAfter: (dueIso: string | null) => void,
): void {
  const days = Math.max(0, change.days);
  // The chosen band's numeric floor: "band C" postpones C and below (lower priority).
  const bandCeiling = priorityFromLabel(change.band);

  for (const item of snapshot.attention) {
    if (item.priority <= bandCeiling && isLowPriority(item.priority) && item.dueAt) {
      addAfter(shiftOut(item.dueAt, days));
    } else {
      addAfter(item.dueAt);
    }
  }

  for (const card of snapshot.cards) {
    if (!change.includeMatureCards) {
      addAfter(card.dueAt);
      continue;
    }
    const eligible =
      card.dueAt != null &&
      isLowPriority(card.priority) &&
      !isHighPriority(card.priority) &&
      card.priority <= bandCeiling &&
      isCardMature({
        retrievability: card.retrievability,
        stability: card.stability,
        fsrsState: card.fsrsState,
        lapses: null,
      });
    addAfter(eligible ? shiftOut(card.dueAt, days) : card.dueAt);
  }
}

/** Shift an ISO due instant out by `days` (returns a new ISO instant). */
function shiftOut(dueIso: string, days: number): string {
  const ms = Date.parse(dueIso);
  if (Number.isNaN(ms)) return dueIso;
  return new Date(ms + days * MS_PER_DAY).toISOString();
}

/** Sum the first `days` buckets. */
function sumWindow(buckets: readonly number[], days: number): number {
  let total = 0;
  for (let i = 0; i < Math.min(days, buckets.length); i += 1) total += buckets[i] ?? 0;
  return total;
}

/** Convert a numeric priority to its A/B/C/D band (re-export of the core helper). */
export function workloadBand(priority: Priority): PriorityLabel {
  return priorityToLabel(priority);
}
