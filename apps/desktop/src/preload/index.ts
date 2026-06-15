/**
 * Preload bridge (T007) — the single, narrow seam between the untrusted renderer
 * and the trusted main process.
 *
 * Runs in an isolated world (`contextIsolation: true`) and a sandbox
 * (`sandbox: true`), so it may only import `electron` itself. It exposes exactly
 * one global, `window.appApi`, whose every method is a thin `ipcRenderer.invoke`
 * over a channel defined in the shared contract. The renderer therefore gets no
 * raw Node, filesystem, or SQLite access, and there is no generic `db.query`.
 *
 * The payloads are validated again on the main side (the renderer is untrusted);
 * the contract import here is type-only + the channel constants, so no Node/DB
 * code is pulled into the sandboxed preload.
 */

import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../shared/channels";
import type {
  AiApproveRequest,
  AiDismissRequest,
  AiListRequest,
  AiRunRequest,
  AnalyticsGetRequest,
  AnalyticsReviewActivityRequest,
  AppApi,
  BackupsResetLocalDataRequest,
  BackupsRestoreFileRequest,
  BackupsRestoreRequest,
  BalanceGetRequest,
  BlockProcessingMarkBlockRequest,
  BlockProcessingSourceRequest,
  CaptureSetEnabledRequest,
  CardsAddContextRequest,
  CardsBackToExtractRequest,
  CardsCreateRequest,
  CardsDeleteRequest,
  CardsExportAnkiRequest,
  CardsFlagRequest,
  CardsGenerateOcclusionRequest,
  CardsImportAnkiRequest,
  CardsMarkLeechRequest,
  CardsReStabilizeUndoRequest,
  CardsRetireRequest,
  CardsSetLifetimeRequest,
  CardsSiblingAnswersRequest,
  CardsSplitRequest,
  CardsSuspendRequest,
  CardsUnretireRequest,
  CardsUpdateRequest,
  ConceptsAssignRequest,
  ConceptsCreateRequest,
  ConceptsMembersRequest,
  ConceptsUnassignRequest,
  ConversionCreateCardRequest,
  ConversionPrefetchDraftsRequest,
  ConversionSessionPreviewRequest,
  ConversionSetFateRequest,
  DailyWorkGraduationAckRequest,
  DailyWorkSummaryRequest,
  DailyWorkUndoAutoPostponeReceiptRequest,
  DocumentMarksAddRequest,
  DocumentMarksListRequest,
  DocumentMarksRemoveRequest,
  DocumentsExportMarkdownRequest,
  DocumentsGetRequest,
  DocumentsSaveRequest,
  ElementsCountDescendantsRequest,
  ElementsRenameRequest,
  ElementsSetPriorityRequest,
  ElementsSoftDeleteSubtreeRequest,
  ExtractAgingApplyRequest,
  ExtractAgingPreviewRequest,
  ExtractAgingUndoReceiptRequest,
  ExtractionCreateRequest,
  ExtractStagnationListRequest,
  ExtractsDeleteRequest,
  ExtractsMarkDoneRequest,
  ExtractsPostponeRequest,
  ExtractsReactivateFateRequest,
  ExtractsRewriteRequest,
  ExtractsSetFateRequest,
  ExtractsUpdateStageRequest,
  InboxBulkApplySuggestionsRequest,
  InboxBulkTriageRequest,
  InboxBulkTriageUndoRequest,
  InboxGetRequest,
  InboxTriageRequest,
  InspectorGetRequest,
  JobSummary,
  JobsListRequest,
  LapseClustersListRequest,
  LibraryBrowseRequest,
  LibraryParkedActionRequest,
  LineageGetRequest,
  MaintenanceBulkArchiveRequest,
  MaintenanceBulkPostponeRequest,
  MaintenanceBulkTrashRequest,
  MaintenanceChronicPostponesApplyRequest,
  MaintenanceChronicPostponesRequest,
  MaintenanceDedupeRequest,
  MaintenanceIntegrityRequest,
  MaintenanceLowValueRequest,
  MaintenanceOrphanMediaRequest,
  MaintenanceParkedResurfacingApplyRequest,
  MaintenanceParkedResurfacingRequest,
  MaintenanceSchedulerConsistencyRequest,
  OptimizationApplyRequest,
  OptimizationSuggestRequest,
  PickImportFileRequest,
  PriorityIntegrityGetRequest,
  QueueActRequest,
  QueueAutoPostponeRequest,
  QueueCatchUpRequest,
  QueueListRequest,
  QueueScheduleRequest,
  QueueSessionPlanRequest,
  QueueUndoRequest,
  QueueVacationRequest,
  ReadPointGetRequest,
  ReadPointSetRequest,
  RetentionResolveForRequest,
  RetentionSetBandEnabledRequest,
  RetentionSetBandRequest,
  RetentionSetCardRequest,
  RetentionSetConceptRequest,
  ReverifyResolveRequest,
  ReverifySessionPreviewRequest,
  ReverifyUndoReceiptRequest,
  ReviewCardRequest,
  ReviewGradeRequestInput,
  ReviewModeCountRequest,
  ReviewModeDeckRequest,
  ReviewPreviewRequest,
  ReviewSessionNextRequest,
  SearchQueryRequest,
  SemanticContradictionsRequest,
  SemanticDownloadModelRequest,
  SemanticReindexRequest,
  SemanticRelatedRequest,
  SemanticRetryFailedRequest,
  SemanticSearchRequest,
  SemanticStatusRequest,
  // review.leeches() / concepts.list() / tags.list() take no request payload.
  SettingsGetRequest,
  SettingsUpdateManyRequest,
  SettingsUpdateRequest,
  SourcesAcceptOcrRequest,
  SourcesDismissRetirementSuggestionRequest,
  SourcesExtractClipRequest,
  SourcesExtractRegionRequest,
  SourcesGetMediaDataRequest,
  SourcesGetOcrRequest,
  SourcesGetPdfDataRequest,
  SourcesGetRegionImageRequest,
  SourcesImportDocumentRequest,
  SourcesImportEpubRequest,
  SourcesImportHighlightsRequest,
  SourcesImportManualRequest,
  SourcesImportMarkdownTextRequest,
  SourcesImportMediaRequest,
  SourcesImportPdfRequest,
  SourcesImportUrlRequest,
  SourcesRunOcrRequest,
  SourcesUpdateReliabilityRequest,
  SourceYieldListRequest,
  SynthesisCreateRequest,
  SynthesisEditBodyRequest,
  SynthesisGetRequest,
  SynthesisLinkRequest,
  SynthesisScheduleReturnRequest,
  SynthesisUnlinkRequest,
  TagsAddRequest,
  TagsRemoveRequest,
  TasksCompleteRequest,
  TasksCreateRequest,
  TasksGenerateFromExpiryRequest,
  TasksListRequest,
  TasksPostponeRequest,
  TopicFallowRequest,
  TopicKnowledgeStateGetRequest,
  TopicUnfallowRequest,
  TrashPurgeRequest,
  TrashRestoreAncestorChainRequest,
  TrashRestoreBatchRequest,
  TrashRestoreRequest,
  TriageSuggestMetadataRequest,
  TriageSuggestRequest,
  VaultCollectOrphansRequest,
  VaultFindOrphansRequest,
  VaultVerifyRequest,
  WeeklyReviewCompleteRequest,
  WeeklyReviewDismissRequest,
  WeeklyReviewProgressPatch,
  WeeklyReviewSummaryRequest,
  WorkloadSimulateRequest,
} from "../shared/contract";

const appApi: AppApi = {
  app: {
    health: () => ipcRenderer.invoke(IPC_CHANNELS.appHealth),
  },
  db: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.dbGetStatus),
  },
  settings: {
    get: (request?: SettingsGetRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsGet, request ?? {}),
    update: (request: SettingsUpdateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsUpdate, request),
    getAll: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGetAll),
    updateMany: (request: SettingsUpdateManyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.settingsUpdateMany, request),
  },
  inspector: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.inspectorList),
    get: (request: InspectorGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.inspectorGet, request),
  },
  elements: {
    setPriority: (request: ElementsSetPriorityRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.elementsSetPriority, request),
    rename: (request: ElementsRenameRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.elementsRename, request),
    countDescendants: (request: ElementsCountDescendantsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.elementsCountDescendants, request),
    softDeleteSubtree: (request: ElementsSoftDeleteSubtreeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.elementsSoftDeleteSubtree, request),
  },
  topics: {
    fallow: (request: TopicFallowRequest) => ipcRenderer.invoke(IPC_CHANNELS.topicsFallow, request),
    unfallow: (request: TopicUnfallowRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.topicsUnfallow, request),
  },
  queue: {
    list: (request?: QueueListRequest) => ipcRenderer.invoke(IPC_CHANNELS.queueList, request ?? {}),
    sessionPlan: (request: QueueSessionPlanRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueSessionPlan, request),
    act: (request: QueueActRequest) => ipcRenderer.invoke(IPC_CHANNELS.queueAct, request),
    schedule: (request: QueueScheduleRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueSchedule, request),
    undo: (request: QueueUndoRequest) => ipcRenderer.invoke(IPC_CHANNELS.queueUndo, request),
    autoPostpone: (request?: QueueAutoPostponeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueAutoPostpone, request ?? {}),
    autoPostponeApply: (request?: QueueAutoPostponeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueAutoPostponeApply, request ?? {}),
    catchUp: (request?: QueueCatchUpRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueCatchUp, request ?? {}),
    catchUpApply: (request?: QueueCatchUpRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueCatchUpApply, request ?? {}),
    vacation: (request: QueueVacationRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueVacation, request),
    vacationApply: (request: QueueVacationRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueVacationApply, request),
  },
  conversion: {
    sessionPreview: (request?: ConversionSessionPreviewRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.conversionSessionPreview, request ?? {}),
    prefetchDrafts: (request: ConversionPrefetchDraftsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.conversionPrefetchDrafts, request),
    createCard: (request: ConversionCreateCardRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.conversionCreateCard, request),
    setFate: (request: ConversionSetFateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.conversionSetFate, request),
  },
  lineage: {
    get: (request: LineageGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.lineageGet, request),
  },
  sources: {
    importManual: (request: SourcesImportManualRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportManual, request),
    updateReliability: (request: SourcesUpdateReliabilityRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesUpdateReliability, request),
    dismissRetirementSuggestion: (request: SourcesDismissRetirementSuggestionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesDismissRetirementSuggestion, request),
    importUrl: (request: SourcesImportUrlRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportUrl, request),
    importPdf: (request: SourcesImportPdfRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportPdf, request),
    getPdfData: (request: SourcesGetPdfDataRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesGetPdfData, request),
    pickImportFile: (request: PickImportFileRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesPickImportFile, request),
    importEpub: (request: SourcesImportEpubRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportEpub, request),
    importMedia: (request: SourcesImportMediaRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportMedia, request),
    getMediaData: (request: SourcesGetMediaDataRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesGetMediaData, request),
    importDocument: (request: SourcesImportDocumentRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportDocument, request),
    importMarkdownText: (request: SourcesImportMarkdownTextRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportMarkdownText, request),
    importHighlights: (request: SourcesImportHighlightsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportHighlights, request),
    extractRegion: (request: SourcesExtractRegionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesExtractRegion, request),
    getRegionImage: (request: SourcesGetRegionImageRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesGetRegionImage, request),
    extractClip: (request: SourcesExtractClipRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesExtractClip, request),
    runOcr: (request: SourcesRunOcrRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesRunOcr, request),
    getOcr: (request: SourcesGetOcrRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesGetOcr, request),
    acceptOcr: (request: SourcesAcceptOcrRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesAcceptOcr, request),
    dismissOcr: (request: SourcesAcceptOcrRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesDismissOcr, request),
    onOpenReader: (callback: (sourceId: string) => void) => {
      const listener = (_event: unknown, sourceId: string) => callback(sourceId);
      ipcRenderer.on(IPC_CHANNELS.sourcesOpenReader, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.sourcesOpenReader, listener);
    },
  },
  ai: {
    run: (request: AiRunRequest) => ipcRenderer.invoke(IPC_CHANNELS.aiRun, request),
    list: (request: AiListRequest) => ipcRenderer.invoke(IPC_CHANNELS.aiList, request),
    approveCard: (request: AiApproveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.aiApproveCard, request),
    dismiss: (request: AiDismissRequest) => ipcRenderer.invoke(IPC_CHANNELS.aiDismiss, request),
    status: () => ipcRenderer.invoke(IPC_CHANNELS.aiStatus),
    downloadModel: () => ipcRenderer.invoke(IPC_CHANNELS.aiDownloadModel),
  },
  capture: {
    getPairing: () => ipcRenderer.invoke(IPC_CHANNELS.captureGetPairing),
    regenerateToken: () => ipcRenderer.invoke(IPC_CHANNELS.captureRegenerateToken),
    setEnabled: (request: CaptureSetEnabledRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.captureSetEnabled, request),
  },
  inbox: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.inboxList),
    get: (request: InboxGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.inboxGet, request),
    triage: (request: InboxTriageRequest) => ipcRenderer.invoke(IPC_CHANNELS.inboxTriage, request),
    bulkTriage: (request: InboxBulkTriageRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.inboxBulkTriage, request),
    bulkTriageUndo: (request: InboxBulkTriageUndoRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.inboxBulkTriageUndo, request),
    bulkApplySuggestions: (request: InboxBulkApplySuggestionsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.inboxBulkApplySuggestions, request),
  },
  triage: {
    suggest: (request: TriageSuggestRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.triageSuggest, request),
    suggestForMetadata: (request: TriageSuggestMetadataRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.triageSuggestMetadata, request),
  },
  documents: {
    get: (request: DocumentsGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.documentsGet, request),
    save: (request: DocumentsSaveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.documentsSave, request),
    exportMarkdown: (request: DocumentsExportMarkdownRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.documentsExportMarkdown, request),
    marks: {
      add: (request: DocumentMarksAddRequest) =>
        ipcRenderer.invoke(IPC_CHANNELS.documentsMarksAdd, request),
      remove: (request: DocumentMarksRemoveRequest) =>
        ipcRenderer.invoke(IPC_CHANNELS.documentsMarksRemove, request),
      list: (request: DocumentMarksListRequest) =>
        ipcRenderer.invoke(IPC_CHANNELS.documentsMarksList, request),
    },
  },
  blockProcessing: {
    list: (request: BlockProcessingSourceRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.blockProcessingList, request),
    summary: (request: BlockProcessingSourceRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.blockProcessingSummary, request),
    markIgnored: (request: BlockProcessingMarkBlockRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.blockProcessingMarkIgnored, request),
    markProcessed: (request: BlockProcessingMarkBlockRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.blockProcessingMarkProcessed, request),
    markNeedsLater: (request: BlockProcessingMarkBlockRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.blockProcessingMarkNeedsLater, request),
    markUnread: (request: BlockProcessingMarkBlockRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.blockProcessingMarkUnread, request),
  },
  extractions: {
    create: (request: ExtractionCreateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractionsCreate, request),
  },
  cards: {
    create: (request: CardsCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsCreate, request),
    generateOcclusion: (request: CardsGenerateOcclusionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsGenerateOcclusion, request),
    update: (request: CardsUpdateRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsUpdate, request),
    reStabilizeUndo: (request: CardsReStabilizeUndoRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsReStabilizeUndo, request),
    setLifetime: (request: CardsSetLifetimeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsSetLifetime, request),
    suspend: (request: CardsSuspendRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsSuspend, request),
    delete: (request: CardsDeleteRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsDelete, request),
    flag: (request: CardsFlagRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsFlag, request),
    markLeech: (request: CardsMarkLeechRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsMarkLeech, request),
    split: (request: CardsSplitRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsSplit, request),
    addContext: (request: CardsAddContextRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsAddContext, request),
    backToExtract: (request: CardsBackToExtractRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsBackToExtract, request),
    retire: (request: CardsRetireRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsRetire, request),
    unretire: (request: CardsUnretireRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsUnretire, request),
    retired: () => ipcRenderer.invoke(IPC_CHANNELS.cardsRetired),
    siblingAnswers: (request: CardsSiblingAnswersRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsSiblingAnswers, request),
    importAnki: (request: CardsImportAnkiRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsImportAnki, request),
    exportAnki: (request: CardsExportAnkiRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsExportAnki, request),
  },
  extracts: {
    updateStage: (request: ExtractsUpdateStageRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractsUpdateStage, request),
    rewrite: (request: ExtractsRewriteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractsRewrite, request),
    postpone: (request: ExtractsPostponeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractsPostpone, request),
    markDone: (request: ExtractsMarkDoneRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractsMarkDone, request),
    setFate: (request: ExtractsSetFateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractsSetFate, request),
    reactivateFate: (request: ExtractsReactivateFateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractsReactivateFate, request),
    delete: (request: ExtractsDeleteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractsDelete, request),
  },
  review: {
    sessionNext: (request?: ReviewSessionNextRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reviewSessionNext, request ?? {}),
    card: (request: ReviewCardRequest) => ipcRenderer.invoke(IPC_CHANNELS.reviewCard, request),
    preview: (request: ReviewPreviewRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reviewPreview, request),
    grade: (request: ReviewGradeRequestInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.reviewGrade, request),
    leeches: () => ipcRenderer.invoke(IPC_CHANNELS.reviewLeeches),
    modeDeck: (request: ReviewModeDeckRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reviewModeDeck, request),
    modeCount: (request: ReviewModeCountRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reviewModeCount, request),
  },
  concepts: {
    create: (request: ConceptsCreateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.conceptsCreate, request),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.conceptsList),
    assign: (request: ConceptsAssignRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.conceptsAssign, request),
    unassign: (request: ConceptsUnassignRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.conceptsUnassign, request),
    members: (request: ConceptsMembersRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.conceptsMembers, request),
  },
  tasks: {
    create: (request: TasksCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.tasksCreate, request),
    list: (request: TasksListRequest) => ipcRenderer.invoke(IPC_CHANNELS.tasksList, request),
    complete: (request: TasksCompleteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.tasksComplete, request),
    postpone: (request: TasksPostponeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.tasksPostpone, request),
    generateFromExpiry: (request: TasksGenerateFromExpiryRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.tasksGenerateFromExpiry, request),
  },
  synthesis: {
    create: (request: SynthesisCreateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.synthesisCreate, request),
    link: (request: SynthesisLinkRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.synthesisLink, request),
    unlink: (request: SynthesisUnlinkRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.synthesisUnlink, request),
    editBody: (request: SynthesisEditBodyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.synthesisEditBody, request),
    scheduleReturn: (request: SynthesisScheduleReturnRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.synthesisScheduleReturn, request),
    get: (request: SynthesisGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.synthesisGet, request),
  },
  retention: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.retentionGet),
    setBand: (request: RetentionSetBandRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.retentionSetBand, request),
    setBandEnabled: (request: RetentionSetBandEnabledRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.retentionSetBandEnabled, request),
    setConcept: (request: RetentionSetConceptRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.retentionSetConcept, request),
    setCard: (request: RetentionSetCardRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.retentionSetCard, request),
    resolveFor: (request: RetentionResolveForRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.retentionResolveFor, request),
  },
  optimization: {
    suggest: (request: OptimizationSuggestRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.optimizationSuggest, request),
    apply: (request: OptimizationApplyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.optimizationApply, request),
  },
  workload: {
    simulate: (request: WorkloadSimulateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.workloadSimulate, request),
  },
  tags: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.tagsList),
    add: (request: TagsAddRequest) => ipcRenderer.invoke(IPC_CHANNELS.tagsAdd, request),
    remove: (request: TagsRemoveRequest) => ipcRenderer.invoke(IPC_CHANNELS.tagsRemove, request),
  },
  search: {
    query: (request: SearchQueryRequest) => ipcRenderer.invoke(IPC_CHANNELS.searchQuery, request),
  },
  semantic: {
    search: (request: SemanticSearchRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.semanticSearch, request),
    status: (request?: SemanticStatusRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.semanticStatus, request ?? {}),
    reindex: (request?: SemanticReindexRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.semanticReindex, request ?? {}),
    retryFailed: (request?: SemanticRetryFailedRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.semanticRetryFailed, request ?? {}),
    downloadModel: (request?: SemanticDownloadModelRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.semanticDownloadModel, request ?? {}),
    related: (request: SemanticRelatedRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.semanticRelated, request),
    contradictions: (request: SemanticContradictionsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.semanticContradictions, request),
  },
  library: {
    browse: (request?: LibraryBrowseRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.libraryBrowse, request ?? {}),
    parkedAction: (request: LibraryParkedActionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.libraryParkedAction, request),
  },
  readPoints: {
    get: (request: ReadPointGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.readPointGet, request),
    set: (request: ReadPointSetRequest) => ipcRenderer.invoke(IPC_CHANNELS.readPointSet, request),
  },
  trash: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.trashList),
    restore: (request: TrashRestoreRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.trashRestore, request),
    restoreBatch: (request: TrashRestoreBatchRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.trashRestoreBatch, request),
    restoreAncestorChain: (request: TrashRestoreAncestorChainRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.trashRestoreAncestorChain, request),
    purge: (request: TrashPurgeRequest) => ipcRenderer.invoke(IPC_CHANNELS.trashPurge, request),
    empty: () => ipcRenderer.invoke(IPC_CHANNELS.trashEmpty),
  },
  undo: {
    last: () => ipcRenderer.invoke(IPC_CHANNELS.undoLast),
  },
  analytics: {
    get: (request?: AnalyticsGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.analyticsGet, request),
    reviewActivity: (request?: AnalyticsReviewActivityRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.analyticsReviewActivity, request),
    priorityIntegrity: (request?: PriorityIntegrityGetRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.analyticsPriorityIntegrity, request),
    topicKnowledgeState: (request?: TopicKnowledgeStateGetRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.analyticsTopicKnowledgeState, request),
  },
  balance: {
    get: (request?: BalanceGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.balanceGet, request),
  },
  dailyWork: {
    summary: (request?: DailyWorkSummaryRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.dailyWorkSummary, request ?? {}),
    ackGraduationEvents: (request?: DailyWorkGraduationAckRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.dailyWorkAckGraduationEvents, request ?? {}),
    undoAutoPostponeReceipt: (request: DailyWorkUndoAutoPostponeReceiptRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.dailyWorkUndoAutoPostponeReceipt, request),
  },
  extractAging: {
    preview: (request?: ExtractAgingPreviewRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractAgingPreview, request ?? {}),
    apply: (request?: ExtractAgingApplyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractAgingApply, request ?? {}),
    undoReceipt: (request: ExtractAgingUndoReceiptRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractAgingUndoReceipt, request),
  },
  reverify: {
    flaggedSources: () => ipcRenderer.invoke(IPC_CHANNELS.reverifyFlaggedSources),
    sessionPreview: (request: ReverifySessionPreviewRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reverifySessionPreview, request),
    resolve: (request: ReverifyResolveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reverifyResolve, request),
    undoReceipt: (request: ReverifyUndoReceiptRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reverifyUndoReceipt, request),
    receiptsToday: () => ipcRenderer.invoke(IPC_CHANNELS.reverifyReceiptsToday),
  },
  weeklyReview: {
    summary: (request?: WeeklyReviewSummaryRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyReviewSummary, request ?? {}),
    updateProgress: (request: WeeklyReviewProgressPatch) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyReviewUpdateProgress, request),
    complete: (request: WeeklyReviewCompleteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyReviewComplete, request),
    dismiss: (request: WeeklyReviewDismissRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.weeklyReviewDismiss, request),
  },
  sourceYield: {
    list: (request?: SourceYieldListRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourceYieldList, request),
  },
  lapseClusters: {
    list: (request?: LapseClustersListRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.lapseClusters, request),
  },
  extractStagnation: {
    list: (request?: ExtractStagnationListRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractStagnationList, request),
  },
  backups: {
    create: () => ipcRenderer.invoke(IPC_CHANNELS.backupsCreate),
    openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.backupsOpenFolder),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.backupsList),
    restore: (request: BackupsRestoreRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.backupsRestore, request),
    pickArchive: () => ipcRenderer.invoke(IPC_CHANNELS.backupsPickArchive),
    restoreFile: (request: BackupsRestoreFileRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.backupsRestoreFile, request),
    resetLocalData: (request: BackupsResetLocalDataRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.backupsResetLocalData, request),
  },
  jobs: {
    // Observe the background-runner queue (T058) — invoke only. NO `enqueue`: per
    // the contract decision the renderer enqueues only via `sources.importUrl`.
    list: (request?: JobsListRequest) => ipcRenderer.invoke(IPC_CHANNELS.jobsList, request ?? {}),
    // Receive-only subscription (T058): the runner sends `jobs:updated` with a
    // `JobSummary` on every job state change. Same narrow named-event pattern as
    // `menu.onShowShortcuts`, but — UNLIKE those payload-free exemplars — it must
    // DELIVER the summary to the callback, so the listener forwards the event's
    // payload arg (a plain serializable `JobSummary`, never the raw event).
    subscribe: (callback: (summary: JobSummary) => void) => {
      const listener = (_event: unknown, summary: JobSummary) => callback(summary);
      ipcRenderer.on(IPC_CHANNELS.jobsUpdated, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.jobsUpdated, listener);
    },
  },
  vault: {
    // Asset-vault maintenance (T059) — thin invokes. No raw path or byte ever
    // crosses; the renderer gets only the typed report/counts. `collectOrphans` is
    // guarded by `confirm: true` (validated again on the main side).
    verify: (request?: VaultVerifyRequest) => ipcRenderer.invoke(IPC_CHANNELS.vaultVerify, request),
    findOrphans: (request?: VaultFindOrphansRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultFindOrphans, request),
    collectOrphans: (request: VaultCollectOrphansRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.vaultCollectOrphans, request),
  },
  maintenance: {
    // Large-collection maintenance (T099) — thin invokes. Every report is read-only;
    // every action is op-logged + soft-delete / undoable on the main side. No raw path
    // or asset id crosses inbound; the destructive actions are validated again main-side.
    report: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceReport),
    duplicates: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceDuplicates),
    cardsWithoutSources: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceCardsWithoutSources),
    brokenSources: () => ipcRenderer.invoke(IPC_CHANNELS.maintenanceBrokenSources),
    schedulerConsistency: (request?: MaintenanceSchedulerConsistencyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceSchedulerConsistency, request),
    lowValue: (request?: MaintenanceLowValueRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceLowValue, request),
    integrity: (request?: MaintenanceIntegrityRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceIntegrity, request),
    dedupe: (request: MaintenanceDedupeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceDedupe, request),
    orphanMedia: (request: MaintenanceOrphanMediaRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceOrphanMedia, request),
    bulkTrash: (request: MaintenanceBulkTrashRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceBulkTrash, request),
    bulkArchive: (request: MaintenanceBulkArchiveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceBulkArchive, request),
    bulkPostpone: (request: MaintenanceBulkPostponeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceBulkPostpone, request),
    parkedResurfacing: (request?: MaintenanceParkedResurfacingRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceParkedResurfacing, request),
    parkedResurfacingApply: (request: MaintenanceParkedResurfacingApplyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceParkedResurfacingApply, request),
    chronicPostpones: (request?: MaintenanceChronicPostponesRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceChronicPostpones, request),
    chronicPostponesApply: (request: MaintenanceChronicPostponesApplyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.maintenanceChronicPostponesApply, request),
  },
  menu: {
    // Receive-only subscription (T048): the native Help → "Keyboard shortcuts"
    // menu item sends `menu:showShortcuts`; we forward a payload-free callback and
    // return an unsubscribe fn. No generic listener is exposed — only this one
    // named event, and the renderer never gets the raw `ipcRenderer`/`event`.
    onShowShortcuts: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.menuShowShortcuts, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.menuShowShortcuts, listener);
    },
    // Receive-only subscription (T050): the native File → "Back up…" menu item
    // sends `menu:createBackup`; we forward a payload-free callback and return an
    // unsubscribe fn. Same narrow, named-event pattern as `onShowShortcuts`.
    onCreateBackup: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.menuCreateBackup, listener);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.menuCreateBackup, listener);
    },
  },
};

contextBridge.exposeInMainWorld("appApi", appApi);
