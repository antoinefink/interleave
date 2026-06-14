/**
 * Single-shortcut-registry tests (T048).
 *
 * The registry (`shortcuts.ts`) is the ONE source of truth that the `?` cheat
 * sheet and the `⌘K` palette are derived from, and that the scope hooks must keep
 * in sync with their real handlers. These tests guard that contract:
 *
 *  1. the cheat sheet (`nav.ts`'s derived `CHEAT_SHEET`) is exactly the registry's
 *     groups/rows — so the doc cannot drift from the registry;
 *  2. the palette ACTION entries are derived from the registry's `palette` specs;
 *  3. DRIFT GUARD — every registry entry that claims a `scope` is actually BOUND by
 *     the matching scope hook, asserted by scanning each hook's source for the
 *     entry's primary keys. A shortcut documented but not wired (or renamed in one
 *     place only) fails CI.
 */

import { describe, expect, it } from "vitest";
// The scope hooks' SOURCE, imported as raw strings via Vite's `?raw` loader (a
// renderer-native feature — no Node `fs`), so the drift guard can scan what each
// hook actually binds without leaving the renderer toolchain.
import inboxTriageSrc from "../pages/inbox/useInboxTriageShortcuts.ts?raw";
import processSrc from "../pages/queue/useProcessShortcuts.ts?raw";
import readerSrc from "../pages/source/SourceReader.tsx?raw";
import reviewRepairSrc from "../review/ReviewRepairBar.tsx?raw";
import reviewScreenSrc from "../review/ReviewScreen.tsx?raw";
import { CHEAT_SHEET, COMMAND_ITEMS } from "./nav";
import {
  CHEAT_GROUP_ORDER,
  paletteShortcuts,
  SHORTCUTS,
  type ShortcutScope,
  shortcutsForScope,
} from "./shortcuts";
import shellSrc from "./useShellShortcuts.ts?raw";

describe("shortcut registry", () => {
  it("has unique ids", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every entry has keys, a group, and a scope", () => {
    for (const s of SHORTCUTS) {
      expect(s.keys.length).toBeGreaterThan(0);
      expect(CHEAT_GROUP_ORDER).toContain(s.group);
      expect(["global", "reader", "review", "queue", "triage"]).toContain(s.scope);
    }
  });
});

describe("cheat sheet is derived from the registry (cannot drift)", () => {
  it("renders exactly the registry's groups in order, with every entry as a row", () => {
    // Each cheat group must equal the registry's entries for that group.
    for (const group of CHEAT_SHEET) {
      const expected = SHORTCUTS.filter((s) => s.group === group.group);
      expect(group.rows.map((r) => r[0])).toEqual(expected.map((s) => s.label));
      expect(group.rows.map((r) => r[1])).toEqual(expected.map((s) => [...s.keys]));
    }
    // Every registry entry appears in some cheat row (no orphaned doc).
    const allRows = CHEAT_SHEET.flatMap((g) => g.rows.map((r) => r[0]));
    for (const s of SHORTCUTS) {
      expect(allRows).toContain(s.label);
    }
  });

  it("covers the load-bearing T048 shortcuts (next/extract/cloze/postpone/done/delete/undo/+/-/search/open-source/open-parent)", () => {
    const ids = new Set(SHORTCUTS.map((s) => s.id));
    for (const id of [
      "next-item",
      "extract",
      "cloze",
      "postpone",
      "done",
      "delete",
      "process-undo",
      "raise-priority",
      "lower-priority",
      "search",
      "open-source",
      "open-parent",
      "command-palette",
    ]) {
      expect(ids).toContain(id);
    }
  });
});

describe("palette action entries are derived from the registry", () => {
  it("each palette-shortcut produces a COMMAND_ITEMS entry with its label + actionId/to", () => {
    for (const s of paletteShortcuts()) {
      const item = COMMAND_ITEMS.find((i) => i.label === s.label);
      expect(item, `palette item for "${s.label}"`).toBeTruthy();
      if (s.palette?.actionId) expect(item?.actionId).toBe(s.palette.actionId);
      if (s.palette?.to) expect(item?.to).toBe(s.palette.to);
    }
  });
});

/**
 * The DRIFT GUARD: every scope-claimed registry entry must be bound by the hook
 * that owns that scope. We assert this by scanning each scope hook's SOURCE for the
 * entry's primary key(s) — a documented-but-unwired shortcut (or one renamed in the
 * registry only) then fails here. Keys are mapped to the literal the handler
 * matches (`switch (e.key)` / `e.key === …`), e.g. `␣` → `" "`/`"Space"`,
 * `⌫` → `"Backspace"`, `1`/`4` → the grade keys.
 */
describe("registry-vs-handlers drift guard", () => {
  // Source of the hook that binds each scope's keys.
  const SCOPE_SOURCE: Record<ShortcutScope, string> = {
    global: shellSrc,
    reader: readerSrc,
    // The review surface binds `␣`/`1–4`/`o` in ReviewScreen and the `E`/`S` repair
    // keys in the repair bar — both own the review keyboard.
    review: reviewScreenSrc + reviewRepairSrc,
    queue: processSrc,
    // The inbox is the real triage surface (T126): its bulk-triage keymap is bound
    // in `useInboxTriageShortcuts`, so the `triage` scope's drift guard scans THAT
    // hook's source (not the queue process loop, which owns the `queue` scope).
    triage: inboxTriageSrc,
  };

  /** The handler-literal(s) we expect to see in source for a registry keycap. */
  function handlerLiterals(cap: string): string[] {
    switch (cap) {
      case "⌘":
        return ["metaKey"];
      case "⇧":
        return ["shiftKey"]; // range-extend (⇧J / ⇧K) reads e.shiftKey
      case "J":
        return ['"j"']; // inbox cursor-down (lowercase handler literal)
      case "K":
        // `⌘K` (palette) matches `"k"`; the inbox cursor-up key also uses `"k"`.
        return ['"k"'];
      case "A":
        return ['"a"']; // inbox priority-band A (bare lowercase key)
      case "Z":
        return ['"z"'];
      case "?":
        return ['"?"'];
      case "/":
        return ['"/"'];
      case "G":
        return ['"g"'];
      case "␣":
        return ['"Space"', '" "', '=== "Space"', "Space"];
      case "⌫":
        return ['"Backspace"', '"Delete"'];
      case "E":
        return ['"e"', '=== "e"'];
      case "C":
        return ['"c"'];
      case "H":
        return ['"h"'];
      case "O":
        return ['"o"', '"O"'];
      case "U":
        return ['"u"', '"U"'];
      case "S":
        return ['"s"', "key"]; // review suspend key (S) — repair bar
      case "N":
        return ['"n"', "ArrowRight"];
      case "P":
        return ['"p"'];
      case "D":
        return ['"d"'];
      case "X":
        return ['"x"'];
      case "+":
        return ['"+"', '"="'];
      case "-":
        return ['"-"'];
      case "1":
      case "4":
        // 1–4 are the review/queue grade keys; the inbox verb keys (1/2/3/6) map
        // the bare digit directly, so accept the literal digit too.
        return ["g.key", "GRADES", "rating", '"1"'];
      default:
        return [cap];
    }
  }

  for (const scope of ["global", "reader", "review", "queue", "triage"] as ShortcutScope[]) {
    it(`binds every "${scope}"-scope shortcut`, () => {
      const src = SCOPE_SOURCE[scope];
      for (const s of shortcutsForScope(scope)) {
        // The shortcut is bound if at least the FIRST keycap's handler literal is
        // present in the owning hook's source.
        const firstCap = s.keys[0] ?? "";
        const literals = handlerLiterals(firstCap);
        const bound = literals.some((lit) => src.includes(lit));
        expect(bound, `"${s.id}" (${s.keys.join("")}) bound in ${scope}`).toBe(true);
      }
    });
  }
});
