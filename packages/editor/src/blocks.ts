/**
 * Block preservation transform (T016) — read stable ids OFF the document JSON.
 *
 * `toBlockInputs(doc)` walks a ProseMirror document and emits one descriptor per
 * block-level node, reading the `blockId` attribute the {@link BlockId} extension
 * maintains. The ids are read, never minted, here: the editor's additive filler
 * already guarantees every block has a stable id, so the save path simply mirrors
 * them into `document_blocks`. On re-import of the same source, an incoming doc
 * whose blocks still carry their `blockId`s is preserved verbatim — only blocks
 * with no id at all are skipped (the editor will fill them before a save).
 *
 * The output shape matches `DocumentRepository.upsert({ blocks })`'s
 * `DocumentBlockInput` so the renderer can pass it straight across `documents.save`
 * (the main process persists exactly what it receives — see the layering rule).
 *
 * Framework-agnostic on purpose (a plain JSON walk, no editor instance / DOM), so
 * it runs in Vitest and could be reused in the main process if ever needed.
 */

import type { BlockId } from "@interleave/core";
import { BLOCK_ID_NODE_TYPES } from "./block-id";

/** One stable block to persist — mirrors `local-db`'s `DocumentBlockInput`. */
export interface DocumentBlockInput {
  /** The ProseMirror node type, e.g. `paragraph`, `heading`, `listItem`. */
  readonly blockType: string;
  /** 0-based position of the block in document order. */
  readonly order: number;
  /** The stable id read off the node's `blockId` attribute (never minted here). */
  readonly stableBlockId: BlockId;
}

/** A minimal structural view of a ProseMirror node for the walk. */
interface PmNode {
  readonly type?: string;
  readonly attrs?: { readonly blockId?: unknown } & Record<string, unknown>;
  readonly content?: readonly PmNode[];
}

const BLOCK_ID_NODE_SET = new Set<string>(BLOCK_ID_NODE_TYPES);

/**
 * Derive the ordered, stable-id block list from a ProseMirror document JSON.
 *
 * Visits nodes depth-first in document order; for each block-level node that
 * carries a non-empty `blockId`, emits a descriptor with its type, sequential
 * `order`, and the existing id. Blocks without a `blockId` are skipped (the
 * editor's filler assigns ids before any real save, so this only guards against
 * a raw/un-editor-processed doc). The result feeds `DocumentRepository.upsert`.
 */
export function toBlockInputs(doc: unknown): DocumentBlockInput[] {
  const out: DocumentBlockInput[] = [];
  if (!doc || typeof doc !== "object") return out;

  let order = 0;
  const visit = (node: PmNode): void => {
    const type = node.type ?? "";
    if (BLOCK_ID_NODE_SET.has(type)) {
      const id = node.attrs?.blockId;
      if (typeof id === "string" && id.length > 0) {
        out.push({ blockType: type, order, stableBlockId: id as BlockId });
        order += 1;
      }
    }
    if (node.content) {
      for (const child of node.content) visit(child);
    }
  };

  visit(doc as PmNode);
  return out;
}

/** Collect just the stable block ids of a document, in order (test/diff helper). */
export function blockIdsOf(doc: unknown): BlockId[] {
  return toBlockInputs(doc).map((b) => b.stableBlockId);
}
