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
    getSettings: vi.fn((key: string) => ({ key, value: "stored" })),
    updateSetting: vi.fn(),
    listQueue: vi.fn(() => ({ items: [] })),
    actOnQueueItem: vi.fn(),
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
