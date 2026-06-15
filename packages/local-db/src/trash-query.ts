/**
 * TrashRepository (T044) — the read + terminal hard-delete for the Trash view.
 *
 * Soft-delete already happens everywhere (`ElementRepository.softDelete` sets
 * `deletedAt` + status `deleted` and logs `soft_delete_element`); the rest of the
 * app hides those rows (`listBy*` filter `isNull(deletedAt)`). This repository is
 * the OTHER side: it READS the soft-deleted rows for the Trash screen, and is the
 * single place a row can be HARD-deleted (`purge`/`emptyTrash`).
 *
 * Two-stage delete is the whole point: soft-delete is recoverable (restore via
 * `ElementRepository.restore`); purge is the irreversible terminal state.
 *
 * Purge & the operation log (load-bearing decision):
 *   A purge is IRREVERSIBLE BY DESIGN — there is no `restore_element` after it —
 *   so it does NOT append a new op (and the closed 15-op set gains no "purge" type).
 *   The element's prior `soft_delete_element` op stays in the append-only log as the
 *   last word about that element; the real `DELETE` nulls that op's `element_id` via
 *   the `operation_log.element_id` FK (`onDelete: set null`), and the FTS5
 *   `elements_fts_ad` trigger + the FK cascades (`cards`/`review_states`/
 *   `review_logs`/`documents`/`sources`/`source_locations`/`assets`/`concepts`/
 *   `element_tags`/`tasks`/relations) clean up every dependent row. Every
 *   element-keyed side-table — `concepts` included (its `id` cascades to
 *   `elements.id`) — is cleaned up, so purge leaves NO orphans and is the only hard
 *   delete in the app — it is gated behind explicit UI confirmation.
 */

import type { Element, ElementId, ElementStatus, IsoTimestamp } from "@interleave/core";
import { elements, embeddings, type InterleaveDatabase, operationLog } from "@interleave/db";
import { and, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { newRowId } from "./ids";
import { rowToElement } from "./mappers";
import {
  originStatusFromPayload,
  parsePayload,
  restoreScheduleFromPayload,
} from "./op-payload-helpers";
import type { DbClient } from "./types";

/** One row in the Trash view: the soft-deleted element + its origin context. */
export interface TrashItem {
  /** The soft-deleted element (`deletedAt != null`, status `deleted`). */
  readonly element: Element;
  /** When it was soft-deleted (ISO-8601) — the same as `element.deletedAt`. */
  readonly deletedAt: IsoTimestamp;
  /**
   * The lifecycle status the element had BEFORE the delete — what `restore`
   * returns it to. Read from the latest `soft_delete_element` op payload's `prev`
   * (recorded at delete time); `active` when no prior status is recorded.
   */
  readonly originStatus: ElementStatus;
  /** The owning source's title for the "from {source}" line, or `null`. */
  readonly sourceTitle: string | null;
  /**
   * The `batchId` of the latest `soft_delete_element` op for this row (T135 / U8), or
   * `null` for a legacy op written without one. Rows sharing a `batchId` were deleted as
   * one branch and the Trash view groups them under the branch root for a single
   * atomic `restoreBatch`. Read-only display metadata — no behavior depends on it here.
   */
  readonly deleteBatchId: string | null;
}

/** Why a node was skipped by {@link TrashRepository.restoreBatch}. */
export type RestoreSkipReason =
  /** The row is no longer in the trash store (purged) or never existed. */
  | "missing"
  /** The row is already live (a prior restore brought it back). */
  | "not-deleted"
  /** Newer manual intent since the delete (re-deleted under another batch, etc.). */
  | "newer-intent"
  /** Its ancestor (the branch root) was skipped, so it stays a tombstone (no orphan restore). */
  | "ancestor-skipped";

export interface RestoreSkippedRow {
  readonly id: ElementId;
  readonly reason: RestoreSkipReason;
}

/** The outcome of a batch restore (T135 / U5) — surfaces partial/broken chains. */
export interface RestoreBatchResult {
  /** The ids actually restored by this call (root-first). */
  readonly restored: readonly ElementId[];
  /** Nodes left as tombstones (with a reason) — the partial state, surfaced not hidden. */
  readonly skipped: readonly RestoreSkippedRow[];
  /** Whether the branch root itself was restored (false ⇒ the whole branch stayed down). */
  readonly rootRestored: boolean;
  /**
   * The fresh `restore_element` batch id threaded through every restored node's op (T135 /
   * A1), so a follow-up `UndoService.undoLast` reverses the WHOLE restore as one unit.
   * `null` when nothing was restored (so there is no restore-batch to undo).
   */
  readonly batchId: string | null;
}

/**
 * Thrown by {@link TrashRepository.purge} when a tombstone still anchors LIVE
 * descendants (KTD9 / R12). A hard purge would fire the `onDelete: "set null"`
 * self-FKs and null those live rows' lineage links — the exact 0030-wipe
 * mechanism — so it is blocked. Typed so the renderer can present the recovery
 * path (restore the node, or delete the whole branch first).
 */
export class PurgeBlockedByLiveDescendantsError extends Error {
  readonly code = "PURGE_BLOCKED_LIVE_DESCENDANTS" as const;
  constructor(
    readonly elementId: ElementId,
    readonly liveDescendantCount: number,
  ) {
    super(
      `Cannot purge ${elementId}: it still anchors ${liveDescendantCount} live descendant(s). ` +
        "Restore it or delete the whole branch first.",
    );
    this.name = "PurgeBlockedByLiveDescendantsError";
  }
}

export class TrashRepository {
  private readonly elements: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
  }

  /**
   * Every soft-deleted element, newest-deleted first. Joins the owning source's
   * title for the "from {source}" line and reads the prior status from the latest
   * `soft_delete_element` op so restore returns the element to where it was.
   * Read-only — no mutation, no `operation_log`.
   */
  listTrash(): TrashItem[] {
    const rows = this.db
      .select()
      .from(elements)
      .where(isNotNull(elements.deletedAt))
      .orderBy(desc(elements.deletedAt), desc(sql`rowid`))
      .all();

    return rows.map((row) => {
      const element = rowToElement(row);
      const meta = this.latestSoftDeleteMetaFor(element.id);
      return {
        element,
        deletedAt: (element.deletedAt ?? element.updatedAt) as IsoTimestamp,
        originStatus: meta.originStatus,
        sourceTitle: this.sourceTitleFor(element),
        deleteBatchId: meta.batchId,
      };
    });
  }

  /**
   * The prior status + delete `batchId` from the element's MOST-RECENT
   * `soft_delete_element` op. `originStatus` is the `prev.status` payload (what restore
   * returns the element to), defaulting to `active` when none is recorded (e.g. a
   * pre-T044 op) so restore never leaves an invalid state; `batchId` (T135 / U8) groups
   * branch-deleted siblings in the Trash view, `null` for a legacy op without one. One
   * read serves both so the Trash list stays a single pass.
   */
  private latestSoftDeleteMetaFor(id: ElementId): {
    originStatus: ElementStatus;
    batchId: string | null;
  } {
    const op = this.db
      .select()
      .from(operationLog)
      .where(and(eq(operationLog.elementId, id), eq(operationLog.opType, "soft_delete_element")))
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();
    if (!op) return { originStatus: "active", batchId: null };
    let originStatus: ElementStatus = "active";
    let batchId: string | null = null;
    try {
      const payload = JSON.parse(op.payload) as { prev?: { status?: unknown }; batchId?: unknown };
      const prior = payload.prev?.status;
      if (typeof prior === "string" && prior !== "deleted") originStatus = prior as ElementStatus;
      if (typeof payload.batchId === "string" && payload.batchId.length > 0) {
        batchId = payload.batchId;
      }
    } catch {
      // Malformed payload — fall through to the safe defaults.
    }
    return { originStatus, batchId };
  }

  /**
   * Restore a branch-deleted subtree as a UNIT (T135 / U5), the inverse of
   * {@link ExtractService.deleteSubtree}. Finds every `soft_delete_element` op
   * sharing `batchId`, restores ROOT-FIRST, and per node clears `deletedAt`,
   * restores the prior status, and re-establishes the schedule from the recorded
   * preimage (so a restored card returns to the FSRS due queue exactly where it
   * was). Runs in ONE transaction.
   *
   * Two safety rules make a partial state VISIBLE rather than silently broken:
   *  - A node carrying NEWER manual intent since the delete (its latest delete/restore
   *    op is not this batch's soft-delete) is skipped with `newer-intent` — mirrors
   *    `FallowService.unfallow`'s skip-on-changed guard.
   *  - If ANY node is skipped (the root OR a mid-tree intermediate), its descendants are
   *    NOT silently restored under a still-tombstoned ancestor (that would surface an
   *    orphan-looking live node under a deleted parent); they are skipped with
   *    `ancestor-skipped`. We track skips in a `skippedIds` set and, processing
   *    root-first, skip any node whose `parentId` is already skipped. The caller gets
   *    the structured partial result to show.
   *
   * Atomic undo (A1): every `restore_element` op this call writes shares ONE fresh
   * `batchId`, so a follow-up `UndoService.undoLast` reverses the WHOLE restore as one
   * unit (it groups by the most-recent op's `batchId`). Returned in `batchId`.
   *
   * Order independence: callers (the snackbar Undo) pass the announced delete `batchId`,
   * so an intervening logged action never makes this restore the wrong thing (KTD10).
   */
  restoreBatch(deleteBatchId: string): RestoreBatchResult {
    return this.db.transaction((tx) => {
      // The batch's soft-delete ops in INSERTION order (rowid asc) — i.e. root-first,
      // exactly how `softDeleteSubtreeWithin` wrote them (root, then DFS descendants).
      const ops = tx
        .select()
        .from(operationLog)
        .where(
          and(
            eq(operationLog.opType, "soft_delete_element"),
            // Indexed `batch_id` lookup (migration 0041) — was a `json_extract(payload)`
            // scan over every soft_delete_element row. Same result set: the column is
            // dual-written at append time and backfilled for historical rows.
            eq(operationLog.batchId, deleteBatchId),
          ),
        )
        .orderBy(operationLog.createdAt, sql`rowid`)
        .all();

      const restored: ElementId[] = [];
      const skipped: RestoreSkippedRow[] = [];
      // Every id skipped so far (newer-intent / not-deleted / missing / ancestor-skipped).
      // A non-root node is ITSELF skipped when its parent is skipped, propagating the cut
      // through any depth of skipped intermediates — not just the root.
      const skippedIds = new Set<ElementId>();
      let rootRestored = true;
      // One fresh restore batch so undoLast reverses the whole restore atomically (A1).
      const restoreBatchId = newRowId();

      // The id of EVERY node originally in this batch, recovered from the op payload's `id`
      // (which survives even when a purge nulls the `operation_log.element_id` COLUMN). A
      // non-root node whose current `parentId` is NOT one of these had its in-batch parent
      // purged (the FK nulled the link), so it must not be restored as a parentless orphan.
      const batchIds = new Set<ElementId>();
      for (const op of ops) {
        const pid =
          (op.elementId as ElementId | null) ??
          (parsePayload(op.payload).id as ElementId | undefined);
        if (pid) batchIds.add(pid);
      }

      for (let index = 0; index < ops.length; index += 1) {
        const op = ops[index];
        if (!op) continue;
        const payload = parsePayload(op.payload);
        // Recover the element id from the payload when the column was nulled by a purge.
        const id =
          (op.elementId as ElementId | null) ?? (payload.id as ElementId | undefined) ?? null;
        if (!id) continue;
        const isRoot = index === 0;

        const skip = (reason: RestoreSkipReason): void => {
          skipped.push({ id, reason });
          skippedIds.add(id);
          if (isRoot) rootRestored = false;
        };

        const row = tx.select().from(elements).where(eq(elements.id, id)).get();
        // A skipped/lost ANCESTOR cuts the whole subtree below it. A non-root node is
        // ancestor-skipped when its parent is already skipped OR its in-batch parent link is
        // gone (parentId null, or pointing outside the batch because the parent was purged) —
        // either way it must not be restored under a still-tombstoned or vanished parent.
        const parentId = (row?.parentId as ElementId | null) ?? null;
        if (!isRoot && (!parentId || !batchIds.has(parentId) || skippedIds.has(parentId))) {
          skip("ancestor-skipped");
          continue;
        }
        if (!row) {
          skip("missing");
          continue;
        }
        if (!row.deletedAt) {
          skip("not-deleted");
          continue;
        }
        // Newer-intent guard: the row's most-recent delete/restore op must be THIS
        // batch's soft-delete. A newer op (re-deleted under a different batch, or
        // already restored-then-something) means manual intent we must not stomp.
        if (!this.isLatestLifecycleOpWithin(tx, id, deleteBatchId)) {
          skip("newer-intent");
          continue;
        }

        const origin = originStatusFromPayload(payload);
        const schedule = restoreScheduleFromPayload(payload);
        this.elements.restoreWithin(tx, id, origin, {
          batchId: restoreBatchId,
          ...(schedule ? { schedule } : {}),
        });
        restored.push(id);
      }

      return {
        restored,
        skipped,
        rootRestored,
        batchId: restored.length > 0 ? restoreBatchId : null,
      };
    });
  }

  /**
   * Restore ONE tombstone (T135 / U5) — the single-element restore the Trash list's
   * per-row Restore and the inspector tombstone Restore both go through. Unlike a
   * bare {@link ElementRepository.restore}, this re-establishes the schedule from the
   * latest `soft_delete_element` op's preimage (so a restored card returns to the
   * FSRS due queue exactly where it was, not as a stale past-due phantom). Returns
   * the restored element, or `null` when the id is unknown or not in the trash.
   */
  restoreOne(id: ElementId): Element | null {
    return this.db.transaction((tx) => {
      const row = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (!row?.deletedAt) return null;
      const op = tx
        .select()
        .from(operationLog)
        .where(and(eq(operationLog.elementId, id), eq(operationLog.opType, "soft_delete_element")))
        .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
        .limit(1)
        .get();
      const payload = op ? parsePayload(op.payload) : {};
      const origin = originStatusFromPayload(payload);
      const schedule = restoreScheduleFromPayload(payload);
      return this.elements.restoreWithin(tx, id, origin, schedule ? { schedule } : undefined);
    });
  }

  /**
   * Restore the DELETED-ancestor chain of `id` up to the first LIVE ancestor (T135 / A2)
   * — the correct primitive for the inspector's "ancestor deleted" hint and a
   * per-tombstone-node Restore, where naively restoring every tombstone in the lineage
   * would resurrect unrelated sibling/cousin tombstones.
   *
   * Walks `parentId` UPWARD from `id`: collects `id` itself (when it is a tombstone) and
   * every tombstone ancestor, STOPPING at the first live ancestor (a live node, a live
   * root, or a null parent — also the `sourceId` root for a node parented directly by a
   * source). Restores them ROOT-FIRST so a child never momentarily restores under a
   * still-tombstoned parent, each re-establishing its schedule from its recorded preimage.
   * All under ONE shared restore `batchId` (A1 threading), so `UndoService.undoLast`
   * reverses the whole chain restore as one unit. A cycle guard bounds the walk.
   */
  restoreAncestorChain(id: ElementId): { restored: ElementId[]; batchId: string | null } {
    return this.db.transaction((tx) => {
      // Collect the deleted chain bottom-up: `id` (if a tombstone) then each tombstone
      // ANCESTOR, stopping at the first LIVE ancestor. The focused node `id` being LIVE is
      // not a stop — we keep climbing for its deleted ancestors (the "ancestor deleted"
      // hint case: a live card under a deleted middle extract). A node parented directly by
      // a source walks `sourceId` once `parentId` is exhausted, so a deleted source restores.
      const chain: ElementId[] = [];
      const seen = new Set<ElementId>();
      let cursor: ElementId | null = id;
      while (cursor !== null && !seen.has(cursor)) {
        const current: ElementId = cursor;
        seen.add(current);
        const row = tx.select().from(elements).where(eq(elements.id, current)).get();
        if (!row) break; // a missing (purged) node terminates the chain
        const parent: ElementId | null =
          (row.parentId as ElementId | null) ?? (row.sourceId as ElementId | null) ?? null;
        if (row.deletedAt) {
          chain.push(current); // a tombstone (the focused node or an ancestor) restores
          cursor = parent;
        } else if (current === id) {
          cursor = parent; // focused node is live: skip it, keep climbing for deleted ancestors
        } else {
          break; // first LIVE ancestor — attach here, climb no further
        }
      }

      const restored: ElementId[] = [];
      if (chain.length === 0) return { restored, batchId: null };
      const restoreBatchId = newRowId();
      // Root-first: the topmost tombstone is last in the bottom-up `chain`, so reverse it.
      for (const nodeId of chain.reverse()) {
        const op = tx
          .select()
          .from(operationLog)
          .where(
            and(eq(operationLog.elementId, nodeId), eq(operationLog.opType, "soft_delete_element")),
          )
          .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
          .limit(1)
          .get();
        const payload = op ? parsePayload(op.payload) : {};
        const origin = originStatusFromPayload(payload);
        const schedule = restoreScheduleFromPayload(payload);
        this.elements.restoreWithin(tx, nodeId, origin, {
          batchId: restoreBatchId,
          ...(schedule ? { schedule } : {}),
        });
        restored.push(nodeId);
      }
      return { restored, batchId: restoreBatchId };
    });
  }

  /**
   * Whether `id`'s most-recent lifecycle op (soft-delete or restore) is the
   * `soft_delete_element` carrying `batchId`. Used by {@link restoreBatch} to skip
   * nodes that gained newer manual intent after the branch delete (mirrors the
   * fallow restore's "still matches what we set" guard).
   */
  private isLatestLifecycleOpWithin(tx: DbClient, id: ElementId, batchId: string): boolean {
    const latest = tx
      .select()
      .from(operationLog)
      .where(
        and(
          eq(operationLog.elementId, id),
          or(
            eq(operationLog.opType, "soft_delete_element"),
            eq(operationLog.opType, "restore_element"),
          ),
        ),
      )
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();
    if (latest?.opType !== "soft_delete_element") return false;
    const payload = parsePayload(latest.payload);
    return payload.batchId === batchId;
  }

  /**
   * Whether a hard purge of `id` would orphan any LIVE element — i.e. any not-deleted
   * row whose `parentId` OR `sourceId` points at `id` (BOTH are `onDelete: "set null"`
   * self-FKs, so either link would be nulled). Read inside the caller's transaction
   * so the check and the DELETE see one consistent snapshot. This is the KTD9 / R12
   * guard that closes the 0030-wipe mechanism at the hard-delete seam.
   */
  private liveDependentCountWithin(tx: DbClient, id: ElementId): number {
    const rows = tx
      .select({ id: elements.id })
      .from(elements)
      .where(
        and(isNull(elements.deletedAt), or(eq(elements.parentId, id), eq(elements.sourceId, id))),
      )
      .all();
    return rows.length;
  }

  /** The owning source element's title for the "from {source}" line, or `null`. */
  private sourceTitleFor(element: Element): string | null {
    if (element.type === "source") return element.title;
    if (!element.sourceId) return null;
    const src = this.db
      .select({ title: elements.title })
      .from(elements)
      .where(eq(elements.id, element.sourceId))
      .get();
    return src?.title ?? null;
  }

  /**
   * The ONLY hard delete in the app (T044): a real `DELETE` of the element row in
   * one transaction. FK cascades + the FTS5 delete trigger clean up every dependent
   * row; the `operation_log.element_id` FK nulls this element's op rows
   * (`onDelete: set null`) so the append-only log survives. Appends NO op — a purge
   * is irreversible by design. Returns whether a row was removed.
   */
  purge(id: ElementId): boolean {
    return this.db.transaction((tx) => {
      const existing = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (!existing) return false;
      // KTD9 / R12 guard: BLOCK a purge that would null a live element's lineage links
      // (the 0030-wipe mechanism). A typed, user-presentable error so the renderer can
      // offer the recovery path (restore / delete the whole branch first).
      const liveDependents = this.liveDependentCountWithin(tx, id);
      if (liveDependents > 0) {
        throw new PurgeBlockedByLiveDescendantsError(id, liveDependents);
      }
      // The `vec0` `element_vectors` virtual table has NO foreign key to `elements`
      // (a virtual table cannot), so the hard DELETE below does NOT cascade to it.
      // Drop this element's vector rowid first so a purge leaves no orphan vector
      // (no-op on hosts where the vec0 store was never created).
      if (this.vecStoreExists(tx)) this.purgeVectorFor(tx, id);
      tx.delete(elements).where(eq(elements.id, id)).run();
      return true;
    });
  }

  /** Whether the `element_vectors` (vec0) virtual table exists on this connection. */
  // biome-ignore lint/suspicious/noExplicitAny: drizzle tx/db share the raw query surface
  private vecStoreExists(tx: any): boolean {
    return (
      tx.get(
        sql`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'element_vectors'`,
      ) != null
    );
  }

  /**
   * Delete the element's `element_vectors` (vec0) rowid, read from the `embeddings`
   * sidecar BEFORE the element DELETE cascades that sidecar row away. Caller must run
   * inside its transaction and have confirmed the vec0 store exists.
   */
  // biome-ignore lint/suspicious/noExplicitAny: drizzle tx/db share the raw query surface
  private purgeVectorFor(tx: any, id: ElementId): void {
    const emb = tx
      .select({ vecRowid: embeddings.vecRowid })
      .from(embeddings)
      .where(eq(embeddings.elementId, id))
      .get();
    if (!emb) return;
    tx.run(
      sql`DELETE FROM element_vectors WHERE rowid = ${sql.raw(String(Math.trunc(emb.vecRowid)))}`,
    );
  }

  /**
   * Purge EVERY trashed element in ONE transaction (the "Empty trash" action,
   * gated behind explicit UI confirmation). Returns the count purged and the count
   * SKIPPED by the live-descendant guard. Like {@link purge} this appends no op and
   * relies on the same cascades/triggers.
   *
   * KTD9 / R12: a trashed node that still anchors LIVE descendants is SKIPPED (not
   * purged) so Empty Trash can never null a live element's lineage links — the guard
   * runs here too, skip-and-report rather than block-the-whole-empty. The skip is
   * re-evaluated against the LIVE set as purges proceed: if purging a tombstone later
   * removes the live status of nothing (its dependents were themselves tombstones now
   * purged), the anchor stays the one skipped. To keep the guarded anchor genuinely
   * safe we purge only rows with NO live dependents at decision time and leave the
   * rest, so an anchor whose only dependents are also trashed is still skipped — its
   * live-descendant guard is conservative by design (recovery is restore-then-empty).
   */
  emptyTrash(): { purged: number; skipped: number } {
    return this.db.transaction((tx) => {
      const trashed = tx
        .select({ id: elements.id })
        .from(elements)
        .where(isNotNull(elements.deletedAt))
        .all();
      const hasVec = this.vecStoreExists(tx);
      let purged = 0;
      let skipped = 0;
      // Drop each purged element's vec0 vector first (no FK cascade reaches the
      // virtual table) so emptying the trash leaves no orphan vectors. Skip — never
      // block — any row that still anchors live descendants (the 0030-wipe guard).
      for (const row of trashed) {
        const id = row.id as ElementId;
        if (this.liveDependentCountWithin(tx, id) > 0) {
          skipped += 1;
          continue;
        }
        if (hasVec) this.purgeVectorFor(tx, id);
        tx.delete(elements).where(eq(elements.id, id)).run();
        purged += 1;
      }
      return { purged, skipped };
    });
  }
}
