import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
  createBackup: vi.fn(),
  openBackupsFolder: vi.fn(),
  listBackups: vi.fn(),
  restoreBackup: vi.fn(),
  pickBackupArchive: vi.fn(),
  restoreBackupFromFile: vi.fn(),
  resetLocalData: vi.fn(),
  getCapturePairing: vi.fn(),
  setCaptureEnabled: vi.fn(),
  regenerateCaptureToken: vi.fn(),
  aiStatus: vi.fn(),
  downloadAiModel: vi.fn(),
  semanticStatus: vi.fn(),
  semanticReindex: vi.fn(),
  semanticRetryFailed: vi.fn(),
  semanticDownloadModel: vi.fn(),
  subscribeJobs: vi.fn(),
  setRetentionBandEnabled: vi.fn(),
  setRetentionBand: vi.fn(),
  health: vi.fn(),
  dbStatus: vi.fn(),
  getSettings: vi.fn(),
  updateSetting: vi.fn(),
}));

vi.mock("../components/OptimizationPanel", () => ({
  OptimizationPanel: () => <div data-testid="mock-optimization-panel" />,
}));

vi.mock("../components/WorkloadSimulator", () => ({
  WorkloadSimulator: () => <div data-testid="mock-workload-simulator" />,
}));

vi.mock("../lib/appApi", async () => {
  const actual = await vi.importActual<typeof import("../lib/appApi")>("../lib/appApi");
  return {
    ...actual,
    isDesktop: () => h.desktop,
    appApi: {
      getAppSettings: h.getAppSettings,
      updateAppSettings: h.updateAppSettings,
      createBackup: h.createBackup,
      openBackupsFolder: h.openBackupsFolder,
      listBackups: h.listBackups,
      restoreBackup: h.restoreBackup,
      pickBackupArchive: h.pickBackupArchive,
      restoreBackupFromFile: h.restoreBackupFromFile,
      resetLocalData: h.resetLocalData,
      getCapturePairing: h.getCapturePairing,
      setCaptureEnabled: h.setCaptureEnabled,
      regenerateCaptureToken: h.regenerateCaptureToken,
      aiStatus: h.aiStatus,
      downloadAiModel: h.downloadAiModel,
      semanticStatus: h.semanticStatus,
      semanticReindex: h.semanticReindex,
      semanticRetryFailed: h.semanticRetryFailed,
      semanticDownloadModel: h.semanticDownloadModel,
      subscribeJobs: h.subscribeJobs,
      setRetentionBandEnabled: h.setRetentionBandEnabled,
      setRetentionBand: h.setRetentionBand,
      health: h.health,
      dbStatus: h.dbStatus,
      getSettings: h.getSettings,
      updateSetting: h.updateSetting,
    },
  };
});

import {
  RESET_LOCAL_DATA_CONFIRMATION_PHRASE,
  RESTORE_BACKUP_CONFIRMATION_PHRASE,
  type RendererSettings,
} from "../lib/appApi";
import { Settings } from "./Settings";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settings: RendererSettings = {
  dailyBudgetMinutes: 60,
  distillationQuotaPercent: 15,
  overloadPolicy: "suggest",
  extractAgingPolicy: "off",
  extractAgingReturnThreshold: 5,
  extractAgingAgeDays: 30,
  dailyReviewBudget: 60,
  defaultDesiredRetention: 0.9,
  defaultTopicIntervalDays: 7,
  defaultSourcePriority: 0.375,
  burySiblings: true,
  trashRetentionDays: 30,
  balanceWarnings: true,
  parkedResurfaceAfterDays: 90,
  chronicPostponeThreshold: 5,
  weeklyReviewEnabled: true,
  weeklyReviewCadenceDays: 7,
  adaptiveAttentionIntervals: true,
  importBalanceFactor: 1.5,
  keyboardLayout: "qwerty",
  theme: "dark",
  displayName: "",
  retentionByBand: {},
  retentionByBandEnabled: false,
  fsrsParamsGlobal: null,
  semanticSearchEnabled: true,
  embeddingModelId: "onnx-community/embeddinggemma-300m-ONNX",
  embeddingModelDownloaded: false,
  aiEnabled: false,
  aiProviderKind: "local",
  aiManagedProxyEnabled: false,
  aiModelDownloaded: false,
  aiLocalModelId: "local:Llama-3.2-3B-Instruct-Q4_K_M",
  aiKeyConfigured: false,
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  h.desktop = true;
  for (const mock of Object.values(h)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  h.getAppSettings.mockResolvedValue({ settings });
  h.semanticStatus.mockResolvedValue({
    enabled: true,
    vecAvailable: true,
    modelDownloaded: true,
    embedded: 10,
    total: 10,
    modelId: "onnx-community/embeddinggemma-300m-ONNX",
    modelState: "ready",
    indexHealth: "healthy",
    coverageRatio: 1,
    failedCount: 0,
    lastError: null,
    etaSeconds: null,
  });
  h.subscribeJobs.mockReturnValue(() => {});
  h.semanticReindex.mockResolvedValue({ enqueued: 0 });
  h.semanticRetryFailed.mockResolvedValue({ retried: 0 });
  h.semanticDownloadModel.mockResolvedValue({ downloaded: true });
  h.updateAppSettings.mockImplementation(({ patch }) => ({
    settings: { ...settings, ...patch },
  }));
  h.createBackup.mockResolvedValue({
    timestamp: "2026-06-07T10-30-00-000Z",
    archiveName: "2026-06-07T10-30-00-000Z.zip",
    sizeBytes: 2048,
    fileCount: 3,
    schemaVersion: "v1",
  });
  h.openBackupsFolder.mockResolvedValue({ ok: true });
  h.listBackups.mockResolvedValue({
    backups: [
      {
        timestamp: "2026-06-07T10-20-30-000Z",
        createdAt: "2026-06-07T10:20:30.000Z",
        sizeBytes: 4096,
        fileCount: 4,
        schemaVersion: "v1",
        automatic: false,
      },
    ],
  });
  h.restoreBackup.mockResolvedValue({
    status: "restored",
    timestamp: "2026-06-07T10-20-30-000Z",
    restoredAt: "2026-06-07T10:35:00.000Z",
    reloadRequired: true,
  });
  h.pickBackupArchive.mockResolvedValue({ path: "/tmp/backups/foo.zip" });
  h.restoreBackupFromFile.mockResolvedValue({
    status: "restored",
    timestamp: "2026-06-07T10-20-30-000Z",
    restoredAt: "2026-06-07T10:35:00.000Z",
    reloadRequired: true,
  });
  h.resetLocalData.mockResolvedValue({
    status: "reset",
    resetAt: "2026-06-07T10:35:00.000Z",
    reloadRequired: true,
  });
  h.getCapturePairing.mockResolvedValue({
    enabled: false,
    running: false,
    port: null,
    token: "token-1",
    extensionOriginHint: null,
  });
  h.setCaptureEnabled.mockResolvedValue({ enabled: true, running: true, port: 17890 });
  h.aiStatus.mockResolvedValue({
    enabled: false,
    providerKind: "local",
    keyConfigured: false,
    modelDownloaded: false,
    managedProxyEnabled: false,
  });
  h.health.mockResolvedValue({
    status: "ok",
    appVersion: "0.2.0",
    dbOpen: true,
    migrated: true,
    time: "t",
  });
  h.dbStatus.mockResolvedValue({
    open: true,
    migrated: true,
    journalMode: "wal",
    foreignKeys: 1,
    busyTimeoutMs: 5000,
    appliedMigrations: 12,
  });
  h.getSettings.mockResolvedValue({ settings: { "desktop.lastCheck": "checked-before" } });
  h.updateSetting.mockResolvedValue({ key: "desktop.lastCheck", value: "checked-x" });
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("Settings", () => {
  it("renders desktop-only fallback without the bridge", () => {
    h.desktop = false;
    const { getByTestId, getByText } = render(<Settings />);

    expect(getByTestId("settings-desktop-only")).toBeInTheDocument();
    expect(getByText(/only available in the Electron desktop app/i)).toBeInTheDocument();
    expect(h.getAppSettings).not.toHaveBeenCalled();
  });

  it("loads settings and persists setting changes through the bridge", async () => {
    const { getByTestId, findByTestId, queryByTestId } = render(<Settings />);

    expect(await findByTestId("setting-budget-value")).toHaveTextContent("60 min");
    expect(getByTestId("setting-distillation-quota-value")).toHaveTextContent("15%");
    fireEvent.change(getByTestId("setting-budget"), { target: { value: "75" } });

    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { dailyBudgetMinutes: 75 } }),
    );
    expect(queryByTestId("settings-saved")).not.toBeInTheDocument();
    expect(getByTestId("setting-budget-value")).toHaveTextContent("75 min");

    fireEvent.change(getByTestId("setting-distillation-quota"), { target: { value: "25" } });
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({
        patch: { distillationQuotaPercent: 25 },
      }),
    );
    expect(getByTestId("setting-distillation-quota-value")).toHaveTextContent("25%");

    fireEvent.click(getByTestId("setting-budget-preset-option-120"));
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { dailyBudgetMinutes: 120 } }),
    );

    fireEvent.click(getByTestId("setting-overload-policy-option-automatic"));
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { overloadPolicy: "automatic" } }),
    );

    fireEvent.change(getByTestId("setting-parked-resurface"), { target: { value: "120" } });
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({
        patch: { parkedResurfaceAfterDays: 120 },
      }),
    );
    expect(getByTestId("setting-parked-resurface")).toHaveValue(120);

    fireEvent.change(getByTestId("setting-weekly-cadence"), { target: { value: "14" } });
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({
        patch: { weeklyReviewCadenceDays: 14 },
      }),
    );
    expect(getByTestId("setting-weekly-cadence")).toHaveValue(14);

    fireEvent.click(getByTestId("setting-weekly-review"));
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({
        patch: { weeklyReviewEnabled: false },
      }),
    );
  });

  it("renders the distillation floor off state", async () => {
    h.getAppSettings.mockResolvedValue({
      settings: { ...settings, distillationQuotaPercent: 0 },
    });

    const { findByTestId } = render(<Settings />);

    expect(await findByTestId("setting-distillation-quota-value")).toHaveTextContent("Off");
  });

  it("persists the system theme preference from the theme segmented control", async () => {
    const { getByTestId, findByTestId } = render(<Settings />);

    await findByTestId("setting-theme-option-system");
    fireEvent.click(getByTestId("setting-theme-option-system"));

    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { theme: "system" } }),
    );
    expect(getByTestId("setting-theme-option-system")).toHaveAttribute("aria-pressed", "true");
    expect(localStorage.getItem("interleave.theme")).toBe("system");
  });

  it("pins switch thumbs to the correct track edge for checked and unchecked states", async () => {
    const { findByTestId } = render(<Settings />);

    const checkedThumb = await findByTestId("setting-bury-siblings-thumb");
    const uncheckedThumb = await findByTestId("setting-retention-by-band-thumb");

    expect(checkedThumb).toHaveClass("left-[calc(100%-var(--s-5)-2px)]");
    expect(checkedThumb).not.toHaveClass("translate-x-[22px]");
    expect(uncheckedThumb).toHaveClass("left-0.5");
    expect(uncheckedThumb).not.toHaveClass("translate-x-0.5");
  });

  it("runs a backup and displays the result", async () => {
    const { getByTestId, findByTestId } = render(<Settings />);

    await findByTestId("settings-backup-now");
    fireEvent.click(getByTestId("settings-backup-now"));

    await waitFor(() => expect(h.createBackup).toHaveBeenCalled());
    expect(await findByTestId("settings-backup-result")).toHaveTextContent("2.0 KB");
    expect(getByTestId("settings-backup-result")).toHaveTextContent("3 files");
  });

  it("opens the backups folder from the secondary data action", async () => {
    const { getByTestId, findByTestId } = render(<Settings />);

    await findByTestId("settings-open-backups-folder");
    fireEvent.click(getByTestId("settings-open-backups-folder"));

    await waitFor(() => expect(h.openBackupsFolder).toHaveBeenCalledTimes(1));
    expect(h.openBackupsFolder).toHaveBeenCalledWith();
  });

  it("disables the backups-folder button while Finder is opening", async () => {
    let resolveOpen: (value: { ok: true }) => void = () => {};
    h.openBackupsFolder.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const { findByTestId } = render(<Settings />);

    const button = await findByTestId("settings-open-backups-folder");
    fireEvent.click(button);
    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Opening…");
    expect(h.openBackupsFolder).toHaveBeenCalledTimes(1);

    resolveOpen({ ok: true });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveTextContent("Open backups folder");
  });

  it("shows a focused folder-open error without blocking backup creation", async () => {
    h.openBackupsFolder.mockRejectedValueOnce(new Error("Finder is unavailable"));
    const { getByTestId, findByTestId } = render(<Settings />);

    await findByTestId("settings-open-backups-folder");
    fireEvent.click(getByTestId("settings-open-backups-folder"));

    expect(await findByTestId("settings-backup-folder-error")).toHaveTextContent(
      "Finder is unavailable",
    );
    expect(getByTestId("settings-backup-now")).not.toBeDisabled();

    fireEvent.click(getByTestId("settings-backup-now"));
    await waitFor(() => expect(h.createBackup).toHaveBeenCalledTimes(1));
    expect(await findByTestId("settings-backup-result")).toHaveTextContent("2.0 KB");
  });

  it("keeps the backup explanation aligned inside the data section rhythm", async () => {
    const { getByTestId, findByTestId } = render(<Settings />);

    await findByTestId("settings-backup-now");
    const note = getByTestId("settings-backup-note");

    expect(note).toHaveClass("py-3.5");
    expect(note).toHaveClass("border-b");
    expect(note).not.toHaveClass("mb-2");
    expect(note).toHaveTextContent("A backup is a full, recoverable copy");
    expect(note).toHaveTextContent("Backup vs Export");
  });

  it("loads and renders app-managed backup artifacts", async () => {
    h.listBackups.mockResolvedValueOnce({
      backups: [
        {
          timestamp: "2026-06-07T10-20-30-000Z",
          createdAt: "2026-06-07T10:20:30.000Z",
          sizeBytes: 4096,
          fileCount: 4,
          schemaVersion: "v1",
          automatic: false,
        },
        {
          timestamp: "2026-06-06T09-00-00-000Z",
          createdAt: "2026-06-06T09:00:00.000Z",
          sizeBytes: 2048,
          fileCount: 3,
          schemaVersion: "v1",
          automatic: true,
        },
      ],
    });
    const { findByTestId, getByTestId } = render(<Settings />);

    expect(
      await findByTestId("settings-backup-artifact-2026-06-07T10-20-30-000Z"),
    ).toHaveTextContent("2026-06-07T10-20-30-000Z");
    expect(getByTestId("settings-backup-artifact-2026-06-07T10-20-30-000Z")).toHaveTextContent(
      "4 files",
    );
    expect(getByTestId("settings-backup-artifact-2026-06-06T09-00-00-000Z")).toHaveTextContent(
      "2.0 KB",
    );
    expect(getByTestId("settings-backup-artifact-2026-06-06T09-00-00-000Z")).toHaveTextContent(
      "Automatic",
    );
    expect(h.listBackups).toHaveBeenCalled();
  });

  it("requires the exact restore phrase before restoring a selected backup", async () => {
    const { findByTestId, getByTestId, getByRole } = render(<Settings />);

    await findByTestId("settings-backup-artifact-2026-06-07T10-20-30-000Z");
    const restoreButton = getByTestId("settings-restore-backup");
    expect(restoreButton).toBeDisabled();
    expect(getByRole("textbox", { name: /restore selected backup/i })).toHaveAccessibleDescription(
      new RegExp(RESTORE_BACKUP_CONFIRMATION_PHRASE),
    );

    fireEvent.change(getByTestId("settings-restore-confirm"), {
      target: { value: "restore backup" },
    });
    expect(restoreButton).toBeDisabled();
    expect(h.restoreBackup).not.toHaveBeenCalled();

    fireEvent.change(getByTestId("settings-restore-confirm"), {
      target: { value: RESTORE_BACKUP_CONFIRMATION_PHRASE },
    });
    fireEvent.click(restoreButton);

    await waitFor(() =>
      expect(h.restoreBackup).toHaveBeenCalledWith({
        timestamp: "2026-06-07T10-20-30-000Z",
        confirm: true,
        phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
      }),
    );
    expect(await findByTestId("settings-restore-success")).toHaveTextContent("Restart Interleave");
    expect(getByTestId("settings-data-restart-required")).toHaveTextContent("Restart Interleave");
    expect(getByTestId("settings-backup-now")).toBeDisabled();
    expect(getByTestId("settings-backup-refresh")).toBeDisabled();
  });

  it("clears a typed restore phrase when the selected backup changes", async () => {
    h.listBackups.mockResolvedValueOnce({
      backups: [
        {
          timestamp: "2026-06-07T10-20-30-000Z",
          createdAt: "2026-06-07T10:20:30.000Z",
          sizeBytes: 4096,
          fileCount: 4,
          schemaVersion: "v1",
          automatic: false,
        },
        {
          timestamp: "2026-06-06T09-00-00-000Z",
          createdAt: "2026-06-06T09:00:00.000Z",
          sizeBytes: 2048,
          fileCount: 3,
          schemaVersion: "v1",
          automatic: true,
        },
      ],
    });
    const { findByTestId, getByTestId } = render(<Settings />);

    await findByTestId("settings-backup-artifact-2026-06-07T10-20-30-000Z");
    fireEvent.change(getByTestId("settings-restore-confirm"), {
      target: { value: RESTORE_BACKUP_CONFIRMATION_PHRASE },
    });
    expect(getByTestId("settings-restore-backup")).not.toBeDisabled();

    fireEvent.click(getByTestId("settings-backup-artifact-2026-06-06T09-00-00-000Z"));

    expect(getByTestId("settings-restore-confirm")).toHaveValue("");
    expect(getByTestId("settings-restore-backup")).toBeDisabled();
    expect(h.restoreBackup).not.toHaveBeenCalled();
  });

  it("blocks overlapping destructive backup operations", async () => {
    const restore = deferred<{
      status: "restored";
      timestamp: string;
      restoredAt: string;
      reloadRequired: true;
    }>();
    h.restoreBackup.mockReturnValueOnce(restore.promise);
    const { findByTestId, getByTestId } = render(<Settings />);

    await findByTestId("settings-backup-artifact-2026-06-07T10-20-30-000Z");
    fireEvent.change(getByTestId("settings-restore-confirm"), {
      target: { value: RESTORE_BACKUP_CONFIRMATION_PHRASE },
    });
    fireEvent.click(getByTestId("settings-restore-backup"));
    fireEvent.click(getByTestId("settings-restore-backup"));

    await waitFor(() => expect(h.restoreBackup).toHaveBeenCalledTimes(1));
    expect(getByTestId("settings-reset-local-data")).toBeDisabled();
    expect(getByTestId("settings-backup-now")).toBeDisabled();
    fireEvent.change(getByTestId("settings-reset-confirm"), {
      target: { value: RESET_LOCAL_DATA_CONFIRMATION_PHRASE },
    });
    fireEvent.click(getByTestId("settings-reset-local-data"));
    expect(h.resetLocalData).not.toHaveBeenCalled();

    restore.resolve({
      status: "restored",
      timestamp: "2026-06-07T10-20-30-000Z",
      restoredAt: "2026-06-07T10:35:00.000Z",
      reloadRequired: true,
    });
    expect(await findByTestId("settings-restore-success")).toHaveTextContent("Restart Interleave");
  });

  it("shows restore errors without hiding the selected backup", async () => {
    h.restoreBackup.mockRejectedValueOnce(new Error("hash mismatch"));
    const { findByTestId, getByTestId } = render(<Settings />);

    await findByTestId("settings-backup-artifact-2026-06-07T10-20-30-000Z");
    fireEvent.change(getByTestId("settings-restore-confirm"), {
      target: { value: RESTORE_BACKUP_CONFIRMATION_PHRASE },
    });
    fireEvent.click(getByTestId("settings-restore-backup"));

    expect(await findByTestId("settings-restore-error")).toHaveTextContent("hash mismatch");
    expect(getByTestId("settings-backup-artifact-2026-06-07T10-20-30-000Z")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("picks a backup file and reveals the basename plus confirm input", async () => {
    h.pickBackupArchive.mockResolvedValueOnce({ path: "/tmp/backups/foo.zip" });
    const { findByTestId, getByTestId, queryByTestId } = render(<Settings />);

    await findByTestId("settings-restore-file-choose");
    expect(queryByTestId("settings-restore-file-path")).toBeNull();
    expect(queryByTestId("settings-restore-file-confirm")).toBeNull();

    fireEvent.click(getByTestId("settings-restore-file-choose"));

    await waitFor(() => expect(h.pickBackupArchive).toHaveBeenCalledTimes(1));
    expect(await findByTestId("settings-restore-file-path")).toHaveTextContent("foo.zip");
    expect(getByTestId("settings-restore-file-confirm")).toBeInTheDocument();
  });

  it("leaves the file-restore row unchanged when the picker is cancelled", async () => {
    h.pickBackupArchive.mockResolvedValueOnce({ cancelled: true });
    const { findByTestId, getByTestId, queryByTestId } = render(<Settings />);

    await findByTestId("settings-restore-file-choose");
    fireEvent.click(getByTestId("settings-restore-file-choose"));

    await waitFor(() => expect(h.pickBackupArchive).toHaveBeenCalledTimes(1));
    expect(queryByTestId("settings-restore-file-path")).toBeNull();
    expect(queryByTestId("settings-restore-file-confirm")).toBeNull();
    expect(h.restoreBackupFromFile).not.toHaveBeenCalled();
  });

  it("requires both a chosen file and the exact phrase before restoring from a file", async () => {
    const { findByTestId, getByTestId } = render(<Settings />);

    await findByTestId("settings-restore-file-choose");
    fireEvent.click(getByTestId("settings-restore-file-choose"));

    const confirm = await findByTestId("settings-restore-file-confirm");
    const restoreButton = getByTestId("settings-restore-file");
    expect(restoreButton).toBeDisabled();

    fireEvent.change(confirm, { target: { value: "restore backup" } });
    expect(restoreButton).toBeDisabled();
    expect(h.restoreBackupFromFile).not.toHaveBeenCalled();

    fireEvent.change(confirm, { target: { value: RESTORE_BACKUP_CONFIRMATION_PHRASE } });
    expect(restoreButton).not.toBeDisabled();
    fireEvent.click(restoreButton);

    await waitFor(() =>
      expect(h.restoreBackupFromFile).toHaveBeenCalledWith({
        path: "/tmp/backups/foo.zip",
        confirm: true,
        phrase: RESTORE_BACKUP_CONFIRMATION_PHRASE,
      }),
    );
  });

  it("locks the panel and shows restart-required after a file restore succeeds", async () => {
    const { findByTestId, getByTestId } = render(<Settings />);

    await findByTestId("settings-restore-file-choose");
    fireEvent.click(getByTestId("settings-restore-file-choose"));
    fireEvent.change(await findByTestId("settings-restore-file-confirm"), {
      target: { value: RESTORE_BACKUP_CONFIRMATION_PHRASE },
    });
    fireEvent.click(getByTestId("settings-restore-file"));

    expect(await findByTestId("settings-restore-file-success")).toHaveTextContent("foo.zip");
    expect(getByTestId("settings-data-restart-required")).toHaveTextContent("Restart Interleave");
    expect(getByTestId("settings-backup-now")).toBeDisabled();
    expect(getByTestId("settings-backup-refresh")).toBeDisabled();
    expect(getByTestId("settings-restore-backup")).toBeDisabled();
    expect(getByTestId("settings-restore-file-choose")).toBeDisabled();
  });

  it("surfaces a file-restore error without entering restart-required", async () => {
    h.restoreBackupFromFile.mockRejectedValueOnce(new Error("zip-slip entry"));
    const { findByTestId, getByTestId, queryByTestId } = render(<Settings />);

    await findByTestId("settings-restore-file-choose");
    fireEvent.click(getByTestId("settings-restore-file-choose"));
    fireEvent.change(await findByTestId("settings-restore-file-confirm"), {
      target: { value: RESTORE_BACKUP_CONFIRMATION_PHRASE },
    });
    fireEvent.click(getByTestId("settings-restore-file"));

    expect(await findByTestId("settings-restore-file-error")).toHaveTextContent("zip-slip entry");
    expect(queryByTestId("settings-data-restart-required")).toBeNull();
    expect(getByTestId("settings-backup-now")).not.toBeDisabled();
  });

  it("requires the exact fresh-start phrase before resetting local data", async () => {
    const { findByTestId, getByTestId, getByRole } = render(<Settings />);

    await findByTestId("settings-reset-local-data");
    const resetButton = getByTestId("settings-reset-local-data");
    expect(resetButton).toBeDisabled();
    expect(getByRole("textbox", { name: /fresh start/i })).toHaveAccessibleDescription(
      new RegExp(RESET_LOCAL_DATA_CONFIRMATION_PHRASE),
    );

    fireEvent.change(getByTestId("settings-reset-confirm"), {
      target: { value: "START" },
    });
    expect(resetButton).toBeDisabled();
    expect(h.resetLocalData).not.toHaveBeenCalled();

    fireEvent.change(getByTestId("settings-reset-confirm"), {
      target: { value: RESET_LOCAL_DATA_CONFIRMATION_PHRASE },
    });
    fireEvent.click(resetButton);

    await waitFor(() =>
      expect(h.resetLocalData).toHaveBeenCalledWith({
        confirm: true,
        phrase: RESET_LOCAL_DATA_CONFIRMATION_PHRASE,
      }),
    );
    expect(await findByTestId("settings-reset-success")).toHaveTextContent("Restart Interleave");
    expect(getByTestId("settings-data-restart-required")).toHaveTextContent("Restart Interleave");
  });

  it("shows backup list and fresh-start errors", async () => {
    h.listBackups.mockRejectedValueOnce(new Error("manifest unreadable"));
    h.resetLocalData.mockRejectedValueOnce(new Error("reset refused"));
    const { findByTestId, getByTestId } = render(<Settings />);

    expect(await findByTestId("settings-backup-list-error")).toHaveTextContent(
      "manifest unreadable",
    );

    fireEvent.change(getByTestId("settings-reset-confirm"), {
      target: { value: RESET_LOCAL_DATA_CONFIRMATION_PHRASE },
    });
    fireEvent.click(getByTestId("settings-reset-local-data"));

    expect(await findByTestId("settings-reset-error")).toHaveTextContent("reset refused");
  });

  it("enables capture server and reveals running status", async () => {
    h.getCapturePairing
      .mockResolvedValueOnce({
        enabled: false,
        running: false,
        port: null,
        token: "token-1",
        extensionOriginHint: null,
      })
      .mockResolvedValueOnce({
        enabled: true,
        running: true,
        port: 17890,
        token: "token-1",
        extensionOriginHint: "chrome-extension://abc",
      });
    const { getByTestId, findByTestId } = render(<Settings />);

    await findByTestId("settings-capture-toggle");
    fireEvent.click(getByTestId("settings-capture-toggle"));

    await waitFor(() => expect(h.setCaptureEnabled).toHaveBeenCalledWith({ enabled: true }));
    expect(await findByTestId("settings-capture-status")).toHaveTextContent("Running");
    expect(getByTestId("settings-capture-origin")).toHaveTextContent("chrome-extension://abc");
  });

  it("does not render semantic-search provider or embedding-key settings", async () => {
    h.getAppSettings.mockResolvedValue({
      settings: {
        ...settings,
      },
    });
    const { findByTestId, queryByTestId, queryByText } = render(<Settings />);

    await findByTestId("setting-budget");

    expect(queryByText(/^Semantic search$/i)).toBeNull();
    expect(queryByTestId("setting-semantic-enabled")).toBeNull();
    expect(queryByTestId("setting-embedding-provider")).toBeNull();
    expect(queryByTestId("setting-embedding-api-key")).toBeNull();
    expect(queryByTestId("setting-embedding-store-key")).toBeNull();
  });

  it("uses write-only key patches for AI settings", async () => {
    h.getAppSettings.mockResolvedValue({
      settings: {
        ...settings,
        aiProviderKind: "openai",
      },
    });
    h.updateAppSettings.mockImplementation(({ patch }) => ({
      settings: {
        ...settings,
        aiProviderKind: "openai",
        ...patch,
      },
    }));
    const { getByTestId, findByTestId } = render(<Settings />);

    fireEvent.change(await findByTestId("setting-ai-api-key"), {
      target: { value: " ai-key " },
    });
    fireEvent.click(getByTestId("setting-ai-store-key"));
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { aiApiKey: "ai-key" } }),
    );
  });
});

describe("System section", () => {
  it("renders the diagnostics from the typed bridge", async () => {
    const { getByTestId, findByTestId } = render(<Settings />);

    await waitFor(() => expect(getByTestId("health-status")).toHaveTextContent("Healthy"));
    expect(getByTestId("desktop-status")).toHaveAttribute("data-desktop", "true");
    expect(getByTestId("db-applied-migrations")).toHaveTextContent("12 migrations");
    expect(getByTestId("db-migrated")).toHaveTextContent("Up to date");
    expect(getByTestId("db-journal-mode")).toHaveTextContent("wal");
    expect(getByTestId("db-foreign-keys")).toHaveTextContent("FK on");
    expect(getByTestId("db-busy-timeout")).toHaveTextContent("5000 ms");
    expect(await findByTestId("persisted-value")).toHaveTextContent("checked-before");
    expect(h.getSettings).toHaveBeenCalledWith({ key: "desktop.lastCheck" });
  });

  it("writes a persisted check and reads it back over the bridge", async () => {
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-06-03T13:00:00.000Z");
    h.getSettings
      .mockResolvedValueOnce({ settings: { "desktop.lastCheck": "checked-before" } })
      .mockResolvedValueOnce({
        settings: { "desktop.lastCheck": "checked-2026-06-03T13:00:00.000Z" },
      });
    const { getByTestId, findByTestId } = render(<Settings />);
    await waitFor(() => expect(getByTestId("persisted-value")).toHaveTextContent("checked-before"));

    fireEvent.click(await findByTestId("persist-button"));

    await waitFor(() =>
      expect(h.updateSetting).toHaveBeenCalledWith({
        key: "desktop.lastCheck",
        value: "checked-2026-06-03T13:00:00.000Z",
      }),
    );
    await waitFor(() =>
      expect(getByTestId("persisted-value")).toHaveTextContent("checked-2026-06-03T13:00:00.000Z"),
    );
  });

  it("shows the loading state while the bridge reads are in flight", async () => {
    // dbStatus never resolves -> status stays null -> the Local-database chip reads "Checking…".
    h.dbStatus.mockReturnValue(new Promise(() => {}));
    const { getByTestId } = render(<Settings />);

    await waitFor(() => expect(getByTestId("health-status")).toHaveTextContent("Checking…"));
  });

  it("shows 'Unavailable' when the database reports it is not open", async () => {
    h.dbStatus.mockResolvedValue({
      open: false,
      migrated: true,
      journalMode: "wal",
      foreignKeys: 1,
      busyTimeoutMs: 5000,
      appliedMigrations: 12,
    });
    const { getByTestId } = render(<Settings />);

    await waitFor(() => expect(getByTestId("health-status")).toHaveTextContent("Unavailable"));
  });

  it("renders 'FK off' when foreign keys are disabled", async () => {
    h.dbStatus.mockResolvedValue({
      open: true,
      migrated: true,
      journalMode: "wal",
      foreignKeys: 0,
      busyTimeoutMs: 5000,
      appliedMigrations: 12,
    });
    const { getByTestId } = render(<Settings />);

    await waitFor(() => expect(getByTestId("db-foreign-keys")).toHaveTextContent("FK off"));
  });

  it("omits the 'Up to date' chip when the store is not yet migrated", async () => {
    h.dbStatus.mockResolvedValue({
      open: true,
      migrated: false,
      journalMode: "wal",
      foreignKeys: 1,
      busyTimeoutMs: 5000,
      appliedMigrations: 0,
    });
    const { getByTestId, queryByTestId } = render(<Settings />);

    await waitFor(() =>
      expect(getByTestId("db-applied-migrations")).toHaveTextContent("0 migrations"),
    );
    expect(queryByTestId("db-migrated")).toBeNull();
  });

  it("surfaces a bridge failure in the error row and flips the chip to 'Unavailable'", async () => {
    h.dbStatus.mockRejectedValue(new Error("db unavailable"));
    const { getByTestId, findByTestId } = render(<Settings />);

    expect(await findByTestId("desktop-status-error")).toHaveTextContent("db unavailable");
    expect(getByTestId("health-status")).toHaveTextContent("Unavailable");
  });
});

describe("Settings — Search Intelligence panel (U5)", () => {
  it("renders the index-health headline + coverage from semanticStatus", async () => {
    const { findByTestId } = render(<Settings />);
    expect(await findByTestId("semantic-index-health")).toHaveTextContent("Search index ready");
    expect(await findByTestId("semantic-progress")).toHaveTextContent("10 of 10");
    expect(await findByTestId("semantic-model-ready")).toHaveTextContent("Model ready");
  });

  it("shows a fallback (degraded) state with human copy — never a raw enum token", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: false,
      embedded: 5,
      total: 10,
      modelId: "local:embeddinggemma-hash-768",
      modelState: "fallback",
      indexHealth: "degraded",
      coverageRatio: 0.5,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    const { findByTestId } = render(<Settings />);
    const chip = await findByTestId("semantic-model-fallback");
    expect(chip).toHaveTextContent(/keyword fallback/i);
    // Human sentence, not the bare enum token.
    expect(chip.textContent?.trim()).not.toBe("fallback");
    expect(await findByTestId("semantic-recheck-model")).toBeInTheDocument();
  });

  it("surfaces failures in plain language and retries on click", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 8,
      total: 10,
      modelId: "onnx-community/embeddinggemma-300m-ONNX",
      modelState: "ready",
      indexHealth: "stale",
      coverageRatio: 0.8,
      failedCount: 2,
      lastError: "OVERSIZED: element text too large",
      etaSeconds: null,
    });
    const { findByTestId, getByText } = render(<Settings />);
    expect(await findByTestId("semantic-failed")).toHaveTextContent("2 failed");
    // The raw "OVERSIZED: …" string is translated to plain language, never shown verbatim.
    expect(getByText("An item was too large to index.")).toBeInTheDocument();
    fireEvent.click(await findByTestId("semantic-retry-failed"));
    await waitFor(() => expect(h.semanticRetryFailed).toHaveBeenCalledTimes(1));
  });

  it("rebuild calls semanticReindex", async () => {
    const { findByTestId } = render(<Settings />);
    fireEvent.click(await findByTestId("semantic-reindex"));
    await waitFor(() => expect(h.semanticReindex).toHaveBeenCalledWith({ onlyMissing: false }));
  });

  it("renders a neutral empty state for an empty vault (no false 'partial coverage')", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 0,
      total: 0,
      modelId: "onnx-community/embeddinggemma-300m-ONNX",
      modelState: "ready",
      indexHealth: "healthy",
      coverageRatio: 0,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    const { findByTestId, queryByTestId } = render(<Settings />);
    expect(await findByTestId("semantic-empty")).toHaveTextContent("Nothing to index yet");
    expect(queryByTestId("semantic-progress")).toBeNull();
  });

  it("collapses to an unavailable message when the vector engine is down", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: false,
      modelDownloaded: false,
      embedded: 0,
      total: 10,
      modelId: "",
      modelState: "fallback",
      indexHealth: "degraded",
      coverageRatio: 0,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    const { findByTestId, queryByTestId } = render(<Settings />);
    expect(await findByTestId("semantic-unavailable")).toBeInTheDocument();
    expect(queryByTestId("semantic-reindex")).toBeNull();
  });
});

describe("Settings — Search Intelligence building/loading states (U5)", () => {
  it("shows a building headline + ETA while indexing", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: true,
      embedded: 4,
      total: 10,
      modelId: "onnx-community/embeddinggemma-300m-ONNX",
      modelState: "ready",
      indexHealth: "building",
      coverageRatio: 0.4,
      failedCount: 0,
      lastError: null,
      etaSeconds: 42,
    });
    const { findByTestId, getByText } = render(<Settings />);
    expect(await findByTestId("semantic-index-health")).toHaveTextContent("Building search index…");
    expect(getByText("about 42s remaining")).toBeInTheDocument();
  });

  it("shows a 'Loading model…' chip (not a raw token) while the model loads", async () => {
    h.semanticStatus.mockResolvedValue({
      enabled: true,
      vecAvailable: true,
      modelDownloaded: false,
      embedded: 0,
      total: 5,
      modelId: "onnx-community/embeddinggemma-300m-ONNX",
      modelState: "loading",
      indexHealth: "building",
      coverageRatio: 0,
      failedCount: 0,
      lastError: null,
      etaSeconds: null,
    });
    const { findByTestId } = render(<Settings />);
    expect(await findByTestId("semantic-model-loading")).toHaveTextContent("Loading model…");
  });
});
