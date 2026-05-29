/**
 * SourceRepository (T008) — source provenance + actionable source locations.
 *
 * Creating a source is a multi-table mutation: an `elements` row (type `source`)
 * AND its `sources` provenance side-table row, written in ONE transaction with a
 * `create_source` op. Extraction is also here: an extract is an independent
 * scheduled `elements` row (NOT a highlight) plus a `source_locations` row that
 * anchors it to the exact block ids / offsets / selected-text snapshot in its
 * source — the load-bearing `extract → source location → source` lineage. That
 * runs in one transaction with a `create_extract` op.
 *
 * Source locations capture the parent element id, source element id, source
 * block ids, offsets, and the selected-text snapshot so the origin survives a
 * re-import of the source document (see the document/editor rules in CLAUDE.md).
 */

import type {
  BlockId,
  DistillationStage,
  Element,
  ElementId,
  ElementLocation,
  IsoTimestamp,
  Priority,
  Source,
  SourceLocationId,
} from "@interleave/core";
import { plainTextToProseMirrorDoc } from "@interleave/core";
import {
  documentBlocks,
  documents,
  elements,
  type InterleaveDatabase,
  sourceLocations,
  sources,
} from "@interleave/db";
import { eq } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { newRowId, newSourceLocationId, nowIso } from "./ids";
import { rowToElement, rowToSource, rowToSourceLocation } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/** Provenance fields for a new source (all optional — manual imports omit most). */
export interface CreateSourceInput {
  readonly title: string;
  readonly priority: Priority;
  readonly status?: Element["status"];
  readonly stage?: DistillationStage;
  readonly url?: string | null;
  readonly canonicalUrl?: string | null;
  readonly originalUrl?: string | null;
  readonly author?: string | null;
  readonly publishedAt?: IsoTimestamp | null;
  readonly accessedAt?: IsoTimestamp | null;
  readonly snapshotKey?: string | null;
  readonly reasonAdded?: string | null;
}

/** The element + provenance pair returned when a source is created/read. */
export interface SourceWithElement {
  readonly element: Element;
  readonly source: Source;
}

/**
 * Create a source AND its document body in ONE transaction (T013). Extends
 * {@link CreateSourceInput} with the raw pasted `body`; the repository flattens
 * it to plain text + ProseMirror JSON via `plainTextToProseMirrorDoc` and writes
 * the `documents` row + stable `document_blocks` alongside the element + sources
 * rows, so a source can never persist without its body (and vice versa).
 */
export interface CreateSourceWithDocumentInput extends CreateSourceInput {
  /** Raw pasted body text; converted to plain text + ProseMirror JSON. Optional/empty allowed. */
  readonly body?: string | undefined;
}

/** A source element + provenance + its created document body (T013). */
export interface SourceWithDocument {
  readonly element: Element;
  readonly source: Source;
  /** ProseMirror `doc` JSON stored for the body (opaque to callers). */
  readonly prosemirrorJson: unknown;
  /** The flattened plain-text mirror stored for search/preview. */
  readonly plainText: string;
  /** Number of stable blocks written for the body. */
  readonly blockCount: number;
}

/** Arguments to extract a child element anchored at a source location. */
export interface CreateExtractInput {
  /** The source element this extract derives from (lineage root + parent). */
  readonly sourceElementId: ElementId;
  /** Origin element the extract is lifted from; defaults to `sourceElementId`. */
  readonly parentId?: ElementId;
  readonly title: string;
  readonly priority: Priority;
  readonly stage?: DistillationStage;
  readonly selectedText: string;
  readonly blockIds: readonly BlockId[];
  readonly startOffset?: number | null;
  readonly endOffset?: number | null;
  readonly page?: number | null;
  readonly timestampMs?: number | null;
  readonly label?: string | null;
}

/** An extract element together with the source location anchoring its lineage. */
export interface ExtractWithLocation {
  readonly element: Element;
  readonly location: ElementLocation;
}

export class SourceRepository {
  private readonly elementsRepo: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elementsRepo = new ElementRepository(db);
  }

  /**
   * Create a `source` element + its provenance row, atomically, logging
   * `create_source`. The element is created via {@link ElementRepository} on the
   * same transaction so `create_element` is also logged.
   */
  create(input: CreateSourceInput): SourceWithElement {
    return this.db.transaction((tx) => {
      const element = this.elementsRepo.createWithin(tx, {
        type: "source",
        status: input.status ?? "inbox",
        stage: input.stage ?? "raw_source",
        priority: input.priority,
        title: input.title,
        parentId: null,
        sourceId: null,
      });
      const source: Source = {
        elementId: element.id,
        url: input.url ?? null,
        canonicalUrl: input.canonicalUrl ?? null,
        originalUrl: input.originalUrl ?? null,
        author: input.author ?? null,
        publishedAt: input.publishedAt ?? null,
        accessedAt: input.accessedAt ?? null,
        snapshotKey: input.snapshotKey ?? null,
        reasonAdded: input.reasonAdded ?? null,
      };
      tx.insert(sources)
        .values({ ...source })
        .run();
      new OperationLogRepository(tx).append(tx, {
        opType: "create_source",
        elementId: element.id,
        payload: { source },
      });
      return { element, source };
    });
  }

  /**
   * Create a `source` element + its provenance row + its document body, all in
   * ONE transaction (T013). The element + `sources` rows are written exactly as
   * in {@link create} (logging `create_element` + `create_source`); the body is
   * converted with `plainTextToProseMirrorDoc` and inserted into `documents` +
   * `document_blocks`, logging `update_document` — all on the same `tx`, so the
   * source row, document row, blocks, and their ops commit (or roll back) as a
   * unit. A source therefore never persists without its body. The main process
   * owns the conversion; the renderer only ships the raw string (the layering
   * rule — no ProseMirror building in the renderer).
   */
  createWithDocument(input: CreateSourceWithDocumentInput): SourceWithDocument {
    const conversion = plainTextToProseMirrorDoc(input.body ?? "");
    return this.db.transaction((tx) => {
      const element = this.elementsRepo.createWithin(tx, {
        type: "source",
        status: input.status ?? "inbox",
        stage: input.stage ?? "raw_source",
        priority: input.priority,
        title: input.title,
        parentId: null,
        sourceId: null,
      });
      const source: Source = {
        elementId: element.id,
        url: input.url ?? null,
        canonicalUrl: input.canonicalUrl ?? null,
        originalUrl: input.originalUrl ?? null,
        author: input.author ?? null,
        publishedAt: input.publishedAt ?? null,
        accessedAt: input.accessedAt ?? null,
        snapshotKey: input.snapshotKey ?? null,
        reasonAdded: input.reasonAdded ?? null,
      };
      tx.insert(sources)
        .values({ ...source })
        .run();
      const log = new OperationLogRepository(tx);
      log.append(tx, {
        opType: "create_source",
        elementId: element.id,
        payload: { source },
      });

      // Document body + stable blocks (same transaction → atomic with the source).
      const updatedAt = nowIso();
      const json = JSON.stringify(conversion.doc);
      const schemaVersion = 1;
      tx.insert(documents)
        .values({
          elementId: element.id,
          prosemirrorJson: json,
          plainText: conversion.plainText,
          schemaVersion,
          updatedAt,
        })
        .run();
      for (const block of conversion.blocks) {
        tx.insert(documentBlocks)
          .values({
            id: newRowId(),
            documentId: element.id,
            blockType: block.blockType,
            order: block.order,
            stableBlockId: block.stableBlockId,
          })
          .run();
      }
      log.append(tx, {
        opType: "update_document",
        elementId: element.id,
        payload: {
          elementId: element.id,
          schemaVersion,
          blockCount: conversion.blocks.length,
        },
      });

      return {
        element,
        source,
        prosemirrorJson: conversion.doc,
        plainText: conversion.plainText,
        blockCount: conversion.blocks.length,
      };
    });
  }

  /** Read a source (element + provenance) by element id, or `null`. */
  findById(elementId: ElementId): SourceWithElement | null {
    const elementRow = this.db.select().from(elements).where(eq(elements.id, elementId)).get();
    const sourceRow = this.db.select().from(sources).where(eq(sources.elementId, elementId)).get();
    if (!elementRow || !sourceRow) return null;
    return { element: rowToElement(elementRow), source: rowToSource(sourceRow) };
  }

  /**
   * Create an extract: an independent scheduled `elements` row PLUS the
   * `source_locations` anchor, atomically, logging `create_extract`. The extract
   * inherits the source as both its lineage root (`sourceId`) and, by default,
   * its `parentId`. Sub-extracts pass an explicit `parentId`.
   */
  createExtract(input: CreateExtractInput): ExtractWithLocation {
    return this.db.transaction((tx) => this.createExtractWithin(tx, input));
  }

  /**
   * Create an extract using an EXISTING transaction — the tx-composable seam used
   * by {@link ExtractionService} (T021), which performs the full extraction (extract
   * element + location + body seed + `derived_from` relation + tag/priority
   * inheritance + attention reschedule + parent `extracted_span` mark) in ONE outer
   * `db.transaction`. Mirrors {@link ElementRepository.createWithin}: it inserts the
   * `elements` row (via `createWithin`, logging `create_element`) + the
   * `source_locations` row and logs `create_extract` on the SAME `tx`, so a throw
   * anywhere downstream rolls the whole extraction back (no orphan element/location).
   */
  createExtractWithin(tx: DbClient, input: CreateExtractInput): ExtractWithLocation {
    const element = this.elementsRepo.createWithin(tx, {
      type: "extract",
      status: "pending",
      stage: input.stage ?? "raw_extract",
      priority: input.priority,
      title: input.title,
      parentId: input.parentId ?? input.sourceElementId,
      sourceId: input.sourceElementId,
    });

    const locationId: SourceLocationId = newSourceLocationId();
    const location: ElementLocation = {
      id: locationId,
      elementId: element.id,
      sourceElementId: input.sourceElementId,
      blockIds: input.blockIds,
      startOffset: input.startOffset ?? null,
      endOffset: input.endOffset ?? null,
      page: input.page ?? null,
      timestampMs: input.timestampMs ?? null,
      label: input.label ?? null,
      selectedText: input.selectedText,
    };
    tx.insert(sourceLocations)
      .values({
        id: location.id,
        elementId: location.elementId,
        sourceElementId: location.sourceElementId,
        blockIds: JSON.stringify(location.blockIds),
        startOffset: location.startOffset,
        endOffset: location.endOffset,
        page: location.page,
        timestampMs: location.timestampMs,
        label: location.label,
        selectedText: location.selectedText,
      })
      .run();

    new OperationLogRepository(tx).append(tx, {
      opType: "create_extract",
      elementId: element.id,
      payload: { extractId: element.id, sourceElementId: input.sourceElementId, locationId },
    });

    return { element, location };
  }

  /** Fetch one source location by id, or `null`. */
  findLocationById(id: SourceLocationId): ElementLocation | null {
    const row = this.db.select().from(sourceLocations).where(eq(sourceLocations.id, id)).get();
    return row ? rowToSourceLocation(row) : null;
  }

  /** The source location anchoring a given element (e.g. an extract), or `null`. */
  findLocationForElement(elementId: ElementId): ElementLocation | null {
    const row = this.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, elementId))
      .get();
    return row ? rowToSourceLocation(row) : null;
  }

  /** All locations that point INTO a given source (its extracts' anchors). */
  listLocationsForSource(sourceElementId: ElementId): ElementLocation[] {
    return this.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.sourceElementId, sourceElementId))
      .all()
      .map(rowToSourceLocation);
  }
}
