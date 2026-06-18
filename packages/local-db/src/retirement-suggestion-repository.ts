import type { ElementId, IsoTimestamp } from "@interleave/core";
import { elements, type InterleaveDatabase, retirementSuggestionDismissals } from "@interleave/db";
import { type SourceRetirementSuggestion, sourceRetirementSuggestion } from "@interleave/scheduler";
import { eq, inArray } from "drizzle-orm";
import { BlockProcessingService } from "./block-processing-service";
import { nowIso } from "./ids";
import { OperationLogRepository } from "./operation-log-repository";
import type { TransactionClient } from "./types";

export type VisibleSourceRetirementSuggestion = SourceRetirementSuggestion;

export interface DismissRetirementSuggestionResult {
  readonly dismissed: boolean;
  readonly suggestion: VisibleSourceRetirementSuggestion | null;
  readonly stale: boolean;
}

export class RetirementSuggestionRepository {
  private readonly blockProcessing: BlockProcessingService;
  private readonly operationLog: OperationLogRepository;

  constructor(private readonly db: InterleaveDatabase) {
    this.blockProcessing = new BlockProcessingService(db);
    this.operationLog = new OperationLogRepository(db);
  }

  rawForSource(sourceElementId: ElementId): VisibleSourceRetirementSuggestion | null {
    const source = this.db
      .select({
        id: elements.id,
        type: elements.type,
        deletedAt: elements.deletedAt,
      })
      .from(elements)
      .where(eq(elements.id, sourceElementId))
      .get();
    if (!source || source.deletedAt || source.type !== "source") return null;

    const summary = this.blockProcessing.getSourceProcessingSummary(sourceElementId);
    return sourceRetirementSuggestion({
      sourceId: sourceElementId,
      totalBlocks: summary.totalBlocks,
      terminalBlocks: summary.terminalBlocks,
      ignoredBlocks: summary.ignoredBlocks,
      unresolvedBlocks: summary.unresolvedBlocks,
      unresolvedRatio:
        summary.totalBlocks === 0 ? 0 : summary.unresolvedBlocks / summary.totalBlocks,
      terminalRatio: summary.terminalRatio,
      ignoredRatio: summary.ignoredRatio,
      extractedOutputCount: summary.extractedOutputCount,
    });
  }

  visibleForSource(sourceElementId: ElementId): VisibleSourceRetirementSuggestion | null {
    const suggestion = this.rawForSource(sourceElementId);
    if (!suggestion) return null;
    const dismissal = this.db
      .select()
      .from(retirementSuggestionDismissals)
      .where(eq(retirementSuggestionDismissals.sourceElementId, sourceElementId))
      .get();
    if (dismissal?.signalHash === suggestion.signalHash) return null;
    return suggestion;
  }

  /**
   * Batched twin of {@link visibleForSource}: resolve the visible retirement suggestion
   * for many SOURCE element ids, returning `Map<ElementId, VisibleSourceRetirementSuggestion>`
   * with entries ONLY for the sources that currently have a non-dismissed suggestion (a
   * source with no suggestion, or whose suggestion is dismissed, is absent — mirroring
   * `visibleForSource` returning `null`). Empty `ids` → empty map.
   *
   * Used by {@link QueueQuery.summaryForMany} (U1) so the batched inventory rows carry the
   * SAME `retirementSuggestion` the single-row `summaryFor` resolves, instead of the
   * `list()` `BatchContext` hardcoded `null` (which is valid only for the due-only path).
   * The per-source signal still derives from `rawForSource` (the block-processing rollup is
   * inherently per-source), but the dismissal lookup is batched into ONE
   * `inArray` read folded per source.
   */
  visibleForSourceMany(
    ids: readonly ElementId[],
  ): Map<ElementId, VisibleSourceRetirementSuggestion> {
    const result = new Map<ElementId, VisibleSourceRetirementSuggestion>();
    if (ids.length === 0) return result;

    // Batch the dismissal lookup (one IN read for all ids).
    const dismissalHash = new Map<ElementId, string>();
    for (const row of this.db
      .select()
      .from(retirementSuggestionDismissals)
      .where(inArray(retirementSuggestionDismissals.sourceElementId, ids as ElementId[]))
      .all()) {
      dismissalHash.set(row.sourceElementId as ElementId, row.signalHash);
    }

    // Batch the element-type guard: only live source elements can have a suggestion.
    const liveSourceIds = new Set<ElementId>(
      this.db
        .select({ id: elements.id, type: elements.type, deletedAt: elements.deletedAt })
        .from(elements)
        .where(inArray(elements.id, ids as ElementId[]))
        .all()
        .filter((row) => !row.deletedAt && row.type === "source")
        .map((row) => row.id as ElementId),
    );

    // One batched block-processing read for all live sources (replaces per-source
    // getSourceProcessingSummary calls — the stale-tolerant batched primitive always
    // returns an entry for every id so the ?? zero-summary fallback is never needed).
    const summaryBySource = this.blockProcessing.getSourceProcessingSummaryForMany([
      ...liveSourceIds,
    ]);

    for (const id of ids) {
      if (!liveSourceIds.has(id)) continue;
      const summary = summaryBySource.get(id);
      if (!summary) continue;

      // Replicate rawForSource's suggestion logic using the batched summary.
      const suggestion = sourceRetirementSuggestion({
        sourceId: id,
        totalBlocks: summary.totalBlocks,
        terminalBlocks: summary.terminalBlocks,
        ignoredBlocks: summary.ignoredBlocks,
        unresolvedBlocks: summary.unresolvedBlocks,
        unresolvedRatio:
          summary.totalBlocks === 0 ? 0 : summary.unresolvedBlocks / summary.totalBlocks,
        terminalRatio: summary.terminalRatio,
        ignoredRatio: summary.ignoredRatio,
        extractedOutputCount: summary.extractedOutputCount,
      });

      if (!suggestion) continue;
      if (dismissalHash.get(id) === suggestion.signalHash) continue;
      result.set(id, suggestion);
    }
    return result;
  }

  dismiss(
    sourceElementId: ElementId,
    signalHash: string,
    now: IsoTimestamp = nowIso(),
  ): DismissRetirementSuggestionResult {
    const current = this.rawForSource(sourceElementId);
    if (!current || current.signalHash !== signalHash) {
      return { dismissed: false, suggestion: current, stale: true };
    }

    this.db.transaction((tx) => {
      this.upsertDismissalWithin(tx, sourceElementId, signalHash, now);
      this.operationLog.append(tx, {
        opType: "update_element",
        elementId: sourceElementId,
        payload: {
          id: sourceElementId,
          retirementSuggestionDismissed: {
            kind: current.kind,
            signalHash,
          },
        },
      });
    });

    return { dismissed: true, suggestion: null, stale: false };
  }

  private upsertDismissalWithin(
    tx: TransactionClient,
    sourceElementId: ElementId,
    signalHash: string,
    dismissedAt: IsoTimestamp,
  ): void {
    tx.insert(retirementSuggestionDismissals)
      .values({ sourceElementId, signalHash, dismissedAt })
      .onConflictDoUpdate({
        target: retirementSuggestionDismissals.sourceElementId,
        set: { signalHash, dismissedAt },
      })
      .run();
  }
}
