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
  /** Test id for the block root (defaults to `refblock`). */
  readonly testId?: string;
  /** Extra inline style passthrough (e.g. top margin in review). */
  readonly style?: React.CSSProperties;
}

/**
 * Render the source reference. Keeps the kit's `.refblock` markup; the citation +
 * href come from the shared `formatSourceRef` so this stays presentation-only.
 */
export function RefBlock({
  ref,
  onOpenSource,
  showSnippet = true,
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

  return (
    <div className="refblock serif" data-testid={testId} style={style}>
      {showSnippet && f.snippet ? (
        <span className="refblock__quote" data-testid={`${testId}-quote`}>
          {f.snippet}
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

      {/* Source-reliability badge + uncertainty note (T091). Shown only when the source
          carries reliability metadata; a null-reliability source renders nothing extra
          (the unchanged pre-T091 refblock). Colored by tier; tinted warn on uncertainty.
          In review this rides the post-reveal reveal gate (the whole refblock is hidden
          until reveal), so it never leaks the answer. */}
      {f.reliability ? (
        <div className="refblock__reliability">
          <span
            className={`badge ${reliabilityBadgeClass(f.reliability)}`}
            data-testid={`${testId}-reliability`}
            data-reliability-tier={f.reliability.tier ?? ""}
            data-reliability-confidence={f.reliability.confidence ?? ""}
          >
            <Icon name={f.reliability.hasUncertainty ? "warning" : "shield"} size={11} />
            {f.reliability.label}
          </span>
        </div>
      ) : null}
      {f.reliability?.notes ? (
        <span className="refblock__rel-note" data-testid={`${testId}-reliability-note`}>
          {f.reliability.notes}
        </span>
      ) : null}

      {f.href ? (
        <ExternalUrlLink
          className="refblock__url"
          icon="link"
          testId={`${testId}-url`}
          url={f.href}
        />
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
