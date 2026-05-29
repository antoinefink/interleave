/**
 * The IPC contract (T007) — the single source of truth for the narrow typed
 * surface the renderer reaches through `window.appApi`.
 *
 * This module is deliberately framework-free: it imports **no** Electron, no
 * Node, no `better-sqlite3`. It defines, for every command:
 *  - a stable channel name (`IPC_CHANNELS`),
 *  - a Zod schema for the request payload (validated on the **main** side before
 *    any handler runs — never trust the renderer),
 *  - the response type.
 *
 * Both sides import this one file so they cannot drift: the preload bridge and
 * the main-process router use the channels + schemas; the renderer imports the
 * `AppApi` type to type `window.appApi`. There is intentionally **no**
 * `db.query(sql)` channel — the renderer can never run arbitrary SQL.
 */

import {
  type AppSettings,
  DAILY_REVIEW_BUDGET_MAX,
  DAILY_REVIEW_BUDGET_MIN,
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  KEYBOARD_LAYOUTS,
  THEMES,
} from "@interleave/core";
import { z } from "zod";

export type { AppSettings } from "@interleave/core";

// Channel names live in their own dependency-free module so the preload can
// import them without pulling Zod into the sandboxed bundle.
export { IPC_CHANNELS, type IpcChannel } from "./channels";

// ---------------------------------------------------------------------------
// app.health()
// ---------------------------------------------------------------------------

/** `app.health()` takes no arguments. */
export const HealthRequestSchema = z.void();

/**
 * Liveness + readiness for the desktop shell: confirms the app process is up,
 * the SQLite DB is open, and migrations have been applied.
 */
export interface HealthResult {
  /** Always `"ok"` when the IPC round-trip itself succeeded. */
  readonly status: "ok";
  /** App version (from the desktop package). */
  readonly appVersion: string;
  /** Whether the SQLite database handle is open. */
  readonly dbOpen: boolean;
  /** Whether startup migrations have been applied. */
  readonly migrated: boolean;
  /** Server timestamp (ISO-8601) for sanity/debugging. */
  readonly time: string;
}

// ---------------------------------------------------------------------------
// db.getStatus()
// ---------------------------------------------------------------------------

/** `db.getStatus()` takes no arguments. */
export const DbStatusRequestSchema = z.void();

/** Reports the local SQLite database's open/migrated state and pragmas. */
export interface DbStatus {
  readonly open: boolean;
  readonly migrated: boolean;
  /** Effective `journal_mode` pragma (expected `"wal"` for a file DB). */
  readonly journalMode: string;
  /** Effective `foreign_keys` pragma (expected `1`). */
  readonly foreignKeys: number;
  /** Effective `busy_timeout` pragma in ms (expected `5000`). */
  readonly busyTimeoutMs: number;
  /** Number of applied migration entries in the Drizzle journal. */
  readonly appliedMigrations: number;
}

// ---------------------------------------------------------------------------
// settings.get() / settings.update()
// ---------------------------------------------------------------------------

/**
 * A single settings key/value. `value` is arbitrary JSON-serializable data; the
 * `settings` table stores it as JSON text. The M1 surface is intentionally a
 * generic key/value store — typed setting models land with T011.
 */
export const SettingKeySchema = z.string().min(1).max(128);

export const SettingsGetRequestSchema = z.object({
  /** Optional specific key; when omitted, all settings are returned. */
  key: SettingKeySchema.optional(),
});
export type SettingsGetRequest = z.infer<typeof SettingsGetRequestSchema>;

/** A JSON-serializable settings value. */
export type SettingValue =
  | string
  | number
  | boolean
  | null
  | SettingValue[]
  | { [k: string]: SettingValue };

export interface SettingsGetResult {
  /** All requested settings as a key → value map (empty if none match). */
  readonly settings: Readonly<Record<string, SettingValue>>;
}

export const SettingsUpdateRequestSchema = z.object({
  key: SettingKeySchema,
  /** Any JSON-serializable value; persisted as JSON text in the `settings` table. */
  value: z.unknown(),
});
export type SettingsUpdateRequest = z.infer<typeof SettingsUpdateRequestSchema>;

export interface SettingsUpdateResult {
  readonly key: string;
  readonly value: SettingValue;
}

// ---------------------------------------------------------------------------
// settings.getAll() / settings.updateMany()  (T011 — typed AppSettings)
// ---------------------------------------------------------------------------

/**
 * The typed user/domain settings surface (T011). On top of the generic key/value
 * `settings.get/update`, this exposes the validated `AppSettings` model the
 * scheduler + `/settings` UI read: defaults fill any unset key on read, and the
 * patch is validated/clamped on the MAIN side (the renderer is untrusted) before
 * it reaches SQLite. The authoritative model + bounds live in `@interleave/core`.
 */

/** `settings.getAll()` takes no arguments. */
export const SettingsGetAllRequestSchema = z.void();

export interface SettingsGetAllResult {
  /** The complete, validated settings (unset keys resolved to defaults). */
  readonly settings: AppSettings;
}

/**
 * A partial settings patch. Every field is optional + bounded; the main side
 * re-coerces with `@interleave/core` so even a malformed renderer payload cannot
 * write an out-of-range value. Bounds mirror the core model so a bad value is
 * rejected at the boundary rather than silently clamped.
 */
export const SettingsPatchSchema = z
  .object({
    dailyReviewBudget: z.number().int().min(DAILY_REVIEW_BUDGET_MIN).max(DAILY_REVIEW_BUDGET_MAX),
    defaultDesiredRetention: z.number().min(DESIRED_RETENTION_MIN).max(DESIRED_RETENTION_MAX),
    defaultTopicIntervalDays: z.number().int().positive(),
    defaultSourcePriority: z.number().min(0).max(1),
    keyboardLayout: z.enum(KEYBOARD_LAYOUTS),
    theme: z.enum(THEMES),
  })
  .partial()
  .strict();

export const SettingsUpdateManyRequestSchema = z.object({
  /** The partial patch to apply; at least one field should be present. */
  patch: SettingsPatchSchema,
});
export type SettingsUpdateManyRequest = z.infer<typeof SettingsUpdateManyRequestSchema>;

export interface SettingsUpdateManyResult {
  /** The full settings after the patch is applied. */
  readonly settings: AppSettings;
}

// ---------------------------------------------------------------------------
// inspector.list() / inspector.get()  (T010 — read-only)
// ---------------------------------------------------------------------------

/**
 * The universal element inspector (T010) reads any element's metadata + lineage
 * + scheduler signals THROUGH this read-only surface. The renderer never touches
 * SQLite: the main process composes the repositories (ElementRepository,
 * SourceRepository, ReviewRepository, DocumentRepository, …) into the flat,
 * serializable shapes below.
 *
 * `inspector.list()` returns lightweight summaries so the UI can offer a picker
 * (and the rest of the app can set the selected element); `inspector.get(id)`
 * returns the full inspector payload for one element. Both are read-only for M1
 * — editing priority/stage lands with later features.
 */

/** A lightweight summary used by the selection picker / lists. */
export interface ElementSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  readonly dueAt: string | null;
}

/** Which scheduler an element is on — the load-bearing FSRS vs attention split. */
export type SchedulerKind = "fsrs" | "attention";

/**
 * The scheduler signals shown by the `SchedulerChip`/readout. `fsrs` carries
 * memory signals (retrievability/stability/difficulty) for cards; `attention`
 * carries process-again signals (stage/priority/last-processed/postponed×N) for
 * sources/topics/extracts/tasks/synthesis notes.
 */
export interface SchedulerSignals {
  readonly kind: SchedulerKind;
  // FSRS (cards only):
  /** Retrievability `0.0`–`1.0` (probability of recall now), when computable. */
  readonly retrievability: number | null;
  /** FSRS memory stability in days. */
  readonly stability: number | null;
  /** FSRS item difficulty (≈ 1–10). */
  readonly difficulty: number | null;
  readonly reps: number | null;
  readonly lapses: number | null;
  readonly fsrsState: string | null;
  // Attention (everything else):
  /** Distillation stage shown on the attention chip. */
  readonly stage: string;
  /** How many times this element has been postponed. */
  readonly postponed: number;
  /** When it was last processed/reviewed (ISO-8601), when known. */
  readonly lastProcessedAt: string | null;
}

/** A parent/child/source row in the inspector's lineage sections. */
export interface LineageItem {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly stage: string;
}

/** Review history summary for a card (FSRS), read-only. */
export interface ReviewSummary {
  readonly dueAt: string | null;
  readonly stability: number;
  readonly difficulty: number;
  readonly reps: number;
  readonly lapses: number;
  readonly fsrsState: string;
  readonly lastReviewedAt: string | null;
  /** Total durable review-log rows recorded for this card. */
  readonly logCount: number;
}

/** Source provenance shown when the element is (or belongs to) a source. */
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

/** A precise source location (jump-to-paragraph lineage) for an extract/card. */
export interface LocationSummary {
  readonly label: string | null;
  readonly selectedText: string;
  readonly page: number | null;
}

/**
 * The complete inspector payload for one element, assembled by the main process
 * from the repositories. Flat + JSON-serializable so it crosses IPC cleanly.
 */
export interface InspectorData {
  readonly element: ElementSummary;
  readonly scheduler: SchedulerSignals;
  /** Direct parent element (lineage), if any. */
  readonly parent: LineageItem | null;
  /** Live direct children (extracts/sub-extracts/cards), if any. */
  readonly children: readonly LineageItem[];
  /** The owning `source` element (lineage root), if distinct from the element. */
  readonly source: LineageItem | null;
  /** Source provenance when the element is a source. */
  readonly provenance: SourceProvenance | null;
  /** The source location anchoring this element (extract/card), if any. */
  readonly location: LocationSummary | null;
  /** Flat tag names attached to the element. */
  readonly tags: readonly string[];
  /** FSRS review summary for cards; `null` for attention-scheduled elements. */
  readonly review: ReviewSummary | null;
}

export const ElementIdSchema = z.string().min(1).max(128);

/** `inspector.list()` takes no arguments (returns all live element summaries). */
export const InspectorListRequestSchema = z.void();

export interface InspectorListResult {
  readonly elements: readonly ElementSummary[];
}

export const InspectorGetRequestSchema = z.object({
  /** The element id to inspect. */
  id: ElementIdSchema,
});
export type InspectorGetRequest = z.infer<typeof InspectorGetRequestSchema>;

export interface InspectorGetResult {
  /** The inspector payload, or `null` when the id is unknown/soft-deleted. */
  readonly data: InspectorData | null;
}

// ---------------------------------------------------------------------------
// sources.importManual() / inbox.list() / inbox.get() / inbox.triage()  (T012)
// ---------------------------------------------------------------------------

/**
 * The first MUTATION surface on the bridge (T012). The renderer can create a
 * source in the `inbox`, list/preview inbox-status sources, change their
 * priority (A/B/C/D), accept them into active learning, keep them for later, or
 * delete them — every action validated main-side, run in ONE transaction, and
 * logged to `operation_log`. There is still no generic `db.query`.
 */

/** The four coarse priority labels the UI exposes (numeric mapping lives in core). */
export const PriorityLabelSchema = z.enum(["A", "B", "C", "D"]);
export type PriorityLabelInput = z.infer<typeof PriorityLabelSchema>;

/**
 * Create a source in the `inbox` (T012 landed title-only; T013 adds the body).
 * `title` is required (1–512 chars); provenance fields + priority label are
 * optional (priority defaults to `C` so new material never dominates). `body` is
 * the raw pasted article text — the MAIN process converts it to plain text +
 * ProseMirror JSON (the renderer never builds the doc) and stores both. The
 * `publishedAt` "date" field is a loose date string stored as-is.
 *
 * Provenance (T014, no remote fetching): the renderer MAY pass
 * `canonicalUrl`/`originalUrl`/`accessedAt`/`snapshotKey`, but they are optional
 * and normally left out — the MAIN process derives the canonical URL from `url`,
 * preserves the as-entered URL as `originalUrl`, and auto-stamps `accessedAt` to
 * "now". `snapshotKey` stays `null` in M2 (no snapshot is fetched). `body` is
 * capped to keep IPC payloads bounded.
 */
export const SourcesImportManualRequestSchema = z.object({
  title: z.string().trim().min(1).max(512),
  url: z.string().trim().max(2048).optional(),
  /** Normalized URL; usually omitted — the main process derives it from `url`. */
  canonicalUrl: z.string().trim().max(2048).optional(),
  /** As-entered URL; usually omitted — the main process sets it from `url`. */
  originalUrl: z.string().trim().max(2048).optional(),
  author: z.string().trim().max(512).optional(),
  publishedAt: z.string().trim().max(64).optional(),
  /** ISO accessed date; usually omitted — the main process auto-stamps "now". */
  accessedAt: z.string().trim().max(64).optional(),
  /** Vault-relative snapshot key; stays absent in M2 (no snapshot is fetched). */
  snapshotKey: z.string().trim().max(2048).optional(),
  /** Raw pasted body text; converted to plain text + ProseMirror JSON main-side. */
  body: z.string().max(2_000_000).optional(),
  reasonAdded: z.string().trim().max(2048).optional(),
  /** Coarse A/B/C/D priority; mapped to a numeric value main-side. Defaults `C`. */
  priority: PriorityLabelSchema.optional(),
});
export type SourcesImportManualRequest = z.infer<typeof SourcesImportManualRequestSchema>;

/** A flat, list-row summary for one inbox source. */
export interface InboxItemSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** Provenance source-type label (M2: always "Manual note"). */
  readonly srcType: string;
  readonly author: string | null;
  readonly accessedAt: string | null;
  /** Character count of the document body, if any. */
  readonly charCount: number;
  /** A short plain-text preview snippet (first ~160 chars), or `null`. */
  readonly previewSnippet: string | null;
}

export interface SourcesImportManualResult {
  /** The new source element id. */
  readonly id: string;
  /** The fresh inbox summary for the created source. */
  readonly item: InboxItemSummary;
}

/** `inbox.list()` takes no arguments. */
export const InboxListRequestSchema = z.void();

export interface InboxListResult {
  readonly items: readonly InboxItemSummary[];
}

export const InboxGetRequestSchema = z.object({
  id: ElementIdSchema,
});
export type InboxGetRequest = z.infer<typeof InboxGetRequestSchema>;

/** Full preview payload for one inbox item (summary + provenance + body preview). */
export interface InboxItemDetail {
  readonly summary: InboxItemSummary;
  readonly provenance: SourceProvenance;
  /** A longer plain-text body preview (first ~4000 chars), or `null`. */
  readonly bodyPreview: string | null;
}

export interface InboxGetResult {
  /** The inbox detail, or `null` when the id is unknown / not an inbox source. */
  readonly detail: InboxItemDetail | null;
}

/**
 * One triage action applied to an inbox source. A discriminated union so the
 * main side rejects an unknown action at the boundary:
 *  - `accept`      → status `active` (into active learning, leaves the inbox)
 *  - `keepForLater`→ status `dismissed` (set aside, leaves the inbox)
 *  - `setPriority` → numeric priority from the A/B/C/D label (status unchanged)
 *  - `delete`      → soft-delete (`deletedAt` + status `deleted`)
 */
export const InboxTriageRequestSchema = z.object({
  id: ElementIdSchema,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("accept") }),
    z.object({ kind: z.literal("keepForLater") }),
    z.object({ kind: z.literal("setPriority"), priority: PriorityLabelSchema }),
    z.object({ kind: z.literal("delete") }),
  ]),
});
export type InboxTriageRequest = z.infer<typeof InboxTriageRequestSchema>;

export interface InboxTriageResult {
  /** The updated summary, or `{ deleted: true }` when the item was soft-deleted. */
  readonly item: InboxItemSummary | null;
  readonly deleted: boolean;
}

// ---------------------------------------------------------------------------
// The typed surface the renderer sees as `window.appApi`.
// ---------------------------------------------------------------------------

/**
 * The complete narrow API the preload exposes. The renderer's typed client
 * wrapper (apps/web) is built against this exact shape; adding a capability
 * means adding a channel + schema here first.
 */
export interface AppApi {
  readonly app: {
    /** Liveness/readiness probe. */
    health(): Promise<HealthResult>;
  };
  readonly db: {
    /** Local SQLite open/migrated status. */
    getStatus(): Promise<DbStatus>;
  };
  readonly settings: {
    /** Read one setting (by key) or all settings (no key). */
    get(request?: SettingsGetRequest): Promise<SettingsGetResult>;
    /** Create/overwrite one setting; persists to SQLite. */
    update(request: SettingsUpdateRequest): Promise<SettingsUpdateResult>;
    /** Read the complete, validated typed {@link AppSettings} (T011). */
    getAll(): Promise<SettingsGetAllResult>;
    /** Apply a validated partial patch to the typed settings (T011). */
    updateMany(request: SettingsUpdateManyRequest): Promise<SettingsUpdateManyResult>;
  };
  readonly inspector: {
    /** All live element summaries (read-only) — drives the selection picker. */
    list(): Promise<InspectorListResult>;
    /** The full inspector payload for one element (read-only). */
    get(request: InspectorGetRequest): Promise<InspectorGetResult>;
  };
  readonly sources: {
    /** Create a source in the `inbox` (T012; body lands with T013). */
    importManual(request: SourcesImportManualRequest): Promise<SourcesImportManualResult>;
  };
  readonly inbox: {
    /** Inbox-status source summaries (T012). */
    list(): Promise<InboxListResult>;
    /** Full preview payload for one inbox item (T012). */
    get(request: InboxGetRequest): Promise<InboxGetResult>;
    /** Apply one triage action to a source (T012). */
    triage(request: InboxTriageRequest): Promise<InboxTriageResult>;
  };
}
