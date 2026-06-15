/**
 * App settings model (T011).
 *
 * The canonical, framework-agnostic shape of the user/domain settings that
 * scheduling and the UI read. These live in the SQLite `settings` key/value
 * table (`packages/local-db` `SettingsRepository`), reached by the renderer only
 * through the typed `window.appApi` (`settings.getAll()` / `settings.updateMany()`).
 *
 * Why a typed model on top of the generic key/value store:
 *  - the scheduler (T028 topic/extract scheduler, T036/T037 FSRS review) reads
 *    these through one typed surface instead of guessing keys/types;
 *  - defaults are defined once here, so an unset DB still yields a complete,
 *    valid settings object;
 *  - the keys are STABLE — they are part of backup/export (T047) and eventual
 *    cloud sync, so renames are migrations, not refactors.
 *
 * This module is intentionally dependency-free (no React, Drizzle, or
 * better-sqlite3), per the layering rules. Priority is stored numerically and
 * surfaced as A/B/C/D via `@interleave/core`'s priority helpers.
 */

import { type AiProviderKind, isAiProviderKind } from "./ai";
import { clampFactor, DEFAULT_IMPORT_BALANCE_FACTOR } from "./balance";
import { clamp01 } from "./numeric";
import { DEFAULT_PRIORITY, type Priority, type PriorityLabel, priorityFromLabel } from "./priority";

/**
 * Keyboard layouts that affect default shortcut bindings (presentation only for
 * M1 — the real binding map lands with T048). Matches the prototype's segmented
 * control options.
 */
export const KEYBOARD_LAYOUTS = ["qwerty", "dvorak", "vim"] as const;
export type KeyboardLayout = (typeof KEYBOARD_LAYOUTS)[number];

/** UI theme preference. `system` resolves to a light/dark `data-theme` in the renderer. */
export const THEMES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEMES)[number];

/** Standing overload policy for T117. Manual overload controls remain available in every mode. */
export const OVERLOAD_POLICIES = ["off", "suggest", "automatic"] as const;
export type OverloadPolicy = (typeof OVERLOAD_POLICIES)[number];

/** Extract aging policy for T121. Automatic demotion is explicitly opt-in. */
export const EXTRACT_AGING_POLICIES = ["off", "suggest", "automatic"] as const;
export type ExtractAgingPolicy = (typeof EXTRACT_AGING_POLICIES)[number];

/**
 * The complete, validated user/domain settings.
 *
 * - `dailyBudgetMinutes` — soft cap on estimated minutes surfaced per day; overflow
 *   auto-postpones by priority (read by the queue/scheduler, T116).
 * - `distillationQuotaPercent` — share of a daily/session minute target reserved
 *   for due extract distillation work before card fill (T119). Unused share returns
 *   to the normal queue/session fill.
 * - `dailyReviewBudget` — legacy item-count cap kept readable for one-release rollback
 *   and count-only consumers until they migrate to minute budgets.
 * - `defaultDesiredRetention` — FSRS target recall probability `0.0`–`1.0`
 *   (read by the FSRS scheduler, T036).
 * - `defaultTopicIntervalDays` — how often a topic resurfaces on the attention
 *   scheduler (read by the topic/extract scheduler, T028).
 * - `defaultSourcePriority` — numeric priority assigned to newly imported
 *   sources (surfaced as A/B/C/D; read by import, T012).
 * - `burySiblings` — when `true` (default), cards from the same extract/cloze
 *   sibling group are not shown back-to-back in a review session (read by the
 *   review session ordering, T039). Turning it off uses the natural due order.
 * - `trashRetentionDays` — how long soft-deleted items remain recoverable in the
 *   Trash before they can be cleaned up (T044). For M9 this is INFORMATIONAL copy
 *   only ("recoverable for N days") + a manual "Empty trash"; auto-purge on expiry
 *   is DEFERRED to the maintenance job (M20/T099).
 * - `balanceWarnings` — when `true` (default), the import/process balance `Banner`
 *   (T046) appears on the inbox + analytics when imports outpace processing.
 *   Turning it off suppresses the advisory banner entirely.
 * - `parkedResurfaceAfterDays` — how long a deliberately parked source waits before
 *   it appears in the parked resurfacing sweep (T102). The sweep asks; it never
 *   auto-schedules parked material.
 * - `chronicPostponeThreshold` — how many effective postpones put an item into the
 *   chronic-postpone reckoning list (T106). The count is folded from operation-log
 *   postpone/reset markers, not stored as a mutable column.
 * - `weeklyReviewEnabled` — whether the scheduled weekly ledger/integrity session
 *   is active (T110). Turning it off suppresses the system-owned weekly task.
 * - `weeklyReviewCadenceDays` — the attention cadence for the weekly session (T110).
 * - `adaptiveAttentionIntervals` — whether per-element attention interval
 *   multipliers are used by processed source/extract visits. Default ON now that
 *   T113 exposes the reason line for interval changes.
 * - `importBalanceFactor` — how lopsided imports-vs-processing must be before the
 *   balance warning fires (T046): imports must exceed processed output by this
 *   multiple. Higher = less sensitive. Read by the pure `judgeBalance` rule.
 * - `keyboardLayout` — default shortcut bindings (T048).
 * - `theme` — system/light/dark UI preference.
 * - `displayName` — the local vault owner's name shown in the shell's user chip
 *   (and the source of the avatar initials). Empty by default (a brand-new vault
 *   has no name yet — the UI degrades to the neutral "Local vault" identity); the
 *   user sets it in `/settings`. There is no server account — this is purely the
 *   on-device identity label, persisted like any other setting.
 */
export interface AppSettings {
  readonly dailyBudgetMinutes: number;
  readonly distillationQuotaPercent: number;
  readonly overloadPolicy: OverloadPolicy;
  readonly extractAgingPolicy: ExtractAgingPolicy;
  readonly extractAgingReturnThreshold: number;
  readonly extractAgingAgeDays: number;
  readonly dailyReviewBudget: number;
  readonly defaultDesiredRetention: Priority;
  readonly defaultTopicIntervalDays: number;
  readonly defaultSourcePriority: Priority;
  readonly burySiblings: boolean;
  readonly trashRetentionDays: number;
  readonly balanceWarnings: boolean;
  readonly parkedResurfaceAfterDays: number;
  readonly chronicPostponeThreshold: number;
  /**
   * Lapse-cluster detection (T128). When `true`, the read-only `LapseClusterQuery`
   * surfaces groups of live cards that share a source-region (extract) ancestor and
   * keep lapsing together — a comprehension-debt signal, never a mutation. `false`
   * short-circuits the query to an empty list and hides every cluster surface.
   */
  readonly lapseClusterDetectionEnabled: boolean;
  /** Min total in-window lapse increments for a cluster to surface (K). Conservative. */
  readonly lapseClusterMinLapses: number;
  /** Rolling window (days) over which cluster lapses are counted. */
  readonly lapseClusterWindowDays: number;
  /** Min distinct live member cards for a cluster to surface. */
  readonly lapseClusterMinCards: number;
  /**
   * Re-read proposals (T129). When `true`, a detected lapse cluster (T128) is turned
   * into a quiet, capped re-read proposal the user can accept (scheduling an attention
   * re-read item) or dismiss. `false` short-circuits the proposal listing to an empty
   * list and hides every proposal surface.
   */
  readonly rereadProposalsEnabled: boolean;
  /** Max ACTIVE re-read proposals surfaced at once (a surfacing throttle, not an accept budget). */
  readonly rereadProposalWeeklyCap: number;
  readonly weeklyReviewEnabled: boolean;
  readonly weeklyReviewCadenceDays: number;
  readonly adaptiveAttentionIntervals: boolean;
  readonly importBalanceFactor: number;
  readonly keyboardLayout: KeyboardLayout;
  readonly theme: ThemePreference;
  readonly displayName: string;
  /**
   * Per-priority-band desired-retention targets (T079). When
   * {@link retentionByBandEnabled} is `true`, the FSRS resolver
   * (`@interleave/scheduler` `resolveDesiredRetention`) holds A/B/C/D cards at
   * these per-band targets instead of the single {@link defaultDesiredRetention}.
   * A PARTIAL map: a MISSING band inherits `defaultDesiredRetention` (so the
   * default `{}` is a clean no-op, and it tracks a user-changed global). Each
   * present value is clamped to the retention bounds; unknown labels are dropped.
   */
  readonly retentionByBand: Partial<Record<PriorityLabel, number>>;
  /**
   * Master switch for per-priority/per-concept retention (T079). When `false`,
   * the resolver ignores bands AND concepts — only a per-card override and the
   * global default apply (a clean revert to T036 single-retention behavior).
   * Per-concept targets (stored on the `concept` element) additionally engage the
   * resolver when present, independent of this flag.
   */
  readonly retentionByBandEnabled: boolean;
  /**
   * The optimized GLOBAL FSRS parameter preset (T080) — a JSON-encoded 21-number
   * FSRS-6 `w` vector, or `null` = inherit ts-fsrs `default_w`. Written ONLY by the
   * optimization apply (the suggest/apply flow), never auto-applied. Read by the
   * per-card scheduler factory: `concepts.fsrs_params` (the card's concept preset)
   * overrides this; this overrides `default_w`. Stored here (the queryable store)
   * exactly like {@link retentionByBand} — a `settings` write (no op, T011). The
   * structural shape (a finite 21-number array) is validated at this coercion choke
   * point; the full FSRS `checkParameters` validity is enforced at the
   * `OptimizationService` write boundary (which can import `@interleave/scheduler`;
   * core stays dependency-free).
   */
  readonly fsrsParamsGlobal: number[] | null;
  /**
   * On-device semantic search compatibility flag (T087). Semantic search is now a
   * built-in local capability, so this always resolves to `true`; old stored `false`
   * values and renderer patches are accepted only for compatibility and coerced on.
   */
  readonly semanticSearchEnabled: boolean;
  /**
   * Which embedder computes vectors (T087). Semantic embeddings are local-only; old
   * `"api"` provider values are accepted at coercion boundaries only and resolve to
   * `"local"`.
   */
  readonly embeddingProvider: "local";
  /**
   * Legacy embedding-API key slot (T087). Local semantic search no longer uses this,
   * but existing vaults may contain it. It remains main-side only and is projected to
   * a configured boolean for renderer reads.
   */
  readonly embeddingApiKey: string;
  /**
   * The active embedding model id (T087). Semantic search is pinned to the local
   * EmbeddingGemma ONNX model; legacy model ids coerce to this default so KNN never
   * mixes incompatible vector spaces.
   */
  readonly embeddingModelId: string;
  /**
   * First-run state for the local EmbeddingGemma ONNX model (T087): `false` until
   * the one-time local model preparation completes.
   */
  readonly embeddingModelDownloaded: boolean;
  /**
   * On-device AI assistance master switch (T093). `false` by default — when off, the
   * seven AI formulation actions are disabled, no model/API is called, and the
   * distillation surface shows a calm "Turn on AI assistance in Settings" state. AI
   * runs on the T058 background runner (a local model OR the user's own API key);
   * off-by-default + drafts-only are load-bearing invariants.
   */
  readonly aiEnabled: boolean;
  /**
   * Which provider runs the model (T093): `"local"` (the bundled/downloaded on-device
   * instruction model, run in the DB-free worker — the default, but its model needs a
   * one-time download), `"anthropic"`/`"openai"` (the user's OWN-key HTTP call from the
   * worker — works immediately once a key is set), or `"managed_proxy"` (the
   * OFF-by-default first-party route, which discloses content is sent off-device). The
   * recommended WORKING generation path is an own-key provider — see
   * {@link aiLocalModelId}.
   */
  readonly aiProviderKind: AiProviderKind;
  /**
   * The optional first-party managed-proxy route (T093), `false` by default. Enabling
   * it routes AI calls through the future T051 backup server and is gated by a confirm
   * dialog DISCLOSING that content is sent off-device. The proxy provider throws
   * `AiProxyUnavailableError` until the server `/ai/complete` route lands.
   */
  readonly aiManagedProxyEnabled: boolean;
  /**
   * First-run state for the local instruction model (T093): `false` until the one-time
   * download-on-first-enable completes (the model is NOT bundled — it streams into
   * `<dataDir>/models/<modelId>/`). Until then every action stays disabled with a
   * "downloading model…" affordance. A user with only an own-key configured skips the
   * download entirely.
   */
  readonly aiModelDownloaded: boolean;
  /**
   * The pinned local instruction model id (T093), default
   * `"local:Llama-3.2-3B-Instruct-Q4_K_M"` — identifies the model dir + the download.
   * The on-device instruction model is the EXPLICITLY-EXPERIMENTAL option (CPU-only
   * generation is weaker/slower than an own-key call); the own-key providers are the
   * recommended default generation path and need no download.
   */
  readonly aiLocalModelId: string;
  /**
   * The user's OWN AI-API key (T093), used only for `aiProviderKind` `"anthropic"` /
   * `"openai"`. Stored in SQLite settings on the user's own device, written MAIN-SIDE
   * ONLY. The load-bearing invariant: it is NEVER returned to the renderer (the typed
   * settings read PROJECTS it to a `aiKeyConfigured: boolean`) and NEVER written to a
   * persisted `jobs` row — it is baked into the worker's fork env when AI is enabled.
   * Empty by default.
   */
  readonly aiApiKey: string;
}

/**
 * The RENDERER-facing projection of {@link AppSettings} (T087/T093). Plaintext keys
 * are MAIN-SIDE secrets and must never cross the trusted/untrusted boundary. AI still
 * exposes a configured boolean because its Settings UI edits the own-key provider;
 * legacy embedding provider/key fields are removed from the renderer surface entirely.
 * `projectToRendererSettings` is the single choke point for this projection.
 */
export type RendererSettings = Omit<
  AppSettings,
  "aiApiKey" | "embeddingApiKey" | "embeddingProvider"
> & {
  /** Whether the user's OWN AI-API key is set (T093) — never the key itself. */
  readonly aiKeyConfigured: boolean;
};

/**
 * Project the full main-side {@link AppSettings} to the renderer-safe
 * {@link RendererSettings}: strip plaintext keys and remove legacy embedding provider
 * controls. This is the load-bearing T087/T093 invariant — own-keys are write-only
 * from the renderer's perspective and are never returned in plaintext.
 */
export function projectToRendererSettings(settings: AppSettings): RendererSettings {
  const { aiApiKey, embeddingApiKey, embeddingProvider, ...rest } = settings;
  void embeddingApiKey;
  void embeddingProvider;
  return {
    ...rest,
    aiKeyConfigured: aiApiKey.trim().length > 0,
  };
}

/**
 * The stable storage keys for each setting in the SQLite `settings` table. These
 * strings are persisted and synced — do NOT rename without a migration.
 */
export const SETTINGS_KEYS = {
  dailyBudgetMinutes: "review.dailyBudgetMinutes",
  distillationQuotaPercent: "review.distillationQuotaPercent",
  overloadPolicy: "review.overloadPolicy",
  extractAgingPolicy: "extractAging.policy",
  extractAgingReturnThreshold: "extractAging.returnThreshold",
  extractAgingAgeDays: "extractAging.ageDays",
  dailyReviewBudget: "review.dailyBudget",
  defaultDesiredRetention: "review.defaultDesiredRetention",
  defaultTopicIntervalDays: "scheduler.defaultTopicIntervalDays",
  defaultSourcePriority: "import.defaultSourcePriority",
  burySiblings: "review.burySiblings",
  trashRetentionDays: "trash.retentionDays",
  balanceWarnings: "balance.warnings",
  parkedResurfaceAfterDays: "parked.resurfaceAfterDays",
  chronicPostponeThreshold: "scheduler.chronicPostponeThreshold",
  lapseClusterDetectionEnabled: "lapseCluster.enabled",
  lapseClusterMinLapses: "lapseCluster.minLapses",
  lapseClusterWindowDays: "lapseCluster.windowDays",
  lapseClusterMinCards: "lapseCluster.minCards",
  rereadProposalsEnabled: "rereadProposals.enabled",
  rereadProposalWeeklyCap: "rereadProposals.weeklyCap",
  weeklyReviewEnabled: "weeklyReview.enabled",
  weeklyReviewCadenceDays: "weeklyReview.cadenceDays",
  adaptiveAttentionIntervals: "scheduler.adaptiveAttentionIntervals",
  importBalanceFactor: "balance.importFactor",
  keyboardLayout: "ui.keyboardLayout",
  theme: "ui.theme",
  displayName: "ui.displayName",
  retentionByBand: "review.retentionByBand",
  retentionByBandEnabled: "review.retentionByBand.enabled",
  fsrsParamsGlobal: "review.fsrsParamsGlobal",
  semanticSearchEnabled: "semantic.enabled",
  embeddingProvider: "semantic.provider",
  embeddingApiKey: "semantic.apiKey",
  embeddingModelId: "semantic.modelId",
  embeddingModelDownloaded: "semantic.modelDownloaded",
  aiEnabled: "ai.enabled",
  aiProviderKind: "ai.providerKind",
  aiManagedProxyEnabled: "ai.managedProxyEnabled",
  aiModelDownloaded: "ai.modelDownloaded",
  aiLocalModelId: "ai.localModelId",
  aiApiKey: "ai.apiKey",
} as const satisfies Record<keyof AppSettings, string>;

/**
 * The default on-device embedding model id (T087). Semantic search is pinned to
 * EmbeddingGemma-300M ONNX, whose sentence embeddings are 768-dimensional.
 */
export const DEFAULT_EMBEDDING_MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";

/**
 * The ONNX weight precision the embedding worker loads (T087). `fp16` is the
 * macOS-native choice: it runs on the CoreML execution provider (Apple Neural Engine)
 * and, having no int8 ops, avoids the onnxruntime `DequantizeLinear<int8>` crash the
 * `q8` build hit on Apple Silicon. transformers.js maps this to `model_fp16.onnx`.
 */
export const DEFAULT_EMBEDDING_MODEL_DTYPE = "fp16";

/**
 * The pinned local instruction-model id (T093). `node-llama-cpp` running
 * `Llama-3.2-3B-Instruct` Q4_K_M GGUF (~2 GB int4) is the named on-device generation
 * model — the explicitly-experimental option (CPU-only output is best-effort). The id
 * identifies the model dir (`<dataDir>/models/<modelId>/`) + the one-time download. The
 * own-key providers (Anthropic/OpenAI) are the recommended default generation path and
 * need no download. The local provider MAY ship as a reserved stub until the
 * `node-llama-cpp` integration lands.
 */
export const DEFAULT_AI_LOCAL_MODEL_ID = "local:Llama-3.2-3B-Instruct-Q4_K_M";

/** Maximum length of the user's AI-API key (chars). */
export const AI_API_KEY_MAX = 512;

/** Maximum length of the local AI model id (chars). */
export const AI_LOCAL_MODEL_ID_MAX = 128;

/**
 * Coerce an arbitrary stored value into a valid {@link AiProviderKind} (T093) — the
 * single choke point that keeps a corrupt/legacy provider value from reaching the
 * provider factory. An unknown kind degrades to `"local"` (the default).
 */
export function coerceAiProviderKind(raw: unknown): AiProviderKind {
  return isAiProviderKind(raw) ? raw : "local";
}

/**
 * The defaults used when a setting has never been written. A brand-new database
 * (or a freshly cleared key) resolves to these, so the scheduler/UI always see a
 * complete settings object. Chosen to match the prototype's defaults.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  dailyBudgetMinutes: 60,
  distillationQuotaPercent: 15,
  overloadPolicy: "suggest",
  extractAgingPolicy: "off",
  extractAgingReturnThreshold: 5,
  extractAgingAgeDays: 30,
  dailyReviewBudget: 60,
  defaultDesiredRetention: 0.9,
  defaultTopicIntervalDays: 7,
  defaultSourcePriority: DEFAULT_PRIORITY,
  burySiblings: true,
  trashRetentionDays: 30,
  balanceWarnings: true,
  parkedResurfaceAfterDays: 90,
  chronicPostponeThreshold: 5,
  // Lapse-cluster detection (T128) — ON by default (read-only, no queue impact, quiet
  // help). Conservative thresholds (K=5 / 30d / ≥2 cards, within the spec's ~4–6 band)
  // keep clusters rare so the surfaces never read as an alarm.
  lapseClusterDetectionEnabled: true,
  lapseClusterMinLapses: 5,
  lapseClusterWindowDays: 30,
  lapseClusterMinCards: 2,
  // Re-read proposals (T129) — ON by default (advisory, capped, quiet help). The cap is a
  // surfacing throttle: at most this many ACTIVE proposals are shown at once.
  rereadProposalsEnabled: true,
  rereadProposalWeeklyCap: 2,
  weeklyReviewEnabled: true,
  weeklyReviewCadenceDays: 7,
  adaptiveAttentionIntervals: true,
  importBalanceFactor: DEFAULT_IMPORT_BALANCE_FACTOR,
  keyboardLayout: "qwerty",
  theme: "dark",
  displayName: "",
  // Default to an EMPTY map (every band inherits `defaultDesiredRetention`) — a
  // filled `{ A:0.9, … }` literal would NOT track a user-changed global (the const
  // is static). An absent band = inherit, which stays correct dynamically (T079).
  retentionByBand: {},
  retentionByBandEnabled: false,
  // `null` = inherit ts-fsrs `default_w` (the T036 behavior) until the optimization
  // flow explicitly applies a fitted preset. Never auto-filled (T080).
  fsrsParamsGlobal: null,
  // Semantic search (T087) — always-on local capability. Availability is decided by
  // sqlite-vec/model readiness; this compatibility setting always resolves true.
  semanticSearchEnabled: true,
  embeddingProvider: "local",
  embeddingApiKey: "",
  embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
  embeddingModelDownloaded: false,
  // AI assistance (T093) — OFF BY DEFAULT. Nothing runs until the user opts in AND
  // configures a provider. The default provider kind is `"local"` (its model needs a
  // one-time download), but the recommended working path is an own-key provider. The
  // managed proxy is off until explicitly enabled (with a content-is-sent disclosure).
  aiEnabled: false,
  aiProviderKind: "local",
  aiManagedProxyEnabled: false,
  aiModelDownloaded: false,
  aiLocalModelId: DEFAULT_AI_LOCAL_MODEL_ID,
  aiApiKey: "",
};

/** The valid embedding-provider values (the `semantic.provider` setting). */
export const EMBEDDING_PROVIDERS = ["local"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/** Type guard for {@link EmbeddingProvider}. */
export function isEmbeddingProvider(value: unknown): value is EmbeddingProvider {
  return typeof value === "string" && (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

/** Maximum length of the user's embedding-API key (chars). */
export const EMBEDDING_API_KEY_MAX = 512;

/** Maximum length of the active model id (chars). */
export const EMBEDDING_MODEL_ID_MAX = 128;

/** The FSRS-6 weight-vector length (`default_w` is 21 numbers in ts-fsrs@5.4.1). */
export const FSRS_PARAM_VECTOR_LENGTH = 21;

/**
 * Coerce an arbitrary stored value into a valid global FSRS parameter vector
 * (T080): a finite 21-number array, else `null` (inherit). This is the STRUCTURAL
 * choke point — core stays dependency-free, so the full FSRS `checkParameters`
 * validity (the clamp/range check) is enforced upstream at the `OptimizationService`
 * write boundary (which imports `@interleave/scheduler`). A malformed / wrong-length
 * / non-finite value degrades to `null` so a corrupt store can never reach FSRS.
 */
export function coerceFsrsParams(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length !== FSRS_PARAM_VECTOR_LENGTH) return null;
  if (!raw.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return [...(raw as number[])];
}

/** Inclusive UI bounds for the minute-denominated daily budget (T116). */
export const DAILY_BUDGET_MINUTES_MIN = 5;
export const DAILY_BUDGET_MINUTES_MAX = 300;
export const DAILY_BUDGET_MINUTE_PRESETS = [15, 30, 60, 120] as const;

/** Inclusive UI bounds for the distillation quota floor (T119). */
export const DISTILLATION_QUOTA_PERCENT_MIN = 0;
export const DISTILLATION_QUOTA_PERCENT_MAX = 100;

/** Inclusive UI bounds for the legacy daily review budget slider. */
export const DAILY_REVIEW_BUDGET_MIN = 10;
export const DAILY_REVIEW_BUDGET_MAX = 300;

/** Inclusive bounds for the trash retention (informational for M9). */
export const TRASH_RETENTION_DAYS_MIN = 1;
export const TRASH_RETENTION_DAYS_MAX = 365;

/** Inclusive bounds for parked-source resurfacing sweeps (T102). */
export const PARKED_RESURFACE_AFTER_DAYS_MIN = 1;
export const PARKED_RESURFACE_AFTER_DAYS_MAX = 3650;

/** Inclusive bounds for chronic-postpone reckoning threshold (T106). */
export const CHRONIC_POSTPONE_THRESHOLD_MIN = 2;
export const CHRONIC_POSTPONE_THRESHOLD_MAX = 50;

/** Inclusive bounds for lapse-cluster detection thresholds (T128). */
export const LAPSE_CLUSTER_MIN_LAPSES_MIN = 2;
export const LAPSE_CLUSTER_MIN_LAPSES_MAX = 20;
export const LAPSE_CLUSTER_WINDOW_DAYS_MIN = 7;
export const LAPSE_CLUSTER_WINDOW_DAYS_MAX = 365;
export const LAPSE_CLUSTER_MIN_CARDS_MIN = 2;
export const LAPSE_CLUSTER_MIN_CARDS_MAX = 10;

/** Inclusive bounds for the active re-read proposal surfacing cap (T129). */
export const REREAD_PROPOSAL_WEEKLY_CAP_MIN = 1;
export const REREAD_PROPOSAL_WEEKLY_CAP_MAX = 10;

/** Inclusive bounds for extract aging's returns-without-progress threshold (T121). */
export const EXTRACT_AGING_RETURN_THRESHOLD_MIN = 1;
export const EXTRACT_AGING_RETURN_THRESHOLD_MAX = 50;

/** Inclusive bounds for extract aging's days-since-progress threshold (T121). */
export const EXTRACT_AGING_AGE_DAYS_MIN = 1;
export const EXTRACT_AGING_AGE_DAYS_MAX = 3650;

/** Inclusive bounds for the weekly ledger/integrity cadence (T110). */
export const WEEKLY_REVIEW_CADENCE_DAYS_MIN = 1;
export const WEEKLY_REVIEW_CADENCE_DAYS_MAX = 90;

/**
 * Inclusive bounds for the import-balance factor (T046). Re-exported from
 * `./balance` so the IPC contract + the settings UI bound the slider/patch
 * against the SAME numbers the pure `judgeBalance` rule clamps to.
 */
export { IMPORT_BALANCE_FACTOR_MAX, IMPORT_BALANCE_FACTOR_MIN } from "./balance";

/** Inclusive UI bounds for desired retention (as a probability `0.0`–`1.0`). */
export const DESIRED_RETENTION_MIN = 0.8;
export const DESIRED_RETENTION_MAX = 0.97;

/** The topic-interval presets the UI offers (in days). */
export const TOPIC_INTERVAL_OPTIONS = [3, 7, 14, 30] as const;

/** Maximum length of the local vault owner's display name (chars). */
export const DISPLAY_NAME_MAX = 64;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The four A/B/C/D band labels, as a runtime set for the retention-map coercion. */
const RETENTION_BAND_LABELS: readonly PriorityLabel[] = ["A", "B", "C", "D"];

/**
 * Coerce an arbitrary stored value into a valid {@link AppSettings.retentionByBand}
 * map (T079): keep only the four known A/B/C/D labels whose value is a finite
 * number, clamp each present value to the retention bounds, and DROP everything
 * else. An absent label means "inherit the global default" — it is never stored as
 * a duplicate of global. A non-object yields `{}` (the no-op default).
 */
export function coerceRetentionByBand(raw: unknown): Partial<Record<PriorityLabel, number>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: Partial<Record<PriorityLabel, number>> = {};
  for (const label of RETENTION_BAND_LABELS) {
    const value = source[label];
    if (isFiniteNumber(value)) {
      out[label] = clampRange(value, DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX);
    }
  }
  return out;
}

/** Type guard for {@link KeyboardLayout}. */
export function isKeyboardLayout(value: unknown): value is KeyboardLayout {
  return typeof value === "string" && (KEYBOARD_LAYOUTS as readonly string[]).includes(value);
}

/** Type guard for {@link ThemePreference}. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** Type guard for {@link OverloadPolicy}. */
export function isOverloadPolicy(value: unknown): value is OverloadPolicy {
  return typeof value === "string" && (OVERLOAD_POLICIES as readonly string[]).includes(value);
}

/** Type guard for {@link ExtractAgingPolicy}. */
export function isExtractAgingPolicy(value: unknown): value is ExtractAgingPolicy {
  return typeof value === "string" && (EXTRACT_AGING_POLICIES as readonly string[]).includes(value);
}

/**
 * Coerce one arbitrary stored value into a valid setting of the given key,
 * falling back to the default when the stored value is missing or malformed.
 * This is the single choke point that keeps a corrupt/legacy value from ever
 * escaping into the scheduler or UI.
 */
export function coerceSettingValue<K extends keyof AppSettings>(
  key: K,
  raw: unknown,
): AppSettings[K] {
  const fallback = DEFAULT_APP_SETTINGS[key];
  switch (key) {
    case "dailyBudgetMinutes":
      return (
        isFiniteNumber(raw)
          ? clampInt(raw, DAILY_BUDGET_MINUTES_MIN, DAILY_BUDGET_MINUTES_MAX)
          : fallback
      ) as AppSettings[K];
    case "distillationQuotaPercent":
      return (
        isFiniteNumber(raw)
          ? clampInt(raw, DISTILLATION_QUOTA_PERCENT_MIN, DISTILLATION_QUOTA_PERCENT_MAX)
          : fallback
      ) as AppSettings[K];
    case "dailyReviewBudget":
      return (
        isFiniteNumber(raw)
          ? clampInt(raw, DAILY_REVIEW_BUDGET_MIN, DAILY_REVIEW_BUDGET_MAX)
          : fallback
      ) as AppSettings[K];
    case "overloadPolicy":
      return (isOverloadPolicy(raw) ? raw : fallback) as AppSettings[K];
    case "extractAgingPolicy":
      return (isExtractAgingPolicy(raw) ? raw : fallback) as AppSettings[K];
    case "extractAgingReturnThreshold":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, EXTRACT_AGING_RETURN_THRESHOLD_MIN, EXTRACT_AGING_RETURN_THRESHOLD_MAX)
          : fallback
      ) as AppSettings[K];
    case "extractAgingAgeDays":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, EXTRACT_AGING_AGE_DAYS_MIN, EXTRACT_AGING_AGE_DAYS_MAX)
          : fallback
      ) as AppSettings[K];
    case "defaultDesiredRetention":
      return (
        isFiniteNumber(raw)
          ? clampRange(raw, DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX)
          : fallback
      ) as AppSettings[K];
    case "defaultTopicIntervalDays":
      return (isFiniteNumber(raw) && raw > 0 ? Math.round(raw) : fallback) as AppSettings[K];
    case "defaultSourcePriority":
      return (isFiniteNumber(raw) ? clamp01(raw) : fallback) as AppSettings[K];
    case "burySiblings":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "balanceWarnings":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "parkedResurfaceAfterDays":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, PARKED_RESURFACE_AFTER_DAYS_MIN, PARKED_RESURFACE_AFTER_DAYS_MAX)
          : fallback
      ) as AppSettings[K];
    case "chronicPostponeThreshold":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, CHRONIC_POSTPONE_THRESHOLD_MIN, CHRONIC_POSTPONE_THRESHOLD_MAX)
          : fallback
      ) as AppSettings[K];
    case "lapseClusterDetectionEnabled":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "lapseClusterMinLapses":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, LAPSE_CLUSTER_MIN_LAPSES_MIN, LAPSE_CLUSTER_MIN_LAPSES_MAX)
          : fallback
      ) as AppSettings[K];
    case "lapseClusterWindowDays":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, LAPSE_CLUSTER_WINDOW_DAYS_MIN, LAPSE_CLUSTER_WINDOW_DAYS_MAX)
          : fallback
      ) as AppSettings[K];
    case "lapseClusterMinCards":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, LAPSE_CLUSTER_MIN_CARDS_MIN, LAPSE_CLUSTER_MIN_CARDS_MAX)
          : fallback
      ) as AppSettings[K];
    case "rereadProposalsEnabled":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "rereadProposalWeeklyCap":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, REREAD_PROPOSAL_WEEKLY_CAP_MIN, REREAD_PROPOSAL_WEEKLY_CAP_MAX)
          : fallback
      ) as AppSettings[K];
    case "weeklyReviewEnabled":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "weeklyReviewCadenceDays":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, WEEKLY_REVIEW_CADENCE_DAYS_MIN, WEEKLY_REVIEW_CADENCE_DAYS_MAX)
          : fallback
      ) as AppSettings[K];
    case "adaptiveAttentionIntervals":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "importBalanceFactor":
      return (isFiniteNumber(raw) ? clampFactor(raw) : fallback) as AppSettings[K];
    case "trashRetentionDays":
      return (
        isFiniteNumber(raw) && raw > 0
          ? clampInt(raw, TRASH_RETENTION_DAYS_MIN, TRASH_RETENTION_DAYS_MAX)
          : fallback
      ) as AppSettings[K];
    case "keyboardLayout":
      return (isKeyboardLayout(raw) ? raw : fallback) as AppSettings[K];
    case "theme":
      return (isThemePreference(raw) ? raw : fallback) as AppSettings[K];
    case "displayName":
      // Trim + cap; a non-string (or whitespace-only) yields the empty default,
      // so a corrupt/legacy value can never reach the shell's user chip.
      return (
        typeof raw === "string" ? raw.trim().slice(0, DISPLAY_NAME_MAX) : fallback
      ) as AppSettings[K];
    case "retentionByBand":
      // Keep only known A/B/C/D labels with finite, in-bounds values (T079); an
      // absent label inherits global, so a malformed map degrades to `{}`.
      return coerceRetentionByBand(raw) as AppSettings[K];
    case "retentionByBandEnabled":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "fsrsParamsGlobal":
      // A finite 21-number array, else `null` (inherit `default_w`); the full
      // FSRS validity is enforced at the OptimizationService write (T080).
      return coerceFsrsParams(raw) as AppSettings[K];
    case "semanticSearchEnabled":
      // Compatibility read/write only: semantic search is always on when local vec/model
      // capability is available, so old stored `false` values cannot disable it.
      return true as AppSettings[K];
    case "embeddingProvider":
      // Semantic embeddings are local-only. Legacy `"api"` or corrupt values are ignored.
      return "local" as AppSettings[K];
    case "embeddingApiKey":
      // Legacy, main-side-only slot. Local embeddings never read this value, but keeping
      // bounded coercion preserves backup/settings compatibility without projection leaks.
      return (
        typeof raw === "string" ? raw.slice(0, EMBEDDING_API_KEY_MAX) : fallback
      ) as AppSettings[K];
    case "embeddingModelId":
      // The embedding space is pinned to EmbeddingGemma ONNX; old MiniLM/API ids coerce.
      return DEFAULT_EMBEDDING_MODEL_ID as AppSettings[K];
    case "embeddingModelDownloaded":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "aiEnabled":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "aiProviderKind":
      // An unknown/legacy provider kind degrades to `"local"` (the default) so a
      // corrupt value never reaches the provider factory.
      return coerceAiProviderKind(raw) as AppSettings[K];
    case "aiManagedProxyEnabled":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "aiModelDownloaded":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "aiLocalModelId":
      // A non-empty bounded string, else the canonical default model id.
      return (
        typeof raw === "string" && raw.trim().length > 0
          ? raw.trim().slice(0, AI_LOCAL_MODEL_ID_MAX)
          : fallback
      ) as AppSettings[K];
    case "aiApiKey":
      // A bounded string; a non-string degrades to the empty default so a corrupt
      // value never reaches the worker's provider call. Written main-side only.
      return (typeof raw === "string" ? raw.slice(0, AI_API_KEY_MAX) : fallback) as AppSettings[K];
    default:
      return fallback;
  }
}

/**
 * Build a complete {@link AppSettings} from a partial/loose record of stored
 * key/value pairs (e.g. the raw `settings` table contents), coercing every field
 * and filling gaps with {@link DEFAULT_APP_SETTINGS}.
 */
export function appSettingsFromStored(stored: Readonly<Record<string, unknown>>): AppSettings {
  const hasMinuteBudget = Object.hasOwn(stored, SETTINGS_KEYS.dailyBudgetMinutes);
  const legacyBudget = coerceSettingValue(
    "dailyReviewBudget",
    stored[SETTINGS_KEYS.dailyReviewBudget],
  );
  const rawEmbeddingModelId = stored[SETTINGS_KEYS.embeddingModelId];
  const embeddingModelMatchesDefault =
    rawEmbeddingModelId === undefined || rawEmbeddingModelId === DEFAULT_EMBEDDING_MODEL_ID;
  return {
    dailyBudgetMinutes: coerceSettingValue(
      "dailyBudgetMinutes",
      hasMinuteBudget
        ? stored[SETTINGS_KEYS.dailyBudgetMinutes]
        : stored[SETTINGS_KEYS.dailyReviewBudget],
    ),
    distillationQuotaPercent: coerceSettingValue(
      "distillationQuotaPercent",
      stored[SETTINGS_KEYS.distillationQuotaPercent],
    ),
    dailyReviewBudget: legacyBudget,
    overloadPolicy: coerceSettingValue("overloadPolicy", stored[SETTINGS_KEYS.overloadPolicy]),
    extractAgingPolicy: coerceSettingValue(
      "extractAgingPolicy",
      stored[SETTINGS_KEYS.extractAgingPolicy],
    ),
    extractAgingReturnThreshold: coerceSettingValue(
      "extractAgingReturnThreshold",
      stored[SETTINGS_KEYS.extractAgingReturnThreshold],
    ),
    extractAgingAgeDays: coerceSettingValue(
      "extractAgingAgeDays",
      stored[SETTINGS_KEYS.extractAgingAgeDays],
    ),
    defaultDesiredRetention: coerceSettingValue(
      "defaultDesiredRetention",
      stored[SETTINGS_KEYS.defaultDesiredRetention],
    ),
    defaultTopicIntervalDays: coerceSettingValue(
      "defaultTopicIntervalDays",
      stored[SETTINGS_KEYS.defaultTopicIntervalDays],
    ),
    defaultSourcePriority: coerceSettingValue(
      "defaultSourcePriority",
      stored[SETTINGS_KEYS.defaultSourcePriority],
    ),
    burySiblings: coerceSettingValue("burySiblings", stored[SETTINGS_KEYS.burySiblings]),
    trashRetentionDays: coerceSettingValue(
      "trashRetentionDays",
      stored[SETTINGS_KEYS.trashRetentionDays],
    ),
    balanceWarnings: coerceSettingValue("balanceWarnings", stored[SETTINGS_KEYS.balanceWarnings]),
    parkedResurfaceAfterDays: coerceSettingValue(
      "parkedResurfaceAfterDays",
      stored[SETTINGS_KEYS.parkedResurfaceAfterDays],
    ),
    chronicPostponeThreshold: coerceSettingValue(
      "chronicPostponeThreshold",
      stored[SETTINGS_KEYS.chronicPostponeThreshold],
    ),
    lapseClusterDetectionEnabled: coerceSettingValue(
      "lapseClusterDetectionEnabled",
      stored[SETTINGS_KEYS.lapseClusterDetectionEnabled],
    ),
    lapseClusterMinLapses: coerceSettingValue(
      "lapseClusterMinLapses",
      stored[SETTINGS_KEYS.lapseClusterMinLapses],
    ),
    lapseClusterWindowDays: coerceSettingValue(
      "lapseClusterWindowDays",
      stored[SETTINGS_KEYS.lapseClusterWindowDays],
    ),
    lapseClusterMinCards: coerceSettingValue(
      "lapseClusterMinCards",
      stored[SETTINGS_KEYS.lapseClusterMinCards],
    ),
    rereadProposalsEnabled: coerceSettingValue(
      "rereadProposalsEnabled",
      stored[SETTINGS_KEYS.rereadProposalsEnabled],
    ),
    rereadProposalWeeklyCap: coerceSettingValue(
      "rereadProposalWeeklyCap",
      stored[SETTINGS_KEYS.rereadProposalWeeklyCap],
    ),
    weeklyReviewEnabled: coerceSettingValue(
      "weeklyReviewEnabled",
      stored[SETTINGS_KEYS.weeklyReviewEnabled],
    ),
    weeklyReviewCadenceDays: coerceSettingValue(
      "weeklyReviewCadenceDays",
      stored[SETTINGS_KEYS.weeklyReviewCadenceDays],
    ),
    adaptiveAttentionIntervals: coerceSettingValue(
      "adaptiveAttentionIntervals",
      stored[SETTINGS_KEYS.adaptiveAttentionIntervals],
    ),
    importBalanceFactor: coerceSettingValue(
      "importBalanceFactor",
      stored[SETTINGS_KEYS.importBalanceFactor],
    ),
    keyboardLayout: coerceSettingValue("keyboardLayout", stored[SETTINGS_KEYS.keyboardLayout]),
    theme: coerceSettingValue("theme", stored[SETTINGS_KEYS.theme]),
    displayName: coerceSettingValue("displayName", stored[SETTINGS_KEYS.displayName]),
    retentionByBand: coerceSettingValue("retentionByBand", stored[SETTINGS_KEYS.retentionByBand]),
    retentionByBandEnabled: coerceSettingValue(
      "retentionByBandEnabled",
      stored[SETTINGS_KEYS.retentionByBandEnabled],
    ),
    fsrsParamsGlobal: coerceSettingValue(
      "fsrsParamsGlobal",
      stored[SETTINGS_KEYS.fsrsParamsGlobal],
    ),
    semanticSearchEnabled: coerceSettingValue(
      "semanticSearchEnabled",
      stored[SETTINGS_KEYS.semanticSearchEnabled],
    ),
    embeddingProvider: coerceSettingValue(
      "embeddingProvider",
      stored[SETTINGS_KEYS.embeddingProvider],
    ),
    embeddingApiKey: coerceSettingValue("embeddingApiKey", stored[SETTINGS_KEYS.embeddingApiKey]),
    embeddingModelId: coerceSettingValue(
      "embeddingModelId",
      stored[SETTINGS_KEYS.embeddingModelId],
    ),
    embeddingModelDownloaded: embeddingModelMatchesDefault
      ? coerceSettingValue(
          "embeddingModelDownloaded",
          stored[SETTINGS_KEYS.embeddingModelDownloaded],
        )
      : false,
    aiEnabled: coerceSettingValue("aiEnabled", stored[SETTINGS_KEYS.aiEnabled]),
    aiProviderKind: coerceSettingValue("aiProviderKind", stored[SETTINGS_KEYS.aiProviderKind]),
    aiManagedProxyEnabled: coerceSettingValue(
      "aiManagedProxyEnabled",
      stored[SETTINGS_KEYS.aiManagedProxyEnabled],
    ),
    aiModelDownloaded: coerceSettingValue(
      "aiModelDownloaded",
      stored[SETTINGS_KEYS.aiModelDownloaded],
    ),
    aiLocalModelId: coerceSettingValue("aiLocalModelId", stored[SETTINGS_KEYS.aiLocalModelId]),
    aiApiKey: coerceSettingValue("aiApiKey", stored[SETTINGS_KEYS.aiApiKey]),
  };
}

/**
 * Validate + coerce a partial settings patch (from the UI), returning a clean
 * partial keyed by the {@link AppSettings} field names. Unknown/extra fields are
 * dropped; malformed values are coerced. Use this before persisting so only
 * valid, bounded values reach SQLite.
 */
export function coerceSettingsPatch(
  patch: Readonly<Record<string, unknown>>,
): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  for (const key of Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[]) {
    if (Object.hasOwn(patch, key) && patch[key] !== undefined) {
      // biome-ignore lint/suspicious/noExplicitAny: index assignment across the union
      (out as any)[key] = coerceSettingValue(key, patch[key]);
    }
  }
  return out;
}

/**
 * Convert a partial {@link AppSettings} patch to the stable storage key/value
 * record the `settings` table persists. The inverse of reading via
 * {@link appSettingsFromStored}.
 */
export function settingsPatchToStored(
  patch: Readonly<Partial<AppSettings>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as (keyof AppSettings)[]) {
    const value = patch[key];
    if (value !== undefined) {
      out[SETTINGS_KEYS[key]] = shouldCoerceSettingOnWrite(key)
        ? coerceSettingValue(key, value)
        : value;
    }
  }
  if (patch.dailyBudgetMinutes !== undefined && patch.dailyReviewBudget === undefined) {
    out[SETTINGS_KEYS.dailyReviewBudget] = coerceSettingValue(
      "dailyReviewBudget",
      patch.dailyBudgetMinutes,
    );
  }
  if (patch.dailyReviewBudget !== undefined && patch.dailyBudgetMinutes === undefined) {
    out[SETTINGS_KEYS.dailyBudgetMinutes] = coerceSettingValue(
      "dailyBudgetMinutes",
      patch.dailyReviewBudget,
    );
  }
  return out;
}

function shouldCoerceSettingOnWrite(key: keyof AppSettings): boolean {
  return (
    key === "semanticSearchEnabled" || key === "embeddingProvider" || key === "embeddingModelId"
  );
}

/** Set the default source priority from an A/B/C/D label (UI → numeric store). */
export function sourcePriorityFromLabel(label: PriorityLabel): Priority {
  return priorityFromLabel(label);
}
