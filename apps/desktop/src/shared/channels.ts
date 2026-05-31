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
  lineageGet: "lineage:get",
  sourcesImportManual: "sources:importManual",
  inboxList: "inbox:list",
  inboxGet: "inbox:get",
  inboxTriage: "inbox:triage",
  documentsGet: "documents:get",
  documentsSave: "documents:save",
  documentsMarksAdd: "documents:marks:add",
  documentsMarksRemove: "documents:marks:remove",
  documentsMarksList: "documents:marks:list",
  extractionsCreate: "extractions:create",
  cardsCreate: "cards:create",
  cardsUpdate: "cards:update",
  cardsSuspend: "cards:suspend",
  cardsDelete: "cards:delete",
  cardsFlag: "cards:flag",
  cardsMarkLeech: "cards:markLeech",
  extractsUpdateStage: "extracts:updateStage",
  extractsRewrite: "extracts:rewrite",
  extractsPostpone: "extracts:postpone",
  extractsMarkDone: "extracts:markDone",
  extractsDelete: "extracts:delete",
  reviewSessionNext: "review:session:next",
  reviewPreview: "review:preview",
  reviewGrade: "review:grade",
  reviewLeeches: "review:leeches",
  conceptsCreate: "concepts:create",
  conceptsList: "concepts:list",
  conceptsAssign: "concepts:assign",
  conceptsUnassign: "concepts:unassign",
  conceptsMembers: "concepts:members",
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
