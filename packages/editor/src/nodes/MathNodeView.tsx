/**
 * The KaTeX math NodeView (T072) — renders a `math` node's LaTeX in source + extract.
 *
 * The constrained-schema `math` node (`nodes/math.ts`) stores only the latex string;
 * this React NodeView renders it via the SHARED {@link renderMathHtml} helper (the
 * SAME path the review body renderer uses, so the three surfaces never drift). The
 * node is an atom (no editable inner content) — clicking it opens a small inline
 * editor so the latex can be edited in place; pressing Escape / blur commits.
 *
 * KaTeX renders synchronously to a fixed, safe HTML subset, so there is no async
 * swap (unlike code) — we set `dangerouslySetInnerHTML` with the KaTeX output, which
 * is sanitized markup, never raw user HTML.
 *
 * The NodeView is wired into the React `SourceEditor` only (the schema stays
 * React-free); it is attached via the `Math` node's `addNodeView` at editor build.
 */

import { NodeViewWrapper, type ReactNodeViewProps, ReactNodeViewRenderer } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderMathHtml } from "../render/katex";

/** The interactive math NodeView component. */
function MathNodeViewComponent(props: ReactNodeViewProps) {
  const { node, updateAttributes, editor } = props;
  const latex = (node.attrs.latex as string | undefined) ?? "";
  const display = node.attrs.display === true;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Keep the draft in sync when the node's latex changes from outside.
  useEffect(() => {
    if (!editing) setDraft(latex);
  }, [latex, editing]);

  // Focus the inline editor when it opens.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const html = useMemo(() => renderMathHtml(latex, { display }), [latex, display]);

  const commit = useCallback(() => {
    setEditing(false);
    if (draft !== latex) updateAttributes({ latex: draft });
  }, [draft, latex, updateAttributes]);

  const startEditing = useCallback(() => {
    if (editor?.isEditable === false) return;
    setDraft(latex);
    setEditing(true);
  }, [editor, latex]);

  return (
    <NodeViewWrapper
      as={display ? "div" : "span"}
      className={`math-node${display ? " math-node--block" : " math-node--inline"}`}
      data-testid="math-node"
      data-display={display ? "true" : "false"}
    >
      {editing ? (
        <textarea
          ref={inputRef}
          className="math-node__edit"
          data-testid="math-node-edit"
          value={draft}
          rows={display ? 2 : 1}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(latex);
              setEditing(false);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
        />
      ) : html.length > 0 ? (
        <button
          type="button"
          className="math-node__rendered"
          data-testid="math-node-rendered"
          aria-label="Edit formula"
          // KaTeX output is sanitized markup (a fixed safe subset), not raw user HTML.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: KaTeX-sanitized markup
          dangerouslySetInnerHTML={{ __html: html }}
          onClick={startEditing}
        />
      ) : (
        <button
          type="button"
          className="math-node__empty dimmed"
          data-testid="math-node-empty"
          onClick={startEditing}
        >
          {display ? "Empty formula — click to edit" : "∅"}
        </button>
      )}
    </NodeViewWrapper>
  );
}

/** The Tiptap NodeView renderer for the `math` node (attach in `SourceEditor`). */
export const MathNodeView = ReactNodeViewRenderer(MathNodeViewComponent);
