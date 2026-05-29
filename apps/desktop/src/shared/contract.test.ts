/**
 * IPC contract validation tests (T007).
 *
 * The security posture depends on the main side rejecting malformed renderer
 * payloads, so these assert the Zod schemas accept valid requests and reject
 * invalid ones, and that the channel set is exactly the four M1 commands (no
 * generic `db.query`).
 */

import { describe, expect, it } from "vitest";
import {
  InboxGetRequestSchema,
  InboxTriageRequestSchema,
  InspectorGetRequestSchema,
  IPC_CHANNELS,
  SettingKeySchema,
  SettingsGetRequestSchema,
  SettingsPatchSchema,
  SettingsUpdateManyRequestSchema,
  SettingsUpdateRequestSchema,
  SourcesImportManualRequestSchema,
} from "./contract";

describe("IPC channels", () => {
  it("exposes exactly the M1 commands plus the M2 inbox mutation surface and no generic SQL channel", () => {
    expect(Object.values(IPC_CHANNELS).sort()).toEqual(
      [
        "app:health",
        "db:getStatus",
        "settings:get",
        "settings:update",
        "settings:getAll",
        "settings:updateMany",
        "inspector:list",
        "inspector:get",
        "sources:importManual",
        "inbox:list",
        "inbox:get",
        "inbox:triage",
      ].sort(),
    );
    expect(Object.values(IPC_CHANNELS)).not.toContain("db:query");
  });
});

describe("SettingsGetRequestSchema", () => {
  it("accepts an empty object (all settings)", () => {
    expect(SettingsGetRequestSchema.parse({})).toEqual({});
  });

  it("accepts a key", () => {
    expect(SettingsGetRequestSchema.parse({ key: "theme" })).toEqual({ key: "theme" });
  });

  it("rejects an empty key", () => {
    expect(() => SettingsGetRequestSchema.parse({ key: "" })).toThrow();
  });
});

describe("SettingsUpdateRequestSchema", () => {
  it("accepts a key + arbitrary JSON value", () => {
    const parsed = SettingsUpdateRequestSchema.parse({ key: "budget", value: 20 });
    expect(parsed.key).toBe("budget");
    expect(parsed.value).toBe(20);
  });

  it("requires a key", () => {
    expect(() => SettingsUpdateRequestSchema.parse({ value: 1 })).toThrow();
  });

  it("rejects an over-long key", () => {
    expect(() => SettingKeySchema.parse("x".repeat(200))).toThrow();
  });
});

describe("SettingsPatchSchema (T011)", () => {
  it("accepts a valid partial patch", () => {
    const parsed = SettingsPatchSchema.parse({ dailyReviewBudget: 60, theme: "light" });
    expect(parsed).toEqual({ dailyReviewBudget: 60, theme: "light" });
  });

  it("accepts an empty patch", () => {
    expect(SettingsPatchSchema.parse({})).toEqual({});
  });

  it("rejects an unknown field (strict)", () => {
    expect(() => SettingsPatchSchema.parse({ bogus: 1 })).toThrow();
  });

  it("rejects an out-of-range daily budget", () => {
    expect(() => SettingsPatchSchema.parse({ dailyReviewBudget: 9999 })).toThrow();
    expect(() => SettingsPatchSchema.parse({ dailyReviewBudget: 1 })).toThrow();
  });

  it("rejects an out-of-range retention and a bad enum", () => {
    expect(() => SettingsPatchSchema.parse({ defaultDesiredRetention: 0.5 })).toThrow();
    expect(() => SettingsPatchSchema.parse({ keyboardLayout: "azerty" })).toThrow();
    expect(() => SettingsPatchSchema.parse({ theme: "system" })).toThrow();
  });

  it("rejects a non-integer budget / topic interval", () => {
    expect(() => SettingsPatchSchema.parse({ dailyReviewBudget: 60.5 })).toThrow();
    expect(() => SettingsPatchSchema.parse({ defaultTopicIntervalDays: 0 })).toThrow();
  });
});

describe("SettingsUpdateManyRequestSchema (T011)", () => {
  it("wraps a patch", () => {
    expect(SettingsUpdateManyRequestSchema.parse({ patch: { theme: "dark" } })).toEqual({
      patch: { theme: "dark" },
    });
  });

  it("requires the patch field", () => {
    expect(() => SettingsUpdateManyRequestSchema.parse({})).toThrow();
  });
});

describe("InspectorGetRequestSchema", () => {
  it("accepts a non-empty element id", () => {
    expect(InspectorGetRequestSchema.parse({ id: "el_123" })).toEqual({ id: "el_123" });
  });

  it("rejects a missing or empty id", () => {
    expect(() => InspectorGetRequestSchema.parse({})).toThrow();
    expect(() => InspectorGetRequestSchema.parse({ id: "" })).toThrow();
  });
});

describe("SourcesImportManualRequestSchema (T012)", () => {
  it("accepts a title-only payload", () => {
    expect(SourcesImportManualRequestSchema.parse({ title: "Hello" })).toEqual({ title: "Hello" });
  });

  it("accepts optional provenance + a priority label", () => {
    const parsed = SourcesImportManualRequestSchema.parse({
      title: "Article",
      author: "Ada",
      url: "https://example.com",
      priority: "A",
    });
    expect(parsed.title).toBe("Article");
    expect(parsed.priority).toBe("A");
  });

  it("accepts a full payload with a multi-paragraph body + date (T013)", () => {
    const parsed = SourcesImportManualRequestSchema.parse({
      title: "Pasted article",
      url: "https://example.com/post",
      author: "Ada",
      publishedAt: "2026-01-15",
      body: "First paragraph.\n\nSecond paragraph.",
      priority: "B",
    });
    expect(parsed.body).toBe("First paragraph.\n\nSecond paragraph.");
    expect(parsed.publishedAt).toBe("2026-01-15");
  });

  it("trims the title and rejects an empty / missing one", () => {
    expect(SourcesImportManualRequestSchema.parse({ title: "  Trimmed  " }).title).toBe("Trimmed");
    expect(() => SourcesImportManualRequestSchema.parse({})).toThrow();
    expect(() => SourcesImportManualRequestSchema.parse({ title: "" })).toThrow();
    expect(() => SourcesImportManualRequestSchema.parse({ title: "   " })).toThrow();
  });

  it("rejects an over-long title and a bad priority label", () => {
    expect(() => SourcesImportManualRequestSchema.parse({ title: "x".repeat(513) })).toThrow();
    expect(() => SourcesImportManualRequestSchema.parse({ title: "ok", priority: "Z" })).toThrow();
  });
});

describe("InboxGetRequestSchema (T012)", () => {
  it("accepts a non-empty id and rejects an empty one", () => {
    expect(InboxGetRequestSchema.parse({ id: "el_1" })).toEqual({ id: "el_1" });
    expect(() => InboxGetRequestSchema.parse({ id: "" })).toThrow();
  });
});

describe("InboxTriageRequestSchema (T012)", () => {
  it("accepts each known action", () => {
    expect(InboxTriageRequestSchema.parse({ id: "el_1", action: { kind: "accept" } })).toEqual({
      id: "el_1",
      action: { kind: "accept" },
    });
    expect(
      InboxTriageRequestSchema.parse({ id: "el_1", action: { kind: "keepForLater" } }),
    ).toBeTruthy();
    expect(
      InboxTriageRequestSchema.parse({
        id: "el_1",
        action: { kind: "setPriority", priority: "B" },
      }),
    ).toBeTruthy();
    expect(InboxTriageRequestSchema.parse({ id: "el_1", action: { kind: "delete" } })).toBeTruthy();
  });

  it("rejects an unknown action and a bad setPriority label", () => {
    expect(() =>
      InboxTriageRequestSchema.parse({ id: "el_1", action: { kind: "archive" } }),
    ).toThrow();
    expect(() =>
      InboxTriageRequestSchema.parse({
        id: "el_1",
        action: { kind: "setPriority", priority: "Z" },
      }),
    ).toThrow();
    expect(() =>
      InboxTriageRequestSchema.parse({ id: "el_1", action: { kind: "setPriority" } }),
    ).toThrow();
  });

  it("requires an id", () => {
    expect(() => InboxTriageRequestSchema.parse({ action: { kind: "accept" } })).toThrow();
  });
});
