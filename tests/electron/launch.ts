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
const webDir = path.join(repoRoot, "apps", "web");
const packagesDir = path.join(repoRoot, "packages");
const webDist = path.join(webDir, "dist", "index.html");
const mainBundle = path.join(desktopDir, "dist", "main.cjs");
const preloadBundle = path.join(desktopDir, "dist", "preload.cjs");

/**
 * The newest mtime (ms) of any `.ts`/`.tsx`/`.css` source under `roots`, or `0`
 * when none exists. Skips dist/node_modules so we only see real source. Used to
 * decide whether a built artifact is STALE — see {@link ensureBuilt}.
 */
function newestSourceMtime(roots: readonly string[]): number {
  let newest = 0;
  const skip = new Set(["dist", "node_modules", ".turbo"]);
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a missing dir contributes nothing
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(full);
      } else if (/\.(tsx?|css)$/.test(entry.name)) {
        const m = fs.statSync(full).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  for (const root of roots) walk(root);
  return newest;
}

/** True when `artifact` is missing OR older than the newest source under `roots`. */
function isStale(artifact: string, roots: readonly string[]): boolean {
  if (!fs.existsSync(artifact)) return true;
  return fs.statSync(artifact).mtimeMs < newestSourceMtime(roots);
}

/**
 * Build the renderer + desktop bundle when the artifacts are missing OR STALE.
 *
 * A plain existence check is not enough: the desktop E2E launches the BUILT
 * main.cjs + renderer dist, so if a source change (in the app src or any
 * workspace packages src they bundle) post-dates the last build, the suite would
 * silently exercise OLD code and "pass" against a bug that is already fixed in
 * source. We therefore rebuild whenever the newest relevant source out-dates the
 * artifact. Both builds are fast (esbuild bundle ~tens of ms; Vite renderer
 * sub-second), so the staleness scan is cheap insurance for correctness.
 */
export function ensureBuilt(): void {
  // The renderer bundles apps/web/src + the shared packages it imports.
  if (isStale(webDist, [path.join(webDir, "src"), packagesDir])) {
    execFileSync("pnpm", ["--filter", "@interleave/web", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
  // The main bundle compiles apps/desktop/src + the shared packages (db/core/
  // local-db/scheduler) it bundles into a self-contained main.cjs.
  const desktopStale =
    isStale(mainBundle, [path.join(desktopDir, "src"), packagesDir]) ||
    isStale(preloadBundle, [path.join(desktopDir, "src"), packagesDir]);
  if (desktopStale) {
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
  /**
   * Show the first-run onboarding overlay (T050). DEFAULTS to suppressed: the
   * existing feature specs start from a fresh, empty data dir, where the welcome
   * overlay would otherwise cover the UI. The dedicated onboarding spec passes
   * `{ showOnboarding: true }` to exercise the real first-run flow.
   */
  readonly showOnboarding?: boolean;
  /**
   * Permit URL import from a loopback host (T060). The URL-import E2E serves its
   * article fixture from a `127.0.0.1` HTTP server, which the SSRF guard normally
   * blocks; this sets `INTERLEAVE_ALLOW_LOOPBACK_IMPORT=1` (honored only in the
   * unpackaged E2E build) so the test can reach it. Defaults off.
   */
  readonly allowLoopbackImport?: boolean;
  /**
   * Enable the loopback capture server (T062) at launch. The server is OFF by
   * default (it is a network surface); this sets `INTERLEAVE_CAPTURE_ENABLED=1`
   * so the capture-server E2E can POST to it without first toggling it through the
   * UI. Mirrors the `seedOnEmpty` → `INTERLEAVE_SEED_ON_EMPTY` mapping.
   */
  readonly captureEnabled?: boolean;
  /**
   * Stub the native PDF file picker (T064) to return this absolute path, so the
   * PDF-import E2E can drive import deterministically without a real dialog. Sets
   * `INTERLEAVE_PDF_IMPORT_PATH` (honored only in the unpackaged build), mirroring
   * the `INTERLEAVE_ALLOW_LOOPBACK_IMPORT` escape. Defaults unset (a real picker).
   */
  readonly pdfImportPath?: string;
  /**
   * Stub the native EPUB file picker (T067) to return this absolute path, so the
   * EPUB-import E2E can drive import deterministically without a real dialog. Sets
   * `INTERLEAVE_EPUB_IMPORT_PATH` (honored only in the unpackaged build), mirroring
   * the `INTERLEAVE_PDF_IMPORT_PATH` escape. Defaults unset (a real picker).
   */
  readonly epubImportPath?: string;
  /**
   * Stub the native Markdown file picker (T068) to return this absolute path, so the
   * Markdown-import E2E can drive import deterministically without a real dialog. Sets
   * `INTERLEAVE_MARKDOWN_IMPORT_PATH` (honored only in the unpackaged build), mirroring
   * the `INTERLEAVE_EPUB_IMPORT_PATH` escape. Defaults unset (a real picker).
   */
  readonly markdownImportPath?: string;
  /**
   * Stub the native highlight-export file picker (T069) to return this absolute path,
   * so the highlight-import E2E can drive import deterministically without a real
   * dialog. Sets `INTERLEAVE_HIGHLIGHTS_IMPORT_PATH` (honored only in the unpackaged
   * build), mirroring the `INTERLEAVE_EPUB_IMPORT_PATH` escape. Defaults unset.
   */
  readonly highlightsImportPath?: string;
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
      ...(options.allowLoopbackImport ? { INTERLEAVE_ALLOW_LOOPBACK_IMPORT: "1" } : {}),
      ...(options.captureEnabled ? { INTERLEAVE_CAPTURE_ENABLED: "1" } : {}),
      ...(options.pdfImportPath ? { INTERLEAVE_PDF_IMPORT_PATH: options.pdfImportPath } : {}),
      ...(options.epubImportPath ? { INTERLEAVE_EPUB_IMPORT_PATH: options.epubImportPath } : {}),
      ...(options.markdownImportPath
        ? { INTERLEAVE_MARKDOWN_IMPORT_PATH: options.markdownImportPath }
        : {}),
      ...(options.highlightsImportPath
        ? { INTERLEAVE_HIGHLIGHTS_IMPORT_PATH: options.highlightsImportPath }
        : {}),
      // Suppress the first-run onboarding overlay unless a spec opts in, so it
      // never covers the UI in the feature specs (all start empty). See main/index.ts.
      ...(options.showOnboarding ? {} : { INTERLEAVE_SUPPRESS_ONBOARDING: "1" }),
      // Ensure production-mode renderer load (built files, not the dev server).
      VITE_DEV_SERVER_URL: "",
      NODE_ENV: "production",
    },
  });
}

export { mainBundle, preloadBundle, webDist };
