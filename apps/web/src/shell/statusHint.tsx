/**
 * Status-bar hint slot.
 *
 * The bottom status bar (in `Shell.tsx`) carries the three persistent global
 * hints (⌘K / G-nav / ?). A focused work session — the Process session, a review
 * — also has its own per-item action keys (`d` done, `p` postpone, …). Rather
 * than stacking a second footer row inside the scrolling card (costing vertical
 * reading space), the active screen *publishes* those keys into the one status
 * bar through this tiny context, and the shell renders them on the right.
 *
 * Pure UI orchestration state, mirroring `selection.tsx`: the screen owns WHAT
 * the hint says (it knows its own actions); the shell only renders whatever node
 * is published, and shows nothing when the slot is empty. The publisher clears
 * the slot on unmount so the hint never outlives the screen that set it.
 */

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export interface StatusHintContextValue {
  /** The hint the active screen contributes to the status bar, or `null`. */
  readonly hint: ReactNode | null;
  /** Publish the status-bar hint for the current screen (or clear it with `null`). */
  setHint(hint: ReactNode | null): void;
}

const StatusHintContext = createContext<StatusHintContextValue | null>(null);

/** Provides the status-bar hint slot to the shell + every screen under it. */
export function StatusHintProvider({ children }: { children: ReactNode }) {
  const [hint, setHint] = useState<ReactNode | null>(null);
  // `setHint` is the stable useState setter, so a publishing screen can safely
  // list it in effect deps without re-running on every hint change.
  const value = useMemo<StatusHintContextValue>(() => ({ hint, setHint }), [hint]);
  return <StatusHintContext.Provider value={value}>{children}</StatusHintContext.Provider>;
}

/** Read + set the status-bar hint. Throws if used outside the provider. */
export function useStatusHint(): StatusHintContextValue {
  const ctx = useContext(StatusHintContext);
  if (!ctx) {
    throw new Error("useStatusHint must be used within a <StatusHintProvider>");
  }
  return ctx;
}
