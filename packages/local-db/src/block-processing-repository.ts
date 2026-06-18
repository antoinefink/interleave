import type {
  BlockId,
  ElementId,
  SourceBlockOutputType,
  SourceBlockProcessingAction,
  SourceBlockProcessingState,
  SourceBlockReconcileReport,
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
import { and, eq, inArray, isNull } from "drizzle-orm";
import { chunkIds } from "./chunk-in-array";
import { newRowId, nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/**
 * The processed states a block can hold before going `stale_after_edit` (T123) — the
 * states the reconcile stale-arm acts on, and the only states the un-stale arm will
 * auto-restore a block to. Shared so the stale skip-guard and `restorableStateFromMetadata`
 * cannot drift if the state set ever changes.
 */
const RESTORABLE_PROCESSED_STATES: ReadonlySet<SourceBlockProcessingState> = new Set([
  "extracted",
  "ignored",
  "processed_without_output",
  "needs_later",
]);

export interface SourceBlockProcessingRow {
  readonly id: string;
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly state: SourceBlockProcessingState;
  readonly blockContentHash: string | null;
  /** T123 — last-processed hash captured while `stale_after_edit`; `null` otherwise. */
  readonly preStaleHash: string | null;
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
  /**
   * T123 — explicit pre-stale-hash write (only meaningful when `state` is
   * `stale_after_edit`; ignored/cleared for any other state). When `undefined`, the
   * existing value is preserved on a stale row.
   */
  readonly preStaleHash?: string | null;
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
    preStaleHash: row.preStaleHash,
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
    // T123 — `pre_stale_hash` is only meaningful while a row is `stale_after_edit`
    // (it records the last-processed hash so restoration is recognizable). Any
    // transition to a non-stale state clears it; entering/staying stale writes the
    // explicit value when given, else preserves the existing capture (capture-once).
    const preStaleHash =
      input.state === "stale_after_edit"
        ? input.preStaleHash !== undefined
          ? input.preStaleHash
          : (existing?.preStaleHash ?? null)
        : null;
    if (existing) {
      tx.update(sourceBlockProcessing)
        .set({
          state: input.state,
          blockContentHash: input.blockContentHash ?? existing.blockContentHash,
          preStaleHash,
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
          preStaleHash,
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

  // --- Batched variants (perf U10) -----------------------------------------
  // Each mirrors the per-source read above but over `IN (sourceIds)`, returning a
  // `Map<ElementId, …>` for the same per-source assembly. Every method guards the
  // empty id list (drizzle emits `IN ()` → a SQLite syntax error otherwise) and an
  // id absent from the result is treated identically to the single-source path
  // returning empty/null. These are read-only and carry no liveness guard — the
  // caller scopes `sourceIds` to the already-fetched live-source set (U10
  // stale-source safety: a strict `requireSourceElement` would crash the whole call).

  listRowsForMany(sourceIds: readonly ElementId[]): Map<ElementId, SourceBlockProcessingRow[]> {
    const out = new Map<ElementId, SourceBlockProcessingRow[]>();
    if (sourceIds.length === 0) return out;
    // Chunk the IN (...) list so an unbounded source set stays under SQLite's
    // variable limit; per-source accumulation is order-independent across chunks.
    for (const chunk of chunkIds(sourceIds as ElementId[])) {
      const rows = this.db
        .select()
        .from(sourceBlockProcessing)
        .where(inArray(sourceBlockProcessing.sourceElementId, chunk))
        .all();
      for (const raw of rows) {
        const row = rowToProcessing(raw);
        const list = out.get(row.sourceElementId) ?? [];
        list.push(row);
        out.set(row.sourceElementId, list);
      }
    }
    return out;
  }

  listSourceBlocksForMany(
    sourceIds: readonly ElementId[],
  ): Map<ElementId, { stableBlockId: BlockId; order: number }[]> {
    const out = new Map<ElementId, { stableBlockId: BlockId; order: number }[]>();
    if (sourceIds.length === 0) return out;
    // Chunk the IN (...) list so an unbounded source set stays under SQLite's
    // variable limit; the final sort makes per-source order chunk-independent.
    for (const chunk of chunkIds(sourceIds as ElementId[])) {
      const rows = this.db
        .select({
          documentId: documentBlocks.documentId,
          stableBlockId: documentBlocks.stableBlockId,
          order: documentBlocks.order,
        })
        .from(documentBlocks)
        .where(inArray(documentBlocks.documentId, chunk))
        .all();
      for (const row of rows) {
        const list = out.get(row.documentId as ElementId) ?? [];
        list.push({ stableBlockId: row.stableBlockId as BlockId, order: row.order });
        out.set(row.documentId as ElementId, list);
      }
    }
    // Match the single-source `listSourceBlocks` ordering (by `order` ASC).
    for (const list of out.values()) list.sort((a, b) => a.order - b.order);
    return out;
  }

  getReadPointOrderForMany(sourceIds: readonly ElementId[]): Map<ElementId, number> {
    const out = new Map<ElementId, number>();
    if (sourceIds.length === 0) return out;
    // Chunk the IN (...) list so an unbounded source set stays under SQLite's
    // variable limit. Each source appears in exactly one chunk, so resolving its
    // read-point order within that chunk is output-identical to one big read; the
    // inner document_blocks read is bounded by the chunk's read-point count.
    for (const chunk of chunkIds(sourceIds as ElementId[])) {
      const rps = this.db
        .select({ elementId: readPoints.elementId, blockId: readPoints.blockId })
        .from(readPoints)
        .where(inArray(readPoints.elementId, chunk))
        .all();
      if (rps.length === 0) continue;
      // Resolve each read-point block's order via one batched `document_blocks` read.
      const docIds = rps.map((rp) => rp.elementId);
      const blockOrders = this.db
        .select({
          documentId: documentBlocks.documentId,
          stableBlockId: documentBlocks.stableBlockId,
          order: documentBlocks.order,
        })
        .from(documentBlocks)
        .where(inArray(documentBlocks.documentId, docIds))
        .all();
      const orderByKey = new Map<string, number>();
      for (const b of blockOrders) orderByKey.set(`${b.documentId} ${b.stableBlockId}`, b.order);
      for (const rp of rps) {
        const order = orderByKey.get(`${rp.elementId} ${rp.blockId}`);
        if (order != null) out.set(rp.elementId as ElementId, order);
      }
    }
    return out;
  }

  listLiveOutputsForMany(sourceIds: readonly ElementId[]): Map<ElementId, LiveBlockOutput[]> {
    const out = new Map<ElementId, LiveBlockOutput[]>();
    if (sourceIds.length === 0) return out;

    // Per-source de-dup seen set, mirroring the single-source `listLiveOutputs`.
    const seen = new Map<ElementId, Set<string>>();
    const seenFor = (sourceId: ElementId): Set<string> => {
      let s = seen.get(sourceId);
      if (!s) {
        s = new Set();
        seen.set(sourceId, s);
      }
      return s;
    };

    // Chunk the IN (...) list so an unbounded source set stays under SQLite's
    // variable limit. Each source appears in exactly one chunk, so both reads
    // (linked then derived-from-location) for that source happen in the SAME
    // chunk iteration and in the SAME order as the unchunked path — making the
    // per-source de-dup + assembly output-identical to one big read.
    for (const chunk of chunkIds(sourceIds as ElementId[])) {
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
            inArray(sourceBlockProcessingOutputs.sourceElementId, chunk),
            isNull(elements.deletedAt),
          ),
        )
        .all();
      for (const row of linked) {
        const sourceId = row.sourceElementId as ElementId;
        const list = out.get(sourceId) ?? [];
        list.push({
          sourceElementId: sourceId,
          stableBlockId: row.stableBlockId as BlockId,
          outputElementId: row.outputElementId as ElementId,
          outputType: row.outputType as SourceBlockOutputType,
          sourceLocationId: row.sourceLocationId,
        });
        out.set(sourceId, list);
        seenFor(sourceId).add(`${row.stableBlockId}:${row.outputElementId}`);
      }

      const locationRows = this.db
        .select({
          sourceElementId: sourceLocations.sourceElementId,
          locationId: sourceLocations.id,
          elementId: sourceLocations.elementId,
          elementType: elements.type,
          blockIds: sourceLocations.blockIds,
        })
        .from(sourceLocations)
        .innerJoin(elements, eq(elements.id, sourceLocations.elementId))
        .where(and(inArray(sourceLocations.sourceElementId, chunk), isNull(elements.deletedAt)))
        .all();
      for (const row of locationRows) {
        const sourceId = row.sourceElementId as ElementId;
        let blockIds: string[] = [];
        try {
          blockIds = JSON.parse(row.blockIds) as string[];
        } catch {
          blockIds = [];
        }
        const s = seenFor(sourceId);
        const list = out.get(sourceId) ?? [];
        for (const blockId of blockIds) {
          const key = `${blockId}:${row.elementId}`;
          if (s.has(key)) continue;
          s.add(key);
          list.push({
            sourceElementId: sourceId,
            stableBlockId: blockId as BlockId,
            outputElementId: row.elementId as ElementId,
            outputType: outputTypeForElement(row.elementType),
            sourceLocationId: row.locationId,
          });
        }
        if (list.length > 0) out.set(sourceId, list);
      }
    }
    return out;
  }

  sourcePriorityForMany(sourceIds: readonly ElementId[]): Map<ElementId, number> {
    const out = new Map<ElementId, number>();
    if (sourceIds.length === 0) return out;
    // Chunk the IN (...) list so an unbounded source set stays under SQLite's
    // variable limit; per-source priority is keyed by id, so merging is identical.
    for (const chunk of chunkIds(sourceIds as ElementId[])) {
      const rows = this.db
        .select({ id: elements.id, priority: elements.priority })
        .from(elements)
        .where(inArray(elements.id, chunk))
        .all();
      for (const row of rows) {
        if (row.priority != null) out.set(row.id as ElementId, row.priority);
      }
    }
    return out;
  }

  /**
   * Reconcile durable block-processing state against the current document block
   * hashes and report the transitions (T123). A processed block whose content drifted
   * (or disappeared) goes `stale_after_edit` and is reported in `staled`; a previously
   * stale block whose content returned to its captured pre-stale hash is restored to
   * its prior processed state and reported in `unStaled`. Idempotent: an unchanged
   * document produces an empty report. Stale propagation consumes the report in the
   * same transaction.
   */
  reconcileStaleWithin(
    tx: DbClient,
    sourceElementId: ElementId,
    blockHashes: ReadonlyMap<BlockId, string>,
  ): SourceBlockReconcileReport {
    const staled: BlockId[] = [];
    const unStaled: BlockId[] = [];
    const rows = tx
      .select()
      .from(sourceBlockProcessing)
      .where(eq(sourceBlockProcessing.sourceElementId, sourceElementId))
      .all();
    for (const row of rows) {
      const blockId = row.stableBlockId as BlockId;
      const nextHash = blockHashes.get(blockId);

      // Un-stale arm (NEW in T123): a row already in `stale_after_edit` is restored
      // when the block's current content hash returns to its captured pre-stale hash.
      // The pre-T123 loop skipped these rows entirely (no restoration path existed).
      if (row.state === "stale_after_edit") {
        const restoredState = this.restorableStateFromMetadata(row.metadata);
        if (nextHash && row.preStaleHash && nextHash === row.preStaleHash && restoredState) {
          this.upsertStateWithin(tx, {
            sourceElementId,
            stableBlockId: blockId,
            state: restoredState,
            action: "reconcile_document_blocks",
            blockContentHash: nextHash,
            preStaleHash: null,
            metadata: { reason: "content_restored", restoredTo: restoredState },
          });
          unStaled.push(blockId);
        }
        continue;
      }

      if (!RESTORABLE_PROCESSED_STATES.has(row.state as SourceBlockProcessingState)) {
        continue;
      }
      if (nextHash && row.blockContentHash === nextHash) continue;
      if (nextHash && row.blockContentHash == null) {
        this.upsertStateWithin(tx, {
          sourceElementId,
          stableBlockId: blockId,
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
      // processed → stale: capture the last-processed hash ONCE so the un-stale arm
      // above can recognize a later restoration.
      this.upsertStateWithin(tx, {
        sourceElementId,
        stableBlockId: blockId,
        state: "stale_after_edit",
        action: "reconcile_document_blocks",
        blockContentHash: nextHash ?? row.blockContentHash,
        preStaleHash: row.blockContentHash,
        metadata: {
          reason: nextHash ? "content_changed" : "block_missing",
          previousState: row.state,
        },
      });
      staled.push(blockId);
    }
    return { staled, unStaled };
  }

  /**
   * The processed state to restore a `stale_after_edit` row to, read from the
   * `previousState` recorded in metadata when the block was staled. Returns `null`
   * (no restoration) when the recorded state is missing or not a known processed
   * state — we only auto-restore when the prior state is unambiguous.
   */
  private restorableStateFromMetadata(raw: string | null): SourceBlockProcessingState | null {
    const metadata = parseMetadata(raw);
    const previousState = metadata?.previousState;
    if (
      typeof previousState === "string" &&
      RESTORABLE_PROCESSED_STATES.has(previousState as SourceBlockProcessingState)
    ) {
      return previousState as SourceBlockProcessingState;
    }
    return null;
  }
}
