/**
 * ChronicPostponeService (T106) — undoable reckoning decisions.
 *
 * Applies keep / demote / done / delete decisions for rows surfaced by
 * ChronicPostponeQuery. Every renderer-provided id is revalidated inside the
 * transaction; stale rows are skipped instead of failing the batch. Applied rows
 * share one `batchId`, so `UndoService.undoLast` reverses the whole batch.
 */

import type { ElementId, ElementStatus } from "@interleave/core";
import { lowerPriority } from "@interleave/core";
import { cards, elements, type InterleaveDatabase, reviewStates } from "@interleave/db";
import { eq } from "drizzle-orm";
import { BlockProcessingService } from "./block-processing-service";
import { CHRONIC_POSTPONE_TYPES } from "./chronic-postpone-query";
import { ElementRepository } from "./element-repository";
import { newRowId } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import { isQueueActionableStatus } from "./queue-repository";
import type { DbClient } from "./types";

export type ChronicPostponeDecisionKind = "keep" | "demote" | "done" | "delete";

export interface ChronicPostponeDecision {
  readonly id: ElementId;
  readonly kind: ChronicPostponeDecisionKind;
}

export type ChronicPostponeSkipReason =
  | "missing"
  | "deleted"
  | "unsupported-type"
  | "not-actionable"
  | "retired-card"
  | "below-threshold"
  | "already-lowest"
  | "source-unresolved-blocks";

export interface ChronicPostponeSkippedDecision {
  readonly id: ElementId;
  readonly reason: ChronicPostponeSkipReason;
}

export interface ChronicPostponeApplyOptions {
  readonly decisions: readonly ChronicPostponeDecision[];
  readonly threshold: number;
}

export interface ChronicPostponeApplyResult {
  readonly applied: number;
  readonly skipped: readonly ChronicPostponeSkippedDecision[];
  readonly batchId: string | null;
}

type SupportedType = (typeof CHRONIC_POSTPONE_TYPES)[number];

export class ChronicPostponeService {
  private readonly elements: ElementRepository;
  private readonly blockProcessing: BlockProcessingService;

  constructor(private readonly db: InterleaveDatabase) {
    this.elements = new ElementRepository(db);
    this.blockProcessing = new BlockProcessingService(db);
  }

  apply(options: ChronicPostponeApplyOptions): ChronicPostponeApplyResult {
    const threshold = normalizeThreshold(options.threshold);
    const batchId = newRowId();
    return this.db.transaction((tx) => {
      const skipped: ChronicPostponeSkippedDecision[] = [];
      let applied = 0;

      for (const decision of options.decisions) {
        const validation = this.validateWithin(tx, decision.id, threshold);
        if (validation.reason) {
          skipped.push({ id: decision.id, reason: validation.reason });
          continue;
        }
        if (!validation.row) {
          skipped.push({ id: decision.id, reason: "missing" });
          continue;
        }

        switch (decision.kind) {
          case "keep":
            this.appendResetMarkerWithin(
              tx,
              decision.id,
              validation.postponeCount,
              batchId,
              "keep",
            );
            break;
          case "demote":
            if (lowerPriority(validation.row.priority) === validation.row.priority) {
              skipped.push({ id: decision.id, reason: "already-lowest" });
              continue;
            }
            this.elements.updateWithin(
              tx,
              decision.id,
              { priority: lowerPriority(validation.row.priority) },
              { batchId, extras: { action: "chronicPostpone:demote" } },
            );
            this.appendResetMarkerWithin(
              tx,
              decision.id,
              validation.postponeCount,
              batchId,
              "demote",
            );
            break;
          case "done":
            if (
              validation.row.type === "source" &&
              !this.blockProcessing.getDoneGate(decision.id).canMarkDone
            ) {
              skipped.push({ id: decision.id, reason: "source-unresolved-blocks" });
              continue;
            }
            this.markDoneWithin(tx, decision.id, validation.row.type as SupportedType, batchId);
            break;
          case "delete":
            this.elements.softDeleteWithin(tx, decision.id, { batchId });
            break;
        }
        applied += 1;
      }

      return { applied, skipped, batchId: applied > 0 ? batchId : null };
    });
  }

  private validateWithin(
    tx: DbClient,
    id: ElementId,
    threshold: number,
  ): {
    readonly row: ValidationRow | null;
    readonly postponeCount: number;
    readonly reason: ChronicPostponeSkipReason | null;
  } {
    const row = tx
      .select({
        id: elements.id,
        type: elements.type,
        status: elements.status,
        priority: elements.priority,
        deletedAt: elements.deletedAt,
      })
      .from(elements)
      .where(eq(elements.id, id))
      .get() as ValidationRow | undefined;
    if (!row) return { row: null, postponeCount: 0, reason: "missing" };
    if (row.deletedAt) return { row, postponeCount: 0, reason: "deleted" };
    if (!isSupportedType(row.type)) return { row, postponeCount: 0, reason: "unsupported-type" };
    if (!isQueueActionableStatus(row.status as ElementStatus)) {
      return { row, postponeCount: 0, reason: "not-actionable" };
    }
    if (row.type === "card" && this.isRetiredCardWithin(tx, id)) {
      return { row, postponeCount: 0, reason: "retired-card" };
    }
    const postponeCount = new OperationLogRepository(tx).countPostpones(id);
    if (postponeCount < threshold) return { row, postponeCount, reason: "below-threshold" };
    return { row, postponeCount, reason: null };
  }

  private isRetiredCardWithin(tx: DbClient, id: ElementId): boolean {
    return (
      tx.select({ isRetired: cards.isRetired }).from(cards).where(eq(cards.elementId, id)).get()
        ?.isRetired === true
    );
  }

  private markDoneWithin(tx: DbClient, id: ElementId, type: SupportedType, batchId: string): void {
    const previousReviewDueAt =
      type === "card"
        ? (tx
            .select({ dueAt: reviewStates.dueAt })
            .from(reviewStates)
            .where(eq(reviewStates.elementId, id))
            .get()?.dueAt ?? null)
        : undefined;
    if (type === "card") {
      tx.update(reviewStates).set({ dueAt: null }).where(eq(reviewStates.elementId, id)).run();
    }
    this.elements.updateWithin(
      tx,
      id,
      { status: "done", dueAt: null },
      {
        batchId,
        extras: {
          action: "chronicPostpone:done",
          ...(previousReviewDueAt !== undefined ? { prevReviewDueAt: previousReviewDueAt } : {}),
          ...(type === "card" ? { queueExit: true } : {}),
        },
      },
    );
  }

  private appendResetMarkerWithin(
    tx: DbClient,
    id: ElementId,
    prevEffectivePostponeCount: number,
    batchId: string,
    decision: "keep" | "demote",
  ): void {
    new OperationLogRepository(tx).append(tx, {
      opType: "update_element",
      elementId: id,
      payload: {
        id,
        action: `chronicPostpone:${decision}`,
        decision,
        chronicPostponeReset: true,
        prevEffectivePostponeCount,
        batchId,
      },
    });
  }
}

interface ValidationRow {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly priority: number;
  readonly deletedAt: string | null;
}

function normalizeThreshold(threshold: number): number {
  return Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : 1;
}

function isSupportedType(type: string): type is SupportedType {
  return (CHRONIC_POSTPONE_TYPES as readonly string[]).includes(type);
}
