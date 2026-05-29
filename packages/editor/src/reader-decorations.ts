/**
 * Reader display decorations (T018) — a ProseMirror decoration plugin.
 *
 * The source reader renders the document body through the same constrained Tiptap
 * editor (`SourceEditor`) in a read-leaning mode. On top of that live surface the
 * reader needs two purely-visual affordances from the design kit
 * (`screen-reader.jsx`):
 *
 *  1. the `.readpoint` divider — a dashed accent rule inserted BEFORE the first
 *     unread block (the block after the stored read-point), with the
 *     "↓ unread from here" hint;
 *  2. `mark.extracted` display markers — the already-extracted blocks (those a
 *     child extract anchors to) get the `extracted` class so they read as the
 *     kit's extracted spans. **M3 only DISPLAYS these; creating extracts is M4.**
 *
 * Both anchor to the STABLE block ids (T016). Crucially, this is implemented as
 * ProseMirror **Decorations** — NOT by mutating the editor-owned DOM. ProseMirror
 * re-renders block nodes on every transaction (the block-id filler mints ids for
 * new blocks just after mount), so a direct DOM mutation would be wiped, and
 * inserting nodes into the contenteditable fights the view's MutationObserver.
 * A widget decoration (divider) + node decorations (extracted class / read-point
 * marker) are the supported overlay mechanism: ProseMirror re-applies them across
 * its own re-renders.
 *
 * Keeping this in `@interleave/editor` — not a React component — honors the
 * layering rule that editor/ProseMirror logic lives in the editor package; the
 * reader just installs the extension and pushes the latest inputs via
 * {@link setReaderDecorations}.
 */

import type { Editor } from "@tiptap/core";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BLOCK_ID_NODE_TYPES } from "./block-id";

const BLOCK_ID_NODE_SET = new Set<string>(BLOCK_ID_NODE_TYPES);

/**
 * One persisted highlight to overlay (T020): a STABLE block id + the
 * `[start,end]` character range within that block's text. The reader renders it as
 * an INLINE `mark.hl` decoration (not a stored body mark) so highlights re-anchor
 * by block id after a re-import and never enter the document JSON / extraction
 * substrate. `markId` lets the reader map a clicked highlight back to the
 * `document_marks` row to remove it.
 */
export interface HighlightDecoration {
  /** The `document_marks.id` of the persisted highlight. */
  readonly markId: string;
  /** The STABLE block id the highlight anchors to. */
  readonly blockId: string;
  /** Char offset within the block where the highlight starts (`>= 0`). */
  readonly start: number;
  /** Char offset within the block where the highlight ends (`> start`). */
  readonly end: number;
}

/** The inputs that drive the reader decorations (pushed by the host). */
export interface ReaderDecorationState {
  /** The first UNREAD block id; the divider is placed before it. `null` ⇒ none. */
  readonly firstUnreadBlockId: string | null;
  /** The read-point's block id (marked as the resume anchor). `null` ⇒ none. */
  readonly readPointBlockId: string | null;
  /** Block ids that already have a child extract anchored to them (display only). */
  readonly extractedBlockIds: readonly string[];
  /** Persisted highlights to overlay as `mark.hl` inline decorations (T020). */
  readonly highlights: readonly HighlightDecoration[];
}

const EMPTY_STATE: ReaderDecorationState = {
  firstUnreadBlockId: null,
  readPointBlockId: null,
  extractedBlockIds: [],
  highlights: [],
};

/** Plugin key carrying the latest {@link ReaderDecorationState}. */
export const readerDecorationsKey = new PluginKey<ReaderDecorationState>(
  "interleaveReaderDecorations",
);

/** A transaction meta payload that replaces the plugin's decoration inputs. */
interface ReaderDecorationMeta {
  readonly state: ReaderDecorationState;
}

/** Build the `.readpoint` divider widget DOM (matches the kit). */
function buildDivider(): HTMLElement {
  const divider = document.createElement("div");
  divider.className = "readpoint";
  divider.setAttribute("contenteditable", "false");
  divider.setAttribute("data-readpoint-divider", "true");
  const hint = document.createElement("span");
  hint.className = "readpoint__hint";
  hint.textContent = "↓ unread from here";
  divider.appendChild(hint);
  return divider;
}

/**
 * Construct the reader-decoration ProseMirror plugin. Exported so both the Tiptap
 * extension and the headless unit tests instantiate the SAME plugin definition
 * (avoiding a second prosemirror-model copy from a separate compile path).
 */
export function createReaderDecorationsPlugin(): Plugin<ReaderDecorationState> {
  return new Plugin<ReaderDecorationState>({
    key: readerDecorationsKey,
    state: {
      init: () => EMPTY_STATE,
      apply(tr, value) {
        const meta = tr.getMeta(readerDecorationsKey) as ReaderDecorationMeta | undefined;
        return meta ? meta.state : value;
      },
    },
    props: {
      decorations(editorState) {
        const inputs = readerDecorationsKey.getState(editorState) ?? EMPTY_STATE;
        const extracted = new Set(inputs.extractedBlockIds);
        // Group highlights by block id so a single doc walk can place them inline.
        const highlightsByBlock = new Map<string, HighlightDecoration[]>();
        for (const hl of inputs.highlights) {
          const list = highlightsByBlock.get(hl.blockId);
          if (list) list.push(hl);
          else highlightsByBlock.set(hl.blockId, [hl]);
        }
        const decorations: Decoration[] = [];

        editorState.doc.descendants((node, pos) => {
          if (!BLOCK_ID_NODE_SET.has(node.type.name)) return true;
          const blockId = node.attrs.blockId as string | null | undefined;
          if (typeof blockId !== "string" || blockId.length === 0) return true;

          // Node decoration: extracted-span display class + read-point anchor.
          const classes: string[] = [];
          if (extracted.has(blockId)) classes.push("extracted");
          const attrs: { class?: string; "data-readpoint-block"?: string } = {};
          if (classes.length > 0) attrs.class = classes.join(" ");
          if (blockId === inputs.readPointBlockId) attrs["data-readpoint-block"] = "true";
          if (attrs.class || attrs["data-readpoint-block"]) {
            decorations.push(Decoration.node(pos, pos + node.nodeSize, attrs));
          }

          // Widget decoration: the read-point divider, just before the first unread
          // block. `side: -1` keeps it ahead of the block content.
          if (blockId === inputs.firstUnreadBlockId) {
            decorations.push(
              Decoration.widget(pos, buildDivider, { side: -1, key: "readpoint-divider" }),
            );
          }

          // Inline decorations: persisted highlights for this block, mapped from
          // block-relative `[start,end]` offsets onto absolute document positions.
          // The block's text starts at `pos + 1` (step inside the block node); we
          // clamp to the block's text length so a stale range can never run past it.
          const blockHighlights = highlightsByBlock.get(blockId);
          if (blockHighlights) {
            const textStart = pos + 1;
            const textLen = node.textContent.length;
            for (const hl of blockHighlights) {
              const start = Math.max(0, Math.min(hl.start, textLen));
              const end = Math.max(start, Math.min(hl.end, textLen));
              if (end <= start) continue;
              decorations.push(
                Decoration.inline(
                  textStart + start,
                  textStart + end,
                  // `nodeName: "mark"` wraps the range in `<mark class="hl">`
                  // (matching the design kit) instead of the default `<span>`.
                  { nodeName: "mark", class: "hl", "data-mark-id": hl.markId },
                  { inclusiveStart: false, inclusiveEnd: false },
                ),
              );
            }
          }
          // Block nodes are leaves for this walk (ids live on block level).
          return false;
        });

        return DecorationSet.create(editorState.doc, decorations);
      },
    },
  });
}

/**
 * The Tiptap extension that draws the reader's display decorations. Install it in
 * the editor's extension list (the reader passes it via `SourceEditor`'s schema);
 * push the latest inputs with {@link setReaderDecorations}.
 */
export const ReaderDecorations = Extension.create({
  name: "interleaveReaderDecorations",

  addProseMirrorPlugins() {
    return [createReaderDecorationsPlugin()];
  },
});

/**
 * Push the latest decoration inputs into the editor (dispatches a metadata-only
 * transaction — no document change, so it does not touch the body or trigger a
 * save). Idempotent; safe to call on every doc/read-point/extract change. No-op
 * when the editor is gone.
 */
export function setReaderDecorations(editor: Editor | null, state: ReaderDecorationState): void {
  if (!editor) return;
  const meta: ReaderDecorationMeta = { state };
  const tr = editor.state.tr.setMeta(readerDecorationsKey, meta);
  // Metadata-only transactions still need dispatch to update plugin state.
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
}
