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
} from "./block-id";
export { type BlockIdMinter, newBlockId } from "./block-ids";
export { blockIdsOf, type DocumentBlockInput, toBlockInputs } from "./blocks";
export {
  clampOffsetToBlock,
  firstUnreadBlockId,
  type JumpResult,
  type JumpToReadPointOptions,
  jumpToReadPoint,
  type ResolvedReadPoint,
  readPointProgress,
  readThroughBlock,
  resolveReadPointFromSelection,
  resolveReadPointFromState,
} from "./read-point";
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
export { emptyDoc, toPlainText } from "./serialize";
