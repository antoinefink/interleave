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

import type { BlockId, ElementId, Priority } from "@interleave/core";
import { priorityToLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import {
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

/** The stable block ids of a source body, in document order. */
function blockIdsOf(handle: DbHandle, sourceId: ElementId): BlockId[] {
  return new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((b) => b.stableBlockId as BlockId);
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
