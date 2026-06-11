import type { BlockId, ElementId } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { operationLog } from "@interleave/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockProcessingService } from "./block-processing-service";
import { DocumentRepository } from "./document-repository";
import { createRepositories, type Repositories } from "./index";
import type { RetirementSuggestionRepository } from "./retirement-suggestion-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let repos: Repositories;
let retirement: RetirementSuggestionRepository;

function seedSource(): { readonly sourceId: ElementId; readonly blocks: readonly BlockId[] } {
  const { element } = new SourceRepository(handle.db).createWithDocument({
    title: "Dead-end article",
    priority: 0.5,
    status: "active",
    stage: "raw_source",
    body: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\nFourth paragraph.",
  });
  const blocks = new DocumentRepository(handle.db)
    .listBlocks(element.id)
    .map((block) => block.stableBlockId as BlockId);
  return { sourceId: element.id, blocks };
}

function makeRetirable(sourceId: ElementId, blocks: readonly BlockId[]): void {
  expect(blocks).toHaveLength(4);
  const [first, second, third, fourth] = blocks as readonly [BlockId, BlockId, BlockId, BlockId];
  const blockProcessing = new BlockProcessingService(handle.db);
  blockProcessing.markBlockIgnored({ sourceElementId: sourceId, stableBlockId: first });
  blockProcessing.markBlockIgnored({ sourceElementId: sourceId, stableBlockId: second });
  blockProcessing.markBlockIgnored({ sourceElementId: sourceId, stableBlockId: third });
  blockProcessing.markBlockProcessed({ sourceElementId: sourceId, stableBlockId: fourth });
}

beforeEach(() => {
  handle = createInMemoryDb();
  repos = createRepositories(handle.db);
  retirement = repos.retirementSuggestions;
});

afterEach(() => {
  handle.sqlite.close();
});

describe("RetirementSuggestionRepository", () => {
  it("returns a visible abandon suggestion for a terminal ignored source with no outputs", () => {
    const { sourceId, blocks } = seedSource();
    makeRetirable(sourceId, blocks);

    expect(retirement.visibleForSource(sourceId)).toMatchObject({
      kind: "abandon",
      totalBlocks: 4,
      terminalBlocks: 4,
      ignoredBlocks: 3,
      unresolvedBlocks: 0,
      extractedOutputCount: 0,
    });
  });

  it("dismisses only the current signal hash and logs an update_element marker", () => {
    const { sourceId, blocks } = seedSource();
    makeRetirable(sourceId, blocks);
    const suggestion = retirement.visibleForSource(sourceId);
    expect(suggestion).not.toBeNull();

    const result = retirement.dismiss(sourceId, suggestion?.signalHash ?? "");

    expect(result).toEqual({ dismissed: true, suggestion: null, stale: false });
    expect(retirement.visibleForSource(sourceId)).toBeNull();

    const ops = handle.db
      .select()
      .from(operationLog)
      .where(eq(operationLog.elementId, sourceId))
      .all()
      .map((op) => ({ ...op, payload: JSON.parse(op.payload) as unknown }));
    expect(ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          opType: "update_element",
          payload: expect.objectContaining({
            retirementSuggestionDismissed: {
              kind: "abandon",
              signalHash: suggestion?.signalHash,
            },
          }),
        }),
      ]),
    );
  });

  it("treats a stale dismissal hash as non-mutating and re-surfaces after signal changes", () => {
    const { sourceId, blocks } = seedSource();
    makeRetirable(sourceId, blocks);
    const suggestion = retirement.visibleForSource(sourceId);
    expect(suggestion).not.toBeNull();
    expect(retirement.dismiss(sourceId, suggestion?.signalHash ?? "").dismissed).toBe(true);

    new BlockProcessingService(handle.db).markBlockIgnored({
      sourceElementId: sourceId,
      stableBlockId: (blocks as readonly [BlockId, BlockId, BlockId, BlockId])[3],
    });

    const changed = retirement.visibleForSource(sourceId);
    expect(changed).not.toBeNull();
    expect(changed?.signalHash).not.toBe(suggestion?.signalHash);

    const opCountBefore = handle.db.select().from(operationLog).all().length;
    const stale = retirement.dismiss(sourceId, suggestion?.signalHash ?? "");
    const opCountAfter = handle.db.select().from(operationLog).all().length;

    expect(stale).toMatchObject({ dismissed: false, stale: true });
    expect(stale.suggestion?.signalHash).toBe(changed?.signalHash);
    expect(opCountAfter).toBe(opCountBefore);
  });

  it("returns null for deleted and non-source elements", () => {
    const { sourceId, blocks } = seedSource();
    makeRetirable(sourceId, blocks);
    repos.elements.softDelete(sourceId);

    const task = repos.elements.create({
      type: "task",
      status: "active",
      stage: "raw_source",
      priority: 0.5,
      title: "Not a source",
    });

    expect(retirement.rawForSource(sourceId)).toBeNull();
    expect(retirement.visibleForSource(task.id)).toBeNull();
  });
});
