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
  type AiGroundingLocation,
  type AiSuggestion,
  type AiSuggestionGrounding,
  AiSuggestionRepository,
  type CreateAiSuggestionInput,
} from "./ai-suggestion-repository";
export {
  type AnalyticsOptions,
  AnalyticsService,
  type AnalyticsSummary,
  type BalanceOptions,
  type BalanceSummary,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  DEFAULT_BALANCE_WINDOW_DAYS,
  type ReviewActivityDay,
  type ReviewActivityOptions,
  type ReviewActivitySummary,
  type ReviewsByDay,
} from "./analytics-query";
export { AssetRepository, type CreateAssetInput } from "./asset-repository";
export {
  AUTO_POSTPONE_CARD_DEFER_DAYS,
  type AutoPostponeApplyResult,
  type AutoPostponePreview,
  AutoPostponeService,
  type PostponePreviewRow,
} from "./auto-postpone-service";
export {
  BlockProcessingRepository,
  type LiveBlockOutput,
  type SourceBlockProcessingRow,
} from "./block-processing-repository";
export {
  BlockProcessingService,
  computeBlockContentHashes,
  type DeriveExtractionInput,
  type DoneGateResult,
  type MarkBlockInput,
} from "./block-processing-service";
export {
  type BulkActionResult,
  BulkActionService,
  type BulkArchiveMode,
} from "./bulk-action-service";
export {
  type CardBodyForKind,
  type CardEditResult,
  CardEditService,
  cardRowToLifetime,
  resolveCardBodyForKind,
  type UpdateCardBodyInput,
  type UpdateCardLifetimeInput,
} from "./card-edit-service";
export {
  type AddContextResult,
  type BackToExtractResult,
  type CardRemediationPart,
  CardRemediationService,
  type SplitLeechCardInput,
  type SplitLeechCardResult,
} from "./card-remediation-service";
export {
  type CardRetirementResult,
  CardRetirementService,
  type RetireCardInput,
  type RetiredCard,
} from "./card-retirement-service";
export {
  CardService,
  type CreateCardFromExtractInput,
  type CreateCardResult,
} from "./card-service";
export {
  CHRONIC_POSTPONE_TYPES,
  type ChronicPostponeElementRef,
  type ChronicPostponeListOptions,
  type ChronicPostponeListResult,
  ChronicPostponeQuery,
  type ChronicPostponeRow,
} from "./chronic-postpone-query";
export {
  type ChronicPostponeApplyOptions,
  type ChronicPostponeApplyResult,
  type ChronicPostponeDecision,
  type ChronicPostponeDecisionKind,
  ChronicPostponeService,
  type ChronicPostponeSkippedDecision,
  type ChronicPostponeSkipReason,
} from "./chronic-postpone-service";
export {
  type ConceptNode,
  ConceptRepository,
  type ConceptSummary,
  type CreateConceptInput,
} from "./concept-repository";
export {
  DailyWorkQuery,
  type DailyWorkRecommendedAction,
  type DailyWorkResumeSource,
  type DailyWorkSummary,
} from "./daily-work-query";
export {
  DEFAULT_DEDUP_CLUSTER_LIMIT,
  type DedupReportOptions,
  DedupReportQuery,
  type DuplicateCluster,
  type DuplicateMatchKind,
  type DuplicateRef,
  type DuplicateReport,
  normalizeContentKey,
  pickContentKeeper,
  pickSourceKeeper,
} from "./dedup-report-query";
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
  type EmbeddableType,
  type Embedding,
  EmbeddingRepository,
  type EmbeddingStats,
  type KnnHit,
  type KnnOptions,
  type UpsertEmbeddingInput,
} from "./embedding-repository";
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
  DEFAULT_EXTRACT_STAGNATION_LIMIT,
  type ExtractStagnationOptions,
  ExtractStagnationQuery,
  type ExtractStagnationSummary,
  type StagnantExtractRef,
  type StagnantExtractRow,
} from "./extract-stagnation-query";
export {
  type CreateClipExtractInput,
  type CreateExtractionInput,
  type CreateRegionExtractInput,
  type ExtractionResult,
  ExtractionService,
  rawExtractIntervalDays,
} from "./extraction-service";
export {
  FALLOW_REASON_MAX,
  type FallowApplyResult,
  FallowService,
  type FallowSkippedRow,
  type FallowSkipReason,
  type FallowTopicOptions,
  type FallowTopicWithinOptions,
  type UnfallowTopicOptions,
} from "./fallow-service";
export {
  newAssetId,
  newBlockId,
  newElementId,
  newJobId,
  newRowId,
  newSiblingGroupId,
  nowIso,
} from "./ids";
export {
  type InboxItemDetail,
  type InboxItemSummary,
  type InboxProvenance,
  InboxQuery,
  inboxSourceTypeLabel,
} from "./inbox-query";
export {
  type ElementSummary,
  type FactLifetimeSummary,
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
  DEFAULT_MAX_ATTEMPTS,
  type EnqueueJobInput,
  type JobListFilter,
  JobsRepository,
  rowToJob,
} from "./jobs-repository";
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
  type BrokenSourceCandidate,
  DEFAULT_LINEAGE_GAP_LIMIT,
  DEFAULT_LOW_VALUE_STALE_DAYS,
  type GapElementRef,
  LineageGapQuery,
  type LineageGapRow,
  type LowValueOptions,
  type LowValueRow,
  type SourceSnapshotAsset,
} from "./lineage-gap-query";
export {
  type LineageData,
  type LineageNode,
  LineageQuery,
} from "./lineage-query";
export {
  type OcclusionMask,
  type OcclusionMaskInput,
  OcclusionMasksRepository,
} from "./occlusion-masks-repository";
export {
  type GeneratedOcclusionCard,
  type GenerateOcclusionInput,
  type GenerateOcclusionResult,
  type OcclusionMaskRequest,
  OcclusionService,
} from "./occlusion-service";
export {
  type OcrPage,
  OcrPagesRepository,
  type OcrPageWord,
  type UpsertOcrPageInput,
} from "./ocr-pages-repository";
export {
  type AppendOpInput,
  OperationLogRepository,
} from "./operation-log-repository";
export {
  HEAVY_FIT_REVIEW_THRESHOLD,
  type OptimizationScope,
  OptimizationService,
  type OptimizationSuggestionWithWorkload,
  type WorkloadDay,
  type WorkloadImpact,
} from "./optimization-service";
export {
  isParkedDueForResurfacing,
  type ParkedResurfacingListOptions,
  type ParkedResurfacingListResult,
  ParkedResurfacingQuery,
  type ParkedResurfacingRow,
  parkedResurfacingCutoff,
} from "./parked-resurfacing-query";
export {
  type ParkedResurfacingApplyOptions,
  type ParkedResurfacingApplyResult,
  type ParkedResurfacingDecision,
  type ParkedResurfacingDecisionKind,
  ParkedResurfacingService,
  type ParkedResurfacingSkippedDecision,
  type ParkedResurfacingSkipReason,
} from "./parked-resurfacing-service";
export {
  A_BAND_SHARE_WARN_THRESHOLD,
  DEFAULT_PRIORITY_INTEGRITY_SACRIFICED_LIMIT,
  DEFAULT_PRIORITY_INTEGRITY_TOPIC_LIMIT,
  DEFAULT_PRIORITY_INTEGRITY_WINDOW_DAYS,
  POSTPONE_DEBT_HIGH_DAYS,
  type PriorityIntegrityBandSummary,
  type PriorityIntegrityOptions,
  PriorityIntegrityQuery,
  type PriorityIntegritySacrificedRow,
  type PriorityIntegritySummary,
  type PriorityIntegrityThresholdFlags,
  type PriorityIntegrityTopicSummary,
} from "./priority-integrity-query";
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
export {
  isQueueActionableStatus,
  QUEUE_EXCLUDED_STATUSES,
  QueueRepository,
} from "./queue-repository";
export {
  type CatchUpPreview,
  DEFAULT_CATCHUP_SPREAD_DAYS,
  MAX_CATCHUP_SPREAD_DAYS,
  MIN_CATCHUP_SPREAD_DAYS,
  type RecoveryApplyResult,
  RecoveryModeService,
  type VacationPreview,
} from "./recovery-mode-service";
export {
  DUPLICATE_DISTANCE_THRESHOLD,
  distanceToSimilarity,
  type RelatedConcept,
  type RelatedItem,
  type RelatedOptions,
  type RelatedResult,
  RelatedService,
} from "./related-service";
export { type RetentionCardResult, RetentionService } from "./retention-service";
export {
  type DismissRetirementSuggestionResult,
  RetirementSuggestionRepository,
  type VisibleSourceRetirementSuggestion,
} from "./retirement-suggestion-repository";
export {
  type ReviewModeCount,
  type ReviewModeDeck,
  ReviewModeService,
  type SemanticResolveContext,
} from "./review-mode-service";
export {
  type CardWithElement,
  type CreateCardInput,
  type LeechCard,
  type ReviewOutcome,
  ReviewRepository,
  type ReviewStateSeed,
  type SiblingCardBody,
} from "./review-repository";
export {
  type NextReviewCard,
  type NextReviewCardInput,
  ReviewSessionService,
} from "./review-session-service";
export {
  SchedulerConsistencyQuery,
  type SchedulerConsistencyReason,
  type SchedulerConsistencyRow,
} from "./scheduler-consistency-query";
export { type ScheduleResult, SchedulerService } from "./scheduler-service";
export {
  emptySearchFacetCounts,
  foldSearchFacetCounts,
  type SearchableType,
  type SearchFacetCountFilters,
  type SearchFacetCountMatch,
  type SearchFacetCountOptions,
  type SearchFacetCounts,
  type SearchHit,
  type SearchOptions,
  type SearchQueryOptions,
  SearchRepository,
  toMatchExpression,
} from "./search-repository";
export {
  type FusedHit,
  type FusedSearchOptions,
  type FusedSearchResult,
  RRF_K,
  SemanticSearchRepository,
} from "./semantic-search-repository";
export { SettingsRepository } from "./settings-repository";
export {
  SourceDedupQuery,
  type SourceDuplicateMatch,
  type SourceDuplicateMatchKind,
} from "./source-dedup-query";
export {
  deriveClipLabel,
  deriveSourceLocationLabel,
  type LabelBlock,
} from "./source-location-label";
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
export {
  DEFAULT_SOURCE_YIELD_LIMIT,
  type SourceYieldOptions,
  SourceYieldQuery,
  type SourceYieldRow,
  type SourceYieldSourceRef,
  type SourceYieldSummary,
} from "./source-yield-query";
export {
  type CreateSynthesisInput,
  type EditSynthesisBodyInput,
  SYNTHESIS_STAGE,
  type SynthesisBlockInput,
  type SynthesisCreateResult,
  type SynthesisData,
  type SynthesisLinkedElement,
  type SynthesisLinkResult,
  SynthesisService,
} from "./synthesis-service";
export {
  type CreateTaskInput,
  type GenerateVerificationResult,
  TASK_STAGE,
  TaskService,
  type TaskSummary,
} from "./task-service";
export {
  DEFAULT_TOPIC_KNOWLEDGE_STATE_LIMIT,
  KNOWLEDGE_GRADUATION_MATURE_RATIO,
  KNOWLEDGE_GRADUATION_MIN_CARDS,
  KNOWLEDGE_GRADUATION_MIN_REVIEWS,
  KNOWLEDGE_GRADUATION_NEAR_RATIO,
  KNOWLEDGE_RETENTION_TARGET_TOLERANCE,
  KNOWLEDGE_STATE_SNAPSHOT_COUNT,
  KNOWLEDGE_STATE_WINDOW_DAYS,
  KNOWLEDGE_YOUNG_STABILITY_MAX_DAYS,
  type KnowledgeFunnel,
  type KnowledgeGraduationEvent,
  type KnowledgeGraduationState,
  type KnowledgeRetentionSnapshot,
  type KnowledgeRetentionTrend,
  type KnowledgeStabilityBuckets,
  type KnowledgeStaleness,
  type TopicKnowledgeGraduationStatus,
  type TopicKnowledgeStateOptions,
  TopicKnowledgeStateQuery,
  type TopicKnowledgeStateSubject,
  type TopicKnowledgeStateSubjectType,
  type TopicKnowledgeStateSummary,
} from "./topic-knowledge-state-query";
export { type TrashItem, TrashRepository } from "./trash-query";
export type { DbClient, TransactionClient } from "./types";
export { type UndoResult, UndoService } from "./undo-service";
export { WorkloadService, type WorkloadSimulateOptions } from "./workload-service";

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
  /** Durable per-source-block processing state and output links. */
  readonly blockProcessing: import("./block-processing-repository").BlockProcessingRepository;
  /** The Trash view's read + terminal hard-delete (T044). */
  readonly trash: import("./trash-query").TrashRepository;
  /** The system-wide analytics aggregation (T045) — read-only. */
  readonly analytics: import("./analytics-query").AnalyticsService;
  /** Duplicate-detection lookups for URL import (T061) — read-only. */
  readonly sourceDedup: import("./source-dedup-query").SourceDedupQuery;
  /**
   * The collection-wide duplicate ROLLUP (T099) — duplicate source/card/extract
   * CLUSTERS for the Maintenance view. Read-only, NO op-log, never auto-merges.
   */
  readonly dedupReport: import("./dedup-report-query").DedupReportQuery;
  /**
   * The lineage / value scans (T099) — cards-without-sources, broken-source
   * candidates, and low-value-stale candidates for the Maintenance view. Read-only,
   * NO op-log; SURFACES gaps, never auto-deletes (lineage is sacred).
   */
  readonly lineageGap: import("./lineage-gap-query").LineageGapQuery;
  /**
   * The thin BULK cleanup wrappers (T099) — `bulkSoftDelete` / `bulkArchive` /
   * `bulkPostpone`, each minting ONE `batchId` so the whole sweep undoes as one
   * (T044). Routes through the EXISTING per-item write paths; no new op/status.
   */
  readonly bulkActions: import("./bulk-action-service").BulkActionService;
  /** The persisted background-runner job queue (T058) — main-runner-only. */
  readonly jobs: import("./jobs-repository").JobsRepository;
  /** The reviewable per-page OCR layer (T066) — the recognized-text suggestion store. */
  readonly ocrPages: import("./ocr-pages-repository").OcrPagesRepository;
  /** The image-occlusion masks store (T071) — vector masks kept separate from the base image. */
  readonly occlusionMasks: import("./occlusion-masks-repository").OcclusionMasksRepository;
  /** The per-source yield rollup (T083) — read %, extracts/cards/mature/leeches/time, ranked. */
  readonly sourceYield: import("./source-yield-query").SourceYieldQuery;
  /** The extract-stagnation scan (T084) — extracts that keep returning without progressing. */
  readonly extractStagnation: import("./extract-stagnation-query").ExtractStagnationQuery;
  /** Scheduler drift diagnostics: stale due rows that are hidden from the Queue. */
  readonly schedulerConsistency: import("./scheduler-consistency-query").SchedulerConsistencyQuery;
  /** Due parked sources that should resurface in Maintenance (T102). Read-only. */
  readonly parkedResurfacingQuery: import("./parked-resurfacing-query").ParkedResurfacingQuery;
  /**
   * The undoable parked resurfacing decision batch (T102) — existing `update_element`,
   * one `batchId`, revalidated before write.
   */
  readonly parkedResurfacing: import("./parked-resurfacing-service").ParkedResurfacingService;
  /** Priority-fidelity read model (T105): serviced/deferred/debt by band/topic. Read-only. */
  readonly priorityIntegrity: import("./priority-integrity-query").PriorityIntegrityQuery;
  /** Topic/concept maturity receipts (T108): current funnel, retention, and graduation state. */
  readonly topicKnowledgeState: import("./topic-knowledge-state-query").TopicKnowledgeStateQuery;
  /** Chronic-postpone reckoning list (T106). Read-only, folded from operation-log markers. */
  readonly chronicPostpone: import("./chronic-postpone-query").ChronicPostponeQuery;
  /** Undoable chronic-postpone keep/demote/done/delete batches (T106). */
  readonly chronicPostponeService: import("./chronic-postpone-service").ChronicPostponeService;
  /** Deliberate topic rest (T107): attention-only fallow/unfallow batches. */
  readonly fallow: import("./fallow-service").FallowService;
  /** Dismissible source retirement nudges (T103) — visible signal + op-logged dismissal. */
  readonly retirementSuggestions: import("./retirement-suggestion-repository").RetirementSuggestionRepository;
  /** The on-device semantic-search vector store (T087) — `sqlite-vec` KNN, NO op-log. */
  readonly embeddings: import("./embedding-repository").EmbeddingRepository;
  /** The FTS+vec fusion layer (T087) — fuses keyword + semantic hits, FTS-only degrade. */
  readonly semanticSearch: import("./semantic-search-repository").SemanticSearchRepository;
  /**
   * The DERIVED related-item suggestions (T088) — similar extracts / possible
   * duplicates / prerequisite concepts / sibling sources over the `vec0` store +
   * the concept lineage. NO op-log, NO new relation types — a read-only surface.
   */
  readonly related: import("./related-service").RelatedService;
  /**
   * Verification tasks (T092) — create / schedule / complete / postpone `task`-type
   * elements, and generate them from T090 expiry. Attention-scheduled (never FSRS); a
   * task + its `references` link is created in one transaction (`create_element` +
   * `add_relation`); generation is idempotent + priority-inherited.
   */
  readonly tasks: import("./task-service").TaskService;
  /**
   * The AI-suggestion DRAFT layer (T093/T094) — inert `ai_suggestions` rows the
   * on-device AI runner produces. NO op-log (a transient draft/infra artifact, like a
   * `jobs`/`ocr_pages` row); grounding stored separately from the model output.
   */
  readonly aiSuggestions: import("./ai-suggestion-repository").AiSuggestionRepository;
  /**
   * Incremental writing / synthesis notes (T095) — create / link / unlink / edit body /
   * schedule-return for the EXISTING `synthesis_note` element type. Collects extracts/
   * cards via `references` edges; returns on the ATTENTION scheduler (never FSRS). No
   * new table, no new op type, no new element type — reuses the element/document/
   * relation/attention substrate.
   */
  readonly synthesis: import("./synthesis-service").SynthesisService;
}

import type { InterleaveDatabase } from "@interleave/db";
import { AiSuggestionRepository } from "./ai-suggestion-repository";
import { AnalyticsService } from "./analytics-query";
import { AssetRepository } from "./asset-repository";
import { BlockProcessingRepository } from "./block-processing-repository";
import { BulkActionService } from "./bulk-action-service";
import { ChronicPostponeQuery } from "./chronic-postpone-query";
import { ChronicPostponeService } from "./chronic-postpone-service";
import { ConceptRepository } from "./concept-repository";
import { DedupReportQuery } from "./dedup-report-query";
import { DocumentRepository } from "./document-repository";
import { ElementRepository } from "./element-repository";
import { EmbeddingRepository } from "./embedding-repository";
import { ExtractStagnationQuery } from "./extract-stagnation-query";
import { FallowService } from "./fallow-service";
import { JobsRepository } from "./jobs-repository";
import { LineageGapQuery } from "./lineage-gap-query";
import { OcclusionMasksRepository } from "./occlusion-masks-repository";
import { OcrPagesRepository } from "./ocr-pages-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { ParkedResurfacingQuery } from "./parked-resurfacing-query";
import { ParkedResurfacingService } from "./parked-resurfacing-service";
import { PriorityIntegrityQuery } from "./priority-integrity-query";
import { QueueRepository } from "./queue-repository";
import { RelatedService } from "./related-service";
import { RetirementSuggestionRepository } from "./retirement-suggestion-repository";
import { ReviewRepository } from "./review-repository";
import { SchedulerConsistencyQuery } from "./scheduler-consistency-query";
import { SearchRepository } from "./search-repository";
import { SemanticSearchRepository } from "./semantic-search-repository";
import { SettingsRepository } from "./settings-repository";
import { SourceDedupQuery } from "./source-dedup-query";
import { resolveSourceRef } from "./source-ref-query";
import { SourceRepository } from "./source-repository";
import { SourceYieldQuery } from "./source-yield-query";
import { SynthesisService } from "./synthesis-service";
import { TaskService } from "./task-service";
import { TopicKnowledgeStateQuery } from "./topic-knowledge-state-query";
import { TrashRepository } from "./trash-query";

/** Options for {@link createRepositories}. */
export interface CreateRepositoriesOptions {
  /**
   * Whether `sqlite-vec` `vec0` is loaded AND functional on this connection
   * (T087) — the caller passes `vecFunctional(sqlite)` (the functional smoke test,
   * not mere resolvability). Threaded into the `EmbeddingRepository` so it knows
   * whether the `element_vectors` table exists; when `false`, KNN returns `[]` and
   * embed upserts no-op, so search degrades cleanly to FTS-only. Default `false`.
   */
  readonly vecAvailable?: boolean;
}

/**
 * Build all repositories against one Drizzle client. Called by the Electron
 * main/DB service after it opens + migrates the database. `options.vecAvailable`
 * gates the semantic-search store (T087); omit it (or pass `false`) and the
 * embedding repo is dormant (FTS-only).
 */
export function createRepositories(
  db: InterleaveDatabase,
  options: CreateRepositoriesOptions = {},
): Repositories {
  const assets = new AssetRepository(db);
  const search = new SearchRepository(db);
  const embeddings = new EmbeddingRepository(db, options.vecAvailable ?? false);
  const elements = new ElementRepository(db);
  const concepts = new ConceptRepository(db);
  const repos: Repositories = {
    elements,
    documents: new DocumentRepository(db),
    sources: new SourceRepository(db),
    review: new ReviewRepository(db),
    queue: new QueueRepository(db),
    search,
    concepts,
    assets,
    settings: new SettingsRepository(db),
    operationLog: new OperationLogRepository(db),
    blockProcessing: new BlockProcessingRepository(db),
    trash: new TrashRepository(db),
    analytics: new AnalyticsService(db),
    sourceDedup: new SourceDedupQuery(db, assets),
    dedupReport: new DedupReportQuery(db, assets),
    lineageGap: new LineageGapQuery(db),
    bulkActions: new BulkActionService(db),
    jobs: new JobsRepository(db),
    ocrPages: new OcrPagesRepository(db),
    occlusionMasks: new OcclusionMasksRepository(db),
    sourceYield: new SourceYieldQuery(db),
    extractStagnation: new ExtractStagnationQuery(db),
    schedulerConsistency: new SchedulerConsistencyQuery(db),
    parkedResurfacingQuery: new ParkedResurfacingQuery(db),
    parkedResurfacing: new ParkedResurfacingService(db),
    priorityIntegrity: new PriorityIntegrityQuery(db),
    topicKnowledgeState: new TopicKnowledgeStateQuery(db),
    chronicPostpone: new ChronicPostponeQuery(db),
    chronicPostponeService: new ChronicPostponeService(db),
    fallow: new FallowService(db),
    retirementSuggestions: new RetirementSuggestionRepository(db),
    embeddings,
    semanticSearch: new SemanticSearchRepository(search, embeddings),
    tasks: new TaskService(db),
    aiSuggestions: new AiSuggestionRepository(db),
    synthesis: new SynthesisService(db),
    // Built last: it resolves an item's refblock through the SAME `resolveSourceRef`
    // the inspector/review/library use (needs the assembled repos), so it captures
    // `repos` for the lazy ref resolution. It is a DERIVED read — no op-log.
    related: undefined as unknown as RelatedService,
  };
  (repos as { related: RelatedService }).related = new RelatedService({
    elements,
    concepts,
    embeddings,
    resolveRef: (id) => resolveSourceRef(repos, id),
  });
  return repos;
}
