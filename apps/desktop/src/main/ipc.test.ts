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
    openPath: vi.fn(async () => ""),
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
  shell: { openPath: electron.openPath },
}));

import { dialog } from "electron";
import {
  IPC_CHANNELS,
  RESET_LOCAL_DATA_CONFIRMATION_PHRASE,
  RESTORE_BACKUP_CONFIRMATION_PHRASE,
} from "../shared/contract";
import { type IpcHandlerContext, registerIpcHandlers } from "./ipc";

const showOpenDialog = vi.mocked(dialog.showOpenDialog);

function fakeDbService() {
  return {
    isOpen: true,
    isMigrated: true,
    ping: vi.fn(() => true),
    getStatus: vi.fn(() => ({ open: true, migrated: true })),
    setElementPriority: vi.fn(),
    countDescendants: vi.fn(() => ({ extracts: 1, cards: 2, cardsWithHistory: 1, total: 3 })),
    softDeleteSubtree: vi.fn(() => ({ batchId: "batch_1", affected: ["el_1"], skipped: [] })),
    restoreBatchFromTrash: vi.fn(() => ({ restored: ["el_1"], skipped: [], rootRestored: true })),
    getSettings: vi.fn((key: string) => ({ key, value: "stored" })),
    updateSetting: vi.fn(),
    updateAppSettings: vi.fn(),
    listQueue: vi.fn(() => ({ items: [] })),
    previewSessionPlan: vi.fn(() => ({
      targetMinutes: 25,
      plannedMinutes: 0,
      candidateMinutes: 0,
      plannedCount: 0,
      candidateCount: 0,
      overTarget: false,
      confidence: "learned",
      usesDefaultEstimate: false,
      items: [],
      cut: {
        totalCount: 0,
        totalMinutes: 0,
        detailLimit: 25,
        items: [],
        byReason: { did_not_fit: { count: 0, minutes: 0 } },
        byType: {},
      },
    })),
    actOnQueueItem: vi.fn(),
    createCard: vi.fn(),
    createExtraction: vi.fn(),
    listBlockProcessing: vi.fn(),
    getBlockProcessingSummary: vi.fn(),
    markBlockIgnored: vi.fn(),
    markBlockProcessed: vi.fn(),
    markBlockNeedsLater: vi.fn(),
    markBlockUnread: vi.fn(),
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
    previewConversionSession: vi.fn((request?: unknown) => ({
      sessionId: "session-1",
      asOf: "2026-06-13T08:00:00.000Z",
      expiresAt: "2026-06-13T08:15:00.000Z",
      limit:
        request &&
        typeof request === "object" &&
        typeof (request as { limit?: unknown }).limit === "number"
          ? (request as { limit: number }).limit
          : 25,
      candidateCount: 0,
      items: [],
      staleItemIds: [],
    })),
    prefetchConversionDrafts: vi.fn(() => ({ queued: 1, skipped: [], alreadyDrafted: 0 })),
    createConversionCard: vi.fn(() => ({
      card: { id: "card-1" },
      sourceLocationId: "loc-1",
      consumedSuggestionId: "suggestion-1",
    })),
    setConversionFate: vi.fn((request?: unknown) => ({ extract: request })),
    setExtractFate: vi.fn(),
    reactivateExtractFate: vi.fn(),
    dismissRetirementSuggestion: vi.fn(() => ({ dismissed: true, stale: false, suggestion: null })),
    getDailyWorkSummary: vi.fn(() => ({
      asOf: "2026-06-08T09:00:00.000Z",
      dueQueueItems: 0,
      inboxSources: 0,
      activeUnscheduledSources: 0,
      resumeSource: null,
      recommendedAction: "clear",
      graduationEvents: [],
      autoPostponeReceipt: null,
      extractAgingReceipts: [],
    })),
    ackDailyWorkGraduationEvents: vi.fn((request?: unknown) => ({
      asOf: "2026-06-08T09:00:00.000Z",
      acknowledgedEventIds:
        request && typeof request === "object" && "eventIds" in request
          ? ((request as { eventIds?: readonly string[] }).eventIds ?? [])
          : [],
      observedSubjectCount: 0,
    })),
    previewExtractAging: vi.fn((request?: unknown) => ({
      asOf:
        request && typeof request === "object" && "asOf" in request
          ? (request as { asOf?: string }).asOf
          : "2026-06-08T09:00:00.000Z",
      policy: "suggest",
      thresholds: { returnThreshold: 5, ageDays: 30, sweepLimit: 50 },
      candidates: [],
      candidateCount: 0,
      remainingCandidateCount: 0,
      receipts: [],
    })),
    applyExtractAging: vi.fn(() => ({
      batchId: "batch-aging-1",
      demoted: 0,
      skipped: [],
      remainingCandidateCount: 0,
      receipt: null,
    })),
    undoExtractAgingReceipt: vi.fn(() => ({
      receipt: null,
      undo: { undone: true, count: 1, label: "Undid 1 change", opType: "update_element" },
    })),
    reverifyFlaggedSources: vi.fn(() => ({
      totalOutputs: 3,
      sources: [{ sourceElementId: "source-1", title: "A source", count: 3 }],
    })),
    reverifySessionPreview: vi.fn((request?: unknown) => ({
      sourceElementId:
        request && typeof request === "object" && "sourceElementId" in request
          ? (request as { sourceElementId?: string }).sourceElementId
          : "source-1",
      asOf: "2026-06-14T09:00:00.000Z",
      expiresAt: "2026-06-14T09:10:00.000Z",
      cap: 25,
      remaining: 0,
      items: [],
    })),
    reverifyResolve: vi.fn(() => ({
      batchId: "batch-reverify-1",
      applied: 1,
      skipped: [],
      receipt: null,
    })),
    reverifyUndoReceipt: vi.fn(() => ({
      undone: true,
      count: 1,
      skipped: [],
      receipt: null,
    })),
    reverifyReceiptsToday: vi.fn(() => ({ receipts: [] })),
    getPriorityIntegrity: vi.fn((request?: unknown) => ({
      asOf: "2026-06-08T09:00:00.000Z",
      windowDays: 30,
      priorityAttribution: "current",
      bands: [],
      topics: [],
      sacrificed: [],
      thresholdFlags: {
        aBandInflation: false,
        aBandDeferredRecently: false,
        postponeDebtHigh: false,
      },
      request,
    })),
    getTopicKnowledgeState: vi.fn((request?: unknown) => ({
      asOf: "2026-06-08T09:00:00.000Z",
      windowDays: 90,
      subjects: [],
      graduationEvents: [],
      request,
    })),
    getMaintenanceChronicPostpones: vi.fn((request?: unknown) => ({
      rows: [],
      totalDue: 0,
      threshold: 5,
      limit: request && typeof request === "object" ? (request as { limit?: number }).limit : null,
    })),
    maintenanceChronicPostponesApply: vi.fn((request?: unknown) => ({
      applied: 1,
      skipped: [],
      batchId: "batch-1",
      request,
    })),
    fallowTopic: vi.fn((request?: unknown) => ({
      applied: 2,
      skipped: [],
      batchId: "batch-fallow",
      request,
    })),
    unfallowTopic: vi.fn((request?: unknown) => ({
      applied: 2,
      skipped: [],
      batchId: "batch-fallow",
      request,
    })),
    importManualSource: vi.fn(),
    search: vi.fn(),
    listInbox: vi.fn(() => ({ items: [] })),
    triageInboxItem: vi.fn(),
    getInboxItem: vi.fn(),
  };
}

function fakeIpcContext(): IpcHandlerContext {
  return {
    paths: {
      dataDir: "/tmp/interleave",
      dbPath: "/tmp/interleave/app.sqlite",
      assetsDir: "/tmp/interleave/assets",
      exportsDir: "/tmp/interleave/exports",
      downloadsDir: "/tmp/interleave/Downloads",
      backupsDir: "/tmp/interleave/backups",
      modelsDir: "/tmp/interleave/models",
    },
    migrationsDir: "/tmp/interleave/migrations",
  };
}

beforeEach(() => {
  electron.handlers.clear();
  electron.handle.mockClear();
  electron.removeHandler.mockClear();
  electron.getAllWindows.mockReset();
  electron.fromWebContents.mockClear();
  electron.openPath.mockReset();
  electron.openPath.mockResolvedValue("");
  showOpenDialog.mockReset();
  delete process.env.INTERLEAVE_BACKUP_RESTORE_PATH;
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

  it("validates and forwards queue.sessionPlan payloads", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.queueSessionPlan);

    expect(
      handler?.(
        {},
        {
          targetMinutes: 25,
          asOf: "2026-06-08T09:00:00.000Z",
          types: ["card"],
          statuses: ["scheduled"],
          protectedOnly: true,
          mode: "review",
        },
      ),
    ).toMatchObject({
      targetMinutes: 25,
      plannedCount: 0,
    });
    expect(db.previewSessionPlan).toHaveBeenCalledWith({
      targetMinutes: 25,
      asOf: "2026-06-08T09:00:00.000Z",
      types: ["card"],
      statuses: ["scheduled"],
      protectedOnly: true,
      mode: "review",
    });

    expect(() => handler?.({}, { targetMinutes: -1 })).toThrow();
    expect(db.previewSessionPlan).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards conversion.sessionPreview payloads with the default request", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.conversionSessionPreview);

    expect(handler?.({}, undefined)).toMatchObject({
      sessionId: "session-1",
      limit: 25,
      items: [],
    });
    expect(db.previewConversionSession).toHaveBeenCalledWith({});

    expect(handler?.({}, { limit: 50 })).toMatchObject({ limit: 50 });
    expect(db.previewConversionSession).toHaveBeenLastCalledWith({ limit: 50 });
    expect(() => handler?.({}, { limit: 101 })).toThrow();
  });

  it("validates and forwards conversion.prefetchDrafts only when a runner is available", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never, { runner: { observe: vi.fn(() => vi.fn()) } } as never);
    const handler = electron.handlers.get(IPC_CHANNELS.conversionPrefetchDrafts);
    const request = {
      sessionId: "session-1",
      action: "suggest_qa",
      consentedAt: "2026-06-13T08:00:00.000Z",
    };

    expect(handler?.({}, request)).toEqual({ queued: 1, skipped: [], alreadyDrafted: 0 });
    expect(db.prefetchConversionDrafts).toHaveBeenCalledWith(request);
    expect(() => handler?.({}, { ...request, action: "summarize" })).toThrow();
    expect(db.prefetchConversionDrafts).toHaveBeenCalledTimes(1);
  });

  it("rejects conversion.prefetchDrafts before the DB service when no runner is registered", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.conversionPrefetchDrafts);

    expect(() =>
      handler?.(
        {},
        {
          sessionId: "session-1",
          action: "suggest_qa",
          consentedAt: "2026-06-13T08:00:00.000Z",
        },
      ),
    ).toThrow("background runner");
    expect(db.prefetchConversionDrafts).not.toHaveBeenCalled();
  });

  it("validates and forwards conversion.createCard payloads", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.conversionCreateCard);
    const request = {
      sessionId: "session-1",
      suggestionId: "suggestion-1",
      extractId: "ex-1",
      kind: "qa",
      prompt: "Q?",
      answer: "A.",
    };

    expect(handler?.({}, request)).toMatchObject({
      card: { id: "card-1" },
      consumedSuggestionId: "suggestion-1",
    });
    expect(db.createConversionCard).toHaveBeenCalledWith(request);
    expect(() => handler?.({}, { ...request, sessionId: "" })).toThrow();
    expect(db.createConversionCard).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards conversion.setFate payloads through the frozen session", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.conversionSetFate);
    const request = { sessionId: "session-1", id: "ex-1", fate: "reference" };

    expect(handler?.({}, request)).toEqual({ extract: request });
    expect(db.setConversionFate).toHaveBeenCalledWith(request);
    expect(() => handler?.({}, { ...request, fate: "synthesized" })).toThrow();
    expect(db.setConversionFate).toHaveBeenCalledTimes(1);
  });

  describe("lineage-aware delete IPC boundary (T135)", () => {
    it("validates and forwards elements:countDescendants", () => {
      const db = fakeDbService();
      registerIpcHandlers(db as never);
      const handler = electron.handlers.get(IPC_CHANNELS.elementsCountDescendants);

      expect(handler?.({}, { id: "el_1" })).toEqual({
        extracts: 1,
        cards: 2,
        cardsWithHistory: 1,
        total: 3,
      });
      expect(db.countDescendants).toHaveBeenCalledWith({ id: "el_1" });
    });

    it("rejects a malformed elements:countDescendants payload before the DB service", () => {
      const db = fakeDbService();
      registerIpcHandlers(db as never);
      const handler = electron.handlers.get(IPC_CHANNELS.elementsCountDescendants);

      expect(() => handler?.({}, { id: "" })).toThrow();
      expect(() => handler?.({}, {})).toThrow();
      expect(db.countDescendants).not.toHaveBeenCalled();
    });

    it("validates and forwards elements:softDeleteSubtree (incl. includeSubtree)", () => {
      const db = fakeDbService();
      registerIpcHandlers(db as never);
      const handler = electron.handlers.get(IPC_CHANNELS.elementsSoftDeleteSubtree);

      expect(handler?.({}, { id: "el_1", includeSubtree: true })).toEqual({
        batchId: "batch_1",
        affected: ["el_1"],
        skipped: [],
      });
      expect(db.softDeleteSubtree).toHaveBeenCalledWith({ id: "el_1", includeSubtree: true });
    });

    it("rejects a malformed elements:softDeleteSubtree payload before the DB service", () => {
      const db = fakeDbService();
      registerIpcHandlers(db as never);
      const handler = electron.handlers.get(IPC_CHANNELS.elementsSoftDeleteSubtree);

      expect(() => handler?.({}, { id: "el_1", includeSubtree: "yes" })).toThrow();
      expect(() => handler?.({}, {})).toThrow();
      expect(db.softDeleteSubtree).not.toHaveBeenCalled();
    });

    it("validates and forwards trash:restoreBatch", () => {
      const db = fakeDbService();
      registerIpcHandlers(db as never);
      const handler = electron.handlers.get(IPC_CHANNELS.trashRestoreBatch);

      expect(handler?.({}, { batchId: "batch_1" })).toEqual({
        restored: ["el_1"],
        skipped: [],
        rootRestored: true,
      });
      expect(db.restoreBatchFromTrash).toHaveBeenCalledWith({ batchId: "batch_1" });
    });

    it("rejects a malformed trash:restoreBatch payload before the DB service", () => {
      const db = fakeDbService();
      registerIpcHandlers(db as never);
      const handler = electron.handlers.get(IPC_CHANNELS.trashRestoreBatch);

      expect(() => handler?.({}, { batchId: "" })).toThrow();
      expect(() => handler?.({}, {})).toThrow();
      expect(db.restoreBatchFromTrash).not.toHaveBeenCalled();
    });
  });

  it("validates and forwards daily work summary requests", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const asOf = "2026-06-08T09:00:00.000Z";
    const handler = electron.handlers.get(IPC_CHANNELS.dailyWorkSummary);

    expect(handler?.({}, { asOf })).toMatchObject({ recommendedAction: "clear" });
    expect(db.getDailyWorkSummary).toHaveBeenCalledWith({ asOf });
  });

  it("rejects malformed daily work summary clocks before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.dailyWorkSummary);

    expect(() => handler?.({}, { asOf: "not-a-date" })).toThrow();
    expect(db.getDailyWorkSummary).not.toHaveBeenCalled();
  });

  it("validates and forwards daily work graduation acknowledgement requests", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const request = {
      asOf: "2026-06-08T09:00:00.000Z",
      eventIds: ["concept:c1:graduated:v1"],
    };
    const handler = electron.handlers.get(IPC_CHANNELS.dailyWorkAckGraduationEvents);

    expect(handler?.({}, request)).toMatchObject({
      acknowledgedEventIds: ["concept:c1:graduated:v1"],
    });
    expect(db.ackDailyWorkGraduationEvents).toHaveBeenCalledWith(request);
  });

  it("rejects malformed daily work graduation acknowledgement payloads", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.dailyWorkAckGraduationEvents);

    expect(() => handler?.({}, { eventIds: ["ok", ""] })).toThrow();
    expect(db.ackDailyWorkGraduationEvents).not.toHaveBeenCalled();
  });

  it("validates and forwards extract aging preview requests", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const request = { asOf: "2026-06-08T09:00:00.000Z", limit: 12 };
    const handler = electron.handlers.get(IPC_CHANNELS.extractAgingPreview);

    expect(handler?.({}, request)).toMatchObject({ policy: "suggest" });
    expect(db.previewExtractAging).toHaveBeenCalledWith(request);
  });

  it("validates and forwards extract aging apply requests", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const request = { asOf: "2026-06-08T09:00:00.000Z", ids: ["extract-1"] };
    const handler = electron.handlers.get(IPC_CHANNELS.extractAgingApply);

    expect(handler?.({}, request)).toMatchObject({ batchId: "batch-aging-1" });
    expect(db.applyExtractAging).toHaveBeenCalledWith(request);
  });

  it("validates and forwards extract aging receipt undo requests", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.extractAgingUndoReceipt);

    expect(handler?.({}, { batchId: "batch-aging-1" })).toMatchObject({
      undo: { undone: true },
    });
    expect(db.undoExtractAgingReceipt).toHaveBeenCalledWith({ batchId: "batch-aging-1" });
  });

  it("rejects malformed extract aging payloads before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    expect(() =>
      electron.handlers.get(IPC_CHANNELS.extractAgingPreview)?.({}, { asOf: "not-a-date" }),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.extractAgingPreview)?.({}, { limit: 0 }),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.extractAgingPreview)?.({}, { limit: 51 }),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.extractAgingPreview)?.({}, { limit: 1.5 }),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.extractAgingApply)?.({}, { ids: [""] }),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.extractAgingApply)?.(
        {},
        { ids: Array.from({ length: 51 }, (_, i) => `extract-${i}`) },
      ),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.extractAgingUndoReceipt)?.({}, { batchId: "" }),
    ).toThrow();
    expect(db.previewExtractAging).not.toHaveBeenCalled();
    expect(db.applyExtractAging).not.toHaveBeenCalled();
    expect(db.undoExtractAgingReceipt).not.toHaveBeenCalled();
  });

  it("forwards the read-only reverify flagged-sources rollup (no payload)", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.reverifyFlaggedSources);

    expect(handler?.({}, undefined)).toMatchObject({ totalOutputs: 3 });
    expect(db.reverifyFlaggedSources).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards a reverify session preview request", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const request = { sourceElementId: "source-1", cap: 10 };
    const handler = electron.handlers.get(IPC_CHANNELS.reverifySessionPreview);

    expect(handler?.({}, request)).toMatchObject({ sourceElementId: "source-1" });
    expect(db.reverifySessionPreview).toHaveBeenCalledWith(request);
  });

  it("returns the stable empty preview for a missing/deleted source id without throwing", () => {
    // The service tolerates a stale source id (returns a full-shape empty payload). The
    // fake mirrors that contract — the handler must parse + delegate, never throw.
    const db = fakeDbService();
    db.reverifySessionPreview = vi.fn((request?: unknown) => ({
      sourceElementId:
        request && typeof request === "object" && "sourceElementId" in request
          ? (request as { sourceElementId?: string }).sourceElementId
          : "gone",
      asOf: "2026-06-14T09:00:00.000Z",
      expiresAt: "2026-06-14T09:10:00.000Z",
      cap: 25,
      remaining: 0,
      items: [],
    })) as never;
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.reverifySessionPreview);

    const result = handler?.({}, { sourceElementId: "deleted-source" });
    expect(result).toMatchObject({ sourceElementId: "deleted-source", items: [], remaining: 0 });
    expect(db.reverifySessionPreview).toHaveBeenCalledTimes(1);
  });

  it("validates and forwards a reverify resolve request", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const request = {
      batchId: "batch-reverify-1",
      sourceElementId: "source-1",
      decisions: [
        {
          elementId: "extract-1",
          stableBlockId: "block-1",
          verb: "confirm",
          fingerprint: "fp-1",
        },
      ],
    };
    const handler = electron.handlers.get(IPC_CHANNELS.reverifyResolve);

    expect(handler?.({}, request)).toMatchObject({ batchId: "batch-reverify-1", applied: 1 });
    expect(db.reverifyResolve).toHaveBeenCalledWith(request);
  });

  it("validates and forwards a reverify receipt undo request", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.reverifyUndoReceipt);

    expect(handler?.({}, { batchId: "batch-reverify-1" })).toMatchObject({ undone: true });
    expect(db.reverifyUndoReceipt).toHaveBeenCalledWith({ batchId: "batch-reverify-1" });
  });

  it("forwards the read-only reverify receipts-today read (no payload)", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.reverifyReceiptsToday);

    expect(handler?.({}, undefined)).toMatchObject({ receipts: [] });
    expect(db.reverifyReceiptsToday).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed reverify payloads at the Zod boundary before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    // sessionPreview: missing source id / bad cap.
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.reverifySessionPreview)?.({}, { cap: 5 }),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.reverifySessionPreview)?.(
        {},
        { sourceElementId: "source-1", cap: 0 },
      ),
    ).toThrow();
    // resolve: invalid verb / empty decisions / missing source id.
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.reverifyResolve)?.(
        {},
        {
          sourceElementId: "source-1",
          decisions: [
            { elementId: "e", stableBlockId: "b", verb: "frobnicate", fingerprint: "fp" },
          ],
        },
      ),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.reverifyResolve)?.(
        {},
        { sourceElementId: "source-1", decisions: [] },
      ),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.reverifyResolve)?.(
        {},
        {
          decisions: [{ elementId: "e", stableBlockId: "b", verb: "confirm", fingerprint: "fp" }],
        },
      ),
    ).toThrow();
    // undoReceipt: empty batchId.
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.reverifyUndoReceipt)?.({}, { batchId: "" }),
    ).toThrow();
    expect(db.reverifySessionPreview).not.toHaveBeenCalled();
    expect(db.reverifyResolve).not.toHaveBeenCalled();
    expect(db.reverifyUndoReceipt).not.toHaveBeenCalled();
  });

  it("validates and forwards priority integrity requests", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const request = {
      asOf: "2026-06-08T09:00:00.000Z",
      windowDays: 14,
      sacrificedLimit: 5,
      topicLimit: 6,
    };
    const handler = electron.handlers.get(IPC_CHANNELS.analyticsPriorityIntegrity);

    expect(handler?.({}, request)).toMatchObject({ priorityAttribution: "current" });
    expect(db.getPriorityIntegrity).toHaveBeenCalledWith(request);
  });

  it("rejects malformed priority integrity clocks before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.analyticsPriorityIntegrity);

    expect(() => handler?.({}, { asOf: "not-a-date" })).toThrow();
    expect(db.getPriorityIntegrity).not.toHaveBeenCalled();
  });

  it("validates and forwards topic knowledge-state requests", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const request = {
      asOf: "2026-06-08T09:00:00.000Z",
      windowDays: 90,
      limit: 10,
      subjectType: "topic",
      subjectId: "topic-1",
    };
    const handler = electron.handlers.get(IPC_CHANNELS.analyticsTopicKnowledgeState);

    expect(handler?.({}, request)).toMatchObject({ subjects: [] });
    expect(db.getTopicKnowledgeState).toHaveBeenCalledWith(request);
  });

  it("rejects malformed topic knowledge-state filters before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.analyticsTopicKnowledgeState);

    expect(() => handler?.({}, { subjectType: "source" })).toThrow();
    expect(() => handler?.({}, { limit: 0 })).toThrow();
    expect(db.getTopicKnowledgeState).not.toHaveBeenCalled();
  });

  it("validates and forwards topic fallow commands", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const fallowRequest = {
      topicId: "topic-1",
      fallowUntil: "2026-07-01T00:00:00.000Z",
      fallowReason: "Seasonal pause",
    };
    const unfallowRequest = { topicId: "topic-1" };

    expect(electron.handlers.get(IPC_CHANNELS.topicsFallow)?.({}, fallowRequest)).toMatchObject({
      applied: 2,
      batchId: "batch-fallow",
    });
    expect(db.fallowTopic).toHaveBeenCalledWith(fallowRequest);
    expect(electron.handlers.get(IPC_CHANNELS.topicsUnfallow)?.({}, unfallowRequest)).toMatchObject(
      {
        applied: 2,
        batchId: "batch-fallow",
      },
    );
    expect(db.unfallowTopic).toHaveBeenCalledWith(unfallowRequest);
  });

  it("rejects malformed topic fallow commands before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    expect(() =>
      electron.handlers.get(IPC_CHANNELS.topicsFallow)?.(
        {},
        { topicId: "topic-1", fallowUntil: "not-a-date" },
      ),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.topicsFallow)?.(
        {},
        {
          topicId: "topic-1",
          fallowUntil: "2026-07-01T00:00:00.000Z",
          now: "2000-01-01T00:00:00.000Z",
        },
      ),
    ).toThrow();
    expect(() => electron.handlers.get(IPC_CHANNELS.topicsUnfallow)?.({}, {})).toThrow();
    expect(db.fallowTopic).not.toHaveBeenCalled();
    expect(db.unfallowTopic).not.toHaveBeenCalled();
  });

  it("validates and forwards chronic postpone maintenance requests", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    expect(
      electron.handlers.get(IPC_CHANNELS.maintenanceChronicPostpones)?.({}, { limit: 50 }),
    ).toMatchObject({ threshold: 5, limit: 50 });
    expect(db.getMaintenanceChronicPostpones).toHaveBeenCalledWith({ limit: 50 });

    const applyRequest = { decisions: [{ id: "el_1", kind: "demote" }] };
    expect(
      electron.handlers.get(IPC_CHANNELS.maintenanceChronicPostponesApply)?.({}, applyRequest),
    ).toMatchObject({ applied: 1, batchId: "batch-1" });
    expect(db.maintenanceChronicPostponesApply).toHaveBeenCalledWith(applyRequest);
  });

  it("rejects malformed chronic postpone requests before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    expect(() =>
      electron.handlers.get(IPC_CHANNELS.maintenanceChronicPostpones)?.({}, { limit: 0 }),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.maintenanceChronicPostponesApply)?.(
        {},
        { decisions: [{ id: "el_1", kind: "archive" }] },
      ),
    ).toThrow();
    expect(() =>
      electron.handlers.get(IPC_CHANNELS.maintenanceChronicPostponesApply)?.(
        {},
        {
          decisions: Array.from({ length: 501 }, (_, index) => ({
            id: `el_${index}`,
            kind: "keep",
          })),
        },
      ),
    ).toThrow();
    expect(db.getMaintenanceChronicPostpones).not.toHaveBeenCalled();
    expect(db.maintenanceChronicPostponesApply).not.toHaveBeenCalled();
  });

  it("rejects direct synthesized extract fate before invoking the database service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);
    const handler = electron.handlers.get(IPC_CHANNELS.extractsSetFate);

    expect(() => handler?.({}, { id: "el_ex", fate: "synthesized" })).toThrow();
    expect(db.setExtractFate).not.toHaveBeenCalled();
  });

  it("validates high-risk command payloads before invoking the corresponding DB service", () => {
    const db = fakeDbService();
    registerIpcHandlers(db as never);

    const malformed = [
      { channel: IPC_CHANNELS.settingsUpdate, payload: {}, service: "updateSetting" },
      {
        channel: IPC_CHANNELS.elementsSetPriority,
        payload: { id: "el_1", priority: "Z" },
        service: "setElementPriority",
      },
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
        channel: IPC_CHANNELS.sourcesDismissRetirementSuggestion,
        payload: { sourceElementId: "src_1", signalHash: "" },
        service: "dismissRetirementSuggestion",
      },
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
        channel: IPC_CHANNELS.reviewGrade,
        payload: { cardId: "el_1", rating: "good", promptMs: 1.5, responseMs: 1000 },
        service: "reviewGrade",
      },
      {
        channel: IPC_CHANNELS.reviewGrade,
        payload: { cardId: "el_1", rating: "good", promptMs: 86_400_001, responseMs: 1000 },
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
      "dismissRetirementSuggestion",
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

    electron.handlers.get(IPC_CHANNELS.settingsUpdate)?.(
      {},
      { key: "dailyReviewBudget", value: 24 },
    );
    expect(db.updateSetting).toHaveBeenCalledWith("dailyReviewBudget", 24);

    electron.handlers.get(IPC_CHANNELS.elementsSetPriority)?.(
      {},
      { id: "el_1", action: { kind: "set", priority: "A" } },
    );
    expect(db.setElementPriority).toHaveBeenCalledWith({
      id: "el_1",
      action: { kind: "set", priority: "A" },
    });

    electron.handlers.get(IPC_CHANNELS.queueSchedule)?.(
      {},
      { id: "el_1", choice: { kind: "tomorrow" } },
    );
    expect(db.scheduleQueueItem).toHaveBeenCalledWith({
      id: "el_1",
      choice: { kind: "tomorrow" },
    });

    electron.handlers.get(IPC_CHANNELS.queueUndo)?.(
      {},
      {
        id: "el_1",
        undo: { kind: "restore", previousStatus: "active" },
      },
    );
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

    electron.handlers.get(IPC_CHANNELS.queueVacation)?.(
      {},
      {
        awayStart: "2027-01-01T00:00:00.000Z",
        awayEnd: "2027-01-03T23:59:59.000Z",
        asOf: "2027-01-01T00:00:00.000Z",
      },
    );
    expect(db.previewVacation).toHaveBeenCalledWith({
      awayStart: "2027-01-01T00:00:00.000Z",
      awayEnd: "2027-01-03T23:59:59.000Z",
      asOf: "2027-01-01T00:00:00.000Z",
    });

    electron.handlers.get(IPC_CHANNELS.queueVacationApply)?.(
      {},
      {
        awayStart: "2027-01-01T00:00:00.000Z",
        awayEnd: "2027-01-03T23:59:59.000Z",
        asOf: "2027-01-01T00:00:00.000Z",
      },
    );
    expect(db.applyVacation).toHaveBeenCalledWith({
      awayStart: "2027-01-01T00:00:00.000Z",
      awayEnd: "2027-01-03T23:59:59.000Z",
      asOf: "2027-01-01T00:00:00.000Z",
    });

    electron.handlers.get(IPC_CHANNELS.sourcesImportManual)?.({}, { title: "From test" });
    expect(db.importManualSource).toHaveBeenCalledWith({ title: "From test" });

    electron.handlers.get(IPC_CHANNELS.sourcesDismissRetirementSuggestion)?.(
      {},
      { sourceElementId: "src_1", signalHash: "hash-1" },
    );
    expect(db.dismissRetirementSuggestion).toHaveBeenCalledWith({
      sourceElementId: "src_1",
      signalHash: "hash-1",
    });

    electron.handlers.get(IPC_CHANNELS.extractionsCreate)?.(
      {},
      {
        sourceElementId: "el_1",
        selectedText: "selected",
        blockIds: ["b_1"],
      },
    );
    expect(db.createExtraction).toHaveBeenCalledWith({
      sourceElementId: "el_1",
      selectedText: "selected",
      blockIds: ["b_1"],
    });

    electron.handlers.get(IPC_CHANNELS.cardsUpdate)?.(
      {},
      {
        cardId: "el_1",
        prompt: "What changed?",
      },
    );
    expect(db.updateCard).toHaveBeenCalledWith({ cardId: "el_1", prompt: "What changed?" });

    electron.handlers.get(IPC_CHANNELS.reviewGrade)?.(
      {},
      {
        cardId: "el_1",
        rating: "good",
        responseMs: 1100,
        asOf: "2027-01-01T00:00:00.000Z",
      },
    );
    expect(db.reviewGrade).toHaveBeenCalledWith({
      cardId: "el_1",
      rating: "good",
      promptMs: 0,
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

    expect(() => cardsCreate?.({}, { kind: "qa", prompt: "What is X?", answer: "Y" })).toThrow();
    expect(db.createCard).not.toHaveBeenCalled();

    expect(() =>
      cardsCreate?.({}, { extractId: "el_1", kind: "qa", prompt: "What is X?", answer: "Y" }),
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

  it("opens the managed backups folder through Electron shell.openPath", async () => {
    registerIpcHandlers(fakeDbService() as never, fakeIpcContext());

    await expect(electron.handlers.get(IPC_CHANNELS.backupsOpenFolder)?.({})).resolves.toEqual({
      ok: true,
    });

    expect(electron.openPath).toHaveBeenCalledWith("/tmp/interleave/backups");
  });

  it("rejects payloads before opening the backups folder", async () => {
    registerIpcHandlers(fakeDbService() as never, fakeIpcContext());

    await expect(
      electron.handlers.get(IPC_CHANNELS.backupsOpenFolder)?.({}, { path: "/tmp" }),
    ).rejects.toThrow();

    expect(electron.openPath).not.toHaveBeenCalled();
  });

  it("throws clearly when the backups folder handler has no filesystem context", async () => {
    registerIpcHandlers(fakeDbService() as never);

    await expect(electron.handlers.get(IPC_CHANNELS.backupsOpenFolder)?.({})).rejects.toThrow(
      "backups.openFolder: handler registered without filesystem context",
    );
    expect(electron.openPath).not.toHaveBeenCalled();
  });

  it("throws when Electron cannot open the backups folder", async () => {
    electron.openPath.mockResolvedValue("No application could open the folder");
    registerIpcHandlers(fakeDbService() as never, fakeIpcContext());

    await expect(electron.handlers.get(IPC_CHANNELS.backupsOpenFolder)?.({})).rejects.toThrow(
      "backups.openFolder: failed to open backups folder",
    );
    expect(electron.openPath).toHaveBeenCalledWith("/tmp/interleave/backups");
  });

  it("rejects unexpected backup-create payloads before requiring filesystem context", async () => {
    registerIpcHandlers(fakeDbService() as never);

    await expect(
      electron.handlers.get(IPC_CHANNELS.backupsCreate)?.({}, { path: "/tmp" }) as Promise<unknown>,
    ).rejects.toThrow();
  });

  it("validates destructive backup lifecycle confirmations before requiring filesystem context", async () => {
    registerIpcHandlers(fakeDbService() as never);

    const restore = electron.handlers.get(IPC_CHANNELS.backupsRestore);
    const reset = electron.handlers.get(IPC_CHANNELS.backupsResetLocalData);
    const list = electron.handlers.get(IPC_CHANNELS.backupsList);

    expect(() => list?.({}, {})).toThrow();
    expect(() => list?.({}, undefined)).toThrow(
      "backups.list: handler registered without filesystem context",
    );
    await expect(
      restore?.(
        {},
        {
          timestamp: "2026-06-07T10-00-00-000Z",
          confirm: true,
          phrase: "restore backup",
        },
      ) as Promise<unknown>,
    ).rejects.toThrow();
    await expect(
      reset?.({}, { confirm: true, phrase: "start from scratch" }) as Promise<unknown>,
    ).rejects.toThrow();

    await expect(
      restore?.(
        {},
        {
          timestamp: "2026-06-07T10-00-00-000Z",
          confirm: true,
          phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
        },
      ) as Promise<unknown>,
    ).rejects.toThrow("backups.restore: handler registered without filesystem context");
    await expect(
      reset?.(
        {},
        { confirm: true, phrase: RESET_LOCAL_DATA_CONFIRMATION_PHRASE },
      ) as Promise<unknown>,
    ).rejects.toThrow("backups.resetLocalData: handler registered without filesystem context");
  });

  it("rejects a malformed restore-from-file payload before constructing the service", async () => {
    registerIpcHandlers(fakeDbService() as never, fakeIpcContext());

    const restoreFile = electron.handlers.get(IPC_CHANNELS.backupsRestoreFile);

    // missing phrase
    await expect(
      restoreFile?.({}, { path: "/backups/2026-06-07.zip", confirm: true }) as Promise<unknown>,
    ).rejects.toThrow();
    // confirm:false
    await expect(
      restoreFile?.(
        {},
        {
          path: "/backups/2026-06-07.zip",
          confirm: false,
          phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
        },
      ) as Promise<unknown>,
    ).rejects.toThrow();
    // empty path
    await expect(
      restoreFile?.(
        {},
        { path: "", confirm: true, phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE },
      ) as Promise<unknown>,
    ).rejects.toThrow();
  });

  it("restore-from-file throws when no filesystem context is wired", async () => {
    registerIpcHandlers(fakeDbService() as never);

    const restoreFile = electron.handlers.get(IPC_CHANNELS.backupsRestoreFile);

    await expect(
      restoreFile?.(
        {},
        {
          path: "/backups/2026-06-07.zip",
          confirm: true,
          phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
        },
      ) as Promise<unknown>,
    ).rejects.toThrow("backups.restoreFile: handler registered without filesystem context");
  });

  it("pickArchive returns the env-override path in an unpackaged build", async () => {
    process.env.INTERLEAVE_BACKUP_RESTORE_PATH = "/backups/override.zip";
    registerIpcHandlers(fakeDbService() as never, fakeIpcContext());

    const pickArchive = electron.handlers.get(IPC_CHANNELS.backupsPickArchive);

    await expect(pickArchive?.({}) as Promise<unknown>).resolves.toEqual({
      path: "/backups/override.zip",
    });
    // The env override short-circuits the dialog entirely.
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it("pickArchive returns { cancelled: true } when the dialog is canceled", async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    registerIpcHandlers(fakeDbService() as never, fakeIpcContext());

    const pickArchive = electron.handlers.get(IPC_CHANNELS.backupsPickArchive);

    await expect(pickArchive?.({}) as Promise<unknown>).resolves.toEqual({ cancelled: true });
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
  });

  it("pickArchive returns the chosen path when the dialog resolves a file", async () => {
    // No env override in play (cleared in beforeEach), so the native dialog runs.
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ["/some/backup.zip"] });
    registerIpcHandlers(fakeDbService() as never, fakeIpcContext());

    const pickArchive = electron.handlers.get(IPC_CHANNELS.backupsPickArchive);

    await expect(pickArchive?.({}) as Promise<unknown>).resolves.toEqual({
      path: "/some/backup.zip",
    });
    expect(showOpenDialog).toHaveBeenCalledTimes(1);
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
