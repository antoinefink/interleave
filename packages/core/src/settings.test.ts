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
  coerceAiProviderKind,
  coerceSettingsPatch,
  coerceSettingValue,
  DAILY_REVIEW_BUDGET_MAX,
  DAILY_REVIEW_BUDGET_MIN,
  DEFAULT_AI_LOCAL_MODEL_ID,
  DEFAULT_APP_SETTINGS,
  DESIRED_RETENTION_MAX,
  DESIRED_RETENTION_MIN,
  isKeyboardLayout,
  isThemePreference,
  projectToRendererSettings,
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
      aiEnabled: "ai.enabled",
      aiProviderKind: "ai.providerKind",
      aiManagedProxyEnabled: "ai.managedProxyEnabled",
      aiModelDownloaded: "ai.modelDownloaded",
      aiLocalModelId: "ai.localModelId",
      aiApiKey: "ai.apiKey",
    });
  });

  it("ships semantic search OFF by default with the local provider", () => {
    expect(DEFAULT_APP_SETTINGS.semanticSearchEnabled).toBe(false);
    expect(DEFAULT_APP_SETTINGS.embeddingProvider).toBe("local");
    expect(DEFAULT_APP_SETTINGS.embeddingModelDownloaded).toBe(false);
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
    expect(coerceSettingValue("theme", "system")).toBe("system");
    expect(coerceSettingValue("theme", "sepia")).toBe(DEFAULT_APP_SETTINGS.theme);
  });

  it("trims + caps the display name, else falls back to empty (shell identity)", () => {
    expect(coerceSettingValue("displayName", "Ada Lovelace")).toBe("Ada Lovelace");
    expect(coerceSettingValue("displayName", "  Ada  ")).toBe("Ada");
    expect(coerceSettingValue("displayName", "x".repeat(80))).toBe("x".repeat(64));
    expect(coerceSettingValue("displayName", 42)).toBe(DEFAULT_APP_SETTINGS.displayName);
    expect(coerceSettingValue("displayName", null)).toBe("");
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

  it("clamps + rounds the trash retention days into range (T044)", () => {
    expect(coerceSettingValue("trashRetentionDays", 30)).toBe(30);
    expect(coerceSettingValue("trashRetentionDays", 9999)).toBe(365);
    expect(coerceSettingValue("trashRetentionDays", 0)).toBe(
      DEFAULT_APP_SETTINGS.trashRetentionDays,
    );
    expect(coerceSettingValue("trashRetentionDays", 14.6)).toBe(15);
    expect(coerceSettingValue("trashRetentionDays", "nope")).toBe(
      DEFAULT_APP_SETTINGS.trashRetentionDays,
    );
  });

  it("coerces the per-band retention map: clamp present bands, drop unknown labels (T079)", () => {
    // In-bounds bands kept; out-of-range clamped; unknown labels + non-numbers dropped.
    expect(
      coerceSettingValue("retentionByBand", { A: 0.93, B: 0.5, C: "x", E: 0.9, D: 0.999 }),
    ).toEqual({ A: 0.93, B: DESIRED_RETENTION_MIN, D: DESIRED_RETENTION_MAX });
    // A missing band is NOT stored as a duplicate of global — it simply inherits.
    expect(coerceSettingValue("retentionByBand", { A: 0.91 })).toEqual({ A: 0.91 });
    // A non-object degrades to the empty (no-op) default.
    expect(coerceSettingValue("retentionByBand", "nope")).toEqual({});
    expect(coerceSettingValue("retentionByBand", null)).toEqual({});
    expect(coerceSettingValue("retentionByBand", [0.9])).toEqual({});
  });

  it("keeps a real boolean for retentionByBandEnabled, else falls back (T079)", () => {
    expect(coerceSettingValue("retentionByBandEnabled", true)).toBe(true);
    expect(coerceSettingValue("retentionByBandEnabled", false)).toBe(false);
    expect(coerceSettingValue("retentionByBandEnabled", "true")).toBe(
      DEFAULT_APP_SETTINGS.retentionByBandEnabled,
    );
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
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("sepia")).toBe(false);
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
      [SETTINGS_KEYS.trashRetentionDays]: 14,
      [SETTINGS_KEYS.balanceWarnings]: false,
      [SETTINGS_KEYS.importBalanceFactor]: 2.5,
      [SETTINGS_KEYS.keyboardLayout]: "dvorak",
      [SETTINGS_KEYS.theme]: "system",
      [SETTINGS_KEYS.displayName]: "Ada Lovelace",
    };
    expect(appSettingsFromStored(stored)).toEqual({
      dailyReviewBudget: 120,
      defaultDesiredRetention: 0.95,
      defaultTopicIntervalDays: 30,
      defaultSourcePriority: 0.625,
      burySiblings: false,
      trashRetentionDays: 14,
      balanceWarnings: false,
      importBalanceFactor: 2.5,
      keyboardLayout: "dvorak",
      theme: "system",
      displayName: "Ada Lovelace",
      retentionByBand: {},
      retentionByBandEnabled: false,
      fsrsParamsGlobal: null,
      // Unset semantic keys fall back to the OFF-by-default local-provider defaults.
      semanticSearchEnabled: false,
      embeddingProvider: "local",
      embeddingApiKey: "",
      embeddingModelId: "local:all-MiniLM-L6-v2",
      embeddingModelDownloaded: false,
      // Unset AI keys fall back to the OFF-by-default local-provider defaults (T093).
      aiEnabled: false,
      aiProviderKind: "local",
      aiManagedProxyEnabled: false,
      aiModelDownloaded: false,
      aiLocalModelId: "local:Llama-3.2-3B-Instruct-Q4_K_M",
      aiApiKey: "",
    });
  });

  it("a model patch maps back to stable storage keys", () => {
    const stored = settingsPatchToStored({ dailyReviewBudget: 100, theme: "system" });
    expect(stored).toEqual({
      [SETTINGS_KEYS.dailyReviewBudget]: 100,
      [SETTINGS_KEYS.theme]: "system",
    });
  });

  it("survives a full round-trip through stored representation", () => {
    const original = {
      dailyReviewBudget: 80,
      defaultDesiredRetention: 0.92,
      defaultTopicIntervalDays: 3,
      defaultSourcePriority: 0.375,
      burySiblings: false,
      trashRetentionDays: 7,
      balanceWarnings: false,
      importBalanceFactor: 2,
      keyboardLayout: "vim" as const,
      theme: "system" as const,
      displayName: "Ada Lovelace",
      retentionByBand: { A: 0.93, D: 0.85 },
      retentionByBandEnabled: true,
      // A valid 21-number FSRS-6 `w` vector round-trips through the JSON store (T080).
      fsrsParamsGlobal: Array.from({ length: 21 }, (_, i) => 0.1 + i * 0.01),
      // Semantic search settings (T087) round-trip through the JSON store too.
      semanticSearchEnabled: true,
      embeddingProvider: "api" as const,
      embeddingApiKey: "sk-user-own-key",
      embeddingModelId: "openai:text-embedding-3-small",
      embeddingModelDownloaded: true,
      // AI settings (T093) round-trip through the JSON store too.
      aiEnabled: true,
      aiProviderKind: "anthropic" as const,
      aiManagedProxyEnabled: true,
      aiModelDownloaded: true,
      aiLocalModelId: "local:Llama-3.2-3B-Instruct-Q4_K_M",
      aiApiKey: "sk-user-own-ai-key",
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
      theme: "system",
    });
    expect(patch).toEqual({ dailyReviewBudget: DAILY_REVIEW_BUDGET_MAX, theme: "system" });
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

describe("AI settings (T093)", () => {
  it("defaults AI off with the local provider + the pinned model id, no key", () => {
    expect(DEFAULT_APP_SETTINGS.aiEnabled).toBe(false);
    expect(DEFAULT_APP_SETTINGS.aiProviderKind).toBe("local");
    expect(DEFAULT_APP_SETTINGS.aiManagedProxyEnabled).toBe(false);
    expect(DEFAULT_APP_SETTINGS.aiModelDownloaded).toBe(false);
    expect(DEFAULT_APP_SETTINGS.aiLocalModelId).toBe(DEFAULT_AI_LOCAL_MODEL_ID);
    expect(DEFAULT_APP_SETTINGS.aiApiKey).toBe("");
  });

  it("coerces the provider kind, degrading an unknown value to local", () => {
    expect(coerceAiProviderKind("anthropic")).toBe("anthropic");
    expect(coerceAiProviderKind("openai")).toBe("openai");
    expect(coerceAiProviderKind("managed_proxy")).toBe("managed_proxy");
    expect(coerceAiProviderKind("gemini")).toBe("local");
    expect(coerceAiProviderKind(42)).toBe("local");
    expect(coerceSettingValue("aiProviderKind", "bogus")).toBe("local");
  });

  it("coerces aiEnabled / aiApiKey from a stored record (key is a bounded string)", () => {
    expect(coerceSettingValue("aiEnabled", true)).toBe(true);
    expect(coerceSettingValue("aiEnabled", "yes")).toBe(false);
    expect(coerceSettingValue("aiApiKey", "sk-abc")).toBe("sk-abc");
    expect(coerceSettingValue("aiApiKey", 123)).toBe("");
  });

  it("round-trips the AI settings through stored ↔ model", () => {
    const stored = settingsPatchToStored({
      aiEnabled: true,
      aiProviderKind: "anthropic",
      aiApiKey: "sk-secret",
      aiManagedProxyEnabled: true,
    });
    expect(stored[SETTINGS_KEYS.aiEnabled]).toBe(true);
    expect(stored[SETTINGS_KEYS.aiApiKey]).toBe("sk-secret");
    const model = appSettingsFromStored({
      [SETTINGS_KEYS.aiEnabled]: true,
      [SETTINGS_KEYS.aiProviderKind]: "openai",
      [SETTINGS_KEYS.aiApiKey]: "sk-xyz",
    });
    expect(model.aiEnabled).toBe(true);
    expect(model.aiProviderKind).toBe("openai");
    expect(model.aiApiKey).toBe("sk-xyz");
  });
});

describe("projectToRendererSettings (T087/T093 own-key projection)", () => {
  it("strips the plaintext own-keys and replaces them with *Configured booleans", () => {
    const full = {
      ...DEFAULT_APP_SETTINGS,
      embeddingApiKey: "sk-embed-secret",
      aiApiKey: "sk-ai-secret",
    };
    const projected = projectToRendererSettings(full);

    // The plaintext keys are GONE — never returned across the IPC boundary.
    expect(projected).not.toHaveProperty("aiApiKey");
    expect(projected).not.toHaveProperty("embeddingApiKey");
    // …replaced with write-only configured flags derived from whether a key is set.
    expect(projected.aiKeyConfigured).toBe(true);
    expect(projected.embeddingApiKeyConfigured).toBe(true);
    // Every non-key field is carried through untouched.
    expect(projected.dailyReviewBudget).toBe(DEFAULT_APP_SETTINGS.dailyReviewBudget);
    expect(projected.aiEnabled).toBe(DEFAULT_APP_SETTINGS.aiEnabled);
  });

  it("reports configured=false for an empty / whitespace-only key", () => {
    expect(
      projectToRendererSettings({ ...DEFAULT_APP_SETTINGS, aiApiKey: "", embeddingApiKey: "" }),
    ).toMatchObject({ aiKeyConfigured: false, embeddingApiKeyConfigured: false });
    expect(
      projectToRendererSettings({
        ...DEFAULT_APP_SETTINGS,
        aiApiKey: "   ",
        embeddingApiKey: "\t\n",
      }),
    ).toMatchObject({ aiKeyConfigured: false, embeddingApiKeyConfigured: false });
  });
});
