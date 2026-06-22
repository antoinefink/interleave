/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const shellCssPath =
  [
    path.join(process.cwd(), "apps/web/src/shell/shell.css"),
    path.join(process.cwd(), "src/shell/shell.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const shellCss = readFileSync(shellCssPath, "utf8");

const tokensCssPath =
  [
    path.join(process.cwd(), "design/tokens.css"),
    path.join(process.cwd(), "../../design/tokens.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const tokensCss = tokensCssPath ? readFileSync(tokensCssPath, "utf8") : "";

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(shellCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("shell styles", () => {
  it("keeps route scrolling inside the shell work area", () => {
    const page = cssBlock(".shell-page");

    expect(page).toContain("overflow-y: auto;");
    expect(page).toContain("min-height: 0;");
    expect(page).toContain("overscroll-behavior: contain;");
  });

  it("lets reader routes own their vertical scroll position", () => {
    const readerPage = cssBlock(".shell-page:has(.source-reader-screen)");

    expect(readerPage).toContain("overflow-y: hidden;");
  });

  it("defines the theme-adaptive --sidebar-hover token from --text", () => {
    // Guards the token's existence and its color-mix(var(--text)) formula: a
    // rename or a regression to a hardcoded color in tokens.css must fail here,
    // not silently leave shell.css referencing a dead var.
    expect(tokensCss).toMatch(/--sidebar-hover:\s*color-mix\(in oklch, var\(--text\)[^;]*\);/);
  });

  it("gives sidebar items a perceptible, theme-adaptive hover fill", () => {
    // The `--sunken` sidebar made the old `--surface-2` hover ~0.007 L away in
    // light mode (invisible). `--sidebar-hover` is a `--text` overlay that steps
    // clear of `--sunken` in light and stays below the active card in dark.
    const navHover = cssBlock(".shell-nav__item:hover");
    expect(navHover).toContain("var(--sidebar-hover)");
    expect(navHover).not.toContain("--surface-2");

    const userchipHover = cssBlock(".shell-userchip:hover");
    expect(userchipHover).toContain("var(--sidebar-hover)");
    expect(userchipHover).not.toContain("--surface-2");
  });

  it("keeps the active nav item crisp on hover without escalating shadow", () => {
    // `:hover` (0,2,0) would otherwise override `--on` (0,1,0) and replace the
    // white card with the generic hover fill. The dedicated rule pins the card.
    const activeHover = cssBlock(".shell-nav__item--on:hover");
    expect(activeHover).toContain("var(--surface)");

    // Per docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md,
    // hover must not signal via box-shadow — neither hover block escalates it.
    expect(activeHover).not.toMatch(/\bbox-shadow\s*:/);
    expect(cssBlock(".shell-nav__item:hover")).not.toMatch(/\bbox-shadow\s*:/);
  });
});
