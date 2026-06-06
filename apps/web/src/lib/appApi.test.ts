import { afterEach, describe, expect, it, vi } from "vitest";
import { type AppApi, appApi, isDesktop, requireAppApi, type SearchQueryResult } from "./appApi";

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

    await expect(appApi.searchQuery({ q: "memory" })).resolves.toEqual(result);
    expect(bridge.search.query).toHaveBeenCalledWith({ q: "memory" });
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
