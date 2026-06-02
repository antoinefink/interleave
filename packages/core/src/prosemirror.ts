/**
 * Plain-text → ProseMirror converter (T013) — a pure, framework-agnostic helper.
 *
 * Tiptap is NOT installed until T015/M3, so manual text import does not stand up
 * a live editor. Instead this deterministic converter turns pasted plain text
 * into the minimal valid ProseMirror `doc` shape the document repository stores
 * and the later editor will agree on: a `doc` whose `content` is one `paragraph`
 * node per blank-line-separated paragraph, each holding a single `text` node.
 *
 * `packages/core` is the natural home: `Document.prosemirrorJson` is typed
 * `unknown` precisely so core stays editor-free, and the converter must not pull
 * in ProseMirror/Tiptap. Every paragraph is assigned a STABLE block id that is
 * embedded BOTH in the node's `blockId` attribute (so the T016 editor ADOPTS it
 * rather than minting a fresh one — preserving ids across import → edit → save)
 * AND in the parallel `blocks` list (so `document_blocks` stores the same id).
 * The id minter is injectable so the function stays pure + testable; the default
 * uses the platform `crypto.randomUUID`, which exists in both the Electron main
 * process (Node 19+) and the renderer — never `node:crypto`, so the helper is
 * safe to import anywhere. (The editor mints ULIDs for blocks created live; an
 * imported source's ids are UUIDs minted here. Both are valid opaque stable ids
 * — what matters is that they are never regenerated.)
 */

import type { BlockId } from "./ids";

/**
 * The inline mark names the constrained editor schema permits (mirrors
 * `@interleave/editor`'s `ALLOWED_MARK_NAMES`). Kept as plain string literals so
 * `@interleave/core` stays editor-free.
 */
export type ProseMirrorMarkType = "bold" | "italic" | "link" | "code";

/** A single inline mark on a text node (e.g. `{ type: "link", attrs: { href } }`). */
export interface ProseMirrorMark {
  readonly type: ProseMirrorMarkType;
  readonly attrs?: Readonly<Record<string, unknown>>;
}

/** The heading levels the constrained schema permits (mirrors `ALLOWED_HEADING_LEVELS`). */
export type ProseMirrorHeadingLevel = 1 | 2 | 3;

/** A minimal ProseMirror text node (now optionally mark-bearing). */
export interface ProseMirrorTextNode {
  readonly type: "text";
  readonly text: string;
  /** Inline marks (bold/italic/link/code); omitted when the run is unmarked. */
  readonly marks?: readonly ProseMirrorMark[];
}

/** A hard line break inside a block (`<br>` → `hardBreak`). */
export interface ProseMirrorHardBreakNode {
  readonly type: "hardBreak";
}

/** The inline content a text-bearing block may hold (text, hard break, math atom). */
export type ProseMirrorInlineNode =
  | ProseMirrorTextNode
  | ProseMirrorHardBreakNode
  | ProseMirrorMathNode;

/**
 * The stable block id (T016), embedded as a node attribute so the editor ADOPTS
 * it instead of minting a fresh one — this is what preserves block ids across
 * import → edit → save → re-import. Mirrors the matching
 * `document_blocks.stableBlockId`. Carried on exactly the OUTERMOST block of a row.
 */
export interface BlockIdAttrs {
  readonly blockId: BlockId;
}

/** A paragraph node — inline content only. */
export interface ProseMirrorParagraphNode {
  readonly type: "paragraph";
  readonly attrs?: BlockIdAttrs;
  readonly content?: readonly ProseMirrorInlineNode[];
}

/** A heading node (levels 1–3) — inline content only. */
export interface ProseMirrorHeadingNode {
  readonly type: "heading";
  readonly attrs: { readonly level: ProseMirrorHeadingLevel } & Partial<BlockIdAttrs>;
  readonly content?: readonly ProseMirrorInlineNode[];
}

/** A code block — a single plain-text run (no inline marks). */
export interface ProseMirrorCodeBlockNode {
  readonly type: "codeBlock";
  /**
   * The fenced-code `language` (T072) is an optional attr alongside the block id —
   * stored as a clean string; syntax highlighting (Shiki) is a render-time concern,
   * never baked into the JSON. `null`/absent → a plain, un-highlighted block.
   */
  readonly attrs?: BlockIdAttrs & { readonly language?: string | null };
  readonly content?: readonly ProseMirrorTextNode[];
}

/**
 * A LaTeX math node (T072) — an inline atom carrying a raw `latex` string + a
 * `display` flag (block vs inline formula). The rendered KaTeX is a display-time
 * concern; the stored JSON keeps only the latex. Mirrors `@interleave/editor`'s
 * `math` node. It is inline content (sits inside a paragraph's content); a block
 * formula is a `display:true` math node that is the sole inline child of its
 * paragraph, so the row's stable id lives on the containing paragraph.
 */
export interface ProseMirrorMathNode {
  readonly type: "math";
  readonly attrs: { readonly latex: string; readonly display: boolean };
}

/** A horizontal rule — a leaf block. */
export interface ProseMirrorHorizontalRuleNode {
  readonly type: "horizontalRule";
  readonly attrs?: BlockIdAttrs;
}

/** A blockquote — wraps block children; the row id sits on the quote, not its inner paragraph. */
export interface ProseMirrorBlockquoteNode {
  readonly type: "blockquote";
  readonly attrs?: BlockIdAttrs;
  readonly content?: readonly ProseMirrorBlockNode[];
}

/** A list item — wraps block children; the row id sits on the item, not its inner paragraph. */
export interface ProseMirrorListItemNode {
  readonly type: "listItem";
  readonly attrs?: BlockIdAttrs;
  readonly content?: readonly ProseMirrorBlockNode[];
}

/** A bullet list container — structural, never id-bearing. */
export interface ProseMirrorBulletListNode {
  readonly type: "bulletList";
  readonly content?: readonly ProseMirrorListItemNode[];
}

/** An ordered list container — structural, never id-bearing. */
export interface ProseMirrorOrderedListNode {
  readonly type: "orderedList";
  readonly content?: readonly ProseMirrorListItemNode[];
}

/**
 * Any block-level node the constrained schema admits. Mirrors
 * `@interleave/editor`'s `ALLOWED_NODE_NAMES` (sans the structural `doc`/`text`),
 * so a doc built from this union validates against `buildSchema()`.
 */
export type ProseMirrorBlockNode =
  | ProseMirrorParagraphNode
  | ProseMirrorHeadingNode
  | ProseMirrorBlockquoteNode
  | ProseMirrorBulletListNode
  | ProseMirrorOrderedListNode
  | ProseMirrorListItemNode
  | ProseMirrorCodeBlockNode
  | ProseMirrorHorizontalRuleNode;

/**
 * A constrained ProseMirror `doc` node. Admits the full constrained block set
 * (paragraphs/headings/lists/blockquotes/code/rules) — the paragraph-only
 * plain-text converter still satisfies it, and the richer HTML→PM converter
 * (T060) produces the same shape.
 */
export interface ProseMirrorDoc {
  readonly type: "doc";
  readonly content: readonly ProseMirrorBlockNode[];
}

/**
 * The row-bearing block types that get one stable id each (mirrors
 * `@interleave/editor`'s `BLOCK_ID_NODE_TYPES`). List CONTAINERS
 * (`bulletList`/`orderedList`) never carry an id.
 */
export type ProseMirrorBlockType =
  | "paragraph"
  | "heading"
  | "blockquote"
  | "listItem"
  | "codeBlock"
  | "horizontalRule";

/** One stable block descriptor mirroring a row-bearing node in the produced doc. */
export interface ProseMirrorBlock {
  readonly blockType: ProseMirrorBlockType;
  /** 0-based position in the document. */
  readonly order: number;
  /** The stable id extracts/read-points/sync anchor to (T016). */
  readonly stableBlockId: BlockId;
  /**
   * The 1-based PAGE number this block belongs to, for PAGINATED sources (PDFs,
   * T064) → persisted to `document_blocks.page`. Omitted/`null` for non-paginated
   * HTML/text bodies (the paragraph/HTML converters never set it). Backward
   * compatible — `createWithDocumentWithin` writes `block.page ?? null`.
   */
  readonly page?: number | null;
}

/** The full result of converting pasted plain text. */
export interface PlainTextConversion {
  /** The minimal valid ProseMirror `doc` (store as `documents.prosemirror_json`). */
  readonly doc: ProseMirrorDoc;
  /** The normalized plain-text mirror (store as `documents.plain_text`). */
  readonly plainText: string;
  /** One stable block per paragraph, in document order. */
  readonly blocks: readonly ProseMirrorBlock[];
}

/** A function that mints a fresh stable block id. Injectable so the helper stays pure. */
export type BlockIdMinter = () => BlockId;

/** Default block-id minter: a platform UUID (works in Node 19+ and the renderer). */
const defaultBlockIdMinter: BlockIdMinter = () => globalThis.crypto.randomUUID() as BlockId;

/**
 * Split pasted text into paragraphs on blank lines.
 *
 * Normalizes CRLF/CR to LF, splits on runs of two-or-more newlines (a blank
 * line), trims each paragraph, and drops empty paragraphs. Within a paragraph,
 * single newlines + runs of inline whitespace are collapsed to single spaces so
 * the stored text is clean for search/preview (rich line-break preservation is
 * deferred to the real editor, T015).
 */
function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((para) => para.replace(/\s+/g, " ").trim())
    .filter((para) => para.length > 0);
}

/**
 * Convert pasted plain text into a minimal ProseMirror `doc`, its normalized
 * `plainText` mirror, and one stable block per paragraph.
 *
 * - Blank-line-separated paragraphs each become a `paragraph` node holding a
 *   single `text` node.
 * - An empty / whitespace-only body yields a valid EMPTY doc
 *   (`{ type: "doc", content: [] }`), empty `plainText`, and zero blocks — never
 *   an invalid document.
 * - `plainText` is the paragraphs rejoined with blank lines, so it round-trips:
 *   re-splitting the returned `plainText` yields the same paragraphs.
 *
 * @param text the raw pasted text (HTML, if pasted, is treated as plain text in M2).
 * @param mintBlockId optional id minter (defaults to a platform UUID).
 */
export function plainTextToProseMirrorDoc(
  text: string,
  mintBlockId: BlockIdMinter = defaultBlockIdMinter,
): PlainTextConversion {
  const paragraphs = splitParagraphs(text);

  // Mint one stable id per paragraph and embed it BOTH in the node attrs (so the
  // editor adopts it) and in the parallel `blocks` list (so `document_blocks`
  // gets the same id). Building both from one mapped id keeps them in lock-step.
  const content: ProseMirrorParagraphNode[] = [];
  const blocks: ProseMirrorBlock[] = [];
  paragraphs.forEach((para, order) => {
    const stableBlockId = mintBlockId();
    content.push({
      type: "paragraph",
      attrs: { blockId: stableBlockId },
      content: [{ type: "text", text: para }],
    });
    blocks.push({ blockType: "paragraph", order, stableBlockId });
  });

  return {
    doc: { type: "doc", content },
    plainText: paragraphs.join("\n\n"),
    blocks,
  };
}
