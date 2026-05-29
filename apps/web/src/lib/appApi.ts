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
  /** Load an element's read-point (resume position), or `null` (T017). */
  getReadPoint(request: ReadPointGetRequest): Promise<ReadPointGetResult> {
    return requireAppApi().readPoints.get(request);
  },
  /** Upsert an element's read-point; logs `set_read_point` (T017). */
  setReadPoint(request: ReadPointSetRequest): Promise<ReadPointSetResult> {
    return requireAppApi().readPoints.set(request);
  },
} as const;
