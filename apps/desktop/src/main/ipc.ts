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
import { app, BrowserWindow, ipcMain } from "electron";
import {
  AnalyticsGetRequestSchema,
  BackupsCreateRequestSchema,
  BalanceGetRequestSchema,
  CaptureGetPairingRequestSchema,
  CaptureRegenerateTokenRequestSchema,
  CaptureSetEnabledRequestSchema,
  CardsCreateRequestSchema,
  CardsDeleteRequestSchema,
  CardsFlagRequestSchema,
  CardsMarkLeechRequestSchema,
  CardsSuspendRequestSchema,
  CardsUpdateRequestSchema,
  ConceptsAssignRequestSchema,
  ConceptsCreateRequestSchema,
  ConceptsListRequestSchema,
  ConceptsMembersRequestSchema,
  ConceptsUnassignRequestSchema,
  DbStatusRequestSchema,
  DocumentMarksAddRequestSchema,
  DocumentMarksListRequestSchema,
  DocumentMarksRemoveRequestSchema,
  DocumentsGetRequestSchema,
  DocumentsSaveRequestSchema,
  ElementsSetPriorityRequestSchema,
  ExtractionCreateRequestSchema,
  ExtractsDeleteRequestSchema,
  ExtractsMarkDoneRequestSchema,
  ExtractsPostponeRequestSchema,
  ExtractsRewriteRequestSchema,
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
  LineageGetRequestSchema,
  QueueActRequestSchema,
  QueueListRequestSchema,
  QueueScheduleRequestSchema,
  QueueUndoRequestSchema,
  ReadPointGetRequestSchema,
  ReadPointSetRequestSchema,
  ReviewCardRequestSchema,
  ReviewGradeRequestSchema,
  ReviewLeechesRequestSchema,
  ReviewPreviewRequestSchema,
  ReviewSessionNextRequestSchema,
  SearchQueryRequestSchema,
  SettingsGetAllRequestSchema,
  SettingsGetRequestSchema,
  SettingsUpdateManyRequestSchema,
  SettingsUpdateRequestSchema,
  SourcesImportManualRequestSchema,
  SourcesImportUrlRequestSchema,
  type SourcesImportUrlResult,
  TagsAddRequestSchema,
  TagsListRequestSchema,
  TagsRemoveRequestSchema,
  TrashEmptyRequestSchema,
  TrashListRequestSchema,
  TrashPurgeRequestSchema,
  TrashRestoreRequestSchema,
  UndoLastRequestSchema,
} from "../shared/contract";
import { BackupService } from "./backup-service";
import type { CaptureController } from "./capture-controller";
import type { DbService } from "./db-service";
import type { UrlImportJobPayload } from "./job-apply-handlers";
import type { JobRunner } from "./job-runner";
import type { AppPaths } from "./paths";
import { UrlImportError } from "./url-import-service";

/** Extra main-process context the backup handler (T047) needs (absolute paths). */
export interface IpcHandlerContext {
  /** The resolved app-data paths (`dbPath`/`assetsDir`/`backupsDir`). */
  readonly paths: AppPaths;
  /** The Drizzle migrations folder (its journal maps idx → schema-version tag). */
  readonly migrationsDir: string;
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

  ipcMain.handle(IPC_CHANNELS.lineageGet, (_event, rawRequest: unknown) => {
    const request = LineageGetRequestSchema.parse(rawRequest);
    return dbService.getLineage(request.id);
  });

  ipcMain.handle(IPC_CHANNELS.sourcesImportManual, (_event, rawRequest: unknown) => {
    const request = SourcesImportManualRequestSchema.parse(rawRequest);
    return dbService.importManualSource(request);
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

  ipcMain.handle(IPC_CHANNELS.extractionsCreate, (_event, rawRequest: unknown) => {
    const request = ExtractionCreateRequestSchema.parse(rawRequest);
    return dbService.createExtraction(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsCreate, (_event, rawRequest: unknown) => {
    const request = CardsCreateRequestSchema.parse(rawRequest);
    return dbService.createCard(request);
  });

  ipcMain.handle(IPC_CHANNELS.cardsUpdate, (_event, rawRequest: unknown) => {
    const request = CardsUpdateRequestSchema.parse(rawRequest);
    return dbService.updateCard(request);
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

  ipcMain.handle(IPC_CHANNELS.libraryBrowse, (_event, rawRequest: unknown) => {
    const request = LibraryBrowseRequestSchema.parse(rawRequest ?? {});
    return dbService.libraryBrowse(request);
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

  ipcMain.handle(IPC_CHANNELS.balanceGet, (_event, rawRequest: unknown) => {
    const request = BalanceGetRequestSchema.parse(rawRequest);
    return dbService.getBalance(request);
  });

  ipcMain.handle(IPC_CHANNELS.backupsCreate, async () => {
    // No payload to validate (void); keep the schema call for symmetry.
    BackupsCreateRequestSchema.parse(undefined);
    if (!context) {
      throw new Error("backups.create: handler registered without filesystem context");
    }
    // The backup runs entirely main-side: it snapshots `app.sqlite`, copies the
    // asset vault, writes the hashed manifest, and zips — the renderer only gets
    // the final path string back (no raw filesystem access crosses IPC).
    const backupService = new BackupService({
      dbService,
      paths: context.paths,
      migrationsDir: context.migrationsDir,
      appVersion: app.getVersion(),
    });
    const result = await backupService.createBackup();
    return {
      path: result.path,
      timestamp: result.timestamp,
      sizeBytes: result.sizeBytes,
      fileCount: result.fileCount,
      schemaVersion: result.schemaVersion,
    };
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
