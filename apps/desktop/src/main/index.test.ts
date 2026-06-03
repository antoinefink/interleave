import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface IndexHarness {
  app: {
    isPackaged: boolean;
    requestSingleInstanceLock: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    whenReady: ReturnType<typeof vi.fn>;
    getVersion: ReturnType<typeof vi.fn>;
  };
  callbacks: Map<string, (...args: unknown[]) => unknown>;
  dbService: Record<string, ReturnType<typeof vi.fn> | Record<string, unknown>>;
  captureController: Record<string, ReturnType<typeof vi.fn>>;
  jobRunner: Record<string, ReturnType<typeof vi.fn>>;
  registerIpcHandlers: ReturnType<typeof vi.fn>;
  disposeIpc: ReturnType<typeof vi.fn>;
  registerRendererProtocol: ReturnType<typeof vi.fn>;
  registerRendererSchemePrivileges: ReturnType<typeof vi.fn>;
  registerMediaProtocol: ReturnType<typeof vi.fn>;
  registerMediaSchemePrivileges: ReturnType<typeof vi.fn>;
  installApplicationMenu: ReturnType<typeof vi.fn>;
  createMainWindow: ReturnType<typeof vi.fn>;
  setCaptureEnabled: ReturnType<typeof vi.fn>;
}

async function loadIndex(options: {
  readonly gotLock: boolean;
  readonly isPackaged?: boolean;
  readonly env?: Record<string, string | undefined>;
}): Promise<IndexHarness> {
  vi.resetModules();
  vi.unstubAllEnvs();
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
  };
  const BrowserWindow = {
    getAllWindows: vi.fn(() => []),
  };

  const dbService = {
    open: vi.fn(),
    seedIfEmpty: vi.fn(() => false),
    seedMaintenanceIfEmpty: vi.fn(() => null),
    seedScaleIfEmpty: vi.fn(() => null),
    updateSetting: vi.fn(),
    close: vi.fn(),
    setRunner: vi.fn(),
    repos: {
      settings: {
        getAppSettings: vi.fn(() => ({ aiEnabled: false, aiProviderKind: "local" })),
      },
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
  const disposeIpc = vi.fn();
  const registerIpcHandlers = vi.fn(() => disposeIpc);
  const registerRendererProtocol = vi.fn();
  const registerRendererSchemePrivileges = vi.fn();
  const registerMediaProtocol = vi.fn();
  const registerMediaSchemePrivileges = vi.fn();
  const installApplicationMenu = vi.fn();
  const createMainWindow = vi.fn();
  const setCaptureEnabled = vi.fn();

  vi.doMock("electron", () => ({ app, BrowserWindow }));
  vi.doMock("./db-service", () => ({
    DbService: vi.fn(function DbService() {
      return dbService;
    }),
  }));
  vi.doMock("./capture-controller", () => ({
    CaptureController: vi.fn(function CaptureController() {
      return captureController;
    }),
  }));
  vi.doMock("./job-runner", () => ({
    JobRunner: vi.fn(function JobRunner() {
      return jobRunner;
    }),
  }));
  vi.doMock("./ipc", () => ({ registerIpcHandlers }));
  vi.doMock("./job-apply-handlers", () => ({ createJobApplyHandlers: vi.fn(() => ({})) }));
  vi.doMock("./capture-pairing", () => ({ setCaptureEnabled }));
  vi.doMock("./embedding-service", () => ({ embedJobSecrets: vi.fn(() => ({})) }));
  vi.doMock("./media-protocol", () => ({ registerMediaProtocol, registerMediaSchemePrivileges }));
  vi.doMock("./menu", () => ({ installApplicationMenu }));
  vi.doMock("./migrations", () => ({ resolveMigrationsDir: vi.fn(() => "/migrations") }));
  vi.doMock("./native-binding", () => ({
    resolveNativeBinding: vi.fn(() => "/native/better.node"),
  }));
  vi.doMock("./paths", () => ({
    initAppPaths: vi.fn(() => ({
      dbPath: "/data/app.sqlite",
      assetsDir: "/data/assets",
      backupsDir: "/data/backups",
      exportsDir: "/data/exports",
      modelsDir: "/data/models",
    })),
  }));
  vi.doMock("./renderer-protocol", () => ({
    registerRendererProtocol,
    registerRendererSchemePrivileges,
  }));
  vi.doMock("./sqlite-vec-binding", () => ({
    resolveSqliteVecBinary: vi.fn(() => "/native/vec0.dylib"),
  }));
  vi.doMock("./window", () => ({ createMainWindow }));

  await import("./index");
  await Promise.resolve();

  return {
    app,
    callbacks,
    dbService,
    captureController,
    jobRunner,
    registerIpcHandlers,
    disposeIpc,
    registerRendererProtocol,
    registerRendererSchemePrivileges,
    registerMediaProtocol,
    registerMediaSchemePrivileges,
    installApplicationMenu,
    createMainWindow,
    setCaptureEnabled,
  };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("main entrypoint", () => {
  it("quits immediately when another instance already owns the SQLite lock", async () => {
    const harness = await loadIndex({ gotLock: false });

    expect(harness.app.quit).toHaveBeenCalledOnce();
    expect(harness.app.whenReady).not.toHaveBeenCalled();
    expect(harness.dbService.open).not.toHaveBeenCalled();
    expect(harness.registerMediaSchemePrivileges).toHaveBeenCalledOnce();
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
    expect(harness.dbService.open).toHaveBeenCalledWith("/data/app.sqlite", {
      migrationsDir: "/migrations",
      nativeBinding: "/native/better.node",
      assetsDir: "/data/assets",
      exportsDir: "/data/exports",
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
        paths: expect.objectContaining({ dbPath: "/data/app.sqlite", assetsDir: "/data/assets" }),
        migrationsDir: "/migrations",
        captureController: harness.captureController,
        runner: harness.jobRunner,
      }),
    );
    expect(harness.captureController.startIfEnabled).toHaveBeenCalledOnce();
    expect(harness.registerRendererProtocol).toHaveBeenCalledOnce();
    expect(harness.registerMediaProtocol).toHaveBeenCalledWith(harness.dbService, "/data/assets");
    expect(harness.installApplicationMenu).toHaveBeenCalledOnce();
    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined }),
    );

    harness.callbacks.get("will-quit")?.();

    expect(harness.captureController.stop).toHaveBeenCalledOnce();
    expect(harness.jobRunner.stop).toHaveBeenCalledOnce();
    expect(harness.disposeIpc).toHaveBeenCalledOnce();
    expect(harness.dbService.close).toHaveBeenCalledOnce();
  });

  it("never honors VITE_DEV_SERVER_URL in packaged mode", async () => {
    const harness = await loadIndex({
      gotLock: true,
      isPackaged: true,
      env: { VITE_DEV_SERVER_URL: "http://localhost:5173" },
    });

    expect(harness.registerRendererProtocol).toHaveBeenCalledOnce();
    expect(harness.createMainWindow).toHaveBeenCalledWith(
      expect.objectContaining({ devServerUrl: undefined }),
    );
  });
});
