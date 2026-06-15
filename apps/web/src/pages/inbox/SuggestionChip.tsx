/**
 * Suggested-priority chip + justification formatter (T127 — U6).
 *
 * The triage suggestion engine (U1–U5) returns, per inbox item, a *structured*
 * justification — a list of fired signals carrying only integer counters and a
 * coarse band. This module turns that structure into ONE short human line and
 * renders a small chip distinct from the current-priority `Prio` badge.
 *
 * Two hard rules from the plan (R4):
 *  - The formatter NEVER invents prose. It only ever cites the integer values the
 *    backend already computed (`neighborCount`, `workedSourceCount`, `totalCards`,
 *    …). A signal that did not fire contributes no clause.
 *  - The chip is visually DISTINCT from the existing `Prio` badge: a dashed
 *    outline + a `sparkle` glyph + a "Suggested" affordance, design tokens only
 *    (so it never reads as the item's current band). It works light + dark.
 *
 * Pure presentation: the chip only FORMATS the backend-provided suggestion and
 * forwards an accept intent. No data fetching, no priority math, no domain logic.
 */

import { Icon } from "../../components/Icon";
import type { PriorityLabel, TriageJustification } from "../../lib/appApi";

/** One semantic clause, citing only the neighbor count + the band lean. */
function semanticClause(neighborCount: number, lean: PriorityLabel): string {
  const noun = neighborCount === 1 ? "neighbor" : "neighbors";
  return `Near ${neighborCount} priority-${lean} ${noun}`;
}

/** One yield clause (author or domain), citing only the real worked-source + card counts. */
function yieldClause(
  who: "author" | "domain",
  workedSourceCount: number,
  totalCards: number,
): string {
  const subject = who === "author" ? "author" : "domain";
  const sources = workedSourceCount === 1 ? "source" : "sources";
  const cards = totalCards === 1 ? "card" : "cards";
  return `This ${subject}'s last ${workedSourceCount} ${sources} made ${totalCards} ${cards}`;
}

/**
 * Format the structured justification into ONE short line. Renders ONLY the
 * clauses for signals that actually fired, in their structured order, joined with
 * a middot. Returns `""` when there is nothing to cite (the caller renders no line
 * then). Citing only the integer values present — never invented prose (R4).
 */
export function formatTriageJustification(justification: TriageJustification): string {
  const clauses: string[] = [];
  for (const signal of justification.signals) {
    switch (signal.kind) {
      case "semantic":
        clauses.push(semanticClause(signal.neighborCount, signal.lean));
        break;
      case "authorYield":
        clauses.push(yieldClause("author", signal.workedSourceCount, signal.totalCards));
        break;
      case "domainYield":
        clauses.push(yieldClause("domain", signal.workedSourceCount, signal.totalCards));
        break;
      default: {
        // Exhaustiveness guard: a new signal kind must add a clause above.
        const _never: never = signal;
        void _never;
      }
    }
  }
  return clauses.join(" · ");
}

/**
 * The suggested-band chip. Dashed outline + `sparkle` glyph + the suggested band
 * letter, labelled "Suggested" so it is unmistakable from the current `Prio`
 * badge. Clicking it accepts the suggestion (Enter does the same from the cursor
 * row). `compact` drops the wording for the dense list row; the preview pane shows
 * the full affordance.
 */
export function SuggestionChip({
  band,
  onAccept,
  busy,
  compact,
}: {
  band: PriorityLabel;
  onAccept?: () => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const label = compact ? `Suggested priority ${band}` : `Accept suggested priority ${band}`;
  const body = (
    <>
      <Icon name="sparkle" size={12} />
      {compact ? null : <span className="font-medium">Suggested</span>}
      <span
        className="inline-flex size-4 items-center justify-center rounded-full font-semibold text-2xs"
        style={{ background: `var(--prio-${band.toLowerCase()})`, color: "var(--text-on-accent)" }}
        aria-hidden
      >
        {band}
      </span>
    </>
  );
  const className =
    "inline-flex items-center gap-1.5 rounded-md border border-accent-soft-bd border-dashed bg-accent-soft px-2 py-0.5 text-accent-text text-2xs disabled:cursor-not-allowed disabled:opacity-55";
  if (onAccept) {
    return (
      <button
        type="button"
        data-testid="inbox-suggestion-chip"
        data-suggested-band={band}
        aria-label={label}
        disabled={busy}
        onClick={onAccept}
        className={`${className} hover:opacity-90`}
      >
        {body}
      </button>
    );
  }
  return (
    <span
      data-testid="inbox-suggestion-chip"
      data-suggested-band={band}
      role="img"
      aria-label={label}
      className={className}
    >
      {body}
    </span>
  );
}

/**
 * A neutral pending placeholder shown WHILE the batch suggestion fetch is in
 * flight, so "computing" is distinguishable from the permanent blank an
 * `insufficient_signal` row shows (the plan's loading-vs-empty rule).
 */
export function SuggestionPending() {
  return (
    <span
      data-testid="inbox-suggestion-pending"
      aria-hidden
      className="inline-flex items-center gap-1.5 rounded-md border border-border border-dashed bg-surface-2 px-2 py-0.5 text-2xs text-text-3"
    >
      <Icon name="sparkle" size={12} />
      <span className="motion-safe:animate-pulse">…</span>
    </span>
  );
}
