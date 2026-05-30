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
  readPointGet: "readPoint:get",
  readPointSet: "readPoint:set",
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
