/**
 * doneIntentBreakdown — pure copy helpers for the partial-source "Done" intent surface.
 *
 * The done-gate surface (DoneIntentMenu) replaces the old `window.confirm("N unresolved
 * blocks…")` with an HONEST per-state breakdown. A flat "N unresolved" lumps five very
 * different states together: `unread` (never looked at), `read` (read but not extracted
 * from), `needs_later` (a DELIBERATE defer), and `stale_after_edit` (previously processed,
 * then the text changed). Only `extracted` / `ignored` / `processed_without_output` are
 * terminal; everything else is "unresolved".
 *
 * This module is pure (no React, no IPC) so the wording is unit-testable in isolation and
 * identical across the three call sites. It derives the non-terminal set from the domain's
 * own `isTerminalSourceBlockProcessingState` so a future reclassification can't silently
 * drift this copy (the test pins the expected set).
 */

import {
  isTerminalSourceBlockProcessingState,
  SOURCE_BLOCK_PROCESSING_STATES,
  type SourceBlockProcessingState,
} from "@interleave/core";

/** One non-terminal bucket to surface in the breakdown. */
export interface UnresolvedSegment {
  readonly key: SourceBlockProcessingState;
  /** Human label rendered after the count, e.g. "unread", "deferred". */
  readonly label: string;
  readonly count: number;
}

/**
 * Display order + friendly labels for the non-terminal states. Order is intentional:
 * never-read first, then read-but-unmined, then the two deliberate/odd states last.
 * `needs_later` reads as "deferred" (a choice the user made), `stale_after_edit` as
 * "stale after edit" (the text drifted) — both framed as not-a-problem-to-fix.
 */
const NON_TERMINAL_LABELS: Readonly<Record<string, string>> = {
  unread: "unread",
  read: "read, not extracted",
  needs_later: "deferred",
  stale_after_edit: "stale after edit",
};

const DISPLAY_ORDER: readonly string[] = ["unread", "read", "needs_later", "stale_after_edit"];

/** The non-terminal states, in display order, derived from the domain classification. */
function nonTerminalStatesInOrder(): SourceBlockProcessingState[] {
  const nonTerminal = SOURCE_BLOCK_PROCESSING_STATES.filter(
    (s) => !isTerminalSourceBlockProcessingState(s),
  );
  return [...nonTerminal].sort((a, b) => DISPLAY_ORDER.indexOf(a) - DISPLAY_ORDER.indexOf(b));
}

/**
 * Turn a source's `stateCounts` into the ordered, non-zero, non-terminal breakdown segments.
 * Terminal states (extracted/ignored/processed_without_output) and zero-count buckets are
 * excluded — the surface only shows what is still open.
 */
export function describeUnresolved(
  stateCounts: Readonly<Record<SourceBlockProcessingState, number>>,
): UnresolvedSegment[] {
  const segments: UnresolvedSegment[] = [];
  for (const key of nonTerminalStatesInOrder()) {
    const count = stateCounts[key] ?? 0;
    if (count <= 0) continue;
    segments.push({ key, label: NON_TERMINAL_LABELS[key] ?? key, count });
  }
  return segments;
}

/** Pluralize the block noun for a count: "1 block" / "12 blocks". */
export function pluralizeBlocks(count: number): string {
  return `${count} ${count === 1 ? "block" : "blocks"}`;
}

/**
 * The resume location label for the surface, e.g. "block 12 of 68", or `null` when there
 * is no usable read-point/total (never opened, cleared, or — in the list context — no
 * read-point position is available). Keeps read-point (where) separate from due-date (when).
 */
export function resumeLabel(
  currentBlock: number | null | undefined,
  totalBlocks: number | null | undefined,
): string | null {
  if (
    currentBlock == null ||
    totalBlocks == null ||
    !Number.isFinite(currentBlock) ||
    !Number.isFinite(totalBlocks) ||
    totalBlocks <= 0 ||
    currentBlock <= 0
  ) {
    return null;
  }
  return `block ${currentBlock} of ${totalBlocks}`;
}
