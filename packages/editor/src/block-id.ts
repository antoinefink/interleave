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
 * ## List granularity (decision)
 *
 * Ids live on `listItem` (the leaf list rows), NOT on the `bulletList` /
 * `orderedList` containers. Extraction (M4) targets a list item, which is the
 * unit a reader actually selects; the container is structural. The container
 * nodes are intentionally excluded from {@link BLOCK_ID_NODE_TYPES}.
 *
 * The module is React-free so it stays unit-testable headlessly (no DOM): it
 * imports `@tiptap/core` + `@tiptap/pm/state` only, and the id minter is
 * renderer-safe (Web Crypto, never `node:crypto`).
 */

import { Extension } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { type BlockIdMinter, newBlockId } from "./block-ids";

/**
 * The block-level node types that carry a stable `blockId`. List CONTAINERS
 * (`bulletList`/`orderedList`) are excluded on purpose — ids sit on `listItem`.
 * Exported so tests + the preservation transform agree on the exact set.
 */
export const BLOCK_ID_NODE_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "listItem",
] as const;

const BLOCK_ID_NODE_SET = new Set<string>(BLOCK_ID_NODE_TYPES);

/** The DOM attribute the id renders to, so the reader/marks can target a block. */
export const BLOCK_ID_DOM_ATTR = "data-block-id";

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

  state.doc.descendants((node, pos) => {
    if (!BLOCK_ID_NODE_SET.has(node.type.name)) return true;
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
            // Keep the id in the document JSON (the canonical persisted form).
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
