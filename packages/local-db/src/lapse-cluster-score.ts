/**
 * lapse-cluster-score (T128) — the pure ordering heuristic for lapse clusters.
 *
 * A "strength" score used ONLY to order the cluster list (strongest first). It does NOT
 * gate inclusion — the K / ≥2-cards / window floors do that (see `LapseClusterQuery`).
 * The raw number is never shown to users; it only sorts.
 *
 * Kept in `packages/local-db` (co-located with its single consumer, the query) rather than
 * `packages/core`: unlike `scoreSourceYield` (a cross-package domain rule with bands), this
 * is an internal ordering heuristic. Promote to core if a second consumer (e.g. T129) needs
 * it.
 *
 * ## Properties (pinned by tests)
 * - **Monotonic in lapse count** (depth): more total lapses → higher score, breadth fixed.
 * - **Monotonic in affected-card count** (breadth): more distinct failing cards → higher
 *   score, lapses fixed.
 * - **Breadth beats depth at equal total lapses:** 5 cards × 1 lapse outranks 1 card × 5
 *   lapses — the spec's framing that a correlated, multi-card failure is more a comprehension
 *   problem than a single hard card. Guaranteed because `BREADTH_WEIGHT > 0`.
 * - **Finite & NaN-safe:** non-finite or negative inputs are clamped to 0; the result is
 *   always a finite, non-negative number (pure addition — no division).
 */

/** Weight on total in-window lapse increments (depth). */
export const LAPSE_CLUSTER_DEPTH_WEIGHT = 1;
/** Weight on the count of distinct failing cards (breadth) — > depth so breadth wins ties. */
export const LAPSE_CLUSTER_BREADTH_WEIGHT = 1.5;

export interface LapseClusterScoreInput {
  /** Total true lapse increments across the cluster's member cards, in the window. */
  readonly totalWindowLapses: number;
  /** Number of distinct live member cards that lapsed in the window. */
  readonly affectedCardCount: number;
}

function nonNegFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Pure cluster-strength score. Higher = a stronger comprehension-debt signal. Ordering only.
 */
export function scoreLapseCluster(input: LapseClusterScoreInput): number {
  const lapses = nonNegFinite(input.totalWindowLapses);
  const cards = nonNegFinite(input.affectedCardCount);
  return lapses * LAPSE_CLUSTER_DEPTH_WEIGHT + cards * LAPSE_CLUSTER_BREADTH_WEIGHT;
}
