/**
 * Shell navigation + keyboard config (T004).
 *
 * Pure UI configuration for the persistent app shell: the sidebar nav model,
 * the ⌘K command-palette catalogue, the `g`+letter navigation map, and the `?`
 * cheat-sheet contents. This is static presentation data — NOT domain logic —
 * so it lives in a plain module the shell components import (keeping the JSX
 * lean and the data testable in isolation).
 *
 * Routes here mirror the typed routes registered in `router.tsx`. Library has its
 * own dedicated `/library` browse surface and Concepts has its own `/concepts`
 * knowledge-map surface — each is the sole canonical owner of its route, so each
 * highlights exclusively (no Library/Search/Concepts triple-highlight).
 */
import type { IconName } from "../components/Icon";
import { CHEAT_GROUP_ORDER, type PaletteActionId, paletteShortcuts, SHORTCUTS } from "./shortcuts";

/** A primary or secondary sidebar entry. */
export type NavItem = {
  /** Stable id, also used for the `nav-<id>` test hook. */
  readonly id: string;
  readonly label: string;
  readonly icon: IconName;
  /** Destination route path (a registered TanStack Router path). */
  readonly to: string;
  /**
   * Whether this entry shows a LIVE count badge (Queue / Inbox / Review). The
   * value is NOT stored here — it is read at render time from `window.appApi`
   * (`useNavBadges`: queue.list / inbox.list), keyed by `id`, so the badge always
   * reflects the real due/inbox counts rather than a hardcoded placeholder.
   */
  readonly liveBadge?: boolean;
  /**
   * Whether THIS entry is the canonical owner of its `to` route when several
   * entries point at the same path. Home/Library/Concepts/Search each own their
   * own distinct route (`/`, `/library`, `/concepts`, `/search`) as the canonical
   * owner, so the active-state stays exclusive (exactly one item highlighted). See
   * `resolveActiveNavId`. When a route has no canonical owner, the first matching
   * entry wins.
   */
  readonly canonical?: boolean;
};

/**
 * Primary nav, shown above the "Organize" divider — matches the kit's first
 * five entries (Queue, Inbox, Library, Review, Search). Queue / Inbox / Review
 * carry a LIVE count badge wired to real `window.appApi` data (see
 * `useNavBadges`) — no hardcoded counts.
 */
export const PRIMARY_NAV: readonly NavItem[] = [
  // Home command center (the `/` landing dashboard). Canonical owner of `/`, so the
  // route highlights EXCLUSIVELY — `resolveActiveNavId` matches `to === "/"` only via
  // the exact `pathname === "/"` branch, and the longest-prefix rule guarantees it
  // never collides with any deeper route. The `layers` glyph is the shell brand mark.
  { id: "home", label: "Home", icon: "layers", to: "/", canonical: true },
  { id: "queue", label: "Queue", icon: "queue", to: "/queue", liveBadge: true },
  { id: "inbox", label: "Inbox", icon: "inbox", to: "/inbox", liveBadge: true },
  // Library now has its OWN dedicated browse-everything route (`/library`) and is
  // its sole canonical owner, so it highlights EXCLUSIVELY there — no longer
  // sharing the `/search` highlight with Search/Concepts (the triple-highlight bug
  // fixed in ac73484 stays fixed: distinct routes resolve to distinct owners).
  { id: "library", label: "Library", icon: "library", to: "/library", canonical: true },
  { id: "review", label: "Review", icon: "review", to: "/review", liveBadge: true },
  // Canonical owner of `/search`. Concepts now owns its own `/concepts` route, so
  // Search is the ONLY entry pointing at `/search` and highlights there exclusively.
  { id: "search", label: "Search", icon: "search", to: "/search", canonical: true },
];

/** Secondary "Organize" group — Concepts, Analytics, Settings in the kit. */
export const SECONDARY_NAV: readonly NavItem[] = [
  // Concepts now has its OWN dedicated `/concepts` knowledge-map route and is its
  // sole canonical owner, so it highlights EXCLUSIVELY there — no longer sharing the
  // `/search` highlight with Search (the triple-highlight bug fixed in ac73484 stays
  // fixed: distinct routes resolve to distinct owners).
  { id: "concepts", label: "Concepts", icon: "concepts", to: "/concepts", canonical: true },
  { id: "analytics", label: "Analytics", icon: "analytics", to: "/analytics", canonical: true },
  // The per-source yield view (T083) — ranked, lowest-yield-first per-source rollup
  // (read %, extracts/cards/mature-cards, leeches, review time). Its own
  // `/analytics/sources` route so it highlights exclusively (a deeper route than
  // `/analytics`, which `resolveActiveNavId`'s longest-prefix rule already favours).
  { id: "source-yield", label: "Source yield", icon: "library", to: "/analytics/sources" },
  // The leech cleanup view (T040) — maintenance for repeatedly-failing cards. Lives
  // under the "Organize" group until the full M9 analytics/maintenance screen lands.
  { id: "leeches", label: "Leeches", icon: "leech", to: "/maintenance/leeches" },
  // The stagnant-extracts view (T084) — the attention mirror of leech cleanup:
  // extracts that keep returning without progressing (stage never advanced, no
  // children, postponed repeatedly), with rewrite/convert/postpone/delete remedies.
  { id: "stagnant", label: "Stagnant", icon: "hourglass", to: "/maintenance/stagnant" },
  // The Trash view (T044) — soft-deleted elements, recoverable via Restore + undo.
  { id: "trash", label: "Trash", icon: "trash", to: "/trash" },
  { id: "settings", label: "Settings", icon: "settings", to: "/settings" },
];

/** Every sidebar entry, primary then secondary, in render order. */
export const ALL_NAV: readonly NavItem[] = [...PRIMARY_NAV, ...SECONDARY_NAV];

/**
 * Resolve the SINGLE active sidebar entry for a given pathname — returns its
 * `id`, or `null` when no entry owns the route. Pure (no React, no DOM) so the
 * exclusivity contract is unit-testable.
 *
 * Rules:
 *  - The home route `/` only matches an entry whose `to` is exactly `/` (the Home
 *    entry), so `/` resolves to `home` — and never to a deeper route, since every
 *    other `to` is a longer/different prefix.
 *  - Otherwise an entry matches when the pathname equals its `to` or is a child
 *    of it (`${to}/…`) — so `/maintenance/leeches` activates Leeches, and a
 *    future `/search/abc` would still activate the search owner.
 *  - The BEST (longest `to`) match wins, so nested routes beat shallow ones.
 *  - When several entries tie on the same `to`, the `canonical` entry wins; absent
 *    a canonical owner, the first entry in render order wins. This guarantees AT
 *    MOST ONE active id per render — fixing the bug where multiple `/search`
 *    entries highlighted. Library and Concepts now own their own `/library` and
 *    `/concepts` routes, so each resolves uniquely to its own id and only Search
 *    points at `/search`.
 */
export function resolveActiveNavId(pathname: string): string | null {
  let best: NavItem | null = null;
  for (const item of ALL_NAV) {
    const matches =
      item.to === "/"
        ? pathname === "/"
        : pathname === item.to || pathname.startsWith(`${item.to}/`);
    if (!matches) continue;
    if (best === null) {
      best = item;
      continue;
    }
    // Longer `to` = more specific route, always wins.
    if (item.to.length > best.to.length) {
      best = item;
      continue;
    }
    // Same `to` (shared route): the canonical owner wins; otherwise keep the
    // earlier (render-order) entry so resolution is deterministic.
    if (
      item.to.length === best.to.length &&
      item.to === best.to &&
      item.canonical &&
      !best.canonical
    ) {
      best = item;
    }
  }
  return best?.id ?? null;
}

/**
 * Context passed to a palette item's `when` gate so context-scoped action
 * commands (e.g. "Open source", "Raise priority") only appear when they apply.
 * Pure UI state — no domain data.
 */
export interface CommandContext {
  /** Whether an element is currently selected in the shell (T010 selection). */
  readonly hasSelection: boolean;
}

/**
 * A command-palette entry (T004, extended in T048).
 *
 * An entry may navigate (`to`), dispatch a screen `event`, run a registry-backed
 * ACTION (`actionId`, T048 — the palette's "do something" commands), or any
 * combination (e.g. "Start review" navigates to `/review`; "Search" navigates AND
 * runs the search action). `to` is optional now that action-only commands exist.
 */
export type CommandItem = {
  readonly group: string;
  readonly icon: IconName;
  readonly label: string;
  /** Route to navigate to when chosen (optional for action-only commands). */
  readonly to?: string;
  /** Optional keyboard hint rendered on the right. */
  readonly kbd?: readonly string[];
  /**
   * Optional `window` CustomEvent name dispatched (after navigating to `to`)
   * when the item is chosen. Lets a screen react to a palette action without the
   * palette knowing about that screen — e.g. "New manual note…" navigates to
   * `/inbox` AND opens its New-source modal. The detail is `undefined`.
   */
  readonly event?: string;
  /**
   * Optional registry-backed ACTION id (T048). When set, the palette runs the
   * shell's matching handler, which dispatches the SAME typed `window.appApi`
   * command (or navigation) as the on-screen button — no second mutation path.
   */
  readonly actionId?: PaletteActionId;
  /**
   * Optional visibility gate (T048). When present, the palette only shows the item
   * if it returns `true` for the current context (e.g. context-scoped actions show
   * only when an element is selected).
   */
  readonly when?: (ctx: CommandContext) => boolean;
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
 * CustomEvent name the /settings screen dispatches after a setting is persisted,
 * so shell chrome that reads settings (the sidebar's identity chip) can re-read
 * the change live without waiting for a remount. The detail is `undefined`;
 * listeners just re-fetch through the bridge.
 */
export const SETTINGS_CHANGED_EVENT = "interleave:settings-changed";

/**
 * Action entries DERIVED from the single shortcut registry (T048) — the palette's
 * "do something" commands (Open source, Open parent, Raise/Lower priority, Start
 * review, Search). Each carries the registry's `actionId` so `CommandPalette`'s
 * `runItem` dispatches the SAME `window.appApi`-backed handler as the on-screen
 * button (no second mutation path). Context-scoped actions are gated by `when` so
 * they only appear when an element is selected. Built from the registry so the
 * palette can never drift from the documented shortcuts.
 */
const ACTION_COMMAND_ITEMS: readonly CommandItem[] = paletteShortcuts().map((s) => {
  const p = s.palette;
  // Only the element-targeted actions are context-scoped; nav/session ones are
  // always available.
  const contextScoped =
    p?.actionId === "open-source" ||
    p?.actionId === "open-parent" ||
    p?.actionId === "raise-priority" ||
    p?.actionId === "lower-priority";
  const item: CommandItem = {
    group: p?.group ?? "Actions",
    icon: (p?.icon ?? "play") as IconName,
    label: s.label,
    kbd: s.keys,
    ...(p?.to ? { to: p.to } : {}),
    ...(p?.actionId ? { actionId: p.actionId } : {}),
    ...(contextScoped ? { when: (ctx: CommandContext) => ctx.hasSelection } : {}),
  };
  return item;
});

/**
 * ⌘K catalogue — the kit's navigation/create commands PLUS the registry-derived
 * ACTION entries (T048). "Go to"/"Create" navigate (and optionally open a modal);
 * the action entries run a typed command via `actionId`.
 */
export const COMMAND_ITEMS: readonly CommandItem[] = [
  { group: "Go to", icon: "layers", label: "Home command center", to: "/", kbd: ["G", "H"] },
  { group: "Go to", icon: "queue", label: "Daily Queue", to: "/queue", kbd: ["G", "Q"] },
  { group: "Go to", icon: "inbox", label: "Inbox triage", to: "/inbox", kbd: ["G", "I"] },
  { group: "Go to", icon: "review", label: "Review session", to: "/review", kbd: ["G", "R"] },
  { group: "Go to", icon: "library", label: "Library", to: "/library", kbd: ["G", "L"] },
  { group: "Go to", icon: "concepts", label: "Concept map", to: "/concepts", kbd: ["G", "C"] },
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
  ...ACTION_COMMAND_ITEMS,
];

/**
 * `g`+letter quick-navigation map (pressing `g` then the letter). Matches the
 * kit: h→home, q→queue, i→inbox, r→review, l→library, c→concepts, a→analytics,
 * s→settings. Library has its OWN `/library` browse route (g l → /library) and
 * Concepts has its OWN `/concepts` knowledge-map route (g c → /concepts);
 * analytics has its own `/analytics` route (T045); home is the `/` landing
 * command center.
 */
export const GOTO_MAP: Readonly<Record<string, string>> = {
  h: "/",
  q: "/queue",
  i: "/inbox",
  r: "/review",
  l: "/library",
  c: "/concepts",
  a: "/analytics",
  s: "/settings",
};

/** One cheat-sheet group: a heading plus [label, keys] rows. */
export type CheatGroup = {
  readonly group: string;
  readonly rows: readonly (readonly [string, readonly string[]])[];
};

/**
 * `?` cheat-sheet contents — DERIVED from the single shortcut registry (T048), so
 * the documentation can never drift from the real handlers. Each registry entry
 * becomes a `[label, keys]` row under its group; groups render in
 * `CHEAT_GROUP_ORDER`. (Before T048 this was a hand-maintained literal that could
 * silently disagree with what was actually bound.)
 */
export const CHEAT_SHEET: readonly CheatGroup[] = CHEAT_GROUP_ORDER.map((group) => ({
  group,
  rows: SHORTCUTS.filter((s) => s.group === group).map(
    (s) => [s.label, s.keys] as readonly [string, readonly string[]],
  ),
})).filter((g) => g.rows.length > 0);
