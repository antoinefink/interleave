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
  DocumentBlockInputSchema,
  DocumentMarksAddRequestSchema,
  DocumentMarksListRequestSchema,
  DocumentMarksRemoveRequestSchema,
  DocumentsGetRequestSchema,
  DocumentsSaveRequestSchema,
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
  LineageGetRequestSchema,
  ReadPointGetRequestSchema,
  ReadPointSetRequestSchema,
  SettingKeySchema,
  SettingsGetRequestSchema,
  SettingsPatchSchema,
  SettingsUpdateManyRequestSchema,
  SettingsUpdateRequestSchema,
  SourcesImportManualRequestSchema,
} from "./contract";

describe("IPC channels", () => {
  it("exposes exactly the M1 commands plus the M2 inbox mutation + M3 document/read-point + M4 marks/extraction/lineage/extract-review surface and no generic SQL channel", () => {
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
        "lineage:get",
        "sources:importManual",
        "inbox:list",
        "inbox:get",
        "inbox:triage",
        "documents:get",
        "documents:save",
        "documents:marks:add",
        "documents:marks:remove",
        "documents:marks:list",
        "extractions:create",
        "extracts:updateStage",
        "extracts:rewrite",
        "extracts:postpone",
        "extracts:markDone",
        "extracts:delete",
        "readPoint:get",
        "readPoint:set",
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
