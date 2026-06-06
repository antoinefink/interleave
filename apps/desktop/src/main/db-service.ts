/**
 * Native SQLite DB service (T007) — the Electron main-process owner of the local
 * database. It is the only place the DB file is opened; the renderer reaches it
 * solely through validated IPC (never directly).
 *
 * Responsibilities for M1:
 *  - open `app.sqlite` via `@interleave/db` (`better-sqlite3` + the mandatory
 *    pragmas: `foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`),
 *  - run the generated Drizzle migrations on startup (explicit + safe for prod),
 *  - serve `db.getStatus()` and the `settings.get/update` surface.
 *
 * The full repository layer (`packages/local-db`, with the operation-log append
 * and transactional multi-table mutations) is constructed here on open (T008):
 * the renderer reaches it only through validated IPC, never directly. The narrow
 * settings surface routes through `SettingsRepository` so all data access flows
 * through the repository seam.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import type {
  BlockId,
  CardKind,
  ElementId,
  ElementStatus,
  IsoTimestamp,
  JobJsonValue,
  MarkType,
  MediaRef,
  Priority,
  PriorityLabel,
  ReviewLog,
  ReviewRating,
  ReviewState,
  SiblingGroupId,
  SourceLocationId,
} from "@interleave/core";
import {
  canonicalizeUrl,
  deriveExpiryStatus,
  type FactLifetime,
  lowerPriority,
  parseMediaRef,
  priorityFromLabel,
  priorityToLabel,
  projectToRendererSettings,
  raisePriority,
} from "@interleave/core";
import {
  type DbHandle,
  elements,
  loadVectorExtension,
  migrateDatabase,
  openDatabase,
  vecFunctional,
} from "@interleave/db";
import { parseYouTubeId } from "@interleave/importers";
import {
  SchedulerService as AttentionScheduleService,
  AutoPostponeService,
  CardEditService,
  CardRemediationService,
  CardRetirementService,
  CardService,
  cardRowToLifetime,
  createRepositories,
  type DocumentMark,
  ExtractionService,
  ExtractService,
  ExtractStagnationQuery,
  foldSearchFacetCounts,
  HEAVY_FIT_REVIEW_THRESHOLD,
  InboxQuery,
  InspectorQuery,
  inboxSourceTypeLabel,
  type LibraryBrowseFilters,
  LibraryQuery,
  LineageQuery,
  nowIso,
  OcclusionService,
  type OptimizationScope,
  OptimizationService,
  type OptimizationSuggestionWithWorkload,
  QueueActionService,
  QueueQuery,
  RecoveryModeService,
  type RelatedItem,
  type RelatedResult,
  type Repositories,
  RetentionService,
  ReviewModeService,
  type ReviewOutcome,
  ReviewSessionService,
  resolveSourceRef,
  type SemanticResolveContext,
  SourceYieldQuery,
  type SynthesisData,
  type SynthesisLinkedElement,
  UndoService,
  WorkloadService,
} from "@interleave/local-db";
import {
  CardSchedulerService,
  type IntervalPreview,
  type OptimizationSuggestionParts,
  optimizationSuggestionFromParts,
  type WorkloadChange,
} from "@interleave/scheduler";
import {
  CI_SCALE_PROFILE,
  type LargeSeedStats,
  type MaintenanceCollection,
  seedDemoCollection,
  seedLargeCollection,
  seedMaintenanceCollection,
} from "@interleave/testing";
import { eq } from "drizzle-orm";
import type {
  AiApproveRequest,
  AiApproveResult,
  AiDismissRequest,
  AiDismissResult,
  AiListRequest,
  AiListResult,
  AiRunRequest,
  AiRunResult,
  AiStatusResult,
  AnalyticsGetRequest,
  AnalyticsGetResult,
  AutoPostponeApplyResult,
  AutoPostponePreview,
  BalanceGetRequest,
  BalanceGetResult,
  CardEditSummary,
  CardsAddContextRequest,
  CardsAddContextResult,
  CardsBackToExtractRequest,
  CardsBackToExtractResult,
  CardsCreateRequest,
  CardsCreateResult,
  CardsDeleteRequest,
  CardsDeleteResult,
  CardsFlagRequest,
  CardsFlagResult,
  CardsGenerateOcclusionRequest,
  CardsGenerateOcclusionResult,
  CardsMarkLeechRequest,
  CardsMarkLeechResult,
  CardsRetiredResult,
  CardsRetireRequest,
  CardsRetireResult,
  CardsSetLifetimeRequest,
  CardsSetLifetimeResult,
  CardsSiblingAnswersRequest,
  CardsSiblingAnswersResult,
  CardsSplitRequest,
  CardsSplitResult,
  CardsSuspendRequest,
  CardsSuspendResult,
  CardsUnretireRequest,
  CardsUnretireResult,
  CardsUpdateRequest,
  CardsUpdateResult,
  CatchUpPreview,
  ConceptMemberSummary,
  ConceptsAssignRequest,
  ConceptsAssignResult,
  ConceptsCreateRequest,
  ConceptsCreateResult,
  ConceptsListResult,
  ConceptsMembersRequest,
  ConceptsMembersResult,
  ConceptsUnassignRequest,
  ConceptsUnassignResult,
  DbStatus,
  DocumentMarkPayload,
  DocumentMarksAddRequest,
  DocumentMarksAddResult,
  DocumentMarksListRequest,
  DocumentMarksListResult,
  DocumentMarksRemoveRequest,
  DocumentMarksRemoveResult,
  DocumentsGetRequest,
  DocumentsGetResult,
  DocumentsSaveRequest,
  DocumentsSaveResult,
  ElementOrganizeState,
  ElementsSetPriorityRequest,
  ElementsSetPriorityResult,
  ExtractActionSummary,
  ExtractionCreateRequest,
  ExtractionCreateResult,
  ExtractStagnationListRequest,
  ExtractStagnationListResult,
  ExtractsDeleteRequest,
  ExtractsDeleteResult,
  ExtractsMarkDoneRequest,
  ExtractsMarkDoneResult,
  ExtractsPostponeRequest,
  ExtractsPostponeResult,
  ExtractsRewriteRequest,
  ExtractsRewriteResult,
  ExtractsUpdateStageRequest,
  ExtractsUpdateStageResult,
  FactLifetimeSummary,
  InboxGetResult,
  InboxItemSummary,
  InboxListResult,
  InboxTriageRequest,
  InboxTriageResult,
  InspectorGetResult,
  InspectorListResult,
  LeechSummary,
  LibraryBrowseRequest,
  LibraryBrowseResult,
  LibraryItem,
  LineageGetResult,
  LocationSummary,
  OptimizationApplyRequest,
  OptimizationApplyResult,
  OptimizationSuggestRequest,
  OptimizationSuggestResult,
  QueueActRequest,
  QueueActResult,
  QueueAutoPostponeRequest,
  QueueCatchUpRequest,
  QueueListRequest,
  QueueListResult,
  QueueScheduleRequest,
  QueueScheduleResult,
  QueueUndoRequest,
  QueueUndoResult,
  QueueVacationRequest,
  ReadPointGetRequest,
  ReadPointGetResult,
  ReadPointSetRequest,
  ReadPointSetResult,
  RecoveryApplyResult,
  RetentionGetResult,
  RetentionResolveForRequest,
  RetentionResolveForResult,
  RetentionSetBandEnabledRequest,
  RetentionSetBandRequest,
  RetentionSetCardRequest,
  RetentionSetCardResult,
  RetentionSetConceptRequest,
  RetentionSetConceptResult,
  RetentionUpdatedResult,
  RetiredCardSummary,
  ReviewCardRequest,
  ReviewCardResult,
  ReviewCardView,
  ReviewGradeRequest,
  ReviewGradeResult,
  ReviewLeechesResult,
  ReviewModeCountRequest,
  ReviewModeCountResult,
  ReviewModeDeckRequest,
  ReviewModeDeckResult,
  ReviewPreviewRequest,
  ReviewPreviewResult,
  ReviewSessionNextRequest,
  ReviewSessionNextResult,
  SearchableType,
  SearchQueryRequest,
  SearchQueryResult,
  SearchResult,
  SemanticContradictionsRequest,
  SemanticContradictionsResult,
  SemanticReindexRequest,
  SemanticReindexResult,
  SemanticRelatedItem,
  SemanticRelatedRequest,
  SemanticRelatedResult,
  SemanticSearchMode,
  SemanticSearchRequest,
  SemanticSearchResult,
  SemanticSearchResultRow,
  SemanticStatusResult,
  SettingsGetAllResult,
  SettingsGetResult,
  SettingsUpdateManyResult,
  SettingsUpdateResult,
  SettingValue,
  SourcesAcceptOcrRequest,
  SourcesAcceptOcrResult,
  SourcesExtractClipRequest,
  SourcesExtractClipResult,
  SourcesExtractRegionRequest,
  SourcesExtractRegionResult,
  SourcesGetMediaDataRequest,
  SourcesGetMediaDataResult,
  SourcesGetOcrRequest,
  SourcesGetOcrResult,
  SourcesGetPdfDataRequest,
  SourcesGetPdfDataResult,
  SourcesGetRegionImageRequest,
  SourcesGetRegionImageResult,
  SourcesImportEpubResult,
  SourcesImportManualRequest,
  SourcesImportManualResult,
  SourcesImportMediaResult,
  SourcesImportPdfResult,
  SourcesRunOcrRequest,
  SourcesRunOcrResult,
  SourcesUpdateReliabilityRequest,
  SourcesUpdateReliabilityResult,
  SourceYieldListRequest,
  SourceYieldListResult,
  SynthesisCreateRequest,
  SynthesisCreateResultView,
  SynthesisDataView,
  SynthesisEditBodyRequest,
  SynthesisEditBodyResult,
  SynthesisGetRequest,
  SynthesisGetResult,
  SynthesisLinkedView,
  SynthesisLinkRequest,
  SynthesisLinkResultView,
  SynthesisScheduleReturnRequest,
  SynthesisScheduleReturnResult,
  SynthesisUnlinkRequest,
  TagsAddRequest,
  TagsAddResult,
  TagsListResult,
  TagsRemoveRequest,
  TagsRemoveResult,
  TasksCompleteRequest,
  TasksCompleteResult,
  TasksCreateRequest,
  TasksCreateResult,
  TasksGenerateFromExpiryRequest,
  TasksGenerateFromExpiryResult,
  TasksListRequest,
  TasksListResult,
  TasksPostponeRequest,
  TasksPostponeResult,
  TrashEmptyResult,
  TrashListResult,
  TrashPurgeRequest,
  TrashPurgeResult,
  TrashRestoreRequest,
  TrashRestoreResult,
  UndoLastResult,
  VacationPreview,
  VaultCollectOrphansRequest,
  VaultCollectOrphansResult,
  VaultOrphansResult,
  VaultVerifyResult,
  WorkloadSimulateRequest,
  WorkloadSimulateResult,
} from "../shared/contract";
import { AiService } from "./ai-service";
import {
  type AnkiExportFileResult,
  type AnkiExportSelection,
  AnkiExportService,
} from "./anki-export-service";
import { type AnkiImportResult, AnkiImportService } from "./anki-import-service";
import {
  AssetVaultService,
  type OrphanReport,
  type VaultIntegrityReport,
} from "./asset-vault-service";
import { type BackupCounts, resolveSchemaVersion } from "./backup-manifest";
import {
  CAPTURE_ALLOWED_ORIGIN_KEY,
  CAPTURE_ENABLED_KEY,
  CAPTURE_PORT_KEY,
  CAPTURE_TOKEN_KEY,
} from "./capture-pairing";
import { ContradictionService } from "./contradiction-service";
import {
  type DocumentImportResult,
  DocumentImportService,
  type MarkdownExportResult,
} from "./document-import-service";
import { EmbeddingService } from "./embedding-service";
import { EpubImportService } from "./epub-import-service";
import { type HighlightImportResult, HighlightImportService } from "./highlight-import-service";
import type { JobRunner } from "./job-runner";
import {
  type BrokenSourceRow,
  type IntegrityReport,
  type MaintenanceBatchResult,
  type MaintenanceDuplicateReport,
  type MaintenanceReport,
  MaintenanceService,
} from "./maintenance-service";
import { MediaClipService } from "./media-clip-service";
import { MediaImportService } from "./media-import-service";
import { OcrService } from "./ocr-service";
import { PdfImportService } from "./pdf-import-service";
import { PdfRegionService } from "./pdf-region-service";
import { UrlImportService } from "./url-import-service";

/**
 * Capture-server pairing keys ({@link CAPTURE_TOKEN_KEY} et al.) are
 * capture-internal plumbing, NOT user-facing app settings. They reach the
 * trusted renderer ONLY via the explicit `capture.getPairing()` path, so the
 * generic no-key `settings.get()` dump must NOT surface them — otherwise the
 * raw settings table would leak the pairing secret. The typed `settings.getAll()`
 * surface already drops them (unknown keys); this set keeps the raw key/value
 * read consistent with that isolation.
 */
const CAPTURE_SETTING_KEYS: ReadonlySet<string> = new Set([
  CAPTURE_TOKEN_KEY,
  CAPTURE_ENABLED_KEY,
  CAPTURE_PORT_KEY,
  CAPTURE_ALLOWED_ORIGIN_KEY,
]);

export class DbService {
  private handle: DbHandle | null = null;
  private repositories: Repositories | null = null;
  private inspector: InspectorQuery | null = null;
  private lineage: LineageQuery | null = null;
  private queue: QueueQuery | null = null;
  private library: LibraryQuery | null = null;
  /** The per-source yield rollup (T083) — read %, extracts/cards/mature/leeches/time, ranked. */
  private sourceYield: SourceYieldQuery | null = null;
  /** The extract-stagnation scan (T084) — extracts that keep returning without progressing. */
  private extractStagnation: ExtractStagnationQuery | null = null;
  private inboxQuery: InboxQuery | null = null;
  private queueAction: QueueActionService | null = null;
  /** The overload AUTO-POSTPONE apply seam (T077) — preview + apply, one `batchId` per sweep. */
  private autoPostpone: AutoPostponeService | null = null;
  /** The CATCH-UP & VACATION apply seam (T078) — previewed, reversible, one `batchId` per plan. */
  private recoveryMode: RecoveryModeService | null = null;
  private extraction: ExtractionService | null = null;
  private extractReview: ExtractService | null = null;
  private cardService: CardService | null = null;
  private occlusionService: OcclusionService | null = null;
  private cardEditService: CardEditService | null = null;
  /**
   * Leech remediation seam (T085) — the three new compositions (split / add-context /
   * back-to-extract) the remediation screen drives. Each is one transaction + the
   * correct EXISTING op; only back-to-extract touches the attention scheduler.
   */
  private cardRemediationService: CardRemediationService | null = null;
  /**
   * Mature-card retirement seam (T082) — flips the durable `cards.is_retired` flag
   * (reversible, non-destructive) so a low-value mature card leaves active review,
   * and reads the retired inventory. Card-only (FSRS); the flag is the sole source of
   * truth for "skip in the due/review reads".
   */
  private cardRetirementService: CardRetirementService | null = null;
  private reviewSession: ReviewSessionService | null = null;
  /**
   * The targeted review-mode SELECTION seam (T096) — resolves a chosen card SUBSET
   * (concept/source/branch/search/semantic/stale/leech/random) OUTSIDE normal
   * scheduling (it ignores `review_states.due_at`). Read-only: it never mutates and
   * appends nothing to the operation log — grading reuses the unchanged `review.grade`
   * path. Constructed once per open DB (like {@link reviewSession}).
   */
  private reviewMode: ReviewModeService | null = null;
  /**
   * The retention RESOLVER seam (T079) — assembles the live {@link RetentionTargets}
   * (settings bands + per-concept targets) and resolves a card's effective FSRS target,
   * and writes the per-card override. The per-card scheduler factory + the `retention.*`
   * IPC route through this. Card-only (the attention scheduler is untouched).
   */
  private retention: RetentionService | null = null;
  /**
   * The FSRS parameter-optimization seam (T080) — replays `review_logs` to SUGGEST
   * (never auto-apply) a better global/per-concept parameter set with a workload
   * preview, and APPLIES an accepted set to the queryable store
   * (`fsrs.params.global` setting / `concepts.fsrs_params` column) that
   * {@link schedulerForCard} reads. Card-only (FSRS), read-only until `apply`.
   */
  private optimization: OptimizationService | null = null;
  /**
   * The workload-simulation seam (T081) — a READ-ONLY pure projection over the live
   * `review_states` + due dates that previews how daily load shifts from altering
   * desired retention / adding cards / postponing low-priority material BEFORE the user
   * commits. Mutates nothing (no due date / setting / op). Shares the projector engine
   * with the T080 optimization workload preview.
   */
  private workload: WorkloadService | null = null;
  /**
   * The per-card FSRS scheduler CACHE (T079), keyed by ROUNDED resolved retention so we
   * build at most ~one `CardSchedulerService` per distinct target (not per card). A
   * settings/target write bumps {@link schedulerCacheGen}, which clears this so the next
   * grade/preview re-resolves against the new targets. Replaces the single T036 scheduler.
   */
  private schedulerCache: Map<string, CardSchedulerService> | null = null;
  /** Cache generation — bumped on a retention write to invalidate {@link schedulerCache}. */
  private schedulerCacheGen = 0;
  /**
   * The ATTENTION-scheduler APPLY seam (T028) — explicit tomorrow / next-week /
   * next-month / manual scheduling for non-card attention items, distinct from the
   * FSRS `scheduler` above (the two-scheduler split). Reachable from the renderer
   * via `queue.schedule`.
   */
  private attentionScheduler: AttentionScheduleService | null = null;
  private undoService: UndoService | null = null;
  /**
   * The URL-import orchestrator (T060) — fetch + Readability + sanitize + vault
   * snapshot + atomic source insert. Built lazily (it needs the vault `assetsDir`,
   * injected at open() time) so a contract-only test that never imports a URL can
   * still open the DB. The SAME built instance is shared by the IPC handler AND
   * M13's loopback capture server (via the {@link urlImportService} accessor).
   */
  private urlImport: UrlImportService | null = null;
  /**
   * The asset-vault scaling service (T059) — streamed write+hash, content-hash
   * dedup, integrity verify, and file-centric orphan GC. Built lazily on first read
   * (it needs the vault `assetsDir`, injected at open()), so a contract-only test
   * that never touches the vault can still open the DB.
   */
  private assetVault: AssetVaultService | null = null;
  /**
   * The Maintenance composer (T099) — the read-only reports + cleanup actions behind
   * the Maintenance view. Built lazily on first read; it composes THIS `DbService` (so
   * it shares the open DB, repos, vault, and integrity pragmas).
   */
  private maintenance: MaintenanceService | null = null;
  /**
   * The PDF-import orchestrator (T064) — read + validate + stream the original PDF
   * into the vault + parse + create an `inbox` source. Built lazily on first read
   * (it needs `assetsDir` + the `assetVaultService`, both available after open()).
   */
  private pdfImport: PdfImportService | null = null;
  /**
   * The EPUB-import orchestrator (T067) — read + validate + stream `original.epub`
   * into the vault + parse the book + create an `inbox` book source + chapter topics
   * in one transaction. Built lazily on first read (it needs `assetsDir`, after open()).
   */
  private epubImport: EpubImportService | null = null;
  /**
   * The media-import orchestrator (T073) — stream a local video/audio file into the
   * vault + parse an optional transcript, OR fetch a YouTube URL's metadata/captions
   * on-device (no bytes downloaded), creating an `inbox` source either way. Built
   * lazily on first read (it needs `assetsDir` + the `assetVaultService` + the URL
   * fetch impl, all available after open()).
   */
  private mediaImport: MediaImportService | null = null;
  /**
   * The Markdown/HTML document-import + Markdown-export orchestrator (T068) — parse a
   * local `.md`/`.html` (or pasted Markdown) into an `inbox` source, and serialize a
   * stored document back to a `.md` in the `exports/` vault. Built lazily on first
   * read (Markdown import needs no vault; HTML import + export need `assetsDir`/
   * `exportsDir`, injected at open()).
   */
  private documentImport: DocumentImportService | null = null;
  /**
   * The highlight-import orchestrator (T069) — parse a Readwise/Kindle export into
   * inbox `extract`s grouped under one `source` per book/article (NEVER cards). Built
   * lazily on first read (it needs no vault — highlights are text).
   */
  private highlightImport: HighlightImportService | null = null;
  /**
   * The Anki `.apkg` import orchestrator (T070) — unwrap the ZIP + open the embedded
   * `collection.anki2` (better-sqlite3) + author the notes as `card` elements under a
   * per-deck `source`, preserving review history when available. Built lazily on first
   * read (it needs the vault `assetsDir` + the `nativeBinding`).
   */
  private ankiImport: AnkiImportService | null = null;
  /**
   * The Anki `.apkg`/CSV export orchestrator (T070) — build an Anki-importable file in
   * `exports/`, carrying source refs OUT. Built lazily (it needs `exportsDir` + the
   * `nativeBinding` to write the embedded collection).
   */
  private ankiExport: AnkiExportService | null = null;
  /**
   * The PDF region-extract orchestrator (T065) — crop a figure/table region into a
   * scheduled `media_fragment` extract (vault image + page+region source location).
   * Built lazily (it needs the extraction service + the `assetVaultService`).
   */
  private pdfRegion: PdfRegionService | null = null;
  /**
   * The media clip-extract orchestrator (T074) — clip a video/audio span into a
   * scheduled `media_fragment` (start timestamp + clip window source location). Built
   * lazily (it needs the extraction service); asset-free (the clip references the
   * original media — no re-encoding).
   */
  private mediaClip: MediaClipService | null = null;
  /**
   * The OCR orchestrator (T066) — write the page PNG to the vault + enqueue the
   * `ocr` job; apply the worker result into `ocr_pages` + the durable vault json;
   * accept OCR text into the body. Built lazily (it needs the vault + the runner).
   */
  private ocr: OcrService | null = null;
  /**
   * The semantic-embedding service (T087), built lazily against the open DB + the
   * runner. UPSERTs worker-computed vectors into the `sqlite-vec` store and embeds
   * search queries. Left `null` until first use.
   */
  private embedding: EmbeddingService | null = null;
  /**
   * The AI-assisted-distillation service (T093), built lazily against the open DB + the
   * runner + the settings repo. Persists the worker's suggestion into the
   * `ai_suggestions` draft layer + mints parked card drafts on approve. `null` until first use.
   */
  private ai: AiService | null = null;
  /**
   * The contradiction-detection service (T089), built lazily against the open DB.
   * A DERIVED, HEURISTIC, SUGGESTIVE read over the `vec0` neighbors + the `sources`
   * provenance dates (via lineage) — it writes nothing. Left `null` until first use.
   */
  private contradiction: ContradictionService | null = null;
  /**
   * Whether `sqlite-vec` `vec0` is loaded AND functional on this connection (T087) —
   * set at open() from the FUNCTIONAL smoke test (`vecFunctional`), NOT from
   * `loadVectorExtension` returning. When `false`, semantic search degrades to
   * FTS-only and the `element_vectors` table is never created.
   */
  private vecAvailable = false;
  /**
   * The background-runner reference (T058), injected by the bootstrap AFTER the
   * runner is constructed (it is built against this open DB). The OCR service uses
   * it to enqueue an `ocr` job; left `null` for contract-only tests that never OCR.
   */
  private runner: JobRunner | null = null;
  /** The vault asset-root, injected at open() time; required for URL import. */
  private assetsDir: string | null = null;
  /** The exports-root (`<dataDir>/exports`), injected at open(); for Markdown export (T068). */
  private exportsDir: string | null = null;
  /**
   * The Electron-ABI `better-sqlite3` binding path, injected at open() (T070). The Anki
   * import/export services need it to open the EMBEDDED `collection.anki2` with the same
   * native ABI the app DB uses; `null`/undefined in Node/Vitest (default binding).
   */
  private nativeBinding: string | undefined = undefined;
  /** DEV/E2E-only: permit loopback/private hosts in URL import (see open()). */
  private allowLoopbackImport = false;
  /** TEST-only: the media-import YouTube fetch override (defaults to Node `fetch`). */
  private mediaFetchImpl: typeof fetch | undefined = undefined;
  private migrated = false;

  /** Whether the database handle is currently open. */
  get isOpen(): boolean {
    return this.handle !== null;
  }

  /** Whether startup migrations have been applied this session. */
  get isMigrated(): boolean {
    return this.migrated;
  }

  /**
   * Open the database at `dbPath` and run all pending migrations. Idempotent:
   * calling again while open is a no-op. `migrationsDir` is resolved by the
   * caller (the desktop bundle ships its own copy — see `migrations.ts`);
   * `nativeBinding`, when set, points `better-sqlite3` at the Electron-ABI addon
   * (see `native-binding.ts`).
   */
  open(
    dbPath: string,
    options: {
      migrationsDir?: string | undefined;
      nativeBinding?: string | undefined;
      /** The asset-vault root (`<dataDir>/assets`) — required for URL import (T060). */
      assetsDir?: string | undefined;
      /** The exports root (`<dataDir>/exports`) — required for Markdown export (T068). */
      exportsDir?: string | undefined;
      /** DEV/E2E-only: permit loopback/private hosts in URL import (the SSRF guard escape). */
      allowLoopbackImport?: boolean | undefined;
      /**
       * The HTTP-fetch implementation the media-import service (T073) uses for the
       * YouTube oEmbed/caption requests. Defaults to the Node global `fetch`;
       * injectable so a test can supply a recorded fake — no live network. Production
       * never sets it. (The media service owns the only network call; the DB service
       * itself stays network-free — see the import-path guard test.)
       */
      mediaFetchImpl?: typeof fetch | undefined;
      /**
       * Absolute path to the packaged `sqlite-vec` `vec0` binary (T087). When set,
       * it is loaded explicitly (the `app.asar.unpacked` path the desktop main
       * resolves); when omitted, the installed npm package resolves the host binary
       * (dev/Vitest). Load failure / a non-functional `vec0` degrades to FTS-only.
       */
      vecBinaryPath?: string | undefined;
    } = {},
  ): void {
    if (this.handle) return;
    this.handle = options.nativeBinding
      ? openDatabase(dbPath, { nativeBinding: options.nativeBinding })
      : openDatabase(dbPath);
    // T087: load `sqlite-vec` BETWEEN open and migrate, and set `vecAvailable` from
    // the FUNCTIONAL smoke test (NOT `loadVectorExtension` returning) — so a
    // loaded-but-non-functional `vec0` (the better-sqlite3-12 ↔ sqlite-vec ABI trap)
    // degrades to FTS-only instead of throwing on first query. The `element_vectors`
    // `vec0` migration then only runs when `vecAvailable` is already known true.
    try {
      loadVectorExtension(this.handle.sqlite, options.vecBinaryPath);
      this.vecAvailable = vecFunctional(this.handle.sqlite);
    } catch {
      this.vecAvailable = false;
    }
    migrateDatabase(this.handle.db, {
      ...(options.migrationsDir ? { migrationsFolder: options.migrationsDir } : {}),
      vecAvailable: this.vecAvailable,
    });
    this.assetsDir = options.assetsDir ?? null;
    this.exportsDir = options.exportsDir ?? null;
    this.nativeBinding = options.nativeBinding;
    this.allowLoopbackImport = options.allowLoopbackImport ?? false;
    this.mediaFetchImpl = options.mediaFetchImpl;
    this.repositories = createRepositories(this.handle.db, { vecAvailable: this.vecAvailable });
    this.inspector = new InspectorQuery(this.repositories);
    this.lineage = new LineageQuery(this.repositories);
    this.queue = new QueueQuery(this.repositories);
    // The facet-driven browse-all read behind `/library` (distinct from search):
    // lists ALL live elements narrowed by type/concept/priority/status facets,
    // including topic/synthesis_note/task which the FTS index never covers.
    this.library = new LibraryQuery(this.handle.db, this.repositories);
    // The per-source yield rollup behind `/analytics/sources` (T083): a read-only
    // ranked rollup of read %, extracts/cards/mature-cards, leeches, and review time,
    // lowest-yield first. No mutation, no `operation_log`, no schedule change.
    this.sourceYield = new SourceYieldQuery(this.handle.db);
    // The extract-stagnation scan behind `/maintenance/stagnant` (T084): a read-only
    // detection of extracts that keep returning without progressing (stage never
    // advanced, no children, postponed repeatedly), with rewrite/convert/postpone/
    // delete suggestions. No mutation, no `operation_log`, no schedule change.
    this.extractStagnation = new ExtractStagnationQuery(this.handle.db);
    this.queueAction = new QueueActionService(this.handle.db);
    // The overload AUTO-POSTPONE apply seam (T077): reads the merged due set + budget,
    // runs the pure `planAutoPostpone`, and applies each victim through its CORRECT
    // scheduler (attention reschedule / FSRS card defer) under one `batchId`.
    this.autoPostpone = new AutoPostponeService(this.handle.db, this.repositories);
    // The CATCH-UP & VACATION apply seam (T078): previews the cost (the per-day load curve
    // before vs after + what slips) and applies the plan — reschedule attention / FSRS card
    // defer / vacation suspend — under one `batchId`, reusing the existing ops only.
    this.recoveryMode = new RecoveryModeService(this.handle.db, this.repositories);
    this.inboxQuery = new InboxQuery(this.repositories);
    this.extraction = new ExtractionService(this.handle.db);
    this.extractReview = new ExtractService(this.handle.db);
    this.cardService = new CardService(this.handle.db);
    // Image-occlusion card generation (T071) — mints N sibling `image_occlusion`
    // cards from a `media_fragment` image extract + its masks in one transaction.
    this.occlusionService = new OcclusionService(this.handle.db);
    this.cardEditService = new CardEditService(this.handle.db);
    // Leech remediation compositions (T085) — split / add-context / back-to-extract.
    this.cardRemediationService = new CardRemediationService(this.handle.db);
    // Mature-card retirement (T082) — the reversible `cards.is_retired` flag.
    this.cardRetirementService = new CardRetirementService(this.handle.db);
    // The sibling-aware review-session ordering seam (T039): chooses the next due
    // card and buries siblings (session-ordering ONLY — it writes nothing).
    this.reviewSession = new ReviewSessionService(this.handle.db);
    // The targeted review-mode SELECTION seam (T096): resolves a chosen card subset
    // OUTSIDE scheduling (ignores `review_states.due_at`). Read-only — grading reuses
    // the unchanged `review.grade` path.
    this.reviewMode = new ReviewModeService(this.handle.db, this.repositories);
    // The retention RESOLVER (T079) + the per-card FSRS scheduler CACHE — generalizing
    // the single T036 scheduler. FSRS schedules CARDS ONLY against each card's RESOLVED
    // desired-retention target (per-card override → concept → priority band → global);
    // sources/topics/extracts stay on the separate attention scheduler, never here.
    this.retention = new RetentionService(this.handle.db);
    // The FSRS parameter-optimization seam (T080) — suggest (read-only) + apply.
    this.optimization = new OptimizationService(this.handle.db);
    // The workload-simulation seam (T081) — read-only load projection (mutates nothing).
    this.workload = new WorkloadService(this.handle.db);
    this.schedulerCache = new Map();
    this.schedulerCacheGen = 0;
    // The attention-scheduler APPLY seam (T028): the only place explicit
    // tomorrow/next-week/next-month/manual scheduling for non-card attention items
    // is persisted. Cards are rejected here (the two-scheduler split holds).
    this.attentionScheduler = new AttentionScheduleService(this.handle.db);
    // The general, command-level undo (T044): inverts the last operation_log op via
    // the existing repository write paths. Distinct from the queue's recipe undo (T030).
    this.undoService = new UndoService(this.handle.db);
    this.migrated = true;
  }

  /** Close the database handle (called on app shutdown). */
  close(): void {
    if (!this.handle) return;
    this.handle.sqlite.close();
    this.handle = null;
    this.repositories = null;
    this.inspector = null;
    this.lineage = null;
    this.queue = null;
    this.library = null;
    this.queueAction = null;
    this.autoPostpone = null;
    this.recoveryMode = null;
    this.inboxQuery = null;
    this.extraction = null;
    this.extractReview = null;
    this.cardService = null;
    this.cardEditService = null;
    this.cardRemediationService = null;
    this.cardRetirementService = null;
    this.reviewSession = null;
    this.reviewMode = null;
    this.retention = null;
    this.optimization = null;
    this.workload = null;
    this.schedulerCache = null;
    this.schedulerCacheGen = 0;
    this.attentionScheduler = null;
    this.undoService = null;
    this.urlImport = null;
    this.assetVault = null;
    this.maintenance = null;
    this.pdfImport = null;
    this.epubImport = null;
    this.mediaImport = null;
    this.documentImport = null;
    this.highlightImport = null;
    this.ankiImport = null;
    this.ankiExport = null;
    this.pdfRegion = null;
    this.mediaClip = null;
    this.ocr = null;
    this.embedding = null;
    this.ai = null;
    this.runner = null;
    this.assetsDir = null;
    this.exportsDir = null;
    this.nativeBinding = undefined;
    this.allowLoopbackImport = false;
    this.mediaFetchImpl = undefined;
    this.migrated = false;
  }

  private require(): DbHandle {
    if (!this.handle) {
      throw new Error("DbService: database is not open");
    }
    return this.handle;
  }

  /**
   * The repository layer (`packages/local-db`) bound to the open database. All
   * domain data access goes through these — IPC handlers route here, never to
   * raw SQL.
   */
  get repos(): Repositories {
    if (!this.repositories) {
      throw new Error("DbService: database is not open");
    }
    return this.repositories;
  }

  /** Read effective pragmas + applied-migration count for `db.getStatus()`. */
  getStatus(): DbStatus {
    const { sqlite } = this.require();
    const journalMode = String(sqlite.pragma("journal_mode", { simple: true }));
    const foreignKeys = Number(sqlite.pragma("foreign_keys", { simple: true }));
    const busyTimeoutMs = Number(sqlite.pragma("busy_timeout", { simple: true }));

    let appliedMigrations = 0;
    try {
      const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as
        | { n: number }
        | undefined;
      appliedMigrations = row?.n ?? 0;
    } catch {
      // Migration table absent only if migrations never ran; report 0.
      appliedMigrations = 0;
    }

    return {
      open: true,
      migrated: this.migrated,
      journalMode,
      foreignKeys,
      busyTimeoutMs,
      appliedMigrations,
    };
  }

  /**
   * Run the SQLite DB-integrity pragmas (T099) — READ-ONLY, via the SAME
   * `sqlite.pragma(...)` access `getStatus`/`backupDatabaseTo` use. `quick_check` (the
   * default) is fast and skips index-consistency; `integrity_check` (deep) is thorough
   * but can take seconds on a 100k DB. Also runs `PRAGMA foreign_key_check` (count of
   * violated rows — 0 with `foreign_keys = ON`). `ok` = the check returned exactly
   * `["ok"]` AND there are no FK violations. These pragmas do NOT mutate.
   */
  checkDbIntegrity(deep = false): {
    ok: boolean;
    integrityCheck: string[];
    foreignKeyViolations: number;
    mode: "quick_check" | "integrity_check";
  } {
    const { sqlite } = this.require();
    const mode = deep ? "integrity_check" : "quick_check";
    // `PRAGMA (quick|integrity)_check` returns one row per problem, or a single
    // `{ <pragma>: "ok" }` row when healthy.
    const rows = sqlite.pragma(mode) as Array<Record<string, unknown>>;
    const integrityCheck = rows.map((r) => String(Object.values(r)[0] ?? ""));
    // `PRAGMA foreign_key_check` returns one row per violated row (empty when clean).
    const fkRows = sqlite.pragma("foreign_key_check") as unknown[];
    const foreignKeyViolations = Array.isArray(fkRows) ? fkRows.length : 0;
    const ok =
      integrityCheck.length === 1 && integrityCheck[0] === "ok" && foreignKeyViolations === 0;
    return { ok, integrityCheck, foreignKeyViolations, mode };
  }

  /**
   * Read one setting (by key) or all settings, parsing JSON values.
   *
   * Capture-server pairing keys ({@link CAPTURE_SETTING_KEYS}) are NEVER surfaced
   * here: the single-key read returns `{}` for them, and the no-key dump drops
   * them. The token + allowed origin + bound port reach the trusted renderer
   * exclusively through the explicit `capture.getPairing()` path.
   */
  getSettings(key?: string): SettingsGetResult {
    const repo = this.repos.settings;
    if (key) {
      if (CAPTURE_SETTING_KEYS.has(key)) {
        return { settings: {} };
      }
      const value = repo.get<SettingValue>(key);
      return { settings: value === null ? {} : { [key]: value } };
    }
    const all = repo.getAll() as Record<string, SettingValue>;
    const filtered: Record<string, SettingValue> = {};
    for (const [storedKey, storedValue] of Object.entries(all)) {
      if (CAPTURE_SETTING_KEYS.has(storedKey)) {
        continue;
      }
      filtered[storedKey] = storedValue;
    }
    return { settings: filtered };
  }

  /**
   * Create/overwrite a setting through `SettingsRepository` (the repository seam)
   * so the value persists as JSON text and survives an app restart.
   */
  updateSetting(key: string, value: unknown): SettingsUpdateResult {
    const stored = this.repos.settings.set(key, value ?? null);
    return { key, value: stored as SettingValue };
  }

  /**
   * Read the complete, validated typed {@link AppSettings} (T011) through the
   * `SettingsRepository` — unset keys resolve to the canonical defaults, so the
   * scheduler/UI always see a complete object.
   */
  getAppSettings(): SettingsGetAllResult {
    // Project out the user's OWN plaintext keys (`aiApiKey`/`embeddingApiKey`) before the
    // result crosses the IPC boundary — the renderer sees `*Configured` booleans only
    // (T087/T093). The raw keys stay main-side (worker fork env), never returned.
    return { settings: projectToRendererSettings(this.repos.settings.getAppSettings()) };
  }

  /**
   * Apply a validated partial {@link AppSettings} patch (T011). The repository
   * coerces/clamps and persists in one transaction, then returns the full
   * resulting settings — so it survives an app restart.
   */
  updateAppSettings(patch: Readonly<Record<string, unknown>>): SettingsUpdateManyResult {
    const result = this.repos.settings.updateAppSettings(patch);
    // T093: when an AI enable/key/provider setting changes, re-fork the worker so the
    // new `INTERLEAVE_AI_API_KEY`/`INTERLEAVE_AI_PROVIDER` env takes effect (the worker
    // bakes env at construction; there is no per-job env channel). The re-fork is gated
    // on the worker being fully idle, so an unrelated in-flight job is never killed. Only
    // when the runner is present (the IPC path) — a contract-only test never re-forks.
    const touchesAi =
      Object.hasOwn(patch, "aiEnabled") ||
      Object.hasOwn(patch, "aiApiKey") ||
      Object.hasOwn(patch, "aiProviderKind");
    if (touchesAi && this.runner) {
      this.aiService.onSettingsChanged();
    }
    // Project out the plaintext own-keys before returning to the renderer (T087/T093) —
    // the write path accepted the key, but the read-back is `*Configured` booleans only.
    return { settings: projectToRendererSettings(result) };
  }

  /** Read-only inspector query layer (T010), bound to the open database. */
  private get inspectorQuery(): InspectorQuery {
    if (!this.inspector) {
      throw new Error("DbService: database is not open");
    }
    return this.inspector;
  }

  /** All live element summaries for the inspector's selection picker. */
  listInspectableElements(): InspectorListResult {
    return { elements: this.inspectorQuery.list() };
  }

  /** The full inspector payload for one element, or `null` if unknown/deleted. */
  getInspectorData(id: string): InspectorGetResult {
    return { data: this.inspectorQuery.get(id as ElementId) };
  }

  /**
   * Set / raise / lower an element's priority (T027) — the universal priority
   * write path for ANY element type (source/extract/card/task/topic/synthesis
   * note). The renderer sends an intent only; the MAIN process computes the new
   * numeric value with the `@interleave/core` band helpers and persists it through
   * {@link ElementRepository.setPriority}, which mutates `elements.priority` and
   * appends `update_element` in ONE transaction (NO new op type — priority changes
   * stay within the closed op set). Returns the updated summary carrying the new
   * numeric value + its derived A/B/C/D label so the renderer can update the badge
   * without a re-fetch; `null` when the id is unknown / soft-deleted.
   */
  setElementPriority(request: ElementsSetPriorityRequest): ElementsSetPriorityResult {
    const id = request.id as ElementId;
    const element = this.repos.elements.findById(id);
    if (!element || element.deletedAt) return { element: null };

    let nextPriority: Priority;
    switch (request.action.kind) {
      case "set":
        nextPriority = priorityFromLabel(request.action.priority);
        break;
      case "raise":
        nextPriority = raisePriority(element.priority);
        break;
      case "lower":
        nextPriority = lowerPriority(element.priority);
        break;
    }

    const updated = this.repos.elements.setPriority(id, nextPriority);
    return {
      element: {
        id: updated.id,
        type: updated.type,
        status: updated.status,
        stage: updated.stage,
        priority: updated.priority,
        title: updated.title,
        dueAt: updated.dueAt,
        priorityLabel: priorityToLabel(updated.priority),
      },
    };
  }

  /** Read-only lineage query layer (T023), bound to the open database. */
  private get lineageQuery(): LineageQuery {
    if (!this.lineage) {
      throw new Error("DbService: database is not open");
    }
    return this.lineage;
  }

  /**
   * The full, depth-tagged lineage tree for one element (T023), or `null` when the
   * id is unknown/soft-deleted. The {@link LineageQuery} resolves the lineage ROOT
   * and flattens the `source → extract → sub-extract → card` descendant tree —
   * read-only lineage computed main-side so the renderer only renders + navigates.
   */
  getLineage(id: string): LineageGetResult {
    return { lineage: this.lineageQuery.get(id as ElementId) };
  }

  /** Read-only queue query layer (T029), bound to the open database. */
  private get queueQuery(): QueueQuery {
    if (!this.queue) {
      throw new Error("DbService: database is not open");
    }
    return this.queue;
  }

  /**
   * The unified, sorted, filtered due queue (T029). The {@link QueueQuery} merges
   * the two DISTINCT due reads (due cards via the FSRS `review_states.due_at` join;
   * due sources/topics/extracts/tasks via the attention `elements.due_at` read),
   * decorates each row with its scheduler signals + meta, **orders by the T076
   * scoring function** (priority/due/retrievability/type + sibling/source/concept
   * de-clumping, modulated by the session `mode`), applies the type/concept/status
   * filters, and reads the daily review budget from {@link SettingsRepository} for the
   * gauge. Read-only — no mutation, no `operation_log`. The two schedulers stay
   * separate inside the read.
   */
  listQueue(request: QueueListRequest): QueueListResult {
    const data = this.queueQuery.list({
      ...(request.asOf ? { asOf: request.asOf as IsoTimestamp } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      filters: {
        ...(request.types ? { types: request.types } : {}),
        ...(request.concept ? { concept: request.concept } : {}),
        ...(request.tag ? { tag: request.tag } : {}),
        ...(request.statuses ? { statuses: request.statuses } : {}),
      },
    });
    return { items: data.items, counts: data.counts, budget: data.budget };
  }

  /** The per-row queue ACT seam (T030), bound to the open database. */
  private get queueActionService(): QueueActionService {
    if (!this.queueAction) {
      throw new Error("DbService: database is not open");
    }
    return this.queueAction;
  }

  /**
   * Apply one in-place queue action (T030) — postpone / raise / lower / done /
   * dismiss / delete — through the {@link QueueActionService}, a thin DISPATCHER over
   * the already-built mutation paths. Each path runs in ONE transaction and appends
   * the correct EXISTING op (no new op types): postpone routes an ATTENTION item
   * through the attention scheduler (`reschedule_element`) and a CARD through a thin
   * FSRS `review_states.due_at` defer (the two schedulers stay separate); raise/lower
   * → `update_element`; done/dismiss → `update_element` status; delete →
   * `soft_delete_element` (soft + undoable). Returns the REFRESHED queue row (so the
   * renderer updates + re-sorts it in place), whether the row LEAVES the due list,
   * and the undo recipe for the snackbar. The renderer reaches this only over
   * validated IPC — there is no generic `db.query`.
   */
  actOnQueueItem(request: QueueActRequest): QueueActResult {
    const id = request.id as ElementId;
    const result = this.queueActionService.act(id, request.action.kind);
    // A removing action (done/dismiss/delete) drops the row from the list; a
    // postpone recedes it from the DUE set (so it has no due row either). Only an
    // in-place change (raise/lower) returns a refreshed, still-due summary.
    const item =
      result.removed || request.action.kind === "postpone" ? null : this.queueQuery.summaryFor(id);
    return {
      item,
      removed: result.removed,
      undo: result.undo
        ? { kind: result.undo.kind, previousStatus: result.undo.previousStatus }
        : null,
    };
  }

  /** The attention-scheduler APPLY seam (T028), bound to the open database. */
  private get attentionScheduleService(): AttentionScheduleService {
    if (!this.attentionScheduler) {
      throw new Error("DbService: database is not open");
    }
    return this.attentionScheduler;
  }

  /**
   * Schedule a non-card attention item for an EXPLICIT return (T028) — tomorrow /
   * next week / next month / a manual date — through the attention
   * {@link AttentionScheduleService} (`SchedulerService.scheduleAt`), the apply seam
   * over the pure `AttentionScheduler.scheduleForChoice`. It computes the new
   * `due_at` and persists it via {@link ElementRepository.reschedule}
   * (`reschedule_element`, status → `scheduled`) in ONE transaction — NO new op type.
   *
   * THE TWO-SCHEDULER SPLIT holds: a `card` is rejected by the service (cards
   * schedule on FSRS, never the attention heuristic). After scheduling, the item
   * usually recedes from the DUE set (a future date), so the refreshed `item` is
   * `null` exactly as a `postpone` returns — the renderer re-reads the queue. The
   * renderer reaches this only over validated IPC; there is no generic `db.query`.
   */
  scheduleQueueItem(request: QueueScheduleRequest): QueueScheduleResult {
    const id = request.id as ElementId;
    const choice =
      request.choice.kind === "manual"
        ? { manual: request.choice.date as IsoTimestamp }
        : request.choice.kind;
    const { intervalDays, element } = this.attentionScheduleService.scheduleAt(id, choice);
    return { item: null, dueAt: element.dueAt as string, intervalDays };
  }

  /**
   * Undo a removing queue action (T030) — the snackbar's "Undo" — through the
   * {@link QueueActionService}. `restore` brings a soft-deleted row back via
   * {@link ElementRepository.restore} (`restore_element`); `status` re-sets the prior
   * lifecycle status via {@link ElementRepository.update} (`update_element`). One
   * transaction + the correct existing op (no new op types). Returns the restored
   * queue-row summary so the renderer re-inserts it; `null` when the id is unknown.
   */
  undoQueueAction(request: QueueUndoRequest): QueueUndoResult {
    const id = request.id as ElementId;
    this.queueActionService.undo(id, {
      kind: request.undo.kind,
      previousStatus: request.undo.previousStatus as ElementStatus,
    });
    return { item: this.queueQuery.summaryFor(id) };
  }

  /** The overload AUTO-POSTPONE apply seam (T077), bound to the open database. */
  private get autoPostponeService(): AutoPostponeService {
    if (!this.autoPostpone) {
      throw new Error("DbService: database is not open");
    }
    return this.autoPostpone;
  }

  /**
   * Preview the overload auto-postpone (T077) — READ-ONLY. Runs the pure `planAutoPostpone`
   * over the current due set + budget and returns what would move (low-priority topics first,
   * then low-priority mature cards — never a high-priority fragile card), from→to + why, so
   * the renderer shows the cost before committing. No mutation, no op.
   */
  previewAutoPostpone(request: QueueAutoPostponeRequest): AutoPostponePreview {
    return this.autoPostponeService.preview({
      ...(request.asOf ? { asOf: request.asOf as IsoTimestamp } : {}),
    });
  }

  /**
   * Apply the overload auto-postpone (T077) — TRANSACTIONAL. Postpones the planned items
   * through their CORRECT scheduler (attention items reschedule on the attention scheduler;
   * cards defer on FSRS — `review_states.due_at` only, memory state untouched, no review
   * log), all under ONE `batchId` so the whole sweep undoes as one (T044). Returns the count
   * + the batch id; no new op types.
   */
  applyAutoPostpone(request: QueueAutoPostponeRequest): AutoPostponeApplyResult {
    return this.autoPostponeService.apply({
      ...(request.asOf ? { asOf: request.asOf as IsoTimestamp } : {}),
    });
  }

  /** The CATCH-UP & VACATION apply seam (T078), bound to the open database. */
  private get recoveryModeService(): RecoveryModeService {
    if (!this.recoveryMode) {
      throw new Error("DbService: database is not open");
    }
    return this.recoveryMode;
  }

  /**
   * Preview the CATCH-UP plan (T078) — READ-ONLY. Spreads the overdue backlog forward over
   * `spreadDays` so each day ≤ budget (high-value/fragile first) and returns the COST (the
   * per-day load curve before vs after + the slips). No mutation, no op.
   */
  previewCatchUp(request: QueueCatchUpRequest): CatchUpPreview {
    return this.recoveryModeService.previewCatchUp({
      ...(request.asOf ? { asOf: request.asOf as IsoTimestamp } : {}),
      ...(request.spreadDays !== undefined ? { spreadDays: request.spreadDays } : {}),
    });
  }

  /**
   * Apply the CATCH-UP plan (T078) — TRANSACTIONAL. Reschedules attention items + defers cards
   * to their EXACT planned days (memory state untouched, no review log), all under ONE `batchId`
   * so the plan undoes as one (T044). Returns the count + the batch id; no new op types.
   */
  applyCatchUp(request: QueueCatchUpRequest): RecoveryApplyResult {
    return this.recoveryModeService.applyCatchUp({
      ...(request.asOf ? { asOf: request.asOf as IsoTimestamp } : {}),
      ...(request.spreadDays !== undefined ? { spreadDays: request.spreadDays } : {}),
    });
  }

  /**
   * Preview the VACATION plan (T078) — READ-ONLY. Finds what would come due in `[awayStart,
   * awayEnd]`, chooses suspend (fragile cards) vs shift-past-return (the rest), and returns the
   * COST (the after-return load curve + slips). No mutation, no op.
   */
  previewVacation(request: QueueVacationRequest): VacationPreview {
    return this.recoveryModeService.previewVacation({
      awayStart: request.awayStart as IsoTimestamp,
      awayEnd: request.awayEnd as IsoTimestamp,
      ...(request.asOf ? { asOf: request.asOf as IsoTimestamp } : {}),
    });
  }

  /**
   * Apply the VACATION plan (T078) — TRANSACTIONAL. Suspends fragile cards (prior status captured
   * in the op pre-image for resume) + shifts the rest past return, all under ONE `batchId` so the
   * plan undoes (and vacation resumes) as one. Returns the moved + suspended counts + the batch id.
   */
  applyVacation(request: QueueVacationRequest): RecoveryApplyResult {
    return this.recoveryModeService.applyVacation({
      awayStart: request.awayStart as IsoTimestamp,
      awayEnd: request.awayEnd as IsoTimestamp,
      ...(request.asOf ? { asOf: request.asOf as IsoTimestamp } : {}),
    });
  }

  /** Read-only inbox query layer (T012), bound to the open database. */
  private get inbox(): InboxQuery {
    if (!this.inboxQuery) {
      throw new Error("DbService: database is not open");
    }
    return this.inboxQuery;
  }

  /**
   * Create a source in the `inbox` with its document body (T012 + T013). The
   * {@link SourceRepository.createWithDocument} writes the `elements` row, the
   * `sources` provenance row, AND the `documents` body + stable `document_blocks`
   * in ONE transaction, appending `create_element` + `create_source` +
   * `update_document` together — a source never persists without its body. The
   * raw pasted `body` is converted main-side to plain text + ProseMirror JSON
   * (the renderer never builds the doc). The A/B/C/D label maps to a numeric
   * priority via `priorityFromLabel` (default `C`, so new material never dominates
   * older high-value material).
   *
   * Provenance derivation (T014, NO remote fetching): the entered `url` is
   * preserved verbatim as `originalUrl`, and a conservative `canonicalUrl` is
   * derived from it with the pure `canonicalizeUrl` normalizer (tracking params /
   * fragment stripped, host lowercased). `accessedAt` is auto-stamped to "now"
   * (ISO) when the renderer did not supply one. `snapshotKey` stays `null` in M2.
   * If the renderer explicitly passes any of these, its value wins. This entire
   * path is fetch-free — it imports no network module and works fully offline.
   * Returns the new id + its inbox summary.
   */
  importManualSource(request: SourcesImportManualRequest): SourcesImportManualResult {
    const label: PriorityLabel = request.priority ?? "C";
    const url = request.url ?? null;
    const canonicalUrl = request.canonicalUrl ?? canonicalizeUrl(url);
    const originalUrl = request.originalUrl ?? url;
    const accessedAt = request.accessedAt ?? new Date().toISOString();
    const { element } = this.repos.sources.createWithDocument({
      title: request.title,
      priority: priorityFromLabel(label),
      status: "inbox",
      stage: "raw_source",
      url,
      canonicalUrl,
      originalUrl,
      accessedAt,
      snapshotKey: request.snapshotKey ?? null,
      author: request.author ?? null,
      publishedAt: request.publishedAt ?? null,
      reasonAdded: request.reasonAdded ?? null,
      body: request.body,
    });
    const detail = this.inbox.get(element.id);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === element.id) ?? null;
    if (!item) {
      throw new Error("DbService.importManualSource: created source not found in inbox");
    }
    return { id: element.id, item };
  }

  /**
   * Edit a source's reliability metadata (T091) via
   * {@link SourceRepository.updateReliability}: set/clear `source_type` /
   * `reliability_tier` / `confidence` / `reliability_notes` in ONE transaction logging
   * `update_element` on the source element (no new op type, no lineage touched). Returns
   * the source's refreshed provenance (built by the SAME {@link InspectorQuery} the
   * inspector uses) so the renderer reflects the new badge WITHOUT a re-fetch.
   */
  updateSourceReliability(
    request: SourcesUpdateReliabilityRequest,
  ): SourcesUpdateReliabilityResult {
    this.repos.sources.updateReliability(request.sourceId as ElementId, {
      ...(request.sourceType !== undefined ? { sourceType: request.sourceType } : {}),
      ...(request.reliabilityTier !== undefined
        ? { reliabilityTier: request.reliabilityTier }
        : {}),
      ...(request.confidence !== undefined ? { confidence: request.confidence } : {}),
      ...(request.reliabilityNotes !== undefined
        ? { reliabilityNotes: request.reliabilityNotes }
        : {}),
    });
    const data = this.inspectorQuery.get(request.sourceId as ElementId);
    if (!data?.provenance) {
      throw new Error(
        `DbService.updateSourceReliability: provenance not found for ${request.sourceId}`,
      );
    }
    return { provenance: data.provenance };
  }

  /**
   * The shared URL-import service (T060), lazily built on first read against the
   * open DB + the vault `assetsDir` injected at {@link open}. Returns the SAME
   * built instance every call, so M13's `bootstrap()` can pass it into
   * `startCaptureServer({ …, importService: dbService.urlImportService })` and the
   * renderer IPC path + the loopback path share one fully-wired service. Throws a
   * clear error if `assetsDir` was not provided (a contract-only test that never
   * imports), rather than constructing a half-wired service.
   */
  /**
   * Whether URL import permits loopback/private hosts (the DEV/E2E SSRF-guard
   * escape, set at {@link open}). The IPC `importUrl` handler forwards this into
   * the `url_import` job payload so the background-runner WORKER's fetch permits
   * the 127.0.0.1 fixture server in the E2E (never true in a packaged app).
   */
  get allowsLoopbackImport(): boolean {
    return this.allowLoopbackImport;
  }

  get urlImportService(): UrlImportService {
    if (this.urlImport) return this.urlImport;
    const repositories = this.repos;
    if (!this.assetsDir) {
      throw new Error(
        "DbService: URL import requires an assets directory — call open() with { assetsDir }",
      );
    }
    this.urlImport = new UrlImportService({
      db: this.require().db,
      repositories,
      assetsDir: this.assetsDir,
      allowLoopback: this.allowLoopbackImport,
    });
    return this.urlImport;
  }

  /**
   * The asset-vault scaling service (T059), lazily built on first read against the
   * open DB + the vault `assetsDir` injected at {@link open}. Returns the SAME
   * instance every call. Throws a clear error if `assetsDir` was not provided (a
   * contract-only test that never touches the vault), rather than constructing a
   * half-wired service — mirrors {@link urlImportService}.
   */
  get assetVaultService(): AssetVaultService {
    if (this.assetVault) return this.assetVault;
    const repositories = this.repos;
    if (!this.assetsDir) {
      throw new Error(
        "DbService: vault maintenance requires an assets directory — call open() with { assetsDir }",
      );
    }
    this.assetVault = new AssetVaultService({
      db: this.require().db,
      repositories,
      assetsDir: this.assetsDir,
    });
    return this.assetVault;
  }

  /**
   * The Maintenance composer (T099), lazily built on first read. Composes THIS
   * `DbService` (sharing the open DB, repos, vault, and the integrity pragmas), so it
   * needs the same `assetsDir` the vault reports do — the getter surfaces a clear error
   * if it is absent (a contract-only test that never touches the vault).
   */
  get maintenanceService(): MaintenanceService {
    if (this.maintenance) return this.maintenance;
    this.maintenance = new MaintenanceService({ dbService: this });
    return this.maintenance;
  }

  // --- Maintenance reports (T099 — read-only, no operation_log) -------------

  /** The Maintenance hub rollup — every report's COUNT + the integrity-not-run flag. */
  async getMaintenanceReport(): Promise<MaintenanceReport> {
    return this.maintenanceService.report();
  }

  /** The collection-wide duplicate cluster rollup (read-only). */
  getMaintenanceDuplicates(): MaintenanceDuplicateReport {
    return this.maintenanceService.duplicates();
  }

  /** Live cards with no resolvable source lineage (SURFACED, never auto-deleted). */
  getMaintenanceCardsWithoutSources(): {
    rows: ReturnType<MaintenanceService["cardsWithoutSources"]>["rows"];
  } {
    return this.maintenanceService.cardsWithoutSources();
  }

  /** Broken sources — live sources whose snapshot bytes are missing / absent. */
  async getMaintenanceBrokenSources(): Promise<{ rows: BrokenSourceRow[] }> {
    return this.maintenanceService.brokenSources();
  }

  /** Low-priority, stale candidates for bulk postpone / archive. */
  getMaintenanceLowValue(request?: { asOf?: string | undefined; limit?: number | undefined }): {
    rows: ReturnType<MaintenanceService["lowValueCandidates"]>["rows"];
  } {
    return this.maintenanceService.lowValueCandidates(request?.asOf, request?.limit);
  }

  /** The DB + vault integrity DEEP check (on-demand). Read-only. */
  async getMaintenanceIntegrity(request?: {
    deep?: boolean | undefined;
  }): Promise<IntegrityReport> {
    return this.maintenanceService.checkIntegrity(request?.deep ?? false);
  }

  // --- Maintenance actions (T099 — transactional, op-logged, undoable) ------

  /** Dedup cleanup — soft-delete validated non-keeper duplicates in one batch. */
  maintenanceDedupe(request: { removeIds: string[] }): MaintenanceBatchResult {
    return this.maintenanceService.dedupeCleanup({
      removeIds: request.removeIds as ElementId[],
    });
  }

  /** Orphan-media cleanup — the confirmed vault GC + the vector prune. */
  async maintenanceOrphanMedia(request: {
    confirm: true;
    relativePaths?: string[] | undefined;
  }): Promise<{ removed: number; freedBytes: number; vectorsPruned: number }> {
    return this.maintenanceService.orphanMediaCleanup({
      confirm: request.confirm,
      ...(request.relativePaths ? { relativePaths: request.relativePaths } : {}),
    });
  }

  /** Bulk soft-delete (broken-source / sourceless-card trash) — one undoable batch. */
  maintenanceBulkTrash(request: { ids: string[] }): MaintenanceBatchResult {
    return this.maintenanceService.bulkTrash({ ids: request.ids as ElementId[] });
  }

  /** Bulk archive (trash / dismiss / retire) — one undoable batch. */
  maintenanceBulkArchive(request: {
    ids: string[];
    mode: "trash" | "dismiss" | "retire";
  }): MaintenanceBatchResult {
    return this.maintenanceService.bulkArchive({
      ids: request.ids as ElementId[],
      mode: request.mode,
    });
  }

  /** Bulk postpone (low-priority recede) — one undoable batch (cards FSRS / attention split). */
  maintenanceBulkPostpone(request: {
    ids: string[];
    asOf?: string | undefined;
  }): MaintenanceBatchResult {
    return this.maintenanceService.bulkPostpone({
      ids: request.ids as ElementId[],
      ...(request.asOf ? { asOf: request.asOf } : {}),
    });
  }

  /**
   * The PDF-import service (T064), lazily built on first read against the open DB +
   * the vault `assetsDir` + the `assetVaultService` (so the original PDF streams in
   * through the SAME T059 importer). Returns the SAME instance every call. Throws a
   * clear error if `assetsDir` was not provided (a contract-only test that never
   * imports) — mirrors {@link urlImportService} / {@link assetVaultService}.
   */
  get pdfImportService(): PdfImportService {
    if (this.pdfImport) return this.pdfImport;
    const repositories = this.repos;
    if (!this.assetsDir) {
      throw new Error(
        "DbService: PDF import requires an assets directory — call open() with { assetsDir }",
      );
    }
    this.pdfImport = new PdfImportService({
      db: this.require().db,
      repositories,
      assetsDir: this.assetsDir,
      assetVault: this.assetVaultService,
    });
    return this.pdfImport;
  }

  /**
   * Import a local `.pdf` (T064) — the IPC handler has already resolved the chosen
   * absolute `filePath` via the MAIN file picker. Delegates to
   * {@link PdfImportService.importFromFile}; a thrown `PdfImportError` propagates to
   * the IPC layer (rejected invoke → the modal's friendly-message catch).
   */
  async importPdf(input: {
    filePath: string;
    priority?: PriorityLabel;
    reasonAdded?: string | null;
  }): Promise<SourcesImportPdfResult> {
    const { id, item } = await this.pdfImportService.importFromFile(input);
    return { status: "imported", id, item };
  }

  /**
   * The EPUB-import orchestrator (T067), lazily built on first read against the open
   * DB + repos + the vault `assetsDir` (so `original.epub` streams in). Throws a clear
   * error if `assetsDir` was not provided — mirrors {@link pdfImportService}.
   */
  get epubImportService(): EpubImportService {
    if (this.epubImport) return this.epubImport;
    const repositories = this.repos;
    if (!this.assetsDir) {
      throw new Error(
        "DbService: EPUB import requires an assets directory — call open() with { assetsDir }",
      );
    }
    this.epubImport = new EpubImportService({
      db: this.require().db,
      repositories,
      assetsDir: this.assetsDir,
    });
    return this.epubImport;
  }

  /**
   * Import a local `.epub` (T067) — the IPC handler has already resolved the chosen
   * absolute `absPath` via the MAIN file picker. Delegates to
   * {@link EpubImportService.importFromFile}; a thrown `EpubImportError` propagates to
   * the IPC layer (rejected invoke → the modal's friendly-message catch).
   */
  async importEpub(input: {
    absPath: string;
    priority?: PriorityLabel;
    reasonAdded?: string | null;
  }): Promise<SourcesImportEpubResult> {
    return await this.epubImportService.importFromFile(input);
  }

  /**
   * The media-import orchestrator (T073), lazily built on first read against the open
   * DB + repos + the vault `assetsDir` + the `assetVaultService` (so a local file
   * streams in) + the Node global `fetch` (so a YouTube URL fetches metadata/captions
   * on-device). Throws a clear error if `assetsDir` was not provided — mirrors
   * {@link pdfImportService}.
   */
  get mediaImportService(): MediaImportService {
    if (this.mediaImport) return this.mediaImport;
    const repositories = this.repos;
    if (!this.assetsDir) {
      throw new Error(
        "DbService: media import requires an assets directory — call open() with { assetsDir }",
      );
    }
    this.mediaImport = new MediaImportService({
      db: this.require().db,
      repositories,
      assetsDir: this.assetsDir,
      assetVault: this.assetVaultService,
      ...(this.mediaFetchImpl ? { fetchImpl: this.mediaFetchImpl } : {}),
    });
    return this.mediaImport;
  }

  /**
   * Import a LOCAL media file (T073) — the IPC handler has already resolved the chosen
   * absolute `path` (and optional `subtitlesPath`) via the MAIN file picker. Delegates
   * to {@link MediaImportService.importFromFile}; a thrown `MediaImportError` propagates
   * to the IPC layer (rejected invoke → the inbox chip's friendly-message catch).
   */
  async importMedia(input: {
    path: string;
    subtitlesPath?: string | null;
    priority?: PriorityLabel;
    reasonAdded?: string | null;
  }): Promise<SourcesImportMediaResult> {
    const result = await this.mediaImportService.importFromFile({
      filePath: input.path,
      ...(input.subtitlesPath !== undefined ? { subtitlesPath: input.subtitlesPath } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.reasonAdded !== undefined ? { reasonAdded: input.reasonAdded } : {}),
    });
    return {
      status: "imported",
      id: result.id,
      item: result.item,
      mediaKind: result.mediaKind,
      hasTranscript: result.hasTranscript,
    };
  }

  /**
   * Import a YouTube URL (T073) — the routing fork on `sources.importUrl`. The URL IPC
   * handler detects a YouTube URL and calls this instead of enqueuing a Readability
   * `url_import` job. Delegates to {@link MediaImportService.importFromYouTube}; a thrown
   * `MediaImportError` propagates to the IPC layer.
   */
  async importMediaFromYouTube(input: {
    url: string;
    priority?: PriorityLabel;
    reasonAdded?: string | null;
  }): Promise<SourcesImportMediaResult> {
    const result = await this.mediaImportService.importFromYouTube(input);
    return {
      status: "imported",
      id: result.id,
      item: result.item,
      mediaKind: result.mediaKind,
      hasTranscript: result.hasTranscript,
    };
  }

  /**
   * Serve a media source's playable data to the renderer (T073). For a LOCAL source it
   * returns the privileged `media://<elementId>` URL (the renderer's `<video>`/`<audio>`
   * streams it with Range support — bytes never buffered over IPC) + the mime/duration;
   * for a YOUTUBE source it returns the video id (the renderer uses the IFrame embed).
   * Read-only; the renderer passes only an element id (MAIN owns the vault path).
   */
  getMediaData(request: SourcesGetMediaDataRequest): Promise<SourcesGetMediaDataResult> {
    const elementId = request.elementId as ElementId;
    const provenance = this.repos.sources.findById(elementId)?.source ?? null;
    const mediaKind = provenance?.mediaKind ?? null;
    if (mediaKind === "youtube") {
      const youtubeId = provenance?.canonicalUrl ? parseYouTubeId(provenance.canonicalUrl) : null;
      return Promise.resolve({
        mediaSource: "youtube",
        mediaKind: null,
        mediaUrl: null,
        mime: null,
        youtubeId,
        durationMs: null,
      });
    }
    if (mediaKind === "video" || mediaKind === "audio") {
      // The original media asset carries the mime + duration; the bytes stream over the
      // privileged `media://<elementId>` protocol (registered in main).
      const asset = this.repos.assets.listForElementByKind(elementId, mediaKind)[0] ?? null;
      return Promise.resolve({
        mediaSource: "local",
        mediaKind,
        mediaUrl: `media://${elementId}`,
        mime: asset?.mime ?? null,
        youtubeId: null,
        durationMs: asset?.durationMs ?? null,
      });
    }
    // Not a media source.
    return Promise.resolve({
      mediaSource: "local",
      mediaKind: null,
      mediaUrl: null,
      mime: null,
      youtubeId: null,
      durationMs: null,
    });
  }

  /**
   * The Markdown/HTML import + Markdown-export orchestrator (T068), lazily built on
   * first read against the open DB + repos + the vault `assetsDir` + the `exportsDir`.
   * Throws a clear error if either dir was not provided — mirrors
   * {@link epubImportService}.
   */
  get documentImportService(): DocumentImportService {
    if (this.documentImport) return this.documentImport;
    if (!this.assetsDir || !this.exportsDir) {
      throw new Error(
        "DbService: document import/export requires assets + exports directories — call open() with { assetsDir, exportsDir }",
      );
    }
    this.documentImport = new DocumentImportService({
      db: this.require().db,
      repositories: this.repos,
      assetsDir: this.assetsDir,
      exportsDir: this.exportsDir,
    });
    return this.documentImport;
  }

  /**
   * Import a local `.md`/`.html` file (T068) — the IPC handler resolved the chosen
   * path via the MAIN file picker. Delegates to {@link DocumentImportService}; a thrown
   * `DocumentImportError` propagates to the IPC layer.
   */
  async importDocument(input: {
    absPath: string;
    format: "markdown" | "html";
    priority?: PriorityLabel;
    reasonAdded?: string | null;
  }): Promise<DocumentImportResult> {
    return await this.documentImportService.importFromFile(input);
  }

  /** Import pasted Markdown (T068) — the paste path, no file read. */
  async importMarkdownText(input: {
    text: string;
    title?: string | null;
    priority?: PriorityLabel;
    reasonAdded?: string | null;
  }): Promise<DocumentImportResult> {
    return await this.documentImportService.importFromText(input);
  }

  /**
   * Export an element's document body to a `.md` in the `exports/` vault (T068).
   * Read-only on the DB (no mutation, no op-log entry). Returns the written path.
   */
  async exportMarkdown(input: { elementId: ElementId }): Promise<MarkdownExportResult> {
    return await this.documentImportService.exportToMarkdown(input);
  }

  /**
   * The highlight-import orchestrator (T069), lazily built on first read against the
   * open DB + repos. Needs NO vault directory — highlights are text, not assets.
   */
  get highlightImportService(): HighlightImportService {
    if (this.highlightImport) return this.highlightImport;
    this.highlightImport = new HighlightImportService({
      db: this.require().db,
      repositories: this.repos,
    });
    return this.highlightImport;
  }

  /**
   * Import a Readwise/Kindle highlight export (T069) — the IPC handler resolved the
   * chosen path via the MAIN file picker. Delegates to {@link HighlightImportService};
   * a thrown `HighlightImportError` propagates to the IPC layer.
   */
  async importHighlights(input: {
    absPath: string;
    format?: "readwise_csv" | "readwise_json" | "kindle_clippings";
    priority?: PriorityLabel;
  }): Promise<HighlightImportResult> {
    return await this.highlightImportService.importFromFile(input);
  }

  /**
   * The Anki `.apkg`-import orchestrator (T070), lazily built on first read against the
   * open DB + repos + the vault `assetsDir` (so the original `.apkg` is retained in the
   * vault) + the Electron-ABI `nativeBinding` (to open the embedded collection). Throws
   * a clear error if `assetsDir` was not provided — mirrors {@link epubImportService}.
   */
  get ankiImportService(): AnkiImportService {
    if (this.ankiImport) return this.ankiImport;
    if (!this.assetsDir) {
      throw new Error(
        "DbService: Anki import requires an assets directory — call open() with { assetsDir }",
      );
    }
    this.ankiImport = new AnkiImportService({
      db: this.require().db,
      repositories: this.repos,
      assetsDir: this.assetsDir,
      assetVault: this.assetVaultService,
      nativeBinding: this.nativeBinding,
    });
    return this.ankiImport;
  }

  /**
   * Import a local `.apkg` (T070) — the IPC handler resolved the chosen path via the
   * MAIN file picker. Delegates to {@link AnkiImportService.importFromFile}; a thrown
   * `AnkiImportError` propagates to the IPC layer.
   */
  async importAnki(input: {
    absPath: string;
    priority?: PriorityLabel;
  }): Promise<AnkiImportResult> {
    return await this.ankiImportService.importFromFile(input);
  }

  /**
   * The Anki `.apkg`/CSV-export orchestrator (T070), lazily built on first read against
   * the open DB + repos + the `exportsDir` (where the file lands) + the `nativeBinding`
   * (to write the embedded collection). Throws if `exportsDir` was not provided.
   */
  get ankiExportService(): AnkiExportService {
    if (this.ankiExport) return this.ankiExport;
    if (!this.exportsDir) {
      throw new Error(
        "DbService: Anki export requires an exports directory — call open() with { exportsDir }",
      );
    }
    this.ankiExport = new AnkiExportService({
      repositories: this.repos,
      exportsDir: this.exportsDir,
      nativeBinding: this.nativeBinding,
    });
    return this.ankiExport;
  }

  /**
   * Export selected cards to an Anki `.apkg`/CSV in `exports/` (T070) — read-only on the
   * DB. Delegates to {@link AnkiExportService}; a thrown `AnkiExportError` propagates.
   */
  async exportAnki(input: {
    format: "apkg" | "csv";
    cardIds?: readonly string[] | undefined;
    conceptId?: string | undefined;
    all?: boolean | undefined;
  }): Promise<AnkiExportFileResult> {
    const selection: AnkiExportSelection = {
      ...(input.cardIds ? { cardIds: input.cardIds as readonly ElementId[] } : {}),
      ...(input.conceptId ? { conceptId: input.conceptId as ElementId } : {}),
      ...(input.all != null ? { all: input.all } : {}),
    };
    return input.format === "csv"
      ? await this.ankiExportService.exportCsv(selection)
      : await this.ankiExportService.exportApkg(selection);
  }

  /**
   * Serve a PDF source's ORIGINAL bytes to the renderer for rendering (T064). MAIN
   * reads the source's `.pdf` `snapshotKey`, resolves it under `assetsDir`, and
   * returns the bytes (the renderer passes only an element id; main owns the path).
   * Returns `{ bytes: null }` when the source is not a PDF / has no snapshot.
   */
  async getPdfData(request: SourcesGetPdfDataRequest): Promise<SourcesGetPdfDataResult> {
    const elementId = request.elementId as ElementId;
    const provenance = this.repos.sources.findById(elementId)?.source ?? null;
    const snapshotKey = provenance?.snapshotKey ?? null;
    const pageCount = this.pdfPageCount(elementId);
    if (!this.assetsDir || !snapshotKey?.toLowerCase().endsWith(".pdf")) {
      return { bytes: null, pageCount };
    }
    const abs = path.join(this.assetsDir, ...snapshotKey.split("/"));
    try {
      const buf = await fsp.readFile(abs);
      // Return a standalone ArrayBuffer slice (not the pooled Node Buffer's).
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { bytes: ab, pageCount };
    } catch {
      return { bytes: null, pageCount };
    }
  }

  /** The page count of a PDF source, from the max `document_blocks.page`, or 0. */
  private pdfPageCount(elementId: ElementId): number {
    let max = 0;
    for (const block of this.repos.documents.listBlocks(elementId)) {
      if (typeof block.page === "number" && block.page > max) max = block.page;
    }
    return max;
  }

  /**
   * The PDF region-extract service (T065), lazily built on first read against the
   * open DB + repos + the extraction service + the `assetVaultService` (so the
   * cropped PNG streams in through the SAME T059 importer). Throws a clear error if
   * `assetsDir` was not provided — mirrors {@link pdfImportService}.
   */
  private get pdfRegionService(): PdfRegionService {
    if (this.pdfRegion) return this.pdfRegion;
    if (!this.assetsDir) {
      throw new Error(
        "DbService: PDF region extraction requires an assets directory — call open() with { assetsDir }",
      );
    }
    this.pdfRegion = new PdfRegionService({
      db: this.require().db,
      repositories: this.repos,
      extraction: this.extractionService,
      assetVault: this.assetVaultService,
    });
    return this.pdfRegion;
  }

  /**
   * The media clip-extract service (T074), lazily built on first read against the
   * open DB + repos + the extraction service. Asset-free (the clip references the
   * original media — no vault step), so it needs NO `assetVaultService`/`assetsDir`.
   */
  private get mediaClipService(): MediaClipService {
    if (this.mediaClip) return this.mediaClip;
    this.mediaClip = new MediaClipService({
      db: this.require().db,
      repositories: this.repos,
      extraction: this.extractionService,
    });
    return this.mediaClip;
  }

  /**
   * Clip a media span into a scheduled `media_fragment` (T074). The renderer ships
   * only the `{ startMs, endMs }` + the source id + the anchor block id + the
   * (optional) transcript segment (already validated at the IPC boundary); MAIN
   * creates the fragment + its start-timestamp + clip-window source location in one
   * transaction. NO bytes are cut/re-encoded — the clip references the original media.
   */
  async extractClip(request: SourcesExtractClipRequest): Promise<SourcesExtractClipResult> {
    // `await` so a synchronous validation throw in MediaClipService surfaces as a
    // rejected promise at the IPC boundary (not a sync throw the handler misses).
    return await this.mediaClipService.extractClip({
      sourceElementId: request.sourceElementId as ElementId,
      startMs: request.startMs,
      endMs: request.endMs,
      anchorBlockId: request.anchorBlockId,
      transcriptSegment: request.transcriptSegment ?? null,
      caption: request.caption ?? null,
      ...(request.priority ? { priority: request.priority } : {}),
    });
  }

  /**
   * Crop a PDF page region into a scheduled `media_fragment` extract (T065). The
   * renderer ships the cropped PNG + the normalized rect + page (already validated/
   * size-capped at the IPC boundary); MAIN streams the bytes into the vault and
   * creates the region extract + its page+region source location in one transaction.
   */
  async extractRegion(request: SourcesExtractRegionRequest): Promise<SourcesExtractRegionResult> {
    return await this.pdfRegionService.extractRegion({
      sourceElementId: request.sourceElementId as ElementId,
      page: request.page,
      pageBlockId: request.pageBlockId,
      region: request.region,
      imagePng: request.imagePng,
      caption: request.caption ?? null,
      ...(request.priority ? { priority: request.priority } : {}),
    });
  }

  /**
   * Serve a region extract's cropped image bytes to the renderer (T065). MAIN reads
   * the owning `image` asset's vault path; the renderer passes only the element id.
   * Returns `{ bytes: null }` when the element has no image asset.
   */
  async getRegionImage(
    request: SourcesGetRegionImageRequest,
  ): Promise<SourcesGetRegionImageResult> {
    const elementId = request.elementId as ElementId;
    const asset = this.repos.assets.listForElementByKind(elementId, "image")[0] ?? null;
    if (!this.assetsDir || !asset) {
      return { bytes: null, mime: null };
    }
    const abs = path.join(this.assetsDir, ...asset.location.vaultPath.relativePath.split("/"));
    try {
      const buf = await fsp.readFile(abs);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      return { bytes: ab, mime: asset.mime };
    } catch {
      return { bytes: null, mime: null };
    }
  }

  /**
   * Inject the background runner (T058) after it is constructed against this open
   * DB. The OCR service (T066) uses it to enqueue an `ocr` job; the bootstrap calls
   * this once after `new JobRunner(...)`.
   */
  setRunner(runner: JobRunner): void {
    this.runner = runner;
  }

  /**
   * The OCR service (T066), lazily built on first read against the open DB + the
   * `assetVaultService` + the injected runner. Returns the SAME instance every
   * call. The apply handler reaches it via `getOcrService` (only `applyResult`,
   * which needs no runner); the IPC `runOcr` path needs the runner to enqueue.
   * Throws a clear error if `assetsDir` was not provided — mirrors the others.
   */
  get ocrService(): OcrService {
    if (this.ocr) return this.ocr;
    if (!this.assetsDir) {
      throw new Error(
        "DbService: OCR requires an assets directory — call open() with { assetsDir }",
      );
    }
    this.ocr = new OcrService({
      db: this.require().db,
      repositories: this.repos,
      assetVault: this.assetVaultService,
      getRunner: () => {
        if (!this.runner) {
          throw new Error(
            "DbService: OCR enqueue requires a background runner — setRunner() first",
          );
        }
        return this.runner;
      },
    });
    return this.ocr;
  }

  /**
   * The semantic-embedding service (T087), lazily built against the open DB + the
   * runner + the settings repo. Returns the SAME instance every call. The apply
   * handler reaches it via `getEmbeddingService` (its `applyResult` needs no runner);
   * the IPC reindex/search paths use the runner to enqueue.
   */
  get embeddingService(): EmbeddingService {
    if (this.embedding) return this.embedding;
    this.embedding = new EmbeddingService({
      db: this.require().db,
      repositories: this.repos,
      getRunner: () => {
        if (!this.runner) {
          throw new Error(
            "DbService: embed enqueue requires a background runner — setRunner() first",
          );
        }
        return this.runner;
      },
      getSettings: () => this.repos.settings.getAppSettings(),
    });
    return this.embedding;
  }

  /**
   * The AI-assisted-distillation service (T093), lazily built against the open DB + the
   * runner + the settings repo. Returns the SAME instance every call. The apply handler
   * reaches it via `getAiService` (its `applyResult` needs no runner); the IPC `runAi`
   * path uses the runner to enqueue.
   */
  get aiService(): AiService {
    if (this.ai) return this.ai;
    this.ai = new AiService({
      repositories: this.repos,
      getRunner: () => {
        if (!this.runner) {
          throw new Error("DbService: AI enqueue requires a background runner — setRunner() first");
        }
        return this.runner;
      },
      getSettings: () => this.repos.settings.getAppSettings(),
      getCardService: () => this.cards,
    });
    return this.ai;
  }

  // -------------------------------------------------------------------------
  // ai.*  (T093 — AI-assisted distillation)
  // -------------------------------------------------------------------------

  /** Enqueue an AI formulation action over a selected span (T093). Off → throws. */
  runAi(request: AiRunRequest): AiRunResult {
    return this.aiService.enqueue({
      owningElementId: request.owningElementId as ElementId,
      action: request.action,
      sourceRef: {
        sourceElementId: request.sourceRef.sourceElementId as ElementId,
        blockIds: request.sourceRef.blockIds as BlockId[],
        startOffset: request.sourceRef.startOffset ?? null,
        endOffset: request.sourceRef.endOffset ?? null,
        selectedText: request.sourceRef.selectedText,
        ...(request.sourceRef.context ? { context: request.sourceRef.context } : {}),
      },
    });
  }

  /** The draft suggestions for an element + each one's resolved grounding (T093/T094). */
  listAiSuggestions(request: AiListRequest): AiListResult {
    const owningElementId = request.elementId as ElementId;
    const suggestions = this.aiService.listForElement(owningElementId);
    return {
      suggestions: suggestions.map((s) => {
        // The grounding span as a jump-to-source `LocationSummary` (T094) so the drafts
        // panel can wire an in-app "jump to source" exactly like an extract/card refblock;
        // `null` for the orphan case (no resolvable source → no jump affordance).
        const span = this.repos.aiSuggestions.groundingLocationFor(this.repos, s.id);
        const groundingLocation: LocationSummary | null = span
          ? {
              label: span.label,
              selectedText: span.selectedText,
              page: null,
              region: null,
              sourceElementId: span.sourceElementId,
              blockIds: span.blockIds,
              startOffset: span.startOffset,
              endOffset: span.endOffset,
            }
          : null;
        return {
          ...s,
          grounding: this.repos.aiSuggestions.groundingFor(this.repos, s.id),
          groundingLocation,
        };
      }),
    };
  }

  /** Approve a card-shaped suggestion → mint a PARKED, un-due `card_draft` (T093). */
  approveAiCard(request: AiApproveRequest): AiApproveResult {
    return this.aiService.approveCard(request.suggestionId);
  }

  /** Dismiss a draft suggestion (soft) (T093). */
  dismissAiSuggestion(request: AiDismissRequest): AiDismissResult {
    return this.aiService.dismiss(request.suggestionId);
  }

  /** The AI disabled-state + disclosure data (T093) — NO key, only `keyConfigured`. */
  aiStatus(): AiStatusResult {
    return this.aiService.status();
  }

  /** Download / warm the local AI model (T093) — flips `aiModelDownloaded`. */
  downloadAiModel(): { downloaded: boolean } {
    return this.aiService.downloadModel();
  }

  // -------------------------------------------------------------------------
  // semantic.*  (T087 — on-device semantic search)
  // -------------------------------------------------------------------------

  /**
   * Fused semantic + FTS search (T087). Embeds the query via the runner
   * (`embedQuery` — a transient `persist:false` embed job, recovered from a
   * main-side map, with a short timeout so `/search` never hangs), runs the
   * `SemanticSearchRepository` fusion, and enriches each hit with the same row
   * metadata `search()` produces. Degrades to FTS-only (never throws) when
   * semantics are off / the model is absent / `vec0` failed to load / the query
   * embed timed out. The `mode` tells the UI which retrieval actually ran.
   */
  async semanticSearch(request: SemanticSearchRequest): Promise<SemanticSearchResult> {
    const settings = this.repos.settings.getAppSettings();
    const enabled = settings.semanticSearchEnabled && this.vecAvailable;

    // Embed the query only when semantics can run (else FTS-only, no job enqueued).
    const queryVector = enabled ? await this.embeddingService.embedQuery(request.q) : null;

    const runFused = (type?: SearchableType) =>
      this.repos.semanticSearch.search(request.q, {
        semanticEnabled: enabled,
        ...(queryVector ? { queryVector } : {}),
        ...(type ? { type } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      });
    const toCountRows = (
      hits: readonly {
        id: string;
        type: "source" | "extract" | "card";
        title: string;
        snippet: string;
        ftsScore?: number;
        vecDistance?: number;
        source: "fts" | "semantic" | "both";
      }[],
    ) =>
      hits
        .map((hit) => this.enrichFusedHit(hit))
        .filter((r): r is SemanticSearchResultRow => r !== null)
        .map((row) => ({
          id: row.id as ElementId,
          type: row.type,
          priority: row.priority as Priority,
        }));

    const fused = runFused(request.type);

    const results = fused.hits
      .map((hit) => this.enrichFusedHit(hit))
      .filter((r): r is SemanticSearchResultRow => r !== null);
    const countRows = toCountRows(fused.hits);
    const membership = this.repos.concepts.liveMembershipMapForMembers(
      countRows.map((row) => row.id),
    );
    const counts = foldSearchFacetCounts(countRows, membership, {
      ...(request.type ? { type: request.type } : {}),
    });
    for (const type of ["source", "extract", "card"] as const) {
      counts.byType[type] = toCountRows(runFused(type).hits).length;
    }

    const mode: SemanticSearchMode = !enabled
      ? "disabled"
      : fused.mode === "semantic"
        ? "semantic"
        : "fts";
    return { results, mode, counts };
  }

  /** Index-coverage + state for the Settings toggle + the library "N of M embedded" affordance. */
  semanticStatus(): SemanticStatusResult {
    const settings = this.repos.settings.getAppSettings();
    const stats = this.repos.embeddings.stats();
    return {
      enabled: settings.semanticSearchEnabled,
      vecAvailable: this.vecAvailable,
      modelDownloaded: settings.embeddingModelDownloaded,
      embedded: stats.embedded,
      total: stats.total,
      modelId: stats.modelId ?? settings.embeddingModelId,
    };
  }

  /**
   * Build the semantic index (T087): enqueue `embed` jobs for every live source/
   * extract/card that needs (re-)embedding. The renderer observes progress via the
   * existing `jobs.subscribe`. A no-op (0) when semantics are off / `vec0` is absent.
   */
  semanticReindex(request: SemanticReindexRequest): SemanticReindexResult {
    return this.embeddingService.reindexAll({
      ...(request.onlyMissing !== undefined ? { onlyMissing: request.onlyMissing } : {}),
    });
  }

  /**
   * Download the local embedding model on first enable (T087). The default local
   * provider runs the real `all-MiniLM-L6-v2` ONNX model, which `fastembed` streams
   * into the worker's `INTERLEAVE_MODEL_DIR` cache on first use; this seam pre-warms
   * that load and flips `embeddingModelDownloaded = true` once it resolves (it
   * degrades to the deterministic embedder offline). See
   * {@link EmbeddingService.downloadModel} for the mechanism + tradeoff.
   */
  async semanticDownloadModel(): Promise<{ downloaded: boolean }> {
    return this.embeddingService.downloadModel();
  }

  /**
   * Related-item suggestions for an element (T088) — a DERIVED read over the T087
   * `vec0` store + the concept lineage: similar extracts, possible duplicates,
   * prerequisite (ancestor) concepts, and sibling sources. No new relation types,
   * no `operation_log` writes, no lineage mutation. Degrades gracefully: the vector
   * buckets are empty (with `semanticAvailable: false`) when semantics are off /
   * `vec0` is absent / the element isn't embedded, while the concept + sibling
   * buckets still resolve from lineage. No raw vectors cross IPC.
   */
  semanticRelated(request: SemanticRelatedRequest): SemanticRelatedResult {
    const settings = this.repos.settings.getAppSettings();
    const semanticEnabled = settings.semanticSearchEnabled && this.vecAvailable;
    const result: RelatedResult = this.repos.related.related(request.elementId as ElementId, {
      semanticEnabled,
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });
    return {
      similar: result.similar.map((i) => this.toRelatedItem(i)),
      duplicates: result.duplicates.map((i) => this.toRelatedItem(i)),
      prerequisiteConcepts: result.prerequisiteConcepts.map((c) => ({
        id: c.id,
        name: c.name,
        level: c.level,
      })),
      siblingSources: result.siblingSources.map((i) => this.toRelatedItem(i)),
      semanticAvailable: result.semanticAvailable,
    };
  }

  /** Map a local-db {@link RelatedItem} to the IPC {@link SemanticRelatedItem} (no vectors). */
  private toRelatedItem(item: RelatedItem): SemanticRelatedItem {
    return {
      id: item.id,
      type: item.type,
      title: item.title,
      similarity: item.similarity ?? null,
      kind: item.kind,
      ref: item.ref ?? null,
    };
  }

  /**
   * The contradiction-detection service (T089), lazily built against the open DB.
   * Reuses {@link embeddingService}'s `buildText` (the exact text that was embedded)
   * + the shared `resolveSourceRef` so the heuristic compares the same content
   * keyword + semantic search index and the same lineage the refblock uses. A
   * DERIVED, HEURISTIC read — it writes nothing.
   */
  private get contradictionService(): ContradictionService {
    if (this.contradiction) return this.contradiction;
    this.contradiction = new ContradictionService({
      repositories: this.repos,
      buildText: (id) => this.embeddingService.buildText(id),
      resolveRef: (id) => resolveSourceRef(this.repos, id),
      vecAvailable: this.vecAvailable,
      semanticEnabled: () => this.repos.settings.getAppSettings().semanticSearchEnabled,
    });
    return this.contradiction;
  }

  /**
   * Possible-conflict flags for an element (T089) — a DERIVED, HEURISTIC, SUGGESTIVE
   * read: highly-similar `vec0` neighbors that ALSO carry an opposing/superseding
   * signal (negation, numeric divergence, a newer source). NEVER authoritative — it
   * never edits/suspends/reschedules, writes NO `operation_log`, persists NO
   * "conflict" relation, and never mutates lineage. Returns empty flags when
   * semantics are off / `vec0` is absent (the renderer hides the surface). No raw
   * vectors cross IPC. The flags re-derive from the persisted vectors + lineage after
   * an app restart.
   */
  semanticContradictions(request: SemanticContradictionsRequest): SemanticContradictionsResult {
    const flags = this.contradictionService.findForElement(request.elementId as ElementId);
    return {
      flags: flags.map((f) => ({
        otherId: f.otherId,
        otherType: f.otherType,
        otherTitle: f.otherTitle,
        otherRef: f.otherRef,
        selfRef: f.selfRef,
        reasons: f.reasons,
        severity: f.severity,
        newerSide: f.newerSide,
      })),
    };
  }

  /**
   * Enqueue an `embed` job for a freshly created/edited element (T087) — the
   * post-commit auto-embed seam. Fire-and-forget + gated on `semanticSearchEnabled`
   * inside the service; a no-op when off. Swallows errors so a mutation's response
   * never depends on the (async, off-main) index update.
   */
  private autoEmbed(elementId: ElementId): void {
    if (!this.vecAvailable) return;
    if (!this.runner) return;
    try {
      this.embeddingService.enqueueElement(elementId);
    } catch (error) {
      console.warn("[db-service] auto-embed enqueue failed (non-fatal):", error);
    }
  }

  /**
   * Enrich a fused hit into a full {@link SemanticSearchResultRow}, reusing the SAME
   * lineage/scheduler/due enrichment as `search()` so a semantic row renders
   * identically to a keyword row in the library (just labeled "related" when it came
   * purely from the vector side).
   */
  private enrichFusedHit(hit: {
    id: string;
    type: "source" | "extract" | "card";
    title: string;
    snippet: string;
    ftsScore?: number;
    vecDistance?: number;
    source: "fts" | "semantic" | "both";
  }): SemanticSearchResultRow | null {
    const element = this.repos.elements.findById(hit.id as ElementId);
    if (!element || element.deletedAt) return null;
    const { sourceTitle, sourceLocationLabel } = this.refMetaForElement(element.id);
    const inspectorData = this.inspectorQuery.get(element.id);
    const summary = this.queueQuery.summaryFor(element.id);
    const scheduler = inspectorData?.scheduler ?? {
      kind: "attention" as const,
      retrievability: null,
      stability: null,
      difficulty: null,
      reps: null,
      lapses: null,
      fsrsState: null,
      stage: element.stage,
      postponed: 0,
      lastProcessedAt: element.updatedAt ?? null,
    };
    return {
      id: element.id,
      type: hit.type,
      // A purely-semantic hit has no FTS title/snippet — fall back to the element row.
      title: hit.title || element.title,
      snippet: hit.snippet,
      score: hit.ftsScore ?? 0,
      priority: element.priority,
      priorityLabel: priorityToLabel(element.priority),
      concept: this.conceptForElement(element.id),
      sourceTitle,
      sourceLocationLabel,
      dueAt: summary?.dueAt ?? element.dueAt ?? null,
      scheduler,
      due: summary?.due ?? "soon",
      dueLabel: summary?.dueLabel ?? "Scheduled",
      semantic: hit.source === "semantic" || hit.source === "both",
      vecDistance: hit.vecDistance ?? null,
    };
  }

  /**
   * Enqueue OCR for a text-free PDF page (T066). The renderer ships the page PNG it
   * already rendered (the same render path the reader/region crop use); MAIN writes
   * it to the vault (`sources/<id>/ocr/page-N.png`) and enqueues an `ocr` job
   * carrying ONLY that vault-relative path (never the bytes — a persisted `jobs`
   * row holds no blob). The worker OCRs it on the runner; MAIN applies the result.
   * The renderer observes progress via the existing `jobs.subscribe` surface.
   */
  async runOcr(request: SourcesRunOcrRequest): Promise<SourcesRunOcrResult> {
    const { jobId } = await this.ocrService.enqueuePage({
      sourceElementId: request.elementId as ElementId,
      page: request.page,
      imagePng: request.imagePng,
    });
    return { enqueued: 1, jobId };
  }

  /**
   * Read a PDF source's OCR suggestion layer (T066) — the per-page recognized text
   * + confidence + review status the reader shows. Read-only.
   */
  getOcr(request: SourcesGetOcrRequest): SourcesGetOcrResult {
    return { pages: this.ocrService.listForSource(request.elementId as ElementId) };
  }

  /**
   * Accept a page's OCR text into the body (T066) — an explicit user action. Merges
   * the recognized lines into the page's empty "Page N" run through the normal
   * `documents.save` path (logging `update_document`, updating `plainText` → FTS),
   * so accepted OCR becomes ordinary searchable/extractable body text, and flips the
   * `ocr_pages` row to `accepted`. The text is NEVER auto-merged.
   */
  acceptOcr(request: SourcesAcceptOcrRequest): SourcesAcceptOcrResult {
    return this.ocrService.acceptPage(request.elementId as ElementId, request.page);
  }

  /** Dismiss a page's OCR suggestion (T066) — sets `dismissed`. */
  dismissOcr(request: SourcesAcceptOcrRequest): { dismissed: boolean } {
    return this.ocrService.dismissPage(request.elementId as ElementId, request.page);
  }

  /**
   * Verify the asset vault's integrity (T059) — re-hash every live asset's stored
   * bytes (streamed) and compare to the recorded `assets.content_hash`. Read-only;
   * returns the renderer-safe report (asset ids + extra-file relative paths). The
   * IPC handler delegates here; the renderer never resolves a path or reads bytes.
   */
  async verifyVault(): Promise<VaultVerifyResult> {
    const report: VaultIntegrityReport = await this.assetVaultService.verifyIntegrity();
    return {
      ok: report.ok,
      mismatched: report.mismatched,
      missing: report.missing,
      extraFiles: report.extraFiles,
    };
  }

  /**
   * Find orphaned vault FILES (T059) — files under `assets/` that no live `assets`
   * row references (the bytes a hard-purge's cascade left behind). Read-only; the
   * candidate set the confirm dialog shows before {@link collectVaultOrphans}.
   */
  async findVaultOrphans(): Promise<VaultOrphansResult> {
    const report: OrphanReport = await this.assetVaultService.findOrphans();
    return {
      orphans: report.orphans.map((o) => ({ relativePath: o.relativePath, size: o.size })),
      totalBytes: report.totalBytes,
    };
  }

  /**
   * Remove confirmed orphan files (T059) — guarded by `confirm: true`; the optional
   * `relativePaths` allow-list scopes removal to exactly the files the UI showed.
   * Never deletes a file any live asset row references (re-checked at removal time).
   */
  async collectVaultOrphans(
    request: VaultCollectOrphansRequest,
  ): Promise<VaultCollectOrphansResult> {
    return this.assetVaultService.collectOrphans({
      confirm: request.confirm,
      ...(request.relativePaths ? { relativePaths: request.relativePaths } : {}),
    });
  }

  // NOTE: URL import (T060) no longer has an inline `DbService.importFromUrl`
  // method. The renderer's `sources.importUrl` IPC handler now ENQUEUES a
  // `url_import` job on the background runner (T058) so the page FETCH runs
  // OFF-MAIN in the `utilityProcess` worker; MAIN applies the result through the
  // shared {@link urlImportService} (`importFromHtml`) — see ipc.ts +
  // job-apply-handlers.ts. The `UrlImportService.importFromUrl` inline path stays
  // available as a library method (used by M13's direct callers + the service
  // tests), but no main-side handler blocks the event loop on a network fetch.

  /** Live inbox-status source summaries (T012). */
  listInbox(): InboxListResult {
    return { items: this.inbox.list() };
  }

  /** Full preview payload for one inbox item, or `null` (T012). */
  getInboxItem(id: string): InboxGetResult {
    const detail = this.inbox.get(id as ElementId);
    if (!detail) return { detail: null };
    return {
      detail: {
        summary: detail.summary,
        provenance: {
          elementId: detail.provenance.elementId,
          url: detail.provenance.url,
          canonicalUrl: detail.provenance.canonicalUrl,
          originalUrl: detail.provenance.originalUrl,
          author: detail.provenance.author,
          publishedAt: detail.provenance.publishedAt,
          accessedAt: detail.provenance.accessedAt,
          reasonAdded: detail.provenance.reasonAdded,
          // Source-reliability metadata (T091).
          sourceType: detail.provenance.sourceType,
          reliabilityTier: detail.provenance.reliabilityTier,
          confidence: detail.provenance.confidence,
          reliabilityNotes: detail.provenance.reliabilityNotes,
        },
        bodyDoc: detail.bodyDoc,
        bodyText: detail.bodyText,
        bodyPreview: detail.bodyPreview,
      },
    };
  }

  /**
   * Apply one triage action to an inbox source (T012). Each branch runs through
   * {@link ElementRepository}, which mutates + appends the matching op in ONE
   * transaction:
   *  - `accept`       → `update_element` (status `active`)
   *  - `keepForLater` → `update_element` (status `dismissed`)
   *  - `setPriority`  → `update_element` (numeric priority from the label)
   *  - `delete`       → `soft_delete_element` (`deletedAt` + status `deleted`)
   */
  triageInboxItem(request: InboxTriageRequest): InboxTriageResult {
    const id = request.id as ElementId;
    const { action } = request;
    let deleted = false;
    this.require().db.transaction((tx) => {
      const current = tx.select().from(elements).where(eq(elements.id, id)).get();
      if (
        !current ||
        current.deletedAt ||
        current.type !== "source" ||
        current.status !== "inbox"
      ) {
        throw new Error("Inbox item is no longer available.");
      }
      switch (action.kind) {
        case "accept": {
          this.repos.elements.updateWithin(tx, id, { status: "active" });
          break;
        }
        case "keepForLater": {
          this.repos.elements.updateWithin(tx, id, { status: "dismissed" });
          break;
        }
        case "setPriority": {
          this.repos.elements.updateWithin(tx, id, {
            priority: priorityFromLabel(action.priority),
          });
          break;
        }
        case "delete": {
          this.repos.elements.softDeleteWithin(tx, id);
          deleted = true;
          break;
        }
      }
    });
    if (deleted) return { item: null, deleted: true };
    // After accept/keep the source leaves the inbox; after setPriority it stays.
    // Re-read it as a fresh summary so the renderer reflects the new state.
    const summary: InboxItemSummary | null = this.summaryForId(id);
    return { item: summary, deleted: false };
  }

  /** A fresh inbox summary for one source id (whatever its current status), or `null`. */
  private summaryForId(id: ElementId): InboxItemSummary | null {
    const element = this.repos.elements.findById(id);
    if (!element || element.deletedAt || element.type !== "source") return null;
    const provenance = this.repos.sources.findById(id)?.source ?? null;
    const doc = this.repos.documents.findById(id);
    const plainText = doc?.plainText ?? "";
    const normalized = plainText.replace(/\s+/g, " ").trim();
    const previewSnippet =
      normalized.length === 0
        ? null
        : normalized.length > 160
          ? `${normalized.slice(0, 160).trimEnd()}…`
          : normalized;
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      srcType: inboxSourceTypeLabel(provenance),
      author: provenance?.author ?? null,
      accessedAt: provenance?.accessedAt ?? null,
      charCount: plainText.length,
      previewSnippet,
    };
  }

  /**
   * Load an element's document body (T015) through {@link DocumentRepository}.
   * Returns the ProseMirror JSON + plain-text mirror + schema version, or `null`
   * when the element has no document row yet. Read-only; never re-parses the JSON.
   */
  getDocument(request: DocumentsGetRequest): DocumentsGetResult {
    const elementId = request.elementId as ElementId;
    const doc = this.repos.documents.findById(elementId);
    if (!doc) {
      return {
        document: null,
        extractedBlockIds: [],
        sourceFormat: null,
        mediaSource: null,
        mediaKind: null,
        blockPages: {},
        blockTimestamps: {},
      };
    }
    // Derive the source's already-extracted block ids from its child extracts'
    // source locations (lineage stays main-side; the reader only DISPLAYS them in
    // M3). Distinct + stable-ordered so the reader can mark `mark.extracted`.
    const extractedBlockIds = this.collectExtractedBlockIds(elementId);
    // Source-format detection. PDF (T064): a `.pdf` snapshot key. MEDIA (T073): the
    // authoritative `sources.media_kind` discriminator (NOT a snapshot derivation —
    // a transcript-less YouTube source has neither a vault asset nor a distinctive
    // snapshot key). The two never overlap (a PDF has no `media_kind`).
    const provenance = this.repos.sources.findById(elementId)?.source ?? null;
    const snapshotKey = provenance?.snapshotKey ?? null;
    const dbMediaKind = provenance?.mediaKind ?? null;
    const isPdf = typeof snapshotKey === "string" && snapshotKey.toLowerCase().endsWith(".pdf");
    const isMedia = dbMediaKind != null;

    const blockPages: Record<string, number> = {};
    const blockTimestamps: Record<string, number> = {};
    if (isPdf) {
      // The block→page map (T064) so the reader can set a page read-point + derive
      // the page of a selected block for the extract anchor.
      for (const block of this.repos.documents.listBlocks(elementId)) {
        if (typeof block.page === "number") blockPages[block.stableBlockId] = block.page;
      }
    } else if (isMedia) {
      // The block→time map (T073) so the reader can seek to a cue, highlight the
      // playing cue, and persist a timestamp read-point.
      for (const block of this.repos.documents.listBlocks(elementId)) {
        if (typeof block.timestampMs === "number") {
          blockTimestamps[block.stableBlockId] = block.timestampMs;
        }
      }
    }

    return {
      document: {
        prosemirrorJson: doc.prosemirrorJson,
        plainText: doc.plainText,
        schemaVersion: doc.schemaVersion,
        updatedAt: doc.updatedAt,
      },
      extractedBlockIds,
      sourceFormat: isPdf ? "pdf" : isMedia ? "video" : null,
      // `media_kind === "youtube"` → an IFrame embed; `"video"`/`"audio"` → a local
      // `media://` stream. `null` for non-media sources.
      mediaSource: isMedia ? (dbMediaKind === "youtube" ? "youtube" : "local") : null,
      mediaKind: dbMediaKind === "video" || dbMediaKind === "audio" ? dbMediaKind : null,
      blockPages,
      blockTimestamps,
    };
  }

  /**
   * The DISTINCT stable block ids in a source's body that have a child extract
   * anchored to them (T018 display markers). Reads the source's `source_locations`
   * (each extract's anchor stores the block ids it covers) — read-only lineage,
   * computed main-side so the renderer never touches the DB. Returns `[]` for
   * elements with no anchors (including non-sources).
   */
  private collectExtractedBlockIds(sourceElementId: ElementId): string[] {
    const locations = this.repos.sources.listLocationsForSource(sourceElementId);
    const seen = new Set<string>();
    for (const loc of locations) {
      for (const blockId of loc.blockIds) seen.add(blockId);
    }
    return [...seen];
  }

  /**
   * Upsert an element's document body (T015 + T016) through
   * {@link DocumentRepository}, which persists the body + `plainText`, replaces
   * the stable `document_blocks`, and appends `update_document` in ONE
   * transaction. The main process stores EXACTLY what the renderer sent — it does
   * not re-parse ProseMirror or re-mint ids (the renderer already enforced the
   * constrained schema, computed `plainText`, and derived the stable block list
   * via `toBlockInputs`). The `blocks` carry the STABLE ids; persisting them
   * verbatim is what preserves the lineage anchor across saves. When `blocks` is
   * omitted, the existing block set is left untouched.
   */
  saveDocument(request: DocumentsSaveRequest): DocumentsSaveResult {
    const saved = this.repos.documents.upsert({
      elementId: request.elementId as ElementId,
      prosemirrorJson: request.prosemirrorJson,
      plainText: request.plainText,
      ...(request.schemaVersion !== undefined ? { schemaVersion: request.schemaVersion } : {}),
      ...(request.blocks !== undefined
        ? {
            blocks: request.blocks.map((b) => ({
              blockType: b.blockType,
              order: b.order,
              stableBlockId: b.stableBlockId as BlockId,
            })),
          }
        : {}),
    });
    // T087 auto-embed: re-embed the owning source AFTER the document write committed
    // (inside `documents.upsert`'s own tx) — never inside that tx (embedding is async
    // + off-main and must not ride the write transaction). The content hash skips an
    // unchanged body.
    this.autoEmbed(request.elementId as ElementId);
    return {
      document: {
        prosemirrorJson: saved.prosemirrorJson,
        plainText: saved.plainText,
        schemaVersion: saved.schemaVersion,
        updatedAt: saved.updatedAt,
      },
    };
  }

  /**
   * Add a document mark (T020 highlight; reused by T021/T026) over a STABLE block
   * range through {@link DocumentRepository}, which inserts the `document_marks`
   * row and appends `update_document` in ONE transaction. A mark is an annotation,
   * NOT an element — no `elements` row is created. The renderer-supplied `markType`
   * is already validated against `MARK_TYPES` at the IPC boundary.
   */
  addDocumentMark(request: DocumentMarksAddRequest): DocumentMarksAddResult {
    const mark = this.repos.documents.addMark({
      elementId: request.elementId as ElementId,
      blockId: request.blockId as BlockId,
      markType: request.markType as MarkType,
      range: [request.range[0], request.range[1]],
      attrs: request.attrs ?? null,
    });
    return { mark: markToPayload(mark) };
  }

  /**
   * Remove one document mark by id (T020) through {@link DocumentRepository},
   * which deletes the annotation row and logs `update_document` in ONE
   * transaction. The source BODY is untouched. Returns whether a row was removed.
   */
  removeDocumentMark(request: DocumentMarksRemoveRequest): DocumentMarksRemoveResult {
    const removed = this.repos.documents.removeMark(request.markId);
    return { removed };
  }

  /**
   * List an element's document marks (T020), optionally filtered to one kind
   * (e.g. only highlights). Read-only; the renderer renders them as overlay
   * decorations keyed by stable block id + range.
   */
  listDocumentMarks(request: DocumentMarksListRequest): DocumentMarksListResult {
    const elementId = request.elementId as ElementId;
    const marks = request.markType
      ? this.repos.documents.listMarksByType(elementId, request.markType as MarkType)
      : this.repos.documents.listMarks(elementId);
    return { marks: marks.map(markToPayload) };
  }

  /** The extraction service (T021), bound to the open database. */
  private get extractionService(): ExtractionService {
    if (!this.extraction) {
      throw new Error("DbService: database is not open");
    }
    return this.extraction;
  }

  /**
   * Lift selected source text into a new independent, attention-scheduled `extract`
   * element (T021 — the keystone) via {@link ExtractionService}. In ONE transaction
   * the service creates the extract element + its `source_locations` anchor, seeds
   * the extract's own document body, adds a `derived_from` relation to its
   * source/parent, inherits the source's priority + tags, sets an initial attention
   * `due_at` (status `scheduled`; NEVER an FSRS `review_states` row), and marks the
   * parent body `extracted_span`. A throw anywhere rolls the whole extraction back.
   *
   * The priority is INHERITED from the source by default (the A/B/C/D label, when
   * supplied, overrides it); the title is derived from the selection main-side. The
   * renderer-supplied payload is already validated against the contract schema at
   * the IPC boundary.
   */
  createExtraction(request: ExtractionCreateRequest): ExtractionCreateResult {
    const sourceElementId = request.sourceElementId as ElementId;
    const sourceElement = this.repos.elements.findById(sourceElementId);
    if (!sourceElement || sourceElement.deletedAt) {
      throw new Error(`DbService.createExtraction: source ${sourceElementId} not found`);
    }
    // Inherit the source's numeric priority unless the renderer overrode it.
    const priority: Priority = request.priority
      ? priorityFromLabel(request.priority)
      : sourceElement.priority;

    const { element, location } = this.extractionService.createExtraction({
      sourceElementId,
      parentId: request.parentId as ElementId | undefined,
      selectedText: request.selectedText,
      blockIds: request.blockIds as BlockId[],
      startOffset: request.startOffset,
      endOffset: request.endOffset,
      title: request.title,
      label: request.label ?? undefined,
      page: request.page ?? null,
      priority,
    });

    // T087 auto-embed the new extract (post-commit, fire-and-forget, gated on the setting).
    this.autoEmbed(element.id);

    return {
      extract: {
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        dueAt: element.dueAt,
        sourceId: element.sourceId,
        parentId: element.parentId,
      },
      location: {
        id: location.id,
        sourceElementId: location.sourceElementId,
        blockIds: location.blockIds,
        startOffset: location.startOffset,
        endOffset: location.endOffset,
        label: location.label,
        selectedText: location.selectedText,
      },
    };
  }

  /** The card-authoring service (T032), bound to the open database. */
  private get cards(): CardService {
    if (!this.cardService) {
      throw new Error("DbService: database is not open");
    }
    return this.cardService;
  }

  /**
   * Author a card (Q&A or cloze) from an extract (T032 — the M6 keystone) via
   * {@link CardService}. In ONE transaction the service creates the `card` element
   * (stage `card_draft`) + its `cards` row (`kind`/prompt/answer/cloze + the
   * INHERITED `sourceLocationId` anchor) + an UN-DUE `review_states` row
   * (`fsrsState = "new"`, `dueAt = null`), inherits the extract's priority + tags,
   * and links the card to a `sibling_group`. Logs `create_element` + `create_card`
   * (+ `add_tag`/`add_relation`). A throw anywhere rolls the whole card back.
   *
   * **Two-scheduler split (load-bearing):** M6 does NO FSRS math — the card is
   * authored at `card_draft` and parked un-due; M7 (T036) owns the first FSRS
   * schedule + the `card_draft → active_card` transition. The originating extract is
   * UNCHANGED (still its own attention-scheduled element).
   *
   * The priority is INHERITED from the extract by default (the A/B/C/D label, when
   * supplied, overrides it, mapped to a numeric value here main-side); the title is
   * derived from the body main-side when absent. The renderer-supplied payload is
   * already validated against the contract schema (incl. the coarse Q&A/cloze
   * non-empty check) at the IPC boundary.
   */
  createCard(request: CardsCreateRequest): CardsCreateResult {
    const extractId = request.extractId as ElementId;
    const extract = this.repos.elements.findById(extractId);
    if (!extract || extract.deletedAt) {
      throw new Error(`DbService.createCard: extract ${extractId} not found`);
    }
    const { element, siblingGroupId, sourceLocationId, mediaRef } = this.cards.createFromExtract({
      extractId,
      kind: request.kind as CardKind,
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      ...(request.answer !== undefined ? { answer: request.answer } : {}),
      ...(request.cloze !== undefined ? { cloze: request.cloze } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
      // Inherit the extract's numeric priority unless the renderer overrode it.
      ...(request.priority ? { priority: priorityFromLabel(request.priority) } : {}),
      ...(request.siblingGroupId
        ? { siblingGroupId: request.siblingGroupId as SiblingGroupId }
        : {}),
      // Audio-card carrier (T075): an explicit ref wins; when omitted the service
      // derives it from a clip `media_fragment` extract (defaulting the loop to prompt).
      // The contract's `sourceElementId` is a validated string; brand it for the domain.
      ...(request.mediaRef != null
        ? {
            mediaRef: {
              ...request.mediaRef,
              sourceElementId: request.mediaRef.sourceElementId as ElementId,
            },
          }
        : request.mediaRef === null
          ? { mediaRef: null }
          : {}),
    });
    // T087 auto-embed the new card (post-commit, fire-and-forget, gated on the setting).
    this.autoEmbed(element.id);
    return {
      card: {
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        kind: request.kind,
        parentId: element.parentId,
        sourceId: element.sourceId,
        siblingGroupId,
        mediaRef,
        // A freshly authored card is never retired (T082).
        isRetired: false,
      },
      sourceLocationId,
    };
  }

  /** The image-occlusion card-generation service (T071), bound to the open database. */
  private get occlusion(): OcclusionService {
    if (!this.occlusionService) {
      throw new Error("DbService: database is not open");
    }
    return this.occlusionService;
  }

  /**
   * Generate N sibling `image_occlusion` cards (T071) from a `media_fragment`
   * image extract + the drawn masks, in ONE transaction. The renderer ships only
   * the element id + the vector masks (the base image bytes already live in the
   * vault); MAIN mints one `image_occlusion` `card` per mask, all in one
   * `sibling_group`, via {@link OcclusionService}. Masks are stored SEPARATELY from
   * the base image (the `occlusion_masks` table) — the cropped PNG is never mutated.
   *
   * The priority is INHERITED from the image extract by default (the A/B/C/D label,
   * when supplied, overrides it, mapped to a numeric value here main-side). Each
   * card is `card_draft` with an UN-DUE `review_states` row (FSRS — M7 first-
   * schedules it); the originating `media_fragment` stays an ATTENTION item.
   */
  generateOcclusionCards(request: CardsGenerateOcclusionRequest): CardsGenerateOcclusionResult {
    const imageElementId = request.imageElementId as ElementId;
    const image = this.repos.elements.findById(imageElementId);
    if (!image || image.deletedAt) {
      throw new Error(`DbService.generateOcclusionCards: image ${imageElementId} not found`);
    }
    const result = this.occlusion.generate({
      imageElementId,
      masks: request.masks.map((m) => ({
        region: m.region,
        label: m.label ?? null,
      })),
      // Inherit the image's numeric priority unless the renderer overrode it.
      ...(request.priority ? { priority: priorityFromLabel(request.priority) } : {}),
    });
    return {
      siblingGroupId: result.siblingGroupId,
      cards: result.cards.map((c) => ({
        id: c.id,
        type: c.type,
        status: c.status,
        stage: c.stage,
        priority: c.priority,
        title: c.title,
        kind: c.kind,
        parentId: c.parentId,
        sourceId: c.sourceId,
        siblingGroupId: c.siblingGroupId,
        // An occlusion card is never an audio card (the audio carrier is text-card only).
        mediaRef: null,
        // A freshly generated card is never retired (T082).
        isRetired: false,
      })),
    };
  }

  /** The in-review card-repair service (T038), bound to the open database. */
  private get cardEdit(): CardEditService {
    if (!this.cardEditService) {
      throw new Error("DbService: database is not open");
    }
    return this.cardEditService;
  }

  /** The leech remediation seam (T085), bound to the open database. */
  private get cardRemediation(): CardRemediationService {
    if (!this.cardRemediationService) {
      throw new Error("DbService: database is not open");
    }
    return this.cardRemediationService;
  }

  /** Map a {@link CardEditResult} (element + cards row) onto the flat wire shape. */
  private toCardEditSummary(result: {
    element: {
      id: ElementId;
      type: string;
      status: string;
      stage: string;
      priority: number;
      title: string;
      parentId: ElementId | null;
      sourceId: ElementId | null;
      deletedAt: string | null;
    };
    card: {
      kind: string;
      prompt: string | null;
      answer: string | null;
      cloze: string | null;
      isLeech: boolean;
      isRetired: boolean;
    };
  }): CardEditSummary {
    const { element, card } = result;
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      kind: card.kind,
      prompt: card.prompt,
      answer: card.answer,
      cloze: card.cloze,
      parentId: element.parentId,
      sourceId: element.sourceId,
      flagged: this.cardEdit.isFlagged(element.id),
      // The durable leech flag (T040) lives on the `cards` row.
      leech: card.isLeech,
      // The durable retirement flag (T082) lives on the `cards` row.
      retired: card.isRetired,
      deleted: element.deletedAt != null,
    };
  }

  /**
   * Edit a card's body in review (T038) via {@link CardEditService.updateBody}: the
   * `cards` row's prompt/answer (Q&A) or cloze text is updated, `elements.updatedAt`
   * is stamped, and `update_element` is logged — all in ONE transaction. Lineage
   * (`sourceLocationId`), the FSRS `review_states`, and the append-only `review_logs`
   * are NEVER touched (an edit must not corrupt the in-flight FSRS state). The body
   * is kept non-empty for the card's kind; the rich card-quality gate is M6/T035.
   */
  updateCard(request: CardsUpdateRequest): CardsUpdateResult {
    const result = this.cardEdit.updateBody(request.cardId as ElementId, {
      ...(request.prompt !== undefined ? { prompt: request.prompt } : {}),
      ...(request.answer !== undefined ? { answer: request.answer } : {}),
      ...(request.cloze !== undefined ? { cloze: request.cloze } : {}),
    });
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * Set/clear a card's claim-lifetime fields (T090) via {@link CardEditService.setLifetime}:
   * writes the six `cards` columns + logs `update_element` in ONE transaction (no new
   * op type; "expired" stays a DERIVED attribute, the card never leaves
   * `active`/`scheduled`). An omitted field is left unchanged; an explicit `null`/`""`
   * clears it. Returns the edited card + the freshly-derived expiry status so the
   * inspector reflects the new badge/rows without a re-fetch.
   */
  setCardLifetime(request: CardsSetLifetimeRequest): CardsSetLifetimeResult {
    const result = this.cardEdit.setLifetime(request.cardId as ElementId, {
      ...(request.factStability !== undefined ? { factStability: request.factStability } : {}),
      ...(request.validFrom !== undefined ? { validFrom: request.validFrom } : {}),
      ...(request.validUntil !== undefined ? { validUntil: request.validUntil } : {}),
      ...(request.jurisdiction !== undefined ? { jurisdiction: request.jurisdiction } : {}),
      ...(request.softwareVersion !== undefined
        ? { softwareVersion: request.softwareVersion }
        : {}),
      ...(request.reviewBy !== undefined ? { reviewBy: request.reviewBy } : {}),
    });
    const fields = cardRowToLifetime(result.card);
    const lifetime: FactLifetimeSummary = {
      ...fields,
      status: deriveExpiryStatus(fields, new Date()),
    };
    return { card: this.toCardEditSummary(result), lifetime };
  }

  /**
   * Suspend a card in review (T038) via {@link CardEditService.suspend}: status
   * `suspended` (`update_element`). The card drops out of `QueueRepository.dueCards`
   * (which excludes suspended) but keeps its `review_states` + `review_logs`,
   * recoverable by un-suspending.
   */
  suspendCard(request: CardsSuspendRequest): CardsSuspendResult {
    const result = this.cardEdit.suspend(request.cardId as ElementId);
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * SOFT-delete a card in review (T038) via {@link CardEditService.delete}
   * (`soft_delete_element`): `deletedAt` + status `deleted`, never a hard DELETE.
   * Lineage references remain valid and it is restorable from the trash (T044).
   */
  deleteCard(request: CardsDeleteRequest): CardsDeleteResult {
    const result = this.cardEdit.delete(request.cardId as ElementId);
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * Flag/un-flag a card as bad in review (T038) via {@link CardEditService.flag} — a
   * non-destructive QUALITY marker stored in the `update_element` op payload (no new
   * column; the durable leech/flag migration is T040's). The card stays in the deck;
   * its body, lineage, and FSRS state are untouched. Logs `update_element`.
   */
  flagCard(request: CardsFlagRequest): CardsFlagResult {
    const result = this.cardEdit.flag(
      request.cardId as ElementId,
      request.flagged,
      request.reason ?? null,
    );
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * Set / clear a card's durable leech flag (T040) via
   * {@link ReviewRepository.setCardLeech}: writes `cards.is_leech` + logs
   * `update_element` in ONE transaction (no new op type). Backs the manual "Mark
   * leech" button and un-leeching a remediated card after a rewrite. Flagging never
   * destroys the card or its `review_logs`; the card stays in the deck (leech is
   * flag + warn, not auto-suspend).
   */
  markLeechCard(request: CardsMarkLeechRequest): CardsMarkLeechResult {
    const result = this.repos.review.setCardLeech(request.cardId as ElementId, request.leech);
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * Split a failing card (T085) into atomic sibling cards via
   * {@link CardRemediationService.split}. Each new card inherits the original's
   * lineage (`parentId`/`sourceLocationId`/priority/tags) with a FRESH `review_states`
   * row (a split card is a NEW card — never copies the original's FSRS memory), all in
   * one `sibling_group`; the original is soft-deleted (default) or suspended. ONE
   * transaction; logs `create_card` ×N + `add_relation` + `soft_delete_element`/
   * `update_element`. The original's `review_logs` history survives.
   */
  splitCard(request: CardsSplitRequest): CardsSplitResult {
    const { cards, siblingGroupId } = this.cardRemediation.split({
      cardId: request.cardId as ElementId,
      parts: request.parts.map((p) => ({
        kind: p.kind as CardKind,
        ...(p.prompt !== undefined ? { prompt: p.prompt } : {}),
        ...(p.answer !== undefined ? { answer: p.answer } : {}),
        ...(p.cloze !== undefined ? { cloze: p.cloze } : {}),
      })),
      ...(request.originalDisposition ? { originalDisposition: request.originalDisposition } : {}),
    });
    return {
      cards: cards.map(({ element, card }) => ({
        id: element.id,
        type: element.type,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        kind: card.kind,
        parentId: element.parentId,
        sourceId: element.sourceId,
        siblingGroupId,
        // A split text card carries no audio clip; it is a fresh, non-retired card.
        mediaRef: null,
        isRetired: false,
      })),
    };
  }

  /**
   * Append a clarifying CONTEXT NOTE to a card (T085) via
   * {@link CardRemediationService.addContext}: an op-payload marker (no new column),
   * `update_element`. The card stays in rotation; body/`review_states`/lineage are
   * untouched. Returns the card summary + the accumulated context note.
   */
  addCardContext(request: CardsAddContextRequest): CardsAddContextResult {
    const result = this.cardRemediation.addContext(request.cardId as ElementId, request.note);
    return { card: this.toCardEditSummary(result.card), context: result.context };
  }

  /**
   * Send a card's parent EXTRACT back into the attention queue (T085) via
   * {@link CardRemediationService.backToExtract}: reactivate it to DUE-NOW on the
   * ATTENTION scheduler (`reschedule_element`, never `review_states`) and dispose the
   * card (default suspend). Returns the reactivated extract summary, or `null` when the
   * card has no live parent extract. The ONLY remediation action touching attention.
   */
  backToExtractCard(request: CardsBackToExtractRequest): CardsBackToExtractResult {
    const { extract } = this.cardRemediation.backToExtract(
      request.cardId as ElementId,
      request.cardDisposition,
    );
    return {
      extract: extract
        ? {
            id: extract.id,
            type: extract.type,
            status: extract.status,
            stage: extract.stage,
            priority: extract.priority,
            title: extract.title,
            dueAt: extract.dueAt,
          }
        : null,
    };
  }

  /**
   * The leech cleanup view's read (T040) — every card flagged a leech (auto after
   * ≥4 lapses, or manual) with its lapse count + source. Composes
   * {@link ReviewRepository.listLeechCards} (the durable `cards.is_leech` query,
   * most-lapsed first) with each card's lineage source title + location label.
   * Read-only — no mutation, no `operation_log`. Soft-deleted cards are excluded;
   * suspended cards are kept (the cleanup view is where they are repaired).
   */
  reviewLeeches(): ReviewLeechesResult {
    const leeches = this.repos.review.listLeechCards();
    const cards: LeechSummary[] = leeches.map((leech) => {
      const { element, card } = leech;
      const sourceLocationId = card.sourceLocationId as SourceLocationId | null;
      const location = sourceLocationId
        ? this.repos.sources.findLocationById(sourceLocationId)
        : null;
      const sourceEl = element.sourceId ? this.repos.elements.findById(element.sourceId) : null;
      const sourceTitle = sourceEl && !sourceEl.deletedAt ? sourceEl.title : null;
      // The originating extract (T085) — `parentId` filtered to a LIVE `extract`
      // element; `null` when the parent is missing/soft-deleted/not an extract (e.g.
      // an Anki-imported card). Drives the screen's Back-to-extract enable/disable.
      const parent = element.parentId ? this.repos.elements.findById(element.parentId) : null;
      const parentExtractId =
        parent && !parent.deletedAt && parent.type === "extract" ? parent.id : null;
      return {
        id: element.id,
        kind: card.kind,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        prompt: card.prompt,
        answer: card.answer,
        cloze: card.cloze,
        lapses: leech.lapses,
        reps: leech.reps,
        sourceTitle,
        sourceLocationLabel: location?.label ?? null,
        // T085: the id (for Open source's jump fetch) + the originating extract id.
        sourceLocationId: sourceLocationId ?? null,
        parentExtractId,
        // T085: the latest op-log-derived context note (so an added note re-appears
        // after the list refreshes — making the prompt answerable, not just logged).
        context: this.cardRemediation.contextNote(element.id),
      };
    });
    return { cards };
  }

  /** The mature-card retirement seam (T082), bound to the open database. */
  private get cardRetirement(): CardRetirementService {
    if (!this.cardRetirementService) {
      throw new Error("DbService: database is not open");
    }
    return this.cardRetirementService;
  }

  /**
   * Retire a card (T082) via {@link CardRetirementService.retire}: flips the durable
   * `cards.is_retired` flag in ONE transaction, logging `update_element` (no new op
   * type). The card drops out of the due/review reads by the flag (a `cards` join in
   * `QueueRepository.dueCards`), while keeping its `review_states`/`review_logs`/
   * lineage. Reversible; NEVER a soft delete. When `lowRetention` is set, also
   * floor-clamps the per-card retention override (a convenience, not the mechanism).
   */
  retireCard(request: CardsRetireRequest): CardsRetireResult {
    const result = this.cardRetirement.retire(request.cardId as ElementId, {
      ...(request.reason !== undefined ? { reason: request.reason } : {}),
      ...(request.lowRetention !== undefined ? { lowRetention: request.lowRetention } : {}),
    });
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * Un-retire a card (T082) via {@link CardRetirementService.unretire}: clears
   * `cards.is_retired` (`update_element`), returning the card to the normal due read
   * at its existing `review_states.due_at`.
   */
  unretireCard(request: CardsUnretireRequest): CardsUnretireResult {
    const result = this.cardRetirement.unretire(request.cardId as ElementId);
    return { card: this.toCardEditSummary(result) };
  }

  /**
   * The retired-card inventory read (T082) — every LIVE retired card with its body +
   * FSRS memory signals (stability/reps/lapses) + lineage source title/location.
   * Composes {@link CardRetirementService.listRetired} (most-mature first) with each
   * card's lineage. Read-only — no mutation, no `operation_log`.
   */
  cardsRetired(): CardsRetiredResult {
    const retired = this.cardRetirement.listRetired();
    const cards: RetiredCardSummary[] = retired.map((row) => {
      const { element, card } = row;
      const sourceLocationId = card.sourceLocationId as SourceLocationId | null;
      const location = sourceLocationId
        ? this.repos.sources.findLocationById(sourceLocationId)
        : null;
      const sourceEl = element.sourceId ? this.repos.elements.findById(element.sourceId) : null;
      const sourceTitle = sourceEl && !sourceEl.deletedAt ? sourceEl.title : null;
      return {
        id: element.id,
        kind: card.kind,
        status: element.status,
        stage: element.stage,
        priority: element.priority,
        title: element.title,
        prompt: card.prompt,
        answer: card.answer,
        cloze: card.cloze,
        stability: row.stability,
        reps: row.reps,
        lapses: row.lapses,
        sourceTitle,
        sourceLocationLabel: location?.label ?? null,
      };
    });
    return { cards };
  }

  /**
   * The sibling card ANSWERS under an extract (T086) — the read-only candidate set the
   * card builder feeds to the pure `detectInterference` similar-answer heuristic. Reads
   * the live `card` children of the extract via {@link ReviewRepository.listSiblingCardBodies}
   * and returns only the comparable bodies. Read-only — no mutation, no `operation_log`.
   */
  cardsSiblingAnswers(request: CardsSiblingAnswersRequest): CardsSiblingAnswersResult {
    const siblings = this.repos.review.listSiblingCardBodies(request.extractId as ElementId);
    return {
      cards: siblings.map((s) => ({ id: s.id, answer: s.answer, cloze: s.cloze })),
    };
  }

  /** The retention RESOLVER seam (T079), bound to the open database. */
  private get retentionService(): RetentionService {
    if (!this.retention) {
      throw new Error("DbService: database is not open");
    }
    return this.retention;
  }

  /** The FSRS parameter-optimization seam (T080), bound to the open database. */
  private get optimizationService(): OptimizationService {
    if (!this.optimization) {
      throw new Error("DbService: database is not open");
    }
    return this.optimization;
  }

  /** The workload-simulation seam (T081), bound to the open database. */
  private get workloadService(): WorkloadService {
    if (!this.workload) {
      throw new Error("DbService: database is not open");
    }
    return this.workload;
  }

  /**
   * Build (or reuse) the FSRS card scheduler for ONE card (T079) — the seam every FSRS
   * call routes through. Resolves the card's effective desired-retention target via the
   * {@link RetentionService} (per-card override → concept name → priority band → global)
   * and constructs/CACHES a {@link CardSchedulerService} for that target, keyed by the
   * ROUNDED retention (to `0.001`) so we build at most ~one scheduler per distinct
   * target, not per card. A `retention.*` write bumps {@link schedulerCacheGen}, which
   * the cache key embeds, so the next grade/preview re-resolves against the new targets.
   *
   * THE TWO-SCHEDULER SPLIT holds: this constructs the FSRS card scheduler only; the
   * attention scheduler is never reached here. The renderer is unchanged — it still
   * calls `review.grade`/`review.preview`; only the resolution behind them changes.
   */
  private schedulerForCard(cardElementId: ElementId): CardSchedulerService {
    if (!this.schedulerCache) {
      throw new Error("DbService: database is not open");
    }
    const { target } = this.retentionService.resolveForCard(cardElementId);
    // The card's resolved optimized FSRS params (T080): concept preset → global
    // preset → `null` (inherit ts-fsrs `default_w`). Passed through the documented
    // `CardSchedulerServiceOptions.params` escape hatch so resolved scheduling uses
    // the applied params; the scheduler is cached keyed by (retention, params sig).
    const params = this.retentionService.resolveParamsForCard(cardElementId);
    // Round to 0.001 so near-identical targets share one cached scheduler; embed the
    // cache generation so a settings/target write invalidates every cached scheduler,
    // and the params signature so a concept preset gets its own scheduler.
    const rounded = Math.round(target * 1000) / 1000;
    const paramsSig = params ? JSON.stringify(params) : "default";
    const key = `${this.schedulerCacheGen}:${rounded}:${paramsSig}`;
    const cached = this.schedulerCache.get(key);
    if (cached) return cached;
    const scheduler = new CardSchedulerService({
      desiredRetention: rounded,
      ...(params ? { params: { w: params } } : {}),
    });
    this.schedulerCache.set(key, scheduler);
    return scheduler;
  }

  /**
   * Invalidate the per-card scheduler cache (T079) after a retention target change so
   * the next grade/preview rebuilds against the new resolved targets. Cheap — a counter
   * bump; the cache lazily rebuilds. Called by every `retention.*` write path.
   */
  private bumpSchedulerCache(): void {
    this.schedulerCacheGen += 1;
  }

  // -------------------------------------------------------------------------
  // retention.*  (T079 — desired retention by priority band / concept / card)
  // -------------------------------------------------------------------------

  /**
   * The current desired-retention targets (T079): the global default, the per-band
   * enable flag + A/B/C/D band map (from {@link AppSettings}), and every LIVE concept
   * with its per-concept target (from {@link ConceptRepository.listConcepts}). Read-only.
   */
  getRetention(): RetentionGetResult {
    const settings = this.repos.settings.getAppSettings();
    const byConcept = this.repos.concepts.listConcepts().map((c) => ({
      conceptId: c.id,
      name: c.name,
      target: c.desiredRetention,
    }));
    return {
      global: settings.defaultDesiredRetention,
      byBandEnabled: settings.retentionByBandEnabled,
      byBand: settings.retentionByBand,
      byConcept,
    };
  }

  /**
   * Set/clear one priority-band desired-retention target (T079) → a
   * `settings.updateAppSettings` write of the merged `retentionByBand` map (settings
   * have no op). Bumps the per-card scheduler cache so the next grade/preview re-resolves.
   * Returns the refreshed full read.
   */
  setRetentionBand(request: RetentionSetBandRequest): RetentionUpdatedResult {
    const current = this.repos.settings.getAppSettings().retentionByBand;
    const nextBand: Partial<Record<PriorityLabel, number>> = { ...current };
    if (request.target === null) {
      delete nextBand[request.band];
    } else {
      nextBand[request.band] = request.target;
    }
    this.repos.settings.updateAppSettings({ retentionByBand: nextBand });
    this.bumpSchedulerCache();
    return { retention: this.getRetention() };
  }

  /**
   * Enable/disable the per-band retention feature (T079) → a `settings.updateAppSettings`
   * write. Bumps the scheduler cache; returns the refreshed full read.
   */
  setRetentionBandEnabled(request: RetentionSetBandEnabledRequest): RetentionUpdatedResult {
    this.repos.settings.updateAppSettings({ retentionByBandEnabled: request.enabled });
    this.bumpSchedulerCache();
    return { retention: this.getRetention() };
  }

  /**
   * Set/clear one concept's per-concept target (T079) → `concepts.desired_retention` +
   * an `update_element` audit on the concept element, in one transaction (clamped at the
   * repo write). Bumps the scheduler cache. Returns the concept's stored target.
   */
  setRetentionConcept(request: RetentionSetConceptRequest): RetentionSetConceptResult {
    const concept = this.repos.concepts.setConceptRetention(
      request.conceptId as ElementId,
      request.target,
    );
    this.bumpSchedulerCache();
    return {
      concept: { conceptId: concept.id, name: concept.name, target: concept.desiredRetention },
    };
  }

  /**
   * Set/clear a card's per-card override (T079) → `cards.desired_retention` + an
   * `update_element` audit on the card element, in one transaction (floor-clamped at the
   * service so it can never reach a self-retiring near-zero target). Bumps the scheduler
   * cache so the NEXT grade schedules against the new override.
   */
  setRetentionCard(request: RetentionSetCardRequest): RetentionSetCardResult {
    const { card } = this.retentionService.setCardRetention(
      request.cardId as ElementId,
      request.target,
    );
    this.bumpSchedulerCache();
    return { cardId: card.elementId, target: card.desiredRetention ?? null };
  }

  /**
   * Resolve a card's effective desired-retention target + which rule won (T079) — the
   * debug/inspector read. Returns `{ null, null }` for a non-card / unknown id. Read-only.
   */
  resolveRetentionFor(request: RetentionResolveForRequest): RetentionResolveForResult {
    const cardId = request.cardId as ElementId;
    const card = this.repos.review.findCardById(cardId);
    if (card?.element.type !== "card" || card.element.deletedAt) {
      return { target: null, source: null };
    }
    const { target, source } = this.retentionService.resolveForCard(cardId);
    return { target, source };
  }

  // -------------------------------------------------------------------------
  // optimization.*  (T080 — on-device FSRS parameter optimization)
  // -------------------------------------------------------------------------

  /**
   * Estimate a better FSRS parameter set for a scope from the user's review history
   * (T080) WITHOUT persisting anything, with a workload-impact preview. Card-only
   * (FSRS); an honest history-calibration estimate, never claimed optimal.
   *
   * ROUTING: a SMALL history fits INLINE (the bounded search is fast, so the caller
   * never blocks meaningfully); a LARGE history (≥ {@link HEAVY_FIT_REVIEW_THRESHOLD}
   * review rows, when a background runner is attached) is dispatched to the off-main
   * `fsrs_optimize` runner job so the heavy fit runs OFF the main thread — MAIN awaits
   * only the job's terminal snapshot (mirroring the await-terminal `importUrl` path),
   * then computes the DB-backed workload preview on the main side (the worker stays
   * DB-free). Either way the result shape is identical; nothing is persisted.
   */
  async suggestOptimization(
    request: OptimizationSuggestRequest,
  ): Promise<OptimizationSuggestResult> {
    const scope = request.scope as OptimizationScope;
    const suggestion = await this.fitSuggestion(scope);
    return {
      params: [...suggestion.params.w],
      baseline: suggestion.baseline,
      suggested: suggestion.suggested,
      improvement: suggestion.improvement,
      reviewsScored: suggestion.reviewsScored,
      method: suggestion.method,
      sufficientData: suggestion.sufficientData,
      workload: suggestion.workload,
    };
  }

  /**
   * Fit the suggestion for a scope, routing a LARGE history to the off-main runner
   * (T080). Returns the suggestion + its DB-backed workload preview. The runner branch
   * only engages when a runner is attached AND the history exceeds the heavy-fit
   * threshold; otherwise (and for any runner/worker failure) it falls back to the
   * bounded inline fit so a missing/failed runner never breaks the affordance.
   */
  private async fitSuggestion(
    scope: OptimizationScope,
  ): Promise<OptimizationSuggestionWithWorkload> {
    const service = this.optimizationService;
    const cardIds = service.cardIdsForScope(scope);
    if (this.runner && service.reviewCount(cardIds) >= HEAVY_FIT_REVIEW_THRESHOLD) {
      try {
        return await this.fitSuggestionOnRunner(scope);
      } catch {
        // The heavy fit is an estimate, not load-bearing — degrade to the inline
        // bounded search rather than surfacing a runner error to the user.
      }
    }
    return service.suggest(scope);
  }

  /**
   * Run the heavy fit on the background runner (T080): build the DB-free job payload,
   * enqueue an `fsrs_optimize` job, await its terminal snapshot, and recombine the
   * worker's suggestion with the DB-backed workload preview (computed here on MAIN so
   * the worker never touches the DB). Throws on a non-success terminal so the caller
   * can fall back to the inline fit.
   */
  private async fitSuggestionOnRunner(
    scope: OptimizationScope,
  ): Promise<OptimizationSuggestionWithWorkload> {
    if (!this.runner) {
      throw new Error("DbService: heavy FSRS fit requires a background runner");
    }
    const service = this.optimizationService;
    const payload = service.buildJobPayload(scope);
    const job = this.runner.enqueue("fsrs_optimize", payload as unknown as JobJsonValue);
    const terminal = await this.runner.waitForTerminal(job.id);
    if (terminal.status !== "succeeded" || !terminal.result) {
      throw new Error(`DbService: fsrs_optimize job ${job.id} did not succeed`);
    }
    // Re-wrap the worker's plain-JSON `w` + scores into a typed suggestion behind the
    // scheduler boundary (main never imports ts-fsrs), then attach the DB-backed
    // workload preview here on MAIN (the worker stays DB-free).
    const suggestion = optimizationSuggestionFromParts(
      terminal.result as unknown as OptimizationSuggestionParts,
    );
    return service.withWorkload(suggestion, scope);
  }

  /**
   * Apply an accepted FSRS parameter set (T080) — the only persisting optimization
   * command. Writes the queryable preset (the `fsrs.params.global` setting or
   * `concepts.fsrs_params` + an `update_element` audit) and bumps the per-card
   * scheduler cache so the NEXT grade/preview re-resolves against the new params.
   * No retroactive reschedule of existing cards.
   */
  applyOptimization(request: OptimizationApplyRequest): OptimizationApplyResult {
    const scope = request.scope as OptimizationScope;
    const result = this.optimizationService.apply(scope, request.params);
    this.bumpSchedulerCache();
    return result;
  }

  // -------------------------------------------------------------------------
  // workload.*  (T081 — workload simulation)
  // -------------------------------------------------------------------------

  /**
   * Preview how daily load shifts under a hypothetical change (T081) — altering desired
   * retention, adding N cards, or postponing low-priority material — BEFORE committing.
   * Builds the snapshot from the live tables and runs the pure projector. READ-ONLY:
   * mutates nothing (no due date / setting / op). The `change` is the Zod-validated
   * discriminated union; the result baseline is grounded in the same due reads the
   * queue/analytics report for the same clock.
   */
  simulateWorkload(request: WorkloadSimulateRequest): WorkloadSimulateResult {
    const change = request.change as WorkloadChange;
    const options: { asOf?: IsoTimestamp; windowDays?: number } = {};
    if (request.asOf !== undefined) options.asOf = request.asOf as IsoTimestamp;
    if (request.windowDays !== undefined) options.windowDays = request.windowDays;
    const projection = this.workloadService.simulate(change, options);
    return {
      days: projection.days,
      overBudgetDaysBefore: projection.overBudgetDaysBefore,
      overBudgetDaysAfter: projection.overBudgetDaysAfter,
      peakBefore: projection.peakBefore,
      peakAfter: projection.peakAfter,
      deltaNext7: projection.deltaNext7,
      deltaNext30: projection.deltaNext30,
      budget: projection.budget,
    };
  }

  /**
   * Preview the four possible next intervals for a card (T036) — the data the
   * review grade buttons render (T037). Reads the card's current `review_states`
   * via {@link ReviewRepository.findReviewState} and asks the FSRS
   * {@link CardSchedulerService} for the four outcomes. PURE: it mutates NOTHING (no
   * `review_states` write, no `operation_log`). Returns `null` when the id is not a
   * card or has no review state. The renderer reaches this only over validated IPC
   * (T037's `review.preview`); there is no generic `db.query`.
   */
  previewCardIntervals(
    cardElementId: ElementId,
    asOf: IsoTimestamp = new Date().toISOString() as IsoTimestamp,
  ): Record<ReviewRating, IntervalPreview> | null {
    const card = this.repos.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) return null;
    const state = this.repos.review.findReviewState(cardElementId);
    if (!state) return null;
    return this.schedulerForCard(cardElementId).previewIntervals(state, asOf);
  }

  /**
   * Grade one card (T036) — the FSRS write path. FSRS is for CARDS ONLY: this
   * rejects a non-card element so the engine never schedules an extract/source.
   * It reads the card's current `review_states`, asks the FSRS
   * {@link CardSchedulerService} to compute the next memory state (the FSRS math lives
   * in `packages/scheduler`, never here or in the repository), then persists it via
   * {@link ReviewRepository.recordReview} — which appends the immutable
   * `review_logs` row, advances `review_states` (due/stability/difficulty/elapsed/
   * scheduled/reps/lapses/fsrsState) + `elements.due_at`, and logs `add_review_log`,
   * ALL in one transaction. A `card_draft`/un-due card is moved to `active_card` on
   * its first real review (the `card_draft → active_card` transition). The renderer
   * reaches this only over validated IPC (T037's `review.grade`).
   */
  gradeCard(
    cardElementId: ElementId,
    rating: ReviewRating,
    responseMs: number,
    asOf: IsoTimestamp = new Date().toISOString() as IsoTimestamp,
  ): { reviewLog: ReviewLog; reviewState: ReviewState } {
    const card = this.repos.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) {
      throw new Error(`DbService.gradeCard: card ${cardElementId} not found`);
    }
    const state = this.repos.review.findReviewState(cardElementId);
    if (!state) {
      throw new Error(`DbService.gradeCard: review state for card ${cardElementId} missing`);
    }
    const outcome: ReviewOutcome = this.schedulerForCard(cardElementId).gradeCard(
      state,
      rating,
      asOf,
      responseMs,
    );
    // First real review promotes a parked draft card into active rotation
    // (`card_draft → active_card`) in the SAME transaction as the review log, so the
    // first review is atomic (no durable review log on a card still flagged draft).
    // Normally a card is already `active_card` (it is first-scheduled + activated at
    // creation), but this stays self-healing for any legacy un-activated draft.
    const reviewLog = this.repos.review.recordReview(cardElementId, outcome, {
      promoteFromDraft: card.element.stage === "card_draft",
    });
    const reviewState = this.repos.review.findReviewState(cardElementId);
    if (!reviewState) {
      throw new Error(`DbService.gradeCard: review state vanished after recordReview`);
    }
    return { reviewLog, reviewState };
  }

  /** The FSRS forgetting-curve constants (factor=19/81, decay=-0.5). */
  private static readonly FSRS_DECAY = -0.5;
  private static readonly FSRS_FACTOR = 19 / 81;

  /**
   * Approximate retrievability `R(t) = (1 + FACTOR · t / S)^DECAY` from stability
   * `S` (days) + days since the last review — the same pure presentation formula
   * the inspector/queue use for the `SchedulerChip`/`FsrsStats`. A never-reviewed
   * card has no meaningful value (`null`).
   */
  private static approximateRetrievability(
    stability: number,
    lastReviewedAt: string | null,
    asOfMs: number,
  ): number | null {
    if (!lastReviewedAt || stability <= 0) return null;
    const last = Date.parse(lastReviewedAt);
    if (Number.isNaN(last)) return null;
    const elapsedDays = Math.max(0, (asOfMs - last) / 86_400_000);
    const r = (1 + (DbService.FSRS_FACTOR * elapsedDays) / stability) ** DbService.FSRS_DECAY;
    return Math.min(1, Math.max(0, r));
  }

  /**
   * Assemble the flat {@link ReviewCardView} for one card element — everything the
   * review face needs WITHOUT a reveal round-trip (the answer/cloze/ref ship with
   * the card; the renderer hides them until reveal). Composes the `cards` row, the
   * `review_states` FSRS signals, the lineage source location (jump-to-source), the
   * owning source title, and the concept. Returns `null` for a non-card / deleted id.
   */
  private toReviewCardView(cardElementId: ElementId, asOfMs: number): ReviewCardView | null {
    const card = this.repos.review.findCardById(cardElementId);
    if (card?.element.type !== "card" || card.element.deletedAt) return null;
    const element = card.element;
    const state = this.repos.review.findReviewState(cardElementId);

    // Lineage: the card's source-location anchor (card → source location → source).
    const sourceLocationId = card.card.sourceLocationId as SourceLocationId | null;
    const location = sourceLocationId
      ? this.repos.sources.findLocationById(sourceLocationId)
      : null;

    // The owning source's title (provenance) for the refblock.
    const sourceId = element.sourceId;
    const sourceEl = sourceId ? this.repos.elements.findById(sourceId) : null;
    const sourceTitle = sourceEl && !sourceEl.deletedAt ? sourceEl.title : null;

    const retrievability = state
      ? DbService.approximateRetrievability(state.stability, state.lastReviewedAt, asOfMs)
      : null;

    // Claim-lifetime expiry block (T090): resolved from the card's six lifetime columns.
    // Present ONLY when the fact is STALE (derived status !== "fresh"); the renderer keeps
    // it hidden until reveal (a calm post-reveal "may be out of date" banner). A fresh /
    // lifetime-less card carries `expiry: null` (no banner).
    const lifetime: FactLifetime = cardRowToLifetime(card.card);
    const expiryStatus = deriveExpiryStatus(lifetime, new Date(asOfMs));
    const expiry: ReviewCardView["expiry"] =
      expiryStatus === "fresh"
        ? null
        : {
            status: expiryStatus,
            validUntil: lifetime.validUntil,
            reviewBy: lifetime.reviewBy,
            jurisdiction: lifetime.jurisdiction,
            softwareVersion: lifetime.softwareVersion,
          };

    // Image-occlusion render data (T071): resolved from `occlusion_masks` ONLY for
    // an `image_occlusion` card. The face loads the base image bytes through the
    // typed `getRegionImage` command (the masks are stored SEPARATELY); we ship the
    // card's own masked region + the sibling masks so the front can dim them too.
    let occlusion: ReviewCardView["occlusion"] = null;
    if (card.card.kind === "image_occlusion") {
      const mask = this.repos.occlusionMasks.findByCard(element.id);
      if (mask) {
        const siblings = this.repos.occlusionMasks
          .listForImage(mask.imageElementId as ElementId)
          .filter((m) => m.id !== mask.id);
        occlusion = {
          imageElementId: mask.imageElementId,
          region: mask.region,
          label: mask.label,
          otherRegions: siblings.map((m) => m.region),
        };
      }
    }

    // Audio-card render data (T075): the looped clip + face, resolved from the card's
    // `cards.media_ref` ONLY for an audio card (null otherwise). We also resolve the
    // media source's kind (`local`/`youtube` + video id) so the review face can play
    // WITHOUT a second `getMediaData` round-trip. The face seeks the ORIGINAL media —
    // no re-encoding. A malformed cell degrades to "no audio" (parseMediaRef returns
    // null), never a thrown review read.
    const mediaRef: MediaRef | null = parseMediaRef(card.card.mediaRef);
    let mediaSource: ReviewCardView["mediaSource"] = null;
    let youtubeId: string | null = null;
    if (mediaRef) {
      const resolved = this.resolveAudioMediaSource(mediaRef.sourceElementId as ElementId);
      mediaSource = resolved.mediaSource;
      youtubeId = resolved.youtubeId;
    }

    return {
      id: element.id,
      kind: card.card.kind,
      // The front prompt: a Q&A card's `prompt`; a cloze card's `cloze` text (the
      // renderer masks the `{{cN::…}}` spans until reveal).
      prompt: card.card.kind === "cloze" ? (card.card.cloze ?? "") : (card.card.prompt ?? ""),
      answer: card.card.answer,
      cloze: card.card.cloze,
      priority: element.priority,
      stage: element.stage,
      concept: this.conceptForElement(element.id),
      sourceTitle,
      sourceLocationLabel: location?.label ?? null,
      ref: location?.selectedText ?? null,
      // The enriched refblock (T043): title + URL + author + date + location +
      // snippet, resolved from the card's lineage with the SAME resolver the
      // inspector uses. Ships with the card but the renderer hides it until reveal.
      sourceRef: resolveSourceRef(this.repos, element.id),
      // Claim-lifetime expiry block (T090) — null unless the fact is stale; the
      // renderer hides it until reveal (the calm "may be out of date" banner).
      expiry,
      schedulerSignals: {
        kind: "fsrs",
        retrievability,
        stability: state?.stability ?? null,
        difficulty: state?.difficulty ?? null,
        reps: state?.reps ?? null,
        lapses: state?.lapses ?? null,
        fsrsState: state?.fsrsState ?? null,
      },
      // Leech surfacing (T040): the durable `cards.is_leech` flag set automatically
      // once `lapses` crosses the threshold (or manually). The review face shows the
      // leech banner + badge from this. `lapses` is the running lapse count.
      leech: card.card.isLeech,
      lapses: state?.lapses ?? 0,
      // Flag-as-bad (T038) — derived from the card's op-log (no column); the review
      // face shows the flag so the user sees a previously-flagged card resurface.
      flagged: this.cardEdit.isFlagged(element.id),
      // The card's sibling group (T039) — the renderer threads it forward so the
      // next `session.next` can bury it. `null` when the card has no siblings.
      siblingGroupId: this.reviewSessionService.siblingGroupOf(element.id),
      // Image-occlusion render data (T071) — null for non-occlusion cards.
      occlusion,
      // Audio-card render data (T075) — null for non-audio cards. The clip window +
      // face to loop, plus the resolved media-source kind so the face plays directly.
      mediaRef,
      mediaSource,
      youtubeId,
    };
  }

  /**
   * Resolve a media `source` element id → its playable kind for an audio card (T075):
   * `"local"` (a vault asset played via `media://`) or `"youtube"` (an IFrame Player) +
   * the YouTube video id. Read-only; mirrors {@link getMediaData}'s discriminator off
   * the authoritative `sources.media_kind` so the review face and the reader agree.
   */
  private resolveAudioMediaSource(mediaSourceElementId: ElementId): {
    mediaSource: "local" | "youtube";
    youtubeId: string | null;
  } {
    const provenance = this.repos.sources.findById(mediaSourceElementId)?.source ?? null;
    if (provenance?.mediaKind === "youtube") {
      return {
        mediaSource: "youtube",
        youtubeId: provenance.canonicalUrl ? parseYouTubeId(provenance.canonicalUrl) : null,
      };
    }
    return { mediaSource: "local", youtubeId: null };
  }

  /**
   * The first concept this element is a member of, or `null` — delegates to the
   * ONE shared {@link ConceptRepository.firstConceptName} (also used by the queue
   * + review meta lines) so every surface agrees on the displayed concept.
   */
  private conceptForElement(id: ElementId): string | null {
    return this.repos.concepts.firstConceptName(id);
  }

  /**
   * The next due card in the active-recall session (T037 + T039 sibling burying).
   * Reads the FSRS due deck (`QueueRepository.dueCards` — cards due by
   * `review_states.due_at`, soonest first), skips the `exclude` set (already-seen
   * cards), and caps the session at the `dailyReviewBudget` setting (the soft cap
   * on items surfaced per day, default 60 — read from {@link SettingsRepository}).
   * The budget bounds the WHOLE session: cards already reviewed (the `exclude` set)
   * count against it, so the surfaceable remainder is `budget − exclude.length`.
   *
   * **Sibling burying (T039):** within the budget-bounded deck, the next card is
   * chosen by {@link ReviewSessionService} — when burying is on (the persisted
   * `burySiblings` setting, overridable per-request), a card whose sibling group is
   * in `recentSiblingGroups` is skipped so siblings aren't shown back-to-back; if
   * every remaining card is a recent sibling, the soonest-due card is returned
   * anyway (never starve). The chosen card's `siblingGroupId` rides back on the
   * view so the renderer threads it into the next call. Burying is session-ordering
   * ONLY — it never mutates `review_states`/`due_at`/logs.
   *
   * **Cards only** (the two-scheduler split — attention items are not in the review
   * session). Read-only: no mutation, no `operation_log`.
   */
  reviewSessionNext(request: ReviewSessionNextRequest): ReviewSessionNextResult {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const asOfMs = Date.parse(asOf);
    const exclude = (request.exclude ?? []) as ElementId[];
    const settings = this.repos.settings.getAppSettings();
    // The daily review budget is the deck cap (soft cap on items surfaced per day).
    // It bounds the entire session, so cards already seen this session (the `exclude`
    // set) consume it — only `budget − seen` further cards may be surfaced.
    const surfaceableCap = Math.max(0, settings.dailyReviewBudget - exclude.length);
    // Burying defaults to the persisted setting; the request may override it (the
    // /settings toggle drives the setting, but a session can pass an explicit value).
    const burySiblings = request.burySiblings ?? settings.burySiblings;
    const next = this.reviewSessionService.nextReviewCard({
      asOf,
      exclude,
      burySiblings,
      limit: surfaceableCap,
      recentSiblingGroups: (request.recentSiblingGroups ?? []) as SiblingGroupId[],
    });
    const total = next.deckSize;
    if (!next.cardId) return { card: null, remaining: 0, total };
    // `toReviewCardView` resolves the card's `siblingGroupId` itself (it equals
    // `next.siblingGroupId`), so the renderer gets the group to bury on the next call.
    const card = this.toReviewCardView(next.cardId, asOfMs);
    if (!card) return { card: null, remaining: Math.max(0, total - 1), total };
    return { card, remaining: Math.max(0, total - 1), total };
  }

  /** The {@link ReviewSessionService} (sibling-aware deck ordering, T039). */
  private get reviewSessionService(): ReviewSessionService {
    if (!this.reviewSession) {
      throw new Error("DbService: database is not open");
    }
    return this.reviewSession;
  }

  /** The {@link ReviewModeService} (targeted subset selection, T096). */
  private get reviewModeService(): ReviewModeService {
    if (!this.reviewMode) {
      throw new Error("DbService: database is not open");
    }
    return this.reviewMode;
  }

  /**
   * Resolve a TARGETED review-mode deck (T096) — the ordered card SUBSET for a
   * `concept`/`source`/`branch`/`search`/`semantic`/`stale`/`leech`/`random` mode,
   * mapped through the SAME {@link toReviewCardView} the daily session ships so the
   * renderer gets reveal-ready views with no per-card round-trip. The selection
   * IGNORES `review_states.due_at` (a not-due card is selectable) — that is the
   * defining behavior; every other deck guard (live / `card` / not soft-deleted /
   * not deleted / not suspended / not retired) holds.
   *
   * For the `semantic` selector it awaits the existing `embeddingService.embedQuery`
   * (the `semanticSearch` path) and injects the vector, degrading to the keyword
   * resolver when semantics are off / `vec0` is unavailable / the embed timed out.
   * READ-ONLY: no mutation, no `operation_log`. Grading reuses the unchanged
   * `review.grade`. Cards only — the two-scheduler split holds.
   */
  async reviewModeDeck(request: ReviewModeDeckRequest): Promise<ReviewModeDeckResult> {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const asOfMs = Date.parse(asOf);
    const semantic = await this.resolveSemanticContext(request.selector);
    const deck = this.reviewModeService.deck(request.selector, asOf, semantic);
    const views: ReviewCardView[] = [];
    for (const id of deck.cardIds) {
      const view = this.toReviewCardView(id, asOfMs);
      // A view can be null only if the row was removed between selection + build (a
      // race) — drop it rather than ship a null; the count below stays the underlying
      // total so the header's "of N" still reflects the selected set.
      if (view) views.push(view);
    }
    return { deck: views, total: deck.total, label: deck.label, truncated: deck.truncated };
  }

  /**
   * The cheap count for the review-mode entry affordances (T096) — the SAME
   * selection as {@link reviewModeDeck} but returning only the subset size + label
   * (no full views built). Read-only.
   */
  async reviewModeCount(request: ReviewModeCountRequest): Promise<ReviewModeCountResult> {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const semantic = await this.resolveSemanticContext(request.selector);
    const { total, label } = this.reviewModeService.count(request.selector, asOf, semantic);
    return { total, label };
  }

  /**
   * Build the {@link SemanticResolveContext} for a `semantic` selector — embed the
   * query via the existing `embeddingService.embedQuery` (the `semanticSearch` seam)
   * ONLY when semantics are enabled AND `vec0` is available, else `null` so the
   * service degrades to the keyword resolver. For every NON-semantic selector it
   * returns `undefined` (no embed work). Mirrors `semanticSearch`'s gating exactly.
   */
  private async resolveSemanticContext(
    selector: ReviewModeDeckRequest["selector"],
  ): Promise<SemanticResolveContext | undefined> {
    if (selector.kind !== "semantic") return undefined;
    const settings = this.repos.settings.getAppSettings();
    const enabled = settings.semanticSearchEnabled && this.vecAvailable;
    const queryVector = enabled ? await this.embeddingService.embedQuery(selector.query) : null;
    return { enabled, queryVector };
  }

  /**
   * Fetch ONE card's full reveal-ready {@link ReviewCardView} by id (T037/T031) —
   * the SAME view {@link reviewSessionNext} ships, but TARGETED by id instead of
   * soonest-due. The process loop (T031) walks a FROZEN queue order with a cursor;
   * to reveal a card inline it needs that specific card's full view (answer / cloze
   * / source ref / FSRS signals), which the soonest-due session read cannot return.
   * Read-only: it wraps the private {@link toReviewCardView} (no mutation, no
   * `operation_log`). `card` is `null` for a non-card / deleted id. Cards only —
   * the two-scheduler split holds (this never touches the attention seam).
   */
  reviewCard(request: ReviewCardRequest): ReviewCardResult {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const asOfMs = Date.parse(asOf);
    const card = this.toReviewCardView(request.cardId as ElementId, asOfMs);
    return { card };
  }

  /**
   * Preview the four next intervals for a card's grade buttons (T037) via the FSRS
   * {@link CardSchedulerService} — wraps {@link previewCardIntervals} into the flat wire
   * shape. PURE: mutates nothing. `intervals` is `null` when the id is not a card or
   * has no review state.
   */
  reviewPreview(request: ReviewPreviewRequest): ReviewPreviewResult {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const previews = this.previewCardIntervals(request.cardId as ElementId, asOf);
    if (!previews) return { intervals: null };
    return {
      intervals: {
        again: previews.again,
        hard: previews.hard,
        good: previews.good,
        easy: previews.easy,
      },
    };
  }

  /**
   * Grade a card (T037) — the FSRS write path wrapped into the flat wire shape.
   * Delegates to {@link gradeCard} (which runs `CardSchedulerService.gradeCard` →
   * `ReviewRepository.recordReview`, appending the immutable `review_logs` row,
   * advancing `review_states` + `elements.due_at`, and logging `add_review_log` in
   * ONE transaction, plus the `card_draft → active_card` first-review promotion).
   * Records the response time. Cards only.
   */
  reviewGrade(request: ReviewGradeRequest): ReviewGradeResult {
    const asOf = (request.asOf ?? new Date().toISOString()) as IsoTimestamp;
    const { reviewLog, reviewState } = this.gradeCard(
      request.cardId as ElementId,
      request.rating as ReviewRating,
      request.responseMs,
      asOf,
    );
    return {
      reviewLog: {
        id: reviewLog.id,
        elementId: reviewLog.elementId,
        rating: reviewLog.rating,
        reviewedAt: reviewLog.reviewedAt,
        responseMs: reviewLog.responseMs,
        nextDueAt: reviewLog.nextDueAt,
      },
      reviewState: {
        dueAt: reviewState.dueAt,
        stability: reviewState.stability,
        difficulty: reviewState.difficulty,
        reps: reviewState.reps,
        lapses: reviewState.lapses,
        fsrsState: reviewState.fsrsState,
        lastReviewedAt: reviewState.lastReviewedAt,
      },
    };
  }

  private get extractService(): ExtractService {
    if (!this.extractReview) {
      throw new Error("DbService: database is not open");
    }
    return this.extractReview;
  }

  /** Map a domain {@link Element} into the flat `ExtractActionSummary` wire shape. */
  private toExtractActionSummary(element: {
    id: ElementId;
    type: string;
    status: string;
    stage: string;
    priority: number;
    title: string;
    dueAt: string | null;
    sourceId: ElementId | null;
    parentId: ElementId | null;
  }): ExtractActionSummary {
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      dueAt: element.dueAt,
      sourceId: element.sourceId,
      parentId: element.parentId,
    };
  }

  /**
   * Advance an extract `raw_extract → clean_extract → atomic_statement` (or set an
   * explicit stage when the stepper targets one) (T024) via {@link ExtractService}.
   * In ONE transaction the service persists the new `stage` (`update_element`) AND
   * reschedules the extract on the ATTENTION scheduler (`reschedule_element`) by the
   * by-stage interval — it never creates a card and never touches FSRS. The
   * renderer payload is already validated at the IPC boundary.
   */
  updateExtractStage(request: ExtractsUpdateStageRequest): ExtractsUpdateStageResult {
    const id = request.id as ElementId;
    const { element } = request.stage
      ? this.extractService.setStage(id, request.stage)
      : this.extractService.advanceStage(id);
    return { extract: this.toExtractActionSummary(element) };
  }

  /**
   * Rewrite (or trim) an extract's body (T024) via {@link ExtractService}, which
   * upserts the new ProseMirror body + stable blocks (logs `update_document`). The
   * lineage/anchor + scheduling are untouched — editing the text is not a stage
   * move. `trim` is a renderer-side normalization that flows through this command.
   */
  rewriteExtract(request: ExtractsRewriteRequest): ExtractsRewriteResult {
    const result = this.extractService.rewrite({
      elementId: request.id as ElementId,
      prosemirrorJson: request.prosemirrorJson,
      plainText: request.plainText,
      ...(request.blocks ? { blocks: request.blocks } : {}),
    });
    return {
      extract: this.toExtractActionSummary(result.element),
      plainText: result.plainText ?? request.plainText,
    };
  }

  /**
   * Postpone an extract (T024) via {@link ExtractService}: reschedule it further out
   * on the attention scheduler and record a postpone marker + running count in the
   * `reschedule_element` op payload (no schema migration), so the attention
   * scheduler (T028) + stagnation analytics (T084) can read the postpone history.
   */
  postponeExtract(request: ExtractsPostponeRequest): ExtractsPostponeResult {
    const id = request.id as ElementId;
    const { element } = this.extractService.postpone(id);
    return {
      extract: this.toExtractActionSummary(element),
      postponeCount: this.extractService.countPostpones(id),
    };
  }

  /**
   * Mark an extract done (T024): status `done` via {@link ExtractService}
   * (`update_element`). The extract leaves the active rotation; its body, anchor,
   * and lineage stay intact and recoverable.
   */
  markExtractDone(request: ExtractsMarkDoneRequest): ExtractsMarkDoneResult {
    const { element } = this.extractService.markDone(request.id as ElementId);
    return { extract: this.toExtractActionSummary(element) };
  }

  /**
   * SOFT-delete an extract (T024) via {@link ExtractService} (`soft_delete_element`):
   * `deletedAt` + status `deleted`, never a hard DELETE. User data is never
   * destroyed; lineage references remain valid and it is restorable from the trash.
   */
  deleteExtract(request: ExtractsDeleteRequest): ExtractsDeleteResult {
    const { element } = this.extractService.delete(request.id as ElementId);
    return { extract: this.toExtractActionSummary(element) };
  }

  // -------------------------------------------------------------------------
  // concepts.* / tags.*  (T041 — organize)
  // -------------------------------------------------------------------------

  /**
   * Create a hierarchical concept (T041) through {@link ConceptRepository}: the
   * `concept`-type element (logging `create_element`) AND its `concepts` row, in
   * ONE transaction. Validates the parent (when given) exists. No new op type.
   */
  createConcept(request: ConceptsCreateRequest): ConceptsCreateResult {
    const concept = this.repos.concepts.createConcept({
      name: request.name,
      ...(request.parentConceptId ? { parentConceptId: request.parentConceptId as ElementId } : {}),
    });
    return {
      concept: {
        id: concept.id,
        name: concept.name,
        parentConceptId: concept.parentConceptId,
        desiredRetention: concept.desiredRetention,
      },
    };
  }

  /**
   * All concepts as a flat hierarchy (id/name/parent + direct-child & member
   * counts) for the filterbar + the read-only concept map (T041). Read-only.
   */
  listConcepts(): ConceptsListResult {
    return {
      concepts: this.repos.concepts.listConcepts().map((c) => ({
        id: c.id,
        name: c.name,
        parentConceptId: c.parentConceptId,
        childCount: c.childCount,
        memberCount: c.memberCount,
        desiredRetention: c.desiredRetention,
      })),
    };
  }

  /**
   * Assign an element to a concept (T041) — add the `concept_membership` edge via
   * {@link ConceptRepository.assignConcept} (logs `add_relation`, idempotent).
   * Returns the element's refreshed `{ concepts, tags }`.
   */
  assignConcept(request: ConceptsAssignRequest): ConceptsAssignResult {
    this.repos.concepts.assignConcept(
      request.elementId as ElementId,
      request.conceptId as ElementId,
    );
    return { element: this.organizeState(request.elementId as ElementId) };
  }

  /** Unassign an element from a concept (T041) — remove the edge; logs `remove_relation`. */
  unassignConcept(request: ConceptsUnassignRequest): ConceptsUnassignResult {
    this.repos.concepts.unassignConcept(
      request.elementId as ElementId,
      request.conceptId as ElementId,
    );
    return { element: this.organizeState(request.elementId as ElementId) };
  }

  /**
   * The LIVE member elements of one concept (the `/concepts` knowledge-map
   * drill-in). Reads the member ids through the EXISTING
   * {@link ConceptRepository.elementsForConcept} (already excludes soft-deleted
   * members), then enriches each with the SAME fields a search/library row carries
   * — priority + label, owning-source title, the FSRS-vs-attention
   * {@link SchedulerSignals}, and the due state/label — by reusing the inspector +
   * queue builders, so a member row reads identically to a search/queue/library
   * row (no duplicated scheduling math). Read-only (appends no op).
   */
  conceptMembers(request: ConceptsMembersRequest): ConceptsMembersResult {
    const memberIds = this.repos.concepts.elementsForConcept(request.conceptId as ElementId);

    const members: ConceptMemberSummary[] = [];
    for (const id of memberIds) {
      const element = this.repos.elements.findById(id);
      if (!element || element.deletedAt) continue;

      // The owning-source title for the row's meta line (shared T043 resolver — a
      // source references itself; extract/card reference their owning source).
      const { sourceTitle } = this.refMetaForElement(element.id);

      // The load-bearing scheduler chip + due badge — reuse the SAME builders the
      // inspector + queue use so the chip/due read identically across surfaces. Both
      // are best-effort: an element that vanished mid-read degrades to a calm
      // attention "Scheduled" default rather than dropping out of the list.
      const inspectorData = this.inspectorQuery.get(element.id);
      const summary = this.queueQuery.summaryFor(element.id);
      const scheduler = inspectorData?.scheduler ?? {
        kind: "attention" as const,
        retrievability: null,
        stability: null,
        difficulty: null,
        reps: null,
        lapses: null,
        fsrsState: null,
        stage: element.stage,
        postponed: 0,
        lastProcessedAt: element.updatedAt ?? null,
      };

      members.push({
        id: element.id,
        type: element.type,
        title: element.title,
        priority: element.priority,
        priorityLabel: priorityToLabel(element.priority),
        status: element.status,
        stage: element.stage,
        sourceTitle,
        dueAt: summary?.dueAt ?? element.dueAt ?? null,
        scheduler,
        due: summary?.due ?? "soon",
        dueLabel: summary?.dueLabel ?? "Scheduled",
      });
    }
    return { members };
  }

  // -------------------------------------------------------------------------
  // tasks.* (T092 — verification tasks)
  // -------------------------------------------------------------------------

  /**
   * Create a verification task (T092) through {@link TaskService}: the `task`-type
   * element (`create_element`) + its `tasks` row + the `references` link
   * (`add_relation`) in ONE transaction. Attention-scheduled (never FSRS); priority
   * inherited from the linked element. No new op type.
   */
  createTask(request: TasksCreateRequest): TasksCreateResult {
    const task = this.repos.tasks.createTask({
      taskType: request.taskType,
      title: request.title,
      ...(request.note !== undefined ? { note: request.note } : {}),
      ...(request.linkedElementId ? { linkedElementId: request.linkedElementId as ElementId } : {}),
      ...(request.priority ? { priority: priorityFromLabel(request.priority) } : {}),
      ...(request.dueChoice ? { dueChoice: this.taskDueChoice(request.dueChoice) } : {}),
    });
    return { task };
  }

  /** Open tasks (optionally protecting one element) — the inspector Maintenance read (T092). */
  listTasks(request: TasksListRequest): TasksListResult {
    return {
      tasks: this.repos.tasks.listOpenTasks(
        request.linkedElementId ? { linkedElementId: request.linkedElementId as ElementId } : {},
      ),
    };
  }

  /**
   * Complete a task (T092) — status → `done` (`reschedule_element`). When
   * `bumpReviewByDays` is set, EXPLICITLY pushes the protected card's `review_by`
   * forward (a T090 `update_element`) so a completed task stops re-surfacing the fact.
   */
  completeTask(request: TasksCompleteRequest): TasksCompleteResult {
    const task = this.repos.tasks.completeTask(
      request.id as ElementId,
      request.bumpReviewByDays !== undefined ? { bumpReviewByDays: request.bumpReviewByDays } : {},
    );
    return { task };
  }

  /** Postpone a task (T092) — reschedule further out (`reschedule_element`, growing). */
  postponeTask(request: TasksPostponeRequest): TasksPostponeResult {
    const task = this.repos.tasks.postponeTask(
      request.id as ElementId,
      request.choice ? this.taskDueChoice(request.choice) : undefined,
    );
    return { task };
  }

  /**
   * Generate verification tasks from T090 expiry (T092) — explicit/opt-in. Scans
   * card-backed facts past `review_by`/`valid_until` and creates one task per protected
   * card without an open task of that kind (idempotent, priority-inherited).
   */
  generateVerificationTasks(
    _request: TasksGenerateFromExpiryRequest,
  ): TasksGenerateFromExpiryResult {
    const { created, tasks } = this.repos.tasks.generateVerificationTasks();
    return { created, tasks };
  }

  /** Convert the contract's `{ kind, date }` schedule union to the scheduler's `ScheduleChoice`. */
  private taskDueChoice(
    choice: NonNullable<TasksCreateRequest["dueChoice"]>,
  ): "tomorrow" | "nextWeek" | "nextMonth" | { manual: IsoTimestamp } {
    return choice.kind === "manual" ? { manual: choice.date as IsoTimestamp } : choice.kind;
  }

  // -------------------------------------------------------------------------
  // synthesis.* (T095 — incremental writing / synthesis notes)
  // -------------------------------------------------------------------------

  /**
   * Create a synthesis note (T095) through {@link SynthesisService}: the
   * `synthesis_note` element (`create_element`) + (optionally) an initial `documents`
   * body (`update_document`), in ONE transaction. Stage `synthesis`; priority defaults
   * to the configured default source priority. Attention-scheduled later via
   * {@link scheduleSynthesisReturn} — NEVER FSRS. No new op/element type.
   */
  createSynthesisNote(request: SynthesisCreateRequest): SynthesisCreateResultView {
    const { element } = this.repos.synthesis.create({
      title: request.title,
      ...(request.priority ? { priority: priorityFromLabel(request.priority) } : {}),
      ...(request.bodyJson !== undefined ? { bodyJson: request.bodyJson } : {}),
      ...(request.bodyPlainText !== undefined ? { bodyPlainText: request.bodyPlainText } : {}),
      ...(request.blocks ? { blocks: request.blocks } : {}),
    });
    return { element: synthesisElementSummary(element) };
  }

  /**
   * Collect an extract/card into a synthesis note (T095) — a `references` edge
   * note→target (`add_relation`); idempotent; rejects a non-extract/non-card.
   */
  linkSynthesisElement(request: SynthesisLinkRequest): SynthesisLinkResultView {
    const { data } = this.repos.synthesis.linkElement(
      request.noteId as ElementId,
      request.targetId as ElementId,
    );
    return { data: synthesisDataView(data) };
  }

  /** Remove a collected extract/card from a synthesis note (T095) — `remove_relation`. */
  unlinkSynthesisElement(request: SynthesisUnlinkRequest): SynthesisLinkResultView {
    const { data } = this.repos.synthesis.unlinkElement(
      request.noteId as ElementId,
      request.targetId as ElementId,
    );
    return { data: synthesisDataView(data) };
  }

  /**
   * Save a synthesis note's ProseMirror body (T095) — `update_document`, preserving
   * stable block ids (so the note's text can later be searched/extracted-from).
   */
  editSynthesisBody(request: SynthesisEditBodyRequest): SynthesisEditBodyResult {
    const data = this.repos.synthesis.editBody({
      noteId: request.noteId as ElementId,
      prosemirrorJson: request.prosemirrorJson,
      plainText: request.plainText,
      ...(request.blocks ? { blocks: request.blocks } : {}),
    });
    return { data: synthesisDataView(data) };
  }

  /**
   * Schedule a synthesis note to RETURN for refinement (T095) on the ATTENTION
   * scheduler (`reschedule_element`, status → `scheduled`) — tomorrow/next-week/
   * next-month/manual. NEVER writes a `review_states` row (the two-scheduler split).
   */
  scheduleSynthesisReturn(request: SynthesisScheduleReturnRequest): SynthesisScheduleReturnResult {
    const when =
      request.when.kind === "manual"
        ? { manual: request.when.date as IsoTimestamp }
        : request.when.kind;
    const data = this.repos.synthesis.scheduleReturn(request.noteId as ElementId, when);
    return { data: synthesisDataView(data) };
  }

  /** The synthesis note + its linked extracts/cards + due date (T095). Read-only. */
  getSynthesisNote(request: SynthesisGetRequest): SynthesisGetResult {
    const data = this.repos.synthesis.get(request.noteId as ElementId);
    return { data: data ? synthesisDataView(data) : null };
  }

  /** All tags with their live usage count (T041) — the library filterbar. Read-only. */
  listAllTags(): TagsListResult {
    return { tags: this.repos.elements.listAllTags() };
  }

  /** Tag an element (T041) — created on demand; logs `add_tag`. Idempotent. */
  addTag(request: TagsAddRequest): TagsAddResult {
    this.repos.elements.addTag(request.elementId as ElementId, request.tag);
    return { element: this.organizeState(request.elementId as ElementId) };
  }

  /** Untag an element (T041); logs `remove_tag`. */
  removeTag(request: TagsRemoveRequest): TagsRemoveResult {
    this.repos.elements.removeTag(request.elementId as ElementId, request.tag);
    return { element: this.organizeState(request.elementId as ElementId) };
  }

  // -------------------------------------------------------------------------
  // search.*  (T042 — local FTS5 full-text search)
  // -------------------------------------------------------------------------

  /**
   * Local FTS5 full-text search (T042) through {@link SearchRepository.search}:
   * ranked matches over source title/body + extract body + card prompt/answer +
   * tags, with the optional type/concept/tag filters applied in the query layer.
   * Each ranked hit is enriched main-side with its priority label, concept, and
   * source provenance/location (the row's refblock) — reusing the same lineage
   * reads the review/inspector use, so the library row reads consistently. An
   * empty/malformed query yields `{ results: [] }`. Read-only (appends no op).
   */
  search(request: SearchQueryRequest): SearchQueryResult {
    const hits = this.repos.search.search(request.q, {
      ...(request.type ? { type: request.type } : {}),
      ...(request.conceptId ? { conceptId: request.conceptId as ElementId } : {}),
      ...(request.tag ? { tag: request.tag } : {}),
      ...(request.priorityLabel ? { priorityLabel: request.priorityLabel } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    });

    const results: SearchResult[] = [];
    for (const hit of hits) {
      const element = this.repos.elements.findById(hit.id as ElementId);
      if (!element || element.deletedAt) continue;

      // Source provenance + location for the row's refblock. For a `source` hit
      // the element IS the source; for an extract/card, resolve the owning source
      // and the card's/extract's source-location anchor.
      const { sourceTitle, sourceLocationLabel } = this.refMetaForElement(element.id);

      // Scheduler chip + due badge for the selection detail (kit parity). Reuse the
      // SAME builders the inspector + queue use so the chip/due read identically:
      // the inspector resolves the full FSRS/attention `SchedulerSignals`, and the
      // queue summary classifies the due state/label — no duplicated scheduling math.
      // Both are best-effort: a row that vanished between the FTS hit and this read
      // degrades to a calm attention/"Scheduled" default rather than dropping.
      const inspectorData = this.inspectorQuery.get(element.id);
      const summary = this.queueQuery.summaryFor(element.id);
      const scheduler = inspectorData?.scheduler ?? {
        kind: "attention" as const,
        retrievability: null,
        stability: null,
        difficulty: null,
        reps: null,
        lapses: null,
        fsrsState: null,
        stage: element.stage,
        postponed: 0,
        lastProcessedAt: element.updatedAt ?? null,
      };

      results.push({
        id: element.id,
        type: hit.type,
        title: hit.title,
        snippet: hit.snippet,
        score: hit.score,
        priority: element.priority,
        priorityLabel: priorityToLabel(element.priority),
        concept: this.conceptForElement(element.id),
        sourceTitle,
        sourceLocationLabel,
        dueAt: summary?.dueAt ?? element.dueAt ?? null,
        scheduler,
        due: summary?.due ?? "soon",
        dueLabel: summary?.dueLabel ?? "Scheduled",
      });
    }

    // DRILL-DOWN faceted counts for the filterbar. The repository computes exact
    // aggregate counts in SQL (no snippets/ranking/materialized match list), and
    // each dimension drops only its own active predicate.
    const counts = this.repos.search.facetCounts(request.q, {
      ...(request.tag ? { tag: request.tag } : {}),
      ...(request.type ? { type: request.type } : {}),
      ...(request.conceptId ? { conceptId: request.conceptId as ElementId } : {}),
      ...(request.priorityLabel ? { priorityLabel: request.priorityLabel } : {}),
    });

    return { results, counts };
  }

  // -------------------------------------------------------------------------
  // library.browse()  (Library route — the facet-driven browse-everything read)
  // -------------------------------------------------------------------------

  /** Read-only library browse query layer, bound to the open database. */
  private get libraryQuery(): LibraryQuery {
    if (!this.library) {
      throw new Error("DbService: database is not open");
    }
    return this.library;
  }

  private get sourceYieldQuery(): SourceYieldQuery {
    if (!this.sourceYield) {
      throw new Error("DbService: database is not open");
    }
    return this.sourceYield;
  }

  private get extractStagnationQuery(): ExtractStagnationQuery {
    if (!this.extractStagnation) {
      throw new Error("DbService: database is not open");
    }
    return this.extractStagnation;
  }

  /**
   * The facet-driven "browse everything" read behind `/library`. DISTINCT from
   * {@link search}: it takes NO keyword and lists ALL live elements by default,
   * narrowing only by the type/concept/priority/status facets — and it covers
   * `topic`/`synthesis_note`/`task`, which the FTS-backed search can never return.
   *
   * {@link LibraryQuery} does the live-elements read + ordering + per-facet counts
   * (no SQL/ranking in the renderer); here each returned id is enriched with the
   * SAME fields a search/queue row carries — priority label, concept, source
   * provenance/location (the refblock), the FSRS-vs-attention {@link SchedulerSignals},
   * and the due state/label — by reusing the inspector/queue/refblock builders, so
   * a Library row reads identically to a search/queue row (no duplicated scheduling
   * math). Read-only (appends no op).
   */
  libraryBrowse(request: LibraryBrowseRequest): LibraryBrowseResult {
    const filters: LibraryBrowseFilters = {
      ...(request.types ? { types: request.types } : {}),
      ...(request.conceptId ? { conceptId: request.conceptId as ElementId } : {}),
      ...(request.priorityLabel ? { priorityLabel: request.priorityLabel } : {}),
      ...(request.statuses ? { statuses: request.statuses } : {}),
      ...(request.limit !== undefined ? { limit: request.limit } : {}),
    };
    const { items: elements, counts } = this.libraryQuery.browse(filters);

    const items: LibraryItem[] = [];
    for (const element of elements) {
      // The owning-source provenance + location for the row's refblock (shared
      // T043 resolver — a source references itself; extract/card reference their
      // owning source + location anchor).
      const { sourceTitle, sourceLocationLabel } = this.refMetaForElement(element.id);

      // The load-bearing scheduler chip + due badge — reuse the SAME builders the
      // inspector + queue use so the chip/due read identically across surfaces. Both
      // are best-effort: a row that vanished mid-read degrades to a calm attention
      // "Scheduled" default rather than dropping out of the browse.
      const inspectorData = this.inspectorQuery.get(element.id);
      const summary = this.queueQuery.summaryFor(element.id);
      const linked =
        element.type === "task"
          ? (this.repos.tasks.findTask(element.id)?.linkedElement ?? null)
          : null;
      const scheduler = inspectorData?.scheduler ?? {
        kind: "attention" as const,
        retrievability: null,
        stability: null,
        difficulty: null,
        reps: null,
        lapses: null,
        fsrsState: null,
        stage: element.stage,
        postponed: 0,
        lastProcessedAt: element.updatedAt ?? null,
      };

      items.push({
        id: element.id,
        type: element.type as LibraryItem["type"],
        title: element.title,
        priority: element.priority,
        priorityLabel: priorityToLabel(element.priority),
        status: element.status,
        stage: element.stage,
        concept: this.conceptForElement(element.id),
        sourceTitle,
        sourceLocationLabel,
        dueAt: summary?.dueAt ?? element.dueAt ?? null,
        scheduler,
        due: summary?.due ?? "soon",
        dueLabel: summary?.dueLabel ?? "Scheduled",
        linkedElementId: linked?.id ?? null,
        linkedElementType: linked?.type ?? null,
      });
    }
    return { items, counts };
  }

  /**
   * Resolve the source title + location label for a search row's refblock through
   * the ONE shared {@link resolveSourceRef} (the same T043 resolver the inspector,
   * review face, and extract view use), so the library row reads a reference
   * identically. A `source` hit references itself; an `extract`/`card` references
   * its owning source element + its source-location anchor (a card additionally
   * falls back to its `cards.source_location_id`). A soft-deleted/missing source
   * degrades to `null` (a calm "no source"), never a broken reference.
   */
  private refMetaForElement(id: ElementId): {
    sourceTitle: string | null;
    sourceLocationLabel: string | null;
  } {
    const ref = resolveSourceRef(this.repos, id);
    return {
      sourceTitle: ref?.sourceTitle ?? null,
      sourceLocationLabel: ref?.locationLabel ?? null,
    };
  }

  /** The element's organize state (concepts + tags), or `null` when soft-deleted/unknown. */
  private organizeState(id: ElementId): ElementOrganizeState | null {
    const element = this.repos.elements.findById(id);
    if (!element || element.deletedAt) return null;
    return {
      elementId: id,
      concepts: this.repos.concepts.conceptsForElement(id).map((c) => ({
        id: c.id,
        name: c.name,
        parentConceptId: c.parentConceptId,
        desiredRetention: c.desiredRetention,
      })),
      tags: this.repos.elements.listTags(id),
    };
  }

  /**
   * Load an element's read-point (resume position) (T017) through
   * {@link DocumentRepository}. Returns the STABLE block id + offset + updated
   * timestamp, or `null` when no read-point has been set yet. Read-only.
   */
  getReadPoint(request: ReadPointGetRequest): ReadPointGetResult {
    const rp = this.repos.documents.getReadPoint(request.elementId as ElementId);
    if (!rp) return { readPoint: null };
    return { readPoint: { blockId: rp.blockId, offset: rp.offset, updatedAt: rp.updatedAt } };
  }

  /**
   * Upsert an element's read-point (T017) through {@link DocumentRepository},
   * which writes the single `read_points` row (one per element) and appends
   * `set_read_point` in ONE transaction. The renderer resolves the STABLE block
   * id + offset from the editor selection; the main process persists exactly what
   * it receives. The same command backs the `markReadThrough` auto-advance seam
   * reserved for T021.
   */
  setReadPoint(request: ReadPointSetRequest): ReadPointSetResult {
    const saved = this.repos.documents.setReadPoint({
      elementId: request.elementId as ElementId,
      documentId: request.documentId as ElementId,
      blockId: request.blockId as BlockId,
      offset: request.offset,
    });
    return {
      readPoint: { blockId: saved.blockId, offset: saved.offset, updatedAt: saved.updatedAt },
    };
  }

  // -------------------------------------------------------------------------
  // Deletion, trash & undo (T044)
  // -------------------------------------------------------------------------

  /** The general command-level undo service (T044), bound to the open database. */
  private get undo(): UndoService {
    if (!this.undoService) {
      throw new Error("DbService: database is not open");
    }
    return this.undoService;
  }

  /**
   * List every soft-deleted element for the Trash view (T044) via the
   * {@link TrashRepository}: newest-deleted first, each with its type, owning-source
   * title, deletion time, and the status it had BEFORE delete (what restore returns
   * it to). Read-only — no mutation, no `operation_log`.
   */
  listTrash(): TrashListResult {
    const items = this.repos.trash.listTrash().map((it) => ({
      id: it.element.id,
      type: it.element.type,
      title: it.element.title,
      deletedAt: it.deletedAt,
      originStatus: it.originStatus,
      sourceTitle: it.sourceTitle,
    }));
    return { items };
  }

  /**
   * Restore a soft-deleted element to its prior lifecycle status (T044) via
   * {@link ElementRepository.restore} (`restore_element`, one transaction, lineage
   * intact). The prior status comes from the latest `soft_delete_element` op's
   * pre-image. Returns the restored summary so the renderer drops the row from the
   * trash; `null` when the id is unknown or the element is not in the trash.
   */
  restoreFromTrash(request: TrashRestoreRequest): TrashRestoreResult {
    const id = request.id as ElementId;
    const element = this.repos.elements.findById(id);
    if (!element?.deletedAt) return { item: null };
    // Reuse the trash read's origin-status resolution so restore returns it to where
    // it was (the same source of truth the Trash list shows).
    const trashItem = this.repos.trash.listTrash().find((it) => it.element.id === id);
    const originStatus = trashItem?.originStatus ?? "active";
    const restored = this.repos.elements.restore(id, originStatus);
    return {
      item: {
        id: restored.id,
        type: restored.type,
        status: restored.status,
        stage: restored.stage,
        priority: restored.priority,
        title: restored.title,
        dueAt: restored.dueAt,
      },
    };
  }

  /**
   * Permanently delete ONE trashed element (T044) — the only hard delete in the
   * app, gated behind explicit UI confirmation — via {@link TrashRepository.purge}.
   * FK cascades + the FTS5 delete trigger clean up dependents; appends no op
   * (irreversible by design). Returns `{ purged: 1 }` or `{ purged: 0 }`.
   */
  purgeFromTrash(request: TrashPurgeRequest): TrashPurgeResult {
    const purged = this.repos.trash.purge(request.id as ElementId) ? 1 : 0;
    return { purged };
  }

  /**
   * Permanently delete EVERY trashed element in one transaction (T044, the "Empty
   * trash" action) via {@link TrashRepository.emptyTrash}. UI-confirmed.
   */
  emptyTrash(): TrashEmptyResult {
    return this.repos.trash.emptyTrash();
  }

  /**
   * Reverse the MOST-RECENT operation from anywhere (T044) via {@link UndoService}:
   * delete → restore, mark-done/dismiss/suspend → prior status, postpone (incl.
   * bulk) → prior schedule. The inverse runs through the existing repository write
   * paths and is itself logged (no new op type). A non-invertible last op returns
   * `{ undone: false }` and mutates nothing.
   */
  undoLastOperation(): UndoLastResult {
    const result = this.undo.undoLast();
    return {
      undone: result.undone,
      opType: result.opType,
      elementId: result.elementId,
      label: result.label,
      ...(result.reason ? { reason: result.reason } : {}),
      count: result.count,
    };
  }

  /**
   * The system-wide learning-health snapshot (T045) via
   * {@link AnalyticsService.computeAnalytics} (in `packages/local-db`): daily
   * reviews + retention from `review_logs`, due cards/topics from the two
   * schedulers, new cards/extracts + deletions from `elements`, and the live leech
   * count. Read-only — no mutation, no `operation_log`. `asOf` defaults to "now"
   * and `windowDays` to 30.
   */
  getAnalytics(request?: AnalyticsGetRequest): AnalyticsGetResult {
    const asOf = (request?.asOf ?? nowIso()) as IsoTimestamp;
    const summary = this.repos.analytics.computeAnalytics(asOf, {
      ...(request?.windowDays !== undefined ? { windowDays: request.windowDays } : {}),
    });
    return {
      asOf: summary.asOf,
      windowDays: summary.windowDays,
      reviewsByDay: summary.reviewsByDay,
      reviewsTotal: summary.reviewsTotal,
      reviewsPerDayAvg: summary.reviewsPerDayAvg,
      retention30d: summary.retention30d,
      dueCards: summary.dueCards,
      dueTopics: summary.dueTopics,
      newCards: summary.newCards,
      newExtracts: summary.newExtracts,
      deletions: summary.deletions,
      leeches: summary.leeches,
      retired: summary.retired,
      dayStreak: summary.dayStreak,
    };
  }

  /**
   * The import/process balance snapshot (T046) via
   * {@link AnalyticsService.computeBalance} (in `packages/local-db`): the week's
   * sources imported / extracts created / cards created / reviews due, plus the
   * imbalance judgment (the pure `@interleave/core` `judgeBalance` rule, tuned by
   * the user's `importBalanceFactor` setting). REUSES the analytics aggregation so
   * the inbox banner + analytics view can't disagree. Read-only — no mutation, no
   * `operation_log`, no schedule changes. `asOf` defaults to "now", `windowDays`
   * to 7. The `balanceWarnings` on/off setting is honoured in the RENDERER (it
   * controls whether the banner shows); the snapshot is always computed so the
   * analytics view can surface the numbers regardless.
   */
  getBalance(request?: BalanceGetRequest): BalanceGetResult {
    const asOf = (request?.asOf ?? nowIso()) as IsoTimestamp;
    const factor = this.repos.settings.getAppSettings().importBalanceFactor;
    const summary = this.repos.analytics.computeBalance(asOf, {
      factor,
      ...(request?.windowDays !== undefined ? { windowDays: request.windowDays } : {}),
    });
    return {
      asOf: summary.asOf,
      windowDays: summary.windowDays,
      sourcesImported: summary.sourcesImported,
      extractsCreated: summary.extractsCreated,
      cardsCreated: summary.cardsCreated,
      reviewsDueThisWeek: summary.reviewsDueThisWeek,
      imbalanced: summary.imbalanced,
      severity: summary.severity,
    };
  }

  /**
   * The per-source yield rollup (T083) via {@link SourceYieldQuery.listSourceYield}
   * (in `packages/local-db`): for every live `source`, its read % (`read_points` vs
   * `document_blocks`), extracts/cards/mature-cards created (via the persisted
   * `sourceId` lineage), leeches (`cards.is_leech`), and review time
   * (`SUM(review_logs.responseMs)`) — plus a derived `yieldScore`/`yieldBand` (the
   * pure `@interleave/core` `scoreSourceYield` rule), ranked **lowest-yield first** so
   * low-yield sources are identifiable. Read-only — no mutation, no `operation_log`,
   * no schedule change. `asOf` defaults to "now"; `limit` to 200. The FSRS-vs-attention
   * split stays labeled (the source is attention; its leeches/mature-cards are FSRS).
   */
  listSourceYield(request?: SourceYieldListRequest): SourceYieldListResult {
    const asOf = (request?.asOf ?? nowIso()) as IsoTimestamp;
    const summary = this.sourceYieldQuery.listSourceYield(asOf, {
      ...(request?.limit !== undefined ? { limit: request.limit } : {}),
      ...(request?.offset !== undefined ? { offset: request.offset } : {}),
    });
    return {
      asOf: summary.asOf,
      rows: summary.rows,
      lowYieldCount: summary.lowYieldCount,
    };
  }

  /**
   * The extract-stagnation scan (T084) via {@link ExtractStagnationQuery.listStagnantExtracts}
   * (in `packages/local-db`): for every live `extract`, reads the charter's
   * attention-scheduler signals (stage / child count / op-log postpone markers + last
   * stage advance), runs the PURE `@interleave/scheduler` `isStagnant` heuristic (the
   * attention mirror of `isLeech`), and returns ONLY the stagnant rows (most-stagnant
   * first) with their reasons + a recommended rewrite/convert/postpone/delete
   * remediation. Read-only — no mutation, no `operation_log`, no schedule change. The
   * suggestion is a LABEL; the actual remediations reuse the existing `extracts.*` /
   * extract→card commands. `asOf` defaults to "now"; `limit` to 200. Stagnation is an
   * ATTENTION concern — never FSRS `lapses`; an extract is never a "leech".
   */
  listStagnantExtracts(request?: ExtractStagnationListRequest): ExtractStagnationListResult {
    const asOf = (request?.asOf ?? nowIso()) as IsoTimestamp;
    const summary = this.extractStagnationQuery.listStagnantExtracts(asOf, {
      ...(request?.limit !== undefined ? { limit: request.limit } : {}),
      ...(request?.offset !== undefined ? { offset: request.offset } : {}),
    });
    return {
      asOf: summary.asOf,
      rows: summary.rows,
      stagnantCount: summary.stagnantCount,
    };
  }

  /**
   * Snapshot the live SQLite database to `destPath` consistently (T047) — used by
   * {@link BackupService}. Delegates to better-sqlite3's online `backup()` API,
   * which produces a consistent copy INCLUDING un-checkpointed WAL pages WITHOUT
   * disturbing the live connection (the WAL-consistency correctness guarantee a
   * naive file copy lacks). The renderer never calls this — it is reached only via
   * the typed `backups.create` command in the main process.
   */
  backupDatabaseTo(destPath: string): void {
    const { sqlite } = this.require();
    // `VACUUM INTO` writes a transactionally CONSISTENT, fully self-contained copy
    // of the database to `destPath` in one synchronous statement — it reads a single
    // point-in-time snapshot (so un-checkpointed WAL pages are included) and emits a
    // defragmented DB file with NO `-wal`/`-shm` siblings, which is exactly what a
    // portable, restore-ready backup wants. It requires the destination to not yet
    // exist (the caller writes into a fresh `backups/<timestamp>/`). A defensive
    // checkpoint first keeps the live DB tidy; the snapshot would be consistent
    // either way.
    sqlite.pragma("wal_checkpoint(PASSIVE)");
    sqlite.prepare("VACUUM INTO ?").run(destPath);
  }

  /**
   * The latest applied Drizzle migration TAG (T047) — the backup manifest's
   * "schema version". Reads the runtime count of applied migrations from
   * `__drizzle_migrations` (the source of truth that the DB is at) and maps it to a
   * tag via the staged `_journal.json`. NOT a `schema_version` column (there is
   * none) and NOT `documents.schemaVersion`.
   */
  getSchemaVersion(migrationsDir: string): string {
    const { sqlite } = this.require();
    const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as
      | { n: number }
      | undefined;
    const appliedCount = row?.n ?? 0;
    return resolveSchemaVersion(migrationsDir, appliedCount);
  }

  /**
   * Element/source/extract/card/asset counts for the backup manifest's quick
   * human sanity check (T047). Counts LIVE (non-soft-deleted) elements by type and
   * the total asset-metadata rows. Read-only.
   */
  getBackupCounts(): BackupCounts {
    const { sqlite } = this.require();
    // Count ALL rows the backup file actually contains (including soft-deleted) so
    // the manifest sanity check matches the captured `app.sqlite`, not the live view.
    const count = (sql: string): number => {
      const row = sqlite.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    return {
      elements: count("SELECT COUNT(*) AS n FROM elements"),
      sources: count("SELECT COUNT(*) AS n FROM elements WHERE type = 'source'"),
      extracts: count("SELECT COUNT(*) AS n FROM elements WHERE type = 'extract'"),
      cards: count("SELECT COUNT(*) AS n FROM elements WHERE type = 'card'"),
      assets: count("SELECT COUNT(*) AS n FROM assets"),
    };
  }

  /**
   * Populate an EMPTY database with the shared demo collection (the same factory
   * the Vitest fixtures + `pnpm seed` use), so the inspector has realistic
   * lineage to show in dev and E2E. A no-op when any element already exists, so
   * it never duplicates data or overwrites a real user collection. Opt-in via the
   * caller (gated by `INTERLEAVE_SEED_ON_EMPTY` in `bootstrap`) — production
   * launches do not seed.
   */
  seedIfEmpty(): boolean {
    const repos = this.repos;
    const existing = repos.elements.listByType("source");
    if (existing.length > 0) return false;
    seedDemoCollection(repos, this.require().db);
    return true;
  }

  /**
   * Populate an EMPTY database with the T099 MAINTENANCE fixture (a duplicate source
   * pair, a hand-authored sourceless card, a broken source whose snapshot file the
   * e2e deletes on disk, and a low-priority stale source), so the Maintenance E2E has
   * deterministic dead weight to find and reclaim. A no-op when any element exists.
   * Opt-in via `INTERLEAVE_SEED_MAINTENANCE` in `bootstrap`; production never seeds.
   * Returns the planted ids (incl. `brokenSnapshotRelPath`) or `null` when not empty.
   */
  seedMaintenanceIfEmpty(): MaintenanceCollection | null {
    const repos = this.repos;
    if (repos.elements.listByType("source").length > 0) return null;
    return seedMaintenanceCollection(repos, this.require().db);
  }

  /**
   * Populate an EMPTY database with the T100 CI-bounded SCALE collection (a few
   * THOUSAND elements via the bulk fast path) so the `scale-smoke` E2E can exercise
   * backup/restore, `integrity_check`, the two-scheduler split, and the MVP flow
   * after restart against a realistic-but-fast collection. A no-op when any element
   * exists (so a restart never re-seeds). Opt-in via `INTERLEAVE_SEED_SCALE` in
   * `bootstrap`; production never seeds. The bulk path runs only against this
   * throwaway E2E data dir (never the dev/user DB) and restores its pragmas after.
   * Returns the {@link LargeSeedStats} or `null` when not empty.
   */
  seedScaleIfEmpty(): LargeSeedStats | null {
    const repos = this.repos;
    if (repos.elements.listByType("source").length > 0) return null;
    return seedLargeCollection(repos, this.require().db, {
      ...CI_SCALE_PROFILE,
      seed: "interleave-scale-e2e",
    });
  }

  /** Cheap connectivity check used by `app.health()`. */
  ping(): boolean {
    const { sqlite } = this.require();
    const row = sqlite.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
    return row?.ok === 1;
  }

  /** Exposed only for diagnostics/tests; never wired to the renderer. */
  get raw(): DbHandle {
    return this.require();
  }
}

/** Map a repository {@link DocumentMark} onto the flat, JSON-serializable IPC payload. */
function markToPayload(mark: DocumentMark): DocumentMarkPayload {
  return {
    id: mark.id,
    elementId: mark.elementId,
    blockId: mark.blockId,
    markType: mark.markType,
    range: [mark.range[0], mark.range[1]],
    attrs: mark.attrs,
  };
}

/** Map a synthesis-note domain element onto the flat, JSON-serializable IPC summary (T095). */
function synthesisElementSummary(
  element: SynthesisData["element"],
): SynthesisCreateResultView["element"] {
  return {
    id: element.id,
    type: element.type,
    status: element.status,
    stage: element.stage,
    priority: element.priority,
    title: element.title,
    dueAt: element.dueAt,
  };
}

/** Map a referenced extract/card onto the flat IPC view (T095). */
function synthesisLinkedView(linked: SynthesisLinkedElement): SynthesisLinkedView {
  return {
    id: linked.id,
    type: linked.type,
    title: linked.title,
    stage: linked.stage,
    priority: linked.priority,
    relationId: linked.relationId,
  };
}

/** Map the synthesis-note domain read onto the flat, JSON-serializable IPC view (T095). */
function synthesisDataView(data: SynthesisData): SynthesisDataView {
  return {
    element: synthesisElementSummary(data.element),
    linked: data.linked.map(synthesisLinkedView),
    dueAt: data.dueAt,
  };
}
