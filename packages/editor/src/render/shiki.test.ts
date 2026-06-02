/**
 * Shiki highlight-helper tests (T072).
 *
 * `highlightCodeHtml` is the SHARED code→HTML path the editor NodeView + the review
 * body renderer both use, backed by ONE module-singleton highlighter (the JS RegExp
 * engine — NO WASM, NO CDN). A bundled language highlights; an unbundled language
 * degrades to a plain (escaped) `<pre><code>` with the code intact; the singleton is
 * reused across calls.
 */

import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  getHighlighter,
  highlightCodeHtml,
  plainCodeHtml,
  resolveLanguage,
} from "./shiki";

describe("resolveLanguage", () => {
  it("resolves bundled languages + common aliases", () => {
    expect(resolveLanguage("typescript")).toBe("typescript");
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("py")).toBe("python");
    expect(resolveLanguage("sh")).toBe("bash");
  });

  it("returns null for unbundled / absent languages", () => {
    expect(resolveLanguage("brainfuck")).toBeNull();
    expect(resolveLanguage(null)).toBeNull();
    expect(resolveLanguage("")).toBeNull();
  });
});

describe("plainCodeHtml / escapeHtml", () => {
  it("escapes HTML-significant characters in plain code", () => {
    expect(escapeHtml('a < b && c > "d"')).toBe("a &lt; b &amp;&amp; c &gt; &quot;d&quot;");
    const html = plainCodeHtml("<script>alert(1)</script>", null);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("highlightCodeHtml", () => {
  it("highlights a bundled language to styled spans", async () => {
    const html = await highlightCodeHtml("const x: number = 1;", { language: "typescript" });
    expect(html).toContain("<span");
    expect(html).toContain("shiki");
  });

  it("falls back to plain escaped code for an unbundled language", async () => {
    const html = await highlightCodeHtml("BEGIN; END.", { language: "cobol" });
    expect(html).toContain("<pre");
    expect(html).toContain("BEGIN; END.");
    expect(html).toContain("shiki--plain");
  });

  it("reuses ONE shared highlighter singleton across calls", async () => {
    const a = await getHighlighter();
    const b = await getHighlighter();
    expect(a).toBe(b);
  });
});
