/**
 * RefBlock (T043) — the shared source-reference (`refblock`) component.
 *
 * Every extract and card shows WHERE it came from: the originating source's
 * title / URL / author / published date / location, plus the verbatim source
 * snippet — so nothing in the app feels orphaned. This is the ONE renderer
 * component that draws that block; review, the extract view, the inspector, and
 * the library selection detail all reuse it so a reference reads consistently.
 *
 * The citation/href/location assembly is NOT done here — it lives in
 * `@interleave/core`'s `formatSourceRef` (framework-free, unit-tested). This
 * component is pure presentation over a {@link SourceRef}: it renders the snippet
 * quote, the citation line, an optional external URL link, and the
 * "open source at this location" affordance (the T022 jump-to-source, wired by the
 * caller via `onOpenSource`). A source-less / soft-deleted-source ref degrades to
 * a calm "Source unavailable" placeholder — never a broken link, never a crash.
 *
 * Matches the kit's `.refblock` / `.refblock__src` (design/kit `screen-review`,
 * `screen-builder`, `screen-library`): the serif quote with the left rule + the
 * accent-text source line.
 */

import { formatSourceRef, type ReliabilitySummary, type SourceRef } from "@interleave/core";
import { ExternalUrlLink } from "./ExternalUrlLink";
import { Icon } from "./Icon";
import "./ref-block.css";

/**
 * Pick the reliability-badge variant class (T091). An uncertainty cue (low confidence
 * OR a caveat note) overrides the tier color to the warn tint so the eye lands on
 * "be careful"; otherwise the tier sets a calm trust color (primary → ok, secondary/
 * tertiary → neutral/muted); with no tier, a soft neutral badge.
 */
function reliabilityBadgeClass(reliability: ReliabilitySummary): string {
  if (reliability.hasUncertainty) return "badge--uncertain";
  if (reliability.tier === "primary") return "badge--tier-primary";
  if (reliability.tier === "secondary") return "badge--tier-secondary";
  if (reliability.tier === "tertiary") return "badge--tier-tertiary";
  return "badge--reliability";
}

export interface RefBlockProps {
  /** The resolved source reference, or `null` (the orphan placeholder case). */
  readonly ref: SourceRef | null | undefined;
  /**
   * The jump-to-source action (T022). When provided AND the ref resolves a source,
   * the "Open source at this location" affordance is shown; the caller resolves the
   * jump target from the element's location and calls `navigateToLocation`.
   */
  readonly onOpenSource?: () => void;
  /** Render the verbatim source snippet as the block body (default true). */
  readonly showSnippet?: boolean;
  /**
   * Optional body text already rendered nearby. When the source snippet is effectively
   * the same text, RefBlock suppresses only the quote body and keeps citation/provenance.
   */
  readonly dedupeSnippetAgainst?: string | null;
  /** Test id for the block root (defaults to `refblock`). */
  readonly testId?: string;
  /** Extra inline style passthrough (e.g. top margin in review). */
  readonly style?: React.CSSProperties;
}

function normalizeForSnippetDedupe(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/\{\{c\d+::([^}]+)\}\}/g, "$1")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDuplicateSnippet(snippet: string | null, compare: string | null | undefined): boolean {
  if (!snippet || !compare) return false;
  const a = normalizeForSnippetDedupe(snippet);
  const b = normalizeForSnippetDedupe(compare);
  if (!a || !b) return false;
  if (a === b) return true;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length < 40) return false;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.65;
}

/**
 * Render the source reference. Keeps the kit's `.refblock` markup; the citation +
 * href come from the shared `formatSourceRef` so this stays presentation-only.
 */
export function RefBlock({
  ref,
  onOpenSource,
  showSnippet = true,
  dedupeSnippetAgainst,
  testId = "refblock",
  style,
}: RefBlockProps) {
  const f = formatSourceRef(ref);

  // Orphaned / source-less: a calm placeholder, never a broken link or a crash.
  if (!f.hasSource) {
    return (
      <div className="refblock refblock--empty" data-testid={`${testId}-empty`} style={style}>
        <span className="dimmed">Source unavailable</span>
      </div>
    );
  }

  const shouldShowSnippet =
    showSnippet && f.snippet && !isDuplicateSnippet(f.snippet, dedupeSnippetAgainst);

  // Citation, reliability badge, and source URL collapse onto one wrapping "meta" row
  // (badge leading) so short provenance reads on a single line and long provenance wraps
  // gracefully. Rendered only when at least one piece is present, so an otherwise-empty
  // ref adds no stray row.
  const hasMeta = Boolean(f.reliability || f.citation || f.locationLabel || f.href);

  return (
    <div className="refblock serif" data-testid={testId} style={style}>
      {shouldShowSnippet ? (
        <span className="refblock__quote" data-testid={`${testId}-quote`}>
          {f.snippet}
        </span>
      ) : null}

      {/* The wrapping meta row: badge leads, then citation/locator, then the URL. DOM
          order is the visual order (no CSS `order`), so reading order matches the render
          (WCAG 1.3.2); the URL anchor is the row's only tab stop. Source-reliability badge
          (T091) shows only when the source carries reliability metadata; colored by tier,
          tinted warn on uncertainty. In review this rides the post-reveal gate (the whole
          refblock is hidden until reveal), so it never leaks the answer. */}
      {hasMeta ? (
        <div className="refblock__meta" data-testid={`${testId}-meta`}>
          {f.reliability ? (
            <span
              className={`badge ${reliabilityBadgeClass(f.reliability)}`}
              data-testid={`${testId}-reliability`}
              data-reliability-tier={f.reliability.tier ?? ""}
              data-reliability-confidence={f.reliability.confidence ?? ""}
            >
              <Icon name={f.reliability.hasUncertainty ? "warning" : "shield"} size={11} />
              {f.reliability.label}
            </span>
          ) : null}

          {f.citation ? (
            <div className="refblock__cite" data-testid={`${testId}-citation`}>
              {f.citation}
              {f.locationLabel ? <span className="refblock__loc"> · {f.locationLabel}</span> : null}
            </div>
          ) : f.locationLabel ? (
            <div className="refblock__cite" data-testid={`${testId}-citation`}>
              {f.locationLabel}
            </div>
          ) : null}

          {f.href ? (
            <ExternalUrlLink
              className="refblock__url"
              icon="link"
              testId={`${testId}-url`}
              url={f.href}
            />
          ) : null}
        </div>
      ) : null}

      {/* The uncertainty caveat stays a full-width block below the meta row. */}
      {f.reliability?.notes ? (
        <span className="refblock__rel-note" data-testid={`${testId}-reliability-note`}>
          {f.reliability.notes}
        </span>
      ) : null}

      {onOpenSource ? (
        <button
          type="button"
          className="refblock__src"
          data-testid={`${testId}-open-source`}
          onClick={onOpenSource}
        >
          <Icon name="external" size={12} />
          Open source at this location
        </button>
      ) : null}
    </div>
  );
}
