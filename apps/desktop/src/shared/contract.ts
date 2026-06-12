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
  AI_ACTION_TYPES,
  AI_API_KEY_MAX,
  AI_LOCAL_MODEL_ID_MAX,
  AI_PROVIDER_KINDS,
  AI_SOURCE_TEXT_MAX,
  type AiActionType,
  type AiProviderKind,
  type AiSuggestionKind,
  type AppSettings,
  CARD_KINDS,
  CHRONIC_POSTPONE_THRESHOLD_MAX,
  CHRONIC_POSTPONE_THRESHOLD_MIN,
  CONFIDENCE_LEVELS,
  type ConfidenceLevel,
  DAILY_REVIEW_BUDGET_MAX,
  DAILY_REVIEW_BUDGET_MIN,
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  DISPLAY_NAME_MAX,
  ELEMENT_STATUSES,
  ELEMENT_TYPES,
  EMBEDDING_API_KEY_MAX,
  EMBEDDING_MODEL_ID_MAX,
  EMBEDDING_PROVIDERS,
  type ExtractFate,
  FACT_STABILITY,
  type FactExpiryStatus,
  type FactLifetime,
  IMPORT_BALANCE_FACTOR_MAX,
  IMPORT_BALANCE_FACTOR_MIN,
  JOB_STATUSES,
  JOB_TYPES,
  KEYBOARD_LAYOUTS,
  MARK_TYPES,
  MAX_REVIEW_MODE_DECK,
  MEDIA_REF_FACES,
  type MediaRef,
  PARKED_RESURFACE_AFTER_DAYS_MAX,
  PARKED_RESURFACE_AFTER_DAYS_MIN,
  type PriorityLabel,
  RELIABILITY_TIERS,
  REVIEW_RATINGS,
  type ReliabilityTier,
  type RendererSettings,
  type ReviewModeSelector,
  SOURCE_BLOCK_PROCESSING_STATES,
  SOURCE_TYPES,
  type SourceBlockProcessingDerivation,
  type SourceBlockProcessingState,
  type SourceRef,
  type SourceType,
  TASK_TYPES,
  type TaskType,
  THEMES,
  WEEKLY_REVIEW_CADENCE_DAYS_MAX,
  WEEKLY_REVIEW_CADENCE_DAYS_MIN,
} from "@interleave/core";
import { z } from "zod";

// The source-reference (refblock) shape (T043) crosses IPC verbatim; the citation
// formatter (`formatSourceRef`) lives in `@interleave/core` and the renderer's
// `RefBlock` reuses it. No new lineage model — this is derived display data.
// The claim-lifetime model (T090) crosses IPC verbatim; the pure `deriveExpiryStatus`
// lives in `@interleave/core` (computed main-side; the renderer only renders the status).
// The source-reliability tuples (T091) cross IPC verbatim; `formatSourceRef` assembles
// the badge from them.
export type {
  AppSettings,
  ConfidenceLevel,
  ExtractFate,
  FactExpiryStatus,
  FactLifetime,
  FactStability,
  PriorityLabel,
  ReliabilitySummary,
  ReliabilityTier,
  RendererSettings,
  ReviewModeSelector,
  SourceRef,
  SourceType,
} from "@interleave/core";

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
  /**
   * The complete, validated settings (unset keys resolved to defaults), PROJECTED for
   * the renderer: the user's OWN keys (`aiApiKey`/`embeddingApiKey`) are stripped and
   * replaced with `aiKeyConfigured`/`embeddingApiKeyConfigured` booleans. The plaintext
   * keys are MAIN-SIDE secrets and are NEVER returned across the IPC boundary (T087/T093).
   */
  readonly settings: RendererSettings;
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
    burySiblings: z.boolean(),
    trashRetentionDays: z.number().int().positive(),
    balanceWarnings: z.boolean(),
    parkedResurfaceAfterDays: z
      .number()
      .int()
      .min(PARKED_RESURFACE_AFTER_DAYS_MIN)
      .max(PARKED_RESURFACE_AFTER_DAYS_MAX),
    chronicPostponeThreshold: z
      .number()
      .int()
      .min(CHRONIC_POSTPONE_THRESHOLD_MIN)
      .max(CHRONIC_POSTPONE_THRESHOLD_MAX),
    weeklyReviewEnabled: z.boolean(),
    weeklyReviewCadenceDays: z
      .number()
      .int()
      .min(WEEKLY_REVIEW_CADENCE_DAYS_MIN)
      .max(WEEKLY_REVIEW_CADENCE_DAYS_MAX),
    adaptiveAttentionIntervals: z.boolean(),
    importBalanceFactor: z.number().min(IMPORT_BALANCE_FACTOR_MIN).max(IMPORT_BALANCE_FACTOR_MAX),
    keyboardLayout: z.enum(KEYBOARD_LAYOUTS),
    theme: z.enum(THEMES),
    /** The local vault owner's display name (trimmed + capped main-side). */
    displayName: z.string().max(DISPLAY_NAME_MAX),
    // Semantic search (T087): the on/off switch, provider, the user's own API key
    // (validated/coerced main-side), the active model id, and the model-downloaded
    // flag. The key is stored in SQLite settings only — never our server.
    semanticSearchEnabled: z.boolean(),
    embeddingProvider: z.enum(EMBEDDING_PROVIDERS),
    embeddingApiKey: z.string().max(EMBEDDING_API_KEY_MAX),
    embeddingModelId: z.string().max(EMBEDDING_MODEL_ID_MAX),
    embeddingModelDownloaded: z.boolean(),
    // AI assistance (T093): the on/off switch, provider kind, the managed-proxy switch,
    // the model-downloaded flag, the local model id, and the user's OWN key (validated/
    // coerced main-side, projected to `keyConfigured` on read — never returned).
    aiEnabled: z.boolean(),
    aiProviderKind: z.enum(AI_PROVIDER_KINDS),
    aiManagedProxyEnabled: z.boolean(),
    aiModelDownloaded: z.boolean(),
    aiLocalModelId: z.string().max(AI_LOCAL_MODEL_ID_MAX),
    aiApiKey: z.string().max(AI_API_KEY_MAX),
  })
  .partial()
  .strict();

export const SettingsUpdateManyRequestSchema = z.object({
  /** The partial patch to apply; at least one field should be present. */
  patch: SettingsPatchSchema,
});
export type SettingsUpdateManyRequest = z.infer<typeof SettingsUpdateManyRequestSchema>;

export interface SettingsUpdateManyResult {
  /**
   * The full settings after the patch is applied, PROJECTED for the renderer — the
   * own-keys are replaced with `*Configured` booleans, never returned in plaintext
   * (T087/T093). The write path still accepts the raw key via {@link SettingsPatchSchema}.
   */
  readonly settings: RendererSettings;
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
  /** Topic-rest return timestamp when this element is the fallowed topic. */
  readonly fallowUntil?: string | null;
  /** Optional user-visible reason for the active/rested topic. */
  readonly fallowReason?: string | null;
  /** Extract-only honorable terminal fate; `null` for active extracts and all non-extracts. */
  readonly extractFate: ExtractFate | null;
}

/** Which scheduler an element is on — the load-bearing FSRS vs attention split. */
export type SchedulerKind = "fsrs" | "attention";

export type CurrentScheduleReasonKind =
  | "yield_shortened"
  | "yield_lengthened"
  | "recency_damped"
  | "postpone_recession"
  | "source_unresolved_shortened"
  | "source_exhausted_lengthened"
  | "descendant_lapses"
  | "band_base";

/** Structured, renderer-formatted reason for the current persisted attention schedule. */
export interface CurrentScheduleReason {
  readonly kind: CurrentScheduleReasonKind;
  readonly baseIntervalDays: number | null;
  readonly finalIntervalDays: number | null;
  readonly intervalAfterMultiplierDays?: number | null;
  readonly priorMultiplier?: number | null;
  readonly newMultiplier?: number | null;
  readonly productiveOutputCount?: number | null;
  readonly unresolvedRatio?: number | null;
  readonly terminalRatio?: number | null;
  readonly ignoredRatio?: number | null;
  readonly daysSinceLastSeen?: number | null;
  readonly recencyCreditDays?: number | null;
  readonly intervalAfterPostponeDays?: number | null;
  readonly postponeCount?: number | null;
  readonly intervalAfterSourceProcessingDays?: number | null;
  readonly extractedOutputCount?: number | null;
  readonly descendantLapseCount?: number | null;
  readonly affectedCardCount?: number | null;
  readonly descendantCardCount?: number | null;
  readonly descendantLapseRate?: number | null;
  readonly intervalAfterDescendantDays?: number | null;
}

/**
 * The scheduler signals shown by the `SchedulerChip`/readout. `fsrs` carries
 * memory signals (retrievability/stability/difficulty) for cards; `attention`
 * carries process-again signals (stage/priority/last-processed/postponed×N) and
 * an optional structured reason for the current attention due date.
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
  /** Structured reason for the current attention schedule; `null` for cards/band-base. */
  readonly scheduleReason: CurrentScheduleReason | null;
  /** When it was last processed/reviewed (ISO-8601), when known. */
  readonly lastProcessedAt: string | null;
  /**
   * The attention chip's promised "yield (N extracts / M cards)" for a SOURCE
   * (T083) — read %, extracts/cards created, from the read-only `SourceYieldQuery`.
   * `null` for non-source attention items and for cards (the FSRS branch); absent on
   * adapter signals that don't carry yield.
   */
  readonly yield?: SourceYieldSignals | null;
  /** Dismissible source-retirement suggestion for "done with no yield" sources (T103). */
  readonly retirementSuggestion?: SourceRetirementSuggestion | null;
}

/** The per-source yield summary the inspector "yield" chip shows (T083). */
export interface SourceYieldSignals {
  /** How far the source has been read, in `[0, 1]`. */
  readonly readPct: number;
  /** Live `extract` descendants created from the source. */
  readonly extractsCreated: number;
  /** Extracts that produced non-card value, de-duplicated across fate + synthesis refs. */
  readonly productiveExtracts: number;
  /** Live `card` descendants created from the source. */
  readonly cardsCreated: number;
}

/** A scheduler-derived suggestion that a source has reached an honest exit point (T103). */
export interface SourceRetirementSuggestion {
  readonly kind: "abandon";
  readonly reason: string;
  readonly reasonLabel: string;
  readonly signalHash: string;
  readonly terminalRatio: number;
  readonly ignoredRatio: number;
  readonly totalBlocks: number;
  readonly terminalBlocks: number;
  readonly ignoredBlocks: number;
  readonly unresolvedBlocks: number;
  readonly extractedOutputCount: number;
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
  /** Whether the card is currently RETIRED (T082) — out of review, kept for reference. */
  readonly isRetired: boolean;
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
  /**
   * Source-reliability metadata (T091) — `type` / `tier` / `confidence` / `notes`.
   * All nullable: a source with no reliability data shows no badge (the unchanged
   * pre-T091 render). Edited through `sources.updateReliability` (`update_element`).
   */
  readonly sourceType: SourceType | null;
  readonly reliabilityTier: ReliabilityTier | null;
  readonly confidence: ConfidenceLevel | null;
  readonly reliabilityNotes: string | null;
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
  /** The PDF region bbox (T065) for a `media_fragment` region extract, else `null`. */
  readonly region: RegionRectInput | null;
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
  /**
   * The originating source reference (T043 — the refblock): title/url/author/date
   * + location label + verbatim snippet, resolved from this element's lineage for a
   * source/extract/card. Built main-side via `resolveSourceRef` (the SAME resolver
   * the review payload uses) so the inspector, review, extract view, and library
   * agree; rendered with the shared `formatSourceRef`/`RefBlock`. `null` only when
   * the element has no resolvable source — the renderer shows a calm placeholder.
   */
  readonly sourceRef: SourceRef | null;
  /** Flat tag names attached to the element. */
  readonly tags: readonly string[];
  /** Concepts this element is a member of (T041 — `concept_membership` edges). */
  readonly concepts: readonly ConceptInspectorSummary[];
  /** FSRS review summary for cards; `null` for attention-scheduled elements. */
  readonly review: ReviewSummary | null;
  /**
   * The card's claim-lifetime fields + the DERIVED expiry status (T090). Present only
   * for a `card` (the fact carrier); `null` for non-card elements. The `status` is
   * computed MAIN-side via `deriveExpiryStatus(now)` — the renderer renders the
   * Expiry section/badge from it and never recomputes it. A card with no lifetime is
   * still present with `status: "fresh"` + every field `null` (the section offers an
   * "Add expiry" affordance). Edited through `cards.setLifetime` (`update_element`).
   */
  readonly lifetime: FactLifetimeSummary | null;
}

/** The card's claim-lifetime fields + the derived expiry status, for the inspector (T090). */
export interface FactLifetimeSummary extends FactLifetime {
  /** The derived `fresh` / `due_for_review` / `expired` attribute (NOT a lifecycle status). */
  readonly status: FactExpiryStatus;
}

/** A concept summary embedded in the inspector payload (T041). */
export interface ConceptInspectorSummary {
  readonly id: string;
  readonly name: string;
}

export const ElementIdSchema = z.string().min(1).max(128);

/**
 * An optional "clock" the renderer may pass to override the main-side `now` (the
 * `asOf` instant used by the due reads and the FSRS grade path). It must be a
 * NON-EMPTY string that `Date.parse` can actually turn into a valid timestamp —
 * an empty/garbage value (`""`, `"now"`, `"yesterday"`) is rejected at the IPC
 * boundary BEFORE it can reach the scheduler, so a malformed clock can never be
 * persisted as an `Invalid Date` into `review_states`/`elements.due_at`/the
 * append-only `review_logs` (CLAUDE.md: never trust the renderer; do not silently
 * destroy user data). Length is bounded (defense against absurd inputs) and the
 * value is trimmed before parsing.
 */
export const IsoTimestampInputSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => isCanonicalUtcIsoTimestamp(value), {
    message: "must be a canonical UTC ISO-8601 timestamp",
  });

function isCanonicalUtcIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

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
// topics.fallow() / topics.unfallow()  (T107 — deliberate topic rest)
// ---------------------------------------------------------------------------

/** Bound for a short, user-visible topic-rest reason. Kept in sync with local-db. */
export const TOPIC_FALLOW_REASON_MAX = 240;

export const TopicFallowRequestSchema = z
  .object({
    /** The live topic whose attention subtree should rest until `fallowUntil`. */
    topicId: ElementIdSchema,
    /** Future return timestamp for the topic and eligible attention descendants. */
    fallowUntil: IsoTimestampInputSchema,
    /** Optional reason shown in queue/inventory/review context. */
    fallowReason: z.string().trim().max(TOPIC_FALLOW_REASON_MAX).optional().nullable(),
  })
  .strict();
export type TopicFallowRequest = z.infer<typeof TopicFallowRequestSchema>;

export const TopicUnfallowRequestSchema = z
  .object({
    /** The fallowed topic to restore from its active fallow batch. */
    topicId: ElementIdSchema,
  })
  .strict();
export type TopicUnfallowRequest = z.infer<typeof TopicUnfallowRequestSchema>;

export type TopicFallowSkipReason =
  | "missing"
  | "deleted"
  | "not-topic"
  | "not-actionable"
  | "invalid-return"
  | "not-fallowed"
  | "missing-fallow-batch"
  | "schedule-changed";

export interface TopicFallowResult {
  readonly applied: number;
  readonly skipped: readonly { readonly id: string; readonly reason: TopicFallowSkipReason }[];
  readonly batchId: string | null;
}

// ---------------------------------------------------------------------------
// queue.list()  (T029 — the unified, sorted, filtered due queue)
// ---------------------------------------------------------------------------

/**
 * The daily queue read (T029). The renderer asks for everything DUE — due cards
 * (FSRS) AND due sources/topics/extracts/tasks (attention) — and the MAIN process
 * composes the queue query in `packages/local-db`: it merges the two distinct due
 * reads (the FSRS `review_states.due_at` join vs the attention `elements.due_at`
 * read), decorates each row with its scheduler signals + meta, **sorts by priority
 * desc then due date asc**, applies the type/concept/status filters, and returns
 * flat `QueueItemSummary` rows + per-type counts + the daily budget gauge. The
 * 10–20% jitter the daily-queue rule asks for is a stable, seeded shuffle the
 * renderer applies on top — the sort here is deterministic. Read-only: no
 * mutation, no `operation_log`. There is still no generic `db.query`.
 *
 * `concept` + `tag` filtering is REAL (T041, M8): the query layer narrows on the
 * element's `concept_membership` edges (matched by concept NAME, against ALL of an
 * element's memberships) and its `element_tags`. The filtering lives in the
 * `QueueQuery`/repository layer, never in React.
 */

/** Which scheduler a queue row is on — the FSRS vs attention split. */
export type QueueScheduler = "fsrs" | "attention";

/** The scheduler signals a queue row carries for its `SchedulerChip`. */
export interface QueueSchedulerSignals {
  readonly kind: QueueScheduler;
  /** Card recall probability now (`0.0`–`1.0`), or `null` for new/attention rows. */
  readonly retrievability: number | null;
  /** FSRS memory stability in days, or `null` for attention rows. */
  readonly stability: number | null;
  /**
   * Current FSRS phase (`new`/`learning`/`review`/`relearning`), or `null` for attention
   * rows — the fragile↔mature signal the T077 auto-postpone planner reads.
   */
  readonly fsrsState: string | null;
  /** Cumulative FSRS lapses, or `null` for attention rows — drives the T077 leech exclusion. */
  readonly lapses: number | null;
  /** Distillation stage (shown on the attention chip). */
  readonly stage: string;
  /** How many times an attention element has been postponed. */
  readonly postponed: number;
  /** Structured reason for the current attention schedule; `null` for cards/band-base. */
  readonly scheduleReason: CurrentScheduleReason | null;
  /** Dismissible source-retirement suggestion for "done with no yield" sources (T103). */
  readonly retirementSuggestion: SourceRetirementSuggestion | null;
}

/** How "due" a row is relative to `asOf`. */
export type QueueDueState = "overdue" | "today" | "soon";

/** A flat, JSON-serializable queue row. */
export interface QueueItemSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** The governing due time (FSRS `review_states.due_at` or attention `elements.due_at`). */
  readonly dueAt: string | null;
  readonly scheduler: QueueScheduler;
  readonly schedulerSignals: QueueSchedulerSignals;
  /** The owning source's title (provenance), for the per-row meta line. */
  readonly sourceTitle: string | null;
  /** The source's author, when the row is (or belongs to) a source. */
  readonly author: string | null;
  /** A concept this row is a member of (T041 populates this; null until then). */
  readonly concept: string | null;
  /**
   * The sibling-group id (cards only), or `null` — a de-clumping key for the T076
   * auto-sort (siblings are not placed adjacent). Non-cards are always `null`.
   */
  readonly siblingGroupId: string | null;
  /** The owning source's id (provenance), or `null` — the same-source de-clumping key. */
  readonly sourceId: string | null;
  /** Card kind (`qa`/`cloze`); null for non-cards. */
  readonly cardType: string | null;
  /** Task kind for `task` rows, or null for non-tasks. */
  readonly taskType: TaskType | null;
  /**
   * The element a `task`-type row protects (its `tasks.linked_element_id`), or `null` —
   * lets the queue/process "Open" affordance JUMP TO the protected card/source/extract's
   * reader (T092) instead of opening the maintenance task itself. Task rows only.
   */
  readonly linkedElementId: string | null;
  /** The protected element's TYPE, or `null` — paired with {@link linkedElementId}. */
  readonly linkedElementType: string | null;
  /** True for A-priority items (the `--protected` accent bar). */
  readonly protected: boolean;
  /** Overdue / today / soon, relative to `asOf`. */
  readonly due: QueueDueState;
  /** A short human due label ("Overdue" / "Due today" / "in 3d"). */
  readonly dueLabel: string;
  /** True only when this row is actionable in the due queue at the read clock. */
  readonly queueEligible: boolean;
  /** Human explanation when an inventory row has scheduler history but is not in Queue. */
  readonly notInQueueReason: string | null;
  /** Topic rest state explaining this row, when a parent/self topic has fallow metadata. */
  readonly fallowState: "active" | "returned" | null;
  /** Return timestamp for the fallow context, when present. */
  readonly fallowUntil: string | null;
  /** User-visible topic-rest reason, when present. */
  readonly fallowReason: string | null;
  /** The topic whose fallow state explains this row, when present. */
  readonly fallowTopicId: string | null;
}

/**
 * DRILL-DOWN per-type + at-risk counts. Each respects the active status/concept/tag
 * filters but DROPS the type dimension (the chips drive it), so a chip's number equals
 * the rows shown when that chip is selected alongside the other active filters (the
 * count-vs-list invariant). `all` equals the filtered list length.
 */
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

export const QueueListRequestSchema = z.object({
  /** "Now" the due reads compare against (ISO-8601); defaults to the server clock. */
  asOf: IsoTimestampInputSchema.optional(),
  /** Keep only these element types. */
  types: z.array(z.enum(ELEMENT_TYPES)).optional(),
  /** Keep only rows that are a member of this concept, by concept NAME (T041). */
  concept: z.string().trim().max(256).optional(),
  /** Keep only rows tagged with this tag name (T041). */
  tag: z.string().trim().max(256).optional(),
  /** Keep only these lifecycle statuses. */
  statuses: z.array(z.enum(ELEMENT_STATUSES)).optional(),
  /**
   * The active session mode (T076) — a SOFT type up-weight on the auto-sort, not a
   * filter. `review` floats cards, `read` floats reading items, `full` is neutral.
   * Defaults to `"full"`. Both types always stay in the list; the mode re-orders them.
   */
  mode: z.enum(["full", "review", "read"]).optional(),
  /** Include the T115 minute estimate; count-only callers leave this false/omitted. */
  includeTimeEstimate: z.boolean().optional(),
});
export type QueueListRequest = z.infer<typeof QueueListRequestSchema>;

/** Confidence for queue time-cost estimates. `default` means at least one priced component uses a documented fallback. */
export type QueueTimeEstimateConfidence = "learned" | "default";

/** Optional estimate for a visible queue row, when the trusted read model provides per-row pricing. */
export interface QueueVisibleTimeEstimate {
  readonly id: string;
  readonly estimatedMinutes: number;
  readonly confidence: QueueTimeEstimateConfidence;
  readonly basis: string;
}

/** Trusted aggregate pricing for the filtered due queue. Budget remains item-count based in T115. */
export interface QueueTimeEstimate {
  readonly confidence: QueueTimeEstimateConfidence;
  readonly totalMinutes: number;
  readonly pricedItemCount: number;
  readonly items: readonly QueueVisibleTimeEstimate[];
}

export interface QueueListResult {
  readonly items: readonly QueueItemSummary[];
  readonly counts: QueueCounts;
  /** The daily review budget gauge: items due vs the configured target. */
  readonly budget: { readonly used: number; readonly target: number };
  /** Full filtered due-set time estimate, priced on the trusted side when requested. */
  readonly timeEstimate?: QueueTimeEstimate;
}

// ---------------------------------------------------------------------------
// queue.act()  (T030 — per-row, in-place queue actions)
// ---------------------------------------------------------------------------

/**
 * The in-place queue ACT surface (T030). Every `qitem` row in `/queue` acts WITHOUT
 * leaving the list: postpone / raise / lower / done / dismiss / delete. (Open is
 * renderer-only navigation — it is NOT an IPC call.) The renderer sends an intent
 * only; the MAIN process dispatches it through the `QueueActionService` (a thin
 * DISPATCHER over the already-built mutation paths — it invents no new scheduling or
 * priority math):
 *
 *  - `postpone` → an ATTENTION item reschedules further out on the attention
 *    scheduler (`reschedule_element` + the postpone marker/count in the op payload);
 *    a CARD defers its FSRS `review_states.due_at` forward (a deliberate THIN defer
 *    for M5 — full FSRS grade-driven rescheduling is M7). The two schedulers stay
 *    SEPARATE — a card is never put on the attention heuristic.
 *  - `raise` / `lower` → the `@interleave/core` band helpers + `update_element`.
 *  - `markDone` → status `done` + clear active due (`update_element`); `dismiss` →
 *    status `dismissed` + clear active due (`update_element`); `delete` → SOFT delete
 *    (`soft_delete_element`), recoverable.
 *
 * Each path is validated main-side, runs in ONE transaction, and appends exactly
 * the correct EXISTING op (NO new op types — the closed 15-op set is unchanged).
 * The result carries the REFRESHED row summary (so the renderer updates/re-sorts it
 * in place), whether the row LEAVES the list, and the undo recipe for the snackbar.
 * There is still no generic `db.query`.
 *
 * `action` is a discriminated union so the main side rejects an unknown intent at
 * the boundary.
 */
export const QueueActRequestSchema = z.object({
  /** The due element id to act on (any queue type). */
  id: ElementIdSchema,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("postpone") }),
    z.object({ kind: z.literal("raise") }),
    z.object({ kind: z.literal("lower") }),
    z.object({ kind: z.literal("markDone"), confirmUnresolvedBlocks: z.boolean().optional() }),
    z.object({ kind: z.literal("dismiss") }),
    z.object({ kind: z.literal("delete") }),
  ]),
});
export type QueueActRequest = z.infer<typeof QueueActRequestSchema>;

/** The undo recipe a removing action hands back for the snackbar. */
export interface QueueActUndo {
  /** `restore` → `ElementRepository.restore`; `status` → re-set the prior status. */
  readonly kind: "restore" | "status";
  /** The status the row had BEFORE the action (the target the undo restores). */
  readonly previousStatus: string;
  /** The element due time BEFORE the action, restored by snackbar undo. */
  readonly previousDueAt?: string | null;
  /** The FSRS due time BEFORE the action for cards, restored by snackbar/global undo. */
  readonly previousReviewDueAt?: string | null;
}

export interface QueueActResult {
  /**
   * The REFRESHED queue row after the action, so the renderer can update + re-sort
   * it in place; `null` when the row left the due set (done / dismiss / delete) or
   * the id was unknown.
   */
  readonly item: QueueItemSummary | null;
  /** Whether the row LEAVES the due list (done / dismiss / delete). */
  readonly removed: boolean;
  /** The undo recipe for the snackbar, when the action is undoable. */
  readonly undo: QueueActUndo | null;
}

// ---------------------------------------------------------------------------
// queue.schedule()  (T028/T030 — explicit tomorrow / next-week / next-month / manual)
// ---------------------------------------------------------------------------

/**
 * The EXPLICIT (non-heuristic) attention-scheduling surface (T028). Where
 * `queue.act` `postpone` recedes a non-card item by the HEURISTIC interval, this
 * lets the user pin an item to a precise return: **tomorrow / next week / next
 * month / a manual date**. T028's roadmap "Done when" requires this capability; it
 * runs through the `SchedulerService.scheduleAt` apply seam (the attention half),
 * which computes the new `due_at` with the pure `AttentionScheduler.scheduleForChoice`
 * and persists it via `ElementRepository.reschedule` (`reschedule_element`, status →
 * `scheduled`) in ONE transaction — NO new op type (the closed 15-op set is
 * unchanged).
 *
 * THE TWO-SCHEDULER SPLIT (load-bearing): this is for non-card ATTENTION items only.
 * A `card` is REJECTED main-side (cards schedule on FSRS — `review.grade`, T037 —
 * never the attention heuristic), so the renderer only offers this control on
 * sources / topics / extracts / tasks. There is still no generic `db.query`.
 *
 * `choice` is a discriminated union so the main side rejects an unknown intent at
 * the boundary; `manual` carries an ISO-8601 date (validated/normalized main-side).
 */
export const QueueScheduleRequestSchema = z.object({
  /** The due (or any non-card attention) element id to schedule explicitly. */
  id: ElementIdSchema,
  choice: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tomorrow") }),
    z.object({ kind: z.literal("nextWeek") }),
    z.object({ kind: z.literal("nextMonth") }),
    z.object({
      kind: z.literal("manual"),
      /** The chosen return date, ISO-8601 (normalized to canonical ISO main-side). */
      date: IsoTimestampInputSchema,
    }),
  ]),
});
export type QueueScheduleRequest = z.infer<typeof QueueScheduleRequestSchema>;

export interface QueueScheduleResult {
  /**
   * The REFRESHED queue row after scheduling, or `null` when the item is no longer
   * due (the usual case — a future schedule recedes it from the due set) or the id
   * was unknown.
   */
  readonly item: QueueItemSummary | null;
  /** The new `due_at` the item was scheduled to (ISO-8601). */
  readonly dueAt: string;
  /** The interval (in days) from "now" the chosen schedule resolved to. */
  readonly intervalDays: number;
}

/**
 * Undo a removing queue action (T030) — the snackbar's "Undo". The renderer echoes
 * back the {@link QueueActUndo} recipe the prior {@link QueueActResult} handed it; the
 * MAIN process applies the inverse through the `QueueActionService`: `restore` →
 * {@link ElementRepository.restore} (`restore_element`) for a soft-deleted row;
 * `status` → {@link ElementRepository.update} re-setting the prior status
 * (`update_element`) for a done/dismiss. One transaction + the correct existing op;
 * no new op types. There is still no generic `db.query`.
 */
export const QueueUndoRequestSchema = z.object({
  /** The element id to restore. */
  id: ElementIdSchema,
  undo: z.object({
    kind: z.enum(["restore", "status"]),
    /** The status the row had BEFORE the action (the target to restore to). */
    previousStatus: z.enum(ELEMENT_STATUSES),
    previousDueAt: IsoTimestampInputSchema.nullable().optional(),
    previousReviewDueAt: IsoTimestampInputSchema.nullable().optional(),
  }),
});
export type QueueUndoRequest = z.infer<typeof QueueUndoRequestSchema>;

export interface QueueUndoResult {
  /** The restored queue row summary, or `null` when the id is unknown. */
  readonly item: QueueItemSummary | null;
}

// ---------------------------------------------------------------------------
// queue.autoPostpone() / queue.autoPostponeApply()  (T077 — the overload valve)
// ---------------------------------------------------------------------------

/**
 * The overload AUTO-POSTPONE surface (T077). When the due load exceeds the daily review
 * budget (`getAppSettings().dailyReviewBudget`), the user can relieve the overflow — and the
 * system chooses victims DETERMINISTICALLY by value: low-priority topics/sources/extracts
 * first, then low-priority *mature* cards, while NEVER touching high-priority *fragile* cards
 * (or leeches, or explicitly protected items). Selection is the pure `planAutoPostpone`
 * (`@interleave/scheduler`); application is transactional through the `AutoPostponeService`,
 * routing each item to its CORRECT scheduler — attention items reschedule on the attention
 * scheduler (`reschedule_element`); cards defer on FSRS (`review_states.due_at` only, memory
 * state untouched, no review log) — all under ONE shared `batchId` so the whole sweep undoes
 * as one (T044). No new op types (the closed 15-op set is unchanged), no schema migration.
 *
 * `preview` is READ-ONLY (no mutation, no op); `apply` is transactional. Undo reuses the
 * existing command-level/`batchId` undo (`undo.last`) — the `reschedule_element` pre-images
 * restore BOTH `elements.due_at` and `review_states.due_at`. There is still no generic
 * `db.query`.
 */
export const QueueAutoPostponeRequestSchema = z.object({
  /** "Now" the due reads + plan compare against (ISO-8601); defaults to the server clock. */
  asOf: IsoTimestampInputSchema.optional(),
});
export type QueueAutoPostponeRequest = z.infer<typeof QueueAutoPostponeRequestSchema>;

/** Why a victim was chosen — surfaced so the cost of postponement is legible. */
export type AutoPostponeReason = "low-priority-topic" | "low-priority-mature-card";

/** One preview row — what moves, from→to, and why. */
export interface AutoPostponePreviewRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the band. */
  readonly priority: number;
  readonly scheduler: QueueScheduler;
  /** The current due time (ISO-8601), or `null`. */
  readonly fromDueAt: string | null;
  /** The projected due time after the postpone (ISO-8601). */
  readonly toDueAt: string;
  readonly reason: AutoPostponeReason;
}

/** The read-only auto-postpone preview the renderer shows BEFORE committing. */
export interface AutoPostponePreview {
  /** How many items are over today's budget (`used - target`, clamped at 0). */
  readonly overBudget: number;
  /** The daily review budget target. */
  readonly target: number;
  /** The current due count. */
  readonly used: number;
  /** The ordered postpone victims (cheapest value first). */
  readonly willPostpone: readonly AutoPostponePreviewRow[];
  /** The due count remaining after applying the plan. */
  readonly remainingAfter: number;
}

/** The result of applying the auto-postpone sweep. */
export interface AutoPostponeApplyResult {
  /** How many items were postponed. */
  readonly postponed: number;
  /** The shared batch id (the whole sweep undoes as one via `undo.last`). */
  readonly batchId: string;
}

// ---------------------------------------------------------------------------
// queue.catchUp() / queue.vacation()  (T078 — the catch-up & vacation modes)
// ---------------------------------------------------------------------------

/**
 * The CATCH-UP & VACATION surface (T078) — the two human-facing overload tools, both built on
 * T077's deterministic selection + safe application, both SHOWING THE COST of postponement
 * (what slips, by how much) BEFORE committing.
 *
 *  - **Catch-up** recovers from a backlog: it spreads the overdue pile forward over `spreadDays`
 *    so each day stays within the daily budget, high-value/fragile items to the EARLIEST days.
 *  - **Vacation** pre-adjusts future load: it suspends (fragile cards) or shifts-past-return
 *    (everything else) whatever would come due in `[awayStart, awayEnd]` and re-spreads the
 *    shifted load after return within budget.
 *
 * Planning is the pure `planCatchUp`/`planVacation` (`@interleave/scheduler`); application is the
 * `RecoveryModeService`, dispatching each item to its CORRECT scheduler — attention items
 * reschedule on the attention scheduler (`reschedule_element`, ABSOLUTE date); cards defer on
 * FSRS (`review_states.due_at` to the EXACT planned day, memory state untouched, no review log);
 * vacation suspend is a status change (`update_element` → `suspended`, prior status captured for
 * resume) — all under ONE shared `batchId` so the whole plan undoes as one (T044). No new op
 * types (the closed 15-op set is unchanged), no schema migration.
 *
 * Previews are READ-ONLY (no mutation, no op); applies are transactional + reversible. Undo
 * reuses the existing command-level/`batchId` undo (`undo.last`) — pre-images restore both
 * `elements.due_at`/`review_states.due_at` and the suspended items' prior status. There is still
 * no generic `db.query`.
 */
export const QueueCatchUpRequestSchema = z.object({
  /** "Now" the backlog read + plan compare against (ISO-8601); defaults to the server clock. */
  asOf: IsoTimestampInputSchema.optional(),
  /** Over how many days to spread the backlog (≥ 1; clamped main-side). */
  spreadDays: z.number().int().positive().optional(),
});
export type QueueCatchUpRequest = z.infer<typeof QueueCatchUpRequestSchema>;

/**
 * The vacation request — the away window + an optional clock. `awayEnd` MUST be ≥ `awayStart`
 * (a malformed window is rejected at the IPC boundary so a bad range can never be applied).
 */
export const QueueVacationRequestSchema = z
  .object({
    /** The away window start (inclusive, ISO-8601). */
    awayStart: IsoTimestampInputSchema,
    /** The away window end (inclusive, ISO-8601). */
    awayEnd: IsoTimestampInputSchema,
    /** "Now" the value ranking compares against (ISO-8601); defaults to the server clock. */
    asOf: IsoTimestampInputSchema.optional(),
  })
  .refine((value) => Date.parse(value.awayEnd) >= Date.parse(value.awayStart), {
    message: "awayEnd must be on or after awayStart",
    path: ["awayEnd"],
  });
export type QueueVacationRequest = z.infer<typeof QueueVacationRequestSchema>;

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

/**
 * The shared COST preview both modes return — it QUANTIFIES the cost of postponement so the
 * renderer can always show it BEFORE committing: total items moved, the new tail date, the days
 * added, the per-day load curve before vs after, and the per-item `slips` list.
 */
export interface RecoveryCostPreview {
  readonly moved: number;
  readonly newTailDueAt: string | null;
  readonly daysAdded: number;
  readonly loadBefore: readonly RecoveryLoadCurvePoint[];
  readonly loadAfter: readonly RecoveryLoadCurvePoint[];
  readonly slips: readonly RecoverySlipRow[];
}

/** The read-only catch-up preview the renderer shows BEFORE committing. */
export interface CatchUpPreview {
  /** The per-day cap the backlog is spread under (the daily review budget). */
  readonly budget: number;
  /** How many days the backlog is spread over. */
  readonly spreadDays: number;
  /** The quantified cost of postponement. */
  readonly cost: RecoveryCostPreview;
}

/** The read-only vacation preview the renderer shows BEFORE committing. */
export interface VacationPreview {
  readonly awayStart: string;
  readonly awayEnd: string;
  /** How many items are suspended for the away window. */
  readonly suspendedCount: number;
  /** How many items are shifted past return. */
  readonly shiftedCount: number;
  /** The quantified cost of postponement. */
  readonly cost: RecoveryCostPreview;
}

/** The result of applying a recovery plan (catch-up or vacation). */
export interface RecoveryApplyResult {
  /** How many items were moved (rescheduled/deferred). */
  readonly moved: number;
  /** How many items were suspended (vacation only; `0` for catch-up). */
  readonly suspended: number;
  /** The shared batch id (the whole plan undoes as one via `undo.last`). */
  readonly batchId: string;
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
  /**
   * True when this node is a soft-deleted tombstone (only emitted when the request
   * sets `includeTombstones`); always `false` on the default live-only path.
   */
  readonly deleted: boolean;
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
  /**
   * When `true`, include soft-deleted nodes as muted tombstones so a focused
   * element never vanishes from its own lineage (T135). Omitted/false keeps the
   * default live-only tree for yield / "review this branch" / analytics callers.
   */
  includeTombstones: z.boolean().optional(),
});
export type LineageGetRequest = z.infer<typeof LineageGetRequestSchema>;

export interface LineageGetResult {
  /** The lineage tree, or `null` when the id is unknown/soft-deleted. */
  readonly lineage: LineageData | null;
}

// ---------------------------------------------------------------------------
// elements.countDescendants() / elements.softDeleteSubtree()  (T135 — lineage-aware delete)
// ---------------------------------------------------------------------------

/**
 * The lineage-aware delete surface (T135). Deleting an element that sits in the
 * MIDDLE of the lineage tree must never silently orphan or silently hide live
 * work, so the renderer first asks for the blast radius:
 *
 *  - `countDescendants` → the typed live-descendant breakdown (extracts, cards,
 *    cards carrying review history, total). `total === 0` means "quiet delete, no
 *    menu"; otherwise the renderer opens the intent menu and quantifies the cost.
 *    Read-only — no mutation, no `operation_log`.
 *  - `softDeleteSubtree` → soft-delete the target node and OPTIONALLY its live
 *    subtree in ONE transaction under a shared `batchId`, recoverable as a unit.
 *    `includeSubtree: false` tombstones only the node (keep-descendants);
 *    `includeSubtree: true` soft-cascades the whole branch. Each per-node delete is
 *    preimage-aware (clears + records `elements.due_at`, and a card's
 *    `review_states.due_at`) so restore re-establishes the schedule exactly.
 *
 * The main process delegates to the `DescendantQuery` / `ExtractService` behind the
 * boundary; there is still no generic `db.query`.
 */

export const ElementsCountDescendantsRequestSchema = z.object({
  /** The element id whose live descendants to count (any type — lineage is universal). */
  id: ElementIdSchema,
});
export type ElementsCountDescendantsRequest = z.infer<typeof ElementsCountDescendantsRequestSchema>;

/** The live-descendant blast-radius breakdown that drives the delete intent menu. */
export interface ElementsCountDescendantsResult {
  /** Live descendant `extract` rows (includes sub-extracts). */
  readonly extracts: number;
  /** Live descendant `card` rows. */
  readonly cards: number;
  /** Live descendant cards with at least one `review_logs` row (review history). */
  readonly cardsWithHistory: number;
  /** Total live descendants of every kind (`0` ⇒ quiet delete, no menu). */
  readonly total: number;
}

export const ElementsSoftDeleteSubtreeRequestSchema = z.object({
  /** The target element id to soft-delete (and optionally its live subtree). */
  id: ElementIdSchema,
  /**
   * When `true`, soft-delete the node AND every live descendant under one shared
   * `batchId` ("delete the whole branch"). When `false`/omitted, tombstone only the
   * target node and leave its descendants live and connected ("keep descendants").
   */
  includeSubtree: z.boolean().optional(),
});
export type ElementsSoftDeleteSubtreeRequest = z.infer<
  typeof ElementsSoftDeleteSubtreeRequestSchema
>;

/** Why a node was skipped by a subtree soft-delete (it never fails the batch). */
export interface SubtreeDeleteSkippedRow {
  readonly id: string;
  /** `missing` (gone) or `already-deleted` (already in the trash). */
  readonly reason: "missing" | "already-deleted";
}

export interface ElementsSoftDeleteSubtreeResult {
  /** The shared `batchId` every `soft_delete_element` op in this delete carries. */
  readonly batchId: string;
  /** The ids actually soft-deleted by this call (root-first). */
  readonly affected: readonly string[];
  /** Ids the in-transaction revalidation skipped (missing / already in the trash). */
  readonly skipped: readonly SubtreeDeleteSkippedRow[];
}

// ---------------------------------------------------------------------------
// sources.importManual() / inbox.list() / inbox.get() / inbox.triage()  (T012)
// ---------------------------------------------------------------------------

/**
 * The first MUTATION surface on the bridge (T012). The renderer can create a
 * source in the `inbox`, list/preview inbox-status sources, change their
 * priority (A/B/C/D), accept them into active learning with an attention return
 * date, keep them for later, or delete them — every action validated main-side,
 * run in ONE transaction, and logged to `operation_log`. There is still no
 * generic `db.query`.
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

/**
 * Edit a source's reliability metadata (T091) — `sourceType` / `reliabilityTier` /
 * `confidence` / `reliabilityNotes`. Every field is OPTIONAL: an omitted field is LEFT
 * UNCHANGED; an explicit `null`/`""` (for notes) CLEARS it (a source with no reliability
 * data renders exactly as before, no badge). The three enums are validated against the
 * core tuples main-side; notes are bounded free text. Written in ONE transaction logging
 * `update_element` on the source element — NO new op type, NO lineage touched. The body
 * refine requires at least one field so an empty call is rejected.
 */
export const SourcesUpdateReliabilityRequestSchema = z
  .object({
    /** The source element id whose reliability to edit. */
    sourceId: ElementIdSchema,
    /** One of `SOURCE_TYPES` (`paper`/`book`/…), or `null` to clear. */
    sourceType: z.enum(SOURCE_TYPES).nullable().optional(),
    /** One of `RELIABILITY_TIERS` (`primary`/`secondary`/`tertiary`), or `null` to clear. */
    reliabilityTier: z.enum(RELIABILITY_TIERS).nullable().optional(),
    /** One of `CONFIDENCE_LEVELS` (`high`/`medium`/`low`), or `null` to clear. */
    confidence: z.enum(CONFIDENCE_LEVELS).nullable().optional(),
    /** Free-text reliability caveats / known biases (≤2048), or empty/`null` to clear. */
    reliabilityNotes: z.string().trim().max(2048).nullable().optional(),
  })
  .refine(
    (value) =>
      value.sourceType !== undefined ||
      value.reliabilityTier !== undefined ||
      value.confidence !== undefined ||
      value.reliabilityNotes !== undefined,
    { message: "sources.updateReliability requires at least one reliability field" },
  );
export type SourcesUpdateReliabilityRequest = z.infer<typeof SourcesUpdateReliabilityRequestSchema>;

export interface SourcesUpdateReliabilityResult {
  /**
   * The source's provenance after the edit (including the new reliability fields), so
   * the inspector reflects the refreshed badge WITHOUT a re-fetch (mirrors how the
   * other inspector edits return the updated row).
   */
  readonly provenance: SourceProvenance;
}

export const SourcesDismissRetirementSuggestionRequestSchema = z.object({
  sourceElementId: ElementIdSchema,
  signalHash: z.string().trim().min(1).max(512),
});
export type SourcesDismissRetirementSuggestionRequest = z.infer<
  typeof SourcesDismissRetirementSuggestionRequestSchema
>;

export interface SourcesDismissRetirementSuggestionResult {
  readonly dismissed: boolean;
  readonly stale: boolean;
  readonly suggestion: SourceRetirementSuggestion | null;
}

/** A flat, list-row summary for one inbox source. */
export interface InboxItemSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** Provenance source-type label, e.g. "Manual note", "Web article", or "PDF". */
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

/**
 * Automatic URL import (T060). The renderer passes ONLY a URL (+ optional
 * priority / reason); the MAIN process fetches the page, runs Readability,
 * sanitizes + snapshots it to the vault, converts it to ProseMirror, and creates
 * an `inbox` source. The renderer never fetches, never builds the doc, never
 * touches the vault. `forceNewVersion` is reserved for T061's "import new version
 * anyway" choice (it imports a second source even when a duplicate exists).
 */
export const SourcesImportUrlRequestSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  /** Coarse A/B/C/D priority; defaults `C` main-side so new material never dominates. */
  priority: PriorityLabelSchema.optional(),
  reasonAdded: z.string().trim().max(2048).optional(),
  /** T061: import a fresh source even if this canonical URL / content is already imported. */
  forceNewVersion: z.boolean().optional(),
});
export type SourcesImportUrlRequest = z.infer<typeof SourcesImportUrlRequestSchema>;

/**
 * One existing source that an import candidate duplicates (T061). Surfaced in the
 * `"duplicate"` result so the renderer can show "Already imported as '<title>' on
 * <date>" and offer "Open existing" / "Import new version" / "Cancel".
 */
export interface SourceDuplicateSummary {
  /** The existing source element's id (so "Open existing" can navigate to it). */
  readonly elementId: string;
  readonly title: string;
  /** Lifecycle status (never `deleted` — only live sources match). */
  readonly status: string;
  /** When it was imported/snapshotted (ISO-8601), or `null`. */
  readonly accessedAt: string | null;
  /** Which signal matched — the canonical URL or the cleaned-snapshot content hash. */
  readonly matchedBy: "canonicalUrl" | "contentHash";
}

/**
 * The discriminated URL-import result. T060 always returned the `"imported"` arm;
 * T061 adds the `"duplicate"` arm to this SAME shape (so the result never has a
 * breaking shape change). When the canonical URL or the cleaned-snapshot content
 * hash already maps to a live source (and `forceNewVersion` is false), the import
 * creates NOTHING and returns `"duplicate"` with the existing match(es); the user
 * then chooses Open existing / Import new version (re-call with `forceNewVersion`).
 */
export type SourcesImportUrlResult =
  | {
      readonly status: "imported";
      /** The new source element id. */
      readonly id: string;
      /** The fresh inbox summary for the created source. */
      readonly item: InboxItemSummary;
    }
  | {
      readonly status: "duplicate";
      /** The existing live source(s) this URL/content already maps to. */
      readonly matches: readonly SourceDuplicateSummary[];
    };

// ---------------------------------------------------------------------------
// sources.importPdf() / sources.getPdfData()  (T064 — local PDF import)
// ---------------------------------------------------------------------------

/**
 * PDF import (T064). The renderer cannot choose a filesystem path itself (no fs
 * access), so the command carries ONLY a priority/reason; the MAIN handler opens
 * a native file picker (filtered to `.pdf`), gets the chosen absolute path, and
 * runs `PdfImportService.importFromFile` (read + validate + stream into the vault
 * + parse + create an `inbox` source — all main-side). A large PDF never crosses
 * the IPC bridge as a payload; the picker keeps the path main-side.
 */
export const SourcesImportPdfRequestSchema = z.object({
  /** Coarse A/B/C/D priority; defaults `C` main-side so new material never dominates. */
  priority: PriorityLabelSchema.optional(),
  reasonAdded: z.string().trim().max(2048).optional(),
});
export type SourcesImportPdfRequest = z.infer<typeof SourcesImportPdfRequestSchema>;

/**
 * The PDF-import result. `"imported"` carries the new source + inbox summary;
 * `"cancelled"` is the user dismissing the native picker (a non-error outcome,
 * distinct from a thrown `PdfImportError` which the modal catch maps to a friendly
 * line via its `code`).
 */
export type SourcesImportPdfResult =
  | {
      readonly status: "imported";
      readonly id: string;
      readonly item: InboxItemSummary;
    }
  | {
      readonly status: "cancelled";
    };

/**
 * Serve a PDF source's ORIGINAL bytes to the renderer for rendering (T064). The
 * renderer never resolves a vault path — it passes only the source element id;
 * MAIN reads `sources.snapshotKey` (the `sources/<id>/original.pdf` relative path),
 * resolves it under `assetsDir`, and returns the bytes (capped to the import size)
 * for the `pdfjs-dist` canvas. The single ArrayBuffer transfer at open is
 * acceptable (Chromium handles it); a future scaled variant can stream over a
 * privileged protocol without a breaking change.
 */
export const SourcesGetPdfDataRequestSchema = z.object({
  elementId: ElementIdSchema,
});
export type SourcesGetPdfDataRequest = z.infer<typeof SourcesGetPdfDataRequestSchema>;

export interface SourcesGetPdfDataResult {
  /** The original PDF bytes, or `null` when the source is not a PDF / has no snapshot. */
  readonly bytes: ArrayBuffer | null;
  /** The number of pages (derived from `document_blocks.page`), or 0 when unknown. */
  readonly pageCount: number;
}

// ---------------------------------------------------------------------------
// sources.pickImportFile() / sources.importEpub()  (T067 — local EPUB import)
// ---------------------------------------------------------------------------

/**
 * Pick a local file to import (T067) — the SHARED file-picker command for all M14
 * file imports (EPUB now; T068 Markdown/HTML, T069 highlights, T070 Anki extend the
 * `kind` enum). The renderer cannot read the filesystem, so it asks MAIN to open a
 * native picker (filtered to the `kind`'s extensions) and returns the chosen
 * absolute path(s) — MAIN reads the bytes; the renderer never receives a `File`. The
 * single command serves every file kind so it is defined ONCE.
 */
export const PickImportFileRequestSchema = z.object({
  // `media` + `subtitles` (T073) extend the shared picker: `media` filters to the
  // video/audio extensions, `subtitles` to `.vtt`/`.srt` (the optional sidecar).
  kind: z.enum(["epub", "markdown", "html", "highlights", "anki", "media", "subtitles"]),
});
export type PickImportFileRequest = z.infer<typeof PickImportFileRequestSchema>;

/** The picker result: the chosen path(s), or a non-error cancellation. */
export type PickImportFileResult =
  | { readonly paths: readonly string[] }
  | { readonly cancelled: true };

/**
 * EPUB import (T067). After the renderer has a chosen `.epub` path (via
 * {@link PickImportFileRequestSchema}), it calls this with the path; MAIN reads +
 * validates the bytes, streams `original.epub` into the vault, parses the book, and
 * creates an `inbox` book `source` + one chapter `topic` per spine item — all main-
 * side. A large `.epub` never crosses the IPC bridge as a payload; only the path does.
 */
export const SourcesImportEpubRequestSchema = z.object({
  path: z.string().min(1),
  /** Coarse A/B/C/D priority; defaults `C` main-side so a fresh book never dominates. */
  priority: PriorityLabelSchema.optional(),
  reasonAdded: z.string().trim().max(2048).optional(),
});
export type SourcesImportEpubRequest = z.infer<typeof SourcesImportEpubRequestSchema>;

/**
 * The EPUB-import result. Discriminated on `status` so future arms (e.g. a
 * duplicate-book check) can be added without a breaking change; `"imported"` carries
 * the new book id, its chapter count, and the inbox summary for the BOOK source.
 */
export type SourcesImportEpubResult = {
  readonly status: "imported";
  readonly bookId: string;
  readonly chapterCount: number;
  readonly item: InboxItemSummary;
};

// ---------------------------------------------------------------------------
// sources.importMedia() / sources.getMediaData()  (T073 — local/YouTube media)
// ---------------------------------------------------------------------------

/**
 * Import a LOCAL media file as an inbox `source` (T073). After the renderer has a
 * chosen media path (via {@link PickImportFileRequestSchema} with kind `media`) — and
 * optionally a sidecar `.vtt`/`.srt` path (kind `subtitles`) — it calls this with the
 * path(s); MAIN reads the bytes, streams `original.<ext>` into the vault, parses the
 * (optional) transcript, and creates the source in one transaction. A large video never
 * crosses the IPC bridge as a payload; only the path does. YouTube rides the existing
 * `sources.importUrl` path (the service auto-routes when the URL is a YouTube URL).
 */
export const SourcesImportMediaRequestSchema = z.object({
  path: z.string().min(1),
  /** Optional ABSOLUTE path to a sidecar `.vtt`/`.srt` transcript. */
  subtitlesPath: z.string().min(1).nullable().optional(),
  /** Coarse A/B/C/D priority; defaults `C` main-side so new media never dominates. */
  priority: PriorityLabelSchema.optional(),
  reasonAdded: z.string().trim().max(2048).optional(),
});
export type SourcesImportMediaRequest = z.infer<typeof SourcesImportMediaRequestSchema>;

/**
 * The media-import result. `"imported"` carries the new source + inbox summary +
 * the media discriminator + whether a transcript was produced; discriminated on
 * `status` so future arms can be added without a breaking change.
 */
export type SourcesImportMediaResult = {
  readonly status: "imported";
  readonly id: string;
  readonly item: InboxItemSummary;
  /** `"video"`/`"audio"` (a local file) or `"youtube"`. */
  readonly mediaKind: "video" | "audio" | "youtube";
  /** Whether a transcript body was produced (vs the placeholder). */
  readonly hasTranscript: boolean;
};

/**
 * Serve a media source's playable data to the renderer (T073). For a LOCAL source MAIN
 * resolves the vault path; the renderer's `<video>`/`<audio>` plays the privileged
 * `media://<elementId>` URL (streamed with HTTP Range support — the bytes are NOT
 * buffered over IPC), so this returns `mediaSource: "local"` + the mime/duration. For a
 * YOUTUBE source it returns `mediaSource: "youtube"` + the video id (the renderer uses
 * the IFrame embed; no bytes). The renderer passes only an element id; MAIN owns the
 * path. Read-only.
 */
export const SourcesGetMediaDataRequestSchema = z.object({
  elementId: ElementIdSchema,
});
export type SourcesGetMediaDataRequest = z.infer<typeof SourcesGetMediaDataRequestSchema>;

export interface SourcesGetMediaDataResult {
  /** `"local"` (a vault asset, played via `media://`) or `"youtube"` (an IFrame embed). */
  readonly mediaSource: "local" | "youtube";
  /** `"video"`/`"audio"` for a local source, else `null`. */
  readonly mediaKind: "video" | "audio" | null;
  /** The privileged `media://<elementId>` URL for a local source, else `null`. */
  readonly mediaUrl: string | null;
  /** The MIME type of the local media, else `null`. */
  readonly mime: string | null;
  /** The YouTube video id for a youtube source, else `null`. */
  readonly youtubeId: string | null;
  /** The media duration in ms (local source), else `null`. */
  readonly durationMs: number | null;
}

// ---------------------------------------------------------------------------
// sources.importDocument() / importMarkdownText() / documents.exportMarkdown()
//   (T068 — local Markdown & HTML import/export)
// ---------------------------------------------------------------------------

/**
 * Import a local `.md`/`.markdown` or `.html`/`.htm` file (T068). After the renderer
 * has a chosen path (via {@link PickImportFileRequestSchema} with kind
 * `markdown`/`html`), it calls this with the path + format; MAIN reads + parses the
 * bytes (Markdown via `markdown-it`, HTML via sanitize+HTML→PM) and creates an `inbox`
 * source in one transaction. The body never crosses the IPC bridge — only the path.
 */
export const SourcesImportDocumentRequestSchema = z.object({
  path: z.string().min(1),
  format: z.enum(["markdown", "html"]),
  priority: PriorityLabelSchema.optional(),
  reasonAdded: z.string().trim().max(2048).optional(),
});
export type SourcesImportDocumentRequest = z.infer<typeof SourcesImportDocumentRequestSchema>;

/**
 * Import PASTED Markdown text (T068) — the paste path, no file read. MAIN parses the
 * text + creates an `inbox` source. The optional `title` overrides the first-heading /
 * default title.
 */
export const SourcesImportMarkdownTextRequestSchema = z.object({
  text: z.string().min(1),
  title: z.string().trim().max(512).optional(),
  priority: PriorityLabelSchema.optional(),
  reasonAdded: z.string().trim().max(2048).optional(),
});
export type SourcesImportMarkdownTextRequest = z.infer<
  typeof SourcesImportMarkdownTextRequestSchema
>;

/**
 * The document-import result (Markdown/HTML file OR pasted Markdown). Discriminated on
 * `status` so future arms can be added without a breaking change; `"imported"` carries
 * the new source id + its inbox summary.
 */
export type SourcesImportDocumentResult = {
  readonly status: "imported";
  readonly id: string;
  readonly item: InboxItemSummary;
};

/**
 * Export a document (source/extract/topic) to Markdown (T068). MAIN loads the stored
 * ProseMirror doc, serializes it, and writes the `.md` into the OS Downloads directory.
 * Read-only on the DB (no mutation, no op-log entry).
 */
export const DocumentsExportMarkdownRequestSchema = z.object({
  elementId: z.string().min(1),
});
export type DocumentsExportMarkdownRequest = z.infer<typeof DocumentsExportMarkdownRequestSchema>;

/** The export result — display-safe metadata for the written `.md`. */
export type DocumentsExportMarkdownResult = {
  readonly relativePath: string;
  readonly directoryLabel: "Downloads";
};

// ---------------------------------------------------------------------------
// sources.importHighlights()  (T069 — Readwise / Kindle highlight import)
// ---------------------------------------------------------------------------

/**
 * Import an external highlight export (T069) — a Readwise CSV/JSON export or a Kindle
 * `My Clippings.txt`. After the renderer has a chosen path (via
 * {@link PickImportFileRequestSchema} with kind `highlights`), it calls this with the
 * path; MAIN reads + parses the file (auto-detecting the format, or using the supplied
 * one) and turns the highlights into inbox `extract` elements grouped under one
 * `source` per book/article — NEVER cards. The file never crosses the bridge as a
 * payload; only the path does.
 */
export const SourcesImportHighlightsRequestSchema = z.object({
  path: z.string().min(1),
  /** Optional explicit format; omitted ⇒ MAIN auto-detects by filename + content. */
  format: z.enum(["readwise_csv", "readwise_json", "kindle_clippings"]).optional(),
  /** Coarse A/B/C/D priority; defaults `C` main-side so imports never dominate. */
  priority: PriorityLabelSchema.optional(),
});
export type SourcesImportHighlightsRequest = z.infer<typeof SourcesImportHighlightsRequestSchema>;

/**
 * The highlight-import result. Discriminated on `status` so future arms can be added
 * without a breaking change; `"imported"` carries the detected format, the per-import
 * counts (sources created/updated, extracts added, duplicate highlights skipped), and
 * the inbox summaries for the affected sources.
 */
export type SourcesImportHighlightsResult = {
  readonly status: "imported";
  readonly format: "readwise_csv" | "readwise_json" | "kindle_clippings";
  readonly sourceCount: number;
  readonly extractCount: number;
  readonly skipped: number;
  readonly items: readonly InboxItemSummary[];
};

// ---------------------------------------------------------------------------
// cards.importAnki() / cards.exportAnki()  (T070 — Anki .apkg/CSV interop)
// ---------------------------------------------------------------------------

/**
 * Import an Anki `.apkg` deck (T070) — after the renderer has a chosen path (via
 * {@link PickImportFileRequestSchema} with kind `anki`), it calls this with the path;
 * MAIN unwraps the ZIP, opens the embedded `collection.anki2` with `better-sqlite3`,
 * and authors the notes as `card` elements under a per-deck `source`, preserving
 * review history when available. The archive never crosses the bridge — only the path.
 */
export const CardsImportAnkiRequestSchema = z.object({
  path: z.string().min(1),
  /** Coarse A/B/C/D priority; defaults `C` main-side so a fresh deck never dominates. */
  priority: PriorityLabelSchema.optional(),
});
export type CardsImportAnkiRequest = z.infer<typeof CardsImportAnkiRequestSchema>;

/**
 * The Anki-import result. Discriminated on `status`; `"imported"` carries the deck +
 * card counts, how many cards carried scheduling history over (`withHistory`), and the
 * inbox summary for the per-deck `source`.
 */
export type CardsImportAnkiResult = {
  readonly status: "imported";
  readonly deckCount: number;
  readonly cardCount: number;
  readonly withHistory: number;
  readonly item: InboxItemSummary;
};

/**
 * Export selected cards to an Anki-compatible `.apkg` or CSV (T070). The selection is
 * explicit card ids, a concept's cards, or all live cards; the format is `apkg` or
 * `csv`. MAIN builds the file in the OS Downloads directory (read-only on the DB,
 * carrying source refs OUT to Anki) and returns display-safe metadata + card count.
 */
export const CardsExportAnkiRequestSchema = z
  .object({
    format: z.enum(["apkg", "csv"]),
    cardIds: z.array(ElementIdSchema).optional(),
    conceptId: ElementIdSchema.optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => (v.cardIds && v.cardIds.length > 0) || v.conceptId != null || v.all === true, {
    message: "Provide a non-empty cardIds, a conceptId, or all=true.",
  });
export type CardsExportAnkiRequest = z.infer<typeof CardsExportAnkiRequestSchema>;

/** The Anki-export result — display-safe file metadata + card count. */
export type CardsExportAnkiResult = {
  readonly relativePath: string;
  readonly directoryLabel: "Downloads";
  readonly cardCount: number;
};

// ---------------------------------------------------------------------------
// sources.extractRegion() / sources.getRegionImage()  (T065 — PDF region extract)
// ---------------------------------------------------------------------------

/** Max bytes a single cropped figure PNG may cross the IPC bridge (T065). */
const MAX_REGION_PNG_BYTES = 8 * 1024 * 1024; // 8 MB — one figure crop is far under this.

/**
 * A normalized region rectangle (T065): fractions `0–1` of the page's rendered
 * width/height (scale-independent). Validated `0≤·≤1`, `x0<x1`, `y0<y1` so an
 * inverted/out-of-range rect cannot cross the bridge.
 */
export const RegionRectSchema = z
  .object({
    x0: z.number().min(0).max(1),
    y0: z.number().min(0).max(1),
    x1: z.number().min(0).max(1),
    y1: z.number().min(0).max(1),
  })
  .refine((r) => r.x0 < r.x1 && r.y0 < r.y1, {
    message: "region must have x0<x1 and y0<y1",
  });
export type RegionRectInput = z.infer<typeof RegionRectSchema>;

/**
 * PDF region extraction (T065). The renderer crops the figure/table from the page
 * it already rendered to a `<canvas>` and ships the small PNG `ArrayBuffer` + the
 * normalized rect + page; MAIN streams the bytes into the vault (`media/<asset_id>/
 * original.png`) and creates a `media_fragment` extract whose `source_locations`
 * row carries the page + region. The PNG byteLength is size-capped so a hostile/
 * huge crop cannot cross the bridge.
 */
export const SourcesExtractRegionRequestSchema = z.object({
  /** The PDF source element the region was drawn over (the lineage root). */
  sourceElementId: ElementIdSchema,
  /** The 1-based page the region sits on. */
  page: z.number().int().min(1),
  /** The page's heading/first stable block id — the region's jump anchor. */
  pageBlockId: z.string().min(1).max(128),
  /** The normalized bounding box (fractions 0–1). */
  region: RegionRectSchema,
  /** The cropped figure PNG bytes (produced in the renderer's `<canvas>`). */
  imagePng: z
    .instanceof(ArrayBuffer)
    .refine((b) => b.byteLength > 0 && b.byteLength <= MAX_REGION_PNG_BYTES, {
      message: `imagePng must be 1..${MAX_REGION_PNG_BYTES} bytes`,
    }),
  /** Optional user caption; defaults to "Figure on page N" main-side. */
  caption: z.string().trim().max(512).nullable().optional(),
  /** Optional A/B/C/D priority override; else INHERITS the source's priority. */
  priority: PriorityLabelSchema.optional(),
});
export type SourcesExtractRegionRequest = z.infer<typeof SourcesExtractRegionRequestSchema>;

/** The created region extract's `media_fragment` summary. */
export interface RegionExtractSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** The attention `due_at` (ISO-8601) — a region fragment is an attention item, never FSRS. */
  readonly dueAt: string | null;
  readonly sourceId: string | null;
  readonly parentId: string | null;
}

/** The created region extract's stored region source-location anchor. */
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

/**
 * Serve a region extract's cropped IMAGE bytes to the renderer (T065) for the
 * inspector/extract detail view — the renderer passes only the `media_fragment`
 * element id; MAIN resolves the owning `image` asset's vault path and returns the
 * bytes (the renderer never resolves a path).
 */
export const SourcesGetRegionImageRequestSchema = z.object({
  elementId: ElementIdSchema,
});
export type SourcesGetRegionImageRequest = z.infer<typeof SourcesGetRegionImageRequestSchema>;

export interface SourcesGetRegionImageResult {
  /** The cropped PNG bytes, or `null` when the element has no image asset. */
  readonly bytes: ArrayBuffer | null;
  /** The image MIME (e.g. `image/png`), or `null`. */
  readonly mime: string | null;
}

// ---------------------------------------------------------------------------
// sources.extractClip()  (T074 — video/audio clip extract)
// ---------------------------------------------------------------------------

/** Max chars a transcript segment may carry across the IPC bridge for a clip (T074). */
const MAX_CLIP_TRANSCRIPT_CHARS = 8000;

/**
 * Video/audio clip extraction (T074). The renderer selects a start/end timestamp (a
 * scrubber range, or a run of transcript cues) and ships ONLY the `{ startMs, endMs }`
 * + the source id + the anchor block id + the (optional) transcript segment under the
 * range; MAIN creates a scheduled `media_fragment` whose `source_locations` row carries
 * the start `timestamp_ms` + the clip window. NO bytes are cut/re-encoded — the clip is
 * a time window onto the original media. The window is validated `startMs >= 0`,
 * `endMs > startMs`, both integers; MAIN further checks `endMs ≤ durationMs`.
 */
export const SourcesExtractClipRequestSchema = z.object({
  /** The media source element the clip was selected over (the lineage root). */
  sourceElementId: ElementIdSchema,
  /** The clip start in integer milliseconds. */
  startMs: z.number().int().min(0),
  /** The clip end in integer milliseconds. */
  endMs: z.number().int().min(1),
  /** The stable block id the clip anchors to (the first cue in range, or placeholder). */
  anchorBlockId: z.string().min(1).max(128),
  /** The transcript segment under the range (when a transcript exists), else null. */
  transcriptSegment: z.string().max(MAX_CLIP_TRANSCRIPT_CHARS).nullable().optional(),
  /** Optional user caption; defaults to the "Clip M:SS–M:SS" label main-side. */
  caption: z.string().trim().max(512).nullable().optional(),
  /** Optional A/B/C/D priority override; else INHERITS the source's priority. */
  priority: PriorityLabelSchema.optional(),
});
export const SourcesExtractClipRequestSchemaRefined = SourcesExtractClipRequestSchema.refine(
  (r) => r.endMs > r.startMs,
  { message: "clip must have endMs > startMs" },
);
export type SourcesExtractClipRequest = z.infer<typeof SourcesExtractClipRequestSchema>;

/** A clip window `{ startMs, endMs }` (integer ms), the IPC mirror of `ClipWindow`. */
export interface ClipWindowSummary {
  readonly startMs: number;
  readonly endMs: number;
}

/** The created clip extract's `media_fragment` summary. */
export interface ClipExtractSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** The attention `due_at` (ISO-8601) — a clip fragment is an attention item, never FSRS. */
  readonly dueAt: string | null;
  readonly sourceId: string | null;
  readonly parentId: string | null;
}

/** The created clip extract's stored clip source-location anchor. */
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

// ---------------------------------------------------------------------------
// sources.runOcr() / sources.getOcr() / sources.acceptOcr()  (T066 — OCR fallback)
// ---------------------------------------------------------------------------

/** Max bytes a single rendered page PNG may cross the IPC bridge for OCR (T066). */
const MAX_OCR_PAGE_PNG_BYTES = 24 * 1024 * 1024; // 24 MB — a high-DPI full page.

/**
 * Run OCR on one scanned/text-free PDF page (T066). The renderer renders the page
 * to a PNG (it already has the page on a `<canvas>`) and ships the size-capped
 * bytes; MAIN writes the PNG to the vault (`sources/<id>/ocr/page-N.png`) and
 * enqueues an `ocr` job carrying ONLY that vault-relative path (never the bytes —
 * a persisted `jobs` row holds no blob). The worker OCRs it on the T058 runner with
 * the bundled WASM/lang (offline); MAIN applies the result into the `ocr_pages`
 * layer. The renderer observes progress via the existing `jobs.subscribe` surface.
 */
export const SourcesRunOcrRequestSchema = z.object({
  elementId: ElementIdSchema,
  /** The 1-based page to OCR. */
  page: z.number().int().min(1),
  /** The rendered page PNG bytes (produced in the renderer's `<canvas>`). */
  imagePng: z
    .instanceof(ArrayBuffer)
    .refine((b) => b.byteLength > 0 && b.byteLength <= MAX_OCR_PAGE_PNG_BYTES, {
      message: `imagePng must be 1..${MAX_OCR_PAGE_PNG_BYTES} bytes`,
    }),
});
export type SourcesRunOcrRequest = z.infer<typeof SourcesRunOcrRequestSchema>;

export interface SourcesRunOcrResult {
  /** How many `ocr` jobs were enqueued (1 for a single page). */
  readonly enqueued: number;
  /** The enqueued job id (so the renderer can observe its progress). */
  readonly jobId: string;
}

/** Read a PDF source's OCR suggestion layer (T066) — per-page text + confidence. */
export const SourcesGetOcrRequestSchema = z.object({
  elementId: ElementIdSchema,
});
export type SourcesGetOcrRequest = z.infer<typeof SourcesGetOcrRequestSchema>;

/** One page's OCR suggestion (the renderer shows the text + a confidence badge). */
export interface OcrPageSummary {
  readonly page: number;
  readonly text: string;
  /** Mean confidence 0–100 (the renderer derives a green/amber/red badge). */
  readonly meanConfidence: number;
  /** `suggested` | `accepted` | `dismissed`. */
  readonly status: string;
}

export interface SourcesGetOcrResult {
  readonly pages: readonly OcrPageSummary[];
}

/**
 * Accept / dismiss one page's OCR suggestion (T066). Accepting MERGES the text into
 * the page body via the normal `documents.save` → `update_document` path (so it
 * becomes searchable/extractable) and sets the row `accepted`; dismissing sets
 * `dismissed`. The text is NEVER auto-merged — the user accepts it explicitly.
 */
export const SourcesAcceptOcrRequestSchema = z.object({
  elementId: ElementIdSchema,
  page: z.number().int().min(1),
});
export type SourcesAcceptOcrRequest = z.infer<typeof SourcesAcceptOcrRequestSchema>;

export interface SourcesAcceptOcrResult {
  /** Whether the OCR text was merged into the body (false when no suggestion). */
  readonly accepted: boolean;
}

// ---------------------------------------------------------------------------
// ai.run() / ai.list() / ai.approveCard() / ai.dismiss() / ai.status()  (T093)
// ---------------------------------------------------------------------------

/** Zod mirror of the closed `AiActionType` union (built from the core tuple). */
export const AiActionTypeSchema = z.enum(AI_ACTION_TYPES);
/** Zod mirror of the closed `AiProviderKind` union (built from the core tuple). */
export const AiProviderKindSchema = z.enum(AI_PROVIDER_KINDS);

/**
 * Run an AI formulation action over a selected span (T093). The renderer ships the
 * SAME selection payload the T021 extraction path uses (the source element id + the
 * ordered stable block ids + offsets + the verbatim selected text); MAIN reads
 * settings (throwing when AI is off), builds the request, and enqueues an `ai` job on
 * the T058 runner — the renderer observes via the existing `jobs.subscribe`. The API
 * key is NEVER in this request (it lives main-side, baked into the worker fork env).
 */
export const AiRunRequestSchema = z.object({
  /** The extract/source the action runs ON (the suggestion's owner; lineage parent). */
  owningElementId: ElementIdSchema,
  action: AiActionTypeSchema,
  sourceRef: z.object({
    /** The source element the span lives in (the jump-to-source target, T094). */
    sourceElementId: ElementIdSchema,
    /** Ordered STABLE block ids the span covers (document order). */
    blockIds: z.array(z.string().min(1).max(128)).min(1).max(10_000),
    /** Char offset within the FIRST spanned block where the span starts. */
    startOffset: z.number().int().min(0).nullable().optional(),
    /** Char offset within the LAST spanned block where the span ends. */
    endOffset: z.number().int().min(0).nullable().optional(),
    /** The verbatim selected source quote (the grounding) — bounded for the prompt. */
    selectedText: z.string().min(1).max(AI_SOURCE_TEXT_MAX),
    /** Optional surrounding context to improve the formulation. */
    context: z.string().max(AI_SOURCE_TEXT_MAX).optional(),
  }),
});
export type AiRunRequest = z.infer<typeof AiRunRequestSchema>;

export interface AiRunResult {
  /** The enqueued job id (the renderer observes its progress via `jobs.subscribe`). */
  readonly jobId: string;
}

/** One card-quality check row crossing IPC (the same T035/T086 shape, inlined). */
export interface AiQualityCheck {
  readonly id: string;
  readonly severity: "ok" | "warn" | "block";
  readonly message: string;
}

/** A draft card carried in a card-shaped suggestion. */
export interface AiDraftCard {
  readonly kind: "qa" | "cloze";
  readonly prompt?: string;
  readonly answer?: string;
  readonly cloze?: string;
}

/** A renderer-safe AI suggestion + its resolved grounding (T093/T094). NO key. */
export interface AiSuggestionView {
  readonly id: string;
  readonly action: AiActionType;
  readonly kind: AiSuggestionKind;
  /** The MODEL's generated text (stored separately from the source quote). */
  readonly text: string;
  readonly cards: readonly AiDraftCard[];
  readonly status: string;
  /** The card-quality warnings on any card draft (shown before approval). */
  readonly qualityChecks: readonly AiQualityCheck[];
  /** The resolved grounding refblock (the source span this was made about, T094). */
  readonly grounding: SourceRef;
  /**
   * The grounding span as a jump-to-source location (T094) — source element id +
   * ordered stable block ids + offsets + label, so the drafts panel can wire an
   * in-app "jump to source" on the refblock exactly like an extract/card. `null`
   * when the span has no resolvable source (the orphan case — no jump affordance).
   */
  readonly groundingLocation: LocationSummary | null;
}

/** List the draft suggestions for an element (T093). */
export const AiListRequestSchema = z.object({
  elementId: ElementIdSchema,
});
export type AiListRequest = z.infer<typeof AiListRequestSchema>;

export interface AiListResult {
  readonly suggestions: readonly AiSuggestionView[];
}

/** Approve a card-shaped suggestion → mint a PARKED, un-due `card_draft` (T093). */
export const AiApproveRequestSchema = z.object({
  suggestionId: z.string().min(1).max(128),
});
export type AiApproveRequest = z.infer<typeof AiApproveRequestSchema>;

export interface AiApproveResult {
  readonly approved: boolean;
  /** The minted parked `card_draft` element id (when approved). */
  readonly cardId?: string;
  /** Why approval was refused (`not_found` / `not_draft` / `not_a_card` / `empty_card`). */
  readonly reason?: string;
}

/** Dismiss a draft suggestion (soft) (T093). */
export const AiDismissRequestSchema = z.object({
  suggestionId: z.string().min(1).max(128),
});
export type AiDismissRequest = z.infer<typeof AiDismissRequestSchema>;

export interface AiDismissResult {
  readonly dismissed: boolean;
}

/** The AI disabled-state + disclosure data (T093) — NO key (only `keyConfigured`). */
export interface AiStatusResult {
  readonly enabled: boolean;
  readonly providerKind: AiProviderKind;
  /** Whether an own-key is configured (the key itself is NEVER returned). */
  readonly keyConfigured: boolean;
  readonly modelDownloaded: boolean;
  readonly managedProxyEnabled: boolean;
}

/** Download / warm the local AI model (T093) — flips `aiModelDownloaded`. */
export const AiDownloadModelRequestSchema = z.void();
export interface AiDownloadModelResult {
  readonly downloaded: boolean;
}

// ---------------------------------------------------------------------------
// jobs.list() / jobs.subscribe()  (T058 — observe the local background runner)
// ---------------------------------------------------------------------------

/**
 * A renderer-safe projection of a background-runner job (T058). It carries the
 * lifecycle fields the renderer observes — NO raw `payload`/`result` bytes (the
 * `url_import` terminal result the renderer cares about is the inbox summary,
 * surfaced via the existing {@link SourcesImportUrlResult}). The renderer never
 * runs a job; it only observes via `jobs.list` / `jobs.subscribe`.
 */
export interface JobSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  /** Progress as an integer percent 0–100. */
  readonly progressRatio: number;
  readonly progressNote: string | null;
  /** A terminal error line (with a leading `code:`), or `null`. */
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Observe the current queue (optionally filtered) for a maintenance view. */
export const JobsListRequestSchema = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES).optional(),
  limit: z.number().int().positive().max(500).optional(),
});
export type JobsListRequest = z.infer<typeof JobsListRequestSchema>;

export interface JobsListResult {
  readonly jobs: readonly JobSummary[];
}

// ---------------------------------------------------------------------------
// vault.verify() / vault.findOrphans() / vault.collectOrphans()  (T059)
// ---------------------------------------------------------------------------

/**
 * Vault integrity-verify request (T059) — currently no scope; a future scoped
 * variant (e.g. one source) can extend this shape without a breaking change.
 */
export const VaultVerifyRequestSchema = z.void();
export type VaultVerifyRequest = z.infer<typeof VaultVerifyRequestSchema>;

/**
 * The vault integrity report: counts of OK assets + the asset ids whose stored
 * bytes hashed to a different value (`mismatched`) or whose file is gone
 * (`missing`), plus on-disk vault files with no `assets` row (`extraFiles`,
 * canonical relative paths). Read-only — verify reports, it never mutates.
 */
export interface VaultVerifyResult {
  readonly ok: number;
  readonly mismatched: readonly string[];
  readonly missing: readonly string[];
  readonly extraFiles: readonly string[];
}

/** Vault orphan-scan request (T059) — no scope; scans the whole `assetsDir`. */
export const VaultFindOrphansRequestSchema = z.void();
export type VaultFindOrphansRequest = z.infer<typeof VaultFindOrphansRequestSchema>;

/**
 * The orphan-scan result. Each orphan is a vault FILE (its canonical relative path
 * + size) — the orphan unit is the unreferenced file, not a dangling asset row
 * (the cascade FK makes a dangling row unreachable). There is no `reason`/`assetId`
 * field: an orphan is by definition a file with no live asset row.
 */
export interface VaultOrphansResult {
  readonly orphans: readonly { relativePath: string; size: number }[];
  readonly totalBytes: number;
}

/**
 * Collect (delete) confirmed orphan files (T059). `confirm: z.literal(true)` makes
 * a destructive sweep impossible to trigger accidentally from the renderer; the
 * optional `relativePaths` allow-list lets the UI confirm exactly the files
 * `findOrphans` showed (keyed on the same relative-path orphan identity).
 */
export const VaultCollectOrphansRequestSchema = z.object({
  confirm: z.literal(true),
  relativePaths: z.array(z.string()).optional(),
});
export type VaultCollectOrphansRequest = z.infer<typeof VaultCollectOrphansRequestSchema>;

export interface VaultCollectOrphansResult {
  readonly removed: number;
  readonly freedBytes: number;
}

// ---------------------------------------------------------------------------
// maintenance.*  (T099 — large-collection maintenance reports + cleanup actions)
// ---------------------------------------------------------------------------

/**
 * The Maintenance surface (T099) — the janitor's report + cleanup commands. Every
 * REPORT is a read-only domain query (no `operation_log`); every ACTION is a
 * transactional, op-logged, soft-delete / undoable mutation, with the ONLY hard deletes
 * being the existing `trash.purge` (elements) + `vault.collectOrphans` (files). The
 * destructive actions take explicit id lists / `confirm: z.literal(true)` (orphan
 * media) / a bounded `mode` enum (`bulkArchive`). NO asset id crosses IPC as a request
 * input (orphan media takes canonical relative paths; `missingAssetIds` is result-only)
 * and there is NO generic `db.query`.
 */

/** A compact element descriptor in a maintenance report (no asset ids, no raw paths). */
export interface MaintenanceRefSummary {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly priority: number;
  readonly priorityLabel?: string;
  readonly createdAt: string;
}

/** One duplicate cluster: the keeper + the removable copies. */
export interface DuplicateClusterSummary {
  readonly key: string;
  readonly matchedBy: "canonicalUrl" | "contentHash";
  readonly canonical: MaintenanceRefSummary;
  readonly duplicates: readonly MaintenanceRefSummary[];
}

/** The collection-wide duplicate rollup. */
export interface DuplicateReportResult {
  readonly sourceClusters: readonly DuplicateClusterSummary[];
  readonly cardClusters: readonly DuplicateClusterSummary[];
  readonly extractClusters: readonly DuplicateClusterSummary[];
  readonly totalDuplicates: number;
}

/** `maintenance.report()` — the hub rollup (counts + integrity-not-run flag). */
export const MaintenanceReportRequestSchema = z.void();
export type MaintenanceReportRequest = z.infer<typeof MaintenanceReportRequestSchema>;

export interface MaintenanceReportResult {
  readonly duplicateCount: number;
  readonly cardsWithoutSourcesCount: number;
  readonly schedulerConsistencyCount: number;
  readonly parkedResurfacingCount: number;
  readonly chronicPostponeCount: number;
  readonly orphanFileCount: number;
  readonly orphanBytes: number;
  readonly lowValueCount: number;
  /** `null` — the DB+vault integrity deep check is on-demand (not auto-run). */
  readonly integrity: null;
}

/** `maintenance.duplicates()` — the full cluster drill-down. */
export const MaintenanceDuplicatesRequestSchema = z.void();
export type MaintenanceDuplicatesRequest = z.infer<typeof MaintenanceDuplicatesRequestSchema>;
export type MaintenanceDuplicatesResult = DuplicateReportResult;

/** One sourceless-card row (a lineage gap the user fixes or trashes). */
export interface LineageGapRowSummary {
  readonly card: MaintenanceRefSummary;
  readonly hasSourceLocation: false;
  readonly hasSourceAncestor: false;
  readonly createdAt: string;
}

/** `maintenance.cardsWithoutSources()`. */
export const MaintenanceCardsWithoutSourcesRequestSchema = z.void();
export type MaintenanceCardsWithoutSourcesRequest = z.infer<
  typeof MaintenanceCardsWithoutSourcesRequestSchema
>;
export interface MaintenanceCardsWithoutSourcesResult {
  readonly rows: readonly LineageGapRowSummary[];
}

/** One broken-source row: a source you can no longer open. */
export interface BrokenSourceRowSummary {
  readonly source: MaintenanceRefSummary;
  readonly reason: "missingFile" | "noSnapshot";
  /** Result-only — never a request input (no asset id crosses IPC inbound). */
  readonly missingAssetIds: readonly string[];
}

/** `maintenance.brokenSources()` — composes the SQL candidates + the vault disk join. */
export const MaintenanceBrokenSourcesRequestSchema = z.void();
export type MaintenanceBrokenSourcesRequest = z.infer<typeof MaintenanceBrokenSourcesRequestSchema>;
export interface MaintenanceBrokenSourcesResult {
  readonly rows: readonly BrokenSourceRowSummary[];
}

export type SchedulerConsistencyReason =
  | "terminal-element-due"
  | "terminal-card-review-due"
  | "retired-card-review-due"
  | "scheduled-attention-missing-due"
  | "attention-due-before-last-seen"
  | "chronic-postpone-paused"
  | "chronic-postpone-reset";

export interface SchedulerConsistencyRowSummary {
  readonly element: MaintenanceRefSummary & { readonly status: string };
  readonly reason: SchedulerConsistencyReason;
  readonly elementDueAt: string | null;
  readonly reviewDueAt: string | null;
}

export const MaintenanceSchedulerConsistencyRequestSchema = z
  .object({ limit: z.number().int().positive().max(500).optional() })
  .optional();
export type MaintenanceSchedulerConsistencyRequest = z.infer<
  typeof MaintenanceSchedulerConsistencyRequestSchema
>;
export interface MaintenanceSchedulerConsistencyResult {
  readonly rows: readonly SchedulerConsistencyRowSummary[];
}

/** One low-value, stale candidate for the bulk postpone / archive action. */
export interface LowValueRowSummary {
  readonly element: MaintenanceRefSummary;
  readonly lastActivityAt: string;
  readonly daysSinceActivity: number;
}

/** `maintenance.lowValue({ asOf?, limit? })`. */
export const MaintenanceLowValueRequestSchema = z
  .object({
    asOf: IsoTimestampInputSchema.optional(),
    limit: z.number().int().positive().optional(),
  })
  .optional();
export type MaintenanceLowValueRequest = z.infer<typeof MaintenanceLowValueRequestSchema>;
export interface MaintenanceLowValueResult {
  readonly rows: readonly LowValueRowSummary[];
}

/** `maintenance.integrity({ deep? })` — the on-demand deep DB+vault check. */
export const MaintenanceIntegrityRequestSchema = z
  .object({ deep: z.boolean().optional() })
  .optional();
export type MaintenanceIntegrityRequest = z.infer<typeof MaintenanceIntegrityRequestSchema>;
export interface MaintenanceIntegrityResult {
  readonly db: {
    readonly ok: boolean;
    readonly integrityCheck: readonly string[];
    readonly foreignKeyViolations: number;
    readonly mode: "quick_check" | "integrity_check";
  };
  readonly vault: {
    readonly ok: number;
    readonly mismatched: readonly string[];
    readonly missing: readonly string[];
    readonly extraFiles: readonly string[];
  };
}

/** The shared shape of every bulk cleanup action's result. */
export interface MaintenanceBatchResultSummary {
  readonly affected: number;
  readonly batchId: string;
}

/** `maintenance.dedupe({ removeIds })` — soft-delete validated non-keeper duplicates. */
export const MaintenanceDedupeRequestSchema = z.object({
  removeIds: z.array(ElementIdSchema).min(1),
});
export type MaintenanceDedupeRequest = z.infer<typeof MaintenanceDedupeRequestSchema>;
export type MaintenanceDedupeResult = MaintenanceBatchResultSummary;

/**
 * `maintenance.orphanMedia({ confirm, relativePaths? })` — the confirmed vault GC +
 * the vector prune. `confirm: z.literal(true)` makes the destructive sweep impossible
 * to trigger accidentally; `relativePaths` are the canonical paths `vault.findOrphans`
 * returned (no raw absolute path crosses IPC).
 */
export const MaintenanceOrphanMediaRequestSchema = z.object({
  confirm: z.literal(true),
  relativePaths: z.array(z.string()).optional(),
});
export type MaintenanceOrphanMediaRequest = z.infer<typeof MaintenanceOrphanMediaRequestSchema>;
export interface MaintenanceOrphanMediaResult {
  readonly removed: number;
  readonly freedBytes: number;
  readonly vectorsPruned: number;
}

/** `maintenance.bulkTrash({ ids })` — soft-delete a chosen id list as one batch. */
export const MaintenanceBulkTrashRequestSchema = z.object({
  ids: z.array(ElementIdSchema).min(1),
});
export type MaintenanceBulkTrashRequest = z.infer<typeof MaintenanceBulkTrashRequestSchema>;
export type MaintenanceBulkTrashResult = MaintenanceBatchResultSummary;

/** `maintenance.bulkArchive({ ids, mode })` — trash / dismiss / retire as one batch. */
export const MaintenanceBulkArchiveRequestSchema = z.object({
  ids: z.array(ElementIdSchema).min(1),
  mode: z.enum(["trash", "dismiss", "retire"]),
});
export type MaintenanceBulkArchiveRequest = z.infer<typeof MaintenanceBulkArchiveRequestSchema>;
export type MaintenanceBulkArchiveResult = MaintenanceBatchResultSummary;

/** `maintenance.bulkPostpone({ ids, asOf? })` — recede low-priority items as one batch. */
export const MaintenanceBulkPostponeRequestSchema = z.object({
  ids: z.array(ElementIdSchema).min(1),
  asOf: IsoTimestampInputSchema.optional(),
});
export type MaintenanceBulkPostponeRequest = z.infer<typeof MaintenanceBulkPostponeRequestSchema>;
export type MaintenanceBulkPostponeResult = MaintenanceBatchResultSummary;

export interface ParkedResurfacingRowSummary {
  readonly element: MaintenanceRefSummary & {
    readonly type: "source";
    readonly priorityLabel: string;
  };
  readonly parkedAt: string;
  readonly ageDays: number;
}

/** `maintenance.parkedResurfacing({ limit? })` — due saved-for-later sources. */
export const MaintenanceParkedResurfacingRequestSchema = z
  .object({ limit: z.number().int().positive().max(500).optional() })
  .optional();
export type MaintenanceParkedResurfacingRequest = z.infer<
  typeof MaintenanceParkedResurfacingRequestSchema
>;
export interface MaintenanceParkedResurfacingResult {
  readonly rows: readonly ParkedResurfacingRowSummary[];
  readonly totalDue: number;
  readonly limit: number | null;
  readonly asOf: string;
}

export const ParkedResurfacingDecisionSchema = z.object({
  id: ElementIdSchema,
  kind: z.enum(["keepParked", "queueNow", "letGo"]),
});
export type ParkedResurfacingDecisionInput = z.infer<typeof ParkedResurfacingDecisionSchema>;

/** `maintenance.parkedResurfacingApply({ decisions })` — one undoable batch. */
export const MaintenanceParkedResurfacingApplyRequestSchema = z.object({
  decisions: z.array(ParkedResurfacingDecisionSchema).min(1),
});
export type MaintenanceParkedResurfacingApplyRequest = z.infer<
  typeof MaintenanceParkedResurfacingApplyRequestSchema
>;
export interface MaintenanceParkedResurfacingApplyResult {
  readonly applied: number;
  readonly skipped: readonly {
    readonly id: string;
    readonly reason: "missing" | "deleted" | "not-source" | "not-parked" | "not-due";
  }[];
  readonly batchId: string | null;
}

export interface ChronicPostponeRowSummary {
  readonly element: MaintenanceRefSummary & {
    readonly type: "source" | "topic" | "extract" | "synthesis_note" | "card";
    readonly priorityLabel: string;
    readonly status: string;
    readonly dueAt: string | null;
  };
  readonly scheduler: "attention" | "fsrs";
  readonly postponeCount: number;
}

/** `maintenance.chronicPostpones({ limit? })` — items past the postpone threshold. */
export const MaintenanceChronicPostponesRequestSchema = z
  .object({ limit: z.number().int().positive().max(500).optional() })
  .optional();
export type MaintenanceChronicPostponesRequest = z.infer<
  typeof MaintenanceChronicPostponesRequestSchema
>;
export interface MaintenanceChronicPostponesResult {
  readonly rows: readonly ChronicPostponeRowSummary[];
  readonly totalDue: number;
  readonly threshold: number;
  readonly limit: number | null;
}

export const ChronicPostponeDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ id: ElementIdSchema, kind: z.literal("keep") }),
  z.object({ id: ElementIdSchema, kind: z.literal("demote") }),
  z.object({ id: ElementIdSchema, kind: z.literal("done") }),
  z.object({ id: ElementIdSchema, kind: z.literal("delete") }),
  z.object({
    id: ElementIdSchema,
    kind: z.literal("fallow"),
    fallowUntil: IsoTimestampInputSchema,
    fallowReason: z.string().trim().max(TOPIC_FALLOW_REASON_MAX).optional().nullable(),
  }),
]);
export type ChronicPostponeDecisionInput = z.infer<typeof ChronicPostponeDecisionSchema>;

/** `maintenance.chronicPostponesApply({ decisions })` — one undoable reckoning batch. */
export const MaintenanceChronicPostponesApplyRequestSchema = z.object({
  decisions: z.array(ChronicPostponeDecisionSchema).min(1).max(500),
});
export type MaintenanceChronicPostponesApplyRequest = z.infer<
  typeof MaintenanceChronicPostponesApplyRequestSchema
>;
export interface MaintenanceChronicPostponesApplyResult {
  readonly applied: number;
  readonly skipped: readonly {
    readonly id: string;
    readonly reason:
      | "missing"
      | "deleted"
      | "unsupported-type"
      | "not-actionable"
      | "retired-card"
      | "below-threshold"
      | "already-lowest"
      | "source-unresolved-blocks"
      | "invalid-return";
  }[];
  readonly batchId: string | null;
}

// ---------------------------------------------------------------------------
// capture.getPairing() / capture.regenerateToken() / capture.setEnabled()  (T062)
// ---------------------------------------------------------------------------

/**
 * The browser-extension pairing surface (T062). The TRUSTED desktop renderer
 * reads the per-install pairing token (to display it for the user to paste into
 * the extension), regenerates it, and toggles the loopback capture server on/off.
 * The token is NEVER handed to a web page — only the desktop renderer displays it;
 * the extension obtains it by the user pasting it. There is no `db.query` and no
 * generic command surface; these three commands route to the `capture-pairing`
 * helpers + the live capture-server start/stop.
 */

/** No payload — read the current pairing state. */
export const CaptureGetPairingRequestSchema = z.void();
export type CaptureGetPairingRequest = z.infer<typeof CaptureGetPairingRequestSchema>;

/** No payload — mint a fresh token (unpairs the current extension). */
export const CaptureRegenerateTokenRequestSchema = z.void();
export type CaptureRegenerateTokenRequest = z.infer<typeof CaptureRegenerateTokenRequestSchema>;

/** Enable/disable the capture server (starts/stops it live). */
export const CaptureSetEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});
export type CaptureSetEnabledRequest = z.infer<typeof CaptureSetEnabledRequestSchema>;

/** The full pairing state surfaced in the Settings "Browser capture" card. */
export interface CapturePairingResult {
  /** Whether the user has enabled the capture server (default false). */
  readonly enabled: boolean;
  /** Whether the server socket is actually bound + running right now. */
  readonly running: boolean;
  /** The actually-bound loopback port, or `null` when not running. */
  readonly port: number | null;
  /** The per-install pairing token (shown for the user to paste into the extension). */
  readonly token: string;
  /**
   * The paired extension origin (`chrome-extension://<id>`) learned via the
   * pairing handshake, or `null` until an extension has paired.
   */
  readonly extensionOriginHint: string | null;
}

/** The result of regenerating the token (the NEW token; the old one is now invalid). */
export interface CaptureRegenerateTokenResult {
  readonly token: string;
}

/** The result of toggling the server — the resulting running state + port. */
export interface CaptureSetEnabledResult {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly port: number | null;
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

/** Full preview payload for one inbox item (summary + provenance + full body). */
export interface InboxItemDetail {
  readonly summary: InboxItemSummary;
  readonly provenance: SourceProvenance;
  /** Full ProseMirror body JSON for formatted selected-item rendering. */
  readonly bodyDoc: unknown | null;
  /** Full plain-text mirror for fallback rendering; never truncated. */
  readonly bodyText: string | null;
  /** Deprecated plain-text body preview (first ~4000 chars), or `null`. */
  readonly bodyPreview: string | null;
}

export interface InboxGetResult {
  /** The inbox detail, or `null` when the id is unknown / not an inbox source. */
  readonly detail: InboxItemDetail | null;
}

/**
 * One triage action applied to an inbox source. A discriminated union so the
 * main side rejects an unknown action at the boundary:
 *  - `accept`      → status `active` + attention `due_at` (leaves the inbox)
 *  - `queueSoon`   → status `scheduled` + due now (leaves the inbox)
 *  - `keepForLater`→ status `parked` + `parkedAt` (set aside, leaves the inbox)
 *  - `setPriority` → numeric priority from the A/B/C/D label (status unchanged)
 *  - `delete`      → soft-delete (`deletedAt` + status `deleted`)
 */
export const InboxTriageRequestSchema = z.object({
  id: ElementIdSchema,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("accept") }),
    z.object({ kind: z.literal("queueSoon") }),
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
  /**
   * The source body format. `"pdf"` for a paginated PDF source (T064 — the reader
   * swaps in the `pdfjs-dist` PDF reading mode), `"video"` for a media source (T073 —
   * the reader swaps in the `MediaReader` `<video>`/`<audio>`/YouTube IFrame), else
   * `null` (the ordinary editor body). The PDF case derives from a `.pdf` snapshot;
   * the media case derives from `sources.media_kind != null` (the authoritative
   * media discriminator — a transcript-less YouTube source has no distinctive snapshot).
   */
  readonly sourceFormat: "pdf" | "video" | null;
  /**
   * For a MEDIA source (T073): `"local"` (a vault asset, played via `media://`) or
   * `"youtube"` (an IFrame embed). `null` for non-media sources. Derived from
   * `sources.media_kind`.
   */
  readonly mediaSource: "local" | "youtube" | null;
  /**
   * For a LOCAL media source (T073): `"video"` or `"audio"` (so the reader picks the
   * right element); `null` for a YouTube source and every non-media source.
   */
  readonly mediaKind: "video" | "audio" | null;
  /**
   * For a PAGINATED source (PDF, T064): the block→page map (stable block id →
   * 1-based page) read off `document_blocks.page`, so the reader can set a
   * page-granular read-point and derive the page of a selected block for the
   * extract's `source_locations.page`. Empty for non-paginated bodies.
   */
  readonly blockPages: Readonly<Record<string, number>>;
  /**
   * For a MEDIA source (T073): the block→time map (stable block id → cue start ms)
   * read off `document_blocks.timestamp_ms`, so the reader can seek the player to a
   * cue, highlight the playing cue, and persist a timestamp read-point. Empty for
   * non-media bodies (a transcript-less media source has only the title heading,
   * which carries no timestamp).
   */
  readonly blockTimestamps: Readonly<Record<string, number>>;
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
// blockProcessing.*  (durable source-block processing outcomes)
// ---------------------------------------------------------------------------

/**
 * The durable source-block processing surface. These rows are the source of truth
 * for incremental-reading progress; `processed_span` document marks are only a
 * legacy/visual projection. Every write validates that the block belongs to the
 * source document and logs `update_document` in the same transaction.
 */

export const SourceBlockProcessingStateSchema = z.enum(SOURCE_BLOCK_PROCESSING_STATES);

export interface SourceBlockProcessingViewPayload {
  readonly sourceElementId: string;
  readonly stableBlockId: string;
  readonly order: number;
  readonly state: SourceBlockProcessingState;
  readonly storedState: SourceBlockProcessingState | null;
  readonly blockContentHash: string | null;
  readonly outputElementIds: readonly string[];
  readonly derivedFrom: SourceBlockProcessingDerivation;
}

export interface SourceBlockProcessingSummaryPayload {
  readonly sourceElementId: string;
  readonly totalBlocks: number;
  readonly processedBlocks: number;
  readonly terminalBlocks: number;
  readonly unresolvedBlocks: number;
  readonly highPriorityUnresolvedBlocks: number;
  readonly extractedBlockCount: number;
  readonly extractedOutputCount: number;
  readonly ignoredBlocks: number;
  readonly ignoredRatio: number;
  readonly terminalRatio: number;
  readonly staleAfterEditBlocks: number;
  readonly legacyProjectedBlocks: number;
  readonly canMarkDoneWithoutConfirmation: boolean;
  readonly stateCounts: Readonly<Record<SourceBlockProcessingState, number>>;
}

export const BlockProcessingSourceRequestSchema = z.object({
  sourceElementId: ElementIdSchema,
});
export type BlockProcessingSourceRequest = z.infer<typeof BlockProcessingSourceRequestSchema>;

export interface BlockProcessingListResult {
  readonly blocks: readonly SourceBlockProcessingViewPayload[];
  readonly summary: SourceBlockProcessingSummaryPayload;
}

export interface BlockProcessingSummaryResult {
  readonly summary: SourceBlockProcessingSummaryPayload;
}

export const BlockProcessingMarkBlockRequestSchema = z.object({
  sourceElementId: ElementIdSchema,
  stableBlockId: z.string().min(1).max(128),
});
export type BlockProcessingMarkBlockRequest = z.infer<typeof BlockProcessingMarkBlockRequestSchema>;

export interface BlockProcessingMarkBlockResult {
  readonly block: SourceBlockProcessingViewPayload;
  readonly summary: SourceBlockProcessingSummaryPayload;
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
  /** Extract-only honorable terminal fate; `null` when no fate is set. */
  readonly extractFate: ExtractFate | null;
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

export type DirectExtractFate = "reference" | "done_without_card";

export const DirectExtractFateSchema = z.enum(["reference", "done_without_card"]);

export const ExtractsSetFateRequestSchema = z.object({
  /** The extract element id to mark as honorably terminal. */
  id: ElementIdSchema,
  /**
   * Direct user commands can only set non-card fates. `synthesized` is maintained by
   * synthesis-note lineage and is intentionally rejected at the IPC boundary.
   */
  fate: DirectExtractFateSchema,
});
export type ExtractsSetFateRequest = z.infer<typeof ExtractsSetFateRequestSchema>;

export interface ExtractsSetFateResult {
  readonly extract: ExtractActionSummary;
}

export const ExtractsReactivateFateRequestSchema = z.object({
  /** The extract element id whose honorable fate should be cleared and reactivated. */
  id: ElementIdSchema,
});
export type ExtractsReactivateFateRequest = z.infer<typeof ExtractsReactivateFateRequestSchema>;

export interface ExtractsReactivateFateResult {
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
// cards.create()  (T032 — author a card from an extract)
// ---------------------------------------------------------------------------

/**
 * The card-authoring surface (T032 — the M6 keystone). From an
 * `atomic_statement` extract, the renderer hands the authored fields (a `qa`
 * card's `prompt`/`answer`, or a `cloze` card's canonical `{{c1::answer}}` text)
 * and the MAIN process runs the `CardService` to create a NEW `card` element in
 * ONE transaction: the card element (stage `card_draft`) + its `cards` row
 * (`kind`/prompt/answer/cloze + the INHERITED `sourceLocationId` anchor) + an
 * UN-DUE `review_states` row (`fsrsState = "new"`, `dueAt = null`), inheriting the
 * extract's priority + tags, and a `sibling_group` edge linking it to the group.
 * A throw anywhere rolls the whole card back. There is still no generic `db.query`.
 *
 * **Two-scheduler split (load-bearing):** M6 AUTHORS the card; it does NO FSRS
 * math. The card is created at `card_draft` and parked un-due — M7 (T036) owns the
 * first FSRS schedule + the `card_draft → active_card` transition. The originating
 * extract is UNCHANGED (it lives on as its own attention-scheduled element).
 *
 * `priority`/`title` are optional: when absent the main side INHERITS the
 * extract's numeric priority and derives a title, so the renderer never reads
 * lineage. `siblingGroupId` is omitted for the FIRST card from an extract (the
 * main side mints one) and echoed back from a prior `cards.create` to group a
 * subsequent sibling (a Q&A + cloze pair, or a multi-cloze set). The schema
 * enforces a COARSE boundary check (a `qa` card carries non-empty `prompt` +
 * `answer`; a `cloze` card carries non-empty `cloze`) — the rich card-quality
 * gate is T035.
 */

/** The card kind values the renderer may request (validated against `CARD_KINDS`). */
export const CardKindSchema = z.enum(CARD_KINDS);

/**
 * The audio-card presentation carrier (T075) — `{ sourceElementId, startMs, endMs, on }`
 * (see `@interleave/core` `MediaRef`). When supplied on `cards.create`, the card LOOPS
 * this clip of the original media (`sourceElementId`, the media `source`) over the
 * `[startMs, endMs)` window on the `on` face. Validated `startMs >= 0`, `endMs > startMs`
 * (both integer ms), `on ∈ {prompt,answer,both}` so an inverted/negative window cannot
 * cross the bridge. Audio is a presentation modifier on the existing card model, NOT a new
 * `kind`. `null` for a text/occlusion card. Mirrors `RegionRectSchema`'s refine discipline.
 */
export const MediaRefSchema = z
  .object({
    sourceElementId: ElementIdSchema,
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    on: z.enum(MEDIA_REF_FACES),
  })
  .refine((r) => r.endMs > r.startMs, {
    message: "media clip must have endMs > startMs",
  });
export type MediaRefInput = z.infer<typeof MediaRefSchema>;

export const CardsCreateRequestSchema = z
  .object({
    /** The originating extract this card is distilled from (lineage parent). */
    extractId: ElementIdSchema,
    /** Card kind — `qa` or `cloze`. */
    kind: CardKindSchema,
    /** Q&A prompt (required, non-empty, for `qa`). */
    prompt: z.string().trim().max(20_000).optional(),
    /** Q&A answer (required, non-empty, for `qa`). */
    answer: z.string().trim().max(20_000).optional(),
    /** Canonical `{{c1::answer}}` cloze text (required, non-empty, for `cloze`). */
    cloze: z.string().trim().max(20_000).optional(),
    /** Optional explicit title; otherwise derived from the body main-side. */
    title: z.string().trim().max(512).optional(),
    /** Optional A/B/C/D priority override; otherwise INHERITS the extract's priority. */
    priority: PriorityLabelSchema.optional(),
    /** Optional sibling group id (to group with a prior sibling); minted when absent. */
    siblingGroupId: z.string().min(1).max(128).optional(),
    /**
     * Audio-card presentation carrier (T075). When supplied, the card LOOPS this clip
     * of the original media on the chosen face — an AUDIO card. When OMITTED and the
     * `extractId` is a clip `media_fragment`, the main side DERIVES the ref from the
     * clip window (defaulting the loop to the prompt). Validated by {@link MediaRefSchema}
     * (window + face). Omitted/`null` for every text card. Audio is a presentation
     * modifier, not a new `kind` — the existing channel carries it (no new command).
     */
    mediaRef: MediaRefSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    // `image_occlusion` cards are NOT authorable here: they require an
    // `occlusion_masks` row minted atomically alongside the card, so they MUST go
    // through `cards.generateOcclusion`. Accepting one on this path would mint a
    // mask-less, permanently-blank, FSRS-scheduled card with no reviewable face.
    if (value.kind === "image_occlusion") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["kind"],
        message: "image-occlusion cards are created via cards.generateOcclusion, not cards.create",
      });
      return;
    }
    // Coarse boundary check (the rich quality gate is T035): a Q&A card must carry
    // a non-empty prompt AND answer; a cloze card must carry non-empty cloze text.
    // AUDIO override (T075): when `mediaRef` loops on a face, the AUDIO is that face's
    // content, so the WRITTEN text for that face may be empty (an audio-prompt card has
    // no written prompt; an audio-answer card no written answer). The audio thus
    // satisfies the non-empty requirement for whichever face it covers.
    const ref = value.mediaRef ?? null;
    const audioOnPrompt = ref != null && (ref.on === "prompt" || ref.on === "both");
    const audioOnAnswer = ref != null && (ref.on === "answer" || ref.on === "both");
    if (value.kind === "qa") {
      if (!audioOnPrompt && (!value.prompt || value.prompt.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["prompt"],
          message: "a Q&A card requires a non-empty prompt",
        });
      }
      if (!audioOnAnswer && (!value.answer || value.answer.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["answer"],
          message: "a Q&A card requires a non-empty answer",
        });
      }
    } else if (value.kind === "cloze") {
      if (!value.cloze || value.cloze.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cloze"],
          message: "a cloze card requires non-empty cloze text",
        });
      }
    }
  });
export type CardsCreateRequest = z.infer<typeof CardsCreateRequestSchema>;

/** A flat summary of a freshly created card element. */
export interface CardSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
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
  /**
   * The audio-card clip reference (T075) when this is an audio card — the looped
   * clip + face; `null` for a text/occlusion card. Echoed so the builder can confirm
   * an audio card was authored without a re-fetch.
   */
  readonly mediaRef: MediaRef | null;
  /**
   * Whether the card is currently RETIRED (T082) — a low-value mature card that has
   * gracefully left active review (skipped by the due/review reads), reversibly. A
   * freshly created card is never retired (`false`).
   */
  readonly isRetired: boolean;
}

export interface CardsCreateResult {
  readonly card: CardSummary;
  /** The inherited source-location anchor id (lineage), or `null` when the extract has none. */
  readonly sourceLocationId: string | null;
}

// ---------------------------------------------------------------------------
// cards.generateOcclusion()  (T071 — image-occlusion card generation)
// ---------------------------------------------------------------------------

/** The most masks one diagram may yield (cap a runaway editor minting hundreds of cards). */
const MAX_OCCLUSION_MASKS = 50;

/**
 * Generate N sibling `image_occlusion` cards from a `media_fragment` image extract
 * (T071). The renderer draws normalized mask rects over the base image (which
 * already lives in the vault — the bytes are NOT sent here) and ships ONLY the
 * `imageElementId` + the vector masks. MAIN mints one `image_occlusion` `card` per
 * mask, all in one `sibling_group`, in ONE transaction. Masks are stored SEPARATELY
 * from the base image (the `occlusion_masks` table); the crop is never mutated.
 *
 * Mirrors `cards.create` (T032): `priority` is optional A/B/C/D (else INHERITS the
 * image's). Each rect is validated by the reused `RegionRectSchema` (`0≤·≤1`,
 * `x0<x1`, `y0<y1`); a label is the text the hidden region stands for.
 */
export const CardsGenerateOcclusionRequestSchema = z.object({
  /** The `media_fragment` image extract the masks are drawn over (the base). */
  imageElementId: ElementIdSchema,
  /** The masks to occlude — one card per mask (≥1, ≤50). */
  masks: z
    .array(
      z.object({
        region: RegionRectSchema,
        label: z.string().trim().max(512).nullable().optional(),
      }),
    )
    .min(1)
    .max(MAX_OCCLUSION_MASKS),
  /** Optional A/B/C/D priority override; otherwise INHERITS the image's priority. */
  priority: PriorityLabelSchema.optional(),
});
export type CardsGenerateOcclusionRequest = z.infer<typeof CardsGenerateOcclusionRequestSchema>;

export interface CardsGenerateOcclusionResult {
  /** The sibling group all generated cards joined (the whole diagram). */
  readonly siblingGroupId: string;
  /** One `image_occlusion` card summary per mask. */
  readonly cards: CardSummary[];
}

// ---------------------------------------------------------------------------
// cards.update() / cards.suspend() / cards.delete() / cards.flag()  (T038 — in-review repair)
// ---------------------------------------------------------------------------

/**
 * The in-review card-repair surface (T038). The review session's repair row
 * (Edit / Open source / Suspend / Delete / Flag-as-bad) becomes functional so the
 * user can fix a bad card the MOMENT it fails, without leaving review. The
 * renderer sends an intent; the MAIN process runs the `CardEditService`
 * (`packages/local-db`) in ONE transaction per action, appending the correct
 * EXISTING `operation_log` op (NO new op types — the closed 15-op set is
 * unchanged):
 *
 *  - `cards.update`  → edit the card body (Q&A prompt/answer or cloze text); writes
 *    the `cards` row + logs `update_element`. Lineage (`sourceLocationId`),
 *    `review_states`, and the append-only `review_logs` are NEVER touched — an edit
 *    must not corrupt the in-flight FSRS state.
 *  - `cards.suspend` → status `suspended` (`update_element`); the card leaves the
 *    due deck (`dueCards` excludes suspended) but keeps its review state/logs.
 *  - `cards.delete`  → SOFT delete (`deletedAt` + status `deleted`,
 *    `soft_delete_element`); lineage stays valid, recoverable from trash (T044).
 *  - `cards.flag`    → a non-destructive "flag-as-bad" QUALITY marker stored in the
 *    `update_element` op payload (no new column — the durable leech/flag migration
 *    is T040's); the card stays in the deck. Logs `update_element`.
 *
 * **Open source** is renderer NAVIGATION (the card's `sourceLocationId` →
 * `SourceRepository.findLocationById` → `navigateToLocation`, reusing T022) — NOT
 * an IPC mutation; there is no `cards.openSource` command. There is still no
 * generic `db.query`.
 */

/**
 * A flat summary of a card after a repair action. Carries the body (so the
 * renderer reflects an edit without a re-fetch), the lifecycle `status` (so it
 * knows the card left the deck on suspend/delete), and the current `flagged`
 * quality marker.
 */
export interface CardEditSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** Card kind (`qa`/`cloze`). */
  readonly kind: string;
  /** The Q&A prompt, or the cloze `{{cN::…}}` text. */
  readonly prompt: string | null;
  /** The Q&A answer; `null` for cloze cards. */
  readonly answer: string | null;
  /** The canonical cloze text; `null` for Q&A cards. */
  readonly cloze: string | null;
  /** The originating extract id (lineage parent). */
  readonly parentId: string | null;
  /** The owning source element id (lineage root). */
  readonly sourceId: string | null;
  /** Whether the card is currently flagged-as-bad (a manual quality marker). */
  readonly flagged: boolean;
  /** Whether the card is currently flagged a leech (auto after ≥4 lapses, or manual) (T040). */
  readonly leech: boolean;
  /** Whether the card is currently RETIRED (T082) — out of active review, kept for reference. */
  readonly retired: boolean;
  /** True after a soft delete. */
  readonly deleted: boolean;
}

export const CardsUpdateRequestSchema = z
  .object({
    /** The card element id to edit. */
    cardId: ElementIdSchema,
    /** New Q&A prompt (for a `qa` card); ignored for a cloze card. */
    prompt: z.string().trim().max(20_000).optional(),
    /** New Q&A answer (for a `qa` card); ignored for a cloze card. */
    answer: z.string().trim().max(20_000).optional(),
    /** New canonical `{{c1::answer}}` cloze text (for a `cloze` card); ignored for Q&A. */
    cloze: z.string().trim().max(20_000).optional(),
  })
  .refine((value) => value.prompt != null || value.answer != null || value.cloze != null, {
    message: "cards.update requires at least one of prompt / answer / cloze",
  });
export type CardsUpdateRequest = z.infer<typeof CardsUpdateRequestSchema>;

export interface CardsUpdateResult {
  readonly card: CardEditSummary;
}

/**
 * A bounded ISO-or-empty date string (T090). The lifetime dates are stored loosely
 * (parsed defensively by `deriveExpiryStatus` — an unparseable value is "no
 * constraint", never an error), so the IPC schema only BOUNDS the length; it does not
 * reject a free-form date. An empty string clears the field. `null` also clears it; an
 * OMITTED field is left unchanged.
 */
const LifetimeDateSchema = z.string().trim().max(40).nullable().optional();

/**
 * Edit a card's claim-lifetime fields (T090). Every field is OPTIONAL — an omitted
 * field is left unchanged; an explicit `null`/`""` clears it. Validated main-side:
 * `factStability` against the core tuple (or `null` to clear), the dates bounded,
 * the jurisdiction/version bounded free text. Rides the existing `cards.*` group — no
 * new top-level command group. The body refine requires at least one field so an empty
 * call is rejected.
 */
export const CardsSetLifetimeRequestSchema = z
  .object({
    /** The card element id whose lifetime to edit. */
    cardId: ElementIdSchema,
    /** `stable`/`slow`/`volatile`, or `null` to clear. */
    factStability: z.enum(FACT_STABILITY).nullable().optional(),
    /** ISO date the validity starts (or empty/`null` to clear). */
    validFrom: LifetimeDateSchema,
    /** ISO date the validity ends — when `now > valid_until` the fact is EXPIRED. */
    validUntil: LifetimeDateSchema,
    /** Free-text jurisdiction ("US-CA"/"EU"/"global"), ≤128 chars, or empty/`null`. */
    jurisdiction: z.string().trim().max(128).nullable().optional(),
    /** Free-text software version ("React 19"/"Postgres 18"), ≤64 chars, or empty/`null`. */
    softwareVersion: z.string().trim().max(64).nullable().optional(),
    /** ISO date the fact should be re-checked — when `now > review_by` it is DUE-FOR-REVIEW. */
    reviewBy: LifetimeDateSchema,
  })
  .refine(
    (value) =>
      value.factStability !== undefined ||
      value.validFrom !== undefined ||
      value.validUntil !== undefined ||
      value.jurisdiction !== undefined ||
      value.softwareVersion !== undefined ||
      value.reviewBy !== undefined,
    { message: "cards.setLifetime requires at least one lifetime field" },
  );
export type CardsSetLifetimeRequest = z.infer<typeof CardsSetLifetimeRequestSchema>;

export interface CardsSetLifetimeResult {
  readonly card: CardEditSummary;
  /**
   * The card's lifetime fields + the freshly-derived expiry status after the edit, so
   * the inspector reflects the new badge/rows WITHOUT a re-fetch (mirrors how
   * `cards.update` returns the edited body).
   */
  readonly lifetime: FactLifetimeSummary;
}

export const CardsSuspendRequestSchema = z.object({
  /** The card element id to suspend. */
  cardId: ElementIdSchema,
});
export type CardsSuspendRequest = z.infer<typeof CardsSuspendRequestSchema>;

export interface CardsSuspendResult {
  readonly card: CardEditSummary;
}

export const CardsDeleteRequestSchema = z.object({
  /** The card element id to soft-delete. */
  cardId: ElementIdSchema,
});
export type CardsDeleteRequest = z.infer<typeof CardsDeleteRequestSchema>;

export interface CardsDeleteResult {
  readonly card: CardEditSummary;
}

export const CardsFlagRequestSchema = z.object({
  /** The card element id to flag/un-flag. */
  cardId: ElementIdSchema,
  /** Set the flag (`true`) or clear it (`false`). */
  flagged: z.boolean(),
  /** Optional human reason for the flag (stored in the op payload). */
  reason: z.string().trim().max(2048).optional(),
});
export type CardsFlagRequest = z.infer<typeof CardsFlagRequestSchema>;

export interface CardsFlagResult {
  readonly card: CardEditSummary;
}

// ---------------------------------------------------------------------------
// cards.markLeech()  (T040 — manual leech flag toggle / un-leech after rewrite)
// ---------------------------------------------------------------------------

/**
 * Set / clear a card's durable leech flag (T040). Leech detection is AUTOMATIC
 * (the failing-grade path sets `cards.is_leech` once `lapses` crosses the
 * threshold — `@interleave/scheduler` `LEECH_LAPSE_THRESHOLD`, 4), but this command
 * backs the kit's manual "Mark leech" button AND lets a remediated card be
 * UN-leeched after a rewrite. The MAIN process runs
 * {@link ReviewRepository.setCardLeech} in ONE transaction, logging `update_element`
 * (NO new op type). Flagging never destroys the card or its `review_logs`.
 */
export const CardsMarkLeechRequestSchema = z.object({
  /** The card element id to (un)flag as a leech. */
  cardId: ElementIdSchema,
  /** Set the leech flag (`true`) or clear it (`false` — un-leech after remediation). */
  leech: z.boolean(),
});
export type CardsMarkLeechRequest = z.infer<typeof CardsMarkLeechRequestSchema>;

export interface CardsMarkLeechResult {
  readonly card: CardEditSummary;
}

// ---------------------------------------------------------------------------
// cards.split() / cards.addContext() / cards.backToExtract()  (T085 — leech remediation)
// ---------------------------------------------------------------------------

/**
 * The three NEW leech-remediation compositions (T085) — the only new domain logic on
 * the remediation screen (the rest reuse existing `cards.*` / `elements.setPriority`
 * / T022 navigation). The MAIN process runs {@link CardRemediationService}
 * (`packages/local-db`) in ONE transaction per action, appending the correct EXISTING
 * `operation_log` op (NO new op types — the closed set is unchanged); lineage and the
 * append-only `review_logs` history are preserved:
 *
 *  - `cards.split`        → divide a multi-fact failing card into 2+ ATOMIC sibling
 *    cards, each inheriting the original's lineage (`parentId`/`sourceLocationId`/
 *    priority/tags) with a FRESH `review_states` row (a split card is a NEW card —
 *    never copies the original's FSRS memory), all in one `sibling_group`; the
 *    original is soft-deleted (default) or suspended. Logs `create_element`/
 *    `create_card` per new card, `add_relation` per grouping, `soft_delete_element`
 *    (or `update_element`) for the original.
 *  - `cards.addContext`  → append a clarifying CONTEXT NOTE (op-payload marker, no new
 *    column); the card stays in rotation; logs `update_element`.
 *  - `cards.backToExtract` → reactivate the card's parent EXTRACT to DUE-NOW on the
 *    ATTENTION scheduler (`reschedule_element`, never `review_states`) and dispose the
 *    card (default suspend). Returns the reactivated extract, or `null` when the card
 *    has no live parent extract.
 */

/** One authored atomic part of a split (validated non-empty for its kind main-side). */
export const CardsSplitPartSchema = z.object({
  /** The part's card kind (`qa` or `cloze`). */
  kind: z.enum(["qa", "cloze"]),
  /** Q&A prompt (required non-empty for `qa`). */
  prompt: z.string().trim().max(20_000).optional(),
  /** Q&A answer (required non-empty for `qa`). */
  answer: z.string().trim().max(20_000).optional(),
  /** Canonical `{{c1::answer}}` cloze text (required non-empty for `cloze`). */
  cloze: z.string().trim().max(20_000).optional(),
});

export const CardsSplitRequestSchema = z.object({
  /** The failing card to split. */
  cardId: ElementIdSchema,
  /** The authored atomic parts — at least 2; one new sibling card per part. */
  parts: z.array(CardsSplitPartSchema).min(2),
  /** Disposition of the ORIGINAL card; default `delete` (soft, recoverable). */
  originalDisposition: z.enum(["delete", "suspend"]).optional(),
});
export type CardsSplitRequest = z.infer<typeof CardsSplitRequestSchema>;

export interface CardsSplitResult {
  /** The new atomic sibling cards (in authored order). */
  readonly cards: readonly CardSummary[];
}

export const CardsAddContextRequestSchema = z.object({
  /** The card to add a clarifying context note to. */
  cardId: ElementIdSchema,
  /** The context note — non-empty, bounded. */
  note: z.string().trim().min(1).max(20_000),
});
export type CardsAddContextRequest = z.infer<typeof CardsAddContextRequestSchema>;

export interface CardsAddContextResult {
  readonly card: CardEditSummary;
  /** The accumulated context note now on the card (op-log-derived). */
  readonly context: string | null;
}

export const CardsBackToExtractRequestSchema = z.object({
  /** The leech card whose parent extract is sent back into the attention queue. */
  cardId: ElementIdSchema,
  /** What to do with the card; default `suspend` (recoverable). */
  cardDisposition: z.enum(["suspend", "delete", "keep"]).optional(),
});
export type CardsBackToExtractRequest = z.infer<typeof CardsBackToExtractRequestSchema>;

export interface CardsBackToExtractResult {
  /** The reactivated parent extract (due-now), or `null` when the card has none live. */
  readonly extract: ElementSummary | null;
}

// ---------------------------------------------------------------------------
// cards.retire() / cards.unretire() / cards.retired()  (T082 — mature-card retirement)
// ---------------------------------------------------------------------------

/**
 * Mature-card retirement (T082). A low-value MATURE card (high stability, low
 * priority, well-learned) can be RETIRED so it leaves active review gracefully —
 * WITHOUT being deleted or losing its lineage/history — and a retired card is
 * SKIPPED by the due/review reads. Retirement is REVERSIBLE (un-retire restores
 * normal scheduling at the card's existing due date).
 *
 * The MAIN process runs {@link CardRetirementService} in ONE transaction per
 * action, flipping the durable `cards.is_retired` flag (the SOLE source of truth
 * for "leave active review" — a `cards` quality attribute like leech, NOT a new
 * `ELEMENT_STATUSES` value), logging `update_element` (NO new op type). Retire ≠
 * suspend ≠ delete: retire is "done with, kept for reference, low-value", a distinct
 * reversible exit. `review_states`/`review_logs`/lineage are preserved (never a soft
 * delete). FSRS / cards only — the attention reads are untouched.
 */

export const CardsRetireRequestSchema = z.object({
  /** The card element id to retire. */
  cardId: ElementIdSchema,
  /** Optional human reason, stored in the `update_element` op payload (audit). */
  reason: z.string().trim().max(2048).optional(),
  /**
   * When `true`, ALSO floor-clamp the card's per-card desired-retention override to
   * `DESIRED_RETENTION_MIN` (a convenience interval-lengthener for an eventual
   * un-retire) — NOT the retirement mechanism (the `is_retired` flag is). Default
   * `false` (retire is a pure flag flip; the override is untouched).
   */
  lowRetention: z.boolean().optional(),
});
export type CardsRetireRequest = z.infer<typeof CardsRetireRequestSchema>;

export interface CardsRetireResult {
  readonly card: CardEditSummary;
}

export const CardsUnretireRequestSchema = z.object({
  /** The card element id to un-retire (return to normal scheduling). */
  cardId: ElementIdSchema,
});
export type CardsUnretireRequest = z.infer<typeof CardsUnretireRequestSchema>;

export interface CardsUnretireResult {
  readonly card: CardEditSummary;
}

/**
 * One retired card in the inventory/cleanup view (T082) — the body + the memory
 * signals (high stability, reps/lapses) that make it read as a low-value, well-learned
 * card kept for reference, plus its lineage source.
 */
export interface RetiredCardSummary {
  readonly id: string;
  /** Card kind (`qa`/`cloze`). */
  readonly kind: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  readonly prompt: string | null;
  readonly answer: string | null;
  readonly cloze: string | null;
  /** FSRS memory stability (days) — high for a mature, well-learned card. */
  readonly stability: number;
  readonly reps: number;
  readonly lapses: number;
  /** Originating source title (lineage), or `null`. */
  readonly sourceTitle: string | null;
  /** Human-readable source location label (lineage), or `null`. */
  readonly sourceLocationLabel: string | null;
}

export interface CardsRetiredResult {
  readonly cards: RetiredCardSummary[];
}

/**
 * Request the sibling card ANSWERS under an extract (T086) — the one-shot, read-only
 * candidate set the card builder feeds to the pure `detectInterference` heuristic. Fetched
 * once when the builder opens / the extract changes, NEVER on every keystroke.
 */
export const CardsSiblingAnswersRequestSchema = z.object({
  /** The originating extract whose live card children supply the comparison set. */
  extractId: ElementIdSchema,
});
export type CardsSiblingAnswersRequest = z.infer<typeof CardsSiblingAnswersRequestSchema>;

/** One sibling card's answer body (the interference comparison unit, T086). */
export interface SiblingCardAnswer {
  /** The sibling card element id (so the candidate never compares against itself). */
  readonly id: string;
  /** The Q&A answer, when the sibling is a Q&A card. */
  readonly answer: string | null;
  /** The canonical cloze text, when the sibling is a cloze card. */
  readonly cloze: string | null;
}

/** The sibling answer bodies under an extract (T086, read-only). */
export interface CardsSiblingAnswersResult {
  readonly cards: SiblingCardAnswer[];
}

// ---------------------------------------------------------------------------
// review.session.next() / review.preview() / review.grade()  (T037 — the session)
// ---------------------------------------------------------------------------

/**
 * The active-recall review surface (T037). `/review` loads the due-card deck
 * (FSRS `due_at ≤ now`, soonest first), reveals the answer, shows the four grade
 * buttons with next-interval previews, and on a grade records the response time +
 * reschedules the card via the FSRS `CardSchedulerService` → `ReviewRepository`. The
 * three commands keep the renderer thin: it holds ONLY UI/session state (deck
 * cursor, revealed flag, the reveal→grade timer) — never FSRS math, never SQL.
 *
 * **Two-scheduler split (load-bearing):** this surface is for `card` elements
 * ONLY. The deck is `QueueRepository.dueCards` (cards due by `review_states.due_at`),
 * NOT the attention `dueAttentionItems` — sources/extracts are not part of the
 * review session (their combined daily queue is M5). Every grade is a durable,
 * append-only `review_logs` row (`add_review_log`) written in ONE transaction.
 *
 * **Local + fast:** `review.session.next` ships the FULL card — including the
 * `answer`/`cloze`/`ref` — so the renderer hides them until reveal WITHOUT a
 * round-trip on reveal. `exclude` lets the caller skip already-seen card ids
 * (the seam T039 sibling-burying drives main-side); the renderer never computes
 * sibling relationships. There is still no generic `db.query`.
 */

/** The FSRS scheduler signals a review card carries for its `SchedulerChip` + `FsrsStats`. */
export interface ReviewSchedulerSignals {
  readonly kind: "fsrs";
  /** Card recall probability now (`0.0`–`1.0`), or `null` for a never-reviewed card. */
  readonly retrievability: number | null;
  /** FSRS memory stability in days, or `null`. */
  readonly stability: number | null;
  /** FSRS item difficulty (≈ 1–10), or `null`. */
  readonly difficulty: number | null;
  readonly reps: number | null;
  readonly lapses: number | null;
  readonly fsrsState: string | null;
}

/**
 * Everything the review face needs for ONE card. The `answer`/`cloze`/`ref`
 * travel with the card but the renderer keeps them hidden until reveal (review
 * stays local — no reveal round-trip). `sourceLocationId` + `ref` make the
 * jump-to-source affordance actionable (lineage: card → source location → source).
 */
export interface ReviewCardView {
  readonly id: string;
  /** Card kind (`qa`/`cloze`). */
  readonly kind: string;
  /** The Q&A prompt, or the cloze text (`{{cN::…}}`) the front masks until reveal. */
  readonly prompt: string;
  /** The Q&A answer (hidden until reveal); `null` for cloze cards. */
  readonly answer: string | null;
  /** The canonical cloze text (`{{cN::…}}`), masked on the front; `null` for Q&A. */
  readonly cloze: string | null;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly stage: string;
  /** A concept this card is a member of, or `null`. */
  readonly concept: string | null;
  /** The owning source's title (provenance), for the `refblock`. */
  readonly sourceTitle: string | null;
  /** The human-readable source location label ("¶ 4" / "p. 12"), or `null`. */
  readonly sourceLocationLabel: string | null;
  /** A verbatim snapshot of the originating text (the `refblock` quote), or `null`. */
  readonly ref: string | null;
  /**
   * The full originating source reference (T043 — the enriched refblock): title +
   * URL + author + published date + location + snippet, resolved from the card's
   * lineage (card → source location → source). It travels with the card but the
   * renderer keeps it HIDDEN until reveal (it must not leak the answer) — exactly
   * like `answer`/`ref`. Built via the SAME `resolveSourceRef` the inspector uses,
   * rendered with the shared `formatSourceRef`/`RefBlock`. `null` for a source-less
   * card (a calm placeholder, never a broken link). The loose `sourceTitle`/
   * `sourceLocationLabel`/`ref` fields above are kept for back-compat.
   */
  readonly sourceRef: SourceRef | null;
  /**
   * The card's claim-lifetime expiry block (T090) — present when the card carries any
   * lifetime AND its derived status is NOT `fresh` (a stale fact); `null` otherwise (a
   * fresh or lifetime-less card shows no banner). It travels with the card but the
   * renderer keeps it HIDDEN until reveal (a calm "this fact may be out of date" banner
   * near the refblock) — exactly like `answer`/`sourceRef`, so it can't leak the answer.
   * The `status` is derived MAIN-side (`deriveExpiryStatus`); the renderer renders the
   * banner from it. Resolved from the card's `cards` lifetime columns.
   */
  readonly expiry: ReviewCardExpiry | null;
  /** The FSRS signals for the chip + stat readout. */
  readonly schedulerSignals: ReviewSchedulerSignals;
  /** True when the card has crossed the leech lapse threshold (T040 makes this real). */
  readonly leech: boolean;
  /** Cumulative FSRS lapses (failed reviews). */
  readonly lapses: number;
  /** True when the user has flagged this card as bad (T038 — a manual quality marker). */
  readonly flagged: boolean;
  /**
   * The card's sibling group (the same extract / cloze set), or `null` when it has
   * none. The renderer threads this forward as opaque session state so the NEXT
   * `session.next` call can ask the main side to bury this group (T039); the
   * renderer never computes sibling relationships itself.
   */
  readonly siblingGroupId: string | null;
  /** Active ancestor topic rest context; cards still review while attention work rests. */
  readonly fallowContext: ReviewFallowContext | null;
  /**
   * Image-occlusion render data (T071) — present ONLY for an `image_occlusion`
   * card, `null` otherwise. The review face reads the base image bytes through the
   * typed `sources.getRegionImage({ elementId: imageElementId })` command and
   * composites a mask box over the card's `region` (the hidden answer) on the
   * front; on reveal it clears the box and shows the `label`. `otherRegions` are
   * the sibling masks (so the front can optionally dim them too). Resolved MAIN-side
   * from `occlusion_masks` — the masks are stored SEPARATELY from the base image,
   * never baked into it.
   */
  readonly occlusion: ReviewOcclusion | null;
  /**
   * Audio-card render data (T075) — present ONLY for a card whose `cards.media_ref`
   * is set, `null` otherwise. The clip window + face to LOOP (see `MediaRef`); the
   * review face plays it by seeking the original media (no re-encoding) on the
   * `mediaRef.on` face — the front loops it on `{prompt,both}`, the reveal on
   * `{answer,both}`, NEVER leaking an audio answer before reveal.
   */
  readonly mediaRef: MediaRef | null;
  /**
   * The resolved media-source kind for the audio clip (T075) — `"local"` (a vault
   * asset, played via `media://<mediaRef.sourceElementId>`) or `"youtube"` (an IFrame
   * Player). Ships with the card so the face plays WITHOUT a second `getMediaData`
   * round-trip. `null` for a non-audio card (no `mediaRef`).
   */
  readonly mediaSource: "local" | "youtube" | null;
  /** The YouTube video id for a youtube audio source (T075), else `null`. */
  readonly youtubeId: string | null;
}

/**
 * The reveal-gated expiry block a stale card carries into review (T090). Only the
 * fields the post-reveal banner renders — the derived `status`, the two dates, and the
 * jurisdiction/version context (so the banner can say WHAT changed). `status` is never
 * `"fresh"` here (a fresh card carries `expiry: null`). The renderer keeps this hidden
 * until reveal so it cannot leak the answer.
 */
export interface ReviewCardExpiry {
  /** `due_for_review` or `expired` (never `fresh` — a fresh card has `expiry: null`). */
  readonly status: FactExpiryStatus;
  /** ISO date the fact's validity ended (drives the "expired {date}" line), or `null`. */
  readonly validUntil: string | null;
  /** ISO date the fact should be re-checked (drives the "review by {date}" line), or `null`. */
  readonly reviewBy: string | null;
  /** Free-text jurisdiction context shown beside the banner, or `null`. */
  readonly jurisdiction: string | null;
  /** Free-text software version context shown beside the banner, or `null`. */
  readonly softwareVersion: string | null;
}

export interface ReviewFallowContext {
  readonly topicId: string;
  readonly topicTitle: string;
  readonly fallowUntil: string;
  readonly fallowReason: string | null;
}

/** The image-occlusion data a review face needs (T071). */
export interface ReviewOcclusion {
  /** The `media_fragment` image extract whose bytes the face loads (base image). */
  readonly imageElementId: string;
  /** The masked region this card hides (the answer), shown on reveal. */
  readonly region: RegionRectInput;
  /** The label the hidden region stands for, shown on reveal; or `null`. */
  readonly label: string | null;
  /** The sibling masks (the other regions of the diagram) — for optional dimming. */
  readonly otherRegions: RegionRectInput[];
}

export const ReviewSessionNextRequestSchema = z.object({
  /** Card ids already seen this session — skipped so the deck advances. */
  exclude: z.array(ElementIdSchema).max(10_000).optional(),
  /**
   * Sibling group(s) shown most recently this session — opaque ids the renderer
   * carries forward from the previous card's `siblingGroupId`. When burying is on,
   * a card in any of these groups is skipped so siblings aren't back-to-back
   * (T039). The renderer never computes sibling relationships; the MAIN side does
   * the sibling-aware selection from these ids.
   */
  recentSiblingGroups: z.array(z.string().min(1).max(128)).max(64).optional(),
  /**
   * When `false`, sibling burying is disabled (the natural due order is used). When
   * omitted, the main side reads the persisted `burySiblings` setting (default on).
   */
  burySiblings: z.boolean().optional(),
  /** "Now" the due read compares against (ISO-8601); defaults to the server clock. */
  asOf: IsoTimestampInputSchema.optional(),
});
export type ReviewSessionNextRequest = z.infer<typeof ReviewSessionNextRequestSchema>;

export interface ReviewSessionNextResult {
  /** The next due card to show, or `null` when the deck is exhausted. */
  readonly card: ReviewCardView | null;
  /** How many due cards remain (excluding the `exclude` set), AFTER this card. */
  readonly remaining: number;
  /** The total due-card deck size (excluding the `exclude` set), incl. this card. */
  readonly total: number;
}

/**
 * Fetch ONE card's full {@link ReviewCardView} by id (T037/T031) — the same
 * reveal-ready view `review.session.next` ships, but TARGETED (not soonest-due).
 * The process loop (T031) walks a FROZEN queue order with a cursor, so to reveal
 * the answer inline for the card under the cursor it needs that specific card's
 * full view, which the soonest-due `session.next` cannot return. Read-only: no
 * mutation, no `operation_log`. Returns `null` for a non-card / deleted id.
 */
export const ReviewCardRequestSchema = z.object({
  /** The card element id to load the full reveal-ready view for. */
  cardId: ElementIdSchema,
  /** "Now" the FSRS signals are computed against (ISO-8601); defaults to the server clock. */
  asOf: IsoTimestampInputSchema.optional(),
});
export type ReviewCardRequest = z.infer<typeof ReviewCardRequestSchema>;

export interface ReviewCardResult {
  /** The full reveal-ready card view, or `null` for a non-card / deleted id. */
  readonly card: ReviewCardView | null;
}

/** One previewed grade outcome: the resulting due time + interval (days) + a label. */
export interface ReviewIntervalPreview {
  readonly dueAt: string;
  /** Interval from `now` to the previewed due time, in (fractional) days. */
  readonly scheduledDays: number;
  /** Compact human label, e.g. `"10m"`, `"2d"`, `"5d"`. */
  readonly label: string;
}

/** The canonical rating values the renderer may grade with (validated against `REVIEW_RATINGS`). */
export const ReviewRatingSchema = z.enum(REVIEW_RATINGS);

export const ReviewPreviewRequestSchema = z.object({
  /** The card id to preview the four next intervals for. */
  cardId: ElementIdSchema,
  /** "Now" the previews compare against (ISO-8601); defaults to the server clock. */
  asOf: IsoTimestampInputSchema.optional(),
});
export type ReviewPreviewRequest = z.infer<typeof ReviewPreviewRequestSchema>;

export interface ReviewPreviewResult {
  /** The four possible next intervals, keyed by rating (PURE — nothing is mutated). */
  readonly intervals: Record<"again" | "hard" | "good" | "easy", ReviewIntervalPreview> | null;
}

const ReviewTimingMsSchema = z.number().finite().int().min(0).max(86_400_000);

export const ReviewGradeRequestSchema = z.object({
  /** The card id being graded. */
  cardId: ElementIdSchema,
  /** The grade (`again`/`hard`/`good`/`easy`). */
  rating: ReviewRatingSchema,
  /** The measured reveal→grade response time in ms (persisted on `review_logs`). */
  responseMs: ReviewTimingMsSchema,
  /** The measured card-shown→reveal prompt time in ms; omitted legacy callers default to 0. */
  promptMs: ReviewTimingMsSchema.optional().default(0),
  /** "Now" the grade is recorded at (ISO-8601); defaults to the server clock. */
  asOf: IsoTimestampInputSchema.optional(),
});
export type ReviewGradeRequestInput = z.input<typeof ReviewGradeRequestSchema>;
export type ReviewGradeRequest = z.output<typeof ReviewGradeRequestSchema>;

/** The durable review-log row written by a grade (append-only). */
export interface ReviewLogSummary {
  readonly id: string;
  readonly elementId: string;
  readonly rating: string;
  readonly reviewedAt: string;
  readonly responseMs: number;
  readonly promptMs: number;
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

// ---------------------------------------------------------------------------
// review.leeches()  (T040 — the leech cleanup view read)
// ---------------------------------------------------------------------------

/**
 * The leech cleanup view's read (T040). Lists every card flagged a leech (auto
 * after ≥4 lapses, or manually) with its lapse count + source, so the user can
 * rewrite / suspend / delete it. Read-only — no mutation, no `operation_log`. The
 * remediation ACTIONS reuse the existing `cards.update` (rewrite) / `cards.suspend`
 * / `cards.delete` / `cards.markLeech` (un-leech) commands. Soft-deleted cards are
 * excluded; suspended cards are kept (the cleanup view is where they are repaired).
 */

/** One leech card row for the cleanup view. */
export interface LeechSummary {
  readonly id: string;
  /** Card kind (`qa`/`cloze`). */
  readonly kind: string;
  readonly status: string;
  readonly stage: string;
  /** Numeric priority `0.0`–`1.0`; the UI derives the A/B/C/D label. */
  readonly priority: number;
  readonly title: string;
  /** The Q&A prompt, or the cloze `{{cN::…}}` text. */
  readonly prompt: string | null;
  /** The Q&A answer; `null` for cloze cards. */
  readonly answer: string | null;
  /** The canonical cloze text; `null` for Q&A cards. */
  readonly cloze: string | null;
  /** Cumulative FSRS lapses (failed reviews) — the leech's severity. */
  readonly lapses: number;
  /** Total reps recorded. */
  readonly reps: number;
  /** The owning source's title (provenance), or `null`. */
  readonly sourceTitle: string | null;
  /** The human-readable source location label ("¶ 4" / "p. 12"), or `null`. */
  readonly sourceLocationLabel: string | null;
  /**
   * The card's source-location anchor id (T085) — the **Open source** action needs the
   * id (not just `sourceLocationLabel`) to fetch the full jump payload; `null` when the
   * card has no source location.
   */
  readonly sourceLocationId: string | null;
  /**
   * The card's originating extract id (T085), filtered to a LIVE `extract` element —
   * `null` when the parent is missing / soft-deleted / not an extract (e.g. an
   * Anki-imported card). The screen uses this only to enable/disable **Back to
   * extract** (`extractAvailable = parentExtractId != null`); the authoritative guard
   * still lives main-side in `cards.backToExtract`.
   */
  readonly parentExtractId: string | null;
  /**
   * The card's current CONTEXT NOTE (T085) — the latest clarifying note appended via
   * **Add context** (op-log-derived, `null` when none). Surfaced as a separate context
   * line on the leech card so the note re-appears after the list refreshes and the
   * prompt actually becomes answerable (the deliverable's purpose), not just logged.
   */
  readonly context: string | null;
}

/** `review.leeches()` takes no arguments. */
export const ReviewLeechesRequestSchema = z.void();

export interface ReviewLeechesResult {
  readonly cards: readonly LeechSummary[];
}

// ---------------------------------------------------------------------------
// review.modeDeck() / review.modeCount()  (T096 — targeted review modes)
// ---------------------------------------------------------------------------

/**
 * Targeted review modes (T096). A mode reviews a CHOSEN SUBSET of cards OUTSIDE
 * normal scheduling — by `concept` / `source` / `branch` (a lineage subtree) /
 * `search` (keyword) / `semantic` (vector) / `stale` (T090) / `leech` (T040) /
 * `random` audit. The selection IGNORES `review_states.due_at` (a not-due card is
 * selectable); everything else about a review is unchanged — `review.grade`
 * (untouched) still writes a durable `review_logs` row + advances FSRS. These two
 * commands are READ-ONLY: `review.modeDeck` resolves the ordered card-id deck and
 * maps each id through the SAME `toReviewCardView` the daily session ships (so the
 * renderer gets reveal-ready views with no per-card round-trip); `review.modeCount`
 * is the cheap count for the entry affordances. No mutation, no `operation_log`.
 *
 * The Zod selector mirrors `@interleave/core`'s {@link ReviewModeSelector} (the
 * single source of truth) so the IPC validation can't drift from the domain union.
 */

/** A bounded query string for the `search`/`semantic` modes. */
const ReviewModeQuerySchema = z.string().trim().min(1).max(512);

/** The validated review-mode selector — a discriminated union mirroring the core type. */
export const ReviewModeSelectorSchema: z.ZodType<ReviewModeSelector> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("concept"), conceptId: ElementIdSchema }),
    z.object({ kind: z.literal("source"), sourceId: ElementIdSchema }),
    z.object({ kind: z.literal("branch"), rootId: ElementIdSchema }),
    z.object({ kind: z.literal("search"), query: ReviewModeQuerySchema }),
    z.object({ kind: z.literal("semantic"), query: ReviewModeQuerySchema }),
    z.object({ kind: z.literal("stale") }),
    z.object({ kind: z.literal("leech") }),
    z.object({
      kind: z.literal("random"),
      size: z.number().int().min(1).max(MAX_REVIEW_MODE_DECK),
      seed: z.number().int().optional(),
    }),
  ],
) as z.ZodType<ReviewModeSelector>;

export const ReviewModeDeckRequestSchema = z.object({
  /** The typed selector describing the mode + its one parameter. */
  selector: ReviewModeSelectorSchema,
  /** "Now" the selection (e.g. stale derivation) compares against; defaults to the clock. */
  asOf: IsoTimestampInputSchema.optional(),
});
export type ReviewModeDeckRequest = z.infer<typeof ReviewModeDeckRequestSchema>;

export interface ReviewModeDeckResult {
  /** The ordered reveal-ready card views (capped at `MAX_REVIEW_MODE_DECK`). */
  readonly deck: readonly ReviewCardView[];
  /** The TOTAL underlying selected count BEFORE the cap (so the UI can say "of N"). */
  readonly total: number;
  /** The calm mode label for the header ("Concept" / "Leeches" / …). */
  readonly label: string;
  /** True when the underlying set exceeded the cap and the deck was truncated. */
  readonly truncated: boolean;
}

export const ReviewModeCountRequestSchema = z.object({
  selector: ReviewModeSelectorSchema,
  asOf: IsoTimestampInputSchema.optional(),
});
export type ReviewModeCountRequest = z.infer<typeof ReviewModeCountRequestSchema>;

export interface ReviewModeCountResult {
  /** The size of the subset the mode would review (cards only, outside scheduling). */
  readonly total: number;
  /** The calm mode label for the entry affordance. */
  readonly label: string;
}

// ---------------------------------------------------------------------------
// concepts.* / tags.*  (T041 — organize: hierarchical concepts + flat tags)
// ---------------------------------------------------------------------------

/**
 * The organize surface (T041). Concepts are HIERARCHICAL (a `concept`-type element
 * + a `concepts.parentConceptId` hierarchy row, created together so
 * `create_element` is logged); tags are FLAT (`tags`/`element_tags`). Both can be
 * created/assigned to any element and removed, and elements can be filtered by
 * concept (the queue's `concept` filter) and by tag (the library, T042). Every
 * mutation runs in ONE transaction and appends the correct EXISTING op — NO new op
 * types: concept create → `create_element`; concept membership → `add_relation` /
 * `remove_relation`; tags → `add_tag` / `remove_tag`. The renderer reaches this
 * only through these typed commands; there is still no generic `db.query`.
 *
 * `concepts.create` validates the parent (when given) exists; assigning is
 * idempotent (re-assigning the same pair is a no-op). The assign/unassign + tag
 * add/remove results echo back the element's full `{ concepts, tags }` so the
 * inspector reflects the change without a re-fetch.
 */

/** A bounded concept/tag name (1–256 chars). */
const ConceptNameSchema = z.string().trim().min(1).max(256);
const TagNameSchema = z.string().trim().min(1).max(256);

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
  /** Number of LIVE (not soft-deleted) elements that are members of this concept. */
  readonly memberCount: number;
  /** Per-concept FSRS desired-retention target (T079), or `null` = inherit. */
  readonly desiredRetention: number | null;
}

/** A tag with its live usage count (for the library filterbar). */
export interface TagSummary {
  readonly name: string;
  readonly count: number;
}

/** The element's organize state after an assign/unassign/tag mutation. */
export interface ElementOrganizeState {
  readonly elementId: string;
  readonly concepts: readonly ConceptSummary[];
  readonly tags: readonly string[];
}

export const ConceptsCreateRequestSchema = z.object({
  /** Display name (1–256 chars). */
  name: ConceptNameSchema,
  /** Optional parent concept id (must exist); omit/null for a root concept. */
  parentConceptId: ElementIdSchema.nullable().optional(),
});
export type ConceptsCreateRequest = z.infer<typeof ConceptsCreateRequestSchema>;

export interface ConceptsCreateResult {
  readonly concept: ConceptSummary;
}

/** `concepts.list()` takes no arguments. */
export const ConceptsListRequestSchema = z.void();

export interface ConceptsListResult {
  readonly concepts: readonly ConceptNode[];
}

export const ConceptsAssignRequestSchema = z.object({
  /** The element to add to the concept (any type). */
  elementId: ElementIdSchema,
  /** The concept element id to assign. */
  conceptId: ElementIdSchema,
});
export type ConceptsAssignRequest = z.infer<typeof ConceptsAssignRequestSchema>;

export interface ConceptsAssignResult {
  /** The element's organize state after the assignment, or `null` when unknown. */
  readonly element: ElementOrganizeState | null;
}

export const ConceptsUnassignRequestSchema = z.object({
  elementId: ElementIdSchema,
  conceptId: ElementIdSchema,
});
export type ConceptsUnassignRequest = z.infer<typeof ConceptsUnassignRequestSchema>;

export interface ConceptsUnassignResult {
  readonly element: ElementOrganizeState | null;
}

/**
 * `concepts.members(conceptId)` — the live elements assigned to one concept (the
 * `/concepts` knowledge-map drill-in). Read-only; backed by the EXISTING
 * `ConceptRepository.elementsForConcept` (returns non-deleted member ids), each
 * enriched main-side like a search/library row.
 */
export const ConceptsMembersRequestSchema = z.object({
  /** The concept whose member elements to list. */
  conceptId: ElementIdSchema,
});
export type ConceptsMembersRequest = z.infer<typeof ConceptsMembersRequestSchema>;

/**
 * One member-element summary for the drill-in list. Carries the SAME enrichment a
 * {@link LibraryItem} does (type/title/priority + label, the FSRS-vs-attention
 * {@link SchedulerSignals}, the due state/label, owning-source title) so a member
 * row reads identically to a search/queue/library row — and enough to open the
 * element (source → reader, extract → extract view, card → review).
 */
export interface ConceptMemberSummary {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  /** Numeric priority (0..1) + its A/B/C/D label, for the row badge. */
  readonly priority: number;
  readonly priorityLabel: PriorityLabelInput;
  readonly status: string;
  readonly stage: string;
  /** Owning source title (provenance) for the row's meta line; `null` when none. */
  readonly sourceTitle: string | null;
  /** Next-attention/review time (ISO); `null` when none. */
  readonly dueAt: string | null;
  /** The load-bearing FSRS-vs-attention scheduler signals for the row's chip. */
  readonly scheduler: SchedulerSignals;
  /** How due the element is now (overdue / today / soon), for the row's badge. */
  readonly due: QueueDueState;
  /** A short human due label ("Overdue", "Due today", "in 3d", "Scheduled"). */
  readonly dueLabel: string;
  /** True only when this member is actionable in the due queue at the read clock. */
  readonly queueEligible: boolean;
  /** Human explanation when a member has scheduler history but is not in Queue. */
  readonly notInQueueReason: string | null;
}

export interface ConceptsMembersResult {
  readonly members: readonly ConceptMemberSummary[];
}

// ---------------------------------------------------------------------------
// tasks.*  (T092 — verification tasks: scheduled `task`-type elements)
//
// A `task` is the EXISTING core element type — an ATTENTION-scheduled maintenance
// action ("verify this claim" / "find a better source" / "update this outdated card"
// / "check the current version" / "custom") that protects time-sensitive knowledge
// from rotting. It is NEVER a card and NEVER FSRS-scheduled. Tasks are created by
// hand (the inspector / a review banner) or GENERATED from T090 expiry (a fact past
// `review_by`/`valid_until`), link back to the element they protect (a `references`
// edge + `linked_element_id`), appear in the daily queue + the inspector, and
// complete/postpone like any attention item. Every mutation is ONE transaction + the
// correct EXISTING op — NO new op types: create → `create_element`; link →
// `add_relation`; schedule/complete/postpone → `reschedule_element`. There is still no
// generic `db.query`.
// ---------------------------------------------------------------------------

/** The closed verification-task kinds (the core TASK_TYPES tuple). */
export const TaskTypeSchema = z.enum(TASK_TYPES);
export type TaskTypeInput = z.infer<typeof TaskTypeSchema>;

/** A bounded task title (1–256 chars). */
const TaskTitleSchema = z.string().trim().min(1).max(256);
/** A bounded, optional task note (≤2048 chars). */
const TaskNoteSchema = z.string().trim().max(2048).optional();

/** The explicit schedule choice a task accepts (reuses the queue's choice union). */
const TaskDueChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tomorrow") }),
  z.object({ kind: z.literal("nextWeek") }),
  z.object({ kind: z.literal("nextMonth") }),
  z.object({ kind: z.literal("manual"), date: IsoTimestampInputSchema }),
]);

/** A flat verification-task summary — the inspector/queue read shape. */
export interface TaskSummary {
  readonly id: string;
  readonly taskType: TaskType;
  readonly title: string;
  readonly note: string | null;
  readonly status: string;
  readonly dueAt: string | null;
  /** Numeric priority (0..1); the UI derives the A/B/C/D label. */
  readonly priority: number;
  /** The element this task protects (resolved from the link), or `null`. */
  readonly linkedElement: {
    readonly id: string;
    readonly type: string;
    readonly title: string;
  } | null;
}

export const TasksCreateRequestSchema = z.object({
  taskType: TaskTypeSchema,
  title: TaskTitleSchema,
  note: TaskNoteSchema,
  /** The element the task protects (links it + inherits its priority); omit/null for a custom task. */
  linkedElementId: ElementIdSchema.nullable().optional(),
  /** Optional explicit priority band; default = the linked element's priority, else B. */
  priority: PriorityLabelSchema.optional(),
  /** Optional explicit schedule; default = an attention interval by priority. */
  dueChoice: TaskDueChoiceSchema.optional(),
});
export type TasksCreateRequest = z.infer<typeof TasksCreateRequestSchema>;

export interface TasksCreateResult {
  readonly task: TaskSummary;
}

export const TasksListRequestSchema = z.object({
  /** Narrow to OPEN tasks protecting one element (the inspector Maintenance read). */
  linkedElementId: ElementIdSchema.nullable().optional(),
});
export type TasksListRequest = z.infer<typeof TasksListRequestSchema>;

export interface TasksListResult {
  readonly tasks: readonly TaskSummary[];
}

export const TasksCompleteRequestSchema = z.object({
  id: ElementIdSchema,
  /**
   * When set (>0), EXPLICITLY bump the protected card's `review_by` forward by N days
   * (a T090 `update_element`) so a completed verify/update task stops re-surfacing the
   * fact. Never automatic — the user opts in (they may complete without refreshing).
   */
  bumpReviewByDays: z.number().int().positive().max(36500).optional(),
});
export type TasksCompleteRequest = z.infer<typeof TasksCompleteRequestSchema>;

export interface TasksCompleteResult {
  readonly task: TaskSummary;
}

export const TasksPostponeRequestSchema = z.object({
  id: ElementIdSchema,
  /** Optional explicit choice; default = the growing by-priority postpone interval. */
  choice: TaskDueChoiceSchema.optional(),
});
export type TasksPostponeRequest = z.infer<typeof TasksPostponeRequestSchema>;

export interface TasksPostponeResult {
  readonly task: TaskSummary;
}

/** `tasks.generateFromExpiry({})` — generate verification tasks from T090 expiry. */
export const TasksGenerateFromExpiryRequestSchema = z.object({}).strict();
export type TasksGenerateFromExpiryRequest = z.infer<typeof TasksGenerateFromExpiryRequestSchema>;

export interface TasksGenerateFromExpiryResult {
  readonly created: number;
  readonly tasks: readonly TaskSummary[];
}

// ---------------------------------------------------------------------------
// synthesis.*  (T095 — incremental writing / synthesis notes)
//
// A synthesis note is the EXISTING core `synthesis_note` element type — a writing/
// thinking surface that COLLECTS linked extracts/cards (explicit `references` edges)
// and is SCHEDULED TO RETURN for refinement on the ATTENTION scheduler (NEVER FSRS —
// a synthesis note is processed, not recalled). It is the "incremental writing"
// counterpart to incremental reading. No new table, no new element type, no new op:
// create → `create_element` (+ `update_document` for a body); link → `add_relation`
// (`references`); unlink → `remove_relation`; edit body → `update_document`;
// schedule-return → `reschedule_element`. A scheduled note flows through the EXISTING
// `queue.list` (an attention item). There is still no generic `db.query`.
// ---------------------------------------------------------------------------

/** A bounded synthesis-note title (1–256 chars). */
const SynthesisTitleSchema = z.string().trim().min(1).max(256);

/** The explicit return choice a synthesis note accepts (reuses the queue's choice union). */
const SynthesisWhenSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tomorrow") }),
  z.object({ kind: z.literal("nextWeek") }),
  z.object({ kind: z.literal("nextMonth") }),
  z.object({ kind: z.literal("manual"), date: IsoTimestampInputSchema }),
]);
export type SynthesisWhen = z.infer<typeof SynthesisWhenSchema>;

/** One referenced extract/card collected into a synthesis note. */
export interface SynthesisLinkedView {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly stage: string;
  /** Numeric priority (0..1); the UI derives the A/B/C/D label. */
  readonly priority: number;
  /** The `element_relations` row id (so the renderer can unlink it precisely). */
  readonly relationId: string;
}

/** The full synthesis-note read — the note element + its linked material + due date. */
export interface SynthesisDataView {
  readonly element: ElementSummary;
  readonly linked: readonly SynthesisLinkedView[];
  /** The next attention return date, or `null` when unscheduled. */
  readonly dueAt: string | null;
}

export const SynthesisCreateRequestSchema = z.object({
  title: SynthesisTitleSchema,
  /** Optional explicit priority band; default = the configured default source priority. */
  priority: PriorityLabelSchema.optional(),
  /** Optional initial ProseMirror body JSON (built renderer-side). */
  bodyJson: z.unknown().optional(),
  /** The flattened plain-text mirror of `bodyJson`. */
  bodyPlainText: z.string().max(4_000_000).optional(),
  /** The ordered stable block list for `bodyJson` (preserves the stable ids). */
  blocks: z.array(DocumentBlockInputSchema).max(100_000).optional(),
});
export type SynthesisCreateRequest = z.infer<typeof SynthesisCreateRequestSchema>;

export interface SynthesisCreateResultView {
  readonly element: ElementSummary;
}

export const SynthesisLinkRequestSchema = z.object({
  noteId: ElementIdSchema,
  /** The extract/card to collect into the note. */
  targetId: ElementIdSchema,
});
export type SynthesisLinkRequest = z.infer<typeof SynthesisLinkRequestSchema>;

export const SynthesisUnlinkRequestSchema = z.object({
  noteId: ElementIdSchema,
  targetId: ElementIdSchema,
});
export type SynthesisUnlinkRequest = z.infer<typeof SynthesisUnlinkRequestSchema>;

export interface SynthesisLinkResultView {
  readonly data: SynthesisDataView;
}

export const SynthesisEditBodyRequestSchema = z.object({
  noteId: ElementIdSchema,
  prosemirrorJson: z.unknown(),
  plainText: z.string().max(4_000_000),
  blocks: z.array(DocumentBlockInputSchema).max(100_000).optional(),
});
export type SynthesisEditBodyRequest = z.infer<typeof SynthesisEditBodyRequestSchema>;

export interface SynthesisEditBodyResult {
  readonly data: SynthesisDataView;
}

export const SynthesisScheduleReturnRequestSchema = z.object({
  noteId: ElementIdSchema,
  when: SynthesisWhenSchema,
});
export type SynthesisScheduleReturnRequest = z.infer<typeof SynthesisScheduleReturnRequestSchema>;

export interface SynthesisScheduleReturnResult {
  readonly data: SynthesisDataView;
}

export const SynthesisGetRequestSchema = z.object({
  noteId: ElementIdSchema,
});
export type SynthesisGetRequest = z.infer<typeof SynthesisGetRequestSchema>;

export interface SynthesisGetResult {
  /** The synthesis-note read, or `null` when the id is unknown / not a synthesis note. */
  readonly data: SynthesisDataView | null;
}

// ---------------------------------------------------------------------------
// retention.*  (T079 — desired retention by priority band / concept / card)
//
// A card's FSRS desired-retention target is RESOLVED from an ordered rule set
// (per-card override → concept target → priority-band target → global default).
// The bands + enable flag live in `AppSettings` (settings, no op); per-concept
// targets on `concepts.desired_retention` (update_element); the per-card override
// on `cards.desired_retention` (update_element). FSRS schedules each card against
// its resolved target. CARD-ONLY — the attention scheduler is untouched.
// ---------------------------------------------------------------------------

/** A resolved desired-retention target as a probability in the supported band. */
const RetentionTargetSchema = z.number().min(DESIRED_RETENTION_MIN).max(DESIRED_RETENTION_MAX);

/** Which rule resolved a card's effective retention (the inspector/debug read). */
export type RetentionSource = "card" | "concept" | "band" | "global";

/** One concept's per-concept retention target (for the `retention.get` read). */
export interface RetentionConceptTarget {
  readonly conceptId: string;
  readonly name: string;
  /** The per-concept target, or `null` = inherit the band/global default. */
  readonly target: number | null;
}

/** `retention.get()` takes no arguments. */
export const RetentionGetRequestSchema = z.void();

export interface RetentionGetResult {
  /** The global default (`settings.defaultDesiredRetention`). */
  readonly global: number;
  /** Whether the per-band feature is enabled. */
  readonly byBandEnabled: boolean;
  /** The per-band targets (a partial A/B/C/D map; an absent band inherits global). */
  readonly byBand: Partial<Record<PriorityLabelInput, number>>;
  /** Every live concept with its per-concept target (or `null` = inherit). */
  readonly byConcept: readonly RetentionConceptTarget[];
}

export const RetentionSetBandRequestSchema = z.object({
  band: PriorityLabelSchema,
  /** The band target, or `null` to clear (inherit global). */
  target: RetentionTargetSchema.nullable(),
});
export type RetentionSetBandRequest = z.infer<typeof RetentionSetBandRequestSchema>;

export const RetentionSetBandEnabledRequestSchema = z.object({
  enabled: z.boolean(),
});
export type RetentionSetBandEnabledRequest = z.infer<typeof RetentionSetBandEnabledRequestSchema>;

/** Both band writes return the refreshed full retention read. */
export interface RetentionUpdatedResult {
  readonly retention: RetentionGetResult;
}

export const RetentionSetConceptRequestSchema = z.object({
  conceptId: ElementIdSchema,
  /** The per-concept target, or `null` to clear (inherit). */
  target: RetentionTargetSchema.nullable(),
});
export type RetentionSetConceptRequest = z.infer<typeof RetentionSetConceptRequestSchema>;

export interface RetentionSetConceptResult {
  readonly concept: RetentionConceptTarget | null;
}

export const RetentionSetCardRequestSchema = z.object({
  cardId: ElementIdSchema,
  /** The per-card override, or `null` to clear (inherit). */
  target: RetentionTargetSchema.nullable(),
});
export type RetentionSetCardRequest = z.infer<typeof RetentionSetCardRequestSchema>;

export interface RetentionSetCardResult {
  /** The card's stored override after the write (or `null` = inherit). */
  readonly cardId: string;
  readonly target: number | null;
}

export const RetentionResolveForRequestSchema = z.object({
  cardId: ElementIdSchema,
});
export type RetentionResolveForRequest = z.infer<typeof RetentionResolveForRequestSchema>;

export interface RetentionResolveForResult {
  /** The resolved effective target, or `null` when the id is not a live card. */
  readonly target: number | null;
  /** Which rule won, or `null` when the id is not a live card. */
  readonly source: RetentionSource | null;
}

// ---------------------------------------------------------------------------
// optimization.*  (T080 — on-device FSRS parameter optimization)
//
// Accumulated `review_logs` are replayed on-device to SUGGEST a better FSRS
// parameter set (global preset or per-concept) with a workload-impact preview.
// Suggestions are NEVER auto-applied — the user explicitly applies or dismisses.
// The apply writes to a QUERYABLE store: the global preset → the `fsrs.params.global`
// setting (no op); a per-concept preset → `concepts.fsrs_params` (+ update_element).
// `schedulerForCard` reads those stores. CARD-ONLY (FSRS); ts-fsrs has NO optimizer
// — this is an honest history-calibration estimate, NEVER claimed optimal.
// ---------------------------------------------------------------------------

/** The optimization scope — the global preset, or one concept's preset. */
export const OptimizationScopeSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("global") }),
  z.object({ scope: z.literal("concept"), conceptId: ElementIdSchema }),
]);
export type OptimizationScopeRequest = z.infer<typeof OptimizationScopeSchema>;

/** `optimization.suggest({ scope })`. */
export const OptimizationSuggestRequestSchema = z.object({
  scope: OptimizationScopeSchema,
});
export type OptimizationSuggestRequest = z.infer<typeof OptimizationSuggestRequestSchema>;

/** A calibration score (lower is better) for the before/after metric copy. */
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

/**
 * The suggestion view the renderer renders (the result of `optimization.suggest`).
 * Carries the suggested `params` so the renderer can echo them back to
 * `optimization.apply` unchanged (the renderer never computes params).
 */
export interface OptimizationSuggestResult {
  /** The suggested 21-number FSRS-6 `w` vector (always valid/clamped). */
  readonly params: readonly number[];
  readonly baseline: OptimizationFitScore;
  readonly suggested: OptimizationFitScore;
  /** `baseline.logLoss - suggested.logLoss` (≥ 0; `0` = no improvement found). */
  readonly improvement: number;
  readonly reviewsScored: number;
  /** The honest method label — always `"history-calibration"`, never "optimal". */
  readonly method: "history-calibration";
  /** `false` below the data floor — show the insufficient-data empty state. */
  readonly sufficientData: boolean;
  readonly workload: OptimizationWorkload;
}

/** `optimization.apply({ scope, params })` — the only persisting command. */
export const OptimizationApplyRequestSchema = z.object({
  scope: OptimizationScopeSchema,
  /** The accepted 21-number FSRS-6 `w` vector (validated again at the service). */
  params: z.array(z.number()).length(21),
});
export type OptimizationApplyRequest = z.infer<typeof OptimizationApplyRequestSchema>;

export interface OptimizationApplyResult {
  readonly applied: true;
}

// ---------------------------------------------------------------------------
// workload.*  (T081 — workload simulation)
//
// A single READ-ONLY command that previews how daily load shifts BEFORE the user
// commits a change: (a) altering desired retention (global / a band / a concept),
// (b) adding N new cards (a planned import), or (c) postponing low-priority material.
// A pure projection over the live `review_states` + due dates (the `change` is a Zod
// discriminatedUnion); it mutates nothing and appends no op. FSRS vs attention stay
// distinct in the projection (a retention lever moves CARDS; a postpone lever moves
// ATTENTION items + optional low-priority MATURE cards — never fragile). The renderer
// then `Commit`s the real change via the relevant EXISTING command (retention set /
// import / postpone); the preview itself commits nothing.
// ---------------------------------------------------------------------------

/** The priority band a per-band retention / postpone lever targets. */
export const WorkloadBandSchema = z.enum(["A", "B", "C", "D"]);

/** The discriminated workload-change union the projector accepts. */
export const WorkloadChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("retention"),
    scope: z.enum(["global", "band", "concept"]),
    /** The band label (scope `band`) or concept name (scope `concept`); omit for `global`. */
    key: z.string().optional(),
    /** The new desired-retention target (`0`–`1`). */
    target: z.number().min(0).max(1),
  }),
  z.object({
    kind: z.literal("addCards"),
    count: z.number().int().min(0).max(100_000),
    priority: z.number().min(0).max(1),
    /** How many days out the first review lands (default `0`). */
    firstDueInDays: z.number().int().min(0).max(3650).optional(),
  }),
  z.object({
    kind: z.literal("postponeLowPriority"),
    band: WorkloadBandSchema,
    days: z.number().min(0).max(3650),
    /** Also postpone low-priority MATURE cards (never fragile) — default `false`. */
    includeMatureCards: z.boolean().optional(),
  }),
]);
export type WorkloadChangeRequest = z.infer<typeof WorkloadChangeSchema>;

/** `workload.simulate({ change, windowDays?, asOf? })`. */
export const WorkloadSimulateRequestSchema = z.object({
  change: WorkloadChangeSchema,
  /** The projection window length in days (default 30). */
  windowDays: z.number().int().min(1).max(365).optional(),
  /** The clock the projection starts at (ISO-8601); defaults to the wall clock. */
  asOf: IsoTimestampInputSchema.optional(),
});
export type WorkloadSimulateRequest = z.infer<typeof WorkloadSimulateRequestSchema>;

/** One local-calendar day's before/after due counts. `date` is `YYYY-MM-DD` (local). */
export interface WorkloadProjectionDay {
  readonly date: string;
  readonly before: number;
  readonly after: number;
}

/** The complete workload projection (the `workload.simulate` result). */
export interface WorkloadSimulateResult {
  readonly days: readonly WorkloadProjectionDay[];
  /** Days in the window strictly above `budget` BEFORE the change. */
  readonly overBudgetDaysBefore: number;
  /** Days in the window strictly above `budget` AFTER the change. */
  readonly overBudgetDaysAfter: number;
  /** The largest single-day due count BEFORE / AFTER the change. */
  readonly peakBefore: number;
  readonly peakAfter: number;
  /** `after - before` total over the next 7 / 30 days (positive = more load). */
  readonly deltaNext7: number;
  readonly deltaNext30: number;
  /** The daily review budget (the overload line). */
  readonly budget: number;
}

/** `tags.list()` takes no arguments. */
export const TagsListRequestSchema = z.void();

export interface TagsListResult {
  readonly tags: readonly TagSummary[];
}

export const TagsAddRequestSchema = z.object({
  /** The element to tag (any type). */
  elementId: ElementIdSchema,
  /** The tag name (created on demand, idempotent). */
  tag: TagNameSchema,
});
export type TagsAddRequest = z.infer<typeof TagsAddRequestSchema>;

export interface TagsAddResult {
  readonly element: ElementOrganizeState | null;
}

export const TagsRemoveRequestSchema = z.object({
  elementId: ElementIdSchema,
  tag: TagNameSchema,
});
export type TagsRemoveRequest = z.infer<typeof TagsRemoveRequestSchema>;

export interface TagsRemoveResult {
  readonly element: ElementOrganizeState | null;
}

// ---------------------------------------------------------------------------
// search.*  (T042 — local FTS5 full-text search)
// ---------------------------------------------------------------------------

/**
 * The searchable element types (the only types with an FTS index). The library
 * `result` list groups by these; topics/tasks/concepts are not full-text indexed.
 */
export const SearchableTypeSchema = z.enum(["source", "extract", "card"]);
export type SearchableType = z.infer<typeof SearchableTypeSchema>;

/**
 * A ranked search hit — enough for the library `result` row + selection detail.
 * `snippet` is a short matched excerpt; `score` is the (lower-is-better) `bm25`
 * rank exposed for debugging/ordering; the source meta (`sourceTitle`/
 * `sourceLocationLabel`) lets the row reuse the refblock formatter (T043).
 */
export interface SearchResult {
  readonly id: string;
  readonly type: SearchableType;
  readonly title: string;
  readonly snippet: string;
  readonly score: number;
  /** Numeric priority (0..1) + its A/B/C/D label, for the row badge. */
  readonly priority: number;
  readonly priorityLabel: PriorityLabelInput;
  /** The concept this element is a member of, by name; `null` when none. */
  readonly concept: string | null;
  /** Owning source title (provenance) for the row's refblock; `null` when none. */
  readonly sourceTitle: string | null;
  /** Human-readable source location label ("Definition · ¶1"); `null` when none. */
  readonly sourceLocationLabel: string | null;
  /** Next-attention time (ISO), for the row's scheduler chip; `null` when none. */
  readonly dueAt: string | null;
  /**
   * The element's scheduler signals (the load-bearing FSRS-vs-attention split),
   * so the library selection detail renders the same `SchedulerChip` the
   * queue/inspector/review do. Cards carry the FSRS readout; everything else the
   * attention stage/postpone readout.
   */
  readonly scheduler: SchedulerSignals;
  /** How due the element is now (overdue / today / soon), for the detail badge. */
  readonly due: QueueDueState;
  /** A short human due label ("Overdue", "Due today", "in 3d", "Scheduled"). */
  readonly dueLabel: string;
  /** True only when this result is actionable in the due queue at the read clock. */
  readonly queueEligible: boolean;
  /** Human explanation when a result has scheduler history but is not in Queue. */
  readonly notInQueueReason: string | null;
}

export const SearchQueryRequestSchema = z.object({
  /** The raw user query. Sanitized into a safe FTS5 MATCH expression main-side. */
  q: z.string().max(512),
  /** Restrict to a single searchable type. */
  type: SearchableTypeSchema.optional(),
  /** Restrict to members of this concept (by concept id) — T041 filter. */
  conceptId: ElementIdSchema.optional(),
  /** Restrict to elements carrying this tag name — T041 filter. */
  tag: TagNameSchema.optional(),
  /**
   * Restrict to elements whose numeric priority maps to this A/B/C/D band (the
   * `/search` priority facet). Applied MAIN-side via the canonical priority-band
   * boundaries (mirroring `priorityToLabel`) so the result list and drill-down
   * filterbar counts respect priority together — chip numbers then match the
   * priority-narrowed lists (the count-vs-list invariant).
   */
  priorityLabel: PriorityLabelSchema.optional(),
  /** Cap the result count (1..200; defaults main-side). */
  limit: z.number().int().min(1).max(200).optional(),
  /**
   * Compact lookup surfaces may skip drill-down counts they do not render. The
   * default remains `true` for `/search` so existing facet semantics are intact.
   */
  includeCounts: z.boolean().optional(),
});
export type SearchQueryRequest = z.infer<typeof SearchQueryRequestSchema>;

/**
 * DRILL-DOWN faceted counts for the `/search` filterbar. Each dimension respects
 * the active keyword + tag and every OTHER active facet, but drops its own active
 * value: `byType` ignores type, `byPriority` ignores priority, and `byConcept`
 * ignores concept. That makes each chip count equal the rows returned if that chip
 * were selected with the rest of the current filters. Concept keys are concept
 * element ids and MUST come from this map, not global `ConceptNode.memberCount`.
 */
export interface SearchCounts {
  /** Per searchable type, ignoring the active type filter. */
  readonly byType: Readonly<Record<SearchableType, number>>;
  /** Per concept (keyed by concept element id), ignoring the active concept filter. */
  readonly byConcept: Readonly<Record<string, number>>;
  /** Per priority band A/B/C/D, ignoring the active priority filter. */
  readonly byPriority: Readonly<Record<PriorityLabelInput, number>>;
}

export interface SearchQueryResult {
  readonly results: readonly SearchResult[];
  /** Drill-down counts for the `/search` filterbar chips. */
  readonly counts: SearchCounts;
}

// ---------------------------------------------------------------------------
// semantic.*  (T087 — on-device semantic search: FTS + sqlite-vec fusion)
// ---------------------------------------------------------------------------

/** The retrieval mode that actually ran, so the UI labels "keyword only" honestly. */
export const SemanticSearchModeSchema = z.enum(["semantic", "fts", "disabled"]);
export type SemanticSearchMode = z.infer<typeof SemanticSearchModeSchema>;

/**
 * A fused search result row. EXTENDS the full {@link SearchResult} shape (so the
 * library renders a semantic row identically to a keyword row — same scheduler
 * chip, due badge, refblock) and adds `semantic` (whether a vector neighbor
 * produced it, so the UI labels purely-semantic "related" rows) + `vecDistance`.
 * NO raw vectors cross IPC — only ids/titles/snippets/distances.
 */
export interface SemanticSearchResultRow extends SearchResult {
  /** Whether a vector neighbor contributed this hit (label it "related" in the UI). */
  readonly semantic: boolean;
  /** The `vec0` distance (lower nearer), or `null` for a pure keyword hit. */
  readonly vecDistance: number | null;
}

export const SemanticSearchRequestSchema = z.object({
  q: z.string().max(512),
  type: SearchableTypeSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export type SemanticSearchRequest = z.infer<typeof SemanticSearchRequestSchema>;

export interface SemanticSearchResult {
  readonly results: readonly SemanticSearchResultRow[];
  /** Which retrieval ran — `disabled`/`fts` tell the UI to show "keyword only". */
  readonly mode: SemanticSearchMode;
  /** Drill-down counts over the returned fused result universe. */
  readonly counts: SearchCounts;
}

export const SemanticStatusRequestSchema = z.object({});
export type SemanticStatusRequest = z.infer<typeof SemanticStatusRequestSchema>;

export interface SemanticStatusResult {
  readonly enabled: boolean;
  /** Whether `sqlite-vec` `vec0` is loaded + functional (the FTS-only degrade gate). */
  readonly vecAvailable: boolean;
  readonly modelDownloaded: boolean;
  /** How many live searchable elements are embedded. */
  readonly embedded: number;
  /** The total live searchable corpus (the "N of M embedded" denominator). */
  readonly total: number;
  readonly modelId: string;
}

export const SemanticReindexRequestSchema = z.object({
  onlyMissing: z.boolean().optional(),
});
export type SemanticReindexRequest = z.infer<typeof SemanticReindexRequestSchema>;

export interface SemanticReindexResult {
  /** How many `embed` jobs were enqueued (observe progress via `jobs.subscribe`). */
  readonly enqueued: number;
}

export const SemanticDownloadModelRequestSchema = z.object({});
export type SemanticDownloadModelRequest = z.infer<typeof SemanticDownloadModelRequestSchema>;

export interface SemanticDownloadModelResult {
  /** Whether the local model is ready (`embeddingModelDownloaded` is now `true`). */
  readonly downloaded: boolean;
}

// ---------------------------------------------------------------------------
// semantic.related()  (T088 — DERIVED related-item suggestions)
// ---------------------------------------------------------------------------

/**
 * Related-item suggestions for an element (T088). Validates `{ elementId, limit? }`.
 * The result ({@link SemanticRelatedResult}) is a DERIVED read over the T087 `vec0`
 * store + the `concept_membership` / `concepts.parentConceptId` lineage — no new
 * `RELATION_TYPES`, no `element_relations` writes, no `operation_log` entries. No
 * raw vectors cross IPC (only ids/titles/similarities).
 */
export const SemanticRelatedRequestSchema = z.object({
  elementId: ElementIdSchema,
  limit: z.number().int().min(1).max(50).optional(),
});
export type SemanticRelatedRequest = z.infer<typeof SemanticRelatedRequestSchema>;

/** A related element (a similar extract, a possible duplicate, or a sibling source). */
export interface SemanticRelatedItem {
  readonly id: string;
  readonly type: SearchableType;
  readonly title: string;
  /** A 0..1 similarity from the `vec0` distance when vector-ranked, else `null`. */
  readonly similarity: number | null;
  /** `similar` for a near neighbor, `duplicate` for a below-threshold near-identical one. */
  readonly kind: "similar" | "duplicate";
  /** The originating source reference (refblock), or `null` when unresolvable. */
  readonly ref: SourceRef | null;
}

/** A prerequisite/ancestor concept + its hierarchy level (0 = a direct member). */
export interface SemanticRelatedConcept {
  readonly id: string;
  readonly name: string;
  /** 0 = a direct member concept; 1+ = an ancestor (more general → learn first). */
  readonly level: number;
}

/**
 * The four DERIVED buckets + whether the vector buckets actually ran. When
 * `semanticAvailable` is `false` (semantics off / `vec0` absent / not embedded) the
 * `similar`/`duplicates` buckets are empty while the concept + sibling buckets still
 * resolve from lineage — the graceful degrade.
 */
export interface SemanticRelatedResult {
  readonly similar: readonly SemanticRelatedItem[];
  readonly duplicates: readonly SemanticRelatedItem[];
  readonly prerequisiteConcepts: readonly SemanticRelatedConcept[];
  readonly siblingSources: readonly SemanticRelatedItem[];
  readonly semanticAvailable: boolean;
}

// ---------------------------------------------------------------------------
// semantic.contradictions()  (T089 — DERIVED, HEURISTIC, SUGGESTIVE conflict flags)
// ---------------------------------------------------------------------------

/**
 * Contradiction-detection request (T089). Validates `{ elementId }`. The result
 * ({@link SemanticContradictionsResult}) is a DERIVED, HEURISTIC read over the T087
 * `vec0` neighbors + the `sources` provenance dates (via lineage) — no op-log, no
 * persisted "conflict" relation, no lineage mutation, never authoritative. Returns
 * empty flags when semantics are off / `vec0` is absent (the surface hides). No raw
 * vectors cross IPC.
 */
export const SemanticContradictionsRequestSchema = z.object({
  elementId: ElementIdSchema,
});
export type SemanticContradictionsRequest = z.infer<typeof SemanticContradictionsRequestSchema>;

/** An opposing/superseding signal a possible-conflict flag carries. */
export const ContradictionReasonSchema = z.enum(["negation", "numeric", "recency"]);
export type ContradictionReason = z.infer<typeof ContradictionReasonSchema>;

/**
 * One possible-conflict flag for the calm "possible conflict" surface. Carries the
 * conflicting (`other`) element's id/type/title + its source reference, the queried
 * element's own source reference (the side-by-side compare), and the heuristic's
 * reasons/severity/newerSide. `severity` is NEVER `"high"` — the whole thing is
 * suggestive ("possible conflict — review", never "conflict").
 */
export interface ContradictionFlagView {
  readonly otherId: string;
  readonly otherType: SearchableType;
  readonly otherTitle: string;
  /** The conflicting neighbor's source reference (refblock), or `null`. */
  readonly otherRef: SourceRef | null;
  /** The queried element's own source reference, for the side-by-side compare. */
  readonly selfRef: SourceRef | null;
  readonly reasons: readonly ContradictionReason[];
  readonly severity: "low" | "medium";
  /**
   * `self` when the queried element's source is the newer one, `other` when the
   * neighbor's is, `null` when the recency signal did not fire.
   */
  readonly newerSide: "self" | "other" | null;
}

export interface SemanticContradictionsResult {
  /** The possible-conflict flags — empty when semantics are off / nothing conflicts. */
  readonly flags: readonly ContradictionFlagView[];
}

// ---------------------------------------------------------------------------
// library.browse()  (Library route — the facet-driven browse-everything read)
// ---------------------------------------------------------------------------

/**
 * The browsable element types the Library route lists (every distillation type
 * EXCEPT `concept`, which is a FACET column, and `media_fragment`, which has no
 * MVP reader target). Unlike {@link SearchableTypeSchema} (FTS-indexed only),
 * this includes `topic`/`synthesis_note`/`task` — the types keyword search can
 * never return — which is the whole point of a dedicated browse surface.
 */
export const LibraryBrowseTypeSchema = z.enum([
  "source",
  "extract",
  "card",
  "topic",
  "synthesis_note",
  "task",
]);
export type LibraryBrowseType = z.infer<typeof LibraryBrowseTypeSchema>;

/**
 * The facet-driven browse request. Every facet is OPTIONAL — with none set the
 * Library lists ALL live elements (the browse-first default that distinguishes it
 * from keyword search, which returns `[]` for an empty query). Facets narrow by
 * type / concept membership / priority band / lifecycle status; the main process
 * runs the read in {@link LibraryQuery} (no keyword, no FTS).
 */
export const LibraryBrowseRequestSchema = z.object({
  /** Keep only these browsable element types. */
  types: z.array(LibraryBrowseTypeSchema).optional(),
  /** Keep only members of this concept (by concept id) — the `concept_membership` facet. */
  conceptId: ElementIdSchema.optional(),
  /** Keep only elements whose priority maps to this A/B/C/D band. */
  priorityLabel: PriorityLabelSchema.optional(),
  /** Keep only these lifecycle statuses. */
  statuses: z.array(z.enum(ELEMENT_STATUSES)).optional(),
  /** Cap the result count (1..500; defaults main-side). */
  limit: z.number().int().min(1).max(500).optional(),
});
export type LibraryBrowseRequest = z.infer<typeof LibraryBrowseRequestSchema>;

/**
 * One browsed element row — the Library `result` row + selection detail. Reuses
 * the SAME enrichment the search row carries (priority label, concept, source
 * provenance/location, the FSRS-vs-attention {@link SchedulerSignals}, the due
 * state/label) so a Library row reads identically to a search/queue row. Unlike
 * a search hit it carries NO `snippet`/`score` (there is no keyword to match).
 */
export interface LibraryItem {
  readonly id: string;
  readonly type: LibraryBrowseType;
  readonly title: string;
  /** Numeric priority (0..1) + its A/B/C/D label, for the row badge. */
  readonly priority: number;
  readonly priorityLabel: PriorityLabelInput;
  readonly status: string;
  readonly stage: string;
  /** The concept this element is a member of, by name; `null` when none. */
  readonly concept: string | null;
  /** Owning source title (provenance) for the row's refblock; `null` when none. */
  readonly sourceTitle: string | null;
  /** Human-readable source location label ("Definition · ¶1"); `null` when none. */
  readonly sourceLocationLabel: string | null;
  /** Next-attention/review time (ISO), for the detail; `null` when none. */
  readonly dueAt: string | null;
  /** When the item was deliberately parked from the inbox, or `null`. */
  readonly parkedAt: string | null;
  /** The load-bearing FSRS-vs-attention scheduler signals for the detail chip. */
  readonly scheduler: SchedulerSignals;
  /** How due the element is now (overdue / today / soon), for the detail badge. */
  readonly due: QueueDueState;
  /** A short human due label ("Overdue", "Due today", "in 3d", "Scheduled"). */
  readonly dueLabel: string;
  /** True only when this item is actionable in the due queue at the read clock. */
  readonly queueEligible: boolean;
  /** Human explanation when an item has scheduler history but is not in Queue. */
  readonly notInQueueReason: string | null;
  /** The element a `task` row protects, or `null` for non-task/unlinked rows. */
  readonly linkedElementId: string | null;
  /** The protected element's type, paired with `linkedElementId` for task routing. */
  readonly linkedElementType: string | null;
}

/**
 * DRILL-DOWN faceted counts for the filterbar. Each dimension's counts respect ALL
 * OTHER currently-active filters but NOT its own selected value, so the number next
 * to any facet value V equals the number of result rows you get if V is selected
 * together with the other active filters (the count always matches the visible
 * list — the fix for the reported chip/list mismatch). `all` is the count of the
 * RENDERED rows (= the returned `items` length, post-limit, before the optional title
 * narrow), so the top "N elements" label never exceeds the visible list at scale.
 */
export interface LibraryBrowseCounts {
  /** The rendered-row total: equals `items.length` (post-limit, pre-title-narrow). */
  readonly all: number;
  /** Per browsable type (one entry per {@link LibraryBrowseTypeSchema} value). */
  readonly byType: Readonly<Record<string, number>>;
  /** Per concept, keyed by concept element id (the drill-down concept-chip count). */
  readonly byConcept: Readonly<Record<string, number>>;
  /** Per priority band A/B/C/D. */
  readonly byPriority: Readonly<Record<string, number>>;
  /** Per lifecycle status. */
  readonly byStatus: Readonly<Record<string, number>>;
}

export interface LibraryBrowseResult {
  readonly items: readonly LibraryItem[];
  readonly counts: LibraryBrowseCounts;
}

/**
 * Commands for returning a parked source to work. All branches are ordinary
 * `update_element` mutations so Undo restores the full preimage (`status`,
 * `dueAt`, and `parkedAt`) without a parked-specific op type.
 */
export const LibraryParkedActionRequestSchema = z.object({
  id: ElementIdSchema,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("moveToInbox") }),
    z.object({ kind: z.literal("queueSoon") }),
    z.object({ kind: z.literal("dismiss") }),
  ]),
});
export type LibraryParkedActionRequest = z.infer<typeof LibraryParkedActionRequestSchema>;

export interface LibraryParkedActionResult {
  readonly item: LibraryItem | null;
}

// ---------------------------------------------------------------------------
// trash.list() / trash.restore() / trash.purge() / trash.empty()  (T044)
// ---------------------------------------------------------------------------

/**
 * The Trash surface (T044). Soft-delete already happens everywhere
 * (`soft_delete_element`); these commands READ the trashed rows and RESTORE or
 * PERMANENTLY delete them. The MAIN process runs the `TrashRepository`:
 *
 *  - `list`    → every soft-deleted element (newest-deleted first) with its type,
 *    owning-source title, deletion time, and the status it had BEFORE delete.
 *    Read-only.
 *  - `restore` → `ElementRepository.restore(id, originStatus)` brings it back to
 *    its prior lifecycle status with lineage intact; logs `restore_element`.
 *  - `purge`   → the ONLY hard `DELETE` in the app (FK cascades + the FTS5 trigger
 *    clean up dependents); appends no op (irreversible by design). UI-confirmed.
 *  - `empty`   → purge every trashed element in one transaction. UI-confirmed.
 *
 * There is still no generic `db.query`.
 */

/** A flat, JSON-serializable trash row for the Trash view. */
export interface TrashItemSummary {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  /** ISO-8601 deletion time. */
  readonly deletedAt: string;
  /** The status the element had BEFORE delete (what restore returns it to). */
  readonly originStatus: string;
  /** The owning source's title for the "from {source}" line, or `null`. */
  readonly sourceTitle: string | null;
  /**
   * The branch-delete `batchId` this row was soft-deleted under (T135 / U8), or `null`
   * for a single (non-branch) delete. Rows sharing a `batchId` were deleted as one branch;
   * the Trash view groups them under the branch root for one atomic `trash.restoreBatch`.
   */
  readonly deleteBatchId: string | null;
}

/** `trash.list()` takes no arguments. */
export const TrashListRequestSchema = z.void();

export interface TrashListResult {
  readonly items: readonly TrashItemSummary[];
}

export const TrashRestoreRequestSchema = z.object({
  /** The soft-deleted element id to restore. */
  id: ElementIdSchema,
});
export type TrashRestoreRequest = z.infer<typeof TrashRestoreRequestSchema>;

export interface TrashRestoreResult {
  /** The restored element summary, or `null` when the id is unknown. */
  readonly item: ElementSummary | null;
}

export const TrashRestoreBatchRequestSchema = z.object({
  /** The branch-delete `batchId` to restore as one unit (root-first). */
  batchId: z.string().min(1).max(128),
});
export type TrashRestoreBatchRequest = z.infer<typeof TrashRestoreBatchRequestSchema>;

export const TrashRestoreAncestorChainRequestSchema = z.object({
  /** The element whose DELETED-ancestor chain (up to the first live ancestor) to restore. */
  id: ElementIdSchema,
});
export type TrashRestoreAncestorChainRequest = z.infer<
  typeof TrashRestoreAncestorChainRequestSchema
>;

/**
 * The outcome of an ancestor-chain restore (T135). Restores ONLY the deleted chain
 * above (and including, when a tombstone) the focused element — never sibling or cousin
 * tombstones — so a live element reconnects to a live root without resurrecting
 * unrelated deletions.
 */
export interface TrashRestoreAncestorChainResult {
  /** The ids actually restored (root-first). */
  readonly restored: readonly string[];
  /**
   * The fresh `restore_element` batch id threaded through every restored op, so a
   * follow-up global undo reverses the whole chain restore as one unit; `null` when
   * nothing was restored (the focused node and its ancestors were already live).
   */
  readonly batchId: string | null;
}

/** Why a node was left a tombstone by a batch restore (the partial state, surfaced). */
export interface RestoreSkippedRow {
  readonly id: string;
  /**
   * `missing` (purged/never existed), `not-deleted` (already live), `newer-intent`
   * (re-deleted under another batch since), or `ancestor-skipped` (its branch root
   * stayed down, so it stays a tombstone — no orphan restore).
   */
  readonly reason: "missing" | "not-deleted" | "newer-intent" | "ancestor-skipped";
}

/**
 * The outcome of a batch restore (T135) — surfaces partial/broken chains rather
 * than silently restoring descendants under a still-tombstoned root.
 */
export interface TrashRestoreBatchResult {
  /** The ids actually restored by this call (root-first). */
  readonly restored: readonly string[];
  /** Nodes left as tombstones (with a reason) — the partial state, surfaced not hidden. */
  readonly skipped: readonly RestoreSkippedRow[];
  /** Whether the branch root itself was restored (false ⇒ the whole branch stayed down). */
  readonly rootRestored: boolean;
}

export const TrashPurgeRequestSchema = z.object({
  /** The soft-deleted element id to PERMANENTLY delete (UI-confirmed). */
  id: ElementIdSchema,
});
export type TrashPurgeRequest = z.infer<typeof TrashPurgeRequestSchema>;

/**
 * The purge outcome (T044 + T135). A purge that would null a LIVE element's lineage
 * links (the 0030-wipe mechanism) is BLOCKED at the local-db seam; rather than let
 * that surface as a raw IPC error, the main side catches it and returns a STRUCTURED
 * result so the renderer can tell "blocked by live descendants" (offer restore /
 * delete-branch recovery) apart from a genuine failure.
 */
export interface TrashPurgeResult {
  /** `1` when the element was hard-deleted, `0` when the id was unknown OR the purge was blocked. */
  readonly purged: number;
  /** `true` when the purge was refused because the tombstone still anchors live descendants. */
  readonly blocked: boolean;
  /** How many live descendants blocked the purge (`0` unless `blocked`). */
  readonly liveDependents: number;
}

/** `trash.empty()` takes no arguments (UI-confirmed before calling). */
export const TrashEmptyRequestSchema = z.void();

export interface TrashEmptyResult {
  /** How many elements were permanently deleted. */
  readonly purged: number;
  /**
   * How many trashed rows were SKIPPED because they still anchor live descendants
   * (the purge guard skips-and-reports rather than blocking the whole empty).
   */
  readonly skipped: number;
}

// ---------------------------------------------------------------------------
// undo.last()  (T044 — the general, command-level undo)
// ---------------------------------------------------------------------------

/**
 * The general command-level undo (T044) — distinct from the queue's removing-only
 * recipe undo (T030). It reverses the MOST-RECENT `operation_log` op from ANYWHERE
 * (reader, review, inspector, trash, bulk actions) by applying its inverse through
 * the existing repository write paths in the MAIN process (`UndoService.undoLast`).
 * It adds NO op type — the inverse is one of the closed 15 and is itself logged, so
 * the log stays append-only. Covered set = delete / mark-done / suspend /
 * bulk-postpone (`soft_delete_element` / `update_element` / `reschedule_element`,
 * plus `restore_element` for redo). A non-invertible last op returns
 * `{ undone: false }` and mutates nothing. There is still no generic `db.query`.
 */

/** `undo.last()` takes no arguments. */
export const UndoLastRequestSchema = z.void();

export interface UndoLastResult {
  /** Whether anything was undone (`false` when the last op is non-invertible). */
  readonly undone: boolean;
  /** The op type that was inverted (or the un-invertible last op's type), or `null`. */
  readonly opType: string | null;
  /** The element the undo concerned, or `null`. */
  readonly elementId: string | null;
  /** A human label for the snackbar ("Restored 'Spaced repetition'"), or `""`. */
  readonly label: string;
  /** Why nothing was undone, when `undone` is `false`. */
  readonly reason?: string;
  /** How many ops were reversed (>1 for a bulk batch). */
  readonly count: number;
}

// ---------------------------------------------------------------------------
// analytics.get()  (T045 — the system-wide learning-health snapshot)
// ---------------------------------------------------------------------------

/**
 * The Analytics surface (T045) — ONE read-only aggregation over the durable
 * tables (`review_logs` / `elements` / `review_states`) the Analytics screen
 * renders as `Metric`s + a `Spark`. The MAIN process runs
 * `AnalyticsService.computeAnalytics`:
 *
 *  - `reviewsByDay`  → reviews grouped by LOCAL calendar day over the window (the
 *    spark), one bucket per day (0-filled).
 *  - `retention30d`  → fraction of window reviews graded NOT-`again`
 *    (`hard`/`good`/`easy`), in `[0,1]`; `null` when there are no reviews.
 *  - `dueCards` / `dueTopics` → the two-scheduler split: FSRS cards vs attention
 *    items due at/before `asOf`.
 *  - `newCards` / `newExtracts` → created in the window (throughput).
 *  - `deletions` → soft-deleted in the window. `leeches` → live leech-flag count.
 *
 * Read-only: NO mutation, NO `operation_log`. There is still no generic
 * `db.query`. Source-yield (per-source) analytics + FSRS-true retrievability are
 * deferred to M17/T083.
 */

/**
 * `analytics.get({ asOf?, windowDays? })`. `asOf` defaults to "now" on the main
 * side; `windowDays` defaults to 30. Both optional so the screen can call it bare.
 */
export const AnalyticsGetRequestSchema = z
  .object({
    /** The instant to compute the snapshot for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
    /** Window length in calendar days (1–365); defaults to 30. */
    windowDays: z.number().int().min(1).max(365).optional(),
  })
  .optional();
export type AnalyticsGetRequest = z.infer<typeof AnalyticsGetRequestSchema>;

/** One calendar day's review count for the spark. `date` is `YYYY-MM-DD` (local). */
export interface AnalyticsReviewsByDay {
  readonly date: string;
  readonly count: number;
}

/**
 * `analytics.reviewActivity({ asOf?, year? })`. `asOf` defaults to "now" on
 * the main side; `year` defaults to the local calendar year of `asOf`.
 */
export const AnalyticsReviewActivityRequestSchema = z
  .object({
    /** The instant to anchor default year selection and local-day bucketing. */
    asOf: IsoTimestampInputSchema.optional(),
    /** Selected four-digit calendar year; defaults main-side from `asOf`. */
    year: z.number().int().min(1000).max(9998).optional(),
  })
  .optional();
export type AnalyticsReviewActivityRequest = z.infer<typeof AnalyticsReviewActivityRequestSchema>;

/** One local calendar day in the review-activity heatmap. */
export interface AnalyticsReviewActivityDay {
  readonly date: string;
  readonly count: number;
}

/** Calendar-year review activity for the Analytics heatmap. */
export interface AnalyticsReviewActivityResult {
  /** The instant the activity read was computed for (ISO-8601). */
  readonly asOf: string;
  /** The selected calendar year. */
  readonly year: number;
  /** Earliest calendar year with review history, or `null` when empty. */
  readonly minYear: number | null;
  /** Latest calendar year with review history, or `null` when empty. */
  readonly maxYear: number | null;
  /** Previous year with review history, skipping empty years; `null` when absent. */
  readonly previousYear: number | null;
  /** Next year with review history, skipping empty years; `null` when absent. */
  readonly nextYear: number | null;
  /** Zero-filled local calendar days for `year`, oldest first. */
  readonly days: readonly AnalyticsReviewActivityDay[];
  /** Total reviews in the selected calendar year. */
  readonly totalReviews: number;
}

/** The flat, JSON-serializable analytics snapshot the renderer reads. */
export interface AnalyticsGetResult {
  /** The instant the snapshot was computed for (ISO-8601). */
  readonly asOf: string;
  /** The window length in calendar days. */
  readonly windowDays: number;
  /** Reviews per local calendar day over the window, oldest day first. */
  readonly reviewsByDay: readonly AnalyticsReviewsByDay[];
  /** Total reviews graded in the window. */
  readonly reviewsTotal: number;
  /** Mean reviews per day over the window. */
  readonly reviewsPerDayAvg: number;
  /** Fraction of window reviews graded not-`again` (`[0,1]`), or `null` if none. */
  readonly retention30d: number | null;
  /** Cards due for FSRS review at/before `asOf`. */
  readonly dueCards: number;
  /** Sources/topics/extracts due for re-processing at/before `asOf`. */
  readonly dueTopics: number;
  /** `card` elements created in the window. */
  readonly newCards: number;
  /** `extract` elements created in the window. */
  readonly newExtracts: number;
  /** Elements soft-deleted in the window. */
  readonly deletions: number;
  /** Cards currently flagged a leech. */
  readonly leeches: number;
  /** Cards currently RETIRED (live) — out of active review, kept for reference (T082). */
  readonly retired: number;
  /** Consecutive days (ending today) with ≥1 review. */
  readonly dayStreak: number;
}

// ---------------------------------------------------------------------------
// balance.get()  (T046 — the import/process balance warning)
// ---------------------------------------------------------------------------

/**
 * The import/process balance surface (T046) — a read-only extension of the T045
 * aggregation that catches the "importing faster than processing" failure mode.
 * The MAIN process runs `AnalyticsService.computeBalance` (the SAME windowed
 * counting as analytics, just a 7-day window + the import-vs-output framing) and
 * the pure `@interleave/core` `judgeBalance` rule (tunable via the user's
 * `importBalanceFactor` setting). It returns the four weekly headline numbers —
 * sources imported / extracts created / cards created / reviews due this week —
 * plus current inbox / due-queue counts and the `imbalanced` / `severity`
 * judgment that drives the advisory `Banner`.
 *
 * ADVISORY only: it NEVER mutates a schedule (auto-postpone is M16/T077). Reusing
 * the analytics aggregation guarantees the inbox banner + the analytics view show
 * the SAME numbers. Read-only: NO mutation, NO `operation_log`, no generic
 * `db.query`.
 */
export const BalanceGetRequestSchema = z
  .object({
    /** The instant to compute the balance for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
    /** Window length in calendar days (1–365); defaults to 7. */
    windowDays: z.number().int().min(1).max(365).optional(),
  })
  .optional();
export type BalanceGetRequest = z.infer<typeof BalanceGetRequestSchema>;

/** Coarse imbalance severity: `ok` hides the banner, `warn`/`danger` show it. */
export type BalanceSeverity = "ok" | "warn" | "danger";

/** The flat, JSON-serializable balance snapshot the renderer reads. */
export interface BalanceGetResult {
  /** The instant the snapshot was computed for (ISO-8601). */
  readonly asOf: string;
  /** The window length in calendar days (default 7). */
  readonly windowDays: number;
  /** `source` elements imported (created) in the window. */
  readonly sourcesImported: number;
  /** `extract` elements created in the window. */
  readonly extractsCreated: number;
  /** `card` elements created in the window. */
  readonly cardsCreated: number;
  /** Cards due for FSRS review within the next `windowDays` days (forward-looking). */
  readonly reviewsDueThisWeek: number;
  /** Live source elements currently waiting in the inbox. */
  readonly inboxSources: number;
  /** Items that would appear in `/queue` at `asOf`: due cards + due attention items. */
  readonly dueQueueItems: number;
  /** True when imports outpace processing (`severity !== "ok"`). */
  readonly imbalanced: boolean;
  /** The severity bucket driving the banner variant. */
  readonly severity: BalanceSeverity;
}

// ---------------------------------------------------------------------------
// analytics.priorityIntegrity()  (T105 — priority-fidelity read model)
// ---------------------------------------------------------------------------

/**
 * Priority-integrity analytics (T105) — a read-only receipt over durable facts:
 * attention service from `reschedule_element` action ops, FSRS service from
 * `review_logs`, deferrals from existing postpone markers, and live priority
 * distribution from `elements`/`cards`. It computes per-band and per-topic
 * serviced-vs-deferred counts, cumulative postpone debt, and backend threshold
 * flags. NO mutation, NO `operation_log`, no generic `db.query`.
 */
export const PriorityIntegrityGetRequestSchema = z
  .object({
    /** The instant to compute the receipt for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
    /** Window length in calendar days (1–365); defaults to 30. */
    windowDays: z.number().int().min(1).max(365).optional(),
    /** Max postponed rows returned for the "sacrificed" list (1–50). */
    sacrificedLimit: z.number().int().min(1).max(50).optional(),
    /** Max topic/source anchors returned (1–50). */
    topicLimit: z.number().int().min(1).max(50).optional(),
  })
  .optional();
export type PriorityIntegrityGetRequest = z.infer<typeof PriorityIntegrityGetRequestSchema>;

export interface PriorityIntegrityBandSummary {
  readonly band: PriorityLabel;
  readonly attentionServiced: number;
  readonly fsrsServiced: number;
  readonly deferred: number;
  readonly totalEvents: number;
  readonly serviceRate: number | null;
  readonly deferRate: number | null;
  readonly postponeDebtDays: number;
  readonly liveCount: number;
  readonly liveShare: number;
}

export interface PriorityIntegrityTopicSummary {
  readonly anchorId: string;
  readonly title: string;
  readonly type: string;
  readonly band: PriorityLabel;
  readonly attentionServiced: number;
  readonly fsrsServiced: number;
  readonly deferred: number;
  readonly postponeDebtDays: number;
}

export interface PriorityIntegritySacrificedRow {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly band: PriorityLabel;
  readonly scheduler: "attention" | "fsrs";
  readonly postponeCount: number;
  readonly postponeDebtDays: number;
  readonly latestDeferredAt: string;
  readonly topicAnchorId: string | null;
  readonly topicTitle: string | null;
}

export interface PriorityIntegrityRestingTopic {
  readonly topicId: string;
  readonly title: string;
  readonly band: PriorityLabel;
  readonly fallowUntil: string;
  readonly fallowReason: string | null;
}

export interface PriorityIntegrityThresholdFlags {
  readonly aBandInflation: boolean;
  readonly aBandDeferredRecently: boolean;
  readonly postponeDebtHigh: boolean;
}

export interface PriorityIntegrityGetResult {
  readonly asOf: string;
  readonly windowDays: number;
  readonly priorityAttribution: "current";
  readonly bands: readonly PriorityIntegrityBandSummary[];
  readonly topics: readonly PriorityIntegrityTopicSummary[];
  readonly sacrificed: readonly PriorityIntegritySacrificedRow[];
  readonly resting: readonly PriorityIntegrityRestingTopic[];
  readonly thresholdFlags: PriorityIntegrityThresholdFlags;
}

// ---------------------------------------------------------------------------
// analytics.topicKnowledgeState()  (T108 — topic/concept maturity receipts)
// ---------------------------------------------------------------------------

/**
 * Topic knowledge-state analytics (T108) — a read-only receipt over durable facts:
 * live concept membership/topic subtrees, extract/card lineage, review logs, review
 * states, retention targets, and verification tasks. It computes the current
 * knowledge funnel, stability buckets, rolling retention snapshots, and deterministic
 * current graduation candidates. NO mutation, NO `operation_log`, no weekly-review
 * session creation (T110 owns that ritual).
 */
export const TopicKnowledgeStateGetRequestSchema = z
  .object({
    /** The instant to compute the receipt for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
    /** Rolling retention window in days (1–365); defaults to 90. */
    windowDays: z.number().int().min(1).max(365).optional(),
    /** Cap the subject count (1–200); defaults to 50. */
    limit: z.number().int().min(1).max(200).optional(),
    /** Optional subject filter; omit to include both concepts and topics. */
    subjectType: z.enum(["concept", "topic"]).optional(),
    /** Optional exact subject id filter. */
    subjectId: z.string().min(1).optional(),
    /** Optional trusted-side ordering; use needs_attention for weak-topic surfaces. */
    order: z.enum(["default", "needs_attention"]).optional(),
  })
  .optional();
export type TopicKnowledgeStateGetRequest = z.infer<typeof TopicKnowledgeStateGetRequestSchema>;

export type TopicKnowledgeStateSubjectType = "concept" | "topic";
export type TopicKnowledgeStateOrder = "default" | "needs_attention";
export type TopicKnowledgeGraduationStatus =
  | "insufficient_evidence"
  | "building"
  | "near_graduation"
  | "graduated"
  | "needs_attention";

export interface KnowledgeFunnel {
  readonly read: number;
  readonly extracted: number;
  readonly distilled: number;
  readonly carded: number;
  readonly mature: number;
  readonly extractedOfRead: number | null;
  readonly distilledOfExtracted: number | null;
  readonly cardedOfDistilled: number | null;
  readonly matureOfCarded: number | null;
}

export interface KnowledgeStabilityBuckets {
  readonly young: number;
  readonly maturing: number;
  readonly mature: number;
  readonly retired: number;
}

export interface KnowledgeRetentionSnapshot {
  readonly start: string;
  readonly end: string;
  readonly reviewCount: number;
  readonly measuredRetention: number | null;
}

export interface KnowledgeRetentionTrend {
  readonly windowDays: number;
  readonly reviewCount: number;
  readonly measuredRetention: number | null;
  readonly retentionTarget: number | null;
  readonly directConceptTarget: number | null;
  readonly deltaFromTarget: number | null;
  readonly snapshots: readonly KnowledgeRetentionSnapshot[];
}

export interface KnowledgeStaleness {
  readonly staleItems: number;
  readonly needsReverify: number;
}

export interface KnowledgeGraduationState {
  readonly status: TopicKnowledgeGraduationStatus;
  readonly reason: string;
  readonly thresholdVersion: "v1";
}

export interface TopicKnowledgeStateSubject {
  readonly subjectType: TopicKnowledgeStateSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly priority: number | null;
  readonly priorityLabel: PriorityLabel | null;
  readonly directMemberCount: number | null;
  readonly includedElementCount: number;
  readonly funnel: KnowledgeFunnel;
  readonly stability: KnowledgeStabilityBuckets;
  readonly retention: KnowledgeRetentionTrend;
  readonly staleness: KnowledgeStaleness;
  readonly graduationState: KnowledgeGraduationState;
}

export interface KnowledgeGraduationEvent {
  readonly eventId: string;
  readonly eventType: "current_graduated";
  readonly subjectType: TopicKnowledgeStateSubjectType;
  readonly subjectId: string;
  readonly title: string;
  readonly asOf: string;
  readonly thresholdVersion: "v1";
}

export interface TopicKnowledgeStateGetResult {
  readonly asOf: string;
  readonly windowDays: number;
  readonly subjects: readonly TopicKnowledgeStateSubject[];
  readonly graduationEvents: readonly KnowledgeGraduationEvent[];
}

// ---------------------------------------------------------------------------
// dailyWork.summary()  (T101 — daily workflow routing)
// ---------------------------------------------------------------------------

/**
 * The daily workflow read model: one main-side answer for whether the primary
 * action should process due scheduled work, triage fresh imports, resume an
 * active unscheduled source, or show a true clear state. It composes the same
 * queue/inbox predicates the due queue uses; the renderer must not duplicate
 * those scheduler rules.
 */
export const DailyWorkSummaryRequestSchema = z
  .object({
    /** The instant to compute the due queue for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
  })
  .optional();
export type DailyWorkSummaryRequest = z.infer<typeof DailyWorkSummaryRequestSchema>;

export type DailyWorkRecommendedAction =
  | "process_due_queue"
  | "triage_inbox"
  | "resume_unscheduled_source"
  | "clear";

export interface DailyWorkResumeSource {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly priorityLabel: "A" | "B" | "C" | "D";
  readonly status: string;
  readonly stage: string;
  readonly updatedAt: string;
  readonly unresolvedBlocks: number | null;
}

export interface DailyWorkSummaryResult {
  readonly asOf: string;
  readonly dueQueueItems: number;
  readonly inboxSources: number;
  readonly activeUnscheduledSources: number;
  readonly resumeSource: DailyWorkResumeSource | null;
  readonly recommendedAction: DailyWorkRecommendedAction;
  readonly graduationEvents: readonly KnowledgeGraduationEvent[];
}

export const DailyWorkGraduationAckRequestSchema = z
  .object({
    /** The instant to observe current maturity state for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
    /** Graduation event ids that were rendered by the daily summary. */
    eventIds: z.array(z.string().min(1)).optional(),
  })
  .optional();
export type DailyWorkGraduationAckRequest = z.infer<typeof DailyWorkGraduationAckRequestSchema>;

export interface DailyWorkGraduationAckResult {
  readonly asOf: string;
  readonly acknowledgedEventIds: readonly string[];
  readonly observedSubjectCount: number;
}

// ---------------------------------------------------------------------------
// weeklyReview.*  (T110 — weekly ledger & integrity session)
// ---------------------------------------------------------------------------

export const WeeklyReviewSummaryRequestSchema = z
  .object({
    /** The instant to compute the weekly session for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
  })
  .optional();
export type WeeklyReviewSummaryRequest = z.infer<typeof WeeklyReviewSummaryRequestSchema>;

export const WeeklyReviewSectionStateSchema = z.enum(["pending", "done", "skipped"]);
export type WeeklyReviewSectionState = z.infer<typeof WeeklyReviewSectionStateSchema>;
export type WeeklyReviewSectionId = "ledger" | "integrity" | "parked" | "chronic" | "fallow";

export const WeeklyReviewProgressPatchSchema = z.object({
  taskId: ElementIdSchema,
  sections: z
    .object({
      ledger: WeeklyReviewSectionStateSchema,
      integrity: WeeklyReviewSectionStateSchema,
      parked: WeeklyReviewSectionStateSchema,
      chronic: WeeklyReviewSectionStateSchema,
      fallow: WeeklyReviewSectionStateSchema,
    })
    .partial()
    .strict(),
});
export type WeeklyReviewProgressPatch = z.infer<typeof WeeklyReviewProgressPatchSchema>;

export interface WeeklyReviewProgress {
  readonly taskId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly sections: Readonly<Record<WeeklyReviewSectionId, WeeklyReviewSectionState>>;
}

export interface WeeklyReviewWindow {
  readonly start: string;
  readonly end: string;
  readonly days: number;
}

export interface WeeklyReviewPriorityMiss {
  readonly band: PriorityLabel;
  readonly deferred: number;
  readonly postponeDebtDays: number;
}

export interface WeeklyReviewLedger {
  readonly sources: number;
  readonly extracts: number;
  readonly cards: number;
  readonly maturedCards: number;
  readonly priorityMisses: readonly WeeklyReviewPriorityMiss[];
}

export interface WeeklyReviewFallowSuggestion {
  readonly topicId: string;
  readonly title: string;
  readonly band: PriorityLabel;
  readonly deferred: number;
  readonly postponeDebtDays: number;
}

export interface WeeklyReviewSummaryResult {
  readonly asOf: string;
  readonly enabled: boolean;
  readonly cadenceDays: number;
  readonly session: TaskSummary | null;
  readonly due: boolean;
  readonly window: WeeklyReviewWindow;
  readonly progress: WeeklyReviewProgress | null;
  readonly ledger: WeeklyReviewLedger;
  readonly integrity: PriorityIntegrityGetResult;
  readonly decisions: {
    readonly parked: MaintenanceParkedResurfacingResult;
    readonly chronic: MaintenanceChronicPostponesResult;
    readonly fallowSuggestions: readonly WeeklyReviewFallowSuggestion[];
  };
}

export const WeeklyReviewCompleteRequestSchema = z.object({
  taskId: ElementIdSchema,
  asOf: IsoTimestampInputSchema.optional(),
});
export type WeeklyReviewCompleteRequest = z.infer<typeof WeeklyReviewCompleteRequestSchema>;

export const WeeklyReviewDismissRequestSchema = z.object({
  taskId: ElementIdSchema,
  asOf: IsoTimestampInputSchema.optional(),
  snoozeDays: z.number().int().min(1).max(WEEKLY_REVIEW_CADENCE_DAYS_MAX).optional(),
});
export type WeeklyReviewDismissRequest = z.infer<typeof WeeklyReviewDismissRequestSchema>;

export interface WeeklyReviewLifecycleResult {
  readonly task: TaskSummary | null;
  readonly progress: WeeklyReviewProgress | null;
}

// ---------------------------------------------------------------------------
// sourceYield.list()  (T083 — per-source yield analytics)
// ---------------------------------------------------------------------------

/**
 * The per-source yield surface (T083) — a READ-ONLY ranked rollup that answers
 * "which sources are not paying their way?". The MAIN process runs
 * `SourceYieldQuery.listSourceYield`, which for every live `source` computes its
 * read % (`read_points` vs `document_blocks`), extracts/cards/mature-cards created
 * (via the persisted `sourceId` lineage), leeches (`cards.is_leech`), review time
 * (`SUM(review_logs.responseMs)`), and a derived `yieldScore`/`yieldBand` (the pure
 * `@interleave/core` `scoreSourceYield` rule). Rows come back sorted **lowest-yield
 * first** so the ranked view can lead with the sources to abandon.
 *
 * The FSRS-vs-attention split stays labeled: the source is an attention item; its
 * leeches/mature-cards are its FSRS-card outputs. Read-only: NO mutation, NO
 * `operation_log`, no schedule change, no generic `db.query`. Reading time is NOT
 * tracked — `timeSpentMs` is REVIEW time on the source's cards.
 */
export const SourceYieldListRequestSchema = z
  .object({
    /** The instant to compute the snapshot for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
    /** Cap the row count (1–1000); defaults to 200. */
    limit: z.number().int().min(1).max(1000).optional(),
    /** Skip the first `offset` rows (after the lowest-yield sort). */
    offset: z.number().int().min(0).optional(),
  })
  .optional();
export type SourceYieldListRequest = z.infer<typeof SourceYieldListRequestSchema>;

/** Coarse yield band: `neutral` = un-started (never flagged); the rest rank a worked source. */
export type YieldBand = "high" | "medium" | "low" | "neutral";

/** The flat source descriptor embedded in each yield row. */
export interface SourceYieldSourceRef {
  readonly id: string;
  readonly title: string;
  readonly priority: number;
  readonly priorityLabel: "A" | "B" | "C" | "D";
  readonly createdAt: string;
  readonly url: string | null;
}

/** One source's complete yield rollup (flat, JSON-serializable). */
export interface SourceYieldRow {
  readonly source: SourceYieldSourceRef;
  /** How far the source has been read, in `[0, 1]`. */
  readonly readPct: number;
  readonly extractsCreated: number;
  /** Live fated/reference extracts plus synthesis-referenced extracts, de-duplicated. */
  readonly productiveExtracts: number;
  /** Live fated extracts with `extract_fate = 'reference'`. */
  readonly referenceExtracts: number;
  /** Live fated extracts with `extract_fate = 'synthesized'`. */
  readonly synthesizedExtracts: number;
  /** Live fated extracts with `extract_fate = 'done_without_card'`. */
  readonly doneWithoutCardExtracts: number;
  /** Live extract targets referenced by live synthesis notes. */
  readonly synthesisReferencedExtracts: number;
  /** Live synthesis notes that reference material from this source. */
  readonly synthesisNotesCreated: number;
  readonly cardsCreated: number;
  readonly matureCards: number;
  readonly leeches: number;
  /** Summed review response time on the source's cards (ms) — review time, not reading. */
  readonly timeSpentMs: number;
  readonly reviewCount: number;
  readonly processedBlockRatio: number;
  readonly ignoredBlockRatio: number;
  readonly unresolvedBlocks: number;
  readonly extractedOutputCount: number;
  readonly lastActivityAt: string | null;
  readonly yieldScore: number;
  readonly yieldBand: YieldBand;
}

/** The flat, JSON-serializable source-yield snapshot the renderer reads. */
export interface SourceYieldListResult {
  /** The instant the snapshot was computed for (ISO-8601). */
  readonly asOf: string;
  /** The rows, sorted by `yieldScore` ASCENDING (lowest-yield first). */
  readonly rows: readonly SourceYieldRow[];
  /** How many rows are in the `low` band. */
  readonly lowYieldCount: number;
}

// ---------------------------------------------------------------------------
// extractStagnation.list()  (T084 — extract-stagnation analytics)
// ---------------------------------------------------------------------------

/**
 * The extract-stagnation surface (T084) — a READ-ONLY scan that answers "which
 * extracts keep coming back without ever turning into anything?". The MAIN process
 * runs `ExtractStagnationQuery.listStagnantExtracts`, which for every live `extract`
 * reads the charter's attention-scheduler signals (stage / child count / op-log
 * postpone markers + last stage advance), runs the PURE `@interleave/scheduler`
 * `isStagnant` heuristic (the attention mirror of `isLeech`), and returns ONLY the
 * stagnant rows (most-stagnant first) with their `reasons` + a recommended
 * `suggestion` (rewrite / convert / postpone / delete).
 *
 * Read-only: NO mutation, NO `operation_log`, no schedule change, no generic
 * `db.query`. The suggestion is a LABEL; the actual remediations reuse the existing
 * transactional `extracts:*` (+ extract→card) commands. Stagnation is an ATTENTION
 * concern computed from stage/children/postpones — NEVER from FSRS `lapses`; an
 * extract is NEVER called a "leech".
 */
export const ExtractStagnationListRequestSchema = z
  .object({
    /** The instant to compute the scan for (ISO-8601); defaults to now. */
    asOf: IsoTimestampInputSchema.optional(),
    /** Cap the row count (1–1000); defaults to 200. */
    limit: z.number().int().min(1).max(1000).optional(),
    /** Skip the first `offset` rows (after the most-stagnant-first sort). */
    offset: z.number().int().min(0).optional(),
  })
  .optional();
export type ExtractStagnationListRequest = z.infer<typeof ExtractStagnationListRequestSchema>;

/** A reason the stagnation predicate fired (the maintenance view's calm chips). */
export type StagnationReason = "postponed-repeatedly" | "no-progress" | "no-children" | "stale";

/** The recommended remediation — each maps to an EXISTING `extracts:*` / extract→card command. */
export type StagnationSuggestion =
  | "rewrite"
  | "convert"
  | "postpone"
  | "delete"
  | "keep_as_reference"
  | "mark_synthesized";

/** A small extract descriptor embedded in each stagnant row (flat, JSON-serializable). */
export interface StagnantExtractRef {
  readonly id: string;
  readonly title: string;
  readonly stage: string;
  readonly priority: number;
  /** The attention `due_at` (ISO-8601), or `null`. Extracts are attention items. */
  readonly dueAt: string | null;
  /** Extract-only honorable terminal fate; `null` when no fate is set. */
  readonly extractFate?: ExtractFate | null;
  readonly createdAt: string;
}

/** One stagnant extract + why it stalled + the recommended remediation (flat). */
export interface StagnantExtractRow {
  readonly extract: StagnantExtractRef;
  readonly postponeCount: number;
  readonly childCount: number;
  readonly synthesizedReferenceCount?: number;
  /** Whole days since the last stage advance (or `createdAt`). */
  readonly daysSinceProgress: number;
  readonly reasons: readonly StagnationReason[];
  readonly suggestion: StagnationSuggestion;
}

/** The flat, JSON-serializable extract-stagnation snapshot the renderer reads. */
export interface ExtractStagnationListResult {
  /** The instant the scan was computed for (ISO-8601). */
  readonly asOf: string;
  /** The stagnant rows, sorted most-stagnant first. */
  readonly rows: readonly StagnantExtractRow[];
  /** How many extracts are stagnant (`rows.length`). */
  readonly stagnantCount: number;
}

// ---------------------------------------------------------------------------
// backups.*  (T047/T055 — Electron-managed backup lifecycle)
// ---------------------------------------------------------------------------

/**
 * The backup surface (T047). The renderer triggers a backup of the ENTIRE local
 * knowledge base — the canonical native SQLite database (`app.sqlite`,
 * snapshotted consistently via SQLite's `VACUUM INTO`) plus the
 * filesystem asset vault (`assets/`) — and the MAIN process packages it into a
 * versioned, hashed, deterministic ZIP under `backups/<timestamp>/` + a sibling
 * `<timestamp>.zip`. The backup is a COPY of the canonical store, never a JSON
 * re-serialization. The `manifest.json` is the restore contract (format version,
 * schema-migration tag, app version, ISO timestamp, per-file SHA-256 integrity
 * hashes, element/asset counts), so restore can verify the archive and reject one
 * that is too new or corrupt. The renderer never sees an absolute filesystem path
 * or touches the vault — `backups.create` returns only renderer-safe artifact
 * metadata, and there is no generic `db.query`.
 */

/** `backups.create()` takes no arguments. */
export const BackupsCreateRequestSchema = z.void();

export interface BackupsCreateResult {
  /** The filesystem-safe timestamp used for the backup directory/archive name. */
  readonly timestamp: string;
  /** Display-only archive filename, never an absolute filesystem path. */
  readonly archiveName: string;
  /** Total size of the `.zip` archive in bytes. */
  readonly sizeBytes: number;
  /** Number of files captured in the archive (`app.sqlite` + every asset). */
  readonly fileCount: number;
  /** The schema version captured — the latest applied Drizzle migration tag. */
  readonly schemaVersion: string;
}

/** `backups.openFolder()` takes no arguments. */
export const BackupsOpenFolderRequestSchema = z.void();

export interface BackupsOpenFolderResult {
  /** Confirms Electron accepted the fixed open-backups-folder request. */
  readonly ok: true;
}

/**
 * Backup identifiers are app-managed directory/archive names, never renderer-
 * supplied paths. Accept manual timestamps, automatic `auto-` timestamps, and
 * BackupService's numeric collision suffix.
 */
export const BackupTimestampSchema = z
  .string()
  .regex(
    /^(?:auto-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/,
    "Expected an app-managed backup timestamp",
  );

/** `backups.list()` takes no arguments. */
export const BackupsListRequestSchema = z.void();

/** One renderer-safe app-managed backup artifact. No raw paths are exposed. */
export interface BackupArtifact {
  readonly timestamp: string;
  /** ISO-8601 creation time from the manifest/timestamp. */
  readonly createdAt: string;
  /** Size of the zip + retained backup directory bytes. */
  readonly sizeBytes: number;
  /** Number of captured files (`app.sqlite` + assets), from the manifest. */
  readonly fileCount: number;
  /** The captured schema version (latest applied Drizzle migration tag). */
  readonly schemaVersion: string;
  /** Whether the artifact was created by the automatic rolling-backup scheduler. */
  readonly automatic: boolean;
}

export interface BackupsListResult {
  readonly backups: readonly BackupArtifact[];
}

export const RESTORE_BACKUP_CONFIRMATION_PHRASE = "RESTORE BACKUP" as const;
export const RESET_LOCAL_DATA_CONFIRMATION_PHRASE = "START FROM SCRATCH" as const;

export const BackupsRestoreRequestSchema = z
  .object({
    timestamp: BackupTimestampSchema,
    confirm: z.literal(true),
    phrase: z.literal(RESTORE_BACKUP_CONFIRMATION_PHRASE),
  })
  .strict();
export type BackupsRestoreRequest = z.infer<typeof BackupsRestoreRequestSchema>;

export interface BackupsRestoreResult {
  readonly status: "restored";
  readonly timestamp: string;
  readonly restoredAt: string;
  /** The renderer should reload/restart after high-risk data replacement. */
  readonly reloadRequired: true;
}

/**
 * What `backups.pickArchive()` returns — ONLY the absolute path the user chose in
 * the main-owned native open-file dialog, or `{ cancelled: true }`. This is the one
 * narrow place a backup `.zip` path crosses into the renderer, and it originates
 * from a main-owned picker (same trust model as the import pickers), never a generic
 * filesystem read. The chosen path is then handed straight back to
 * `backups.restoreFile` for extract → verify → install.
 */
export type BackupsPickArchiveResult = { readonly path: string } | { readonly cancelled: true };

/**
 * `backups.restoreFile()` restores an arbitrary backup `.zip` on disk (one the app
 * does not manage). `path` is the archive chosen via `backups.pickArchive`; guarded
 * by `confirm: true` and the SAME `RESTORE BACKUP` phrase as the timestamp restore.
 * Main re-validates the request and the archive — this is a narrow extract + verify
 * + install capability, not a generic file-read surface.
 */
export const BackupsRestoreFileRequestSchema = z
  .object({
    path: z.string().min(1),
    confirm: z.literal(true),
    phrase: z.literal(RESTORE_BACKUP_CONFIRMATION_PHRASE),
  })
  .strict();
export type BackupsRestoreFileRequest = z.infer<typeof BackupsRestoreFileRequestSchema>;

export const BackupsResetLocalDataRequestSchema = z
  .object({
    confirm: z.literal(true),
    phrase: z.literal(RESET_LOCAL_DATA_CONFIRMATION_PHRASE),
  })
  .strict();
export type BackupsResetLocalDataRequest = z.infer<typeof BackupsResetLocalDataRequestSchema>;

export interface BackupsResetLocalDataResult {
  readonly status: "reset";
  readonly resetAt: string;
  /** The renderer should reload/restart after high-risk data replacement. */
  readonly reloadRequired: true;
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
    /**
     * Count an element's LIVE descendants (T135) broken down by kind — the
     * blast-radius inventory the delete intent menu reads. `total === 0` ⇒ quiet
     * delete; otherwise the menu opens and quantifies the cost. Read-only.
     */
    countDescendants(
      request: ElementsCountDescendantsRequest,
    ): Promise<ElementsCountDescendantsResult>;
    /**
     * Soft-delete a node and OPTIONALLY its live subtree (T135) in one transaction
     * under a shared `batchId`, recoverable as a unit. `includeSubtree: false`
     * tombstones only the node (keep-descendants); `true` soft-cascades the branch.
     * Preimage-aware so restore re-establishes each node's schedule exactly.
     */
    softDeleteSubtree(
      request: ElementsSoftDeleteSubtreeRequest,
    ): Promise<ElementsSoftDeleteSubtreeResult>;
  };
  readonly topics: {
    /** Deliberately rest a topic and eligible attention descendants until a return date. */
    fallow(request: TopicFallowRequest): Promise<TopicFallowResult>;
    /** Manually return a fallowed topic, restoring schedules still owned by its fallow batch. */
    unfallow(request: TopicUnfallowRequest): Promise<TopicFallowResult>;
  };
  readonly queue: {
    /**
     * The unified, sorted, filtered due queue (T029) — due cards (FSRS) AND due
     * attention items, sorted priority-then-due-date, with type/concept/status
     * filters + per-type counts + the budget gauge. Read-only.
     */
    list(request?: QueueListRequest): Promise<QueueListResult>;
    /**
     * Apply one in-place queue action (T030) — postpone / raise / lower / done /
     * dismiss / delete — without leaving the list. One transaction + the correct
     * existing op; attention items postpone on the attention scheduler, cards defer
     * on FSRS; delete is soft + undoable.
     */
    act(request: QueueActRequest): Promise<QueueActResult>;
    /**
     * Schedule a non-card attention item for an EXPLICIT return (T028) — tomorrow /
     * next week / next month / a manual date — through the attention-scheduler apply
     * seam (`reschedule_element`, status → `scheduled`). Cards are rejected (FSRS
     * schedules cards). One transaction + the existing op; no new op type.
     */
    schedule(request: QueueScheduleRequest): Promise<QueueScheduleResult>;
    /**
     * Undo a removing queue action (T030) — restore a soft-deleted row or re-set the
     * prior status (done/dismiss). One transaction + the correct existing op.
     */
    undo(request: QueueUndoRequest): Promise<QueueUndoResult>;
    /**
     * Preview the overload AUTO-POSTPONE (T077) — READ-ONLY. Returns what would move
     * (low-priority topics first, then low-priority mature cards), from→to + why, so the
     * user sees the cost before committing. No mutation, no op.
     */
    autoPostpone(request?: QueueAutoPostponeRequest): Promise<AutoPostponePreview>;
    /**
     * Apply the overload AUTO-POSTPONE (T077) — transactional. Postpones the planned items
     * (attention items on the attention scheduler; cards via an FSRS defer that leaves
     * memory state untouched + writes no review log), all under ONE `batchId` so the sweep
     * undoes as one. Returns the count + the batch id.
     */
    autoPostponeApply(request?: QueueAutoPostponeRequest): Promise<AutoPostponeApplyResult>;
    /**
     * Preview the CATCH-UP plan (T078) — READ-ONLY. Spreads the overdue backlog forward over
     * `spreadDays` so each day ≤ budget (high-value/fragile first), and returns the COST (the
     * per-day load curve before vs after + the slips) so the user sees it before committing.
     */
    catchUp(request?: QueueCatchUpRequest): Promise<CatchUpPreview>;
    /**
     * Apply the CATCH-UP plan (T078) — transactional. Reschedules attention items + defers cards
     * to their EXACT planned days (memory state untouched, no review log), all under ONE
     * `batchId` so the plan undoes as one. Returns the count + the batch id.
     */
    catchUpApply(request?: QueueCatchUpRequest): Promise<RecoveryApplyResult>;
    /**
     * Preview the VACATION plan (T078) — READ-ONLY. Finds what would come due in the away window,
     * chooses suspend (fragile cards) vs shift-past-return (the rest), and returns the COST (the
     * after-return load curve + slips) so the user sees it before committing.
     */
    vacation(request: QueueVacationRequest): Promise<VacationPreview>;
    /**
     * Apply the VACATION plan (T078) — transactional. Suspends fragile cards (prior status
     * captured) + shifts the rest past return, all under ONE `batchId` so the plan undoes (and
     * vacation resumes) as one. Returns the moved + suspended counts + the batch id.
     */
    vacationApply(request: QueueVacationRequest): Promise<RecoveryApplyResult>;
  };
  readonly lineage: {
    /** The full, depth-tagged lineage tree for one element (read-only) (T023). */
    get(request: LineageGetRequest): Promise<LineageGetResult>;
  };
  readonly sources: {
    /** Create a source in the `inbox` (T012; body lands with T013). */
    importManual(request: SourcesImportManualRequest): Promise<SourcesImportManualResult>;
    /** Edit a source's reliability metadata — type/tier/confidence/notes (T091). */
    updateReliability(
      request: SourcesUpdateReliabilityRequest,
    ): Promise<SourcesUpdateReliabilityResult>;
    /** Fetch + clean + snapshot a live URL into an `inbox` source (T060). */
    importUrl(request: SourcesImportUrlRequest): Promise<SourcesImportUrlResult>;
    /**
     * Import a local `.pdf` into an `inbox` source (T064) — opens a MAIN file
     * picker, streams the original into the vault, parses per-page text, and
     * creates a paginated source. `"cancelled"` when the picker is dismissed.
     */
    importPdf(request: SourcesImportPdfRequest): Promise<SourcesImportPdfResult>;
    /** Serve a PDF source's original bytes to the renderer for rendering (T064). */
    getPdfData(request: SourcesGetPdfDataRequest): Promise<SourcesGetPdfDataResult>;
    /**
     * Open a native file picker for an import `kind` (T067) — the SHARED picker for
     * all M14 file imports; returns the chosen path(s) or a cancellation. MAIN reads
     * the bytes (the renderer never receives a `File`).
     */
    pickImportFile(request: PickImportFileRequest): Promise<PickImportFileResult>;
    /**
     * Import a local `.epub` into an `inbox` book `source` + chapter `topic`s (T067) —
     * MAIN reads + validates the bytes, streams `original.epub` into the vault, and
     * creates the book→chapter lineage tree in one transaction.
     */
    importEpub(request: SourcesImportEpubRequest): Promise<SourcesImportEpubResult>;
    /**
     * Import a LOCAL media file into an `inbox` source (T073) — the renderer passes a
     * path chosen via {@link pickImportFile} (kind `media`) + an optional `subtitles`
     * sidecar path; MAIN reads + validates the bytes, streams `original.<ext>` into the
     * vault, parses the (optional) transcript, and creates the source in one transaction.
     */
    importMedia(request: SourcesImportMediaRequest): Promise<SourcesImportMediaResult>;
    /**
     * Serve a media source's playable data to the renderer (T073) — `media://` URL +
     * mime/duration for a LOCAL source, or the YouTube video id for a YOUTUBE source.
     */
    getMediaData(request: SourcesGetMediaDataRequest): Promise<SourcesGetMediaDataResult>;
    /**
     * Import a local `.md`/`.html` file into an `inbox` source (T068) — MAIN reads +
     * parses the bytes (Markdown via `markdown-it`, HTML via sanitize+HTML→PM) and
     * creates the source in one transaction. The body never crosses the bridge.
     */
    importDocument(request: SourcesImportDocumentRequest): Promise<SourcesImportDocumentResult>;
    /** Import PASTED Markdown text into an `inbox` source (T068) — no file read. */
    importMarkdownText(
      request: SourcesImportMarkdownTextRequest,
    ): Promise<SourcesImportDocumentResult>;
    /**
     * Import a Readwise/Kindle highlight export into inbox `extract`s grouped under one
     * `source` per book/article (T069) — MAIN reads + parses the file (auto-detecting
     * the format) and authors extracts (NEVER cards), one transaction per source.
     */
    importHighlights(
      request: SourcesImportHighlightsRequest,
    ): Promise<SourcesImportHighlightsResult>;
    /**
     * Crop a PDF page region into a scheduled `media_fragment` extract (T065) —
     * the renderer ships the cropped PNG + the normalized rect + page; MAIN streams
     * the bytes into the vault and creates the region extract + its page+region
     * source location in one transaction.
     */
    extractRegion(request: SourcesExtractRegionRequest): Promise<SourcesExtractRegionResult>;
    /** Serve a region extract's cropped image bytes to the renderer (T065). */
    getRegionImage(request: SourcesGetRegionImageRequest): Promise<SourcesGetRegionImageResult>;
    /**
     * Clip a media span into a scheduled `media_fragment` (T074) — the renderer ships
     * only the `{ startMs, endMs }` + the source id + the anchor block id + the
     * (optional) transcript segment; MAIN creates the fragment + its clip source
     * location in one transaction. NO re-encoding — the clip references the original.
     */
    extractClip(request: SourcesExtractClipRequest): Promise<SourcesExtractClipResult>;
    /**
     * Run OCR on one scanned/text-free PDF page (T066) — the renderer ships the
     * rendered page PNG; MAIN writes it to the vault + enqueues an `ocr` job on the
     * T058 runner (DB-free `tesseract.js` worker, offline). Observe via `jobs.subscribe`.
     */
    runOcr(request: SourcesRunOcrRequest): Promise<SourcesRunOcrResult>;
    /** Read a PDF source's OCR suggestion layer — per-page text + confidence (T066). */
    getOcr(request: SourcesGetOcrRequest): Promise<SourcesGetOcrResult>;
    /**
     * Accept a page's OCR text into the body (T066) — merges it via `documents.save`
     * (logs `update_document`); sets the `ocr_pages` row `accepted`. Never auto-merged.
     */
    acceptOcr(request: SourcesAcceptOcrRequest): Promise<SourcesAcceptOcrResult>;
    /** Dismiss a page's OCR suggestion (T066) — sets `dismissed`. */
    dismissOcr(request: SourcesAcceptOcrRequest): Promise<{ dismissed: boolean }>;
    /** Hide the current source-retirement suggestion until its signal changes (T103). */
    dismissRetirementSuggestion(
      request: SourcesDismissRetirementSuggestionRequest,
    ): Promise<SourcesDismissRetirementSuggestionResult>;
    /**
     * Receive a narrow main → renderer source-open request. The paired browser
     * extension can ask main to focus a captured source; the renderer receives only
     * the source id and performs normal `/source/$id` navigation. No generic route
     * listener or raw IPC event is exposed.
     */
    onOpenReader(callback: (sourceId: string) => void): () => void;
  };
  readonly ai: {
    /**
     * Run an AI formulation action over a selected span (T093) — enqueues an `ai` job
     * on the T058 runner (a local model OR the user's own-key call). DRAFTS ONLY: the
     * result is an inert `ai_suggestions` row, never a scheduled card. Throws
     * `AiDisabledError` when AI is off. Observe progress via `jobs.subscribe`.
     */
    run(request: AiRunRequest): Promise<AiRunResult>;
    /** The draft suggestions for an element + each one's resolved grounding (T093/T094). */
    list(request: AiListRequest): Promise<AiListResult>;
    /**
     * Approve a card-shaped suggestion (T093) → mint a PARKED, un-due `card_draft` via
     * the draft-only `CardService` seam (NOT activated, NOT first-scheduled, NOT in the
     * FSRS deck). The grounding is inherited as a real `source_locations` row.
     */
    approveCard(request: AiApproveRequest): Promise<AiApproveResult>;
    /** Dismiss a draft suggestion (T093) — soft (status → `dismissed`). */
    dismiss(request: AiDismissRequest): Promise<AiDismissResult>;
    /** The disabled-state + disclosure data (T093) — NO key (only `keyConfigured`). */
    status(): Promise<AiStatusResult>;
    /** Download / warm the local AI model (T093) — flips `aiModelDownloaded`. */
    downloadModel(): Promise<AiDownloadModelResult>;
  };
  readonly capture: {
    /** Read the browser-capture pairing state (token + enabled/running/port) (T062). */
    getPairing(): Promise<CapturePairingResult>;
    /** Mint a fresh pairing token — UNPAIRS the current extension (T062). */
    regenerateToken(): Promise<CaptureRegenerateTokenResult>;
    /** Enable/disable the loopback capture server (starts/stops it live) (T062). */
    setEnabled(request: CaptureSetEnabledRequest): Promise<CaptureSetEnabledResult>;
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
    /**
     * Export an element's document body to a `.md` in Downloads (T068). Read-only on
     * the DB (no mutation, no op-log entry); returns display-safe file metadata.
     */
    exportMarkdown(request: DocumentsExportMarkdownRequest): Promise<DocumentsExportMarkdownResult>;
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
  readonly blockProcessing: {
    /** List every source block with its durable/derived processing outcome. */
    list(request: BlockProcessingSourceRequest): Promise<BlockProcessingListResult>;
    /** Read source progress/yield counters derived from block outcomes. */
    summary(request: BlockProcessingSourceRequest): Promise<BlockProcessingSummaryResult>;
    /** Mark a source block ignored; terminal for source completion. */
    markIgnored(request: BlockProcessingMarkBlockRequest): Promise<BlockProcessingMarkBlockResult>;
    /** Mark a source block processed without creating an extract/card. */
    markProcessed(
      request: BlockProcessingMarkBlockRequest,
    ): Promise<BlockProcessingMarkBlockResult>;
    /** Keep a source block unresolved but explicitly scheduled for later attention. */
    markNeedsLater(
      request: BlockProcessingMarkBlockRequest,
    ): Promise<BlockProcessingMarkBlockResult>;
    /** Restore a block to explicit unread, overriding read-point-derived read state. */
    markUnread(request: BlockProcessingMarkBlockRequest): Promise<BlockProcessingMarkBlockResult>;
  };
  readonly extractions: {
    /**
     * Lift selected source text into a new independent, attention-scheduled
     * `extract` element + its lineage, in one transaction (T021). Marks the parent
     * `extracted_span`; never creates an FSRS `review_states` row.
     */
    create(request: ExtractionCreateRequest): Promise<ExtractionCreateResult>;
  };
  readonly cards: {
    /**
     * Author a `card` (Q&A or cloze) from an extract (T032), in one transaction:
     * the card element (`card_draft`) + its `cards` row + an UN-DUE `review_states`
     * row + inherited priority/tags + a `sibling_group` edge. Logs `create_card` (+
     * `add_tag`/`add_relation`); does NO FSRS math (M7 first-schedules it).
     */
    create(request: CardsCreateRequest): Promise<CardsCreateResult>;
    /**
     * Generate N sibling `image_occlusion` cards (T071) from a `media_fragment`
     * image extract + the drawn masks, in one transaction: one card per mask, all
     * in one `sibling_group`. Masks are stored SEPARATELY (the `occlusion_masks`
     * table); the base image bytes (already in the vault) are NOT sent. Logs
     * `create_card` ×N (+ `add_tag`/`add_relation`); does NO FSRS math (M7 schedules).
     */
    generateOcclusion(
      request: CardsGenerateOcclusionRequest,
    ): Promise<CardsGenerateOcclusionResult>;
    /**
     * Edit a card's body (T038) — prompt/answer (Q&A) or cloze text — in review;
     * writes the `cards` row + logs `update_element`. Never touches lineage,
     * `review_states`, or `review_logs`.
     */
    update(request: CardsUpdateRequest): Promise<CardsUpdateResult>;
    /**
     * Set/clear a card's claim-lifetime fields (T090) — `fact_stability`/`valid_from`/
     * `valid_until`/`jurisdiction`/`software_version`/`review_by` — in one transaction;
     * logs `update_element`. "Expired" stays a DERIVED attribute (no status change, no
     * new op type). Returns the edited card + the freshly-derived expiry status.
     */
    setLifetime(request: CardsSetLifetimeRequest): Promise<CardsSetLifetimeResult>;
    /** Suspend a card (T038): status `suspended`; logs `update_element`. Leaves the deck. */
    suspend(request: CardsSuspendRequest): Promise<CardsSuspendResult>;
    /** Soft-delete a card (T038): `deletedAt` + status `deleted`; logs `soft_delete_element`. */
    delete(request: CardsDeleteRequest): Promise<CardsDeleteResult>;
    /** Flag/un-flag a card as bad (T038) — a non-destructive marker; logs `update_element`. */
    flag(request: CardsFlagRequest): Promise<CardsFlagResult>;
    /**
     * Set/clear a card's durable leech flag (T040) — the manual "Mark leech" button +
     * un-leeching a remediated card; logs `update_element`. Detection is automatic
     * after ≥4 lapses; this is the manual override.
     */
    markLeech(request: CardsMarkLeechRequest): Promise<CardsMarkLeechResult>;
    /**
     * Split a failing card (T085) into 2+ ATOMIC sibling cards — each inheriting the
     * original's lineage with a FRESH `review_states` row, all in one `sibling_group`;
     * the original is soft-deleted (default) or suspended. One transaction; logs
     * `create_card` ×N + `add_relation` + `soft_delete_element`/`update_element`.
     */
    split(request: CardsSplitRequest): Promise<CardsSplitResult>;
    /**
     * Append a clarifying CONTEXT NOTE to a card (T085) — an op-payload marker (no new
     * column); the card stays in rotation. Logs `update_element`. Never touches
     * `review_states`/lineage.
     */
    addContext(request: CardsAddContextRequest): Promise<CardsAddContextResult>;
    /**
     * Send a card's parent EXTRACT back into the attention queue (T085) — reactivate it
     * to DUE-NOW on the ATTENTION scheduler (`reschedule_element`, never `review_states`)
     * and dispose the card (default suspend). Returns the extract, or `null` when the
     * card has no live parent extract.
     */
    backToExtract(request: CardsBackToExtractRequest): Promise<CardsBackToExtractResult>;
    /**
     * Retire a card (T082) — flip the durable `cards.is_retired` flag so a low-value
     * mature card leaves active review gracefully (skipped by the due/review reads),
     * reversibly. Logs `update_element`; never deletes; preserves
     * `review_states`/`review_logs`/lineage. Optionally also floor-clamps the per-card
     * retention override (a convenience, NOT the retirement mechanism).
     */
    retire(request: CardsRetireRequest): Promise<CardsRetireResult>;
    /**
     * Un-retire a card (T082) — clear `cards.is_retired`, returning the card to the
     * normal due read at its existing due date. Logs `update_element`. Independent of
     * any low-retention override (which is cleared via `retention.setCard`).
     */
    unretire(request: CardsUnretireRequest): Promise<CardsUnretireResult>;
    /**
     * The retired-card inventory (T082) — every LIVE retired card with its body +
     * memory signals (stability/reps/lapses) + lineage source, most-mature first.
     * Read-only — no mutation, no `operation_log`.
     */
    retired(): Promise<CardsRetiredResult>;
    /**
     * The sibling card ANSWERS under an extract (T086) — the read-only candidate set the
     * card builder feeds to the pure `detectInterference` similar-answer heuristic. Fetched
     * once when the builder opens / the extract changes (NOT per keystroke). Read-only — no
     * mutation, no `operation_log`.
     */
    siblingAnswers(request: CardsSiblingAnswersRequest): Promise<CardsSiblingAnswersResult>;
    /**
     * Import an Anki `.apkg` deck (T070) — MAIN unwraps the ZIP, opens the embedded
     * `collection.anki2` (`better-sqlite3`), and authors the notes as `card` elements
     * under a per-deck `source`, preserving review history when available.
     */
    importAnki(request: CardsImportAnkiRequest): Promise<CardsImportAnkiResult>;
    /**
     * Export selected cards to an Anki-compatible `.apkg`/CSV in Downloads (T070),
     * carrying source refs OUT to Anki. Read-only on the DB; returns display-safe
     * file metadata.
     */
    exportAnki(request: CardsExportAnkiRequest): Promise<CardsExportAnkiResult>;
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
    /** Mark an extract as reference / done-without-card; direct synthesized is rejected (T104). */
    setFate(request: ExtractsSetFateRequest): Promise<ExtractsSetFateResult>;
    /** Clear an extract fate and return it to active attention work due now (T104). */
    reactivateFate(request: ExtractsReactivateFateRequest): Promise<ExtractsReactivateFateResult>;
    /** Soft-delete an extract; logs `soft_delete_element` (T024). */
    delete(request: ExtractsDeleteRequest): Promise<ExtractsDeleteResult>;
  };
  readonly review: {
    /**
     * The next due card in the active-recall session (T037) — the FSRS deck
     * (`review_states.due_at ≤ now`), soonest first, skipping `exclude`d ids.
     * Carries the full card so reveal needs no round-trip. Read-only.
     */
    sessionNext(request?: ReviewSessionNextRequest): Promise<ReviewSessionNextResult>;
    /**
     * Fetch ONE card's full reveal-ready view by id (T037/T031) — the same view
     * `sessionNext` ships, but TARGETED. The process loop (T031) uses it to reveal
     * the answer inline for the card under its frozen-order cursor. Read-only.
     */
    card(request: ReviewCardRequest): Promise<ReviewCardResult>;
    /**
     * Preview the four next intervals for a card's grade buttons (T037) — calls
     * `CardSchedulerService.previewIntervals`. PURE: mutates nothing.
     */
    preview(request: ReviewPreviewRequest): Promise<ReviewPreviewResult>;
    /**
     * Grade a card (T037) — FSRS reschedule + a durable `review_logs` row, in ONE
     * transaction via `CardSchedulerService.gradeCard` → `ReviewRepository.recordReview`,
     * logging `add_review_log`. Records prompt-side and response-side timings. Cards only.
     */
    grade(request: ReviewGradeRequestInput): Promise<ReviewGradeResult>;
    /**
     * The leech cleanup view's read (T040) — every card flagged a leech (auto after
     * ≥4 lapses, or manual) with its lapse count + source. Read-only. Remediation
     * reuses `cards.update`/`suspend`/`delete`/`markLeech`.
     */
    leeches(): Promise<ReviewLeechesResult>;
    /**
     * Resolve a TARGETED review-mode deck (T096) — the ordered reveal-ready card
     * SUBSET for a concept/source/branch/search/semantic/stale/leech/random mode,
     * OUTSIDE normal scheduling (the selection ignores `review_states.due_at`).
     * Read-only; grading reuses the unchanged `grade`. Cards only.
     */
    modeDeck(request: ReviewModeDeckRequest): Promise<ReviewModeDeckResult>;
    /** The cheap subset count for a review-mode entry affordance (T096). Read-only. */
    modeCount(request: ReviewModeCountRequest): Promise<ReviewModeCountResult>;
  };
  readonly concepts: {
    /**
     * Create a hierarchical concept (T041) — the `concept`-type element + its
     * `concepts` row, in one transaction. Logs `create_element`. Validates the parent.
     */
    create(request: ConceptsCreateRequest): Promise<ConceptsCreateResult>;
    /** All concepts as a flat hierarchy (id/name/parent + child & member counts). Read-only. */
    list(): Promise<ConceptsListResult>;
    /**
     * Assign an element to a concept (T041) — add the `concept_membership` edge;
     * logs `add_relation`. Idempotent. Returns the element's `{ concepts, tags }`.
     */
    assign(request: ConceptsAssignRequest): Promise<ConceptsAssignResult>;
    /** Unassign an element from a concept (T041) — remove the edge; logs `remove_relation`. */
    unassign(request: ConceptsUnassignRequest): Promise<ConceptsUnassignResult>;
    /**
     * The live elements assigned to one concept (the `/concepts` drill-in) — backed
     * by `ConceptRepository.elementsForConcept`, enriched per element. Read-only.
     */
    members(request: ConceptsMembersRequest): Promise<ConceptsMembersResult>;
  };
  readonly tasks: {
    /**
     * Create a verification task (T092) — the `task`-type element + its `tasks` row +
     * the `references` link, in one transaction (`create_element` + `add_relation`).
     * Attention-scheduled (never FSRS); priority inherited from the linked element.
     */
    create(request: TasksCreateRequest): Promise<TasksCreateResult>;
    /** Open tasks (optionally protecting one element) — the inspector Maintenance read. Read-only. */
    list(request: TasksListRequest): Promise<TasksListResult>;
    /** Complete a task (T092) — status → `done` (`reschedule_element`); optional review_by bump. */
    complete(request: TasksCompleteRequest): Promise<TasksCompleteResult>;
    /** Postpone a task (T092) — reschedule further out (`reschedule_element`, growing). */
    postpone(request: TasksPostponeRequest): Promise<TasksPostponeResult>;
    /**
     * Generate verification tasks from T090 expiry (T092) — explicit/opt-in. Scans
     * card-backed facts past `review_by`/`valid_until` and creates one task per
     * protected card without an open task of that kind (idempotent, priority-inherited).
     */
    generateFromExpiry(
      request: TasksGenerateFromExpiryRequest,
    ): Promise<TasksGenerateFromExpiryResult>;
  };
  readonly synthesis: {
    /**
     * Create a synthesis note (T095) — the `synthesis_note` element + (optionally) an
     * initial `documents` body, in one transaction (`create_element` + `update_document`).
     * Stage `synthesis`; attention-scheduled later via {@link scheduleReturn} (never FSRS).
     */
    create(request: SynthesisCreateRequest): Promise<SynthesisCreateResultView>;
    /**
     * Collect an extract/card into a synthesis note (T095) — a `references` edge
     * note→target (`add_relation`); idempotent; rejects a non-extract/non-card.
     */
    link(request: SynthesisLinkRequest): Promise<SynthesisLinkResultView>;
    /** Remove a collected extract/card (T095) — `remove_relation`. */
    unlink(request: SynthesisUnlinkRequest): Promise<SynthesisLinkResultView>;
    /** Save the note's ProseMirror body (T095) — `update_document`, stable ids preserved. */
    editBody(request: SynthesisEditBodyRequest): Promise<SynthesisEditBodyResult>;
    /**
     * Schedule the note to RETURN for refinement (T095) — tomorrow/next-week/next-month/
     * manual, on the ATTENTION scheduler (`reschedule_element`). NEVER FSRS / `review_states`.
     */
    scheduleReturn(request: SynthesisScheduleReturnRequest): Promise<SynthesisScheduleReturnResult>;
    /** The note + its linked extracts/cards + due date (T095). Read-only. */
    get(request: SynthesisGetRequest): Promise<SynthesisGetResult>;
  };
  readonly retention: {
    /**
     * The current desired-retention targets (T079) — the global default, the per-band
     * enable flag + A/B/C/D band map, and every live concept's per-concept target.
     * Read-only.
     */
    get(): Promise<RetentionGetResult>;
    /**
     * Set/clear one priority-band target (T079) → a `settings.updateAppSettings` write
     * (settings have no op). Returns the refreshed full read.
     */
    setBand(request: RetentionSetBandRequest): Promise<RetentionUpdatedResult>;
    /** Enable/disable the per-band feature (T079) → settings write. Refreshed read. */
    setBandEnabled(request: RetentionSetBandEnabledRequest): Promise<RetentionUpdatedResult>;
    /**
     * Set/clear one concept's per-concept target (T079) → `concepts.desired_retention`
     * + `update_element` audit, in one transaction. Returns the concept's stored target.
     */
    setConcept(request: RetentionSetConceptRequest): Promise<RetentionSetConceptResult>;
    /**
     * Set/clear a card's per-card override (T079) → `cards.desired_retention` +
     * `update_element` audit, in one transaction (clamped to the floor). Card-only.
     */
    setCard(request: RetentionSetCardRequest): Promise<RetentionSetCardResult>;
    /**
     * Debug/inspector read (T079): the resolved effective target for one card + which
     * rule won (card override / concept / band / global). Read-only.
     */
    resolveFor(request: RetentionResolveForRequest): Promise<RetentionResolveForResult>;
  };
  readonly optimization: {
    /**
     * Estimate a better FSRS parameter set from the user's review history (T080) —
     * for the global preset or one concept's preset — with a workload-impact preview.
     * Read-only: persists NOTHING (the user must explicitly `apply`). Below the data
     * floor `sufficientData` is `false` (the suggestion equals the current params).
     * An honest history-calibration estimate, never claimed optimal.
     */
    suggest(request: OptimizationSuggestRequest): Promise<OptimizationSuggestResult>;
    /**
     * Apply an accepted parameter set (T080) — the ONLY persisting command. Global
     * scope → the `fsrs.params.global` setting (no op); concept scope →
     * `concepts.fsrs_params` (+ an `update_element` audit). `schedulerForCard` then
     * reads it so subsequent grades use the new params (no retroactive reschedule).
     */
    apply(request: OptimizationApplyRequest): Promise<OptimizationApplyResult>;
  };
  readonly workload: {
    /**
     * Preview how daily load shifts under a hypothetical change (T081) — altering
     * desired retention, adding N cards, or postponing low-priority material — BEFORE
     * committing. A pure projection over the live `review_states` + due dates; READ-ONLY
     * (no due date / setting / op changes). The renderer `Commit`s the real change via
     * the relevant existing command. FSRS vs attention stay distinct in the projection.
     */
    simulate(request: WorkloadSimulateRequest): Promise<WorkloadSimulateResult>;
  };
  readonly tags: {
    /** All tags with their live usage count (T041) — the library filterbar. Read-only. */
    list(): Promise<TagsListResult>;
    /** Tag an element (T041) — created on demand; logs `add_tag`. Idempotent. */
    add(request: TagsAddRequest): Promise<TagsAddResult>;
    /** Untag an element (T041); logs `remove_tag`. */
    remove(request: TagsRemoveRequest): Promise<TagsRemoveResult>;
  };
  readonly search: {
    /**
     * Local FTS5 full-text search (T042) over source title/body + extract body +
     * card prompt/answer + tags, ranked best-first with simple `bm25` ranking.
     * Applies the optional type/concept/tag filters in the query layer. An empty
     * or malformed query returns `[]`. Read-only (appends no op). The renderer
     * never issues SQL — it calls this typed command.
     */
    query(request: SearchQueryRequest): Promise<SearchQueryResult>;
  };
  readonly semantic: {
    /**
     * Fused semantic + FTS search (T087). Embeds the query on-device via the
     * background runner and fuses the `sqlite-vec` KNN with the FTS hits, so
     * conceptually-related material surfaces without a keyword match. OFF BY
     * DEFAULT: when semantics are disabled / the model is absent / `vec0` failed to
     * load, it degrades to FTS-only and `mode` reports which retrieval ran. No raw
     * vectors cross IPC.
     */
    search(request: SemanticSearchRequest): Promise<SemanticSearchResult>;
    /** Index coverage + on/off/downloaded state for the Settings + library affordances. */
    status(request?: SemanticStatusRequest): Promise<SemanticStatusResult>;
    /** Build the index — enqueue `embed` jobs; observe progress via `jobs.subscribe`. */
    reindex(request?: SemanticReindexRequest): Promise<SemanticReindexResult>;
    /**
     * Pre-warm the local embedding model on first enable (T087) and flip
     * `embeddingModelDownloaded = true`. The default local model `fastembed`-caches
     * itself on its first worker job, so this warms that load and degrades to the
     * deterministic embedder offline — search stays FTS-only until it resolves.
     */
    downloadModel(request?: SemanticDownloadModelRequest): Promise<SemanticDownloadModelResult>;
    /**
     * Related-item suggestions for an element (T088) — DERIVED similar extracts /
     * possible duplicates / prerequisite concepts / sibling sources over the `vec0`
     * store + the concept lineage. No new relation types, no op-log, no lineage
     * mutation; degrades to the lineage-only buckets (with `semanticAvailable:
     * false`) when semantics are off. No raw vectors cross IPC.
     */
    related(request: SemanticRelatedRequest): Promise<SemanticRelatedResult>;
    /**
     * Possible-conflict flags for an element (T089) — a DERIVED, HEURISTIC,
     * SUGGESTIVE read: highly-similar `vec0` neighbors that ALSO carry an opposing/
     * superseding signal (negation, numeric divergence, a newer source). Never
     * authoritative — it never edits/suspends/reschedules; it writes nothing (no
     * op-log, no relation). Returns empty flags when semantics are off / `vec0` is
     * absent (the surface hides). No raw vectors cross IPC.
     */
    contradictions(request: SemanticContradictionsRequest): Promise<SemanticContradictionsResult>;
  };
  readonly library: {
    /**
     * The facet-driven "browse everything" read behind `/library`. DISTINCT from
     * `search.query`: it takes NO keyword and lists ALL live elements by default,
     * narrowing only by the type/concept/priority/status facets — and it covers
     * `topic`/`synthesis_note`/`task`, which the FTS-backed search never returns.
     * Read-only (appends no op).
     */
    browse(request?: LibraryBrowseRequest): Promise<LibraryBrowseResult>;
    /**
     * Move a parked source back into the inbox, queue it now, or dismiss it.
     * Mutating; appends one `update_element` op.
     */
    parkedAction(request: LibraryParkedActionRequest): Promise<LibraryParkedActionResult>;
  };
  readonly readPoints: {
    /** Load an element's read-point (resume position), or `null` (T017). */
    get(request: ReadPointGetRequest): Promise<ReadPointGetResult>;
    /** Upsert an element's read-point; logs `set_read_point` (T017). */
    set(request: ReadPointSetRequest): Promise<ReadPointSetResult>;
  };
  readonly trash: {
    /** Every soft-deleted element with its origin context (T044). Read-only. */
    list(): Promise<TrashListResult>;
    /** Restore a soft-deleted element to its prior status; logs `restore_element` (T044). */
    restore(request: TrashRestoreRequest): Promise<TrashRestoreResult>;
    /**
     * Restore an entire branch-delete `batchId` as one unit (T135), root-first, with
     * each node's schedule re-established from its recorded preimage. Surfaces a
     * partial chain (skipped nodes) rather than silently restoring under a still-
     * tombstoned root. The snackbar Undo + the Trash group "Restore" call this.
     */
    restoreBatch(request: TrashRestoreBatchRequest): Promise<TrashRestoreBatchResult>;
    /**
     * Restore only the DELETED-ancestor chain of one element up to the first live
     * ancestor (T135), under one shared restore batch. The inspector "ancestor deleted"
     * hint and a per-tombstone Restore call this so sibling/cousin tombstones are never
     * resurrected and a node is never left under a still-tombstoned parent.
     */
    restoreAncestorChain(
      request: TrashRestoreAncestorChainRequest,
    ): Promise<TrashRestoreAncestorChainResult>;
    /**
     * PERMANENTLY delete one trashed element — the only hard delete (T044). UI-
     * confirmed. A purge that would null a live element's lineage links is refused
     * and reported via `{ blocked: true, liveDependents }` rather than thrown (T135).
     */
    purge(request: TrashPurgeRequest): Promise<TrashPurgeResult>;
    /** PERMANENTLY delete every trashed element in one transaction (T044). UI-confirmed. */
    empty(): Promise<TrashEmptyResult>;
  };
  readonly undo: {
    /**
     * Reverse the MOST-RECENT operation from anywhere (T044) — delete / mark-done /
     * suspend / bulk-postpone — by applying its inverse through the existing write
     * paths. The inverse is one of the closed 15 ops and is itself logged.
     */
    last(): Promise<UndoLastResult>;
  };
  readonly analytics: {
    /**
     * The system-wide learning-health snapshot (T045) — daily reviews, retention,
     * due cards/topics, new cards/extracts, deletions, leeches — aggregated over
     * the durable tables. Read-only (no mutation, no `operation_log`).
     */
    get(request?: AnalyticsGetRequest): Promise<AnalyticsGetResult>;
    /**
     * The calendar-year review activity heatmap read — one zero-filled local-day
     * bucket per day plus sparse previous/next year targets. Read-only.
     */
    reviewActivity(
      request?: AnalyticsReviewActivityRequest,
    ): Promise<AnalyticsReviewActivityResult>;
    /**
     * Priority-fidelity receipt (T105): serviced/deferred/debt by band/topic and
     * threshold flags over the durable logs. Read-only.
     */
    priorityIntegrity(request?: PriorityIntegrityGetRequest): Promise<PriorityIntegrityGetResult>;
    /**
     * Topic/concept maturity receipt (T108): current funnel, stability buckets,
     * retention snapshots, and current graduation candidates. Read-only.
     */
    topicKnowledgeState(
      request?: TopicKnowledgeStateGetRequest,
    ): Promise<TopicKnowledgeStateGetResult>;
  };
  readonly balance: {
    /**
     * The import/process balance snapshot (T046) — the week's sources imported /
     * extracts created / cards created / reviews due, plus the imbalance judgment.
     * Reuses the analytics aggregation; advisory only (no schedule mutation).
     * Read-only.
     */
    get(request?: BalanceGetRequest): Promise<BalanceGetResult>;
  };
  readonly dailyWork: {
    /**
     * The primary daily workflow recommendation — due queue first, then inbox
     * triage, then active unscheduled source resume, then true clear. Read-only.
     */
    summary(request?: DailyWorkSummaryRequest): Promise<DailyWorkSummaryResult>;
    /**
     * Mark the maturity states rendered by the daily summary as observed. This is
     * a UI receipt acknowledgement stored in settings, not a domain mutation.
     */
    ackGraduationEvents(
      request?: DailyWorkGraduationAckRequest,
    ): Promise<DailyWorkGraduationAckResult>;
  };
  readonly weeklyReview: {
    /** Weekly ledger/integrity session summary. May create/suppress the system task. */
    summary(request?: WeeklyReviewSummaryRequest): Promise<WeeklyReviewSummaryResult>;
    /** Persist section progress so a dismissed/partial session resumes. */
    updateProgress(request: WeeklyReviewProgressPatch): Promise<WeeklyReviewProgress>;
    /** Mark the current session complete and schedule the next cadence. */
    complete(request: WeeklyReviewCompleteRequest): Promise<WeeklyReviewLifecycleResult>;
    /** Snooze the current session while preserving section progress. */
    dismiss(request: WeeklyReviewDismissRequest): Promise<WeeklyReviewLifecycleResult>;
  };
  readonly sourceYield: {
    /**
     * The per-source yield rollup (T083) — read %, extracts/cards/mature-cards,
     * leeches, and review time per source, ranked lowest-yield first so low-yield
     * sources are identifiable. Read-only (no mutation, no `operation_log`).
     */
    list(request?: SourceYieldListRequest): Promise<SourceYieldListResult>;
  };
  readonly extractStagnation: {
    /**
     * The extract-stagnation scan (T084) — every live extract that keeps returning
     * without progressing (stage never advanced, no children, postponed repeatedly),
     * with its reasons + a recommended rewrite/convert/postpone/delete remediation,
     * most-stagnant first. Read-only (no mutation, no `operation_log`); the
     * remediations reuse the existing `extracts.*` / extract→card commands.
     */
    list(request?: ExtractStagnationListRequest): Promise<ExtractStagnationListResult>;
  };
  readonly backups: {
    /**
     * Export the entire local knowledge base (T047) — the consistently
     * checkpointed `app.sqlite` + the filesystem asset vault + a versioned, hashed
     * `manifest.json` — into a deterministic `backups/<timestamp>/` directory and a
     * portable `.zip`. Runs entirely in the Electron main process; returns only
     * display-safe artifact metadata (no raw filesystem path reaches the renderer).
     */
    create(): Promise<BackupsCreateResult>;
    /**
     * Open the managed local backups directory in the OS file manager through a
     * fixed Electron main-process command. The renderer supplies no path and receives
     * no path.
     */
    openFolder(): Promise<BackupsOpenFolderResult>;
    /**
     * List app-managed local backups by timestamp. Returns display-safe artifact
     * metadata only — no absolute paths and no arbitrary filesystem access.
     */
    list(): Promise<BackupsListResult>;
    /**
     * Restore one app-managed backup by timestamp. Guarded by `confirm: true` and
     * the exact phrase `RESTORE BACKUP`; never accepts a renderer-supplied path.
     */
    restore(request: BackupsRestoreRequest): Promise<BackupsRestoreResult>;
    /**
     * Open a main-owned native open-file dialog filtered to `.zip` and return ONLY
     * the chosen archive path (or `{ cancelled: true }`). No renderer-supplied path;
     * the picker lives entirely in main, like the import pickers.
     */
    pickArchive(): Promise<BackupsPickArchiveResult>;
    /**
     * Restore an arbitrary backup `.zip` on disk (chosen via `pickArchive`). Extracts
     * + verifies + installs through the SAME pipeline as `restore`. Guarded by
     * `confirm: true` and the exact phrase `RESTORE BACKUP`; never a generic file read.
     */
    restoreFile(request: BackupsRestoreFileRequest): Promise<BackupsRestoreResult>;
    /**
     * Remove the local knowledge store and recreate an empty migrated vault while
     * preserving sibling backups/exports/models. Guarded by `START FROM SCRATCH`.
     */
    resetLocalData(request: BackupsResetLocalDataRequest): Promise<BackupsResetLocalDataResult>;
  };
  readonly jobs: {
    /**
     * Observe the on-device background-runner queue (T058) — read-only. Returns
     * renderer-safe {@link JobSummary} rows (no raw payload/result bytes). T058
     * does NOT expose a generic `enqueue` to the renderer; the only renderer-
     * reachable enqueue path is `sources.importUrl`.
     */
    list(request?: JobsListRequest): Promise<JobsListResult>;
    /**
     * Subscribe to runner `job:update`s (T058). A one-way main → renderer event
     * delivering a {@link JobSummary} to the callback on every state change.
     * Returns an unsubscribe fn. Receive-only — no enqueue, no generic listener,
     * and the renderer never sees the raw `ipcRenderer`/event. Structurally
     * mirrors `menu.onShowShortcuts`, but its callback receives a `JobSummary`.
     */
    subscribe(callback: (summary: JobSummary) => void): () => void;
  };
  readonly vault: {
    /**
     * Verify the asset vault's integrity (T059) — re-hash every live asset's
     * stored bytes (streamed) and report mismatched / missing files + extra files
     * (vault bytes with no `assets` row). Read-only; runs on the local background
     * runner for a large vault. The renderer never resolves a path or reads bytes.
     */
    verify(request?: VaultVerifyRequest): Promise<VaultVerifyResult>;
    /**
     * Find orphaned vault FILES (T059) — files under `assets/` that no live
     * `assets` row references (the bytes a hard-purge's cascade left behind).
     * Read-only; the candidate set for `collectOrphans`.
     */
    findOrphans(request?: VaultFindOrphansRequest): Promise<VaultOrphansResult>;
    /**
     * Remove confirmed orphan files (T059). Guarded by `confirm: true`; an optional
     * `relativePaths` allow-list scopes removal to exactly the files the UI showed.
     * Never deletes a file any live asset row references. Returns the counts freed.
     */
    collectOrphans(request: VaultCollectOrphansRequest): Promise<VaultCollectOrphansResult>;
  };
  readonly maintenance: {
    /** The Maintenance hub rollup (T099) — counts + the integrity-not-run flag; read-only. */
    report(request?: MaintenanceReportRequest): Promise<MaintenanceReportResult>;
    /** The collection-wide duplicate cluster rollup (T099); read-only. */
    duplicates(request?: MaintenanceDuplicatesRequest): Promise<MaintenanceDuplicatesResult>;
    /** Live cards with no resolvable source (T099) — surfaced, never auto-deleted; read-only. */
    cardsWithoutSources(
      request?: MaintenanceCardsWithoutSourcesRequest,
    ): Promise<MaintenanceCardsWithoutSourcesResult>;
    /** Broken sources (T099) — snapshot bytes missing / absent; read-only. */
    brokenSources(
      request?: MaintenanceBrokenSourcesRequest,
    ): Promise<MaintenanceBrokenSourcesResult>;
    /** Scheduler drift hidden from Queue but visible in inventory; read-only. */
    schedulerConsistency(
      request?: MaintenanceSchedulerConsistencyRequest,
    ): Promise<MaintenanceSchedulerConsistencyResult>;
    /** Low-priority, stale candidates (T099) for bulk postpone / archive; read-only. */
    lowValue(request?: MaintenanceLowValueRequest): Promise<MaintenanceLowValueResult>;
    /** The on-demand deep DB + vault integrity check (T099); read-only. */
    integrity(request?: MaintenanceIntegrityRequest): Promise<MaintenanceIntegrityResult>;
    /** Dedup cleanup (T099) — soft-delete validated non-keeper duplicates; undoable. */
    dedupe(request: MaintenanceDedupeRequest): Promise<MaintenanceDedupeResult>;
    /** Orphan-media cleanup (T099) — the confirmed vault GC + vector prune. */
    orphanMedia(request: MaintenanceOrphanMediaRequest): Promise<MaintenanceOrphanMediaResult>;
    /** Bulk soft-delete (T099) — broken-source / sourceless-card trash; one undoable batch. */
    bulkTrash(request: MaintenanceBulkTrashRequest): Promise<MaintenanceBulkTrashResult>;
    /** Bulk archive (T099) — trash / dismiss / retire; one undoable batch. */
    bulkArchive(request: MaintenanceBulkArchiveRequest): Promise<MaintenanceBulkArchiveResult>;
    /** Bulk postpone (T099) — recede low-priority items; one undoable batch (FSRS/attention). */
    bulkPostpone(request: MaintenanceBulkPostponeRequest): Promise<MaintenanceBulkPostponeResult>;
    /** Due saved-for-later sources whose parked timestamp crossed the user threshold. */
    parkedResurfacing(
      request?: MaintenanceParkedResurfacingRequest,
    ): Promise<MaintenanceParkedResurfacingResult>;
    /** Apply keep/queue/let-go decisions for the parked resurfacing sweep as one undoable batch. */
    parkedResurfacingApply(
      request: MaintenanceParkedResurfacingApplyRequest,
    ): Promise<MaintenanceParkedResurfacingApplyResult>;
    /** Items whose effective postpone count crossed the chronic threshold. */
    chronicPostpones(
      request?: MaintenanceChronicPostponesRequest,
    ): Promise<MaintenanceChronicPostponesResult>;
    /** Apply keep/demote/done/delete decisions for chronic-postpone rows as one batch. */
    chronicPostponesApply(
      request: MaintenanceChronicPostponesApplyRequest,
    ): Promise<MaintenanceChronicPostponesApplyResult>;
  };
  readonly menu: {
    /**
     * Subscribe to the native Help → "Keyboard shortcuts" (⌘/) menu item (T048).
     * A one-way main → renderer event so the native menu opens the in-app cheat
     * sheet. Returns an unsubscribe fn. This is the ONLY receive-only bridge method
     * — it carries no payload and exposes no generic listener.
     */
    onShowShortcuts(callback: () => void): () => void;
    /**
     * Subscribe to the native File → "Back up…" (⌘B) menu item (T050). A one-way
     * main → renderer event so the native menu runs the SAME `backups.create()`
     * command as the ⌘B shortcut and the ⌘K palette. Returns an unsubscribe fn;
     * payload-free, no generic listener — same narrow pattern as `onShowShortcuts`.
     */
    onCreateBackup(callback: () => void): () => void;
  };
}
