/**
 * IPC router (T007) — wires the validated request handlers for the narrow
 * `window.appApi` surface to the main-process services.
 *
 * Every handler validates its payload with the Zod schema from the shared
 * contract **before** touching the DB service: the renderer is untrusted, so
 * malformed payloads are rejected at the boundary. There is no generic
 * `db.query(sql)` handler — only the four explicit commands below exist.
 */

import type { Job, JobJsonValue } from "@interleave/core";
import { isYouTubeUrl } from "@interleave/importers";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import {
  AiApproveRequestSchema,
  AiDismissRequestSchema,
  AiListRequestSchema,
  AiRunRequestSchema,
  AnalyticsGetRequestSchema,
  AnalyticsReviewActivityRequestSchema,
  BackupsCreateRequestSchema,
  BackupsListRequestSchema,
  BackupsOpenFolderRequestSchema,
  BackupsResetLocalDataRequestSchema,
  BackupsRestoreFileRequestSchema,
  BackupsRestoreRequestSchema,
  BalanceGetRequestSchema,
  BlockProcessingMarkBlockRequestSchema,
  BlockProcessingSourceRequestSchema,
  CaptureGetPairingRequestSchema,
  CaptureRegenerateTokenRequestSchema,
  CaptureSetEnabledRequestSchema,
  CardsAddContextRequestSchema,
  CardsBackToExtractRequestSchema,
  CardsCreateRequestSchema,
  CardsDeleteRequestSchema,
  CardsExportAnkiRequestSchema,
  CardsFlagRequestSchema,
  CardsGenerateOcclusionRequestSchema,
  CardsImportAnkiRequestSchema,
  CardsMarkLeechRequestSchema,
  CardsRetireRequestSchema,
  CardsSetLifetimeRequestSchema,
  CardsSiblingAnswersRequestSchema,
  CardsSplitRequestSchema,
  CardsSuspendRequestSchema,
  CardsUnretireRequestSchema,
  CardsUpdateRequestSchema,
  ConceptsAssignRequestSchema,
  ConceptsCreateRequestSchema,
  ConceptsListRequestSchema,
  ConceptsMembersRequestSchema,
  ConceptsUnassignRequestSchema,
  DailyWorkSummaryRequestSchema,
  DbStatusRequestSchema,
  DocumentMarksAddRequestSchema,
  DocumentMarksListRequestSchema,
  DocumentMarksRemoveRequestSchema,
  DocumentsExportMarkdownRequestSchema,
  DocumentsGetRequestSchema,
  DocumentsSaveRequestSchema,
  ElementsSetPriorityRequestSchema,
  ExtractionCreateRequestSchema,
  ExtractStagnationListRequestSchema,
  ExtractsDeleteRequestSchema,
  ExtractsMarkDoneRequestSchema,
  ExtractsPostponeRequestSchema,
  ExtractsReactivateFateRequestSchema,
  ExtractsRewriteRequestSchema,
  ExtractsSetFateRequestSchema,
  ExtractsUpdateStageRequestSchema,
  HealthRequestSchema,
  type HealthResult,
  InboxGetRequestSchema,
  InboxListRequestSchema,
  InboxTriageRequestSchema,
  InspectorGetRequestSchema,
  InspectorListRequestSchema,
  IPC_CHANNELS,
  type JobSummary,
  JobsListRequestSchema,
  type JobsListResult,
  LibraryBrowseRequestSchema,
  LibraryParkedActionRequestSchema,
  LineageGetRequestSchema,
  MaintenanceBrokenSourcesRequestSchema,
  MaintenanceBulkArchiveRequestSchema,
  MaintenanceBulkPostponeRequestSchema,
  MaintenanceBulkTrashRequestSchema,
  MaintenanceCardsWithoutSourcesRequestSchema,
  MaintenanceChronicPostponesApplyRequestSchema,
  MaintenanceChronicPostponesRequestSchema,
  MaintenanceDedupeRequestSchema,
  MaintenanceDuplicatesRequestSchema,
  MaintenanceIntegrityRequestSchema,
  MaintenanceLowValueRequestSchema,
  MaintenanceOrphanMediaRequestSchema,
  MaintenanceParkedResurfacingApplyRequestSchema,
  MaintenanceParkedResurfacingRequestSchema,
  MaintenanceReportRequestSchema,
  MaintenanceSchedulerConsistencyRequestSchema,
  OptimizationApplyRequestSchema,
  OptimizationSuggestRequestSchema,
  PickImportFileRequestSchema,
  type PickImportFileResult,
  PriorityIntegrityGetRequestSchema,
  QueueActRequestSchema,
  QueueAutoPostponeRequestSchema,
  QueueCatchUpRequestSchema,
  QueueListRequestSchema,
  QueueScheduleRequestSchema,
  QueueUndoRequestSchema,
  QueueVacationRequestSchema,
  ReadPointGetRequestSchema,
  ReadPointSetRequestSchema,
  RetentionGetRequestSchema,
  RetentionResolveForRequestSchema,
  RetentionSetBandEnabledRequestSchema,
  RetentionSetBandRequestSchema,
  RetentionSetCardRequestSchema,
  RetentionSetConceptRequestSchema,
  ReviewCardRequestSchema,
  ReviewGradeRequestSchema,
  ReviewLeechesRequestSchema,
  ReviewModeCountRequestSchema,
  ReviewModeDeckRequestSchema,
  ReviewPreviewRequestSchema,
  ReviewSessionNextRequestSchema,
  SearchQueryRequestSchema,
  SemanticContradictionsRequestSchema,
  SemanticDownloadModelRequestSchema,
  SemanticReindexRequestSchema,
  SemanticRelatedRequestSchema,
  SemanticSearchRequestSchema,
  SettingsGetAllRequestSchema,
  SettingsGetRequestSchema,
  SettingsUpdateManyRequestSchema,
  SettingsUpdateRequestSchema,
  SourcesAcceptOcrRequestSchema,
  SourcesDismissRetirementSuggestionRequestSchema,
  SourcesExtractClipRequestSchemaRefined,
  SourcesExtractRegionRequestSchema,
  SourcesGetMediaDataRequestSchema,
  SourcesGetOcrRequestSchema,
  SourcesGetPdfDataRequestSchema,
  SourcesGetRegionImageRequestSchema,
  SourcesImportDocumentRequestSchema,
  SourcesImportEpubRequestSchema,
  SourcesImportHighlightsRequestSchema,
  SourcesImportManualRequestSchema,
  SourcesImportMarkdownTextRequestSchema,
  SourcesImportMediaRequestSchema,
  SourcesImportPdfRequestSchema,
  SourcesImportUrlRequestSchema,
  type SourcesImportUrlResult,
  SourcesRunOcrRequestSchema,
  SourcesUpdateReliabilityRequestSchema,
  SourceYieldListRequestSchema,
  SynthesisCreateRequestSchema,
  SynthesisEditBodyRequestSchema,
  SynthesisGetRequestSchema,
  SynthesisLinkRequestSchema,
  SynthesisScheduleReturnRequestSchema,
  SynthesisUnlinkRequestSchema,
  TagsAddRequestSchema,
  TagsListRequestSchema,
  TagsRemoveRequestSchema,
  TasksCompleteRequestSchema,
  TasksCreateRequestSchema,
  TasksGenerateFromExpiryRequestSchema,
  TasksListRequestSchema,
  TasksPostponeRequestSchema,
  TrashEmptyRequestSchema,
  TrashListRequestSchema,
  TrashPurgeRequestSchema,
  TrashRestoreRequestSchema,
  UndoLastRequestSchema,
  VaultCollectOrphansRequestSchema,
  VaultFindOrphansRequestSchema,
  VaultVerifyRequestSchema,
  WorkloadSimulateRequestSchema,
} from "../shared/contract";
import { AnkiExportError } from "./anki-export-service";
import { AnkiImportError } from "./anki-import-service";
import { BackupRestoreService } from "./backup-restore-service";
import { BackupService } from "./backup-service";
import type { CaptureController } from "./capture-controller";
import type { DbService } from "./db-service";
import { DocumentImportError } from "./document-import-service";
import { EpubImportError } from "./epub-import-service";
import { HighlightImportError } from "./highlight-import-service";
import type { UrlImportJobPayload } from "./job-apply-handlers";
import type { JobRunner } from "./job-runner";
import { MediaImportError } from "./media-import-service";
import type { AppPaths } from "./paths";
import { PdfImportError } from "./pdf-import-service";
import { UrlImportError } from "./url-import-service";

/** Extra main-process context the backup handler (T047) needs (absolute paths). */
export interface IpcHandlerContext {
  /** The resolved app-data paths (`dbPath`/`assetsDir`/`backupsDir`). */
  readonly paths: AppPaths;
  /** The Drizzle migrations folder (its journal maps idx → schema-version tag). */
  readonly migrationsDir: string;
  /** Packaged Electron native binding for secondary SQLite opens. */
  readonly nativeBinding?: string | undefined;
  /**
   * The live capture-server controller (T062) — the `capture.*` pairing commands
   * route here so the IPC layer never touches the raw HTTP server or the
   * `capture.*` settings keys directly. Optional so contract/round-trip tests can
   * register the non-capture handlers alone.
   */
  readonly captureController?: CaptureController;
  /**
   * The on-device background job runner (T058). The `sources.importUrl` path now
   * ENQUEUES a `url_import` job (the worker fetches off-main); `jobs.list` +
   * `jobs.subscribe` observe the queue. Optional so contract-only tests register
   * the non-runner handlers alone; a runner-requiring handler then throws clearly.
   */
  readonly runner?: JobRunner;
}

/** Project a domain {@link Job} to the renderer-safe {@link JobSummary}. */
function toJobSummary(job: Job): JobSummary {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progressRatio: Math.round(job.progress.ratio * 100),
    progressNote: job.progress.note ?? null,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Register all IPC handlers. Call once after the DB service is open. Returns a
 * disposer that removes the handlers (used on shutdown / in tests). `context`
 * supplies the absolute paths the backup command needs; it is optional so the
 * contract/round-trip tests can register the non-filesystem handlers alone.
 */
export function registerIpcHandlers(dbService: DbService, context?: IpcHandlerContext): () => void {
  ipcMain.handle(IPC_CHANNELS.appHealth, (): HealthResult => {
    // No payload to validate (void), but keep the schema call for symmetry.
    HealthRequestSchema.parse(undefined);
    const dbOpen = dbService.isOpen && dbService.ping();
    return {
      status: "ok",
      appVersion: app.getVersion(),
      dbOpen,
      migrated: dbService.isMigrated,
      time: new Date().toISOString(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.dbGetStatus, () => {
    DbStatusRequestSchema.parse(undefined);
    return dbService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.settingsGet, (_event, rawRequest: unknown) => {
    const request = SettingsGetRequestSchema.parse(rawRequest ?? {});
    return dbService.getSettings(request.key);
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (_event, rawRequest: unknown) => {
    const request = SettingsUpdateRequestSchema.parse(rawRequest);
    return dbService.updateSetting(request.key, request.value);
  });

  ipcMain.handle(IPC_CHANNELS.settingsGetAll, () => {
    SettingsGetAllRequestSchema.parse(undefined);
    return dbService.getAppSettings();
  });

  ipcMain.handle(IPC_CHANNELS.settingsUpdateMany, (_event, rawRequest: unknown) => {
    const request = SettingsUpdateManyRequestSchema.parse(rawRequest);
    return dbService.updateAppSettings(request.patch);
  });

  ipcMain.handle(IPC_CHANNELS.inspectorList, () => {
    InspectorListRequestSchema.parse(undefined);
    return dbService.listInspectableElements();
  });

  ipcMain.handle(IPC_CHANNELS.inspectorGet, (_event, rawRequest: unknown) => {
    const request = InspectorGetRequestSchema.parse(rawRequest);
    return dbService.getInspectorData(request.id);
  });

  ipcMain.handle(IPC_CHANNELS.elementsSetPriority, (_event, rawRequest: unknown) => {
    const request = ElementsSetPriorityRequestSchema.parse(rawRequest);
    return dbService.setElementPriority(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueList, (_event, rawRequest: unknown) => {
    const request = QueueListRequestSchema.parse(rawRequest ?? {});
    return dbService.listQueue(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueAct, (_event, rawRequest: unknown) => {
    const request = QueueActRequestSchema.parse(rawRequest);
    return dbService.actOnQueueItem(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueSchedule, (_event, rawRequest: unknown) => {
    const request = QueueScheduleRequestSchema.parse(rawRequest);
    return dbService.scheduleQueueItem(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueUndo, (_event, rawRequest: unknown) => {
    const request = QueueUndoRequestSchema.parse(rawRequest);
    return dbService.undoQueueAction(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueAutoPostpone, (_event, rawRequest: unknown) => {
    const request = QueueAutoPostponeRequestSchema.parse(rawRequest ?? {});
    return dbService.previewAutoPostpone(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueAutoPostponeApply, (_event, rawRequest: unknown) => {
    const request = QueueAutoPostponeRequestSchema.parse(rawRequest ?? {});
    return dbService.applyAutoPostpone(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueCatchUp, (_event, rawRequest: unknown) => {
    const request = QueueCatchUpRequestSchema.parse(rawRequest ?? {});
    return dbService.previewCatchUp(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueCatchUpApply, (_event, rawRequest: unknown) => {
    const request = QueueCatchUpRequestSchema.parse(rawRequest ?? {});
    return dbService.applyCatchUp(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueVacation, (_event, rawRequest: unknown) => {
    const request = QueueVacationRequestSchema.parse(rawRequest);
    return dbService.previewVacation(request);
  });

  ipcMain.handle(IPC_CHANNELS.queueVacationApply, (_event, rawRequest: unknown) => {
    const request = QueueVacationRequestSchema.parse(rawRequest);
    return dbService.applyVacation(request);
  });

  ipcMain.handle(IPC_CHANNELS.lineageGet, (_event, rawRequest: unknown) => {
    const request = LineageGetRequestSchema.parse(rawRequest);
    return dbService.getLineage(request.id);
  });

  ipcMain.handle(IPC_CHANNELS.sourcesImportManual, (_event, rawRequest: unknown) => {
    const request = SourcesImportManualRequestSchema.parse(rawRequest);
    return dbService.importManualSource(request);
  });

  // Source-reliability edit (T091) — set/clear the source's type/tier/confidence/notes,
  // one `update_element` transaction on the source element (no new op type).
  ipcMain.handle(IPC_CHANNELS.sourcesUpdateReliability, (_event, rawRequest: unknown) => {
    const request = SourcesUpdateReliabilityRequestSchema.parse(rawRequest);
    return dbService.updateSourceReliability(request);
  });

  ipcMain.handle(IPC_CHANNELS.sourcesDismissRetirementSuggestion, (_event, rawRequest: unknown) => {
    const request = SourcesDismissRetirementSuggestionRequestSchema.parse(rawRequest);
    return dbService.dismissRetirementSuggestion(request);
  });

  // URL import (T060/T058) — the renderer enqueues a `url_import` job; the
  // background-runner WORKER fetches the page OFF-MAIN (so a slow fetch never
  // freezes the UI or blocks the SQLite writer), and MAIN applies the result
  // through the existing UrlImportService snapshot+createSource pipeline. The
  // handler keeps the existing single-result contract by ENQUEUEING + AWAITING
  // the job's terminal state (main never blocks on the network — only on the
  // job's terminal `job:update`). A `succeeded` job carries the apply handler's
  // SourcesImportUrlResult (imported | duplicate) → returned as-is; a `failed`/
  // `cancelled` job → re-throw a reconstructed UrlImportError (the result type has
  // NO error arm — errors are THROWN, exactly as the inline path did), which the
  // `ImportUrlModal` catch already handles.
  ipcMain.handle(IPC_CHANNELS.sourcesImportUrl, async (_event, rawRequest: unknown) => {
    const request = SourcesImportUrlRequestSchema.parse(rawRequest);
    // YouTube routing fork (T073): "Paste URL" stays the ONE web-import entry point,
    // but a YouTube URL is a VIDEO source, not a Readability article — route it to the
    // media importer (oEmbed metadata + best-effort on-device captions; no bytes
    // downloaded), bypassing the `url_import` worker job. The result is the SAME
    // discriminated `"imported"` shape the URL path returns, so the renderer is unchanged.
    if (isYouTubeUrl(request.url)) {
      try {
        const media = await dbService.importMediaFromYouTube({
          url: request.url,
          ...(request.priority ? { priority: request.priority } : {}),
          ...(request.reasonAdded !== undefined ? { reasonAdded: request.reasonAdded } : {}),
        });
        return { status: "imported", id: media.id, item: media.item } as SourcesImportUrlResult;
      } catch (err) {
        if (err instanceof MediaImportError) {
          throw new Error(`${err.code}: ${err.message}`);
        }
        throw err;
      }
    }
    const runner = requireRunner();
    const payload: UrlImportJobPayload = {
      url: request.url,
      ...(request.priority ? { priority: request.priority } : {}),
      ...(request.reasonAdded !== undefined ? { reasonAdded: request.reasonAdded } : {}),
      ...(request.forceNewVersion !== undefined
        ? { forceNewVersion: request.forceNewVersion }
        : {}),
      // Forward the DEV/E2E loopback-import escape so the worker's SSRF guard
      // permits the 127.0.0.1 fixture server in the E2E (never set in production).
      ...(dbService.allowsLoopbackImport ? { allowLoopback: true } : {}),
    };
    const enqueued = runner.enqueue("url_import", payload as unknown as JobJsonValue);
    const job = await runner.waitForTerminal(enqueued.id);
    if (job.status === "succeeded" && job.result && typeof job.result === "object") {
      return job.result as unknown as SourcesImportUrlResult;
    }
    // Terminal failed/cancelled → reconstruct + throw the typed import error. The
    // stored error is a `code: message` line; split it back into the typed shape.
    const errorLine = job.error ?? "fetch_failed: URL import did not complete";
    const sep = errorLine.indexOf(":");
    const code = (sep > 0 ? errorLine.slice(0, sep) : "fetch_failed").trim();
    const message = (sep > 0 ? errorLine.slice(sep + 1) : errorLine).trim();
    throw new UrlImportError(code as UrlImportError["code"], message);
  });

  // PDF import (T064) — the renderer cannot pick a filesystem path (no fs access),
  // so MAIN opens a native file picker (filtered to `.pdf`), resolves the chosen
  // absolute path, and runs the PdfImportService (read + validate + stream into the
  // vault + parse + create an `inbox` source). The user can cancel the picker — a
  // non-error `{ status: "cancelled" }`. A thrown `PdfImportError` rejects the
  // invoke (the renderer modal's catch maps its `code` to a friendly line). The
  // E2E stubs the picker via INTERLEAVE_PDF_IMPORT_PATH (unpackaged only), mirroring
  // the INTERLEAVE_ALLOW_LOOPBACK_IMPORT escape pattern.
  ipcMain.handle(IPC_CHANNELS.sourcesImportPdf, async (event, rawRequest: unknown) => {
    const request = SourcesImportPdfRequestSchema.parse(rawRequest);
    const filePath = await pickPdfPath(event);
    if (!filePath) return { status: "cancelled" } as const;
    try {
      return await dbService.importPdf({
        filePath,
        ...(request.priority ? { priority: request.priority } : {}),
        ...(request.reasonAdded !== undefined ? { reasonAdded: request.reasonAdded } : {}),
      });
    } catch (err) {
      // Re-throw a typed PdfImportError as a `code: message` line so the renderer
      // modal can map the `code` to a friendly message (mirrors the URL path).
      if (err instanceof PdfImportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  // Serve a PDF source's original bytes to the renderer for rendering (T064). MAIN
  // owns the path; the renderer passes only an element id. Read-only.
  ipcMain.handle(IPC_CHANNELS.sourcesGetPdfData, (_event, rawRequest: unknown) => {
    const request = SourcesGetPdfDataRequestSchema.parse(rawRequest);
    return dbService.getPdfData(request);
  });

  // Pick a local file to import (T067) — the SHARED native picker for all M14 file
  // imports. The renderer cannot read the filesystem, so it asks MAIN to open the
  // dialog (filtered to the `kind`'s extensions) and returns the chosen path(s) or a
  // cancellation. The E2E stubs the EPUB picker via INTERLEAVE_EPUB_IMPORT_PATH
  // (unpackaged only), mirroring the INTERLEAVE_PDF_IMPORT_PATH escape.
  ipcMain.handle(
    IPC_CHANNELS.sourcesPickImportFile,
    async (event, rawRequest: unknown): Promise<PickImportFileResult> => {
      const request = PickImportFileRequestSchema.parse(rawRequest);
      const paths = await pickImportFilePaths(event, request.kind);
      if (paths.length === 0) return { cancelled: true };
      return { paths };
    },
  );

  // Import a local `.epub` (T067) — the renderer has already resolved the chosen
  // path via `sources.pickImportFile`. MAIN reads + validates + streams the original
  // into the vault + parses the book + creates an `inbox` book source + chapter
  // topics. A thrown `EpubImportError` is re-thrown as a `code: message` line so the
  // renderer modal can map the `code` to a friendly message (mirrors the PDF path).
  ipcMain.handle(IPC_CHANNELS.sourcesImportEpub, async (_event, rawRequest: unknown) => {
    const request = SourcesImportEpubRequestSchema.parse(rawRequest);
    try {
      return await dbService.importEpub({
        absPath: request.path,
        ...(request.priority ? { priority: request.priority } : {}),
        ...(request.reasonAdded !== undefined ? { reasonAdded: request.reasonAdded } : {}),
      });
    } catch (err) {
      if (err instanceof EpubImportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  // Import a local media file (T073) — the renderer resolved the chosen media path
  // (and optional sidecar subtitles path) via `sources.pickImportFile`. MAIN reads +
  // validates + streams the original into the vault + parses the (optional) transcript
  // + creates an `inbox` source. A thrown `MediaImportError` is re-thrown as a
  // `code: message` line so the inbox chip can map the `code` to a friendly message
  // (mirrors the PDF/EPUB path).
  ipcMain.handle(IPC_CHANNELS.sourcesImportMedia, async (_event, rawRequest: unknown) => {
    const request = SourcesImportMediaRequestSchema.parse(rawRequest);
    try {
      return await dbService.importMedia({
        path: request.path,
        ...(request.subtitlesPath !== undefined ? { subtitlesPath: request.subtitlesPath } : {}),
        ...(request.priority ? { priority: request.priority } : {}),
        ...(request.reasonAdded !== undefined ? { reasonAdded: request.reasonAdded } : {}),
      });
    } catch (err) {
      if (err instanceof MediaImportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  // Serve a media source's playable data to the renderer (T073). For a local source it
  // returns the privileged `media://<id>` URL (streamed by the protocol handler) + the
  // mime/duration; for a YouTube source it returns the video id. MAIN owns the path; the
  // renderer passes only an element id. Read-only.
  ipcMain.handle(IPC_CHANNELS.sourcesGetMediaData, (_event, rawRequest: unknown) => {
    const request = SourcesGetMediaDataRequestSchema.parse(rawRequest);
    return dbService.getMediaData(request);
  });

  // Import a local `.md`/`.html` file (T068) — the renderer resolved the chosen path
  // via `sources.pickImportFile`. MAIN reads + parses + creates an `inbox` source. A
  // thrown `DocumentImportError` is re-thrown as a `code: message` line so the modal
  // can map the `code` to a friendly message (mirrors the EPUB path).
  ipcMain.handle(IPC_CHANNELS.sourcesImportDocument, async (_event, rawRequest: unknown) => {
    const request = SourcesImportDocumentRequestSchema.parse(rawRequest);
    try {
      return await dbService.importDocument({
        absPath: request.path,
        format: request.format,
        ...(request.priority ? { priority: request.priority } : {}),
        ...(request.reasonAdded !== undefined ? { reasonAdded: request.reasonAdded } : {}),
      });
    } catch (err) {
      if (err instanceof DocumentImportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  // Import PASTED Markdown (T068) — the paste path, no file read.
  ipcMain.handle(IPC_CHANNELS.sourcesImportMarkdownText, async (_event, rawRequest: unknown) => {
    const request = SourcesImportMarkdownTextRequestSchema.parse(rawRequest);
    try {
      return await dbService.importMarkdownText({
        text: request.text,
        ...(request.title !== undefined ? { title: request.title } : {}),
        ...(request.priority ? { priority: request.priority } : {}),
        ...(request.reasonAdded !== undefined ? { reasonAdded: request.reasonAdded } : {}),
      });
    } catch (err) {
      if (err instanceof DocumentImportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  // Import a Readwise/Kindle highlight export (T069) — the renderer resolved the chosen
  // path via `sources.pickImportFile({ kind: "highlights" })`. MAIN reads + parses +
  // groups the highlights into one inbox `source` per book/article, authoring `extract`s
  // (NEVER cards). A thrown `HighlightImportError` is re-thrown as a `code: message` line
  // so the modal can map the `code` to a friendly message (mirrors the EPUB/MD paths).
  ipcMain.handle(IPC_CHANNELS.sourcesImportHighlights, async (_event, rawRequest: unknown) => {
    const request = SourcesImportHighlightsRequestSchema.parse(rawRequest);
    try {
      return await dbService.importHighlights({
        absPath: request.path,
        ...(request.format ? { format: request.format } : {}),
        ...(request.priority ? { priority: request.priority } : {}),
      });
    } catch (err) {
      if (err instanceof HighlightImportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  // Import an Anki `.apkg` deck (T070) — the renderer resolved the chosen path via
  // `sources.pickImportFile({ kind: "anki" })`. MAIN unwraps the ZIP, opens the embedded
  // `collection.anki2` (`better-sqlite3`), and authors the notes as `card` elements
  // under a per-deck `source`, preserving review history when available. A thrown
  // `AnkiImportError` is re-thrown as a `code: message` line for the modal to map.
  ipcMain.handle(IPC_CHANNELS.cardsImportAnki, async (_event, rawRequest: unknown) => {
    const request = CardsImportAnkiRequestSchema.parse(rawRequest);
    try {
      return await dbService.importAnki({
        absPath: request.path,
        ...(request.priority ? { priority: request.priority } : {}),
      });
    } catch (err) {
      if (err instanceof AnkiImportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  // Export selected cards to an Anki `.apkg`/CSV in Downloads (T070) — read-only on
  // the DB, carrying source refs OUT to Anki. A thrown `AnkiExportError` (empty
  // selection) is re-thrown as a friendly `code: message` line.
  ipcMain.handle(IPC_CHANNELS.cardsExportAnki, async (_event, rawRequest: unknown) => {
    const request = CardsExportAnkiRequestSchema.parse(rawRequest);
    try {
      return await dbService.exportAnki(request);
    } catch (err) {
      if (err instanceof AnkiExportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  // PDF region extraction (T065). The renderer crops the figure/table from the page
  // it rendered and ships the size-capped PNG + the normalized rect + page; MAIN
  // streams the bytes into the vault and creates a `media_fragment` region extract
  // (its page+region source location + lineage + attention schedule) in one
  // transaction. The rect + PNG byteLength are validated/size-capped at the schema.
  ipcMain.handle(IPC_CHANNELS.sourcesExtractRegion, async (_event, rawRequest: unknown) => {
    const request = SourcesExtractRegionRequestSchema.parse(rawRequest);
    return await dbService.extractRegion(request);
  });

  // Serve a region extract's cropped image bytes to the renderer (T065). MAIN owns
  // the vault path; the renderer passes only the `media_fragment` element id.
  ipcMain.handle(IPC_CHANNELS.sourcesGetRegionImage, (_event, rawRequest: unknown) => {
    const request = SourcesGetRegionImageRequestSchema.parse(rawRequest);
    return dbService.getRegionImage(request);
  });

  // Clip a media span into a scheduled `media_fragment` (T074). The renderer ships
  // only the `{ startMs, endMs }` + the source id + the anchor block id + the
  // (optional) transcript segment; MAIN creates the fragment + its clip source
  // location in one transaction. NO re-encoding — the clip references the original.
  ipcMain.handle(IPC_CHANNELS.sourcesExtractClip, async (_event, rawRequest: unknown) => {
    const request = SourcesExtractClipRequestSchemaRefined.parse(rawRequest);
    return await dbService.extractClip(request);
  });

  // Run OCR on a scanned/text-free PDF page (T066). The renderer ships the rendered
  // page PNG (size-capped at the schema); MAIN writes it to the vault + enqueues an
  // `ocr` job on the T058 runner (DB-free `tesseract.js` worker, offline). The
  // renderer observes progress via the existing `jobs.subscribe` surface. The
  // recognized text is persisted as a reviewable suggestion — NOT merged into the
  // body until the user accepts it.
  ipcMain.handle(IPC_CHANNELS.sourcesRunOcr, async (_event, rawRequest: unknown) => {
    const request = SourcesRunOcrRequestSchema.parse(rawRequest);
    return await dbService.runOcr(request);
  });

  // Read a PDF source's OCR suggestion layer (T066) — per-page text + confidence +
  // status. Read-only.
  ipcMain.handle(IPC_CHANNELS.sourcesGetOcr, (_event, rawRequest: unknown) => {
    const request = SourcesGetOcrRequestSchema.parse(rawRequest);
    return dbService.getOcr(request);
  });

  // Accept a page's OCR text into the body (T066) — merges it via the document-save
  // path (logs `update_document`), making it searchable/extractable, and sets the
  // `ocr_pages` row `accepted`. Never auto-merged — this is the explicit user action.
  ipcMain.handle(IPC_CHANNELS.sourcesAcceptOcr, (_event, rawRequest: unknown) => {
    const request = SourcesAcceptOcrRequestSchema.parse(rawRequest);
    return dbService.acceptOcr(request);
  });

  // Dismiss a page's OCR suggestion (T066) — sets `dismissed`.
  ipcMain.handle(IPC_CHANNELS.sourcesDismissOcr, (_event, rawRequest: unknown) => {
    const request = SourcesAcceptOcrRequestSchema.parse(rawRequest);
    return dbService.dismissOcr(request);
  });

  // AI-assisted distillation (T093). `ai.run` enqueues an `ai` job on the T058 runner
  // (a local model OR the user's own-key call); the result is an inert DRAFT suggestion,
  // never a scheduled card. The enqueue needs the runner present (mirrors `runOcr`).
  ipcMain.handle(IPC_CHANNELS.aiRun, (_event, rawRequest: unknown) => {
    requireRunner();
    const request = AiRunRequestSchema.parse(rawRequest);
    return dbService.runAi(request);
  });
  // The draft suggestions for an element + each one's resolved grounding (T094). Read-only.
  ipcMain.handle(IPC_CHANNELS.aiList, (_event, rawRequest: unknown) => {
    const request = AiListRequestSchema.parse(rawRequest);
    return dbService.listAiSuggestions(request);
  });
  // Approve a card-shaped suggestion → mint a PARKED, un-due `card_draft` (drafts-only).
  ipcMain.handle(IPC_CHANNELS.aiApproveCard, (_event, rawRequest: unknown) => {
    const request = AiApproveRequestSchema.parse(rawRequest);
    return dbService.approveAiCard(request);
  });
  // Dismiss a draft suggestion (soft).
  ipcMain.handle(IPC_CHANNELS.aiDismiss, (_event, rawRequest: unknown) => {
    const request = AiDismissRequestSchema.parse(rawRequest);
    return dbService.dismissAiSuggestion(request);
  });
  // The AI disabled-state + disclosure data — NO key (only `keyConfigured`).
  ipcMain.handle(IPC_CHANNELS.aiStatus, () => {
    return dbService.aiStatus();
  });
  // Download / warm the local AI model — flips `aiModelDownloaded`.
  ipcMain.handle(IPC_CHANNELS.aiDownloadModel, () => {
    return dbService.downloadAiModel();
  });

  // Browser-capture pairing (T062). The TRUSTED desktop renderer reads the
  // per-install pairing token (to display it), regenerates it, and toggles the
  // loopback capture server. These route to the CaptureController (single source
  // of truth for the live server + the `capture.*` settings). The token is never
  // handed to a web page — only displayed in the desktop renderer. A handler
  // registered without the controller (contract-only tests) throws a clear error.
  function requireCaptureController(): CaptureController {
    if (!context?.captureController) {
      throw new Error("capture: handler registered without a capture controller");
    }
    return context.captureController;
  }

  // The background runner (T058) backs `sources.importUrl` (enqueue) +
  // `jobs.list`/`jobs.subscribe` (observe). A handler registered without it (a
  // contract-only test) throws a clear error, mirroring `requireCaptureController`.
  function requireRunner(): JobRunner {
    if (!context?.runner) {
      throw new Error("jobs: handler registered without a background runner");
    }
    return context.runner;
  }

  /**
   * Resolve the absolute path of the `.pdf` to import (T064). In a normal run this
   * opens the native open dialog filtered to PDFs and returns the chosen path (or
   * `null` if the user cancels). In an UNPACKAGED build (DEV/E2E) the env override
   * `INTERLEAVE_PDF_IMPORT_PATH` short-circuits the picker so the Electron E2E can
   * drive import deterministically — mirroring the `INTERLEAVE_ALLOW_LOOPBACK_IMPORT`
   * escape (never honored in a packaged app).
   */
  async function pickPdfPath(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
    const override = process.env.INTERLEAVE_PDF_IMPORT_PATH;
    if (!app.isPackaged && override && override.length > 0) return override;
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: "Import PDF",
          properties: ["openFile"],
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        })
      : await dialog.showOpenDialog({
          title: "Import PDF",
          properties: ["openFile"],
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  }

  /**
   * Resolve the chosen file path(s) for an import `kind` (T067) — the SHARED native
   * picker for all M14 file imports. In a normal run this opens the native open
   * dialog filtered to the kind's extensions; in an UNPACKAGED build (DEV/E2E) the
   * `INTERLEAVE_<KIND>_IMPORT_PATH` env override short-circuits the picker so the
   * Electron E2E can drive import deterministically — mirroring `pickPdfPath`.
   */
  async function pickImportFilePaths(
    event: Electron.IpcMainInvokeEvent,
    kind: "epub" | "markdown" | "html" | "highlights" | "anki" | "media" | "subtitles",
  ): Promise<string[]> {
    // Per-kind picker config (extensions + the E2E env escape). Only EPUB is wired in
    // T067; the other kinds land with T068–T070 (they reuse this same picker).
    const config: Record<
      typeof kind,
      { title: string; name: string; exts: string[]; env: string }
    > = {
      epub: {
        title: "Import EPUB",
        name: "EPUB",
        exts: ["epub"],
        env: "INTERLEAVE_EPUB_IMPORT_PATH",
      },
      markdown: {
        title: "Import Markdown",
        name: "Markdown",
        exts: ["md", "markdown"],
        env: "INTERLEAVE_MARKDOWN_IMPORT_PATH",
      },
      html: {
        title: "Import HTML",
        name: "HTML",
        exts: ["html", "htm"],
        env: "INTERLEAVE_HTML_IMPORT_PATH",
      },
      highlights: {
        title: "Import highlights",
        name: "Highlights",
        exts: ["csv", "json", "txt"],
        env: "INTERLEAVE_HIGHLIGHTS_IMPORT_PATH",
      },
      anki: {
        title: "Import Anki deck",
        name: "Anki",
        // Import accepts `.apkg` only; CSV is an EXPORT-only format here, so the picker
        // must not advertise it (the service rejects a non-.apkg with a typed error).
        exts: ["apkg"],
        env: "INTERLEAVE_ANKI_IMPORT_PATH",
      },
      media: {
        title: "Import media",
        name: "Video / Audio",
        // Keep in lockstep with MediaImportService VIDEO_EXTS/AUDIO_EXTS so the
        // picker advertises exactly the set the service accepts.
        exts: [
          "mp4",
          "webm",
          "mov",
          "mkv",
          "m4v",
          "ogv",
          "m4a",
          "mp3",
          "wav",
          "aac",
          "oga",
          "ogg",
          "flac",
          "opus",
        ],
        env: "INTERLEAVE_MEDIA_IMPORT_PATH",
      },
      subtitles: {
        title: "Choose a transcript",
        name: "Subtitles",
        exts: ["vtt", "srt"],
        env: "INTERLEAVE_SUBTITLES_PATH",
      },
    };
    const { title, name, exts, env } = config[kind];

    const override = process.env[env];
    if (!app.isPackaged && override && override.length > 0) return [override];

    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = {
      title,
      properties: ["openFile"],
      filters: [{ name, extensions: exts }],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled) return [];
    return result.filePaths;
  }

  /**
   * Restore-from-file picker. Opens a main-owned native open-file dialog filtered to
   * `.zip` and returns the chosen path(s) (`[]` on cancel). Mirrors
   * `pickImportFilePaths`: in an UNPACKAGED build (DEV/E2E) `INTERLEAVE_BACKUP_RESTORE_PATH`
   * overrides the dialog so Playwright can drive restore-from-file deterministically.
   * The chosen path is the ONLY backup `.zip` path that crosses to the renderer, and it
   * always originates here — never a renderer-supplied path.
   */
  async function pickBackupArchivePath(event: Electron.IpcMainInvokeEvent): Promise<string[]> {
    const override = process.env.INTERLEAVE_BACKUP_RESTORE_PATH;
    if (!app.isPackaged && override && override.length > 0) return [override];

    const win = BrowserWindow.fromWebContents(event.sender);
    const opts: Electron.OpenDialogOptions = {
      title: "Restore backup from file",
      properties: ["openFile"],
      filters: [{ name: "Backup", extensions: ["zip"] }],
    };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (result.canceled) return [];
    return result.filePaths;
  }

  ipcMain.handle(IPC_CHANNELS.captureGetPairing, () => {
    CaptureGetPairingRequestSchema.parse(undefined);
    return requireCaptureController().getPairing();
  });

  ipcMain.handle(IPC_CHANNELS.captureRegenerateToken, () => {
    CaptureRegenerateTokenRequestSchema.parse(undefined);
    const token = requireCaptureController().regenerateToken();
    return { token };
  });

  ipcMain.handle(IPC_CHANNELS.captureSetEnabled, async (_event, rawRequest: unknown) => {
    const request = CaptureSetEnabledRequestSchema.parse(rawRequest);
    const pairing = await requireCaptureController().setEnabled(request.enabled);
    return { enabled: pairing.enabled, running: pairing.running, port: pairing.port };
  });

  ipcMain.handle(IPC_CHANNELS.inboxList, () => {
    InboxListRequestSchema.parse(undefined);
    return dbService.listInbox();
  });

  ipcMain.handle(IPC_CHANNELS.inboxGet, (_event, rawRequest: unknown) => {
    const request = InboxGetRequestSchema.parse(rawRequest);
    return dbService.getInboxItem(request.id);
  });

  ipcMain.handle(IPC_CHANNELS.inboxTriage, (_event, rawRequest: unknown) => {
    const request = InboxTriageRequestSchema.parse(rawRequest);
    return dbService.triageInboxItem(request);
  });

  ipcMain.handle(IPC_CHANNELS.documentsGet, (_event, rawRequest: unknown) => {
    const request = DocumentsGetRequestSchema.parse(rawRequest);
    return dbService.getDocument(request);
  });

  ipcMain.handle(IPC_CHANNELS.documentsSave, (_event, rawRequest: unknown) => {
    const request = DocumentsSaveRequestSchema.parse(rawRequest);
    return dbService.saveDocument(request);
  });

  // Export an element's document body to a `.md` in Downloads (T068) — async file
  // I/O, read-only on the DB. A `DocumentImportError` is re-thrown as a
  // friendly `code: message` line.
  ipcMain.handle(IPC_CHANNELS.documentsExportMarkdown, async (_event, rawRequest: unknown) => {
    const request = DocumentsExportMarkdownRequestSchema.parse(rawRequest);
    try {
      return await dbService.exportMarkdown({ elementId: request.elementId as never });
    } catch (err) {
      if (err instanceof DocumentImportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  });

  ipcMain.handle(IPC_CHANNELS.documentsMarksAdd, (_event, rawRequest: unknown) => {
    const request = DocumentMarksAddRequestSchema.parse(rawRequest);
    return dbService.addDocumentMark(request);
  });

  ipcMain.handle(IPC_CHANNELS.documentsMarksRemove, (_event, rawRequest: unknown) => {
    const request = DocumentMarksRemoveRequestSchema.parse(rawRequest);
    return dbService.removeDocumentMark(request);
  });

  ipcMain.handle(IPC_CHANNELS.documentsMarksList, (_event, rawRequest: unknown) => {
    const request = DocumentMarksListRequestSchema.parse(rawRequest);
    return dbService.listDocumentMarks(request);
  });

  ipcMain.handle(IPC_CHANNELS.blockProcessingList, (_event, rawRequest: unknown) => {
    const request = BlockProcessingSourceRequestSchema.parse(rawRequest);
    return dbService.listBlockProcessing(request);
  });

  ipcMain.handle(IPC_CHANNELS.blockProcessingSummary, (_event, rawRequest: unknown) => {
    const request = BlockProcessingSourceRequestSchema.parse(rawRequest);
    return dbService.getBlockProcessingSummary(request);
  });

  ipcMain.handle(IPC_CHANNELS.blockProcessingMarkIgnored, (_event, rawRequest: unknown) => {
    const request = BlockProcessingMarkBlockRequestSchema.parse(rawRequest);
    return dbService.markBlockIgnored(request);
  });

  ipcMain.handle(IPC_CHANNELS.blockProcessingMarkProcessed, (_event, rawRequest: unknown) => {
    const request = BlockProcessingMarkBlockRequestSchema.parse(rawRequest);
    return dbService.markBlockProcessed(request);
  });

  ipcMain.handle(IPC_CHANNELS.blockProcessingMarkNeedsLater, (_event, rawRequest: unknown) => {
    const request = BlockProcessingMarkBlockRequestSchema.parse(rawRequest);
    return dbService.markBlockNeedsLater(request);
  });

  ipcMain.handle(IPC_CHANNELS.blockProcessingMarkUnread, (_event, rawRequest: unknown) => {
    const request = BlockProcessingMarkBlockRequestSchema.parse(rawRequest);
    return dbService.markBlockUnread(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractionsCreate, (_event, rawRequest: unknown) => {
    const request = ExtractionCreateRequestSchema.parse(rawRequest);
    return dbService.createExtraction(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsCreate, (_event, rawRequest: unknown) => {
    const request = CardsCreateRequestSchema.parse(rawRequest);
    return dbService.createCard(request);
  });

  // Generate N sibling `image_occlusion` cards (T071) from a `media_fragment` image
  // extract + its masks. The renderer ships only the element id + the vector masks
  // (the base image bytes already live in the vault); MAIN mints one card per mask
  // in one transaction. Masks are stored SEPARATELY from the base image.
  ipcMain.handle(IPC_CHANNELS.cardsGenerateOcclusion, (_event, rawRequest: unknown) => {
    const request = CardsGenerateOcclusionRequestSchema.parse(rawRequest);
    return dbService.generateOcclusionCards(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsUpdate, (_event, rawRequest: unknown) => {
    const request = CardsUpdateRequestSchema.parse(rawRequest);
    return dbService.updateCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsSetLifetime, (_event, rawRequest: unknown) => {
    const request = CardsSetLifetimeRequestSchema.parse(rawRequest);
    return dbService.setCardLifetime(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsSuspend, (_event, rawRequest: unknown) => {
    const request = CardsSuspendRequestSchema.parse(rawRequest);
    return dbService.suspendCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsDelete, (_event, rawRequest: unknown) => {
    const request = CardsDeleteRequestSchema.parse(rawRequest);
    return dbService.deleteCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsFlag, (_event, rawRequest: unknown) => {
    const request = CardsFlagRequestSchema.parse(rawRequest);
    return dbService.flagCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsMarkLeech, (_event, rawRequest: unknown) => {
    const request = CardsMarkLeechRequestSchema.parse(rawRequest);
    return dbService.markLeechCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsSplit, (_event, rawRequest: unknown) => {
    const request = CardsSplitRequestSchema.parse(rawRequest);
    return dbService.splitCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsAddContext, (_event, rawRequest: unknown) => {
    const request = CardsAddContextRequestSchema.parse(rawRequest);
    return dbService.addCardContext(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsBackToExtract, (_event, rawRequest: unknown) => {
    const request = CardsBackToExtractRequestSchema.parse(rawRequest);
    return dbService.backToExtractCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsRetire, (_event, rawRequest: unknown) => {
    const request = CardsRetireRequestSchema.parse(rawRequest);
    return dbService.retireCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsUnretire, (_event, rawRequest: unknown) => {
    const request = CardsUnretireRequestSchema.parse(rawRequest);
    return dbService.unretireCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsRetired, () => {
    return dbService.cardsRetired();
  });

  ipcMain.handle(IPC_CHANNELS.cardsSiblingAnswers, (_event, rawRequest: unknown) => {
    const request = CardsSiblingAnswersRequestSchema.parse(rawRequest);
    return dbService.cardsSiblingAnswers(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractsUpdateStage, (_event, rawRequest: unknown) => {
    const request = ExtractsUpdateStageRequestSchema.parse(rawRequest);
    return dbService.updateExtractStage(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractsRewrite, (_event, rawRequest: unknown) => {
    const request = ExtractsRewriteRequestSchema.parse(rawRequest);
    return dbService.rewriteExtract(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractsPostpone, (_event, rawRequest: unknown) => {
    const request = ExtractsPostponeRequestSchema.parse(rawRequest);
    return dbService.postponeExtract(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractsMarkDone, (_event, rawRequest: unknown) => {
    const request = ExtractsMarkDoneRequestSchema.parse(rawRequest);
    return dbService.markExtractDone(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractsSetFate, (_event, rawRequest: unknown) => {
    const request = ExtractsSetFateRequestSchema.parse(rawRequest);
    return dbService.setExtractFate(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractsReactivateFate, (_event, rawRequest: unknown) => {
    const request = ExtractsReactivateFateRequestSchema.parse(rawRequest);
    return dbService.reactivateExtractFate(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractsDelete, (_event, rawRequest: unknown) => {
    const request = ExtractsDeleteRequestSchema.parse(rawRequest);
    return dbService.deleteExtract(request);
  });

  ipcMain.handle(IPC_CHANNELS.reviewSessionNext, (_event, rawRequest: unknown) => {
    const request = ReviewSessionNextRequestSchema.parse(rawRequest ?? {});
    return dbService.reviewSessionNext(request);
  });

  ipcMain.handle(IPC_CHANNELS.reviewCard, (_event, rawRequest: unknown) => {
    const request = ReviewCardRequestSchema.parse(rawRequest);
    return dbService.reviewCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.reviewPreview, (_event, rawRequest: unknown) => {
    const request = ReviewPreviewRequestSchema.parse(rawRequest);
    return dbService.reviewPreview(request);
  });

  ipcMain.handle(IPC_CHANNELS.reviewGrade, (_event, rawRequest: unknown) => {
    const request = ReviewGradeRequestSchema.parse(rawRequest);
    return dbService.reviewGrade(request);
  });

  ipcMain.handle(IPC_CHANNELS.reviewLeeches, () => {
    ReviewLeechesRequestSchema.parse(undefined);
    return dbService.reviewLeeches();
  });

  // Targeted review modes (T096) — read-only subset selection, outside scheduling.
  ipcMain.handle(IPC_CHANNELS.reviewModeDeck, (_event, rawRequest: unknown) => {
    const request = ReviewModeDeckRequestSchema.parse(rawRequest);
    return dbService.reviewModeDeck(request);
  });

  ipcMain.handle(IPC_CHANNELS.reviewModeCount, (_event, rawRequest: unknown) => {
    const request = ReviewModeCountRequestSchema.parse(rawRequest);
    return dbService.reviewModeCount(request);
  });

  ipcMain.handle(IPC_CHANNELS.conceptsCreate, (_event, rawRequest: unknown) => {
    const request = ConceptsCreateRequestSchema.parse(rawRequest);
    return dbService.createConcept(request);
  });

  ipcMain.handle(IPC_CHANNELS.conceptsList, () => {
    ConceptsListRequestSchema.parse(undefined);
    return dbService.listConcepts();
  });

  ipcMain.handle(IPC_CHANNELS.conceptsAssign, (_event, rawRequest: unknown) => {
    const request = ConceptsAssignRequestSchema.parse(rawRequest);
    return dbService.assignConcept(request);
  });

  ipcMain.handle(IPC_CHANNELS.conceptsUnassign, (_event, rawRequest: unknown) => {
    const request = ConceptsUnassignRequestSchema.parse(rawRequest);
    return dbService.unassignConcept(request);
  });

  ipcMain.handle(IPC_CHANNELS.conceptsMembers, (_event, rawRequest: unknown) => {
    const request = ConceptsMembersRequestSchema.parse(rawRequest);
    return dbService.conceptMembers(request);
  });

  // Verification tasks (T092) — create / list / complete / postpone / generate.
  ipcMain.handle(IPC_CHANNELS.tasksCreate, (_event, rawRequest: unknown) => {
    const request = TasksCreateRequestSchema.parse(rawRequest);
    return dbService.createTask(request);
  });

  ipcMain.handle(IPC_CHANNELS.tasksList, (_event, rawRequest: unknown) => {
    const request = TasksListRequestSchema.parse(rawRequest);
    return dbService.listTasks(request);
  });

  ipcMain.handle(IPC_CHANNELS.tasksComplete, (_event, rawRequest: unknown) => {
    const request = TasksCompleteRequestSchema.parse(rawRequest);
    return dbService.completeTask(request);
  });

  ipcMain.handle(IPC_CHANNELS.tasksPostpone, (_event, rawRequest: unknown) => {
    const request = TasksPostponeRequestSchema.parse(rawRequest);
    return dbService.postponeTask(request);
  });

  ipcMain.handle(IPC_CHANNELS.tasksGenerateFromExpiry, (_event, rawRequest: unknown) => {
    const request = TasksGenerateFromExpiryRequestSchema.parse(rawRequest);
    return dbService.generateVerificationTasks(request);
  });

  // Incremental writing / synthesis notes (T095) — create / link / unlink / editBody /
  // scheduleReturn / get.
  ipcMain.handle(IPC_CHANNELS.synthesisCreate, (_event, rawRequest: unknown) => {
    const request = SynthesisCreateRequestSchema.parse(rawRequest);
    return dbService.createSynthesisNote(request);
  });

  ipcMain.handle(IPC_CHANNELS.synthesisLink, (_event, rawRequest: unknown) => {
    const request = SynthesisLinkRequestSchema.parse(rawRequest);
    return dbService.linkSynthesisElement(request);
  });

  ipcMain.handle(IPC_CHANNELS.synthesisUnlink, (_event, rawRequest: unknown) => {
    const request = SynthesisUnlinkRequestSchema.parse(rawRequest);
    return dbService.unlinkSynthesisElement(request);
  });

  ipcMain.handle(IPC_CHANNELS.synthesisEditBody, (_event, rawRequest: unknown) => {
    const request = SynthesisEditBodyRequestSchema.parse(rawRequest);
    return dbService.editSynthesisBody(request);
  });

  ipcMain.handle(IPC_CHANNELS.synthesisScheduleReturn, (_event, rawRequest: unknown) => {
    const request = SynthesisScheduleReturnRequestSchema.parse(rawRequest);
    return dbService.scheduleSynthesisReturn(request);
  });

  ipcMain.handle(IPC_CHANNELS.synthesisGet, (_event, rawRequest: unknown) => {
    const request = SynthesisGetRequestSchema.parse(rawRequest);
    return dbService.getSynthesisNote(request);
  });

  ipcMain.handle(IPC_CHANNELS.retentionGet, () => {
    RetentionGetRequestSchema.parse(undefined);
    return dbService.getRetention();
  });

  ipcMain.handle(IPC_CHANNELS.retentionSetBand, (_event, rawRequest: unknown) => {
    const request = RetentionSetBandRequestSchema.parse(rawRequest);
    return dbService.setRetentionBand(request);
  });

  ipcMain.handle(IPC_CHANNELS.retentionSetBandEnabled, (_event, rawRequest: unknown) => {
    const request = RetentionSetBandEnabledRequestSchema.parse(rawRequest);
    return dbService.setRetentionBandEnabled(request);
  });

  ipcMain.handle(IPC_CHANNELS.retentionSetConcept, (_event, rawRequest: unknown) => {
    const request = RetentionSetConceptRequestSchema.parse(rawRequest);
    return dbService.setRetentionConcept(request);
  });

  ipcMain.handle(IPC_CHANNELS.retentionSetCard, (_event, rawRequest: unknown) => {
    const request = RetentionSetCardRequestSchema.parse(rawRequest);
    return dbService.setRetentionCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.retentionResolveFor, (_event, rawRequest: unknown) => {
    const request = RetentionResolveForRequestSchema.parse(rawRequest);
    return dbService.resolveRetentionFor(request);
  });

  // optimization.*  (T080 — on-device FSRS parameter optimization)
  ipcMain.handle(IPC_CHANNELS.optimizationSuggest, (_event, rawRequest: unknown) => {
    const request = OptimizationSuggestRequestSchema.parse(rawRequest);
    return dbService.suggestOptimization(request);
  });

  ipcMain.handle(IPC_CHANNELS.optimizationApply, (_event, rawRequest: unknown) => {
    const request = OptimizationApplyRequestSchema.parse(rawRequest);
    return dbService.applyOptimization(request);
  });

  // workload.*  (T081 — workload simulation; read-only preview, mutates nothing)
  ipcMain.handle(IPC_CHANNELS.workloadSimulate, (_event, rawRequest: unknown) => {
    const request = WorkloadSimulateRequestSchema.parse(rawRequest);
    return dbService.simulateWorkload(request);
  });

  ipcMain.handle(IPC_CHANNELS.tagsList, () => {
    TagsListRequestSchema.parse(undefined);
    return dbService.listAllTags();
  });

  ipcMain.handle(IPC_CHANNELS.tagsAdd, (_event, rawRequest: unknown) => {
    const request = TagsAddRequestSchema.parse(rawRequest);
    return dbService.addTag(request);
  });

  ipcMain.handle(IPC_CHANNELS.tagsRemove, (_event, rawRequest: unknown) => {
    const request = TagsRemoveRequestSchema.parse(rawRequest);
    return dbService.removeTag(request);
  });

  ipcMain.handle(IPC_CHANNELS.searchQuery, (_event, rawRequest: unknown) => {
    const request = SearchQueryRequestSchema.parse(rawRequest);
    return dbService.search(request);
  });

  // Semantic search (T087) — fused FTS + sqlite-vec. Async (the query embed rides
  // the runner with a short timeout); degrades to FTS-only when off/absent.
  ipcMain.handle(IPC_CHANNELS.semanticSearch, (_event, rawRequest: unknown) => {
    const request = SemanticSearchRequestSchema.parse(rawRequest);
    return dbService.semanticSearch(request);
  });
  ipcMain.handle(IPC_CHANNELS.semanticStatus, () => {
    return dbService.semanticStatus();
  });
  ipcMain.handle(IPC_CHANNELS.semanticReindex, (_event, rawRequest: unknown) => {
    const request = SemanticReindexRequestSchema.parse(rawRequest ?? {});
    return dbService.semanticReindex(request);
  });
  ipcMain.handle(IPC_CHANNELS.semanticDownloadModel, (_event, rawRequest: unknown) => {
    SemanticDownloadModelRequestSchema.parse(rawRequest ?? {});
    return dbService.semanticDownloadModel();
  });
  // Related-item suggestions (T088) — derived similar/duplicate/prereq/sibling reads.
  ipcMain.handle(IPC_CHANNELS.semanticRelated, (_event, rawRequest: unknown) => {
    const request = SemanticRelatedRequestSchema.parse(rawRequest);
    return dbService.semanticRelated(request);
  });
  // Contradiction detection (T089) — derived, heuristic, suggestive possible-conflict flags.
  ipcMain.handle(IPC_CHANNELS.semanticContradictions, (_event, rawRequest: unknown) => {
    const request = SemanticContradictionsRequestSchema.parse(rawRequest);
    return dbService.semanticContradictions(request);
  });

  ipcMain.handle(IPC_CHANNELS.libraryBrowse, (_event, rawRequest: unknown) => {
    const request = LibraryBrowseRequestSchema.parse(rawRequest ?? {});
    return dbService.libraryBrowse(request);
  });

  ipcMain.handle(IPC_CHANNELS.libraryParkedAction, (_event, rawRequest: unknown) => {
    const request = LibraryParkedActionRequestSchema.parse(rawRequest);
    return dbService.libraryParkedAction(request);
  });

  ipcMain.handle(IPC_CHANNELS.readPointGet, (_event, rawRequest: unknown) => {
    const request = ReadPointGetRequestSchema.parse(rawRequest);
    return dbService.getReadPoint(request);
  });

  ipcMain.handle(IPC_CHANNELS.readPointSet, (_event, rawRequest: unknown) => {
    const request = ReadPointSetRequestSchema.parse(rawRequest);
    return dbService.setReadPoint(request);
  });

  ipcMain.handle(IPC_CHANNELS.trashList, () => {
    TrashListRequestSchema.parse(undefined);
    return dbService.listTrash();
  });

  ipcMain.handle(IPC_CHANNELS.trashRestore, (_event, rawRequest: unknown) => {
    const request = TrashRestoreRequestSchema.parse(rawRequest);
    return dbService.restoreFromTrash(request);
  });

  ipcMain.handle(IPC_CHANNELS.trashPurge, (_event, rawRequest: unknown) => {
    const request = TrashPurgeRequestSchema.parse(rawRequest);
    return dbService.purgeFromTrash(request);
  });

  ipcMain.handle(IPC_CHANNELS.trashEmpty, () => {
    TrashEmptyRequestSchema.parse(undefined);
    return dbService.emptyTrash();
  });

  ipcMain.handle(IPC_CHANNELS.undoLast, () => {
    UndoLastRequestSchema.parse(undefined);
    return dbService.undoLastOperation();
  });

  ipcMain.handle(IPC_CHANNELS.analyticsGet, (_event, rawRequest: unknown) => {
    const request = AnalyticsGetRequestSchema.parse(rawRequest);
    return dbService.getAnalytics(request);
  });

  ipcMain.handle(IPC_CHANNELS.analyticsReviewActivity, (_event, rawRequest: unknown) => {
    const request = AnalyticsReviewActivityRequestSchema.parse(rawRequest);
    return dbService.getReviewActivity(request);
  });

  ipcMain.handle(IPC_CHANNELS.analyticsPriorityIntegrity, (_event, rawRequest: unknown) => {
    const request = PriorityIntegrityGetRequestSchema.parse(rawRequest);
    return dbService.getPriorityIntegrity(request);
  });

  ipcMain.handle(IPC_CHANNELS.balanceGet, (_event, rawRequest: unknown) => {
    const request = BalanceGetRequestSchema.parse(rawRequest);
    return dbService.getBalance(request);
  });

  ipcMain.handle(IPC_CHANNELS.dailyWorkSummary, (_event, rawRequest: unknown) => {
    const request = DailyWorkSummaryRequestSchema.parse(rawRequest);
    return dbService.getDailyWorkSummary(request);
  });

  ipcMain.handle(IPC_CHANNELS.sourceYieldList, (_event, rawRequest: unknown) => {
    const request = SourceYieldListRequestSchema.parse(rawRequest);
    return dbService.listSourceYield(request);
  });

  ipcMain.handle(IPC_CHANNELS.extractStagnationList, (_event, rawRequest: unknown) => {
    const request = ExtractStagnationListRequestSchema.parse(rawRequest);
    return dbService.listStagnantExtracts(request);
  });

  /**
   * Build a {@link BackupRestoreService} with the standard main-side dep wiring.
   * All four backup-restore handlers (list, restore, restoreFile, resetLocalData)
   * share identical deps; `withReplaceHooks` adds the writer-quiescing hook the
   * store-replacing handlers need (and that `list` does not). Throws clearly if
   * the filesystem context was never wired, so handlers don't repeat the guard.
   */
  function makeBackupRestoreService(withReplaceHooks: boolean): BackupRestoreService {
    if (!context) {
      throw new Error("backups: handler registered without filesystem context");
    }
    return new BackupRestoreService({
      dbService,
      paths: context.paths,
      migrationsDir: context.migrationsDir,
      nativeBinding: context.nativeBinding,
      ...(withReplaceHooks
        ? {
            beforeReplaceLocalData: async () => {
              await context?.runner?.stopAndDrain();
              await context?.captureController?.stop();
            },
          }
        : {}),
    });
  }

  ipcMain.handle(IPC_CHANNELS.backupsCreate, async (_event, rawRequest: unknown) => {
    // No payload is allowed; validate the actual renderer argument so unexpected
    // paths/options are rejected before any filesystem work starts.
    BackupsCreateRequestSchema.parse(rawRequest);
    if (!context) {
      throw new Error("backups.create: handler registered without filesystem context");
    }
    // The backup runs entirely main-side: it snapshots `app.sqlite`, copies the
    // asset vault, writes the hashed manifest, and zips. The renderer gets only
    // artifact metadata, never the absolute filesystem path.
    const backupService = new BackupService({
      dbService,
      paths: context.paths,
      migrationsDir: context.migrationsDir,
      appVersion: app.getVersion(),
    });
    const result = await backupService.createBackup();
    return {
      timestamp: result.timestamp,
      archiveName: `${result.timestamp}.zip`,
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount,
      schemaVersion: result.schemaVersion,
    };
  });

  ipcMain.handle(IPC_CHANNELS.backupsOpenFolder, async (_event, rawRequest: unknown) => {
    BackupsOpenFolderRequestSchema.parse(rawRequest);
    if (!context) {
      throw new Error("backups.openFolder: handler registered without filesystem context");
    }
    const openError = await shell.openPath(context.paths.backupsDir);
    if (openError) {
      throw new Error("backups.openFolder: failed to open backups folder");
    }
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS.backupsList, (_event, rawRequest: unknown) => {
    BackupsListRequestSchema.parse(rawRequest);
    if (!context) {
      throw new Error("backups.list: handler registered without filesystem context");
    }
    const restoreService = makeBackupRestoreService(false);
    return { backups: restoreService.listBackups() };
  });

  ipcMain.handle(IPC_CHANNELS.backupsRestore, async (_event, rawRequest: unknown) => {
    const request = BackupsRestoreRequestSchema.parse(rawRequest);
    if (!context) {
      throw new Error("backups.restore: handler registered without filesystem context");
    }
    const restoreService = makeBackupRestoreService(true);
    const result = await restoreService.restoreBackup(request.timestamp);
    return {
      status: "restored" as const,
      timestamp: result.timestamp,
      restoredAt: new Date().toISOString(),
      reloadRequired: true as const,
    };
  });

  // Open the main-owned native open-file dialog and return ONLY the chosen `.zip`
  // path (or `{ cancelled: true }`). The renderer hands this path straight back to
  // `backups.restoreFile`; it is never a generic file-read surface.
  ipcMain.handle(IPC_CHANNELS.backupsPickArchive, async (event) => {
    const paths = await pickBackupArchivePath(event);
    if (paths.length === 0) return { cancelled: true as const };
    return { path: paths[0] as string };
  });

  ipcMain.handle(IPC_CHANNELS.backupsRestoreFile, async (_event, rawRequest: unknown) => {
    const request = BackupsRestoreFileRequestSchema.parse(rawRequest);
    if (!context) {
      throw new Error("backups.restoreFile: handler registered without filesystem context");
    }
    const restoreService = makeBackupRestoreService(true);
    const result = await restoreService.restoreBackupFromArchive(request.path);
    return {
      status: "restored" as const,
      timestamp: result.timestamp,
      restoredAt: new Date().toISOString(),
      reloadRequired: true as const,
    };
  });

  ipcMain.handle(IPC_CHANNELS.backupsResetLocalData, async (_event, rawRequest: unknown) => {
    BackupsResetLocalDataRequestSchema.parse(rawRequest);
    if (!context) {
      throw new Error("backups.resetLocalData: handler registered without filesystem context");
    }
    const restoreService = makeBackupRestoreService(true);
    await restoreService.resetLocalData();
    return {
      status: "reset" as const,
      resetAt: new Date().toISOString(),
      reloadRequired: true as const,
    };
  });

  // Asset-vault maintenance (T059) — all behind the typed surface. The renderer
  // never resolves a raw path or reads/writes bytes; it gets only the typed report
  // /counts. `verify` re-hashes stored bytes (streamed), `findOrphans` lists vault
  // files no live `assets` row references, and `collectOrphans` removes ONLY
  // confirmed orphan files (guarded by `confirm: true`). A handler that runs without
  // an `assetsDir` (a contract-only test) throws clearly from the DbService accessor.
  ipcMain.handle(IPC_CHANNELS.vaultVerify, async (_event, rawRequest: unknown) => {
    VaultVerifyRequestSchema.parse(rawRequest);
    return dbService.verifyVault();
  });

  ipcMain.handle(IPC_CHANNELS.vaultFindOrphans, async (_event, rawRequest: unknown) => {
    VaultFindOrphansRequestSchema.parse(rawRequest);
    return dbService.findVaultOrphans();
  });

  ipcMain.handle(IPC_CHANNELS.vaultCollectOrphans, async (_event, rawRequest: unknown) => {
    const request = VaultCollectOrphansRequestSchema.parse(rawRequest);
    return dbService.collectVaultOrphans(request);
  });

  // Large-collection maintenance (T099) — all behind the typed surface, Zod-validated.
  // The REPORTS are read-only (no `operation_log`); the ACTIONS are transactional,
  // op-logged, soft-delete / undoable, with the only hard deletes being the existing
  // `trash:purge` + `vault:collectOrphans`. No `db.query`, no raw path crosses IPC.
  ipcMain.handle(IPC_CHANNELS.maintenanceReport, async (_event, rawRequest: unknown) => {
    MaintenanceReportRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceReport();
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceDuplicates, (_event, rawRequest: unknown) => {
    MaintenanceDuplicatesRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceDuplicates();
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceCardsWithoutSources, (_event, rawRequest: unknown) => {
    MaintenanceCardsWithoutSourcesRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceCardsWithoutSources();
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceBrokenSources, async (_event, rawRequest: unknown) => {
    MaintenanceBrokenSourcesRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceBrokenSources();
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceSchedulerConsistency, (_event, rawRequest: unknown) => {
    const request = MaintenanceSchedulerConsistencyRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceSchedulerConsistency(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceLowValue, (_event, rawRequest: unknown) => {
    const request = MaintenanceLowValueRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceLowValue(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceIntegrity, async (_event, rawRequest: unknown) => {
    const request = MaintenanceIntegrityRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceIntegrity(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceDedupe, (_event, rawRequest: unknown) => {
    const request = MaintenanceDedupeRequestSchema.parse(rawRequest);
    return dbService.maintenanceDedupe(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceOrphanMedia, async (_event, rawRequest: unknown) => {
    const request = MaintenanceOrphanMediaRequestSchema.parse(rawRequest);
    return dbService.maintenanceOrphanMedia(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceBulkTrash, (_event, rawRequest: unknown) => {
    const request = MaintenanceBulkTrashRequestSchema.parse(rawRequest);
    return dbService.maintenanceBulkTrash(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceBulkArchive, (_event, rawRequest: unknown) => {
    const request = MaintenanceBulkArchiveRequestSchema.parse(rawRequest);
    return dbService.maintenanceBulkArchive(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceBulkPostpone, (_event, rawRequest: unknown) => {
    const request = MaintenanceBulkPostponeRequestSchema.parse(rawRequest);
    return dbService.maintenanceBulkPostpone(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceParkedResurfacing, (_event, rawRequest: unknown) => {
    const request = MaintenanceParkedResurfacingRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceParkedResurfacing(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceParkedResurfacingApply, (_event, rawRequest: unknown) => {
    const request = MaintenanceParkedResurfacingApplyRequestSchema.parse(rawRequest);
    return dbService.maintenanceParkedResurfacingApply(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceChronicPostpones, (_event, rawRequest: unknown) => {
    const request = MaintenanceChronicPostponesRequestSchema.parse(rawRequest);
    return dbService.getMaintenanceChronicPostpones(request);
  });

  ipcMain.handle(IPC_CHANNELS.maintenanceChronicPostponesApply, (_event, rawRequest: unknown) => {
    const request = MaintenanceChronicPostponesApplyRequestSchema.parse(rawRequest);
    return dbService.maintenanceChronicPostponesApply(request);
  });

  // Jobs OBSERVE surface (T058) — read-only. `jobs.list` reads the current queue
  // (e.g. for an Analytics/Maintenance "background activity" view); `jobs.subscribe`
  // (the renderer) receives a `JobSummary` on every `job:update`. T058 deliberately
  // does NOT expose a generic `jobs.enqueue` to the renderer — the only renderer-
  // reachable enqueue path is `sources.importUrl` (above). The runner is optional
  // for contract-only tests, so the handler throws clearly when absent.
  ipcMain.handle(IPC_CHANNELS.jobsList, (_event, rawRequest: unknown) => {
    const request = JobsListRequestSchema.parse(rawRequest ?? {});
    const jobs = requireRunner()
      .list({
        ...(request.status ? { status: request.status } : {}),
        ...(request.type ? { type: request.type } : {}),
        ...(request.limit != null ? { limit: request.limit } : {}),
      })
      .map(toJobSummary);
    return { jobs } satisfies JobsListResult;
  });

  // Broadcast every runner `job:update` to all open windows as a `JobSummary` over
  // the one-way `jobs:updated` send channel (the preload forwards it to
  // `jobs.subscribe` callbacks). Capture the unsubscribe fn so the disposer tears
  // it down — the `removeHandler` loop below only removes `invoke` handlers, not
  // this emitter listener; re-registering handlers (a DbService-reopen test) would
  // otherwise leak listeners / double-send.
  const unsubscribeRunner =
    context?.runner?.observe((job) => {
      const summary = toJobSummary(job);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.jobsUpdated, summary);
      }
    }) ?? null;

  return () => {
    unsubscribeRunner?.();
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
