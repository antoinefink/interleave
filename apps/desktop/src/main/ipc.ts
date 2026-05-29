/**
 * IPC router (T007) — wires the validated request handlers for the narrow
 * `window.appApi` surface to the main-process services.
 *
 * Every handler validates its payload with the Zod schema from the shared
 * contract **before** touching the DB service: the renderer is untrusted, so
 * malformed payloads are rejected at the boundary. There is no generic
 * `db.query(sql)` handler — only the four explicit commands below exist.
 */

import { app, ipcMain } from "electron";
import {
  DbStatusRequestSchema,
  DocumentMarksAddRequestSchema,
  DocumentMarksListRequestSchema,
  DocumentMarksRemoveRequestSchema,
  DocumentsGetRequestSchema,
  DocumentsSaveRequestSchema,
  HealthRequestSchema,
  type HealthResult,
  InboxGetRequestSchema,
  InboxListRequestSchema,
  InboxTriageRequestSchema,
  InspectorGetRequestSchema,
  InspectorListRequestSchema,
  IPC_CHANNELS,
  ReadPointGetRequestSchema,
  ReadPointSetRequestSchema,
  SettingsGetAllRequestSchema,
  SettingsGetRequestSchema,
  SettingsUpdateManyRequestSchema,
  SettingsUpdateRequestSchema,
  SourcesImportManualRequestSchema,
} from "../shared/contract";
import type { DbService } from "./db-service";

/**
 * Register all IPC handlers. Call once after the DB service is open. Returns a
 * disposer that removes the handlers (used on shutdown / in tests).
 */
export function registerIpcHandlers(dbService: DbService): () => void {
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

  ipcMain.handle(IPC_CHANNELS.sourcesImportManual, (_event, rawRequest: unknown) => {
    const request = SourcesImportManualRequestSchema.parse(rawRequest);
    return dbService.importManualSource(request);
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

  ipcMain.handle(IPC_CHANNELS.readPointGet, (_event, rawRequest: unknown) => {
    const request = ReadPointGetRequestSchema.parse(rawRequest);
    return dbService.getReadPoint(request);
  });

  ipcMain.handle(IPC_CHANNELS.readPointSet, (_event, rawRequest: unknown) => {
    const request = ReadPointSetRequestSchema.parse(rawRequest);
    return dbService.setReadPoint(request);
  });

  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
