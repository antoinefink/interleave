/**
 * IPC contract validation tests (T007).
 *
 * The security posture depends on the main side rejecting malformed renderer
 * payloads, so these assert the Zod schemas accept valid requests and reject
 * invalid ones, and that the channel set is exactly the four M1 commands (no
 * generic `db.query`).
 */

import { MAX_REVIEW_MODE_DECK } from "@interleave/core";
import { describe, expect, it } from "vitest";
import {
  AnalyticsGetRequestSchema,
  AnalyticsReviewActivityRequestSchema,
  type BackupArtifact,
  BackupsCreateRequestSchema,
  BackupsListRequestSchema,
  type BackupsListResult,
  BackupsOpenFolderRequestSchema,
  type BackupsPickArchiveResult,
  BackupsResetLocalDataRequestSchema,
  type BackupsResetLocalDataResult,
  BackupsRestoreFileRequestSchema,
  BackupsRestoreRequestSchema,
  type BackupsRestoreResult,
  BackupTimestampSchema,
  BalanceGetRequestSchema,
  CaptureGetPairingRequestSchema,
  CaptureRegenerateTokenRequestSchema,
  CaptureSetEnabledRequestSchema,
  CardsCreateRequestSchema,
  CardsDeleteRequestSchema,
  CardsExportAnkiRequestSchema,
  type CardsExportAnkiResult,
  CardsFlagRequestSchema,
  CardsGenerateOcclusionRequestSchema,
  type CardsGenerateOcclusionResult,
  CardsImportAnkiRequestSchema,
  type CardsImportAnkiResult,
  CardsMarkLeechRequestSchema,
  CardsRetireRequestSchema,
  CardsSiblingAnswersRequestSchema,
  CardsSuspendRequestSchema,
  CardsUnretireRequestSchema,
  CardsUpdateRequestSchema,
  ConceptsAssignRequestSchema,
  ConceptsCreateRequestSchema,
  ConceptsMembersRequestSchema,
  ConceptsUnassignRequestSchema,
  DocumentBlockInputSchema,
  DocumentMarksAddRequestSchema,
  DocumentMarksListRequestSchema,
  DocumentMarksRemoveRequestSchema,
  DocumentsExportMarkdownRequestSchema,
  type DocumentsExportMarkdownResult,
  DocumentsGetRequestSchema,
  DocumentsSaveRequestSchema,
  ElementsSetPriorityRequestSchema,
  ExtractionCreateRequestSchema,
  ExtractStagnationListRequestSchema,
  ExtractsDeleteRequestSchema,
  ExtractsMarkDoneRequestSchema,
  ExtractsPostponeRequestSchema,
  ExtractsReactivateFateRequestSchema,
  ExtractsRewriteRequestSchema,
  ExtractsSetFateRequestSchema,
  ExtractsUpdateStageRequestSchema,
  InboxGetRequestSchema,
  InboxTriageRequestSchema,
  InspectorGetRequestSchema,
  IPC_CHANNELS,
  IsoTimestampInputSchema,
  type JobSummary,
  JobsListRequestSchema,
  type JobsListResult,
  LibraryBrowseRequestSchema,
  LibraryParkedActionRequestSchema,
  LineageGetRequestSchema,
  MaintenanceBulkArchiveRequestSchema,
  MaintenanceBulkPostponeRequestSchema,
  MaintenanceBulkTrashRequestSchema,
  MaintenanceDedupeRequestSchema,
  MaintenanceIntegrityRequestSchema,
  MaintenanceLowValueRequestSchema,
  MaintenanceOrphanMediaRequestSchema,
  MaintenanceParkedResurfacingApplyRequestSchema,
  MaintenanceParkedResurfacingRequestSchema,
  MaintenanceReportRequestSchema,
  MediaRefSchema,
  PickImportFileRequestSchema,
  QueueActRequestSchema,
  QueueAutoPostponeRequestSchema,
  QueueCatchUpRequestSchema,
  QueueListRequestSchema,
  QueueScheduleRequestSchema,
  QueueUndoRequestSchema,
  QueueVacationRequestSchema,
  ReadPointGetRequestSchema,
  ReadPointSetRequestSchema,
  ReviewGradeRequestSchema,
  ReviewModeCountRequestSchema,
  ReviewModeDeckRequestSchema,
  ReviewModeSelectorSchema,
  ReviewPreviewRequestSchema,
  ReviewSessionNextRequestSchema,
  SearchQueryRequestSchema,
  type SearchQueryResult,
  SemanticContradictionsRequestSchema,
  SemanticReindexRequestSchema,
  SemanticRelatedRequestSchema,
  SemanticSearchModeSchema,
  SemanticSearchRequestSchema,
  type SemanticSearchResult,
  SemanticStatusRequestSchema,
  SettingKeySchema,
  SettingsGetRequestSchema,
  SettingsPatchSchema,
  SettingsUpdateManyRequestSchema,
  SettingsUpdateRequestSchema,
  SourcesAcceptOcrRequestSchema,
  SourcesDismissRetirementSuggestionRequestSchema,
  SourcesExtractClipRequestSchemaRefined,
  SourcesExtractRegionRequestSchema,
  SourcesGetMediaDataRequestSchema,
  type SourcesGetMediaDataResult,
  SourcesGetOcrRequestSchema,
  SourcesGetPdfDataRequestSchema,
  SourcesGetRegionImageRequestSchema,
  SourcesImportDocumentRequestSchema,
  type SourcesImportDocumentResult,
  SourcesImportEpubRequestSchema,
  type SourcesImportEpubResult,
  SourcesImportHighlightsRequestSchema,
  type SourcesImportHighlightsResult,
  SourcesImportManualRequestSchema,
  SourcesImportMarkdownTextRequestSchema,
  SourcesImportMediaRequestSchema,
  type SourcesImportMediaResult,
  SourcesImportPdfRequestSchema,
  type SourcesImportPdfResult,
  type SourcesImportUrlRequest,
  SourcesImportUrlRequestSchema,
  type SourcesImportUrlResult,
  SourcesRunOcrRequestSchema,
  SourceYieldListRequestSchema,
  SynthesisCreateRequestSchema,
  SynthesisEditBodyRequestSchema,
  SynthesisGetRequestSchema,
  SynthesisLinkRequestSchema,
  SynthesisScheduleReturnRequestSchema,
  SynthesisUnlinkRequestSchema,
  TagsAddRequestSchema,
  TagsRemoveRequestSchema,
  TasksCompleteRequestSchema,
  TasksCreateRequestSchema,
  TasksGenerateFromExpiryRequestSchema,
  TasksListRequestSchema,
  TasksPostponeRequestSchema,
  VaultCollectOrphansRequestSchema,
  type VaultCollectOrphansResult,
  type VaultOrphansResult,
  type VaultVerifyResult,
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
        "sourceYield:list",
        "extractStagnation:list",
        "inspector:list",
        "inspector:get",
        "elements:setPriority",
        "queue:list",
        "queue:act",
        "queue:schedule",
        "queue:undo",
        "queue:autoPostpone",
        "queue:autoPostpone:apply",
        "queue:catchUp",
        "queue:catchUp:apply",
        "queue:vacation",
        "queue:vacation:apply",
        "lineage:get",
        "sources:importManual",
        "sources:updateReliability",
        "sources:dismissRetirementSuggestion",
        "sources:importUrl",
        "sources:importPdf",
        "sources:getPdfData",
        "sources:pickImportFile",
        "sources:importEpub",
        "sources:importMedia",
        "sources:getMediaData",
        "sources:importDocument",
        "sources:importMarkdownText",
        "sources:importHighlights",
        "sources:extractRegion",
        "sources:getRegionImage",
        "sources:extractClip",
        "sources:openReader",
        "sources:runOcr",
        "sources:getOcr",
        "sources:acceptOcr",
        "sources:dismissOcr",
        "ai:run",
        "ai:list",
        "ai:approveCard",
        "ai:dismiss",
        "ai:status",
        "ai:downloadModel",
        "capture:getPairing",
        "capture:regenerateToken",
        "capture:setEnabled",
        "inbox:list",
        "inbox:get",
        "inbox:triage",
        "documents:get",
        "documents:save",
        "documents:exportMarkdown",
        "documents:marks:add",
        "documents:marks:remove",
        "documents:marks:list",
        "blockProcessing:list",
        "blockProcessing:summary",
        "blockProcessing:markIgnored",
        "blockProcessing:markProcessed",
        "blockProcessing:markNeedsLater",
        "blockProcessing:markUnread",
        "extractions:create",
        "cards:create",
        "cards:generateOcclusion",
        "cards:update",
        "cards:suspend",
        "cards:delete",
        "cards:flag",
        "cards:markLeech",
        "cards:split",
        "cards:addContext",
        "cards:backToExtract",
        "cards:retire",
        "cards:unretire",
        "cards:retired",
        "cards:setLifetime",
        "cards:siblingAnswers",
        "cards:importAnki",
        "cards:exportAnki",
        "extracts:updateStage",
        "extracts:rewrite",
        "extracts:postpone",
        "extracts:markDone",
        "extracts:setFate",
        "extracts:reactivateFate",
        "extracts:delete",
        "review:session:next",
        "review:card",
        "review:preview",
        "review:grade",
        "review:leeches",
        "review:mode:deck",
        "review:mode:count",
        "concepts:create",
        "concepts:list",
        "concepts:assign",
        "concepts:unassign",
        "concepts:members",
        "tasks:create",
        "tasks:list",
        "tasks:complete",
        "tasks:postpone",
        "tasks:generateFromExpiry",
        "synthesis:create",
        "synthesis:link",
        "synthesis:unlink",
        "synthesis:editBody",
        "synthesis:scheduleReturn",
        "synthesis:get",
        "retention:get",
        "retention:setBand",
        "retention:setBandEnabled",
        "retention:setConcept",
        "retention:setCard",
        "retention:resolveFor",
        "optimization:suggest",
        "optimization:apply",
        "workload:simulate",
        "tags:list",
        "tags:add",
        "tags:remove",
        "search:query",
        "semantic:search",
        "semantic:status",
        "semantic:reindex",
        "semantic:downloadModel",
        "semantic:related",
        "semantic:contradictions",
        "library:browse",
        "library:parkedAction",
        "readPoint:get",
        "readPoint:set",
        "trash:list",
        "trash:restore",
        "trash:purge",
        "trash:empty",
        "undo:last",
        "analytics:get",
        "analytics:reviewActivity",
        "balance:get",
        "dailyWork:summary",
        "backups:create",
        "backups:openFolder",
        "backups:list",
        "backups:restore",
        "backups:pickArchive",
        "backups:restoreFile",
        "backups:resetLocalData",
        "jobs:list",
        "jobs:updated",
        "vault:verify",
        "vault:findOrphans",
        "vault:collectOrphans",
        "maintenance:report",
        "maintenance:duplicates",
        "maintenance:cardsWithoutSources",
        "maintenance:brokenSources",
        "maintenance:schedulerConsistency",
        "maintenance:integrity",
        "maintenance:lowValue",
        "maintenance:dedupe",
        "maintenance:orphanMedia",
        "maintenance:bulkTrash",
        "maintenance:bulkArchive",
        "maintenance:bulkPostpone",
        "maintenance:parkedResurfacing",
        "maintenance:parkedResurfacing:apply",
        "menu:showShortcuts",
        "menu:createBackup",
      ].sort(),
    );
    expect(Object.values(IPC_CHANNELS)).not.toContain("db:query");
    // T058: the renderer enqueues ONLY via `sources:importUrl` — there is no
    // generic `jobs:enqueue` channel.
    expect(Object.values(IPC_CHANNELS)).not.toContain("jobs:enqueue");
  });
});

describe("Mature-card retirement schemas (T082)", () => {
  it("accepts a retire request with an optional reason + lowRetention lever", () => {
    expect(CardsRetireRequestSchema.parse({ cardId: "card-1" })).toEqual({ cardId: "card-1" });
    const full = CardsRetireRequestSchema.parse({
      cardId: "card-1",
      reason: "Low-value",
      lowRetention: true,
    });
    expect(full.reason).toBe("Low-value");
    expect(full.lowRetention).toBe(true);
  });

  it("rejects a retire/unretire request without a cardId", () => {
    expect(CardsRetireRequestSchema.safeParse({}).success).toBe(false);
    expect(CardsUnretireRequestSchema.safeParse({}).success).toBe(false);
  });

  it("accepts a minimal unretire request", () => {
    expect(CardsUnretireRequestSchema.parse({ cardId: "card-1" })).toEqual({ cardId: "card-1" });
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

describe("SourcesImportPdfRequestSchema (T064)", () => {
  it("accepts an empty request (the picker carries no path)", () => {
    const parsed = SourcesImportPdfRequestSchema.parse({});
    expect(parsed.priority).toBeUndefined();
    expect(parsed.reasonAdded).toBeUndefined();
  });

  it("accepts an optional priority + reason", () => {
    const parsed = SourcesImportPdfRequestSchema.parse({ priority: "B", reasonAdded: "a paper" });
    expect(parsed.priority).toBe("B");
    expect(parsed.reasonAdded).toBe("a paper");
  });

  it("rejects an invalid priority", () => {
    expect(() => SourcesImportPdfRequestSchema.parse({ priority: "Z" })).toThrow();
  });

  it("the result discriminates imported vs cancelled", () => {
    const imported: SourcesImportPdfResult = {
      status: "imported",
      id: "el_pdf",
      item: {
        id: "el_pdf",
        type: "source",
        status: "inbox",
        stage: "raw_source",
        priority: 0.4,
        title: "A PDF",
        srcType: "Manual note",
        author: null,
        accessedAt: "2026-06-01T00:00:00.000Z",
        charCount: 10,
        previewSnippet: "Page 1",
      },
    };
    const cancelled: SourcesImportPdfResult = { status: "cancelled" };
    expect(imported.status).toBe("imported");
    if (imported.status === "imported") expect(imported.id).toBe("el_pdf");
    expect(cancelled.status).toBe("cancelled");
  });

  it("SourcesGetPdfDataRequestSchema requires an elementId", () => {
    expect(SourcesGetPdfDataRequestSchema.parse({ elementId: "el_1" }).elementId).toBe("el_1");
    expect(() => SourcesGetPdfDataRequestSchema.parse({})).toThrow();
  });
});

describe("EPUB import schemas (T067)", () => {
  it("PickImportFileRequestSchema accepts the known kinds + rejects others", () => {
    expect(PickImportFileRequestSchema.parse({ kind: "epub" }).kind).toBe("epub");
    expect(PickImportFileRequestSchema.parse({ kind: "anki" }).kind).toBe("anki");
    // T073 extends the picker with the media + subtitles kinds.
    expect(PickImportFileRequestSchema.parse({ kind: "media" }).kind).toBe("media");
    expect(PickImportFileRequestSchema.parse({ kind: "subtitles" }).kind).toBe("subtitles");
    expect(() => PickImportFileRequestSchema.parse({ kind: "pdf" })).toThrow();
    expect(() => PickImportFileRequestSchema.parse({})).toThrow();
  });

  it("SourcesImportEpubRequestSchema requires a non-empty path + optional priority/reason", () => {
    const parsed = SourcesImportEpubRequestSchema.parse({
      path: "/tmp/book.epub",
      priority: "C",
      reasonAdded: "to read",
    });
    expect(parsed.path).toBe("/tmp/book.epub");
    expect(parsed.priority).toBe("C");
    expect(parsed.reasonAdded).toBe("to read");
    expect(() => SourcesImportEpubRequestSchema.parse({ path: "" })).toThrow();
    expect(() =>
      SourcesImportEpubRequestSchema.parse({ path: "/x.epub", priority: "Z" }),
    ).toThrow();
  });

  it("SourcesImportEpubResult round-trips the imported shape", () => {
    const result: SourcesImportEpubResult = {
      status: "imported",
      bookId: "el_book",
      chapterCount: 3,
      item: {
        id: "el_book",
        type: "source",
        status: "inbox",
        stage: "raw_source",
        priority: 0.4,
        title: "A Book",
        srcType: "Manual note",
        author: "An Author",
        accessedAt: "2026-06-01T00:00:00.000Z",
        charCount: 10,
        previewSnippet: "Title",
      },
    };
    expect(result.status).toBe("imported");
    expect(result.bookId).toBe("el_book");
    expect(result.chapterCount).toBe(3);
  });
});

describe("Media import schemas (T073)", () => {
  it("SourcesImportMediaRequestSchema requires a path + optional sidecar/priority/reason", () => {
    const parsed = SourcesImportMediaRequestSchema.parse({
      path: "/tmp/talk.mp4",
      subtitlesPath: "/tmp/talk.vtt",
      priority: "B",
      reasonAdded: "a lecture",
    });
    expect(parsed.path).toBe("/tmp/talk.mp4");
    expect(parsed.subtitlesPath).toBe("/tmp/talk.vtt");
    expect(parsed.priority).toBe("B");
    // The sidecar is optional + nullable; the path is required + non-empty.
    expect(SourcesImportMediaRequestSchema.parse({ path: "/x.mp4" }).subtitlesPath).toBeUndefined();
    expect(
      SourcesImportMediaRequestSchema.parse({ path: "/x.mp4", subtitlesPath: null }).subtitlesPath,
    ).toBeNull();
    expect(() => SourcesImportMediaRequestSchema.parse({ path: "" })).toThrow();
    expect(() =>
      SourcesImportMediaRequestSchema.parse({ path: "/x.mp4", priority: "Z" }),
    ).toThrow();
  });

  it("SourcesImportMediaResult round-trips the imported shape", () => {
    const result: SourcesImportMediaResult = {
      status: "imported",
      id: "el_media",
      item: {
        id: "el_media",
        type: "source",
        status: "inbox",
        stage: "raw_source",
        priority: 0.4,
        title: "A Talk",
        srcType: "Manual note",
        author: null,
        accessedAt: "2026-06-01T00:00:00.000Z",
        charCount: 10,
        previewSnippet: "A Talk",
      },
      mediaKind: "video",
      hasTranscript: true,
    };
    expect(result.status).toBe("imported");
    expect(result.mediaKind).toBe("video");
    expect(result.hasTranscript).toBe(true);
  });

  it("SourcesGetMediaDataRequestSchema requires an elementId", () => {
    expect(SourcesGetMediaDataRequestSchema.parse({ elementId: "el_1" }).elementId).toBe("el_1");
    expect(() => SourcesGetMediaDataRequestSchema.parse({})).toThrow();
  });

  it("SourcesGetMediaDataResult round-trips both local + youtube shapes", () => {
    const local: SourcesGetMediaDataResult = {
      mediaSource: "local",
      mediaKind: "video",
      mediaUrl: "media://el_media",
      mime: "video/mp4",
      youtubeId: null,
      durationMs: 1000,
    };
    const youtube: SourcesGetMediaDataResult = {
      mediaSource: "youtube",
      mediaKind: null,
      mediaUrl: null,
      mime: null,
      youtubeId: "dQw4w9WgXcQ",
      durationMs: null,
    };
    expect(local.mediaUrl).toBe("media://el_media");
    expect(youtube.youtubeId).toBe("dQw4w9WgXcQ");
  });
});

describe("Highlight import schemas (T069)", () => {
  it("PickImportFileRequestSchema accepts the highlights kind", () => {
    expect(PickImportFileRequestSchema.parse({ kind: "highlights" }).kind).toBe("highlights");
  });

  it("SourcesImportHighlightsRequestSchema requires a path + optional format/priority", () => {
    const parsed = SourcesImportHighlightsRequestSchema.parse({
      path: "/tmp/clippings.txt",
      format: "kindle_clippings",
      priority: "C",
    });
    expect(parsed.path).toBe("/tmp/clippings.txt");
    expect(parsed.format).toBe("kindle_clippings");
    expect(parsed.priority).toBe("C");
    // A bare path is valid (format auto-detected main-side).
    expect(SourcesImportHighlightsRequestSchema.parse({ path: "/x.csv" }).format).toBeUndefined();
  });

  it("SourcesImportHighlightsRequestSchema rejects bad payloads", () => {
    expect(() => SourcesImportHighlightsRequestSchema.parse({ path: "" })).toThrow();
    expect(() =>
      SourcesImportHighlightsRequestSchema.parse({ path: "/x.csv", format: "csv" }),
    ).toThrow();
    expect(() =>
      SourcesImportHighlightsRequestSchema.parse({ path: "/x.csv", priority: "Z" }),
    ).toThrow();
  });

  it("SourcesImportHighlightsResult round-trips the imported shape (counts + items)", () => {
    const result: SourcesImportHighlightsResult = {
      status: "imported",
      format: "readwise_csv",
      sourceCount: 2,
      extractCount: 5,
      skipped: 1,
      items: [
        {
          id: "el_src",
          type: "source",
          status: "inbox",
          stage: "raw_source",
          priority: 0.4,
          title: "A Book",
          srcType: "Manual note",
          author: "An Author",
          accessedAt: "2026-06-01T00:00:00.000Z",
          charCount: 4,
          previewSnippet: "Book",
        },
      ],
    };
    expect(result.format).toBe("readwise_csv");
    expect(result.sourceCount).toBe(2);
    expect(result.extractCount).toBe(5);
    expect(result.skipped).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe("Anki import/export schemas (T070)", () => {
  it("PickImportFileRequestSchema accepts the anki kind", () => {
    expect(PickImportFileRequestSchema.parse({ kind: "anki" }).kind).toBe("anki");
  });

  it("CardsImportAnkiRequestSchema requires a non-empty path + optional priority", () => {
    const parsed = CardsImportAnkiRequestSchema.parse({ path: "/tmp/deck.apkg", priority: "C" });
    expect(parsed.path).toBe("/tmp/deck.apkg");
    expect(parsed.priority).toBe("C");
    expect(CardsImportAnkiRequestSchema.parse({ path: "/x.apkg" }).priority).toBeUndefined();
    expect(() => CardsImportAnkiRequestSchema.parse({ path: "" })).toThrow();
    expect(() => CardsImportAnkiRequestSchema.parse({ path: "/x.apkg", priority: "Z" })).toThrow();
  });

  it("CardsImportAnkiResult round-trips the imported shape (counts + item)", () => {
    const result: CardsImportAnkiResult = {
      status: "imported",
      deckCount: 1,
      cardCount: 42,
      withHistory: 30,
      item: {
        id: "el_deck",
        type: "source",
        status: "inbox",
        stage: "raw_source",
        priority: 0.375,
        title: "Imported Anki deck: French",
        srcType: "Manual note",
        author: null,
        accessedAt: "2026-06-01T00:00:00.000Z",
        charCount: 0,
        previewSnippet: "",
      },
    };
    expect(result.cardCount).toBe(42);
    expect(result.withHistory).toBe(30);
  });

  it("CardsExportAnkiRequestSchema requires a scope (cardIds / conceptId / all)", () => {
    expect(CardsExportAnkiRequestSchema.parse({ format: "apkg", all: true }).format).toBe("apkg");
    expect(
      CardsExportAnkiRequestSchema.parse({ format: "csv", cardIds: ["c1", "c2"] }).cardIds,
    ).toHaveLength(2);
    expect(CardsExportAnkiRequestSchema.parse({ format: "apkg", conceptId: "cn1" }).conceptId).toBe(
      "cn1",
    );
    // No scope ⇒ rejected.
    expect(() => CardsExportAnkiRequestSchema.parse({ format: "apkg" })).toThrow();
    expect(() => CardsExportAnkiRequestSchema.parse({ format: "apkg", cardIds: [] })).toThrow();
    // Bad format ⇒ rejected.
    expect(() => CardsExportAnkiRequestSchema.parse({ format: "pdf", all: true })).toThrow();
  });

  it("CardsExportAnkiResult round-trips display-safe file metadata", () => {
    const result: CardsExportAnkiResult = {
      relativePath: "anki-export-123.apkg",
      directoryLabel: "Downloads",
      cardCount: 5,
    };
    expect(result.cardCount).toBe(5);
    expect(result.directoryLabel).toBe("Downloads");
    expect(result.relativePath.endsWith(".apkg")).toBe(true);
  });
});

describe("Markdown/HTML import-export schemas (T068)", () => {
  it("PickImportFileRequestSchema accepts markdown + html kinds", () => {
    expect(PickImportFileRequestSchema.parse({ kind: "markdown" }).kind).toBe("markdown");
    expect(PickImportFileRequestSchema.parse({ kind: "html" }).kind).toBe("html");
  });

  it("SourcesImportDocumentRequestSchema requires a path + a markdown/html format", () => {
    const parsed = SourcesImportDocumentRequestSchema.parse({
      path: "/tmp/note.md",
      format: "markdown",
      priority: "C",
    });
    expect(parsed.format).toBe("markdown");
    expect(() =>
      SourcesImportDocumentRequestSchema.parse({ path: "", format: "markdown" }),
    ).toThrow();
    expect(() =>
      SourcesImportDocumentRequestSchema.parse({ path: "/x.md", format: "pdf" }),
    ).toThrow();
    expect(() => SourcesImportDocumentRequestSchema.parse({ path: "/x.md" })).toThrow();
  });

  it("SourcesImportMarkdownTextRequestSchema requires non-empty text + optional title", () => {
    const parsed = SourcesImportMarkdownTextRequestSchema.parse({
      text: "# Hello",
      title: "Hi",
    });
    expect(parsed.text).toBe("# Hello");
    expect(parsed.title).toBe("Hi");
    expect(() => SourcesImportMarkdownTextRequestSchema.parse({ text: "" })).toThrow();
  });

  it("DocumentsExportMarkdownRequestSchema requires a non-empty elementId", () => {
    expect(DocumentsExportMarkdownRequestSchema.parse({ elementId: "el_1" }).elementId).toBe(
      "el_1",
    );
    expect(() => DocumentsExportMarkdownRequestSchema.parse({ elementId: "" })).toThrow();
    expect(() => DocumentsExportMarkdownRequestSchema.parse({})).toThrow();
  });

  it("the import + export results round-trip the imported/exported shapes", () => {
    const imp: SourcesImportDocumentResult = {
      status: "imported",
      id: "el_md",
      item: {
        id: "el_md",
        type: "source",
        status: "inbox",
        stage: "raw_source",
        priority: 0.4,
        title: "A Note",
        srcType: "Manual note",
        author: null,
        accessedAt: "2026-06-01T00:00:00.000Z",
        charCount: 10,
        previewSnippet: "A Note",
      },
    };
    expect(imp.id).toBe("el_md");
    const exp: DocumentsExportMarkdownResult = {
      relativePath: "el_md-a-note.md",
      directoryLabel: "Downloads",
    };
    expect(exp.relativePath.endsWith(".md")).toBe(true);
    expect(exp.directoryLabel).toBe("Downloads");
  });
});

describe("SourcesExtractRegionRequestSchema (T065)", () => {
  const PNG = new ArrayBuffer(64);
  const base = {
    sourceElementId: "el_pdf",
    page: 2,
    pageBlockId: "pg-2-h",
    region: { x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.7 },
    imagePng: PNG,
  };

  it("accepts a valid region request", () => {
    const parsed = SourcesExtractRegionRequestSchema.parse(base);
    expect(parsed.page).toBe(2);
    expect(parsed.region).toEqual({ x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.7 });
    expect(parsed.imagePng.byteLength).toBe(64);
  });

  it("rejects an inverted rect (x0>=x1 or y0>=y1)", () => {
    expect(() =>
      SourcesExtractRegionRequestSchema.parse({
        ...base,
        region: { x0: 0.6, y0: 0.2, x1: 0.1, y1: 0.7 },
      }),
    ).toThrow();
    expect(() =>
      SourcesExtractRegionRequestSchema.parse({
        ...base,
        region: { x0: 0.1, y0: 0.7, x1: 0.6, y1: 0.2 },
      }),
    ).toThrow();
  });

  it("rejects an out-of-range rect (outside 0..1)", () => {
    expect(() =>
      SourcesExtractRegionRequestSchema.parse({
        ...base,
        region: { x0: -0.1, y0: 0.2, x1: 0.6, y1: 0.7 },
      }),
    ).toThrow();
    expect(() =>
      SourcesExtractRegionRequestSchema.parse({
        ...base,
        region: { x0: 0.1, y0: 0.2, x1: 1.2, y1: 0.7 },
      }),
    ).toThrow();
  });

  it("rejects an empty PNG and an oversize PNG (size-cap at the bridge)", () => {
    expect(() =>
      SourcesExtractRegionRequestSchema.parse({ ...base, imagePng: new ArrayBuffer(0) }),
    ).toThrow();
    expect(() =>
      SourcesExtractRegionRequestSchema.parse({
        ...base,
        imagePng: new ArrayBuffer(9 * 1024 * 1024),
      }),
    ).toThrow();
  });

  it("rejects a non-integer / non-positive page", () => {
    expect(() => SourcesExtractRegionRequestSchema.parse({ ...base, page: 0 })).toThrow();
    expect(() => SourcesExtractRegionRequestSchema.parse({ ...base, page: 1.5 })).toThrow();
  });

  it("SourcesGetRegionImageRequestSchema requires an elementId", () => {
    expect(SourcesGetRegionImageRequestSchema.parse({ elementId: "el_1" }).elementId).toBe("el_1");
    expect(() => SourcesGetRegionImageRequestSchema.parse({})).toThrow();
  });
});

describe("SourcesExtractClipRequestSchema (T074)", () => {
  const base = {
    sourceElementId: "el_media",
    startMs: 42_000,
    endMs: 75_000,
    anchorBlockId: "cue-3",
  };

  it("accepts a valid clip request (and optional transcript/caption/priority)", () => {
    const parsed = SourcesExtractClipRequestSchemaRefined.parse({
      ...base,
      transcriptSegment: "the spoken phrase",
      caption: "Key phrase",
      priority: "B",
    });
    expect(parsed.startMs).toBe(42_000);
    expect(parsed.endMs).toBe(75_000);
    expect(parsed.transcriptSegment).toBe("the spoken phrase");
    expect(parsed.priority).toBe("B");
  });

  it("accepts a bare clip request (no transcript/caption/priority)", () => {
    const parsed = SourcesExtractClipRequestSchemaRefined.parse(base);
    expect(parsed.anchorBlockId).toBe("cue-3");
  });

  it("rejects an inverted/zero-length window (endMs <= startMs)", () => {
    expect(() =>
      SourcesExtractClipRequestSchemaRefined.parse({ ...base, startMs: 75_000, endMs: 42_000 }),
    ).toThrow();
    expect(() =>
      SourcesExtractClipRequestSchemaRefined.parse({ ...base, startMs: 10_000, endMs: 10_000 }),
    ).toThrow();
  });

  it("rejects a negative or non-integer timestamp", () => {
    expect(() => SourcesExtractClipRequestSchemaRefined.parse({ ...base, startMs: -1 })).toThrow();
    expect(() =>
      SourcesExtractClipRequestSchemaRefined.parse({ ...base, startMs: 100.5 }),
    ).toThrow();
  });

  it("rejects an over-long transcript segment (length cap at the bridge)", () => {
    expect(() =>
      SourcesExtractClipRequestSchemaRefined.parse({
        ...base,
        transcriptSegment: "x".repeat(8001),
      }),
    ).toThrow();
  });
});

describe("CardsGenerateOcclusionRequestSchema (T071)", () => {
  const base = {
    imageElementId: "el_img",
    masks: [
      { region: { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.5 }, label: "Hippocampus" },
      { region: { x0: 0.5, y0: 0.2, x1: 0.8, y1: 0.5 } },
    ],
  };

  it("accepts a valid request (masks + optional priority)", () => {
    const parsed = CardsGenerateOcclusionRequestSchema.parse({ ...base, priority: "B" });
    expect(parsed.imageElementId).toBe("el_img");
    expect(parsed.masks.length).toBe(2);
    expect(parsed.masks[0]?.label).toBe("Hippocampus");
    expect(parsed.masks[1]?.label ?? null).toBeNull();
    expect(parsed.priority).toBe("B");
  });

  it("rejects 0 masks", () => {
    expect(() => CardsGenerateOcclusionRequestSchema.parse({ ...base, masks: [] })).toThrow();
  });

  it("rejects more than 50 masks (the runaway-editor cap)", () => {
    const masks = Array.from({ length: 51 }, () => ({
      region: { x0: 0.1, y0: 0.1, x1: 0.2, y1: 0.2 },
    }));
    expect(() => CardsGenerateOcclusionRequestSchema.parse({ ...base, masks })).toThrow();
  });

  it("rejects an inverted / out-of-range mask rect (reuses RegionRectSchema)", () => {
    expect(() =>
      CardsGenerateOcclusionRequestSchema.parse({
        ...base,
        masks: [{ region: { x0: 0.6, y0: 0.2, x1: 0.1, y1: 0.5 } }],
      }),
    ).toThrow();
    expect(() =>
      CardsGenerateOcclusionRequestSchema.parse({
        ...base,
        masks: [{ region: { x0: 0.1, y0: 0.2, x1: 1.2, y1: 0.5 } }],
      }),
    ).toThrow();
  });

  it("ReviewCardView.occlusion round-trips (the review-face data)", () => {
    const result: CardsGenerateOcclusionResult = {
      siblingGroupId: "sg_1",
      cards: [],
    };
    expect(result.siblingGroupId).toBe("sg_1");
    // The occlusion view shape the review face consumes (resolved MAIN-side).
    const occlusion = {
      imageElementId: "el_img",
      region: { x0: 0.1, y0: 0.2, x1: 0.4, y1: 0.5 },
      label: "Hippocampus",
      otherRegions: [{ x0: 0.5, y0: 0.2, x1: 0.8, y1: 0.5 }],
    };
    expect(occlusion.imageElementId).toBe("el_img");
    expect(occlusion.otherRegions.length).toBe(1);
    expect(occlusion.region.x1).toBe(0.4);
  });
});

describe("OCR schemas (T066)", () => {
  it("SourcesRunOcrRequestSchema accepts a valid page + PNG", () => {
    const parsed = SourcesRunOcrRequestSchema.parse({
      elementId: "el_pdf",
      page: 1,
      imagePng: new ArrayBuffer(128),
    });
    expect(parsed.page).toBe(1);
    expect(parsed.imagePng.byteLength).toBe(128);
  });

  it("SourcesRunOcrRequestSchema rejects an empty / oversize PNG and a non-positive page", () => {
    expect(() =>
      SourcesRunOcrRequestSchema.parse({ elementId: "el", page: 1, imagePng: new ArrayBuffer(0) }),
    ).toThrow();
    expect(() =>
      SourcesRunOcrRequestSchema.parse({
        elementId: "el",
        page: 1,
        imagePng: new ArrayBuffer(25 * 1024 * 1024),
      }),
    ).toThrow();
    expect(() =>
      SourcesRunOcrRequestSchema.parse({ elementId: "el", page: 0, imagePng: new ArrayBuffer(8) }),
    ).toThrow();
  });

  it("SourcesGetOcrRequestSchema / SourcesAcceptOcrRequestSchema validate their shape", () => {
    expect(SourcesGetOcrRequestSchema.parse({ elementId: "el_1" }).elementId).toBe("el_1");
    expect(() => SourcesGetOcrRequestSchema.parse({})).toThrow();
    const accept = SourcesAcceptOcrRequestSchema.parse({ elementId: "el_1", page: 3 });
    expect(accept).toEqual({ elementId: "el_1", page: 3 });
    expect(() => SourcesAcceptOcrRequestSchema.parse({ elementId: "el_1", page: 0 })).toThrow();
  });

  it("the worker `ocr` result data shape rides the generic worker `result.data` JSON", () => {
    // The worker posts `{ page, text, meanConfidence, words }` as the generic
    // `result.data` (the WorkerMessage envelope is unchanged); validated at the
    // apply boundary. A plain object round-trips through JSON.
    const data = {
      page: 1,
      text: "CARDS",
      meanConfidence: 80,
      words: [{ text: "CARDS", confidence: 80, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } }],
    };
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });
});

describe("Source retirement suggestion schemas (T103)", () => {
  it("SourcesDismissRetirementSuggestionRequestSchema validates source id plus signal hash", () => {
    expect(
      SourcesDismissRetirementSuggestionRequestSchema.parse({
        sourceElementId: "src_1",
        signalHash: "v1|src_1|abandon|thresholds:terminal>=0.9,ignored>=0.5,output=0|4|4|3|0|0",
      }),
    ).toEqual({
      sourceElementId: "src_1",
      signalHash: "v1|src_1|abandon|thresholds:terminal>=0.9,ignored>=0.5,output=0|4|4|3|0|0",
    });

    expect(() =>
      SourcesDismissRetirementSuggestionRequestSchema.parse({
        sourceElementId: "src_1",
        signalHash: "",
      }),
    ).toThrow();
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

  it("rejects an image_occlusion request (those go through cards.generateOcclusion)", () => {
    // `image_occlusion` is a valid CardKind, but it requires a mask minted
    // atomically by the occlusion generator — cards.create cannot construct one,
    // so the contract MUST reject it (else it would mint a blank, unreviewable card).
    const result = CardsCreateRequestSchema.safeParse({
      extractId: "el_1",
      kind: "image_occlusion",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("kind"))).toBe(true);
    }
  });

  // ---- T075: audio cards (the media_ref presentation carrier) ----

  it("accepts a Q&A request carrying a media_ref (an audio card)", () => {
    const parsed = CardsCreateRequestSchema.parse({
      extractId: "el_1",
      kind: "qa",
      prompt: "How is this phrase pronounced?",
      answer: "the answer",
      mediaRef: { sourceElementId: "src_1", startMs: 1000, endMs: 4000, on: "answer" },
    });
    expect(parsed.mediaRef?.on).toBe("answer");
    expect(parsed.mediaRef?.startMs).toBe(1000);
  });

  it("accepts an audio-PROMPT card with an EMPTY written prompt (the audio is the prompt)", () => {
    // Without the audio override this would fail the non-empty-prompt refine; with a
    // media_ref on the prompt face the audio carries the prompt, so it is valid.
    const parsed = CardsCreateRequestSchema.parse({
      extractId: "el_1",
      kind: "qa",
      answer: "the written translation",
      mediaRef: { sourceElementId: "src_1", startMs: 0, endMs: 4000, on: "prompt" },
    });
    expect(parsed.mediaRef?.on).toBe("prompt");
  });

  it("accepts an audio-ANSWER card with an EMPTY written answer", () => {
    const parsed = CardsCreateRequestSchema.parse({
      extractId: "el_1",
      kind: "qa",
      prompt: "How is this phrase pronounced?",
      mediaRef: { sourceElementId: "src_1", startMs: 0, endMs: 4000, on: "answer" },
    });
    expect(parsed.mediaRef?.on).toBe("answer");
  });

  it("STILL rejects an audio-prompt card whose written ANSWER is empty (audio covers only the prompt)", () => {
    const result = CardsCreateRequestSchema.safeParse({
      extractId: "el_1",
      kind: "qa",
      mediaRef: { sourceElementId: "src_1", startMs: 0, endMs: 4000, on: "prompt" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("answer"))).toBe(true);
    }
  });
});

describe("MediaRefSchema (T075)", () => {
  it("accepts a valid window + face", () => {
    const parsed = MediaRefSchema.parse({
      sourceElementId: "src_1",
      startMs: 1000,
      endMs: 4000,
      on: "both",
    });
    expect(parsed.on).toBe("both");
  });

  it("rejects an inverted window (endMs <= startMs)", () => {
    expect(() =>
      MediaRefSchema.parse({ sourceElementId: "src_1", startMs: 4000, endMs: 4000, on: "prompt" }),
    ).toThrow();
    expect(() =>
      MediaRefSchema.parse({ sourceElementId: "src_1", startMs: 5000, endMs: 4000, on: "prompt" }),
    ).toThrow();
  });

  it("rejects a negative start and an unknown face", () => {
    expect(() =>
      MediaRefSchema.parse({ sourceElementId: "src_1", startMs: -1, endMs: 1000, on: "prompt" }),
    ).toThrow();
    expect(() =>
      MediaRefSchema.parse({ sourceElementId: "src_1", startMs: 0, endMs: 1000, on: "front" }),
    ).toThrow();
  });

  it("rejects a non-integer millisecond window", () => {
    expect(() =>
      MediaRefSchema.parse({ sourceElementId: "src_1", startMs: 0.5, endMs: 1000, on: "prompt" }),
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

  it("cards.siblingAnswers requires an extractId (T086)", () => {
    expect(CardsSiblingAnswersRequestSchema.parse({ extractId: "ex_1" }).extractId).toBe("ex_1");
    expect(() => CardsSiblingAnswersRequestSchema.parse({})).toThrow();
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

  it("grade accepts the four canonical ratings + non-negative response/prompt timings", () => {
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      const parsed = ReviewGradeRequestSchema.parse({
        cardId: "el_1",
        rating,
        promptMs: 800,
        responseMs: 1200,
      });
      expect(parsed.rating).toBe(rating);
      expect(parsed.promptMs).toBe(800);
    }
  });

  it("grade defaults omitted promptMs to 0 for legacy callers", () => {
    const parsed = ReviewGradeRequestSchema.parse({
      cardId: "el_1",
      rating: "good",
      responseMs: 1200,
    });

    expect(parsed.promptMs).toBe(0);
  });

  it("grade rejects an unknown rating, negative timings, non-finite promptMs, and a missing cardId", () => {
    expect(() =>
      ReviewGradeRequestSchema.parse({ cardId: "el_1", rating: "perfect", responseMs: 1 }),
    ).toThrow();
    expect(() =>
      ReviewGradeRequestSchema.parse({ cardId: "el_1", rating: "good", responseMs: -1 }),
    ).toThrow();
    expect(() =>
      ReviewGradeRequestSchema.parse({
        cardId: "el_1",
        rating: "good",
        promptMs: -1,
        responseMs: 1,
      }),
    ).toThrow();
    expect(() =>
      ReviewGradeRequestSchema.parse({
        cardId: "el_1",
        rating: "good",
        promptMs: 1.5,
        responseMs: 1,
      }),
    ).toThrow();
    expect(() =>
      ReviewGradeRequestSchema.parse({
        cardId: "el_1",
        rating: "good",
        promptMs: 86_400_001,
        responseMs: 1,
      }),
    ).toThrow();
    expect(() =>
      ReviewGradeRequestSchema.parse({
        cardId: "el_1",
        rating: "good",
        promptMs: Number.POSITIVE_INFINITY,
        responseMs: 1,
      }),
    ).toThrow();
    expect(() =>
      ReviewGradeRequestSchema.parse({
        cardId: "el_1",
        rating: "good",
        promptMs: Number.NaN,
        responseMs: 1,
      }),
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

describe("QueueAutoPostponeRequestSchema (T077)", () => {
  it("accepts an empty object + a parseable asOf, rejects a garbage asOf", () => {
    expect(QueueAutoPostponeRequestSchema.parse({})).toEqual({});
    expect(QueueAutoPostponeRequestSchema.parse({ asOf: "2027-06-01T12:00:00.000Z" }).asOf).toBe(
      "2027-06-01T12:00:00.000Z",
    );
    expect(() => QueueAutoPostponeRequestSchema.parse({ asOf: "whenever" })).toThrow();
  });
});

describe("QueueCatchUpRequestSchema (T078)", () => {
  it("accepts an empty object, an asOf, and a positive integer spreadDays", () => {
    expect(QueueCatchUpRequestSchema.parse({})).toEqual({});
    const parsed = QueueCatchUpRequestSchema.parse({
      asOf: "2027-06-01T12:00:00.000Z",
      spreadDays: 7,
    });
    expect(parsed.asOf).toBe("2027-06-01T12:00:00.000Z");
    expect(parsed.spreadDays).toBe(7);
  });

  it("rejects a non-positive / non-integer spreadDays and a garbage asOf", () => {
    expect(() => QueueCatchUpRequestSchema.parse({ spreadDays: 0 })).toThrow();
    expect(() => QueueCatchUpRequestSchema.parse({ spreadDays: -3 })).toThrow();
    expect(() => QueueCatchUpRequestSchema.parse({ spreadDays: 2.5 })).toThrow();
    expect(() => QueueCatchUpRequestSchema.parse({ asOf: "whenever" })).toThrow();
  });
});

describe("QueueVacationRequestSchema (T078)", () => {
  it("accepts a valid away window (awayEnd ≥ awayStart, trimmed)", () => {
    const parsed = QueueVacationRequestSchema.parse({
      awayStart: "  2027-06-10T00:00:00.000Z  ",
      awayEnd: "2027-06-20T00:00:00.000Z",
    });
    expect(parsed.awayStart).toBe("2027-06-10T00:00:00.000Z");
    expect(parsed.awayEnd).toBe("2027-06-20T00:00:00.000Z");
  });

  it("rejects awayEnd before awayStart, and a missing/garbage bound", () => {
    expect(() =>
      QueueVacationRequestSchema.parse({
        awayStart: "2027-06-20T00:00:00.000Z",
        awayEnd: "2027-06-10T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      QueueVacationRequestSchema.parse({ awayStart: "2027-06-10T00:00:00.000Z" }),
    ).toThrow();
    expect(() =>
      QueueVacationRequestSchema.parse({ awayStart: "soon", awayEnd: "later" }),
    ).toThrow();
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
    const parsed = SettingsPatchSchema.parse({ dailyReviewBudget: 60, theme: "system" });
    expect(parsed).toEqual({ dailyReviewBudget: 60, theme: "system" });
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
    expect(() => SettingsPatchSchema.parse({ theme: "sepia" })).toThrow();
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
    expect(SettingsUpdateManyRequestSchema.parse({ patch: { theme: "system" } })).toEqual({
      patch: { theme: "system" },
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
      InboxTriageRequestSchema.parse({ id: "el_1", action: { kind: "queueSoon" } }),
    ).toBeTruthy();
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
      ExtractsReactivateFateRequestSchema,
    ]) {
      expect(schema.parse({ id: "el_ex" })).toEqual({ id: "el_ex" });
      expect(() => schema.parse({ id: "" })).toThrow();
      expect(() => schema.parse({})).toThrow();
    }
  });
});

describe("ExtractsSetFateRequestSchema (T104)", () => {
  it("accepts direct non-card fates and rejects direct synthesized", () => {
    expect(ExtractsSetFateRequestSchema.parse({ id: "el_ex", fate: "reference" })).toEqual({
      id: "el_ex",
      fate: "reference",
    });
    expect(ExtractsSetFateRequestSchema.parse({ id: "el_ex", fate: "done_without_card" })).toEqual({
      id: "el_ex",
      fate: "done_without_card",
    });
    expect(() =>
      ExtractsSetFateRequestSchema.parse({ id: "el_ex", fate: "synthesized" }),
    ).toThrow();
    expect(() => ExtractsSetFateRequestSchema.parse({ id: "el_ex" })).toThrow();
    expect(() => ExtractsSetFateRequestSchema.parse({ id: "", fate: "reference" })).toThrow();
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
  it("SearchQueryRequestSchema accepts a query + optional type/concept/tag/limit/count flag and rejects bad values", () => {
    expect(SearchQueryRequestSchema.parse({ q: "memory" })).toEqual({ q: "memory" });
    expect(
      SearchQueryRequestSchema.parse({
        q: "memory",
        type: "extract",
        conceptId: "el_c",
        tag: "definitions",
        limit: 10,
        includeCounts: false,
      }),
    ).toEqual({
      q: "memory",
      type: "extract",
      conceptId: "el_c",
      tag: "definitions",
      limit: 10,
      includeCounts: false,
    });

    // An empty query is allowed (it degrades to [] main-side), but only the
    // searchable types are accepted, and the limit is bounded.
    expect(SearchQueryRequestSchema.parse({ q: "" }).q).toBe("");
    expect(() => SearchQueryRequestSchema.parse({ q: "x", type: "topic" })).toThrow();
    expect(() => SearchQueryRequestSchema.parse({ q: "x", limit: 0 })).toThrow();
    expect(() => SearchQueryRequestSchema.parse({ q: "x", limit: 999 })).toThrow();
    expect(() => SearchQueryRequestSchema.parse({ q: "x".repeat(513) })).toThrow();
    expect(() => SearchQueryRequestSchema.parse({})).toThrow();
  });

  it("SearchQueryResult and SemanticSearchResult carry the full SearchCounts shape", () => {
    const searchFixture = {
      results: [],
      counts: {
        byType: { source: 1, extract: 2, card: 3 },
        byConcept: { el_concept: 4 },
        byPriority: { A: 5, B: 6, C: 7, D: 8 },
      },
    } satisfies SearchQueryResult;
    const semanticFixture = {
      results: [],
      mode: "semantic",
      counts: searchFixture.counts,
    } satisfies SemanticSearchResult;

    expect(searchFixture.counts.byType.source).toBe(1);
    expect(semanticFixture.counts.byPriority.D).toBe(8);
  });
});

describe("Semantic search schemas (T087)", () => {
  it("SemanticSearchRequestSchema accepts a query + optional type/limit and rejects bad values", () => {
    expect(SemanticSearchRequestSchema.parse({ q: "spaced repetition" })).toEqual({
      q: "spaced repetition",
    });
    expect(SemanticSearchRequestSchema.parse({ q: "x", type: "extract", limit: 20 })).toEqual({
      q: "x",
      type: "extract",
      limit: 20,
    });
    // Only searchable types; bounded limit; bounded query length.
    expect(() => SemanticSearchRequestSchema.parse({ q: "x", type: "topic" })).toThrow();
    expect(() => SemanticSearchRequestSchema.parse({ q: "x", limit: 0 })).toThrow();
    expect(() => SemanticSearchRequestSchema.parse({ q: "x", limit: 999 })).toThrow();
    expect(() => SemanticSearchRequestSchema.parse({ q: "x".repeat(513) })).toThrow();
    expect(() => SemanticSearchRequestSchema.parse({})).toThrow();
  });

  it("SemanticReindexRequestSchema accepts an optional onlyMissing flag", () => {
    expect(SemanticReindexRequestSchema.parse({})).toEqual({});
    expect(SemanticReindexRequestSchema.parse({ onlyMissing: true })).toEqual({
      onlyMissing: true,
    });
    expect(() => SemanticReindexRequestSchema.parse({ onlyMissing: "yes" })).toThrow();
  });

  it("SemanticStatusRequestSchema takes an empty payload", () => {
    expect(SemanticStatusRequestSchema.parse({})).toEqual({});
  });

  it("SemanticSearchModeSchema is the closed semantic/fts/disabled set", () => {
    expect(SemanticSearchModeSchema.parse("semantic")).toBe("semantic");
    expect(SemanticSearchModeSchema.parse("fts")).toBe("fts");
    expect(SemanticSearchModeSchema.parse("disabled")).toBe("disabled");
    expect(() => SemanticSearchModeSchema.parse("keyword")).toThrow();
  });

  it("SemanticRelatedRequestSchema validates { elementId, limit? } (T088)", () => {
    expect(SemanticRelatedRequestSchema.parse({ elementId: "el-1" })).toEqual({
      elementId: "el-1",
    });
    expect(SemanticRelatedRequestSchema.parse({ elementId: "el-1", limit: 8 })).toEqual({
      elementId: "el-1",
      limit: 8,
    });
    // A required, bounded element id; a bounded optional limit.
    expect(() => SemanticRelatedRequestSchema.parse({})).toThrow();
    expect(() => SemanticRelatedRequestSchema.parse({ elementId: "" })).toThrow();
    expect(() => SemanticRelatedRequestSchema.parse({ elementId: "el-1", limit: 0 })).toThrow();
    expect(() => SemanticRelatedRequestSchema.parse({ elementId: "el-1", limit: 999 })).toThrow();
  });

  it("SemanticContradictionsRequestSchema validates { elementId } (T089)", () => {
    expect(SemanticContradictionsRequestSchema.parse({ elementId: "el-1" })).toEqual({
      elementId: "el-1",
    });
    // A required, non-empty element id; nothing else.
    expect(() => SemanticContradictionsRequestSchema.parse({})).toThrow();
    expect(() => SemanticContradictionsRequestSchema.parse({ elementId: "" })).toThrow();
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
        statuses: ["active", "inbox", "parked"],
        limit: 100,
      }),
    ).toEqual({
      types: ["source", "topic", "synthesis_note", "task"],
      conceptId: "el_c",
      priorityLabel: "A",
      statuses: ["active", "inbox", "parked"],
      limit: 100,
    });
  });

  it("accepts the parked-source action request and rejects unknown actions", () => {
    expect(
      LibraryParkedActionRequestSchema.parse({
        id: "el_1",
        action: { kind: "moveToInbox" },
      }),
    ).toEqual({ id: "el_1", action: { kind: "moveToInbox" } });
    expect(
      LibraryParkedActionRequestSchema.parse({ id: "el_1", action: { kind: "queueSoon" } }).action
        .kind,
    ).toBe("queueSoon");
    expect(
      LibraryParkedActionRequestSchema.parse({ id: "el_1", action: { kind: "dismiss" } }).action
        .kind,
    ).toBe("dismiss");
    expect(() =>
      LibraryParkedActionRequestSchema.parse({ id: "el_1", action: { kind: "archive" } }),
    ).toThrow();
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

describe("AnalyticsReviewActivityRequestSchema", () => {
  it("accepts an empty/absent request (defaults applied main-side)", () => {
    expect(AnalyticsReviewActivityRequestSchema.parse(undefined)).toBeUndefined();
    expect(AnalyticsReviewActivityRequestSchema.parse({})).toEqual({});
  });

  it("accepts an explicit asOf + year and rejects invalid years", () => {
    expect(
      AnalyticsReviewActivityRequestSchema.parse({
        asOf: "2026-05-30T00:00:00.000Z",
        year: 2026,
      }),
    ).toEqual({ asOf: "2026-05-30T00:00:00.000Z", year: 2026 });
    expect(() => AnalyticsReviewActivityRequestSchema.parse({ year: 0 })).toThrow();
    expect(() => AnalyticsReviewActivityRequestSchema.parse({ year: 999 })).toThrow();
    expect(() => AnalyticsReviewActivityRequestSchema.parse({ year: 9999 })).toThrow();
    expect(() => AnalyticsReviewActivityRequestSchema.parse({ year: 2026.5 })).toThrow();
    expect(() => AnalyticsReviewActivityRequestSchema.parse({ asOf: "" })).toThrow();
    expect(() => AnalyticsReviewActivityRequestSchema.parse({ asOf: "not-a-date" })).toThrow();
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

describe("SourceYieldListRequestSchema (T083)", () => {
  it("accepts an empty/absent request (defaults applied main-side)", () => {
    expect(SourceYieldListRequestSchema.parse(undefined)).toBeUndefined();
    expect(SourceYieldListRequestSchema.parse({})).toEqual({});
  });

  it("accepts an explicit asOf + limit + offset and rejects out-of-range values", () => {
    expect(
      SourceYieldListRequestSchema.parse({
        asOf: "2026-06-01T00:00:00.000Z",
        limit: 50,
        offset: 10,
      }),
    ).toEqual({ asOf: "2026-06-01T00:00:00.000Z", limit: 50, offset: 10 });
    expect(() => SourceYieldListRequestSchema.parse({ limit: 0 })).toThrow();
    expect(() => SourceYieldListRequestSchema.parse({ limit: 1001 })).toThrow();
    expect(() => SourceYieldListRequestSchema.parse({ limit: 1.5 })).toThrow();
    expect(() => SourceYieldListRequestSchema.parse({ offset: -1 })).toThrow();
    expect(() => SourceYieldListRequestSchema.parse({ asOf: "" })).toThrow();
  });
});

describe("ExtractStagnationListRequestSchema (T084)", () => {
  it("accepts an empty/absent request (defaults applied main-side)", () => {
    expect(ExtractStagnationListRequestSchema.parse(undefined)).toBeUndefined();
    expect(ExtractStagnationListRequestSchema.parse({})).toEqual({});
  });

  it("accepts an explicit asOf + limit + offset and rejects out-of-range values", () => {
    expect(
      ExtractStagnationListRequestSchema.parse({
        asOf: "2026-06-01T00:00:00.000Z",
        limit: 50,
        offset: 10,
      }),
    ).toEqual({ asOf: "2026-06-01T00:00:00.000Z", limit: 50, offset: 10 });
    expect(() => ExtractStagnationListRequestSchema.parse({ limit: 0 })).toThrow();
    expect(() => ExtractStagnationListRequestSchema.parse({ limit: 1001 })).toThrow();
    expect(() => ExtractStagnationListRequestSchema.parse({ limit: 1.5 })).toThrow();
    expect(() => ExtractStagnationListRequestSchema.parse({ offset: -1 })).toThrow();
    expect(() => ExtractStagnationListRequestSchema.parse({ asOf: "" })).toThrow();
  });
});

describe("BackupsCreateRequestSchema (T047)", () => {
  it("takes no arguments (void request)", () => {
    expect(BackupsCreateRequestSchema.parse(undefined)).toBeUndefined();
    expect(() => BackupsCreateRequestSchema.parse({ anything: true })).toThrow();
  });
});

describe("BackupsOpenFolderRequestSchema", () => {
  it("takes no arguments (void request)", () => {
    expect(BackupsOpenFolderRequestSchema.parse(undefined)).toBeUndefined();
    expect(() => BackupsOpenFolderRequestSchema.parse({ path: "/tmp" })).toThrow();
  });
});

describe("Backup restore/reset schemas (T055)", () => {
  it("BackupsListRequestSchema takes no arguments", () => {
    expect(BackupsListRequestSchema.parse(undefined)).toBeUndefined();
    expect(() => BackupsListRequestSchema.parse({})).toThrow();
  });

  it("BackupTimestampSchema accepts only app-managed backup names", () => {
    expect(BackupTimestampSchema.parse("2026-06-07T12-30-00-000Z")).toBe(
      "2026-06-07T12-30-00-000Z",
    );
    expect(BackupTimestampSchema.parse("2026-06-07T12-30-00-000Z-1")).toBe(
      "2026-06-07T12-30-00-000Z-1",
    );
    expect(BackupTimestampSchema.parse("auto-2026-06-07T12-30-00-000Z")).toBe(
      "auto-2026-06-07T12-30-00-000Z",
    );
    expect(BackupTimestampSchema.safeParse("../app.sqlite").success).toBe(false);
    expect(BackupTimestampSchema.safeParse("/tmp/2026-06-07T12-30-00-000Z").success).toBe(false);
    expect(BackupTimestampSchema.safeParse("2026-06-07T12:30:00.000Z").success).toBe(false);
  });

  it("BackupsRestoreRequestSchema requires confirm:true and the exact restore phrase", () => {
    expect(
      BackupsRestoreRequestSchema.parse({
        timestamp: "2026-06-07T12-30-00-000Z",
        confirm: true,
        phrase: "RESTORE BACKUP",
      }),
    ).toEqual({
      timestamp: "2026-06-07T12-30-00-000Z",
      confirm: true,
      phrase: "RESTORE BACKUP",
    });
    expect(
      BackupsRestoreRequestSchema.parse({
        timestamp: "auto-2026-06-07T12-30-00-000Z",
        confirm: true,
        phrase: "RESTORE BACKUP",
      }).timestamp,
    ).toBe("auto-2026-06-07T12-30-00-000Z");
    expect(
      BackupsRestoreRequestSchema.safeParse({
        timestamp: "2026-06-07T12-30-00-000Z",
        phrase: "RESTORE BACKUP",
      }).success,
    ).toBe(false);
    expect(
      BackupsRestoreRequestSchema.safeParse({
        timestamp: "2026-06-07T12-30-00-000Z",
        confirm: false,
        phrase: "RESTORE BACKUP",
      }).success,
    ).toBe(false);
    expect(
      BackupsRestoreRequestSchema.safeParse({
        timestamp: "2026-06-07T12-30-00-000Z",
        confirm: true,
        phrase: "restore backup",
      }).success,
    ).toBe(false);
    expect(
      BackupsRestoreRequestSchema.safeParse({
        timestamp: "../2026-06-07T12-30-00-000Z",
        confirm: true,
        phrase: "RESTORE BACKUP",
      }).success,
    ).toBe(false);
  });

  it("BackupsRestoreFileRequestSchema requires a non-empty path, confirm:true, and the exact phrase", () => {
    expect(
      BackupsRestoreFileRequestSchema.parse({
        path: "/x.zip",
        confirm: true,
        phrase: "RESTORE BACKUP",
      }),
    ).toEqual({
      path: "/x.zip",
      confirm: true,
      phrase: "RESTORE BACKUP",
    });
    // empty path
    expect(
      BackupsRestoreFileRequestSchema.safeParse({
        path: "",
        confirm: true,
        phrase: "RESTORE BACKUP",
      }).success,
    ).toBe(false);
    // missing path
    expect(
      BackupsRestoreFileRequestSchema.safeParse({
        confirm: true,
        phrase: "RESTORE BACKUP",
      }).success,
    ).toBe(false);
    // confirm:false
    expect(
      BackupsRestoreFileRequestSchema.safeParse({
        path: "/x.zip",
        confirm: false,
        phrase: "RESTORE BACKUP",
      }).success,
    ).toBe(false);
    // wrong phrase
    expect(
      BackupsRestoreFileRequestSchema.safeParse({
        path: "/x.zip",
        confirm: true,
        phrase: "restore backup",
      }).success,
    ).toBe(false);
    // unknown extra keys rejected (.strict())
    expect(
      BackupsRestoreFileRequestSchema.safeParse({
        path: "/x.zip",
        confirm: true,
        phrase: "RESTORE BACKUP",
        timestamp: "2026-06-07T12-30-00-000Z",
      }).success,
    ).toBe(false);
  });

  it("BackupsPickArchiveResult round-trips both variants as plain JSON without extra surface", () => {
    const chosen: BackupsPickArchiveResult = { path: "/backups/2026-06-07.zip" };
    const cancelled: BackupsPickArchiveResult = { cancelled: true };

    expect(JSON.parse(JSON.stringify(chosen))).toEqual(chosen);
    expect(JSON.parse(JSON.stringify(cancelled))).toEqual(cancelled);
  });

  it("BackupsResetLocalDataRequestSchema requires confirm:true and the exact reset phrase", () => {
    expect(
      BackupsResetLocalDataRequestSchema.parse({
        confirm: true,
        phrase: "START FROM SCRATCH",
      }),
    ).toEqual({
      confirm: true,
      phrase: "START FROM SCRATCH",
    });
    expect(
      BackupsResetLocalDataRequestSchema.safeParse({ phrase: "START FROM SCRATCH" }).success,
    ).toBe(false);
    expect(
      BackupsResetLocalDataRequestSchema.safeParse({
        confirm: false,
        phrase: "START FROM SCRATCH",
      }).success,
    ).toBe(false);
    expect(
      BackupsResetLocalDataRequestSchema.safeParse({
        confirm: true,
        phrase: "start from scratch",
      }).success,
    ).toBe(false);
  });

  it("backup list/restore/reset result types round-trip as plain JSON without paths", () => {
    const artifact: BackupArtifact = {
      timestamp: "auto-2026-06-07T12-30-00-000Z",
      createdAt: "2026-06-07T12:30:00.000Z",
      sizeBytes: 1234,
      fileCount: 3,
      schemaVersion: "0001_initial",
      automatic: true,
    };
    const list: BackupsListResult = { backups: [artifact] };
    const restore: BackupsRestoreResult = {
      status: "restored",
      timestamp: artifact.timestamp,
      restoredAt: "2026-06-07T12:45:00.000Z",
      reloadRequired: true,
    };
    const reset: BackupsResetLocalDataResult = {
      status: "reset",
      resetAt: "2026-06-07T12:45:00.000Z",
      reloadRequired: true,
    };

    expect(JSON.parse(JSON.stringify(list))).toEqual(list);
    expect(JSON.parse(JSON.stringify(restore))).toEqual(restore);
    expect(JSON.parse(JSON.stringify(reset))).toEqual(reset);
    expect(Object.keys(artifact).sort()).toEqual([
      "automatic",
      "createdAt",
      "fileCount",
      "schemaVersion",
      "sizeBytes",
      "timestamp",
    ]);
  });
});

describe("Jobs observe schemas (T058)", () => {
  it("JobsListRequestSchema accepts an empty / filtered request and rejects bad enums", () => {
    expect(JobsListRequestSchema.parse({})).toEqual({});
    expect(
      JobsListRequestSchema.parse({ status: "queued", type: "url_import", limit: 50 }),
    ).toEqual({ status: "queued", type: "url_import", limit: 50 });
    expect(() => JobsListRequestSchema.parse({ status: "nope" })).toThrow();
    expect(() => JobsListRequestSchema.parse({ type: "made_up" })).toThrow();
    expect(() => JobsListRequestSchema.parse({ limit: 0 })).toThrow();
  });

  it("a JobSummary / JobsListResult round-trips as plain JSON", () => {
    const summary: JobSummary = {
      id: "job-1",
      type: "url_import",
      status: "running",
      progressRatio: 50,
      progressNote: "fetching",
      error: null,
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:01.000Z",
    };
    const result: JobsListResult = { jobs: [summary] };
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("Vault maintenance schemas (T059)", () => {
  it("VaultCollectOrphansRequestSchema REJECTS a payload without confirm: true", () => {
    expect(() => VaultCollectOrphansRequestSchema.parse({})).toThrow();
    expect(() => VaultCollectOrphansRequestSchema.parse({ confirm: false })).toThrow();
  });

  it("VaultCollectOrphansRequestSchema accepts confirm:true with + without an allow-list", () => {
    expect(VaultCollectOrphansRequestSchema.parse({ confirm: true })).toEqual({ confirm: true });
    expect(
      VaultCollectOrphansRequestSchema.parse({
        confirm: true,
        relativePaths: ["sources/s1/original.html", "media/x/original.bin"],
      }),
    ).toEqual({
      confirm: true,
      relativePaths: ["sources/s1/original.html", "media/x/original.bin"],
    });
  });

  it("verify + orphans result types round-trip as plain JSON (orphan = { relativePath, size })", () => {
    const verify: VaultVerifyResult = {
      ok: 3,
      mismatched: ["asset-1"],
      missing: ["asset-2"],
      extraFiles: ["media/stray/x.bin"],
    };
    const orphans: VaultOrphansResult = {
      orphans: [{ relativePath: "media/stray/x.bin", size: 42 }],
      totalBytes: 42,
    };
    const collect: VaultCollectOrphansResult = { removed: 1, freedBytes: 42 };
    expect(JSON.parse(JSON.stringify(verify))).toEqual(verify);
    expect(JSON.parse(JSON.stringify(orphans))).toEqual(orphans);
    expect(JSON.parse(JSON.stringify(collect))).toEqual(collect);
    // An orphan entry has NO `assetId`/`reason` field.
    const [firstOrphan] = orphans.orphans;
    expect(Object.keys(firstOrphan ?? {}).sort()).toEqual(["relativePath", "size"]);
  });
});

describe("Worker message schemas (T058)", () => {
  it("WorkerRequest round-trips a valid request and rejects a bad type", async () => {
    const { WorkerRequestSchema } = await import("../worker/messages");
    const req = { jobId: "job-1", type: "url_import", payload: { url: "https://x.test" } };
    expect(WorkerRequestSchema.parse(req)).toEqual(req);
    expect(() => WorkerRequestSchema.parse({ jobId: "j", type: "made_up", payload: {} })).toThrow();
    expect(() => WorkerRequestSchema.parse({ type: "url_import", payload: {} })).toThrow();
  });

  it("WorkerMessage round-trips progress/result/error and rejects a malformed one", async () => {
    const { WorkerMessageSchema } = await import("../worker/messages");
    const progress = { kind: "progress", jobId: "j", progress: { ratio: 0.5, note: "x" } };
    const result = { kind: "result", jobId: "j", data: { html: "<h1/>", finalUrl: "u" } };
    const error = { kind: "error", jobId: "j", code: "fetch_failed", message: "boom" };
    expect(WorkerMessageSchema.parse(progress)).toEqual(progress);
    expect(WorkerMessageSchema.parse(result)).toEqual(result);
    expect(WorkerMessageSchema.parse(error)).toEqual(error);
    // Bad: unknown kind; out-of-range ratio; missing jobId.
    expect(() => WorkerMessageSchema.parse({ kind: "nope", jobId: "j" })).toThrow();
    expect(() =>
      WorkerMessageSchema.parse({ kind: "progress", jobId: "j", progress: { ratio: 2 } }),
    ).toThrow();
    expect(() => WorkerMessageSchema.parse({ kind: "error", code: "c", message: "m" })).toThrow();
  });
});

describe("Verification-task schemas (T092)", () => {
  it("TasksCreateRequestSchema accepts a valid create and rejects bad input", () => {
    const ok = TasksCreateRequestSchema.parse({
      taskType: "verify_claim",
      title: "Verify the definition",
      note: "check 2024",
      linkedElementId: "el-1",
      dueChoice: { kind: "tomorrow" },
    });
    expect(ok.taskType).toBe("verify_claim");
    expect(ok.linkedElementId).toBe("el-1");

    // A minimal create (no link / note / due) is valid.
    expect(TasksCreateRequestSchema.parse({ taskType: "custom", title: "Tidy" }).title).toBe(
      "Tidy",
    );

    // Bad: empty title; oversized note; unknown taskType.
    expect(
      TasksCreateRequestSchema.safeParse({ taskType: "verify_claim", title: "  " }).success,
    ).toBe(false);
    expect(
      TasksCreateRequestSchema.safeParse({
        taskType: "verify_claim",
        title: "x",
        note: "n".repeat(2049),
      }).success,
    ).toBe(false);
    expect(TasksCreateRequestSchema.safeParse({ taskType: "nope", title: "x" }).success).toBe(
      false,
    );
  });

  it("TasksList / Complete / Postpone / GenerateFromExpiry validate their shapes", () => {
    expect(TasksListRequestSchema.parse({}).linkedElementId).toBeUndefined();
    expect(TasksListRequestSchema.parse({ linkedElementId: "el-1" }).linkedElementId).toBe("el-1");

    expect(TasksCompleteRequestSchema.parse({ id: "t-1" }).id).toBe("t-1");
    expect(
      TasksCompleteRequestSchema.parse({ id: "t-1", bumpReviewByDays: 30 }).bumpReviewByDays,
    ).toBe(30);
    // bumpReviewByDays must be a positive int.
    expect(TasksCompleteRequestSchema.safeParse({ id: "t-1", bumpReviewByDays: 0 }).success).toBe(
      false,
    );
    expect(TasksCompleteRequestSchema.safeParse({ id: "t-1", bumpReviewByDays: -5 }).success).toBe(
      false,
    );
    expect(TasksCompleteRequestSchema.safeParse({}).success).toBe(false);

    expect(
      TasksPostponeRequestSchema.parse({ id: "t-1", choice: { kind: "nextWeek" } }).choice,
    ).toEqual({ kind: "nextWeek" });
    expect(TasksGenerateFromExpiryRequestSchema.parse({})).toEqual({});
    // strict: an unexpected key is rejected.
    expect(TasksGenerateFromExpiryRequestSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("Synthesis-note schemas (T095)", () => {
  it("SynthesisCreateRequestSchema accepts a valid create and rejects bad input", () => {
    const ok = SynthesisCreateRequestSchema.parse({
      title: "Weaving definitions",
      priority: "A",
      bodyJson: { type: "doc", content: [] },
      bodyPlainText: "thoughts",
      blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "blk_0" }],
    });
    expect(ok.title).toBe("Weaving definitions");
    expect(ok.priority).toBe("A");

    // A minimal create (title only) is valid.
    expect(SynthesisCreateRequestSchema.parse({ title: "Bare note" }).title).toBe("Bare note");

    // Bad: empty title; unknown priority band.
    expect(SynthesisCreateRequestSchema.safeParse({ title: "   " }).success).toBe(false);
    expect(SynthesisCreateRequestSchema.safeParse({ title: "x", priority: "Z" }).success).toBe(
      false,
    );
  });

  it("SynthesisLink / Unlink / EditBody / Get validate their shapes", () => {
    expect(SynthesisLinkRequestSchema.parse({ noteId: "n-1", targetId: "e-1" }).targetId).toBe(
      "e-1",
    );
    expect(SynthesisLinkRequestSchema.safeParse({ noteId: "n-1" }).success).toBe(false);

    expect(SynthesisUnlinkRequestSchema.parse({ noteId: "n-1", targetId: "e-1" }).noteId).toBe(
      "n-1",
    );

    const edit = SynthesisEditBodyRequestSchema.parse({
      noteId: "n-1",
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "refined",
    });
    expect(edit.plainText).toBe("refined");
    expect(SynthesisEditBodyRequestSchema.safeParse({ noteId: "n-1" }).success).toBe(false);

    expect(SynthesisGetRequestSchema.parse({ noteId: "n-1" }).noteId).toBe("n-1");
    expect(SynthesisGetRequestSchema.safeParse({}).success).toBe(false);
  });

  it("SynthesisScheduleReturnRequestSchema accepts the preset + manual choices and rejects bad input", () => {
    for (const kind of ["tomorrow", "nextWeek", "nextMonth"] as const) {
      expect(
        SynthesisScheduleReturnRequestSchema.parse({ noteId: "n-1", when: { kind } }).when.kind,
      ).toBe(kind);
    }
    const manual = SynthesisScheduleReturnRequestSchema.parse({
      noteId: "n-1",
      when: { kind: "manual", date: "  2026-07-01T12:00:00.000Z  " },
    });
    expect(manual.when).toEqual({ kind: "manual", date: "2026-07-01T12:00:00.000Z" });

    // Bad: an unknown choice kind, and a manual choice with no date.
    expect(
      SynthesisScheduleReturnRequestSchema.safeParse({ noteId: "n-1", when: { kind: "someday" } })
        .success,
    ).toBe(false);
    expect(
      SynthesisScheduleReturnRequestSchema.safeParse({ noteId: "n-1", when: { kind: "manual" } })
        .success,
    ).toBe(false);
  });
});

describe("Review-mode selector schemas (T096)", () => {
  it("accepts every valid selector shape (the IPC validation boundary)", () => {
    const valid = [
      { kind: "concept", conceptId: "el_concept" },
      { kind: "source", sourceId: "el_source" },
      { kind: "branch", rootId: "el_root" },
      { kind: "search", query: "spaced repetition" },
      { kind: "semantic", query: "forgetting curve" },
      { kind: "stale" },
      { kind: "leech" },
      { kind: "random", size: 20 },
      { kind: "random", size: 20, seed: 12345 },
    ] as const;
    for (const selector of valid) {
      const parsed = ReviewModeSelectorSchema.parse(selector);
      expect(parsed).toEqual(selector);
    }
    // The query is trimmed (the schema's `.trim()`), mirroring the other text inputs.
    expect(ReviewModeSelectorSchema.parse({ kind: "search", query: "  hi  " })).toEqual({
      kind: "search",
      query: "hi",
    });
  });

  it("rejects malformed selectors (missing params, bad query, out-of-range size, unknown kind)", () => {
    const invalid: unknown[] = [
      { kind: "concept" }, // missing conceptId
      { kind: "source" }, // missing sourceId
      { kind: "branch" }, // missing rootId
      { kind: "search" }, // missing query
      { kind: "semantic", query: "" }, // empty query
      { kind: "search", query: "   " }, // whitespace-only query (trims to empty)
      { kind: "search", query: "x".repeat(513) }, // over-long query
      { kind: "random" }, // missing size
      { kind: "random", size: 0 }, // size below the min
      { kind: "random", size: 1.5 }, // non-integer size
      { kind: "random", size: MAX_REVIEW_MODE_DECK + 1 }, // size above the cap
      { kind: "random", size: 20, seed: 1.5 }, // non-integer seed
      { kind: "tag" }, // unknown kind (additive-only union)
      {}, // no kind
    ];
    for (const selector of invalid) {
      expect(ReviewModeSelectorSchema.safeParse(selector).success).toBe(false);
    }
  });

  it("validates the deck/count request wrappers (selector + optional asOf)", () => {
    const selector = { kind: "leech" } as const;
    expect(ReviewModeDeckRequestSchema.parse({ selector }).selector).toEqual(selector);
    expect(
      ReviewModeDeckRequestSchema.parse({ selector, asOf: "  2026-06-01T00:00:00.000Z  " }).asOf,
    ).toBe("2026-06-01T00:00:00.000Z");
    expect(ReviewModeCountRequestSchema.parse({ selector }).selector).toEqual(selector);
    // A malformed nested selector fails the wrapper too.
    expect(ReviewModeDeckRequestSchema.safeParse({ selector: { kind: "concept" } }).success).toBe(
      false,
    );
    expect(ReviewModeCountRequestSchema.safeParse({}).success).toBe(false); // missing selector
  });
});

describe("Maintenance schemas (T099)", () => {
  it("the read-only report requests accept void / optional args", () => {
    expect(() => MaintenanceReportRequestSchema.parse(undefined)).not.toThrow();
    expect(MaintenanceLowValueRequestSchema.parse(undefined)).toBeUndefined();
    expect(MaintenanceLowValueRequestSchema.parse({ limit: 50 })?.limit).toBe(50);
    expect(MaintenanceIntegrityRequestSchema.parse({ deep: true })?.deep).toBe(true);
  });

  it("orphan-media requires confirm: true (the destructive guard)", () => {
    expect(MaintenanceOrphanMediaRequestSchema.parse({ confirm: true }).confirm).toBe(true);
    expect(MaintenanceOrphanMediaRequestSchema.safeParse({ confirm: false }).success).toBe(false);
    expect(MaintenanceOrphanMediaRequestSchema.safeParse({}).success).toBe(false);
    // The relative-path allow-list is optional but typed.
    expect(
      MaintenanceOrphanMediaRequestSchema.parse({ confirm: true, relativePaths: ["a/b.bin"] })
        .relativePaths,
    ).toEqual(["a/b.bin"]);
  });

  it("dedupe / bulkTrash require a non-empty id list", () => {
    expect(MaintenanceDedupeRequestSchema.parse({ removeIds: ["e1"] }).removeIds).toEqual(["e1"]);
    expect(MaintenanceDedupeRequestSchema.safeParse({ removeIds: [] }).success).toBe(false);
    expect(MaintenanceBulkTrashRequestSchema.parse({ ids: ["e1"] }).ids).toEqual(["e1"]);
    expect(MaintenanceBulkTrashRequestSchema.safeParse({ ids: [] }).success).toBe(false);
  });

  it("bulkArchive accepts only the bounded mode enum", () => {
    for (const mode of ["trash", "dismiss", "retire"] as const) {
      expect(MaintenanceBulkArchiveRequestSchema.parse({ ids: ["e1"], mode }).mode).toBe(mode);
    }
    expect(
      MaintenanceBulkArchiveRequestSchema.safeParse({ ids: ["e1"], mode: "nuke" }).success,
    ).toBe(false);
    expect(MaintenanceBulkArchiveRequestSchema.safeParse({ ids: ["e1"] }).success).toBe(false);
  });

  it("bulkPostpone takes an id list + an optional asOf", () => {
    expect(MaintenanceBulkPostponeRequestSchema.parse({ ids: ["e1"] }).ids).toEqual(["e1"]);
    expect(
      MaintenanceBulkPostponeRequestSchema.parse({
        ids: ["e1"],
        asOf: "  2026-06-01T00:00:00.000Z  ",
      }).asOf,
    ).toBe("2026-06-01T00:00:00.000Z");
  });

  it("parked resurfacing drilldown accepts only a bounded optional limit", () => {
    expect(MaintenanceParkedResurfacingRequestSchema.parse(undefined)).toBeUndefined();
    expect(MaintenanceParkedResurfacingRequestSchema.parse({ limit: 50 })?.limit).toBe(50);
    expect(MaintenanceParkedResurfacingRequestSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(MaintenanceParkedResurfacingRequestSchema.safeParse({ limit: 501 }).success).toBe(false);
  });

  it("parked resurfacing apply requires decisions from the bounded enum", () => {
    expect(
      MaintenanceParkedResurfacingApplyRequestSchema.parse({
        decisions: [
          { id: "e1", kind: "keepParked" },
          { id: "e2", kind: "queueNow" },
          { id: "e3", kind: "letGo" },
        ],
      }).decisions.map((decision) => decision.kind),
    ).toEqual(["keepParked", "queueNow", "letGo"]);
    expect(
      MaintenanceParkedResurfacingApplyRequestSchema.safeParse({ decisions: [] }).success,
    ).toBe(false);
    expect(
      MaintenanceParkedResurfacingApplyRequestSchema.safeParse({
        decisions: [{ id: "e1", kind: "archive" }],
      }).success,
    ).toBe(false);
  });
});
