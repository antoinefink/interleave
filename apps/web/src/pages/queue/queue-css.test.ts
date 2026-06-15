/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath =
  [
    path.join(process.cwd(), "apps/web/src/pages/queue/queue.css"),
    path.join(process.cwd(), "src/pages/queue/queue.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const css = readFileSync(cssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("queue CSS", () => {
  it("keeps the selected queue row restrained instead of accent-outlined", () => {
    const active = cssBlock(".qitem--active");

    expect(active).toContain("border-color: var(--border-strong);");
    expect(active).toContain("background: var(--surface-2);");
    expect(active).toContain("box-shadow: none;");
    expect(active).not.toContain("border-color: var(--accent);");
    expect(active).not.toContain("box-shadow: 0 0 0 1px var(--accent);");
  });

  it("keeps the hovered queue row flat (border emphasis, no drop shadow)", () => {
    const hover = cssBlock(".qitem:hover");

    expect(hover).toContain("border-color: var(--border-strong);");
    expect(hover).not.toMatch(/\bbox-shadow\s*:/);
  });

  it("keeps protected rows on the priority accent bar", () => {
    const protectedBar = cssBlock(".qitem--protected::before");

    expect(protectedBar).toContain("width: 3px;");
    expect(protectedBar).toContain("background: var(--prio-a);");
  });
});
