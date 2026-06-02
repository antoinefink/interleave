/**
 * Renderer-side typed client wrapper for the Electron `window.appApi` bridge
 * (T007).
 *
 * This is the renderer's only door to trusted local capabilities. It mirrors the
 * narrow surface the preload exposes (the authoritative contract lives in
 * `apps/desktop/src/shared/contract.ts`); the renderer is a pure UI consumer, so
 * it declares its own minimal types here rather than depending on the desktop
 * app package. The renderer NEVER touches SQLite, Node, or the filesystem — it
 * only awaits these IPC-backed promises.
 *
 * When the renderer runs outside Electron (the T002 Vite-only smoke E2E, plain
 * `vite dev` in a browser), `window.appApi` is undefined; `isDesktop()` lets the
 * UI degrade gracefully instead of throwing.
 */

/** Liveness/readiness of the desktop shell + local DB. */
export interface HealthResult {
  readonly status: "ok";
  readonly appVersion: string;
  readonly dbOpen: boolean;
  readonly migrated: boolean;
  readonly time: string;
}

/** Local SQLite open/migrated state + effective pragmas. */
export interface DbStatus {
  readonly open: boolean;
  readonly migrated: boolean;
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly busyTimeoutMs: number;
  readonly appliedMigrations: number;
}

export type SettingValue =
  | string
  | number
  | boolean
  | null
  | SettingValue[]
  | { [k: string]: SettingValue };

export interface SettingsGetRequest {
  readonly key?: string;
}

export interface SettingsGetResult {
  readonly settings: Readonly<Record<string, SettingValue>>;
}

export interface SettingsUpdateRequest {
  readonly key: string;
  readonly value: unknown;
}

export interface SettingsUpdateResult {
  readonly key: string;
  readonly value: SettingValue;
}

// ---------------------------------------------------------------------------
// settings.getAll() / settings.updateMany()  (T011 — typed AppSettings)
// ---------------------------------------------------------------------------

/** Keyboard layouts affecting default shortcut bindings. */
export type KeyboardLayout = "qwerty" | "dvorak" | "vim";

/** UI theme preference (mirrors the `data-theme` attribute). */
export type ThemePreference = "light" | "dark";

/**
 * The complete, validated user/domain settings the scheduler + UI read. Mirrors
 * `@interleave/core`'s `AppSettings` (the authoritative model). Priority is
 * numeric `0.0`–`1.0`; the UI derives the A/B/C/D label.
 */
export interface AppSettings {
  readonly dailyReviewBudget: number;
  readonly defaultDesiredRetention: number;
  readonly defaultTopicIntervalDays: number;
  readonly defaultSourcePriority: number;
  /** When `true` (default), sibling cards aren't shown back-to-back in review (T039). */
  readonly burySiblings: boolean;
  /** How long soft-deleted items remain recoverable in the Trash (informational, T044). */
  readonly trashRetentionDays: number;
  /** When `true` (default), show the import/process balance banner (T046). */
  readonly balanceWarnings: boolean;
  /** How lopsided imports-vs-processing must be before the balance warning fires (T046). */
  readonly importBalanceFactor: number;
  readonly keyboardLayout: KeyboardLayout;
  readonly theme: ThemePreference;
  /**
   * The local vault owner's display name shown in the shell's user chip (and the
   * source of the avatar initials). Empty by default — the UI degrades to the
   * neutral "Local vault" identity; the user sets it in `/settings`. There is no
   * server account; this is purely the on-device identity label.
   */
  readonly displayName: string;
  /**
   * Per-priority-band FSRS desired-retention targets (T079) — a partial A/B/C/D map.
   * A MISSING band inherits {@link defaultDesiredRetention}. Engaged only when
   * {@link retentionByBandEnabled}.
   */
  readonly retentionByBand: Partial<Record<"A" | "B" | "C" | "D", number>>;
  /**
   * Master switch for per-priority/per-concept retention (T079). When `false`, only a
   * per-card override + the global default apply (a clean revert to T036).
   */
  readonly retentionByBandEnabled: boolean;
  /**
   * The optimized GLOBAL FSRS parameter preset (T080) — a 21-number FSRS-6 `w`
   * vector, or `null` = inherit ts-fsrs `default_w`. Written only by the optimization
   * apply flow; read by the per-card scheduler factory. The renderer never edits this
   * directly — it applies a suggestion via `optimization.apply`.
   */
  readonly fsrsParamsGlobal: number[] | null;
}

export interface SettingsGetAllResult {
  readonly settings: AppSettings;
}

export interface SettingsUpdateManyRequest {
  readonly patch: Partial<AppSettings>;
}

export interface SettingsUpdateManyResult {
  readonly settings: AppSettings;
}

// ---------------------------------------------------------------------------
// inspector.list() / inspector.get()  (T010 — read-only)
// ---------------------------------------------------------------------------

/** A lightweight element summary used by the inspector's selection picker. */
export interface ElementSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly dueAt: string | null;
}

/** Which scheduler an element is on — the load-bearing FSRS vs attention split. */
export type SchedulerKind = "fsrs" | "attention";

export interface SchedulerSignals {
  readonly kind: SchedulerKind;
  readonly retrievability: number | null;
  readonly stability: number | null;
  readonly difficulty: number | null;
  readonly reps: number | null;
  readonly lapses: number | null;
  readonly fsrsState: string | null;
  readonly stage: string;
  readonly postponed: number;
  readonly lastProcessedAt: string | null;
}

export interface LineageItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly stage: string;
}

export interface ReviewSummary {
  readonly dueAt: string | null;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly fsrsState: string;
  readonly lastReviewedAt: string | null;
  readonly logCount: number;
}

/**
 * The originating source reference (T043 — the refblock). Mirrors
 * `@interleave/core`'s `SourceRef`; the renderer's `RefBlock` renders it via the
 * shared `formatSourceRef` so review / extract view / inspector / library agree on
 * how a reference reads. Every field is nullable (manual imports may omit
 * provenance; a source-less element degrades to a calm placeholder).
 */
export interface SourceRef {
  readonly sourceElementId: string | null;
  readonly sourceTitle: string | null;
  readonly url: string | null;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly locationLabel: string | null;
  readonly snippet: string | null;
}

export interface SourceProvenance {
  readonly elementId: string;
  readonly url: string | null;
  /** Normalized URL derived from `url` (tracking params/fragment stripped). */
  readonly canonicalUrl: string | null;
  /** The as-entered URL preserved verbatim for provenance. */
  readonly originalUrl: string | null;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly accessedAt: string | null;
  readonly reasonAdded: string | null;
}

export interface LocationSummary {
  readonly label: string | null;
  readonly selectedText: string;
  readonly page: number | null;
  /** The PDF region bbox (T065) for a `media_fragment` region extract, else `null`. */
  readonly region: RegionRectInput | null;
  /** The media clip window (T074) for a `media_fragment` clip extract, else `null`. */
  readonly clip: ClipWindowSummary | null;
  /** The media clip start in ms (T074) — mirrors `clip.startMs`; else `null`. */
  readonly timestampMs: number | null;
  /** The source element this location points INTO — the reader to open on jump (T022). */
  readonly sourceElementId: string;
  /** Ordered STABLE block ids the selection spans (the scroll target is the first). */
  readonly blockIds: readonly string[];
  /** Char offset within the FIRST spanned block (caret target), or `null`. */
  readonly startOffset: number | null;
  /** Char offset within the LAST spanned block, or `null`. */
  readonly endOffset: number | null;
}

/** A concept summary embedded in the inspector payload (T041). */
export interface ConceptInspectorSummary {
  readonly id: string;
  readonly name: string;
}

export interface InspectorData {
  readonly element: ElementSummary;
  readonly scheduler: SchedulerSignals;
  readonly parent: LineageItem | null;
  readonly children: readonly LineageItem[];
  readonly source: LineageItem | null;
  readonly provenance: SourceProvenance | null;
  readonly location: LocationSummary | null;
  /** The originating source reference (T043 — the refblock), resolved from lineage. */
  readonly sourceRef: SourceRef | null;
  readonly tags: readonly string[];
  /** Concepts this element is a member of (T041 — `concept_membership` edges). */
  readonly concepts: readonly ConceptInspectorSummary[];
  readonly review: ReviewSummary | null;
}

export interface InspectorListResult {
  readonly elements: readonly ElementSummary[];
}

export interface InspectorGetRequest {
  readonly id: string;
}

export interface InspectorGetResult {
  readonly data: InspectorData | null;
}

// ---------------------------------------------------------------------------
// elements.setPriority()  (T027 — the universal priority write path)
// ---------------------------------------------------------------------------

/** The four coarse priority labels the UI exposes (numeric mapping lives in core). */
export type PriorityLabel = "A" | "B" | "C" | "D";

/**
 * One priority-change intent (discriminated by `kind`): set an explicit A/B/C/D
 * label, or step the band up/down. The renderer never does priority math — the
 * main process computes the new numeric value via the core band helpers.
 */
export type ElementsSetPriorityAction =
  | { readonly kind: "set"; readonly priority: PriorityLabel }
  | { readonly kind: "raise" }
  | { readonly kind: "lower" };

export interface ElementsSetPriorityRequest {
  readonly id: string;
  readonly action: ElementsSetPriorityAction;
}

export interface ElementsSetPriorityResult {
  /**
   * The updated element summary with the NEW numeric `priority` + derived A/B/C/D
   * `priorityLabel`, or `null` when the id is unknown / soft-deleted.
   */
  readonly element: (ElementSummary & { readonly priorityLabel: PriorityLabel }) | null;
}

// ---------------------------------------------------------------------------
// queue.list()  (T029 — the unified, sorted, filtered due queue)
// ---------------------------------------------------------------------------

/** Which scheduler a queue row is on — the FSRS vs attention split. */
export type QueueScheduler = "fsrs" | "attention";

/** The scheduler signals a queue row carries for its `SchedulerChip`. */
export interface QueueSchedulerSignals {
  readonly kind: QueueScheduler;
  /** Card recall probability now (`0.0`–`1.0`), or `null` for new/attention rows. */
  readonly retrievability: number | null;
  /** FSRS memory stability in days, or `null` for attention rows. */
  readonly stability: number | null;
  /** Current FSRS phase, or `null` for attention rows (the T077 fragile↔mature signal). */
  readonly fsrsState: string | null;
  /** Cumulative FSRS lapses, or `null` for attention rows (the T077 leech exclusion signal). */
  readonly lapses: number | null;
  /** Distillation stage (shown on the attention chip). */
  readonly stage: string;
  /** How many times an attention element has been postponed. */
  readonly postponed: number;
}

/** How "due" a row is relative to `asOf`. */
export type QueueDueState = "overdue" | "today" | "soon";

/** A flat queue row (due card or due attention item). */
export interface QueueItemSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  /** The governing due time (FSRS `review_states.due_at` or attention `elements.due_at`). */
  readonly dueAt: string | null;
  readonly scheduler: QueueScheduler;
  readonly schedulerSignals: QueueSchedulerSignals;
  readonly sourceTitle: string | null;
  readonly author: string | null;
  /** A concept this row is a member of (T041 populates this; null until then). */
  readonly concept: string | null;
  /** The sibling-group id (cards only), or `null` — the T076 de-clumping key. */
  readonly siblingGroupId: string | null;
  /** The owning source's id, or `null` — the T076 same-source de-clumping key. */
  readonly sourceId: string | null;
  /** Card kind (`qa`/`cloze`); null for non-cards. */
  readonly cardType: string | null;
  /** True for A-priority items (the `--protected` accent bar). */
  readonly protected: boolean;
  readonly due: QueueDueState;
  readonly dueLabel: string;
}

/** Per-type counts over the unfiltered due set + the at-risk counts. */
export interface QueueCounts {
  readonly all: number;
  readonly card: number;
  readonly source: number;
  readonly extract: number;
  readonly topic: number;
  readonly task: number;
  readonly highPriority: number;
  readonly overdue: number;
  readonly protected: number;
}

/** The active session mode (T076) — a soft type up-weight on the auto-sort. */
export type QueueSessionMode = "full" | "review" | "read";

/** Filters the queue read accepts (type/concept/tag/status) + the session mode. */
export interface QueueListRequest {
  /** "Now" the due reads compare against (ISO-8601); defaults to the server clock. */
  readonly asOf?: string;
  readonly types?: readonly string[];
  /** Concept filter, by concept NAME (T041). */
  readonly concept?: string;
  /** Tag filter, by tag name (T041). */
  readonly tag?: string;
  readonly statuses?: readonly string[];
  /**
   * The session mode (T076) — `review` floats cards, `read` floats reading items,
   * `full` (default) is neutral. A SOFT ordering bias, not a filter: both types stay
   * in the list; the mode only re-orders them.
   */
  readonly mode?: QueueSessionMode;
}

export interface QueueListResult {
  readonly items: readonly QueueItemSummary[];
  readonly counts: QueueCounts;
  readonly budget: { readonly used: number; readonly target: number };
}

// ---------------------------------------------------------------------------
// queue.autoPostpone() / queue.autoPostponeApply()  (T077 — the overload valve)
// ---------------------------------------------------------------------------

/** The auto-postpone request — an optional clock for the due reads + plan. */
export interface QueueAutoPostponeRequest {
  readonly asOf?: string;
}

/** Why a victim was chosen (for the preview). */
export type AutoPostponeReason = "low-priority-topic" | "low-priority-mature-card";

/** One auto-postpone preview row — what moves, from→to, and why. */
export interface AutoPostponePreviewRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly priority: number;
  readonly scheduler: QueueScheduler;
  readonly fromDueAt: string | null;
  readonly toDueAt: string;
  readonly reason: AutoPostponeReason;
}

/** The read-only auto-postpone preview shown BEFORE committing. */
export interface AutoPostponePreview {
  readonly overBudget: number;
  readonly target: number;
  readonly used: number;
  readonly willPostpone: readonly AutoPostponePreviewRow[];
  readonly remainingAfter: number;
}

/** The result of applying the auto-postpone sweep. */
export interface AutoPostponeApplyResult {
  readonly postponed: number;
  readonly batchId: string;
}

// ---------------------------------------------------------------------------
// queue.catchUp() / queue.vacation()  (T078 — catch-up & vacation modes)
// ---------------------------------------------------------------------------

/** The catch-up request — an optional clock + how many days to spread the backlog over. */
export interface QueueCatchUpRequest {
  readonly asOf?: string;
  readonly spreadDays?: number;
}

/** The vacation request — the away window + an optional clock (`awayEnd` ≥ `awayStart`). */
export interface QueueVacationRequest {
  readonly awayStart: string;
  readonly awayEnd: string;
  readonly asOf?: string;
}

/** One day of the before/after load curve — a calendar day + how many items are due that day. */
export interface RecoveryLoadCurvePoint {
  readonly date: string;
  readonly count: number;
}

/** One item that NEWLY SLIPS — its old vs new due + by how many days (the explicit cost). */
export interface RecoverySlipRow {
  readonly id: string;
  readonly title: string;
  readonly fromDueAt: string | null;
  readonly toDueAt: string;
  readonly slipDays: number;
}

/** The shared COST preview both modes return (the headline "cost of postponement"). */
export interface RecoveryCostPreview {
  readonly moved: number;
  readonly newTailDueAt: string | null;
  readonly daysAdded: number;
  readonly loadBefore: readonly RecoveryLoadCurvePoint[];
  readonly loadAfter: readonly RecoveryLoadCurvePoint[];
  readonly slips: readonly RecoverySlipRow[];
}

/** The read-only catch-up preview shown BEFORE committing. */
export interface CatchUpPreview {
  readonly budget: number;
  readonly spreadDays: number;
  readonly cost: RecoveryCostPreview;
}

/** The read-only vacation preview shown BEFORE committing. */
export interface VacationPreview {
  readonly awayStart: string;
  readonly awayEnd: string;
  readonly suspendedCount: number;
  readonly shiftedCount: number;
  readonly cost: RecoveryCostPreview;
}

/** The result of applying a recovery plan (catch-up or vacation). */
export interface RecoveryApplyResult {
  readonly moved: number;
  readonly suspended: number;
  readonly batchId: string;
}

// ---------------------------------------------------------------------------
// queue.act()  (T030 — per-row, in-place queue actions)
// ---------------------------------------------------------------------------

/**
 * One in-place queue action (discriminated by `kind`). Open is renderer-only
 * navigation and is NOT sent over IPC. Postpone reschedules (attention) / defers
 * (card); raise/lower change priority; markDone/dismiss set status; delete soft-deletes.
 */
export type QueueActAction =
  | { readonly kind: "postpone" }
  | { readonly kind: "raise" }
  | { readonly kind: "lower" }
  | { readonly kind: "markDone" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "delete" };

export interface QueueActRequest {
  readonly id: string;
  readonly action: QueueActAction;
}

/** The undo recipe a removing action hands back for the snackbar. */
export interface QueueActUndo {
  /** `restore` → restore a soft-deleted row; `status` → re-set the prior status. */
  readonly kind: "restore" | "status";
  /** The status the row had BEFORE the action (the target the undo restores). */
  readonly previousStatus: string;
}

export interface QueueActResult {
  /**
   * The REFRESHED queue row after the action (so the renderer updates + re-sorts it
   * in place); `null` when the row left the due set (postpone / done / dismiss /
   * delete) or the id was unknown.
   */
  readonly item: QueueItemSummary | null;
  /** Whether the row LEAVES the due list (done / dismiss / delete). */
  readonly removed: boolean;
  /** The undo recipe for the snackbar, when the action is undoable. */
  readonly undo: QueueActUndo | null;
}

/**
 * One explicit (non-heuristic) attention-schedule choice (discriminated by `kind`):
 * tomorrow / next week / next month / a manual ISO date (T028). For non-card
 * attention items only — the renderer never offers this on a card (FSRS schedules
 * cards). The main process does the date math via the pure `AttentionScheduler`.
 */
export type QueueScheduleChoice =
  | { readonly kind: "tomorrow" }
  | { readonly kind: "nextWeek" }
  | { readonly kind: "nextMonth" }
  | { readonly kind: "manual"; readonly date: string };

export interface QueueScheduleRequest {
  readonly id: string;
  readonly choice: QueueScheduleChoice;
}

export interface QueueScheduleResult {
  /** The refreshed row, or `null` when the item is no longer due / id unknown. */
  readonly item: QueueItemSummary | null;
  /** The new `due_at` the item was scheduled to (ISO-8601). */
  readonly dueAt: string;
  /** The interval (in days) from "now" the chosen schedule resolved to. */
  readonly intervalDays: number;
}

/** Undo a removing queue action (the snackbar's "Undo") — echoes back the recipe. */
export interface QueueUndoRequest {
  readonly id: string;
  readonly undo: QueueActUndo;
}

export interface QueueUndoResult {
  /** The restored queue row summary, or `null` when the id is unknown. */
  readonly item: QueueItemSummary | null;
}

// ---------------------------------------------------------------------------
// lineage.get()  (T023 — the full navigable element hierarchy)
// ---------------------------------------------------------------------------

/** One flattened lineage node (depth-indented `tree-row`/`tree-node`). */
export interface LineageNode {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly stage: string;
  /** Indentation depth from the lineage root (root = 0). */
  readonly depth: number;
  /** Short trailing label (stage / card type / "sub-extract" / "source"). */
  readonly meta: string;
  /** True for the element the lineage was requested for (the inspector's focus). */
  readonly active: boolean;
}

/** The lineage payload for one element: the root id + the flattened tree. */
export interface LineageData {
  readonly elementId: string;
  /** The lineage root (`source`/`topic`) the tree is rooted at. */
  readonly rootId: string;
  /** Depth-ordered, flattened nodes (pre-order DFS) for the `LineageTree`. */
  readonly nodes: readonly LineageNode[];
}

export interface LineageGetRequest {
  readonly id: string;
}

export interface LineageGetResult {
  readonly lineage: LineageData | null;
}

// ---------------------------------------------------------------------------
// sources.importManual() / inbox.list() / inbox.get() / inbox.triage()  (T012)
// ---------------------------------------------------------------------------

/** The four coarse priority labels the UI exposes. */
export type PriorityLabelInput = "A" | "B" | "C" | "D";

/** Request to create a source in the inbox with its body (T012 + T013 + T014). */
export interface SourcesImportManualRequest {
  readonly title: string;
  readonly url?: string;
  /** Normalized URL; usually omitted — the main process derives it from `url`. */
  readonly canonicalUrl?: string;
  /** As-entered URL; usually omitted — the main process sets it from `url`. */
  readonly originalUrl?: string;
  readonly author?: string;
  /** The source's published date (loose string; stored as-is). */
  readonly publishedAt?: string;
  /** ISO accessed date; usually omitted — the main process auto-stamps "now". */
  readonly accessedAt?: string;
  /** Vault-relative snapshot key; stays absent in M2 (no snapshot is fetched). */
  readonly snapshotKey?: string;
  /** Raw pasted body text; converted to plain text + ProseMirror JSON main-side. */
  readonly body?: string;
  readonly reasonAdded?: string;
  readonly priority?: PriorityLabelInput;
}

/** A flat, list-row summary for one inbox source. */
export interface InboxItemSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly srcType: string;
  readonly author: string | null;
  readonly accessedAt: string | null;
  readonly charCount: number;
  readonly previewSnippet: string | null;
}

export interface SourcesImportManualResult {
  readonly id: string;
  readonly item: InboxItemSummary;
}

/** Request to fetch + clean + snapshot a live URL into an inbox source (T060). */
export interface SourcesImportUrlRequest {
  readonly url: string;
  readonly priority?: PriorityLabelInput;
  readonly reasonAdded?: string;
  /** T061: import a fresh source even if this URL / content is already imported. */
  readonly forceNewVersion?: boolean;
}

/**
 * One existing source an import candidate duplicates (T061) — surfaced in the
 * `"duplicate"` result so the modal can offer Open existing / Import new version.
 */
export interface SourceDuplicateSummary {
  readonly elementId: string;
  readonly title: string;
  readonly status: string;
  readonly accessedAt: string | null;
  readonly matchedBy: "canonicalUrl" | "contentHash";
}

/**
 * The discriminated URL-import result (T060 always `"imported"`; T061 adds
 * `"duplicate"`). Keeping it discriminated avoids a breaking shape change later.
 */
export type SourcesImportUrlResult =
  | {
      readonly status: "imported";
      readonly id: string;
      readonly item: InboxItemSummary;
    }
  | {
      readonly status: "duplicate";
      readonly matches: readonly SourceDuplicateSummary[];
    };

/** Import a local `.pdf` (T064) — MAIN opens the file picker; carries no path. */
export interface SourcesImportPdfRequest {
  readonly priority?: PriorityLabelInput;
  readonly reasonAdded?: string;
}

/** The PDF-import result (T064) — `"imported"` or `"cancelled"` (picker dismissed). */
export type SourcesImportPdfResult =
  | {
      readonly status: "imported";
      readonly id: string;
      readonly item: InboxItemSummary;
    }
  | {
      readonly status: "cancelled";
    };

/** Pick a local file for an import `kind` (T067) — MAIN opens the native picker. */
export interface PickImportFileRequest {
  readonly kind: "epub" | "markdown" | "html" | "highlights" | "anki" | "media" | "subtitles";
}

/** The picker result (T067) — chosen path(s), or a non-error cancellation. */
export type PickImportFileResult =
  | { readonly paths: readonly string[] }
  | { readonly cancelled: true };

/** Import a local `.epub` (T067) — the renderer passes a chosen path; MAIN imports. */
export interface SourcesImportEpubRequest {
  readonly path: string;
  readonly priority?: PriorityLabelInput;
  readonly reasonAdded?: string;
}

/** The EPUB-import result (T067) — the new book + its chapter count + inbox summary. */
export type SourcesImportEpubResult = {
  readonly status: "imported";
  readonly bookId: string;
  readonly chapterCount: number;
  readonly item: InboxItemSummary;
};

/** Import a local media file (T073) — the renderer passes a chosen path + optional sidecar. */
export interface SourcesImportMediaRequest {
  readonly path: string;
  readonly subtitlesPath?: string | null;
  readonly priority?: PriorityLabelInput;
  readonly reasonAdded?: string;
}

/** The media-import result (T073) — the new source + inbox summary + discriminator. */
export type SourcesImportMediaResult = {
  readonly status: "imported";
  readonly id: string;
  readonly item: InboxItemSummary;
  readonly mediaKind: "video" | "audio" | "youtube";
  readonly hasTranscript: boolean;
};

/** Request a media source's playable data (T073). */
export interface SourcesGetMediaDataRequest {
  readonly elementId: string;
}

/** The media playable-data result (T073) — `media://` URL (local) or YouTube id. */
export interface SourcesGetMediaDataResult {
  readonly mediaSource: "local" | "youtube";
  readonly mediaKind: "video" | "audio" | null;
  readonly mediaUrl: string | null;
  readonly mime: string | null;
  readonly youtubeId: string | null;
  readonly durationMs: number | null;
}

/** Import a local `.md`/`.html` file (T068) — the renderer passes a chosen path + format. */
export interface SourcesImportDocumentRequest {
  readonly path: string;
  readonly format: "markdown" | "html";
  readonly priority?: PriorityLabelInput;
  readonly reasonAdded?: string;
}

/** Import PASTED Markdown text (T068) — the paste path, no file read. */
export interface SourcesImportMarkdownTextRequest {
  readonly text: string;
  readonly title?: string;
  readonly priority?: PriorityLabelInput;
  readonly reasonAdded?: string;
}

/** The document-import result (T068) — the new source + its inbox summary. */
export type SourcesImportDocumentResult = {
  readonly status: "imported";
  readonly id: string;
  readonly item: InboxItemSummary;
};

/** Import a Readwise/Kindle highlight export (T069) — the renderer passes a chosen path. */
export interface SourcesImportHighlightsRequest {
  readonly path: string;
  readonly format?: "readwise_csv" | "readwise_json" | "kindle_clippings";
  readonly priority?: PriorityLabelInput;
}

/**
 * The highlight-import result (T069) — the detected format + per-import counts (sources
 * created/updated, extracts added, duplicate highlights skipped) + the inbox summaries.
 */
export type SourcesImportHighlightsResult = {
  readonly status: "imported";
  readonly format: "readwise_csv" | "readwise_json" | "kindle_clippings";
  readonly sourceCount: number;
  readonly extractCount: number;
  readonly skipped: number;
  readonly items: readonly InboxItemSummary[];
};

/** Export a document to Markdown (T068) — MAIN writes the `.md` to the `exports/` vault. */
export interface DocumentsExportMarkdownRequest {
  readonly elementId: string;
}

/** The Markdown-export result (T068) — the written `.md` path. */
export type DocumentsExportMarkdownResult = {
  readonly relativePath: string;
  readonly absPath: string;
};

/** Serve a PDF source's original bytes to the renderer for rendering (T064). */
export interface SourcesGetPdfDataRequest {
  readonly elementId: string;
}

export interface SourcesGetPdfDataResult {
  /** The original PDF bytes, or `null` when the source is not a PDF / has no snapshot. */
  readonly bytes: ArrayBuffer | null;
  /** The number of pages (derived from `document_blocks.page`), or 0 when unknown. */
  readonly pageCount: number;
}

/** A normalized region rectangle (T065): fractions `0–1` of the page (`x0<x1`, `y0<y1`). */
export interface RegionRectInput {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Which face of an audio card additionally plays the looped clip (T075). */
export type MediaRefFace = "prompt" | "answer" | "both";

/**
 * The audio-card presentation carrier (T075) — which clip of the original media to
 * LOOP, and on which face. `sourceElementId` is the media `source` (the player seeks
 * the ORIGINAL by time, no re-encoding); `startMs`/`endMs` the clip window; `on` the
 * face that plays it. Mirrors the contract `MediaRefSchema`.
 */
export interface MediaRef {
  readonly sourceElementId: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly on: MediaRefFace;
}

/** Crop a PDF page region into a scheduled `media_fragment` extract (T065). */
export interface SourcesExtractRegionRequest {
  readonly sourceElementId: string;
  /** The 1-based page the region sits on. */
  readonly page: number;
  /** The page's heading/first stable block id — the region's jump anchor. */
  readonly pageBlockId: string;
  /** The normalized bounding box (fractions 0–1). */
  readonly region: RegionRectInput;
  /** The cropped figure PNG bytes (produced in the renderer's `<canvas>`). */
  readonly imagePng: ArrayBuffer;
  /** Optional user caption; defaults to "Figure on page N" main-side. */
  readonly caption?: string | null;
  /** Optional A/B/C/D priority override; else INHERITS the source's priority. */
  readonly priority?: PriorityLabelInput;
}

/** The created region extract's `media_fragment` summary (T065). */
export interface RegionExtractSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly dueAt: string | null;
  readonly sourceId: string | null;
  readonly parentId: string | null;
}

/** The created region extract's stored region source-location anchor (T065). */
export interface RegionLocationSummary {
  readonly id: string;
  readonly sourceElementId: string;
  readonly page: number | null;
  readonly region: RegionRectInput | null;
  readonly label: string | null;
}

export interface SourcesExtractRegionResult {
  readonly id: string;
  readonly element: RegionExtractSummary;
  readonly location: RegionLocationSummary;
}

/** Clip a media span into a scheduled `media_fragment` extract (T074). */
export interface SourcesExtractClipRequest {
  readonly sourceElementId: string;
  /** The clip start in integer milliseconds. */
  readonly startMs: number;
  /** The clip end in integer milliseconds (`endMs > startMs`). */
  readonly endMs: number;
  /** The stable block id the clip anchors to (the first cue in range, or placeholder). */
  readonly anchorBlockId: string;
  /** The transcript segment under the range (when a transcript exists), else null. */
  readonly transcriptSegment?: string | null;
  /** Optional user caption; defaults to the "Clip M:SS–M:SS" label main-side. */
  readonly caption?: string | null;
  /** Optional A/B/C/D priority override; else INHERITS the source's priority. */
  readonly priority?: PriorityLabelInput;
}

/** A clip window `{ startMs, endMs }` (integer ms) — the IPC mirror of `ClipWindow` (T074). */
export interface ClipWindowSummary {
  readonly startMs: number;
  readonly endMs: number;
}

/** The created clip extract's `media_fragment` summary (T074). */
export interface ClipExtractSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly dueAt: string | null;
  readonly sourceId: string | null;
  readonly parentId: string | null;
}

/** The created clip extract's stored clip source-location anchor (T074). */
export interface ClipLocationSummary {
  readonly id: string;
  readonly sourceElementId: string;
  /** The start timestamp in milliseconds (mirrors `clip.startMs`). */
  readonly timestampMs: number | null;
  /** The clip window `{ startMs, endMs }`, else `null`. */
  readonly clip: ClipWindowSummary | null;
  readonly label: string | null;
}

export interface SourcesExtractClipResult {
  readonly id: string;
  readonly element: ClipExtractSummary;
  readonly location: ClipLocationSummary;
}

/** Serve a region extract's cropped image bytes to the renderer (T065). */
export interface SourcesGetRegionImageRequest {
  readonly elementId: string;
}

export interface SourcesGetRegionImageResult {
  /** The cropped PNG bytes, or `null` when the element has no image asset. */
  readonly bytes: ArrayBuffer | null;
  /** The image MIME (e.g. `image/png`), or `null`. */
  readonly mime: string | null;
}

/** Run OCR on one scanned/text-free PDF page (T066) — ships the rendered page PNG. */
export interface SourcesRunOcrRequest {
  readonly elementId: string;
  /** The 1-based page to OCR. */
  readonly page: number;
  /** The rendered page PNG bytes (produced in the renderer's `<canvas>`). */
  readonly imagePng: ArrayBuffer;
}

export interface SourcesRunOcrResult {
  readonly enqueued: number;
  readonly jobId: string;
}

/** One page's OCR suggestion (text + confidence + status) (T066). */
export interface OcrPageSummary {
  readonly page: number;
  readonly text: string;
  /** Mean confidence 0–100 (the renderer derives a green/amber/red badge). */
  readonly meanConfidence: number;
  /** `suggested` | `accepted` | `dismissed`. */
  readonly status: string;
}

export interface SourcesGetOcrRequest {
  readonly elementId: string;
}

export interface SourcesGetOcrResult {
  readonly pages: readonly OcrPageSummary[];
}

/** Accept / dismiss one page's OCR suggestion (T066). */
export interface SourcesAcceptOcrRequest {
  readonly elementId: string;
  readonly page: number;
}

export interface SourcesAcceptOcrResult {
  readonly accepted: boolean;
}

/**
 * A renderer-safe projection of a background-runner job (T058). The renderer
 * observes the local job queue (e.g. a Maintenance "background activity" view)
 * but never runs a job — no raw payload/result bytes are exposed.
 */
export interface JobSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  /** Progress as an integer percent 0–100. */
  readonly progressRatio: number;
  readonly progressNote: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Observe the current background-runner queue, optionally filtered (T058). */
export interface JobsListRequest {
  readonly status?: string;
  readonly type?: string;
  readonly limit?: number;
}

export interface JobsListResult {
  readonly jobs: readonly JobSummary[];
}

// ---------------------------------------------------------------------------
// vault.* — asset-vault maintenance (T059). The renderer never resolves a raw
// path or reads/writes bytes; it gets only the typed report/counts. The vault is
// the canonical local store — there is NO app-facing S3.
// ---------------------------------------------------------------------------

/** The vault integrity report (T059). Read-only; verify reports, never mutates. */
export interface VaultVerifyResult {
  /** Count of live assets whose stored bytes hashed to the recorded hash. */
  readonly ok: number;
  /** Asset ids whose stored bytes hashed to a DIFFERENT value (corruption). */
  readonly mismatched: readonly string[];
  /** Asset ids whose referenced file is MISSING on disk. */
  readonly missing: readonly string[];
  /** On-disk vault files (canonical relative paths) with no `assets` row at all. */
  readonly extraFiles: readonly string[];
}

/**
 * The orphan-scan result (T059). Each orphan is a vault FILE (relative path +
 * size) — the orphan unit is the unreferenced file, not a dangling asset row.
 */
export interface VaultOrphansResult {
  readonly orphans: readonly { relativePath: string; size: number }[];
  readonly totalBytes: number;
}

/**
 * Remove confirmed orphan files (T059). `confirm: true` guards the destructive
 * sweep; the optional `relativePaths` allow-list scopes removal to exactly the
 * files `findOrphans` showed.
 */
export interface VaultCollectOrphansRequest {
  readonly confirm: true;
  readonly relativePaths?: readonly string[];
}

export interface VaultCollectOrphansResult {
  readonly removed: number;
  readonly freedBytes: number;
}

// ---------------------------------------------------------------------------
// capture.* — browser-extension pairing (T062). The TRUSTED desktop renderer
// reads/regenerates the pairing token + toggles the loopback capture server.
// The token is displayed for the user to paste into the extension; it is never
// handed to a web page (no IPC path does so).
// ---------------------------------------------------------------------------

/** The full pairing state shown in the Settings "Browser capture" card. */
export interface CapturePairingResult {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly port: number | null;
  readonly token: string;
  /** The paired extension origin, or null until an extension has paired. */
  readonly extensionOriginHint: string | null;
}

export interface CaptureRegenerateTokenResult {
  readonly token: string;
}

export interface CaptureSetEnabledRequest {
  readonly enabled: boolean;
}

export interface CaptureSetEnabledResult {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly port: number | null;
}

export interface InboxListResult {
  readonly items: readonly InboxItemSummary[];
}

export interface InboxGetRequest {
  readonly id: string;
}

/** Full preview payload for one inbox item. */
export interface InboxItemDetail {
  readonly summary: InboxItemSummary;
  readonly provenance: SourceProvenance;
  readonly bodyPreview: string | null;
}

export interface InboxGetResult {
  readonly detail: InboxItemDetail | null;
}

/** One triage action applied to an inbox source (discriminated by `kind`). */
export type InboxTriageAction =
  | { readonly kind: "accept" }
  | { readonly kind: "keepForLater" }
  | { readonly kind: "setPriority"; readonly priority: PriorityLabelInput }
  | { readonly kind: "delete" };

export interface InboxTriageRequest {
  readonly id: string;
  readonly action: InboxTriageAction;
}

export interface InboxTriageResult {
  readonly item: InboxItemSummary | null;
  readonly deleted: boolean;
}

// ---------------------------------------------------------------------------
// documents.get() / documents.save()  (T015 — editable rich-text body)
// ---------------------------------------------------------------------------

export interface DocumentsGetRequest {
  readonly elementId: string;
}

/** The persisted document body (ProseMirror JSON + plain-text mirror). */
export interface DocumentPayload {
  readonly prosemirrorJson: unknown;
  readonly plainText: string;
  readonly schemaVersion: number;
  readonly updatedAt: string;
}

export interface DocumentsGetResult {
  readonly document: DocumentPayload | null;
  /**
   * Distinct stable block ids in this source that already have a child extract
   * anchored to them (T018 display markers). M3 only DISPLAYS these; creating
   * extracts is M4. Derived main-side from the source's child extract locations.
   */
  readonly extractedBlockIds: readonly string[];
  /**
   * The source body format — `"pdf"` for a paginated PDF source (T064, the PDF
   * reading mode), `"video"` for a media source (T073, the `MediaReader`), else
   * `null` (the ordinary editor body).
   */
  readonly sourceFormat: "pdf" | "video" | null;
  /**
   * For a MEDIA source (T073): `"local"` (a vault asset played via `media://`) or
   * `"youtube"` (an IFrame embed); `null` for non-media sources.
   */
  readonly mediaSource: "local" | "youtube" | null;
  /**
   * For a LOCAL media source (T073): `"video"`/`"audio"`; `null` for a YouTube source
   * and every non-media source.
   */
  readonly mediaKind: "video" | "audio" | null;
  /**
   * For a PAGINATED (PDF) source: the block→page map (stable block id → 1-based
   * page) off `document_blocks.page`, so the reader sets a page read-point + derives
   * the page of a selected block. Empty for non-paginated bodies.
   */
  readonly blockPages: Readonly<Record<string, number>>;
  /**
   * For a MEDIA source (T073): the block→time map (stable block id → cue start ms)
   * off `document_blocks.timestamp_ms`, so the reader seeks to a cue + persists a
   * timestamp read-point. Empty for non-media bodies.
   */
  readonly blockTimestamps: Readonly<Record<string, number>>;
}

/** One stable block descriptor (T016), derived renderer-side via `toBlockInputs`. */
export interface DocumentBlockInputPayload {
  readonly blockType: string;
  readonly order: number;
  /** The stable block id (a ULID) read off the editor's `blockId` attribute. */
  readonly stableBlockId: string;
}

export interface DocumentsSaveRequest {
  readonly elementId: string;
  /** The ProseMirror document JSON (schema owned by `@interleave/editor`). */
  readonly prosemirrorJson: unknown;
  /** The flattened plain-text mirror, computed renderer-side via `toPlainText`. */
  readonly plainText: string;
  readonly schemaVersion?: number;
  /**
   * The ordered stable block list (T016). When present, the main side replaces
   * `document_blocks` with it, preserving the stable ids extracts/read-points
   * anchor to.
   */
  readonly blocks?: readonly DocumentBlockInputPayload[];
}

export interface DocumentsSaveResult {
  readonly document: DocumentPayload;
}

// ---------------------------------------------------------------------------
// documents.marks.add() / .remove() / .list()  (T020 — document annotations)
// ---------------------------------------------------------------------------

/** A persisted document mark (highlight / extracted-span / processed-span). */
export interface DocumentMarkPayload {
  readonly id: string;
  readonly elementId: string;
  /** The STABLE block id the mark anchors to. */
  readonly blockId: string;
  readonly markType: string;
  /** Character range within the block, as `[start, end]`. */
  readonly range: readonly [number, number];
  /** Mark-specific attributes (JSON), or `null`. */
  readonly attrs: Readonly<Record<string, unknown>> | null;
}

export interface DocumentMarksAddRequest {
  readonly elementId: string;
  /** The STABLE block id the mark anchors to. */
  readonly blockId: string;
  /** The mark kind (`highlight` for T020). */
  readonly markType: string;
  /** `[start, end]` character range within the block. */
  readonly range: readonly [number, number];
  readonly attrs?: Readonly<Record<string, unknown>> | null;
}

export interface DocumentMarksAddResult {
  readonly mark: DocumentMarkPayload;
}

export interface DocumentMarksRemoveRequest {
  readonly markId: string;
}

export interface DocumentMarksRemoveResult {
  readonly removed: boolean;
}

export interface DocumentMarksListRequest {
  readonly elementId: string;
  /** Optionally filter to one kind (e.g. only `highlight`). */
  readonly markType?: string;
}

export interface DocumentMarksListResult {
  readonly marks: readonly DocumentMarkPayload[];
}

// ---------------------------------------------------------------------------
// extractions.create()  (T021 — lift selected text into an independent extract)
// ---------------------------------------------------------------------------

/** The four coarse priority labels (re-stated here for the renderer client). */
export type ExtractionPriorityLabel = "A" | "B" | "C" | "D";

export interface ExtractionCreateRequest {
  /** The original source element the selection was lifted from (lineage root). */
  readonly sourceElementId: string;
  /** The origin element; omit for a top-level extract, set for a sub-extract (T025). */
  readonly parentId?: string;
  /** Verbatim snapshot of the selected text. */
  readonly selectedText: string;
  /** Ordered STABLE block ids the selection spans (≥ 1, document order). */
  readonly blockIds: readonly string[];
  /** Char offset within the FIRST spanned block where the selection starts. */
  readonly startOffset?: number;
  /** Char offset within the LAST spanned block where the selection ends. */
  readonly endOffset?: number;
  /** Optional explicit title; otherwise derived from the selection main-side. */
  readonly title?: string;
  /** Optional human label override; otherwise derived from the source's blocks. */
  readonly label?: string;
  /** Optional page (PDF, later); null/absent for text sources. */
  readonly page?: number | null;
  /** Optional A/B/C/D priority override; otherwise inherits the source's priority. */
  readonly priority?: ExtractionPriorityLabel;
}

/** A flat summary of a freshly created extract element. */
export interface ExtractSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  /** The attention `due_at` (ISO-8601) — extracts are attention items, never FSRS. */
  readonly dueAt: string | null;
  readonly sourceId: string | null;
  readonly parentId: string | null;
}

/** The created extract's stored source-location anchor. */
export interface ExtractLocationSummary {
  readonly id: string;
  readonly sourceElementId: string;
  readonly blockIds: readonly string[];
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly label: string | null;
  readonly selectedText: string;
}

export interface ExtractionCreateResult {
  readonly extract: ExtractSummary;
  readonly location: ExtractLocationSummary;
}

// ---------------------------------------------------------------------------
// cards.create()  (T032 — author a card from an extract)
// ---------------------------------------------------------------------------

/** The two card kinds the MVP ships. */
export type CardKind = "qa" | "cloze" | "image_occlusion";

export interface CardsCreateRequest {
  /** The originating extract this card is distilled from (lineage parent). */
  readonly extractId: string;
  /** Card kind — `qa` or `cloze`. */
  readonly kind: CardKind;
  /** Q&A prompt (required, non-empty, for `qa`). */
  readonly prompt?: string;
  /** Q&A answer (required, non-empty, for `qa`). */
  readonly answer?: string;
  /** Canonical `{{c1::answer}}` cloze text (required, non-empty, for `cloze`). */
  readonly cloze?: string;
  /** Optional explicit title; otherwise derived from the body main-side. */
  readonly title?: string;
  /** Optional A/B/C/D priority override; otherwise inherits the extract's priority. */
  readonly priority?: ExtractionPriorityLabel;
  /** Optional sibling group id (to group with a prior sibling); minted when absent. */
  readonly siblingGroupId?: string;
  /**
   * Audio-card carrier (T075). When supplied, the card LOOPS this clip on the chosen
   * face. When omitted and `extractId` is a clip `media_fragment`, the main side
   * derives it (defaulting the loop to the prompt). `null` for a text card.
   */
  readonly mediaRef?: MediaRef | null;
}

/** A flat summary of a freshly created card element. */
export interface CardSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  /** Card kind (`qa`/`cloze`). */
  readonly kind: string;
  /** The originating extract id (lineage parent). */
  readonly parentId: string | null;
  /** The owning source element id (lineage root). */
  readonly sourceId: string | null;
  /** The sibling group the card joined (thread into the next sibling's create). */
  readonly siblingGroupId: string;
  /** The audio-card clip reference (T075) when this is an audio card, else `null`. */
  readonly mediaRef: MediaRef | null;
}

export interface CardsCreateResult {
  readonly card: CardSummary;
  /** The inherited source-location anchor id (lineage), or `null` when the extract has none. */
  readonly sourceLocationId: string | null;
}

/** One mask to occlude over the base image — a normalized region + an optional label. */
export interface OcclusionMaskInput {
  readonly region: RegionRectInput;
  /** The text the hidden region stands for (shown on reveal); or `null`. */
  readonly label?: string | null;
}

/**
 * Generate N sibling `image_occlusion` cards from a `media_fragment` image extract
 * (T071). The renderer draws normalized mask rects over the base image (already in
 * the vault — the bytes are NOT sent) and ships ONLY the `imageElementId` + the
 * vector masks. One card per mask, all in one `sibling_group`.
 */
export interface CardsGenerateOcclusionRequest {
  /** The `media_fragment` image extract the masks are drawn over (the base). */
  readonly imageElementId: string;
  /** The masks to occlude — one card per mask (≥1, ≤50). */
  readonly masks: readonly OcclusionMaskInput[];
  /** Optional A/B/C/D priority override; otherwise inherits the image's priority. */
  readonly priority?: ExtractionPriorityLabel;
}

export interface CardsGenerateOcclusionResult {
  /** The sibling group all generated cards joined (the whole diagram). */
  readonly siblingGroupId: string;
  /** One `image_occlusion` card summary per mask. */
  readonly cards: readonly CardSummary[];
}

// ---------------------------------------------------------------------------
// cards.update() / cards.suspend() / cards.delete() / cards.flag()  (T038)
// ---------------------------------------------------------------------------

/** A flat summary of a card after a repair action (body + status + flag). */
export interface CardEditSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly kind: string;
  readonly prompt: string | null;
  readonly answer: string | null;
  readonly cloze: string | null;
  readonly parentId: string | null;
  readonly sourceId: string | null;
  /** Whether the card is currently flagged-as-bad. */
  readonly flagged: boolean;
  /** Whether the card is currently flagged a leech (auto after ≥4 lapses, or manual) (T040). */
  readonly leech: boolean;
  /** True after a soft delete. */
  readonly deleted: boolean;
}

export interface CardsUpdateRequest {
  readonly cardId: string;
  /** New Q&A prompt (for a `qa` card); ignored for cloze. */
  readonly prompt?: string;
  /** New Q&A answer (for a `qa` card); ignored for cloze. */
  readonly answer?: string;
  /** New canonical `{{c1::answer}}` cloze text (for a `cloze` card); ignored for Q&A. */
  readonly cloze?: string;
}

export interface CardsUpdateResult {
  readonly card: CardEditSummary;
}

export interface CardsSuspendRequest {
  readonly cardId: string;
}

export interface CardsSuspendResult {
  readonly card: CardEditSummary;
}

export interface CardsDeleteRequest {
  readonly cardId: string;
}

export interface CardsDeleteResult {
  readonly card: CardEditSummary;
}

export interface CardsFlagRequest {
  readonly cardId: string;
  readonly flagged: boolean;
  readonly reason?: string;
}

export interface CardsFlagResult {
  readonly card: CardEditSummary;
}

export interface CardsMarkLeechRequest {
  readonly cardId: string;
  /** Set the leech flag (`true`) or clear it (`false` — un-leech after remediation). */
  readonly leech: boolean;
}

export interface CardsMarkLeechResult {
  readonly card: CardEditSummary;
}

// ---------------------------------------------------------------------------
// cards.importAnki() / cards.exportAnki()  (T070 — Anki .apkg/CSV interop)
// ---------------------------------------------------------------------------

export interface CardsImportAnkiRequest {
  readonly path: string;
  readonly priority?: PriorityLabelInput;
}

export type CardsImportAnkiResult = {
  readonly status: "imported";
  readonly deckCount: number;
  readonly cardCount: number;
  /** How many cards carried scheduling history over (the rest imported as new). */
  readonly withHistory: number;
  readonly item: InboxItemSummary;
};

export interface CardsExportAnkiRequest {
  readonly format: "apkg" | "csv";
  readonly cardIds?: readonly string[];
  readonly conceptId?: string;
  readonly all?: boolean;
}

export type CardsExportAnkiResult = {
  readonly relativePath: string;
  readonly absPath: string;
  readonly cardCount: number;
};

// ---------------------------------------------------------------------------
// extracts.updateStage() / .rewrite() / .postpone() / .markDone() / .delete()
//   (T024 — extract review mode actions)
// ---------------------------------------------------------------------------

/** The three extract distillation stages the chain walks through (T024). */
export type ExtractStage = "raw_extract" | "clean_extract" | "atomic_statement";

/** A flat summary of an extract after a review action (mirrors `ExtractSummary`). */
export interface ExtractActionSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  /** The attention `due_at` (ISO-8601) — extracts are attention items, never FSRS. */
  readonly dueAt: string | null;
  readonly sourceId: string | null;
  readonly parentId: string | null;
}

export interface ExtractsUpdateStageRequest {
  readonly id: string;
  /** Explicit target stage; omit to advance one step from the current stage. */
  readonly stage?: ExtractStage;
}

export interface ExtractsUpdateStageResult {
  readonly extract: ExtractActionSummary;
}

export interface ExtractsRewriteRequest {
  readonly id: string;
  /** The new ProseMirror document JSON (schema owned by `@interleave/editor`). */
  readonly prosemirrorJson: unknown;
  /** The flattened plain-text mirror, computed renderer-side. */
  readonly plainText: string;
  /** The ordered stable block list (preserves the stable ids), when present. */
  readonly blocks?: readonly DocumentBlockInputPayload[];
}

export interface ExtractsRewriteResult {
  readonly extract: ExtractActionSummary;
  /** The persisted plain-text body after the rewrite. */
  readonly plainText: string;
}

export interface ExtractsPostponeRequest {
  readonly id: string;
}

export interface ExtractsPostponeResult {
  readonly extract: ExtractActionSummary;
  /** The running postpone count after this postpone. */
  readonly postponeCount: number;
}

export interface ExtractsMarkDoneRequest {
  readonly id: string;
}

export interface ExtractsMarkDoneResult {
  readonly extract: ExtractActionSummary;
}

export interface ExtractsDeleteRequest {
  readonly id: string;
}

export interface ExtractsDeleteResult {
  readonly extract: ExtractActionSummary;
}

// ---------------------------------------------------------------------------
// readPoints.get() / readPoints.set()  (T017 — resume position)
// ---------------------------------------------------------------------------

export interface ReadPointGetRequest {
  readonly elementId: string;
}

/** The persisted read-point (a STABLE block id + character offset). */
export interface ReadPointPayload {
  readonly blockId: string;
  readonly offset: number;
  readonly updatedAt: string;
}

export interface ReadPointGetResult {
  readonly readPoint: ReadPointPayload | null;
}

export interface ReadPointSetRequest {
  readonly elementId: string;
  /** The element id of the document body the block lives in (usually the same). */
  readonly documentId: string;
  /** The STABLE block id (from T016) to resume at. */
  readonly blockId: string;
  /** Character offset within the block's text; non-negative integer. */
  readonly offset: number;
}

export interface ReadPointSetResult {
  readonly readPoint: ReadPointPayload;
}

// ---------------------------------------------------------------------------
// review.session.next() / review.preview() / review.grade()  (T037 — the session)
// ---------------------------------------------------------------------------

/** The canonical FSRS rating values the renderer grades with. */
export type ReviewRating = "again" | "hard" | "good" | "easy";

/** The FSRS scheduler signals a review card carries for its chip + stat readout. */
export interface ReviewSchedulerSignals {
  readonly kind: "fsrs";
  readonly retrievability: number | null;
  readonly stability: number | null;
  readonly difficulty: number | null;
  readonly reps: number | null;
  readonly lapses: number | null;
  readonly fsrsState: string | null;
}

/**
 * Everything the review face needs for ONE card. The `answer`/`cloze`/`ref` ship
 * with the card but the renderer keeps them hidden until reveal (no reveal
 * round-trip — review stays local + fast).
 */
export interface ReviewCardView {
  readonly id: string;
  readonly kind: string;
  /** The Q&A prompt, or the cloze `{{cN::…}}` text the front masks until reveal. */
  readonly prompt: string;
  readonly answer: string | null;
  readonly cloze: string | null;
  readonly priority: number;
  readonly stage: string;
  readonly concept: string | null;
  readonly sourceTitle: string | null;
  readonly sourceLocationLabel: string | null;
  /** A verbatim snapshot of the originating text (the refblock quote), or `null`. */
  readonly ref: string | null;
  /**
   * The full originating source reference (T043 — title/URL/author/date/location +
   * snippet), resolved from the card's lineage. Ships with the card but the
   * renderer keeps it HIDDEN until reveal (it must not leak the answer), rendered
   * with the shared `formatSourceRef`/`RefBlock`. `null` for a source-less card.
   */
  readonly sourceRef: SourceRef | null;
  readonly schedulerSignals: ReviewSchedulerSignals;
  readonly leech: boolean;
  readonly lapses: number;
  /** True when the user has flagged this card as bad (T038). */
  readonly flagged: boolean;
  /**
   * The card's sibling group (the same extract / cloze set), or `null`. The
   * renderer threads this forward as opaque session state so the next
   * `session.next` can bury the group (T039); it never computes sibling links.
   */
  readonly siblingGroupId: string | null;
  /**
   * Image-occlusion render data (T071) — present ONLY for an `image_occlusion`
   * card, `null` otherwise. The review face loads the base image bytes via
   * `getRegionImage({ elementId: imageElementId })` and composites a mask box over
   * `region` on the front; on reveal it clears the box and shows `label`.
   */
  readonly occlusion: ReviewOcclusion | null;
  /**
   * Audio-card render data (T075) — present ONLY for a card whose `media_ref` is set,
   * `null` otherwise. The clip window + face to LOOP. The review face plays it by
   * seeking the original media (no re-encoding) on the `mediaRef.on` face — the front
   * loops `{prompt,both}`, the reveal `{answer,both}`, never leaking an audio answer.
   */
  readonly mediaRef: MediaRef | null;
  /**
   * The resolved media-source kind for the audio clip (T075) — `"local"` (played via
   * `media://<mediaRef.sourceElementId>`) or `"youtube"` (an IFrame Player) — so the
   * face plays WITHOUT a second `getMediaData` round-trip. `null` for a non-audio card.
   */
  readonly mediaSource: "local" | "youtube" | null;
  /** The YouTube video id for a youtube audio source (T075), else `null`. */
  readonly youtubeId: string | null;
}

/** The image-occlusion data the review face needs (T071). */
export interface ReviewOcclusion {
  /** The `media_fragment` image extract whose bytes the face loads (base image). */
  readonly imageElementId: string;
  /** The masked region this card hides (the answer), shown on reveal. */
  readonly region: RegionRectInput;
  /** The label the hidden region stands for, shown on reveal; or `null`. */
  readonly label: string | null;
  /** The sibling masks (the diagram's other regions) — for optional dimming. */
  readonly otherRegions: readonly RegionRectInput[];
}

export interface ReviewSessionNextRequest {
  /** Card ids already seen this session — skipped so the deck advances. */
  readonly exclude?: readonly string[];
  /**
   * Sibling group(s) shown most recently this session — opaque ids carried forward
   * from the previous card's `siblingGroupId`. When burying is on, a card in any of
   * these groups is skipped so siblings aren't back-to-back (T039). The main side
   * does the sibling-aware selection; the renderer never computes sibling links.
   */
  readonly recentSiblingGroups?: readonly string[];
  /** When `false`, sibling burying is off. When omitted, the persisted setting wins. */
  readonly burySiblings?: boolean;
  /** "Now" the due read compares against (ISO-8601); defaults to the server clock. */
  readonly asOf?: string;
}

export interface ReviewSessionNextResult {
  readonly card: ReviewCardView | null;
  /** Due cards remaining AFTER this card (excluding the `exclude` set). */
  readonly remaining: number;
  /** The total due-card deck size (incl. this card; excluding the `exclude` set). */
  readonly total: number;
}

/**
 * Fetch ONE card's full reveal-ready view by id (T037/T031) — the same view
 * `reviewSessionNext` ships, but TARGETED (not soonest-due). The process loop
 * (T031) walks a frozen queue order with a cursor, so to reveal the answer inline
 * for the card under the cursor it needs THAT card's full view. Read-only.
 */
export interface ReviewCardRequest {
  readonly cardId: string;
  readonly asOf?: string;
}

export interface ReviewCardResult {
  readonly card: ReviewCardView | null;
}

/** One previewed grade outcome: the resulting due time + interval (days) + a label. */
export interface ReviewIntervalPreview {
  readonly dueAt: string;
  readonly scheduledDays: number;
  /** Compact human label, e.g. `"10m"`, `"2d"`, `"5d"`. */
  readonly label: string;
}

export interface ReviewPreviewRequest {
  readonly cardId: string;
  readonly asOf?: string;
}

export interface ReviewPreviewResult {
  /** The four possible next intervals keyed by rating, or `null` (no review state). */
  readonly intervals: Record<ReviewRating, ReviewIntervalPreview> | null;
}

export interface ReviewGradeRequest {
  readonly cardId: string;
  readonly rating: ReviewRating;
  /** The measured reveal→grade response time (ms), persisted on `review_logs`. */
  readonly responseMs: number;
  readonly asOf?: string;
}

/** The durable review-log row written by a grade (append-only). */
export interface ReviewLogSummary {
  readonly id: string;
  readonly elementId: string;
  readonly rating: string;
  readonly reviewedAt: string;
  readonly responseMs: number;
  readonly nextDueAt: string;
}

/** The advanced FSRS state after a grade. */
export interface ReviewStateSummary {
  readonly dueAt: string | null;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly fsrsState: string;
  readonly lastReviewedAt: string | null;
}

export interface ReviewGradeResult {
  readonly reviewLog: ReviewLogSummary;
  readonly reviewState: ReviewStateSummary;
}

/** One leech card row for the cleanup view (T040). */
export interface LeechSummary {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly prompt: string | null;
  readonly answer: string | null;
  readonly cloze: string | null;
  /** Cumulative FSRS lapses (failed reviews) — the leech's severity. */
  readonly lapses: number;
  readonly reps: number;
  readonly sourceTitle: string | null;
  readonly sourceLocationLabel: string | null;
}

export interface ReviewLeechesResult {
  readonly cards: readonly LeechSummary[];
}

// ---------------------------------------------------------------------------
// concepts.* / tags.*  (T041 — organize: hierarchical concepts + flat tags)
// ---------------------------------------------------------------------------

/** A flat concept summary (id + name + parent link). */
export interface ConceptSummary {
  readonly id: string;
  readonly name: string;
  readonly parentConceptId: string | null;
  /** Per-concept FSRS desired-retention target (T079), or `null` = inherit. */
  readonly desiredRetention: number | null;
}

/** A concept node for the filterbar/map: the concept + its cheap derived counts. */
export interface ConceptNode {
  readonly id: string;
  readonly name: string;
  readonly parentConceptId: string | null;
  /** Number of direct child concepts in the hierarchy. */
  readonly childCount: number;
  /** Number of LIVE elements that are members of this concept. */
  readonly memberCount: number;
  /** Per-concept FSRS desired-retention target (T079), or `null` = inherit. */
  readonly desiredRetention: number | null;
}

/** A tag with its live usage count (for the library filterbar). */
export interface TagSummary {
  readonly name: string;
  readonly count: number;
}

/** Request for the live members of one concept (the `/concepts` drill-in). */
export interface ConceptsMembersRequest {
  readonly conceptId: string;
}

/**
 * One member-element summary for the `/concepts` drill-in list. Carries the same
 * enrichment a search/library row does (type/title/priority + label, the
 * FSRS-vs-attention scheduler signals, the due state/label, owning-source title)
 * so a member row reads identically — and enough to open the element.
 */
export interface ConceptMemberSummary {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly priority: number;
  readonly priorityLabel: PriorityLabel;
  readonly status: string;
  readonly stage: string;
  readonly sourceTitle: string | null;
  readonly dueAt: string | null;
  readonly scheduler: SchedulerSignals;
  readonly due: QueueDueState;
  readonly dueLabel: string;
}

export interface ConceptsMembersResult {
  readonly members: readonly ConceptMemberSummary[];
}

// ---------------------------------------------------------------------------
// retention.*  (T079 — desired retention by priority band / concept / card)
// ---------------------------------------------------------------------------

/** Which rule resolved a card's effective retention (the inspector/debug read). */
export type RetentionSource = "card" | "concept" | "band" | "global";

/** One concept's per-concept retention target (for the `retention.get` read). */
export interface RetentionConceptTarget {
  readonly conceptId: string;
  readonly name: string;
  readonly target: number | null;
}

export interface RetentionGetResult {
  readonly global: number;
  readonly byBandEnabled: boolean;
  readonly byBand: Partial<Record<"A" | "B" | "C" | "D", number>>;
  readonly byConcept: readonly RetentionConceptTarget[];
}

export interface RetentionSetBandRequest {
  readonly band: "A" | "B" | "C" | "D";
  readonly target: number | null;
}

export interface RetentionSetBandEnabledRequest {
  readonly enabled: boolean;
}

export interface RetentionUpdatedResult {
  readonly retention: RetentionGetResult;
}

export interface RetentionSetConceptRequest {
  readonly conceptId: string;
  readonly target: number | null;
}

export interface RetentionSetConceptResult {
  readonly concept: RetentionConceptTarget | null;
}

export interface RetentionSetCardRequest {
  readonly cardId: string;
  readonly target: number | null;
}

export interface RetentionSetCardResult {
  readonly cardId: string;
  readonly target: number | null;
}

export interface RetentionResolveForRequest {
  readonly cardId: string;
}

export interface RetentionResolveForResult {
  readonly target: number | null;
  readonly source: RetentionSource | null;
}

// ---------------------------------------------------------------------------
// optimization.*  (T080 — on-device FSRS parameter optimization)
// ---------------------------------------------------------------------------

/** The optimization scope — the global preset, or one concept's preset. */
export type OptimizationScopeRequest =
  | { readonly scope: "global" }
  | { readonly scope: "concept"; readonly conceptId: string };

export interface OptimizationSuggestRequest {
  readonly scope: OptimizationScopeRequest;
}

/** A calibration score (lower is better). */
export interface OptimizationFitScore {
  readonly logLoss: number;
  readonly rmse: number;
  readonly reviewsScored: number;
}

/** A bucketed daily due count for the workload preview. */
export interface OptimizationWorkloadDay {
  readonly date: string;
  readonly count: number;
}

/** The read-only workload-impact preview (before/after daily due counts + deltas). */
export interface OptimizationWorkload {
  readonly before: readonly OptimizationWorkloadDay[];
  readonly after: readonly OptimizationWorkloadDay[];
  readonly deltaDueNext7: number;
  readonly deltaDueNext30: number;
}

export interface OptimizationSuggestResult {
  readonly params: readonly number[];
  readonly baseline: OptimizationFitScore;
  readonly suggested: OptimizationFitScore;
  readonly improvement: number;
  readonly reviewsScored: number;
  readonly method: "history-calibration";
  readonly sufficientData: boolean;
  readonly workload: OptimizationWorkload;
}

export interface OptimizationApplyRequest {
  readonly scope: OptimizationScopeRequest;
  readonly params: readonly number[];
}

export interface OptimizationApplyResult {
  readonly applied: true;
}

// ---------------------------------------------------------------------------
// workload.*  (T081 — workload simulation)
// ---------------------------------------------------------------------------

/** The discriminated workload-change union (the lever being previewed). */
export type WorkloadChangeRequest =
  | {
      readonly kind: "retention";
      readonly scope: "global" | "band" | "concept";
      readonly key?: string;
      readonly target: number;
    }
  | {
      readonly kind: "addCards";
      readonly count: number;
      readonly priority: number;
      readonly firstDueInDays?: number;
    }
  | {
      readonly kind: "postponeLowPriority";
      readonly band: "A" | "B" | "C" | "D";
      readonly days: number;
      readonly includeMatureCards?: boolean;
    };

export interface WorkloadSimulateRequest {
  readonly change: WorkloadChangeRequest;
  readonly windowDays?: number;
  readonly asOf?: string;
}

/** One local-calendar day's before/after due counts. `date` is `YYYY-MM-DD` (local). */
export interface WorkloadProjectionDay {
  readonly date: string;
  readonly before: number;
  readonly after: number;
}

/** The complete workload projection (the `workload.simulate` result). */
export interface WorkloadSimulateResult {
  readonly days: readonly WorkloadProjectionDay[];
  readonly overBudgetDaysBefore: number;
  readonly overBudgetDaysAfter: number;
  readonly peakBefore: number;
  readonly peakAfter: number;
  readonly deltaNext7: number;
  readonly deltaNext30: number;
  readonly budget: number;
}

/** The element's organize state after an assign/unassign/tag mutation. */
export interface ElementOrganizeState {
  readonly elementId: string;
  readonly concepts: readonly ConceptSummary[];
  readonly tags: readonly string[];
}

export interface ConceptsCreateRequest {
  readonly name: string;
  readonly parentConceptId?: string | null;
}

export interface ConceptsCreateResult {
  readonly concept: ConceptSummary;
}

export interface ConceptsListResult {
  readonly concepts: readonly ConceptNode[];
}

export interface ConceptsAssignRequest {
  readonly elementId: string;
  readonly conceptId: string;
}

export interface ConceptsAssignResult {
  readonly element: ElementOrganizeState | null;
}

export interface ConceptsUnassignRequest {
  readonly elementId: string;
  readonly conceptId: string;
}

export interface ConceptsUnassignResult {
  readonly element: ElementOrganizeState | null;
}

export interface TagsListResult {
  readonly tags: readonly TagSummary[];
}

export interface TagsAddRequest {
  readonly elementId: string;
  readonly tag: string;
}

export interface TagsAddResult {
  readonly element: ElementOrganizeState | null;
}

export interface TagsRemoveRequest {
  readonly elementId: string;
  readonly tag: string;
}

export interface TagsRemoveResult {
  readonly element: ElementOrganizeState | null;
}

// ---------------------------------------------------------------------------
// search.*  (T042 — local FTS5 full-text search)
// ---------------------------------------------------------------------------

/** The searchable element types (the only types with an FTS index). */
export type SearchableType = "source" | "extract" | "card";

/** A ranked search hit — enough for the library `result` row + selection detail. */
export interface SearchResult {
  readonly id: string;
  readonly type: SearchableType;
  readonly title: string;
  readonly snippet: string;
  /** FTS5 `bm25` rank — lower is a better match. */
  readonly score: number;
  readonly priority: number;
  readonly priorityLabel: PriorityLabel;
  readonly concept: string | null;
  readonly sourceTitle: string | null;
  readonly sourceLocationLabel: string | null;
  readonly dueAt: string | null;
  /** The element's scheduler signals (FSRS vs attention) for the detail chip. */
  readonly scheduler: SchedulerSignals;
  /** How due the element is now (overdue / today / soon), for the detail badge. */
  readonly due: QueueDueState;
  /** A short human due label ("Overdue", "Due today", "in 3d", "Scheduled"). */
  readonly dueLabel: string;
}

export interface SearchQueryRequest {
  readonly q: string;
  readonly type?: SearchableType;
  readonly conceptId?: string;
  readonly tag?: string;
  /**
   * Restrict to elements whose priority maps to this A/B/C/D band (the priority
   * facet). Applied MAIN-side so the drill-down concept-chip `byConcept` counts
   * respect it too — the chip number then matches the priority-narrowed list.
   */
  readonly priorityLabel?: PriorityLabel;
  readonly limit?: number;
}

/**
 * DRILL-DOWN faceted counts for the `/search` filterbar concept chips. `byConcept`
 * is keyed by concept element id: the count of result rows you'd get if that concept
 * were selected alongside the SAME keyword + type (the concept's own predicate is
 * dropped), so the chip number matches the narrowed list. The chip MUST use this,
 * NOT the global `ConceptNode.memberCount`.
 */
export interface SearchCounts {
  readonly byConcept: Readonly<Record<string, number>>;
}

export interface SearchQueryResult {
  readonly results: readonly SearchResult[];
  /** Drill-down per-concept counts for the filterbar concept chips. */
  readonly counts: SearchCounts;
}

// ---------------------------------------------------------------------------
// library.browse()  (Library route — the facet-driven browse-everything read)
// ---------------------------------------------------------------------------

/** The browsable element types the Library route lists (NOT only the FTS types). */
export type LibraryBrowseType = "source" | "extract" | "card" | "topic" | "synthesis_note" | "task";

/**
 * The facet-driven browse request — every facet OPTIONAL. With none set, the
 * Library lists ALL live elements (the browse-first default that distinguishes
 * it from keyword search). No keyword field exists here on purpose.
 */
export interface LibraryBrowseRequest {
  readonly types?: readonly LibraryBrowseType[];
  readonly conceptId?: string;
  readonly priorityLabel?: PriorityLabel;
  readonly statuses?: readonly string[];
  readonly limit?: number;
}

/** One browsed element row — the Library `result` row + selection detail. */
export interface LibraryItem {
  readonly id: string;
  readonly type: LibraryBrowseType;
  readonly title: string;
  readonly priority: number;
  readonly priorityLabel: PriorityLabel;
  readonly status: string;
  readonly stage: string;
  readonly concept: string | null;
  readonly sourceTitle: string | null;
  readonly sourceLocationLabel: string | null;
  readonly dueAt: string | null;
  /** The load-bearing FSRS-vs-attention scheduler signals for the detail chip. */
  readonly scheduler: SchedulerSignals;
  readonly due: QueueDueState;
  readonly dueLabel: string;
}

/**
 * DRILL-DOWN faceted counts. Each dimension's counts respect ALL OTHER active
 * filters but NOT its own value, so the number next to a facet value equals the
 * rows you get when that value is selected alongside the other active filters
 * (the count always matches the visible list). `byConcept` is keyed by concept
 * element id — the filterbar concept chip MUST use this, not `ConceptNode.memberCount`.
 */
export interface LibraryBrowseCounts {
  /** The rendered-row total: equals `items.length` (post-limit, pre-title-narrow). */
  readonly all: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly byConcept: Readonly<Record<string, number>>;
  readonly byPriority: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
}

export interface LibraryBrowseResult {
  readonly items: readonly LibraryItem[];
  readonly counts: LibraryBrowseCounts;
}

// ---------------------------------------------------------------------------
// trash.* / undo.*  (T044 — deletion, trash & undo)
// ---------------------------------------------------------------------------

/** A flat trash row for the Trash view. */
export interface TrashItemSummary {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly deletedAt: string;
  /** The status the element had BEFORE delete (what restore returns it to). */
  readonly originStatus: string;
  readonly sourceTitle: string | null;
}

export interface TrashListResult {
  readonly items: readonly TrashItemSummary[];
}

export interface TrashRestoreRequest {
  readonly id: string;
}

export interface TrashRestoreResult {
  readonly item: ElementSummary | null;
}

export interface TrashPurgeRequest {
  readonly id: string;
}

export interface TrashPurgeResult {
  readonly purged: number;
}

export interface TrashEmptyResult {
  readonly purged: number;
}

/** The outcome of `undo.last()` — the general command-level undo. */
export interface UndoLastResult {
  readonly undone: boolean;
  readonly opType: string | null;
  readonly elementId: string | null;
  readonly label: string;
  readonly reason?: string;
  readonly count: number;
}

// ---------------------------------------------------------------------------
// analytics.*  (T045 — the system-wide learning-health snapshot)
// ---------------------------------------------------------------------------

/** `analytics.get()` request — both fields optional (defaults applied main-side). */
export interface AnalyticsGetRequest {
  readonly asOf?: string;
  readonly windowDays?: number;
}

/** One calendar day's review count for the spark. `date` is `YYYY-MM-DD` (local). */
export interface AnalyticsReviewsByDay {
  readonly date: string;
  readonly count: number;
}

/** The flat analytics snapshot the Analytics screen renders. */
export interface AnalyticsGetResult {
  readonly asOf: string;
  readonly windowDays: number;
  readonly reviewsByDay: readonly AnalyticsReviewsByDay[];
  readonly reviewsTotal: number;
  readonly reviewsPerDayAvg: number;
  /** Fraction of window reviews graded not-`again` (`[0,1]`), or `null` if none. */
  readonly retention30d: number | null;
  readonly dueCards: number;
  readonly dueTopics: number;
  readonly newCards: number;
  readonly newExtracts: number;
  readonly deletions: number;
  readonly leeches: number;
  readonly dayStreak: number;
}

// ---------------------------------------------------------------------------
// balance.*  (T046 — the import/process balance warning)
// ---------------------------------------------------------------------------

/** `balance.get()` request — both fields optional (defaults applied main-side). */
export interface BalanceGetRequest {
  readonly asOf?: string;
  readonly windowDays?: number;
}

/** Coarse imbalance severity: `ok` hides the banner; `warn`/`danger` show it. */
export type BalanceSeverity = "ok" | "warn" | "danger";

/** The flat import/process balance snapshot the inbox + analytics banner read. */
export interface BalanceGetResult {
  readonly asOf: string;
  readonly windowDays: number;
  readonly sourcesImported: number;
  readonly extractsCreated: number;
  readonly cardsCreated: number;
  readonly reviewsDueThisWeek: number;
  readonly imbalanced: boolean;
  readonly severity: BalanceSeverity;
}

// ---------------------------------------------------------------------------
// backups.*  (T047 — Electron-managed backup/export of the canonical store)
// ---------------------------------------------------------------------------

/** What `backups.create()` returns — only display-safe metadata, no raw fs access. */
export interface BackupsCreateResult {
  /** Absolute path to the produced `.zip` archive (for display only). */
  readonly path: string;
  /** The filesystem-safe timestamp the backup is named with. */
  readonly timestamp: string;
  /** Total size of the `.zip` archive in bytes. */
  readonly sizeBytes: number;
  /** Number of files captured (`app.sqlite` + every asset file). */
  readonly fileCount: number;
  /** The captured schema version (the latest applied Drizzle migration tag). */
  readonly schemaVersion: string;
}

/** The exact shape the preload exposes as `window.appApi`. */
export interface AppApi {
  readonly app: {
    health(): Promise<HealthResult>;
  };
  readonly db: {
    getStatus(): Promise<DbStatus>;
  };
  readonly settings: {
    get(request?: SettingsGetRequest): Promise<SettingsGetResult>;
    update(request: SettingsUpdateRequest): Promise<SettingsUpdateResult>;
    getAll(): Promise<SettingsGetAllResult>;
    updateMany(request: SettingsUpdateManyRequest): Promise<SettingsUpdateManyResult>;
  };
  readonly inspector: {
    list(): Promise<InspectorListResult>;
    get(request: InspectorGetRequest): Promise<InspectorGetResult>;
  };
  readonly elements: {
    setPriority(request: ElementsSetPriorityRequest): Promise<ElementsSetPriorityResult>;
  };
  readonly queue: {
    list(request?: QueueListRequest): Promise<QueueListResult>;
    act(request: QueueActRequest): Promise<QueueActResult>;
    schedule(request: QueueScheduleRequest): Promise<QueueScheduleResult>;
    undo(request: QueueUndoRequest): Promise<QueueUndoResult>;
    autoPostpone(request?: QueueAutoPostponeRequest): Promise<AutoPostponePreview>;
    autoPostponeApply(request?: QueueAutoPostponeRequest): Promise<AutoPostponeApplyResult>;
    catchUp(request?: QueueCatchUpRequest): Promise<CatchUpPreview>;
    catchUpApply(request?: QueueCatchUpRequest): Promise<RecoveryApplyResult>;
    vacation(request: QueueVacationRequest): Promise<VacationPreview>;
    vacationApply(request: QueueVacationRequest): Promise<RecoveryApplyResult>;
  };
  readonly lineage: {
    get(request: LineageGetRequest): Promise<LineageGetResult>;
  };
  readonly sources: {
    importManual(request: SourcesImportManualRequest): Promise<SourcesImportManualResult>;
    importUrl(request: SourcesImportUrlRequest): Promise<SourcesImportUrlResult>;
    importPdf(request: SourcesImportPdfRequest): Promise<SourcesImportPdfResult>;
    getPdfData(request: SourcesGetPdfDataRequest): Promise<SourcesGetPdfDataResult>;
    pickImportFile(request: PickImportFileRequest): Promise<PickImportFileResult>;
    importEpub(request: SourcesImportEpubRequest): Promise<SourcesImportEpubResult>;
    importMedia(request: SourcesImportMediaRequest): Promise<SourcesImportMediaResult>;
    getMediaData(request: SourcesGetMediaDataRequest): Promise<SourcesGetMediaDataResult>;
    importDocument(request: SourcesImportDocumentRequest): Promise<SourcesImportDocumentResult>;
    importMarkdownText(
      request: SourcesImportMarkdownTextRequest,
    ): Promise<SourcesImportDocumentResult>;
    importHighlights(
      request: SourcesImportHighlightsRequest,
    ): Promise<SourcesImportHighlightsResult>;
    extractRegion(request: SourcesExtractRegionRequest): Promise<SourcesExtractRegionResult>;
    getRegionImage(request: SourcesGetRegionImageRequest): Promise<SourcesGetRegionImageResult>;
    extractClip(request: SourcesExtractClipRequest): Promise<SourcesExtractClipResult>;
    runOcr(request: SourcesRunOcrRequest): Promise<SourcesRunOcrResult>;
    getOcr(request: SourcesGetOcrRequest): Promise<SourcesGetOcrResult>;
    acceptOcr(request: SourcesAcceptOcrRequest): Promise<SourcesAcceptOcrResult>;
    dismissOcr(request: SourcesAcceptOcrRequest): Promise<{ dismissed: boolean }>;
  };
  readonly capture: {
    getPairing(): Promise<CapturePairingResult>;
    regenerateToken(): Promise<CaptureRegenerateTokenResult>;
    setEnabled(request: CaptureSetEnabledRequest): Promise<CaptureSetEnabledResult>;
  };
  readonly inbox: {
    list(): Promise<InboxListResult>;
    get(request: InboxGetRequest): Promise<InboxGetResult>;
    triage(request: InboxTriageRequest): Promise<InboxTriageResult>;
  };
  readonly documents: {
    get(request: DocumentsGetRequest): Promise<DocumentsGetResult>;
    save(request: DocumentsSaveRequest): Promise<DocumentsSaveResult>;
    exportMarkdown(request: DocumentsExportMarkdownRequest): Promise<DocumentsExportMarkdownResult>;
    readonly marks: {
      add(request: DocumentMarksAddRequest): Promise<DocumentMarksAddResult>;
      remove(request: DocumentMarksRemoveRequest): Promise<DocumentMarksRemoveResult>;
      list(request: DocumentMarksListRequest): Promise<DocumentMarksListResult>;
    };
  };
  readonly extractions: {
    create(request: ExtractionCreateRequest): Promise<ExtractionCreateResult>;
  };
  readonly cards: {
    create(request: CardsCreateRequest): Promise<CardsCreateResult>;
    generateOcclusion(
      request: CardsGenerateOcclusionRequest,
    ): Promise<CardsGenerateOcclusionResult>;
    update(request: CardsUpdateRequest): Promise<CardsUpdateResult>;
    suspend(request: CardsSuspendRequest): Promise<CardsSuspendResult>;
    delete(request: CardsDeleteRequest): Promise<CardsDeleteResult>;
    flag(request: CardsFlagRequest): Promise<CardsFlagResult>;
    markLeech(request: CardsMarkLeechRequest): Promise<CardsMarkLeechResult>;
    importAnki(request: CardsImportAnkiRequest): Promise<CardsImportAnkiResult>;
    exportAnki(request: CardsExportAnkiRequest): Promise<CardsExportAnkiResult>;
  };
  readonly extracts: {
    updateStage(request: ExtractsUpdateStageRequest): Promise<ExtractsUpdateStageResult>;
    rewrite(request: ExtractsRewriteRequest): Promise<ExtractsRewriteResult>;
    postpone(request: ExtractsPostponeRequest): Promise<ExtractsPostponeResult>;
    markDone(request: ExtractsMarkDoneRequest): Promise<ExtractsMarkDoneResult>;
    delete(request: ExtractsDeleteRequest): Promise<ExtractsDeleteResult>;
  };
  readonly review: {
    sessionNext(request?: ReviewSessionNextRequest): Promise<ReviewSessionNextResult>;
    card(request: ReviewCardRequest): Promise<ReviewCardResult>;
    preview(request: ReviewPreviewRequest): Promise<ReviewPreviewResult>;
    grade(request: ReviewGradeRequest): Promise<ReviewGradeResult>;
    leeches(): Promise<ReviewLeechesResult>;
  };
  readonly concepts: {
    create(request: ConceptsCreateRequest): Promise<ConceptsCreateResult>;
    list(): Promise<ConceptsListResult>;
    assign(request: ConceptsAssignRequest): Promise<ConceptsAssignResult>;
    unassign(request: ConceptsUnassignRequest): Promise<ConceptsUnassignResult>;
    members(request: ConceptsMembersRequest): Promise<ConceptsMembersResult>;
  };
  readonly retention: {
    get(): Promise<RetentionGetResult>;
    setBand(request: RetentionSetBandRequest): Promise<RetentionUpdatedResult>;
    setBandEnabled(request: RetentionSetBandEnabledRequest): Promise<RetentionUpdatedResult>;
    setConcept(request: RetentionSetConceptRequest): Promise<RetentionSetConceptResult>;
    setCard(request: RetentionSetCardRequest): Promise<RetentionSetCardResult>;
    resolveFor(request: RetentionResolveForRequest): Promise<RetentionResolveForResult>;
  };
  readonly optimization: {
    suggest(request: OptimizationSuggestRequest): Promise<OptimizationSuggestResult>;
    apply(request: OptimizationApplyRequest): Promise<OptimizationApplyResult>;
  };
  readonly workload: {
    simulate(request: WorkloadSimulateRequest): Promise<WorkloadSimulateResult>;
  };
  readonly tags: {
    list(): Promise<TagsListResult>;
    add(request: TagsAddRequest): Promise<TagsAddResult>;
    remove(request: TagsRemoveRequest): Promise<TagsRemoveResult>;
  };
  readonly search: {
    query(request: SearchQueryRequest): Promise<SearchQueryResult>;
  };
  readonly library: {
    browse(request?: LibraryBrowseRequest): Promise<LibraryBrowseResult>;
  };
  readonly readPoints: {
    get(request: ReadPointGetRequest): Promise<ReadPointGetResult>;
    set(request: ReadPointSetRequest): Promise<ReadPointSetResult>;
  };
  readonly trash: {
    list(): Promise<TrashListResult>;
    restore(request: TrashRestoreRequest): Promise<TrashRestoreResult>;
    purge(request: TrashPurgeRequest): Promise<TrashPurgeResult>;
    empty(): Promise<TrashEmptyResult>;
  };
  readonly undo: {
    last(): Promise<UndoLastResult>;
  };
  readonly analytics: {
    get(request?: AnalyticsGetRequest): Promise<AnalyticsGetResult>;
  };
  readonly balance: {
    get(request?: BalanceGetRequest): Promise<BalanceGetResult>;
  };
  readonly backups: {
    create(): Promise<BackupsCreateResult>;
  };
  readonly jobs: {
    /** Observe the on-device background-runner queue (T058) — read-only. */
    list(request?: JobsListRequest): Promise<JobsListResult>;
    /** Subscribe to runner job updates (T058); returns an unsubscribe fn. */
    subscribe(callback: (summary: JobSummary) => void): () => void;
  };
  readonly vault: {
    /** Verify asset-vault integrity (T059) — re-hash stored bytes; read-only. */
    verify(): Promise<VaultVerifyResult>;
    /** Find orphaned vault files (T059) — unreferenced bytes; read-only. */
    findOrphans(): Promise<VaultOrphansResult>;
    /** Remove confirmed orphan files (T059) — guarded by `confirm: true`. */
    collectOrphans(request: VaultCollectOrphansRequest): Promise<VaultCollectOrphansResult>;
  };
  readonly menu: {
    /** Subscribe to the native Help → "Keyboard shortcuts" menu item (T048). */
    onShowShortcuts(callback: () => void): () => void;
    /** Subscribe to the native File → "Back up…" menu item (T050). */
    onCreateBackup(callback: () => void): () => void;
  };
}

declare global {
  interface Window {
    /** Present only when running inside the Electron desktop shell. */
    appApi?: AppApi;
  }
}

/** True when running inside the Electron desktop shell. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && typeof window.appApi !== "undefined";
}

/**
 * Return the bridge, throwing a clear error when the renderer is not running in
 * the desktop shell. Use when a capability genuinely requires desktop mode.
 */
export function requireAppApi(): AppApi {
  if (!isDesktop() || !window.appApi) {
    throw new Error(
      "window.appApi is unavailable — the renderer is not running inside the Electron desktop shell.",
    );
  }
  return window.appApi;
}

/** The typed client. All methods reach the main process over validated IPC. */
export const appApi = {
  /** Liveness/readiness probe. */
  health(): Promise<HealthResult> {
    return requireAppApi().app.health();
  },
  /** Local SQLite status. */
  dbStatus(): Promise<DbStatus> {
    return requireAppApi().db.getStatus();
  },
  /** Read one setting (by key) or all settings. */
  getSettings(request?: SettingsGetRequest): Promise<SettingsGetResult> {
    return requireAppApi().settings.get(request);
  },
  /** Create/overwrite a setting; persists to SQLite. */
  updateSetting(request: SettingsUpdateRequest): Promise<SettingsUpdateResult> {
    return requireAppApi().settings.update(request);
  },
  /** Read the complete, validated typed settings (T011). */
  getAppSettings(): Promise<SettingsGetAllResult> {
    return requireAppApi().settings.getAll();
  },
  /** Apply a validated partial patch to the typed settings (T011). */
  updateAppSettings(request: SettingsUpdateManyRequest): Promise<SettingsUpdateManyResult> {
    return requireAppApi().settings.updateMany(request);
  },
  /** All live element summaries for the inspector's selection picker (read-only). */
  listInspectableElements(): Promise<InspectorListResult> {
    return requireAppApi().inspector.list();
  },
  /** The full inspector payload for one element (read-only). */
  getInspectorData(request: InspectorGetRequest): Promise<InspectorGetResult> {
    return requireAppApi().inspector.get(request);
  },
  /**
   * Set / raise / lower an element's priority (T027) — the universal priority
   * write path. Logs `update_element`; returns the new numeric value + A/B/C/D label.
   */
  setElementPriority(request: ElementsSetPriorityRequest): Promise<ElementsSetPriorityResult> {
    return requireAppApi().elements.setPriority(request);
  },
  /**
   * The unified, sorted, filtered due queue (T029) — due cards (FSRS) AND due
   * attention items, sorted priority-then-due-date, with type/concept/status
   * filters + per-type counts + the budget gauge. Read-only.
   */
  listQueue(request?: QueueListRequest): Promise<QueueListResult> {
    return requireAppApi().queue.list(request);
  },
  /**
   * Apply one in-place queue action (T030) — postpone / raise / lower / done /
   * dismiss / delete. One transaction + the correct existing op; attention items
   * postpone on the attention scheduler, cards defer on FSRS; delete is soft + undoable.
   */
  actOnQueueItem(request: QueueActRequest): Promise<QueueActResult> {
    return requireAppApi().queue.act(request);
  },
  /**
   * Schedule a non-card attention item for an EXPLICIT return (T028) — tomorrow /
   * next week / next month / a manual date. Runs through the attention-scheduler
   * apply seam (`reschedule_element`, status → `scheduled`); cards are rejected
   * (FSRS schedules cards). Returns the new `due_at` + interval.
   */
  scheduleQueueItem(request: QueueScheduleRequest): Promise<QueueScheduleResult> {
    return requireAppApi().queue.schedule(request);
  },
  /**
   * Undo a removing queue action (T030) — restore a soft-deleted row or re-set the
   * prior status (done/dismiss). Reuses the typed surface; appends the right op.
   */
  undoQueueAction(request: QueueUndoRequest): Promise<QueueUndoResult> {
    return requireAppApi().queue.undo(request);
  },
  /**
   * Preview the overload auto-postpone (T077) — READ-ONLY. Returns what would move
   * (low-priority topics first, then low-priority mature cards; high-priority fragile
   * cards protected), from→to + why, so the user sees the cost before committing.
   */
  previewAutoPostpone(request?: QueueAutoPostponeRequest): Promise<AutoPostponePreview> {
    return requireAppApi().queue.autoPostpone(request);
  },
  /**
   * Apply the overload auto-postpone (T077) — transactional, one `batchId`. Postpones the
   * planned items through their correct scheduler (attention reschedule / FSRS card defer,
   * memory state untouched, no review log). Undo via the existing batch undo (`undo.last`).
   */
  applyAutoPostpone(request?: QueueAutoPostponeRequest): Promise<AutoPostponeApplyResult> {
    return requireAppApi().queue.autoPostponeApply(request);
  },
  /**
   * Preview the CATCH-UP plan (T078) — READ-ONLY. Spreads the overdue backlog forward so each
   * day ≤ budget (high-value/fragile first) and returns the COST (the per-day load curve before
   * vs after + the slips) so the user sees it before committing.
   */
  previewCatchUp(request?: QueueCatchUpRequest): Promise<CatchUpPreview> {
    return requireAppApi().queue.catchUp(request);
  },
  /**
   * Apply the CATCH-UP plan (T078) — transactional, one `batchId`. Reschedules attention items +
   * defers cards to their EXACT planned days (memory state untouched, no review log). Undo via
   * the existing batch undo (`undo.last`).
   */
  applyCatchUp(request?: QueueCatchUpRequest): Promise<RecoveryApplyResult> {
    return requireAppApi().queue.catchUpApply(request);
  },
  /**
   * Preview the VACATION plan (T078) — READ-ONLY. Finds what would come due in the away window,
   * chooses suspend (fragile cards) vs shift-past-return (the rest), and returns the COST (the
   * after-return load curve + slips) so the user sees it before committing.
   */
  previewVacation(request: QueueVacationRequest): Promise<VacationPreview> {
    return requireAppApi().queue.vacation(request);
  },
  /**
   * Apply the VACATION plan (T078) — transactional, one `batchId`. Suspends fragile cards (prior
   * status captured) + shifts the rest past return. Resume via the existing batch undo (`undo.last`).
   */
  applyVacation(request: QueueVacationRequest): Promise<RecoveryApplyResult> {
    return requireAppApi().queue.vacationApply(request);
  },
  /** The full, depth-tagged lineage tree for one element (read-only) (T023). */
  getLineage(request: LineageGetRequest): Promise<LineageGetResult> {
    return requireAppApi().lineage.get(request);
  },
  /** Create a source in the inbox with its body (T012 + T013). */
  importManualSource(request: SourcesImportManualRequest): Promise<SourcesImportManualResult> {
    return requireAppApi().sources.importManual(request);
  },
  /** Fetch + clean + snapshot a live URL into an inbox source (T060). */
  importUrlSource(request: SourcesImportUrlRequest): Promise<SourcesImportUrlResult> {
    return requireAppApi().sources.importUrl(request);
  },
  /**
   * Import a local `.pdf` into an inbox source (T064) — opens a MAIN file picker,
   * streams the original into the vault, parses per-page text, and creates a
   * paginated source. `"cancelled"` when the picker is dismissed; a thrown
   * `PdfImportError` (a `code: message` line) surfaces a friendly message.
   */
  importPdfSource(request: SourcesImportPdfRequest): Promise<SourcesImportPdfResult> {
    return requireAppApi().sources.importPdf(request);
  },
  /** Serve a PDF source's original bytes to the renderer for rendering (T064). */
  getSourcePdfData(request: SourcesGetPdfDataRequest): Promise<SourcesGetPdfDataResult> {
    return requireAppApi().sources.getPdfData(request);
  },
  /**
   * Open the native file picker for an import `kind` (T067) — the SHARED picker for
   * all M14 file imports. Returns the chosen path(s) or a cancellation; the renderer
   * passes a chosen path back to the matching import command (e.g. `importEpubSource`).
   */
  pickImportFile(request: PickImportFileRequest): Promise<PickImportFileResult> {
    return requireAppApi().sources.pickImportFile(request);
  },
  /**
   * Import a local `.epub` into an inbox book source + chapter topics (T067) — the
   * renderer passes a path chosen via {@link pickImportFile}; MAIN reads + validates +
   * streams the original into the vault + parses the book, all main-side. A thrown
   * `EpubImportError` (a `code: message` line) surfaces a friendly message.
   */
  importEpubSource(request: SourcesImportEpubRequest): Promise<SourcesImportEpubResult> {
    return requireAppApi().sources.importEpub(request);
  },
  /**
   * Import a LOCAL media file into an inbox source (T073) — the renderer passes a media
   * path chosen via {@link pickImportFile} (kind `media`) + an optional sidecar subtitle
   * path; MAIN reads + streams the original into the vault + parses the transcript. A
   * thrown `MediaImportError` (a `code: message` line) surfaces a friendly message.
   */
  importMediaSource(request: SourcesImportMediaRequest): Promise<SourcesImportMediaResult> {
    return requireAppApi().sources.importMedia(request);
  },
  /** Serve a media source's playable data (T073) — `media://` URL or YouTube id. */
  getMediaData(request: SourcesGetMediaDataRequest): Promise<SourcesGetMediaDataResult> {
    return requireAppApi().sources.getMediaData(request);
  },
  /**
   * Import a local `.md`/`.html` file into an inbox source (T068) — the renderer passes
   * a path chosen via {@link pickImportFile} + the format; MAIN reads + parses +
   * persists, all main-side. A thrown `DocumentImportError` surfaces a friendly message.
   */
  importDocumentSource(
    request: SourcesImportDocumentRequest,
  ): Promise<SourcesImportDocumentResult> {
    return requireAppApi().sources.importDocument(request);
  },
  /** Import PASTED Markdown into an inbox source (T068) — the paste path, no file read. */
  importMarkdownText(
    request: SourcesImportMarkdownTextRequest,
  ): Promise<SourcesImportDocumentResult> {
    return requireAppApi().sources.importMarkdownText(request);
  },
  /**
   * Import a Readwise/Kindle highlight export into inbox `extract`s grouped under one
   * `source` per book/article (T069) — the renderer passes a path chosen via
   * {@link pickImportFile}; MAIN reads + parses + persists, all main-side. The result
   * carries the detected format + per-import counts. A thrown `HighlightImportError`
   * (a `code: message` line) surfaces a friendly message.
   */
  importHighlights(
    request: SourcesImportHighlightsRequest,
  ): Promise<SourcesImportHighlightsResult> {
    return requireAppApi().sources.importHighlights(request);
  },
  /**
   * Export a document (source/extract/topic) to a `.md` in the managed `exports/` vault
   * (T068). Read-only on the DB; returns the written path. MAIN owns the path — the
   * renderer never picks it.
   */
  exportDocumentMarkdown(
    request: DocumentsExportMarkdownRequest,
  ): Promise<DocumentsExportMarkdownResult> {
    return requireAppApi().documents.exportMarkdown(request);
  },
  /**
   * Crop a PDF page region into a scheduled `media_fragment` extract (T065) — ships
   * the cropped PNG + the normalized rect + page; MAIN streams the bytes into the
   * vault and creates the region extract + its page+region source location.
   */
  extractRegion(request: SourcesExtractRegionRequest): Promise<SourcesExtractRegionResult> {
    return requireAppApi().sources.extractRegion(request);
  },
  /** Serve a region extract's cropped image bytes to the renderer (T065). */
  getRegionImage(request: SourcesGetRegionImageRequest): Promise<SourcesGetRegionImageResult> {
    return requireAppApi().sources.getRegionImage(request);
  },
  /**
   * Clip a media span into a scheduled `media_fragment` extract (T074) — ships only
   * the `{ startMs, endMs }` + the source id + the anchor block id + the (optional)
   * transcript segment; MAIN creates the fragment + its clip source location in one
   * transaction. NO re-encoding — the clip references the original media.
   */
  extractClip(request: SourcesExtractClipRequest): Promise<SourcesExtractClipResult> {
    return requireAppApi().sources.extractClip(request);
  },
  /**
   * Run OCR on a scanned/text-free PDF page (T066) — ships the rendered page PNG;
   * MAIN writes it to the vault + enqueues an `ocr` job on the T058 runner (DB-free
   * `tesseract.js` worker, offline). Observe progress via `subscribeJobs`.
   */
  runOcr(request: SourcesRunOcrRequest): Promise<SourcesRunOcrResult> {
    return requireAppApi().sources.runOcr(request);
  },
  /** Read a PDF source's OCR suggestion layer — per-page text + confidence (T066). */
  getOcr(request: SourcesGetOcrRequest): Promise<SourcesGetOcrResult> {
    return requireAppApi().sources.getOcr(request);
  },
  /**
   * Accept a page's OCR text into the body (T066) — merges it via `documents.save`
   * (logs `update_document`), making it searchable/extractable; sets `accepted`.
   */
  acceptOcr(request: SourcesAcceptOcrRequest): Promise<SourcesAcceptOcrResult> {
    return requireAppApi().sources.acceptOcr(request);
  },
  /** Dismiss a page's OCR suggestion (T066) — sets `dismissed`. */
  dismissOcr(request: SourcesAcceptOcrRequest): Promise<{ dismissed: boolean }> {
    return requireAppApi().sources.dismissOcr(request);
  },
  /** Read the browser-capture pairing state (token + enabled/running/port) (T062). */
  getCapturePairing(): Promise<CapturePairingResult> {
    return requireAppApi().capture.getPairing();
  },
  /** Mint a fresh pairing token — UNPAIRS the current extension (T062). */
  regenerateCaptureToken(): Promise<CaptureRegenerateTokenResult> {
    return requireAppApi().capture.regenerateToken();
  },
  /** Enable/disable the loopback capture server (starts/stops it live) (T062). */
  setCaptureEnabled(request: CaptureSetEnabledRequest): Promise<CaptureSetEnabledResult> {
    return requireAppApi().capture.setEnabled(request);
  },
  /** Live inbox-status source summaries (T012). */
  listInbox(): Promise<InboxListResult> {
    return requireAppApi().inbox.list();
  },
  /** Full preview payload for one inbox item (T012). */
  getInboxItem(request: InboxGetRequest): Promise<InboxGetResult> {
    return requireAppApi().inbox.get(request);
  },
  /** Apply one triage action to an inbox source (T012). */
  triageInboxItem(request: InboxTriageRequest): Promise<InboxTriageResult> {
    return requireAppApi().inbox.triage(request);
  },
  /** Load an element's document body (ProseMirror JSON + plain text) (T015). */
  getDocument(request: DocumentsGetRequest): Promise<DocumentsGetResult> {
    return requireAppApi().documents.get(request);
  },
  /** Upsert an element's document body; logs `update_document` (T015). */
  saveDocument(request: DocumentsSaveRequest): Promise<DocumentsSaveResult> {
    return requireAppApi().documents.save(request);
  },
  /** Add a highlight (or other) mark over a stable block range (T020). */
  addDocumentMark(request: DocumentMarksAddRequest): Promise<DocumentMarksAddResult> {
    return requireAppApi().documents.marks.add(request);
  },
  /** Remove a document mark by id (T020). */
  removeDocumentMark(request: DocumentMarksRemoveRequest): Promise<DocumentMarksRemoveResult> {
    return requireAppApi().documents.marks.remove(request);
  },
  /** List an element's document marks, optionally by kind (T020). */
  listDocumentMarks(request: DocumentMarksListRequest): Promise<DocumentMarksListResult> {
    return requireAppApi().documents.marks.list(request);
  },
  /** Lift selected text into a new independent, attention-scheduled extract (T021). */
  createExtraction(request: ExtractionCreateRequest): Promise<ExtractionCreateResult> {
    return requireAppApi().extractions.create(request);
  },
  /**
   * Author a card (Q&A or cloze) from an extract (T032). One transaction: the card
   * element (`card_draft`) + its `cards` row + an UN-DUE `review_states` row +
   * inherited priority/tags + a `sibling_group` edge. Does NO FSRS math (M7 first-
   * schedules it). Returns the card summary + the (minted/reused) sibling group id.
   */
  createCard(request: CardsCreateRequest): Promise<CardsCreateResult> {
    return requireAppApi().cards.create(request);
  },
  /**
   * Generate N sibling `image_occlusion` cards (T071) from a `media_fragment`
   * image extract + the drawn masks. One transaction: one card per mask, all in one
   * `sibling_group`. Masks are stored SEPARATELY from the base image (the bytes,
   * already in the vault, are NOT sent). Does NO FSRS math (M7 schedules).
   */
  generateOcclusionCards(
    request: CardsGenerateOcclusionRequest,
  ): Promise<CardsGenerateOcclusionResult> {
    return requireAppApi().cards.generateOcclusion(request);
  },
  /**
   * Edit a card's body in review (T038) — prompt/answer (Q&A) or cloze text. Writes
   * the `cards` row + logs `update_element`; never touches lineage / FSRS state.
   */
  updateCard(request: CardsUpdateRequest): Promise<CardsUpdateResult> {
    return requireAppApi().cards.update(request);
  },
  /** Suspend a card in review (T038): status `suspended`; logs `update_element`. */
  suspendCard(request: CardsSuspendRequest): Promise<CardsSuspendResult> {
    return requireAppApi().cards.suspend(request);
  },
  /** Soft-delete a card in review (T038); logs `soft_delete_element`. Recoverable. */
  deleteCard(request: CardsDeleteRequest): Promise<CardsDeleteResult> {
    return requireAppApi().cards.delete(request);
  },
  /** Flag/un-flag a card as bad in review (T038) — non-destructive; logs `update_element`. */
  flagCard(request: CardsFlagRequest): Promise<CardsFlagResult> {
    return requireAppApi().cards.flag(request);
  },
  /**
   * Set/clear a card's durable leech flag (T040) — the manual "Mark leech" button +
   * un-leeching a remediated card. Logs `update_element`. Detection is automatic
   * after ≥4 lapses; this is the manual override.
   */
  markLeechCard(request: CardsMarkLeechRequest): Promise<CardsMarkLeechResult> {
    return requireAppApi().cards.markLeech(request);
  },
  /**
   * Import an Anki `.apkg` deck as `card` elements under a per-deck `source` (T070),
   * preserving review history when available. The renderer passes a path chosen via
   * {@link pickImportFile}; MAIN unwraps the ZIP + reads the embedded collection.
   */
  importAnki(request: CardsImportAnkiRequest): Promise<CardsImportAnkiResult> {
    return requireAppApi().cards.importAnki(request);
  },
  /**
   * Export selected cards to an Anki `.apkg`/CSV in the managed `exports/` vault (T070),
   * carrying source refs OUT to Anki. Read-only on the DB; returns the written path.
   */
  exportAnki(request: CardsExportAnkiRequest): Promise<CardsExportAnkiResult> {
    return requireAppApi().cards.exportAnki(request);
  },
  /** Advance an extract `raw → clean → atomic` (or set a stage); reschedules it (T024). */
  updateExtractStage(request: ExtractsUpdateStageRequest): Promise<ExtractsUpdateStageResult> {
    return requireAppApi().extracts.updateStage(request);
  },
  /** Rewrite/trim an extract's body; logs `update_document` (T024). */
  rewriteExtract(request: ExtractsRewriteRequest): Promise<ExtractsRewriteResult> {
    return requireAppApi().extracts.rewrite(request);
  },
  /** Postpone an extract (reschedule further out + count); logs `reschedule_element` (T024). */
  postponeExtract(request: ExtractsPostponeRequest): Promise<ExtractsPostponeResult> {
    return requireAppApi().extracts.postpone(request);
  },
  /** Mark an extract done (status `done`); logs `update_element` (T024). */
  markExtractDone(request: ExtractsMarkDoneRequest): Promise<ExtractsMarkDoneResult> {
    return requireAppApi().extracts.markDone(request);
  },
  /** Soft-delete an extract; logs `soft_delete_element` (T024). */
  deleteExtract(request: ExtractsDeleteRequest): Promise<ExtractsDeleteResult> {
    return requireAppApi().extracts.delete(request);
  },
  /**
   * The next due card in the active-recall session (T037) — the FSRS deck (cards
   * due by `review_states.due_at`), soonest first, skipping `exclude`d ids. Carries
   * the full card so reveal needs no round-trip. Read-only.
   */
  reviewSessionNext(request?: ReviewSessionNextRequest): Promise<ReviewSessionNextResult> {
    return requireAppApi().review.sessionNext(request);
  },
  /**
   * Fetch ONE card's full reveal-ready view by id (T037/T031) — the same view
   * `reviewSessionNext` ships, TARGETED. The process loop reveals the card under its
   * frozen-order cursor with this. Read-only: no mutation, no `operation_log`.
   */
  reviewCard(request: ReviewCardRequest): Promise<ReviewCardResult> {
    return requireAppApi().review.card(request);
  },
  /**
   * Preview the four next intervals for a card's grade buttons (T037) — PURE, no
   * mutation. The grade buttons render `intervals[rating].label`.
   */
  reviewPreview(request: ReviewPreviewRequest): Promise<ReviewPreviewResult> {
    return requireAppApi().review.preview(request);
  },
  /**
   * Grade a card (T037) — FSRS reschedule + a durable `review_logs` row in ONE
   * transaction (logs `add_review_log`). Records the reveal→grade response time.
   */
  reviewGrade(request: ReviewGradeRequest): Promise<ReviewGradeResult> {
    return requireAppApi().review.grade(request);
  },
  /**
   * The leech cleanup view's read (T040) — every card flagged a leech (auto after
   * ≥4 lapses, or manual) with its lapse count + source. Read-only. Remediation
   * reuses `updateCard` (rewrite) / `suspendCard` / `deleteCard` / `markLeechCard`.
   */
  reviewLeeches(): Promise<ReviewLeechesResult> {
    return requireAppApi().review.leeches();
  },
  /**
   * Create a hierarchical concept (T041) — the `concept`-type element + its
   * `concepts` row, in one transaction. Logs `create_element`. Validates the parent.
   */
  createConcept(request: ConceptsCreateRequest): Promise<ConceptsCreateResult> {
    return requireAppApi().concepts.create(request);
  },
  /** All concepts as a flat hierarchy (id/name/parent + child & member counts) (T041). */
  listConcepts(): Promise<ConceptsListResult> {
    return requireAppApi().concepts.list();
  },
  /**
   * Assign an element to a concept (T041) — add the `concept_membership` edge; logs
   * `add_relation`. Idempotent. Returns the element's `{ concepts, tags }`.
   */
  assignConcept(request: ConceptsAssignRequest): Promise<ConceptsAssignResult> {
    return requireAppApi().concepts.assign(request);
  },
  /** Unassign an element from a concept (T041) — remove the edge; logs `remove_relation`. */
  unassignConcept(request: ConceptsUnassignRequest): Promise<ConceptsUnassignResult> {
    return requireAppApi().concepts.unassign(request);
  },
  /**
   * The LIVE elements assigned to one concept — the `/concepts` knowledge-map
   * drill-in. Backed by the existing `ConceptRepository.elementsForConcept`,
   * enriched main-side (type/title/priority/scheduler/due/source). Read-only.
   */
  conceptMembers(request: ConceptsMembersRequest): Promise<ConceptsMembersResult> {
    return requireAppApi().concepts.members(request);
  },
  /**
   * The current desired-retention targets (T079) — global, per-band enable + map, and
   * each live concept's per-concept target. Read-only.
   */
  getRetention(): Promise<RetentionGetResult> {
    return requireAppApi().retention.get();
  },
  /** Set/clear one priority-band target (T079) → settings write; refreshed read. */
  setRetentionBand(request: RetentionSetBandRequest): Promise<RetentionUpdatedResult> {
    return requireAppApi().retention.setBand(request);
  },
  /** Enable/disable the per-band feature (T079) → settings write; refreshed read. */
  setRetentionBandEnabled(
    request: RetentionSetBandEnabledRequest,
  ): Promise<RetentionUpdatedResult> {
    return requireAppApi().retention.setBandEnabled(request);
  },
  /**
   * Set/clear one concept's per-concept target (T079) → `concepts.desired_retention`
   * + `update_element`. Returns the concept's stored target.
   */
  setRetentionConcept(request: RetentionSetConceptRequest): Promise<RetentionSetConceptResult> {
    return requireAppApi().retention.setConcept(request);
  },
  /**
   * Set/clear a card's per-card override (T079) → `cards.desired_retention` +
   * `update_element` (floor-clamped). Card-only.
   */
  setRetentionCard(request: RetentionSetCardRequest): Promise<RetentionSetCardResult> {
    return requireAppApi().retention.setCard(request);
  },
  /**
   * Debug/inspector read (T079): the resolved effective target for one card + which
   * rule won. Read-only.
   */
  resolveRetentionFor(request: RetentionResolveForRequest): Promise<RetentionResolveForResult> {
    return requireAppApi().retention.resolveFor(request);
  },
  /**
   * Estimate a better FSRS parameter set from the review history (T080) — global or
   * per-concept — with a workload-impact preview. Read-only (persists nothing; the
   * user must explicitly apply). An honest history-calibration estimate.
   */
  suggestOptimization(request: OptimizationSuggestRequest): Promise<OptimizationSuggestResult> {
    return requireAppApi().optimization.suggest(request);
  },
  /**
   * Apply an accepted FSRS parameter set (T080) — the only persisting optimization
   * command. Subsequent grades use the new params (no retroactive reschedule).
   */
  applyOptimization(request: OptimizationApplyRequest): Promise<OptimizationApplyResult> {
    return requireAppApi().optimization.apply(request);
  },
  /**
   * Preview how daily load shifts (T081) from altering desired retention, adding cards,
   * or postponing low-priority material — BEFORE committing. Read-only: the projection
   * mutates nothing; the caller `Commit`s the real change via the relevant command.
   */
  simulateWorkload(request: WorkloadSimulateRequest): Promise<WorkloadSimulateResult> {
    return requireAppApi().workload.simulate(request);
  },
  /** All tags with their live usage count (T041) — the library filterbar. */
  listTags(): Promise<TagsListResult> {
    return requireAppApi().tags.list();
  },
  /** Tag an element (T041) — created on demand; logs `add_tag`. Idempotent. */
  addTag(request: TagsAddRequest): Promise<TagsAddResult> {
    return requireAppApi().tags.add(request);
  },
  /** Untag an element (T041); logs `remove_tag`. */
  removeTag(request: TagsRemoveRequest): Promise<TagsRemoveResult> {
    return requireAppApi().tags.remove(request);
  },
  /**
   * Local FTS5 full-text search (T042) over source title/body + extract body +
   * card prompt/answer + tags, ranked best-first. Optional type/concept/tag
   * filters. An empty/malformed query returns `{ results: [] }`.
   */
  searchQuery(request: SearchQueryRequest): Promise<SearchQueryResult> {
    return requireAppApi().search.query(request);
  },
  /**
   * The facet-driven "browse everything" read behind `/library`. DISTINCT from
   * `searchQuery`: it takes NO keyword and lists ALL live elements by default,
   * narrowing only by the type/concept/priority/status facets — and it covers
   * topic/synthesis_note/task, which the FTS-backed search never returns. Each row
   * carries the same scheduler/due/concept/refblock fields as a search/queue row.
   * Read-only.
   */
  libraryBrowse(request?: LibraryBrowseRequest): Promise<LibraryBrowseResult> {
    return requireAppApi().library.browse(request);
  },
  /** Load an element's read-point (resume position), or `null` (T017). */
  getReadPoint(request: ReadPointGetRequest): Promise<ReadPointGetResult> {
    return requireAppApi().readPoints.get(request);
  },
  /** Upsert an element's read-point; logs `set_read_point` (T017). */
  setReadPoint(request: ReadPointSetRequest): Promise<ReadPointSetResult> {
    return requireAppApi().readPoints.set(request);
  },
  /** Every soft-deleted element with its origin context (T044). Read-only. */
  listTrash(): Promise<TrashListResult> {
    return requireAppApi().trash.list();
  },
  /** Restore a soft-deleted element to its prior status; logs `restore_element` (T044). */
  restoreFromTrash(request: TrashRestoreRequest): Promise<TrashRestoreResult> {
    return requireAppApi().trash.restore(request);
  },
  /** PERMANENTLY delete one trashed element — the only hard delete (T044). UI-confirmed. */
  purgeFromTrash(request: TrashPurgeRequest): Promise<TrashPurgeResult> {
    return requireAppApi().trash.purge(request);
  },
  /** PERMANENTLY delete every trashed element in one transaction (T044). UI-confirmed. */
  emptyTrash(): Promise<TrashEmptyResult> {
    return requireAppApi().trash.empty();
  },
  /**
   * Reverse the MOST-RECENT operation from anywhere (T044) — delete / mark-done /
   * suspend / bulk-postpone. The inverse runs through the existing write paths and
   * is itself logged (no new op type).
   */
  undoLast(): Promise<UndoLastResult> {
    return requireAppApi().undo.last();
  },
  /**
   * The system-wide learning-health snapshot (T045) — daily reviews, retention,
   * due cards/topics, new cards/extracts, deletions, leeches — aggregated over the
   * durable tables. Read-only.
   */
  getAnalytics(request?: AnalyticsGetRequest): Promise<AnalyticsGetResult> {
    return requireAppApi().analytics.get(request);
  },
  /**
   * The import/process balance snapshot (T046) — the week's sources imported /
   * extracts created / cards created / reviews due, plus the imbalance judgment
   * that drives the advisory banner on the inbox + analytics. Read-only.
   */
  getBalance(request?: BalanceGetRequest): Promise<BalanceGetResult> {
    return requireAppApi().balance.get(request);
  },
  /**
   * Export the entire local knowledge base (T047) — the consistently checkpointed
   * `app.sqlite` + the asset vault + a versioned, hashed `manifest.json` — into a
   * deterministic `backups/<timestamp>/` directory + a portable `.zip`. Runs
   * entirely in the Electron main process; returns only the final `.zip` path +
   * size + timestamp for display (the renderer never touches the filesystem).
   */
  createBackup(): Promise<BackupsCreateResult> {
    return requireAppApi().backups.create();
  },
  /**
   * Observe the on-device background-runner queue (T058) — read-only. Returns an
   * empty list outside the desktop shell (the renderer never runs a job).
   */
  listJobs(request?: JobsListRequest): Promise<JobsListResult> {
    if (!isDesktop() || !window.appApi?.jobs) return Promise.resolve({ jobs: [] });
    return window.appApi.jobs.list(request);
  },
  /**
   * Subscribe to background-runner job updates (T058) — a `JobSummary` per state
   * change. Returns an unsubscribe fn; a no-op outside the desktop shell.
   */
  subscribeJobs(callback: (summary: JobSummary) => void): () => void {
    if (!isDesktop() || !window.appApi?.jobs) return () => {};
    return window.appApi.jobs.subscribe(callback);
  },
  /**
   * Verify the asset vault's integrity (T059) — re-hash every live asset's stored
   * bytes (streamed) and report mismatched / missing / extra files. Read-only.
   * Outside the desktop shell returns an empty OK report (no vault to verify).
   */
  verifyVault(): Promise<VaultVerifyResult> {
    if (!isDesktop() || !window.appApi?.vault) {
      return Promise.resolve({ ok: 0, mismatched: [], missing: [], extraFiles: [] });
    }
    return window.appApi.vault.verify();
  },
  /**
   * Find orphaned vault FILES (T059) — files no live `assets` row references (the
   * bytes a hard-purge's cascade left behind). Read-only; the candidate set the
   * confirm dialog shows. Outside the desktop shell returns an empty set.
   */
  findVaultOrphans(): Promise<VaultOrphansResult> {
    if (!isDesktop() || !window.appApi?.vault) {
      return Promise.resolve({ orphans: [], totalBytes: 0 });
    }
    return window.appApi.vault.findOrphans();
  },
  /**
   * Remove confirmed orphan files (T059) — guarded by `confirm: true`; never
   * deletes a referenced file. Outside the desktop shell removes nothing.
   */
  collectVaultOrphans(request: VaultCollectOrphansRequest): Promise<VaultCollectOrphansResult> {
    if (!isDesktop() || !window.appApi?.vault) {
      return Promise.resolve({ removed: 0, freedBytes: 0 });
    }
    return window.appApi.vault.collectOrphans(request);
  },
  /**
   * Subscribe to the native Help → "Keyboard shortcuts" (⌘/) menu item (T048). The
   * shell calls this to open the in-app cheat sheet from the menu bar. Returns an
   * unsubscribe fn; a no-op outside the desktop shell.
   */
  onMenuShowShortcuts(callback: () => void): () => void {
    if (!isDesktop() || !window.appApi?.menu) return () => {};
    return window.appApi.menu.onShowShortcuts(callback);
  },
  /**
   * Subscribe to the native File → "Back up…" (⌘B) menu item (T050). The shell
   * calls this to run a backup from the menu bar — the SAME `createBackup()`
   * command the prompt button and ⌘K command use. Returns an unsubscribe fn; a
   * no-op outside the desktop shell.
   */
  onMenuCreateBackup(callback: () => void): () => void {
    if (!isDesktop() || !window.appApi?.menu) return () => {};
    return window.appApi.menu.onCreateBackup(callback);
  },
} as const;
