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
import { createHash } from "node:crypto";
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
const buildLockPath = path.join(
  os.tmpdir(),
  `interleave-e2e-build-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 16)}.lock`,
);
const buildLockOwnerFile = path.join(buildLockPath, "owner.json");
const buildLockPollMs = 100;
const buildLockTimeoutMs = 30 * 60 * 1000;
const staleBuildLockMs = 2 * 60 * 1000;
const buildStepTimeoutMs = 5 * 60 * 1000;

interface BuildLock {
  readonly token: string;
}

interface BuildLockOwner {
  readonly pid?: number;
  readonly token?: string;
  readonly createdAt?: string;
}

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

function needsBuild(): boolean {
  const rendererStale = isStale(webDist, [path.join(webDir, "src"), packagesDir]);
  const desktopStale =
    isStale(mainBundle, [path.join(desktopDir, "src"), packagesDir]) ||
    isStale(preloadBundle, [path.join(desktopDir, "src"), packagesDir]);
  return rendererStale || desktopStale;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readBuildLockOwner(): BuildLockOwner | null {
  try {
    return JSON.parse(fs.readFileSync(buildLockOwnerFile, "utf8")) as BuildLockOwner;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isLockStale(now: number): boolean {
  const owner = readBuildLockOwner();
  if (owner?.pid) return !isPidAlive(owner.pid);

  try {
    const stat = fs.statSync(buildLockPath);
    return now - stat.mtimeMs > staleBuildLockMs;
  } catch {
    return false;
  }
}

function isBuildLockPresent(): boolean {
  return fs.existsSync(buildLockPath);
}

function stealStaleBuildLock(): void {
  const stalePath = `${buildLockPath}.stale-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  try {
    fs.renameSync(buildLockPath, stalePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
    throw error;
  }
  fs.rmSync(stalePath, { force: true, recursive: true });
}

function tryAcquireBuildLock(): BuildLock | undefined {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.mkdirSync(buildLockPath);
    fs.writeFileSync(
      buildLockOwnerFile,
      JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
    );
    return { token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }
}

function acquireBuildLock(): BuildLock {
  const startedAt = Date.now();
  while (true) {
    const lock = tryAcquireBuildLock();
    if (lock) return lock;

    const now = Date.now();
    if (isLockStale(now)) {
      stealStaleBuildLock();
      continue;
    }
    if (now - startedAt > buildLockTimeoutMs) {
      throw new Error(
        `Timed out waiting for Electron E2E build lock after ${Math.round(
          buildLockTimeoutMs / 1000,
        )}s: ${buildLockPath}`,
      );
    }
    sleepSync(buildLockPollMs);
  }
}

function releaseBuildLock(lock: BuildLock): void {
  try {
    const owner = JSON.parse(fs.readFileSync(buildLockOwnerFile, "utf8")) as { token?: string };
    if (owner.token !== lock.token) return;
  } catch {
    return;
  }
  fs.rmSync(buildLockPath, { force: true, recursive: true });
}

function runBuildsIfStale(): void {
  // The renderer bundles apps/web/src + the shared packages it imports.
  if (isStale(webDist, [path.join(webDir, "src"), packagesDir])) {
    execFileSync("pnpm", ["--filter", "@interleave/web", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
      timeout: buildStepTimeoutMs,
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
      timeout: buildStepTimeoutMs,
    });
  }
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
  if (!needsBuild() && !isBuildLockPresent()) return;

  const lock = acquireBuildLock();
  try {
    // Another Playwright worker may have produced fresh artifacts while we were
    // waiting. Re-check under the cross-process lock to avoid concurrent
    // build:bundle runs deleting/copying apps/desktop/dist at the same time.
    runBuildsIfStale();
  } finally {
    releaseBuildLock(lock);
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
   * Seed the T099 MAINTENANCE fixture when the database is empty (a duplicate source
   * pair, a sourceless card, a broken source, a low-priority stale source) so the
   * Maintenance E2E has deterministic dead weight. Sets `INTERLEAVE_SEED_MAINTENANCE=1`.
   */
  readonly seedMaintenance?: boolean;
  /**
   * Seed the T100 CI-bounded SCALE collection (a few thousand elements via the bulk
   * fast path) when the database is empty, so the `scale-smoke` E2E can verify
   * backup/restore + integrity + the MVP flow after restart at scale. Sets
   * `INTERLEAVE_SEED_SCALE=1`.
   */
  readonly seedScale?: boolean;
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
  /**
   * Stub the native Anki `.apkg` file picker (T070) to return this absolute path, so the
   * Anki-import E2E can drive import deterministically without a real dialog. Sets
   * `INTERLEAVE_ANKI_IMPORT_PATH` (honored only in the unpackaged build), mirroring the
   * `INTERLEAVE_EPUB_IMPORT_PATH` escape. Defaults unset (a real picker).
   */
  readonly ankiImportPath?: string;
  /**
   * Stub the native MEDIA file picker (T073) to return this absolute path, so the
   * media-import E2E can drive import deterministically without a real dialog. Sets
   * `INTERLEAVE_MEDIA_IMPORT_PATH` (honored only in the unpackaged build), mirroring the
   * `INTERLEAVE_EPUB_IMPORT_PATH` escape. Defaults unset (a real picker).
   */
  readonly mediaImportPath?: string;
  /**
   * Stub the native SUBTITLES (sidecar) picker (T073) to return this absolute path, so
   * the media-import E2E can attach a transcript deterministically. Sets
   * `INTERLEAVE_SUBTITLES_PATH` (honored only in the unpackaged build). Defaults unset
   * (the second picker is cancelled → a transcript-less import).
   */
  readonly subtitlesPath?: string;
  /**
   * Inject the DETERMINISTIC FAKE AI provider (T093) so the AI-distillation E2E runs
   * the full flow with NO live model / network. Sets `INTERLEAVE_AI_FAKE=1` (honored
   * only in the unpackaged build by the worker's provider factory). Defaults off.
   */
  readonly aiFake?: boolean;
  /**
   * Allow automatic rolling backups during this spec. Defaults off for E2E so
   * unrelated fresh launches do not spend I/O creating backup archives; backup
   * specs opt in to exercise the production-default behavior.
   */
  readonly automaticBackups?: boolean;
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
  const downloadsDir = path.join(dataDir, "downloads");
  return electron.launch({
    // Isolate Electron's own `userData` (caches + the single-instance
    // SingletonLock) per data dir, so back-to-back launches across spec files
    // never collide on the shared global lock.
    args: [`--user-data-dir=${path.join(dataDir, "chromium")}`, mainBundle],
    cwd: desktopDir,
    env: {
      ...process.env,
      INTERLEAVE_DATA_DIR: dataDir,
      INTERLEAVE_DOWNLOADS_DIR: downloadsDir,
      ...(options.seedOnEmpty ? { INTERLEAVE_SEED_ON_EMPTY: "1" } : {}),
      ...(options.seedMaintenance ? { INTERLEAVE_SEED_MAINTENANCE: "1" } : {}),
      ...(options.seedScale ? { INTERLEAVE_SEED_SCALE: "1" } : {}),
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
      ...(options.ankiImportPath ? { INTERLEAVE_ANKI_IMPORT_PATH: options.ankiImportPath } : {}),
      ...(options.mediaImportPath ? { INTERLEAVE_MEDIA_IMPORT_PATH: options.mediaImportPath } : {}),
      ...(options.subtitlesPath ? { INTERLEAVE_SUBTITLES_PATH: options.subtitlesPath } : {}),
      // Inject the DETERMINISTIC FAKE AI provider (T093) so the AI-distillation E2E
      // exercises the full flow with NO live model / network. Honored only in the
      // unpackaged build by the worker's provider factory.
      ...(options.aiFake ? { INTERLEAVE_AI_FAKE: "1" } : {}),
      ...(options.automaticBackups ? {} : { INTERLEAVE_DISABLE_AUTOMATIC_BACKUPS: "1" }),
      // Suppress the first-run onboarding overlay unless a spec opts in, so it
      // never covers the UI in the feature specs (all start empty). See main/index.ts.
      ...(options.showOnboarding ? {} : { INTERLEAVE_SUPPRESS_ONBOARDING: "1" }),
      // Local Electron E2E launches should be automation-visible but user-invisible:
      // no Dock spam and no foreground windows during the full suite.
      INTERLEAVE_E2E_QUIET: "1",
      // Ensure production-mode renderer load (built files, not the dev server).
      VITE_DEV_SERVER_URL: "",
      NODE_ENV: "production",
    },
  });
}

export { mainBundle, preloadBundle, webDist };
