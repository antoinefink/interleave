import { describe, expect, it, vi } from "vitest";
import type { AppApi } from "../shared/contract";

const electronMock = vi.hoisted(() => {
  const state: { exposedName: string | null; exposedApi: unknown } = {
    exposedName: null,
    exposedApi: null,
  };
  return {
    state,
    exposeInMainWorld: vi.fn((name: string, api: unknown) => {
      state.exposedName = name;
      state.exposedApi = api;
    }),
    invoke: vi.fn(async (channel: string, payload?: unknown) => ({ channel, payload })),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
});

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMock.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMock.invoke,
    on: electronMock.on,
    removeListener: electronMock.removeListener,
  },
}));

import { IPC_CHANNELS } from "../shared/channels";
import "./index";

function api(): AppApi {
  return electronMock.state.exposedApi as AppApi;
}

describe("preload bridge", () => {
  it("exposes only appApi in the isolated renderer world", () => {
    expect(electronMock.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(electronMock.state.exposedName).toBe("appApi");
    expect(api()).toEqual(
      expect.objectContaining({ app: expect.any(Object), db: expect.any(Object) }),
    );
    expect((api().db as unknown as { query?: unknown }).query).toBeUndefined();
    expect((api() as unknown as { fs?: unknown; ipcRenderer?: unknown }).fs).toBeUndefined();
    expect((api() as unknown as { ipcRenderer?: unknown }).ipcRenderer).toBeUndefined();
  });

  it("routes invoke-only methods to their fixed IPC channels", async () => {
    await api().app.health();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.appHealth);

    await api().backups.openFolder();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.backupsOpenFolder);

    await api().sources.importManual({ title: "T", body: "Body", priority: "B" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.sourcesImportManual, {
      title: "T",
      body: "Body",
      priority: "B",
    });

    await api().cards.delete({ cardId: "card-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.cardsDelete, {
      cardId: "card-1",
    });

    await api().backups.list();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.backupsList);

    await api().analytics.reviewActivity({ asOf: "2026-06-07T12:00:00.000Z", year: 2026 });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.analyticsReviewActivity, {
      asOf: "2026-06-07T12:00:00.000Z",
      year: 2026,
    });

    await api().library.parkedAction({ id: "src-1", action: { kind: "queueSoon" } });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.libraryParkedAction, {
      id: "src-1",
      action: { kind: "queueSoon" },
    });

    await api().backups.restore({
      timestamp: "2026-06-07T12-30-00-000Z",
      confirm: true,
      phrase: "RESTORE BACKUP",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.backupsRestore, {
      timestamp: "2026-06-07T12-30-00-000Z",
      confirm: true,
      phrase: "RESTORE BACKUP",
    });

    await api().backups.pickArchive();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.backupsPickArchive);

    await api().backups.restoreFile({
      path: "/backups/2026-06-07.zip",
      confirm: true,
      phrase: "RESTORE BACKUP",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.backupsRestoreFile, {
      path: "/backups/2026-06-07.zip",
      confirm: true,
      phrase: "RESTORE BACKUP",
    });

    await api().backups.resetLocalData({
      confirm: true,
      phrase: "START FROM SCRATCH",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.backupsResetLocalData, {
      confirm: true,
      phrase: "START FROM SCRATCH",
    });
  });

  it("normalizes optional request payloads to empty objects where the contract expects one", async () => {
    await api().settings.get();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settingsGet, {});

    await api().queue.list();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.queueList, {});

    await api().dailyWork.summary();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.dailyWorkSummary, {});

    await api().review.sessionNext();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.reviewSessionNext, {});

    await api().semantic.status();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.semanticStatus, {});

    await api().jobs.list();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.jobsList, {});
  });

  it("forwards receive-only subscriptions without exposing raw events", () => {
    const callback = vi.fn();
    const unsubscribe = api().jobs.subscribe(callback);
    const [channel, listener] = electronMock.on.mock.calls.at(-1) ?? [];
    const summary = { id: "job-1", type: "import_url", status: "done" };

    expect(channel).toBe(IPC_CHANNELS.jobsUpdated);
    (listener as (event: unknown, summary: unknown) => void)({ sender: "raw-event" }, summary);
    expect(callback).toHaveBeenCalledWith(summary);

    unsubscribe();
    expect(electronMock.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.jobsUpdated, listener);

    const openSource = vi.fn();
    const unsubscribeOpenSource = api().sources.onOpenReader(openSource);
    const [openChannel, openListener] = electronMock.on.mock.calls.at(-1) ?? [];

    expect(openChannel).toBe(IPC_CHANNELS.sourcesOpenReader);
    (openListener as (event: unknown, sourceId: string) => void)({ sender: "raw-event" }, "src-1");
    expect(openSource).toHaveBeenCalledWith("src-1");

    unsubscribeOpenSource();
    expect(electronMock.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.sourcesOpenReader,
      openListener,
    );
  });

  it("returns unsubscribe functions for narrow native menu events", () => {
    const showShortcuts = vi.fn();
    const unsubscribeShortcuts = api().menu.onShowShortcuts(showShortcuts);
    const shortcutsListener = electronMock.on.mock.calls.at(-1)?.[1] as () => void;
    shortcutsListener();
    expect(showShortcuts).toHaveBeenCalledTimes(1);
    unsubscribeShortcuts();
    expect(electronMock.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.menuShowShortcuts,
      shortcutsListener,
    );

    const createBackup = vi.fn();
    const unsubscribeBackup = api().menu.onCreateBackup(createBackup);
    const backupListener = electronMock.on.mock.calls.at(-1)?.[1] as () => void;
    backupListener();
    expect(createBackup).toHaveBeenCalledTimes(1);
    unsubscribeBackup();
    expect(electronMock.removeListener).toHaveBeenCalledWith(
      IPC_CHANNELS.menuCreateBackup,
      backupListener,
    );
  });
});
