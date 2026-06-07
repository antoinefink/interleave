import type {
  BlockId,
  ElementId,
  SourceBlockOutputType,
  SourceBlockProcessingAction,
  SourceBlockProcessingState,
} from "@interleave/core";
import {
  documentBlocks,
  documentMarks,
  elements,
  type InterleaveDatabase,
  readPoints,
  sourceBlockProcessing,
  sourceBlockProcessingOutputs,
  sourceLocations,
} from "@interleave/db";
import { and, eq, isNull } from "drizzle-orm";
import { newRowId, nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

export interface SourceBlockProcessingRow {
  readonly id: string;
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly state: SourceBlockProcessingState;
  readonly blockContentHash: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastAction: SourceBlockProcessingAction | null;
  readonly lastActionAt: string | null;
}

export interface UpsertBlockStateInput {
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly state: SourceBlockProcessingState;
  readonly action: SourceBlockProcessingAction;
  readonly blockContentHash?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export interface AddBlockOutputInput {
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly outputElementId: ElementId;
  readonly outputType: SourceBlockOutputType;
  readonly sourceLocationId?: string | null;
}

export interface LiveBlockOutput {
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly outputElementId: ElementId;
  readonly outputType: SourceBlockOutputType;
  readonly sourceLocationId: string | null;
}

function parseMetadata(raw: string | null): Readonly<Record<string, unknown>> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function rowToProcessing(row: typeof sourceBlockProcessing.$inferSelect): SourceBlockProcessingRow {
  return {
    id: row.id,
    sourceElementId: row.sourceElementId as ElementId,
    stableBlockId: row.stableBlockId as BlockId,
    state: row.state as SourceBlockProcessingState,
    blockContentHash: row.blockContentHash,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastAction: row.lastAction as SourceBlockProcessingAction | null,
    lastActionAt: row.lastActionAt,
  };
}

function outputTypeForElement(type: string): SourceBlockOutputType {
  return type === "card" ? "card" : "extract";
}

export class BlockProcessingRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  listRows(sourceElementId: ElementId): SourceBlockProcessingRow[] {
    return this.db
      .select()
      .from(sourceBlockProcessing)
      .where(eq(sourceBlockProcessing.sourceElementId, sourceElementId))
      .all()
      .map(rowToProcessing);
  }

  findRow(sourceElementId: ElementId, stableBlockId: BlockId): SourceBlockProcessingRow | null {
    const row = this.db
      .select()
      .from(sourceBlockProcessing)
      .where(
        and(
          eq(sourceBlockProcessing.sourceElementId, sourceElementId),
          eq(sourceBlockProcessing.stableBlockId, stableBlockId),
        ),
      )
      .get();
    return row ? rowToProcessing(row) : null;
  }

  upsertStateWithin(tx: DbClient, input: UpsertBlockStateInput): SourceBlockProcessingRow {
    const now = nowIso();
    const existing = tx
      .select()
      .from(sourceBlockProcessing)
      .where(
        and(
          eq(sourceBlockProcessing.sourceElementId, input.sourceElementId),
          eq(sourceBlockProcessing.stableBlockId, input.stableBlockId),
        ),
      )
      .get();
    const metadata = input.metadata == null ? null : JSON.stringify(input.metadata);
    if (existing) {
      tx.update(sourceBlockProcessing)
        .set({
          state: input.state,
          blockContentHash: input.blockContentHash ?? existing.blockContentHash,
          metadata,
          updatedAt: now,
          lastAction: input.action,
          lastActionAt: now,
        })
        .where(eq(sourceBlockProcessing.id, existing.id))
        .run();
    } else {
      tx.insert(sourceBlockProcessing)
        .values({
          id: newRowId(),
          sourceElementId: input.sourceElementId,
          stableBlockId: input.stableBlockId,
          state: input.state,
          blockContentHash: input.blockContentHash ?? null,
          metadata,
          createdAt: now,
          updatedAt: now,
          lastAction: input.action,
          lastActionAt: now,
        })
        .run();
    }

    new OperationLogRepository(tx).append(tx, {
      opType: "update_document",
      elementId: input.sourceElementId,
      payload: {
        blockProcessing: {
          action: input.action,
          stableBlockId: input.stableBlockId,
          state: input.state,
          prevState: existing?.state ?? null,
        },
      },
    });

    const row = tx
      .select()
      .from(sourceBlockProcessing)
      .where(
        and(
          eq(sourceBlockProcessing.sourceElementId, input.sourceElementId),
          eq(sourceBlockProcessing.stableBlockId, input.stableBlockId),
        ),
      )
      .get();
    if (!row) throw new Error("BlockProcessingRepository.upsertStateWithin: row was not written");
    return rowToProcessing(row);
  }

  addOutputWithin(tx: DbClient, input: AddBlockOutputInput): void {
    const existing = tx
      .select()
      .from(sourceBlockProcessingOutputs)
      .where(
        and(
          eq(sourceBlockProcessingOutputs.sourceElementId, input.sourceElementId),
          eq(sourceBlockProcessingOutputs.stableBlockId, input.stableBlockId),
          eq(sourceBlockProcessingOutputs.outputElementId, input.outputElementId),
        ),
      )
      .get();
    if (existing) return;
    tx.insert(sourceBlockProcessingOutputs)
      .values({
        id: newRowId(),
        sourceElementId: input.sourceElementId,
        stableBlockId: input.stableBlockId,
        outputElementId: input.outputElementId,
        outputType: input.outputType,
        sourceLocationId: input.sourceLocationId ?? null,
        createdAt: nowIso(),
      })
      .run();
  }

  listLiveOutputs(sourceElementId: ElementId): LiveBlockOutput[] {
    const linked = this.db
      .select({
        sourceElementId: sourceBlockProcessingOutputs.sourceElementId,
        stableBlockId: sourceBlockProcessingOutputs.stableBlockId,
        outputElementId: sourceBlockProcessingOutputs.outputElementId,
        outputType: sourceBlockProcessingOutputs.outputType,
        sourceLocationId: sourceBlockProcessingOutputs.sourceLocationId,
      })
      .from(sourceBlockProcessingOutputs)
      .innerJoin(elements, eq(elements.id, sourceBlockProcessingOutputs.outputElementId))
      .where(
        and(
          eq(sourceBlockProcessingOutputs.sourceElementId, sourceElementId),
          isNull(elements.deletedAt),
        ),
      )
      .all()
      .map((row) => ({
        sourceElementId: row.sourceElementId as ElementId,
        stableBlockId: row.stableBlockId as BlockId,
        outputElementId: row.outputElementId as ElementId,
        outputType: row.outputType as SourceBlockOutputType,
        sourceLocationId: row.sourceLocationId,
      }));

    const seen = new Set(linked.map((row) => `${row.stableBlockId}:${row.outputElementId}`));
    const locationRows = this.db
      .select({
        locationId: sourceLocations.id,
        elementId: sourceLocations.elementId,
        elementType: elements.type,
        blockIds: sourceLocations.blockIds,
      })
      .from(sourceLocations)
      .innerJoin(elements, eq(elements.id, sourceLocations.elementId))
      .where(and(eq(sourceLocations.sourceElementId, sourceElementId), isNull(elements.deletedAt)))
      .all();
    const derived: LiveBlockOutput[] = [];
    for (const row of locationRows) {
      let blockIds: string[] = [];
      try {
        blockIds = JSON.parse(row.blockIds) as string[];
      } catch {
        blockIds = [];
      }
      for (const blockId of blockIds) {
        const key = `${blockId}:${row.elementId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        derived.push({
          sourceElementId,
          stableBlockId: blockId as BlockId,
          outputElementId: row.elementId as ElementId,
          outputType: outputTypeForElement(row.elementType),
          sourceLocationId: row.locationId,
        });
      }
    }
    return [...linked, ...derived];
  }

  listExistingBlockIds(sourceElementId: ElementId): Set<BlockId> {
    return new Set(
      this.db
        .select({ stableBlockId: documentBlocks.stableBlockId })
        .from(documentBlocks)
        .where(eq(documentBlocks.documentId, sourceElementId))
        .all()
        .map((row) => row.stableBlockId as BlockId),
    );
  }

  legacyProcessedBlockIds(sourceElementId: ElementId): Set<BlockId> {
    const existing = this.listExistingBlockIds(sourceElementId);
    return new Set(
      this.db
        .select({ blockId: documentMarks.blockId })
        .from(documentMarks)
        .where(
          and(
            eq(documentMarks.documentId, sourceElementId),
            eq(documentMarks.markType, "processed_span"),
          ),
        )
        .all()
        .map((row) => row.blockId as BlockId)
        .filter((blockId) => existing.has(blockId)),
    );
  }

  getReadPointOrder(sourceElementId: ElementId): number | null {
    const rp = this.db
      .select({ blockId: readPoints.blockId })
      .from(readPoints)
      .where(eq(readPoints.elementId, sourceElementId))
      .get();
    if (!rp) return null;
    const block = this.db
      .select({ order: documentBlocks.order })
      .from(documentBlocks)
      .where(
        and(
          eq(documentBlocks.documentId, sourceElementId),
          eq(documentBlocks.stableBlockId, rp.blockId),
        ),
      )
      .get();
    return block?.order ?? null;
  }

  listSourceBlocks(sourceElementId: ElementId): { stableBlockId: BlockId; order: number }[] {
    return this.db
      .select({ stableBlockId: documentBlocks.stableBlockId, order: documentBlocks.order })
      .from(documentBlocks)
      .where(eq(documentBlocks.documentId, sourceElementId))
      .all()
      .sort((a, b) => a.order - b.order)
      .map((row) => ({ stableBlockId: row.stableBlockId as BlockId, order: row.order }));
  }

  sourcePriority(sourceElementId: ElementId): number | null {
    const row = this.db
      .select({ priority: elements.priority })
      .from(elements)
      .where(eq(elements.id, sourceElementId))
      .get();
    return row?.priority ?? null;
  }

  reconcileStaleWithin(
    tx: DbClient,
    sourceElementId: ElementId,
    blockHashes: ReadonlyMap<BlockId, string>,
  ): void {
    const rows = tx
      .select()
      .from(sourceBlockProcessing)
      .where(eq(sourceBlockProcessing.sourceElementId, sourceElementId))
      .all();
    for (const row of rows) {
      if (
        row.state !== "extracted" &&
        row.state !== "ignored" &&
        row.state !== "processed_without_output" &&
        row.state !== "needs_later"
      ) {
        continue;
      }
      const nextHash = blockHashes.get(row.stableBlockId as BlockId);
      if (nextHash && row.blockContentHash === nextHash) continue;
      if (nextHash && row.blockContentHash == null) {
        this.upsertStateWithin(tx, {
          sourceElementId,
          stableBlockId: row.stableBlockId as BlockId,
          state: row.state as SourceBlockProcessingState,
          action: "reconcile_document_blocks",
          blockContentHash: nextHash,
          metadata: {
            reason: "hydrated_missing_hash",
            previousState: row.state,
          },
        });
        continue;
      }
      this.upsertStateWithin(tx, {
        sourceElementId,
        stableBlockId: row.stableBlockId as BlockId,
        state: "stale_after_edit",
        action: "reconcile_document_blocks",
        blockContentHash: nextHash ?? row.blockContentHash,
        metadata: {
          reason: nextHash ? "content_changed" : "block_missing",
          previousState: row.state,
        },
      });
    }
  }
}
