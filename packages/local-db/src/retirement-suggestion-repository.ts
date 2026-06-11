import type { ElementId, IsoTimestamp } from "@interleave/core";
import { elements, type InterleaveDatabase, retirementSuggestionDismissals } from "@interleave/db";
import { type SourceRetirementSuggestion, sourceRetirementSuggestion } from "@interleave/scheduler";
import { eq } from "drizzle-orm";
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
