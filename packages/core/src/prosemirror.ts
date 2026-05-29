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
 * in ProseMirror/Tiptap. Every paragraph is assigned a STABLE block id so the
 * eventual editor, read-points, and extraction lineage have an anchor from day
 * one (T016 builds on these ids). The id minter is injectable so the function
 * stays pure + testable; the default uses the platform `crypto.randomUUID`,
 * which exists in both the Electron main process (Node 19+) and the renderer —
 * never `node:crypto`, so the helper is safe to import anywhere.
 */

import type { BlockId } from "./ids";

/** A minimal ProseMirror text node. */
export interface ProseMirrorTextNode {
  readonly type: "text";
  readonly text: string;
}

/** A minimal ProseMirror paragraph node (text content only in M2). */
export interface ProseMirrorParagraphNode {
  readonly type: "paragraph";
  readonly content?: readonly ProseMirrorTextNode[];
}

/** A minimal ProseMirror `doc` node — paragraphs only for pasted plain text. */
export interface ProseMirrorDoc {
  readonly type: "doc";
  readonly content: readonly ProseMirrorParagraphNode[];
}

/** One stable block descriptor mirroring a paragraph in the produced doc. */
export interface ProseMirrorBlock {
  readonly blockType: "paragraph";
  /** 0-based position in the document. */
  readonly order: number;
  /** The stable id extracts/read-points/sync anchor to (T016). */
  readonly stableBlockId: BlockId;
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

  const content: ProseMirrorParagraphNode[] = paragraphs.map((para) => ({
    type: "paragraph",
    content: [{ type: "text", text: para }],
  }));

  const blocks: ProseMirrorBlock[] = paragraphs.map((_, order) => ({
    blockType: "paragraph",
    order,
    stableBlockId: mintBlockId(),
  }));

  return {
    doc: { type: "doc", content },
    plainText: paragraphs.join("\n\n"),
    blocks,
  };
}
