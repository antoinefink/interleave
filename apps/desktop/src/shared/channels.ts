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
  // Lineage-aware deletion (T135). `elements:countDescendants` is the read-only
  // blast-radius inventory that decides quiet-delete vs. the intent menu;
  // `elements:softDeleteSubtree` soft-deletes a node and OPTIONALLY its live
  // subtree under one shared `batchId` (preimage-aware, recoverable);
  // `trash:restoreBatch` restores that whole batch root-first. No new op type — all
  // three ride the existing `soft_delete_element` machinery behind local-db.
  elementsCountDescendants: "elements:countDescendants",
  elementsSoftDeleteSubtree: "elements:softDeleteSubtree",
  topicsFallow: "topics:fallow",
  topicsUnfallow: "topics:unfallow",
  queueList: "queue:list",
  queueAct: "queue:act",
  queueSchedule: "queue:schedule",
  queueUndo: "queue:undo",
  queueSessionPlan: "queue:sessionPlan",
  queueAutoPostpone: "queue:autoPostpone",
  queueAutoPostponeApply: "queue:autoPostpone:apply",
  queueCatchUp: "queue:catchUp",
  queueCatchUpApply: "queue:catchUp:apply",
  queueVacation: "queue:vacation",
  queueVacationApply: "queue:vacation:apply",
  lineageGet: "lineage:get",
  sourcesImportManual: "sources:importManual",
  /** T091: edit a source's reliability metadata (type/tier/confidence/notes). */
  sourcesUpdateReliability: "sources:updateReliability",
  sourcesDismissRetirementSuggestion: "sources:dismissRetirementSuggestion",
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
  aiRun: "ai:run",
  aiList: "ai:list",
  aiApproveCard: "ai:approveCard",
  aiDismiss: "ai:dismiss",
  aiStatus: "ai:status",
  aiDownloadModel: "ai:downloadModel",
  conversionSessionPreview: "conversion:sessionPreview",
  conversionPrefetchDrafts: "conversion:prefetchDrafts",
  conversionCreateCard: "conversion:createCard",
  conversionSetFate: "conversion:setFate",
  captureGetPairing: "capture:getPairing",
  captureRegenerateToken: "capture:regenerateToken",
  captureSetEnabled: "capture:setEnabled",
  // One-way main → renderer event: the paired browser extension asked the app to
  // open a captured source in the reader. The payload is only the source id; the
  // renderer does ordinary TanStack navigation to `/source/$id`.
  sourcesOpenReader: "sources:openReader",
  inboxList: "inbox:list",
  inboxGet: "inbox:get",
  inboxTriage: "inbox:triage",
  // Bulk inbox triage (T126) — `inbox:bulkTriage` applies ONE triage verb (optionally
  // + ONE priority band) to N selected inbox ids as ONE transactional, op-logged batch
  // under one shared `batchId`; `inbox:bulkTriageUndo` reverses that whole batch by its
  // `batchId` through the op-type-agnostic movement guard. No new op type, no new status
  // — bulk reuses the four existing per-item triage writes behind local-db.
  inboxBulkTriage: "inbox:bulkTriage",
  inboxBulkTriageUndo: "inbox:bulkTriageUndo",
  documentsGet: "documents:get",
  documentsSave: "documents:save",
  documentsExportMarkdown: "documents:exportMarkdown",
  documentsMarksAdd: "documents:marks:add",
  documentsMarksRemove: "documents:marks:remove",
  documentsMarksList: "documents:marks:list",
  blockProcessingList: "blockProcessing:list",
  blockProcessingSummary: "blockProcessing:summary",
  blockProcessingMarkIgnored: "blockProcessing:markIgnored",
  blockProcessingMarkProcessed: "blockProcessing:markProcessed",
  blockProcessingMarkNeedsLater: "blockProcessing:markNeedsLater",
  blockProcessingMarkUnread: "blockProcessing:markUnread",
  extractionsCreate: "extractions:create",
  cardsCreate: "cards:create",
  cardsGenerateOcclusion: "cards:generateOcclusion",
  cardsUpdate: "cards:update",
  // Card-edit write barrier undo (T125). `cards:reStabilizeUndo` reverses a substantive
  // edit's re-stabilization ("Keep schedule instead") — restores the exact prior FSRS
  // schedule from the marker preimage under a current-state guard. Receipt-scoped.
  cardsReStabilizeUndo: "cards:reStabilizeUndo",
  // Claim-lifetime (T090). `cards:setLifetime` writes the six expiry fields
  // (fact_stability/valid_from/valid_until/jurisdiction/software_version/review_by) in
  // one transaction (`update_element`); "expired" stays a DERIVED attribute, no status
  // change, no new op type. Rides the existing `cards.*` group (no new top-level group).
  cardsSetLifetime: "cards:setLifetime",
  cardsSuspend: "cards:suspend",
  cardsDelete: "cards:delete",
  cardsFlag: "cards:flag",
  cardsMarkLeech: "cards:markLeech",
  // Leech remediation compositions (T085). `cards:split` divides a multi-fact failing
  // card into atomic sibling cards; `cards:addContext` appends a clarifying note (op-
  // log marker, no new column); `cards:backToExtract` reactivates the card's parent
  // extract on the ATTENTION scheduler (due-now). Each is one transaction + the correct
  // EXISTING op; lower-priority/open-source/suspend/delete reuse existing channels.
  cardsSplit: "cards:split",
  cardsAddContext: "cards:addContext",
  cardsBackToExtract: "cards:backToExtract",
  // Mature-card retirement (T082). `cards:retire`/`cards:unretire` flip the durable
  // `cards.is_retired` flag (reversible, non-destructive); `cards:retired` reads the
  // live retired-card inventory. A retired card is skipped by the due/review reads.
  cardsRetire: "cards:retire",
  cardsUnretire: "cards:unretire",
  cardsRetired: "cards:retired",
  // T086: the read-only sibling-answer candidate set the card builder feeds to the pure
  // `detectInterference` similar-answer heuristic (fetched once per extract, not per keystroke).
  cardsSiblingAnswers: "cards:siblingAnswers",
  cardsImportAnki: "cards:importAnki",
  cardsExportAnki: "cards:exportAnki",
  extractsUpdateStage: "extracts:updateStage",
  extractsRewrite: "extracts:rewrite",
  extractsPostpone: "extracts:postpone",
  extractsMarkDone: "extracts:markDone",
  extractsSetFate: "extracts:setFate",
  extractsReactivateFate: "extracts:reactivateFate",
  extractsDelete: "extracts:delete",
  reviewSessionNext: "review:session:next",
  reviewCard: "review:card",
  reviewPreview: "review:preview",
  reviewGrade: "review:grade",
  reviewLeeches: "review:leeches",
  // Targeted review modes (T096) — resolve a chosen card SUBSET outside scheduling.
  reviewModeDeck: "review:mode:deck",
  reviewModeCount: "review:mode:count",
  conceptsCreate: "concepts:create",
  conceptsList: "concepts:list",
  conceptsAssign: "concepts:assign",
  conceptsUnassign: "concepts:unassign",
  conceptsMembers: "concepts:members",
  // Verification tasks (T092) — scheduled `task`-type elements that protect
  // time-sensitive knowledge. Created by hand or generated from T090 expiry;
  // attention-scheduled (never FSRS); each mutation is one transaction + the correct
  // existing op (create_element / add_relation / reschedule_element).
  tasksCreate: "tasks:create",
  tasksList: "tasks:list",
  tasksComplete: "tasks:complete",
  tasksPostpone: "tasks:postpone",
  tasksGenerateFromExpiry: "tasks:generateFromExpiry",
  // Incremental writing / synthesis notes (T095) — the EXISTING `synthesis_note`
  // element type made creatable + linkable + editable + schedulable. Collects
  // extracts/cards via `references` (`add_relation`/`remove_relation`); returns on
  // the ATTENTION scheduler (`reschedule_element`, never FSRS). Each mutation is one
  // transaction + the correct existing op (no new op types, no new element type).
  synthesisCreate: "synthesis:create",
  synthesisLink: "synthesis:link",
  synthesisUnlink: "synthesis:unlink",
  synthesisEditBody: "synthesis:editBody",
  synthesisScheduleReturn: "synthesis:scheduleReturn",
  synthesisGet: "synthesis:get",
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
  // Semantic search (T087) — fused FTS + sqlite-vec, status, reindex.
  semanticSearch: "semantic:search",
  semanticStatus: "semantic:status",
  semanticReindex: "semantic:reindex",
  semanticRetryFailed: "semantic:retryFailed",
  semanticDownloadModel: "semantic:downloadModel",
  // Related-item suggestions (T088) — DERIVED similar/duplicate/prereq/sibling reads.
  semanticRelated: "semantic:related",
  // Contradiction detection (T089) — DERIVED, HEURISTIC, SUGGESTIVE possible-conflict flags.
  semanticContradictions: "semantic:contradictions",
  libraryBrowse: "library:browse",
  libraryParkedAction: "library:parkedAction",
  readPointGet: "readPoint:get",
  readPointSet: "readPoint:set",
  trashList: "trash:list",
  trashRestore: "trash:restore",
  // Batch restore (T135) — restore an entire branch-delete `batchId` as one unit,
  // root-first, schedule re-established from the recorded preimages. The snackbar
  // Undo + the Trash group "Restore" both call this (order-independent, not
  // global undo).
  trashRestoreBatch: "trash:restoreBatch",
  // Ancestor-chain restore (T135) — restore only the DELETED-ancestor chain of one
  // element up to the first live ancestor (the inspector "ancestor deleted" hint and a
  // per-tombstone Restore), so sibling/cousin tombstones are never resurrected.
  trashRestoreAncestorChain: "trash:restoreAncestorChain",
  trashPurge: "trash:purge",
  trashEmpty: "trash:empty",
  undoLast: "undo:last",
  analyticsGet: "analytics:get",
  analyticsReviewActivity: "analytics:reviewActivity",
  analyticsPriorityIntegrity: "analytics:priorityIntegrity",
  analyticsTopicKnowledgeState: "analytics:topicKnowledgeState",
  balanceGet: "balance:get",
  dailyWorkSummary: "dailyWork:summary",
  dailyWorkAckGraduationEvents: "dailyWork:ackGraduationEvents",
  dailyWorkUndoAutoPostponeReceipt: "dailyWork:autoPostponeReceipt:undo",
  extractAgingPreview: "extractAging:preview",
  extractAgingApply: "extractAging:apply",
  extractAgingUndoReceipt: "extractAging:receipt:undo",
  // Re-verify drain (T124) — the human-in-the-loop resolution of content-stale
  // (`needs_reverify`) outputs. `flaggedSources`/`sessionPreview`/`receiptsToday` are
  // READ-ONLY (zero `operation_log`); `resolve`/`receipt:undo` are strict mutations.
  reverifyFlaggedSources: "reverify:flaggedSources",
  reverifySessionPreview: "reverify:sessionPreview",
  reverifyResolve: "reverify:resolve",
  reverifyUndoReceipt: "reverify:receipt:undo",
  reverifyReceiptsToday: "reverify:receipts:today",
  weeklyReviewSummary: "weeklyReview:summary",
  weeklyReviewUpdateProgress: "weeklyReview:updateProgress",
  weeklyReviewComplete: "weeklyReview:complete",
  weeklyReviewDismiss: "weeklyReview:dismiss",
  // Per-source yield analytics (T083) — a READ-ONLY ranked rollup (read %,
  // extracts/cards/mature-cards, leeches, review time) so low-yield sources are
  // identifiable. No mutation, no `operation_log`, no schedule change.
  sourceYieldList: "sourceYield:list",
  // Extract-stagnation analytics (T084) — a READ-ONLY scan that detects extracts
  // which keep returning without progressing (stage never advanced, no children,
  // postponed repeatedly) and surfaces them with rewrite/convert/postpone/delete
  // suggestions. No mutation, no `operation_log`, no schedule change — the
  // remediations reuse the existing `extracts:*` commands.
  extractStagnationList: "extractStagnation:list",
  backupsCreate: "backups:create",
  backupsOpenFolder: "backups:openFolder",
  backupsList: "backups:list",
  backupsRestore: "backups:restore",
  // Restore from an arbitrary backup `.zip` on disk. `backups:pickArchive` opens a
  // main-owned native open-file dialog (filtered to `.zip`) and returns ONLY the
  // chosen path (or cancelled); `backups:restoreFile` extracts + verifies + installs
  // that archive through the SAME pipeline as `backups:restore`. The path crossing to
  // the renderer originates from the main-owned picker — never a generic file read.
  backupsPickArchive: "backups:pickArchive",
  backupsRestoreFile: "backups:restoreFile",
  backupsResetLocalData: "backups:resetLocalData",
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
  // Large-collection maintenance (T099) — the janitor's report + cleanup surface.
  // The REPORTS are read-only domain queries (no `operation_log`); the ACTIONS are
  // transactional, op-logged, soft-delete / undoable — the ONLY hard deletes stay the
  // existing `trash:purge` + `vault:collectOrphans`. `maintenance:report` is the hub
  // rollup (counts + integrity-not-run flag); `maintenance:integrity` is the on-demand
  // deep DB+vault check. No `db.query`, no raw filesystem path crosses IPC (orphan
  // media takes the canonical relative paths `vault:findOrphans` returned).
  maintenanceReport: "maintenance:report",
  maintenanceDuplicates: "maintenance:duplicates",
  maintenanceCardsWithoutSources: "maintenance:cardsWithoutSources",
  maintenanceBrokenSources: "maintenance:brokenSources",
  maintenanceSchedulerConsistency: "maintenance:schedulerConsistency",
  maintenanceIntegrity: "maintenance:integrity",
  maintenanceLowValue: "maintenance:lowValue",
  maintenanceDedupe: "maintenance:dedupe",
  maintenanceOrphanMedia: "maintenance:orphanMedia",
  maintenanceBulkTrash: "maintenance:bulkTrash",
  maintenanceBulkArchive: "maintenance:bulkArchive",
  maintenanceBulkPostpone: "maintenance:bulkPostpone",
  maintenanceParkedResurfacing: "maintenance:parkedResurfacing",
  maintenanceParkedResurfacingApply: "maintenance:parkedResurfacing:apply",
  maintenanceChronicPostpones: "maintenance:chronicPostpones",
  maintenanceChronicPostponesApply: "maintenance:chronicPostpones:apply",
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
