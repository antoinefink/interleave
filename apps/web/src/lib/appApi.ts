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
  readonly keyboardLayout: KeyboardLayout;
  readonly theme: ThemePreference;
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
  /** The source element this location points INTO — the reader to open on jump (T022). */
  readonly sourceElementId: string;
  /** Ordered STABLE block ids the selection spans (the scroll target is the first). */
  readonly blockIds: readonly string[];
  /** Char offset within the FIRST spanned block (caret target), or `null`. */
  readonly startOffset: number | null;
  /** Char offset within the LAST spanned block, or `null`. */
  readonly endOffset: number | null;
}

export interface InspectorData {
  readonly element: ElementSummary;
  readonly scheduler: SchedulerSignals;
  readonly parent: LineageItem | null;
  readonly children: readonly LineageItem[];
  readonly source: LineageItem | null;
  readonly provenance: SourceProvenance | null;
  readonly location: LocationSummary | null;
  readonly tags: readonly string[];
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

/** Filters the queue read accepts (type/concept/status). */
export interface QueueListRequest {
  /** "Now" the due reads compare against (ISO-8601); defaults to the server clock. */
  readonly asOf?: string;
  readonly types?: readonly string[];
  /** Concept filter (T041 — deferred; wired now for a stable surface). */
  readonly concept?: string;
  readonly statuses?: readonly string[];
}

export interface QueueListResult {
  readonly items: readonly QueueItemSummary[];
  readonly counts: QueueCounts;
  readonly budget: { readonly used: number; readonly target: number };
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
export type CardKind = "qa" | "cloze";

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
}

export interface CardsCreateResult {
  readonly card: CardSummary;
  /** The inherited source-location anchor id (lineage), or `null` when the extract has none. */
  readonly sourceLocationId: string | null;
}

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
    undo(request: QueueUndoRequest): Promise<QueueUndoResult>;
  };
  readonly lineage: {
    get(request: LineageGetRequest): Promise<LineageGetResult>;
  };
  readonly sources: {
    importManual(request: SourcesImportManualRequest): Promise<SourcesImportManualResult>;
  };
  readonly inbox: {
    list(): Promise<InboxListResult>;
    get(request: InboxGetRequest): Promise<InboxGetResult>;
    triage(request: InboxTriageRequest): Promise<InboxTriageResult>;
  };
  readonly documents: {
    get(request: DocumentsGetRequest): Promise<DocumentsGetResult>;
    save(request: DocumentsSaveRequest): Promise<DocumentsSaveResult>;
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
  };
  readonly extracts: {
    updateStage(request: ExtractsUpdateStageRequest): Promise<ExtractsUpdateStageResult>;
    rewrite(request: ExtractsRewriteRequest): Promise<ExtractsRewriteResult>;
    postpone(request: ExtractsPostponeRequest): Promise<ExtractsPostponeResult>;
    markDone(request: ExtractsMarkDoneRequest): Promise<ExtractsMarkDoneResult>;
    delete(request: ExtractsDeleteRequest): Promise<ExtractsDeleteResult>;
  };
  readonly readPoints: {
    get(request: ReadPointGetRequest): Promise<ReadPointGetResult>;
    set(request: ReadPointSetRequest): Promise<ReadPointSetResult>;
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
   * Undo a removing queue action (T030) — restore a soft-deleted row or re-set the
   * prior status (done/dismiss). Reuses the typed surface; appends the right op.
   */
  undoQueueAction(request: QueueUndoRequest): Promise<QueueUndoResult> {
    return requireAppApi().queue.undo(request);
  },
  /** The full, depth-tagged lineage tree for one element (read-only) (T023). */
  getLineage(request: LineageGetRequest): Promise<LineageGetResult> {
    return requireAppApi().lineage.get(request);
  },
  /** Create a source in the inbox with its body (T012 + T013). */
  importManualSource(request: SourcesImportManualRequest): Promise<SourcesImportManualResult> {
    return requireAppApi().sources.importManual(request);
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
  /** Load an element's read-point (resume position), or `null` (T017). */
  getReadPoint(request: ReadPointGetRequest): Promise<ReadPointGetResult> {
    return requireAppApi().readPoints.get(request);
  },
  /** Upsert an element's read-point; logs `set_read_point` (T017). */
  setReadPoint(request: ReadPointSetRequest): Promise<ReadPointSetResult> {
    return requireAppApi().readPoints.set(request);
  },
} as const;
