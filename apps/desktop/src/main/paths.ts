/**
 * App data directory + asset-vault layout (T007).
 *
 * The Electron main process is the **only** code that knows absolute on-disk
 * paths (the renderer never sees them — see the layering rules in CLAUDE.md).
 * This module resolves the per-OS app data directory and the canonical vault
 * skeleton:
 *
 *   <appData>/<app>/
 *     app.sqlite                (+ -wal / -shm siblings)
 *     assets/
 *       sources/
 *       media/
 *     exports/
 *     backups/
 *
 * On macOS `<appData>` is `~/Library/Application Support`. The directory is
 * overridable via `INTERLEAVE_DATA_DIR` so tests (and the Playwright restart
 * spec) can point at an isolated temp directory.
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/** Folder name under the OS app-data directory. */
const APP_DIR_NAME = "Interleave";

/** Absolute on-disk paths the main process manages. */
export interface AppPaths {
  /** The root app data directory, e.g. `~/Library/Application Support/Interleave`. */
  readonly dataDir: string;
  /** The native SQLite database file. */
  readonly dbPath: string;
  /** The asset vault root (`assets/`). */
  readonly assetsDir: string;
  /** Exports directory (`exports/`). */
  readonly exportsDir: string;
  /** Backups directory (`backups/`). */
  readonly backupsDir: string;
  /** Local embedding-model directory (`models/`, T087) — the worker resolves the model here. */
  readonly modelsDir: string;
}

/**
 * Resolve the app data directory. Honors `INTERLEAVE_DATA_DIR` ONLY in dev/test
 * (so the Playwright restart spec can point at an isolated temp dir); the PACKAGED
 * app always uses the real per-OS app-data directory and ignores the override
 * (T050 — a shipped build must not be redirectable by a stray env var).
 */
export function resolveDataDir(): string {
  const override = process.env.INTERLEAVE_DATA_DIR;
  if (!app.isPackaged && override && override.length > 0) {
    return path.resolve(override);
  }
  // `appData` is the OS-standard app-data root (Application Support on macOS,
  // %APPDATA% on Windows, ~/.config on Linux); we nest our own folder under it
  // so the layout matches docs/architecture.md exactly.
  return path.join(app.getPath("appData"), APP_DIR_NAME);
}

/** Compute every managed path from a data directory. */
export function computeAppPaths(dataDir: string): AppPaths {
  return {
    dataDir,
    dbPath: path.join(dataDir, "app.sqlite"),
    assetsDir: path.join(dataDir, "assets"),
    exportsDir: path.join(dataDir, "exports"),
    backupsDir: path.join(dataDir, "backups"),
    modelsDir: path.join(dataDir, "models"),
  };
}

/**
 * Create the app data directory + asset-vault skeleton if missing (idempotent).
 * Safe to call on every launch. Returns the resolved paths.
 */
export function ensureVaultSkeleton(paths: AppPaths): AppPaths {
  const dirs = [
    paths.dataDir,
    paths.assetsDir,
    path.join(paths.assetsDir, "sources"),
    path.join(paths.assetsDir, "media"),
    paths.exportsDir,
    paths.backupsDir,
    paths.modelsDir,
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/** Resolve + create the full app data layout in one call. */
export function initAppPaths(): AppPaths {
  return ensureVaultSkeleton(computeAppPaths(resolveDataDir()));
}
