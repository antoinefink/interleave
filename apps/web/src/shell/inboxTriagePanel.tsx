/**
 * Inbox triage panel bridge (relocates the inbox triage cluster into the shell
 * inspector).
 *
 * The triage actions (Read now / Queue soon / Save for later / Delete), the
 * provenance-aware A/B/C/D priority picker, and the T127 suggestion affordances
 * used to live in a metadata rail inside the inbox `PreviewPane`. They now render
 * inside the shared shell `Inspector`, above its Properties section, so the inbox
 * article preview can use the full width.
 *
 * The `Inspector` is mounted once in the shell and shared by every route, so it
 * cannot receive the inbox's triage handlers as props through the router tree.
 * This context is the one-way channel (mirroring `selection.tsx`): `InboxScreen`
 * publishes a `panel` payload for the single selected inbox source, and the
 * inspector renders the gated triage section only when that payload's `targetId`
 * matches the element it is showing. When `InboxScreen` unmounts the payload
 * clears, so the section never leaks onto other routes.
 *
 * Pure UI orchestration — no domain logic, no data fetching. The triage business
 * logic (navigation, optimistic row removal, refresh, priority provenance, undo)
 * stays in `InboxScreen`; this context only carries references.
 *
 * The payload (`panel`) is rebuilt by `InboxScreen` on every busy/suggestion/
 * highlight change, so the node-registration setters and their ref slots are kept
 * SEPARATE from it — created once and stable — so the inspector's `ref` callbacks
 * never detach/reattach when the payload re-publishes.
 */

import {
  createContext,
  type MutableRefObject,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { PriorityLabelInput, TriageSuggestionDto } from "../lib/appApi";

/**
 * The per-row triage suggestion verdict (banded suggestion / `"pending"` / `null`).
 * Defined here from the canonical `TriageSuggestionDto` (lib/appApi) rather than
 * imported from `pages/inbox/InboxGroupedList`, so the shell layer never depends on
 * a page module.
 */
type InboxRowSuggestion = TriageSuggestionDto | "pending" | null;

/** The live triage payload for the single selected inbox source. */
export interface InboxTriagePanel {
  /** The inbox source id this payload applies to (bound to the loaded detail). */
  readonly targetId: string;
  /** The item's current numeric priority (live from the inbox detail), for the picker's active band. */
  readonly priority: number;
  /** Whether a triage/priority mutation is in flight (disables the controls). */
  readonly busy: boolean;
  /** The selected item's triage suggestion (verdict / `"pending"` / `null`). */
  readonly suggestion: InboxRowSuggestion;
  /** Whether the suggested placement concept has already been assigned this session. */
  readonly placementAssigned: boolean;
  /** Whether the reveal affordance is currently highlighting the section. */
  readonly triageHighlighted: boolean;
  readonly onReadNow: () => void;
  readonly onTriage: (kind: "queueSoon" | "keepForLater" | "delete") => void;
  /** Provenance-aware band set (records T127 accepted/overridden), NOT a generic set. */
  readonly onPickPriority: (label: PriorityLabelInput) => void;
  /** Accept the suggested band as-is (records `accepted` provenance). */
  readonly onAcceptSuggestion: () => void;
  /** Accept the suggested placement concept (`assignConcept`); re-accept is a no-op. */
  readonly onAcceptPlacement: (conceptId: string) => void;
}

export interface InboxTriagePanelContextValue {
  /** The active payload, or `null` when no inbox source is selected for triage. */
  readonly panel: InboxTriagePanel | null;
  /** Publish (or clear with `null`) the active triage payload. */
  setPanel(panel: InboxTriagePanel | null): void;
  /** Stable ref callback: the inspector registers the triage section root here. */
  registerSection(node: HTMLElement | null): void;
  /** Stable ref callback: the inspector registers the Read-now button here. */
  registerReadNowButton(node: HTMLButtonElement | null): void;
  /** The registered section node, read by `InboxScreen` to scroll it into view. */
  readonly sectionRef: MutableRefObject<HTMLElement | null>;
  /** The registered Read-now node, read by `InboxScreen` to focus it. */
  readonly readNowRef: MutableRefObject<HTMLButtonElement | null>;
  /**
   * Bumped each time the Read-now node registers. `InboxScreen` watches this so a
   * reveal requested before the inspector mounted the section can retry once the
   * node exists — the inspector's own fetch may land after the inbox detail does.
   */
  readonly registrationTick: number;
}

const InboxTriagePanelContext = createContext<InboxTriagePanelContextValue | null>(null);

/** Provides the inbox triage panel bridge to the shell + every screen under it. */
export function InboxTriagePanelProvider({ children }: { children: ReactNode }) {
  const [panel, setPanel] = useState<InboxTriagePanel | null>(null);
  const [registrationTick, setRegistrationTick] = useState(0);
  const sectionRef = useRef<HTMLElement | null>(null);
  const readNowRef = useRef<HTMLButtonElement | null>(null);

  // Stable across re-renders so the inspector's `ref` callbacks never detach when
  // the payload re-publishes (busy/highlight changes rebuild `panel`, not these).
  const registerSection = useCallback((node: HTMLElement | null) => {
    sectionRef.current = node;
  }, []);
  const registerReadNowButton = useCallback((node: HTMLButtonElement | null) => {
    readNowRef.current = node;
    if (node) setRegistrationTick((t) => t + 1);
  }, []);

  const value = useMemo<InboxTriagePanelContextValue>(
    () => ({
      panel,
      setPanel,
      registerSection,
      registerReadNowButton,
      sectionRef,
      readNowRef,
      registrationTick,
    }),
    [panel, registerSection, registerReadNowButton, registrationTick],
  );

  return (
    <InboxTriagePanelContext.Provider value={value}>{children}</InboxTriagePanelContext.Provider>
  );
}

/** Read + publish the inbox triage panel. Throws if used outside the provider. */
export function useInboxTriagePanel(): InboxTriagePanelContextValue {
  const ctx = useContext(InboxTriagePanelContext);
  if (!ctx) {
    throw new Error("useInboxTriagePanel must be used within an <InboxTriagePanelProvider>");
  }
  return ctx;
}
