/**
 * ParkedResurfacingService (T102) — the undoable batch action behind the
 * Maintenance parked sweep.
 *
 * The sweep is deliberately small: it revalidates every renderer-provided id
 * against the current parked/due predicate, then routes each surviving decision
 * through the existing `update_element` op with one shared `batchId`. No new
 * status, no new operation type, no hard delete.
 */

import type { ElementId, IsoTimestamp } from "@interleave/core";
import { elements, type InterleaveDatabase } from "@interleave/db";
import { eq } from "drizzle-orm";
import { ElementRepository } from "./element-repository";
import { newRowId, nowIso } from "./ids";
import { isParkedDueForResurfacing } from "./parked-resurfacing-query";

export type ParkedResurfacingDecisionKind = "keepParked" | "queueNow" | "letGo";

export interface ParkedResurfacingDecision {
  readonly id: ElementId;
  readonly kind: ParkedResurfacingDecisionKind;
}

export type ParkedResurfacingSkipReason =
  | "missing"
  | "deleted"
  | "not-source"
  | "not-parked"
  | "not-due";

export interface ParkedResurfacingSkippedDecision {
  readonly id: ElementId;
  readonly reason: ParkedResurfacingSkipReason;
}

export interface ParkedResurfacingApplyOptions {
  readonly decisions: readonly ParkedResurfacingDecision[];
  readonly asOf?: IsoTimestamp;
  readonly resurfaceAfterDays: number;
}

export interface ParkedResurfacingApplyResult {
  readonly applied: number;
  readonly skipped: readonly ParkedResurfacingSkippedDecision[];
  readonly batchId: string | null;
}

export class ParkedResurfacingService {
  private readonly elements: ElementRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
  }

  /**
   * Apply a set of user decisions. Each id is re-read inside the transaction and
   * skipped if the stale UI row is no longer a due parked source.
   */
  apply(options: ParkedResurfacingApplyOptions): ParkedResurfacingApplyResult {
    const asOf = options.asOf ?? nowIso();
    const batchId = newRowId();
    return this.db.transaction((tx) => {
      const skipped: ParkedResurfacingSkippedDecision[] = [];
      let applied = 0;

      for (const decision of options.decisions) {
        const row = tx.select().from(elements).where(eq(elements.id, decision.id)).get();
        const reason = row
          ? row.deletedAt
            ? "deleted"
            : row.type !== "source"
              ? "not-source"
              : row.status !== "parked"
                ? "not-parked"
                : !isParkedDueForResurfacing(
                      row.parkedAt as IsoTimestamp | null,
                      asOf,
                      options.resurfaceAfterDays,
                    )
                  ? "not-due"
                  : null
          : "missing";
        if (reason) {
          skipped.push({ id: decision.id, reason });
          continue;
        }

        const patch =
          decision.kind === "keepParked"
            ? { status: "parked" as const, dueAt: null, parkedAt: asOf }
            : decision.kind === "queueNow"
              ? { status: "scheduled" as const, dueAt: asOf, parkedAt: null }
              : { status: "dismissed" as const, dueAt: null, parkedAt: null };

        this.elements.updateWithin(tx, decision.id, patch, {
          batchId,
          extras: { action: `parkedResurfacing:${decision.kind}` },
        });
        applied += 1;
      }

      return { applied, skipped, batchId: applied > 0 ? batchId : null };
    });
  }
}
