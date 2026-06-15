/**
 * Inbox triage keyboard scope (T126 — U6).
 *
 * The inbox is the app's real "triage" surface: a 50-item morning must be
 * dispatchable WITHOUT the mouse. This hook owns the `"triage"` scope's keys —
 * the registry (`shortcuts.ts`) declares them once under `scope:"triage"` and the
 * drift test scans THIS source to prove every declared cap is actually bound here
 * (so the keys live in a dedicated, `?raw`-scannable file, not inline in the
 * 1000-line `InboxScreen`).
 *
 * The keymap (all collision-checked against the global + reader/review/queue
 * scopes — see the plan's U6 collision table):
 *
 *   j / ArrowDown        → move the roving cursor down
 *   k / ArrowUp          → move the roving cursor up
 *   Shift+j / Shift+k    → extend the contiguous range from the anchor down / up
 *   x / Space            → toggle the cursor row in / out of the selected set
 *   s                    → select the rest of the cursor's group (cheap group sweep —
 *                          a 30-item group needs ONE keypress, not 30)
 *   ⌘a / Ctrl+a          → select all (capped main-side at 1000) — ⌘a avoids a
 *                          collision with the bare `a` priority-band key
 *   Escape               → clear the whole selection
 *   1 / 2 / 3 / 6        → the four triage verbs (Read now / Queue soon /
 *                          Save for later / Delete) — migrated from the old inline
 *                          handler
 *   a / b / c / d        → arm the A/B/C/D priority band (rides with the next verb
 *                          in one batch, or commits alone via "Set priority")
 *   Enter                → accept the cursor row's SUGGESTED priority band (T127) —
 *                          a no-op when the row carries no suggestion. Enter is free
 *                          in this scope (a/b/c/d + 1/2/3/6 + the selection keys are
 *                          all taken), so it is the dedicated accept key.
 *
 * The verb keys operate on the SELECTION SET when it is non-empty, FALLING BACK to
 * the cursor row (today's single-item behavior) when the set is empty — so the
 * keyboard never silently widens a single-item triage into a list sweep.
 *
 * `⌘Z` is deliberately NOT bound here: global undo fires BEFORE the scope gate in
 * `useShellShortcuts`, so binding it would only fight the always-available global
 * undo. The same is true for `⌘k` / `/` / `?` / the `g`-prefix nav — those stay
 * global, so this hook leaves them untouched.
 *
 * Like the other scope hooks (`useProcessShortcuts`), keys are suppressed while the
 * user types in an input/textarea/contenteditable/select, and chorded modifier
 * presses (other than the explicit `⌘a` select-all) fall through so the shell's
 * `⌘k` / `⌘z` still win. Handlers are read through a ref so the listener never
 * re-binds per render. This is pure UI-interaction wiring — every verb / band /
 * selection handler delegates to the SAME callbacks the on-screen buttons call.
 */

import { useEffect, useRef } from "react";
import type { PriorityLabelInput } from "../../lib/appApi";
/** The actions the inbox triage scope binds to the keyboard. */
export interface InboxTriageShortcutHandlers {
  /** Move the roving cursor by one row (clamped at the list ends). */
  moveCursor(delta: 1 | -1): void;
  /** Extend the contiguous range from the anchor by one row in `delta`'s direction. */
  extendRange(delta: 1 | -1): void;
  /** Toggle the current cursor row in / out of the selected set. */
  toggleCursorRow(): void;
  /** Select every remaining row in the cursor's group (one keypress per group). */
  selectRestOfGroup(): void;
  /** Select the whole visible inbox (the parent caps the request main-side). */
  selectAll(): void;
  /** Whether anything is selected — gates Escape so it stays free to close overlays. */
  hasSelection(): boolean;
  /** Clear the entire selection (+ the armed band + the shift anchor). */
  clearSelection(): void;
  /**
   * Fire a triage verb. Operates on the selection set when non-empty, else the
   * cursor row — the parent owns that fallback so the single-item path is unchanged.
   */
  triageVerb(kind: "accept" | "queueSoon" | "keepForLater" | "delete"): void;
  /** Arm / disarm a priority band (rides with the next verb, or "Set priority"). */
  armPriority(label: PriorityLabelInput): void;
  /**
   * Accept the cursor row's suggested priority band (T127 — U6). The parent re-reads
   * the live suggestion; a cursor row with no suggestion makes this a no-op.
   */
  acceptSuggestion(): void;
}

/** Map a band letter key to its A/B/C/D label. */
const BAND_KEYS: Readonly<Record<string, PriorityLabelInput>> = {
  a: "A",
  b: "B",
  c: "C",
  d: "D",
};

/** Map a verb number key to its triage verb (1/2/3/6 — mirrors the kit's hints). */
const VERB_KEYS: Readonly<Record<string, "accept" | "queueSoon" | "keepForLater" | "delete">> = {
  "1": "accept",
  "2": "queueSoon",
  "3": "keepForLater",
  "6": "delete",
};

/**
 * The keys this scope binds (the drift-test contract, T126). Exported so the
 * (renderer) drift guard can read the literal keycaps the registry claims — note
 * this is informational; the test scans the SOURCE of this module for each cap.
 */
export const INBOX_TRIAGE_BOUND_KEYS: ReadonlySet<string> = new Set([
  "j",
  "arrowdown",
  "k",
  "arrowup",
  "x",
  " ",
  "s",
  "a",
  "escape",
  "enter",
  "1",
  "2",
  "3",
  "6",
  "b",
  "c",
  "d",
]);

/**
 * Bind the inbox triage scope's keys. `enabled` gates the listener (so it is inert
 * outside the desktop shell, while a modal is open, or when the screen is not the
 * active triage surface). Handlers are read through a ref so the listener never
 * re-binds on every render.
 *
 * The keymap is axis-agnostic (select-rest-of-group walks the cursor's rendered group
 * regardless of group-by axis), so the hook does not read the axis.
 */
export function useInboxTriageShortcuts(
  handlers: InboxTriageShortcutHandlers,
  enabled: boolean,
): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      const typing =
        tag === "input" || tag === "textarea" || tag === "select" || !!target?.isContentEditable;
      if (typing) return;

      const h = ref.current;
      const key = e.key;
      const lower = key.toLowerCase();

      // ⌘a / Ctrl+a → select all. The ONLY chord this scope owns; it wins over the
      // bare `a` priority-band key precisely so select-all and band-A never clash.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && lower === "a") {
        e.preventDefault();
        h.selectAll();
        return;
      }

      // Every other chord (⌘k / ⌘z / ⌘b / ⌘…) belongs to the global shell — never
      // hijack it. ⌘z stays global undo (it fires before the scope gate anyway).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Range-extend (Shift+j / Shift+k) BEFORE the bare cursor moves, so a held
      // Shift extends the selection rather than just walking the cursor.
      if (e.shiftKey) {
        if (lower === "j") {
          e.preventDefault();
          h.extendRange(1);
          return;
        }
        if (lower === "k") {
          e.preventDefault();
          h.extendRange(-1);
          return;
        }
        // A lone Shift + an unbound key falls through to the global handler.
        return;
      }

      switch (key) {
        case "j":
        case "ArrowDown":
          e.preventDefault();
          h.moveCursor(1);
          return;
        case "k":
        case "ArrowUp":
          e.preventDefault();
          h.moveCursor(-1);
          return;
        case "x":
        case " ":
          e.preventDefault();
          h.toggleCursorRow();
          return;
        case "s":
          e.preventDefault();
          h.selectRestOfGroup();
          return;
        case "Enter":
          // Accept the cursor row's suggested band (T127). A no-op when the row has
          // no suggestion — the parent re-reads the live suggestion and bails.
          e.preventDefault();
          h.acceptSuggestion();
          return;
        case "Escape":
          // Only consume Escape when there is something to clear (so it stays
          // available to close a popover / overlay otherwise).
          if (h.hasSelection()) {
            e.preventDefault();
            h.clearSelection();
          }
          return;
        default:
          break;
      }

      // Triage verbs (1/2/3/6) — the set when non-empty, else the cursor row.
      const verb = VERB_KEYS[key];
      if (verb) {
        e.preventDefault();
        h.triageVerb(verb);
        return;
      }

      // Priority bands (a/b/c/d) — a pure arm toggle (no IPC on its own).
      const band = BAND_KEYS[lower];
      if (band) {
        e.preventDefault();
        h.armPriority(band);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
