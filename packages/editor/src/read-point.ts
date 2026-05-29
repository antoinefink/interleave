/**
 * Read-point resolution + jump helpers (T017).
 *
 * A read-point is how far the user has read a source/topic: a STABLE block id
 * (from T016) plus a character offset within that block's text. This module is
 * the renderer-side bridge between the editor and the typed `readPoints.*`
 * surface — it does NOT touch SQLite or `window.appApi` (the web `useReadPoint`
 * seam does that). It only:
 *
 *  1. resolves a `{ blockId, offset }` from the editor's current selection
 *     (`resolveReadPointFromSelection`), walking up to the nearest block-level
 *     node that carries a `blockId`;
 *  2. resolves the END-of-block read-point for a given block id
 *     (`readThroughBlock`), the shape the M4 auto-advance-on-extract seam (T021)
 *     will feed to `readPoints.set`;
 *  3. jumps to a stored read-point in a live editor (`jumpToReadPoint`): finds
 *     the block by id, clamps the offset to the block length, sets the caret, and
 *     scrolls the matching `data-block-id` DOM node into view — degrading
 *     gracefully (nearest surviving block / top) when the block was deleted;
 *  4. computes the first UNREAD block id after a read-point
 *     (`firstUnreadBlockId`) so the reader (T018) can render the `.readpoint`
 *     divider before it, and the 0-based reading progress index
 *     (`readPointProgress`) for the progress bar.
 *
 * The pure functions (everything except `jumpToReadPoint`) operate on plain
 * ProseMirror JSON and run headlessly in Vitest without a DOM; `jumpToReadPoint`
 * is the only DOM/editor-instance-aware function.
 */

import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { BLOCK_ID_DOM_ATTR, BLOCK_ID_NODE_TYPES } from "./block-id";

/**
 * Re-export the Tiptap {@link Editor} type so consumers (the renderer's read-point
 * seam) can type an editor instance without taking a direct `@tiptap/core`
 * dependency — the editor package owns the Tiptap surface.
 */
export type { Editor } from "@tiptap/core";

const BLOCK_ID_NODE_SET = new Set<string>(BLOCK_ID_NODE_TYPES);

/** A resolved resume position: a stable block id + a character offset within it. */
export interface ResolvedReadPoint {
  /** The STABLE block id (from T016) the position anchors to. */
  readonly blockId: string;
  /** Character offset within the block's text (`>= 0`). */
  readonly offset: number;
}

/** A minimal structural view of a ProseMirror node for the headless walk. */
interface PmNode {
  readonly type?: string;
  readonly text?: string;
  readonly attrs?: { readonly blockId?: unknown } & Record<string, unknown>;
  readonly content?: readonly PmNode[];
}

/** The concatenated text length of a node's subtree (matches `Node.textContent`). */
function textLengthOf(node: PmNode): number {
  if (typeof node.text === "string") return node.text.length;
  if (!node.content) return 0;
  let total = 0;
  for (const child of node.content) total += textLengthOf(child);
  return total;
}

/** The ordered block-level nodes (those carrying a non-empty `blockId`) of a doc. */
function orderedBlocks(doc: unknown): { id: string; node: PmNode }[] {
  const out: { id: string; node: PmNode }[] = [];
  if (!doc || typeof doc !== "object") return out;
  const visit = (node: PmNode): void => {
    if (BLOCK_ID_NODE_SET.has(node.type ?? "")) {
      const id = node.attrs?.blockId;
      if (typeof id === "string" && id.length > 0) out.push({ id, node });
    }
    if (node.content) {
      for (const child of node.content) visit(child);
    }
  };
  visit(doc as PmNode);
  return out;
}

/**
 * Resolve the read-point from a raw ProseMirror {@link EditorState}: the nearest
 * enclosing block-level node (at the selection head) that carries a `blockId`,
 * plus the caret's character offset within that block's text. Returns `null` when
 * no such block is in scope (e.g. an empty doc whose blocks have not yet been
 * id'd).
 *
 * The offset is measured from the start of the block's text content so it lines
 * up with the stored `offset` semantics used by {@link jumpToReadPoint}. Pure +
 * DOM-free (operates on the state's selection), so it is unit-testable headlessly.
 */
export function resolveReadPointFromState(state: EditorState): ResolvedReadPoint | null {
  const { $from } = state.selection;
  // Walk up the ancestor chain from the selection head to the first block-level
  // node that carries a (non-empty) blockId.
  for (let depth = $from.depth; depth >= 0; depth--) {
    const node = $from.node(depth);
    if (!BLOCK_ID_NODE_SET.has(node.type.name)) continue;
    const blockId = node.attrs.blockId as string | null | undefined;
    if (typeof blockId !== "string" || blockId.length === 0) continue;
    // Offset of the caret within this block's text content. `$from.pos` is an
    // absolute doc position; `$from.start(depth)` is the position of the block's
    // first child — the difference, clamped, is the character offset.
    const blockStart = $from.start(depth);
    const rawOffset = $from.pos - blockStart;
    const blockTextLen = node.textContent.length;
    const offset = Math.max(0, Math.min(rawOffset, blockTextLen));
    return { blockId, offset };
  }
  return null;
}

/**
 * Resolve the read-point at a live editor's current selection. Thin wrapper over
 * {@link resolveReadPointFromState} that reads the editor's state, so the reader's
 * "Set read-point" action can capture exactly where the caret is.
 */
export function resolveReadPointFromSelection(editor: Editor): ResolvedReadPoint | null {
  return resolveReadPointFromState(editor.state);
}

/**
 * The read-point that marks a block as fully read THROUGH: the block's id with
 * the offset at the END of its text. This is the shape the M4 auto-advance-on-
 * extract seam (T021) feeds to `readPoints.set` so extracting from a block
 * advances the read-point to (at least) that block. Pure — operates on the doc
 * JSON, no editor instance. Returns `null` when the block id is not in the doc.
 */
export function readThroughBlock(doc: unknown, blockId: string): ResolvedReadPoint | null {
  const blocks = orderedBlocks(doc);
  const match = blocks.find((b) => b.id === blockId);
  if (!match) return null;
  return { blockId, offset: textLengthOf(match.node) };
}

/**
 * The first UNREAD block id: the block immediately AFTER the read-point's block
 * in document order. The reader (T018) renders the `.readpoint` divider before
 * this block. Returns `null` when the read-point is `null`, its block is the last
 * (or only) block, or its block is no longer in the doc (deleted) — in those
 * cases there is nothing "unread from here" to divide.
 */
export function firstUnreadBlockId(
  doc: unknown,
  readPoint: ResolvedReadPoint | null,
): string | null {
  if (!readPoint) return null;
  const blocks = orderedBlocks(doc);
  const idx = blocks.findIndex((b) => b.id === readPoint.blockId);
  if (idx < 0 || idx + 1 >= blocks.length) return null;
  return blocks[idx + 1]?.id ?? null;
}

/**
 * The 0-based index of the read-point's block among the document's blocks, for
 * the reading progress bar (`index / totalBlocks`). Returns `{ index: 0, total }`
 * when there is no read-point, and clamps a stale (deleted-block) read-point to
 * `index: 0` so the bar degrades gracefully rather than throwing.
 */
export function readPointProgress(
  doc: unknown,
  readPoint: ResolvedReadPoint | null,
): { readonly index: number; readonly total: number } {
  const blocks = orderedBlocks(doc);
  const total = blocks.length;
  if (!readPoint) return { index: 0, total };
  const idx = blocks.findIndex((b) => b.id === readPoint.blockId);
  return { index: idx < 0 ? 0 : idx, total };
}

/** Options for {@link jumpToReadPoint}. */
export interface JumpToReadPointOptions {
  /** Whether to scroll the matching DOM block into view. Defaults to `true`. */
  readonly scroll?: boolean;
  /** `scrollIntoView` block alignment. Defaults to `"center"`. */
  readonly block?: ScrollLogicalPosition;
}

/** What {@link jumpToReadPoint} did, so the caller can decide how to surface it. */
export type JumpResult =
  | { readonly kind: "jumped"; readonly blockId: string; readonly offset: number }
  | { readonly kind: "fallback"; readonly reason: "missing-block" }
  | { readonly kind: "noop"; readonly reason: "no-read-point" | "block-not-rendered" };

/**
 * Jump a live editor to a stored read-point: locate the block by its STABLE id,
 * clamp the offset to the block's text length, set the caret there, and scroll
 * the matching `data-block-id` DOM node into view.
 *
 * Degrades gracefully: when the stored block was deleted (its id is not in the
 * doc) it does NOT throw — it returns `{ kind: "fallback" }` and leaves the caret
 * at the document start so the reader can fall back to the top. (`read_points`
 * cascades on the element, not on individual blocks, so a stale `blockId` is
 * possible — see the T017 spec risk note.)
 */
export function jumpToReadPoint(
  editor: Editor,
  readPoint: ResolvedReadPoint | null,
  options: JumpToReadPointOptions = {},
): JumpResult {
  if (!readPoint) return { kind: "noop", reason: "no-read-point" };
  const { scroll = true, block = "center" } = options;
  const { state } = editor;

  // Find the block node + its absolute position by matching the stable id.
  let target: { pos: number; textLen: number } | null = null;
  state.doc.descendants((node, pos) => {
    if (target) return false;
    if (!BLOCK_ID_NODE_SET.has(node.type.name)) return true;
    if ((node.attrs.blockId as string | null) === readPoint.blockId) {
      target = { pos, textLen: node.textContent.length };
      return false;
    }
    return true;
  });

  if (!target) {
    // Stale read-point: the block was deleted. Fall back to the document start.
    editor.commands.setTextSelection(0);
    return { kind: "fallback", reason: "missing-block" };
  }

  const { pos, textLen } = target;
  const clampedOffset = Math.max(0, Math.min(readPoint.offset, textLen));
  // +1 steps inside the block node to its text; add the clamped char offset.
  const caretPos = pos + 1 + clampedOffset;
  editor.commands.setTextSelection(caretPos);

  if (scroll && typeof document !== "undefined") {
    const dom = editor.view.dom as HTMLElement;
    const el = dom.querySelector<HTMLElement>(
      `[${BLOCK_ID_DOM_ATTR}="${cssEscape(readPoint.blockId)}"]`,
    );
    if (el) {
      el.scrollIntoView({ behavior: "auto", block });
    } else {
      return { kind: "noop", reason: "block-not-rendered" };
    }
  }
  return { kind: "jumped", blockId: readPoint.blockId, offset: clampedOffset };
}

/**
 * Clamp a read-point's offset to a block's text length (pure helper, exported for
 * tests). `jumpToReadPoint` uses this so a stored offset past the (now shorter)
 * block text never lands the caret out of range. Returns the offset clamped to
 * `[0, textLen]`; `null` block ⇒ `0`.
 */
export function clampOffsetToBlock(doc: unknown, blockId: string, offset: number): number {
  const blocks = orderedBlocks(doc);
  const match = blocks.find((b) => b.id === blockId);
  if (!match) return 0;
  return Math.max(0, Math.min(offset, textLengthOf(match.node)));
}

/** Escape a value for use inside a CSS attribute selector (ids are ULIDs, but be safe). */
function cssEscape(value: string): string {
  const cssApi = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (cssApi?.escape) return cssApi.escape(value);
  // Minimal fallback: escape quotes/backslashes for the `[attr="…"]` selector.
  return value.replace(/["\\]/g, "\\$&");
}
