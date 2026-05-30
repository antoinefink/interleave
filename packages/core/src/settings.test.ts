/**
 * AppSettings model tests (T011).
 *
 * Exercises the framework-agnostic settings model: defaults, coercion/clamping
 * of malformed/out-of-range stored values, the stored↔model round-trip, and the
 * partial-patch validation the IPC layer relies on.
 */

import { describe, expect, it } from "vitest";
import {
  appSettingsFromStored,
  coerceSettingsPatch,
  coerceSettingValue,
  DAILY_REVIEW_BUDGET_MAX,
  DAILY_REVIEW_BUDGET_MIN,
  DEFAULT_APP_SETTINGS,
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  isKeyboardLayout,
  isThemePreference,
  SETTINGS_KEYS,
  settingsPatchToStored,
  sourcePriorityFromLabel,
} from "./settings";

describe("AppSettings defaults", () => {
  it("yields a complete, valid object from an empty store", () => {
    expect(appSettingsFromStored({})).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("has stable, namespaced storage keys", () => {
    expect(SETTINGS_KEYS).toEqual({
      dailyReviewBudget: "review.dailyBudget",
      defaultDesiredRetention: "review.defaultDesiredRetention",
      defaultTopicIntervalDays: "scheduler.defaultTopicIntervalDays",
      defaultSourcePriority: "import.defaultSourcePriority",
      burySiblings: "review.burySiblings",
      keyboardLayout: "ui.keyboardLayout",
      theme: "ui.theme",
    });
  });

  it("buries siblings by default", () => {
    expect(DEFAULT_APP_SETTINGS.burySiblings).toBe(true);
  });
});

describe("coerceSettingValue", () => {
  it("clamps + rounds the daily review budget into range", () => {
    expect(coerceSettingValue("dailyReviewBudget", 1)).toBe(DAILY_REVIEW_BUDGET_MIN);
    expect(coerceSettingValue("dailyReviewBudget", 9999)).toBe(DAILY_REVIEW_BUDGET_MAX);
    expect(coerceSettingValue("dailyReviewBudget", 42.7)).toBe(43);
    expect(coerceSettingValue("dailyReviewBudget", "nope")).toBe(
      DEFAULT_APP_SETTINGS.dailyReviewBudget,
    );
  });

  it("clamps desired retention into the FSRS-sane band", () => {
    expect(coerceSettingValue("defaultDesiredRetention", 0.5)).toBe(DESIRED_RETENTION_MIN);
    expect(coerceSettingValue("defaultDesiredRetention", 0.999)).toBe(DESIRED_RETENTION_MAX);
    expect(coerceSettingValue("defaultDesiredRetention", 0.9)).toBe(0.9);
  });

  it("keeps a positive topic interval, else falls back", () => {
    expect(coerceSettingValue("defaultTopicIntervalDays", 14)).toBe(14);
    expect(coerceSettingValue("defaultTopicIntervalDays", 0)).toBe(
      DEFAULT_APP_SETTINGS.defaultTopicIntervalDays,
    );
    expect(coerceSettingValue("defaultTopicIntervalDays", -3)).toBe(
      DEFAULT_APP_SETTINGS.defaultTopicIntervalDays,
    );
  });

  it("clamps the default source priority to [0,1]", () => {
    expect(coerceSettingValue("defaultSourcePriority", 0.875)).toBe(0.875);
    expect(coerceSettingValue("defaultSourcePriority", 2)).toBe(1);
    expect(coerceSettingValue("defaultSourcePriority", -1)).toBe(0);
  });

  it("validates the keyboard layout + theme enums", () => {
    expect(coerceSettingValue("keyboardLayout", "vim")).toBe("vim");
    expect(coerceSettingValue("keyboardLayout", "azerty")).toBe(
      DEFAULT_APP_SETTINGS.keyboardLayout,
    );
    expect(coerceSettingValue("theme", "light")).toBe("light");
    expect(coerceSettingValue("theme", "sepia")).toBe(DEFAULT_APP_SETTINGS.theme);
  });

  it("keeps a real boolean for burySiblings, else falls back to the default", () => {
    expect(coerceSettingValue("burySiblings", false)).toBe(false);
    expect(coerceSettingValue("burySiblings", true)).toBe(true);
    // A non-boolean (incl. truthy strings/numbers) is rejected — only a real
    // boolean is accepted, so a corrupt/legacy value can never disable burying.
    expect(coerceSettingValue("burySiblings", "true")).toBe(DEFAULT_APP_SETTINGS.burySiblings);
    expect(coerceSettingValue("burySiblings", 0)).toBe(DEFAULT_APP_SETTINGS.burySiblings);
    expect(coerceSettingValue("burySiblings", undefined)).toBe(DEFAULT_APP_SETTINGS.burySiblings);
  });
});

describe("type guards", () => {
  it("isKeyboardLayout", () => {
    expect(isKeyboardLayout("qwerty")).toBe(true);
    expect(isKeyboardLayout("colemak")).toBe(false);
    expect(isKeyboardLayout(7)).toBe(false);
  });
  it("isThemePreference", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("system")).toBe(false);
  });
});

describe("stored ↔ model round-trip", () => {
  it("reads custom stored values and coerces them", () => {
    const stored = {
      [SETTINGS_KEYS.dailyReviewBudget]: 120,
      [SETTINGS_KEYS.defaultDesiredRetention]: 0.95,
      [SETTINGS_KEYS.defaultTopicIntervalDays]: 30,
      [SETTINGS_KEYS.defaultSourcePriority]: 0.625,
      [SETTINGS_KEYS.burySiblings]: false,
      [SETTINGS_KEYS.keyboardLayout]: "dvorak",
      [SETTINGS_KEYS.theme]: "light",
    };
    expect(appSettingsFromStored(stored)).toEqual({
      dailyReviewBudget: 120,
      defaultDesiredRetention: 0.95,
      defaultTopicIntervalDays: 30,
      defaultSourcePriority: 0.625,
      burySiblings: false,
      keyboardLayout: "dvorak",
      theme: "light",
    });
  });

  it("a model patch maps back to stable storage keys", () => {
    const stored = settingsPatchToStored({ dailyReviewBudget: 100, theme: "light" });
    expect(stored).toEqual({
      [SETTINGS_KEYS.dailyReviewBudget]: 100,
      [SETTINGS_KEYS.theme]: "light",
    });
  });

  it("survives a full round-trip through stored representation", () => {
    const original = {
      dailyReviewBudget: 80,
      defaultDesiredRetention: 0.92,
      defaultTopicIntervalDays: 3,
      defaultSourcePriority: 0.375,
      burySiblings: false,
      keyboardLayout: "vim" as const,
      theme: "light" as const,
    };
    const reloaded = appSettingsFromStored(settingsPatchToStored(original));
    expect(reloaded).toEqual(original);
  });
});

describe("coerceSettingsPatch", () => {
  it("drops unknown keys and coerces known ones", () => {
    const patch = coerceSettingsPatch({
      dailyReviewBudget: 9999,
      bogus: "x",
      theme: "light",
    });
    expect(patch).toEqual({ dailyReviewBudget: DAILY_REVIEW_BUDGET_MAX, theme: "light" });
  });

  it("ignores undefined fields", () => {
    expect(coerceSettingsPatch({ theme: undefined })).toEqual({});
  });

  it("passes a boolean burySiblings patch through", () => {
    expect(coerceSettingsPatch({ burySiblings: false })).toEqual({ burySiblings: false });
    expect(coerceSettingsPatch({ burySiblings: true })).toEqual({ burySiblings: true });
  });
});

describe("sourcePriorityFromLabel", () => {
  it("maps A/B/C/D to numeric priority bands", () => {
    expect(sourcePriorityFromLabel("A")).toBe(0.875);
    expect(sourcePriorityFromLabel("D")).toBe(0.125);
  });
});
