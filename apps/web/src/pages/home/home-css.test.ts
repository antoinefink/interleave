/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath =
  [
    path.join(process.cwd(), "apps/web/src/pages/home/home.css"),
    path.join(process.cwd(), "src/pages/home/home.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const css = readFileSync(cssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("home CSS", () => {
  it("keeps hovered priority rows flat (border emphasis, no drop shadow)", () => {
    const hover = cssBlock(".home-prow:hover");

    expect(hover).toContain("border-color: var(--border-strong);");
    expect(hover).not.toMatch(/\bbox-shadow\s*:/);
  });

  it("keeps hovered quick-nav tiles flat (border emphasis, no drop shadow)", () => {
    const hover = cssBlock(".home-tile:hover");

    expect(hover).toContain("border-color: var(--border-strong);");
    expect(hover).not.toMatch(/\bbox-shadow\s*:/);
  });
});
