/**
 * IPC channel names (T007) — the lightweight, dependency-free half of the
 * contract.
 *
 * Kept separate from `contract.ts` (which pulls in Zod for main-side payload
 * validation) so the **preload** bundle can import just these string constants
 * without dragging Zod into the sandboxed preload. Renaming a channel is a
 * breaking change.
 */

export const IPC_CHANNELS = {
  appHealth: "app:health",
  dbGetStatus: "db:getStatus",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsGetAll: "settings:getAll",
  settingsUpdateMany: "settings:updateMany",
  inspectorList: "inspector:list",
  inspectorGet: "inspector:get",
  elementsSetPriority: "elements:setPriority",
  queueList: "queue:list",
  queueAct: "queue:act",
  queueSchedule: "queue:schedule",
  queueUndo: "queue:undo",
  queueAutoPostpone: "queue:autoPostpone",
  queueAutoPostponeApply: "queue:autoPostpone:apply",
  queueCatchUp: "queue:catchUp",
  queueCatchUpApply: "queue:catchUp:apply",
  queueVacation: "queue:vacation",
  queueVacationApply: "queue:vacation:apply",
  lineageGet: "lineage:get",
  sourcesImportManual: "sources:importManual",
  sourcesImportUrl: "sources:importUrl",
  sourcesImportPdf: "sources:importPdf",
  sourcesGetPdfData: "sources:getPdfData",
  sourcesPickImportFile: "sources:pickImportFile",
  sourcesImportEpub: "sources:importEpub",
  sourcesImportMedia: "sources:importMedia",
  sourcesGetMediaData: "sources:getMediaData",
  sourcesImportDocument: "sources:importDocument",
  sourcesImportMarkdownText: "sources:importMarkdownText",
  sourcesImportHighlights: "sources:importHighlights",
  sourcesExtractRegion: "sources:extractRegion",
  sourcesGetRegionImage: "sources:getRegionImage",
  sourcesExtractClip: "sources:extractClip",
  sourcesRunOcr: "sources:runOcr",
  sourcesGetOcr: "sources:getOcr",
  sourcesAcceptOcr: "sources:acceptOcr",
  sourcesDismissOcr: "sources:dismissOcr",
  captureGetPairing: "capture:getPairing",
  captureRegenerateToken: "capture:regenerateToken",
  captureSetEnabled: "capture:setEnabled",
  inboxList: "inbox:list",
  inboxGet: "inbox:get",
  inboxTriage: "inbox:triage",
  documentsGet: "documents:get",
  documentsSave: "documents:save",
  documentsExportMarkdown: "documents:exportMarkdown",
  documentsMarksAdd: "documents:marks:add",
  documentsMarksRemove: "documents:marks:remove",
  documentsMarksList: "documents:marks:list",
  extractionsCreate: "extractions:create",
  cardsCreate: "cards:create",
  cardsGenerateOcclusion: "cards:generateOcclusion",
  cardsUpdate: "cards:update",
  cardsSuspend: "cards:suspend",
  cardsDelete: "cards:delete",
  cardsFlag: "cards:flag",
  cardsMarkLeech: "cards:markLeech",
  cardsImportAnki: "cards:importAnki",
  cardsExportAnki: "cards:exportAnki",
  extractsUpdateStage: "extracts:updateStage",
  extractsRewrite: "extracts:rewrite",
  extractsPostpone: "extracts:postpone",
  extractsMarkDone: "extracts:markDone",
  extractsDelete: "extracts:delete",
  reviewSessionNext: "review:session:next",
  reviewCard: "review:card",
  reviewPreview: "review:preview",
  reviewGrade: "review:grade",
  reviewLeeches: "review:leeches",
  conceptsCreate: "concepts:create",
  conceptsList: "concepts:list",
  conceptsAssign: "concepts:assign",
  conceptsUnassign: "concepts:unassign",
  conceptsMembers: "concepts:members",
  // Desired retention by priority band / concept / card (T079).
  retentionGet: "retention:get",
  retentionSetBand: "retention:setBand",
  retentionSetBandEnabled: "retention:setBandEnabled",
  retentionSetConcept: "retention:setConcept",
  retentionSetCard: "retention:setCard",
  retentionResolveFor: "retention:resolveFor",
  // On-device FSRS parameter optimization (T080). `optimization:suggest` is
  // read-only (estimate + workload preview); `optimization:apply` is the only
  // persisting command (writes the queryable preset store).
  optimizationSuggest: "optimization:suggest",
  optimizationApply: "optimization:apply",
  // Workload simulation (T081) — a single READ-ONLY command that previews how daily
  // load shifts from altering desired retention / adding cards / postponing low-priority
  // material BEFORE committing. It mutates nothing (no due date, no setting, no op).
  workloadSimulate: "workload:simulate",
  tagsList: "tags:list",
  tagsAdd: "tags:add",
  tagsRemove: "tags:remove",
  searchQuery: "search:query",
  libraryBrowse: "library:browse",
  readPointGet: "readPoint:get",
  readPointSet: "readPoint:set",
  trashList: "trash:list",
  trashRestore: "trash:restore",
  trashPurge: "trash:purge",
  trashEmpty: "trash:empty",
  undoLast: "undo:last",
  analyticsGet: "analytics:get",
  balanceGet: "balance:get",
  backupsCreate: "backups:create",
  // Background-runner observe surface (T058). `jobs:list` reads the current queue.
  // The renderer enqueues ONLY via `sources:importUrl` — there is intentionally NO
  // `jobs:enqueue` channel (a generic renderer enqueue is deferred to M14/M18).
  jobsList: "jobs:list",
  // One-way main → renderer event (T058): the runner broadcasts a `JobSummary` on
  // every `job:update`; the preload forwards it to `jobs.subscribe` callbacks.
  // SEND channel (no `ipcMain.handle`); the preload exposes a narrow receive-only
  // subscription, never a generic listener.
  jobsUpdated: "jobs:updated",
  // Asset-vault maintenance (T059) — all behind the typed surface, no raw paths.
  // `vault:verify` re-hashes stored bytes; `vault:findOrphans` lists unreferenced
  // vault files; `vault:collectOrphans` removes confirmed orphan files (guarded by
  // `confirm: true`). The vault is the canonical local store — there is NO S3.
  vaultVerify: "vault:verify",
  vaultFindOrphans: "vault:findOrphans",
  vaultCollectOrphans: "vault:collectOrphans",
  // One-way main → renderer event (T048): the native Help → "Keyboard shortcuts"
  // menu item asks the renderer to open the in-app cheat sheet. This is a SEND
  // channel (main → renderer), not an `invoke` handler — the preload exposes a
  // narrow receive-only subscription, never a generic listener.
  menuShowShortcuts: "menu:showShortcuts",
  // One-way main → renderer event (T050): the native File → "Back up…" menu item
  // asks the renderer to run a backup (through the SAME `appApi.createBackup()` the
  // ⌘B shortcut + ⌘K command use). SEND channel; the preload exposes a narrow
  // receive-only subscription, never a generic listener.
  menuCreateBackup: "menu:createBackup",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
