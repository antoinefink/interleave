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
import { elements, type InterleaveDatabase, operationLog } from "@interleave/db";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { rowToElement } from "./mappers";

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
}

export class TrashRepository {
  constructor(private readonly db: InterleaveDatabase) {}

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
      return {
        element,
        deletedAt: (element.deletedAt ?? element.updatedAt) as IsoTimestamp,
        originStatus: this.originStatusFor(element.id),
        sourceTitle: this.sourceTitleFor(element),
      };
    });
  }

  /**
   * The status the element had BEFORE its most-recent soft-delete, from that op's
   * `prev.status` payload. Defaults to `active` when no prior status is recorded
   * (e.g. an op written before the T044 payload enrichment) so restore never
   * leaves the element in an invalid state.
   */
  private originStatusFor(id: ElementId): ElementStatus {
    const op = this.db
      .select()
      .from(operationLog)
      .where(and(eq(operationLog.elementId, id), eq(operationLog.opType, "soft_delete_element")))
      .orderBy(desc(operationLog.createdAt), desc(sql`rowid`))
      .limit(1)
      .get();
    if (!op) return "active";
    try {
      const payload = JSON.parse(op.payload) as { prev?: { status?: unknown } };
      const prior = payload.prev?.status;
      if (typeof prior === "string" && prior !== "deleted") return prior as ElementStatus;
    } catch {
      // Malformed payload — fall through to the safe default.
    }
    return "active";
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
      tx.delete(elements).where(eq(elements.id, id)).run();
      return true;
    });
  }

  /**
   * Purge EVERY trashed element in ONE transaction (the "Empty trash" action,
   * gated behind explicit UI confirmation). Returns the count purged. Like
   * {@link purge} this appends no op and relies on the same cascades/triggers.
   */
  emptyTrash(): { purged: number } {
    return this.db.transaction((tx) => {
      const trashed = tx
        .select({ id: elements.id })
        .from(elements)
        .where(isNotNull(elements.deletedAt))
        .all();
      for (const row of trashed) {
        tx.delete(elements).where(eq(elements.id, row.id)).run();
      }
      return { purged: trashed.length };
    });
  }
}
