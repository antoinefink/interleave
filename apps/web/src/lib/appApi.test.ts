import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AppApi,
  appApi,
  isDesktop,
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
      resetLocalData: vi.fn(async () => ({
        status: "reset",
        resetAt: "2026-06-07T12:45:00.000Z",
        reloadRequired: true,
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

    await appApi.createSynthesisNote({ title: "New note" });
    expect(bridge.synthesis.create).toHaveBeenCalledWith({ title: "New note" });
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
});
