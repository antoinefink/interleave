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
 * - `keyboardLayout` — default shortcut bindings (T048).
 * - `theme` — light/dark UI preference.
 */
export interface AppSettings {
  readonly dailyReviewBudget: number;
  readonly defaultDesiredRetention: Priority;
  readonly defaultTopicIntervalDays: number;
  readonly defaultSourcePriority: Priority;
  readonly burySiblings: boolean;
  readonly keyboardLayout: KeyboardLayout;
  readonly theme: ThemePreference;
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
  keyboardLayout: "ui.keyboardLayout",
  theme: "ui.theme",
} as const satisfies Record<keyof AppSettings, string>;

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
  keyboardLayout: "qwerty",
  theme: "dark",
};

/** Inclusive UI bounds for the daily review budget slider. */
export const DAILY_REVIEW_BUDGET_MIN = 10;
export const DAILY_REVIEW_BUDGET_MAX = 300;

/** Inclusive UI bounds for desired retention (as a probability `0.0`–`1.0`). */
export const DESIRED_RETENTION_MIN = 0.8;
export const DESIRED_RETENTION_MAX = 0.97;

/** The topic-interval presets the UI offers (in days). */
export const TOPIC_INTERVAL_OPTIONS = [3, 7, 14, 30] as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
    case "keyboardLayout":
      return (isKeyboardLayout(raw) ? raw : fallback) as AppSettings[K];
    case "theme":
      return (isThemePreference(raw) ? raw : fallback) as AppSettings[K];
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
    keyboardLayout: coerceSettingValue("keyboardLayout", stored[SETTINGS_KEYS.keyboardLayout]),
    theme: coerceSettingValue("theme", stored[SETTINGS_KEYS.theme]),
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
