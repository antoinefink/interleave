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

    await api().sources.dismissRetirementSuggestion({
      sourceElementId: "src-1",
      signalHash: "hash-1",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.sourcesDismissRetirementSuggestion,
      { sourceElementId: "src-1", signalHash: "hash-1" },
    );

    await api().cards.delete({ cardId: "card-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.cardsDelete, {
      cardId: "card-1",
    });

    await api().extracts.setFate({ id: "ex-1", fate: "reference" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.extractsSetFate, {
      id: "ex-1",
      fate: "reference",
    });

    await api().extracts.reactivateFate({ id: "ex-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.extractsReactivateFate, {
      id: "ex-1",
    });

    await api().conversion.sessionPreview({ limit: 10 });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.conversionSessionPreview, {
      limit: 10,
    });

    await api().conversion.prefetchDrafts({
      sessionId: "session-1",
      action: "suggest_qa",
      consentedAt: "2026-06-13T08:00:00.000Z",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.conversionPrefetchDrafts, {
      sessionId: "session-1",
      action: "suggest_qa",
      consentedAt: "2026-06-13T08:00:00.000Z",
    });

    await api().conversion.createCard({
      sessionId: "session-1",
      suggestionId: "suggestion-1",
      extractId: "ex-1",
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.conversionCreateCard, {
      sessionId: "session-1",
      suggestionId: "suggestion-1",
      extractId: "ex-1",
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    });

    await api().conversion.setFate({
      sessionId: "session-1",
      id: "ex-1",
      fate: "reference",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.conversionSetFate, {
      sessionId: "session-1",
      id: "ex-1",
      fate: "reference",
    });

    await api().backups.list();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.backupsList);

    await api().analytics.reviewActivity({ asOf: "2026-06-07T12:00:00.000Z", year: 2026 });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.analyticsReviewActivity, {
      asOf: "2026-06-07T12:00:00.000Z",
      year: 2026,
    });

    await api().analytics.priorityIntegrity({
      asOf: "2026-06-07T12:00:00.000Z",
      windowDays: 14,
      sacrificedLimit: 5,
      topicLimit: 6,
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.analyticsPriorityIntegrity, {
      asOf: "2026-06-07T12:00:00.000Z",
      windowDays: 14,
      sacrificedLimit: 5,
      topicLimit: 6,
    });

    await api().analytics.topicKnowledgeState({
      asOf: "2026-06-07T12:00:00.000Z",
      windowDays: 90,
      limit: 10,
      subjectType: "topic",
      subjectId: "topic-1",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.analyticsTopicKnowledgeState,
      {
        asOf: "2026-06-07T12:00:00.000Z",
        windowDays: 90,
        limit: 10,
        subjectType: "topic",
        subjectId: "topic-1",
      },
    );

    await api().topics.fallow({
      topicId: "topic-1",
      fallowUntil: "2026-07-01T00:00:00.000Z",
      fallowReason: "Seasonal pause",
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.topicsFallow, {
      topicId: "topic-1",
      fallowUntil: "2026-07-01T00:00:00.000Z",
      fallowReason: "Seasonal pause",
    });
    await api().topics.unfallow({ topicId: "topic-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.topicsUnfallow, {
      topicId: "topic-1",
    });

    // Lineage-aware delete bridge surface (T135) — the three new functions exist on
    // the typed bridge and route to the right channels with the payload unchanged.
    await api().elements.countDescendants({ id: "el-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.elementsCountDescendants, {
      id: "el-1",
    });
    await api().elements.softDeleteSubtree({ id: "el-1", includeSubtree: true });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.elementsSoftDeleteSubtree, {
      id: "el-1",
      includeSubtree: true,
    });
    await api().trash.restoreBatch({ batchId: "batch-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.trashRestoreBatch, {
      batchId: "batch-1",
    });

    await api().library.parkedAction({ id: "src-1", action: { kind: "queueSoon" } });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.libraryParkedAction, {
      id: "src-1",
      action: { kind: "queueSoon" },
    });

    await api().maintenance.parkedResurfacing({ limit: 50 });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.maintenanceParkedResurfacing,
      { limit: 50 },
    );

    await api().maintenance.parkedResurfacingApply({
      decisions: [{ id: "src-1", kind: "queueNow" }],
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.maintenanceParkedResurfacingApply,
      { decisions: [{ id: "src-1", kind: "queueNow" }] },
    );

    await api().maintenance.chronicPostpones({ limit: 50 });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.maintenanceChronicPostpones, {
      limit: 50,
    });

    await api().maintenance.chronicPostponesApply({
      decisions: [{ id: "src-1", kind: "demote" }],
    });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.maintenanceChronicPostponesApply,
      { decisions: [{ id: "src-1", kind: "demote" }] },
    );

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

    // T126 — bulk inbox triage apply + undo route to their fixed channels unchanged.
    await api().inbox.bulkTriage({ ids: ["el_1", "el_2"], action: "queueSoon", priority: "B" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.inboxBulkTriage, {
      ids: ["el_1", "el_2"],
      action: "queueSoon",
      priority: "B",
    });

    await api().inbox.bulkTriageUndo({ batchId: "batch-bulk-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.inboxBulkTriageUndo, {
      batchId: "batch-bulk-1",
    });
  });

  it("normalizes optional request payloads to empty objects where the contract expects one", async () => {
    await api().settings.get();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.settingsGet, {});

    await api().queue.list();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.queueList, {});

    await api().dailyWork.summary();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.dailyWorkSummary, {});

    await api().dailyWork.ackGraduationEvents();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.dailyWorkAckGraduationEvents,
      {},
    );

    await api().dailyWork.undoAutoPostponeReceipt({ batchId: "batch-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(
      IPC_CHANNELS.dailyWorkUndoAutoPostponeReceipt,
      { batchId: "batch-1" },
    );

    await api().extractAging.preview();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.extractAgingPreview, {});

    await api().extractAging.apply();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.extractAgingApply, {});

    await api().extractAging.undoReceipt({ batchId: "batch-aging-1" });
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.extractAgingUndoReceipt, {
      batchId: "batch-aging-1",
    });

    await api().weeklyReview.summary();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.weeklyReviewSummary, {});

    await api().review.sessionNext();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.reviewSessionNext, {});

    await api().semantic.status();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.semanticStatus, {});

    await api().jobs.list();
    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.jobsList, {});
  });

  it("forwards queue list requests through the existing queue:list channel without reshaping", async () => {
    const request: NonNullable<Parameters<AppApi["queue"]["list"]>[0]> = {
      asOf: "2027-06-01T12:00:00.000Z",
      types: ["card"],
      mode: "review",
    };

    await api().queue.list(request);

    expect(electronMock.invoke).toHaveBeenLastCalledWith(IPC_CHANNELS.queueList, request);
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
