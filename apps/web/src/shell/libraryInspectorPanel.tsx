/**
 * Library inspector panel bridge (relocates the Library detail column's unique
 * controls into the shared shell inspector).
 *
 * The Library/Browse and Search screens used to render a 320px detail column
 * (`.lib-detail`) between the results list and the shared shell `Inspector`. That
 * column duplicated the inspector (title / priority / status / source reference);
 * the only things it owned were the "Open {type}" action and — for parked sources
 * — the Move-to-inbox / Queue-soon / Dismiss quick-actions, plus the contextual
 * "Parked {date}" and not-in-queue reason lines. The column is gone; those unique
 * controls now render inside the shared `Inspector`, and the freed width reflows
 * into the results list.
 *
 * The `Inspector` is mounted once in the shell and shared by every route, so it
 * cannot receive the Library screen's handlers as props through the router tree.
 * This context is the one-way channel (mirroring `selection.tsx`): the active
 * Library screen publishes a `panel` payload for the single selected element, and
 * the inspector renders the relocated controls only when that payload's `targetId`
 * matches the element it is showing. When the Library screen unmounts (or before
 * it navigates away) the payload clears, so the controls never leak onto other
 * routes (queue / reader / review / card).
 *
 * Pure UI orchestration — no domain logic, no data fetching. The open routing and
 * parked-action mutations stay in the Library screen; this context only carries
 * references. Unlike `inboxTriagePanel.tsx`, there is no reveal/focus affordance
 * here, so the context needs no registration refs or registration tick — the only
 * consumer of that machinery is a scroll-to/focus action the Library relocation
 * does not have.
 */

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

/** The parked-source quick-actions, present only when a parked source is selected. */
export interface LibraryInspectorParkedActions {
  /** Whether a parked-action mutation is in flight (disables the buttons). */
  readonly busy: boolean;
  onMoveToInbox(): void;
  onQueueSoon(): void;
  onDismiss(): void;
}

/** The live payload for the single selected Library element. */
export interface LibraryInspectorPanel {
  /** The element id this payload applies to (gated against the inspected element). */
  readonly targetId: string;
  /** The type-driven open label, e.g. "Open source" / "Open extract". */
  readonly openLabel: string;
  /** Open the selected element in its dedicated view (the screen's own routing). */
  onOpen(): void;
  /** Parked date for the "Parked {date}" context line, or `null`. */
  readonly parkedAt: string | null;
  /** The queue-exclusion reason line, or `null`. */
  readonly notInQueueReason: string | null;
  /** Parked-source quick-actions, or `null` for non-parked / non-source elements. */
  readonly parked: LibraryInspectorParkedActions | null;
}

export interface LibraryInspectorPanelContextValue {
  /** The active payload, or `null` when no Library element is selected. */
  readonly panel: LibraryInspectorPanel | null;
  /** Publish (or clear with `null`) the active payload. */
  setPanel(panel: LibraryInspectorPanel | null): void;
}

const LibraryInspectorPanelContext = createContext<LibraryInspectorPanelContextValue | null>(null);

/** Provides the Library inspector panel bridge to the shell + every screen under it. */
export function LibraryInspectorPanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<LibraryInspectorPanel | null>(null);
  const value = useMemo<LibraryInspectorPanelContextValue>(() => ({ panel, setPanel }), [panel]);
  return (
    <LibraryInspectorPanelContext.Provider value={value}>
      {children}
    </LibraryInspectorPanelContext.Provider>
  );
}

/** Read + publish the Library inspector panel. Throws if used outside the provider. */
export function useLibraryInspectorPanel(): LibraryInspectorPanelContextValue {
  const ctx = useContext(LibraryInspectorPanelContext);
  if (!ctx) {
    throw new Error(
      "useLibraryInspectorPanel must be used within a <LibraryInspectorPanelProvider>",
    );
  }
  return ctx;
}
