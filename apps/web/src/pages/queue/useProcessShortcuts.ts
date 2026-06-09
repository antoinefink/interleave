/**
 * Process-queue keyboard controls (T031 + T037 inline card review).
 *
 * The "Process queue" loop is built to be mouse-free: this hook binds the loop's
 * CORE keys so a user can grind through ten mixed elements one-handed. The full
 * shortcut catalog + command palette is T048 (and the global `g`-nav / ⌘K live in
 * the shell's `useShellShortcuts`); this only owns the keys that drive THIS loop.
 *
 *   n / → / Space  → next / skip (advance the cursor without mutating)
 *   p              → postpone the current item (opens attention schedule menu; cards postpone)
 *   d              → mark done (a SOURCE opens the done-intent surface; others mark done now)
 *   x              → dismiss
 *   ⌫ / Delete     → delete (soft, undoable)
 *   + / =          → raise priority
 *   -              → lower priority
 *   o / Enter      → open the current item in full (the only navigation)
 *   ⌘Z / Ctrl+Z    → undo the last process action while local undo is available
 *
 * When the current item is a CARD, the loop's review keys take over (consistent
 * with the review session, T037):
 *
 *   Space          → reveal the answer (NOT next/skip)
 *   1 / 2 / 3 / 4  → grade Again / Hard / Good / Easy (only AFTER reveal)
 *
 * Like the shell shortcuts, keys are suppressed while the user is typing in an
 * input/textarea/contenteditable so they never hijack text entry, and chorded
 * modifier presses (⌘/Ctrl/Alt) are ignored so the shell's ⌘K still wins. This is
 * pure UI-interaction wiring — every handler delegates to the loop, which routes
 * through the SAME typed `appApi` mutation path as the queue list / review session
 * (no new channel).
 */

import { useEffect, useRef } from "react";
import type { ReviewRating } from "../../lib/appApi";

/** The keys the process/queue scope binds (the drift-test contract, T048). */
export const PROCESS_BOUND_KEYS: ReadonlySet<string> = new Set([
  "z",
  "n",
  "arrowright",
  " ",
  "1",
  "2",
  "3",
  "4",
  "p",
  "d",
  "x",
  "backspace",
  "delete",
  "+",
  "=",
  "-",
  "o",
  "enter",
]);

/** The actions the loop exposes to the keyboard. */
export interface ProcessShortcutHandlers {
  /** True while a process item is active; false on the done state. */
  canProcess: boolean;
  next(): void;
  postpone(): void;
  markDone(): void;
  dismiss(): void;
  delete(): void;
  raise(): void;
  lower(): void;
  open(): void;
  /** True while the process loop has a pending local undo. */
  canUndo: boolean;
  /** Undo the pending process action, restoring the process cursor. */
  undo(): void;
  /** True when the current item is a CARD (Space reveals; 1–4 grade after reveal). */
  isCard: boolean;
  /** True when the current card's answer has been revealed (gates 1–4 grading). */
  revealed: boolean;
  /** Reveal the current card's answer (Space, while a card is unrevealed). */
  reveal(): void;
  /** Grade the current card (1–4, only after reveal). */
  grade(rating: ReviewRating): void;
}

/** Map the 1–4 number keys to FSRS ratings (the review session's order). */
const GRADE_KEYS: Readonly<Record<string, ReviewRating>> = {
  "1": "again",
  "2": "hard",
  "3": "good",
  "4": "easy",
};

/**
 * Bind the loop's core keys. `enabled` gates the listener (so it is inert on the
 * done state / outside the desktop shell). Handlers are read through a ref so the
 * listener never re-binds on every render.
 */
export function useProcessShortcuts(handlers: ProcessShortcutHandlers, enabled: boolean): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      const typing = tag === "input" || tag === "textarea" || !!target?.isContentEditable;

      const h = ref.current;

      // Local process undo wins over the global command-level undo ONLY while the
      // process loop has a pending recipe. If there is no pending process undo,
      // this capture listener returns without preventing default so the shell's
      // global ⌘Z/Ctrl+Z handler still runs.
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z") {
        if (!typing && h.canUndo) {
          e.preventDefault();
          e.stopImmediatePropagation();
          h.undo();
        }
        return;
      }

      // Never hijack text entry, and let the shell's ⌘K / chorded keys through.
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !h.canProcess) return;

      // Card surface: Space reveals; 1–4 grade after reveal — exactly like the
      // review session. These WIN over next/skip + priority so the card behaves the
      // same in the loop as in /review (no Space→advance collision).
      if (h.isCard) {
        if (e.key === " ") {
          e.preventDefault();
          if (!h.revealed) h.reveal();
          return;
        }
        if (h.revealed) {
          const rating = GRADE_KEYS[e.key];
          if (rating) {
            e.preventDefault();
            h.grade(rating);
            return;
          }
        }
      }

      switch (e.key) {
        case "n":
        case "ArrowRight":
        case " ":
          e.preventDefault();
          h.next();
          break;
        case "p":
          e.preventDefault();
          h.postpone();
          break;
        case "d":
          e.preventDefault();
          h.markDone();
          break;
        case "x":
          e.preventDefault();
          h.dismiss();
          break;
        case "Backspace":
        case "Delete":
          e.preventDefault();
          h.delete();
          break;
        case "+":
        case "=":
          e.preventDefault();
          h.raise();
          break;
        case "-":
          e.preventDefault();
          h.lower();
          break;
        case "o":
        case "Enter":
          e.preventDefault();
          h.open();
          break;
        default:
          break;
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
