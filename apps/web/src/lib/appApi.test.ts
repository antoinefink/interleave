import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AppApi,
  appApi,
  isDesktop,
  type QueueListResult,
  RESET_LOCAL_DATA_CONFIRMATION_PHRASE,
  RESTORE_BACKUP_CONFIRMATION_PHRASE,
  requireAppApi,
  type SearchQueryResult,
} from "./appApi";

function installAppApi(overrides: Partial<AppApi> = {}): AppApi {
  const fake = {
    app: { health: vi.fn(async () => ({ status: "ok" })) },
    db: { getStatus: vi.fn(async () => ({ open: true })) },
    settings: {
      get: vi.fn(async (request?: unknown) => ({ settings: { request } })),
      update: vi.fn(async (request: unknown) => request),
      getAll: vi.fn(async () => ({ settings: {} })),
      updateMany: vi.fn(async (request: unknown) => ({ settings: request })),
    },
    inspector: {
      list: vi.fn(async () => ({ elements: [] })),
      get: vi.fn(async (request: unknown) => ({ data: request })),
    },
    elements: { setPriority: vi.fn(async (request: unknown) => request) },
    topics: {
      fallow: vi.fn(async (request: unknown) => ({
        applied: 1,
        skipped: [],
        batchId: "batch-1",
        request,
      })),
      unfallow: vi.fn(async (request: unknown) => ({
        applied: 1,
        skipped: [],
        batchId: "batch-1",
        request,
      })),
    },
    search: {
      query: vi.fn(async () => ({
        results: [],
        counts: {
          byType: { source: 0, extract: 0, card: 0 },
          byConcept: {},
          byPriority: { A: 0, B: 0, C: 0, D: 0 },
        },
      })),
    },
    queue: {
      list: vi.fn(async (request?: unknown) => ({ items: [], request })),
      act: vi.fn(async (request: unknown) => request),
      schedule: vi.fn(async (request: unknown) => request),
      undo: vi.fn(async (request: unknown) => request),
      autoPostpone: vi.fn(async (request?: unknown) => ({ request })),
      autoPostponeApply: vi.fn(async (request?: unknown) => ({ request })),
      catchUp: vi.fn(async (request?: unknown) => ({ request })),
      catchUpApply: vi.fn(async (request?: unknown) => ({ request })),
      vacation: vi.fn(async (request: unknown) => request),
      vacationApply: vi.fn(async (request: unknown) => request),
    },
    sources: {
      importManual: vi.fn(async (request: unknown) => request),
      dismissRetirementSuggestion: vi.fn(async (request: unknown) => request),
      importUrl: vi.fn(async (request: unknown) => request),
      getRegionImage: vi.fn(async (request: unknown) => request),
    },
    documents: {
      get: vi.fn(async (request: unknown) => request),
      save: vi.fn(async (request: unknown) => request),
      exportMarkdown: vi.fn(async (request: unknown) => request),
      marks: {
        add: vi.fn(async (request: unknown) => request),
        remove: vi.fn(async (request: unknown) => request),
        list: vi.fn(async (request: unknown) => request),
      },
    },
    blockProcessing: {
      list: vi.fn(async (request: unknown) => ({ blocks: [], summary: request })),
      summary: vi.fn(async (request: unknown) => ({ summary: request })),
      markIgnored: vi.fn(async (request: unknown) => ({ block: request, summary: request })),
      markProcessed: vi.fn(async (request: unknown) => ({ block: request, summary: request })),
      markNeedsLater: vi.fn(async (request: unknown) => ({ block: request, summary: request })),
      markUnread: vi.fn(async (request: unknown) => ({ block: request, summary: request })),
    },
    extracts: {
      updateStage: vi.fn(async (request: unknown) => ({ extract: request })),
      rewrite: vi.fn(async (request: unknown) => ({ extract: request, plainText: "body" })),
      postpone: vi.fn(async (request: unknown) => ({ extract: request, postponeCount: 1 })),
      markDone: vi.fn(async (request: unknown) => ({ extract: request })),
      setFate: vi.fn(async (request: unknown) => ({ extract: request })),
      reactivateFate: vi.fn(async (request: unknown) => ({ extract: request })),
      delete: vi.fn(async (request: unknown) => ({ extract: request })),
    },
    synthesis: {
      create: vi.fn(async (request: unknown) => request),
      link: vi.fn(async (request: unknown) => request),
      unlink: vi.fn(async (request: unknown) => request),
      editBody: vi.fn(async (request: unknown) => request),
      scheduleReturn: vi.fn(async (request: unknown) => request),
      get: vi.fn(async (request: unknown) => request),
    },
    analytics: {
      get: vi.fn(async (request?: unknown) => ({
        asOf: "2026-06-07T12:00:00.000Z",
        windowDays: 30,
        reviewsByDay: [],
        reviewsTotal: 0,
        reviewsPerDayAvg: 0,
        retention30d: null,
        dueCards: 0,
        dueTopics: 0,
        newCards: 0,
        newExtracts: 0,
        deletions: 0,
        leeches: 0,
        retired: 0,
        dayStreak: 0,
        request,
      })),
      reviewActivity: vi.fn(async (request?: unknown) => ({
        asOf: "2026-06-07T12:00:00.000Z",
        year: 2026,
        minYear: 2025,
        maxYear: 2026,
        previousYear: 2025,
        nextYear: null,
        days: [{ date: "2026-01-01", count: 2 }],
        totalReviews: 2,
        request,
      })),
      priorityIntegrity: vi.fn(async (request?: unknown) => ({
        asOf: "2026-06-07T12:00:00.000Z",
        windowDays: 30,
        priorityAttribution: "current",
        bands: [],
        topics: [],
        sacrificed: [],
        resting: [],
        thresholdFlags: {
          aBandInflation: false,
          aBandDeferredRecently: false,
          postponeDebtHigh: false,
        },
        request,
      })),
      topicKnowledgeState: vi.fn(async (request?: unknown) => ({
        asOf: "2026-06-07T12:00:00.000Z",
        windowDays: 90,
        subjects: [
          {
            subjectType: "topic",
            subjectId: "topic-1",
            title: "Topic",
            priority: 1,
            priorityLabel: "A",
            directMemberCount: null,
            includedElementCount: 3,
            funnel: {
              read: 1,
              extracted: 1,
              distilled: 1,
              carded: 1,
              mature: 1,
              extractedOfRead: 1,
              distilledOfExtracted: 1,
              cardedOfDistilled: 1,
              matureOfCarded: 1,
            },
            stability: { young: 0, maturing: 0, mature: 1, retired: 0 },
            retention: {
              windowDays: 90,
              reviewCount: 3,
              measuredRetention: 1,
              retentionTarget: 0.9,
              directConceptTarget: null,
              deltaFromTarget: 0.1,
              snapshots: [],
            },
            staleness: { staleItems: 0, needsReverify: 0 },
            graduationState: {
              status: "graduated",
              reason: "Mature-card ratio and measured retention meet the current graduation bar.",
              thresholdVersion: "v1",
            },
          },
        ],
        graduationEvents: [
          {
            eventId: "topic:topic-1:graduated:v1",
            eventType: "current_graduated",
            subjectType: "topic",
            subjectId: "topic-1",
            title: "Topic",
            asOf: "2026-06-07T12:00:00.000Z",
            thresholdVersion: "v1",
          },
        ],
        request,
      })),
    },
    balance: {
      get: vi.fn(async (request?: unknown) => ({
        asOf: "2026-06-07T12:00:00.000Z",
        windowDays: 7,
        sourcesImported: 0,
        extractsCreated: 0,
        cardsCreated: 0,
        reviewsDueThisWeek: 0,
        inboxSources: 0,
        dueQueueItems: 0,
        imbalanced: false,
        severity: "ok",
        request,
      })),
    },
    dailyWork: {
      summary: vi.fn(async (request?: unknown) => ({
        asOf: "2026-06-08T09:00:00.000Z",
        dueQueueItems: 0,
        inboxSources: 1,
        activeUnscheduledSources: 0,
        resumeSource: null,
        recommendedAction: "triage_inbox",
        graduationEvents: [],
        request,
      })),
      ackGraduationEvents: vi.fn(async (request?: unknown) => ({
        asOf: "2026-06-08T09:00:00.000Z",
        acknowledgedEventIds:
          request && typeof request === "object" && "eventIds" in request
            ? ((request as { eventIds?: readonly string[] }).eventIds ?? [])
            : [],
        observedSubjectCount: 0,
      })),
    },
    weeklyReview: {
      summary: vi.fn(async (request?: unknown) => ({
        asOf: "2026-06-08T09:00:00.000Z",
        enabled: true,
        cadenceDays: 7,
        session: null,
        due: false,
        window: {
          start: "2026-06-02T00:00:00.000Z",
          end: "2026-06-08T09:00:00.000Z",
          days: 7,
        },
        progress: null,
        ledger: { sources: 0, extracts: 0, cards: 0, maturedCards: 0, priorityMisses: [] },
        integrity: {
          asOf: "2026-06-08T09:00:00.000Z",
          windowDays: 7,
          priorityAttribution: "current",
          bands: [],
          topics: [],
          sacrificed: [],
          resting: [],
          thresholdFlags: {
            aBandInflation: false,
            aBandDeferredRecently: false,
            postponeDebtHigh: false,
          },
        },
        decisions: {
          parked: { rows: [], totalDue: 0, limit: 8, asOf: "2026-06-08T09:00:00.000Z" },
          chronic: { rows: [], totalDue: 0, threshold: 5, limit: 8 },
          fallowSuggestions: [],
        },
        request,
      })),
      updateProgress: vi.fn(
        async (request: { taskId: string; sections: Record<string, string> }) => ({
          taskId: request.taskId,
          windowStart: "2026-06-02T00:00:00.000Z",
          windowEnd: "2026-06-08T09:00:00.000Z",
          sections: {
            ledger: "done",
            integrity: "pending",
            parked: "pending",
            chronic: "pending",
            fallow: "pending",
          },
        }),
      ),
      complete: vi.fn(async () => ({ task: null, progress: null })),
      dismiss: vi.fn(async () => ({ task: null, progress: null })),
    },
    library: {
      browse: vi.fn(async (request?: unknown) => ({ items: [], counts: {}, request })),
      parkedAction: vi.fn(async (request: unknown) => ({ item: null, request })),
    },
    backups: {
      create: vi.fn(async () => ({
        timestamp: "2026-06-07T12-30-00-000Z",
        archiveName: "2026-06-07T12-30-00-000Z.zip",
        sizeBytes: 42,
        fileCount: 2,
        schemaVersion: "0001_initial",
      })),
      openFolder: vi.fn(async () => ({ ok: true })),
      list: vi.fn(async () => ({
        backups: [
          {
            timestamp: "2026-06-07T12-30-00-000Z",
            createdAt: "2026-06-07T12:30:00.000Z",
            sizeBytes: 42,
            fileCount: 2,
            schemaVersion: "0001_initial",
            automatic: false,
          },
        ],
      })),
      restore: vi.fn(async (request: { timestamp: string }) => ({
        status: "restored",
        timestamp: request.timestamp,
        restoredAt: "2026-06-07T12:45:00.000Z",
        reloadRequired: true,
      })),
      pickArchive: vi.fn(async () => ({ path: "/backups/2026-06-07.zip" })),
      restoreFile: vi.fn(async () => ({
        status: "restored",
        timestamp: "2026-06-07T12-30-00-000Z",
        restoredAt: "2026-06-07T12:45:00.000Z",
        reloadRequired: true,
      })),
      resetLocalData: vi.fn(async () => ({
        status: "reset",
        resetAt: "2026-06-07T12:45:00.000Z",
        reloadRequired: true,
      })),
    },
    maintenance: {
      report: vi.fn(async () => ({
        duplicateCount: 0,
        cardsWithoutSourcesCount: 0,
        schedulerConsistencyCount: 0,
        parkedResurfacingCount: 1,
        orphanFileCount: 0,
        orphanBytes: 0,
        lowValueCount: 0,
        integrity: null,
      })),
      duplicates: vi.fn(async () => ({
        sourceClusters: [],
        cardClusters: [],
        extractClusters: [],
        totalDuplicates: 0,
      })),
      cardsWithoutSources: vi.fn(async () => ({ rows: [] })),
      brokenSources: vi.fn(async () => ({ rows: [] })),
      schedulerConsistency: vi.fn(async () => ({ rows: [] })),
      lowValue: vi.fn(async () => ({ rows: [] })),
      integrity: vi.fn(async () => ({
        db: { ok: true, integrityCheck: ["ok"], foreignKeyViolations: 0, mode: "quick_check" },
        vault: { ok: 0, mismatched: [], missing: [], extraFiles: [] },
      })),
      dedupe: vi.fn(async () => ({ affected: 0, batchId: "" })),
      orphanMedia: vi.fn(async () => ({ removed: 0, freedBytes: 0, vectorsPruned: 0 })),
      bulkTrash: vi.fn(async () => ({ affected: 0, batchId: "" })),
      bulkArchive: vi.fn(async () => ({ affected: 0, batchId: "" })),
      bulkPostpone: vi.fn(async () => ({ affected: 0, batchId: "" })),
      parkedResurfacing: vi.fn(async () => ({
        rows: [],
        totalDue: 1,
        limit: 50,
        asOf: "2026-06-11T12:00:00.000Z",
      })),
      parkedResurfacingApply: vi.fn(async () => ({
        applied: 1,
        skipped: [],
        batchId: "batch-1",
      })),
      chronicPostpones: vi.fn(async () => ({
        rows: [],
        totalDue: 1,
        threshold: 5,
        limit: 50,
      })),
      chronicPostponesApply: vi.fn(async () => ({
        applied: 1,
        skipped: [],
        batchId: "batch-2",
      })),
    },
    ...overrides,
  } as unknown as AppApi;
  window.appApi = fake;
  return fake;
}

afterEach(() => {
  delete window.appApi;
  vi.restoreAllMocks();
});

describe("renderer appApi wrapper", () => {
  it("detects desktop mode and throws a clear error when the bridge is absent", () => {
    expect(isDesktop()).toBe(false);
    expect(() => requireAppApi()).toThrow("window.appApi is unavailable");
  });

  it("returns the bridge when present", () => {
    const bridge = installAppApi();

    expect(isDesktop()).toBe(true);
    expect(requireAppApi()).toBe(bridge);
  });

  it("forwards common read/write methods to the narrow bridge surface", async () => {
    const bridge = installAppApi();

    await appApi.health();
    expect(bridge.app.health).toHaveBeenCalledTimes(1);

    await appApi.getSettings({ key: "daily.budget" });
    expect(bridge.settings.get).toHaveBeenCalledWith({ key: "daily.budget" });

    await appApi.updateSetting({ key: "theme", value: "dark" });
    expect(bridge.settings.update).toHaveBeenCalledWith({ key: "theme", value: "dark" });

    await appApi.listQueue({ types: ["card"] });
    expect(bridge.queue.list).toHaveBeenCalledWith({ types: ["card"] });

    await appApi.dismissSourceRetirementSuggestion({
      sourceElementId: "src-1",
      signalHash: "hash-1",
    });
    expect(bridge.sources.dismissRetirementSuggestion).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      signalHash: "hash-1",
    });

    await appApi.getDailyWorkSummary({ asOf: "2026-06-08T09:00:00.000Z" });
    expect(bridge.dailyWork.summary).toHaveBeenCalledWith({
      asOf: "2026-06-08T09:00:00.000Z",
    });

    await appApi.ackDailyWorkGraduationEvents({
      asOf: "2026-06-08T09:00:00.000Z",
      eventIds: ["topic:topic-1:graduated:v1"],
    });
    expect(bridge.dailyWork.ackGraduationEvents).toHaveBeenCalledWith({
      asOf: "2026-06-08T09:00:00.000Z",
      eventIds: ["topic:topic-1:graduated:v1"],
    });

    await appApi.getWeeklyReviewSummary({ asOf: "2026-06-08T09:00:00.000Z" });
    expect(bridge.weeklyReview.summary).toHaveBeenCalledWith({
      asOf: "2026-06-08T09:00:00.000Z",
    });

    await appApi.updateWeeklyReviewProgress({
      taskId: "weekly-1",
      sections: { ledger: "done" },
    });
    expect(bridge.weeklyReview.updateProgress).toHaveBeenCalledWith({
      taskId: "weekly-1",
      sections: { ledger: "done" },
    });

    await appApi.createSynthesisNote({ title: "New note" });
    expect(bridge.synthesis.create).toHaveBeenCalledWith({ title: "New note" });

    await appApi.setExtractFate({ id: "ex-1", fate: "reference" });
    expect(bridge.extracts.setFate).toHaveBeenCalledWith({ id: "ex-1", fate: "reference" });

    await appApi.reactivateExtractFate({ id: "ex-1" });
    expect(bridge.extracts.reactivateFate).toHaveBeenCalledWith({ id: "ex-1" });

    await appApi.fallowTopic({
      topicId: "topic-1",
      fallowUntil: "2026-07-01T00:00:00.000Z",
      fallowReason: "Seasonal pause",
    });
    expect(bridge.topics.fallow).toHaveBeenCalledWith({
      topicId: "topic-1",
      fallowUntil: "2026-07-01T00:00:00.000Z",
      fallowReason: "Seasonal pause",
    });

    await appApi.unfallowTopic({ topicId: "topic-1" });
    expect(bridge.topics.unfallow).toHaveBeenCalledWith({ topicId: "topic-1" });

    await appApi.libraryParkedAction({ id: "src-1", action: { kind: "queueSoon" } });
    expect(bridge.library.parkedAction).toHaveBeenCalledWith({
      id: "src-1",
      action: { kind: "queueSoon" },
    });
  });

  it("returns queue time estimates from the existing listQueue wrapper", async () => {
    const result = {
      items: [],
      counts: {
        all: 2,
        card: 1,
        source: 1,
        extract: 0,
        topic: 0,
        task: 0,
        highPriority: 1,
        overdue: 0,
        protected: 1,
      },
      budget: { used: 2, target: 20 },
      timeEstimate: {
        confidence: "default",
        totalMinutes: 12,
        pricedItemCount: 2,
        items: [
          { id: "card-1", estimatedMinutes: 2, confidence: "learned", basis: "qa" },
          { id: "source-1", estimatedMinutes: 10, confidence: "default", basis: "source" },
        ],
      },
    } satisfies QueueListResult;
    const bridge = installAppApi();
    vi.mocked(bridge.queue.list).mockResolvedValue(result);

    await expect(appApi.listQueue({ types: ["card"] })).resolves.toBe(result);
    expect(bridge.queue.list).toHaveBeenCalledWith({ types: ["card"] });
  });

  it("forwards parked resurfacing maintenance methods", async () => {
    const bridge = installAppApi();

    await appApi.maintenance.parkedResurfacing({ limit: 50 });
    expect(bridge.maintenance.parkedResurfacing).toHaveBeenCalledWith({ limit: 50 });

    await appApi.maintenance.parkedResurfacingApply({
      decisions: [{ id: "src-1", kind: "queueNow" }],
    });
    expect(bridge.maintenance.parkedResurfacingApply).toHaveBeenCalledWith({
      decisions: [{ id: "src-1", kind: "queueNow" }],
    });

    await appApi.maintenance.chronicPostpones({ limit: 50 });
    expect(bridge.maintenance.chronicPostpones).toHaveBeenCalledWith({ limit: 50 });

    await appApi.maintenance.chronicPostponesApply({
      decisions: [{ id: "src-1", kind: "demote" }],
    });
    expect(bridge.maintenance.chronicPostponesApply).toHaveBeenCalledWith({
      decisions: [{ id: "src-1", kind: "demote" }],
    });
  });

  it("forwards review activity requests to the analytics bridge surface", async () => {
    const bridge = installAppApi();

    await expect(
      appApi.getReviewActivity({ asOf: "2026-06-07T12:00:00.000Z", year: 2026 }),
    ).resolves.toMatchObject({
      year: 2026,
      previousYear: 2025,
      nextYear: null,
      days: [{ date: "2026-01-01", count: 2 }],
      totalReviews: 2,
    });
    expect(bridge.analytics.reviewActivity).toHaveBeenCalledWith({
      asOf: "2026-06-07T12:00:00.000Z",
      year: 2026,
    });
  });

  it("forwards priority integrity requests to the analytics bridge surface", async () => {
    const bridge = installAppApi();
    const request = {
      asOf: "2026-06-07T12:00:00.000Z",
      windowDays: 14,
      sacrificedLimit: 5,
      topicLimit: 6,
    };

    await expect(appApi.getPriorityIntegrity(request)).resolves.toMatchObject({
      asOf: "2026-06-07T12:00:00.000Z",
      priorityAttribution: "current",
    });
    expect(bridge.analytics.priorityIntegrity).toHaveBeenCalledWith(request);
  });

  it("forwards topic knowledge-state requests to the analytics bridge surface", async () => {
    const bridge = installAppApi();
    const request = {
      asOf: "2026-06-07T12:00:00.000Z",
      windowDays: 90,
      limit: 10,
      subjectType: "topic" as const,
      subjectId: "topic-1",
    };

    await expect(appApi.getTopicKnowledgeState(request)).resolves.toMatchObject({
      asOf: "2026-06-07T12:00:00.000Z",
      subjects: [{ subjectId: "topic-1", graduationState: { status: "graduated" } }],
      graduationEvents: [{ eventId: "topic:topic-1:graduated:v1" }],
    });
    expect(bridge.analytics.topicKnowledgeState).toHaveBeenCalledWith(request);
  });

  it("returns an empty topic knowledge-state snapshot outside desktop mode", async () => {
    await expect(
      appApi.getTopicKnowledgeState({
        asOf: "2026-06-07T12:00:00.000Z",
        windowDays: 30,
      }),
    ).resolves.toEqual({
      asOf: "2026-06-07T12:00:00.000Z",
      windowDays: 30,
      subjects: [],
      graduationEvents: [],
    });
  });

  it("forwards the fixed backups folder command without a payload", async () => {
    const bridge = installAppApi();

    await expect(appApi.openBackupsFolder()).resolves.toEqual({ ok: true });

    expect(bridge.backups.openFolder).toHaveBeenCalledTimes(1);
    expect(bridge.backups.openFolder).toHaveBeenCalledWith();
  });

  it("forwards backup lifecycle methods to the narrow bridge surface", async () => {
    const bridge = installAppApi();

    await appApi.createBackup();
    expect(bridge.backups.create).toHaveBeenCalledTimes(1);

    await appApi.listBackups();
    expect(bridge.backups.list).toHaveBeenCalledTimes(1);

    await appApi.restoreBackup({
      timestamp: "2026-06-07T12-30-00-000Z",
      confirm: true,
      phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
    });
    expect(bridge.backups.restore).toHaveBeenCalledWith({
      timestamp: "2026-06-07T12-30-00-000Z",
      confirm: true,
      phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
    });

    await expect(appApi.pickBackupArchive()).resolves.toEqual({
      path: "/backups/2026-06-07.zip",
    });
    expect(bridge.backups.pickArchive).toHaveBeenCalledTimes(1);
    expect(bridge.backups.pickArchive).toHaveBeenCalledWith();

    await appApi.restoreBackupFromFile({
      path: "/backups/2026-06-07.zip",
      confirm: true,
      phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
    });
    expect(bridge.backups.restoreFile).toHaveBeenCalledWith({
      path: "/backups/2026-06-07.zip",
      confirm: true,
      phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
    });

    await appApi.resetLocalData({
      confirm: true,
      phrase: RESET_LOCAL_DATA_CONFIRMATION_PHRASE,
    });
    expect(bridge.backups.resetLocalData).toHaveBeenCalledWith({
      confirm: true,
      phrase: RESET_LOCAL_DATA_CONFIRMATION_PHRASE,
    });
  });

  it("throws for backup listing when the desktop bridge is absent", async () => {
    expect(() => appApi.listBackups()).toThrow("window.appApi is unavailable");
  });

  it("forwards searchQuery and preserves the full SearchCounts shape", async () => {
    const result = {
      results: [],
      counts: {
        byType: { source: 2, extract: 1, card: 3 },
        byConcept: { "concept-1": 4 },
        byPriority: { A: 1, B: 2, C: 3, D: 4 },
      },
    } satisfies SearchQueryResult;
    const bridge = installAppApi({
      search: { query: vi.fn(async () => result) },
    } as Partial<AppApi>);

    await expect(appApi.searchQuery({ q: "memory", includeCounts: false })).resolves.toEqual(
      result,
    );
    expect(bridge.search.query).toHaveBeenCalledWith({ q: "memory", includeCounts: false });
  });

  it("routes document-mark helpers through documents.marks", async () => {
    const bridge = installAppApi();

    await appApi.addDocumentMark({
      elementId: "src-1",
      blockId: "blk-1",
      markType: "highlight",
      range: [0, 4],
    });
    expect(bridge.documents.marks.add).toHaveBeenCalledWith({
      elementId: "src-1",
      blockId: "blk-1",
      markType: "highlight",
      range: [0, 4],
    });

    await appApi.removeDocumentMark({ markId: "mark-1" });
    expect(bridge.documents.marks.remove).toHaveBeenCalledWith({ markId: "mark-1" });

    await appApi.listDocumentMarks({ elementId: "src-1", markType: "processed_span" });
    expect(bridge.documents.marks.list).toHaveBeenCalledWith({
      elementId: "src-1",
      markType: "processed_span",
    });
  });

  it("routes block-processing helpers through blockProcessing", async () => {
    const bridge = installAppApi();

    await appApi.listBlockProcessing({ sourceElementId: "src-1" });
    expect(bridge.blockProcessing.list).toHaveBeenCalledWith({ sourceElementId: "src-1" });

    await appApi.getBlockProcessingSummary({ sourceElementId: "src-1" });
    expect(bridge.blockProcessing.summary).toHaveBeenCalledWith({ sourceElementId: "src-1" });

    await appApi.markBlockProcessed({ sourceElementId: "src-1", stableBlockId: "blk-1" });
    expect(bridge.blockProcessing.markProcessed).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      stableBlockId: "blk-1",
    });

    await appApi.markBlockIgnored({ sourceElementId: "src-1", stableBlockId: "blk-1" });
    expect(bridge.blockProcessing.markIgnored).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      stableBlockId: "blk-1",
    });

    await appApi.markBlockNeedsLater({ sourceElementId: "src-1", stableBlockId: "blk-1" });
    expect(bridge.blockProcessing.markNeedsLater).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      stableBlockId: "blk-1",
    });

    await appApi.markBlockUnread({ sourceElementId: "src-1", stableBlockId: "blk-1" });
    expect(bridge.blockProcessing.markUnread).toHaveBeenCalledWith({
      sourceElementId: "src-1",
      stableBlockId: "blk-1",
    });
  });
});
