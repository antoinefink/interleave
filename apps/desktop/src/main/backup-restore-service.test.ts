import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { seedDemoCollection } from "@interleave/testing";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
});
