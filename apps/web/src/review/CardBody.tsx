/**
 * The shared review body renderer (T072) — renders a card prompt/answer STRING with
 * inline `$…$` / block `$$…$$` math (KaTeX) and fenced ```lang code (Shiki).
 *
 * Today the review faces render `prompt`/`answer` as raw strings, so a Q&A card whose
 * answer is a formula or a code snippet shows raw LaTeX/source. This component splits
 * the body into ordered text/math/code segments (the shared
 * `@interleave/editor` `parseBodySegments`) and renders each via the SAME KaTeX/Shiki
 * helpers the editor NodeViews use — so source, extract, and review look identical.
 *
 * - Math (KaTeX) renders synchronously to a fixed, safe HTML subset.
 * - Code (Shiki) is async (grammar/theme load): the block renders RAW first, then
 *   swaps in the highlighted HTML when ready (a small effect), so a slow first
 *   highlight never blocks paint and an unsupported language stays plain.
 *
 * Pure presentational: no SQL, no scheduling, no `window.appApi`. A plain-text body
 * (no math/code) renders verbatim, so existing cards are unaffected.
 */

import {
  type BodySegment,
  highlightCodeHtml,
  parseBodySegments,
  renderMathHtml,
} from "@interleave/editor";
import { useEffect, useMemo, useState } from "react";

/** Read the current `data-theme` (light/dark) so code highlights match the app theme. */
function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** Render one math segment to inline/block KaTeX markup (synchronous, safe subset). */
function MathSegment({ latex, display }: { latex: string; display: boolean }) {
  const html = useMemo(() => renderMathHtml(latex, { display }), [latex, display]);
  if (html.length === 0) return null;
  return (
    <span
      className={`card-math${display ? " card-math--block" : " card-math--inline"}`}
      data-testid="card-body-math"
      data-display={display ? "true" : "false"}
      // KaTeX output is a fixed, sanitized markup subset (never raw user HTML).
      // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX-sanitized markup
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Render one code segment; raw `<pre><code>` first, swap in Shiki HTML when ready. */
function CodeSegment({ code, language }: { code: string; language: string | null }) {
  const [html, setHtml] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    void highlightCodeHtml(code, { language, theme }).then((out) => {
      if (!cancelled) setHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  if (html) {
    return (
      <div
        className="card-code"
        data-testid="card-body-code"
        data-language={language ?? ""}
        // Shiki output is self-escaped markup (not raw user HTML).
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki-escaped markup
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  // Raw fallback until Shiki resolves (and for SSR / no-DOM tests).
  return (
    <pre
      className="card-code card-code--raw"
      data-testid="card-body-code"
      data-language={language ?? ""}
    >
      <code className={language ? `language-${language}` : undefined}>{code}</code>
    </pre>
  );
}

/** Render an ordered segment list. */
function Segments({ segments }: { segments: readonly BodySegment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "math") {
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, never reordered
          return <MathSegment key={i} latex={seg.latex} display={seg.display} />;
        }
        if (seg.kind === "code") {
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, never reordered
          return <CodeSegment key={i} code={seg.code} language={seg.language} />;
        }
        // biome-ignore lint/suspicious/noArrayIndexKey: positional, never reordered
        return <span key={i}>{seg.content}</span>;
      })}
    </>
  );
}

/**
 * Render a card body string with math + highlighted code. A body with no math/code
 * delimiters renders verbatim. Use this wherever a card prompt/answer is shown in
 * review so the three surfaces (source/extract/review) render math + code identically.
 */
export function CardBody({ body }: { body: string }) {
  const segments = useMemo(() => parseBodySegments(body), [body]);
  return <Segments segments={segments} />;
}
