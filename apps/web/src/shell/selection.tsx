/**
 * Selected-element state (T010).
 *
 * The universal inspector shows whatever element is "selected". This is the
 * shared selection mechanism the rest of the app sets: any screen (queue rows,
 * inbox cards, reader, search results — landing in later milestones) calls
 * `useSelection().select(id)`, and the inspector in the shell reacts. Keeping it
 * in one small React context (UI state only — no domain logic, no data fetching)
 * means the inspector is decoupled from whoever drove the selection.
 *
 * Pure UI orchestration state, per the layering rules: the actual element data
 * is fetched by the inspector THROUGH the typed `window.appApi` bridge from the
 * selected id — this context only holds the id.
 */

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

export interface SelectionContextValue {
  /** The currently selected element id, or `null` when nothing is selected. */
  readonly selectedId: string | null;
  /** Select an element by id (or clear the selection with `null`). */
  select(id: string | null): void;
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

/** Provides the selected-element state to the shell + every screen under it. */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const value = useMemo<SelectionContextValue>(
    () => ({ selectedId, select: setSelectedId }),
    [selectedId],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** Read + set the selected element. Throws if used outside the provider. */
export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error("useSelection must be used within a <SelectionProvider>");
  }
  return ctx;
}
