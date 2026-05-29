/**
 * DocumentRepository (T008) — the editable rich-text body + its stable blocks.
 *
 * A `documents` row is the ProseMirror body of an element (keyed 1:1 by element
 * id); `document_blocks` carries the STABLE block ids that extracts, read-points,
 * and the eventual sync anchor to. Those stable ids are load-bearing: they must
 * survive re-imports and saves, so extraction lineage stays valid. This
 * repository upserts the document body and replaces its block set, and logs
 * `update_document` for the mutation.
 *
 * `document_marks` (highlight / extracted-span / cloze) land with the reader
 * features (M2); the M1 surface is the body + blocks + read-point persistence
 * that lineage depends on.
 */

import type { BlockId, Document, ElementId, IsoTimestamp } from "@interleave/core";
import {
  type DocumentBlockRow,
  documentBlocks,
  documents,
  type InterleaveDatabase,
  readPoints,
} from "@interleave/db";
import { eq } from "drizzle-orm";
import { newRowId, nowIso } from "./ids";
import { rowToDocument } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";

/** One stable block to persist for a document. */
export interface DocumentBlockInput {
  readonly blockType: string;
  readonly order: number;
  readonly stableBlockId: BlockId;
}

/** Arguments to create/replace a document body + its blocks. */
export interface UpsertDocumentInput {
  readonly elementId: ElementId;
  readonly prosemirrorJson: unknown;
  readonly plainText: string;
  readonly schemaVersion?: number;
  readonly blocks?: readonly DocumentBlockInput[];
}

/** A read-point row (resume position) for a source/topic. */
export interface ReadPointInput {
  readonly elementId: ElementId;
  readonly documentId: ElementId;
  readonly blockId: BlockId;
  readonly offset: number;
}

export class DocumentRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /** Fetch a document body by its owning element id, or `null`. */
  findById(elementId: ElementId): Document | null {
    const row = this.db.select().from(documents).where(eq(documents.elementId, elementId)).get();
    return row ? rowToDocument(row) : null;
  }

  /** The stable blocks of a document, in document order. */
  listBlocks(elementId: ElementId): DocumentBlockRow[] {
    return this.db
      .select()
      .from(documentBlocks)
      .where(eq(documentBlocks.documentId, elementId))
      .all()
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Create or replace a document body and (optionally) its block set, then log
   * `update_document`. The body upsert + block replacement + op append all run
   * in one transaction so a half-written document can never persist.
   */
  upsert(input: UpsertDocumentInput): Document {
    return this.db.transaction((tx) => {
      const updatedAt = nowIso();
      const json = JSON.stringify(input.prosemirrorJson ?? { type: "doc", content: [] });
      const schemaVersion = input.schemaVersion ?? 1;

      tx.insert(documents)
        .values({
          elementId: input.elementId,
          prosemirrorJson: json,
          plainText: input.plainText,
          schemaVersion,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: documents.elementId,
          set: { prosemirrorJson: json, plainText: input.plainText, schemaVersion, updatedAt },
        })
        .run();

      if (input.blocks) {
        tx.delete(documentBlocks).where(eq(documentBlocks.documentId, input.elementId)).run();
        for (const block of input.blocks) {
          tx.insert(documentBlocks)
            .values({
              id: newRowId(),
              documentId: input.elementId,
              blockType: block.blockType,
              order: block.order,
              stableBlockId: block.stableBlockId,
            })
            .run();
        }
      }

      new OperationLogRepository(tx).append(tx, {
        opType: "update_document",
        elementId: input.elementId,
        payload: { elementId: input.elementId, schemaVersion, blockCount: input.blocks?.length },
      });

      return {
        elementId: input.elementId,
        prosemirrorJson: input.prosemirrorJson ?? { type: "doc", content: [] },
        plainText: input.plainText,
        schemaVersion,
        updatedAt,
      };
    });
  }

  /** Read the read-point (resume position) for an element, or `null`. */
  getReadPoint(
    elementId: ElementId,
  ): { blockId: BlockId; offset: number; updatedAt: IsoTimestamp } | null {
    const row = this.db.select().from(readPoints).where(eq(readPoints.elementId, elementId)).get();
    if (!row) return null;
    return { blockId: row.blockId as BlockId, offset: row.offset, updatedAt: row.updatedAt };
  }

  /**
   * Set/advance the read-point for an element (one per element) and log
   * `set_read_point`. Upserts on the owning element id.
   */
  setReadPoint(input: ReadPointInput): {
    blockId: BlockId;
    offset: number;
    updatedAt: IsoTimestamp;
  } {
    return this.db.transaction((tx) => {
      const updatedAt = nowIso();
      const existing = tx
        .select()
        .from(readPoints)
        .where(eq(readPoints.elementId, input.elementId))
        .get();
      if (existing) {
        tx.update(readPoints)
          .set({
            documentId: input.documentId,
            blockId: input.blockId,
            offset: input.offset,
            updatedAt,
          })
          .where(eq(readPoints.elementId, input.elementId))
          .run();
      } else {
        tx.insert(readPoints)
          .values({
            id: newRowId(),
            elementId: input.elementId,
            documentId: input.documentId,
            blockId: input.blockId,
            offset: input.offset,
            updatedAt,
          })
          .run();
      }
      new OperationLogRepository(tx).append(tx, {
        opType: "set_read_point",
        elementId: input.elementId,
        payload: { ...input },
      });
      return { blockId: input.blockId, offset: input.offset, updatedAt };
    });
  }
}
