/**
 * App-paths tests (T007).
 *
 * Verifies the app data directory + asset-vault skeleton are computed and created
 * correctly. Electron's `app` is mocked because these tests run under Vitest
 * (no Electron runtime); the `INTERLEAVE_DATA_DIR` override path is the one the
 * Playwright restart spec also uses to isolate its data dir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Electron is not available under Vitest; stub the single import paths.ts uses.
vi.mock("electron", () => ({
  app: {
    // Dev/test posture: the INTERLEAVE_DATA_DIR override is honored only when NOT
    // packaged (T050). Tests run unpackaged, so the override path is exercised.
    isPackaged: false,
    getPath: (name: string) => path.join(os.tmpdir(), "interleave-electron-mock", name),
  },
}));

import {
  computeAppPaths,
  ensureVaultSkeleton,
  initAppPaths,
  resolveDataDir,
  resolveDownloadsDir,
} from "./paths";

let dir: string;
const prevOverride = process.env.INTERLEAVE_DATA_DIR;
const prevDownloadsOverride = process.env.INTERLEAVE_DOWNLOADS_DIR;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-paths-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevOverride === undefined) {
    delete process.env.INTERLEAVE_DATA_DIR;
  } else {
    process.env.INTERLEAVE_DATA_DIR = prevOverride;
  }
  if (prevDownloadsOverride === undefined) {
    delete process.env.INTERLEAVE_DOWNLOADS_DIR;
  } else {
    process.env.INTERLEAVE_DOWNLOADS_DIR = prevDownloadsOverride;
  }
});

describe("app paths", () => {
  it("computes the canonical DB + vault layout under the data dir", () => {
    const downloadsDir = path.join(os.tmpdir(), "interleave-downloads");
    const paths = computeAppPaths(dir, downloadsDir);
    expect(paths.dataDir).toBe(dir);
    expect(paths.dbPath).toBe(path.join(dir, "app.sqlite"));
    expect(paths.assetsDir).toBe(path.join(dir, "assets"));
    expect(paths.exportsDir).toBe(path.join(dir, "exports"));
    expect(paths.downloadsDir).toBe(downloadsDir);
    expect(paths.backupsDir).toBe(path.join(dir, "backups"));
    expect(paths.modelsDir).toBe(path.join(dir, "models"));
    expect(paths.logsDir).toBe(path.join(dir, "logs"));
  });

  it("creates the vault skeleton (idempotently)", () => {
    const paths = computeAppPaths(dir, path.join(dir, "..", "downloads-outside-vault"));
    ensureVaultSkeleton(paths);
    ensureVaultSkeleton(paths); // second call must not throw

    expect(fs.existsSync(paths.assetsDir)).toBe(true);
    expect(fs.existsSync(path.join(paths.assetsDir, "sources"))).toBe(true);
    expect(fs.existsSync(path.join(paths.assetsDir, "media"))).toBe(true);
    expect(fs.existsSync(paths.exportsDir)).toBe(true);
    expect(fs.existsSync(paths.downloadsDir)).toBe(false);
    expect(fs.existsSync(paths.backupsDir)).toBe(true);
    expect(fs.existsSync(paths.modelsDir)).toBe(true);
    expect(fs.existsSync(paths.logsDir)).toBe(true);
  });

  it("honors INTERLEAVE_DATA_DIR over the Electron app-data path", () => {
    process.env.INTERLEAVE_DATA_DIR = dir;
    expect(resolveDataDir()).toBe(path.resolve(dir));
  });

  it("falls back to the Electron app-data path when no override is set", () => {
    delete process.env.INTERLEAVE_DATA_DIR;
    const resolved = resolveDataDir();
    // Mocked appData root + our app folder name.
    expect(resolved).toBe(
      path.join(os.tmpdir(), "interleave-electron-mock", "appData", "Interleave"),
    );
  });

  it("resolves the Electron downloads path", () => {
    expect(resolveDownloadsDir()).toBe(
      path.join(os.tmpdir(), "interleave-electron-mock", "downloads"),
    );
  });

  it("honors INTERLEAVE_DOWNLOADS_DIR over the Electron downloads path in dev/test", () => {
    const downloads = path.join(dir, "downloads");
    process.env.INTERLEAVE_DOWNLOADS_DIR = downloads;
    expect(resolveDownloadsDir()).toBe(path.resolve(downloads));
  });

  it("initAppPaths resolves + creates in one call", () => {
    process.env.INTERLEAVE_DATA_DIR = dir;
    const paths = initAppPaths();
    expect(paths.dataDir).toBe(path.resolve(dir));
    expect(paths.downloadsDir).toBe(
      path.join(os.tmpdir(), "interleave-electron-mock", "downloads"),
    );
    expect(fs.existsSync(paths.dbPath)).toBe(false); // DB created by DbService, not here
    expect(fs.existsSync(paths.assetsDir)).toBe(true);
  });
});
