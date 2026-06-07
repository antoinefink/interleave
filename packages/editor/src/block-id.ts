/**
 * The `blockId` ProseMirror attribute + stable-id filler (T016).
 *
 * This Tiptap extension is what makes block ids *stable*. It does two things:
 *
 *  1. **Adds a global `blockId` attribute** to every block-level node in the
 *     constrained schema (paragraph, heading, blockquote, codeBlock,
 *     horizontalRule, listItem). The attribute round-trips through ProseMirror
 *     JSON (so it survives edit → serialize → re-parse) and renders to the DOM as
 *     `data-block-id`, so the reader (T018) and later mark/extraction code can
 *     target a block by its id.
 *
 *  2. **Mints ids only for blocks that lack one**, via an `appendTransaction`
 *     plugin. This is the load-bearing guarantee: the filler is *strictly
 *     additive*. It walks the doc after every change and assigns a fresh ULID to
 *     any qualifying block whose `blockId` is missing — it NEVER touches a block
 *     that already has one. Editing, saving, reordering, and re-importing
 *     therefore preserve every existing id; only genuinely new blocks get new
 *     ids. Regenerating ids on edit would silently break every extract and read-
 *     point pointing at the document, so we must not.
 *
 * ## List/quote granularity (decision)
 *
 * Exactly ONE stable id per visual block ROW. Ids live on the OUTERMOST
 * block-level node of a row: a top-level `paragraph` / `heading` / `codeBlock` /
 * `horizontalRule` carries its own id, while a `listItem` / `blockquote` carries
 * the id for the row it wraps and its inner `paragraph` (or other nested block)
 * does NOT. The `bulletList` / `orderedList` containers are structural and never
 * carry an id (they are excluded from {@link BLOCK_ID_NODE_TYPES}).
 *
 * Concretely `<ul><li><p>alpha</p></li></ul>` yields a single id on the
 * `listItem`, and a blockquote yields a single id on the `blockquote` — NOT a
 * second id on the inner paragraph. Extraction (M4) therefore targets a list
 * item / blockquote (the unit a reader actually selects), and a single-row
 * selection resolves exactly ONE block id. The rule is expressed once in
 * {@link shouldCarryBlockId} and applied by the filler AND every id-collecting
 * walk (selection, read-point, reader decorations, persistence), so a row can
 * never accumulate two anchors — which would corrupt source lineage.
 *
 * The module is React-free so it stays unit-testable headlessly (no DOM): it
 * imports `@tiptap/core` + `@tiptap/pm/state` only, and the id minter is
 * renderer-safe (Web Crypto, never `node:crypto`).
 */

import { PROSEMIRROR_ROW_BLOCK_TYPES, shouldCarryProseMirrorRowBlockId } from "@interleave/core";
import { Extension } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { type BlockIdMinter, newBlockId } from "./block-ids";

/**
 * The block-level node types ELIGIBLE for a stable `blockId`. List CONTAINERS
 * (`bulletList`/`orderedList`) are excluded on purpose — ids sit on `listItem`.
 * Eligibility is necessary but not sufficient: a node only actually carries an id
 * when it is also the OUTERMOST block of its row (see {@link shouldCarryBlockId}),
 * so the inner paragraph of a `listItem` / `blockquote` — though a `paragraph`
 * here — does not. Exported so tests + the preservation transform agree on the set.
 */
export const BLOCK_ID_NODE_TYPES = PROSEMIRROR_ROW_BLOCK_TYPES;

/**
 * Whether a block-level node should CARRY a stable id, given its parent.
 *
 * Enforces the one-id-per-row invariant: an id sits on the OUTERMOST block of a
 * row only. A node is id-bearing when (a) its type is eligible
 * ({@link BLOCK_ID_NODE_TYPES}) AND (b) its parent is NOT itself an id-bearing
 * block. So a top-level paragraph/heading carries an id (its parent is the `doc`),
 * but the inner paragraph of a `listItem` / `blockquote` does NOT (its parent is
 * an id-bearing block) — the row's single id lives on the `listItem` / `blockquote`.
 *
 * `parentTypeName` is the node's direct parent's type name (`undefined`/`"doc"`
 * for a top-level block). This single predicate is the source of truth used by the
 * filler and every id-collecting walk, so the minting and reading sides can never
 * disagree about which node owns a row's id.
 */
export function shouldCarryBlockId(nodeTypeName: string, parentTypeName?: string): boolean {
  return shouldCarryProseMirrorRowBlockId(nodeTypeName, parentTypeName);
}

/** The DOM attribute the id renders to, so the reader/marks can target a block. */
export const BLOCK_ID_DOM_ATTR = "data-block-id";

/**
 * The absolute ProseMirror position where a block's flattened text content
 * (`node.textContent`) begins, given the block node and its absolute start `pos`.
 *
 * This is the absolute position of `textContent` char offset 0 — the start of the
 * block's FIRST inline text run. For a top-level paragraph/heading it is simply
 * `pos + 1` (one open token); for a block whose content is itself a block — a
 * `listItem` or `blockquote` wrapping a paragraph (and `listItem` is the chosen
 * extraction granularity) — the text begins one open token deeper PER wrapping
 * level, so this descends through leading block children, adding one token per
 * level, until it reaches the inline-content node where the text actually starts.
 *
 * IMPORTANT: this maps ONLY offset 0. A block with multiple inline text runs
 * (e.g. a blockquote of two paragraphs, or a list item with two paragraphs / a
 * nested sub-list) has open/close tokens BETWEEN its text runs, so a single
 * contiguous base cannot map every `textContent` char to an absolute position —
 * `base + offset` overcounts past the first run by the inter-run token count. For
 * any offset other than the block start, use {@link posToBlockOffset} /
 * {@link blockOffsetToPos}, which walk the block's text runs and skip the
 * inter-run tokens so the offset is a TRUE `node.textContent` index. This helper
 * remains for the single-text-run base and as the run-walk's starting anchor.
 */
export function blockTextBase(node: PmNode, pos: number): number {
  let base = pos + 1; // step inside the block node to its content
  let current: PmNode = node;
  // Descend through leading block children (listItem → paragraph, blockquote →
  // paragraph). Stop once we reach a node whose content is inline text.
  while (current.firstChild?.isBlock) {
    base += 1; // one open token per nesting level
    current = current.firstChild;
  }
  return base;
}

/**
 * Convert an absolute ProseMirror position inside a block to a TRUE
 * `node.textContent` character offset, walking the block's inline text runs and
 * skipping the open/close tokens BETWEEN them.
 *
 * `node.textContent` concatenates every descendant text run with NO separators,
 * while absolute positions include a close+open token pair between consecutive
 * inline runs (e.g. a blockquote's two paragraphs). So for any position past the
 * first run, `absPos - blockTextBase(node, pos)` overcounts by that inter-run
 * token count — this function instead accumulates run lengths and adds only the
 * within-run delta, yielding the offset that indexes `node.textContent` exactly.
 *
 * `pos` is the block node's absolute start. The result is clamped to
 * `[0, node.textContent.length]`: a position before the first run (or in a leading
 * token) maps to 0; one at/after the last run's end maps to the text length. This
 * is the inverse of {@link blockOffsetToPos}.
 */
export function posToBlockOffset(node: PmNode, pos: number, absPos: number): number {
  const contentStart = pos + 1; // absolute position of the block's content start
  let offset = 0;
  let result: number | null = null;
  // `node.descendants` yields each descendant's position RELATIVE to the block's
  // content start, in document order. Accumulate text-run lengths; when the target
  // absolute position falls inside (or at the boundary of) a run, record the offset.
  node.descendants((child, relPos) => {
    if (result !== null) return false;
    if (!child.isText) return true; // skip non-text tokens (paragraph open, etc.)
    const text = child.text ?? "";
    const runStart = contentStart + relPos; // absolute start of this text run
    const runEnd = runStart + text.length;
    if (absPos <= runStart) {
      result = offset; // before this run ⇒ end of the preceding accumulated text
      return false;
    }
    if (absPos <= runEnd) {
      result = offset + (absPos - runStart); // inside this run
      return false;
    }
    offset += text.length; // entirely after this run; keep walking
    return false; // text nodes are leaves
  });
  const textLen = node.textContent.length;
  // Past the last run (or no run matched) ⇒ clamp to the accumulated/total length.
  return Math.max(0, Math.min(result ?? offset, textLen));
}

/**
 * Convert a `node.textContent` character offset to the absolute ProseMirror
 * position inside a block, walking the block's inline text runs and inserting the
 * open/close tokens BETWEEN them.
 *
 * The inverse of {@link posToBlockOffset}: it finds the text run that contains the
 * offset and returns that run's absolute start plus the within-run delta, so the
 * caret/decoration lands on the right character even when the block has multiple
 * runs separated by inter-run tokens. `pos` is the block node's absolute start.
 *
 * The offset is clamped to `[0, node.textContent.length]` first; offset 0 maps to
 * {@link blockTextBase} and an offset at/after the text end maps to the end of the
 * last run.
 */
export function blockOffsetToPos(node: PmNode, pos: number, offset: number): number {
  const textLen = node.textContent.length;
  const target = Math.max(0, Math.min(offset, textLen));
  const contentStart = pos + 1;
  let consumed = 0;
  let result: number | null = null;
  let lastRunEnd = blockTextBase(node, pos); // fallback: end of the first run's base
  node.descendants((child, relPos) => {
    if (result !== null) return false;
    if (!child.isText) return true;
    const text = child.text ?? "";
    const runStart = contentStart + relPos;
    const runEnd = runStart + text.length;
    lastRunEnd = runEnd;
    // The offset belongs to this run when it lands within [consumed, consumed+len].
    // Use `<` for the upper bound so an offset exactly at a run boundary anchors to
    // the START of the NEXT run (skipping the inter-run tokens), matching how
    // `posToBlockOffset` maps a position at a run boundary back to that offset.
    if (target < consumed + text.length) {
      result = runStart + (target - consumed);
      return false;
    }
    consumed += text.length;
    return false;
  });
  if (result !== null) return result;
  // Offset at/after the text end ⇒ the end of the last text run.
  return lastRunEnd;
}

const blockIdPluginKey = new PluginKey("interleaveBlockId");

/**
 * The strictly-additive filler, as a pure function over an {@link EditorState}.
 *
 * Walks the document and assigns a fresh id (via `mint`) to every qualifying
 * block-level node whose `blockId` is missing OR is a same-document duplicate;
 * it NEVER changes a block that already has a unique id. Returns a transaction to
 * dispatch, or `undefined` when nothing needed an id (so it never churns the doc).
 *
 * Both the ProseMirror plugin and the headless tests call this, so the
 * preservation guarantee is exercised without standing up a DOM editor.
 */
export function fillMissingBlockIds(
  state: EditorState,
  mint: BlockIdMinter,
): Transaction | undefined {
  const tr = state.tr;
  let modified = false;
  // Track ids already present so a (rare) duplicate carried in by paste gets a
  // fresh id rather than colliding within the same document.
  const seen = new Set<string>();

  state.doc.descendants((node, pos, parent) => {
    if (!shouldCarryBlockId(node.type.name, parent?.type.name)) return true;
    const current = node.attrs.blockId as string | null | undefined;
    if (typeof current === "string" && current.length > 0 && !seen.has(current)) {
      seen.add(current);
      return true;
    }
    // Missing OR a same-document duplicate ⇒ mint a fresh, unique id.
    const fresh = mint();
    seen.add(fresh);
    tr.setNodeAttribute(pos, "blockId", fresh);
    modified = true;
    return true;
  });

  return modified ? tr : undefined;
}

/** Options for {@link BlockId} — primarily the injectable minter (for tests). */
export interface BlockIdOptions {
  /** The id minter; defaults to the renderer-safe ULID {@link newBlockId}. */
  readonly mintBlockId: BlockIdMinter;
}

/**
 * The Tiptap extension adding the global `blockId` attribute + the additive
 * filler plugin. Add it to the constrained extension array (see
 * `buildExtensions({ withBlockIds: true })`).
 */
export const BlockId = Extension.create<BlockIdOptions>({
  name: "interleaveBlockId",

  addOptions() {
    return { mintBlockId: newBlockId };
  },

  /**
   * Register `blockId` as a global attribute on exactly the block-level node
   * types. It parses from `data-block-id` and renders back to it, so a stored
   * document's ids survive an HTML/JSON round-trip; `null`/absent renders no
   * attribute (the filler assigns one on the next transaction).
   */
  addGlobalAttributes() {
    return [
      {
        types: [...BLOCK_ID_NODE_TYPES],
        attributes: {
          blockId: {
            default: null,
            // `false`: a split node does NOT inherit the parent's id — when a
            // block is split (Enter), the new half is left id-less so the additive
            // filler mints a FRESH id for it, preserving id uniqueness. (Serializing
            // the id to the document JSON is governed by parseHTML/renderHTML + the
            // attribute being declared, NOT by keepOnSplit.)
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.getAttribute(BLOCK_ID_DOM_ATTR),
            renderHTML: (attributes: { blockId?: string | null }) =>
              attributes.blockId ? { [BLOCK_ID_DOM_ATTR]: attributes.blockId } : {},
          },
        },
      },
    ];
  },

  /**
   * The strictly-additive filler: after any transaction that changed the doc,
   * assign a fresh id to every qualifying block that has none, and to nothing
   * else. Returns `undefined` (no extra transaction) when every block already
   * has an id, so it never churns the document or re-renders needlessly.
   */
  addProseMirrorPlugins() {
    const mint = this.options.mintBlockId;
    return [
      new Plugin({
        key: blockIdPluginKey,
        // After any change, mint ids for blocks that lack one (and only those),
        // AND on the very first state (no transactions) so a freshly-loaded
        // document with un-id'd blocks gets ids without waiting for an edit.
        appendTransaction: (transactions, _oldState, newState) => {
          const docChanged = transactions.some((tr) => tr.docChanged);
          if (transactions.length > 0 && !docChanged) return undefined;
          return fillMissingBlockIds(newState, mint);
        },
      }),
    ];
  },
});
