/**
 * ScheduleMenu (T028/T030) — the explicit reschedule affordance.
 *
 * Where the queue's heuristic `postpone` recedes a non-card attention item by the
 * scheduler's interval, this control lets the user pin it to a precise return:
 * **tomorrow / next week / next month / a manual date** — the four choices T028's
 * "Done when" requires. It is a small popover the queue row + the process loop both
 * mount; selecting a choice fires `onSchedule({ kind })` (or
 * `{ kind: "manual", date }` for the date picker) which flows through the typed
 * `appApi.scheduleQueueItem` → `queue.schedule` bridge command. No scheduling math
 * lives here — the main process computes the date via the pure `AttentionScheduler`.
 *
 * Only shown for non-card attention items (cards schedule on FSRS); the parent
 * gates that. Pure UI — design tokens only, no domain logic.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { QueueScheduleChoice } from "../../lib/appApi";
import { Icon, type IconName } from "../Icon";
import { Tooltip } from "../Tooltip";
import "./schedule-menu.css";

/** The three preset choices, in kit order, with their human label. */
const PRESETS: readonly { kind: "tomorrow" | "nextWeek" | "nextMonth"; label: string }[] = [
  { kind: "tomorrow", label: "Tomorrow" },
  { kind: "nextWeek", label: "Next week" },
  { kind: "nextMonth", label: "Next month" },
];

/** Today's date as a `YYYY-MM-DD` string, for the manual `<input type="date">` min. */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ScheduleMenu({
  disabled,
  onSchedule,
  openSignal,
  triggerClassName = "schedmenu__trigger",
  triggerIcon = "calendar",
  triggerLabel,
  triggerTestId = "schedule-menu-trigger",
  tooltipLabel = "Schedule for later",
  ariaLabel = "Schedule for tomorrow, next week, next month, or a manual date",
}: {
  disabled?: boolean;
  /** Apply one explicit schedule choice (the parent routes it through the bridge). */
  onSchedule: (choice: QueueScheduleChoice) => void;
  /** Increment/change this value to open the menu from an external shortcut. */
  openSignal?: number;
  /** Button class for the trigger; callers can opt into row icon or process-button styling. */
  triggerClassName?: string;
  triggerIcon?: IconName;
  /** Optional visible label. Omit for the compact row icon button. */
  triggerLabel?: string;
  triggerTestId?: string;
  tooltipLabel?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [manualDate, setManualDate] = useState("");
  const rootRef = useRef<HTMLSpanElement>(null);
  const openSignalRef = useRef(openSignal);

  useEffect(() => {
    if (openSignal === undefined || openSignalRef.current === openSignal) return;
    openSignalRef.current = openSignal;
    setOpen(true);
  }, [openSignal]);

  // Close the popover on an outside click or Escape (keyboard-first hygiene).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = useCallback(
    (choice: QueueScheduleChoice) => {
      setOpen(false);
      onSchedule(choice);
    },
    [onSchedule],
  );

  const applyManual = useCallback(() => {
    if (!manualDate) return;
    // Anchor the picked calendar day to noon UTC so the date is stable across the
    // user's timezone (the main process re-normalizes to canonical ISO).
    pick({ kind: "manual", date: `${manualDate}T12:00:00.000Z` });
    setManualDate("");
  }, [manualDate, pick]);

  return (
    <span className="schedmenu" ref={rootRef} data-testid="schedule-menu">
      {/* Styled tooltip on the trigger; suppressed while the menu is open so the
          bubble doesn't sit over the popover it just spawned. */}
      <Tooltip label={tooltipLabel} disabled={open}>
        <button
          type="button"
          className={triggerClassName}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid={triggerTestId}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name={triggerIcon} size={14} />
          {triggerLabel ? <span>{triggerLabel}</span> : null}
        </button>
      </Tooltip>
      {open ? (
        <div className="schedmenu__pop" role="menu" data-testid="schedule-menu-pop">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.kind}
              role="menuitem"
              className="schedmenu__item"
              data-testid={`schedule-${p.kind}`}
              onClick={() => pick({ kind: p.kind })}
            >
              <Icon name="calendar" size={13} />
              {p.label}
            </button>
          ))}
          <div className="schedmenu__manual">
            <input
              type="date"
              className="schedmenu__date"
              min={todayIsoDate()}
              value={manualDate}
              data-testid="schedule-manual-date"
              aria-label="Pick a manual return date"
              onChange={(e) => setManualDate(e.target.value)}
            />
            <button
              type="button"
              className="schedmenu__apply"
              disabled={!manualDate}
              data-testid="schedule-manual-apply"
              onClick={applyManual}
            >
              Set
            </button>
          </div>
        </div>
      ) : null}
    </span>
  );
}
