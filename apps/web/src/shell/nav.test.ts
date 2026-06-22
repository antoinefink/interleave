import { describe, expect, it } from "vitest";
import { iconNames } from "../components/Icon";
import {
  ALL_NAV,
  CHEAT_SHEET,
  COMMAND_ITEMS,
  GOTO_MAP,
  isInspectorHidden,
  PRIMARY_NAV,
  resolveActiveNavId,
  SECONDARY_NAV,
} from "./nav";

/**
 * Unit tests (T004) — guard the static shell navigation config without
 * rendering React. They protect the keyboard-first contract (every nav/command
 * icon is a real mapped icon, the goto map and command palette agree on
 * routes), so a typo can't silently break the chrome.
 */

/** The nav-reachable routes registered in router.tsx (the only valid destinations). */
const VALID_ROUTES = new Set([
  "/",
  "/inbox",
  "/queue",
  "/process",
  "/weekly",
  "/review",
  "/maintenance",
  "/maintenance/leeches",
  "/maintenance/retired",
  "/maintenance/stagnant",
  "/search",
  "/library",
  "/concepts",
  "/trash",
  "/analytics",
  "/analytics/sources",
  "/settings",
  "/synthesis/new",
]);

describe("shell nav config", () => {
  it("leads with Home, then the primary sidebar entries + the Organize entries", () => {
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual([
      "Home",
      "Queue",
      "Inbox",
      "Library",
      "Review",
    ]);
    expect(SECONDARY_NAV.map((n) => n.label)).toEqual([
      "Concepts",
      "Analytics",
      "Source yield",
      "Maintenance",
      "Leeches",
      "Stagnant",
      "Trash",
      "Settings",
    ]);
  });

  it("uses only icons mapped in the Icon component", () => {
    for (const item of ALL_NAV) {
      expect(iconNames).toContain(item.icon);
    }
    for (const item of COMMAND_ITEMS) {
      expect(iconNames).toContain(item.icon);
    }
  });

  it("points every nav + command + goto target at a registered route", () => {
    for (const item of ALL_NAV) {
      expect(VALID_ROUTES).toContain(item.to);
    }
    for (const item of COMMAND_ITEMS) {
      // Action-only commands (T048) carry no `to`; only validate when one is set.
      if (item.to !== undefined) expect(VALID_ROUTES).toContain(item.to);
    }
    for (const to of Object.values(GOTO_MAP)) {
      expect(VALID_ROUTES).toContain(to);
    }
  });

  it("every command item carries a route, an action, or a screen event (T048)", () => {
    for (const item of COMMAND_ITEMS) {
      const runnable =
        item.to !== undefined || item.actionId !== undefined || item.event !== undefined;
      expect(runnable).toBe(true);
    }
  });

  it("has unique command labels, so palette rows have stable keys", () => {
    const labels = COMMAND_ITEMS.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has unique nav ids (used as `nav-<id>` test hooks)", () => {
    const ids = ALL_NAV.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers the load-bearing goto shortcuts (h/q/r/l/c)", () => {
    expect(GOTO_MAP.h).toBe("/");
    expect(GOTO_MAP.q).toBe("/queue");
    expect(GOTO_MAP.r).toBe("/review");
    // Library now has its own dedicated browse route.
    expect(GOTO_MAP.l).toBe("/library");
    // Concepts now has its own dedicated knowledge-map route (re-pointed off /search).
    expect(GOTO_MAP.c).toBe("/concepts");
  });

  it("points the Concepts command at /concepts and keeps concept-map search terms", () => {
    const concepts = COMMAND_ITEMS.find((c) => c.label === "Concepts");
    expect(concepts).toBeDefined();
    expect(concepts?.to).toBe("/concepts");
    expect(concepts?.kbd).toEqual(["G", "C"]);
    expect(concepts?.keywords).toContain("concept map");
  });

  it("exposes a 'Go to Home command center' command pointing at `/`", () => {
    const home = COMMAND_ITEMS.find((c) => c.to === "/");
    expect(home).toBeDefined();
    expect(home?.group).toBe("Go to");
    expect(home?.kbd).toEqual(["G", "H"]);
  });

  it("exposes every sidebar destination through a searchable Go to command", () => {
    for (const nav of ALL_NAV) {
      const command = COMMAND_ITEMS.find((c) => c.group === "Go to" && c.to === nav.to);
      expect(command, `${nav.label} is missing from command palette`).toBeDefined();
      const haystack = [command?.label, command?.to, ...(command?.keywords ?? [])]
        .join(" ")
        .toLowerCase();
      expect(haystack).toContain(nav.label.toLowerCase());
    }
  });

  it("exposes route-only sections that are not sidebar entries", () => {
    expect(COMMAND_ITEMS.find((c) => c.label === "Search")?.to).toBe("/search");
    expect(COMMAND_ITEMS.find((c) => c.label === "Process queue")?.to).toBe("/process");
    expect(COMMAND_ITEMS.find((c) => c.label === "Weekly review")?.to).toBe("/weekly");
    expect(COMMAND_ITEMS.find((c) => c.label === "Retired cards")?.to).toBe("/maintenance/retired");
  });

  it("provides a non-empty cheat sheet with key rows", () => {
    expect(CHEAT_SHEET.length).toBeGreaterThan(0);
    for (const group of CHEAT_SHEET) {
      expect(group.rows.length).toBeGreaterThan(0);
      for (const [label, keys] of group.rows) {
        expect(label.length).toBeGreaterThan(0);
        expect(keys.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("nav active-state exclusivity (resolveActiveNavId)", () => {
  /** Count the entries the sidebar would render highlighted for `pathname`. */
  const activeCount = (pathname: string) =>
    ALL_NAV.filter((n) => n.id === resolveActiveNavId(pathname)).length;

  it("activates AT MOST one nav item on every nav route", () => {
    const routes = ["/", ...ALL_NAV.map((n) => n.to)];
    for (const route of [...new Set(routes)]) {
      // Never two-or-more highlighted at once (the original Library/Search/Concepts bug).
      expect(activeCount(route)).toBeLessThanOrEqual(1);
    }
  });

  it("activates exactly one nav item on each entry's own route", () => {
    // Every sidebar route is uniquely owned by a single entry.
    for (const item of ALL_NAV) {
      expect(resolveActiveNavId(item.to)).toBe(item.id);
      expect(activeCount(item.to)).toBe(1);
    }
  });

  it("on /concepts highlights ONLY Concepts — never Library (canonical owner)", () => {
    // Concepts owns its OWN dedicated route now; it must light up exclusively there.
    expect(resolveActiveNavId("/concepts")).toBe("concepts");
    expect(activeCount("/concepts")).toBe(1);
    expect(resolveActiveNavId("/concepts")).not.toBe("library");
  });

  it("on /library highlights ONLY Library — never Concepts", () => {
    // Library owns its OWN dedicated route now; it must light up exclusively there.
    expect(resolveActiveNavId("/library")).toBe("library");
    expect(activeCount("/library")).toBe(1);
    expect(resolveActiveNavId("/library")).not.toBe("concepts");
  });

  it("on /search highlights no sidebar item because Search is command-only chrome", () => {
    expect(resolveActiveNavId("/search")).toBeNull();
    expect(activeCount("/search")).toBe(0);
    expect(resolveActiveNavId("/search")).not.toBe("library");
    expect(resolveActiveNavId("/search")).not.toBe("concepts");
  });

  it("keeps /library sidebar-owned and /search route-only", () => {
    expect(resolveActiveNavId("/library")).toBe("library");
    expect(resolveActiveNavId("/search")).toBeNull();
    expect(activeCount("/library")).toBe(1);
    expect(activeCount("/search")).toBe(0);
  });

  it("activates a nav item for its child routes (longest-prefix), not shallow ones", () => {
    // A child path of Leeches activates Leeches, and the deeper `/maintenance/leeches`
    // owner beats any shallower `/maintenance` match.
    expect(resolveActiveNavId("/maintenance/leeches")).toBe("leeches");
    expect(resolveActiveNavId("/settings/profile")).toBe("settings");
    expect(activeCount("/settings/profile")).toBe(1);
  });

  it("highlights nothing for routes no nav item owns", () => {
    // The reader / process routes are not sidebar destinations.
    expect(resolveActiveNavId("/source/abc")).toBeNull();
    expect(resolveActiveNavId("/extract/abc")).toBeNull();
    expect(resolveActiveNavId("/process")).toBeNull();
    expect(resolveActiveNavId("/search")).toBeNull();
    expect(resolveActiveNavId("/search/some-id")).toBeNull();
  });

  it("on `/` highlights EXACTLY the Home entry (its canonical owner)", () => {
    // Home owns `/` (canonical). The exact `pathname === "/"` branch matches only
    // Home, and every other `to` is a longer/different prefix, so `/` never collides.
    expect(resolveActiveNavId("/")).toBe("home");
    expect(activeCount("/")).toBe(1);
    // The deeper routes still resolve to their own owners — `/` does not leak.
    expect(resolveActiveNavId("/queue")).toBe("queue");
    expect(resolveActiveNavId("/search")).toBeNull();
  });
});

describe("inspector visibility per route (isInspectorHidden)", () => {
  /**
   * SHOW routes — a screen (or a descendant) drives the inspector today, so it must
   * stay mounted. Includes the dynamic-param detail routes (`/source/$id` etc.), which
   * resolve to concrete ids at runtime and must NOT be caught by a hide family.
   */
  const SHOW_ROUTES = [
    "/",
    "/inbox",
    "/queue",
    "/process",
    "/review",
    "/search",
    "/library",
    "/source/demo-1",
    "/extract/demo-1",
    "/card/demo-1",
    "/synthesis/abc-123",
  ];

  /** HIDE routes — nothing drives the inspector, so the empty placeholder is suppressed. */
  const HIDE_ROUTES = [
    "/convert",
    "/weekly",
    "/synthesis/new",
    "/concepts",
    "/trash",
    "/settings",
    "/maintenance",
    "/maintenance/leeches",
    "/maintenance/retired",
    "/maintenance/stagnant",
    "/maintenance/reverify",
    "/analytics",
    "/analytics/sources",
  ];

  it.each(SHOW_ROUTES)("shows the inspector on %s", (route) => {
    expect(isInspectorHidden(route)).toBe(false);
  });

  it.each(HIDE_ROUTES)("hides the inspector on %s", (route) => {
    expect(isInspectorHidden(route)).toBe(true);
  });

  it("treats `/synthesis/new` as exact-hide but keeps `/synthesis/$id` shown", () => {
    expect(isInspectorHidden("/synthesis/new")).toBe(true);
    expect(isInspectorHidden("/synthesis/abc-123")).toBe(false);
  });

  it("matches hide families by route boundary, never by loose prefix", () => {
    // `/maintenance` and any `${base}/…` child hide…
    expect(isInspectorHidden("/maintenance")).toBe(true);
    expect(isInspectorHidden("/analytics/sources")).toBe(true);
    // …but a same-prefix sibling that is NOT a `${base}/…` child does not bleed.
    expect(isInspectorHidden("/maintenancex")).toBe(false);
    expect(isInspectorHidden("/analyticsxyz")).toBe(false);
  });

  it("treats exact-set entries as exact — children of a non-family route still show", () => {
    // `/convert` is an exact entry, not a family, so a hypothetical child route is
    // NOT hidden (only the families `/maintenance` and `/analytics` extend to children).
    expect(isInspectorHidden("/convert")).toBe(true);
    expect(isInspectorHidden("/convert/foo")).toBe(false);
  });

  it("shows the inspector on an unknown/future route (hide-list fails safe)", () => {
    expect(isInspectorHidden("/totally-new")).toBe(false);
  });
});
