/**
 * ProcessOverflowMenu — collapses the infrequently-used process actions (Raise,
 * Lower, Delete) behind a single "⋯" affordance in the action bar so the bar
 * stays uncluttered while every action is one click away.
 *
 * Unlike the sibling intent menus (ScheduleMenu / DoneIntentMenu /
 * LineageDeleteMenu), this is a plain anchored action LIST: it dispatches on
 * click and closes. There is no submit-then-await cycle, so it needs none of the
 * in-flight "reset-the-guard-on-busy-settling" machinery — `busy` simply disables
 * the trigger.
 *
 * It mirrors those menus' trigger scaffold (outside-click + Escape close,
 * aria-haspopup/expanded, a styled Tooltip on the icon-only trigger) and adds the
 * ARIA-menu keyboard behavior they lack: focus the first item on open, Arrow
 * Up/Down roving, Tab closes, Escape closes and restores focus to the trigger.
 * The popover opens UPWARD because the action bar sits low in the work area.
 *
 * Delete does not act here. Picking it fires `onDelete`, which the host routes to
 * the descendant-aware LineageDeleteMenu (kept mounted and anchored to this kebab)
 * so the leaf-quiet / branch-confirm flow stays authoritative.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { Tooltip } from "../Tooltip";
import "./process-overflow-menu.css";

export function ProcessOverflowMenu({
  busy = false,
  onAction,
  onDelete,
  triggerTestId = "process-action-more",
}: {
  /** Host-level busy (a mutation is in flight): disables the trigger. */
  busy?: boolean;
  /** Raise / lower priority — routed to the same loop mutation the bar used. */
  onAction: (kind: "raise" | "lower") => void;
  /** Open the descendant-aware delete flow (the host owns the confirm popover). */
  onDelete: () => void;
  triggerTestId?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Focus the first item; preventScroll so opening doesn't yank the reader
    // content (same root cause guarded in DoneIntentMenu / LineageDeleteMenu).
    const items = () =>
      Array.from(popRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-action]") ?? []);
    items()[0]?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "Tab") {
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const list = items();
        if (list.length === 0) return;
        e.preventDefault();
        // biome-ignore lint/complexity/useIndexOf: list is HTMLButtonElement[] but document.activeElement is Element | null; indexOf would require an unsafe cast.
        const idx = list.findIndex((el) => el === document.activeElement);
        const delta = e.key === "ArrowDown" ? 1 : -1;
        list[(idx + delta + list.length) % list.length]?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = useCallback((run: () => void) => {
    setOpen(false);
    run();
  }, []);

  return (
    <span className="pq-overflow" ref={rootRef} data-testid="process-overflow">
      <Tooltip label="More actions" disabled={open}>
        <button
          type="button"
          ref={triggerRef}
          className="pq-btn pq-overflow__trigger"
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More actions"
          data-testid={triggerTestId}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="more" size={16} />
        </button>
      </Tooltip>
      {open ? (
        <div
          className="pq-overflow__pop"
          role="menu"
          ref={popRef}
          data-testid="process-overflow-pop"
        >
          <button
            type="button"
            role="menuitem"
            data-menu-action
            className="pq-overflow__item"
            data-testid="process-action-raise"
            onClick={() => pick(() => onAction("raise"))}
          >
            <Icon name="arrowUp" size={15} />
            Raise priority
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-action
            className="pq-overflow__item"
            data-testid="process-action-lower"
            onClick={() => pick(() => onAction("lower"))}
          >
            <Icon name="arrowDown" size={15} />
            Lower priority
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-action
            className="pq-overflow__item pq-overflow__item--danger"
            data-testid="process-action-delete"
            onClick={() => pick(onDelete)}
          >
            <Icon name="trash" size={15} />
            Delete
          </button>
        </div>
      ) : null}
    </span>
  );
}
