/**
 * Framework-agnostic ProseMirror-JSON helpers (T015).
 *
 * These run in plain Node (no DOM, no React, no editor instance), so the
 * renderer, tests, and — later — the main process can all flatten / construct
 * document JSON identically. The renderer computes `plainText` here before
 * calling `documents.save`, and `DocumentRepository.upsert` stores exactly what
 * it receives; keeping the flattening in one place keeps the stored `plainText`
 * mirror in sync with the JSON.
 *
 * `plainText` is the search/preview mirror: one line per block, list items and
 * headings flattened to their text. It is intentionally simple (it is not a
 * Markdown serializer) — its only contract is "stable, readable text that
 * mirrors the document order".
 */

/** A minimal structural view of a ProseMirror node for flattening. */
interface PmNode {
  readonly type?: string;
  readonly text?: string;
  readonly content?: readonly PmNode[];
  /** Node attrs we read for the plain-text mirror (the math node's latex). */
  readonly attrs?: { readonly latex?: string; readonly display?: boolean };
}

/**
 * Render a `math` node's LaTeX into the plain-text mirror with delimiters so it is
 * searchable + re-parseable: a block formula → `$$E=mc^2$$`, an inline formula →
 * `$E=mc^2$`. The latex is stored clean (no rendered HTML) so this flattening is
 * lossless for search/preview.
 */
function mathText(node: PmNode): string {
  const latex = node.attrs?.latex ?? "";
  if (latex.length === 0) return "";
  return node.attrs?.display ? `$$${latex}$$` : `$${latex}$`;
}

/** The canonical empty document: a single empty paragraph. */
export function emptyDoc(): { type: "doc"; content: [{ type: "paragraph" }] } {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

/** Node types that introduce a block boundary (→ their own plain-text line). */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "listItem",
  "horizontalRule",
]);

/** Collect the concatenated text of a node's inline content (depth-first). */
function inlineText(node: PmNode): string {
  if (typeof node.text === "string") return node.text;
  if (node.type === "math") return mathText(node);
  if (!node.content) return "";
  let out = "";
  for (const child of node.content) {
    if (child.type === "hardBreak") {
      out += "\n";
    } else if (child.type === "math") {
      out += mathText(child);
    } else {
      out += inlineText(child);
    }
  }
  return out;
}

/**
 * Walk a ProseMirror document JSON and emit one plain-text line per block-level
 * node, in document order. Nested blocks (list items, blockquote paragraphs)
 * are flattened to their own lines so the mirror stays readable and ordered.
 */
function collectLines(node: PmNode, lines: string[]): void {
  const type = node.type ?? "";

  if (type === "horizontalRule") {
    lines.push("");
    return;
  }

  // A leaf-ish block whose children are inline (paragraph / heading / codeBlock).
  const childrenAreBlocks =
    node.content?.some((c) => c.type !== undefined && BLOCK_TYPES.has(c.type)) ?? false;

  if (BLOCK_TYPES.has(type) && !childrenAreBlocks) {
    lines.push(inlineText(node));
    return;
  }

  // Otherwise recurse into block children (doc, blockquote-with-paras, lists).
  if (node.content) {
    for (const child of node.content) {
      collectLines(child, lines);
    }
  }
}

/**
 * Flatten a ProseMirror document JSON to newline-joined block text — the exact
 * value stored in `documents.plainText`. Trailing blank lines are trimmed so an
 * empty document flattens to `""` rather than a stray newline.
 */
export function toPlainText(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const lines: string[] = [];
  collectLines(doc as PmNode, lines);
  // Drop trailing empties so an empty doc → "" and content has no dangling \n.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}
