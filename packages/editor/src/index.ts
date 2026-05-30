/**
 * @interleave/editor — Tiptap/ProseMirror schema, serialization, and the React
 * source editor.
 *
 * Documents are the substrate for extraction lineage, not just display. This
 * package owns the **constrained** document schema (T015), the framework-
 * agnostic JSON↔plain-text helpers (T015), the **stable block IDs** (T016) that
 * extracts / read-points / source-locations / sync all anchor to, and — landing
 * in later M4 tasks — highlight / extracted-span / processed-span / cloze marks
 * and the extraction commands. The schema, serialization, and block-id helpers
 * stay React-free so they are unit-testable without a DOM; only
 * {@link SourceEditor} pulls in React.
 */

export const EDITOR_PACKAGE = "@interleave/editor" as const;

// Read-points (T017): resolve/jump/resume helpers that anchor to stable block ids.
export type { Editor } from "@tiptap/core";
// Stable block ids (T016): the load-bearing anchor extracts/read-points/sync use.
export {
  BLOCK_ID_DOM_ATTR,
  BLOCK_ID_NODE_TYPES,
  BlockId,
  type BlockIdOptions,
  fillMissingBlockIds,
  shouldCarryBlockId,
} from "./block-id";
export { type BlockIdMinter, newBlockId } from "./block-ids";
export { blockIdsOf, type DocumentBlockInput, toBlockInputs } from "./blocks";
// Jump-to-source (T022): actionable lineage — scroll the originating block into
// view + flash the kit's accent ring, resolving ALWAYS by stable block id.
export {
  flashBlock,
  JUMP_FLASH_MS,
  type JumpToSourceOptions,
  type JumpToSourceResult,
  jumpToSource,
  scrollBlockIntoView,
} from "./jump-to-source";
// Mark extensions (Highlight / ProcessedSpan / Cloze) — SCHEMA-COMPLETENESS /
// TEST-ONLY FIXTURES, *not* part of the active editor surface.
//
// The live app does NOT install these in `SourceEditor` or the reader: highlights
// (T020), processed spans (T026), and cloze deletions (T034) are persisted as
// `document_marks` rows keyed by stable block id + range (cloze: `cards.cloze`
// numbered text), and rendered as ProseMirror *decorations* (see
// `reader-decorations.ts`) — never as inline marks stored in the document JSON.
// Keeping them out of the body keeps marks out of the extraction substrate and
// lets them re-anchor by block id after a re-import. These three `Mark.create`
// extensions + their set/toggle/unset commands exist only so the `mark.hl` /
// `mark.dimmed` / `span.cloze` shapes are first-class, individually unit-testable
// parts of the schema and so a future in-body command (should one ever be wanted)
// has a real Tiptap entry point. Do not assume installing them is required for the
// running reader/editor — it is not.
//
// Cloze mark (T034): the cloze-deletion span on a CARD body (`span.cloze`,
// carrying a `clozeIndex` attr). Reuses the T020 mark surface with
// `markType: "cloze"`; the canonical source of truth is `cards.cloze` numbered text.
export {
  CLOZE_MARK_CLASS,
  CLOZE_MARK_NAME,
  Cloze,
} from "./marks/cloze";
// Highlight mark (T020): renders `<mark class="hl">`. See the test-only fixture
// note above — the canonical persistence is a `document_marks` row keyed by stable
// block id + range, rendered as an inline decoration, not this stored body mark.
export {
  HIGHLIGHT_MARK_CLASS,
  HIGHLIGHT_MARK_NAME,
  Highlight,
} from "./marks/highlight";
// Processed-span mark (T026): dim a read/extracted passage (`mark.dimmed`) so the
// user can declutter a long source WITHOUT deleting content. Reversible; persisted
// as a `processed_span` `document_marks` row (reusing the T020 mark surface), kept
// strictly separate from highlight (`mark.hl`) and extracted-span (`mark.extracted`).
// See the test-only fixture note above.
export {
  PROCESSED_MARK_CLASS,
  PROCESSED_MARK_NAME,
  ProcessedSpan,
} from "./marks/processed";
export {
  clampOffsetToBlock,
  firstUnreadBlockId,
  isBlockAtOrAfterReadPoint,
  type JumpResult,
  type JumpToReadPointOptions,
  jumpToReadPoint,
  type ResolvedReadPoint,
  readPointProgress,
  readPointProgressFraction,
  readThroughBlock,
  resolveReadPointFromSelection,
  resolveReadPointFromState,
} from "./read-point";
// Reader display decorations (T018): the read-point divider + extracted-span
// markers, drawn as ProseMirror decorations (not DOM mutation) and pushed via
// `setReaderDecorations`.
export {
  createReaderDecorationsPlugin,
  type HighlightDecoration,
  type ProcessedDecoration,
  type ReaderDecorationState,
  ReaderDecorations,
  readerDecorationsKey,
  setReaderDecorations,
} from "./reader-decorations";
export {
  SourceEditor,
  type SourceEditorChange,
  type SourceEditorProps,
} from "./SourceEditor";
export {
  ALLOWED_HEADING_LEVELS,
  ALLOWED_MARK_NAMES,
  ALLOWED_NODE_NAMES,
  type BuildExtensionsOptions,
  buildExtensions,
  buildSchema,
  interleaveExtensions,
} from "./schema";
// Selection → source-location resolution (T019): turn a live ProseMirror
// selection into the stable block-ids + offsets + snapshot the selection toolbar
// hands to the highlight (T020) / extraction (T021) commands. Headless + pure.
export {
  resolveSelectionLocation,
  type SelectionLocation,
} from "./selection-location";
export { emptyDoc, toPlainText } from "./serialize";
