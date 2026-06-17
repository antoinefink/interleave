/**
 * ExtractionService tests (T021 — the keystone).
 *
 * These run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so
 * behaviour matches production exactly. They assert the load-bearing extraction
 * invariants in ONE place:
 *
 *  - one `extractions.create` produces EXACTLY one new `extract` element, with the
 *    correct `parent_id`/`source_id` lineage;
 *  - a `source_locations` row whose `blockIds`/offsets/`selectedText` match the
 *    selection;
 *  - a `derived_from` `element_relations` edge extract → source/parent;
 *  - the extract INHERITS the source's priority + tags;
 *  - a FUTURE attention `due_at` with status `scheduled` — and NO `review_states`
 *    row (extracts are attention items, never FSRS);
 *  - an `extracted_span` `document_marks` row on the PARENT/source body;
 *  - the exact `operation_log` rows (`create_element` + `create_extract` +
 *    `update_document` + `add_relation` + `reschedule_element` + `add_tag`);
 *  - ATOMICITY: a forced failure rolls back the ENTIRE extraction (no orphan
 *    element / location / relation / mark / body / log rows).
 */

import type { BlockId, ElementId, PlainTextConversion, Priority } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import {
  documentBlocks,
  documentMarks,
  documents,
  elementRelations,
  operationLog,
  reviewStates,
  sourceLocations,
} from "@interleave/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractionService, rawExtractIntervalDays } from "./extraction-service";
import { createRepositories } from "./index";
import { LineageQuery } from "./lineage-query";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

/** Seed a source (element + provenance + body + stable blocks) and return its id. */
function seedSource(handle: DbHandle, priority: Priority = 0.625): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title: "On the Measure of Intelligence",
    priority,
    status: "active",
    stage: "raw_source",
    body: "Intro paragraph one.\n\nThe definition paragraph two.\n\nA third paragraph.",
  });
  return element.id;
}

function seedAtomicSource(handle: DbHandle, priority: Priority = 0.625): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title: "Memory notes",
    priority,
    status: "active",
    stage: "raw_source",
    body: "The hippocampus supports episodic memory consolidation.",
  });
  return element.id;
}

/** An UNTRIAGED inbox source (status "inbox", born with no attention due date). */
function seedInboxSource(handle: DbHandle, priority: Priority = 0.625): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title: "Freshly captured, untriaged",
    priority,
    status: "inbox",
    stage: "raw_source",
    body: "Intro paragraph one.\n\nThe definition paragraph two.\n\nA third paragraph.",
  });
  return element.id;
}

/** The stable block ids of a source body, in document order. */
function blockIdsOf(handle: DbHandle, sourceId: ElementId): BlockId[] {
  return new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((b) => b.stableBlockId as BlockId);
}

function reschedulePayloads(id: ElementId): Record<string, unknown>[] {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, id))
    .all()
    .filter((op) => op.opType === "reschedule_element")
    .map((op) => JSON.parse(op.payload) as Record<string, unknown>);
}

function createExtractPayload(id: ElementId): Record<string, unknown> {
  const row = handle.db
    .select()
    .from(operationLog)
    .where(and(eq(operationLog.elementId, id), eq(operationLog.opType, "create_extract")))
    .get();
  return JSON.parse(row?.payload ?? "{}") as Record<string, unknown>;
}

function seedRichSource(handle: DbHandle): { sourceId: ElementId; blocks: BlockId[] } {
  const conversion: PlainTextConversion = {
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: "src-rich-a" as BlockId },
          content: [{ type: "text", text: "First paragraph here." }],
        },
        {
          type: "image",
          attrs: {
            blockId: "src-rich-img" as BlockId,
            src: "article-image://source_1/asset_1",
            alt: "Architecture diagram",
            title: "Figure title",
            width: 640,
            height: 480,
          },
        },
        {
          type: "paragraph",
          attrs: { blockId: "src-rich-b" as BlockId },
          content: [{ type: "text", text: "Second paragraph after image." }],
        },
      ],
    },
    plainText: "First paragraph here.\n\nArchitecture diagram\n\nSecond paragraph after image.",
    blocks: [
      { blockType: "paragraph", order: 0, stableBlockId: "src-rich-a" as BlockId },
      { blockType: "image", order: 1, stableBlockId: "src-rich-img" as BlockId },
      { blockType: "paragraph", order: 2, stableBlockId: "src-rich-b" as BlockId },
    ],
  };
  const { element } = new SourceRepository(handle.db).createWithDocument({
    title: "Rich source",
    priority: 0.625,
    status: "active",
    stage: "raw_source",
    conversion,
  });
  return { sourceId: element.id, blocks: conversion.blocks.map((b) => b.stableBlockId) };
}

function docContentTypes(handle: DbHandle, elementId: ElementId): string[] {
  const doc = new DocumentRepository(handle.db).findById(elementId)?.prosemirrorJson as
    | { content?: readonly { type?: string }[] }
    | undefined;
  return doc?.content?.map((node) => node.type ?? "") ?? [];
}

function paragraphTexts(handle: DbHandle, elementId: ElementId): string[] {
  const doc = new DocumentRepository(handle.db).findById(elementId)?.prosemirrorJson as
    | {
        content?: readonly {
          type?: string;
          content?: readonly { type?: string; text?: string }[];
        }[];
      }
    | undefined;
  return (
    doc?.content
      ?.filter((node) => node.type === "paragraph")
      .map((node) => node.content?.map((child) => child.text ?? "").join("") ?? "") ?? []
  );
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  handle.sqlite.close();
});

describe("ExtractionService.createExtraction", () => {
  it("creates exactly one extract with correct source/parent lineage", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);
    const elementsRepo = new ElementRepository(handle.db);

    const beforeExtracts = elementsRepo.listByType("extract").length;
    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.625,
    });

    const extracts = elementsRepo.listByType("extract");
    expect(extracts.length).toBe(beforeExtracts + 1);
    expect(element.type).toBe("extract");
    expect(element.stage).toBe("raw_extract");
    // Top-level extract: parent AND source are the original source.
    expect(element.parentId).toBe(sourceId);
    expect(element.sourceId).toBe(sourceId);
  });

  it("births clear one-sentence facts as atomic statements with a one-day attention due date", () => {
    const sourceId = seedAtomicSource(handle, 0.125);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const before = Date.now();
    const { element, shapeClassification } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The hippocampus supports episodic memory consolidation.",
      blockIds: [blocks[0] as BlockId],
      startOffset: 0,
      endOffset: 55,
      priority: 0.125,
    });

    expect(element.stage).toBe("atomic_statement");
    expect(element.status).toBe("scheduled");
    const due = Date.parse(element.dueAt ?? "");
    expect(due).toBeGreaterThan(before);
    expect(due - before).toBeLessThanOrEqual(25 * 60 * 60 * 1000);

    const payload = createExtractPayload(element.id);
    expect(payload.shapeClassification).toMatchObject({
      heuristicVersion: "extract-shape.v1",
      classification: "atomic_ready",
      stage: "atomic_statement",
      inputSignals: {
        hasList: false,
        hasCode: false,
        hasMath: false,
        hasMedia: false,
        rich: true,
        fallback: false,
        reconstructionFailed: false,
      },
    });
    expect(shapeClassification).toEqual(payload.shapeClassification);
    expect(payload.shapeClassification).toHaveProperty("normalizedInputHash");
    expect(JSON.stringify(payload.shapeClassification)).not.toContain(
      "The hippocampus supports episodic memory consolidation.",
    );
  });

  it("records a source_locations row matching the selection", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element, location } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.625,
    });

    const row = handle.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, element.id))
      .get();
    expect(row).toBeTruthy();
    expect(JSON.parse(row?.blockIds ?? "[]")).toEqual([blocks[1]]);
    expect(row?.startOffset).toBe(0);
    expect(row?.endOffset).toBe(29);
    expect(row?.selectedText).toBe("The definition paragraph two.");
    expect(row?.sourceElementId).toBe(sourceId);
    // A human-readable label is derived (the definition block is the 2nd ¶).
    expect(location.label).toBe("¶2");
  });

  it("seeds the extract's own document body from the selection", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      priority: 0.625,
    });

    const doc = new DocumentRepository(handle.db).findById(element.id);
    expect(doc).toBeTruthy();
    expect(doc?.plainText).toContain("The definition paragraph two.");
    expect(new DocumentRepository(handle.db).listBlocks(element.id).length).toBeGreaterThan(0);
  });

  it("updates the parent source adaptive multiplier when extraction is a processed visit", () => {
    const repos = createRepositories(handle.db);
    repos.settings.updateAppSettings({ adaptiveAttentionIntervals: true });
    const sourceId = seedSource(handle, 0.375);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.375,
    });

    const source = new ElementRepository(handle.db).findById(sourceId);
    expect(source?.attentionIntervalMultiplier).toBe(0.85);
    expect(reschedulePayloads(sourceId).at(-1)).toMatchObject({
      action: "extract",
      prevAttentionIntervalMultiplier: 1,
      attentionIntervalMultiplier: 0.85,
      attentionAdaptive: {
        version: 1,
        enabled: true,
        priorMultiplier: 1,
        newMultiplier: 0.85,
      },
    });
  });

  it("does NOT triage an inbox source out of the inbox on a processed-visit extract", () => {
    const repos = createRepositories(handle.db);
    repos.settings.updateAppSettings({ adaptiveAttentionIntervals: true });
    const sourceId = seedInboxSource(handle, 0.375);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element: extract } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.375,
    });

    // The guard is NARROW: the extract itself is still created and attention-scheduled —
    // only the SOURCE's processed-visit reschedule is skipped. (Asserting the extract was
    // born proves the guard isn't accidentally short-circuiting the whole extraction.)
    expect(extract.type).toBe("extract");
    expect(extract.status).toBe("scheduled");
    expect(extract.dueAt).toBeTruthy();

    // Extracting is engagement, not the explicit triage the user owns: the source stays
    // untriaged (still `inbox`, still no attention due date) and the adaptive processed-
    // visit reschedule that would flip it to `scheduled` is skipped.
    const after = new ElementRepository(handle.db).findById(sourceId);
    expect(after?.status).toBe("inbox");
    expect(after?.dueAt).toBeNull();
    expect(reschedulePayloads(sourceId).filter((p) => p.action === "extract")).toHaveLength(0);
  });

  it("still reschedules an already-active source as a processed visit (guard is inbox-only)", () => {
    const repos = createRepositories(handle.db);
    repos.settings.updateAppSettings({ adaptiveAttentionIntervals: true });
    const sourceId = seedSource(handle, 0.375); // status "active"
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.375,
    });

    // A non-inbox source is unaffected by the guard — the processed-visit reschedule runs:
    // the source is flipped to `scheduled` and the op-log records the extract visit.
    const after = new ElementRepository(handle.db).findById(sourceId);
    expect(after?.status).toBe("scheduled");
    expect(reschedulePayloads(sourceId).at(-1)).toMatchObject({ action: "extract" });
  });

  it("preserves paragraph structure when the selection spans multiple source blocks", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element, location } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "paragraph one.\nThe definition",
      blockIds: [blocks[0] as BlockId, blocks[1] as BlockId],
      startOffset: 6,
      endOffset: 14,
      priority: 0.625,
    });

    expect(docContentTypes(handle, element.id)).toEqual(["paragraph", "paragraph"]);
    expect(paragraphTexts(handle, element.id)).toEqual(["paragraph one.", "The definition"]);
    const doc = new DocumentRepository(handle.db).findById(element.id);
    expect(doc?.plainText).toBe("paragraph one.\n\nThe definition");
    const childBlocks = blockIdsOf(handle, element.id);
    expect(childBlocks).toHaveLength(2);
    expect(childBlocks).not.toEqual([blocks[0], blocks[1]]);
    expect(location.blockIds).toEqual([blocks[0], blocks[1]]);
    expect(element.stage).toBe("raw_extract");
    const payload = createExtractPayload(element.id);
    expect(payload.shapeClassification).toMatchObject({
      classification: "not_atomic_ready",
      stage: "raw_extract",
      inputSignals: {
        hasList: false,
        hasCode: false,
        hasMath: false,
        hasMedia: false,
        rich: true,
        fallback: false,
        reconstructionFailed: false,
      },
    });
    expect(
      (payload.shapeClassification as { stats?: { blockCount?: number } }).stats,
    ).toMatchObject({
      blockCount: 2,
    });
  });

  it("preserves selected article images in the extract body", () => {
    const { sourceId, blocks } = seedRichSource(handle);
    const service = new ExtractionService(handle.db);

    const { element, location } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "First paragraph here.\nArchitecture diagram\nSecond",
      blockIds: blocks,
      startOffset: 0,
      endOffset: 6,
      priority: 0.625,
    });

    expect(docContentTypes(handle, element.id)).toEqual(["paragraph", "image", "paragraph"]);
    const doc = new DocumentRepository(handle.db).findById(element.id)?.prosemirrorJson as {
      content?: readonly { type?: string; attrs?: Record<string, unknown> }[];
    };
    expect(doc.content?.[1]).toMatchObject({
      type: "image",
      attrs: {
        src: "article-image://source_1/asset_1",
        alt: "Architecture diagram",
        title: "Figure title",
        width: 640,
        height: 480,
      },
    });
    expect(doc.content?.[1]?.attrs?.blockId).not.toBe("src-rich-img");
    expect(new DocumentRepository(handle.db).findById(element.id)?.plainText).toBe(
      "First paragraph here.\n\nArchitecture diagram\n\nSecond",
    );
    expect(
      handle.db
        .select()
        .from(documentBlocks)
        .where(eq(documentBlocks.documentId, element.id))
        .all()
        .map((block) => block.blockType),
    ).toEqual(["paragraph", "image", "paragraph"]);
    expect(location.blockIds).toEqual(blocks);
    expect(element.stage).toBe("raw_extract");
  });

  it("preserves a standalone selected article image atom", () => {
    const { sourceId, blocks } = seedRichSource(handle);
    const service = new ExtractionService(handle.db);

    const { element, location } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "Architecture diagram",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 0,
      priority: 0.625,
    });

    expect(docContentTypes(handle, element.id)).toEqual(["image"]);
    expect(new DocumentRepository(handle.db).findById(element.id)?.plainText).toBe(
      "Architecture diagram",
    );
    expect(blockIdsOf(handle, element.id)).toHaveLength(1);
    expect(location.blockIds).toEqual([blocks[1]]);
    expect(element.stage).toBe("raw_extract");
  });

  it("keeps extracts raw when rich reconstruction fails and records the conservative reason", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);
    vi.spyOn(DocumentRepository.prototype, "findById").mockImplementationOnce(() => null);

    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The hippocampus supports episodic memory consolidation.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 54,
      priority: 0.875,
    });

    expect(element.stage).toBe("raw_extract");
    const payload = createExtractPayload(element.id);
    expect(payload.shapeClassification).toMatchObject({
      classification: "not_atomic_ready",
      stage: "raw_extract",
      inputSignals: {
        rich: false,
        fallback: true,
        reconstructionFailed: true,
      },
    });
    expect(
      (payload.shapeClassification as { reasonCodes?: readonly string[] }).reasonCodes,
    ).toContain("reconstruction_failed");
  });

  it("falls back to the selected text instead of widening offsetless partial selections", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);
    const findById = vi.spyOn(DocumentRepository.prototype, "findById");

    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "definition",
      blockIds: [blocks[1] as BlockId],
      priority: 0.625,
    });

    expect(findById).not.toHaveBeenCalled();
    const doc = new DocumentRepository(handle.db).findById(element.id);
    expect(doc?.plainText).toBe("definition");
    expect(paragraphTexts(handle, element.id)).toEqual(["definition"]);
  });

  it("classifies intentional offsetless text captures instead of treating them as fallback failures", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element, shapeClassification } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "Retrieval practice strengthens long-term retention.",
      blockIds: [blocks[1] as BlockId],
      priority: 0.625,
    });

    expect(element.stage).toBe("atomic_statement");
    expect(shapeClassification).toMatchObject({
      classification: "atomic_ready",
      stage: "atomic_statement",
      inputSignals: {
        rich: false,
        fallback: false,
        reconstructionFailed: false,
      },
    });
  });

  it("adds a derived_from relation extract → source", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      priority: 0.625,
    });

    const rel = handle.db
      .select()
      .from(elementRelations)
      .where(
        and(
          eq(elementRelations.fromElementId, element.id),
          eq(elementRelations.relationType, "derived_from"),
        ),
      )
      .get();
    expect(rel).toBeTruthy();
    expect(rel?.toElementId).toBe(sourceId);
  });

  it("inherits the source's priority and tags", () => {
    const sourceId = seedSource(handle, 0.875); // A priority
    const blocks = blockIdsOf(handle, sourceId);
    const elementsRepo = new ElementRepository(handle.db);
    elementsRepo.addTag(sourceId, "ai");
    elementsRepo.addTag(sourceId, "intelligence");
    const service = new ExtractionService(handle.db);

    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      priority: 0.875,
    });

    expect(element.priority).toBe(0.875);
    expect(new ElementRepository(handle.db).listTags(element.id).sort()).toEqual([
      "ai",
      "intelligence",
    ]);
  });

  it("sets a future attention due_at with status scheduled and NO review_states row", () => {
    const sourceId = seedSource(handle, 0.875);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const before = Date.now();
    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      priority: 0.875,
    });

    expect(element.status).toBe("scheduled");
    expect(element.dueAt).toBeTruthy();
    const due = Date.parse(element.dueAt ?? "");
    expect(due).toBeGreaterThan(before);
    // A priority extract returns in ~1 day (the raw_extract starter heuristic).
    expect(rawExtractIntervalDays(0.875)).toBe(1);

    // The extract is NOT on FSRS: no review_states row exists for it.
    const fsrs = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, element.id))
      .get();
    expect(fsrs).toBeUndefined();
    expect(handle.db.select().from(reviewStates).all().length).toBe(0);
  });

  it("marks the parent/source body with an extracted_span mark", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.625,
    });

    const mark = handle.db
      .select()
      .from(documentMarks)
      .where(
        and(eq(documentMarks.documentId, sourceId), eq(documentMarks.markType, "extracted_span")),
      )
      .get();
    expect(mark).toBeTruthy();
    expect(mark?.blockId).toBe(blocks[1]);
    expect(JSON.parse(mark?.attrs ?? "{}")).toMatchObject({ extractId: element.id });
  });

  it("appends exactly the expected operation_log rows", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    new ElementRepository(handle.db).addTag(sourceId, "ai");
    const service = new ExtractionService(handle.db);

    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.625,
    });

    // Ops anchored to the new extract element (create_element + create_extract +
    // update_document for its body + reschedule_element + add_tag).
    const extractOps = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all()
      .map((r) => r.opType);
    expect(extractOps).toContain("create_element");
    expect(extractOps).toContain("create_extract");
    expect(extractOps).toContain("update_document"); // the extract body seed
    expect(extractOps).toContain("reschedule_element");
    expect(extractOps).toContain("add_tag"); // inherited tag

    // The derived_from relation op is anchored to the extract (its `fromElementId`).
    const relOps = handle.db
      .select()
      .from(operationLog)
      .where(and(eq(operationLog.elementId, element.id), eq(operationLog.opType, "add_relation")))
      .all();
    expect(relOps.length).toBe(1);

    // The extracted_span mark add is logged under update_document on the SOURCE.
    const sourceMarkOps = handle.db
      .select()
      .from(operationLog)
      .where(and(eq(operationLog.elementId, sourceId), eq(operationLog.opType, "update_document")))
      .all()
      // exclude the source's own body seed (it has no `mark` payload field)
      .filter((r) => {
        const payload = JSON.parse(r.payload) as { mark?: string; markType?: string };
        return payload.mark === "add" && payload.markType === "extracted_span";
      });
    expect(sourceMarkOps.length).toBe(1);

    // No FSRS op type is in the closed set — assert none of the extract's ops is a review op.
    expect(extractOps).not.toContain("add_review_log");
  });

  it("rolls back the ENTIRE extraction atomically when a step throws", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    // Force the LAST step (the parent extracted_span mark) to throw, AFTER the
    // element/location/body/relation/reschedule have all been written on the tx.
    const docRepo = (service as unknown as { documents: DocumentRepository }).documents;
    const spy = vi.spyOn(docRepo, "addMarkWithin").mockImplementation(() => {
      throw new Error("boom: simulated failure inside the extraction transaction");
    });

    const elementsRepo = new ElementRepository(handle.db);
    const extractsBefore = elementsRepo.listByType("extract").length;
    const locationsBefore = handle.db.select().from(sourceLocations).all().length;
    const relationsBefore = handle.db.select().from(elementRelations).all().length;
    const marksBefore = handle.db.select().from(documentMarks).all().length;
    const opsBefore = handle.db.select().from(operationLog).all().length;
    const docsBefore = handle.db.select().from(documents).all().length;

    expect(() =>
      service.createExtraction({
        sourceElementId: sourceId,
        selectedText: "The definition paragraph two.",
        blockIds: [blocks[1] as BlockId],
        startOffset: 0,
        endOffset: 29,
        priority: 0.625,
      }),
    ).toThrow(/boom/);

    expect(spy).toHaveBeenCalled();
    // NOTHING from the extraction survived — no orphan rows of any kind.
    expect(elementsRepo.listByType("extract").length).toBe(extractsBefore);
    expect(handle.db.select().from(sourceLocations).all().length).toBe(locationsBefore);
    expect(handle.db.select().from(elementRelations).all().length).toBe(relationsBefore);
    expect(handle.db.select().from(documentMarks).all().length).toBe(marksBefore);
    expect(handle.db.select().from(operationLog).all().length).toBe(opsBefore);
    expect(handle.db.select().from(documents).all().length).toBe(docsBefore);
  });
});

describe("ExtractionService.createExtraction — sub-extracts (T025)", () => {
  /** Create a top-level extract from the source's 2nd block, return its id + blocks. */
  function seedExtract(handle: DbHandle, sourceId: ElementId) {
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);
    const { element } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.625,
    });
    return { extractId: element.id, extractBlocks: blockIdsOf(handle, element.id) };
  }

  it("splits an extract into a sub-extract preserving source → extract → sub-extract", () => {
    const sourceId = seedSource(handle, 0.625);
    const { extractId, extractBlocks } = seedExtract(handle, sourceId);
    const service = new ExtractionService(handle.db);

    // Select inside the EXTRACT body and lift it into a sub-extract: parentId = the
    // extract, sourceElementId = the original source root (the reuse the spec requires).
    const { element: sub, location } = service.createExtraction({
      sourceElementId: sourceId,
      parentId: extractId,
      selectedText: "definition paragraph two.",
      blockIds: [extractBlocks[0] as BlockId],
      startOffset: 4,
      endOffset: 29,
      priority: 0.625,
    });

    // Lineage: parent is the extract, source root is still the original source.
    expect(sub.type).toBe("extract");
    expect(sub.parentId).toBe(extractId);
    expect(sub.sourceId).toBe(sourceId);

    // The source_locations anchor points INTO the parent extract (where the text
    // was selected), NOT the original source — so jump-to-source lands correctly.
    const row = handle.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, sub.id))
      .get();
    expect(row?.sourceElementId).toBe(extractId);
    expect(JSON.parse(row?.blockIds ?? "[]")).toEqual([extractBlocks[0]]);
    expect(location.sourceElementId).toBe(extractId);

    // A derived_from edge points the sub-extract at its PARENT EXTRACT.
    const rel = handle.db
      .select()
      .from(elementRelations)
      .where(
        and(
          eq(elementRelations.fromElementId, sub.id),
          eq(elementRelations.relationType, "derived_from"),
        ),
      )
      .get();
    expect(rel?.toElementId).toBe(extractId);

    // The PARENT EXTRACT's body gains an extracted_span mark (not the source's).
    const parentMark = handle.db
      .select()
      .from(documentMarks)
      .where(
        and(eq(documentMarks.documentId, extractId), eq(documentMarks.markType, "extracted_span")),
      )
      .get();
    expect(parentMark).toBeTruthy();
    expect(parentMark?.blockId).toBe(extractBlocks[0]);

    // Sub-extracts are attention items like extracts — scheduled, NOT FSRS.
    expect(sub.status).toBe("scheduled");
    expect(sub.dueAt).toBeTruthy();
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, sub.id)).get(),
    ).toBeUndefined();
  });

  it("reconstructs rich sub-extract bodies from the parent extract document", () => {
    const { sourceId, blocks: sourceBlocks } = seedRichSource(handle);
    const service = new ExtractionService(handle.db);
    const { element: parent } = service.createExtraction({
      sourceElementId: sourceId,
      selectedText: "First paragraph here.\nArchitecture diagram\nSecond",
      blockIds: sourceBlocks,
      startOffset: 0,
      endOffset: 6,
      priority: 0.625,
    });
    const parentBlocks = blockIdsOf(handle, parent.id);

    const { element: sub, location } = service.createExtraction({
      sourceElementId: sourceId,
      parentId: parent.id,
      selectedText: "First paragraph here.\nArchitecture diagram\nSecond",
      blockIds: parentBlocks,
      startOffset: 0,
      endOffset: 6,
      priority: 0.625,
    });

    expect(sub.parentId).toBe(parent.id);
    expect(sub.sourceId).toBe(sourceId);
    expect(location.sourceElementId).toBe(parent.id);
    expect(location.blockIds).toEqual(parentBlocks);
    expect(docContentTypes(handle, sub.id)).toEqual(["paragraph", "image", "paragraph"]);
    const subBlocks = blockIdsOf(handle, sub.id);
    expect(subBlocks).toHaveLength(3);
    expect(subBlocks).not.toEqual(parentBlocks);
    const doc = new DocumentRepository(handle.db).findById(sub.id)?.prosemirrorJson as {
      content?: readonly { type?: string; attrs?: Record<string, unknown> }[];
    };
    expect(doc.content?.[1]).toMatchObject({
      type: "image",
      attrs: {
        src: "article-image://source_1/asset_1",
        alt: "Architecture diagram",
      },
    });
    expect(doc.content?.[1]?.attrs?.blockId).not.toBe(parentBlocks[1]);
  });

  it("inherits the original source's priority and tags onto the sub-extract", () => {
    const sourceId = seedSource(handle, 0.875); // A priority
    new ElementRepository(handle.db).addTag(sourceId, "ai");
    const { extractId, extractBlocks } = seedExtract(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element: sub } = service.createExtraction({
      sourceElementId: sourceId,
      parentId: extractId,
      selectedText: "definition paragraph two.",
      blockIds: [extractBlocks[0] as BlockId],
      priority: 0.875,
    });

    expect(sub.priority).toBe(0.875);
    expect(new ElementRepository(handle.db).listTags(sub.id)).toContain("ai");
  });

  it("the lineage query returns source → extract → sub-extract at correct depths", () => {
    const sourceId = seedSource(handle, 0.625);
    const { extractId, extractBlocks } = seedExtract(handle, sourceId);
    const service = new ExtractionService(handle.db);
    const { element: sub } = service.createExtraction({
      sourceElementId: sourceId,
      parentId: extractId,
      selectedText: "definition paragraph two.",
      blockIds: [extractBlocks[0] as BlockId],
      priority: 0.625,
    });

    const lineage = new LineageQuery(createRepositories(handle.db)).get(sub.id);
    expect(lineage).toBeTruthy();
    expect(lineage?.rootId).toBe(sourceId);
    const byId = new Map((lineage?.nodes ?? []).map((n) => [n.id, n]));
    expect(byId.get(sourceId)?.depth).toBe(0);
    expect(byId.get(extractId)?.depth).toBe(1);
    expect(byId.get(sub.id)?.depth).toBe(2);
    // The sub-extract is tagged as such; the active node is the requested element.
    expect(byId.get(sub.id)?.meta).toBe("sub-extract");
    expect(byId.get(sub.id)?.active).toBe(true);
  });
});

describe("ExtractionService.createClipExtract (T074 — media clip)", () => {
  it("creates a media_fragment + a clip source-location (timestamp + window)", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element, location } = service.createClipExtract({
      sourceElementId: sourceId,
      startMs: 42_000,
      endMs: 75_000,
      anchorBlockId: blocks[0] as BlockId,
      transcriptSegment: "the spoken phrase under the range",
      priority: 0.625,
    });

    // It is an attention-scheduled media_fragment with full lineage to the source.
    expect(element.type).toBe("media_fragment");
    expect(element.stage).toBe("raw_extract");
    expect(element.status).toBe("scheduled");
    expect(element.dueAt).not.toBeNull();
    expect(element.sourceId).toBe(sourceId);
    expect(element.parentId).toBe(sourceId);

    // NEVER FSRS — no review_states row for a media_fragment clip.
    expect(
      handle.db.select().from(reviewStates).where(eq(reviewStates.elementId, element.id)).get(),
    ).toBeUndefined();

    // The location carries timestamp_ms = startMs + the clip window + the label.
    expect(location.timestampMs).toBe(42_000);
    expect(location.clip).toEqual({ startMs: 42_000, endMs: 75_000 });
    expect(location.label).toBe("Clip 0:42–1:15");
    expect(location.blockIds).toEqual([blocks[0]]);
    expect(location.selectedText).toBe("the spoken phrase under the range");

    // Persisted: the clip cell round-trips through the DB.
    const row = handle.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, element.id))
      .get();
    expect(row?.timestampMs).toBe(42_000);
    expect(JSON.parse(row?.clip ?? "null")).toEqual({ startMs: 42_000, endMs: 75_000 });

    // The op log carries create_element + create_extract for the fragment.
    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, element.id))
      .all()
      .map((o) => o.opType);
    expect(ops).toContain("create_element");
    expect(ops).toContain("create_extract");
  });

  it("falls back to the clip label when no transcript segment is given", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);

    const { element, location } = service.createClipExtract({
      sourceElementId: sourceId,
      startMs: 0,
      endMs: 5_000,
      anchorBlockId: blocks[0] as BlockId,
      transcriptSegment: null,
      priority: 0.375,
    });
    expect(element.title).toBe("Clip 0:00–0:05");
    expect(location.selectedText).toBe("Clip 0:00–0:05");
    expect(location.clip).toEqual({ startMs: 0, endMs: 5_000 });
  });

  it("rejects an inverted/zero-length window", () => {
    const sourceId = seedSource(handle);
    const blocks = blockIdsOf(handle, sourceId);
    const service = new ExtractionService(handle.db);
    expect(() =>
      service.createClipExtract({
        sourceElementId: sourceId,
        startMs: 10_000,
        endMs: 10_000,
        anchorBlockId: blocks[0] as BlockId,
        priority: 0.5,
      }),
    ).toThrow(/invalid clip window/);
  });
});

describe("rawExtractIntervalDays", () => {
  it("returns sooner intervals for higher priority", () => {
    expect(rawExtractIntervalDays(0.875)).toBe(1); // A
    expect(rawExtractIntervalDays(0.625)).toBe(3); // B
    expect(rawExtractIntervalDays(0.375)).toBe(5); // C
    expect(rawExtractIntervalDays(0.125)).toBe(7); // D
    // Sanity: the band → days map agrees with priorityToLabel.
    expect(priorityToLabel(0.875)).toBe("A");
  });
});
