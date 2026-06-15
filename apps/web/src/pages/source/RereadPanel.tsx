/**
 * Re-read failing-cards panel (T129 / U7) — the calm aside the source reader shows
 * when opened from a `reread_region` task (`/source/$id?reread=<taskId>`).
 *
 * It is *help, not an alarm*: a quiet `complementary` landmark beside the reading
 * column that names the cards that keep tripping on this region (each with its
 * CURRENT in-window lapse count + a click-through to card detail), offers a single
 * "Mark re-read done" action, and a close control that hides the panel WITHOUT
 * completing the task. No embedded editor — re-extracting uses the reader's existing
 * selection affordance, and rewriting a card happens on its detail page (the T125
 * write barrier). The data is fetched by `SourceReader` and passed down (read-only).
 *
 * UI only: the panel never opens SQLite/fs and never schedules — completion goes
 * through the existing `appApi.completeTask` verb with NO FSRS bump (R7).
 */

import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { appApi, type RereadItemDetailDto } from "../../lib/appApi";

interface RereadPanelProps {
  /** The `reread_region` task element this panel details + completes. */
  readonly taskElementId: string;
  /** The targeted source region (anchor + human label). */
  readonly region: RereadItemDetailDto["region"];
  /** The live failing cards (deduped) with their current in-window lapse counts. */
  readonly members: RereadItemDetailDto["members"];
  /** The window (days) the counts were taken over, for "in {N}d" labeling. */
  readonly windowDays: number;
  /** Hide the panel without completing the task (removes `?reread` from the URL). */
  readonly onClose: () => void;
  /** Called after the task is completed (clears `?reread`; may navigate to the queue). */
  readonly onCompleted: () => void;
}

/**
 * The reader's failing-cards aside. Focus moves to the heading on first render so
 * keyboard users discover it; the "Mark re-read done" action is in-flight guarded
 * so a double-click can't fire two completions.
 */
export function RereadPanel({
  taskElementId,
  region,
  members,
  windowDays,
  onClose,
  onCompleted,
}: RereadPanelProps) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const [completing, setCompleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on mount, cleared on unmount — the canonical StrictMode-safe shape (a
  // cleanup-only reset stays `false` after the dev remount cycle and would silently
  // no-op the post-await guard; see strictmode-mountedref-cleared-only-on-cleanup.md).
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Move focus to the heading on first render so the panel is discoverable.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const onMarkDone = useCallback(async () => {
    if (completing) return;
    setCompleting(true);
    setError(null);
    try {
      // The standard task-complete verb — NEVER a `bumpReviewByDays` (R7: this path
      // must not touch the failing cards' FSRS state). Completion suppresses the
      // proposal for the grace window (the completed task is the memory).
      await appApi.completeTask({ id: taskElementId });
      if (mountedRef.current) onCompleted();
    } catch {
      if (mountedRef.current) {
        setError("Could not mark this re-read done — try again.");
        setCompleting(false);
      }
    }
  }, [completing, onCompleted, taskElementId]);

  return (
    <aside
      className="reread-panel"
      aria-label="Failing cards for this re-read"
      data-testid="reread-panel"
    >
      <div className="reread-panel__head">
        <h2 className="reread-panel__title" tabIndex={-1} ref={headingRef}>
          <Icon name="eye" size={15} /> Re-reading this section
        </h2>
        <button
          type="button"
          className="reread-panel__close"
          aria-label="Close"
          data-testid="reread-panel-close"
          onClick={onClose}
        >
          <Icon name="x" size={15} />
        </button>
      </div>

      <p className="reread-panel__lede">
        These cards keep tripping on <strong>{region.label}</strong>. Re-reading the passage may
        help them settle.
      </p>

      {members.length === 0 ? (
        <p className="reread-panel__empty" data-testid="reread-panel-empty">
          No failing cards remain here — they may have recovered.
        </p>
      ) : (
        <ul className="reread-panel__cards" data-testid="reread-panel-cards">
          {members.map((member) => (
            <li key={member.cardId} className="reread-panel__card">
              <Link
                to="/card/$id"
                params={{ id: member.cardId }}
                className="reread-panel__card-link"
                data-testid="reread-panel-card-link"
              >
                {member.prompt || "Untitled card"}
              </Link>
              <span className="reread-panel__lapses">
                {member.windowLapseCount === 1
                  ? `1 lapse in ${windowDays}d`
                  : `${member.windowLapseCount} lapses in ${windowDays}d`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="reread-panel__actions">
        <button
          type="button"
          className="reread-panel__done"
          data-testid="reread-panel-done"
          disabled={completing}
          onClick={() => void onMarkDone()}
        >
          <Icon name="brain" size={14} /> Mark re-read done
        </button>
      </div>

      {error ? (
        <p className="reread-panel__error" role="status" data-testid="reread-panel-error">
          {error}
        </p>
      ) : null}

      <p className="reread-panel__note">
        To pull a fresh extract, select the text in the passage. To reword a card, open it and edit
        it from its detail page.
      </p>
    </aside>
  );
}
