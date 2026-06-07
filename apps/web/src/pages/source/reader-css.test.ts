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

    expect(dimmed).toContain("color: color-mix(in oklch, var(--text) 40%, var(--text-3));");
    expect(dimmed).not.toMatch(/\bopacity\s*:/);
    expect(marker).toContain("background: var(--border);");
  });

  it("renders the processed toggle as a restrained reader action", () => {
    const button = cssBlock(".readpara__mark");

    expect(button).toContain("border-radius: var(--r-sm);");
    expect(button).toContain("width: 24px;");
    expect(button).toContain("height: 24px;");
    expect(button).not.toMatch(/\bbox-shadow\s*:/);
  });

  it("keeps persistent processed toggles neutral instead of accent blue", () => {
    const processedButton = cssBlock('.readpara__mark[data-processed="true"]');
    const processedHover = cssBlock('.readpara__mark[data-processed="true"]:hover');

    expect(processedButton).toContain("opacity: 0.74;");
    expect(processedButton).toContain("background: var(--surface-2);");
    expect(processedButton).toContain("color: var(--text-3);");
    expect(processedButton).toContain("border-color: var(--border);");
    expect(processedButton).not.toContain("var(--accent-soft)");
    expect(processedButton).not.toContain("var(--accent-text)");
    expect(processedHover).toContain("background: var(--surface);");
    expect(processedHover).toContain("border-color: var(--border-strong);");
  });
});
