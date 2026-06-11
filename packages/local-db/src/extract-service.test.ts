/**
 * ExtractService tests (T024 — extract review mode).
 *
 * These run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so
 * behaviour matches production exactly. They assert the load-bearing extract
 * review invariants in ONE place:
 *
 *  - the stage chain walks `raw_extract → clean_extract → atomic_statement`, each
 *    `advanceStage`/`setStage` persisting the new `stage` AND rescheduling on the
 *    ATTENTION scheduler (a FUTURE `due_at`, status `scheduled`), logging exactly
 *    `update_element` + `reschedule_element` per transition — and NEVER an FSRS
 *    `review_states` row;
 *  - `rewrite`/`trim` upsert the body (`update_document`) without moving the stage
 *    or rescheduling, and `trimExtractText` only normalizes whitespace;
 *  - `postpone` reschedules further out and records a `postpone` marker + running
 *    count in the `reschedule_element` op payload (schema-churn-free), so
 *    `countPostpones` climbs;
 *  - `markDone` sets status `done` (lineage intact);
 *  - `delete` is a SOFT delete (status `deleted`, `deletedAt` set, op logged) that
 *    leaves the `source_locations`/`element_relations` lineage rows intact.
 */

import type { BlockId, ElementId, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import {
  documents,
  elementRelations,
  elements,
  operationLog,
  reviewStates,
  sourceLocations,
} from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import {
  EXTRACT_STAGES,
  ExtractService,
  extractStageIntervalDays,
  nextExtractStage,
  postponeIntervalDays,
  trimExtractText,
} from "./extract-service";
import { ExtractionService } from "./extraction-service";
import { SourceRepository } from "./source-repository";
import { SynthesisService } from "./synthesis-service";
import { createInMemoryDb } from "./test-db";
import { UndoService } from "./undo-service";

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

/** Seed a source + a top-level extract from its 2nd paragraph; return both ids. */
function seedExtract(
  handle: DbHandle,
  priority: Priority = 0.625,
): { sourceId: ElementId; extractId: ElementId } {
  const sourceId = seedSource(handle, priority);
  const blocks = blockIdsOf(handle, sourceId);
  const extraction = new ExtractionService(handle.db);
  const { element } = extraction.createExtraction({
    sourceElementId: sourceId,
    selectedText: "The definition paragraph two.",
    blockIds: [blocks[1] as BlockId],
    startOffset: 0,
    endOffset: 29,
    priority,
  });
  return { sourceId, extractId: element.id };
}

/** Op types logged against a given element, in insertion order. */
function opsFor(handle: DbHandle, id: ElementId): string[] {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, id))
    .all()
    .map((row) => row.opType);
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  handle.sqlite.close();
});

describe("EXTRACT_STAGES / nextExtractStage", () => {
  it("is the three-step chain in order", () => {
    expect(EXTRACT_STAGES).toEqual(["raw_extract", "clean_extract", "atomic_statement"]);
  });

  it("walks raw → clean → atomic then stops", () => {
    expect(nextExtractStage("raw_extract")).toBe("clean_extract");
    expect(nextExtractStage("clean_extract")).toBe("atomic_statement");
    expect(nextExtractStage("atomic_statement")).toBeNull();
  });
});

describe("extractStageIntervalDays", () => {
  it("returns sooner intervals for higher priority within each stage band", () => {
    // A (high) returns sooner than D (low) at every stage.
    expect(extractStageIntervalDays("raw_extract", 1)).toBeLessThan(
      extractStageIntervalDays("raw_extract", 0),
    );
    // clean_extract pushes further out than raw_extract for the same priority.
    expect(extractStageIntervalDays("clean_extract", 0.625)).toBeGreaterThan(
      extractStageIntervalDays("raw_extract", 0.625),
    );
    // atomic_statement is card-ready: come back tomorrow.
    expect(extractStageIntervalDays("atomic_statement", 0.625)).toBe(1);
  });
});

describe("trimExtractText", () => {
  it("collapses runs of whitespace + trims, without deleting words", () => {
    expect(trimExtractText("  The   quick \t brown   fox  ")).toBe("The quick brown fox");
    expect(trimExtractText("line one\n\n\n\nline two")).toBe("line one\n\nline two");
  });
});

describe("ExtractService.advanceStage (raw → clean → atomic)", () => {
  it("advances stage, sets a future attention due_at, and logs update_element + reschedule_element each step", () => {
    const { extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);
    const elementsRepo = new ElementRepository(handle.db);

    // A new extract starts at raw_extract (the ExtractionService default).
    expect(elementsRepo.findById(extractId)?.stage).toBe("raw_extract");
    const opsBefore = opsFor(handle, extractId).length;

    // raw → clean
    const r1 = service.advanceStage(extractId);
    expect(r1.element.stage).toBe("clean_extract");
    expect(r1.element.status).toBe("scheduled");
    expect(r1.element.dueAt).toBeTruthy();
    expect(Date.parse(r1.element.dueAt as string)).toBeGreaterThan(Date.now());

    // clean → atomic
    const r2 = service.advanceStage(extractId);
    expect(r2.element.stage).toBe("atomic_statement");
    expect(r2.element.dueAt).toBeTruthy();

    // Each advance logs exactly update_element + reschedule_element (2 ops × 2 steps).
    const opsAfter = opsFor(handle, extractId);
    expect(opsAfter.length).toBe(opsBefore + 4);
    expect(opsAfter.slice(-4)).toEqual([
      "update_element",
      "reschedule_element",
      "update_element",
      "reschedule_element",
    ]);

    // Persisted: re-reading the row reflects the final stage + due date.
    const persisted = elementsRepo.findById(extractId);
    expect(persisted?.stage).toBe("atomic_statement");

    // NEVER FSRS — no review_states row was created by a stage move.
    const reviewRow = handle.db
      .select()
      .from(reviewStates)
      .where(eq(reviewStates.elementId, extractId))
      .get();
    expect(reviewRow).toBeUndefined();
  });

  it("reschedules using the by-stage interval for the extract's priority", () => {
    const { extractId } = seedExtract(handle, 0.625); // band B
    const service = new ExtractService(handle.db);

    const before = Date.now();
    const { element } = service.advanceStage(extractId); // → clean_extract
    const expectedDays = extractStageIntervalDays("clean_extract", 0.625);
    const dueMs = Date.parse(element.dueAt as string);
    const days = Math.round((dueMs - before) / 86_400_000);
    expect(days).toBe(expectedDays);
  });

  it("throws when already at atomic_statement (nothing to advance)", () => {
    const { extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);
    service.setStage(extractId, "atomic_statement");
    expect(() => service.advanceStage(extractId)).toThrow(/atomic_statement/);
  });

  it("rejects a non-extract element", () => {
    const sourceId = seedSource(handle);
    const service = new ExtractService(handle.db);
    expect(() => service.advanceStage(sourceId)).toThrow(/not an extract/);
  });
});

describe("ExtractService.rewrite / trim", () => {
  it("upserts the body (update_document) WITHOUT moving the stage or rescheduling", () => {
    const { extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);
    const elementsRepo = new ElementRepository(handle.db);

    const before = elementsRepo.findById(extractId);
    const opsBefore = opsFor(handle, extractId);

    const result = service.rewrite({
      elementId: extractId,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "A cleaner, rewritten body.",
    });
    expect(result.plainText).toBe("A cleaner, rewritten body.");

    // The persisted body changed.
    const doc = handle.db.select().from(documents).where(eq(documents.elementId, extractId)).get();
    expect(doc?.plainText).toBe("A cleaner, rewritten body.");

    // Stage + due date are untouched (no reschedule on a rewrite).
    const after = elementsRepo.findById(extractId);
    expect(after?.stage).toBe(before?.stage);
    expect(after?.dueAt).toBe(before?.dueAt);

    // Exactly one new op, and it is update_document.
    const opsAfter = opsFor(handle, extractId);
    expect(opsAfter.length).toBe(opsBefore.length + 1);
    expect(opsAfter.at(-1)).toBe("update_document");
  });
});

describe("ExtractService.postpone", () => {
  it("reschedules further out and records a postpone marker + running count", () => {
    const { extractId } = seedExtract(handle, 0.625);
    const service = new ExtractService(handle.db);

    expect(service.countPostpones(extractId)).toBe(0);

    const before = Date.now();
    const r1 = service.postpone(extractId);
    expect(r1.element.status).toBe("scheduled");
    const days = Math.round((Date.parse(r1.element.dueAt as string) - before) / 86_400_000);
    expect(days).toBe(postponeIntervalDays(0.625));
    expect(service.countPostpones(extractId)).toBe(1);

    service.postpone(extractId);
    expect(service.countPostpones(extractId)).toBe(2);

    // The marker rides on the reschedule_element op payload (no schema column).
    const rescheduleOps = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, extractId))
      .all()
      .filter((op) => op.opType === "reschedule_element");
    const lastPayload = JSON.parse(rescheduleOps.at(-1)?.payload ?? "{}");
    expect(lastPayload.postpone).toBe(true);
    expect(lastPayload.postponeCount).toBe(2);
  });
});

describe("ExtractService.markDone", () => {
  it("sets status done, clears active due, and logs update_element, leaving lineage intact", () => {
    const { sourceId, extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);

    const { element } = service.markDone(extractId);
    expect(element.status).toBe("done");
    expect(element.dueAt).toBeNull();
    expect(opsFor(handle, extractId).at(-1)).toBe("update_element");

    // Lineage to the source is untouched.
    const loc = handle.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, extractId))
      .get();
    expect(loc?.sourceElementId).toBe(sourceId);
  });
});

describe("ExtractService extract fates (T104)", () => {
  it("sets a direct honorable fate with one update_element patch and clears active scheduling", () => {
    const { extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);

    const { element } = service.setFate(extractId, "reference");
    expect(element.status).toBe("done");
    expect(element.dueAt).toBeNull();
    expect(element.parkedAt).toBeNull();
    expect(element.extractFate).toBe("reference");
    expect(opsFor(handle, extractId).at(-1)).toBe("update_element");

    const lastOp = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, extractId))
      .all()
      .at(-1);
    const payload = JSON.parse(lastOp?.payload ?? "{}");
    expect(payload.patch).toMatchObject({
      status: "done",
      dueAt: null,
      parkedAt: null,
      extractFate: "reference",
    });
    expect(payload.prev).toMatchObject({ extractFate: null });
  });

  it("rejects direct synthesized fate and reactivates a fated extract due now", () => {
    const { extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);

    expect(() => service.setFate(extractId, "synthesized" as never)).toThrow(/synthesis-note/);

    service.setFate(extractId, "done_without_card");
    const { element } = service.reactivateFate(extractId);
    expect(element.status).toBe("scheduled");
    expect(element.dueAt).toBeTruthy();
    expect(element.parkedAt).toBeNull();
    expect(element.extractFate).toBeNull();
  });

  it("does not reactivate a synthesized extract while live synthesis lineage still references it", () => {
    const { extractId } = seedExtract(handle);
    const synthesis = new SynthesisService(handle.db);
    const note = synthesis.create({ title: "Synthesis note" }).element;
    synthesis.linkElement(note.id, extractId);

    expect(() => new ExtractService(handle.db).reactivateFate(extractId)).toThrow(
      /unlink the extract/,
    );
  });

  it("rejects stage and postpone actions on fated extracts until reactivation", () => {
    const { extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);
    service.setFate(extractId, "reference");

    expect(() => service.setStage(extractId, "clean_extract")).toThrow(/reactivate/);
    expect(() => service.postpone(extractId)).toThrow(/reactivate/);

    service.reactivateFate(extractId);
    expect(() => service.postpone(extractId)).not.toThrow();
  });

  it("undo restores the full pre-fate active state", () => {
    const { extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);
    const before = service.postpone(extractId).element;

    service.setFate(extractId, "reference");
    new UndoService(handle.db).undoLast();

    const restored = new ElementRepository(handle.db).findById(extractId);
    expect(restored?.status).toBe(before.status);
    expect(restored?.dueAt).toBe(before.dueAt);
    expect(restored?.parkedAt).toBe(before.parkedAt);
    expect(restored?.extractFate).toBeNull();
  });

  it("undo restores the full fated state after reactivation", () => {
    const { extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);
    const fated = service.setFate(extractId, "done_without_card").element;

    service.reactivateFate(extractId);
    new UndoService(handle.db).undoLast();

    const restored = new ElementRepository(handle.db).findById(extractId);
    expect(restored?.status).toBe(fated.status);
    expect(restored?.dueAt).toBe(fated.dueAt);
    expect(restored?.parkedAt).toBe(fated.parkedAt);
    expect(restored?.extractFate).toBe("done_without_card");
  });
});

describe("ExtractService.delete (soft)", () => {
  it("soft-deletes (status deleted + deletedAt), logs the op, and keeps lineage rows", () => {
    const { sourceId, extractId } = seedExtract(handle);
    const service = new ExtractService(handle.db);

    const { element } = service.delete(extractId);
    expect(element.status).toBe("deleted");
    expect(element.deletedAt).toBeTruthy();
    expect(opsFor(handle, extractId).at(-1)).toBe("soft_delete_element");

    // The row is NOT hard-deleted — it still exists in the table.
    const row = handle.db.select().from(elements).where(eq(elements.id, extractId)).get();
    expect(row).toBeTruthy();
    expect(row?.deletedAt).toBeTruthy();

    // Lineage rows (source location + derived_from relation) remain valid.
    const loc = handle.db
      .select()
      .from(sourceLocations)
      .where(eq(sourceLocations.elementId, extractId))
      .get();
    expect(loc?.sourceElementId).toBe(sourceId);
    const rel = handle.db
      .select()
      .from(elementRelations)
      .where(eq(elementRelations.fromElementId, extractId))
      .get();
    expect(rel?.relationType).toBe("derived_from");
    expect(rel?.toElementId).toBe(sourceId);
  });
});
