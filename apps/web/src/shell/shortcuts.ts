/**
 * The single shortcut registry (T048) — the ONE source of truth for the app's
 * keyboard surface.
 *
 * Before T048, shortcuts lived in three disconnected places (`useShellShortcuts`,
 * `useProcessShortcuts`, the review screen's inline `onKey`) and the cheat sheet
 * (`nav.ts`'s `CHEAT_SHEET`) was hand-maintained documentation that could drift
 * from them. This module collapses that into one declarative list: every shortcut
 * the app binds is described here ONCE, and both the `?` cheat sheet and the `⌘K`
 * palette's action entries are DERIVED from it (see `nav.ts`) so the
 * documentation can never disagree with the handlers.
 *
 * This is pure config + a contract — NOT a handler. A registry entry declares the
 * shortcut's identity, label, keycaps, group, and the SCOPE that is responsible
 * for binding it; the actual key handling stays in the scope hook that owns that
 * surface (the shell's `useShellShortcuts`, the queue's `useProcessShortcuts`, the
 * review screen's `onKey`, the reader's selection keys). The load-bearing
 * invariant T048 enforces is the "one command per action" rule: a shortcut and
 * its on-screen button call the EXACT same typed `window.appApi` command — the
 * registry binds nothing of its own, it only NAMES what each scope must wire and
 * a Vitest drift test asserts that every scope-claimed entry is actually bound.
 *
 * No domain logic here, no SQL, no `window.appApi` calls — just the catalogue.
 */

/** Which surface is responsible for binding a shortcut. */
export type ShortcutScope = "global" | "reader" | "review" | "queue" | "triage";

/** The cheat-sheet / palette grouping a shortcut belongs to. */
export type ShortcutGroup = "Navigation" | "Reading" | "Review" | "Triage" | "Actions";

/** One shortcut in the single source of truth. */
export interface ShortcutDef {
  /** Stable id, used by the drift test + as the `kbd-<id>` doc hook. */
  readonly id: string;
  /** Human label shown in the cheat sheet + palette. */
  readonly label: string;
  /**
   * The keycaps rendered in the cheat sheet / palette (the PRIMARY binding). A
   * shortcut may accept aliases at the handler (e.g. `n`/`→`/`␣` for next) but the
   * cheat sheet shows the canonical caps.
   */
  readonly keys: readonly string[];
  /** The cheat-sheet group heading. */
  readonly group: ShortcutGroup;
  /** Which scope hook is responsible for binding this shortcut. */
  readonly scope: ShortcutScope;
  /**
   * Optional palette command spec. When present, the `⌘K` palette renders an
   * ACTION entry for this shortcut (via `nav.ts`'s derivation). `actionId` is the
   * stable id `CommandPalette` dispatches to the shell's action map; `to` lets the
   * action ALSO navigate first (e.g. "Start review" routes to `/review`).
   */
  readonly palette?: {
    /** The palette group heading (defaults to "Actions"). */
    readonly group?: string;
    /** The lucide icon name for the palette row. */
    readonly icon: string;
    /** The action id the shell's palette-action map runs (omit for nav-only). */
    readonly actionId?: PaletteActionId;
    /** A route to navigate to when chosen (nav-only or nav-then-act). */
    readonly to?: string;
  };
}

/**
 * The closed set of palette ACTION ids the shell knows how to run. Each maps to a
 * handler in `Shell.tsx` that dispatches the SAME `window.appApi` command (or
 * navigation) as the matching on-screen button — there is no second mutation path.
 * Context-scoped actions are no-ops when nothing is selected (the `when` gate in
 * `nav.ts` hides them, and the handler bails defensively).
 */
export type PaletteActionId =
  | "open-source"
  | "open-parent"
  | "raise-priority"
  | "lower-priority"
  | "start-review"
  | "search"
  | "create-backup"
  | "cheat-sheet";

/**
 * The registry. Order here is the cheat-sheet display order within each group.
 *
 * Keys mirror the design kit's caps (IBM Plex `.kbd`): `⌘`/`G`/`?`/`␣`/`⌫` etc.
 * The `scope` says who binds it; the drift test (`shortcuts.test.ts`) asserts each
 * scope-claimed entry is actually wired by reading the scope's known key set.
 */
export const SHORTCUTS: readonly ShortcutDef[] = [
  // ---- Navigation (global) -------------------------------------------------
  {
    id: "command-palette",
    label: "Command palette",
    keys: ["⌘", "K"],
    group: "Navigation",
    scope: "global",
  },
  {
    id: "undo",
    label: "Undo last action",
    keys: ["⌘", "Z"],
    group: "Navigation",
    scope: "global",
  },
  {
    id: "search",
    label: "Search",
    keys: ["/"],
    group: "Navigation",
    scope: "global",
    palette: { group: "Go to", icon: "search", actionId: "search", to: "/search" },
  },
  {
    id: "goto-queue",
    label: "Go to Queue",
    keys: ["G", "Q"],
    group: "Navigation",
    scope: "global",
  },
  {
    id: "goto-review",
    label: "Go to Review",
    keys: ["G", "R"],
    group: "Navigation",
    scope: "global",
  },
  {
    id: "goto-library",
    label: "Go to Library",
    keys: ["G", "L"],
    group: "Navigation",
    scope: "global",
  },
  {
    id: "cheat-sheet",
    label: "This cheat sheet",
    keys: ["?"],
    group: "Navigation",
    scope: "global",
    palette: { group: "Go to", icon: "keyboard", actionId: "cheat-sheet" },
  },
  // ---- Actions (global, on the selected element) ---------------------------
  {
    id: "open-source",
    label: "Open source",
    keys: ["O"],
    group: "Actions",
    scope: "global",
    palette: { icon: "external", actionId: "open-source" },
  },
  {
    id: "open-parent",
    label: "Open parent",
    keys: ["U"],
    group: "Actions",
    scope: "global",
    palette: { icon: "arrowUp", actionId: "open-parent" },
  },
  {
    id: "raise-priority",
    label: "Raise priority",
    keys: ["+"],
    group: "Actions",
    scope: "global",
    palette: { icon: "arrowUp", actionId: "raise-priority" },
  },
  {
    id: "lower-priority",
    label: "Lower priority",
    keys: ["-"],
    group: "Actions",
    scope: "global",
    palette: { icon: "arrowDown", actionId: "lower-priority" },
  },
  {
    id: "start-review",
    label: "Start review",
    keys: ["G", "R"],
    group: "Actions",
    scope: "global",
    palette: { group: "Session", icon: "play", actionId: "start-review", to: "/review" },
  },
  {
    id: "create-backup",
    label: "Create a backup",
    keys: ["⌘", "B"],
    group: "Actions",
    scope: "global",
    palette: { group: "Session", icon: "shield", actionId: "create-backup" },
  },
  // ---- Reading (reader scope) ----------------------------------------------
  {
    id: "extract",
    label: "Extract selection",
    keys: ["E"],
    group: "Reading",
    scope: "reader",
  },
  {
    id: "cloze",
    label: "Cloze selection",
    keys: ["C"],
    group: "Reading",
    scope: "reader",
  },
  {
    id: "highlight",
    label: "Highlight",
    keys: ["H"],
    group: "Reading",
    scope: "reader",
  },
  {
    id: "set-read-point",
    label: "Set read-point",
    keys: ["␣"],
    group: "Reading",
    scope: "reader",
  },
  // ---- Review (review scope) -----------------------------------------------
  {
    id: "reveal",
    label: "Reveal answer",
    keys: ["␣"],
    group: "Review",
    scope: "review",
  },
  {
    id: "grade",
    label: "Grade Again → Easy",
    keys: ["1", "4"],
    group: "Review",
    scope: "review",
  },
  {
    id: "review-edit",
    label: "Edit card",
    keys: ["E"],
    group: "Review",
    scope: "review",
  },
  {
    id: "review-suspend",
    label: "Suspend",
    keys: ["S"],
    group: "Review",
    scope: "review",
  },
  // ---- Queue / process loop (queue scope) ----------------------------------
  {
    id: "process-reveal",
    label: "Reveal card answer (on a card)",
    keys: ["␣"],
    group: "Triage",
    scope: "queue",
  },
  {
    id: "process-grade",
    label: "Grade Again → Easy (on a card)",
    keys: ["1", "4"],
    group: "Triage",
    scope: "queue",
  },
  {
    id: "next-item",
    label: "Next / skip",
    keys: ["N"],
    group: "Triage",
    scope: "queue",
  },
  {
    id: "postpone",
    label: "Postpone",
    keys: ["P"],
    group: "Triage",
    scope: "queue",
  },
  {
    id: "done",
    label: "Mark done",
    keys: ["D"],
    group: "Triage",
    scope: "queue",
  },
  {
    id: "dismiss",
    label: "Dismiss",
    keys: ["X"],
    group: "Triage",
    scope: "queue",
  },
  {
    id: "delete",
    label: "Delete",
    keys: ["⌫"],
    group: "Triage",
    scope: "queue",
  },
] as const;

/** The cheat-sheet group display order. */
export const CHEAT_GROUP_ORDER: readonly ShortcutGroup[] = [
  "Navigation",
  "Actions",
  "Reading",
  "Review",
  "Triage",
];

/** All shortcuts in a given scope (for the drift test + per-scope wiring). */
export function shortcutsForScope(scope: ShortcutScope): readonly ShortcutDef[] {
  return SHORTCUTS.filter((s) => s.scope === scope);
}

/** All shortcuts that carry a palette action spec (for the `⌘K` action entries). */
export function paletteShortcuts(): readonly ShortcutDef[] {
  return SHORTCUTS.filter((s) => s.palette !== undefined);
}
