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
export type ProseMirrorMarkType = "bold" | "italic" | "underline" | "link" | "code";

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
  /** Inline marks (bold/italic/underline/link/code); omitted when the run is unmarked. */
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

/**
 * A locally-owned article image (`article-image://<source_id>/<asset_id>`) stored
 * as a constrained block atom. The renderer never receives raw filesystem paths
 * or remote URLs; width/height are safe numeric hints and alt/title are plain
 * descriptive text.
 */
export interface ProseMirrorImageNode {
  readonly type: "image";
  readonly attrs: Partial<BlockIdAttrs> & {
    readonly src: string;
    readonly alt?: string | null;
    readonly title?: string | null;
    readonly width?: number | null;
    readonly height?: number | null;
  };
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
  | ProseMirrorHorizontalRuleNode
  | ProseMirrorImageNode;

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
  | "image"
  | "horizontalRule";

/** The row-bearing block types that can carry a stable `blockId`. */
export const PROSEMIRROR_ROW_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "codeBlock",
  "image",
  "horizontalRule",
] as const satisfies readonly ProseMirrorBlockType[];

const PROSEMIRROR_ROW_BLOCK_TYPE_SET = new Set<string>(PROSEMIRROR_ROW_BLOCK_TYPES);

/**
 * Whether a block-level node should carry a stable row id, given its parent.
 *
 * Enforces the one-id-per-row invariant shared by the editor, persistence helpers,
 * and rich extraction: id-bearing rows carry ids only on their outermost
 * row-bearing block.
 */
export function shouldCarryProseMirrorRowBlockId(
  type: string,
  parentType?: string,
): type is ProseMirrorBlockType {
  if (!PROSEMIRROR_ROW_BLOCK_TYPE_SET.has(type)) return false;
  if (parentType && PROSEMIRROR_ROW_BLOCK_TYPE_SET.has(parentType)) return false;
  return true;
}

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
  /**
   * The media START TIMESTAMP (milliseconds) this block belongs to, for MEDIA
   * sources (video/audio transcripts, T073) → persisted to
   * `document_blocks.timestamp_ms`. One cue paragraph carries its cue start;
   * omitted/`null` for the title heading, the transcript-less placeholder, and
   * every non-media body. Backward compatible — `createWithDocumentWithin` writes
   * `block.timestampMs ?? null`.
   */
  readonly timestampMs?: number | null;
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

const BLOCK_NODE_TYPES = new Set<string>([
  ...PROSEMIRROR_ROW_BLOCK_TYPES,
  "bulletList",
  "orderedList",
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object";
}

function isBlockNode(value: unknown): value is ProseMirrorBlockNode {
  return (
    isObjectRecord(value) && typeof value.type === "string" && BLOCK_NODE_TYPES.has(value.type)
  );
}

function asDoc(value: unknown): ProseMirrorDoc | null {
  if (!isObjectRecord(value) || value.type !== "doc" || !Array.isArray(value.content)) {
    return null;
  }
  return value as unknown as ProseMirrorDoc;
}

function cloneAttrs(attrs: unknown): Record<string, unknown> {
  return isObjectRecord(attrs) ? { ...attrs } : {};
}

function inlineNodeTextLength(node: ProseMirrorInlineNode): number {
  return node.type === "text" ? node.text.length : 0;
}

function inlinePlainText(node: ProseMirrorInlineNode): string {
  if (node.type === "text") return node.text;
  if (node.type === "hardBreak") return "\n";
  const latex = node.attrs.latex;
  if (!latex) return "";
  return node.attrs.display ? `$$${latex}$$` : `$${latex}$`;
}

function blockTextLength(node: ProseMirrorBlockNode): number {
  if ("content" in node && Array.isArray(node.content)) {
    return node.content.reduce((sum, child) => {
      if (!isBlockNode(child)) return sum + inlineNodeTextLength(child as ProseMirrorInlineNode);
      return sum + blockTextLength(child);
    }, 0);
  }
  return 0;
}

function imagePlainText(node: ProseMirrorImageNode): string {
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt.trim() : "";
  if (alt.length > 0) return alt;
  const title = typeof node.attrs.title === "string" ? node.attrs.title.trim() : "";
  return title;
}

function blockPlainText(node: ProseMirrorBlockNode): string {
  if (node.type === "image") return imagePlainText(node);
  if (node.type === "horizontalRule") return "";
  if ("content" in node && Array.isArray(node.content)) {
    const childrenAreBlocks = node.content.some(isBlockNode);
    if (childrenAreBlocks) {
      return node.content.filter(isBlockNode).map(blockPlainText).filter(Boolean).join("\n");
    }
    return node.content.map((child) => inlinePlainText(child as ProseMirrorInlineNode)).join("");
  }
  return "";
}

function conversionPlainText(content: readonly ProseMirrorBlockNode[]): string {
  return content
    .map(blockPlainText)
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}

function trimInlineContent(
  content: readonly ProseMirrorInlineNode[] | undefined,
  start: number,
  end: number,
  includeNonTextAtoms: boolean,
): ProseMirrorInlineNode[] {
  if (!content || end <= start) return [];
  const out: ProseMirrorInlineNode[] = [];
  let offset = 0;

  for (const child of content) {
    if (child.type !== "text") {
      if (includeNonTextAtoms) out.push(child);
      continue;
    }

    const textStart = offset;
    const textEnd = offset + child.text.length;
    const keepStart = Math.max(start, textStart);
    const keepEnd = Math.min(end, textEnd);
    if (keepEnd > keepStart) {
      const text = child.text.slice(keepStart - textStart, keepEnd - textStart);
      out.push(child.marks ? { ...child, text, marks: [...child.marks] } : { ...child, text });
    }
    offset = textEnd;
  }

  return out;
}

function trimNestedBlockContent(
  content: readonly ProseMirrorBlockNode[] | undefined,
  start: number,
  end: number,
): ProseMirrorBlockNode[] {
  if (!content || end <= start) return [];
  const out: ProseMirrorBlockNode[] = [];
  let offset = 0;

  for (const child of content) {
    const len = blockTextLength(child);
    const childStart = offset;
    const childEnd = offset + len;
    const keepStart = Math.max(start, childStart);
    const keepEnd = Math.min(end, childEnd);
    if (len === 0) {
      if (offset >= start && offset <= end) out.push(child);
    } else if (keepEnd > keepStart) {
      const trimmed = trimBlockNode(child, keepStart - childStart, keepEnd - childStart);
      if (trimmed) out.push(trimmed);
    }
    offset = childEnd;
  }

  return out;
}

function trimBlockNode(
  node: ProseMirrorBlockNode,
  start: number,
  end: number,
): ProseMirrorBlockNode | null {
  const len = blockTextLength(node);
  if (len === 0) return node;
  const clampedStart = Math.max(0, Math.min(start, len));
  const clampedEnd = Math.max(clampedStart, Math.min(end, len));
  if (clampedEnd <= clampedStart) return null;

  if ("content" in node && Array.isArray(node.content) && node.content.some(isBlockNode)) {
    const content = trimNestedBlockContent(
      node.content.filter(isBlockNode),
      clampedStart,
      clampedEnd,
    );
    if (content.length === 0) return null;
    return replaceBlockContent(node, content);
  }

  if ("content" in node && Array.isArray(node.content)) {
    const content = trimInlineContent(
      node.content as readonly ProseMirrorInlineNode[],
      clampedStart,
      clampedEnd,
      clampedStart === 0 && clampedEnd === len,
    );
    if (content.length === 0) return null;
    return replaceBlockContent(node, content);
  }

  return node;
}

function replaceBlockContent(
  node: ProseMirrorBlockNode,
  content: readonly (ProseMirrorBlockNode | ProseMirrorInlineNode)[] | undefined,
): ProseMirrorBlockNode {
  const next = { ...node } as Record<string, unknown>;
  if (content && content.length > 0) next.content = content;
  else delete next.content;
  return next as unknown as ProseMirrorBlockNode;
}

function remintBlockIds(
  node: ProseMirrorBlockNode,
  mintBlockId: BlockIdMinter,
  blocks: ProseMirrorBlock[],
  parentType?: string,
): ProseMirrorBlockNode {
  const attrs = cloneAttrs(
    "attrs" in node ? (node as { readonly attrs?: unknown }).attrs : undefined,
  );
  const type = node.type;

  if (shouldCarryProseMirrorRowBlockId(type, parentType)) {
    const stableBlockId = mintBlockId();
    attrs.blockId = stableBlockId;
    blocks.push({ blockType: type, order: blocks.length, stableBlockId });
  } else {
    delete attrs.blockId;
  }

  const content =
    "content" in node && Array.isArray(node.content)
      ? node.content.map((child) =>
          isBlockNode(child)
            ? remintBlockIds(child, mintBlockId, blocks, type)
            : cloneInlineNode(child as ProseMirrorInlineNode),
        )
      : undefined;

  const next = { ...node } as Record<string, unknown>;
  if (Object.keys(attrs).length > 0) next.attrs = attrs;
  else delete next.attrs;
  if (content && content.length > 0) next.content = content;
  else delete next.content;
  return next as unknown as ProseMirrorBlockNode;
}

function cloneInlineNode(node: ProseMirrorInlineNode): ProseMirrorInlineNode {
  if (node.type === "text") {
    return node.marks ? { ...node, marks: node.marks.map((mark) => ({ ...mark })) } : { ...node };
  }
  if (node.type === "math") return { ...node, attrs: { ...node.attrs } };
  return { ...node };
}

interface RowBlockRef {
  readonly blockId: BlockId;
  readonly node: ProseMirrorBlockNode;
  readonly ancestors: readonly ProseMirrorBlockNode[];
}

function selectedRowBlocksById(
  doc: ProseMirrorDoc,
  blockIds: readonly BlockId[],
): Map<BlockId, RowBlockRef> {
  const out = new Map<BlockId, RowBlockRef>();
  const remaining = new Set(blockIds);
  if (remaining.size === 0) return out;

  const visit = (
    node: ProseMirrorBlockNode,
    parentType?: string,
    ancestors: ProseMirrorBlockNode[] = [],
  ): boolean => {
    if (shouldCarryProseMirrorRowBlockId(node.type, parentType)) {
      const attrs = "attrs" in node ? (node as { readonly attrs?: unknown }).attrs : undefined;
      const id = isObjectRecord(attrs) ? attrs.blockId : undefined;
      if (typeof id === "string" && remaining.has(id as BlockId)) {
        out.set(id as BlockId, { blockId: id as BlockId, node, ancestors: [...ancestors] });
        remaining.delete(id as BlockId);
        if (remaining.size === 0) return false;
      }
    }
    if ("content" in node && Array.isArray(node.content)) {
      for (const child of node.content) {
        if (!isBlockNode(child)) continue;
        ancestors.push(node);
        const keepGoing = visit(child, node.type, ancestors);
        ancestors.pop();
        if (!keepGoing) return false;
      }
    }
    return true;
  };

  for (const node of doc.content) {
    if (!isBlockNode(node)) continue;
    const keepGoing = visit(node);
    if (!keepGoing) break;
  }
  return out;
}

function hasSelectedAncestor(ref: RowBlockRef, selected: readonly RowBlockRef[]): boolean {
  return selected.some((other) => other !== ref && ref.ancestors.includes(other.node));
}

function textOffsetOfDescendant(
  root: ProseMirrorBlockNode,
  target: ProseMirrorBlockNode,
): number | null {
  const walk = (
    node: ProseMirrorBlockNode,
    offset: number,
  ):
    | { readonly found: true; readonly offset: number }
    | { readonly found: false; readonly next: number } => {
    if (node === target) return { found: true, offset };
    let cursor = offset;
    if ("content" in node && Array.isArray(node.content)) {
      for (const child of node.content) {
        if (isBlockNode(child)) {
          const result = walk(child, cursor);
          if (result.found) return result;
          cursor = result.next;
        } else {
          cursor += inlineNodeTextLength(child as ProseMirrorInlineNode);
        }
      }
    }
    return { found: false, next: cursor };
  };

  const result = walk(root, 0);
  return result.found ? result.offset : null;
}

function boundaryOffsetWithin(
  root: RowBlockRef,
  boundary: RowBlockRef,
  offset: number,
): number | null {
  if (root === boundary) return offset;
  if (!boundary.ancestors.includes(root.node)) return null;
  const base = textOffsetOfDescendant(root.node, boundary.node);
  if (base === null) return null;
  return base + offset;
}

function nearestListAncestor(ref: RowBlockRef): ProseMirrorBlockNode | null {
  for (let i = ref.ancestors.length - 1; i >= 0; i--) {
    const ancestor = ref.ancestors[i];
    if (ancestor?.type === "bulletList" || ancestor?.type === "orderedList") return ancestor;
  }
  return null;
}

function cloneListContainer(
  ancestor: ProseMirrorBlockNode,
  content: readonly ProseMirrorBlockNode[],
): ProseMirrorBlockNode {
  const next = { ...ancestor } as Record<string, unknown>;
  const attrs = cloneAttrs(
    "attrs" in ancestor ? (ancestor as { readonly attrs?: unknown }).attrs : undefined,
  );
  delete attrs.blockId;
  if (Object.keys(attrs).length > 0) next.attrs = attrs;
  else delete next.attrs;
  next.content = content;
  return next as unknown as ProseMirrorBlockNode;
}

function restoreStructuralListContainers(
  roots: readonly RowBlockRef[],
  content: readonly ProseMirrorBlockNode[],
): ProseMirrorBlockNode[] {
  const out: ProseMirrorBlockNode[] = [];
  let groupAncestor: ProseMirrorBlockNode | null = null;
  let groupContent: ProseMirrorBlockNode[] = [];

  const flush = (): void => {
    if (!groupAncestor) return;
    out.push(cloneListContainer(groupAncestor, groupContent));
    groupAncestor = null;
    groupContent = [];
  };

  for (let i = 0; i < content.length; i++) {
    const node = content[i];
    const root = roots[i];
    if (!node || !root || root.node.type !== "listItem") {
      flush();
      if (node) out.push(node);
      continue;
    }

    const listAncestor = nearestListAncestor(root);
    if (!listAncestor) {
      flush();
      out.push(node);
      continue;
    }

    if (groupAncestor && groupAncestor !== listAncestor) flush();
    groupAncestor = listAncestor;
    groupContent.push(node);
  }

  flush();
  return out;
}

export interface RichSelectionConversionInput {
  /** The source or parent extract ProseMirror document JSON the user selected from. */
  readonly parentDoc: unknown;
  /** Ordered stable block ids spanned by the source-location anchor. */
  readonly blockIds: readonly BlockId[];
  /** Character offset within the first selected block's flattened text. */
  readonly startOffset?: number | null;
  /** Character offset within the last selected block's flattened text. */
  readonly endOffset?: number | null;
  /** Fallback plain-text snapshot when the stored document cannot be reconstructed. */
  readonly selectedText: string;
  /** Optional stable id minter for deterministic tests. */
  readonly mintBlockId?: BlockIdMinter;
}

/**
 * Build an extract body from an existing constrained ProseMirror document.
 *
 * The returned document preserves selected rich blocks, including article image
 * atoms, while minting fresh block ids for the child extract body. The original
 * `blockIds` remain the source-location anchor and are never reused in the child
 * document. Returns `null` when the parent doc or selected block ids cannot be
 * matched, so callers can fall back to `plainTextToProseMirrorDoc(selectedText)`.
 */
export function richSelectionToProseMirrorDoc(
  input: RichSelectionConversionInput,
): PlainTextConversion | null {
  try {
    return richSelectionToProseMirrorDocInner(input);
  } catch {
    return null;
  }
}

function richSelectionToProseMirrorDocInner(
  input: RichSelectionConversionInput,
): PlainTextConversion | null {
  if (input.blockIds.length === 0) return null;
  if (input.startOffset == null || input.endOffset == null) return null;
  const doc = asDoc(input.parentDoc);
  if (!doc) return null;

  const byId = selectedRowBlocksById(doc, input.blockIds);
  const selected: RowBlockRef[] = [];
  for (const id of input.blockIds) {
    const ref = byId.get(id);
    if (!ref) return null;
    selected.push(ref);
  }
  const firstSelected = selected[0];
  const lastSelected = selected[selected.length - 1];
  if (!firstSelected || !lastSelected) return null;
  const roots = selected.filter((ref) => !hasSelectedAncestor(ref, selected));

  const trimmed: { readonly ref: RowBlockRef; readonly node: ProseMirrorBlockNode }[] = [];
  for (const root of roots) {
    const len = blockTextLength(root.node);
    const start =
      root === firstSelected
        ? input.startOffset
        : (boundaryOffsetWithin(root, firstSelected, input.startOffset) ?? 0);
    const end =
      root === lastSelected
        ? input.endOffset
        : (boundaryOffsetWithin(root, lastSelected, input.endOffset) ?? len);
    const next = start > 0 || end < len ? trimBlockNode(root.node, start, end) : root.node;
    if (next) trimmed.push({ ref: root, node: next });
  }

  if (trimmed.length === 0) return null;

  const blocks: ProseMirrorBlock[] = [];
  const mint = input.mintBlockId ?? defaultBlockIdMinter;
  const restored = restoreStructuralListContainers(
    trimmed.map((item) => item.ref),
    trimmed.map((item) => item.node),
  );
  const content = restored.map((node) => remintBlockIds(node, mint, blocks));
  if (blocks.length === 0) return null;

  const plainText = conversionPlainText(content);
  if (plainText.length === 0 && input.selectedText.trim().length > 0) return null;
  return {
    doc: { type: "doc", content },
    plainText: plainText.length > 0 ? plainText : input.selectedText.trim(),
    blocks,
  };
}

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
