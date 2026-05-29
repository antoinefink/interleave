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
  HealthRequestSchema,
  type HealthResult,
  InspectorGetRequestSchema,
  InspectorListRequestSchema,
  IPC_CHANNELS,
  SettingsGetRequestSchema,
  SettingsUpdateRequestSchema,
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

  ipcMain.handle(IPC_CHANNELS.inspectorList, () => {
    InspectorListRequestSchema.parse(undefined);
    return dbService.listInspectableElements();
  });

  ipcMain.handle(IPC_CHANNELS.inspectorGet, (_event, rawRequest: unknown) => {
    const request = InspectorGetRequestSchema.parse(rawRequest);
    return dbService.getInspectorData(request.id);
  });

  return () => {
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
