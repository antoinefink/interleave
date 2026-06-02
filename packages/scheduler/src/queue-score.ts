/**
 * Queue scoring (T076) — the deterministic auto-sort that replaces the queue's
 * old two-key `priority desc, due_at asc` comparison.
 *
 * `docs/scheduling-and-priority.md` ("Overload handling → Auto-sort") asks for a
 * single scoring function over SEVEN factors — priority, due date,
 * retrievability, element type, sibling spacing, concept diversity, and the
 * active session mode. This module is that function, as PURE domain logic: no DB,
 * no IPC, no React, and (deliberately) NO `ts-fsrs` import — it reads the already-
 * computed `approximateRetrievability` off the flat queue row (`QueueQuery`
 * decorates it), so the two-scheduler split stays READ-ONLY here. `asOf` is
 * injected so there is no hidden `Date.now()`; there is no `Math.random()` — the
 * 10–20% jitter the daily-queue rule asks for stays a SEPARATE seeded layer in the
 * renderer (`apps/web/src/pages/queue/jitter.ts`), applied ON TOP of this order.
 *
 * The ordering is a documented WEIGHTED SUM of normalized `[0,1]` factors (the
 * weights are named exported constants so a change is a deliberate, tested edit),
 * followed by two DETERMINISTIC de-clumping passes (sibling/same-source spacing and
 * concept diversity) that REORDER — they never re-weight the sum, so they cannot
 * starve a genuinely top-scoring item: each pass only moves an item DOWN by a
 * bounded number of ranks ({@link DECLUMP_MAX_PUSHDOWN}) and ties break by id, so a
 * fixed input always yields a fixed order.
 *
 * `queueItemScore` is exported and reusable: T077's auto-postpone reuses the same
 * "what is most/least valuable right now" reasoning to rank postpone victims.
 */

/** Which session mode is steering the order (a SOFT type up-weight, not a filter). */
export type SessionMode = "full" | "review" | "read";

/**
 * The flat queue-row shape the scorer reads. It is structurally satisfied by
 * `QueueQuery`'s `QueueItemSummary` (so the scorer needs no DB), but declared here
 * minimally so `packages/scheduler` does not depend on `packages/local-db`.
 */
export interface QueueScoreInput {
  readonly id: string;
  readonly type: string;
  /** Numeric priority `0.0`–`1.0` (higher = more important). */
  readonly priority: number;
  /** The governing due time (ISO-8601), or `null`. */
  readonly dueAt: string | null;
  readonly scheduler: "fsrs" | "attention";
  /** The card recall probability now (`0.0`–`1.0`), or `null` for attention rows. */
  readonly schedulerSignals: { readonly retrievability: number | null };
  /** A concept this row is a member of, or `null` — the concept-diversity key. */
  readonly concept: string | null;
  /** The sibling-group id (cards), or `null` — a sibling-spacing key. */
  readonly siblingGroupId: string | null;
  /** The owning source id, or `null` — the same-source de-clumping key. */
  readonly sourceId: string | null;
}

/** The per-factor weights of the weighted sum. Exported so they are tunable + tested. */
export interface QueueScoreWeights {
  /** Priority — the DOMINANT term (high-value floats up; new material can't dominate). */
  readonly priority: number;
  /** Due urgency — overdue > due-today > soon, growing with days overdue. */
  readonly dueUrgency: number;
  /** Retrievability — a card about to be forgotten is more urgent (lower R → higher). */
  readonly retrievability: number;
  /** Type weight — the small per-type bias the session mode modulates. */
  readonly type: number;
}

/**
 * The default weights. Priority dominates (so "high-priority fragile memory is
 * protected" and "new material must not dominate" hold), due urgency is the next
 * lever, retrievability and the mode-modulated type bias are smaller nudges. They
 * are pinned in the tests so a weight change is a deliberate update.
 */
export const DEFAULT_QUEUE_SCORE_WEIGHTS: QueueScoreWeights = {
  priority: 1.0,
  dueUrgency: 0.55,
  retrievability: 0.3,
  type: 0.12,
};

/**
 * The neutral retrievability value attention rows (which have no FSRS
 * retrievability) score at — the MIDPOINT, so they are neither unfairly buried nor
 * floated relative to cards on this factor.
 */
export const NEUTRAL_RETRIEVABILITY = 0.5;

/**
 * Days overdue at which the due-urgency factor saturates to `1.0`. A linear ramp
 * from due-today (`0`) to this cap keeps the longest-overdue high-value items at
 * the front without letting an ancient overdue D-item leapfrog a fresh A-item (the
 * priority weight still dominates the sum).
 */
export const DUE_URGENCY_SATURATION_DAYS = 21;

/**
 * The maximum number of ranks a de-clumping pass may push a single item DOWN for
 * diversity. Bounded so a genuinely top-scoring item is never starved to the back
 * of the queue for the sake of variety (the spec's "bounded swap" / "cap how far a
 * high-score item can be pushed down" requirement).
 */
export const DECLUMP_MAX_PUSHDOWN = 3;

const DAY_MS = 86_400_000;

/** Options for {@link scoreQueueItems} / {@link queueItemScore}. */
export interface QueueScoreOptions {
  /** The active session mode (default `"full"`). */
  readonly mode?: SessionMode;
  /** "Now" the due/overdue math compares against (ISO-8601); defaults to the wall clock. */
  readonly asOf?: string;
  /** Override the default weights (tests pin these). */
  readonly weights?: QueueScoreWeights;
}

/** The resolved per-item context the pure {@link queueItemScore} reads. */
export interface QueueScoreContext {
  readonly mode: SessionMode;
  /** `asOf` as epoch ms. */
  readonly asOfMs: number;
  readonly weights: QueueScoreWeights;
}

/** Clamp to `[0, 1]`. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * The mode-modulated per-type bias in `[0, 1]`. `review` floats cards, `read`
 * floats reading/processing items (sources/topics/extracts/tasks/synthesis notes),
 * `full` is neutral. This is a SOFT float — both types always stay in the list; the
 * mode merely re-orders them (the "due cards first, then reading" rule made
 * tunable, not a hard filter).
 */
function typeBias(type: string, mode: SessionMode): number {
  const isCard = type === "card";
  if (mode === "review") return isCard ? 1 : 0;
  if (mode === "read") return isCard ? 0 : 1;
  // full — neutral midpoint, so the type factor contributes nothing eitherway.
  return 0.5;
}

/**
 * The due-urgency factor in `[0, 1]`: a row due in the future scores `0`, a row due
 * today scores ~`0.5`, and an overdue row ramps from there to `1.0` at
 * {@link DUE_URGENCY_SATURATION_DAYS} days overdue. A null/unparseable due reads as
 * "not pressing" (`0`). Derived purely from `dueAt` vs `asOf`.
 */
function dueUrgency(dueAt: string | null, asOfMs: number): number {
  if (!dueAt) return 0;
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return 0;
  if (due > asOfMs) return 0;
  // Overdue/today: half the band for "due now", the other half ramping with days overdue.
  const daysOverdue = (asOfMs - due) / DAY_MS;
  const overdueRamp = clamp01(daysOverdue / DUE_URGENCY_SATURATION_DAYS);
  return 0.5 + 0.5 * overdueRamp;
}

/**
 * The retrievability factor in `[0, 1]`: for a CARD, LOWER retrievability scores
 * HIGHER (a card about to be forgotten is more urgent), i.e. `1 - R`. Attention
 * rows have no retrievability and use the {@link NEUTRAL_RETRIEVABILITY} midpoint so
 * they are not unfairly buried or floated on this factor.
 */
function retrievabilityUrgency(item: QueueScoreInput): number {
  const r = item.schedulerSignals.retrievability;
  if (r == null) return clamp01(1 - NEUTRAL_RETRIEVABILITY);
  return clamp01(1 - r);
}

/**
 * The deterministic per-item score (the weighted sum of the normalized factors).
 * Higher = surfaces earlier. PURE — same `(item, context)` always yields the same
 * number. Exported so T077 can rank postpone victims by the same value reasoning.
 */
export function queueItemScore(item: QueueScoreInput, context: QueueScoreContext): number {
  const { weights } = context;
  const priority = clamp01(item.priority);
  const urgency = dueUrgency(item.dueAt, context.asOfMs);
  const retr = retrievabilityUrgency(item);
  const type = typeBias(item.type, context.mode);
  return (
    weights.priority * priority +
    weights.dueUrgency * urgency +
    weights.retrievability * retr +
    weights.type * type
  );
}

/** Resolve the options into the per-item {@link QueueScoreContext}. */
function resolveContext(options: QueueScoreOptions): QueueScoreContext {
  const asOfMs = options.asOf ? Date.parse(options.asOf) : Date.now();
  return {
    mode: options.mode ?? "full",
    asOfMs: Number.isNaN(asOfMs) ? Date.now() : asOfMs,
    weights: options.weights ?? DEFAULT_QUEUE_SCORE_WEIGHTS,
  };
}

/** A row paired with its score, for the sort + de-clumping passes. */
interface ScoredRow<T extends QueueScoreInput> {
  readonly row: T;
  readonly score: number;
}

/**
 * Sort scored rows by score DESC, breaking ties by id ASC so the order is fully
 * deterministic (no input-position dependence, no randomness).
 */
function sortByScore<T extends QueueScoreInput>(scored: ScoredRow<T>[]): ScoredRow<T>[] {
  return [...scored].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });
}

/**
 * A bounded, deterministic de-clumping pass over a score-ordered list: rebuild the
 * order greedily so two items sharing a `keyOf(...)` group are not adjacent, while
 * never pulling an item more than {@link DECLUMP_MAX_PUSHDOWN} ranks ahead of its
 * score position (so a genuinely top-scoring item is never starved and the reorder
 * stays a bounded swap, not a free shuffle).
 *
 * At each slot we consider the candidates within a bounded look-ahead window (so a
 * pick never jumps more than the cap ahead of its own score rank) and choose, among
 * those whose key DIFFERS from the item just placed, the one whose key has the MOST
 * remaining occurrences — a frequency-aware tiebreak that keeps a majority key from
 * being stranded into an unavoidable adjacency at the tail (e.g. two siblings left
 * for last). Among equal frequencies the highest-scoring (lowest window index) wins,
 * so the choice is fully deterministic. If no in-window candidate differs (every one
 * shares the previous key) we fall back to the top remaining item — variety never
 * starves the queue, and the clump is then genuinely unavoidable. A `null` key never
 * clumps (those items are independent). Same input → same output.
 */
function declump<T extends QueueScoreInput>(ordered: T[], keyOf: (row: T) => string | null): T[] {
  // `remaining` stays in score order; each pick splices out the chosen item, so the
  // candidate at `remaining[k]` is the (origin-rank)-th best still unplaced.
  const remaining = [...ordered];
  // Live count of how many unplaced items carry each (non-null) key — drives the
  // frequency-aware tiebreak so a majority key isn't stranded into a tail clump.
  const keyCounts = new Map<string, number>();
  for (const item of remaining) {
    const key = keyOf(item);
    if (key != null) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  const result: T[] = [];
  let prevKey: string | null = null;
  while (remaining.length > 0) {
    const slot = result.length;
    let pickIndex = 0;
    if (prevKey != null) {
      const window = Math.min(remaining.length, DECLUMP_MAX_PUSHDOWN + 1);
      let bestFreq = -1;
      let chosen = -1;
      for (let k = 0; k < window; k++) {
        const key = keyOf(remaining[k] as T);
        if (key != null && key === prevKey) continue; // would clump — skip
        // A null-key item is independent (treated as frequency 0 — only taken when no
        // differing keyed candidate beats it; the index tiebreak keeps it stable).
        const freq = key == null ? 0 : (keyCounts.get(key) ?? 0);
        if (freq > bestFreq) {
          bestFreq = freq;
          chosen = k;
        }
      }
      // If every in-window candidate shares `prevKey`, `chosen` stays -1 → take the
      // top remaining item anyway (the clump is unavoidable without starving score).
      if (chosen !== -1) pickIndex = chosen;
    }
    const [picked] = remaining.splice(pickIndex, 1);
    const item = picked as T;
    result[slot] = item;
    const itemKey = keyOf(item);
    if (itemKey != null) {
      const next = (keyCounts.get(itemKey) ?? 1) - 1;
      if (next <= 0) keyCounts.delete(itemKey);
      else keyCounts.set(itemKey, next);
    }
    prevKey = itemKey;
  }
  return result;
}

/**
 * Score and order the queue rows (T076). Returns a NEW array — the input is never
 * mutated. The pipeline is:
 *
 *  1. compute each row's {@link queueItemScore} (the weighted sum of the seven
 *     factors' first five — priority/due/retrievability/type, with type modulated
 *     by `mode`);
 *  2. sort by score desc, tie-broken by id (deterministic);
 *  3. de-clump SIBLINGS / SAME-SOURCE rows (the M7 "siblings not back-to-back"
 *     rule, generalized) — a bounded reorder so two rows sharing a sibling group or
 *     source are not adjacent;
 *  4. de-clump CONCEPTS (so the top of the queue isn't all one topic).
 *
 * Steps 3–4 are bounded reorders (never a re-weight), so a genuinely top-scoring
 * item can be pushed down by at most {@link DECLUMP_MAX_PUSHDOWN} ranks per pass and
 * never starved. Fully deterministic: no `Math.random`; `asOf` is injected.
 */
export function scoreQueueItems<T extends QueueScoreInput>(
  items: readonly T[],
  options: QueueScoreOptions = {},
): T[] {
  const context = resolveContext(options);
  const scored = items.map((row) => ({ row, score: queueItemScore(row, context) }));
  const ordered = sortByScore(scored).map((s) => s.row);
  // Sibling spacing first (the M7 rule), then same-source, then concept diversity —
  // each a bounded, deterministic reorder over the score order. Sibling + source share
  // a key space conceptually (both "too related to sit adjacent"); run them as
  // separate passes so a card's sibling group AND its source are both honoured.
  const sibSpaced = declump(ordered, (row) => row.siblingGroupId);
  const srcSpaced = declump(sibSpaced, (row) => row.sourceId);
  return declump(srcSpaced, (row) => row.concept);
}
