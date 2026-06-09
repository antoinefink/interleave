import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { seedDemoCollection } from "@interleave/testing";
import Database from "better-sqlite3";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractBackupArchive } from "./backup-archive";
import * as backupManifest from "./backup-manifest";
import { resolveSchemaVersion } from "./backup-manifest";
import { BackupRestoreService } from "./backup-restore-service";
import { BackupService } from "./backup-service";
import { DbService } from "./db-service";
import { computeAppPaths, ensureVaultSkeleton } from "./paths";

let dataDir: string;
let svc: DbService;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-restore-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  svc?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function openSeeded() {
  const paths = ensureVaultSkeleton(computeAppPaths(dataDir));
  svc = new DbService();
  svc.open(paths.dbPath, {
    migrationsDir: MIGRATIONS_DIR,
    assetsDir: paths.assetsDir,
    exportDestinationDir: paths.downloadsDir,
  });
  seedDemoCollection(svc.repos, svc.raw.db);

  const sourceAssetDir = path.join(paths.assetsDir, "sources", "seed-source");
  fs.mkdirSync(sourceAssetDir, { recursive: true });
  fs.writeFileSync(path.join(sourceAssetDir, "snapshot.json"), '{"version":"backup"}');

  const backup = new BackupService({
    dbService: svc,
    paths,
    migrationsDir: MIGRATIONS_DIR,
    appVersion: "9.9.9",
  });
  const restore = new BackupRestoreService({
    dbService: svc,
    paths,
    migrationsDir: MIGRATIONS_DIR,
  });
  return { paths, backup, restore };
}

function rowCount(dbPath: string, table: string): number {
  const handle = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = handle.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  } finally {
    handle.close();
  }
}

function expectNoStaleSidecar(filePath: string, staleContent: string): void {
  if (!fs.existsSync(filePath)) return;
  expect(fs.readFileSync(filePath, "utf8")).not.toBe(staleContent);
}

/** Read a backup `.zip` produced by BackupService into a mutable fflate entry map. */
function readZipEntries(zipPath: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
}

/** Write an fflate entry map back out as a `.zip` at `zipPath`. */
function writeZip(zipPath: string, entries: Record<string, Uint8Array>): void {
  fs.writeFileSync(zipPath, Buffer.from(zipSync(entries)));
}

/** Count leftover restore temp dirs (extract + stage) under `dataDir`. */
function listRestoreTempDirs(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(".restore-extract-") || name.startsWith(".restore-stage-"));
}

describe("BackupRestoreService", () => {
  it("lists app-managed backup artifacts from the backups directory", async () => {
    const { backup, restore } = openSeeded();
    const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));

    const artifacts = restore.listBackups();

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      timestamp: result.timestamp,
      automatic: false,
      fileCount: result.fileCount,
      schemaVersion: result.schemaVersion,
    });
    expect(artifacts[0]?.createdAt).toBe("2026-06-07T10:00:00.000Z");
    expect(artifacts[0]?.sizeBytes).toBeGreaterThan(0);
  });

  it("restores the backed-up DB and assets, replacing later current data", async () => {
    const { paths, backup, restore } = openSeeded();
    const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
    const backedUpElements = rowCount(
      path.join(paths.backupsDir, result.timestamp, "app.sqlite"),
      "elements",
    );

    svc.importManualSource({ title: "After backup", body: "not in backup", priority: "C" });
    fs.writeFileSync(
      path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json"),
      '{"version":"current"}',
    );
    const extraAsset = path.join(paths.assetsDir, "sources", "current-only", "snapshot.json");
    fs.mkdirSync(path.dirname(extraAsset), { recursive: true });
    fs.writeFileSync(extraAsset, "{}");
    svc.close();
    const staleWal = "stale wal";
    const staleShm = "stale shm";
    fs.writeFileSync(`${paths.dbPath}-wal`, staleWal);
    fs.writeFileSync(`${paths.dbPath}-shm`, staleShm);

    const restored = await restore.restoreBackup(result.timestamp);

    expect(restored.restored).toBe(true);
    expect(restored.restartRequired).toBe(true);
    expect(rowCount(paths.dbPath, "elements")).toBe(backedUpElements);
    expect(
      fs.readFileSync(
        path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json"),
        "utf8",
      ),
    ).toBe('{"version":"backup"}');
    expect(fs.existsSync(extraAsset)).toBe(false);
    expectNoStaleSidecar(`${paths.dbPath}-wal`, staleWal);
    expectNoStaleSidecar(`${paths.dbPath}-shm`, staleShm);
    expect(svc.isOpen).toBe(true);
    expect(svc.isMigrated).toBe(true);
    expect(svc.localDataRestartRequired).toBe(true);
    expect(() => svc.getStatus()).toThrow(/restart Interleave/);
  });

  it("rejects a tampered backup before touching current data", async () => {
    const { paths, backup, restore } = openSeeded();
    const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
    const currentOnly = svc.importManualSource({
      title: "Current only",
      body: "must survive failed restore",
      priority: "B",
    });
    const currentCount = rowCount(paths.dbPath, "elements");

    fs.writeFileSync(
      path.join(
        paths.backupsDir,
        result.timestamp,
        "assets",
        "sources",
        "seed-source",
        "snapshot.json",
      ),
      '{"version":"tamper"}',
    );

    await expect(restore.restoreBackup(result.timestamp)).rejects.toThrow(/hash mismatch/);
    expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
    expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
    expect(svc.isOpen).toBe(true);
    expect(svc.localDataRestartRequired).toBe(false);
  });

  it("rejects a manifest schema that does not match the backup database", async () => {
    const { paths, backup, restore } = openSeeded();
    const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
    const currentOnly = svc.importManualSource({
      title: "Current only",
      body: "must survive failed restore",
      priority: "B",
    });
    const manifestPath = path.join(paths.backupsDir, result.timestamp, "manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      schemaVersion: string;
    };
    manifest.schemaVersion = resolveSchemaVersion(MIGRATIONS_DIR, 1);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(restore.restoreBackup(result.timestamp)).rejects.toThrow(/does not match/);
    expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
    expect(svc.localDataRestartRequired).toBe(false);
  });

  it("leaves current data untouched when staging the verified backup fails", async () => {
    const { paths, backup, restore } = openSeeded();
    const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
    const currentOnly = svc.importManualSource({
      title: "Current only",
      body: "must survive failed restore",
      priority: "B",
    });
    const currentCount = rowCount(paths.dbPath, "elements");
    const snapshotPath = path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json");
    const copyFile = fs.copyFileSync;
    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((from, to) => {
      if (
        String(from) === path.join(paths.backupsDir, result.timestamp, "app.sqlite") &&
        String(to).includes(".restore-stage-")
      ) {
        throw new Error("stage copy failed");
      }
      return copyFile(from, to);
    });

    await expect(restore.restoreBackup(result.timestamp)).rejects.toThrow("stage copy failed");

    copySpy.mockRestore();
    expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
    expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe('{"version":"backup"}');
    expect(svc.isOpen).toBe(true);
    expect(svc.localDataRestartRequired).toBe(false);
  });

  it("rolls back if moving the current store fails partway through install", async () => {
    const { paths, backup, restore } = openSeeded();
    const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
    const currentOnly = svc.importManualSource({
      title: "Current only",
      body: "must survive failed restore",
      priority: "B",
    });
    const currentCount = rowCount(paths.dbPath, "elements");
    const snapshotPath = path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json");
    fs.writeFileSync(snapshotPath, '{"version":"current"}');
    const rename = fs.renameSync;
    let renameCount = 0;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renameCount += 1;
      if (renameCount === 2) {
        throw new Error("rename failed");
      }
      return rename(from, to);
    });

    await expect(restore.restoreBackup(result.timestamp)).rejects.toThrow("rename failed");

    renameSpy.mockRestore();
    expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
    expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe('{"version":"current"}');
    expect(svc.isOpen).toBe(true);
    expect(svc.localDataRestartRequired).toBe(false);
  });

  it("rejects unmanifested symlinks in the backup directory before touching current data", async () => {
    if (process.platform === "win32") return;
    const { paths, backup, restore } = openSeeded();
    const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
    const currentOnly = svc.importManualSource({
      title: "Current only",
      body: "must survive failed restore",
      priority: "B",
    });
    const currentCount = rowCount(paths.dbPath, "elements");
    const symlinkPath = path.join(
      paths.backupsDir,
      result.timestamp,
      "assets",
      "sources",
      "seed-source",
      "escape-link",
    );
    fs.symlinkSync(path.join(paths.backupsDir, result.timestamp, "app.sqlite"), symlinkPath);

    await expect(restore.restoreBackup(result.timestamp)).rejects.toThrow(
      /manifest does not match/,
    );
    expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
    expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
    expect(svc.isOpen).toBe(true);
    expect(svc.localDataRestartRequired).toBe(false);
  });

  it("resets the local knowledge store while preserving backups, exports, and models", async () => {
    const { paths, backup, restore } = openSeeded();
    const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
    fs.mkdirSync(paths.exportsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.exportsDir, "keep.md"), "# keep");
    fs.mkdirSync(paths.modelsDir, { recursive: true });
    fs.writeFileSync(path.join(paths.modelsDir, "model.bin"), "model");
    svc.close();
    const staleWal = "stale wal";
    const staleShm = "stale shm";
    fs.writeFileSync(`${paths.dbPath}-wal`, staleWal);
    fs.writeFileSync(`${paths.dbPath}-shm`, staleShm);

    const reset = await restore.resetLocalData();

    expect(reset.reset).toBe(true);
    expect(reset.restartRequired).toBe(true);
    expect(reset.counts.elements).toBe(0);
    expect(rowCount(paths.dbPath, "elements")).toBe(0);
    expect(svc.localDataRestartRequired).toBe(true);
    expect(fs.existsSync(path.join(paths.assetsDir, "sources"))).toBe(true);
    expect(fs.existsSync(path.join(paths.assetsDir, "media"))).toBe(true);
    expect(fs.existsSync(path.join(paths.backupsDir, result.timestamp))).toBe(true);
    expect(fs.existsSync(path.join(paths.backupsDir, `${result.timestamp}.zip`))).toBe(true);
    expect(fs.existsSync(path.join(paths.exportsDir, "keep.md"))).toBe(true);
    expect(fs.existsSync(path.join(paths.modelsDir, "model.bin"))).toBe(true);
    expectNoStaleSidecar(`${paths.dbPath}-wal`, staleWal);
    expectNoStaleSidecar(`${paths.dbPath}-shm`, staleShm);
  });

  it("rolls back reset if the staged empty database cannot reopen", async () => {
    const { paths, restore } = openSeeded();
    const currentOnly = svc.importManualSource({
      title: "Current only",
      body: "must survive failed reset",
      priority: "B",
    });
    const currentCount = rowCount(paths.dbPath, "elements");
    const snapshotPath = path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json");
    fs.writeFileSync(snapshotPath, '{"version":"current"}');
    vi.spyOn(svc, "reopen").mockImplementationOnce(() => {
      throw new Error("reopen failed");
    });

    await expect(restore.resetLocalData()).rejects.toThrow("reopen failed");

    expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
    expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
    expect(fs.readFileSync(snapshotPath, "utf8")).toBe('{"version":"current"}');
    expect(svc.isOpen).toBe(true);
    expect(svc.localDataRestartRequired).toBe(false);
  });

  describe("restoreBackupFromArchive", () => {
    it("restores from a portable backup zip, swapping DB + assets and clearing WAL/SHM", async () => {
      const { paths, backup, restore } = openSeeded();
      const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
      const backedUpElements = rowCount(
        path.join(paths.backupsDir, result.timestamp, "app.sqlite"),
        "elements",
      );

      svc.importManualSource({ title: "After backup", body: "not in backup", priority: "C" });
      fs.writeFileSync(
        path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json"),
        '{"version":"current"}',
      );
      const extraAsset = path.join(paths.assetsDir, "sources", "current-only", "snapshot.json");
      fs.mkdirSync(path.dirname(extraAsset), { recursive: true });
      fs.writeFileSync(extraAsset, "{}");
      svc.close();
      const staleWal = "stale wal";
      const staleShm = "stale shm";
      fs.writeFileSync(`${paths.dbPath}-wal`, staleWal);
      fs.writeFileSync(`${paths.dbPath}-shm`, staleShm);

      const restored = await restore.restoreBackupFromArchive(result.path);

      expect(restored.restored).toBe(true);
      expect(restored.restartRequired).toBe(true);
      // No app-managed directory timestamp exists for a file restore, so the
      // result reports the backup's recorded ISO creation time (manifest.createdAt),
      // never the archive filename.
      const manifestCreatedAt = (
        JSON.parse(
          fs.readFileSync(path.join(paths.backupsDir, result.timestamp, "manifest.json"), "utf8"),
        ) as { createdAt: string }
      ).createdAt;
      expect(restored.timestamp).toBe(manifestCreatedAt);
      expect(restored.timestamp).toBe("2026-06-07T10:00:00.000Z");
      expect(restored.counts.elements).toBe(backedUpElements);
      expect(rowCount(paths.dbPath, "elements")).toBe(backedUpElements);
      expect(
        fs.readFileSync(
          path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json"),
          "utf8",
        ),
      ).toBe('{"version":"backup"}');
      expect(fs.existsSync(extraAsset)).toBe(false);
      expectNoStaleSidecar(`${paths.dbPath}-wal`, staleWal);
      expectNoStaleSidecar(`${paths.dbPath}-shm`, staleShm);
      expect(svc.isOpen).toBe(true);
      expect(svc.isMigrated).toBe(true);
      expect(svc.localDataRestartRequired).toBe(true);
      expect(listRestoreTempDirs(dataDir)).toEqual([]);
    });

    it("rejects a tampered archive before touching current data", async () => {
      const { paths, backup, restore } = openSeeded();
      const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
      const currentOnly = svc.importManualSource({
        title: "Current only",
        body: "must survive failed restore",
        priority: "B",
      });
      const currentCount = rowCount(paths.dbPath, "elements");
      const snapshotPath = path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json");

      // Tamper one entry's bytes so its on-disk SHA-256 no longer matches the manifest.
      const entries = readZipEntries(result.path);
      entries["assets/sources/seed-source/snapshot.json"] = strToU8('{"version":"tamper"}');
      const tamperedZip = path.join(dataDir, "tampered.zip");
      writeZip(tamperedZip, entries);

      await expect(restore.restoreBackupFromArchive(tamperedZip)).rejects.toThrow(/hash mismatch/);

      expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
      expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe('{"version":"backup"}');
      expect(svc.isOpen).toBe(true);
      expect(svc.localDataRestartRequired).toBe(false);
      expect(listRestoreTempDirs(dataDir)).toEqual([]);
    });

    it("rejects an archive missing a manifested file before touching current data", async () => {
      const { paths, backup, restore } = openSeeded();
      const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
      const currentCount = rowCount(paths.dbPath, "elements");

      const entries = readZipEntries(result.path);
      delete entries["assets/sources/seed-source/snapshot.json"];
      const brokenZip = path.join(dataDir, "missing-file.zip");
      writeZip(brokenZip, entries);

      await expect(restore.restoreBackupFromArchive(brokenZip)).rejects.toThrow();

      expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
      expect(svc.isOpen).toBe(true);
      expect(svc.localDataRestartRequired).toBe(false);
      expect(listRestoreTempDirs(dataDir)).toEqual([]);
    });

    it("rejects an archive whose schema is newer than installed before install", async () => {
      const { paths, backup, restore } = openSeeded();
      // The archive itself is intact and current-schema; we simulate it being
      // newer-than-installed by reporting an OLDER installed schema (as if a
      // future app produced this backup). This exercises the same
      // schema-not-newer guard in validateManifestForRestore both restore paths
      // share, before any install code runs.
      const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
      const currentCount = rowCount(paths.dbPath, "elements");
      const olderSchema = resolveSchemaVersion(MIGRATIONS_DIR, 1);
      vi.spyOn(backupManifest, "latestSchemaVersion").mockReturnValue(olderSchema);

      await expect(restore.restoreBackupFromArchive(result.path)).rejects.toThrow(/newer than/);

      expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
      expect(svc.isOpen).toBe(true);
      expect(svc.localDataRestartRequired).toBe(false);
      expect(listRestoreTempDirs(dataDir)).toEqual([]);
    });

    it("rejects a zip-slip archive before any install and leaves data intact", async () => {
      const { paths, restore } = openSeeded();
      const currentOnly = svc.importManualSource({
        title: "Current only",
        body: "must survive failed restore",
        priority: "B",
      });
      const currentCount = rowCount(paths.dbPath, "elements");

      const zipSlipZip = path.join(dataDir, "zip-slip.zip");
      writeZip(zipSlipZip, {
        "manifest.json": strToU8("{}"),
        "../escape.txt": strToU8("pwned"),
      });

      await expect(restore.restoreBackupFromArchive(zipSlipZip)).rejects.toThrow(
        /unsafe archive entry/,
      );

      expect(fs.existsSync(path.join(dataDir, "..", "escape.txt"))).toBe(false);
      expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
      expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
      expect(svc.isOpen).toBe(true);
      expect(svc.localDataRestartRequired).toBe(false);
      expect(listRestoreTempDirs(dataDir)).toEqual([]);
    });

    it("removes both temp dirs after a failed restore (staging failure)", async () => {
      const { backup, restore } = openSeeded();
      const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
      const copyFile = fs.copyFileSync;
      const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((from, to) => {
        if (String(from).endsWith("app.sqlite") && String(to).includes(".restore-stage-")) {
          throw new Error("stage copy failed");
        }
        return copyFile(from, to);
      });

      await expect(restore.restoreBackupFromArchive(result.path)).rejects.toThrow(
        "stage copy failed",
      );

      copySpy.mockRestore();
      expect(listRestoreTempDirs(dataDir)).toEqual([]);
      expect(svc.isOpen).toBe(true);
      expect(svc.localDataRestartRequired).toBe(false);
    });

    it("rejects a non-zip junk file without touching data or leaking temp dirs", async () => {
      const { paths, restore } = openSeeded();
      const currentOnly = svc.importManualSource({
        title: "Current only",
        body: "must survive failed restore",
        priority: "B",
      });
      const currentCount = rowCount(paths.dbPath, "elements");
      const snapshotPath = path.join(paths.assetsDir, "sources", "seed-source", "snapshot.json");

      // Random bytes that are not a valid zip central directory.
      const junkZip = path.join(dataDir, "junk.zip");
      fs.writeFileSync(junkZip, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]));

      await expect(restore.restoreBackupFromArchive(junkZip)).rejects.toThrow(
        /could not read archive/,
      );

      expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
      expect(svc.getInspectorData(currentOnly.id).data?.element.title).toBe("Current only");
      expect(fs.readFileSync(snapshotPath, "utf8")).toBe('{"version":"backup"}');
      expect(svc.isOpen).toBe(true);
      expect(svc.localDataRestartRequired).toBe(false);
      expect(listRestoreTempDirs(dataDir)).toEqual([]);
    });

    it("rejects an archive with an unmanifested extra entry without touching current data", async () => {
      const { paths, backup, restore } = openSeeded();
      const result = await backup.createBackup(new Date("2026-06-07T10:00:00.000Z"));
      const currentCount = rowCount(paths.dbPath, "elements");

      // An attacker appends an extra entry not listed in the manifest. The
      // directory-vs-manifest reconciliation must reject it before any install.
      const entries = readZipEntries(result.path);
      entries["assets/sources/seed-source/extra-injected.txt"] = strToU8("not in manifest");
      const extraEntryZip = path.join(dataDir, "extra-entry.zip");
      writeZip(extraEntryZip, entries);

      await expect(restore.restoreBackupFromArchive(extraEntryZip)).rejects.toThrow(
        /manifest does not match/,
      );

      expect(rowCount(paths.dbPath, "elements")).toBe(currentCount);
      expect(svc.isOpen).toBe(true);
      expect(svc.localDataRestartRequired).toBe(false);
      expect(listRestoreTempDirs(dataDir)).toEqual([]);
    });

    it("writes archive entries as regular files, never symlinks that could escape", () => {
      // fflate cannot emit a real symlink entry, so we lock in the guarantee at
      // the extraction layer: an entry whose BYTES look like a path target is
      // still written as a plain file inside destDir — it never becomes a symlink
      // and never escapes the extraction root.
      const extractDir = fs.mkdtempSync(path.join(dataDir, ".restore-extract-test-"));
      const zipPath = path.join(dataDir, "symlink-shaped.zip");
      const escapeTarget = path.join(dataDir, "..", "escape-target.txt");
      writeZip(zipPath, {
        "assets/sources/seed-source/link": strToU8(escapeTarget),
      });

      extractBackupArchive(zipPath, extractDir);

      const written = path.join(extractDir, "assets", "sources", "seed-source", "link");
      const stat = fs.lstatSync(written);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      // The bytes are stored verbatim; nothing was resolved/followed to escape.
      expect(fs.readFileSync(written, "utf8")).toBe(escapeTarget);
      expect(fs.existsSync(path.join(dataDir, "..", "escape-target.txt"))).toBe(false);

      fs.rmSync(extractDir, { recursive: true, force: true });
    });
  });
});
