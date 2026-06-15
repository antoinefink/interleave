/// <reference types="node" />

/**
 * CSS contract for the redesigned Weekly Review stylesheet (U5 — Weekly Review
 * redesign). Mirrors the repo's CSS-contract-test precedent
 * (`apps/web/src/pages/queue/queue-css.test.ts`, `apps/web/src/styles-css.test.ts`):
 * read `weekly-review.css` from disk as text and pin the token-only + key-class
 * contract.
 *
 * The point is to guard against regressing to the old hard-coded-hex
 * `var(--x, #hex)` fallback pattern: every color must come from a design token,
 * so the surface themes in both light and dark.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath =
  [
    path.join(process.cwd(), "apps/web/src/weekly/weekly-review.css"),
    path.join(process.cwd(), "src/weekly/weekly-review.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const css = readFileSync(cssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("weekly review CSS", () => {
  it("loads the stylesheet from disk", () => {
    expect(cssPath).not.toBe("");
    expect(css.length).toBeGreaterThan(0);
  });

  it("contains no hard-coded color hex literals", () => {
    // `#rgb`, `#rrggbb`, `#rgba`, `#rrggbbaa` — the regression guard against the
    // old `var(--x, #hex)` fallback pattern. All color comes from tokens.
    const hexMatches = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexMatches).toEqual([]);
  });

  it("references design tokens for color (var(--…))", () => {
    expect(css).toContain("var(--");
  });

  it("uses no raw rgb()/hsl()/oklch() color literals as values", () => {
    // Token-based theming only. `color-mix(in oklch, var(--…) …)` is allowed —
    // it mixes tokens, it is not a raw color literal — so it must NOT trip these
    // assertions. We therefore look for `rgb(`/`hsl(`/`oklch(` used *directly* as
    // a color value, not the `in oklch` color-space keyword inside `color-mix()`.
    expect(css).not.toMatch(/\brgba?\(/);
    expect(css).not.toMatch(/\bhsla?\(/);
    // `oklch(` as a literal color (e.g. `color: oklch(...)`) is disallowed, but
    // the `in oklch` color-space argument of `color-mix()` is fine.
    expect(css).not.toMatch(/(?<!in\s)\boklch\(/);
  });

  it("declares the key structural classes the markup depends on", () => {
    for (const selector of [
      ".wk-funnel",
      ".wk-sec",
      ".wk-flag",
      ".wk-decision",
      ".wk-seg",
      ".wk-prog",
      ".banner",
      ".btn",
      ".prio-dot",
    ]) {
      expect(css).toContain(selector);
    }
  });
});

describe("weekly review section state (R4)", () => {
  it("no longer paints the green left band on completed sections", () => {
    // The `.wk-sec--done::before { background: var(--ok); }` rule was removed.
    // Done-ness is signaled by the border tint + DONE pill, not a 3px green rail.
    // Guard both structurally (no selector block) and textually (exact declaration
    // absent) so it is not reintroduced by analogy to `.qitem--protected::before`.
    expect(() => cssBlock(".wk-sec--done::before")).toThrow();
    expect(css).not.toMatch(/\.wk-sec--done::before\s*\{[^}]*background:\s*var\(--ok\)/);
  });

  it("still signals done-ness via the green-tinted border", () => {
    // The border tint references the green token through color-mix and stays.
    expect(cssBlock(".wk-sec--done")).toContain("var(--ok)");
  });

  it("leaves the skipped-state grey rail untouched", () => {
    expect(cssBlock(".wk-sec--skipped::before")).toContain("background: var(--border-strong);");
  });
});

describe("weekly review completion / off-state panel", () => {
  it("declares the acknowledgment-panel classes the markup depends on", () => {
    for (const selector of [
      ".wk-complete__panel",
      ".wk-complete__icon",
      ".wk-complete__icon--muted",
      ".wk-complete__title",
      ".wk-complete__body",
      ".wk-complete__due",
      ".wk-complete__actions",
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("paints the completed-state icon with the ok tokens", () => {
    const block = cssBlock(".wk-complete__icon");
    expect(block).toContain("var(--ok-soft)");
    expect(block).toContain("var(--ok)");
  });

  it("uses a neutral (non-ok) tone for the off-state icon", () => {
    const block = cssBlock(".wk-complete__icon--muted");
    expect(block).toContain("var(--surface-2)");
    expect(block).toContain("var(--text-3)");
    expect(block).not.toContain("var(--ok)");
  });

  it("styles the panel from surface/border/shadow tokens only", () => {
    const block = cssBlock(".wk-complete__panel");
    expect(block).toContain("var(--surface)");
    expect(block).toContain("var(--border)");
    expect(block).toContain("var(--shadow-md)");
  });

  it("renders the next-due value in the mono token", () => {
    expect(cssBlock(".wk-complete__due .mono")).toContain("var(--font-mono)");
  });
});
