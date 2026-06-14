/**
 * T124 U2 — ReverifyResolutionRepository.
 *
 * Drives the resolution primitives every verb shares: clear provenance by the exact
 * `(element, source, block)` triple and recompute the self-healing flag; freeze a
 * detach snapshot that tombstones the live anchor; restore (undo) by re-inserting
 * provenance + dropping the snapshot + recomputing. The seed mirrors the T123 test:
 * a source → extract (anchored to block[1]) → card lineage, staled through the real
 * `BlockProcessingService.reconcileSourceDocumentWithin` entry point so the provenance
 * rows are produced exactly as production writes them.
 */

import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import {
  documents,
  elementDetachSnapshot,
  elementReverifyProvenance,
  elements,
  operationLog,
} from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { CardService } from "./card-service";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractionService } from "./extraction-service";
import { ReverifyPropagationRepository } from "./reverify-propagation-repository";
import { ReverifyResolutionRepository } from "./reverify-resolution-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

interface Lineage {
  readonly sourceId: ElementId;
  readonly extractId: ElementId;
  readonly cardId: ElementId;
  readonly blocks: BlockId[];
  readonly extractedBlock: BlockId;
}

/** Seed source → extract (anchored to block[1]) → card (parentId = extract). */
function seedLineage(): Lineage {
  const { element: source } = new SourceRepository(handle.db).createWithDocument({
    title: "A long article",
    priority: 0.875,
    status: "active",
    stage: "raw_source",
    body: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
  });
  const sourceId = source.id;
  const blocks = new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((b) => b.stableBlockId as BlockId);
  const extractedBlock = blocks[1] as BlockId;

  const { element: extract } = new ExtractionService(handle.db).createExtraction({
    sourceElementId: sourceId,
    selectedText: "Second paragraph.",
    blockIds: [extractedBlock],
    startOffset: 0,
    endOffset: 17,
    priority: 0.875,
  });
  const { element: card } = new CardService(handle.db).createFromExtract({
    extractId: extract.id,
    kind: "qa",
    prompt: "What is in the second paragraph?",
    answer: "Second paragraph.",
  });

  return { sourceId, extractId: extract.id, cardId: card.id, blocks, extractedBlock };
}

function storedDoc(sourceId: ElementId): unknown {
  const row = handle.db
    .select({ json: documents.prosemirrorJson })
    .from(documents)
    .where(eq(documents.elementId, sourceId))
    .get();
  if (!row) throw new Error("no document");
  return JSON.parse(row.json);
}

/** A deep-cloned copy of the document with one block's text replaced. */
function editBlockText(doc: unknown, blockId: BlockId, newText: string): unknown {
  const clone = JSON.parse(JSON.stringify(doc)) as { content?: unknown[] };
  const visit = (node: { attrs?: { blockId?: unknown }; content?: unknown[] }): void => {
    if (node?.attrs?.blockId === blockId) {
      node.content = [{ type: "text", text: newText }];
      return;
    }
    for (const child of node?.content ?? []) visit(child as never);
  };
  visit(clone as never);
  return clone;
}

function reconcile(service: BlockProcessingService, sourceId: ElementId, doc: unknown): void {
  handle.db.transaction((tx) => {
    service.reconcileSourceDocumentWithin(tx, sourceId, doc);
  });
}

/** Stale `extractedBlock` so the extract + card are flagged with provenance. */
function staleLineage(lineage: Lineage): void {
  const service = new BlockProcessingService(handle.db);
  reconcile(
    service,
    lineage.sourceId,
    editBlockText(storedDoc(lineage.sourceId), lineage.extractedBlock, "Heavily rewritten."),
  );
}

function needsReverify(id: ElementId): boolean {
  const row = handle.db
    .select({ needsReverify: elements.needsReverify })
    .from(elements)
    .where(eq(elements.id, id))
    .get();
  return row?.needsReverify === true;
}

function provenanceCount(elementId: ElementId): number {
  return handle.db
    .select()
    .from(elementReverifyProvenance)
    .where(eq(elementReverifyProvenance.elementId, elementId))
    .all().length;
}

function detachSnapshotRows(elementId: ElementId) {
  return handle.db
    .select()
    .from(elementDetachSnapshot)
    .where(eq(elementDetachSnapshot.elementId, elementId))
    .all();
}

interface ResolutionOp {
  readonly elementId: ElementId | null;
  readonly payload: {
    readonly reverifyResolution?: { verb?: string };
    readonly prevProvenance?: unknown[];
    readonly detachSnapshotId?: string;
    readonly batchId?: string;
  };
}

/** All `reverifyResolution`-marked ops for an element, newest first. */
function resolutionOps(elementId: ElementId): ResolutionOp[] {
  return handle.db
    .select()
    .from(operationLog)
    .where(eq(operationLog.elementId, elementId))
    .all()
    .map((op) => ({
      elementId: op.elementId as ElementId | null,
      payload: JSON.parse(op.payload) as ResolutionOp["payload"],
    }))
    .filter((op) => op.payload.reverifyResolution !== undefined);
}

function repo(): ReverifyResolutionRepository {
  return new ReverifyResolutionRepository(handle.db);
}

/** Index `[0]` under `noUncheckedIndexedAccess`, asserting the row exists. */
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("expected at least one row");
  return row;
}

describe("ReverifyResolutionRepository — provenance clear + detach tombstone", () => {
  it("confirm-clear removes the provenance row, clears the flag, appends one resolution op", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    expect(needsReverify(lineage.extractId)).toBe(true);
    expect(provenanceCount(lineage.extractId)).toBe(1);

    handle.db.transaction((tx) => {
      repo().clearProvenanceWithin(tx, {
        elementId: lineage.extractId,
        sourceElementId: lineage.sourceId,
        stableBlockId: lineage.extractedBlock,
        batchId: "confirm-batch",
        verb: "confirm",
      });
    });

    expect(provenanceCount(lineage.extractId)).toBe(0);
    expect(needsReverify(lineage.extractId)).toBe(false);

    const ops = resolutionOps(lineage.extractId);
    expect(ops).toHaveLength(1);
    const op = first(ops);
    expect(op.payload.reverifyResolution?.verb).toBe("confirm");
    expect(op.payload.batchId).toBe("confirm-batch");
    // The op carries the full preimage of the deleted row.
    expect(op.payload.prevProvenance).toHaveLength(1);
    expect(op.payload.detachSnapshotId).toBeUndefined();
  });

  it("multi-block self-heal — clearing one triple leaves the flag set while another flags it", () => {
    // Extract spanning two blocks; edit both, then clear only one triple.
    const { element: source } = new SourceRepository(handle.db).createWithDocument({
      title: "Two-block source",
      priority: 0.5,
      status: "active",
      stage: "raw_source",
      body: "Alpha block.\n\nBeta block.",
    });
    const sourceId = source.id;
    const blocks = new DocumentRepository(handle.db)
      .listBlocks(sourceId)
      .map((b) => b.stableBlockId as BlockId);
    const { element: extract } = new ExtractionService(handle.db).createExtraction({
      sourceElementId: sourceId,
      selectedText: "Alpha block. Beta block.",
      blockIds: [blocks[0] as BlockId, blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 12,
      priority: 0.5,
    });
    const service = new BlockProcessingService(handle.db);
    let edited = editBlockText(storedDoc(sourceId), blocks[0] as BlockId, "Alpha edited.");
    edited = editBlockText(edited, blocks[1] as BlockId, "Beta edited.");
    reconcile(service, sourceId, edited);
    expect(provenanceCount(extract.id)).toBe(2);
    expect(needsReverify(extract.id)).toBe(true);

    handle.db.transaction((tx) => {
      repo().clearProvenanceWithin(tx, {
        elementId: extract.id,
        sourceElementId: sourceId,
        stableBlockId: blocks[0] as BlockId,
        batchId: "confirm-batch",
        verb: "confirm",
      });
    });

    // The other block's provenance remains → flag stays true (projection, not flip).
    expect(provenanceCount(extract.id)).toBe(1);
    expect(needsReverify(extract.id)).toBe(true);
  });

  it("soft-deleted target — clear still removes the provenance row by triple", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    expect(provenanceCount(lineage.cardId)).toBe(1);

    // Soft-delete the flagged card (FK cascade fires only on HARD purge → row survives).
    new ElementRepository(handle.db).softDelete(lineage.cardId);
    expect(provenanceCount(lineage.cardId)).toBe(1);

    handle.db.transaction((tx) => {
      repo().clearProvenanceWithin(tx, {
        elementId: lineage.cardId,
        sourceElementId: lineage.sourceId,
        stableBlockId: lineage.extractedBlock,
        batchId: "confirm-batch",
        verb: "confirm",
      });
    });

    // The clear does NOT filter on deletedAt, so the soft-deleted row is removed.
    expect(provenanceCount(lineage.cardId)).toBe(0);
  });

  it("detach writes a snapshot, deletes provenance, clears the flag, and the op carries the snapshot id", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    expect(needsReverify(lineage.extractId)).toBe(true);

    let snapshotId = "";
    handle.db.transaction((tx) => {
      snapshotId = repo().detachWithin(
        tx,
        {
          elementId: lineage.extractId,
          sourceElementId: lineage.sourceId,
          stableBlockId: lineage.extractedBlock,
          snapshot: {
            elementId: lineage.extractId,
            sourceElementId: lineage.sourceId,
            stableBlockId: lineage.extractedBlock,
            selectedText: "Second paragraph.",
            blockIds: JSON.stringify([lineage.extractedBlock]),
            startOffset: 0,
            endOffset: 17,
            preStaleHash: "deadbeef",
          },
        },
        "detach-batch",
      );
    });

    expect(provenanceCount(lineage.extractId)).toBe(0);
    expect(needsReverify(lineage.extractId)).toBe(false);
    const snapshots = detachSnapshotRows(lineage.extractId);
    expect(snapshots).toHaveLength(1);
    const snapshot = first(snapshots);
    expect(snapshot.id).toBe(snapshotId);
    expect(snapshot.selectedText).toBe("Second paragraph.");
    expect(snapshot.preStaleHash).toBe("deadbeef");

    const ops = resolutionOps(lineage.extractId);
    expect(ops).toHaveLength(1);
    const op = first(ops);
    expect(op.payload.reverifyResolution?.verb).toBe("detach");
    expect(op.payload.detachSnapshotId).toBe(snapshotId);
    expect(op.payload.prevProvenance).toHaveLength(1);
  });

  it("detach tombstone — a re-stale of the same block does NOT re-flag the detached element", () => {
    const lineage = seedLineage();
    staleLineage(lineage);

    // Detach the extract (its card too, so neither can be re-anchored).
    handle.db.transaction((tx) => {
      for (const id of [lineage.extractId, lineage.cardId]) {
        repo().detachWithin(
          tx,
          {
            elementId: id,
            sourceElementId: lineage.sourceId,
            stableBlockId: lineage.extractedBlock,
            snapshot: {
              elementId: id,
              sourceElementId: lineage.sourceId,
              stableBlockId: lineage.extractedBlock,
              selectedText: "Second paragraph.",
              blockIds: JSON.stringify([lineage.extractedBlock]),
              startOffset: null,
              endOffset: null,
              preStaleHash: null,
            },
          },
          "detach-batch",
        );
      }
    });
    expect(needsReverify(lineage.extractId)).toBe(false);

    // Re-run the propagation walk staling the same block again.
    const prop = new ReverifyPropagationRepository(handle.db);
    handle.db.transaction((tx) => {
      prop.propagateReverify(
        tx,
        lineage.sourceId,
        { staled: [lineage.extractedBlock], unStaled: [] },
        "re-stale-batch",
      );
    });

    // The tombstone excludes the detached tuple from liveAnchorsByBlock → no re-flag.
    expect(provenanceCount(lineage.extractId)).toBe(0);
    expect(needsReverify(lineage.extractId)).toBe(false);
  });

  it("restoreResolutionWithin (confirm) re-inserts identical provenance and recomputes flag true", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const before = handle.db
      .select()
      .from(elementReverifyProvenance)
      .where(eq(elementReverifyProvenance.elementId, lineage.extractId))
      .all();

    handle.db.transaction((tx) => {
      repo().clearProvenanceWithin(tx, {
        elementId: lineage.extractId,
        sourceElementId: lineage.sourceId,
        stableBlockId: lineage.extractedBlock,
        batchId: "confirm-batch",
        verb: "confirm",
      });
    });
    expect(needsReverify(lineage.extractId)).toBe(false);

    const op = first(resolutionOps(lineage.extractId));
    handle.db.transaction((tx) => {
      repo().restoreResolutionWithin(tx, { elementId: lineage.extractId, payload: op.payload });
    });

    const after = handle.db
      .select()
      .from(elementReverifyProvenance)
      .where(eq(elementReverifyProvenance.elementId, lineage.extractId))
      .all();
    expect(after).toEqual(before); // byte-identical rows (id/createdAt preserved)
    expect(needsReverify(lineage.extractId)).toBe(true);
  });

  it("restoreResolutionWithin (detach) drops the snapshot, re-inserts provenance, flag true; tombstone lifted", () => {
    const lineage = seedLineage();
    staleLineage(lineage);

    handle.db.transaction((tx) => {
      repo().detachWithin(
        tx,
        {
          elementId: lineage.extractId,
          sourceElementId: lineage.sourceId,
          stableBlockId: lineage.extractedBlock,
          snapshot: {
            elementId: lineage.extractId,
            sourceElementId: lineage.sourceId,
            stableBlockId: lineage.extractedBlock,
            selectedText: "Second paragraph.",
            blockIds: JSON.stringify([lineage.extractedBlock]),
            startOffset: null,
            endOffset: null,
            preStaleHash: null,
          },
        },
        "detach-batch",
      );
    });
    expect(detachSnapshotRows(lineage.extractId)).toHaveLength(1);

    const op = first(resolutionOps(lineage.extractId));
    handle.db.transaction((tx) => {
      repo().restoreResolutionWithin(tx, { elementId: lineage.extractId, payload: op.payload });
    });

    expect(detachSnapshotRows(lineage.extractId)).toHaveLength(0);
    expect(provenanceCount(lineage.extractId)).toBe(1);
    expect(needsReverify(lineage.extractId)).toBe(true);

    // Tombstone is lifted — a fresh re-stale now re-flags the (no-longer-detached) element.
    const prop = new ReverifyPropagationRepository(handle.db);
    handle.db.transaction((tx) => {
      // Clear the existing provenance first so we can observe a fresh insert.
      tx.delete(elementReverifyProvenance)
        .where(eq(elementReverifyProvenance.elementId, lineage.extractId))
        .run();
      prop.recomputeFlagWithin(tx, lineage.extractId, "settle");
    });
    expect(needsReverify(lineage.extractId)).toBe(false);
    handle.db.transaction((tx) => {
      prop.propagateReverify(
        tx,
        lineage.sourceId,
        { staled: [lineage.extractedBlock], unStaled: [] },
        "re-stale-batch",
      );
    });
    expect(provenanceCount(lineage.extractId)).toBe(1);
    expect(needsReverify(lineage.extractId)).toBe(true);
  });

  it("listFlaggedBySourceWithin returns live flaggable elements grouped by element with their blocks", () => {
    const lineage = seedLineage();
    staleLineage(lineage);

    const flagged = handle.db.transaction((tx) =>
      repo().listFlaggedBySourceWithin(tx, lineage.sourceId),
    );

    // Both the extract and the card are flagged (single block).
    const byId = new Map(flagged.map((r) => [r.elementId, r]));
    expect(byId.size).toBe(2);
    expect(byId.get(lineage.extractId)?.type).toBe("extract");
    expect(byId.get(lineage.extractId)?.blocks).toEqual([lineage.extractedBlock]);
    expect(byId.get(lineage.cardId)?.type).toBe("card");

    // Soft-deleting the card excludes it from the list.
    new ElementRepository(handle.db).softDelete(lineage.cardId);
    const afterDelete = handle.db.transaction((tx) =>
      repo().listFlaggedBySourceWithin(tx, lineage.sourceId),
    );
    expect(afterDelete.map((r) => r.elementId)).toEqual([lineage.extractId]);
  });

  it("rolls back the clear atomically when the surrounding transaction throws", () => {
    const lineage = seedLineage();
    staleLineage(lineage);
    const opsBefore = handle.db.select().from(operationLog).all().length;

    expect(() =>
      handle.db.transaction((tx) => {
        repo().clearProvenanceWithin(tx, {
          elementId: lineage.extractId,
          sourceElementId: lineage.sourceId,
          stableBlockId: lineage.extractedBlock,
          batchId: "confirm-batch",
          verb: "confirm",
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // Provenance, flag, and op-log are untouched after rollback.
    expect(provenanceCount(lineage.extractId)).toBe(1);
    expect(needsReverify(lineage.extractId)).toBe(true);
    expect(handle.db.select().from(operationLog).all().length).toBe(opsBefore);
  });
});
