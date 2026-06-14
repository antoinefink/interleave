/**
 * Active-scope registry (T048) — keeps the global shell shortcuts from fighting a
 * per-screen scope hook that owns the same key.
 *
 * The keyboard surface is layered: the shell binds GLOBAL shortcuts
 * (`useShellShortcuts`) while the active screen binds its SCOPE shortcuts (the
 * reader's `E`/`C`/`H`/`␣`, the review `␣`/`1–4`, the queue process loop's
 * `n`/`p`/`d`/`x`/`⌫`/`o`/`+`/`-`). A few global keys (`o` open-source, `+`/`-`
 * priority) collide with the queue loop's keys, and `o`/`+`/`-`/`u` would be
 * meaningless inside the reader/review surfaces. Rather than couple the hooks, a
 * mounted scope hook REGISTERS itself here; the global handler simply SKIPS its
 * scope-overlapping keys whenever a conflicting scope is active, so exactly one
 * handler runs per keystroke.
 *
 * Pure UI coordination — no domain logic, no state library, just a tiny module-
 * level set that scope hooks add/remove themselves from on mount/unmount.
 */

import { useEffect } from "react";

/**
 * The per-screen scopes that can suppress overlapping global keys. `triage` is the
 * inbox bulk-triage surface (T126) — while it is active the global shell defers its
 * overlapping element-action keys (`o`/`u`/`+`/`-`) to the inbox keymap. (`⌘Z` is
 * NOT scope-gated — it fires before the deferral check, so global undo always works;
 * the inbox scope deliberately never binds it.)
 */
export type ActiveScope = "reader" | "review" | "queue" | "triage";

const active = new Set<ActiveScope>();

/** Register a scope as active (call on mount); returns a deregister fn. */
export function pushActiveScope(scope: ActiveScope): () => void {
  active.add(scope);
  return () => {
    active.delete(scope);
  };
}

/** Whether ANY per-screen scope is currently active. */
export function hasActiveScope(): boolean {
  return active.size > 0;
}

/** Whether a specific scope is currently active. */
export function isScopeActive(scope: ActiveScope): boolean {
  return active.has(scope);
}

/**
 * Mount-time helper: mark `scope` active while `enabled` (a screen's own gating,
 * e.g. desktop && !done). The global shell handler reads `hasActiveScope()` to
 * decide whether to defer its overlapping element-action keys.
 */
export function useActiveScope(scope: ActiveScope, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    return pushActiveScope(scope);
  }, [scope, enabled]);
}
