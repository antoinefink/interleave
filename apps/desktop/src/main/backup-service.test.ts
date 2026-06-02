/**
 * BackupService tests (T047) — the Electron-main backup packager.
 *
 * Drives the REAL `DbService` against an on-disk SQLite file under a temp
 * `INTERLEAVE_DATA_DIR`-shaped layout, seeds the shared demo collection, writes a
 * couple of real asset files into the vault, then runs `createBackup` and asserts:
 *   - a `backups/<timestamp>/` directory + a sibling `.zip` are created;
 *   - the `.zip` unzips to `app.sqlite` + `assets/…` + `manifest.json`;
 *   - the opened-from-backup `app.sqlite` has the SAME row counts as the source
 *     (the WAL-consistency guarantee `VACUUM INTO` provides);
 *   - the manifest carries the right `schemaVersion` (latest migration tag),
 *     `appVersion`, `createdAt`, and a `sha256`+`size` per file matching a
 *     recomputed hash;
 *   - tampering with a copied file makes its recorded hash mismatch.
 *
 * No Electron is involved — `BackupService` takes its deps explicitly (the DB
 * service, the resolved paths, the migrations dir, the app version), so it tests
 * standalone with the real pure-JS yazl packaging.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR, openDatabase } from "@interleave/db";
import { seedDemoCollection } from "@interleave/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackupService, listFilesRelative } from "./backup-service";
import { DbService } from "./db-service";
import { computeAppPaths, ensureVaultSkeleton } from "./paths";

let dataDir: string;
let svc: DbService;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-backup-"));
});

afterEach(() => {
  svc?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Resolve the temp paths the same way the main process would, then open + seed. */
function openSeeded(): { paths: ReturnType<typeof computeAppPaths>; service: BackupService } {
  const paths = ensureVaultSkeleton(computeAppPaths(dataDir));
  svc = new DbService();
  svc.open(paths.dbPath, { migrationsDir: MIGRATIONS_DIR });
  seedDemoCollection(svc.repos, svc.raw.db);

  // Write a couple of real asset files into the vault so the recursive copy +
  // per-file hashing have something to capture (the demo seed only writes asset
  // METADATA, not bytes).
  const sourceAssetDir = path.join(paths.assetsDir, "sources", "seed-source");
  fs.mkdirSync(sourceAssetDir, { recursive: true });
  fs.writeFileSync(path.join(sourceAssetDir, "snapshot.json"), '{"hello":"world"}');
  const mediaDir = path.join(paths.assetsDir, "media", "seed-media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "original.bin"), Buffer.from([1, 2, 3, 4, 5]));

  const service = new BackupService({
    dbService: svc,
    paths,
    migrationsDir: MIGRATIONS_DIR,
    appVersion: "9.9.9",
  });
  return { paths, service };
}

/** Count rows in a table of a SQLite file opened read-only-ish via the factory. */
function rowCount(dbPath: string, table: string): number {
  const handle = openDatabase(dbPath);
  try {
    const row = handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } finally {
    handle.sqlite.close();
  }
}

describe("listFilesRelative (T047)", () => {
  it("lists files recursively as sorted POSIX-relative paths; [] for a missing dir", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-walk-"));
    fs.mkdirSync(path.join(root, "b", "c"), { recursive: true });
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.writeFileSync(path.join(root, "b", "z.txt"), "z");
    fs.writeFileSync(path.join(root, "b", "c", "y.txt"), "y");
    try {
      expect(listFilesRelative(root)).toEqual(["a.txt", "b/c/y.txt", "b/z.txt"]);
      expect(listFilesRelative(path.join(root, "does-not-exist"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BackupService.createBackup (T047)", () => {
  it("produces a timestamped dir + zip with app.sqlite, assets, and a manifest", async () => {
    const { paths, service } = openSeeded();
    const sourceElementCount = rowCount(paths.dbPath, "elements");

    const result = await service.createBackup();

    // The .zip exists, the unzipped dir exists, and the result is well-formed.
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.path.endsWith(".zip")).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.schemaVersion).toBe("0014_remarkable_yellow_claw");
    // app.sqlite + 2 asset files = 3 captured files.
    expect(result.fileCount).toBe(3);

    const backupDir = path.join(paths.backupsDir, result.timestamp);
    expect(fs.existsSync(path.join(backupDir, "app.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, "manifest.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(backupDir, "assets", "sources", "seed-source", "snapshot.json")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(backupDir, "assets", "media", "seed-media", "original.bin")),
    ).toBe(true);

    // Unzip the portable archive with the SYSTEM unzip (proves it is a standard,
    // tool-readable zip) and assert the same layout is inside.
    const unzipDir = path.join(dataDir, "unzipped");
    fs.mkdirSync(unzipDir, { recursive: true });
    execFileSync("unzip", ["-q", result.path, "-d", unzipDir]);
    expect(fs.existsSync(path.join(unzipDir, "app.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(unzipDir, "manifest.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(unzipDir, "assets", "sources", "seed-source", "snapshot.json")),
    ).toBe(true);

    // The opened-from-backup DB has the SAME element row count as the source (the
    // WAL-consistency check — VACUUM INTO snapshots a coherent point in time).
    expect(rowCount(path.join(unzipDir, "app.sqlite"), "elements")).toBe(sourceElementCount);
    expect(sourceElementCount).toBeGreaterThan(0);
  });

  it("writes a manifest with the right metadata + a verifiable sha256 per file", async () => {
    const { paths, service } = openSeeded();
    const result = await service.createBackup();
    const backupDir = path.join(paths.backupsDir, result.timestamp);

    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.schemaVersion).toBe("0014_remarkable_yellow_claw");
    expect(manifest.appVersion).toBe("9.9.9");
    expect(typeof manifest.createdAt).toBe("string");
    expect(Number.isNaN(Date.parse(manifest.createdAt))).toBe(false);
    expect(manifest.assetVaultRoot).toBe("assets");

    // Counts are a sanity check; the seed has ≥1 source/extract/card.
    expect(manifest.counts.elements).toBeGreaterThan(0);
    expect(manifest.counts.sources).toBeGreaterThan(0);
    expect(manifest.counts.extracts).toBeGreaterThan(0);
    expect(manifest.counts.cards).toBeGreaterThan(0);

    // The first file is app.sqlite; every recorded hash + size matches the bytes.
    expect(manifest.files[0].path).toBe("app.sqlite");
    for (const entry of manifest.files) {
      const abs = path.join(backupDir, ...entry.path.split("/"));
      const bytes = fs.readFileSync(abs);
      const recomputed = crypto.createHash("sha256").update(bytes).digest("hex");
      expect(entry.sha256).toBe(recomputed);
      expect(entry.size).toBe(bytes.length);
    }
  });

  it("detects integrity tampering: a modified file no longer matches its hash", async () => {
    const { paths, service } = openSeeded();
    const result = await service.createBackup();
    const backupDir = path.join(paths.backupsDir, result.timestamp);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));

    const assetEntry = manifest.files.find((f: { path: string }) =>
      f.path.endsWith("snapshot.json"),
    );
    expect(assetEntry).toBeDefined();
    const assetAbs = path.join(backupDir, ...assetEntry.path.split("/"));
    fs.writeFileSync(assetAbs, '{"hello":"TAMPERED"}');
    const tamperedHash = crypto
      .createHash("sha256")
      .update(fs.readFileSync(assetAbs))
      .digest("hex");
    expect(tamperedHash).not.toBe(assetEntry.sha256);
  });

  it("a second backup produces a distinct timestamped archive", async () => {
    const { service } = openSeeded();
    const first = await service.createBackup(new Date("2026-05-30T10:00:00.000Z"));
    const second = await service.createBackup(new Date("2026-05-30T11:00:00.000Z"));
    expect(first.timestamp).not.toBe(second.timestamp);
    expect(first.path).not.toBe(second.path);
    expect(fs.existsSync(first.path)).toBe(true);
    expect(fs.existsSync(second.path)).toBe(true);
  });
});
