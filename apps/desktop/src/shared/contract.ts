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

import { z } from "zod";

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
  };
  readonly inspector: {
    /** All live element summaries (read-only) — drives the selection picker. */
    list(): Promise<InspectorListResult>;
    /** The full inspector payload for one element (read-only). */
    get(request: InspectorGetRequest): Promise<InspectorGetResult>;
  };
}
