/**
 * ExtractStagnationQuery tests (T084 — the extract-stagnation scan).
 *
 * Run against a TEMPORARY, fully-migrated in-memory `better-sqlite3` DB so the
 * op-log postpone markers + stage-advance reads match production exactly. They pin:
 *  - a raw_extract postponed ≥ threshold (via REAL `ExtractService.postpone`, so the
 *    `reschedule_element` markers exist) with no children + an old createdAt appears
 *    with the right `postponeCount`, reasons, and suggestion;
 *  - a sibling that `advanceStage`d to `atomic_statement` is EXCLUDED (it progressed);
 *  - a sibling that produced a child (a card) is EXCLUDED (it was productive);
 *  - the `stagnantCount`, the most-stagnant-first sort, and that a soft-deleted
 *    extract is excluded;
 *  - the scan is read-only (it appends NO `operation_log` rows).
 *
 * Staleness is asserted by computing `asOf` 60 days AFTER the extracts are created
 * (their `createdAt` is "now"); the pure heuristic measures days-since-progress from
 * the last stage advance (or `createdAt`), so a future `asOf` makes a never-advanced
 * extract stale without backdating rows.
 */

import type { BlockId, ElementId, IsoTimestamp, Priority } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { elements, operationLog } from "@interleave/db";
import { STAGNATION_POSTPONE_THRESHOLD } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CardService } from "./card-service";
import { DocumentRepository } from "./document-repository";
import { ExtractService } from "./extract-service";
import { ExtractStagnationQuery } from "./extract-stagnation-query";
import { ExtractionService } from "./extraction-service";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

/** `asOf` far enough after "now" that a never-advanced extract reads as stale. */
function farFutureAsOf(): IsoTimestamp {
  return new Date(Date.now() + 60 * 86_400_000).toISOString() as IsoTimestamp;
}

/** Seed a source with a 3-paragraph body; return its element id. */
function seedSource(handle: DbHandle, title = "On Intelligence"): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title,
    priority: 0.625,
    status: "active",
    stage: "raw_source",
    body: "Paragraph one.\n\nParagraph two.\n\nParagraph three.",
  });
  return element.id;
}

/** Seed a top-level extract from a source's k-th paragraph; return its id. */
function seedExtract(
  handle: DbHandle,
  sourceId: ElementId,
  k: number,
  priority: Priority = 0.625 as Priority,
): ElementId {
  const blocks = new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((b) => b.stableBlockId as BlockId);
  const extraction = new ExtractionService(handle.db);
  const { element } = extraction.createExtraction({
    sourceElementId: sourceId,
    selectedText: `Paragraph ${k + 1}.`,
    blockIds: [blocks[k] as BlockId],
    startOffset: 0,
    endOffset: 12,
    priority,
  });
  return element.id;
}

/** Postpone an extract `n` times via the real service (records op-log markers). */
function postponeN(handle: DbHandle, extractId: ElementId, n: number): void {
  const service = new ExtractService(handle.db);
  for (let i = 0; i < n; i++) service.postpone(extractId);
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("ExtractStagnationQuery.listStagnantExtracts", () => {
  it("flags a repeatedly-postponed, never-advanced, child-less extract", () => {
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId, 1);
    postponeN(handle, extractId, STAGNATION_POSTPONE_THRESHOLD);

    const query = new ExtractStagnationQuery(handle.db);
    const summary = query.listStagnantExtracts(farFutureAsOf());

    expect(summary.stagnantCount).toBe(1);
    const row = summary.rows[0];
    expect(row?.extract.id).toBe(extractId);
    expect(row?.postponeCount).toBe(STAGNATION_POSTPONE_THRESHOLD);
    expect(row?.childCount).toBe(0);
    expect(row?.reasons).toEqual(
      expect.arrayContaining(["postponed-repeatedly", "no-progress", "no-children", "stale"]),
    );
    expect(row?.suggestion).toBeDefined();
  });

  it("excludes an extract that advanced to atomic_statement (it progressed)", () => {
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId, 1);
    postponeN(handle, extractId, STAGNATION_POSTPONE_THRESHOLD);
    const service = new ExtractService(handle.db);
    service.advanceStage(extractId); // raw → clean
    service.advanceStage(extractId); // clean → atomic

    const query = new ExtractStagnationQuery(handle.db);
    const summary = query.listStagnantExtracts(farFutureAsOf());
    expect(summary.stagnantCount).toBe(0);
  });

  it("excludes an extract that produced a child card (it was productive)", () => {
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId, 1);
    postponeN(handle, extractId, STAGNATION_POSTPONE_THRESHOLD);
    new CardService(handle.db).createFromExtract({
      extractId,
      kind: "qa",
      prompt: "What is paragraph two about?",
      answer: "The definition.",
    });

    const query = new ExtractStagnationQuery(handle.db);
    const summary = query.listStagnantExtracts(farFutureAsOf());
    expect(summary.stagnantCount).toBe(0);
  });

  it("does NOT count a recent stage advance as stagnant (staleness from last advance)", () => {
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId, 1);
    postponeN(handle, extractId, STAGNATION_POSTPONE_THRESHOLD);
    // Advance once recently → it is still clean_extract (not atomic) AND child-less,
    // but its stage advanced "just now", so it is not stale relative to ~now.
    new ExtractService(handle.db).advanceStage(extractId);

    const query = new ExtractStagnationQuery(handle.db);
    // asOf ~ now (creation time): the recent advance keeps daysSinceProgress small.
    const summary = query.listStagnantExtracts(new Date().toISOString() as IsoTimestamp);
    expect(summary.stagnantCount).toBe(0);
  });

  it("sorts most-postponed first and reports stagnantCount", () => {
    const sourceId = seedSource(handle);
    const a = seedExtract(handle, sourceId, 0);
    const b = seedExtract(handle, sourceId, 1);
    const c = seedExtract(handle, sourceId, 2);
    postponeN(handle, a, STAGNATION_POSTPONE_THRESHOLD);
    postponeN(handle, b, STAGNATION_POSTPONE_THRESHOLD + 2);
    postponeN(handle, c, STAGNATION_POSTPONE_THRESHOLD + 1);

    const query = new ExtractStagnationQuery(handle.db);
    const summary = query.listStagnantExtracts(farFutureAsOf());
    expect(summary.stagnantCount).toBe(3);
    expect(summary.rows.map((r) => r.extract.id)).toEqual([b, c, a]);
    expect(summary.rows[0]?.postponeCount).toBe(STAGNATION_POSTPONE_THRESHOLD + 2);
  });

  it("excludes a soft-deleted extract", () => {
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId, 1);
    postponeN(handle, extractId, STAGNATION_POSTPONE_THRESHOLD);
    new ExtractService(handle.db).delete(extractId);

    const query = new ExtractStagnationQuery(handle.db);
    const summary = query.listStagnantExtracts(farFutureAsOf());
    expect(summary.stagnantCount).toBe(0);
  });

  it("does not flag a once-postponed extract (below the postpone threshold)", () => {
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId, 1);
    postponeN(handle, extractId, STAGNATION_POSTPONE_THRESHOLD - 1);

    const query = new ExtractStagnationQuery(handle.db);
    const summary = query.listStagnantExtracts(farFutureAsOf());
    expect(summary.stagnantCount).toBe(0);
  });

  it("is read-only — appends NO operation_log rows", () => {
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId, 1);
    postponeN(handle, extractId, STAGNATION_POSTPONE_THRESHOLD);

    const before = handle.db.select().from(operationLog).all().length;
    new ExtractStagnationQuery(handle.db).listStagnantExtracts(farFutureAsOf());
    const after = handle.db.select().from(operationLog).all().length;
    expect(after).toBe(before);
  });

  it("ignores leech/flag/body update_element ops (only stage-advance patches count)", () => {
    // A stage advance that DID happen must be the only thing read as a stage advance;
    // an unrelated `update_element` (no patch.stage) must not be mistaken for progress.
    const sourceId = seedSource(handle);
    const extractId = seedExtract(handle, sourceId, 1);
    postponeN(handle, extractId, STAGNATION_POSTPONE_THRESHOLD);
    // Manually append a non-stage update_element op (the shape setCardLeech logs).
    handle.db
      .insert(operationLog)
      .values({
        id: "op-noise-1",
        opType: "update_element",
        payload: JSON.stringify({ id: extractId, isLeech: true }),
        elementId: extractId,
        createdAt: new Date().toISOString(),
      })
      .run();

    const query = new ExtractStagnationQuery(handle.db);
    const summary = query.listStagnantExtracts(farFutureAsOf());
    // The noise op is NOT a stage advance, so staleness is still from createdAt and the
    // extract is still stagnant.
    expect(summary.stagnantCount).toBe(1);
    expect(summary.rows[0]?.extract.id).toBe(extractId);

    // Sanity: the element really exists + is an extract.
    const row = handle.db.select().from(elements).where(eq(elements.id, extractId)).get();
    expect(row?.type).toBe("extract");
  });
});
