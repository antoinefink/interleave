/**
 * Source → extract → card chain operation-log invariants (T021/T025/T051).
 *
 * These tests pin one high-risk integration seam not covered by service-local
 * assertions: when an extract is created from a source and then transformed into a
 * card, lineage edges and operation-log payloads must stay coherent across both
 * mutation boundaries (no silent `derived_from` drift, no missing ops, no cross-edge
 * mix-ups).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DbHandle } from "@interleave/db";
import type { BlockId, ElementId } from "@interleave/core";
import { and, eq } from "drizzle-orm";
import { elementRelations, operationLog } from "@interleave/db";
import { ElementRepository } from "./element-repository";
import { ExtractionService } from "./extraction-service";
import { createInMemoryDb } from "./test-db";
import { DocumentRepository } from "./document-repository";
import { CardService } from "./card-service";
import { OperationLogRepository } from "./operation-log-repository";
import { SourceRepository } from "./source-repository";

let handle: DbHandle;

function seedSource(handle: DbHandle): ElementId {
  const sources = new SourceRepository(handle.db);
  const { element } = sources.createWithDocument({
    title: "The Measure of Intelligence",
    priority: 0.625,
    status: "active",
    stage: "raw_source",
    body: "Intro paragraph one.\n\nThe definition paragraph two.\n\nA third paragraph.",
  });

  const elements = new ElementRepository(handle.db);
  elements.addTag(element.id, "literature");
  elements.addTag(element.id, "learning");
  return element.id;
}

function sourceBlocks(handle: DbHandle, sourceId: ElementId): BlockId[] {
  return new DocumentRepository(handle.db).listBlocks(sourceId).map((block) => block.stableBlockId as BlockId);
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("source → extract → card chain operation logs", () => {
  it("records consistent derived_from payloads and expected op types on every link", () => {
    const sourceId = seedSource(handle);
    const blocks = sourceBlocks(handle, sourceId);
    const extraction = new ExtractionService(handle.db);
    const { element: extract } = extraction.createExtraction({
      sourceElementId: sourceId,
      selectedText: "The definition paragraph two.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 29,
      priority: 0.625,
    });

    const cards = new CardService(handle.db);
    const { element: card } = cards.createFromExtract({
      extractId: extract.id,
      kind: "qa",
      prompt: "What is intelligence?",
      answer: "A long-lived behavioral trait.",
    });

    const opLog = new OperationLogRepository(handle.db);
    const extractOps = opLog.listForElement(extract.id);
    const cardOps = opLog.listForElement(card.id);

    const extractRelation = extractOps.find((op) => op.opType === "add_relation")?.payload;
    expect(extractRelation).toMatchObject({
      fromElementId: extract.id,
      toElementId: sourceId,
      relationType: "derived_from",
    });

    const cardRelation = cardOps.find((op) => op.opType === "add_relation")?.payload;
    expect(cardRelation).toMatchObject({
      fromElementId: card.id,
      toElementId: extract.id,
      relationType: "derived_from",
    });

    const cardTypes = cardOps.map((op) => op.opType);
    expect(cardTypes).toContain("create_element");
    expect(cardTypes).toContain("create_card");
    expect(cardTypes).toContain("add_tag");
    expect(cardTypes).toContain("update_element");
    expect(cardTypes).toContain("add_relation");
    expect(cardTypes).not.toContain("add_review_log");
    expect(cardTypes).not.toContain("reschedule_element");

    // Derived-from is written once per hop only.
    expect(handle.db
      .select()
      .from(operationLog)
      .where(and(eq(operationLog.elementId, extract.id), eq(operationLog.opType, "add_relation")))
      .all().length).toBe(1);
    expect(handle.db
      .select()
      .from(operationLog)
      .where(and(eq(operationLog.elementId, card.id), eq(operationLog.opType, "add_relation")))
      .all().length).toBe(1);

    // The same payload used in logs for the extract edge is mirrored by the edge row.
    const dbRelation = handle.db
      .select()
      .from(elementRelations)
      .where(
        and(
          eq(elementRelations.fromElementId, extract.id),
          eq(elementRelations.toElementId, sourceId),
          eq(elementRelations.relationType, "derived_from"),
        ),
      )
      .all();

    const reversedRelation = handle.db
      .select()
      .from(elementRelations)
      .where(
        and(
          eq(elementRelations.fromElementId, card.id),
          eq(elementRelations.toElementId, extract.id),
          eq(elementRelations.relationType, "derived_from"),
        ),
      )
      .all();

    expect(dbRelation).toHaveLength(1);
    expect(reversedRelation).toHaveLength(1);

    expect(dbRelation[0]).toMatchObject({
      fromElementId: extract.id,
      toElementId: sourceId,
      relationType: "derived_from",
    });
    expect(reversedRelation[0]).toMatchObject({
      fromElementId: card.id,
      toElementId: extract.id,
      relationType: "derived_from",
    });
  });
});
