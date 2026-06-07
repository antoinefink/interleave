/**
 * Selection → source-location resolution (T019).
 *
 * The text-selection toolbar (T019) is the single entry point to every M4 action
 * (highlight, extract, cloze). Before any of those can persist lineage, the
 * renderer must turn a live ProseMirror selection into a STABLE, storable anchor:
 * the ordered list of block ids (from T016) the selection spans, plus the
 * character offsets within the first and last spanned block, plus a verbatim
 * snapshot of the selected text. That anchor is exactly the shape
 * `source_locations` stores (`blockIds`, `startOffset`, `endOffset`,
 * `selectedText`) and what T021's `extractions.create` / T020's `documents.marks`
 * consume — so resolving it correctly here is the load-bearing part of T019.
 *
 * This module is the headless, framework-free core of that resolution: it takes a
 * raw ProseMirror {@link EditorState} (what the live editor wrapper reads) and
 * returns a {@link SelectionLocation}, exactly like the sibling read-point helpers
 * (`resolveReadPointFromState`). It NEVER touches the DOM, `window.appApi`,
 * SQLite, or React — the renderer's `useTextSelection` hook owns the DOM rect +
 * UI state, and the toolbar is purely presentational. Keeping the offset/blockId
 * math here means it is unit-testable without standing up a DOM editor and reused
 * identically by the extract path (T021) and the sub-extract path (T025).
 *
 * Offsets are measured from the start of each block's text content (matching the
 * read-point `offset` semantics) so they line up with `document_blocks` text and
 * survive a re-import: marks/locations re-anchor by block id, never by absolute
 * ProseMirror position (see the M4 op-log note + the T020 "ranges are per stable
 * block id" risk).
 */

import type { Node as PmNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection } from "@tiptap/pm/state";
import { posToBlockOffset, shouldCarryBlockId } from "./block-id";

/**
 * A resolved selection anchor: the ordered stable block ids the selection spans,
 * the character offset within the FIRST spanned block where the selection starts,
 * the character offset within the LAST spanned block where it ends, and a verbatim
 * snapshot of the selected text. This is the renderer-side shape the toolbar hands
 * to `documents.marks.add` (T020) and `extractions.create` (T021); on the main
 * side it maps directly onto `source_locations` (`blockIds` / `startOffset` /
 * `endOffset` / `selectedText`).
 */
export interface SelectionLocation {
  /** Ordered stable block ids spanned by the selection (≥ 1, document order). */
  readonly blockIds: readonly string[];
  /** Char offset within the FIRST spanned block where the selection starts. */
  readonly startOffset: number;
  /** Char offset within the LAST spanned block where the selection ends. */
  readonly endOffset: number;
  /** Verbatim snapshot of the selected text (the user's exact selection). */
  readonly selectedText: string;
  /** Whether the selection spans more than one block (cross-block select). */
  readonly crossBlock: boolean;
}

/**
 * Find the nearest enclosing block-level node (one carrying a non-empty
 * `blockId`) at a given resolved position, returning the block id and the TRUE
 * `node.textContent` character offset of the position within that block.
 *
 * The offset is computed by {@link posToBlockOffset}, which walks the block's
 * inline text runs and skips the open/close tokens BETWEEN them — so for a block
 * with multiple text runs (a multi-paragraph blockquote, or a list item with two
 * paragraphs / a nested sub-list) the offset is a real index into
 * `node.textContent`, not inflated by the nesting depth NOR by the inter-run
 * tokens. It lines up with the reader-decoration / jump-to-source math, which use
 * the inverse {@link blockOffsetToPos}. Returns `null` when the position is not
 * inside an id'd block (e.g. an un-id'd freshly typed block).
 */
function blockAt(
  $pos: ReturnType<EditorState["doc"]["resolve"]>,
): { blockId: string; offset: number } | null {
  for (let depth = $pos.depth; depth >= 0; depth--) {
    const node = $pos.node(depth);
    const parentType = depth > 0 ? $pos.node(depth - 1).type.name : undefined;
    // Resolve to the OUTERMOST row block (the listItem/blockquote), not a stray id
    // on its inner paragraph, so a single list-row endpoint maps to ONE block id.
    if (!shouldCarryBlockId(node.type.name, parentType)) continue;
    const blockId = node.attrs.blockId as string | null | undefined;
    if (typeof blockId !== "string" || blockId.length === 0) continue;
    return {
      blockId,
      offset: posToBlockOffset(node, $pos.before(depth), $pos.pos),
    };
  }
  return null;
}

function atomSelectionText(node: PmNode): string {
  if (node.type.name !== "image") return "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt.trim() : "";
  if (alt.length > 0) return alt;
  const title = typeof node.attrs.title === "string" ? node.attrs.title.trim() : "";
  return title;
}

function resolveNodeSelectionLocation(state: EditorState): SelectionLocation | null {
  if (!(state.selection instanceof NodeSelection)) return null;
  const node = state.selection.node;
  const parentType = state.selection.$from.parent.type.name;
  if (!shouldCarryBlockId(node.type.name, parentType)) return null;
  const blockId = node.attrs.blockId as string | null | undefined;
  if (typeof blockId !== "string" || blockId.length === 0) return null;

  return {
    blockIds: [blockId],
    startOffset: 0,
    endOffset: 0,
    selectedText: atomSelectionText(node),
    crossBlock: false,
  };
}

/**
 * Resolve the {@link SelectionLocation} for a raw ProseMirror {@link EditorState}.
 *
 * Returns `null` when there is nothing to act on:
 *  - the selection is empty (a bare caret — no run of text), or
 *  - the selection's endpoints are not inside id'd block-level nodes.
 *
 * For a single-block selection `blockIds` has one entry and `start/endOffset` are
 * the caret offsets within it. For a CROSS-BLOCK selection it returns EVERY block
 * id from the first to the last spanned block in document order (so extraction can
 * record the full span — see the T019 "cross-node selections must still resolve a
 * multi-block location" note), with `startOffset` in the first block and
 * `endOffset` in the last. Pure + DOM-free, so it is unit-testable headlessly.
 */
export function resolveSelectionLocation(state: EditorState): SelectionLocation | null {
  const nodeSelection = resolveNodeSelectionLocation(state);
  if (nodeSelection) return nodeSelection;

  const { from, to, empty } = state.selection;
  if (empty || from === to) return null;

  const fromBlock = blockAt(state.doc.resolve(from));
  const toBlock = blockAt(state.doc.resolve(to));
  if (!fromBlock || !toBlock) return null;

  // Walk the doc once to collect, in order, every id'd block whose range overlaps
  // [from, to]. We compare against the block's ABSOLUTE node span ([pos, pos +
  // nodeSize]) rather than its text base + textContent.length: for a block with
  // multiple text runs the text-content length undercounts the node's real extent
  // (it omits the inter-run tokens), which would wrongly drop a trailing block
  // from a cross-block selection. The node span is the true overlap interval.
  //
  // CRUCIAL for nested lists: id'd rows can NEST (an outer `listItem` whose node
  // span CONTAINS an inner `listItem` — reachable by Tab-indenting). A naive
  // overlap test would collect BOTH the outer and the inner row for a selection
  // lying entirely inside the inner row, producing an internally inconsistent
  // anchor: `blockAt` resolves the endpoints to the INNERMOST id'd row, so the
  // offsets index the INNER text, but `blockIds[0]` would be the OUTER row — and
  // the highlight/extract consumer (apps/web .../useHighlights) applies
  // `startOffset..end` against `blockIds[0]`, silently writing the range over the
  // WRONG text in the wrong block and corrupting the source-lineage anchor. So we
  // collect only the INNERMOST id'd rows overlapping [from, to], DROPPING any
  // ancestor row that fully contains a deeper overlapping id'd row.
  //
  // Gather every overlapping id'd row with its absolute node span (document order).
  const overlaps: { blockId: string; start: number; end: number }[] = [];
  state.doc.descendants((node, pos, parent) => {
    // Only the OUTERMOST row block of a list item / blockquote *eligibly* contributes
    // an id; its inner paragraph is skipped so a single non-nested row never yields
    // TWO overlapping block ids (which would falsely report crossBlock).
    if (!shouldCarryBlockId(node.type.name, parent?.type.name)) return true;
    const blockId = node.attrs.blockId as string | null | undefined;
    if (typeof blockId !== "string" || blockId.length === 0) return true;
    const blockStart = pos + 1; // first inside position of the block node
    const blockEnd = pos + node.nodeSize - 1; // last inside position
    // Overlap test (inclusive of touching the boundary so a selection ending at a
    // block's start still includes the block it starts in, not the previous one).
    if (blockStart <= to && blockEnd >= from) {
      overlaps.push({ blockId, start: blockStart, end: blockEnd });
    }
    return true;
  });

  // Keep only the INNERMOST id'd rows: drop any row whose span STRICTLY contains
  // another overlapping row's span (it is an ancestor of a deeper id'd row the
  // selection also touches, so its offsets/text are not what the endpoints —
  // resolved to the innermost row — describe).
  let blockIds: string[] = overlaps
    .filter(
      (block) =>
        !overlaps.some(
          (other) => other !== block && block.start <= other.start && block.end >= other.end,
        ),
    )
    .map((block) => block.blockId);

  // Pin the endpoints. `startOffset`/`endOffset` are offsets into `fromBlock` /
  // `toBlock` respectively (the innermost id'd rows the caret endpoints land in),
  // and the consumer indexes `blockIds[0]` with `startOffset` and `blockIds.at(-1)`
  // with `endOffset` — so `blockIds` MUST begin at `fromBlock` and end at
  // `toBlock`. The innermost-filter normally yields exactly that, but a degenerate
  // walk (e.g. an endpoint at a row boundary, or an atom block the overlap test
  // skipped) could drift; clamping here keeps the anchor internally consistent so
  // a within-row selection is `[innerRow]` and a true cross-row span runs
  // `fromBlock … toBlock`.
  const firstIdx = blockIds.indexOf(fromBlock.blockId);
  blockIds = firstIdx > 0 ? blockIds.slice(firstIdx) : blockIds;
  if (blockIds[0] !== fromBlock.blockId) blockIds.unshift(fromBlock.blockId);
  const lastIdx = blockIds.lastIndexOf(toBlock.blockId);
  if (lastIdx >= 0) blockIds = blockIds.slice(0, lastIdx + 1);
  else if (toBlock.blockId !== fromBlock.blockId) blockIds.push(toBlock.blockId);
  // Collapse to a single row when both endpoints resolved to the same id'd row.
  if (fromBlock.blockId === toBlock.blockId) blockIds = [fromBlock.blockId];

  // `blockAt` already converted each endpoint to a TRUE `node.textContent` offset
  // via `posToBlockOffset` (run-walking, inter-run tokens skipped), so these are
  // real indices into the block text — `blockText.slice(startOffset, endOffset)`
  // is the selected text even for a multi-text-run block.
  const startOffset = fromBlock.offset;
  const endOffset = toBlock.offset;
  // `textBetween` with a block separator mirrors `Node.textContent` across blocks,
  // so the snapshot reads as the user sees it (one newline between paragraphs).
  const selectedText = state.doc.textBetween(from, to, "\n", "\n");

  return {
    blockIds,
    startOffset,
    endOffset,
    selectedText,
    crossBlock: blockIds.length > 1,
  };
}
