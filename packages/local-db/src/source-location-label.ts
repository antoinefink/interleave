/**
 * Source-location label derivation (T021/T022).
 *
 * Every extract carries a stored, human-readable `source_locations.label` so the
 * inspector + extract view can show "where it came from" and the jump-to-source
 * affordance (T022) has a name to flash. The label is derived at extraction time
 * from the originating block's position in the source body — its 1-based
 * paragraph/heading index ("¶4", "Heading 2 · ¶4") — never an absolute position,
 * so it reads the same way the user sees the document.
 *
 * Pure + framework-free: it takes the ordered stable block ids of the source body
 * (what `document_blocks` already stores) and the first spanned block id, so it is
 * unit-testable without a DB and reused identically by the extract path (T021) and
 * the sub-extract path (T025). When the block is not found (e.g. a re-import
 * dropped it) it falls back to a generic "Selected text" label rather than a dead
 * end.
 */

/** A minimal ordered-block descriptor for label derivation. */
export interface LabelBlock {
  /** The stable block id (matches `document_blocks.stableBlockId`). */
  readonly stableBlockId: string;
  /** The block type (e.g. `paragraph`, `heading`). */
  readonly blockType: string;
  /** 0-based document order. */
  readonly order: number;
}

/**
 * Derive a human-readable label for a selection anchored at `firstBlockId` within
 * a source whose ordered blocks are `blocks`. Returns "¶N" for a paragraph (1-based
 * among all blocks in document order) or "<Type> · ¶N" for a non-paragraph block
 * (e.g. "Heading · ¶3"). Falls back to "Selected text" when the block is unknown.
 */
export function deriveSourceLocationLabel(
  blocks: readonly LabelBlock[],
  firstBlockId: string,
): string {
  const sorted = [...blocks].sort((a, b) => a.order - b.order);
  const index = sorted.findIndex((b) => b.stableBlockId === firstBlockId);
  if (index < 0) return "Selected text";
  const paraNumber = index + 1;
  const block = sorted[index];
  if (block && block.blockType !== "paragraph") {
    const typeLabel = block.blockType.charAt(0).toUpperCase() + block.blockType.slice(1);
    return `${typeLabel} · ¶${paraNumber}`;
  }
  return `¶${paraNumber}`;
}
