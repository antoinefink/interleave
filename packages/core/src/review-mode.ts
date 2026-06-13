/**
 * Review-mode vocabulary (T096) — the closed set of TARGETED review-mode kinds +
 * a typed, discriminated selector describing each mode's one parameter.
 *
 * A "review mode" reviews a CHOSEN SUBSET of cards — every card of a `concept`, of
 * a `source`, under a `branch` (a lineage subtree), matching a `search` query
 * (keyword) or `semantic` query (vector), every `stale` card (T090), every `leech`
 * (T040), or a `random` audit sample — OUTSIDE normal scheduling. Unlike the daily
 * session (T037), which surfaces only cards whose FSRS `review_states.due_at ≤ now`,
 * a review mode reviews its subset REGARDLESS of due date: a card not yet due is
 * still selectable. The selection IGNORES the due filter; everything else about a
 * review is unchanged — grading still writes a durable `review_logs` row and
 * advances FSRS through the existing path. Review modes are CARDS ONLY: the
 * two-scheduler split (FSRS = cards; attention = sources/topics/extracts) holds.
 *
 * This tuple is the SINGLE source of truth for both the domain union AND the IPC
 * Zod schema (`ReviewModeSelectorSchema` mirrors {@link ReviewModeSelector}), so the
 * DB validation and the domain can't silently drift — "a rename is a migration".
 *
 * Pure, framework-free (no React, no Drizzle, no DB), like every other
 * `@interleave/core` vocabulary (`task.ts` / `ai.ts`): the renderer renders
 * {@link reviewModeLabel}; the main process + the DB validate against
 * {@link REVIEW_MODE_KINDS} / {@link isReviewModeKind}.
 */

import type { ElementId } from "./ids";

/**
 * The closed set of review-mode kinds. Keep this a discriminated union so a future
 * "review by tag" / "review by priority band" mode is an ADDITIVE case, never a
 * rewrite:
 *  - `concept`  — every live card that is a member of a concept.
 *  - `source`   — every live card under a source (owning-source rollup).
 *  - `branch`   — every live card in a lineage subtree (a `source`/`topic`/`extract` root).
 *  - `search`   — every live card matching a keyword query (ranked FTS hits).
 *  - `semantic` — every live card semantically related to a query (FTS+vec fusion);
 *                 degrades to keyword when vec/model capability is unavailable.
 *  - `stale`    — every live card whose T090 lifetime makes it `due_for_review`/`expired`.
 *  - `leech`    — every live leech card (T040, durable `cards.is_leech`).
 *  - `random`   — a bounded random audit sample of live cards (seeded, reproducible).
 */
export const REVIEW_MODE_KINDS = [
  "concept",
  "source",
  "branch",
  "search",
  "semantic",
  "stale",
  "leech",
  "random",
] as const;

/** A review-mode kind — one of {@link REVIEW_MODE_KINDS}. */
export type ReviewModeKind = (typeof REVIEW_MODE_KINDS)[number];

/** Type guard: is `value` one of the {@link REVIEW_MODE_KINDS} kinds? */
export function isReviewModeKind(value: unknown): value is ReviewModeKind {
  return typeof value === "string" && (REVIEW_MODE_KINDS as readonly string[]).includes(value);
}

/** Calm, human labels for each {@link ReviewModeKind} — the mode-header chip + entry buttons. */
export const REVIEW_MODE_LABEL: Readonly<Record<ReviewModeKind, string>> = {
  concept: "Concept",
  source: "Source",
  branch: "Branch",
  search: "Search",
  semantic: "Semantic",
  stale: "Stale",
  leech: "Leeches",
  random: "Random audit",
};

/**
 * The human label for a review-mode kind. Defensive: an unknown value falls back to
 * a calm "Review" rather than throwing — the label is presentation, never a gate.
 */
export function reviewModeLabel(kind: string): string {
  return isReviewModeKind(kind) ? REVIEW_MODE_LABEL[kind] : "Review";
}

/**
 * The discriminated selector describing each review mode's one parameter. The
 * `kind` discriminant pairs with exactly one parameter shape; the IPC
 * `ReviewModeSelectorSchema` validates the SAME union before it reaches the
 * read-only `ReviewModeService`.
 *
 * `random.seed` is OPTIONAL and travels in the descriptor (never persisted to the
 * DB): the runner mints a seed once when the random mode is launched and carries it
 * so a re-read (a remount, or `count` then `deck`) reproduces the SAME sample rather
 * than reshuffling. The deck is ALSO fetched once on mount and walked by index, so
 * within-session stability holds even without a transported seed — the seed is the
 * belt to that suspenders.
 */
export type ReviewModeSelector =
  | { readonly kind: "concept"; readonly conceptId: ElementId }
  | { readonly kind: "source"; readonly sourceId: ElementId }
  | { readonly kind: "branch"; readonly rootId: ElementId }
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "semantic"; readonly query: string }
  | { readonly kind: "stale" }
  | { readonly kind: "leech" }
  | { readonly kind: "random"; readonly size: number; readonly seed?: number };

/**
 * The hard cap on a mode deck — keeps a 100k-card collection from building an
 * unbounded session (T100 load-tests this). When the underlying selected set
 * exceeds this, the deck is truncated to the first {@link MAX_REVIEW_MODE_DECK} and
 * the result is flagged `truncated` so the UI is honest ("showing the first 500 of
 * N"). A named constant a future setting can override.
 */
export const MAX_REVIEW_MODE_DECK = 500;

/**
 * The default `random` audit sample size when an entry affordance does not specify
 * one — small enough for a quick spot-check, capped by {@link MAX_REVIEW_MODE_DECK}.
 */
export const DEFAULT_RANDOM_AUDIT_SIZE = 20;
