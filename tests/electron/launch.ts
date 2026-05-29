/**
 * Electron launch helpers for the desktop E2E (T007).
 *
 * Centralizes: ensuring the renderer + main bundle are built, allocating an
 * isolated app-data directory per run (via `INTERLEAVE_DATA_DIR`, so the test
 * never touches the developer's real Application Support data), and launching
 * the packaged main entry with `_electron.launch`. Reused by the spec for both
 * the initial launch and the post-restart relaunch (same data dir).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";

// Playwright transpiles specs as CommonJS (the repo has no root `"type"`), so
// `__dirname` is available here — avoid `import.meta.url`, which is ESM-only.
const repoRoot = path.resolve(__dirname, "..", "..");
const desktopDir = path.join(repoRoot, "apps", "desktop");
const webDist = path.join(repoRoot, "apps", "web", "dist", "index.html");
const mainBundle = path.join(desktopDir, "dist", "main.cjs");
const preloadBundle = path.join(desktopDir, "dist", "preload.cjs");

/** Build the renderer + desktop bundle if the artifacts are missing. */
export function ensureBuilt(): void {
  if (!fs.existsSync(webDist)) {
    execFileSync("pnpm", ["--filter", "@interleave/web", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  if (!fs.existsSync(mainBundle) || !fs.existsSync(preloadBundle)) {
    execFileSync("pnpm", ["--filter", "@interleave/desktop", "build:bundle"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
}

/** Create a fresh, isolated app-data directory for a test run. */
export function makeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "interleave-e2e-"));
}

/** Optional launch tweaks for a test run. */
export interface LaunchOptions {
  /** Seed the demo collection when the database is empty (T010 inspector E2E). */
  readonly seedOnEmpty?: boolean;
}

/**
 * Launch the built Electron app against `dataDir`. The renderer loads from the
 * built files (production mode) because no `VITE_DEV_SERVER_URL` is set. Pass
 * `{ seedOnEmpty: true }` to populate an empty DB with the shared demo
 * collection (used by the inspector E2E).
 */
export async function launchApp(
  dataDir: string,
  options: LaunchOptions = {},
): Promise<ElectronApplication> {
  return electron.launch({
    // Isolate Electron's own `userData` (caches + the single-instance
    // SingletonLock) per data dir, so back-to-back launches across spec files
    // never collide on the shared global lock.
    args: [`--user-data-dir=${path.join(dataDir, "chromium")}`, mainBundle],
    cwd: desktopDir,
    env: {
      ...process.env,
      INTERLEAVE_DATA_DIR: dataDir,
      ...(options.seedOnEmpty ? { INTERLEAVE_SEED_ON_EMPTY: "1" } : {}),
      // Ensure production-mode renderer load (built files, not the dev server).
      VITE_DEV_SERVER_URL: "",
      NODE_ENV: "production",
    },
  });
}

export { mainBundle, preloadBundle, webDist };
