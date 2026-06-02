/**
 * The shared KaTeX render helper (T072) — ONE latex→HTML path for every surface.
 *
 * Math must render IDENTICALLY in source, extract, and review, so the editor
 * NodeView AND the review body renderer both call {@link renderMathHtml} here
 * rather than each invoking KaTeX their own way. KaTeX renders LaTeX to a fixed,
 * safe HTML+CSS subset **synchronously** (no async typeset pass, no global page
 * mutation) and is **fully offline** (its CSS + fonts are bundled renderer assets;
 * the host imports `katex/dist/katex.min.css` once — NO CDN).
 *
 * Security: `throwOnError: false` makes KaTeX emit a parse-error SPAN for bad
 * LaTeX (it never throws), and `katex.renderToString` emits a fixed, sanitized
 * markup shape — so the result is safe to set via `innerHTML` / `dangerouslySet…`.
 * The latex is user-authored LOCAL content; we never pass arbitrary user HTML to
 * `innerHTML` through any other path.
 *
 * Framework-agnostic (no React) — usable from the Tiptap NodeView and the review
 * face alike.
 */

import katex from "katex";

/** Options for {@link renderMathHtml}. */
export interface RenderMathOptions {
  /** `true` → block/display math (centered, larger); `false` → inline. */
  readonly display?: boolean;
}

/**
 * Render a LaTeX string to a safe KaTeX HTML string. Returns a parse-error span
 * (never throws) for malformed LaTeX. Empty/whitespace latex renders an empty
 * string so the caller can show a placeholder.
 */
export function renderMathHtml(latex: string, options: RenderMathOptions = {}): string {
  const source = latex.trim();
  if (source.length === 0) return "";
  return katex.renderToString(source, {
    displayMode: options.display === true,
    // Render a styled error node instead of throwing on a parse error.
    throwOnError: false,
    // The class KaTeX wraps a parse error in — styled by the app stylesheet.
    errorColor: "var(--danger, #cc0000)",
    // Trust nothing extra; KaTeX's default macro set + the bundled fonts only.
    strict: false,
    output: "htmlAndMathml",
  });
}
