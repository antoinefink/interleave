/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath =
  [
    path.join(process.cwd(), "apps/web/src/components/external-url-link.css"),
    path.join(process.cwd(), "src/components/external-url-link.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const css = readFileSync(cssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("external URL link CSS", () => {
  it("keeps URL links visibly clickable without changing the layout shape", () => {
    const base = cssBlock(".external-url-link");
    const hover = cssBlock(".external-url-link:hover");
    const focus = cssBlock(".external-url-link:focus-visible");

    expect(base).toContain("display: inline-flex;");
    expect(base).toContain("color: var(--accent-text);");
    expect(base).toContain("cursor: pointer;");
    expect(hover).toContain("text-decoration: underline;");
    expect(focus).toContain("outline: 2px solid var(--focus);");
    expect(css).toMatch(
      /\.external-url-link__text,\s*\.external-url-link__fallback\s*\{[^}]*overflow-wrap: anywhere;/s,
    );
  });
});
