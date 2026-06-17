/**
 * DoneIntentMenu — the partial-source "Done" intent surface.
 *
 * Replaces the native `window.confirm("N unresolved blocks. Mark it done anyway?")` at the
 * three done-gate call sites (the in-session queue loop, the queue list rows, and the
 * standalone reader) with ONE shared, non-modal, keyboard-navigable popover. Pressing Done
 * on a source that still has unresolved blocks no longer asks a scary yes/no — it offers the
 * three real intents, defaulting focus to the safe one:
 *
 *   • Return later (default) — postpone; keep the read-point, stay in rotation
 *   • Finished               — mark done (the server gate's confirm override is passed)
 *   • Abandon                — dismiss; drop it from the queue
 *
 * Self-contained like {@link ScheduleMenu}: it owns its trigger button + the anchored popover,
 * closes on outside-click / Escape, and focuses the default choice on open. It adds a
 * `getSummary` callback so the FAST PATH (0 unresolved → mark done with no popover) lives in
 * one place rather than being re-derived at each site, and a `triggerSignal` so a keyboard
 * shortcut (`d`) can run the exact same click logic. `forceOpenSignal` is the proactive-review
 * path: it opens the surface even for a zero-unresolved source, labels a suggested choice, and
 * never resolves without an explicit click. An internal in-flight guard drops a double-submit
 * regardless of the host's busy model.
 *
 * The server gate stays authoritative: "Finished" routes through the host's `onResolved`, which
 * calls `markDone` with the `confirmUnresolvedBlocks` override — this component never decides
 * completion, it only collects intent and renders an honest per-state breakdown. Pure UI +
 * one summary read; design tokens only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { SourceBlockProcessingSummaryPayload } from "../../lib/appApi";
import {
  describeReverifyOutputs,
  describeUnresolved,
  pluralizeBlocks,
} from "../../pages/queue/doneIntentBreakdown";
import { Icon, type IconName } from "../Icon";
import { Tooltip } from "../Tooltip";
import "./done-intent-menu.css";

/** The three outcome intents the surface collects; the host maps them to mutations. */
export type DoneIntent = "later" | "finished" | "abandon";

const CHOICES: readonly {
  intent: DoneIntent;
  icon: IconName;
  label: string;
  hint: string;
  testId: string;
  danger?: boolean;
}[] = [
  {
    intent: "later",
    icon: "postpone",
    label: "Return later",
    hint: "Keep it in rotation",
    testId: "done-intent-later",
  },
  {
    intent: "finished",
    icon: "checkCircle",
    label: "Finished",
    hint: "Done with this source",
    testId: "done-intent-finished",
  },
  {
    intent: "abandon",
    icon: "x",
    label: "Abandon",
    hint: "Drop it from the queue",
    testId: "done-intent-abandon",
    danger: true,
  },
];

export function DoneIntentMenu({
  getSummary,
  onResolved,
  busy = false,
  resumeLabel = null,
  triggerSignal,
  forceOpenSignal,
  suggestedIntent = null,
  triggerClassName = "doneintent__trigger",
  triggerIcon = "check",
  triggerLabel,
  triggerTestId = "done-intent-trigger",
  tooltipLabel = "Mark done",
  triggerAriaLabel = "Mark done",
}: {
  /**
   * Fetch the current block-processing summary for the source. Returns `null` to abort
   * silently (e.g. a failed read the host already surfaced). Drives the fast path: when
   * `canMarkDoneWithoutConfirmation` is true the surface marks done immediately with no popover.
   */
  getSummary: () => Promise<SourceBlockProcessingSummaryPayload | null>;
  /** Apply one chosen intent. The host owns the mutation, post-action, and undo. */
  onResolved: (intent: DoneIntent) => void;
  /** Host-level busy (in flight elsewhere): disables the trigger and choices. */
  busy?: boolean;
  /** Optional resume location ("block N of M"); omitted when no read-point exists. */
  resumeLabel?: string | null;
  /** Increment/change to run the trigger logic from an external shortcut (the `d` key). */
  triggerSignal?: number;
  /**
   * Increment/change to force the popover open from a proactive review nudge. Unlike the
   * normal trigger path, this never fast-path resolves `finished`.
   */
  forceOpenSignal?: number;
  /** Visually and accessibly marks one choice as suggested without changing focus/defaults. */
  suggestedIntent?: DoneIntent | null;
  triggerClassName?: string;
  triggerIcon?: IconName;
  /** Optional visible label; omit for a compact icon-only trigger. */
  triggerLabel?: string;
  triggerTestId?: string;
  tooltipLabel?: string;
  triggerAriaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<SourceBlockProcessingSummaryPayload | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const laterRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const fetchingRef = useRef(false);
  const mountedRef = useRef(false);
  const busyRef = useRef(busy);
  const triggerSignalRef = useRef(triggerSignal);
  const forceOpenSignalRef = useRef(forceOpenSignal);
  const suggestedIntentRef = useRef(suggestedIntent);
  const forceOpenRequestRef = useRef(0);

  // Set on mount and clear on unmount. Initialising `true` and only clearing on cleanup
  // is wrong under React StrictMode: the dev-only mount→unmount→remount cycle leaves a
  // `useRef(true)` permanently `false`, silently killing the post-await `mountedRef` guard
  // in `handleTrigger`. Mirrors the correct pattern in ReviewScreen.tsx.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      forceOpenRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    busyRef.current = busy;
    if (busy) forceOpenRequestRef.current += 1;
  }, [busy]);

  useEffect(() => {
    if (suggestedIntentRef.current === suggestedIntent) return;
    suggestedIntentRef.current = suggestedIntent;
    forceOpenRequestRef.current += 1;
  }, [suggestedIntent]);

  const handleTrigger = useCallback(async () => {
    // Re-press toggles the popover closed (matches the `d`/click cancel affordance).
    if (open) {
      setOpen(false);
      return;
    }
    if (busy || fetchingRef.current || submittingRef.current) return;
    fetchingRef.current = true;
    try {
      const s = await getSummary();
      // The fetch may resolve after the host navigated away (reader Finished/Abandon
      // unmounts this surface); bail before touching state on a dead component.
      if (!mountedRef.current) return;
      if (!s) return;
      if (s.canMarkDoneWithoutConfirmation) {
        // Fast path: nothing unresolved — mark done immediately, no surface.
        submittingRef.current = true;
        onResolved("finished");
        return;
      }
      setSummary(s);
      setOpen(true);
    } finally {
      fetchingRef.current = false;
    }
  }, [open, busy, getSummary, onResolved]);

  const handleForceOpen = useCallback(async () => {
    const requestId = forceOpenRequestRef.current + 1;
    forceOpenRequestRef.current = requestId;
    if (busy || fetchingRef.current || submittingRef.current) return;
    fetchingRef.current = true;
    try {
      const s = await getSummary();
      if (!mountedRef.current) return;
      if (forceOpenRequestRef.current !== requestId || busyRef.current) return;
      if (!s) return;
      setSummary(s);
      setOpen(true);
    } finally {
      fetchingRef.current = false;
    }
  }, [busy, getSummary]);

  // External trigger (keyboard `d`): run the SAME click logic (fetch → fast-path or open).
  useEffect(() => {
    if (triggerSignal === undefined || triggerSignalRef.current === triggerSignal) return;
    triggerSignalRef.current = triggerSignal;
    void handleTrigger();
  }, [triggerSignal, handleTrigger]);

  // Proactive review trigger: fetch and open, but never auto-resolve finished.
  useEffect(() => {
    if (forceOpenSignal === undefined || forceOpenSignalRef.current === forceOpenSignal) return;
    forceOpenSignalRef.current = forceOpenSignal;
    void handleForceOpen();
  }, [forceOpenSignal, handleForceOpen]);

  // Release the in-flight guards once the host's action has settled (`busy` back to
  // false). The fast path resolves WITHOUT opening the popover, so the guard can't rely
  // on an open→close transition; gating on `busy` reliably clears it after the host
  // mutation succeeds OR fails (e.g. a rejected markDone), so the Done control never
  // deadlocks and a retry stays possible. `busy` is held while the host action runs, so
  // the guard still blocks a double-submit during the in-flight window.
  useEffect(() => {
    if (!busy) {
      submittingRef.current = false;
      fetchingRef.current = false;
    }
  }, [busy]);

  // Focus the default (Return later) on open; close on outside-click / Escape, restoring
  // focus to the trigger on Escape (keyboard-first hygiene; non-modal so no focus trap).
  // `preventScroll` is intentional: the popover sits below a clipped flex column, so a plain
  // focus() would scroll the reading content up to reveal the button instead of hovering.
  useEffect(() => {
    if (!open) return;
    laterRef.current?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = useCallback(
    (intent: DoneIntent) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setOpen(false);
      onResolved(intent);
    },
    [onResolved],
  );

  const segments = summary ? describeUnresolved(summary.stateCounts) : [];
  const reverify = summary ? describeReverifyOutputs(summary.needsReverifyOutputs) : null;

  return (
    <span className="doneintent" ref={rootRef} data-testid="done-intent">
      <Tooltip label={tooltipLabel} disabled={open}>
        <button
          type="button"
          ref={triggerRef}
          className={triggerClassName}
          disabled={busy}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={triggerAriaLabel}
          data-testid={triggerTestId}
          onClick={() => void handleTrigger()}
        >
          <Icon name={triggerIcon} size={14} />
          {triggerLabel ? <span>{triggerLabel}</span> : null}
        </button>
      </Tooltip>
      {open && summary ? (
        <div
          className="doneintent__pop"
          role="dialog"
          aria-modal="false"
          aria-label={`Mark done — ${pluralizeBlocks(summary.unresolvedBlocks)} still open`}
          data-testid="done-intent-pop"
        >
          <div className="doneintent__head">
            <span className="doneintent__count">
              {pluralizeBlocks(summary.unresolvedBlocks)} still open
            </span>
            {resumeLabel ? (
              <span className="doneintent__resume" data-testid="done-intent-resume">
                {resumeLabel}
              </span>
            ) : null}
          </div>
          {segments.length > 0 || reverify ? (
            <ul className="doneintent__breakdown" data-testid="done-intent-breakdown">
              {segments.map((s) => (
                <li key={s.key}>
                  <span className="doneintent__seg-count">{s.count}</span> {s.label}
                </li>
              ))}
              {reverify ? (
                <li key="needs-reverify" data-testid="done-intent-reverify">
                  <span className="doneintent__seg-count">{reverify.count}</span> {reverify.label}
                </li>
              ) : null}
            </ul>
          ) : null}
          <div className="doneintent__choices">
            {CHOICES.map((c) => (
              <button
                type="button"
                key={c.intent}
                ref={c.intent === "later" ? laterRef : undefined}
                className={`doneintent__choice${c.danger ? " doneintent__choice--danger" : ""}`}
                data-testid={c.testId}
                disabled={busy}
                onClick={() => choose(c.intent)}
              >
                <Icon name={c.icon} size={15} />
                <span className="doneintent__choice-text">
                  <span className="doneintent__choice-title">
                    <span className="doneintent__choice-label">{c.label}</span>
                    {suggestedIntent === c.intent ? (
                      <span className="doneintent__choice-badge">Suggested</span>
                    ) : null}
                  </span>
                  <span className="doneintent__choice-hint">{c.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </span>
  );
}
