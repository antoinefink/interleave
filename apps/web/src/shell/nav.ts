/**
 * Shell navigation + keyboard config (T004).
 *
 * Pure UI configuration for the persistent app shell: the sidebar nav model,
 * the ⌘K command-palette catalogue, the `g`+letter navigation map, and the `?`
 * cheat-sheet contents. This is static presentation data — NOT domain logic —
 * so it lives in a plain module the shell components import (keeping the JSX
 * lean and the data testable in isolation).
 *
 * Routes here mirror the seven typed routes registered in `router.tsx`. Items
 * the kit lists that do not have a route yet (Library, Concepts, Analytics)
 * point at the closest existing route so the shell stays whole; they re-point
 * when those screens land in later milestones.
 */
import type { IconName } from "../components/Icon";

/** A primary or secondary sidebar entry. */
export type NavItem = {
  /** Stable id, also used for the `nav-<id>` test hook. */
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  /** Destination route path (a registered TanStack Router path). */
  readonly to: string;
  /** Optional count badge (static placeholder until queue/inbox data lands). */
  readonly badge?: number;
};

/**
 * Primary nav, shown above the "Organize" divider — matches the kit's first
 * five entries (Queue, Inbox, Library, Review, Search).
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  { id: "queue", label: "Queue", icon: "queue", to: "/queue", badge: 42 },
  { id: "inbox", label: "Inbox", icon: "inbox", to: "/inbox", badge: 4 },
  { id: "library", label: "Library", icon: "library", to: "/search" },
  { id: "review", label: "Review", icon: "review", to: "/review", badge: 28 },
  { id: "search", label: "Search", icon: "search", to: "/search" },
];

/** Secondary "Organize" group — Concepts, Analytics, Settings in the kit. */
export const SECONDARY_NAV: readonly NavItem[] = [
  { id: "concepts", label: "Concepts", icon: "concepts", to: "/search" },
  { id: "analytics", label: "Analytics", icon: "analytics", to: "/analytics" },
  // The leech cleanup view (T040) — maintenance for repeatedly-failing cards. Lives
  // under the "Organize" group until the full M9 analytics/maintenance screen lands.
  { id: "leeches", label: "Leeches", icon: "leech", to: "/maintenance/leeches" },
  // The Trash view (T044) — soft-deleted elements, recoverable via Restore + undo.
  { id: "trash", label: "Trash", icon: "trash", to: "/trash" },
  { id: "settings", label: "Settings", icon: "settings", to: "/settings" },
];

/** A command-palette entry. */
export type CommandItem = {
  readonly group: string;
  readonly icon: IconName;
  readonly label: string;
  /** Route to navigate to when chosen. */
  readonly to: string;
  /** Optional keyboard hint rendered on the right. */
  readonly kbd?: readonly string[];
  /**
   * Optional `window` CustomEvent name dispatched (after navigating to `to`)
   * when the item is chosen. Lets a screen react to a palette action without the
   * palette knowing about that screen — e.g. "New manual note…" navigates to
   * `/inbox` AND opens its New-source modal. The detail is `undefined`.
   */
  readonly event?: string;
};

/** CustomEvent name the inbox listens for to open its New-source modal (⌘K). */
export const NEW_SOURCE_EVENT = "interleave:new-source";

/**
 * CustomEvent name the shell dispatches after a successful global undo (⌘Z, T044)
 * so the active screen can re-read its data (the mutation reverted main-side). The
 * detail is `undefined`; listeners just re-fetch.
 */
export const UNDO_EVENT = "interleave:undo";

/**
 * ⌘K catalogue — mirrors the kit's CMDK_ITEMS. "Create"/"Session" entries land
 * on their nearest route for now (real actions arrive with their features).
 */
export const COMMAND_ITEMS: readonly CommandItem[] = [
  { group: "Go to", icon: "queue", label: "Daily Queue", to: "/queue", kbd: ["G", "Q"] },
  { group: "Go to", icon: "inbox", label: "Inbox triage", to: "/inbox", kbd: ["G", "I"] },
  { group: "Go to", icon: "review", label: "Review session", to: "/review", kbd: ["G", "R"] },
  { group: "Go to", icon: "library", label: "Library & search", to: "/search", kbd: ["G", "L"] },
  { group: "Go to", icon: "concepts", label: "Concept map", to: "/search", kbd: ["G", "C"] },
  { group: "Go to", icon: "settings", label: "Settings", to: "/settings", kbd: ["G", "S"] },
  { group: "Create", icon: "link", label: "Import from URL…", to: "/inbox" },
  {
    group: "Create",
    icon: "paste",
    label: "Paste text as source…",
    to: "/inbox",
    event: NEW_SOURCE_EVENT,
  },
  { group: "Create", icon: "upload", label: "Upload PDF / EPUB…", to: "/inbox" },
  {
    group: "Create",
    icon: "text",
    label: "New manual note…",
    to: "/inbox",
    event: NEW_SOURCE_EVENT,
  },
  { group: "Session", icon: "play", label: "Start daily session", to: "/review" },
  { group: "Session", icon: "review", label: "Review-only mode", to: "/review" },
  { group: "Session", icon: "bookmark", label: "Reading-only mode", to: "/queue" },
];

/**
 * `g`+letter quick-navigation map (pressing `g` then the letter). Matches the
 * kit: q→queue, i→inbox, r→review, l→library, c→concepts, a→analytics,
 * s→settings. Library/concepts share `/search` until they split out; analytics
 * has its own `/analytics` route (T045).
 */
export const GOTO_MAP: Readonly<Record<string, string>> = {
  q: "/queue",
  i: "/inbox",
  r: "/review",
  l: "/search",
  c: "/search",
  a: "/analytics",
  s: "/settings",
};

/** One cheat-sheet group: a heading plus [label, keys] rows. */
export type CheatGroup = {
  readonly group: string;
  readonly rows: readonly (readonly [string, readonly string[]])[];
};

/** `?` cheat-sheet contents — mirrors the kit's CHEAT table. */
export const CHEAT_SHEET: readonly CheatGroup[] = [
  {
    group: "Navigation",
    rows: [
      ["Command palette", ["⌘", "K"]],
      ["Undo last action", ["⌘", "Z"]],
      ["Go to Queue", ["G", "Q"]],
      ["Go to Review", ["G", "R"]],
      ["Go to Library", ["G", "L"]],
      ["This cheat sheet", ["?"]],
    ],
  },
  {
    group: "Reading",
    rows: [
      ["Extract selection", ["E"]],
      ["Cloze selection", ["C"]],
      ["Highlight", ["H"]],
      ["Set read-point", ["␣"]],
      ["Mark processed", ["M"]],
    ],
  },
  {
    group: "Review",
    rows: [
      ["Reveal answer", ["␣"]],
      ["Grade Again → Easy", ["1", "4"]],
      ["Edit card", ["E"]],
      ["Open source", ["O"]],
      ["Suspend", ["S"]],
    ],
  },
  {
    group: "Triage",
    rows: [
      ["Activate", ["1"]],
      ["Read soon", ["2"]],
      ["Save for later", ["3"]],
      ["Archive", ["4"]],
      ["Delete", ["6"]],
    ],
  },
];
