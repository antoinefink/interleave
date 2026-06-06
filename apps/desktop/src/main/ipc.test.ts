import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
    getAllWindows: vi.fn(),
    fromWebContents: vi.fn(() => null),
  };
});

vi.mock("electron", () => ({
  app: { getVersion: () => "0.2.0", isPackaged: false },
  BrowserWindow: {
    getAllWindows: electron.getAllWindows,
    fromWebContents: electron.fromWebContents,
  },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler },
}));

import { IPC_CHANNELS } from "../shared/contract";
import { registerIpcHandlers } from "./ipc";

function fakeDbService() {
  return {
    isOpen: true,
    isMigrated: true,
    ping: vi.fn(() => true),
    getStatus: vi.fn(() => ({ open: true, migrated: true })),
    setElementPriority: vi.fn(),
    getSettings: vi.fn((key: string) => ({ key, value: "stored" })),
    updateSetting: vi.fn(),
    updateAppSettings: vi.fn(),
    listQueue: vi.fn(() => ({ items: [] })),
    actOnQueueItem: vi.fn(),
    createCard: vi.fn(),
    createExtraction: vi.fn(),
    updateCard: vi.fn(),
    reviewCard: vi.fn(),
    reviewGrade: vi.fn(),
    scheduleQueueItem: vi.fn(),
    undoQueueAction: vi.fn(),
    previewAutoPostpone: vi.fn(),
    applyAutoPostpone: vi.fn(),
    previewCatchUp: vi.fn(),
    applyCatchUp: vi.fn(),
    previewVacation: vi.fn(),
    applyVacation: vi.fn(),
    importManualSource: vi.fn(),
    search: vi.fn(),
    listInbox: vi.fn(() => ({ items: [] })),
    triageInboxItem: vi.fn(),
    getInboxItem: vi.fn(),
  };
}

beforeEach(() => {
  electron.handlers.clear();
  electron.handle.mockClear();
  electron.removeHandler.mockClear();
  electron.getAllWindows.mockReset();
  electron.fromWebContents.mockClear();
});

describe("registerIpcHandlers", () => {
  it("registers validated handlers and disposes every declared IPC channel", () => {
    const db = fakeDbService();
    const dispose = registerIpcHandlers(db as never);

    expect(electron.handle).toHaveBeenCalledWith(IPC_CHANNELS.appHealth, expect.any(Function));
    expect(electron.handle).toHaveBeenCalledWith(IPC_CHANNELS.dbGetStatus, expect.any(Function));
    expect(electron.handle).toHaveBeenCalledWith(IPC_CHANNELS.settingsGet, expect.any(Function));

    expect(electron.handlers.get(IPC_CHANNELS.appHealth)?.()).toMatchObject({
      status: "ok",
      appVersion: "0.2.0",
      dbOpen: true,
      migrated: true,
    });
    expect(electron.handlers.get(IPC_CHANNELS.dbGetStatus)?.()).toEqual({
      open: true,
      migrated: true,
    });
    expect(electron.handlers.get(IPC_CHANNELS.settingsGet)?.({}, { key: "theme" })).toEqual({
      key: "theme",
      value: "stored",
    });

    dispose();

    expect(electron.removeHandler).toHaveBeenCalledTimes(Object.values(IPC_CHANNELS).length);
    expect(electron.handlers.size).toBe(0);
  });

  it("rejects malformed renderer payloads before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    expect(() =>
      electron.handlers.get(IPC_CHANNELS.queueAct)?.({}, { id: "el_1", action: { kind: "nope" } }),
    ).toThrow();
    expect(db.actOnQueueItem).not.toHaveBeenCalled();
  });

  it("validates high-risk command payloads before invoking the corresponding DB service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    const malformed = [
      { channel: IPC_CHANNELS.settingsUpdate, payload: {}, service: "updateSetting" },
      { channel: IPC_CHANNELS.elementsSetPriority, payload: { id: "el_1", priority: "Z" }, service: "setElementPriority" },
      {
        channel: IPC_CHANNELS.queueSchedule,
        payload: { id: "el_1", choice: { kind: "invalid" as never } },
        service: "scheduleQueueItem",
      },
      {
        channel: IPC_CHANNELS.queueUndo,
        payload: { id: "el_1", undo: { kind: "status", previousStatus: "z" } },
        service: "undoQueueAction",
      },
      {
        channel: IPC_CHANNELS.queueAutoPostpone,
        payload: { asOf: "invalid-timestamp" },
        service: "previewAutoPostpone",
      },
      {
        channel: IPC_CHANNELS.queueAutoPostponeApply,
        payload: { asOf: "invalid-timestamp" },
        service: "applyAutoPostpone",
      },
      {
        channel: IPC_CHANNELS.queueCatchUp,
        payload: { spreadDays: 0 },
        service: "previewCatchUp",
      },
      {
        channel: IPC_CHANNELS.queueCatchUpApply,
        payload: { spreadDays: 0 },
        service: "applyCatchUp",
      },
      {
        channel: IPC_CHANNELS.queueVacation,
        payload: { awayStart: "2027-01-02T00:00:00.000Z", awayEnd: "2027-01-01T00:00:00.000Z" },
        service: "previewVacation",
      },
      {
        channel: IPC_CHANNELS.queueVacationApply,
        payload: { awayStart: "2027-01-02T00:00:00.000Z", awayEnd: "2027-01-01T00:00:00.000Z" },
        service: "applyVacation",
      },
      { channel: IPC_CHANNELS.sourcesImportManual, payload: {}, service: "importManualSource" },
      {
        channel: IPC_CHANNELS.extractionsCreate,
        payload: { sourceElementId: "el_1", selectedText: "", blockIds: [] },
        service: "createExtraction",
      },
      {
        channel: IPC_CHANNELS.cardsUpdate,
        payload: { cardId: "el_1" },
        service: "updateCard",
      },
      {
        channel: IPC_CHANNELS.reviewGrade,
        payload: { cardId: "el_1", rating: "bad", responseMs: 1000 },
        service: "reviewGrade",
      },
      {
        channel: IPC_CHANNELS.searchQuery,
        payload: { q: new Array(600).fill("x").join("") },
        service: "search",
      },
    ];

    const invocations = [
      "updateSetting",
      "setElementPriority",
      "scheduleQueueItem",
      "undoQueueAction",
      "previewAutoPostpone",
      "applyAutoPostpone",
      "previewCatchUp",
      "applyCatchUp",
      "previewVacation",
      "applyVacation",
      "importManualSource",
      "createExtraction",
      "updateCard",
      "reviewGrade",
      "search",
    ] as const;
    invocations.forEach((name) => {
      expect(db[name as keyof typeof db]).not.toHaveBeenCalled();
    });

    for (const item of malformed) {
      const handler = electron.handlers.get(item.channel);
      expect(handler).toBeTypeOf("function");
      expect(() => handler?.({}, item.payload as never)).toThrow();
      expect(db[item.service as keyof typeof db]).not.toHaveBeenCalled();
    }
  });

  it("accepts valid payloads and forwards them to the underlying DB service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    electron.handlers.get(IPC_CHANNELS.settingsUpdate)?.({}, { key: "dailyReviewBudget", value: 24 });
    expect(db.updateSetting).toHaveBeenCalledWith("dailyReviewBudget", 24);

    electron.handlers.get(IPC_CHANNELS.elementsSetPriority)?.({}, { id: "el_1", priority: "A" });
    expect(db.setElementPriority).toHaveBeenCalledWith({ id: "el_1", priority: "A" });

    electron.handlers.get(IPC_CHANNELS.queueSchedule)?.({}, { id: "el_1", choice: { kind: "tomorrow" } });
    expect(db.scheduleQueueItem).toHaveBeenCalledWith({
      id: "el_1",
      choice: { kind: "tomorrow" },
    });

    electron.handlers.get(IPC_CHANNELS.queueUndo)?.({}, {
      id: "el_1",
      undo: { kind: "restore", previousStatus: "active" },
    });
    expect(db.undoQueueAction).toHaveBeenCalledWith({
      id: "el_1",
      undo: { kind: "restore", previousStatus: "active" },
    });

    electron.handlers.get(IPC_CHANNELS.queueAutoPostpone)?.({}, {});
    expect(db.previewAutoPostpone).toHaveBeenCalledWith({});

    electron.handlers.get(IPC_CHANNELS.queueAutoPostponeApply)?.({}, {});
    expect(db.applyAutoPostpone).toHaveBeenCalledWith({});

    electron.handlers.get(IPC_CHANNELS.queueCatchUp)?.({}, {});
    expect(db.previewCatchUp).toHaveBeenCalledWith({});

    electron.handlers.get(IPC_CHANNELS.queueCatchUpApply)?.({}, { spreadDays: 3 });
    expect(db.applyCatchUp).toHaveBeenCalledWith({ spreadDays: 3 });

    electron.handlers.get(IPC_CHANNELS.queueVacation)?.({}, {
      awayStart: "2027-01-01T00:00:00.000Z",
      awayEnd: "2027-01-03T23:59:59.000Z",
      asOf: "2027-01-01T00:00:00.000Z",
    });
    expect(db.previewVacation).toHaveBeenCalledWith({
      awayStart: "2027-01-01T00:00:00.000Z",
      awayEnd: "2027-01-03T23:59:59.000Z",
      asOf: "2027-01-01T00:00:00.000Z",
    });

    electron.handlers.get(IPC_CHANNELS.queueVacationApply)?.({}, {
      awayStart: "2027-01-01T00:00:00.000Z",
      awayEnd: "2027-01-03T23:59:59.000Z",
      asOf: "2027-01-01T00:00:00.000Z",
    });
    expect(db.applyVacation).toHaveBeenCalledWith({
      awayStart: "2027-01-01T00:00:00.000Z",
      awayEnd: "2027-01-03T23:59:59.000Z",
      asOf: "2027-01-01T00:00:00.000Z",
    });

    electron.handlers.get(IPC_CHANNELS.sourcesImportManual)?.({}, { title: "From test" });
    expect(db.importManualSource).toHaveBeenCalledWith({ title: "From test" });

    electron.handlers.get(IPC_CHANNELS.extractionsCreate)?.({}, {
      sourceElementId: "el_1",
      selectedText: "selected",
      blockIds: ["b_1"],
    });
    expect(db.createExtraction).toHaveBeenCalledWith({
      sourceElementId: "el_1",
      selectedText: "selected",
      blockIds: ["b_1"],
    });

    electron.handlers.get(IPC_CHANNELS.cardsUpdate)?.({}, {
      cardId: "el_1",
      prompt: "What changed?",
    });
    expect(db.updateCard).toHaveBeenCalledWith({ cardId: "el_1", prompt: "What changed?" });

    electron.handlers.get(IPC_CHANNELS.reviewGrade)?.({}, {
      cardId: "el_1",
      rating: "good",
      responseMs: 1100,
      asOf: "2027-01-01T00:00:00.000Z",
    });
    expect(db.reviewGrade).toHaveBeenCalledWith({
      cardId: "el_1",
      rating: "good",
      responseMs: 1100,
      asOf: "2027-01-01T00:00:00.000Z",
    });

    electron.handlers.get(IPC_CHANNELS.searchQuery)?.({}, { q: "term", limit: 50 });
    expect(db.search).toHaveBeenCalledWith({ q: "term", limit: 50 });
  });

  it("validates cards.create payloads before DB service invocation", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    const cardsCreate = electron.handlers.get(IPC_CHANNELS.cardsCreate);
    expect(cardsCreate).toBeTypeOf("function");

    expect(() =>
      cardsCreate?.({}, { kind: "qa", prompt: "What is X?", answer: "Y" }),
    ).toThrow();
    expect(db.createCard).not.toHaveBeenCalled();

    expect(() =>
      cardsCreate?.(
        {},
        { extractId: "el_1", kind: "qa", prompt: "What is X?", answer: "Y" },
      ),
    ).not.toThrow();
    expect(db.createCard).toHaveBeenCalledWith({
      extractId: "el_1",
      kind: "qa",
      prompt: "What is X?",
      answer: "Y",
    });
  });

  it("throws clearly when capture or job handlers are registered without their runtime deps", async () => {
    registerIpcHandlers(fakeDbService() as never);

    expect(() => electron.handlers.get(IPC_CHANNELS.captureGetPairing)?.()).toThrow(
      "capture: handler registered without a capture controller",
    );
    expect(() => electron.handlers.get(IPC_CHANNELS.jobsList)?.({}, {})).toThrow(
      "jobs: handler registered without a background runner",
    );
  });

  it("broadcasts runner job updates to live renderer windows and unsubscribes on dispose", () => {
    const sent: unknown[] = [];
    const liveWindow = {
      isDestroyed: () => false,
      webContents: { send: (...args: unknown[]) => sent.push(args) },
    };
    const destroyedWindow = {
      isDestroyed: () => true,
      webContents: { send: (...args: unknown[]) => sent.push(args) },
    };
    electron.getAllWindows.mockReturnValue([liveWindow, destroyedWindow]);
    const observer: { current: ((job: never) => void) | null } = { current: null };
    const unsubscribe = vi.fn();
    const runner = {
      observe: vi.fn((fn) => {
        observer.current = fn;
        return unsubscribe;
      }),
      list: vi.fn(() => []),
    };
    const dispose = registerIpcHandlers(fakeDbService() as never, { runner } as never);

    if (!observer.current) throw new Error("runner observer was not registered");
    observer.current({
      id: "job-1",
      type: "url_import",
      status: "running",
      progress: { ratio: 0.42, note: "fetching" },
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    } as never);

    expect(sent).toEqual([
      [
        IPC_CHANNELS.jobsUpdated,
        {
          id: "job-1",
          type: "url_import",
          status: "running",
          progressRatio: 42,
          progressNote: "fetching",
          error: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    ]);

    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
