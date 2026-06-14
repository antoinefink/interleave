/**
 * Reverify resolution (T124) — the transactional primitives every resolution verb
 * (confirm / rebase / detach) shares.
 *
 * T123 made content-staleness *visible*: editing a source block flags the live
 * downstream lineage (`element_reverify_provenance` rows ⇒ `elements.needs_reverify`).
 * T124 builds the human-in-the-loop *drain* — each flagged output resolves as one of
 * three verbs, all of which clear the flag the same way: by deleting the relevant
 * provenance rows and re-running T123's self-healing projection (NEVER by flipping the
 * boolean, which would break multi-block self-healing — KTD1). Detach additionally
 * freezes a provenance snapshot that acts as a re-flag tombstone (so a future edit of
 * the same block can't re-anchor the now-standalone output — KTD3).
 *
 * Load-bearing decisions honored here:
 *  - A provenance delete is NOT an element-column edit, so it cannot ride
 *    `ElementRepository.updateWithin`'s fixed-column preimage. Each resolution instead
 *    appends ONE dedicated `reverifyResolution` op carrying the full provenance
 *    preimage — that op (not the recompute's `propagation: true` flag-write) is the
 *    undoable unit (KTD2).
 *  - The clear deletes provenance by the exact triple across LIVE and SOFT-DELETED
 *    targets (the FK cascade only fires on HARD purge), so a since-trashed element
 *    never resurrects still-flagged.
 *  - Recompute is part of every mutation AND its inverse: re-inserting provenance on
 *    undo leaves `needs_reverify=false` until the projection runs.
 *
 * All methods are `…Within(tx, …)` so the resolution service composes them into one
 * transaction with the op-log append.
 */

import type { BlockId, ElementId, SourceBlockProcessingState } from "@interleave/core";
import {
  type ElementReverifyProvenanceRow,
  elementDetachSnapshot,
  elementReverifyProvenance,
  elements,
  type InterleaveDatabase,
} from "@interleave/db";
import { and, eq, isNull } from "drizzle-orm";
import { BlockProcessingRepository } from "./block-processing-repository";
import { DocumentRepository } from "./document-repository";
import { newRowId, nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import {
  REVERIFY_FLAGGABLE_TYPES,
  ReverifyPropagationRepository,
} from "./reverify-propagation-repository";
import type { DbClient } from "./types";

/** The three resolution verbs (KTD1/KTD3/KTD4). */
export type ReverifyResolutionVerb = "confirm" | "rebase" | "detach";

/** The full preimage of one provenance row, captured for undo (KTD2). */
export interface ReverifyProvenancePreimage {
  readonly id: string;
  readonly elementId: ElementId;
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly batchId: string;
  readonly createdAt: string;
}

/**
 * The extract-body preimage a rebase captures (KTD4). The forward rebase rewrites the
 * extract's own document via `update_document` — a NON-invertible op for global undo —
 * so the resolution op carries the prior body here and the receipt undo restores it.
 */
export interface ReverifyBodyPreimage {
  /** The extract's prior ProseMirror document JSON (already parsed). */
  readonly prosemirrorJson: unknown;
  /** The extract's prior flattened plain-text mirror. */
  readonly plainText: string;
  /** The extract's prior stable block list (so undo restores the exact ids). */
  readonly blocks: readonly {
    readonly blockType: string;
    readonly order: number;
    readonly stableBlockId: BlockId;
  }[];
}

/**
 * The `source_block_processing` preimage a rebase captures when it reconciles a block
 * out of `stale_after_edit` (KTD4 — only fired when the rebased element is the LAST live
 * flagged anchor on the block). The forward reconcile is an `update_document` op (NOT
 * invertible by global undo); the receipt undo restores the prior row from this preimage.
 */
export interface ReverifyBlockStatePreimage {
  readonly stableBlockId: BlockId;
  readonly state: SourceBlockProcessingState;
  readonly blockContentHash: string | null;
  readonly preStaleHash: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

/** Input for {@link ReverifyResolutionRepository.clearProvenanceWithin}. */
export interface ClearProvenanceInput {
  readonly elementId: ElementId;
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly batchId: string;
  readonly verb: ReverifyResolutionVerb;
  /** Set when the resolution is a detach, so its op carries the snapshot id for undo. */
  readonly detachSnapshotId?: string;
  /**
   * Set when the resolution is a rebase that re-derived the extract body — the prior
   * body, embedded so the receipt undo can restore it (the forward `update_document` is
   * non-invertible by global undo). KTD4/R5.
   */
  readonly prevBody?: ReverifyBodyPreimage;
  /**
   * Set when the rebase reconciled the block out of `stale_after_edit` (it was the last
   * live flagged anchor) — the prior `source_block_processing` row, embedded so the
   * receipt undo can restore the block state. KTD4/R5.
   */
  readonly prevBlockState?: ReverifyBlockStatePreimage;
}

/** The frozen anchor a detach snapshot records (KTD3). */
export interface DetachSnapshotInput {
  readonly elementId: ElementId;
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly selectedText: string;
  /** Anchor block ids as a JSON-array string (mirrors `source_locations.block_ids`). */
  readonly blockIds: string;
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly preStaleHash: string | null;
}

/** Input for {@link ReverifyResolutionRepository.detachWithin}. */
export interface DetachInput {
  readonly elementId: ElementId;
  readonly sourceElementId: ElementId;
  readonly stableBlockId: BlockId;
  readonly snapshot: DetachSnapshotInput;
}

/** One flagged output of a source, grouped by element (drives the U4 per-source preview). */
export interface FlaggedBySourceRow {
  readonly elementId: ElementId;
  readonly type: string;
  readonly stage: string;
  readonly title: string;
  /** The distinct source blocks that flag this element. */
  readonly blocks: BlockId[];
}

/**
 * The `reverifyResolution` op payload shape (KTD2). This is the undoable unit; it is
 * distinct from recompute's `propagation: true` flag-write (which global undo skips).
 */
export interface ReverifyResolutionOpPayload {
  readonly reverifyResolution: {
    readonly verb: ReverifyResolutionVerb;
    readonly sourceElementId: ElementId;
    readonly stableBlockId: BlockId;
  };
  readonly prevProvenance: ReverifyProvenancePreimage[];
  readonly detachSnapshotId?: string;
  /** Rebase only — the extract's prior body, restored by the receipt undo (KTD4/R5). */
  readonly prevBody?: ReverifyBodyPreimage;
  /** Rebase only — the prior block-processing row, restored by the receipt undo (KTD4/R5). */
  readonly prevBlockState?: ReverifyBlockStatePreimage;
  readonly batchId: string;
}

export class ReverifyResolutionRepository {
  /** Composes T123's projection (recompute / re-insert) — never re-implements it. */
  private readonly propagation: ReverifyPropagationRepository;
  /** Restores the rebase body preimage on undo (the forward write is non-invertible). */
  private readonly documents: DocumentRepository;
  /** Restores the rebase block-state preimage on undo. */
  private readonly blockProcessing: BlockProcessingRepository;

  constructor(db: InterleaveDatabase) {
    this.propagation = new ReverifyPropagationRepository(db);
    this.documents = new DocumentRepository(db);
    this.blockProcessing = new BlockProcessingRepository(db);
  }

  /**
   * Clear the flag for one `(element, source, block)` triple and settle the projection.
   *
   * 1. Reads the matching provenance rows (the `prevProvenance` preimage).
   * 2. Appends ONE dedicated `reverifyResolution` op carrying that preimage — the
   *    undoable resolution unit (NOT an element-column patch).
   * 3. Deletes the provenance rows by the exact triple (live OR soft-deleted target —
   *    deliberately does not filter on `deletedAt`).
   * 4. Recomputes `needs_reverify` via T123's projection. Multi-block: if another
   *    block's provenance still flags the element, the flag stays true.
   */
  clearProvenanceWithin(tx: DbClient, input: ClearProvenanceInput): void {
    const prevProvenance = this.readProvenanceTriple(
      tx,
      input.elementId,
      input.sourceElementId,
      input.stableBlockId,
    );

    const payload: ReverifyResolutionOpPayload = {
      reverifyResolution: {
        verb: input.verb,
        sourceElementId: input.sourceElementId,
        stableBlockId: input.stableBlockId,
      },
      prevProvenance,
      ...(input.detachSnapshotId ? { detachSnapshotId: input.detachSnapshotId } : {}),
      ...(input.prevBody ? { prevBody: input.prevBody } : {}),
      ...(input.prevBlockState ? { prevBlockState: input.prevBlockState } : {}),
      batchId: input.batchId,
    };
    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId: input.elementId,
      payload,
    });

    tx.delete(elementReverifyProvenance)
      .where(
        and(
          eq(elementReverifyProvenance.elementId, input.elementId),
          eq(elementReverifyProvenance.sourceElementId, input.sourceElementId),
          eq(elementReverifyProvenance.stableBlockId, input.stableBlockId),
        ),
      )
      .run();

    this.propagation.recomputeFlagWithin(tx, input.elementId, input.batchId);
  }

  /**
   * Freeze a detach snapshot (the standalone element's evidence root + the re-flag
   * tombstone — see `liveAnchorsByBlock`). Returns the new row id so the caller can
   * carry it on the resolution op for undo.
   */
  writeDetachSnapshotWithin(tx: DbClient, snapshot: DetachSnapshotInput, batchId: string): string {
    const id = newRowId();
    tx.insert(elementDetachSnapshot)
      .values({
        id,
        elementId: snapshot.elementId,
        sourceElementId: snapshot.sourceElementId,
        stableBlockId: snapshot.stableBlockId,
        selectedText: snapshot.selectedText,
        blockIds: snapshot.blockIds,
        startOffset: snapshot.startOffset,
        endOffset: snapshot.endOffset,
        preStaleHash: snapshot.preStaleHash,
        batchId,
        createdAt: nowIso(),
      })
      .run();
    return id;
  }

  /**
   * Convenience: write the detach snapshot, then clear provenance with `verb: "detach"`
   * and the returned `detachSnapshotId` (so the resolution op carries it for undo).
   * Returns the snapshot id.
   */
  detachWithin(tx: DbClient, input: DetachInput, batchId: string): string {
    const detachSnapshotId = this.writeDetachSnapshotWithin(tx, input.snapshot, batchId);
    this.clearProvenanceWithin(tx, {
      elementId: input.elementId,
      sourceElementId: input.sourceElementId,
      stableBlockId: input.stableBlockId,
      batchId,
      verb: "detach",
      detachSnapshotId,
    });
    return detachSnapshotId;
  }

  /**
   * The INVERSE of a resolution, used by undo (KTD2/KTD4). From the op payload:
   *  1. re-insert each captured provenance row (idempotent via `ON CONFLICT DO NOTHING`);
   *  2. if a detach snapshot was recorded, drop it (lifting the tombstone);
   *  3. if a rebase body preimage was recorded, restore the extract's PRIOR body via
   *     `update_document` (the forward rebase body write is non-invertible by global
   *     undo, so the receipt undo MUST restore it here);
   *  4. if a rebase block-state preimage was recorded, restore the source block's PRIOR
   *     `source_block_processing` row (state + hashes + metadata) so a block reconciled
   *     out of `stale_after_edit` goes back to stale with its `pre_stale_hash` intact;
   *  5. recompute the element's flag so it settles back to true. Re-inserting provenance
   *     ALONE does not re-flag — the recompute is essential.
   */
  restoreResolutionWithin(
    tx: DbClient,
    op: { elementId: ElementId | null; payload: unknown },
  ): void {
    const payload = op.payload as ReverifyResolutionOpPayload | null;
    if (!payload || op.elementId === null) return;
    const batchId = payload.batchId;
    const sourceElementId = payload.reverifyResolution?.sourceElementId;

    for (const row of payload.prevProvenance ?? []) {
      tx.insert(elementReverifyProvenance)
        .values({
          id: row.id,
          elementId: row.elementId,
          sourceElementId: row.sourceElementId,
          stableBlockId: row.stableBlockId,
          batchId: row.batchId,
          createdAt: row.createdAt,
        })
        .onConflictDoNothing()
        .run();
    }

    if (payload.detachSnapshotId) {
      tx.delete(elementDetachSnapshot)
        .where(eq(elementDetachSnapshot.id, payload.detachSnapshotId))
        .run();
    }

    // Rebase undo: restore the extract's prior body (the forward rewrite minted fresh
    // block ids; the preimage carries the exact prior ids so descendants re-anchor).
    if (payload.prevBody) {
      this.documents.upsertWithin(tx, {
        elementId: op.elementId,
        prosemirrorJson: payload.prevBody.prosemirrorJson,
        plainText: payload.prevBody.plainText,
        blocks: payload.prevBody.blocks.map((b) => ({
          blockType: b.blockType,
          order: b.order,
          stableBlockId: b.stableBlockId,
        })),
      });
    }

    // Rebase undo: restore the source block's prior processing row (back into
    // `stale_after_edit` with its captured `pre_stale_hash`, so the sibling-protection /
    // content-restore auto-clear path is re-armed exactly as it was before the rebase).
    if (payload.prevBlockState && sourceElementId) {
      this.blockProcessing.upsertStateWithin(tx, {
        sourceElementId,
        stableBlockId: payload.prevBlockState.stableBlockId,
        state: payload.prevBlockState.state,
        action: "reconcile_document_blocks",
        blockContentHash: payload.prevBlockState.blockContentHash,
        preStaleHash: payload.prevBlockState.preStaleHash,
        metadata: payload.prevBlockState.metadata,
      });
    }

    this.propagation.recomputeFlagWithin(tx, op.elementId, batchId);
  }

  /**
   * For each LIVE flaggable element with ≥1 provenance row for this source, return a
   * record with its type/stage/title and the distinct blocks that flag it (the inverse
   * of T123's `liveAnchorsByBlock` — drives the per-source preview in U4). Soft-deleted
   * and non-flaggable elements are excluded.
   */
  listFlaggedBySourceWithin(tx: DbClient, sourceElementId: ElementId): FlaggedBySourceRow[] {
    const rows = tx
      .select({
        elementId: elementReverifyProvenance.elementId,
        stableBlockId: elementReverifyProvenance.stableBlockId,
        type: elements.type,
        stage: elements.stage,
        title: elements.title,
      })
      .from(elementReverifyProvenance)
      .innerJoin(elements, eq(elements.id, elementReverifyProvenance.elementId))
      .where(
        and(
          eq(elementReverifyProvenance.sourceElementId, sourceElementId),
          isNull(elements.deletedAt),
        ),
      )
      .all();

    const byElement = new Map<ElementId, FlaggedBySourceRow & { blockSet: Set<BlockId> }>();
    for (const row of rows) {
      if (!REVERIFY_FLAGGABLE_TYPES.has(row.type)) continue;
      const elementId = row.elementId as ElementId;
      const blockId = row.stableBlockId as BlockId;
      let entry = byElement.get(elementId);
      if (!entry) {
        entry = {
          elementId,
          type: row.type,
          stage: row.stage,
          title: row.title,
          blocks: [],
          blockSet: new Set<BlockId>(),
        };
        byElement.set(elementId, entry);
      }
      if (!entry.blockSet.has(blockId)) {
        entry.blockSet.add(blockId);
        entry.blocks.push(blockId);
      }
    }

    return [...byElement.values()].map(({ blockSet: _blockSet, ...row }) => row);
  }

  /** Read the full provenance rows for the exact `(element, source, block)` triple. */
  private readProvenanceTriple(
    tx: DbClient,
    elementId: ElementId,
    sourceElementId: ElementId,
    stableBlockId: BlockId,
  ): ReverifyProvenancePreimage[] {
    const rows = tx
      .select()
      .from(elementReverifyProvenance)
      .where(
        and(
          eq(elementReverifyProvenance.elementId, elementId),
          eq(elementReverifyProvenance.sourceElementId, sourceElementId),
          eq(elementReverifyProvenance.stableBlockId, stableBlockId),
        ),
      )
      .all();
    return rows.map((row: ElementReverifyProvenanceRow) => ({
      id: row.id,
      elementId: row.elementId as ElementId,
      sourceElementId: row.sourceElementId as ElementId,
      stableBlockId: row.stableBlockId as BlockId,
      batchId: row.batchId,
      createdAt: row.createdAt,
    }));
  }
}
