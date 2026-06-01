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

export {
  type AnalyticsOptions,
  AnalyticsService,
  type AnalyticsSummary,
  type BalanceOptions,
  type BalanceSummary,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  DEFAULT_BALANCE_WINDOW_DAYS,
  type ReviewsByDay,
} from "./analytics-query";
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
  type ConceptNode,
  ConceptRepository,
  type ConceptSummary,
  type CreateConceptInput,
} from "./concept-repository";
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
  type OpContext,
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
  LIBRARY_STATUSES,
  LIBRARY_TYPES,
  type LibraryBrowseCounts,
  type LibraryBrowseData,
  type LibraryBrowseFilters,
  type LibraryPriorityLabel,
  LibraryQuery,
} from "./library-query";
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
export {
  type SearchableType,
  type SearchHit,
  type SearchOptions,
  type SearchQueryOptions,
  SearchRepository,
  toMatchExpression,
} from "./search-repository";
export { SettingsRepository } from "./settings-repository";
export {
  SourceDedupQuery,
  type SourceDuplicateMatch,
  type SourceDuplicateMatchKind,
} from "./source-dedup-query";
export { deriveSourceLocationLabel, type LabelBlock } from "./source-location-label";
export { resolveSourceRef } from "./source-ref-query";
export {
  type CreateExtractInput,
  type CreateSourceInput,
  type CreateSourceWithDocumentInput,
  type ExtractWithLocation,
  SourceRepository,
  type SourceWithDocument,
  type SourceWithElement,
} from "./source-repository";
export { type TrashItem, TrashRepository } from "./trash-query";
export type { DbClient, TransactionClient } from "./types";
export { type UndoResult, UndoService } from "./undo-service";

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
  readonly concepts: import("./concept-repository").ConceptRepository;
  readonly assets: import("./asset-repository").AssetRepository;
  readonly settings: import("./settings-repository").SettingsRepository;
  readonly operationLog: import("./operation-log-repository").OperationLogRepository;
  /** The Trash view's read + terminal hard-delete (T044). */
  readonly trash: import("./trash-query").TrashRepository;
  /** The system-wide analytics aggregation (T045) — read-only. */
  readonly analytics: import("./analytics-query").AnalyticsService;
  /** Duplicate-detection lookups for URL import (T061) — read-only. */
  readonly sourceDedup: import("./source-dedup-query").SourceDedupQuery;
}

import type { InterleaveDatabase } from "@interleave/db";
import { AnalyticsService } from "./analytics-query";
import { AssetRepository } from "./asset-repository";
import { ConceptRepository } from "./concept-repository";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { QueueRepository } from "./queue-repository";
import { ReviewRepository } from "./review-repository";
import { SearchRepository } from "./search-repository";
import { SettingsRepository } from "./settings-repository";
import { SourceDedupQuery } from "./source-dedup-query";
import { SourceRepository } from "./source-repository";
import { TrashRepository } from "./trash-query";

/**
 * Build all repositories against one Drizzle client. Called by the Electron
 * main/DB service after it opens + migrates the database.
 */
export function createRepositories(db: InterleaveDatabase): Repositories {
  const assets = new AssetRepository(db);
  return {
    elements: new ElementRepository(db),
    documents: new DocumentRepository(db),
    sources: new SourceRepository(db),
    review: new ReviewRepository(db),
    queue: new QueueRepository(db),
    search: new SearchRepository(db),
    concepts: new ConceptRepository(db),
    assets,
    settings: new SettingsRepository(db),
    operationLog: new OperationLogRepository(db),
    trash: new TrashRepository(db),
    analytics: new AnalyticsService(db),
    sourceDedup: new SourceDedupQuery(db, assets),
  };
}
