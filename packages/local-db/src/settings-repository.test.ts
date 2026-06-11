import {
  DAILY_REVIEW_BUDGET_MAX,
  DEFAULT_APP_SETTINGS,
  PRIORITY_LABEL_VALUE,
  SETTINGS_KEYS,
} from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsRepository } from "./settings-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;
let settings: SettingsRepository;

beforeEach(() => {
  handle = createInMemoryDb();
  settings = new SettingsRepository(handle.db);
});

afterEach(() => {
  handle.sqlite.close();
});

describe("SettingsRepository", () => {
  it("stores JSON values, overwrites them, and supports fallbacks/deletes", () => {
    expect(settings.getOr("missing", "fallback")).toBe("fallback");

    settings.set("reader.width", { px: 720 });
    expect(settings.get("reader.width")).toEqual({ px: 720 });

    settings.set("reader.width", { px: 840 });
    expect(settings.get("reader.width")).toEqual({ px: 840 });

    settings.delete("reader.width");
    expect(settings.get("reader.width")).toBeNull();
  });

  it("writes many settings in one call and returns a parsed record", () => {
    settings.setMany({
      "ui.theme": "dark",
      "queue.dailyBudget": 42,
      "nullable.value": null,
    });

    expect(settings.getAll()).toMatchObject({
      "ui.theme": "dark",
      "queue.dailyBudget": 42,
      "nullable.value": null,
    });
  });

  it("returns complete validated app settings and persists only coerced patch fields", () => {
    expect(settings.getAppSettings()).toEqual(DEFAULT_APP_SETTINGS);

    const updated = settings.updateAppSettings({
      dailyReviewBudget: 9999,
      defaultSourcePriority: PRIORITY_LABEL_VALUE.A,
      theme: "dark",
      unknown: "ignored",
    });

    expect(updated.dailyReviewBudget).toBe(DAILY_REVIEW_BUDGET_MAX);
    expect(updated.defaultSourcePriority).toBe(PRIORITY_LABEL_VALUE.A);
    expect(updated.theme).toBe("dark");
    expect(updated.chronicPostponeThreshold).toBe(DEFAULT_APP_SETTINGS.chronicPostponeThreshold);
    expect(settings.get(SETTINGS_KEYS.dailyReviewBudget)).toBe(DAILY_REVIEW_BUDGET_MAX);
    expect(settings.get("unknown")).toBeNull();
  });

  it("persists the coerced chronic postpone threshold", () => {
    const updated = settings.updateAppSettings({ chronicPostponeThreshold: 999 });
    expect(updated.chronicPostponeThreshold).toBe(50);
    expect(settings.get(SETTINGS_KEYS.chronicPostponeThreshold)).toBe(50);
  });
});
