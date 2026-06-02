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

import type { BlockId, Document, ElementId, IsoTimestamp, MarkType } from "@interleave/core";
import {
  type DocumentBlockRow,
  documentBlocks,
  documentMarks,
  documents,
  type InterleaveDatabase,
  readPoints,
} from "@interleave/db";
import { and, eq } from "drizzle-orm";
import { newRowId, nowIso } from "./ids";
import { rowToDocument } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/** One stable block to persist for a document. */
export interface DocumentBlockInput {
  readonly blockType: string;
  readonly order: number;
  readonly stableBlockId: BlockId;
  /**
   * The 1-based PAGE number for a PAGINATED (PDF, T064) block; `null`/omitted for
   * non-paginated HTML/text bodies. Preserved across saves so accepting OCR text
   * (T066) into a PDF body keeps the block→page map the read-point + extract path
   * read. The renderer's plain document saves omit it (→ `null`, unchanged).
   */
  readonly page?: number | null;
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

/**
 * Arguments to add a document mark (T020 highlight; T021 extracted-span; T026
 * processed-span). A mark is an annotation over a STABLE block's `[start,end]`
 * character range — NOT an element and NOT lineage. `range` is stored as JSON
 * `[start, end]` so it re-anchors by block id after a re-import (never an absolute
 * ProseMirror position). `attrs` carries optional mark-specific JSON.
 */
export interface AddMarkInput {
  /** The owning document/element id the mark lives on. */
  readonly elementId: ElementId;
  /** The STABLE block id the mark anchors to. */
  readonly blockId: BlockId;
  readonly markType: MarkType;
  /** Character range within the block, as `[start, end]` (start ≥ 0, end > start). */
  readonly range: readonly [number, number];
  /** Optional mark-specific attributes (JSON-serializable). */
  readonly attrs?: Readonly<Record<string, unknown>> | null;
}

/** A persisted document mark returned to callers (range parsed back to a tuple). */
export interface DocumentMark {
  readonly id: string;
  readonly elementId: ElementId;
  readonly blockId: BlockId;
  readonly markType: MarkType;
  readonly range: readonly [number, number];
  readonly attrs: Readonly<Record<string, unknown>> | null;
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
    return this.db.transaction((tx) => this.upsertWithin(tx, input));
  }

  /**
   * Upsert a document body + (optionally) its block set using an EXISTING
   * transaction, logging `update_document` on the SAME `tx`. The tx-composable seam
   * {@link ExtractionService} (T021) uses to seed a new extract's body inside the
   * single extraction transaction, so the body, blocks, and op commit (or roll
   * back) together with the extract element/location/relation/mark.
   */
  upsertWithin(tx: DbClient, input: UpsertDocumentInput): Document {
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
            // Preserve the page mapping for paginated (PDF) blocks; `null` for the
            // HTML/text path (its block inputs never set `page`).
            page: block.page ?? null,
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

  /**
   * Add a document mark (T020 highlight / T021 extracted-span / T026
   * processed-span) over a stable block's `[start,end]` range, and log
   * `update_document` in ONE transaction. A mark is part of the document body, so
   * it is logged under `update_document` — there is NO `add_mark` op type (the
   * operation set is closed; see the M4 op-log note). Creates NO `elements` row.
   * The mark id is a domain-minted row id; the range is stored as JSON `[s,e]`.
   */
  addMark(input: AddMarkInput): DocumentMark {
    return this.db.transaction((tx) => this.addMarkWithin(tx, input));
  }

  /**
   * Add a document mark using an EXISTING transaction, logging `update_document` on
   * the SAME `tx`. The tx-composable seam {@link ExtractionService} (T021) uses to
   * place the parent/source `extracted_span` breadcrumb inside the single extraction
   * transaction, so the parent mark commits (or rolls back) with the extract it
   * marks. Creates NO `elements` row — a mark is a body annotation, not lineage.
   */
  addMarkWithin(tx: DbClient, input: AddMarkInput): DocumentMark {
    const id = newRowId();
    const [start, end] = input.range;
    const attrsJson = input.attrs == null ? null : JSON.stringify(input.attrs);
    tx.insert(documentMarks)
      .values({
        id,
        documentId: input.elementId,
        blockId: input.blockId,
        markType: input.markType,
        range: JSON.stringify([start, end]),
        attrs: attrsJson,
      })
      .run();

    new OperationLogRepository(tx).append(tx, {
      opType: "update_document",
      elementId: input.elementId,
      payload: {
        elementId: input.elementId,
        mark: "add",
        markId: id,
        markType: input.markType,
        blockId: input.blockId,
        range: [start, end],
      },
    });

    return {
      id,
      elementId: input.elementId,
      blockId: input.blockId,
      markType: input.markType,
      range: [start, end],
      attrs: input.attrs ?? null,
    };
  }

  /**
   * Remove one document mark by id, logging `update_document` in ONE transaction.
   * Returns `true` when a row was removed, `false` when the id was unknown.
   * Marks are body annotations, so removal is a hard delete of the annotation row
   * (the SOURCE BODY is untouched) — it does not soft-delete an element.
   */
  removeMark(markId: string): boolean {
    return this.db.transaction((tx) => {
      const existing = tx.select().from(documentMarks).where(eq(documentMarks.id, markId)).get();
      if (!existing) return false;
      tx.delete(documentMarks).where(eq(documentMarks.id, markId)).run();
      new OperationLogRepository(tx).append(tx, {
        opType: "update_document",
        elementId: existing.documentId,
        payload: {
          elementId: existing.documentId,
          mark: "remove",
          markId,
          markType: existing.markType,
          blockId: existing.blockId,
        },
      });
      return true;
    });
  }

  /** All marks on a document, in insertion order. */
  listMarks(elementId: ElementId): DocumentMark[] {
    return this.db
      .select()
      .from(documentMarks)
      .where(eq(documentMarks.documentId, elementId))
      .all()
      .map(rowToMark);
  }

  /** Marks of one kind on a document (e.g. only highlights), in insertion order. */
  listMarksByType(elementId: ElementId, markType: MarkType): DocumentMark[] {
    return this.db
      .select()
      .from(documentMarks)
      .where(and(eq(documentMarks.documentId, elementId), eq(documentMarks.markType, markType)))
      .all()
      .map(rowToMark);
  }
}

/** Parse a raw `document_marks` row into a {@link DocumentMark}. */
function rowToMark(row: {
  id: string;
  documentId: string;
  blockId: string;
  markType: string;
  range: string;
  attrs: string | null;
}): DocumentMark {
  const parsed = JSON.parse(row.range) as [number, number];
  return {
    id: row.id,
    elementId: row.documentId as ElementId,
    blockId: row.blockId as BlockId,
    markType: row.markType as MarkType,
    range: [parsed[0], parsed[1]],
    attrs: row.attrs == null ? null : (JSON.parse(row.attrs) as Record<string, unknown>),
  };
}
