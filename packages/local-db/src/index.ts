/**
 * @interleave/local-db — the persistence/domain seam (T008).
 *
 * This package is the ONLY place the app reads/writes SQLite. It sits behind the
 * Electron/IPC boundary: the Electron main/DB service constructs these
 * repositories against the `@interleave/db` client and exposes a narrow typed
 * `window.appApi` over validated IPC. The renderer never imports this package and
 * never touches SQL or the filesystem directly (the layering rule in CLAUDE.md).
 *
 * Invariants this package owns:
 *  - Every meaningful mutation appends a command-shaped `operation_log` row INSIDE
 *    the same transaction as the mutation (backup/audit/undo/sync build on it).
 *  - Multi-table domain operations run in a single SQLite transaction.
 *  - Soft-delete (`deleted_at`) semantics — user data is never destroyed.
 *  - Stable, domain-generated ids (never SQLite autoincrement) preserve lineage.
 *
 * The nine repositories below cover the M1 surface; domain services
 * (`SchedulerService`, `ExtractionService`, …) compose them in later milestones.
 */

export { AssetRepository, type CreateAssetInput } from "./asset-repository";
export {
  type CardEditResult,
  CardEditService,
  type UpdateCardBodyInput,
} from "./card-edit-service";
export {
  CardService,
  type CreateCardFromExtractInput,
  type CreateCardResult,
} from "./card-service";
export {
  type AddMarkInput,
  type DocumentBlockInput,
  type DocumentMark,
  DocumentRepository,
  type ReadPointInput,
  type UpsertDocumentInput,
} from "./document-repository";
export {
  type AddRelationInput,
  type CreateElementInput,
  ElementRepository,
  type UpdateElementInput,
} from "./element-repository";
export {
  EXTRACT_STAGES,
  type ExtractActionResult,
  ExtractService,
  type ExtractStage,
  extractStageIntervalDays,
  isExtractStage,
  nextExtractStage,
  postponeIntervalDays,
  type RewriteExtractInput,
  trimExtractText,
} from "./extract-service";
export {
  type CreateExtractionInput,
  type ExtractionResult,
  ExtractionService,
  rawExtractIntervalDays,
} from "./extraction-service";
export { newElementId, newRowId, newSiblingGroupId, nowIso } from "./ids";
export {
  type InboxItemDetail,
  type InboxItemSummary,
  type InboxProvenance,
  InboxQuery,
} from "./inbox-query";
export {
  type ElementSummary,
  type InspectorData,
  InspectorQuery,
  type LineageItem,
  type LocationSummary,
  type ReviewSummary,
  type SchedulerSignals,
  type SourceProvenance,
  schedulerKindForType,
} from "./inspector-query";
export {
  type LineageData,
  type LineageNode,
  LineageQuery,
} from "./lineage-query";
export {
  type AppendOpInput,
  OperationLogRepository,
} from "./operation-log-repository";
export {
  CARD_DEFER_DAYS,
  type QueueActionKind,
  type QueueActionResult,
  QueueActionService,
  type QueueActionUndo,
} from "./queue-action-service";
export {
  type QueueDueState,
  type QueueFilters,
  type QueueItemSummary,
  type QueueListData,
  QueueQuery,
  type QueueScheduler,
  type QueueSchedulerSignals,
} from "./queue-query";
export { QueueRepository } from "./queue-repository";
export {
  type CardWithElement,
  type CreateCardInput,
  type LeechCard,
  type ReviewOutcome,
  ReviewRepository,
} from "./review-repository";
export {
  type NextReviewCard,
  type NextReviewCardInput,
  ReviewSessionService,
} from "./review-session-service";
export { type ScheduleResult, SchedulerService } from "./scheduler-service";
export { type SearchOptions, SearchRepository } from "./search-repository";
export { SettingsRepository } from "./settings-repository";
export { deriveSourceLocationLabel, type LabelBlock } from "./source-location-label";
export {
  type CreateExtractInput,
  type CreateSourceInput,
  type CreateSourceWithDocumentInput,
  type ExtractWithLocation,
  SourceRepository,
  type SourceWithDocument,
  type SourceWithElement,
} from "./source-repository";
export type { DbClient, TransactionClient } from "./types";

/**
 * A bag of all nine repositories bound to one Drizzle client. The Electron DB
 * service constructs this once per open database and routes IPC commands to it.
 */
export interface Repositories {
  readonly elements: import("./element-repository").ElementRepository;
  readonly documents: import("./document-repository").DocumentRepository;
  readonly sources: import("./source-repository").SourceRepository;
  readonly review: import("./review-repository").ReviewRepository;
  readonly queue: import("./queue-repository").QueueRepository;
  readonly search: import("./search-repository").SearchRepository;
  readonly assets: import("./asset-repository").AssetRepository;
  readonly settings: import("./settings-repository").SettingsRepository;
  readonly operationLog: import("./operation-log-repository").OperationLogRepository;
}

import type { InterleaveDatabase } from "@interleave/db";
import { AssetRepository } from "./asset-repository";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { QueueRepository } from "./queue-repository";
import { ReviewRepository } from "./review-repository";
import { SearchRepository } from "./search-repository";
import { SettingsRepository } from "./settings-repository";
import { SourceRepository } from "./source-repository";

/**
 * Build all nine repositories against one Drizzle client. Called by the Electron
 * main/DB service after it opens + migrates the database.
 */
export function createRepositories(db: InterleaveDatabase): Repositories {
  return {
    elements: new ElementRepository(db),
    documents: new DocumentRepository(db),
    sources: new SourceRepository(db),
    review: new ReviewRepository(db),
    queue: new QueueRepository(db),
    search: new SearchRepository(db),
    assets: new AssetRepository(db),
    settings: new SettingsRepository(db),
    operationLog: new OperationLogRepository(db),
  };
}
