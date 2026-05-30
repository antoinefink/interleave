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
  MARK_TYPES,
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

/**
 * A precise source location (jump-to-paragraph lineage) for an extract/card.
 *
 * Carries enough to make lineage ACTIONABLE (T022): the renderer resolves a jump
 * target from `sourceElementId` + the ordered stable `blockIds` (+ offsets),
 * opens that source's reader, and scrolls/flashes the originating block — no extra
 * IPC needed (the jump target rides along on `inspector.get`). `label`/
 * `selectedText` give the affordance a name + a never-dead-end snapshot.
 */
export interface LocationSummary {
  readonly label: string | null;
  readonly selectedText: string;
  readonly page: number | null;
  /** The source element this location points INTO (the reader to open on jump). */
  readonly sourceElementId: string;
  /** Ordered STABLE block ids the selection spans (the scroll target is the first). */
  readonly blockIds: readonly string[];
  /** Char offset within the FIRST spanned block (caret target), or `null`. */
  readonly startOffset: number | null;
  /** Char offset within the LAST spanned block, or `null`. */
  readonly endOffset: number | null;
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

/**
 * The four coarse priority labels the UI exposes (numeric mapping lives in core).
 * Defined here (before the inspector/elements sections that reference it) so the
 * universal `elements.setPriority` command (T027) and the inbox triage
 * `setPriority` action share ONE schema.
 */
export const PriorityLabelSchema = z.enum(["A", "B", "C", "D"]);
export type PriorityLabelInput = z.infer<typeof PriorityLabelSchema>;

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
// elements.setPriority()  (T027 — the universal priority write path)
// ---------------------------------------------------------------------------

/**
 * Priority is a first-class, editable axis on EVERY element (T027). It is stored
 * numerically (`elements.priority`, `0.0`–`1.0`) and surfaced as A/B/C/D; this is
 * the single typed command the renderer uses to CHANGE it — from any source,
 * extract, card (and task/topic/synthesis note). The renderer never does priority
 * math: it sends an intent (`set` an explicit A/B/C/D label, or `raise`/`lower`
 * one band), and the MAIN process computes the new numeric value via the
 * `@interleave/core` helpers (`priorityFromLabel`/`raisePriority`/`lowerPriority`)
 * and persists it through `ElementRepository.setPriority` in ONE transaction,
 * appending `update_element` (NO new op type — the closed op set is unchanged).
 * The change is read by the attention scheduler (T028) and the queue sort (T029).
 * There is still no generic `db.query`.
 *
 * `action` is a discriminated union so the main side rejects an unknown intent at
 * the boundary:
 *  - `set`   → store the label's representative numeric value.
 *  - `raise` → step UP one band (clamped at `A`).
 *  - `lower` → step DOWN one band (clamped at `D`).
 */
export const ElementsSetPriorityRequestSchema = z.object({
  /** The element id whose priority to change (any type — priority is universal). */
  id: ElementIdSchema,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("set"), priority: PriorityLabelSchema }),
    z.object({ kind: z.literal("raise") }),
    z.object({ kind: z.literal("lower") }),
  ]),
});
export type ElementsSetPriorityRequest = z.infer<typeof ElementsSetPriorityRequestSchema>;

export interface ElementsSetPriorityResult {
  /**
   * The updated element summary carrying the NEW numeric `priority` + the derived
   * A/B/C/D `priorityLabel`, so the renderer can update the badge without a
   * re-fetch. `null` when the id is unknown / soft-deleted.
   */
  readonly element:
    | (ElementSummary & {
        /** Derived A/B/C/D label for the new numeric `priority`. */
        readonly priorityLabel: PriorityLabelInput;
      })
    | null;
}

// ---------------------------------------------------------------------------
// lineage.get()  (T023 — the full navigable element hierarchy)
// ---------------------------------------------------------------------------

/**
 * The element hierarchy surface (T023). Where `inspector.get` returns ONE hop of
 * lineage (direct parent + children), `lineage.get` returns the WHOLE chain: for
 * any element the main process resolves the lineage ROOT (the owning
 * `source`/`topic`) and walks DOWN through `source → extract → sub-extract → card`
 * into a FLATTENED, depth-tagged node list the renderer renders as the kit's
 * `LineageTree` and navigates in BOTH directions. Read-only — the renderer never
 * re-derives the tree client-side, and there is still no generic `db.query`.
 */

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

export const LineageGetRequestSchema = z.object({
  /** The element id whose lineage tree to build. */
  id: ElementIdSchema,
});
export type LineageGetRequest = z.infer<typeof LineageGetRequestSchema>;

export interface LineageGetResult {
  /** The lineage tree, or `null` when the id is unknown/soft-deleted. */
  readonly lineage: LineageData | null;
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
// documents.get() / documents.save()  (T015 — editable rich-text body)
// ---------------------------------------------------------------------------

/**
 * The document editor surface (T015). The renderer loads an element's body as
 * ProseMirror JSON + its flattened `plainText` mirror, edits it in the
 * constrained Tiptap editor, and saves it back. The MAIN process persists
 * exactly what it receives via `DocumentRepository.upsert` (which logs
 * `update_document`) — it does NOT re-parse ProseMirror; the renderer computes
 * `plainText` with the editor's `toPlainText` so the stored mirror stays in sync
 * with the JSON. There is still no generic `db.query`.
 *
 * `prosemirrorJson` is `z.unknown()` on the wire: the schema is owned by
 * `@interleave/editor`, not the contract, and the body is bounded by the IPC
 * payload limit rather than re-validated structurally here (the renderer already
 * enforced the constrained schema; main-side re-parsing is intentionally out of
 * scope for T015).
 *
 * `blocks` (T016) is the ordered, STABLE block-id list the renderer derives from
 * the document's `blockId` attributes via `@interleave/editor`'s `toBlockInputs`.
 * It is validated structurally here (block type + order + non-empty id) and
 * persisted verbatim into `document_blocks` so every save refreshes the block set
 * while preserving the stable ids extracts/read-points/sync anchor to. When
 * omitted, the main side leaves the existing blocks untouched.
 */

export const DocumentsGetRequestSchema = z.object({
  /** The owning element id whose body to load. */
  elementId: ElementIdSchema,
});
export type DocumentsGetRequest = z.infer<typeof DocumentsGetRequestSchema>;

/** The persisted document body returned to the renderer, or `null` when absent. */
export interface DocumentPayload {
  readonly prosemirrorJson: unknown;
  readonly plainText: string;
  readonly schemaVersion: number;
  readonly updatedAt: string;
}

export interface DocumentsGetResult {
  /** The element's document body, or `null` when no document row exists. */
  readonly document: DocumentPayload | null;
  /**
   * The DISTINCT stable block ids in this source's body that already have a child
   * extract anchored to them (derived main-side from the source's child extracts'
   * `source_location.blockIds`). The reader (T018) renders `mark.extracted`
   * display markers on these blocks. M3 only DISPLAYS these — creating extracts is
   * M4. Empty for elements with no extracted anchors (or non-sources).
   */
  readonly extractedBlockIds: readonly string[];
}

/**
 * One stable block descriptor on the wire (T016): a block type, its 0-based
 * document order, and the STABLE block id (a ULID) read off the editor's
 * `blockId` attribute. The id is the lineage anchor — never re-minted main-side.
 */
export const DocumentBlockInputSchema = z.object({
  blockType: z.string().min(1).max(64),
  order: z.number().int().min(0),
  stableBlockId: z.string().min(1).max(128),
});
export type DocumentBlockInputPayload = z.infer<typeof DocumentBlockInputSchema>;

export const DocumentsSaveRequestSchema = z.object({
  /** The owning element id whose body to upsert. */
  elementId: ElementIdSchema,
  /** The ProseMirror document JSON (schema owned by `@interleave/editor`). */
  prosemirrorJson: z.unknown(),
  /** The flattened plain-text mirror, computed renderer-side via `toPlainText`. */
  plainText: z.string().max(4_000_000),
  /** The schema version the JSON was authored against; defaults to `1`. */
  schemaVersion: z.number().int().positive().optional(),
  /**
   * The ordered stable block list derived renderer-side via `toBlockInputs`
   * (T016). When present, the main side replaces `document_blocks` with it,
   * preserving the stable ids. Bounded to keep IPC payloads sane.
   */
  blocks: z.array(DocumentBlockInputSchema).max(100_000).optional(),
});
export type DocumentsSaveRequest = z.infer<typeof DocumentsSaveRequestSchema>;

export interface DocumentsSaveResult {
  /** The body after the save (the value the renderer should treat as canonical). */
  readonly document: DocumentPayload;
}

// ---------------------------------------------------------------------------
// readPoints.get() / readPoints.set()  (T017 — resume position)
// ---------------------------------------------------------------------------

/**
 * The read-point surface (T017). A read-point is how far the user has processed
 * a source/topic — a STABLE block id (from T016) plus a character offset within
 * that block. There is exactly ONE read-point per element: `readPoints.set`
 * UPSERTS it (it never appends a second row) and the MAIN process appends a
 * `set_read_point` op in the same transaction via {@link DocumentRepository}.
 * Reopening a source loads the read-point alongside the document and resumes
 * near it. There is still no generic `db.query`.
 *
 * The stored `blockId` must reference a real `stableBlockId` from the document;
 * the renderer resolves it from the editor selection. `offset` is a non-negative
 * character offset within the block's text (clamped to the block length on jump).
 * The `markReadThrough` auto-advance-on-extract call site is deferred to T021 —
 * the seam reuses this same `readPoints.set` command.
 */

export const ReadPointGetRequestSchema = z.object({
  /** The owning element id whose read-point to load. */
  elementId: ElementIdSchema,
});
export type ReadPointGetRequest = z.infer<typeof ReadPointGetRequestSchema>;

/** The persisted read-point returned to the renderer, or `null` when unset. */
export interface ReadPointPayload {
  /** The STABLE block id (from T016) the resume position anchors to. */
  readonly blockId: string;
  /** Character offset within the block's text (`>= 0`). */
  readonly offset: number;
  readonly updatedAt: string;
}

export interface ReadPointGetResult {
  /** The element's read-point, or `null` when none has been set yet. */
  readonly readPoint: ReadPointPayload | null;
}

export const ReadPointSetRequestSchema = z.object({
  /** The owning element id (source/topic) the read-point belongs to. */
  elementId: ElementIdSchema,
  /** The element id of the document body the block lives in (usually the same). */
  documentId: ElementIdSchema,
  /** The STABLE block id (from T016) to resume at. */
  blockId: z.string().min(1).max(128),
  /** Character offset within the block's text; non-negative integer. */
  offset: z.number().int().min(0),
});
export type ReadPointSetRequest = z.infer<typeof ReadPointSetRequestSchema>;

export interface ReadPointSetResult {
  /** The read-point after the upsert (the value the renderer treats as canonical). */
  readonly readPoint: ReadPointPayload;
}

// ---------------------------------------------------------------------------
// documents.marks.add() / .remove() / .list()  (T020 — document annotations)
// ---------------------------------------------------------------------------

/**
 * The document-mark surface (T020). A mark is a lightweight annotation over a
 * STABLE block's character range — NOT an element and NOT lineage. M4 uses it for
 * highlights (T020), the extracted-span breadcrumb (T021), and processed spans
 * (T026); all share this surface but carry a different `markType`. The main side
 * validates `markType` against the canonical {@link MARK_TYPES} enum and persists
 * via `DocumentRepository`, which logs `update_document` in ONE transaction —
 * there is NO `add_mark` op (the operation set is closed). Adding/removing a mark
 * creates NO `elements` row. Ranges are `[start,end]` within the block (the mark
 * re-anchors by block id after a re-import — never an absolute ProseMirror
 * position). There is still no generic `db.query`.
 */

/** A persisted document mark returned to the renderer. */
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

/** The mark-type values the renderer may request (validated against `MARK_TYPES`). */
export const MarkTypeSchema = z.enum(MARK_TYPES);

/** A `[start, end]` character range within a block (start ≥ 0, end > start). */
export const MarkRangeSchema = z
  .tuple([z.number().int().min(0), z.number().int().min(0)])
  .refine(([start, end]) => end > start, {
    message: "range end must be greater than start",
  });

export const DocumentMarksAddRequestSchema = z.object({
  /** The owning document/element id the mark lives on. */
  elementId: ElementIdSchema,
  /** The STABLE block id the mark anchors to. */
  blockId: z.string().min(1).max(128),
  /** The mark kind (validated against the canonical `MARK_TYPES`). */
  markType: MarkTypeSchema,
  /** `[start, end]` character range within the block. */
  range: MarkRangeSchema,
  /** Optional mark-specific attributes (JSON-serializable). */
  attrs: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type DocumentMarksAddRequest = z.infer<typeof DocumentMarksAddRequestSchema>;

export interface DocumentMarksAddResult {
  readonly mark: DocumentMarkPayload;
}

export const DocumentMarksRemoveRequestSchema = z.object({
  /** The `document_marks.id` to remove. */
  markId: z.string().min(1).max(128),
});
export type DocumentMarksRemoveRequest = z.infer<typeof DocumentMarksRemoveRequestSchema>;

export interface DocumentMarksRemoveResult {
  /** Whether a mark row was removed (false when the id was unknown). */
  readonly removed: boolean;
}

export const DocumentMarksListRequestSchema = z.object({
  /** The owning document/element id whose marks to list. */
  elementId: ElementIdSchema,
  /** Optionally filter to one kind (e.g. only `highlight`). */
  markType: MarkTypeSchema.optional(),
});
export type DocumentMarksListRequest = z.infer<typeof DocumentMarksListRequestSchema>;

export interface DocumentMarksListResult {
  readonly marks: readonly DocumentMarkPayload[];
}

// ---------------------------------------------------------------------------
// extractions.create()  (T021 — the keystone: lift selected text into an extract)
// ---------------------------------------------------------------------------

/**
 * The extraction surface (T021). The renderer hands the resolved selection anchor
 * (the original `sourceElementId`, the spanned STABLE block ids + offsets, the
 * verbatim snapshot) and the MAIN process runs the `ExtractionService` to create a
 * NEW, independent, **attention-scheduled** `extract` element in ONE transaction:
 * the extract element + its `source_locations` anchor, its own seeded `documents`
 * body, a `derived_from` relation to its source/parent, inherited priority + tags,
 * an initial attention `due_at` (NEVER FSRS — no `review_states` row), and an
 * `extracted_span` mark on the parent body. A throw anywhere rolls the whole thing
 * back. `parentId` is omitted for a top-level extract (defaults to the source) and
 * set to the parent extract for a sub-extract (T025). There is still no generic
 * `db.query`.
 *
 * `priority`/`title` are optional: when absent the main side INHERITS the source's
 * numeric priority and derives a title from the selection, so the renderer never
 * needs to read provenance. `markType` is not on the wire — extraction always
 * writes `extracted_span`.
 */

export const ExtractionCreateRequestSchema = z.object({
  /** The original source element the selection was lifted from (lineage root). */
  sourceElementId: ElementIdSchema,
  /** The origin element; omit for a top-level extract, set for a sub-extract (T025). */
  parentId: ElementIdSchema.optional(),
  /** Verbatim snapshot of the selected text; seeds the extract body + the anchor. */
  selectedText: z.string().min(1).max(2_000_000),
  /** Ordered STABLE block ids the selection spans (≥ 1, document order). */
  blockIds: z.array(z.string().min(1).max(128)).min(1).max(10_000),
  /** Char offset within the FIRST spanned block where the selection starts. */
  startOffset: z.number().int().min(0).optional(),
  /** Char offset within the LAST spanned block where the selection ends. */
  endOffset: z.number().int().min(0).optional(),
  /** Optional explicit title; otherwise derived from the selection main-side. */
  title: z.string().trim().max(512).optional(),
  /** Optional human label override; otherwise derived from the source's blocks. */
  label: z.string().trim().max(512).optional(),
  /** Optional page (PDF, later); null/absent for text sources. */
  page: z.number().int().min(0).nullable().optional(),
  /** Optional A/B/C/D priority override; otherwise INHERITS the source's priority. */
  priority: PriorityLabelSchema.optional(),
});
export type ExtractionCreateRequest = z.infer<typeof ExtractionCreateRequestSchema>;

/** A flat summary of the freshly created extract element. */
export interface ExtractSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** The attention `due_at` (ISO-8601) — extracts are attention items, never FSRS. */
  readonly dueAt: string | null;
  /** The original source element id (lineage root). */
  readonly sourceId: string | null;
  /** The parent element id (the source for a top-level extract; parent extract for a sub-extract). */
  readonly parentId: string | null;
}

/** The created extract's stored source-location anchor. */
export interface ExtractLocationSummary {
  /** The `source_locations.id`. */
  readonly id: string;
  /** The element the location points INTO (source root or parent extract). */
  readonly sourceElementId: string;
  /** Ordered STABLE block ids the anchor covers. */
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
// extracts.updateStage() / .rewrite() / .postpone() / .markDone() / .delete()
//   (T024 — extract review mode actions)
// ---------------------------------------------------------------------------

/**
 * The extract review surface (T024). After T021 lifts a fragment into an
 * independent, attention-scheduled `extract`, the user processes it over time as
 * a readable mini-topic. These commands are the distillation ACTIONS on an
 * existing extract; the renderer drives them, the MAIN process runs the
 * `ExtractService` (`packages/local-db`) inside ONE transaction per action and
 * appends the right `operation_log` rows. The renderer never touches SQLite and
 * there is still no generic `db.query`.
 *
 *  - `updateStage`  → walk `raw_extract → clean_extract → atomic_statement`,
 *    persisting the new `stage` (`update_element`) AND rescheduling on the
 *    ATTENTION scheduler (`reschedule_element`) by the by-stage interval. Never
 *    creates a card and never touches FSRS — `atomic_statement` is "card-ready".
 *  - `rewrite`      → save an edited (or trimmed) body via `DocumentRepository`
 *    (`update_document`); lineage/anchor/scheduling untouched. `trim` is a
 *    renderer-side normalization that flows through this same command.
 *  - `postpone`     → reschedule further out (`reschedule_element`) + a postpone
 *    marker/count in the op payload (no schema migration).
 *  - `markDone`     → status `done` (`update_element`); leaves the rotation, keeps
 *    lineage.
 *  - `delete`       → SOFT delete (`soft_delete_element`); recoverable from trash.
 */

/** A flat summary of an extract after a review action (mirrors `ExtractSummary`). */
export interface ExtractActionSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** The attention `due_at` (ISO-8601) — extracts are attention items, never FSRS. */
  readonly dueAt: string | null;
  readonly sourceId: string | null;
  readonly parentId: string | null;
}

/**
 * Advance an extract one step along the chain, or jump to an explicit stage
 * (the stepper can target any of the three). When `stage` is omitted the main
 * side advances one step (`raw → clean → atomic`); when present it sets that
 * stage. Either way it reschedules on the attention scheduler.
 */
export const ExtractStageSchema = z.enum(["raw_extract", "clean_extract", "atomic_statement"]);

export const ExtractsUpdateStageRequestSchema = z.object({
  /** The extract element id to advance/retarget. */
  id: ElementIdSchema,
  /** Explicit target stage; omit to advance one step from the current stage. */
  stage: ExtractStageSchema.optional(),
});
export type ExtractsUpdateStageRequest = z.infer<typeof ExtractsUpdateStageRequestSchema>;

export interface ExtractsUpdateStageResult {
  readonly extract: ExtractActionSummary;
}

/**
 * Rewrite (or trim) an extract's body. `prosemirrorJson` is `z.unknown()` on the
 * wire (schema owned by `@interleave/editor`); `plainText` is the flattened
 * mirror computed renderer-side; `blocks` is the ordered stable block list. The
 * main side upserts via `DocumentRepository` (logs `update_document`).
 */
export const ExtractsRewriteRequestSchema = z.object({
  /** The extract element id whose body to rewrite. */
  id: ElementIdSchema,
  /** The new ProseMirror document JSON (schema owned by `@interleave/editor`). */
  prosemirrorJson: z.unknown(),
  /** The flattened plain-text mirror, computed renderer-side. */
  plainText: z.string().max(4_000_000),
  /** The ordered stable block list (preserves the stable ids), when present. */
  blocks: z.array(DocumentBlockInputSchema).max(100_000).optional(),
});
export type ExtractsRewriteRequest = z.infer<typeof ExtractsRewriteRequestSchema>;

export interface ExtractsRewriteResult {
  readonly extract: ExtractActionSummary;
  /** The persisted plain-text body after the rewrite. */
  readonly plainText: string;
}

export const ExtractsPostponeRequestSchema = z.object({
  /** The extract element id to postpone. */
  id: ElementIdSchema,
});
export type ExtractsPostponeRequest = z.infer<typeof ExtractsPostponeRequestSchema>;

export interface ExtractsPostponeResult {
  readonly extract: ExtractActionSummary;
  /** The running postpone count after this postpone. */
  readonly postponeCount: number;
}

export const ExtractsMarkDoneRequestSchema = z.object({
  /** The extract element id to mark done. */
  id: ElementIdSchema,
});
export type ExtractsMarkDoneRequest = z.infer<typeof ExtractsMarkDoneRequestSchema>;

export interface ExtractsMarkDoneResult {
  readonly extract: ExtractActionSummary;
}

export const ExtractsDeleteRequestSchema = z.object({
  /** The extract element id to soft-delete. */
  id: ElementIdSchema,
});
export type ExtractsDeleteRequest = z.infer<typeof ExtractsDeleteRequestSchema>;

export interface ExtractsDeleteResult {
  readonly extract: ExtractActionSummary;
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
  readonly elements: {
    /**
     * Set / raise / lower an element's priority (T027) — the universal priority
     * write path for sources/extracts/cards/tasks/topics/synthesis notes. Updates
     * the numeric value + logs `update_element` in one transaction.
     */
    setPriority(request: ElementsSetPriorityRequest): Promise<ElementsSetPriorityResult>;
  };
  readonly lineage: {
    /** The full, depth-tagged lineage tree for one element (read-only) (T023). */
    get(request: LineageGetRequest): Promise<LineageGetResult>;
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
  readonly documents: {
    /** Load an element's document body (ProseMirror JSON + plain text) (T015). */
    get(request: DocumentsGetRequest): Promise<DocumentsGetResult>;
    /** Upsert an element's document body; logs `update_document` (T015). */
    save(request: DocumentsSaveRequest): Promise<DocumentsSaveResult>;
    /** Document-mark annotations (highlight / extracted-span / processed-span) (T020). */
    readonly marks: {
      /** Add a mark over a stable block range; logs `update_document` (T020). */
      add(request: DocumentMarksAddRequest): Promise<DocumentMarksAddResult>;
      /** Remove a mark by id; logs `update_document` (T020). */
      remove(request: DocumentMarksRemoveRequest): Promise<DocumentMarksRemoveResult>;
      /** List an element's marks (optionally filtered by kind) (T020). */
      list(request: DocumentMarksListRequest): Promise<DocumentMarksListResult>;
    };
  };
  readonly extractions: {
    /**
     * Lift selected source text into a new independent, attention-scheduled
     * `extract` element + its lineage, in one transaction (T021). Marks the parent
     * `extracted_span`; never creates an FSRS `review_states` row.
     */
    create(request: ExtractionCreateRequest): Promise<ExtractionCreateResult>;
  };
  readonly extracts: {
    /**
     * Advance an extract `raw → clean → atomic` (or to an explicit stage),
     * rescheduling it on the attention scheduler; logs `update_element` +
     * `reschedule_element` (T024).
     */
    updateStage(request: ExtractsUpdateStageRequest): Promise<ExtractsUpdateStageResult>;
    /** Rewrite/trim an extract's body; logs `update_document` (T024). */
    rewrite(request: ExtractsRewriteRequest): Promise<ExtractsRewriteResult>;
    /** Postpone an extract (reschedule further out + count); logs `reschedule_element` (T024). */
    postpone(request: ExtractsPostponeRequest): Promise<ExtractsPostponeResult>;
    /** Mark an extract done (status `done`); logs `update_element` (T024). */
    markDone(request: ExtractsMarkDoneRequest): Promise<ExtractsMarkDoneResult>;
    /** Soft-delete an extract; logs `soft_delete_element` (T024). */
    delete(request: ExtractsDeleteRequest): Promise<ExtractsDeleteResult>;
  };
  readonly readPoints: {
    /** Load an element's read-point (resume position), or `null` (T017). */
    get(request: ReadPointGetRequest): Promise<ReadPointGetResult>;
    /** Upsert an element's read-point; logs `set_read_point` (T017). */
    set(request: ReadPointSetRequest): Promise<ReadPointSetResult>;
  };
}
