import { describe, expect, it } from "vitest";
import { iconNames } from "../components/Icon";
import { CHEAT_SHEET, COMMAND_ITEMS, GOTO_MAP, PRIMARY_NAV, SECONDARY_NAV } from "./nav";

/**
 * Unit tests (T004) — guard the static shell navigation config without
 * rendering React. They protect the keyboard-first contract (every nav/command
 * icon is a real mapped icon, the goto map and command palette agree on
 * routes), so a typo can't silently break the chrome.
 */

const ALL_NAV = [...PRIMARY_NAV, ...SECONDARY_NAV];

/** The nav-reachable routes registered in router.tsx (the only valid destinations). */
const VALID_ROUTES = new Set([
  "/",
  "/inbox",
  "/queue",
  "/review",
  "/maintenance/leeches",
  "/search",
  "/settings",
]);

describe("shell nav config", () => {
  it("matches the kit's five primary + the Organize entries", () => {
    expect(PRIMARY_NAV.map((n) => n.label)).toEqual([
      "Queue",
      "Inbox",
      "Library",
      "Review",
      "Search",
    ]);
    expect(SECONDARY_NAV.map((n) => n.label)).toEqual([
      "Concepts",
      "Analytics",
      "Leeches",
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
      expect(VALID_ROUTES).toContain(item.to);
    }
    for (const to of Object.values(GOTO_MAP)) {
      expect(VALID_ROUTES).toContain(to);
    }
  });

  it("has unique nav ids (used as `nav-<id>` test hooks)", () => {
    const ids = ALL_NAV.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers the load-bearing goto shortcuts (q/r/l)", () => {
    expect(GOTO_MAP.q).toBe("/queue");
    expect(GOTO_MAP.r).toBe("/review");
    expect(GOTO_MAP.l).toBe("/search");
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
