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

/** UI theme. Mirrors the `data-theme` attribute the design tokens key off. */
export const THEMES = ["light", "dark"] as const;
export type ThemePreference = (typeof THEMES)[number];

/**
 * The complete, validated user/domain settings.
 *
 * - `dailyReviewBudget` — soft cap on items surfaced per day; overflow
 *   auto-postpones by priority (read by the queue/scheduler, T029/T077).
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
 * - `importBalanceFactor` — how lopsided imports-vs-processing must be before the
 *   balance warning fires (T046): imports must exceed processed output by this
 *   multiple. Higher = less sensitive. Read by the pure `judgeBalance` rule.
 * - `keyboardLayout` — default shortcut bindings (T048).
 * - `theme` — light/dark UI preference.
 * - `displayName` — the local vault owner's name shown in the shell's user chip
 *   (and the source of the avatar initials). Empty by default (a brand-new vault
 *   has no name yet — the UI degrades to the neutral "Local vault" identity); the
 *   user sets it in `/settings`. There is no server account — this is purely the
 *   on-device identity label, persisted like any other setting.
 */
export interface AppSettings {
  readonly dailyReviewBudget: number;
  readonly defaultDesiredRetention: Priority;
  readonly defaultTopicIntervalDays: number;
  readonly defaultSourcePriority: Priority;
  readonly burySiblings: boolean;
  readonly trashRetentionDays: number;
  readonly balanceWarnings: boolean;
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
   * On-device semantic search master switch (T087). `false` by default — when off,
   * `/search` runs FTS-only, no embeddings are generated, and the vector index is
   * dormant. Turning it on (after the local model is downloaded) lets the search
   * fuse FTS + `sqlite-vec` KNN so conceptually-related material surfaces without a
   * keyword match. Off-by-default + graceful degrade are load-bearing invariants.
   */
  readonly semanticSearchEnabled: boolean;
  /**
   * Which embedder computes vectors (T087): `"local"` runs a bundled/downloaded
   * on-device model in the DB-free worker (the default, fully offline); `"api"`
   * calls the user's OWN embedding endpoint with {@link embeddingApiKey} — the key
   * lives only here in SQLite, the only network call is to the provider the user
   * configured, never our server.
   */
  readonly embeddingProvider: "local" | "api";
  /**
   * The user's OWN embedding-API key (T087), used only when {@link embeddingProvider}
   * is `"api"`. Stored in SQLite settings on the user's own device. The load-bearing
   * invariant: it is NEVER sent to OUR server — the only network call it authorizes
   * is to the provider the user configured. It is injected into the worker job
   * payload OUT-OF-BAND at post time (never persisted to a `jobs` row); the Settings
   * panel reads it back (masked) only so the user can edit it on their own machine.
   * Empty by default.
   */
  readonly embeddingApiKey: string;
  /**
   * The active embedding model id (T087), e.g. `"local:all-MiniLM-L6-v2"` or
   * `"openai:text-embedding-3-small"`. The model id + its dim are stored per
   * embedding row so KNN refuses to mix vectors of different models; switching the
   * model re-embeds. One active model at a time in T087.
   */
  readonly embeddingModelId: string;
  /**
   * First-run state for the local model (T087): `false` until the one-time
   * download-on-first-enable completes. The default real `all-MiniLM-L6-v2` model is
   * fetched + cached on disk (into `INTERLEAVE_MODEL_DIR`) by the worker's `fastembed`
   * on its first load; `EmbeddingService.downloadModel` pre-warms that load and flips
   * this `true`. Until then, semantic search stays FTS-only with a "Downloading
   * model…" affordance (and the worker falls back to the deterministic embedder if
   * the fetch is unavailable, so the feature still degrades cleanly rather than
   * hanging).
   */
  readonly embeddingModelDownloaded: boolean;
}

/**
 * The stable storage keys for each setting in the SQLite `settings` table. These
 * strings are persisted and synced — do NOT rename without a migration.
 */
export const SETTINGS_KEYS = {
  dailyReviewBudget: "review.dailyBudget",
  defaultDesiredRetention: "review.defaultDesiredRetention",
  defaultTopicIntervalDays: "scheduler.defaultTopicIntervalDays",
  defaultSourcePriority: "import.defaultSourcePriority",
  burySiblings: "review.burySiblings",
  trashRetentionDays: "trash.retentionDays",
  balanceWarnings: "balance.warnings",
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
} as const satisfies Record<keyof AppSettings, string>;

/**
 * The default on-device embedding model id (T087). The shipped default is the REAL
 * `all-MiniLM-L6-v2` (384-dim) ONNX sentence-transformer, run in the DB-free worker
 * via `fastembed` — it produces TRUE semantic vectors (conceptual matches without a
 * shared keyword). The id is stored per embedding row so a model switch re-embeds and
 * KNN refuses to mix spaces. When the real model cannot load (offline first run, an
 * `onnxruntime` ABI miss, the dev/Vitest path that bundles no model), the worker
 * degrades to a deterministic feature-hashing fallback recorded under a DISTINCT id
 * (`local:minilm-hash-384`, `FALLBACK_MODEL_ID`) so the two spaces are never KNN-mixed.
 */
export const DEFAULT_EMBEDDING_MODEL_ID = "local:all-MiniLM-L6-v2";

/**
 * The defaults used when a setting has never been written. A brand-new database
 * (or a freshly cleared key) resolves to these, so the scheduler/UI always see a
 * complete settings object. Chosen to match the prototype's defaults.
 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  dailyReviewBudget: 60,
  defaultDesiredRetention: 0.9,
  defaultTopicIntervalDays: 7,
  defaultSourcePriority: DEFAULT_PRIORITY,
  burySiblings: true,
  trashRetentionDays: 30,
  balanceWarnings: true,
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
  // Semantic search (T087) — OFF BY DEFAULT. When off, `/search` is FTS-only, no
  // embeddings run, and the vector index is dormant. The local provider + the
  // canonical default model id; the user's own API key is empty until they opt in.
  semanticSearchEnabled: false,
  embeddingProvider: "local",
  embeddingApiKey: "",
  embeddingModelId: DEFAULT_EMBEDDING_MODEL_ID,
  embeddingModelDownloaded: false,
};

/** The valid embedding-provider values (the `semantic.provider` setting). */
export const EMBEDDING_PROVIDERS = ["local", "api"] as const;
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

/** Inclusive UI bounds for the daily review budget slider. */
export const DAILY_REVIEW_BUDGET_MIN = 10;
export const DAILY_REVIEW_BUDGET_MAX = 300;

/** Inclusive bounds for the trash retention (informational for M9). */
export const TRASH_RETENTION_DAYS_MIN = 1;
export const TRASH_RETENTION_DAYS_MAX = 365;

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
    case "dailyReviewBudget":
      return (
        isFiniteNumber(raw)
          ? clampInt(raw, DAILY_REVIEW_BUDGET_MIN, DAILY_REVIEW_BUDGET_MAX)
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
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
    case "embeddingProvider":
      return (isEmbeddingProvider(raw) ? raw : fallback) as AppSettings[K];
    case "embeddingApiKey":
      // A bounded string; a non-string degrades to the empty default so a corrupt
      // value never reaches the worker's provider call.
      return (
        typeof raw === "string" ? raw.slice(0, EMBEDDING_API_KEY_MAX) : fallback
      ) as AppSettings[K];
    case "embeddingModelId":
      // A non-empty bounded string, else the canonical default model id.
      return (
        typeof raw === "string" && raw.trim().length > 0
          ? raw.trim().slice(0, EMBEDDING_MODEL_ID_MAX)
          : fallback
      ) as AppSettings[K];
    case "embeddingModelDownloaded":
      return (typeof raw === "boolean" ? raw : fallback) as AppSettings[K];
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
  return {
    dailyReviewBudget: coerceSettingValue(
      "dailyReviewBudget",
      stored[SETTINGS_KEYS.dailyReviewBudget],
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
    embeddingModelDownloaded: coerceSettingValue(
      "embeddingModelDownloaded",
      stored[SETTINGS_KEYS.embeddingModelDownloaded],
    ),
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
      out[SETTINGS_KEYS[key]] = value;
    }
  }
  return out;
}

/** Set the default source priority from an A/B/C/D label (UI → numeric store). */
export function sourcePriorityFromLabel(label: PriorityLabel): Priority {
  return priorityFromLabel(label);
}
