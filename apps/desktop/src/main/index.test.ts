import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../shared/channels";

interface IndexHarness {
  app: {
    isPackaged: boolean;
    requestSingleInstanceLock: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    whenReady: ReturnType<typeof vi.fn>;
    getVersion: ReturnType<typeof vi.fn>;
    setActivationPolicy: ReturnType<typeof vi.fn>;
    dock: { hide: ReturnType<typeof vi.fn>; setIcon: ReturnType<typeof vi.fn> };
  };
  callbacks: Map<string, (...args: unknown[]) => unknown>;
  dbService: Record<string, ReturnType<typeof vi.fn> | Record<string, unknown>>;
  captureController: Record<string, ReturnType<typeof vi.fn>>;
  jobRunner: Record<string, ReturnType<typeof vi.fn>>;
  automaticBackupService: Record<string, ReturnType<typeof vi.fn>>;
  browserWindow: { getAllWindows: ReturnType<typeof vi.fn> };
  captureControllerConstructor: ReturnType<typeof vi.fn>;
  registerIpcHandlers: ReturnType<typeof vi.fn>;
  disposeIpc: ReturnType<typeof vi.fn>;
  registerRendererProtocol: ReturnType<typeof vi.fn>;
  registerRendererSchemePrivileges: ReturnType<typeof vi.fn>;
  registerMediaProtocol: ReturnType<typeof vi.fn>;
  registerMediaSchemePrivileges: ReturnType<typeof vi.fn>;
  registerArticleImageProtocol: ReturnType<typeof vi.fn>;
  registerArticleImageSchemePrivileges: ReturnType<typeof vi.fn>;
  installApplicationMenu: ReturnType<typeof vi.fn>;
  createMainWindow: ReturnType<typeof vi.fn>;
  setCaptureEnabled: ReturnType<typeof vi.fn>;
  nativeImage: {
    createFromPath: ReturnType<typeof vi.fn>;
    image: { isEmpty: ReturnType<typeof vi.fn> };
  };
}

async function loadIndex(options: {
  readonly gotLock: boolean;
  readonly isPackaged?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly platform?: NodeJS.Platform;
}): Promise<IndexHarness> {
  vi.resetModules();
  vi.unstubAllEnvs();
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  if (options.platform) {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: options.platform,
    });
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) vi.stubEnv(key, undefined);
    else vi.stubEnv(key, value);
  }

  const callbacks = new Map<string, (...args: unknown[]) => unknown>();
  const app = {
    isPackaged: options.isPackaged ?? false,
    requestSingleInstanceLock: vi.fn(() => options.gotLock),
    quit: vi.fn(),
    on: vi.fn((event: string, fn: (...args: unknown[]) => unknown) => callbacks.set(event, fn)),
    whenReady: vi.fn(() => Promise.resolve()),
    getVersion: vi.fn(() => "0.2.0"),
    setActivationPolicy: vi.fn(),
    dock: { hide: vi.fn(), setIcon: vi.fn() },
  };
  const BrowserWindow = {
    getAllWindows: vi.fn(() => []),
  };
  const nativeImage = {
    image: { isEmpty: vi.fn(() => false) },
    createFromPath: vi.fn(() => nativeImage.image),
  };
  const elementRepo = {
    findById: vi.fn(),
  };

  const dbService = {
    open: vi.fn(),
    seedIfEmpty: vi.fn(() => false),
    seedMaintenanceIfEmpty: vi.fn(() => null),
    seedExtractAgingIfEmpty: vi.fn(() => null),
    seedScaleIfEmpty: vi.fn(() => null),
    updateSetting: vi.fn(),
    close: vi.fn(),
    setRunner: vi.fn(),
    setPowerSource: vi.fn(),
    triageInboxItem: vi.fn(() => ({ item: null, deleted: false })),
    repos: {
      settings: {
        getAppSettings: vi.fn(() => ({ aiEnabled: false, aiProviderKind: "local" })),
      },
      elements: elementRepo,
      jobs: {},
    },
    urlImportService: {},
    assetVaultService: {},
    ocrService: {},
    embeddingService: {},
    aiService: {},
  };
  const captureController = {
    startIfEnabled: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const jobRunner = {
    start: vi.fn(),
    stop: vi.fn(),
  };
  const automaticBackupService = {
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const disposeIpc = vi.fn();
  const registerIpcHandlers = vi.fn(() => disposeIpc);
  const registerRendererProtocol = vi.fn();
  const registerRendererSchemePrivileges = vi.fn();
  const registerMediaProtocol = vi.fn();
  const registerMediaSchemePrivileges = vi.fn();
  const registerArticleImageProtocol = vi.fn();
  const registerArticleImageSchemePrivileges = vi.fn();
  const installApplicationMenu = vi.fn();
  const createMainWindow = vi.fn();
  const setCaptureEnabled = vi.fn();
  const captureControllerConstructor = vi.fn(function CaptureController() {
    return captureController;
  });

  vi.doMock("electron", () => ({ app, BrowserWindow, nativeImage }));
  vi.doMock("./db-service", () => ({
    DbService: vi.fn(function DbService() {
      return dbService;
    }),
  }));
  vi.doMock("./capture-controller", () => ({
    CaptureController: captureControllerConstructor,
  }));
  vi.doMock("./job-runner", () => ({
    JobRunner: vi.fn(function JobRunner() {
      return jobRunner;
    }),
  }));
  vi.doMock("./automatic-backup-service", () => ({
    AutomaticBackupService: vi.fn(function AutomaticBackupService() {
      return automaticBackupService;
    }),
  }));
  vi.doMock("./ipc", () => ({ registerIpcHandlers }));
  vi.doMock("./job-apply-handlers", () => ({ createJobApplyHandlers: vi.fn(() => ({})) }));
  vi.doMock("./capture-pairing", () => ({ setCaptureEnabled }));
  vi.doMock("./article-image-protocol", () => ({
    registerArticleImageProtocol,
    registerArticleImageSchemePrivileges,
  }));
  vi.doMock("./media-protocol", () => ({ registerMediaProtocol, registerMediaSchemePrivileges }));
  vi.doMock("./menu", () => ({ installApplicationMenu }));
  vi.doMock("./migrations", () => ({ resolveMigrationsDir: vi.fn(() => "/migrations") }));
  vi.doMock("./native-binding", () => ({
    resolveNativeBinding: vi.fn(() => "/native/better.node"),
  }));
  vi.doMock("./paths", () => ({
    initAppPaths: vi.fn(() => ({
      dataDir: "/data",
      dbPath: "/data/app.sqlite",
      assetsDir: "/data/assets",
      backupsDir: "/data/backups",
      exportsDir: "/data/exports",
      downloadsDir: "/users/me/Downloads",
      modelsDir: "/data/models",
    })),
  }));
  vi.doMock("./renderer-protocol", () => ({
    RENDERER_URL: "app://bundle/",
    registerRendererProtocol,
    registerRendererSchemePrivileges,
  }));
  vi.doMock("./sqlite-vec-binding", () => ({
    resolveSqliteVecBinary: vi.fn(() => "/native/vec0.dylib"),
  }));
  vi.doMock("./window", () => ({ createMainWindow }));

  await import("./index");
  await Promise.resolve();
  if (originalPlatform) {
    Object.defineProperty(process, "platform", originalPlatform);
  }

  return {
    app,
    callbacks,
    dbService,
    captureController,
    browserWindow: BrowserWindow,
    captureControllerConstructor,
    jobRunner,
    automaticBackupService,
    registerIpcHandlers,
    disposeIpc,
    registerRendererProtocol,
    registerRendererSchemePrivileges,
    registerMediaProtocol,
    registerMediaSchemePrivileges,
    registerArticleImageProtocol,
    registerArticleImageSchemePrivileges,
    installApplicationMenu,
    createMainWindow,
    setCaptureEnabled,
    nativeImage,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeWindow(options: { readonly loading?: boolean } = {}) {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    webContents: {
      isLoadingMainFrame: vi.fn(() => options.loading ?? false),
      send: vi.fn(),
    },
  };
}

function firstCallOrder(fn: {
  readonly mock: { readonly invocationCallOrder: readonly number[] };
}) {
  const [order] = fn.mock.invocationCallOrder;
  if (order === undefined) throw new Error("Expected a recorded call order");
  return order;
}

function lastCallOrder(fn: { readonly mock: { readonly invocationCallOrder: readonly number[] } }) {
  const order = fn.mock.invocationCallOrder.at(-1);
  if (order === undefined) throw new Error("Expected a recorded call order");
  return order;
}

describe("main entrypoint", () => {
  it("sets the checked-in Interleave dock icon on macOS dev launches", async () => {
    const harness = await loadIndex({ gotLock: true, platform: "darwin" });

    expect(harness.app.setActivationPolicy).not.toHaveBeenCalled();
    expect(harness.app.dock.hide).not.toHaveBeenCalled();
    expect(harness.nativeImage.createFromPath).toHaveBeenCalledWith(
      expect.stringMatching(/brand\/icon\.png$|build\/icon\.icns$/),
    );
    expect(harness.app.dock.setIcon).toHaveBeenCalledWith(harness.nativeImage.image);
  });

  it("uses accessory presentation and keeps the Dock icon hidden for quiet macOS E2E", async () => {
    const harness = await loadIndex({
      gotLock: true,
      platform: "darwin",
      env: { INTERLEAVE_E2E_QUIET: "1" },
    });

    expect(harness.app.setActivationPolicy).toHaveBeenCalledWith("accessory");
    expect(firstCallOrder(harness.app.setActivationPolicy)).toBeLessThan(
      firstCallOrder(harness.app.whenReady),
    );
    expect(harness.app.dock.hide).toHaveBeenCalledOnce();
    expect(harness.nativeImage.createFromPath).not.toHaveBeenCalled();
    expect(harness.app.dock.setIcon).not.toHaveBeenCalled();
    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined, showOnReady: false }),
    );
  });

  it("ignores quiet E2E presentation outside macOS", async () => {
    const harness = await loadIndex({
      gotLock: true,
      platform: "linux",
      env: { INTERLEAVE_E2E_QUIET: "1" },
    });

    expect(harness.app.setActivationPolicy).not.toHaveBeenCalled();
    expect(harness.app.dock.hide).not.toHaveBeenCalled();
    expect(harness.app.dock.setIcon).not.toHaveBeenCalled();
    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined, showOnReady: true }),
    );
  });

  it("ignores quiet E2E presentation for packaged apps", async () => {
    const harness = await loadIndex({
      gotLock: true,
      isPackaged: true,
      platform: "darwin",
      env: { INTERLEAVE_E2E_QUIET: "1" },
    });

    expect(harness.app.setActivationPolicy).not.toHaveBeenCalled();
    expect(harness.app.dock.hide).not.toHaveBeenCalled();
    expect(harness.app.dock.setIcon).toHaveBeenCalledWith(harness.nativeImage.image);
    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined, showOnReady: true }),
    );
  });

  it("quits immediately when another instance already owns the SQLite lock", async () => {
    const harness = await loadIndex({ gotLock: false });

    expect(harness.app.quit).toHaveBeenCalledOnce();
    expect(harness.app.whenReady).not.toHaveBeenCalled();
    expect(harness.dbService.open).not.toHaveBeenCalled();
    expect(harness.registerMediaSchemePrivileges).toHaveBeenCalledOnce();
    expect(harness.registerArticleImageSchemePrivileges).toHaveBeenCalledOnce();
  });

  it("bootstraps trusted services after ready and tears them down on will-quit", async () => {
    const harness = await loadIndex({
      gotLock: true,
      env: {
        INTERLEAVE_ALLOW_LOOPBACK_IMPORT: "1",
        INTERLEAVE_SUPPRESS_ONBOARDING: "1",
        INTERLEAVE_CAPTURE_ENABLED: "1",
      },
    });

    expect(harness.registerRendererSchemePrivileges).toHaveBeenCalledOnce();
    expect(harness.registerMediaSchemePrivileges).toHaveBeenCalledOnce();
    expect(harness.registerArticleImageSchemePrivileges).toHaveBeenCalledOnce();
    expect(harness.dbService.open).toHaveBeenCalledWith("/data/app.sqlite", {
      migrationsDir: "/migrations",
      nativeBinding: "/native/better.node",
      assetsDir: "/data/assets",
      exportDestinationDir: "/users/me/Downloads",
      vecBinaryPath: "/native/vec0.dylib",
      allowLoopbackImport: true,
    });
    expect(harness.dbService.updateSetting).toHaveBeenCalledWith("ui.seenOnboarding", true);
    expect(harness.setCaptureEnabled).toHaveBeenCalledWith(
      (harness.dbService.repos as { settings: unknown }).settings,
      true,
    );
    expect(harness.jobRunner.start).toHaveBeenCalledOnce();
    expect(harness.registerIpcHandlers).toHaveBeenCalledWith(
      harness.dbService,
      expect.objectContaining({
        paths: expect.objectContaining({
          dbPath: "/data/app.sqlite",
          assetsDir: "/data/assets",
          exportsDir: "/data/exports",
          downloadsDir: "/users/me/Downloads",
        }),
        migrationsDir: "/migrations",
        captureController: harness.captureController,
        runner: harness.jobRunner,
      }),
    );
    expect(harness.captureController.startIfEnabled).toHaveBeenCalledOnce();
    expect(harness.registerRendererProtocol).toHaveBeenCalledOnce();
    expect(harness.registerMediaProtocol).toHaveBeenCalledWith(harness.dbService, "/data/assets");
    expect(harness.registerArticleImageProtocol).toHaveBeenCalledWith(
      harness.dbService,
      "/data/assets",
    );
    expect(harness.installApplicationMenu).toHaveBeenCalledOnce();
    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined, showOnReady: true }),
    );

    expect(harness.automaticBackupService.start).toHaveBeenCalledOnce();

    await harness.callbacks.get("will-quit")?.();

    expect(harness.captureController.stop).toHaveBeenCalledOnce();
    expect(harness.jobRunner.stop).toHaveBeenCalledOnce();
    expect(harness.automaticBackupService.stop).toHaveBeenCalledOnce();
    expect(harness.disposeIpc).toHaveBeenCalledOnce();
    expect(harness.dbService.close).toHaveBeenCalledOnce();
  });

  it("seeds the extract-aging E2E fixture only when explicitly requested", async () => {
    const harness = await loadIndex({
      gotLock: true,
      env: { INTERLEAVE_SEED_EXTRACT_AGING: "1" },
    });

    expect(harness.dbService.seedExtractAgingIfEmpty).toHaveBeenCalledOnce();
    expect(harness.dbService.seedIfEmpty).not.toHaveBeenCalled();
    expect(harness.dbService.seedMaintenanceIfEmpty).not.toHaveBeenCalled();
    expect(harness.dbService.seedScaleIfEmpty).not.toHaveBeenCalled();
  });

  it("never honors VITE_DEV_SERVER_URL in packaged mode", async () => {
    const harness = await loadIndex({
      gotLock: true,
      isPackaged: true,
      env: { VITE_DEV_SERVER_URL: "http://localhost:5173" },
    });

    expect(harness.registerRendererProtocol).toHaveBeenCalledOnce();
    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined, showOnReady: true }),
    );
  });

  it("does not foreground an existing window while opening a captured source in quiet E2E", async () => {
    const harness = await loadIndex({
      gotLock: true,
      platform: "darwin",
      env: { INTERLEAVE_E2E_QUIET: "1" },
    });
    const win = fakeWindow();
    harness.browserWindow.getAllWindows.mockReturnValue([win]);
    const deps = harness.captureControllerConstructor.mock.calls[0]?.[0] as {
      openSource(input: { id: string; activate: boolean }): Promise<unknown>;
    };
    const repos = harness.dbService.repos as {
      elements: { findById: ReturnType<typeof vi.fn> };
    };
    repos.elements.findById.mockReturnValue({
      id: "source-1",
      type: "source",
      status: "active",
      deletedAt: null,
    });

    await expect(deps.openSource({ id: "source-1", activate: false })).resolves.toEqual({
      status: "opened",
      activated: false,
    });

    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.sourcesOpenReader, "source-1");
  });

  it("keeps newly created captured-source windows hidden in quiet E2E", async () => {
    const harness = await loadIndex({
      gotLock: true,
      platform: "darwin",
      env: { INTERLEAVE_E2E_QUIET: "1" },
    });
    const win = fakeWindow();
    harness.browserWindow.getAllWindows.mockReturnValue([]);
    harness.createMainWindow.mockClear();
    harness.createMainWindow.mockReturnValue(win);
    const deps = harness.captureControllerConstructor.mock.calls[0]?.[0] as {
      openSource(input: { id: string; activate: boolean }): Promise<unknown>;
    };
    const repos = harness.dbService.repos as {
      elements: { findById: ReturnType<typeof vi.fn> };
    };
    repos.elements.findById.mockReturnValue({
      id: "source-1",
      type: "source",
      status: "active",
      deletedAt: null,
    });

    await expect(deps.openSource({ id: "source-1", activate: false })).resolves.toEqual({
      status: "opened",
      activated: false,
    });

    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined, showOnReady: false }),
    );
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(win.loadURL).toHaveBeenCalledWith("app://bundle/source/source-1");
  });

  it("does not foreground an existing window on second-instance during quiet E2E", async () => {
    const harness = await loadIndex({
      gotLock: true,
      platform: "darwin",
      env: { INTERLEAVE_E2E_QUIET: "1" },
    });
    const win = fakeWindow();
    harness.browserWindow.getAllWindows.mockReturnValue([win]);

    harness.callbacks.get("second-instance")?.();

    expect(win.restore).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
  });

  it("foregrounds an existing window on second-instance in normal launches", async () => {
    const harness = await loadIndex({ gotLock: true, platform: "darwin" });
    const win = fakeWindow();
    win.isMinimized.mockReturnValue(true);
    harness.browserWindow.getAllWindows.mockReturnValue([win]);

    harness.callbacks.get("second-instance")?.();

    expect(win.restore).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(lastCallOrder(win.restore)).toBeLessThan(lastCallOrder(win.focus));
  });

  it("opens captured sources in an existing window without hard-reloading it", async () => {
    const harness = await loadIndex({ gotLock: true });
    const win = fakeWindow();
    harness.browserWindow.getAllWindows.mockReturnValue([win]);
    const deps = harness.captureControllerConstructor.mock.calls[0]?.[0] as {
      openSource(input: { id: string; activate: boolean }): Promise<unknown>;
    };
    const repos = harness.dbService.repos as {
      elements: { findById: ReturnType<typeof vi.fn> };
    };
    const triageInboxItem = harness.dbService.triageInboxItem as ReturnType<typeof vi.fn>;
    repos.elements.findById.mockReturnValue({
      id: "source-1",
      type: "source",
      status: "inbox",
      deletedAt: null,
    });

    await expect(deps.openSource({ id: "source-1", activate: true })).resolves.toEqual({
      status: "opened",
      activated: true,
    });

    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(win.loadURL).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.sourcesOpenReader, "source-1");
    expect(triageInboxItem).toHaveBeenCalledWith({
      id: "source-1",
      action: { kind: "accept" },
    });
    expect(firstCallOrder(triageInboxItem)).toBeLessThan(firstCallOrder(win.webContents.send));
  });

  it("does not navigate when inbox activation fails", async () => {
    const harness = await loadIndex({ gotLock: true });
    const win = fakeWindow();
    harness.browserWindow.getAllWindows.mockReturnValue([win]);
    const triageInboxItem = harness.dbService.triageInboxItem as ReturnType<typeof vi.fn>;
    triageInboxItem.mockImplementationOnce(() => {
      throw new Error("activation failed");
    });
    const deps = harness.captureControllerConstructor.mock.calls[0]?.[0] as {
      openSource(input: { id: string; activate: boolean }): Promise<unknown>;
    };
    const repos = harness.dbService.repos as {
      elements: { findById: ReturnType<typeof vi.fn> };
    };
    repos.elements.findById.mockReturnValue({
      id: "source-1",
      type: "source",
      status: "inbox",
      deletedAt: null,
    });

    await expect(deps.openSource({ id: "source-1", activate: true })).rejects.toThrow(
      "activation failed",
    );

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it("loads the encoded reader route for an existing window whose renderer is still loading", async () => {
    const harness = await loadIndex({ gotLock: true });
    const win = fakeWindow({ loading: true });
    harness.browserWindow.getAllWindows.mockReturnValue([win]);
    const deps = harness.captureControllerConstructor.mock.calls[0]?.[0] as {
      openSource(input: { id: string; activate: boolean }): Promise<unknown>;
    };
    const repos = harness.dbService.repos as {
      elements: { findById: ReturnType<typeof vi.fn> };
    };
    const triageInboxItem = harness.dbService.triageInboxItem as ReturnType<typeof vi.fn>;
    repos.elements.findById.mockReturnValue({
      id: "source/with space",
      type: "source",
      status: "inbox",
      deletedAt: null,
    });

    await expect(deps.openSource({ id: "source/with space", activate: true })).resolves.toEqual({
      status: "opened",
      activated: true,
    });

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(win.loadURL).toHaveBeenCalledWith("app://bundle/source/source%2Fwith%20space");
    expect(firstCallOrder(triageInboxItem)).toBeLessThan(firstCallOrder(win.loadURL));
  });

  it("loads the encoded reader route for a newly created window", async () => {
    const harness = await loadIndex({ gotLock: true });
    const win = fakeWindow();
    harness.browserWindow.getAllWindows.mockReturnValue([]);
    harness.createMainWindow.mockClear();
    harness.createMainWindow.mockReturnValue(win);
    const deps = harness.captureControllerConstructor.mock.calls[0]?.[0] as {
      openSource(input: { id: string; activate: boolean }): Promise<unknown>;
    };
    const repos = harness.dbService.repos as {
      elements: { findById: ReturnType<typeof vi.fn> };
    };
    repos.elements.findById.mockReturnValue({
      id: "source/with space",
      type: "source",
      status: "active",
      deletedAt: null,
    });

    await expect(deps.openSource({ id: "source/with space", activate: true })).resolves.toEqual({
      status: "opened",
      activated: false,
    });

    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined }),
    );
    expect(win.loadURL).toHaveBeenCalledWith("app://bundle/source/source%2Fwith%20space");
    expect(harness.dbService.triageInboxItem).not.toHaveBeenCalled();
  });

  it("does not mutate or navigate deleted, missing, or non-source elements", async () => {
    const harness = await loadIndex({ gotLock: true });
    const win = fakeWindow();
    harness.browserWindow.getAllWindows.mockReturnValue([win]);
    const deps = harness.captureControllerConstructor.mock.calls[0]?.[0] as {
      openSource(input: { id: string; activate: boolean }): Promise<unknown>;
    };
    const repos = harness.dbService.repos as {
      elements: { findById: ReturnType<typeof vi.fn> };
    };

    for (const element of [
      null,
      { id: "deleted", type: "source", status: "inbox", deletedAt: "2026-06-06T00:00:00.000Z" },
      { id: "card-1", type: "card", status: "active", deletedAt: null },
    ]) {
      repos.elements.findById.mockReturnValueOnce(element);
      await expect(deps.openSource({ id: "source-1", activate: true })).resolves.toEqual({
        status: "not_found",
      });
    }

    expect(harness.dbService.triageInboxItem).not.toHaveBeenCalled();
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});
