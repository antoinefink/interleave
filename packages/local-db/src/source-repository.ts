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
  ElementStatus,
  ElementType,
  IsoTimestamp,
  PlainTextConversion,
  Priority,
  RegionRect,
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
import { and, desc, eq, isNull } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { newRowId, newSourceLocationId, nowIso } from "./ids";
import { rowToElement, rowToSource, rowToSourceLocation } from "./mappers";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/** Provenance fields for a new source (all optional — manual imports omit most). */
export interface CreateSourceInput {
  /**
   * Optional explicit element id, pre-minted by the caller (T060). The URL-import
   * service mints the source id up front so the vault path
   * `assets/sources/<source_id>/` is known before the row exists; passing it here
   * makes the created element ADOPT it. Omitted ⇒ the element repo mints one.
   */
  readonly id?: ElementId;
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
  /**
   * A PRE-BUILT document conversion (T060). When supplied, the repository stores
   * the given `doc`/`plainText`/`blocks` VERBATIM (no re-conversion) instead of
   * running `plainTextToProseMirrorDoc(body)`. This keeps HTML→ProseMirror
   * conversion in `@interleave/importers` (the layering rule — no editor/DOM work
   * in `local-db`) while reusing the exact same atomic source+document transaction.
   * `conversion` wins over `body` when both are present.
   */
  readonly conversion?: PlainTextConversion | undefined;
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

/**
 * Create a `topic` element + its document body, all in ONE transaction (T067). A
 * topic — e.g. an EPUB chapter — is a readable, schedulable document-bearing element
 * derived from a source, but it is NOT itself a provenance-bearing source: it has no
 * `sources` row and logs no `create_source`. Unlike {@link CreateSourceWithDocumentInput}
 * it carries explicit `parentId` (its place in the lineage tree, e.g. the book) and
 * `sourceId` (the lineage root — the same book), since a topic always belongs to a
 * source. The pre-built {@link PlainTextConversion} `conversion` is stored verbatim
 * (the importer already mapped the chapter's XHTML to the constrained schema).
 */
export interface CreateTopicWithDocumentInput {
  /** Optional explicit element id, pre-minted by the caller (book-import path). */
  readonly id?: ElementId;
  readonly title: string;
  readonly priority: Priority;
  readonly status?: Element["status"];
  readonly stage?: DistillationStage;
  /** The element this topic hangs under in the hierarchy (e.g. the book source). */
  readonly parentId: ElementId;
  /** The lineage root this topic belongs to (e.g. the book source). */
  readonly sourceId: ElementId;
  /** A PRE-BUILT conversion stored verbatim; mutually exclusive with `body`. */
  readonly conversion?: PlainTextConversion | undefined;
  /** Raw body text → `plainTextToProseMirrorDoc` when no `conversion` is supplied. */
  readonly body?: string | undefined;
}

/** A topic element + its created document body (T067). */
export interface TopicWithDocument {
  readonly element: Element;
  /** ProseMirror `doc` JSON stored for the body (opaque to callers). */
  readonly prosemirrorJson: unknown;
  /** The flattened plain-text mirror stored for search/preview. */
  readonly plainText: string;
  /** Number of stable blocks written for the body. */
  readonly blockCount: number;
}

/** Arguments to extract a child element anchored at a source location. */
export interface CreateExtractInput {
  /**
   * Optional explicit element id, pre-minted by the caller (T065). The region-
   * extract service mints the `media_fragment` id up front so it can soft-delete
   * the element by id if the subsequent (out-of-tx) image asset import fails.
   * Omitted ⇒ the element repo mints one.
   */
  readonly id?: ElementId;
  /** The source element this extract derives from (lineage root + parent). */
  readonly sourceElementId: ElementId;
  /** Origin element the extract is lifted from; defaults to `sourceElementId`. */
  readonly parentId?: ElementId;
  /**
   * The element the `source_locations` anchor points INTO — i.e. the document the
   * selected text (and thus `blockIds`/offsets) actually lives in. For a top-level
   * extract this is the source itself; for a SUB-extract (T025) it is the PARENT
   * extract, since the text was selected from the parent extract's body. Defaults
   * to `sourceElementId` so the existing top-level path is unchanged. Keeping this
   * distinct from `sourceElementId` (the lineage root, which stays on
   * `elements.source_id`) is what makes jump-to-source land in the right document
   * for a sub-extract.
   */
  readonly locationSourceElementId?: ElementId;
  readonly title: string;
  readonly priority: Priority;
  readonly stage?: DistillationStage;
  readonly selectedText: string;
  readonly blockIds: readonly BlockId[];
  readonly startOffset?: number | null;
  readonly endOffset?: number | null;
  readonly page?: number | null;
  readonly timestampMs?: number | null;
  /**
   * Normalized bounding box for a PDF region extract (T065), else `null`. When set
   * (together with `elementType: "media_fragment"`) the extract anchors a figure/
   * table crop to its page + bbox; `null` for ordinary text extraction.
   */
  readonly region?: RegionRect | null;
  readonly label?: string | null;
  /**
   * The element TYPE the extract mints (T065). Defaults to `"extract"` (text
   * extraction, unchanged); a PDF region passes `"media_fragment"` so the same
   * tx-composable seam can create the image-fragment element + its region anchor.
   */
  readonly elementType?: "extract" | "media_fragment";
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
        ...(input.id ? { id: input.id } : {}),
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
    return this.db.transaction((tx) => this.createWithDocumentWithin(tx, input));
  }

  /**
   * Create a source + provenance + document body using an EXISTING transaction —
   * the tx-composable seam (T060) that lets the URL-import service compose the
   * source insert with its two `source_html` snapshot-asset inserts in ONE outer
   * transaction (so a failure rolls them ALL back: no orphan source/asset/file).
   * Mirrors {@link createExtractWithin}; the single-call {@link createWithDocument}
   * just wraps this in its own `db.transaction`.
   *
   * When `input.conversion` is supplied it is stored verbatim (the importer
   * already built it); otherwise the raw `body` is converted with
   * `plainTextToProseMirrorDoc` (the manual-import path).
   */
  createWithDocumentWithin(tx: DbClient, input: CreateSourceWithDocumentInput): SourceWithDocument {
    const conversion = input.conversion ?? plainTextToProseMirrorDoc(input.body ?? "");
    const source: Source = {
      // The element id is minted by `insertElementWithDocument`; patched in below.
      elementId: "" as ElementId,
      url: input.url ?? null,
      canonicalUrl: input.canonicalUrl ?? null,
      originalUrl: input.originalUrl ?? null,
      author: input.author ?? null,
      publishedAt: input.publishedAt ?? null,
      accessedAt: input.accessedAt ?? null,
      snapshotKey: input.snapshotKey ?? null,
      reasonAdded: input.reasonAdded ?? null,
    };
    const { element, blockCount } = this.insertElementWithDocument(tx, {
      type: "source",
      status: input.status ?? "inbox",
      stage: input.stage ?? "raw_source",
      priority: input.priority,
      title: input.title,
      parentId: null,
      sourceId: null,
      conversion,
      ...(input.id ? { id: input.id } : {}),
      // A source ALSO writes its `sources` provenance row + `create_source` op.
      provenance: source,
    });
    return {
      element,
      source: { ...source, elementId: element.id },
      prosemirrorJson: conversion.doc,
      plainText: conversion.plainText,
      blockCount,
    };
  }

  /**
   * Create a `topic` element + its document body in a SINGLE transaction (T067) —
   * the seam the EPUB importer uses to author one chapter (and any future paginated
   * import that splits a source into readable topics). It shares the SAME private
   * document-insert helper as {@link createWithDocumentWithin} (parameterized by the
   * element `type` + whether to write a `sources` provenance row), so the two paths
   * never drift. A topic logs `create_element` + `update_document` but NO
   * `create_source` (it is not provenance-bearing — only the source is). The supplied
   * `parentId`/`sourceId` are adopted onto the element so lineage is recorded.
   */
  createTopicWithDocument(input: CreateTopicWithDocumentInput): TopicWithDocument {
    return this.db.transaction((tx) => this.createTopicWithDocumentWithin(tx, input));
  }

  /** {@link createTopicWithDocument} using an EXISTING transaction (the book seam). */
  createTopicWithDocumentWithin(
    tx: DbClient,
    input: CreateTopicWithDocumentInput,
  ): TopicWithDocument {
    const conversion = input.conversion ?? plainTextToProseMirrorDoc(input.body ?? "");
    const { element, blockCount } = this.insertElementWithDocument(tx, {
      type: "topic",
      status: input.status ?? "inbox",
      stage: input.stage ?? "rough_topic",
      priority: input.priority,
      title: input.title,
      parentId: input.parentId,
      sourceId: input.sourceId,
      conversion,
      ...(input.id ? { id: input.id } : {}),
      // A topic writes NO `sources` row (it is not provenance-bearing).
      provenance: null,
    });
    return {
      element,
      prosemirrorJson: conversion.doc,
      plainText: conversion.plainText,
      blockCount,
    };
  }

  /**
   * The shared element + `documents` + `document_blocks` insert body (T067), used by
   * BOTH the source path ({@link createWithDocumentWithin} — writes the `sources`
   * provenance row + `create_source` op) and the topic path
   * ({@link createTopicWithDocumentWithin} — skips both). Centralizing the body-insert
   * here means the two document-bearing element types can never diverge in how their
   * body + stable blocks + `update_document` op are written. Always logs
   * `create_element` (via {@link ElementRepository.createWithin}) + `update_document`;
   * logs `create_source` ONLY when `provenance` is supplied.
   */
  private insertElementWithDocument(
    tx: DbClient,
    input: {
      readonly type: ElementType;
      readonly status: ElementStatus;
      readonly stage: DistillationStage;
      readonly priority: Priority;
      readonly title: string;
      readonly parentId: ElementId | null;
      readonly sourceId: ElementId | null;
      readonly conversion: PlainTextConversion;
      readonly id?: ElementId;
      /** When set, also write the `sources` provenance row + `create_source` op. */
      readonly provenance: Source | null;
    },
  ): { element: Element; blockCount: number } {
    const element = this.elementsRepo.createWithin(tx, {
      type: input.type,
      status: input.status,
      stage: input.stage,
      priority: input.priority,
      title: input.title,
      parentId: input.parentId,
      sourceId: input.sourceId,
      ...(input.id ? { id: input.id } : {}),
    });
    const log = new OperationLogRepository(tx);

    if (input.provenance) {
      const source: Source = { ...input.provenance, elementId: element.id };
      tx.insert(sources)
        .values({ ...source })
        .run();
      log.append(tx, {
        opType: "create_source",
        elementId: element.id,
        payload: { source },
      });
    }

    // Document body + stable blocks (same transaction → atomic with the element).
    const conversion = input.conversion;
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
          // The 1-based page for a paginated (PDF, T064) block; `null` otherwise.
          page: block.page ?? null,
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

    return { element, blockCount: conversion.blocks.length };
  }

  /** Read a source (element + provenance) by element id, or `null`. */
  findById(elementId: ElementId): SourceWithElement | null {
    const elementRow = this.db.select().from(elements).where(eq(elements.id, elementId)).get();
    const sourceRow = this.db.select().from(sources).where(eq(sources.elementId, elementId)).get();
    if (!elementRow || !sourceRow) return null;
    return { element: rowToElement(elementRow), source: rowToSource(sourceRow) };
  }

  /**
   * The newest LIVE `source` whose `sources.canonical_url` equals `canonicalUrl`, or
   * `null` (T069). Backed by the indexed `sources_canonical_url_idx`; excludes soft-
   * deleted sources (`elements.deleted_at IS NULL`) so a re-import after deletion is not
   * blocked. The NAMED query the highlight import uses to REUSE an already-imported
   * book/article source instead of creating a duplicate — T061 added the index +
   * `canonicalUrl` field but no named query (its URL-import dedup inlines the lookup),
   * so this parallels that pattern. Returns `null` for a null/empty key.
   */
  findByCanonicalUrl(canonicalUrl: string | null): SourceWithElement | null {
    if (!canonicalUrl) return null;
    const row = this.db
      .select({ source: sources, element: elements })
      .from(sources)
      .innerJoin(elements, eq(sources.elementId, elements.id))
      .where(
        and(
          eq(sources.canonicalUrl, canonicalUrl),
          eq(elements.type, "source"),
          isNull(elements.deletedAt),
        ),
      )
      .orderBy(desc(sources.accessedAt), desc(elements.id))
      .get();
    if (!row) return null;
    return { element: rowToElement(row.element), source: rowToSource(row.source) };
  }

  /**
   * The newest LIVE `source` matching `title` AND `author` (case-sensitive exact
   * match; a null author matches a null author), or `null` (T069) — the no-URL dedup
   * fallback so re-importing a highlight export does not duplicate a book that has no
   * canonical URL (Kindle clippings, a Readwise book with no `source_url`). Excludes
   * soft-deleted sources.
   */
  findByTitleAndAuthor(title: string, author: string | null): SourceWithElement | null {
    const row = this.db
      .select({ source: sources, element: elements })
      .from(sources)
      .innerJoin(elements, eq(sources.elementId, elements.id))
      .where(
        and(
          eq(elements.title, title),
          author == null ? isNull(sources.author) : eq(sources.author, author),
          eq(elements.type, "source"),
          isNull(elements.deletedAt),
        ),
      )
      .orderBy(desc(sources.accessedAt), desc(elements.id))
      .get();
    if (!row) return null;
    return { element: rowToElement(row.element), source: rowToSource(row.source) };
  }

  /**
   * The set of `selectedText` snapshots already anchored under a given source (T069) —
   * i.e. the highlight text of every LIVE extract whose `source_locations.source_element_id`
   * is `sourceElementId`. The highlight import uses this to dedup by `(sourceId, text)`
   * so re-running an export does not re-add the same highlight. Exact-text match only
   * (no semantic dedup — that is T088). Excludes soft-deleted extracts.
   */
  listExtractSelectedText(sourceElementId: ElementId): Set<string> {
    const rows = this.db
      .select({ selectedText: sourceLocations.selectedText })
      .from(sourceLocations)
      .innerJoin(elements, eq(sourceLocations.elementId, elements.id))
      .where(and(eq(sourceLocations.sourceElementId, sourceElementId), isNull(elements.deletedAt)))
      .all();
    return new Set(rows.map((r) => r.selectedText));
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
      // A PDF region (T065) mints a `media_fragment`; everything else an `extract`.
      type: input.elementType ?? "extract",
      status: "pending",
      stage: input.stage ?? "raw_extract",
      priority: input.priority,
      title: input.title,
      parentId: input.parentId ?? input.sourceElementId,
      sourceId: input.sourceElementId,
      ...(input.id ? { id: input.id } : {}),
    });

    const locationId: SourceLocationId = newSourceLocationId();
    // The anchor points into the document the text was selected from: the parent
    // extract for a sub-extract (T025), the source itself for a top-level extract.
    // This is distinct from `elements.source_id` (the lineage root) above.
    const locationSourceElementId = input.locationSourceElementId ?? input.sourceElementId;
    const location: ElementLocation = {
      id: locationId,
      elementId: element.id,
      sourceElementId: locationSourceElementId,
      blockIds: input.blockIds,
      startOffset: input.startOffset ?? null,
      endOffset: input.endOffset ?? null,
      page: input.page ?? null,
      timestampMs: input.timestampMs ?? null,
      region: input.region ?? null,
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
        // The PDF region bbox (T065) is stored as JSON; `null` for text/page-only.
        region: location.region ? JSON.stringify(location.region) : null,
        label: location.label,
        selectedText: location.selectedText,
      })
      .run();

    new OperationLogRepository(tx).append(tx, {
      opType: "create_extract",
      elementId: element.id,
      payload: {
        extractId: element.id,
        sourceElementId: input.sourceElementId,
        locationSourceElementId,
        locationId,
      },
    });

    return { element, location };
  }

  /**
   * Record a bare `source_locations` anchor for an ALREADY-EXISTING element (T067) —
   * e.g. a chapter `topic` anchored to its book, so the chapter knows its place in
   * the book (`page` = spine ordinal, `label` = chapter title) and jump-to-book
   * works. Unlike {@link createExtractWithin} this creates NO element (the element
   * already exists) and logs NO `create_extract` — it is a pure lineage anchor for a
   * paginated child, written on an EXISTING transaction so it commits with the book.
   * `blockIds`/`selectedText` default empty (a chapter anchors to a whole spine item,
   * not a text span). Returns the created location.
   */
  createElementLocationWithin(
    tx: DbClient,
    input: {
      readonly elementId: ElementId;
      readonly sourceElementId: ElementId;
      readonly page?: number | null;
      readonly label?: string | null;
      readonly blockIds?: readonly BlockId[];
      readonly selectedText?: string;
    },
  ): ElementLocation {
    const locationId: SourceLocationId = newSourceLocationId();
    const location: ElementLocation = {
      id: locationId,
      elementId: input.elementId,
      sourceElementId: input.sourceElementId,
      blockIds: input.blockIds ?? [],
      startOffset: null,
      endOffset: null,
      page: input.page ?? null,
      timestampMs: null,
      region: null,
      label: input.label ?? null,
      selectedText: input.selectedText ?? "",
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
        region: null,
        label: location.label,
        selectedText: location.selectedText,
      })
      .run();
    return location;
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
