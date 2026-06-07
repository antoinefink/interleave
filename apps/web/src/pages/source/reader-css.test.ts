/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const readerCssPath =
  [
    path.join(process.cwd(), "apps/web/src/pages/source/reader.css"),
    path.join(process.cwd(), "src/pages/source/reader.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const readerCss = readFileSync(readerCssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(readerCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("source reader CSS", () => {
  it("keeps the read-point hint clear of the dashed divider", () => {
    const hint = cssBlock(".readpoint__hint");

    expect(hint).toContain("bottom: var(--s-2);");
    expect(hint).toContain("line-height: 1;");
    expect(hint).not.toMatch(/\btop\s*:/);
  });

  it("makes processed paragraphs visibly dimmed", () => {
    const dimmed = cssBlock(".reader .dimmed");
    const marker = cssBlock(".reader p.dimmed::before");

    expect(dimmed).toContain("opacity: 0.58;");
    expect(marker).toContain("background: var(--border-strong);");
  });

  it("renders the processed toggle as an action button, not a checkbox", () => {
    const button = cssBlock(".readpara__mark");

    expect(button).toContain("border-radius: var(--r-full);");
    expect(button).toContain("width: 26px;");
    expect(button).toContain("height: 26px;");
  });
});
