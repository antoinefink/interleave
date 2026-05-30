/**
 * Leech detection (T040) — the SINGLE source of the leech rule.
 *
 * A card that keeps failing is a "leech": its repeated lapses cost more review
 * time than the knowledge is worth, so it is flagged for cleanup (rewrite /
 * suspend / delete) rather than ground through endlessly. The detection rule
 * lives HERE (not in React, not duplicated across the DB layer) so the threshold
 * is named once and the predicate is pure + testable.
 *
 * **The rule:** a card is a leech once its cumulative FSRS `lapses` (failed
 * reviews — graded `again` in a non-`new` state) reaches {@link LEECH_LAPSE_THRESHOLD}
 * (the SuperMemo/Anki-style default of 4 — "warn at 4 lapses"). The threshold is a
 * named constant so a future per-collection `leechLapseThreshold` setting can
 * override it without hunting for a hard-coded `4` across the codebase (see T040
 * notes / M17).
 *
 * Leech is DERIVED from `lapses` but is meant to be STORED as a durable card flag
 * (so the cleanup view + analytics — M9/T045, M17/T083 — query it cheaply without
 * recomputing). This module owns the derivation; the persistence (the `cards.is_leech`
 * flag, set in the same transaction as the grade) is `packages/local-db`'s job. The
 * MVP behavior is **flag + warn**, never auto-suspend (auto-suspend-on-leech can be
 * a later setting).
 *
 * This is part of the FSRS (card) half of the two-scheduler split: leeches only
 * apply to `card` elements (they have `review_states`/`lapses`). Sources/topics/
 * extracts are on the attention scheduler and are never leeches.
 */

import type { ReviewState } from "@interleave/core";

/**
 * The lapse count at which a card is flagged a leech — the SuperMemo/Anki-style
 * default. "Warn at 4 lapses" (T040). Kept a named constant so a future
 * `leechLapseThreshold` setting can override it; never hard-code `4` elsewhere.
 */
export const LEECH_LAPSE_THRESHOLD = 4 as const;

/**
 * Whether a card's FSRS state crosses the leech threshold — true once
 * `lapses >= threshold` (default {@link LEECH_LAPSE_THRESHOLD}). Pure: it reads
 * only the `lapses` counter, so the same predicate works for the live grade path
 * (consulted after a review) and the cleanup-view / analytics reads. A `null`/
 * never-reviewed state is not a leech.
 */
export function isLeech(
  state: Pick<ReviewState, "lapses"> | null | undefined,
  threshold: number = LEECH_LAPSE_THRESHOLD,
): boolean {
  if (!state) return false;
  return state.lapses >= threshold;
}
