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
  AppApi,
  DocumentsGetRequest,
  DocumentsSaveRequest,
  InboxGetRequest,
  InboxTriageRequest,
  InspectorGetRequest,
  ReadPointGetRequest,
  ReadPointSetRequest,
  SettingsGetRequest,
  SettingsUpdateManyRequest,
  SettingsUpdateRequest,
  SourcesImportManualRequest,
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
  sources: {
    importManual: (request: SourcesImportManualRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sourcesImportManual, request),
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
  },
  readPoints: {
    get: (request: ReadPointGetRequest) => ipcRenderer.invoke(IPC_CHANNELS.readPointGet, request),
    set: (request: ReadPointSetRequest) => ipcRenderer.invoke(IPC_CHANNELS.readPointSet, request),
  },
};

contextBridge.exposeInMainWorld("appApi", appApi);
