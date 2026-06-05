import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  desktop: true,
  getAppSettings: vi.fn(),
  updateAppSettings: vi.fn(),
  createBackup: vi.fn(),
  getCapturePairing: vi.fn(),
  setCaptureEnabled: vi.fn(),
  regenerateCaptureToken: vi.fn(),
  semanticStatus: vi.fn(),
  semanticReindex: vi.fn(),
  semanticDownloadModel: vi.fn(),
  subscribeJobs: vi.fn(),
  aiStatus: vi.fn(),
  downloadAiModel: vi.fn(),
  setRetentionBandEnabled: vi.fn(),
  setRetentionBand: vi.fn(),
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
      getCapturePairing: h.getCapturePairing,
      setCaptureEnabled: h.setCaptureEnabled,
      regenerateCaptureToken: h.regenerateCaptureToken,
      semanticStatus: h.semanticStatus,
      semanticReindex: h.semanticReindex,
      semanticDownloadModel: h.semanticDownloadModel,
      subscribeJobs: h.subscribeJobs,
      aiStatus: h.aiStatus,
      downloadAiModel: h.downloadAiModel,
      setRetentionBandEnabled: h.setRetentionBandEnabled,
      setRetentionBand: h.setRetentionBand,
    },
  };
});

import { Settings } from "./Settings";

const settings = {
  dailyReviewBudget: 60,
  defaultDesiredRetention: 0.9,
  defaultTopicIntervalDays: 7,
  defaultSourcePriority: 0.375,
  burySiblings: true,
  trashRetentionDays: 30,
  balanceWarnings: true,
  importBalanceFactor: 1.5,
  keyboardLayout: "qwerty",
  theme: "dark",
  displayName: "",
  retentionByBand: {},
  retentionByBandEnabled: false,
  fsrsParamsGlobal: null,
  semanticSearchEnabled: false,
  embeddingProvider: "local",
  embeddingApiKeyConfigured: false,
  embeddingModelId: "local:minilm-hash-384",
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
  h.updateAppSettings.mockImplementation(({ patch }) => ({
    settings: { ...settings, ...patch },
  }));
  h.createBackup.mockResolvedValue({
    path: "/tmp/interleave.zip",
    sizeBytes: 2048,
    fileCount: 3,
    schemaVersion: "v1",
  });
  h.getCapturePairing.mockResolvedValue({
    enabled: false,
    running: false,
    port: null,
    token: "token-1",
    extensionOriginHint: null,
  });
  h.setCaptureEnabled.mockResolvedValue({ enabled: true, running: true, port: 17890 });
  h.semanticStatus.mockResolvedValue({
    vecAvailable: true,
    embedded: 0,
    total: 2,
    modelDownloaded: false,
  });
  h.subscribeJobs.mockReturnValue(() => {});
  h.aiStatus.mockResolvedValue({
    enabled: false,
    providerKind: "local",
    keyConfigured: false,
    modelDownloaded: false,
    managedProxyEnabled: false,
  });
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
    const { getByTestId, findByTestId } = render(<Settings />);

    expect(await findByTestId("setting-budget-value")).toHaveTextContent("60/day");
    fireEvent.change(getByTestId("setting-budget"), { target: { value: "75" } });

    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { dailyReviewBudget: 75 } }),
    );
    expect(await findByTestId("settings-saved")).toBeInTheDocument();
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

  it("runs a backup and displays the result", async () => {
    const { getByTestId, findByTestId } = render(<Settings />);

    await findByTestId("settings-backup-now");
    fireEvent.click(getByTestId("settings-backup-now"));

    await waitFor(() => expect(h.createBackup).toHaveBeenCalled());
    expect(await findByTestId("settings-backup-result")).toHaveTextContent("2.0 KB");
    expect(getByTestId("settings-backup-result")).toHaveTextContent("3 files");
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

  it("uses write-only key patches for semantic and AI settings", async () => {
    h.getAppSettings.mockResolvedValue({
      settings: {
        ...settings,
        embeddingProvider: "api",
        aiProviderKind: "openai",
      },
    });
    h.updateAppSettings.mockImplementation(({ patch }) => ({
      settings: {
        ...settings,
        embeddingProvider: "api",
        aiProviderKind: "openai",
        ...patch,
      },
    }));
    const { getByTestId, findByTestId } = render(<Settings />);

    fireEvent.change(await findByTestId("setting-embedding-api-key"), {
      target: { value: " embed-key " },
    });
    fireEvent.click(getByTestId("setting-embedding-save-key"));
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { embeddingApiKey: "embed-key" } }),
    );

    fireEvent.change(await findByTestId("setting-ai-api-key"), {
      target: { value: " ai-key " },
    });
    fireEvent.click(getByTestId("setting-ai-save-key"));
    await waitFor(() =>
      expect(h.updateAppSettings).toHaveBeenCalledWith({ patch: { aiApiKey: "ai-key" } }),
    );
  });
});
