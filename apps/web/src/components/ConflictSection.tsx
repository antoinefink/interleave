/**
 * ConflictSection (T089) — the calm "possible conflict" surface.
 *
 * Renders the DERIVED, HEURISTIC, SUGGESTIVE possible-conflict flags for an element
 * (from `semantic.contradictions`): highly-similar cards/extracts that ALSO carry an
 * opposing/superseding signal (negation, numeric divergence, a newer source). It is a
 * PROMPT to the user's judgment, never an automatic correction:
 *
 *  - the copy says "Possible conflict — review", NEVER "conflict";
 *  - it is an unobtrusive chip/row, NOT a blocking modal;
 *  - clicking it opens a small compare view (both items' sources + the reasons), with
 *    open-both / dismiss actions;
 *  - **dismiss is LOCAL UI state** for now (a persisted "not a conflict"
 *    acknowledgement is DEFERRED to a later task) — a dismissed flag re-derives after
 *    an app restart;
 *  - it NEVER edits/suspends/reschedules the card (the flag is read-only).
 *
 * The answer-leak guard is the CALLER's responsibility: in review this is rendered
 * ONLY post-reveal (never on the hidden-answer face), mirroring the refblock reveal
 * gate. Pure UI — one command (fetched by the caller / here), no SQL/vectors in React.
 */

import { useEffect, useState } from "react";
import {
  appApi,
  type ContradictionFlagView,
  type ContradictionReason,
  isDesktop,
} from "../lib/appApi";
import { Icon } from "./Icon";
import { RefBlock } from "./RefBlock";
import "./conflict-section.css";

/** Human-readable label for an opposing/superseding reason. */
function reasonLabel(reason: ContradictionReason): string {
  switch (reason) {
    case "negation":
      return "opposing wording";
    case "numeric":
      return "differing numbers";
    case "recency":
      return "newer source";
  }
}

/** A short explanation line for the compare view (suggestive, never definitive). */
function explain(flag: ContradictionFlagView): string {
  const parts = flag.reasons.map(reasonLabel);
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  if (flag.newerSide) {
    const newer = flag.newerSide === "other" ? "the related item" : "this item";
    return `A possible disagreement (${list}); ${newer}'s source is newer and may supersede the other.`;
  }
  return `A possible disagreement (${list}). Review both and decide.`;
}

/** One expandable possible-conflict flag (chip → compare view). */
function ConflictFlag({
  flag,
  onOpen,
}: {
  flag: ContradictionFlagView;
  onOpen?: (id: string) => void;
}) {
  // Dismiss is LOCAL UI state for now (deferred persisted acknowledgement) — see the
  // module docblock. A dismissed flag re-derives after an app restart.
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (dismissed) return null;

  return (
    <div className="conflict-flag" data-testid="conflict-flag" data-element-id={flag.otherId}>
      <button
        type="button"
        className="conflict-flag__chip"
        data-testid="conflict-flag-chip"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <Icon name="warning" size={13} />
        <span className="conflict-flag__label">Possible conflict</span>
        <span className="conflict-flag__title" title={flag.otherTitle}>
          {flag.otherTitle || "Untitled"}
        </span>
        <Icon name={expanded ? "chevronDown" : "chevronRight"} size={13} />
      </button>

      {expanded ? (
        <div className="conflict-flag__compare" data-testid="conflict-flag-compare">
          <p className="conflict-flag__explain" data-testid="conflict-flag-explain">
            {explain(flag)}
          </p>

          <div className="conflict-flag__sides">
            <div className="conflict-flag__side">
              <div className="conflict-flag__side-label">This item</div>
              <RefBlock ref={flag.selfRef} testId="conflict-self-ref" showSnippet={false} />
            </div>
            <div className="conflict-flag__side">
              <div className="conflict-flag__side-label">{flag.otherTitle || "Related item"}</div>
              <RefBlock ref={flag.otherRef} testId="conflict-other-ref" showSnippet={false} />
            </div>
          </div>

          <div className="conflict-flag__actions">
            {onOpen ? (
              <button
                type="button"
                className="conflict-flag__action"
                data-testid="conflict-flag-open"
                onClick={() => onOpen(flag.otherId)}
              >
                <Icon name="external" size={12} />
                Open related item
              </button>
            ) : null}
            <button
              type="button"
              className="conflict-flag__action conflict-flag__action--dismiss"
              data-testid="conflict-flag-dismiss"
              onClick={() => setDismissed(true)}
            >
              <Icon name="x" size={12} />
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The possible-conflict surface for an element. Fetches the flags through the typed
 * `semantic.contradictions` bridge (or accepts pre-fetched `flags`), and renders one
 * expandable chip per flag. Shows NOTHING when there are no flags (semantics off /
 * nothing conflicts) — the calm default.
 *
 * `variant="inspector"` wraps the flags in an `insp-sec`; `variant="inline"` (review)
 * renders just the flags so the caller controls placement (post-reveal only).
 */
export function ConflictSection({
  elementId,
  flags: providedFlags,
  variant = "inspector",
  onOpen,
}: {
  /** Fetch flags for this element (ignored when `flags` is provided). */
  readonly elementId?: string;
  /** Pre-fetched flags (e.g. the review screen already has them) — skips the fetch. */
  readonly flags?: readonly ContradictionFlagView[];
  readonly variant?: "inspector" | "inline";
  /** Navigate to the conflicting element (open-both affordance). */
  readonly onOpen?: (id: string) => void;
}) {
  const [fetched, setFetched] = useState<readonly ContradictionFlagView[] | null>(
    providedFlags ?? null,
  );

  useEffect(() => {
    if (providedFlags !== undefined) {
      setFetched(providedFlags);
      return;
    }
    if (!elementId || !isDesktop()) return;
    // Defensive: degrade silently if the bridge method is absent (a non-desktop
    // host, or a test that mocks only a subset of `appApi`) — never crash a caller.
    if (typeof appApi.semanticContradictions !== "function") return;
    let cancelled = false;
    appApi
      .semanticContradictions({ elementId })
      .then((res) => {
        if (!cancelled) setFetched(res.flags);
      })
      .catch(() => {
        if (!cancelled) setFetched([]);
      });
    return () => {
      cancelled = true;
    };
  }, [elementId, providedFlags]);

  const flags = fetched ?? [];
  if (flags.length === 0) return null;

  const body = (
    <div className="conflict-list" data-testid="conflict-list">
      {flags.map((flag) => (
        <ConflictFlag key={flag.otherId} flag={flag} {...(onOpen ? { onOpen } : {})} />
      ))}
    </div>
  );

  if (variant === "inline") {
    return (
      <div className="conflict-inline" data-testid="conflict-section-inline">
        {body}
      </div>
    );
  }

  return (
    <div className="insp-sec" data-testid="conflict-section">
      <div className="insp-sec__title">Possible conflicts</div>
      {body}
    </div>
  );
}
