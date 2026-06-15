/**
 * LineageDeleteMenu (T135 / U7) — the descendant-aware delete intent surface.
 *
 * Mirrors {@link DoneIntentMenu}: a self-contained, NON-MODAL, keyboard-navigable
 * anchored popover that owns its trigger button + the popover, closes on outside-click
 * / Escape, and focuses the safe default on open. Pressing Delete on an element no
 * longer silently prunes a node that still anchors live work — it first reads the
 * blast radius (`countDescendants`) and then:
 *
 *   • total === 0  → quiet single soft-delete + Undo snackbar, NO popover (R4 fast path).
 *   • count errors → fall through to a safe single soft-delete, surface the error with
 *     no undo (we couldn't quantify the branch). No popover.
 *   • total  >  0  → open the popover quantifying "N extracts, M cards (K with history)"
 *     and offer the honorable intents in the KTD5 order:
 *        1. Mark processed / Done   (extract only; recommended, --ok-soft)
 *           — or Rest / Fallow      (topic only; never calls the extract-only setFate)
 *        2. Keep descendants        (DEFAULT FOCUS; tombstone the node)
 *        3. Delete the whole branch (--danger, last; soft-cascade as one batch)
 *        4. Cancel
 *
 * Keyboard contract: autofocus the safe default (Keep descendants); Tab/arrows cycle the
 * actions in document order; Enter activates the focused action; Esc cancels and returns
 * focus to the trigger. The mutation + undo live in {@link useLineageDelete}; this
 * component only quantifies + routes intent. Server-authoritative: counts and the delete
 * come from IPC. Design tokens only.
 *
 * In-flight-guard pitfall (documented): the guard resets on the host's `busy` SETTLING,
 * not on the popover open→close transition — the fast path resolves WITHOUT opening the
 * popover, so an open→close reset would deadlock the trigger after a failed mutation.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { appApi, type ElementsCountDescendantsResult, isDesktop } from "../../lib/appApi";
import { Icon, type IconName } from "../Icon";
import { Tooltip } from "../Tooltip";
import type { LineageDeleteActions, LineageDeleteTarget } from "./useLineageDelete";
import "./lineage-delete-menu.css";

/** Compose the quantified blast-radius line from the descendant breakdown. */
export function blastRadiusLabel(count: ElementsCountDescendantsResult): string {
  const parts: string[] = [];
  if (count.extracts > 0) {
    parts.push(`${count.extracts} extract${count.extracts === 1 ? "" : "s"}`);
  }
  if (count.cards > 0) {
    const base = `${count.cards} card${count.cards === 1 ? "" : "s"}`;
    parts.push(
      count.cardsWithHistory > 0 ? `${base} (${count.cardsWithHistory} with review history)` : base,
    );
  }
  if (parts.length === 0) return `${count.total} item${count.total === 1 ? "" : "s"}`;
  return parts.join(", ");
}

export function LineageDeleteMenu({
  target,
  actions,
  busy = false,
  triggerSignal,
  triggerClassName,
  triggerIcon = "trash",
  triggerLabel,
  triggerTestId = "lineage-delete-trigger",
  tooltipLabel = "Delete",
  triggerAriaLabel = "Delete",
}: {
  /** The element to delete. `null` disables the trigger (nothing selected). */
  target: LineageDeleteTarget | null;
  /** The shared mutation + undo controller (from {@link useLineageDelete}). */
  actions: LineageDeleteActions;
  /** Host-level busy (a mutation is in flight elsewhere): disables the trigger + choices. */
  busy?: boolean;
  /** Increment/change to run the trigger logic from an external Delete button / shortcut. */
  triggerSignal?: number;
  triggerClassName?: string;
  triggerIcon?: IconName;
  /** Optional visible trigger label; omit for a compact icon-only trigger. */
  triggerLabel?: string;
  triggerTestId?: string;
  tooltipLabel?: string;
  triggerAriaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<ElementsCountDescendantsResult | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const submittingRef = useRef(false);
  const fetchingRef = useRef(false);
  const mountedRef = useRef(false);
  const triggerSignalRef = useRef(triggerSignal);

  const isExtract = target?.type === "extract";
  const isTopic = target?.type === "topic";

  // Set on mount and clear on unmount. Initialising `true` and only clearing on
  // cleanup is wrong under React StrictMode: the dev-only mount→unmount→remount cycle
  // leaves a `useRef(true)` permanently `false` (the ref survives the cycle and the
  // remount never restores it), which silently kills the post-await `mountedRef`
  // guards in `handleTrigger`. Mirrors the correct pattern in ReviewScreen.tsx.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleTrigger = useCallback(async () => {
    // Re-press toggles the popover closed (the cancel affordance).
    if (open) {
      setOpen(false);
      return;
    }
    if (!target || busy || !isDesktop() || fetchingRef.current || submittingRef.current) return;
    fetchingRef.current = true;
    try {
      let result: ElementsCountDescendantsResult;
      try {
        result = await appApi.countDescendants({ id: target.id });
      } catch (e) {
        // R4 error path: fall through to a safe single soft-delete, surface the error.
        if (!mountedRef.current) return;
        submittingRef.current = true;
        actions.quietAfterCountError(target, e instanceof Error ? e.message : String(e));
        return;
      }
      if (!mountedRef.current) return;
      if (result.total === 0) {
        // R4 fast path: a leaf — quiet single soft-delete + Undo snackbar, no popover.
        submittingRef.current = true;
        actions.quiet(target);
        return;
      }
      setCount(result);
      setOpen(true);
    } finally {
      fetchingRef.current = false;
    }
  }, [open, target, busy, actions]);

  // External trigger (a host Delete button / keyboard shortcut): same click logic.
  useEffect(() => {
    if (triggerSignal === undefined || triggerSignalRef.current === triggerSignal) return;
    triggerSignalRef.current = triggerSignal;
    void handleTrigger();
  }, [triggerSignal, handleTrigger]);

  // Release the in-flight guards once the host's action settles (`busy` back to false).
  // The fast path resolves WITHOUT opening the popover, so the guard can't key off an
  // open→close transition; gating on `busy` clears it after the mutation succeeds OR
  // fails so the Delete control never deadlocks.
  useEffect(() => {
    if (!busy) {
      submittingRef.current = false;
      fetchingRef.current = false;
    }
  }, [busy]);

  // Focus the safe default (Keep descendants) on open; close on outside-click / Escape,
  // restoring focus to the trigger on Escape (keyboard-first; non-modal, no focus trap).
  // Tab/arrows cycle the actions in document order.
  useEffect(() => {
    if (!open) return;
    keepRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const items = Array.from(
          popRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-action]") ?? [],
        );
        if (items.length === 0) return;
        e.preventDefault();
        // biome-ignore lint/complexity/useIndexOf: items is HTMLButtonElement[] but document.activeElement is Element | null; indexOf would require an unsafe cast.
        const idx = items.findIndex((el) => el === document.activeElement);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = items[(idx + delta + items.length) % items.length];
        next?.focus();
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
    (run: () => void) => {
      if (submittingRef.current || !target) return;
      submittingRef.current = true;
      setOpen(false);
      run();
    },
    [target],
  );

  const radius = count ? blastRadiusLabel(count) : "";

  return (
    <span className="lindel" ref={rootRef} data-testid="lineage-delete">
      <Tooltip label={tooltipLabel} disabled={open}>
        <button
          type="button"
          ref={triggerRef}
          className={triggerClassName ?? "lindel__trigger"}
          disabled={busy || !target}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-busy={busy || fetchingRef.current ? "true" : undefined}
          aria-label={triggerAriaLabel}
          data-testid={triggerTestId}
          onClick={() => void handleTrigger()}
        >
          <Icon name={triggerIcon} size={14} />
          {triggerLabel ? <span>{triggerLabel}</span> : null}
        </button>
      </Tooltip>
      {open && count && target ? (
        <div
          className="lindel__pop"
          ref={popRef}
          role="dialog"
          aria-modal="false"
          aria-label={`Delete — ${radius} beneath this ${target.type}`}
          data-testid="lineage-delete-pop"
        >
          <div className="lindel__head">
            <span className="lindel__count" data-testid="lineage-delete-radius">
              {radius} beneath this {target.type}
            </span>
          </div>
          <div className="lindel__choices">
            {/* 1. Honorable alternative — recommended. Extract → Mark processed; Topic →
                Rest / Fallow. Offered for NO other type (and setFate never runs on a topic). */}
            {isExtract ? (
              <button
                type="button"
                data-menu-action
                className="lindel__choice lindel__choice--ok"
                data-testid="lineage-delete-mark-done"
                disabled={busy}
                onClick={() => choose(() => actions.markProcessed(target))}
              >
                <Icon name="checkCircle" size={15} />
                <span className="lindel__choice-text">
                  <span className="lindel__choice-title">
                    <span className="lindel__choice-label">Mark processed</span>
                    <span className="lindel__choice-badge">Recommended</span>
                  </span>
                  <span className="lindel__choice-hint">
                    Keep it as provenance, drop from queue
                  </span>
                </span>
              </button>
            ) : isTopic ? (
              <button
                type="button"
                data-menu-action
                className="lindel__choice lindel__choice--ok"
                data-testid="lineage-delete-rest"
                disabled={busy}
                onClick={() => choose(() => actions.restTopic(target))}
              >
                <Icon name="pause" size={15} />
                <span className="lindel__choice-text">
                  <span className="lindel__choice-title">
                    <span className="lindel__choice-label">Rest topic</span>
                    <span className="lindel__choice-badge">Recommended</span>
                  </span>
                  <span className="lindel__choice-hint">Let it lie fallow instead of deleting</span>
                </span>
              </button>
            ) : null}

            {/* 2. Keep descendants — the SAFE default (autofocused). */}
            <button
              type="button"
              data-menu-action
              ref={keepRef}
              className="lindel__choice"
              data-testid="lineage-delete-keep"
              disabled={busy}
              onClick={() => choose(() => actions.keepDescendants(target, count))}
            >
              <Icon name="layers" size={15} />
              <span className="lindel__choice-text">
                <span className="lindel__choice-title">
                  <span className="lindel__choice-label">Keep descendants</span>
                </span>
                <span className="lindel__choice-hint">
                  Delete this only; its {count.total} item{count.total === 1 ? "" : "s"} stay
                </span>
              </span>
            </button>

            {/* 3. Delete the whole branch — destructive, last. */}
            <button
              type="button"
              data-menu-action
              className="lindel__choice lindel__choice--danger"
              data-testid="lineage-delete-branch"
              disabled={busy}
              onClick={() => choose(() => actions.deleteBranch(target))}
            >
              <Icon name="trash" size={15} />
              <span className="lindel__choice-text">
                <span className="lindel__choice-title">
                  <span className="lindel__choice-label">Delete the whole branch</span>
                </span>
                <span className="lindel__choice-hint">
                  Remove this and all {count.total} item{count.total === 1 ? "" : "s"} (recoverable)
                </span>
              </span>
            </button>

            {/* 4. Cancel. */}
            <button
              type="button"
              data-menu-action
              className="lindel__choice lindel__choice--cancel"
              data-testid="lineage-delete-cancel"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <Icon name="x" size={15} />
              <span className="lindel__choice-text">
                <span className="lindel__choice-title">
                  <span className="lindel__choice-label">Cancel</span>
                </span>
              </span>
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
