/**
 * Electron main entry (T007).
 *
 * Owns the desktop app's lifecycle and all trusted local capabilities:
 *   1. resolve + create the app data directory and asset-vault skeleton,
 *   2. open the native SQLite database (with the mandatory pragmas) and run the
 *      Drizzle migrations on startup,
 *   3. register the validated IPC handlers for the narrow `window.appApi`,
 *   4. serve the built renderer over the `app://` protocol (production) and
 *      create the secure, sandboxed window (Vite dev server in dev).
 *
 * The renderer never touches SQLite or the filesystem — it reaches everything
 * here through the preload bridge.
 */

import path from "node:path";
import type { ElementId } from "@interleave/core";
import { app, BrowserWindow } from "electron";
import { IPC_CHANNELS } from "../shared/channels";
import { AutomaticBackupService } from "./automatic-backup-service";
import { CaptureController } from "./capture-controller";
import { setCaptureEnabled } from "./capture-pairing";
import type { CaptureOpenSourceInput, CaptureOpenSourceResult } from "./capture-server";
import { DbService } from "./db-service";
import { embedJobSecrets } from "./embedding-service";
import { registerIpcHandlers } from "./ipc";
import { createJobApplyHandlers } from "./job-apply-handlers";
import { JobRunner } from "./job-runner";
import { registerMediaProtocol, registerMediaSchemePrivileges } from "./media-protocol";
import { installApplicationMenu } from "./menu";
import { resolveMigrationsDir } from "./migrations";
import { resolveNativeBinding } from "./native-binding";
import { initAppPaths } from "./paths";
import {
  RENDERER_URL,
  registerRendererProtocol,
  registerRendererSchemePrivileges,
} from "./renderer-protocol";
import { resolveSqliteVecBinary } from "./sqlite-vec-binding";
import { createMainWindow } from "./window";

/** Single DB service instance for the app's lifetime. */
const dbService = new DbService();
let disposeIpc: (() => void) | null = null;
/** The live loopback capture controller (T062), held for the will-quit stop. */
let captureController: CaptureController | null = null;
/** The on-device background job runner (T058), held for the will-quit stop. */
let jobRunner: JobRunner | null = null;
/** The main-side rolling backup scheduler, held for the will-quit stop. */
let automaticBackupService: AutomaticBackupService | null = null;

/** The compiled-main directory (preload sits alongside the entry). */
const distDir = __dirname;
/** Built renderer location: apps/web/dist relative to apps/desktop/dist. */
const rendererDir = app.isPackaged
  ? // In a packaged app the renderer is copied next to the main bundle.
    path.join(distDir, "renderer")
  : path.resolve(distDir, "..", "..", "web", "dist");

/**
 * Whether to load the Vite dev server (dev) vs the built renderer (prod). The
 * PACKAGED app NEVER honours `VITE_DEV_SERVER_URL` (T050 — a shipped build must
 * load the offline `app://` renderer, not localhost, even if the env var leaks in);
 * dev/test (`electron .` / the Playwright harness) still drive it via the env var.
 */
const devServerUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL || undefined;

function rendererRouteUrl(routePath: string): string {
  const base = (devServerUrl ?? RENDERER_URL).replace(/\/+$/, "");
  const pathPart = routePath.replace(/^\/+/, "");
  return `${base}/${pathPart}`;
}

function focusWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function openSourceReader(sourceId: string): Promise<void> {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (win) {
    focusWindow(win);
    if (!win.webContents.isLoadingMainFrame()) {
      win.webContents.send(IPC_CHANNELS.sourcesOpenReader, sourceId);
      return;
    }
    await win.loadURL(rendererRouteUrl(`/source/${encodeURIComponent(sourceId)}`));
    return;
  }

  const created = createMainWindow({ distDir, devServerUrl });
  focusWindow(created);
  await created.loadURL(rendererRouteUrl(`/source/${encodeURIComponent(sourceId)}`));
}

async function openCapturedSource(input: CaptureOpenSourceInput): Promise<CaptureOpenSourceResult> {
  const id = input.id as ElementId;
  const element = dbService.repos.elements.findById(id);
  if (!element || element.deletedAt || element.type !== "source") {
    return { status: "not_found" };
  }

  let activated = false;
  if (input.activate && element.status === "inbox") {
    dbService.triageInboxItem({ id, action: { kind: "accept" } });
    activated = true;
  }

  await openSourceReader(input.id);
  return { status: "opened", activated };
}

function bootstrap(): void {
  // 1) App data dir + vault skeleton (idempotent).
  const paths = initAppPaths();

  // 2) Open SQLite (pragmas applied in @interleave/db) + run migrations. The
  //    Electron-ABI native binding is loaded explicitly so the shared Node-ABI
  //    package binary keeps serving tests/scripts.
  const migrationsDir = resolveMigrationsDir(distDir);
  const nativeBinding = resolveNativeBinding(distDir);
  dbService.open(paths.dbPath, {
    migrationsDir,
    nativeBinding,
    // The vault asset-root the URL-import service (T060) writes snapshots into;
    // injected once at open() so the IPC handler never threads a path per-call.
    assetsDir: paths.assetsDir,
    // The exports-root the Markdown-export service (T068) writes `.md` files into.
    exportsDir: paths.exportsDir,
    // The packaged `sqlite-vec` `vec0` binary (T087), asar-unpacked like the
    // better-sqlite3 addon. Undefined in dev → the npm package resolves the host
    // binary; a load failure / non-functional vec0 degrades cleanly to FTS-only.
    vecBinaryPath: resolveSqliteVecBinary(distDir),
    // DEV/E2E-only SSRF-guard escape: the URL-import E2E serves its article
    // fixture from a 127.0.0.1 server (the guard normally blocks loopback). Honor
    // INTERLEAVE_ALLOW_LOOPBACK_IMPORT ONLY in an unpackaged build, mirroring the
    // INTERLEAVE_DATA_DIR override discipline — a shipped app always blocks it.
    allowLoopbackImport: !app.isPackaged && process.env.INTERLEAVE_ALLOW_LOOPBACK_IMPORT === "1",
  });

  // 2b) Dev/E2E convenience: seed an empty database with the shared demo
  //     collection so the inspector (T010) has realistic lineage to show.
  //     Opt-in via INTERLEAVE_SEED_ON_EMPTY; never seeds a non-empty DB, so a
  //     real user collection is untouched and production launches do not seed.
  if (process.env.INTERLEAVE_SEED_ON_EMPTY === "1") {
    try {
      const seeded = dbService.seedIfEmpty();
      if (seeded) console.log("[main] seeded empty database with the demo collection");
    } catch (error) {
      console.error("[main] seed-on-empty failed:", error);
    }
  }

  // 2b') Dev/E2E convenience: seed an empty database with the T099 MAINTENANCE
  //      fixture (a duplicate source pair, a sourceless card, a broken source, and a
  //      low-priority stale source) so the Maintenance E2E has deterministic dead
  //      weight. Opt-in via INTERLEAVE_SEED_MAINTENANCE; never seeds a non-empty DB.
  if (process.env.INTERLEAVE_SEED_MAINTENANCE === "1") {
    try {
      const planted = dbService.seedMaintenanceIfEmpty();
      if (planted) console.log("[main] seeded maintenance fixture", planted.brokenSnapshotRelPath);
    } catch (error) {
      console.error("[main] seed-maintenance failed:", error);
    }
  }

  // 2b'') Dev/E2E convenience: seed an empty database with the T100 CI-bounded SCALE
  //       collection (a few thousand elements via the bulk fast path) so the
  //       `scale-smoke` E2E can verify backup/restore + integrity + the MVP flow after
  //       restart at scale. Opt-in via INTERLEAVE_SEED_SCALE; never seeds a non-empty
  //       DB (so a restart never re-seeds), and production never seeds.
  if (process.env.INTERLEAVE_SEED_SCALE === "1") {
    try {
      const stats = dbService.seedScaleIfEmpty();
      if (stats)
        console.log(
          `[main] seeded scale collection: ${stats.cards} cards, ${stats.extracts} extracts, ${stats.reviewLogs} logs`,
        );
    } catch (error) {
      console.error("[main] seed-scale failed:", error);
    }
  }

  // 2c) E2E convenience: pre-set the "seen onboarding" flag so the first-run
  //     welcome overlay (T050) does not cover the UI in the existing feature
  //     specs (which all start from a fresh, empty data dir). Opt-in via
  //     INTERLEAVE_SUPPRESS_ONBOARDING; the dedicated onboarding spec leaves it
  //     unset to exercise the real first-run flow. Never affects production.
  if (process.env.INTERLEAVE_SUPPRESS_ONBOARDING === "1") {
    try {
      dbService.updateSetting("ui.seenOnboarding", true);
    } catch (error) {
      console.error("[main] suppress-onboarding failed:", error);
    }
  }

  // 2d) Browser-capture (T062): the loopback capture server is OFF by default
  //     (it is a network surface). The Electron integration test opts it on via
  //     INTERLEAVE_CAPTURE_ENABLED, mirroring the INTERLEAVE_SEED_ON_EMPTY pattern.
  //     Set the flag FIRST (before the start gate below reads it) so the server
  //     actually starts in the test. Never affects production.
  if (process.env.INTERLEAVE_CAPTURE_ENABLED === "1") {
    try {
      setCaptureEnabled(dbService.repos.settings, true);
    } catch (error) {
      console.error("[main] capture-enabled env override failed:", error);
    }
  }

  // 3) Validated IPC surface. The backup command (T047) needs the absolute app-data
  //    paths + the migrations folder (its journal maps to the schema-version tag).
  //    The capture controller (T062) is the single source of truth for the live
  //    loopback server + the `capture.*` settings; the `capture.*` IPC commands
  //    route through it.
  captureController = new CaptureController({
    settings: dbService.repos.settings,
    // The SAME shared M12 import service the renderer IPC importUrl path uses, so
    // a live-started capture server and the renderer converge on one instance.
    getImportService: () => dbService.urlImportService,
    openSource: openCapturedSource,
    appVersion: app.getVersion(),
  });

  // 3b) The on-device background job runner (T058). It OWNS an Electron
  //     utilityProcess worker (bundled as `dist/job-worker.cjs`, resolved next to
  //     the compiled main — same distDir discipline as the renderer/preload) and
  //     the job-type apply handlers bound to the open DB. `start()` recovers any
  //     job left `running` by a crash (re-queue or terminal-fail) then drains the
  //     persisted queue. The renderer's `sources.importUrl` enqueues a `url_import`
  //     job; the worker fetches OFF-MAIN; MAIN applies via the shared import
  //     service (the single SQLite writer stays main-owned).
  jobRunner = new JobRunner({
    jobsRepo: dbService.repos.jobs,
    applyHandlers: createJobApplyHandlers({
      getUrlImportService: () => dbService.urlImportService,
      // The asset-vault scaling service (T059) backs the `vault_verify`/`vault_gc`
      // job types so a large-vault hash/walk runs OFF-MAIN on the runner.
      getAssetVaultService: () => dbService.assetVaultService,
      // The OCR apply (T066) persists the worker's recognized text into the
      // `ocr_pages` layer + the durable vault json, through the open DB.
      getOcrService: () => dbService.ocrService,
      // The embed apply (T087) UPSERTs the worker's vector into the sqlite-vec
      // store (index path) or recovers a query vector (transient query path).
      getEmbeddingService: () => dbService.embeddingService,
      // The ai apply (T093) persists the worker's suggestion into the `ai_suggestions`
      // draft layer (no op-log; never schedules a card).
      getAiService: () => dbService.aiService,
    }),
    workerPath: path.join(distDir, "job-worker.cjs"),
    // The vault root the OCR worker resolves its page-image path against (T066),
    // passed via the worker's env (never a persisted job payload).
    assetsDir: paths.assetsDir,
    // The model dir the embed worker (T087) resolves a real ONNX model from, via
    // the same fork-env seam (`INTERLEAVE_MODEL_DIR`). The AI worker (T093) reuses this
    // root as `INTERLEAVE_AI_MODEL_DIR` for the local instruction model.
    modelDir: paths.modelsDir,
    // The AI fork-env seam (T093): the user's OWN AI key + provider kind are baked into
    // the single long-lived worker AT CONSTRUCTION when AI is enabled (the worker has no
    // per-job env channel). They are read main-side from settings here and NEVER written
    // to a persisted `jobs` row. Changing the key/enable later calls `restartWorker()`
    // (gated on idle) so the new env takes effect.
    ...(() => {
      const s = dbService.repos.settings.getAppSettings();
      return s.aiEnabled && s.aiApiKey
        ? { aiApiKey: s.aiApiKey, aiProviderKind: s.aiProviderKind }
        : { aiProviderKind: s.aiProviderKind };
    })(),
    // Out-of-band secret seam (T087): the user's embedding-API key is read LIVE
    // from settings and merged into the `embed` worker payload AT POST TIME — it is
    // NEVER written to the persisted `jobs` row (the same secret-keeping discipline
    // as the fork-env paths above).
    getJobSecrets: (job) => embedJobSecrets(job, () => dbService.repos.settings.getAppSettings()),
  });
  // Hand the runner to the DB service so the OCR command path (T066) can enqueue
  // an `ocr` job (the apply handler reaches the OCR service the other direction).
  dbService.setRunner(jobRunner);
  jobRunner.start();

  disposeIpc = registerIpcHandlers(dbService, {
    paths,
    migrationsDir,
    nativeBinding,
    captureController,
    runner: jobRunner,
  });

  // 3c) Automatic local rolling backups. This is a main-process lifecycle service:
  // it owns the timer, calls the canonical BackupService, and prunes ONLY
  // automatic artifacts under backups/. E2E can disable it for unrelated specs so
  // a fresh launch does not spend I/O on backup archives unless the spec opts in.
  if (process.env.INTERLEAVE_DISABLE_AUTOMATIC_BACKUPS !== "1") {
    automaticBackupService = new AutomaticBackupService({
      dbService,
      paths,
      migrationsDir,
      appVersion: app.getVersion(),
      logger: console,
    });
    automaticBackupService.start();
  }

  // Start the capture server ONLY if `capture.enabled` (default off). Bind the
  // socket FIRST, then persist the port, then mark running (all inside the
  // controller). Fire-and-forget — a bind failure must not crash bootstrap.
  void captureController.startIfEnabled().catch((error) => {
    console.error("[main] capture server failed to start:", error);
  });

  // 4) In production, serve the built renderer over the app:// protocol.
  if (!devServerUrl) {
    registerRendererProtocol(rendererDir);
  }

  // 4b) The privileged `media://` protocol (T073) — streams a LOCAL media source's
  //     vault bytes to the reader's `<video>`/`<audio>` with HTTP Range support, in
  //     BOTH dev and production (a video reader needs it under the Vite dev server too).
  registerMediaProtocol(dbService, paths.assetsDir);

  // 5) Native application menu (T048) — standard macOS menu + Edit clipboard roles
  //    (so the editor chords work) + Help → "Keyboard shortcuts" (⌘/) opening the
  //    in-app cheat sheet via a one-way main → renderer event.
  installApplicationMenu();

  // 6) Secure window.
  createMainWindow({ distDir, devServerUrl });
}

// The custom renderer scheme must be registered as privileged BEFORE ready.
if (!devServerUrl) {
  registerRendererSchemePrivileges();
}
// The `media://` scheme (T073) must ALSO be registered as privileged before ready —
// in dev AND production (a video reader streams from it under the Vite dev server too).
registerMediaSchemePrivileges();

// Enforce a single instance so two processes never open the same SQLite file.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app
    .whenReady()
    .then(bootstrap)
    .catch((error) => {
      console.error("[main] bootstrap failed:", error);
      app.quit();
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({ distDir, devServerUrl });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("will-quit", async () => {
    // Stop the loopback capture server (T062) before closing the DB. Fire-and-
    // forget the async close — the process is exiting and the socket is local.
    void captureController?.stop();
    // Stop the background runner (T058) BEFORE closing the DB so no apply handler
    // writes to a closed connection. The persisted queue is left intact — pending
    // jobs resume on the next launch. Mirrors the capture-controller stop ordering.
    jobRunner?.stop();
    await automaticBackupService?.stop();
    disposeIpc?.();
    dbService.close();
  });
}
