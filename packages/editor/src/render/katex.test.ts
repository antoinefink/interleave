/**
 * KaTeX render-helper tests (T072).
 *
 * `renderMathHtml` is the SHARED latex→HTML path the editor NodeView + the review
 * body renderer both use. It must render valid LaTeX to KaTeX markup and return a
 * parse-error span (never throw) for bad LaTeX — so a malformed formula degrades to
 * a visible error, never a crash.
 */

import { describe, expect, it } from "vitest";
import { renderMathHtml } from "./katex";

describe("renderMathHtml", () => {
  it("renders valid LaTeX to KaTeX markup", () => {
    const html = renderMathHtml("E=mc^2");
    expect(html).toContain("katex");
    // The variables appear in the rendered MathML/HTML output.
    expect(html).toMatch(/mc|E/);
  });

  it("renders block (display) vs inline math differently", () => {
    const block = renderMathHtml("E=mc^2", { display: true });
    const inline = renderMathHtml("E=mc^2", { display: false });
    expect(block).toContain("katex-display");
    expect(inline).not.toContain("katex-display");
  });

  it("returns a parse-error span for bad LaTeX without throwing", () => {
    let html = "";
    expect(() => {
      html = renderMathHtml("\\frac{1}{");
    }).not.toThrow();
    // throwOnError:false emits a `katex-error` span instead of throwing.
    expect(html).toContain("katex-error");
  });

  it("returns empty string for empty/whitespace latex", () => {
    expect(renderMathHtml("")).toBe("");
    expect(renderMathHtml("   ")).toBe("");
  });
});
