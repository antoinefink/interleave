/**
 * The Shiki code-block NodeView (T072) — syntax-highlights `codeBlock` in source +
 * extract, with a language picker, degrading gracefully.
 *
 * The constrained `codeBlock` carries a `language` attr (`nodes/code-block-language.ts`);
 * this React NodeView highlights its text via the SHARED async {@link highlightCodeHtml}
 * (the SAME singleton highlighter the review body renderer uses, so source/extract/
 * review never drift). Highlighting is async (grammar/theme load), so:
 *
 *  - the EDITABLE code is always the live `NodeViewContent` `<pre><code>` (ProseMirror
 *    keeps the text + selection there) — we never replace the editable content with
 *    rendered HTML, so editing the code always works;
 *  - a read-only, `aria-hidden`, Shiki-highlighted OVERLAY is rendered on top, shown
 *    only when the block is NOT being edited (the editor is read-only OR the cursor is
 *    elsewhere). It renders RAW first (transparent editable text shows through) and
 *    swaps in the highlighted HTML when Shiki resolves — so a slow first highlight
 *    never blocks paint, and an unsupported language stays plain.
 *
 * The theme tracks the document `data-theme` (light/dark) from `design/tokens.css`.
 *
 * React-only (the schema stays React-free); attached in `SourceEditor`.
 */

import {
  NodeViewContent,
  NodeViewWrapper,
  type ReactNodeViewProps,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import { useEffect, useMemo, useState } from "react";
import { highlightCodeHtml } from "../render/shiki";

/** Languages offered in the picker (a subset of the bundled set + "plain"). */
const PICKER_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: "", label: "Plain" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "python", label: "Python" },
  { value: "json", label: "JSON" },
  { value: "bash", label: "Bash" },
  { value: "sql", label: "SQL" },
  { value: "rust", label: "Rust" },
  { value: "css", label: "CSS" },
  { value: "html", label: "HTML" },
];

/** Read the current `data-theme` off the document root (defaults to light). */
function currentTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "light";
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** The code-block NodeView component. */
function CodeBlockNodeViewComponent(props: ReactNodeViewProps) {
  const { node, updateAttributes, editor } = props;
  const language = (node.attrs.language as string | null | undefined) ?? null;
  const code = node.textContent;
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);

  // Track the document theme so the overlay re-highlights on a light/dark switch.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  // Highlight asynchronously; render raw first (overlay stays empty until ready), and
  // swap the highlighted HTML in when Shiki resolves. A cancel flag avoids a stale set.
  useEffect(() => {
    let cancelled = false;
    setHighlighted(null);
    void highlightCodeHtml(code, { language, theme }).then((html) => {
      if (!cancelled) setHighlighted(html);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  const editable = editor?.isEditable !== false;

  const picker = useMemo(
    () =>
      editable ? (
        <select
          className="code-node__lang"
          data-testid="code-node-lang"
          value={language ?? ""}
          onChange={(e) =>
            updateAttributes({ language: e.target.value.length > 0 ? e.target.value : null })
          }
          // Keep the select out of ProseMirror's editing flow.
          contentEditable={false}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {PICKER_LANGUAGES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      ) : null,
    [editable, language, updateAttributes],
  );

  return (
    <NodeViewWrapper className="code-node" data-testid="code-node" data-language={language ?? ""}>
      {picker}
      {/* The editable code — ProseMirror keeps the text + selection here. */}
      <pre className="code-node__pre">
        <NodeViewContent
          // `as` is typed narrowly in this Tiptap version; `code` is a valid host tag.
          as={"code" as "div"}
          className={language ? `language-${language}` : undefined}
        />
      </pre>
      {/* The read-only highlighted overlay; shown when Shiki has resolved. It is
          aria-hidden + non-editable so it never interferes with editing/selection. */}
      {highlighted ? (
        <div
          className="code-node__hl"
          data-testid="code-node-highlighted"
          aria-hidden="true"
          contentEditable={false}
          // Shiki output is a fixed, self-escaped markup shape (not raw user HTML).
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki-escaped markup
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      ) : null}
    </NodeViewWrapper>
  );
}

/** The Tiptap NodeView renderer for `codeBlock` (attach in `SourceEditor`). */
export const CodeBlockNodeView = ReactNodeViewRenderer(CodeBlockNodeViewComponent);
