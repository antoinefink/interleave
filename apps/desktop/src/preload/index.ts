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
  AnalyticsGetRequest,
  AppApi,
  BalanceGetRequest,
  CaptureSetEnabledRequest,
  CardsCreateRequest,
  CardsDeleteRequest,
  CardsExportAnkiRequest,
  CardsFlagRequest,
  CardsGenerateOcclusionRequest,
  CardsImportAnkiRequest,
  CardsMarkLeechRequest,
  CardsSuspendRequest,
  CardsUpdateRequest,
  ConceptsAssignRequest,
  ConceptsCreateRequest,
  ConceptsMembersRequest,
  ConceptsUnassignRequest,
  DocumentMarksAddRequest,
  DocumentMarksListRequest,
  DocumentMarksRemoveRequest,
  DocumentsExportMarkdownRequest,
  DocumentsGetRequest,
  DocumentsSaveRequest,
  ElementsSetPriorityRequest,
  ExtractionCreateRequest,
  ExtractsDeleteRequest,
  ExtractsMarkDoneRequest,
  ExtractsPostponeRequest,
  ExtractsRewriteRequest,
  ExtractsUpdateStageRequest,
  InboxGetRequest,
  InboxTriageRequest,
  InspectorGetRequest,
  JobSummary,
  JobsListRequest,
  LibraryBrowseRequest,
  LineageGetRequest,
  PickImportFileRequest,
  QueueActRequest,
  QueueListRequest,
  QueueScheduleRequest,
  QueueUndoRequest,
  ReadPointGetRequest,
  ReadPointSetRequest,
  ReviewCardRequest,
  ReviewGradeRequest,
  ReviewPreviewRequest,
  ReviewSessionNextRequest,
  SearchQueryRequest,
  // review.leeches() / concepts.list() / tags.list() take no request payload.
  SettingsGetRequest,
  SettingsUpdateManyRequest,
  SettingsUpdateRequest,
  SourcesAcceptOcrRequest,
  SourcesExtractRegionRequest,
  SourcesGetOcrRequest,
  SourcesGetPdfDataRequest,
  SourcesGetRegionImageRequest,
  SourcesImportDocumentRequest,
  SourcesImportEpubRequest,
  SourcesImportHighlightsRequest,
  SourcesImportManualRequest,
  SourcesImportMarkdownTextRequest,
  SourcesImportPdfRequest,
  SourcesImportUrlRequest,
  SourcesRunOcrRequest,
  TagsAddRequest,
  TagsRemoveRequest,
  TrashPurgeRequest,
  TrashRestoreRequest,
  VaultCollectOrphansRequest,
  VaultFindOrphansRequest,
  VaultVerifyRequest,
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
  },
  queue: {
    list: (request?: QueueListRequest) => ipcRenderer.invoke(IPC_CHANNELS.queueList, request ?? {}),
    act: (request: QueueActRequest) => ipcRenderer.invoke(IPC_CHANNELS.queueAct, request),
    schedule: (request: QueueScheduleRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.queueSchedule, request),
    undo: (request: QueueUndoRequest) => ipcRenderer.invoke(IPC_CHANNELS.queueUndo, request),
  },
  lineage: {
    get: (request: LineageGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.lineageGet, request),
  },
  sources: {
    importManual: (request: SourcesImportManualRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportManual, request),
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
    runOcr: (request: SourcesRunOcrRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesRunOcr, request),
    getOcr: (request: SourcesGetOcrRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesGetOcr, request),
    acceptOcr: (request: SourcesAcceptOcrRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesAcceptOcr, request),
    dismissOcr: (request: SourcesAcceptOcrRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesDismissOcr, request),
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
  extractions: {
    create: (request: ExtractionCreateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractionsCreate, request),
  },
  cards: {
    create: (request: CardsCreateRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsCreate, request),
    generateOcclusion: (request: CardsGenerateOcclusionRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsGenerateOcclusion, request),
    update: (request: CardsUpdateRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsUpdate, request),
    suspend: (request: CardsSuspendRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsSuspend, request),
    delete: (request: CardsDeleteRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsDelete, request),
    flag: (request: CardsFlagRequest) => ipcRenderer.invoke(IPC_CHANNELS.cardsFlag, request),
    markLeech: (request: CardsMarkLeechRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.cardsMarkLeech, request),
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
    delete: (request: ExtractsDeleteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.extractsDelete, request),
  },
  review: {
    sessionNext: (request?: ReviewSessionNextRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reviewSessionNext, request ?? {}),
    card: (request: ReviewCardRequest) => ipcRenderer.invoke(IPC_CHANNELS.reviewCard, request),
    preview: (request: ReviewPreviewRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.reviewPreview, request),
    grade: (request: ReviewGradeRequest) => ipcRenderer.invoke(IPC_CHANNELS.reviewGrade, request),
    leeches: () => ipcRenderer.invoke(IPC_CHANNELS.reviewLeeches),
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
  tags: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.tagsList),
    add: (request: TagsAddRequest) => ipcRenderer.invoke(IPC_CHANNELS.tagsAdd, request),
    remove: (request: TagsRemoveRequest) => ipcRenderer.invoke(IPC_CHANNELS.tagsRemove, request),
  },
  search: {
    query: (request: SearchQueryRequest) => ipcRenderer.invoke(IPC_CHANNELS.searchQuery, request),
  },
  library: {
    browse: (request?: LibraryBrowseRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.libraryBrowse, request ?? {}),
  },
  readPoints: {
    get: (request: ReadPointGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.readPointGet, request),
    set: (request: ReadPointSetRequest) => ipcRenderer.invoke(IPC_CHANNELS.readPointSet, request),
  },
  trash: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.trashList),
    restore: (request: TrashRestoreRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.trashRestore, request),
    purge: (request: TrashPurgeRequest) => ipcRenderer.invoke(IPC_CHANNELS.trashPurge, request),
    empty: () => ipcRenderer.invoke(IPC_CHANNELS.trashEmpty),
  },
  undo: {
    last: () => ipcRenderer.invoke(IPC_CHANNELS.undoLast),
  },
  analytics: {
    get: (request?: AnalyticsGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.analyticsGet, request),
  },
  balance: {
    get: (request?: BalanceGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.balanceGet, request),
  },
  backups: {
    create: () => ipcRenderer.invoke(IPC_CHANNELS.backupsCreate),
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
