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
import { app, BrowserWindow } from "electron";
import { DbService } from "./db-service";
import { registerIpcHandlers } from "./ipc";
import { resolveMigrationsDir } from "./migrations";
import { resolveNativeBinding } from "./native-binding";
import { initAppPaths } from "./paths";
import { registerRendererProtocol, registerRendererSchemePrivileges } from "./renderer-protocol";
import { createMainWindow } from "./window";

/** Single DB service instance for the app's lifetime. */
const dbService = new DbService();
let disposeIpc: (() => void) | null = null;

/** The compiled-main directory (preload sits alongside the entry). */
const distDir = __dirname;
/** Built renderer location: apps/web/dist relative to apps/desktop/dist. */
const rendererDir = app.isPackaged
  ? // In a packaged app the renderer is copied next to the main bundle.
    path.join(distDir, "renderer")
  : path.resolve(distDir, "..", "..", "web", "dist");

/** Whether to load the Vite dev server (dev) vs the built renderer (prod). */
const devServerUrl = process.env.VITE_DEV_SERVER_URL || undefined;

function bootstrap(): void {
  // 1) App data dir + vault skeleton (idempotent).
  const paths = initAppPaths();

  // 2) Open SQLite (pragmas applied in @interleave/db) + run migrations. The
  //    Electron-ABI native binding is loaded explicitly so the shared Node-ABI
  //    package binary keeps serving tests/scripts.
  dbService.open(paths.dbPath, {
    migrationsDir: resolveMigrationsDir(distDir),
    nativeBinding: resolveNativeBinding(distDir),
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

  // 3) Validated IPC surface.
  disposeIpc = registerIpcHandlers(dbService);

  // 4) In production, serve the built renderer over the app:// protocol.
  if (!devServerUrl) {
    registerRendererProtocol(rendererDir);
  }

  // 5) Secure window.
  createMainWindow({ distDir, devServerUrl });
}

// The custom renderer scheme must be registered as privileged BEFORE ready.
if (!devServerUrl) {
  registerRendererSchemePrivileges();
}

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

  app.on("will-quit", () => {
    disposeIpc?.();
    dbService.close();
  });
}
