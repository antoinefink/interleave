/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath =
  [
    path.join(process.cwd(), "apps/web/src/library/library.css"),
    path.join(process.cwd(), "src/library/library.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const css = readFileSync(cssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("library CSS", () => {
  it("keeps adjacent result rows separated by the spacing scale", () => {
    const inlineRows = cssBlock(".lib-sec > .result + .result");
    const virtualRows = cssBlock(".lib-sec__vlist [data-virtual-row] .result");

    expect(inlineRows).toContain("margin-top: var(--s-3);");
    expect(virtualRows).toContain("margin-bottom: var(--s-3);");
  });
});
