/// <reference types="node" />

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const refBlockCssPath =
  [
    path.join(process.cwd(), "apps/web/src/components/ref-block.css"),
    path.join(process.cwd(), "src/components/ref-block.css"),
  ].find((candidate) => existsSync(candidate)) ?? "";
const refBlockCss = readFileSync(refBlockCssPath, "utf8");

function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(refBlockCss);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

describe("ref block CSS", () => {
  it("keeps source context quotes block-level with modest tokenized top spacing", () => {
    const quote = cssBlock(".refblock__quote");

    expect(quote).toContain("display: block;");
    expect(quote).toContain("margin-top: var(--s-2, 6px);");
  });

  it("collapses citation, badge, and URL onto one wrapping, top-aligned meta row", () => {
    const meta = cssBlock(".refblock__meta");

    // Single wrapping row so short provenance reads on one line and long provenance wraps.
    expect(meta).toContain("display: flex;");
    expect(meta).toContain("flex-wrap: wrap;");
    // flex-start (not baseline/center) anchors the badge + URL to the citation's first line.
    expect(meta).toContain("align-items: flex-start;");
    // The row owns spacing via tokenized gaps.
    expect(meta).toContain("column-gap: var(--s-3");
    expect(meta).toContain("row-gap: var(--s-2");
  });

  it("lets the meta row own spacing — citation and URL carry no block margin-top", () => {
    // cssBlock(".refblock__url") matches the base rule, not `.refblock__url:hover`
    // (the `:hover` text sits between the selector and the brace, so the regex skips it).
    const url = cssBlock(".refblock__url");
    const cite = cssBlock(".refblock__cite");

    // Both lost their block margin-top in the meta-row regroup; the row's gaps own spacing.
    expect(url).not.toContain("margin-top:");
    expect(cite).not.toContain("margin-top:");
  });
});
