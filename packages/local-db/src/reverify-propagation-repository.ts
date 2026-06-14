/**
 * Reverify propagation (T123) — forward content-staleness through the lineage DAG.
 *
 * When block reconciliation reports that source blocks newly entered or left
 * `stale_after_edit`, this walks the LIVE lineage from each affected block and keeps
 * `element_reverify_provenance` (and the denormalized `elements.needs_reverify`
 * projection) in sync, all inside the SAME transaction as the reconciliation. The
 * dirty bit flows downstream: an extract anchored to an edited block — and every live
 * statement/card beneath it — gains a queryable "this might no longer match its
 * source" flag. Restoring the block's content removes the provenance it caused and
 * clears the flag (unless another block still stales the element).
 *
 * Invariants honored here:
 *  - Same transaction: a crash never leaves blocks stale but descendants clean.
 *  - Live-only walk via {@link liveDescendantsWithin} (`parentId` DFS, skips
 *    soft-deleted rows). The anchored root is filtered live before the walk.
 *  - Self-healing projection: `needs_reverify` is recomputed as
 *    `EXISTS(provenance for element)`, never flipped on a "newly inserted" guess.
 *  - Idempotent: re-running on the same report inserts no provenance (unique triple +
 *    `ON CONFLICT DO NOTHING`), recomputes the same flag, and appends no op.
 *  - Soft-delete safe: the un-stale clear deletes provenance by block across ALL
 *    targets (live or trashed), so a since-deleted element never resurrects flagged.
 *  - Op-logged with a preimage and a `propagation: true` marker so the global undo
 *    (which cannot invert the source-edit `update_document`) does NOT half-clear the
 *    flags; the clear path is re-reconciliation.
 */

import type { BlockId, ElementId, SourceBlockReconcileReport } from "@interleave/core";
import {
  elementDetachSnapshot,
  elementReverifyProvenance,
  elements,
  type InterleaveDatabase,
  sourceLocations,
} from "@interleave/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { liveDescendantsWithin } from "./descendant-query";
import { newRowId, nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import type { DbClient } from "./types";

/**
 * The element types that may carry `needs_reverify` — matches the `elements`
 * type-coupled CHECK (`type IN ('extract','card','media_fragment')`). Propagation only
 * flags these: in practice only derived artifacts carry `source_locations` anchors, but
 * flagging any other type would violate the CHECK and abort the source save, so the walk
 * filters defensively rather than trusting that invariant implicitly.
 *
 * Exported as the single source of truth: the resolution repo + service import this so
 * the flaggable set stays in lockstep with the `elements` CHECK in ONE place.
 */
export const REVERIFY_FLAGGABLE_TYPES: ReadonlySet<string> = new Set([
  "extract",
  "card",
  "media_fragment",
]);

export class ReverifyPropagationRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Apply one reconciliation report's transitions: flag live descendants of newly
   * stale blocks, clear provenance for restored blocks, and recompute the flag for
   * every touched element. No-op when the report is empty.
   */
  propagateReverify(
    tx: DbClient,
    sourceElementId: ElementId,
    report: SourceBlockReconcileReport,
    batchId: string,
  ): void {
    if (report.staled.length === 0 && report.unStaled.length === 0) return;
    const touched = new Set<ElementId>();

    // Staled blocks → record provenance for each live anchored element AND its live
    // transitive descendants (extract → statement → card).
    if (report.staled.length > 0) {
      const anchorsByBlock = this.liveAnchorsByBlock(tx, sourceElementId, new Set(report.staled));
      for (const blockId of report.staled) {
        const anchors = anchorsByBlock.get(blockId);
        if (!anchors) continue;
        for (const anchorId of anchors) {
          // The anchored element itself is already filtered live + flaggable; the helper
          // EXCLUDES the root, so prepend it explicitly to cover the anchored extract too.
          // Descendants are filtered to flaggable types (a non-derived type would violate
          // the elements CHECK on flag-set and abort the save).
          const affected: ElementId[] = [
            anchorId,
            ...liveDescendantsWithin(tx, anchorId)
              .filter((row) => REVERIFY_FLAGGABLE_TYPES.has(row.type))
              .map((row) => row.id as ElementId),
          ];
          for (const elementId of affected) {
            // T124 detach tombstone applies to DESCENDANTS too, not just the direct
            // anchor (which `liveAnchorsByBlock` already filtered): a descent-flagged
            // card/statement detached against this (source, block) must not be re-flagged
            // when its ancestor's block is later edited, or the detach's standalone
            // promise is silently broken for non-anchor outputs.
            if (this.isDetached(tx, elementId, sourceElementId, blockId)) continue;
            this.insertProvenanceWithin(tx, {
              elementId,
              sourceElementId,
              stableBlockId: blockId,
              batchId,
            });
            touched.add(elementId);
          }
        }
      }
    }

    // Un-staled blocks → drop ALL provenance for the restored block (live or trashed
    // targets), collecting the affected elements so their flag recomputes.
    for (const blockId of report.unStaled) {
      const affected = tx
        .select({ elementId: elementReverifyProvenance.elementId })
        .from(elementReverifyProvenance)
        .where(
          and(
            eq(elementReverifyProvenance.sourceElementId, sourceElementId),
            eq(elementReverifyProvenance.stableBlockId, blockId),
          ),
        )
        .all();
      for (const row of affected) touched.add(row.elementId as ElementId);
      tx.delete(elementReverifyProvenance)
        .where(
          and(
            eq(elementReverifyProvenance.sourceElementId, sourceElementId),
            eq(elementReverifyProvenance.stableBlockId, blockId),
          ),
        )
        .run();
    }

    for (const elementId of touched) {
      this.recomputeFlagWithin(tx, elementId, batchId);
    }
  }

  /**
   * Map each newly-stale block to the LIVE elements anchored directly to it, by
   * parsing `source_locations.block_ids` (the immutable lineage anchor — never the
   * extract body's reminted ids). Mirrors the defensive parse in
   * `BlockProcessingRepository.listLiveOutputs`.
   *
   * T124 detach tombstone: a `(element, source, block)` tuple that has a row in
   * `element_detach_snapshot` was deliberately detached into a standalone output, so a
   * future edit of that block must NOT re-anchor and re-flag it. Such tuples are
   * excluded here via a `NOT EXISTS` subquery, so the detach is a durable re-flag
   * tombstone (until undo drops the snapshot). With no snapshots present this is a
   * no-op, preserving the T123 behavior exactly.
   */
  liveAnchorsByBlock(
    tx: DbClient,
    sourceElementId: ElementId,
    blocks: ReadonlySet<BlockId>,
  ): Map<BlockId, Set<ElementId>> {
    const rows = tx
      .select({
        elementId: sourceLocations.elementId,
        blockIds: sourceLocations.blockIds,
        type: elements.type,
      })
      .from(sourceLocations)
      .innerJoin(elements, eq(elements.id, sourceLocations.elementId))
      .where(and(eq(sourceLocations.sourceElementId, sourceElementId), isNull(elements.deletedAt)))
      .all();
    const out = new Map<BlockId, Set<ElementId>>();
    for (const row of rows) {
      // Only flaggable derived types can carry needs_reverify (see REVERIFY_FLAGGABLE_TYPES).
      if (!REVERIFY_FLAGGABLE_TYPES.has(row.type)) continue;
      let blockIds: string[] = [];
      try {
        blockIds = JSON.parse(row.blockIds) as string[];
      } catch {
        blockIds = [];
      }
      for (const raw of blockIds) {
        const blockId = raw as BlockId;
        if (!blocks.has(blockId)) continue;
        // Detach tombstone: skip a tuple that was detached into a standalone output.
        if (this.isDetached(tx, row.elementId as ElementId, sourceElementId, blockId)) continue;
        const set = out.get(blockId) ?? new Set<ElementId>();
        set.add(row.elementId as ElementId);
        out.set(blockId, set);
      }
    }
    return out;
  }

  /**
   * Whether the `(element, source, block)` tuple has a frozen detach snapshot — i.e.
   * it was detached into a standalone output and must not be re-anchored/re-flagged on
   * a future block edit (T124 detach tombstone). Returns `false` when no snapshot
   * exists (the common case), so the T123 walk is unchanged.
   */
  private isDetached(
    tx: DbClient,
    elementId: ElementId,
    sourceElementId: ElementId,
    stableBlockId: BlockId,
  ): boolean {
    const row = tx
      .select({ id: elementDetachSnapshot.id })
      .from(elementDetachSnapshot)
      .where(
        and(
          eq(elementDetachSnapshot.elementId, elementId),
          eq(elementDetachSnapshot.sourceElementId, sourceElementId),
          eq(elementDetachSnapshot.stableBlockId, stableBlockId),
        ),
      )
      .limit(1)
      .get();
    return row !== undefined;
  }

  /**
   * Count the LIVE derived outputs of a source that currently need re-verification
   * (T123, R6) — distinct non-soft-deleted elements with ≥1 provenance row pointing at
   * this source. Read-only; soft-deleted targets are excluded so the count stays honest.
   */
  countLiveReverifyOutputs(sourceElementId: ElementId): number {
    const row = this.db
      .select({ n: sql<number>`count(distinct ${elementReverifyProvenance.elementId})` })
      .from(elementReverifyProvenance)
      .innerJoin(elements, eq(elements.id, elementReverifyProvenance.elementId))
      .where(
        and(
          eq(elementReverifyProvenance.sourceElementId, sourceElementId),
          isNull(elements.deletedAt),
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  /**
   * Insert one provenance triple (idempotent via the unique index +
   * `ON CONFLICT DO NOTHING`). Public so T124's `ReverifyResolutionRepository`
   * composes the same projection on undo (re-inserting a captured `prevProvenance`
   * row) rather than re-implementing it.
   */
  insertProvenanceWithin(
    tx: DbClient,
    input: {
      readonly elementId: ElementId;
      readonly sourceElementId: ElementId;
      readonly stableBlockId: BlockId;
      readonly batchId: string;
    },
  ): void {
    tx.insert(elementReverifyProvenance)
      .values({
        id: newRowId(),
        elementId: input.elementId,
        sourceElementId: input.sourceElementId,
        stableBlockId: input.stableBlockId,
        batchId: input.batchId,
        createdAt: nowIso(),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Recompute the self-healing projection for one element: `needs_reverify =
   * EXISTS(provenance for element)`. Writes (and op-logs) only when the value actually
   * changes — so re-runs are idempotent and unchanged elements cost nothing.
   *
   * Public so T124's `ReverifyResolutionRepository` settles the flag after deleting (or
   * re-inserting) provenance rows — composing this projection rather than flipping the
   * boolean (which KTD1 forbids, since it would break multi-block self-healing). The
   * `propagation: true` marker on this op stays in place: this flag-write is never
   * the undo unit; T124's dedicated `reverifyResolution` op is.
   */
  recomputeFlagWithin(tx: DbClient, elementId: ElementId, batchId: string): void {
    const current = tx
      .select({ needsReverify: elements.needsReverify, staleSince: elements.staleSince })
      .from(elements)
      .where(eq(elements.id, elementId))
      .get();
    if (!current) return; // hard-deleted mid-transaction; nothing to flag

    const provenance = tx
      .select({ n: sql<number>`count(*)` })
      .from(elementReverifyProvenance)
      .where(eq(elementReverifyProvenance.elementId, elementId))
      .get();
    const hasProvenance = (provenance?.n ?? 0) > 0;
    const currentFlag = current.needsReverify === true;
    if (hasProvenance === currentFlag) return;

    const now = nowIso();
    const nextStaleSince = hasProvenance ? (current.staleSince ?? now) : null;
    tx.update(elements)
      .set({ needsReverify: hasProvenance, staleSince: nextStaleSince, updatedAt: now })
      .where(eq(elements.id, elementId))
      .run();

    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId,
      payload: {
        needsReverify: hasProvenance,
        staleSince: nextStaleSince,
        prev: { needsReverify: currentFlag, staleSince: current.staleSince ?? null },
        batchId,
        // T123 marker: the global undo must NOT invert this flag flip (it would desync
        // from the non-invertible source-edit `update_document`). See UndoService.
        propagation: true,
      },
    });
  }
}
