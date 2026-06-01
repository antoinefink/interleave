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
  AnalyticsGetRequestSchema,
  BackupsCreateRequestSchema,
  BalanceGetRequestSchema,
  CaptureGetPairingRequestSchema,
  CaptureRegenerateTokenRequestSchema,
  CaptureSetEnabledRequestSchema,
  CardsCreateRequestSchema,
  CardsDeleteRequestSchema,
  CardsFlagRequestSchema,
  CardsMarkLeechRequestSchema,
  CardsSuspendRequestSchema,
  CardsUpdateRequestSchema,
  ConceptsAssignRequestSchema,
  ConceptsCreateRequestSchema,
  ConceptsMembersRequestSchema,
  ConceptsUnassignRequestSchema,
  DocumentBlockInputSchema,
  DocumentMarksAddRequestSchema,
  DocumentMarksListRequestSchema,
  DocumentMarksRemoveRequestSchema,
  DocumentsGetRequestSchema,
  DocumentsSaveRequestSchema,
  ElementsSetPriorityRequestSchema,
  ExtractionCreateRequestSchema,
  ExtractsDeleteRequestSchema,
  ExtractsMarkDoneRequestSchema,
  ExtractsPostponeRequestSchema,
  ExtractsRewriteRequestSchema,
  ExtractsUpdateStageRequestSchema,
  InboxGetRequestSchema,
  InboxTriageRequestSchema,
  InspectorGetRequestSchema,
  IPC_CHANNELS,
  IsoTimestampInputSchema,
  LibraryBrowseRequestSchema,
  LineageGetRequestSchema,
  QueueActRequestSchema,
  QueueListRequestSchema,
  QueueScheduleRequestSchema,
  QueueUndoRequestSchema,
  ReadPointGetRequestSchema,
  ReadPointSetRequestSchema,
  ReviewGradeRequestSchema,
  ReviewPreviewRequestSchema,
  ReviewSessionNextRequestSchema,
  SearchQueryRequestSchema,
  SettingKeySchema,
  SettingsGetRequestSchema,
  SettingsPatchSchema,
  SettingsUpdateManyRequestSchema,
  SettingsUpdateRequestSchema,
  SourcesImportManualRequestSchema,
  type SourcesImportUrlRequest,
  SourcesImportUrlRequestSchema,
  type SourcesImportUrlResult,
  TagsAddRequestSchema,
  TagsRemoveRequestSchema,
} from "./contract";

describe("IPC channels", () => {
  it("exposes exactly the M1 commands plus the M2 inbox mutation + M3 document/read-point + M4 marks/extraction/lineage/extract-review + M5 priority/queue surface and no generic SQL channel", () => {
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
        "elements:setPriority",
        "queue:list",
        "queue:act",
        "queue:schedule",
        "queue:undo",
        "lineage:get",
        "sources:importManual",
        "sources:importUrl",
        "capture:getPairing",
        "capture:regenerateToken",
        "capture:setEnabled",
        "inbox:list",
        "inbox:get",
        "inbox:triage",
        "documents:get",
        "documents:save",
        "documents:marks:add",
        "documents:marks:remove",
        "documents:marks:list",
        "extractions:create",
        "cards:create",
        "cards:update",
        "cards:suspend",
        "cards:delete",
        "cards:flag",
        "cards:markLeech",
        "extracts:updateStage",
        "extracts:rewrite",
        "extracts:postpone",
        "extracts:markDone",
        "extracts:delete",
        "review:session:next",
        "review:card",
        "review:preview",
        "review:grade",
        "review:leeches",
        "concepts:create",
        "concepts:list",
        "concepts:assign",
        "concepts:unassign",
        "concepts:members",
        "tags:list",
        "tags:add",
        "tags:remove",
        "search:query",
        "library:browse",
        "readPoint:get",
        "readPoint:set",
        "trash:list",
        "trash:restore",
        "trash:purge",
        "trash:empty",
        "undo:last",
        "analytics:get",
        "balance:get",
        "backups:create",
        "menu:showShortcuts",
        "menu:createBackup",
      ].sort(),
    );
    expect(Object.values(IPC_CHANNELS)).not.toContain("db:query");
  });
});

describe("Capture pairing schemas (T062)", () => {
  it("CaptureGetPairing / CaptureRegenerateToken accept a void (undefined) payload", () => {
    expect(() => CaptureGetPairingRequestSchema.parse(undefined)).not.toThrow();
    expect(() => CaptureRegenerateTokenRequestSchema.parse(undefined)).not.toThrow();
  });

  it("CaptureSetEnabled accepts a boolean `enabled`", () => {
    expect(CaptureSetEnabledRequestSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(CaptureSetEnabledRequestSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("CaptureSetEnabled rejects a missing / non-boolean `enabled`", () => {
    expect(() => CaptureSetEnabledRequestSchema.parse({})).toThrow();
    expect(() => CaptureSetEnabledRequestSchema.parse({ enabled: "yes" })).toThrow();
    expect(() => CaptureSetEnabledRequestSchema.parse({ enabled: 1 })).toThrow();
  });
});

describe("SourcesImportUrlRequestSchema (T060)", () => {
  it("accepts a minimal valid { url }", () => {
    const parsed = SourcesImportUrlRequestSchema.parse({ url: "https://example.com/post" });
    expect(parsed.url).toBe("https://example.com/post");
    expect(parsed.priority).toBeUndefined();
  });

  it("accepts an optional priority, reason, and forceNewVersion", () => {
    const parsed = SourcesImportUrlRequestSchema.parse({
      url: "https://example.com/post",
      priority: "A",
      reasonAdded: "worth keeping",
      forceNewVersion: true,
    });
    expect(parsed.priority).toBe("A");
    expect(parsed.reasonAdded).toBe("worth keeping");
    expect(parsed.forceNewVersion).toBe(true);
  });

  it("rejects an empty url", () => {
    expect(() => SourcesImportUrlRequestSchema.parse({ url: "" })).toThrow();
    expect(() => SourcesImportUrlRequestSchema.parse({ url: "   " })).toThrow();
  });

  it("rejects an oversize url (> 2048 chars)", () => {
    const huge = `https://example.com/${"a".repeat(2100)}`;
    expect(() => SourcesImportUrlRequestSchema.parse({ url: huge })).toThrow();
  });

  it("rejects an invalid priority label", () => {
    expect(() =>
      SourcesImportUrlRequestSchema.parse({ url: "https://example.com", priority: "Z" }),
    ).toThrow();
  });

  it("the request type carries the optional forceNewVersion flag (T061)", () => {
    const req: SourcesImportUrlRequest = { url: "https://example.com", forceNewVersion: true };
    expect(req.forceNewVersion).toBe(true);
  });

  it("the discriminated result round-trips a duplicate `matches` payload (T061)", () => {
    // The duplicate arm carries the existing live match(es) so the modal can offer
    // Open existing / Import new version. A pure TS shape — assert it narrows.
    const result: SourcesImportUrlResult = {
      status: "duplicate",
      matches: [
        {
          elementId: "el_existing",
          title: "The Spacing Effect",
          status: "inbox",
          accessedAt: "2026-05-10T00:00:00.000Z",
          matchedBy: "canonicalUrl",
        },
      ],
    };
    expect(result.status).toBe("duplicate");
    if (result.status !== "duplicate") throw new Error("expected duplicate");
    expect(result.matches[0]?.elementId).toBe("el_existing");
    expect(result.matches[0]?.matchedBy).toBe("canonicalUrl");
  });
});

describe("ElementsSetPriorityRequestSchema (T027)", () => {
  it("accepts a set action with a valid A/B/C/D label", () => {
    const parsed = ElementsSetPriorityRequestSchema.parse({
      id: "el_1",
      action: { kind: "set", priority: "A" },
    });
    expect(parsed.action).toEqual({ kind: "set", priority: "A" });
  });

  it("accepts raise and lower actions", () => {
    expect(
      ElementsSetPriorityRequestSchema.parse({ id: "el_1", action: { kind: "raise" } }).action.kind,
    ).toBe("raise");
    expect(
      ElementsSetPriorityRequestSchema.parse({ id: "el_1", action: { kind: "lower" } }).action.kind,
    ).toBe("lower");
  });

  it("rejects an unknown action kind", () => {
    expect(() =>
      ElementsSetPriorityRequestSchema.parse({ id: "el_1", action: { kind: "bump" } }),
    ).toThrow();
  });

  it("rejects a set action with an invalid label", () => {
    expect(() =>
      ElementsSetPriorityRequestSchema.parse({
        id: "el_1",
        action: { kind: "set", priority: "Z" },
      }),
    ).toThrow();
  });

  it("rejects a missing id", () => {
    expect(() => ElementsSetPriorityRequestSchema.parse({ action: { kind: "raise" } })).toThrow();
  });
});

describe("QueueActRequestSchema (T030)", () => {
  it("accepts each known action kind", () => {
    for (const kind of ["postpone", "raise", "lower", "markDone", "dismiss", "delete"] as const) {
      const parsed = QueueActRequestSchema.parse({ id: "el_1", action: { kind } });
      expect(parsed.action.kind).toBe(kind);
    }
  });

  it("rejects an unknown action kind (the discriminated-union boundary)", () => {
    expect(() =>
      QueueActRequestSchema.parse({ id: "el_1", action: { kind: "schedule" } }),
    ).toThrow();
    expect(() => QueueActRequestSchema.parse({ id: "el_1", action: { kind: "open" } })).toThrow();
  });

  it("rejects a missing id and a missing action", () => {
    expect(() => QueueActRequestSchema.parse({ action: { kind: "postpone" } })).toThrow();
    expect(() => QueueActRequestSchema.parse({ id: "el_1" })).toThrow();
    expect(() => QueueActRequestSchema.parse({ id: "", action: { kind: "postpone" } })).toThrow();
  });
});

describe("QueueScheduleRequestSchema (T028)", () => {
  it("accepts each preset choice", () => {
    for (const kind of ["tomorrow", "nextWeek", "nextMonth"] as const) {
      const parsed = QueueScheduleRequestSchema.parse({ id: "el_1", choice: { kind } });
      expect(parsed.choice.kind).toBe(kind);
    }
  });

  it("accepts a manual choice with an ISO date (trimmed)", () => {
    const parsed = QueueScheduleRequestSchema.parse({
      id: "el_1",
      choice: { kind: "manual", date: "  2026-07-01T12:00:00.000Z  " },
    });
    expect(parsed.choice).toEqual({ kind: "manual", date: "2026-07-01T12:00:00.000Z" });
  });

  it("rejects an unknown choice kind and a manual choice without a date", () => {
    expect(() =>
      QueueScheduleRequestSchema.parse({ id: "el_1", choice: { kind: "someday" } }),
    ).toThrow();
    expect(() =>
      QueueScheduleRequestSchema.parse({ id: "el_1", choice: { kind: "manual" } }),
    ).toThrow();
    expect(() =>
      QueueScheduleRequestSchema.parse({ id: "el_1", choice: { kind: "manual", date: "" } }),
    ).toThrow();
  });

  it("rejects a missing id", () => {
    expect(() => QueueScheduleRequestSchema.parse({ choice: { kind: "tomorrow" } })).toThrow();
  });
});

describe("QueueUndoRequestSchema (T030)", () => {
  it("accepts a restore recipe and a status recipe with a valid previous status", () => {
    expect(
      QueueUndoRequestSchema.parse({
        id: "el_1",
        undo: { kind: "restore", previousStatus: "active" },
      }).undo.kind,
    ).toBe("restore");
    expect(
      QueueUndoRequestSchema.parse({
        id: "el_1",
        undo: { kind: "status", previousStatus: "scheduled" },
      }).undo.previousStatus,
    ).toBe("scheduled");
  });

  it("rejects an unknown undo kind and an invalid previous status", () => {
    expect(() =>
      QueueUndoRequestSchema.parse({
        id: "el_1",
        undo: { kind: "revert", previousStatus: "active" },
      }),
    ).toThrow();
    expect(() =>
      QueueUndoRequestSchema.parse({
        id: "el_1",
        undo: { kind: "restore", previousStatus: "bogus" },
      }),
    ).toThrow();
  });

  it("rejects a missing id or undo recipe", () => {
    expect(() =>
      QueueUndoRequestSchema.parse({ undo: { kind: "restore", previousStatus: "active" } }),
    ).toThrow();
    expect(() => QueueUndoRequestSchema.parse({ id: "el_1" })).toThrow();
  });
});

describe("CardsCreateRequestSchema (T032)", () => {
  it("accepts a Q&A request with a non-empty prompt + answer", () => {
    const parsed = CardsCreateRequestSchema.parse({
      extractId: "el_1",
      kind: "qa",
      prompt: "What is intelligence?",
      answer: "Skill-acquisition efficiency.",
    });
    expect(parsed.kind).toBe("qa");
    expect(parsed.prompt).toBe("What is intelligence?");
  });

  it("accepts a cloze request with non-empty cloze text + an optional sibling group", () => {
    const parsed = CardsCreateRequestSchema.parse({
      extractId: "el_1",
      kind: "cloze",
      cloze: "Intelligence is {{c1::skill-acquisition efficiency}}.",
      siblingGroupId: "grp_1",
    });
    expect(parsed.kind).toBe("cloze");
    expect(parsed.siblingGroupId).toBe("grp_1");
  });

  it("accepts an optional A/B/C/D priority override", () => {
    const parsed = CardsCreateRequestSchema.parse({
      extractId: "el_1",
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
      priority: "A",
    });
    expect(parsed.priority).toBe("A");
  });

  it("rejects a Q&A request with an empty (or missing) prompt", () => {
    expect(() =>
      CardsCreateRequestSchema.parse({ extractId: "el_1", kind: "qa", prompt: "", answer: "A." }),
    ).toThrow();
    expect(() =>
      CardsCreateRequestSchema.parse({ extractId: "el_1", kind: "qa", answer: "A." }),
    ).toThrow();
  });

  it("rejects a Q&A request with an empty (or missing) answer", () => {
    expect(() =>
      CardsCreateRequestSchema.parse({ extractId: "el_1", kind: "qa", prompt: "Q?", answer: "" }),
    ).toThrow();
    expect(() =>
      CardsCreateRequestSchema.parse({ extractId: "el_1", kind: "qa", prompt: "Q?" }),
    ).toThrow();
  });

  it("rejects a cloze request with empty (or missing) cloze text", () => {
    expect(() =>
      CardsCreateRequestSchema.parse({ extractId: "el_1", kind: "cloze", cloze: "" }),
    ).toThrow();
    expect(() => CardsCreateRequestSchema.parse({ extractId: "el_1", kind: "cloze" })).toThrow();
  });

  it("rejects an unknown card kind and a missing extractId", () => {
    expect(() =>
      CardsCreateRequestSchema.parse({ extractId: "el_1", kind: "image", cloze: "x" }),
    ).toThrow();
    expect(() =>
      CardsCreateRequestSchema.parse({ kind: "qa", prompt: "Q?", answer: "A." }),
    ).toThrow();
  });
});

describe("Card repair schemas (T038)", () => {
  it("cards.update accepts a Q&A body edit, a cloze edit, and requires at least one field", () => {
    expect(
      CardsUpdateRequestSchema.parse({ cardId: "el_1", prompt: "New?", answer: "New." }),
    ).toEqual({ cardId: "el_1", prompt: "New?", answer: "New." });
    expect(CardsUpdateRequestSchema.parse({ cardId: "el_1", cloze: "{{c1::x}}" }).cloze).toBe(
      "{{c1::x}}",
    );
    // No body fields → rejected (the refine).
    expect(() => CardsUpdateRequestSchema.parse({ cardId: "el_1" })).toThrow();
    // Missing id → rejected.
    expect(() => CardsUpdateRequestSchema.parse({ prompt: "x" })).toThrow();
  });

  it("cards.suspend / cards.delete require a cardId", () => {
    expect(CardsSuspendRequestSchema.parse({ cardId: "el_1" }).cardId).toBe("el_1");
    expect(CardsDeleteRequestSchema.parse({ cardId: "el_1" }).cardId).toBe("el_1");
    expect(() => CardsSuspendRequestSchema.parse({})).toThrow();
    expect(() => CardsDeleteRequestSchema.parse({})).toThrow();
  });

  it("cards.flag requires a cardId + boolean flagged, with an optional reason", () => {
    const parsed = CardsFlagRequestSchema.parse({
      cardId: "el_1",
      flagged: true,
      reason: "ambiguous pronoun",
    });
    expect(parsed.flagged).toBe(true);
    expect(parsed.reason).toBe("ambiguous pronoun");
    expect(CardsFlagRequestSchema.parse({ cardId: "el_1", flagged: false }).flagged).toBe(false);
    // A non-boolean flag / missing id → rejected.
    expect(() => CardsFlagRequestSchema.parse({ cardId: "el_1", flagged: "yes" })).toThrow();
    expect(() => CardsFlagRequestSchema.parse({ flagged: true })).toThrow();
  });
});

describe("CardsMarkLeechRequestSchema (T040)", () => {
  it("requires a cardId + boolean leech", () => {
    expect(CardsMarkLeechRequestSchema.parse({ cardId: "el_1", leech: true }).leech).toBe(true);
    expect(CardsMarkLeechRequestSchema.parse({ cardId: "el_1", leech: false }).leech).toBe(false);
    expect(() => CardsMarkLeechRequestSchema.parse({ cardId: "el_1", leech: "yes" })).toThrow();
    expect(() => CardsMarkLeechRequestSchema.parse({ leech: true })).toThrow();
  });
});

describe("Review session schemas (T037)", () => {
  it("session.next accepts an empty payload, an exclude list, and an asOf", () => {
    expect(ReviewSessionNextRequestSchema.parse({})).toEqual({});
    const parsed = ReviewSessionNextRequestSchema.parse({
      exclude: ["el_1", "el_2"],
      asOf: "2027-06-01T12:00:00.000Z",
    });
    expect(parsed.exclude).toEqual(["el_1", "el_2"]);
  });

  it("session.next accepts the T039 sibling-burying fields", () => {
    const parsed = ReviewSessionNextRequestSchema.parse({
      exclude: ["el_1"],
      recentSiblingGroups: ["sib_1", "sib_2"],
      burySiblings: false,
    });
    expect(parsed.recentSiblingGroups).toEqual(["sib_1", "sib_2"]);
    expect(parsed.burySiblings).toBe(false);
    // A non-boolean burySiblings is rejected at the boundary.
    expect(() => ReviewSessionNextRequestSchema.parse({ burySiblings: "yes" })).toThrow();
  });

  it("preview requires a cardId", () => {
    expect(ReviewPreviewRequestSchema.parse({ cardId: "el_1" }).cardId).toBe("el_1");
    expect(() => ReviewPreviewRequestSchema.parse({})).toThrow();
  });

  it("grade accepts the four canonical ratings + a non-negative responseMs", () => {
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const parsed = ReviewGradeRequestSchema.parse({ cardId: "el_1", rating, responseMs: 1200 });
      expect(parsed.rating).toBe(rating);
    }
  });

  it("grade rejects an unknown rating, a negative responseMs, and a missing cardId", () => {
    expect(() =>
      ReviewGradeRequestSchema.parse({ cardId: "el_1", rating: "perfect", responseMs: 1 }),
    ).toThrow();
    expect(() =>
      ReviewGradeRequestSchema.parse({ cardId: "el_1", rating: "good", responseMs: -1 }),
    ).toThrow();
    expect(() => ReviewGradeRequestSchema.parse({ rating: "good", responseMs: 1 })).toThrow();
  });

  it("grade rejects a non-parseable asOf clock (no Invalid Date can reach FSRS)", () => {
    // A garbage / empty asOf must be rejected at the boundary, NOT flow through
    // `request.asOf ?? now` into the FSRS grade path where it would persist an
    // Invalid Date into review_states/elements.due_at/the append-only review_logs.
    for (const asOf of ["", "now", "yesterday", "not-a-date", "   "]) {
      expect(() =>
        ReviewGradeRequestSchema.parse({ cardId: "el_1", rating: "good", responseMs: 1, asOf }),
      ).toThrow();
    }
    // A real ISO timestamp still parses (and is trimmed).
    expect(
      ReviewGradeRequestSchema.parse({
        cardId: "el_1",
        rating: "good",
        responseMs: 1,
        asOf: "  2027-06-01T12:00:00.000Z  ",
      }).asOf,
    ).toBe("2027-06-01T12:00:00.000Z");
  });

  it("session.next and preview reject a non-parseable asOf clock", () => {
    expect(() => ReviewSessionNextRequestSchema.parse({ asOf: "garbage" })).toThrow();
    expect(() => ReviewPreviewRequestSchema.parse({ cardId: "el_1", asOf: "" })).toThrow();
  });
});

describe("IsoTimestampInputSchema (asOf clock guard)", () => {
  it("accepts a parseable ISO timestamp and trims it", () => {
    expect(IsoTimestampInputSchema.parse("2027-06-01T12:00:00.000Z")).toBe(
      "2027-06-01T12:00:00.000Z",
    );
    expect(IsoTimestampInputSchema.parse("  2027-06-01T12:00:00.000Z  ")).toBe(
      "2027-06-01T12:00:00.000Z",
    );
  });

  it("rejects empty, whitespace, and unparseable values", () => {
    for (const bad of ["", "   ", "now", "yesterday", "not-a-date", "2027-13-99"]) {
      expect(() => IsoTimestampInputSchema.parse(bad)).toThrow();
    }
  });

  it("rejects an over-long value (bounded length)", () => {
    expect(() =>
      IsoTimestampInputSchema.parse(`2027-06-01T12:00:00.000Z${" ".repeat(64)}x`),
    ).toThrow();
  });
});

describe("QueueListRequestSchema asOf guard", () => {
  it("accepts a parseable asOf and rejects a garbage one", () => {
    expect(QueueListRequestSchema.parse({ asOf: "2027-06-01T12:00:00.000Z" }).asOf).toBe(
      "2027-06-01T12:00:00.000Z",
    );
    expect(() => QueueListRequestSchema.parse({ asOf: "" })).toThrow();
    expect(() => QueueListRequestSchema.parse({ asOf: "soon" })).toThrow();
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

  it("accepts a boolean burySiblings, rejects a non-boolean (T039)", () => {
    expect(SettingsPatchSchema.parse({ burySiblings: false })).toEqual({ burySiblings: false });
    expect(SettingsPatchSchema.parse({ burySiblings: true })).toEqual({ burySiblings: true });
    expect(() => SettingsPatchSchema.parse({ burySiblings: "no" })).toThrow();
  });

  it("accepts a display name, rejects an over-long one (shell identity)", () => {
    expect(SettingsPatchSchema.parse({ displayName: "Ada Lovelace" })).toEqual({
      displayName: "Ada Lovelace",
    });
    expect(SettingsPatchSchema.parse({ displayName: "" })).toEqual({ displayName: "" });
    expect(() => SettingsPatchSchema.parse({ displayName: "x".repeat(65) })).toThrow();
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

describe("LineageGetRequestSchema (T023)", () => {
  it("accepts a non-empty element id", () => {
    expect(LineageGetRequestSchema.parse({ id: "el_123" })).toEqual({ id: "el_123" });
  });

  it("rejects a missing or empty id", () => {
    expect(() => LineageGetRequestSchema.parse({})).toThrow();
    expect(() => LineageGetRequestSchema.parse({ id: "" })).toThrow();
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

  it("accepts optional provenance fields (canonical/original URL, accessed date, snapshot) (T014)", () => {
    const parsed = SourcesImportManualRequestSchema.parse({
      title: "Provenance",
      url: "https://example.com/a?utm_source=x",
      canonicalUrl: "https://example.com/a",
      originalUrl: "https://example.com/a?utm_source=x",
      accessedAt: "2026-05-29T00:00:00.000Z",
      snapshotKey: "assets/sources/abc/original.html",
    });
    expect(parsed.canonicalUrl).toBe("https://example.com/a");
    expect(parsed.originalUrl).toBe("https://example.com/a?utm_source=x");
    expect(parsed.accessedAt).toBe("2026-05-29T00:00:00.000Z");
    expect(parsed.snapshotKey).toBe("assets/sources/abc/original.html");
  });

  it("treats the new provenance fields as optional — a title-only payload still validates (T014)", () => {
    const parsed = SourcesImportManualRequestSchema.parse({ title: "Just a title" });
    expect(parsed.canonicalUrl).toBeUndefined();
    expect(parsed.accessedAt).toBeUndefined();
    expect(parsed.snapshotKey).toBeUndefined();
  });

  it("rejects an over-long canonical URL (T014)", () => {
    expect(() =>
      SourcesImportManualRequestSchema.parse({
        title: "ok",
        canonicalUrl: `https://example.com/${"x".repeat(2100)}`,
      }),
    ).toThrow();
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

describe("DocumentsGetRequestSchema (T015)", () => {
  it("accepts a non-empty elementId", () => {
    expect(DocumentsGetRequestSchema.parse({ elementId: "el_1" })).toEqual({ elementId: "el_1" });
  });

  it("rejects a missing / empty elementId", () => {
    expect(() => DocumentsGetRequestSchema.parse({})).toThrow();
    expect(() => DocumentsGetRequestSchema.parse({ elementId: "" })).toThrow();
  });
});

describe("DocumentsSaveRequestSchema (T015)", () => {
  it("accepts a body with ProseMirror JSON + plain text (no schemaVersion)", () => {
    const json = { type: "doc", content: [{ type: "paragraph" }] };
    const parsed = DocumentsSaveRequestSchema.parse({
      elementId: "el_1",
      prosemirrorJson: json,
      plainText: "",
    });
    expect(parsed.elementId).toBe("el_1");
    expect(parsed.prosemirrorJson).toEqual(json);
    expect(parsed.plainText).toBe("");
    expect(parsed.schemaVersion).toBeUndefined();
  });

  it("accepts an explicit positive integer schemaVersion", () => {
    const parsed = DocumentsSaveRequestSchema.parse({
      elementId: "el_1",
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "hi",
      schemaVersion: 1,
    });
    expect(parsed.schemaVersion).toBe(1);
  });

  it("treats prosemirrorJson as opaque (any JSON value is accepted on the wire)", () => {
    expect(
      DocumentsSaveRequestSchema.parse({ elementId: "el_1", prosemirrorJson: null, plainText: "" })
        .prosemirrorJson,
    ).toBeNull();
  });

  it("rejects a missing elementId, a non-string plainText, and a bad schemaVersion", () => {
    expect(() =>
      DocumentsSaveRequestSchema.parse({ prosemirrorJson: {}, plainText: "x" }),
    ).toThrow();
    expect(() =>
      DocumentsSaveRequestSchema.parse({ elementId: "el_1", prosemirrorJson: {}, plainText: 42 }),
    ).toThrow();
    expect(() =>
      DocumentsSaveRequestSchema.parse({
        elementId: "el_1",
        prosemirrorJson: {},
        plainText: "x",
        schemaVersion: 0,
      }),
    ).toThrow();
    expect(() =>
      DocumentsSaveRequestSchema.parse({
        elementId: "el_1",
        prosemirrorJson: {},
        plainText: "x",
        schemaVersion: 1.5,
      }),
    ).toThrow();
  });

  it("accepts an ordered stable block list (T016)", () => {
    const parsed = DocumentsSaveRequestSchema.parse({
      elementId: "el_1",
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "hi",
      blocks: [
        { blockType: "paragraph", order: 0, stableBlockId: "01J0..." },
        { blockType: "heading", order: 1, stableBlockId: "01J1..." },
      ],
    });
    expect(parsed.blocks).toHaveLength(2);
    expect(parsed.blocks?.[0]?.stableBlockId).toBe("01J0...");
  });

  it("omits blocks cleanly (T015 callers still validate)", () => {
    const parsed = DocumentsSaveRequestSchema.parse({
      elementId: "el_1",
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "",
    });
    expect(parsed.blocks).toBeUndefined();
  });
});

describe("DocumentBlockInputSchema (T016)", () => {
  it("accepts a well-formed block", () => {
    expect(
      DocumentBlockInputSchema.parse({ blockType: "paragraph", order: 0, stableBlockId: "abc" }),
    ).toEqual({ blockType: "paragraph", order: 0, stableBlockId: "abc" });
  });

  it("rejects an empty block type, a negative/non-integer order, and an empty id", () => {
    expect(() =>
      DocumentBlockInputSchema.parse({ blockType: "", order: 0, stableBlockId: "abc" }),
    ).toThrow();
    expect(() =>
      DocumentBlockInputSchema.parse({ blockType: "paragraph", order: -1, stableBlockId: "abc" }),
    ).toThrow();
    expect(() =>
      DocumentBlockInputSchema.parse({ blockType: "paragraph", order: 1.5, stableBlockId: "abc" }),
    ).toThrow();
    expect(() =>
      DocumentBlockInputSchema.parse({ blockType: "paragraph", order: 0, stableBlockId: "" }),
    ).toThrow();
  });
});

describe("ReadPointGetRequestSchema (T017)", () => {
  it("accepts a non-empty elementId", () => {
    expect(ReadPointGetRequestSchema.parse({ elementId: "el_1" })).toEqual({ elementId: "el_1" });
  });

  it("rejects a missing / empty elementId", () => {
    expect(() => ReadPointGetRequestSchema.parse({})).toThrow();
    expect(() => ReadPointGetRequestSchema.parse({ elementId: "" })).toThrow();
  });
});

describe("ReadPointSetRequestSchema (T017)", () => {
  it("accepts a well-formed read-point", () => {
    const parsed = ReadPointSetRequestSchema.parse({
      elementId: "el_1",
      documentId: "el_1",
      blockId: "01J0ABCDEF",
      offset: 42,
    });
    expect(parsed.blockId).toBe("01J0ABCDEF");
    expect(parsed.offset).toBe(42);
  });

  it("accepts a zero offset (start of block)", () => {
    expect(
      ReadPointSetRequestSchema.parse({
        elementId: "el_1",
        documentId: "el_1",
        blockId: "b1",
        offset: 0,
      }).offset,
    ).toBe(0);
  });

  it("rejects a negative offset", () => {
    expect(() =>
      ReadPointSetRequestSchema.parse({
        elementId: "el_1",
        documentId: "el_1",
        blockId: "b1",
        offset: -1,
      }),
    ).toThrow();
  });

  it("rejects a non-integer offset", () => {
    expect(() =>
      ReadPointSetRequestSchema.parse({
        elementId: "el_1",
        documentId: "el_1",
        blockId: "b1",
        offset: 1.5,
      }),
    ).toThrow();
  });

  it("rejects an empty blockId", () => {
    expect(() =>
      ReadPointSetRequestSchema.parse({
        elementId: "el_1",
        documentId: "el_1",
        blockId: "",
        offset: 0,
      }),
    ).toThrow();
  });

  it("rejects a missing elementId or documentId", () => {
    expect(() =>
      ReadPointSetRequestSchema.parse({ documentId: "el_1", blockId: "b1", offset: 0 }),
    ).toThrow();
    expect(() =>
      ReadPointSetRequestSchema.parse({ elementId: "el_1", blockId: "b1", offset: 0 }),
    ).toThrow();
  });
});

describe("DocumentMarksAddRequestSchema (T020)", () => {
  it("accepts a well-formed highlight add", () => {
    const parsed = DocumentMarksAddRequestSchema.parse({
      elementId: "el_1",
      blockId: "b1",
      markType: "highlight",
      range: [4, 12],
    });
    expect(parsed.markType).toBe("highlight");
    expect(parsed.range).toEqual([4, 12]);
  });

  it("accepts each canonical mark type", () => {
    for (const markType of ["highlight", "extracted_span", "processed_span", "cloze"] as const) {
      expect(
        DocumentMarksAddRequestSchema.parse({
          elementId: "el_1",
          blockId: "b1",
          markType,
          range: [0, 1],
        }).markType,
      ).toBe(markType);
    }
  });

  it("rejects an unknown mark type (validated against MARK_TYPES)", () => {
    expect(() =>
      DocumentMarksAddRequestSchema.parse({
        elementId: "el_1",
        blockId: "b1",
        markType: "bogus",
        range: [0, 1],
      }),
    ).toThrow();
  });

  it("rejects a degenerate or negative range", () => {
    expect(() =>
      DocumentMarksAddRequestSchema.parse({
        elementId: "el_1",
        blockId: "b1",
        markType: "highlight",
        range: [5, 5],
      }),
    ).toThrow();
    expect(() =>
      DocumentMarksAddRequestSchema.parse({
        elementId: "el_1",
        blockId: "b1",
        markType: "highlight",
        range: [-1, 3],
      }),
    ).toThrow();
  });

  it("rejects a missing elementId / blockId", () => {
    expect(() =>
      DocumentMarksAddRequestSchema.parse({ blockId: "b1", markType: "highlight", range: [0, 1] }),
    ).toThrow();
    expect(() =>
      DocumentMarksAddRequestSchema.parse({
        elementId: "el_1",
        markType: "highlight",
        range: [0, 1],
      }),
    ).toThrow();
  });
});

describe("DocumentMarksRemoveRequestSchema (T020)", () => {
  it("accepts a non-empty mark id and rejects an empty one", () => {
    expect(DocumentMarksRemoveRequestSchema.parse({ markId: "m_1" })).toEqual({ markId: "m_1" });
    expect(() => DocumentMarksRemoveRequestSchema.parse({ markId: "" })).toThrow();
  });
});

describe("DocumentMarksListRequestSchema (T020)", () => {
  it("accepts an elementId, optionally filtered by mark type", () => {
    expect(DocumentMarksListRequestSchema.parse({ elementId: "el_1" })).toEqual({
      elementId: "el_1",
    });
    expect(
      DocumentMarksListRequestSchema.parse({ elementId: "el_1", markType: "highlight" }).markType,
    ).toBe("highlight");
  });

  it("rejects a bad mark-type filter", () => {
    expect(() =>
      DocumentMarksListRequestSchema.parse({ elementId: "el_1", markType: "bogus" }),
    ).toThrow();
  });
});

describe("ExtractionCreateRequestSchema (T021)", () => {
  it("accepts a minimal top-level extraction (source + selection + one block)", () => {
    const parsed = ExtractionCreateRequestSchema.parse({
      sourceElementId: "el_src",
      selectedText: "Intelligence is …",
      blockIds: ["blk_def_p1"],
    });
    expect(parsed.sourceElementId).toBe("el_src");
    expect(parsed.blockIds).toEqual(["blk_def_p1"]);
    expect(parsed.parentId).toBeUndefined();
  });

  it("accepts an explicit parentId (a sub-extract, T025), offsets, label, and priority", () => {
    const parsed = ExtractionCreateRequestSchema.parse({
      sourceElementId: "el_src",
      parentId: "el_extract",
      selectedText: "a narrower clause",
      blockIds: ["blk_x", "blk_y"],
      startOffset: 3,
      endOffset: 20,
      label: "¶4",
      priority: "A",
    });
    expect(parsed.parentId).toBe("el_extract");
    expect(parsed.startOffset).toBe(3);
    expect(parsed.priority).toBe("A");
  });

  it("rejects a missing source, an empty selection, an empty block list, and a bad priority", () => {
    expect(() =>
      ExtractionCreateRequestSchema.parse({ selectedText: "x", blockIds: ["b1"] }),
    ).toThrow();
    expect(() =>
      ExtractionCreateRequestSchema.parse({
        sourceElementId: "el_src",
        selectedText: "",
        blockIds: ["b1"],
      }),
    ).toThrow();
    expect(() =>
      ExtractionCreateRequestSchema.parse({
        sourceElementId: "el_src",
        selectedText: "x",
        blockIds: [],
      }),
    ).toThrow();
    expect(() =>
      ExtractionCreateRequestSchema.parse({
        sourceElementId: "el_src",
        selectedText: "x",
        blockIds: ["b1"],
        priority: "Z",
      }),
    ).toThrow();
  });

  it("rejects negative offsets", () => {
    expect(() =>
      ExtractionCreateRequestSchema.parse({
        sourceElementId: "el_src",
        selectedText: "x",
        blockIds: ["b1"],
        startOffset: -1,
      }),
    ).toThrow();
  });
});

describe("ExtractsUpdateStageRequestSchema (T024)", () => {
  it("accepts an id with no stage (advance one step)", () => {
    expect(ExtractsUpdateStageRequestSchema.parse({ id: "el_ex" })).toEqual({ id: "el_ex" });
  });

  it("accepts each explicit extract stage", () => {
    for (const stage of ["raw_extract", "clean_extract", "atomic_statement"] as const) {
      expect(ExtractsUpdateStageRequestSchema.parse({ id: "el_ex", stage }).stage).toBe(stage);
    }
  });

  it("rejects a non-extract stage and a missing id", () => {
    expect(() =>
      ExtractsUpdateStageRequestSchema.parse({ id: "el_ex", stage: "card_draft" }),
    ).toThrow();
    expect(() => ExtractsUpdateStageRequestSchema.parse({ stage: "raw_extract" })).toThrow();
    expect(() => ExtractsUpdateStageRequestSchema.parse({ id: "" })).toThrow();
  });
});

describe("ExtractsRewriteRequestSchema (T024)", () => {
  it("accepts a rewrite with body + plain text (no blocks)", () => {
    const parsed = ExtractsRewriteRequestSchema.parse({
      id: "el_ex",
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "trimmed body",
    });
    expect(parsed.id).toBe("el_ex");
    expect(parsed.plainText).toBe("trimmed body");
    expect(parsed.blocks).toBeUndefined();
  });

  it("accepts an ordered stable block list", () => {
    const parsed = ExtractsRewriteRequestSchema.parse({
      id: "el_ex",
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "body",
      blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "blk_1" }],
    });
    expect(parsed.blocks).toHaveLength(1);
  });

  it("rejects a missing id and a non-string plainText", () => {
    expect(() =>
      ExtractsRewriteRequestSchema.parse({ prosemirrorJson: {}, plainText: "x" }),
    ).toThrow();
    expect(() =>
      ExtractsRewriteRequestSchema.parse({ id: "el_ex", prosemirrorJson: {}, plainText: 42 }),
    ).toThrow();
  });
});

describe("Extracts postpone/markDone/delete request schemas (T024)", () => {
  it("each accepts a non-empty id and rejects an empty one", () => {
    for (const schema of [
      ExtractsPostponeRequestSchema,
      ExtractsMarkDoneRequestSchema,
      ExtractsDeleteRequestSchema,
    ]) {
      expect(schema.parse({ id: "el_ex" })).toEqual({ id: "el_ex" });
      expect(() => schema.parse({ id: "" })).toThrow();
      expect(() => schema.parse({})).toThrow();
    }
  });
});

describe("Concept request schemas (T041)", () => {
  it("ConceptsCreateRequestSchema accepts a name and an optional parent, trims, and rejects empty/oversized names", () => {
    expect(ConceptsCreateRequestSchema.parse({ name: "Cognition" })).toEqual({ name: "Cognition" });
    expect(ConceptsCreateRequestSchema.parse({ name: "  Memory  " }).name).toBe("Memory");
    expect(
      ConceptsCreateRequestSchema.parse({ name: "Intelligence", parentConceptId: "el_parent" }),
    ).toEqual({ name: "Intelligence", parentConceptId: "el_parent" });
    expect(
      ConceptsCreateRequestSchema.parse({ name: "X", parentConceptId: null }).parentConceptId,
    ).toBeNull();

    expect(() => ConceptsCreateRequestSchema.parse({ name: "" })).toThrow();
    expect(() => ConceptsCreateRequestSchema.parse({ name: "   " })).toThrow();
    expect(() => ConceptsCreateRequestSchema.parse({ name: "x".repeat(257) })).toThrow();
    expect(() => ConceptsCreateRequestSchema.parse({})).toThrow();
  });

  it("ConceptsAssign/UnassignRequestSchema require both ids", () => {
    for (const schema of [ConceptsAssignRequestSchema, ConceptsUnassignRequestSchema]) {
      expect(schema.parse({ elementId: "el_a", conceptId: "el_c" })).toEqual({
        elementId: "el_a",
        conceptId: "el_c",
      });
      expect(() => schema.parse({ elementId: "el_a" })).toThrow();
      expect(() => schema.parse({ conceptId: "el_c" })).toThrow();
      expect(() => schema.parse({ elementId: "", conceptId: "el_c" })).toThrow();
    }
  });

  it("ConceptsMembersRequestSchema accepts a valid conceptId and rejects a missing/empty one (/concepts drill-in)", () => {
    expect(ConceptsMembersRequestSchema.parse({ conceptId: "el_c" })).toEqual({
      conceptId: "el_c",
    });
    expect(() => ConceptsMembersRequestSchema.parse({})).toThrow();
    expect(() => ConceptsMembersRequestSchema.parse({ conceptId: "" })).toThrow();
    expect(() => ConceptsMembersRequestSchema.parse({ conceptId: 42 })).toThrow();
  });
});

describe("Tag request schemas (T041)", () => {
  it("TagsAdd/RemoveRequestSchema accept an id + tag, trim, and reject empty/oversized tags", () => {
    for (const schema of [TagsAddRequestSchema, TagsRemoveRequestSchema]) {
      expect(schema.parse({ elementId: "el_a", tag: "memory" })).toEqual({
        elementId: "el_a",
        tag: "memory",
      });
      expect(schema.parse({ elementId: "el_a", tag: "  memory  " }).tag).toBe("memory");
      expect(() => schema.parse({ elementId: "el_a", tag: "" })).toThrow();
      expect(() => schema.parse({ elementId: "el_a", tag: "x".repeat(257) })).toThrow();
      expect(() => schema.parse({ elementId: "", tag: "memory" })).toThrow();
    }
  });
});

describe("Search request schema (T042)", () => {
  it("SearchQueryRequestSchema accepts a query + optional type/concept/tag/limit and rejects bad values", () => {
    expect(SearchQueryRequestSchema.parse({ q: "memory" })).toEqual({ q: "memory" });
    expect(
      SearchQueryRequestSchema.parse({
        q: "memory",
        type: "extract",
        conceptId: "el_c",
        tag: "definitions",
        limit: 10,
      }),
    ).toEqual({ q: "memory", type: "extract", conceptId: "el_c", tag: "definitions", limit: 10 });

    // An empty query is allowed (it degrades to [] main-side), but only the
    // searchable types are accepted, and the limit is bounded.
    expect(SearchQueryRequestSchema.parse({ q: "" }).q).toBe("");
    expect(() => SearchQueryRequestSchema.parse({ q: "x", type: "topic" })).toThrow();
    expect(() => SearchQueryRequestSchema.parse({ q: "x", limit: 0 })).toThrow();
    expect(() => SearchQueryRequestSchema.parse({ q: "x", limit: 999 })).toThrow();
    expect(() => SearchQueryRequestSchema.parse({ q: "x".repeat(513) })).toThrow();
    expect(() => SearchQueryRequestSchema.parse({})).toThrow();
  });
});

describe("Library browse request schema (Library route)", () => {
  it("accepts an EMPTY request (the browse-first default — no keyword required)", () => {
    // Unlike search, an empty request is valid and means "browse everything".
    expect(LibraryBrowseRequestSchema.parse({})).toEqual({});
  });

  it("accepts the type/concept/priority/status/limit facets", () => {
    expect(
      LibraryBrowseRequestSchema.parse({
        types: ["source", "topic", "synthesis_note", "task"],
        conceptId: "el_c",
        priorityLabel: "A",
        statuses: ["active", "inbox"],
        limit: 100,
      }),
    ).toEqual({
      types: ["source", "topic", "synthesis_note", "task"],
      conceptId: "el_c",
      priorityLabel: "A",
      statuses: ["active", "inbox"],
      limit: 100,
    });
  });

  it("covers the non-FTS browsable types that search rejects (topic/synthesis_note/task)", () => {
    // These are exactly the types keyword search cannot return — browse must accept them.
    expect(LibraryBrowseRequestSchema.parse({ types: ["topic"] }).types).toEqual(["topic"]);
    expect(LibraryBrowseRequestSchema.parse({ types: ["synthesis_note"] }).types).toEqual([
      "synthesis_note",
    ]);
    expect(LibraryBrowseRequestSchema.parse({ types: ["task"] }).types).toEqual(["task"]);
  });

  it("rejects a non-element type, a bad priority label, a bad status, and an out-of-range limit", () => {
    // `concept` is NOT browsable (it is a facet column), and `media_fragment` has no
    // MVP reader target — both are outside the browse enum.
    expect(() => LibraryBrowseRequestSchema.parse({ types: ["concept"] })).toThrow();
    expect(() => LibraryBrowseRequestSchema.parse({ types: ["media_fragment"] })).toThrow();
    expect(() => LibraryBrowseRequestSchema.parse({ priorityLabel: "Z" })).toThrow();
    expect(() => LibraryBrowseRequestSchema.parse({ statuses: ["not-a-status"] })).toThrow();
    expect(() => LibraryBrowseRequestSchema.parse({ limit: 0 })).toThrow();
    expect(() => LibraryBrowseRequestSchema.parse({ limit: 999 })).toThrow();
  });
});

describe("AnalyticsGetRequestSchema (T045)", () => {
  it("accepts an empty/absent request (defaults applied main-side)", () => {
    expect(AnalyticsGetRequestSchema.parse(undefined)).toBeUndefined();
    expect(AnalyticsGetRequestSchema.parse({})).toEqual({});
  });

  it("accepts an explicit asOf + windowDays and rejects out-of-range values", () => {
    expect(
      AnalyticsGetRequestSchema.parse({ asOf: "2026-05-30T00:00:00.000Z", windowDays: 7 }),
    ).toEqual({ asOf: "2026-05-30T00:00:00.000Z", windowDays: 7 });
    expect(() => AnalyticsGetRequestSchema.parse({ windowDays: 0 })).toThrow();
    expect(() => AnalyticsGetRequestSchema.parse({ windowDays: 400 })).toThrow();
    expect(() => AnalyticsGetRequestSchema.parse({ windowDays: 1.5 })).toThrow();
    expect(() => AnalyticsGetRequestSchema.parse({ asOf: "" })).toThrow();
  });
});

describe("BalanceGetRequestSchema (T046)", () => {
  it("accepts an empty/absent request (defaults applied main-side)", () => {
    expect(BalanceGetRequestSchema.parse(undefined)).toBeUndefined();
    expect(BalanceGetRequestSchema.parse({})).toEqual({});
  });

  it("accepts an explicit asOf + windowDays and rejects out-of-range values", () => {
    expect(
      BalanceGetRequestSchema.parse({ asOf: "2026-05-30T00:00:00.000Z", windowDays: 7 }),
    ).toEqual({ asOf: "2026-05-30T00:00:00.000Z", windowDays: 7 });
    expect(() => BalanceGetRequestSchema.parse({ windowDays: 0 })).toThrow();
    expect(() => BalanceGetRequestSchema.parse({ windowDays: 400 })).toThrow();
    expect(() => BalanceGetRequestSchema.parse({ asOf: "" })).toThrow();
  });
});

describe("BackupsCreateRequestSchema (T047)", () => {
  it("takes no arguments (void request)", () => {
    expect(BackupsCreateRequestSchema.parse(undefined)).toBeUndefined();
    expect(() => BackupsCreateRequestSchema.parse({ anything: true })).toThrow();
  });
});
