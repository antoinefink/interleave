/**
 * Global shell keyboard shortcuts (T004, extended in T048).
 *
 * Wires the keyboard-first chrome described in the charter:
 *   - ⌘K / Ctrl+K  → toggle the command palette
 *   - ⌘Z / Ctrl+Z  → general command-level undo (T044 — reverse the last op)
 *   - ⌘B / Ctrl+B  → create a backup now (T050 — same command as the prompt/menu)
 *   - ⌘← / Ctrl+←  → navigate BACK through page history
 *   - ⌘→ / Ctrl+→  → navigate FORWARD through page history
 *   - ?            → toggle the cheat sheet
 *   - g then <key> → quick-navigate (g q → /queue, g r → /review, …)
 *   - /            → open search (T048 — routes to /search)
 *   - o            → open the selected element's SOURCE (jump-to-source, T022/T048)
 *   - u            → open the selected element's PARENT (T048)
 *   - + / =        → raise the selected element's priority (T027/T048)
 *   - -            → lower the selected element's priority (T027/T048)
 *
 * The element-targeted keys (`o`/`u`/`+`/`-`) act on the SHELL'S CURRENT SELECTION
 * (the `useSelection` id every screen sets) and delegate to handlers the caller
 * supplies — those handlers call the EXACT same typed `window.appApi` command as
 * the inspector's on-screen buttons (`setElementPriority`, `getLineage`,
 * `navigateToLocation`). There is no second mutation path; this hook only
 * DISPATCHES. Per-screen surfaces own their own keys (the reader's `E`/`C`/`H`/`␣`,
 * the review `␣`/`1–4`, the queue loop's `n`/`p`/`d`/`x`/`⌫`); this global handler
 * deliberately does NOT bind those, so it never fights the scope hook that owns the
 * active surface.
 *
 * Shortcuts are suppressed while the user is typing in an input/textarea/
 * contenteditable so they never hijack text entry (⌘Z still reaches the native
 * field undo there — the global undo only fires outside text entry). The `g`-prefix
 * uses a short pending window (matching the kit's 700ms) rather than a global
 * mutable, kept in a ref so re-renders don't reset it.
 *
 * This is UI-interaction wiring, not domain logic — navigation + the element
 * actions are delegated to the caller.
 */
import { useEffect, useRef } from "react";
import { hasActiveScope } from "./activeScope";
import { GOTO_MAP } from "./nav";

export type ShellShortcutHandlers = {
  toggleCommandPalette: () => void;
  toggleCheatSheet: () => void;
  onNavigate: (to: string) => void;
  /** General command-level undo (T044) — ⌘Z/Ctrl+Z outside text entry. */
  onUndo: () => void;
  /** Create a backup now (T050) — ⌘B/Ctrl+B; same command as the prompt/menu. */
  onCreateBackup: () => void;
  /** Open search (T048) — `/` focuses/opens the search surface. */
  onSearch: () => void;
  /** Open the selected element's source (T048) — `o`. No-op if nothing selected. */
  onOpenSource: () => void;
  /** Open the selected element's parent (T048) — `u`. No-op if nothing selected. */
  onOpenParent: () => void;
  /** Raise the selected element's priority (T048) — `+`/`=`. No-op if none selected. */
  onRaisePriority: () => void;
  /** Lower the selected element's priority (T048) — `-`. No-op if none selected. */
  onLowerPriority: () => void;
  /** Navigate back through page history — ⌘←/Ctrl+←. Suppressed while typing. */
  onNavigateBack: () => void;
  /** Navigate forward through page history — ⌘→/Ctrl+→. Suppressed while typing. */
  onNavigateForward: () => void;
};

/** Window (ms) after pressing `g` during which a letter triggers navigation. */
const GOTO_WINDOW_MS = 700;

export function useShellShortcuts(handlersIn: ShellShortcutHandlers): void {
  // Latest handlers without re-binding the listener every render.
  const handlers = useRef(handlersIn);
  handlers.current = handlersIn;

  // Whether `g` was pressed recently (the goto-prefix is armed).
  const gotoArmed = useRef(false);
  const gotoTimer = useRef<number | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase() ?? "";
      const typing = tag === "input" || tag === "textarea" || !!target?.isContentEditable;

      // ⌘K / Ctrl+K works even while typing (it's the universal launcher).
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        handlers.current.toggleCommandPalette();
        return;
      }

      // ⌘Z / Ctrl+Z → general command-level undo (T044), but NOT while typing (so
      // a text field's native undo still works) and NOT with Shift (⌘⇧Z = redo,
      // out of MVP scope). Reverses the last operation_log op anywhere in the app.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "z" &&
        !typing
      ) {
        e.preventDefault();
        handlers.current.onUndo();
        return;
      }

      // ⌘B / Ctrl+B → create a backup now (T050). Outside text entry (so it never
      // hijacks an editor's bold chord), no Shift/Alt. Routes through the SAME
      // typed `appApi.createBackup()` the command palette + native menu call.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === "b" &&
        !typing
      ) {
        e.preventDefault();
        handlers.current.onCreateBackup();
        return;
      }

      // ⌘← / Ctrl+← → back, ⌘→ / Ctrl+→ → forward through page history (mirrors
      // the browser gesture). Outside text entry only — inside an input/textarea/
      // the reader's contenteditable editor, ⌘←/→ must stay the native
      // move-cursor-to-line-edge gesture — and no Shift/Alt (so ⌘⇧← selection is
      // untouched). Routes through the SAME router history every in-app nav uses.
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key === "ArrowLeft" &&
        !typing
      ) {
        e.preventDefault();
        handlers.current.onNavigateBack();
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key === "ArrowRight" &&
        !typing
      ) {
        e.preventDefault();
        handlers.current.onNavigateForward();
        return;
      }

      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "?") {
        e.preventDefault();
        handlers.current.toggleCheatSheet();
        return;
      }

      // `/` → search (kept out of the goto window so it always opens search).
      if (e.key === "/") {
        e.preventDefault();
        handlers.current.onSearch();
        return;
      }

      if (gotoArmed.current) {
        const to = GOTO_MAP[e.key.toLowerCase()];
        gotoArmed.current = false;
        if (gotoTimer.current !== null) window.clearTimeout(gotoTimer.current);
        if (to) {
          e.preventDefault();
          handlers.current.onNavigate(to);
        }
        return;
      }

      if (e.key === "g") {
        gotoArmed.current = true;
        if (gotoTimer.current !== null) window.clearTimeout(gotoTimer.current);
        gotoTimer.current = window.setTimeout(() => {
          gotoArmed.current = false;
        }, GOTO_WINDOW_MS);
        return;
      }

      // Element-targeted global actions on the current selection (T048). These act
      // on whatever the shell has selected and call the SAME typed command as the
      // inspector buttons; the handlers no-op when nothing is selected. We do NOT
      // bind `e`/`c`/`h` (reader scope), `1–4`/space (review scope), or the queue
      // loop's keys here — those belong to the active surface's own hook.
      //
      // When a per-screen scope (reader / review / queue) is mounted it owns these
      // keys (`o`/`+`/`-` overlap the queue loop; `o`/`u`/`+`/`-` are meaningless
      // mid-reader/review), so the global handler DEFERS — exactly one handler runs
      // per keystroke. On list/detail screens with no scope hook (e.g. the inbox,
      // the queue LIST, search results) the global element actions are live.
      if (hasActiveScope()) return;

      switch (e.key) {
        case "o":
        case "O":
          e.preventDefault();
          handlers.current.onOpenSource();
          break;
        case "u":
        case "U":
          e.preventDefault();
          handlers.current.onOpenParent();
          break;
        case "+":
        case "=":
          e.preventDefault();
          handlers.current.onRaisePriority();
          break;
        case "-":
        case "_":
          e.preventDefault();
          handlers.current.onLowerPriority();
          break;
        default:
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gotoTimer.current !== null) window.clearTimeout(gotoTimer.current);
    };
  }, []);
}
