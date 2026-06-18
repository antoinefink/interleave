import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog, sourceBlockProcessing } from "@interleave/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { ExtractionService } from "./extraction-service";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

function seedSource(): ElementId {
  const { element } = new SourceRepository(handle.db).createWithDocument({
    title: "A long article",
    priority: 0.875,
    status: "active",
    stage: "raw_source",
    body: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
  });
  return element.id;
}

function blocksOf(sourceId: ElementId): BlockId[] {
  return new DocumentRepository(handle.db)
    .listBlocks(sourceId)
    .map((block) => block.stableBlockId as BlockId);
}

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

describe("BlockProcessingService", () => {
  it("records explicit block outcomes and source summaries", () => {
    const sourceId = seedSource();
    const blocks = blocksOf(sourceId);
    const service = new BlockProcessingService(handle.db);

    expect(service.getSourceProcessingSummary(sourceId)).toMatchObject({
      totalBlocks: 3,
      processedBlocks: 0,
      unresolvedBlocks: 3,
    });

    const ignored = service.markBlockIgnored({
      sourceElementId: sourceId,
      stableBlockId: blocks[0] as BlockId,
    });
    expect(ignored.state).toBe("ignored");
    expect(ignored.blockContentHash).toBeTruthy();

    const later = service.markBlockNeedsLater({
      sourceElementId: sourceId,
      stableBlockId: blocks[1] as BlockId,
    });
    expect(later.state).toBe("needs_later");

    const summary = service.getSourceProcessingSummary(sourceId);
    expect(summary.processedBlocks).toBe(1);
    expect(summary.unresolvedBlocks).toBe(2);
    expect(summary.highPriorityUnresolvedBlocks).toBe(2);
    expect(summary.ignoredRatio).toBeCloseTo(1 / 3);

    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, sourceId))
      .all()
      .map((op) => JSON.parse(op.payload) as { blockProcessing?: unknown });
    expect(ops.some((op) => op.blockProcessing)).toBe(true);
  });

  it("derives extracted block state and output lineage from extraction", () => {
    const sourceId = seedSource();
    const blocks = blocksOf(sourceId);
    const extraction = new ExtractionService(handle.db);

    const { element } = extraction.createExtraction({
      sourceElementId: sourceId,
      selectedText: "Second paragraph.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 17,
      priority: 0.875,
    });

    const service = new BlockProcessingService(handle.db);
    const view = service.getBlockView(sourceId, blocks[1] as BlockId);
    expect(view.state).toBe("extracted");
    expect(view.outputElementIds).toContain(element.id);
    expect(service.getSourceProcessingSummary(sourceId)).toMatchObject({
      processedBlocks: 1,
      extractedBlockCount: 1,
      extractedOutputCount: 1,
    });
  });

  it("stops treating a block as extracted after its output is soft-deleted", () => {
    const sourceId = seedSource();
    const blocks = blocksOf(sourceId);
    const extraction = new ExtractionService(handle.db);
    const { element } = extraction.createExtraction({
      sourceElementId: sourceId,
      selectedText: "Second paragraph.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 17,
      priority: 0.875,
    });
    new ElementRepository(handle.db).softDelete(element.id);

    const service = new BlockProcessingService(handle.db);
    const view = service.getBlockView(sourceId, blocks[1] as BlockId);

    expect(view.state).toBe("unread");
    expect(view.outputElementIds).toEqual([]);
    expect(service.getSourceProcessingSummary(sourceId)).toMatchObject({
      processedBlocks: 0,
      extractedBlockCount: 0,
      extractedOutputCount: 0,
    });
  });

  it("rejects explicit state writes while live extracted output lineage exists", () => {
    const sourceId = seedSource();
    const blocks = blocksOf(sourceId);
    new ExtractionService(handle.db).createExtraction({
      sourceElementId: sourceId,
      selectedText: "Second paragraph.",
      blockIds: [blocks[1] as BlockId],
      startOffset: 0,
      endOffset: 17,
      priority: 0.875,
    });
    const service = new BlockProcessingService(handle.db);

    for (const write of [
      () =>
        service.markBlockIgnored({
          sourceElementId: sourceId,
          stableBlockId: blocks[1] as BlockId,
        }),
      () =>
        service.markBlockProcessed({
          sourceElementId: sourceId,
          stableBlockId: blocks[1] as BlockId,
        }),
      () =>
        service.markBlockNeedsLater({
          sourceElementId: sourceId,
          stableBlockId: blocks[1] as BlockId,
        }),
      () =>
        service.markBlockUnread({
          sourceElementId: sourceId,
          stableBlockId: blocks[1] as BlockId,
        }),
    ]) {
      expect(write).toThrow(/live extracted output lineage/);
    }
  });

  it("does not count new legacy processed_span marks as durable block progress", () => {
    const sourceId = seedSource();
    const blocks = blocksOf(sourceId);
    const documents = new DocumentRepository(handle.db);

    documents.addMark({
      elementId: sourceId,
      blockId: blocks[0] as BlockId,
      markType: "processed_span",
      range: [0, 1],
    });

    const service = new BlockProcessingService(handle.db);
    expect(service.getBlockView(sourceId, blocks[0] as BlockId)).toMatchObject({
      state: "unread",
      storedState: null,
      derivedFrom: "missing",
    });
    expect(service.getSourceProcessingSummary(sourceId)).toMatchObject({
      processedBlocks: 0,
      legacyProjectedBlocks: 0,
    });
    expect(handle.db.select().from(sourceBlockProcessing).all()).toHaveLength(0);
  });

  it("marks terminal outcomes stale after the source block text changes", () => {
    const sourceId = seedSource();
    const blocks = new DocumentRepository(handle.db).listBlocks(sourceId);
    const service = new BlockProcessingService(handle.db);

    service.markBlockProcessed({
      sourceElementId: sourceId,
      stableBlockId: blocks[0]?.stableBlockId as BlockId,
    });

    const nextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: blocks[0]?.stableBlockId },
          content: [{ type: "text", text: "First paragraph, edited." }],
        },
        {
          type: "paragraph",
          attrs: { blockId: blocks[1]?.stableBlockId },
          content: [{ type: "text", text: "Second paragraph." }],
        },
        {
          type: "paragraph",
          attrs: { blockId: blocks[2]?.stableBlockId },
          content: [{ type: "text", text: "Third paragraph." }],
        },
      ],
    };

    handle.db.transaction((tx) => {
      new DocumentRepository(handle.db).upsertWithin(tx, {
        elementId: sourceId,
        prosemirrorJson: nextDoc,
        plainText: "First paragraph, edited.\n\nSecond paragraph.\n\nThird paragraph.",
        blocks: blocks.map((block) => ({
          blockType: block.blockType,
          order: block.order,
          stableBlockId: block.stableBlockId as BlockId,
        })),
      });
      service.reconcileSourceDocumentWithin(tx, sourceId, nextDoc);
    });

    expect(service.getBlockView(sourceId, blocks[0]?.stableBlockId as BlockId).state).toBe(
      "stale_after_edit",
    );
    expect(service.getSourceProcessingSummary(sourceId).staleAfterEditBlocks).toBe(1);
  });

  it("hydrates missing legacy hashes instead of marking unchanged blocks stale", () => {
    const sourceId = seedSource();
    const blocks = new DocumentRepository(handle.db).listBlocks(sourceId);
    const service = new BlockProcessingService(handle.db);

    service.markBlockProcessed({
      sourceElementId: sourceId,
      stableBlockId: blocks[0]?.stableBlockId as BlockId,
    });
    handle.db
      .update(sourceBlockProcessing)
      .set({ blockContentHash: null })
      .where(
        and(
          eq(sourceBlockProcessing.sourceElementId, sourceId),
          eq(sourceBlockProcessing.stableBlockId, blocks[0]?.stableBlockId ?? ""),
        ),
      )
      .run();

    const sameDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: blocks[0]?.stableBlockId },
          content: [{ type: "text", text: "First paragraph." }],
        },
        {
          type: "paragraph",
          attrs: { blockId: blocks[1]?.stableBlockId },
          content: [{ type: "text", text: "Second paragraph." }],
        },
        {
          type: "paragraph",
          attrs: { blockId: blocks[2]?.stableBlockId },
          content: [{ type: "text", text: "Third paragraph." }],
        },
      ],
    };

    handle.db.transaction((tx) => {
      service.reconcileSourceDocumentWithin(tx, sourceId, sameDoc);
    });

    const view = service.getBlockView(sourceId, blocks[0]?.stableBlockId as BlockId);
    expect(view.state).toBe("processed_without_output");
    expect(view.blockContentHash).toBeTruthy();
    expect(service.getSourceProcessingSummary(sourceId).staleAfterEditBlocks).toBe(0);
  });

  it("keeps missing stale-after-edit rows in summaries and done gating", () => {
    const sourceId = seedSource();
    const blocks = new DocumentRepository(handle.db).listBlocks(sourceId);
    const service = new BlockProcessingService(handle.db);

    service.markBlockProcessed({
      sourceElementId: sourceId,
      stableBlockId: blocks[0]?.stableBlockId as BlockId,
    });

    const nextDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { blockId: blocks[1]?.stableBlockId },
          content: [{ type: "text", text: "Second paragraph." }],
        },
        {
          type: "paragraph",
          attrs: { blockId: blocks[2]?.stableBlockId },
          content: [{ type: "text", text: "Third paragraph." }],
        },
      ],
    };

    handle.db.transaction((tx) => {
      new DocumentRepository(handle.db).upsertWithin(tx, {
        elementId: sourceId,
        prosemirrorJson: nextDoc,
        plainText: "Second paragraph.\n\nThird paragraph.",
        blocks: blocks.slice(1).map((block, index) => ({
          blockType: block.blockType,
          order: index,
          stableBlockId: block.stableBlockId as BlockId,
        })),
      });
      service.reconcileSourceDocumentWithin(tx, sourceId, nextDoc);
    });

    const views = service.listBlockViews(sourceId);
    const stale = views.find((view) => view.stableBlockId === blocks[0]?.stableBlockId);
    expect(stale?.state).toBe("stale_after_edit");
    expect(service.getSourceProcessingSummary(sourceId)).toMatchObject({
      totalBlocks: 3,
      staleAfterEditBlocks: 1,
      unresolvedBlocks: 3,
      canMarkDoneWithoutConfirmation: false,
    });
    expect(service.getDoneGate(sourceId)).toMatchObject({
      canMarkDone: false,
      staleAfterEditBlocks: 1,
    });
  });

  it("rejects non-source elements at the block-processing boundary", () => {
    const topic = new ElementRepository(handle.db).create({
      type: "topic",
      status: "active",
      stage: "rough_topic",
      priority: 0.5,
      title: "Not a source",
    });
    const service = new BlockProcessingService(handle.db);

    expect(() => service.getSourceProcessingSummary(topic.id)).toThrow(/source .* not found/);
  });

  describe("batched read projections (U10)", () => {
    it("listBlockViewsForMany matches per-source listBlockViews for each source", () => {
      const s1 = seedSource();
      const s2 = seedSource();
      const service = new BlockProcessingService(handle.db);
      const b1 = blocksOf(s1);
      service.markBlockIgnored({ sourceElementId: s1, stableBlockId: b1[0] as BlockId });
      service.markBlockProcessed({ sourceElementId: s1, stableBlockId: b1[1] as BlockId });
      // s2 left in its default (unread) state.

      const map = service.listBlockViewsForMany([s1, s2]);
      expect(map.get(s1)).toEqual(service.listBlockViews(s1));
      expect(map.get(s2)).toEqual(service.listBlockViews(s2));
    });

    it("getSourceProcessingSummaryForMany matches per-source summaries", () => {
      const s1 = seedSource();
      const s2 = seedSource();
      const service = new BlockProcessingService(handle.db);
      service.markBlockIgnored({ sourceElementId: s1, stableBlockId: blocksOf(s1)[0] as BlockId });

      const map = service.getSourceProcessingSummaryForMany([s1, s2]);
      expect(map.get(s1)).toEqual(service.getSourceProcessingSummary(s1));
      expect(map.get(s2)).toEqual(service.getSourceProcessingSummary(s2));
    });

    it("chunk-boundary parity: > one IN-chunk worth of sources matches per-source (no SQLite var-limit crash)", () => {
      // SQLITE_SAFE_IN_ARRAY_SIZE is 900; 905 source ids forces a multi-chunk
      // batched scan. Cheap fixture: 2 real sources (with documents/processing
      // state, one straddling the boundary) plus many bare source elements that
      // just inflate the id list past the chunk boundary.
      const repo = new ElementRepository(handle.db);
      const service = new BlockProcessingService(handle.db);

      const real1 = seedSource();
      service.markBlockIgnored({
        sourceElementId: real1,
        stableBlockId: blocksOf(real1)[0] as BlockId,
      });

      const ids: ElementId[] = [real1];
      for (let i = 0; i < 903; i++) {
        ids.push(
          repo.create({
            type: "source",
            status: "active",
            stage: "raw_source",
            priority: 0.5,
            title: `bare-${i}`,
          }).id,
        );
      }
      // A real source whose id lands in the SECOND chunk (index >= 900).
      const real2 = seedSource();
      service.markBlockProcessed({
        sourceElementId: real2,
        stableBlockId: blocksOf(real2)[1] as BlockId,
      });
      ids.push(real2);
      expect(ids.length).toBe(905);

      const summaries = service.getSourceProcessingSummaryForMany(ids);
      const views = service.listBlockViewsForMany(ids);

      // Byte-identical to the per-source path for the two real sources across the
      // chunk boundary; bare sources resolve to a zero/empty projection.
      expect(summaries.get(real1)).toEqual(service.getSourceProcessingSummary(real1));
      expect(summaries.get(real2)).toEqual(service.getSourceProcessingSummary(real2));
      expect(views.get(real1)).toEqual(service.listBlockViews(real1));
      expect(views.get(real2)).toEqual(service.listBlockViews(real2));
      // Every id resolved without throwing (a bare source yields a zero summary).
      expect(summaries.get(real2)?.processedBlocks).toBe(1);
      expect(summaries.get(ids[10] as ElementId)?.totalBlocks).toBe(0);
    });

    it("tolerates a stale/missing id (zero summary, no throw) and guards the empty id list", () => {
      const live = seedSource();
      const service = new BlockProcessingService(handle.db);
      const stale = "ghost" as ElementId;

      // The single-source path throws on the stale id; the batched path does not.
      expect(() => service.getSourceProcessingSummary(stale)).toThrow(/source .* not found/);
      const map = service.getSourceProcessingSummaryForMany([live, stale]);
      expect(map.get(stale)?.totalBlocks).toBe(0);
      expect(map.get(stale)?.terminalRatio).toBe(1);
      expect(map.get(live)).toEqual(service.getSourceProcessingSummary(live));

      // Empty id list → empty maps, never an `IN ()` SQLite error.
      expect(() => service.listBlockViewsForMany([])).not.toThrow();
      expect(service.listBlockViewsForMany([]).size).toBe(0);
      expect(service.getSourceProcessingSummaryForMany([]).size).toBe(0);
    });
  });
});
