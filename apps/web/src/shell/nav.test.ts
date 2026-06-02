import { describe, expect, it } from "vitest";
import { iconNames } from "../components/Icon";
import {
  ALL_NAV,
  CHEAT_SHEET,
  COMMAND_ITEMS,
  GOTO_MAP,
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
  "/review",
  "/maintenance/leeches",
  "/search",
  "/library",
  "/concepts",
  "/trash",
  "/analytics",
  "/analytics/sources",
  "/settings",
]);

describe("shell nav config", () => {
  it("leads with Home, then the kit's five primary + the Organize entries", () => {
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual([
      "Home",
      "Queue",
      "Inbox",
      "Library",
      "Review",
      "Search",
    ]);
    expect(SECONDARY_NAV.map((n) => n.label)).toEqual([
      "Concepts",
      "Analytics",
      "Source yield",
      "Leeches",
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

  it("points the 'Concept map' command at /concepts (re-pointed off /search), keeping G,C", () => {
    const conceptMap = COMMAND_ITEMS.find((c) => c.label === "Concept map");
    expect(conceptMap).toBeDefined();
    expect(conceptMap?.to).toBe("/concepts");
    expect(conceptMap?.kbd).toEqual(["G", "C"]);
  });

  it("exposes a 'Go to Home command center' command pointing at `/`", () => {
    const home = COMMAND_ITEMS.find((c) => c.to === "/");
    expect(home).toBeDefined();
    expect(home?.group).toBe("Go to");
    expect(home?.kbd).toEqual(["G", "H"]);
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
    // Every nav route is now uniquely owned by a single entry (Library → /library,
    // Concepts → /concepts, Search → /search), so each lights up exactly itself.
    for (const item of ALL_NAV) {
      expect(resolveActiveNavId(item.to)).toBe(item.id);
      expect(activeCount(item.to)).toBe(1);
    }
  });

  it("on /concepts highlights ONLY Concepts — never Search or Library (canonical owner)", () => {
    // Concepts owns its OWN dedicated route now; it must light up exclusively there.
    expect(resolveActiveNavId("/concepts")).toBe("concepts");
    expect(activeCount("/concepts")).toBe(1);
    expect(resolveActiveNavId("/concepts")).not.toBe("search");
    expect(resolveActiveNavId("/concepts")).not.toBe("library");
  });

  it("on /library highlights ONLY Library — never Search or Concepts", () => {
    // Library owns its OWN dedicated route now; it must light up exclusively there.
    expect(resolveActiveNavId("/library")).toBe("library");
    expect(activeCount("/library")).toBe(1);
    expect(resolveActiveNavId("/library")).not.toBe("search");
    expect(resolveActiveNavId("/library")).not.toBe("concepts");
  });

  it("on /search highlights ONLY Search — not Library or Concepts (the reported bug)", () => {
    // Search owns /search alone now — Concepts moved to its own /concepts route and
    // Library to /library. Exactly one entry (Search) is active on /search, and it
    // must NOT resolve to Library or Concepts (guards the ac73484 triple-highlight).
    expect(resolveActiveNavId("/search")).toBe("search");
    expect(activeCount("/search")).toBe(1);
    expect(resolveActiveNavId("/search")).not.toBe("library");
    expect(resolveActiveNavId("/search")).not.toBe("concepts");
  });

  it("resolves /library and /search to DISTINCT owners (no triple-highlight regression)", () => {
    // The two surfaces are kept apart: /library → Library, /search → Search. This
    // is the core guarantee the dedicated Library route adds.
    expect(resolveActiveNavId("/library")).toBe("library");
    expect(resolveActiveNavId("/search")).toBe("search");
    expect(activeCount("/library")).toBe(1);
    expect(activeCount("/search")).toBe(1);
  });

  it("activates a nav item for its child routes (longest-prefix), not shallow ones", () => {
    // A child path of Leeches activates Leeches, and the deeper `/maintenance/leeches`
    // owner beats any shallower `/maintenance` match.
    expect(resolveActiveNavId("/maintenance/leeches")).toBe("leeches");
    expect(resolveActiveNavId("/search/some-id")).toBe("search");
    expect(activeCount("/search/some-id")).toBe(1);
  });

  it("highlights nothing for routes no nav item owns", () => {
    // The reader / process routes are not sidebar destinations.
    expect(resolveActiveNavId("/source/abc")).toBeNull();
    expect(resolveActiveNavId("/extract/abc")).toBeNull();
    expect(resolveActiveNavId("/process")).toBeNull();
  });

  it("on `/` highlights EXACTLY the Home entry (its canonical owner)", () => {
    // Home owns `/` (canonical). The exact `pathname === "/"` branch matches only
    // Home, and every other `to` is a longer/different prefix, so `/` never collides.
    expect(resolveActiveNavId("/")).toBe("home");
    expect(activeCount("/")).toBe(1);
    // The deeper routes still resolve to their own owners — `/` does not leak.
    expect(resolveActiveNavId("/queue")).toBe("queue");
    expect(resolveActiveNavId("/search")).toBe("search");
  });
});
