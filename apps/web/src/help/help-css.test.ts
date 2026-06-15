/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helpCssPath =
  [
    path.join(process.cwd(), "apps/web/src/help/help.css"),
    path.join(process.cwd(), "src/help/help.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const helpCss = readFileSync(helpCssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(helpCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("help CSS", () => {
  it("keeps inline hint help-link labels and chevrons on the same line", () => {
    const hintLink = cssBlock(".inline-hint .help-inline");
    const chevron = cssBlock(".help-inline svg");

    expect(hintLink).toContain("display: inline-flex;");
    expect(hintLink).toContain("white-space: nowrap;");
    expect(hintLink).toContain("vertical-align: baseline;");
    expect(hintLink).not.toContain("display: inline;");
    expect(chevron).toContain("flex: none;");
  });

  it("keeps hovered help category cards flat (border emphasis, no drop shadow or lift)", () => {
    const hover = cssBlock(".hc-cat:hover");

    expect(hover).toContain("border-color: var(--border-strong);");
    expect(hover).not.toMatch(/\bbox-shadow\s*:/);
    expect(hover).not.toMatch(/\btransform\s*:/);
  });
});
