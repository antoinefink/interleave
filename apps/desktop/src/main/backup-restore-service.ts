import fs from "node:fs";
import path from "node:path";
import { migrateDatabase, openDatabase } from "@interleave/db";
import Database from "better-sqlite3";
import { listBackupArtifacts, parseBackupTimestamp } from "./automatic-backup-service";
import {
  BACKUP_FORMAT_VERSION,
  type BackupCounts,
  type BackupManifest,
  compareSchemaVersions,
  latestSchemaVersion,
  resolveSchemaVersion,
  sha256File,
} from "./backup-manifest";
import { BackupService } from "./backup-service";
import type { DbService } from "./db-service";
import { type AppPaths, ensureVaultSkeleton } from "./paths";

export interface BackupArtifactSummary {
  readonly timestamp: string;
  readonly createdAt: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly schemaVersion: string;
  readonly automatic: boolean;
}

export interface RestoreBackupResult {
  readonly restored: true;
  readonly timestamp: string;
  readonly schemaVersion: string;
  readonly counts: BackupCounts;
  readonly restartRequired: true;
}

export interface ResetLocalDataResult {
  readonly reset: true;
  readonly counts: BackupCounts;
  readonly restartRequired: true;
}

export interface BackupRestoreServiceDeps {
  readonly dbService: DbService;
  readonly paths: AppPaths;
  readonly migrationsDir: string;
  readonly nativeBinding?: string | undefined;
  /** Stop local writers such as capture/job-runner before replacing the store. */
  readonly beforeReplaceLocalData?: () => void | Promise<void>;
}

interface VerifiedBackup {
  readonly timestamp: string;
  readonly backupDir: string;
  readonly manifest: BackupManifest;
}

const EMPTY_COUNTS: BackupCounts = {
  elements: 0,
  sources: 0,
  extracts: 0,
  cards: 0,
  assets: 0,
};

class LocalDataReplacementUnrecoverableError extends Error {
  override readonly name = "LocalDataReplacementUnrecoverableError";
}

export class BackupRestoreService {
  constructor(private readonly deps: BackupRestoreServiceDeps) {}

  listBackups(): BackupArtifactSummary[] {
    return listBackupArtifacts(this.deps.paths.backupsDir)
      .map((artifact) => {
        try {
          const manifest = readManifest(path.join(artifact.dirPath, "manifest.json"));
          return {
            timestamp: artifact.timestamp,
            createdAt: manifest.createdAt,
            sizeBytes: artifact.sizeBytes,
            fileCount: manifest.files.length,
            schemaVersion: manifest.schemaVersion,
            automatic: artifact.automatic,
          };
        } catch {
          return null;
        }
      })
      .filter((artifact): artifact is BackupArtifactSummary => artifact !== null);
  }

  restoreBackup(timestamp: string): Promise<RestoreBackupResult> {
    return BackupService.runSerialized(async () => {
      const verified = this.verifyBackup(timestamp);
      const stageDir = fs.mkdtempSync(path.join(this.deps.paths.dataDir, ".restore-stage-"));
      try {
        copyBackupToStage(verified.backupDir, verified.manifest, stageDir);
        this.deps.dbService.beginLocalDataReplacement();
        try {
          await this.deps.beforeReplaceLocalData?.();
          this.installStageWithRollback(stageDir);
          this.deps.dbService.completeLocalDataReplacement();
        } catch (error) {
          if (error instanceof LocalDataReplacementUnrecoverableError) {
            this.deps.dbService.completeLocalDataReplacement();
          } else {
            this.deps.dbService.abortLocalDataReplacement();
          }
          throw error;
        }
      } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
      return {
        restored: true,
        timestamp: verified.timestamp,
        schemaVersion: verified.manifest.schemaVersion,
        counts: verified.manifest.counts,
        restartRequired: true,
      };
    });
  }

  resetLocalData(): Promise<ResetLocalDataResult> {
    return BackupService.runSerialized(async () => {
      const stageDir = fs.mkdtempSync(path.join(this.deps.paths.dataDir, ".reset-stage-"));
      try {
        createEmptyStageStore(stageDir, this.deps);
        this.deps.dbService.beginLocalDataReplacement();
        try {
          await this.deps.beforeReplaceLocalData?.();
          this.installStageWithRollback(stageDir);
          this.deps.dbService.completeLocalDataReplacement();
        } catch (error) {
          if (error instanceof LocalDataReplacementUnrecoverableError) {
            this.deps.dbService.completeLocalDataReplacement();
          } else {
            this.deps.dbService.abortLocalDataReplacement();
          }
          throw error;
        }
      } finally {
        fs.rmSync(stageDir, { recursive: true, force: true });
      }
      return {
        reset: true,
        counts: EMPTY_COUNTS,
        restartRequired: true,
      };
    });
  }

  verifyBackup(timestamp: string): VerifiedBackup {
    const backupDir = resolveBackupDir(this.deps.paths.backupsDir, timestamp);
    const manifest = readManifest(path.join(backupDir, "manifest.json"));
    validateManifestForRestore(manifest, this.deps.migrationsDir);
    verifyManifestFiles(backupDir, manifest);
    verifySqliteFile(path.join(backupDir, "app.sqlite"), manifest, this.deps);
    return { timestamp, backupDir, manifest };
  }

  private installStageWithRollback(stageDir: string): void {
    const rollbackDir = fs.mkdtempSync(path.join(this.deps.paths.dataDir, ".restore-rollback-"));
    let rollbackStarted = false;
    let rollbackRestored = false;
    let installStarted = false;
    let installSucceeded = false;

    try {
      this.deps.dbService.close();
      rollbackStarted = true;
      moveCurrentStoreToRollback(this.deps.paths, rollbackDir);
      installStarted = true;
      installStage(this.deps.paths, stageDir);
      ensureVaultSkeleton(this.deps.paths);
      this.deps.dbService.reopen();
      installSucceeded = true;
    } catch (error) {
      this.deps.dbService.close();
      try {
        if (installStarted) {
          removeCurrentStore(this.deps.paths);
        }
        if (rollbackStarted && hasRollbackStore(rollbackDir)) {
          restoreRollback(this.deps.paths, rollbackDir);
          rollbackRestored = true;
        }
        ensureVaultSkeleton(this.deps.paths);
        this.deps.dbService.reopen();
      } catch (rollbackError) {
        const message = error instanceof Error ? error.message : String(error);
        const rollbackMessage =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new LocalDataReplacementUnrecoverableError(
          `backup restore: install failed (${message}); rollback failed (${rollbackMessage}); rollback preserved at ${rollbackDir}`,
        );
      }
      if (rollbackStarted && !rollbackRestored && hasRollbackStore(rollbackDir)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new LocalDataReplacementUnrecoverableError(
          `backup restore: install failed (${message}); rollback preserved at ${rollbackDir}`,
        );
      }
      throw error;
    } finally {
      if (installSucceeded || rollbackRestored || !hasRollbackStore(rollbackDir)) {
        fs.rmSync(rollbackDir, { recursive: true, force: true });
      }
    }
  }
}

function readManifest(manifestPath: string): BackupManifest {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  if (!isBackupManifest(raw)) {
    throw new Error("backup restore: invalid manifest.json");
  }
  return raw;
}

function isBackupManifest(value: unknown): value is BackupManifest {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<BackupManifest>;
  return (
    typeof v.formatVersion === "number" &&
    typeof v.schemaVersion === "string" &&
    typeof v.appVersion === "string" &&
    typeof v.createdAt === "string" &&
    Array.isArray(v.files) &&
    typeof v.assetVaultRoot === "string" &&
    !!v.counts &&
    typeof v.counts === "object"
  );
}

function validateManifestForRestore(manifest: BackupManifest, migrationsDir: string): void {
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`backup restore: unsupported format version ${manifest.formatVersion}`);
  }
  if (manifest.assetVaultRoot !== "assets") {
    throw new Error(`backup restore: unsupported asset root ${manifest.assetVaultRoot}`);
  }
  if (Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new Error("backup restore: invalid createdAt timestamp");
  }
  const installedSchema = latestSchemaVersion(migrationsDir);
  if (compareSchemaVersions(migrationsDir, manifest.schemaVersion, installedSchema) > 0) {
    throw new Error(
      `backup restore: backup schema ${manifest.schemaVersion} is newer than installed schema ${installedSchema}`,
    );
  }
}

function verifyManifestFiles(backupDir: string, manifest: BackupManifest): void {
  const seen = new Set<string>();
  const manifestPaths = manifest.files.map((entry) => entry.path).sort();
  if (!manifestPaths.includes("app.sqlite")) {
    throw new Error("backup restore: manifest is missing app.sqlite");
  }

  for (const entry of manifest.files) {
    if (seen.has(entry.path)) {
      throw new Error(`backup restore: duplicate manifest entry ${entry.path}`);
    }
    seen.add(entry.path);
    if (entry.path !== "app.sqlite" && !entry.path.startsWith(`${manifest.assetVaultRoot}/`)) {
      throw new Error(`backup restore: unsupported manifest path ${entry.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`backup restore: invalid sha256 for ${entry.path}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`backup restore: invalid size for ${entry.path}`);
    }
    const abs = safeJoin(backupDir, entry.path);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      throw new Error(`backup restore: missing manifest file ${entry.path}`);
    }
    if (!stat.isFile()) {
      throw new Error(`backup restore: manifest entry is not a file ${entry.path}`);
    }
    if (stat.size !== entry.size) {
      throw new Error(`backup restore: size mismatch for ${entry.path}`);
    }
    const actual = sha256File(abs);
    if (actual !== entry.sha256) {
      throw new Error(`backup restore: hash mismatch for ${entry.path}`);
    }
  }

  const actualPaths = listBackupEntriesRelative(backupDir)
    .filter((rel) => rel !== "manifest.json")
    .sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(manifestPaths)) {
    throw new Error("backup restore: manifest does not match backup directory contents");
  }
}

function listBackupEntriesRelative(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(dir, "");
  return out;
}

function verifySqliteFile(
  dbPath: string,
  manifest: BackupManifest,
  deps: BackupRestoreServiceDeps,
): void {
  const sqlite = openReadonlySqlite(dbPath, deps.nativeBinding);
  try {
    const integrity = sqlite.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("backup restore: SQLite integrity_check failed");
    }
    const fkRows = sqlite.pragma("foreign_key_check") as unknown[];
    if (fkRows.length > 0) {
      throw new Error("backup restore: SQLite foreign_key_check failed");
    }
    const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as
      | { n: number }
      | undefined;
    const actualSchema = resolveSchemaVersion(deps.migrationsDir, row?.n ?? 0);
    if (actualSchema !== manifest.schemaVersion) {
      throw new Error(
        `backup restore: manifest schema ${manifest.schemaVersion} does not match backup DB schema ${actualSchema}`,
      );
    }
  } finally {
    sqlite.close();
  }
}

function openReadonlySqlite(dbPath: string, nativeBinding?: string): Database.Database {
  return nativeBinding
    ? new Database(dbPath, { readonly: true, fileMustExist: true, nativeBinding })
    : new Database(dbPath, { readonly: true, fileMustExist: true });
}

function resolveBackupDir(backupsDir: string, timestamp: string): string {
  if (timestamp.includes("/") || timestamp.includes("\\") || timestamp.includes("..")) {
    throw new Error("backup restore: invalid backup timestamp");
  }
  const parseable = timestamp.startsWith("auto-") ? timestamp.slice("auto-".length) : timestamp;
  if (!parseBackupTimestamp(parseable)) {
    throw new Error("backup restore: invalid backup timestamp");
  }
  const backupDir = path.join(backupsDir, timestamp);
  if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) {
    throw new Error(`backup restore: backup ${timestamp} is not available`);
  }
  return backupDir;
}

function safeJoin(root: string, rel: string): string {
  if (path.isAbsolute(rel) || rel.includes("\\") || rel.length === 0) {
    throw new Error(`backup restore: unsafe path ${rel}`);
  }
  const parts = rel.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`backup restore: unsafe path ${rel}`);
  }
  const abs = path.join(root, ...parts);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error(`backup restore: unsafe path ${rel}`);
  }
  return abs;
}

function copyBackupToStage(backupDir: string, manifest: BackupManifest, stageDir: string): void {
  fs.copyFileSync(path.join(backupDir, "app.sqlite"), path.join(stageDir, "app.sqlite"));
  const backupAssetsDir = path.join(backupDir, manifest.assetVaultRoot);
  const stageAssetsDir = path.join(stageDir, "assets");
  if (fs.existsSync(backupAssetsDir)) {
    fs.cpSync(backupAssetsDir, stageAssetsDir, { recursive: true });
  } else {
    fs.mkdirSync(stageAssetsDir, { recursive: true });
  }
}

function createEmptyStageStore(stageDir: string, deps: BackupRestoreServiceDeps): void {
  const stageDbPath = path.join(stageDir, "app.sqlite");
  const stageAssetsDir = path.join(stageDir, "assets");
  fs.mkdirSync(path.join(stageAssetsDir, "sources"), { recursive: true });
  fs.mkdirSync(path.join(stageAssetsDir, "media"), { recursive: true });
  const handle = deps.nativeBinding
    ? openDatabase(stageDbPath, { nativeBinding: deps.nativeBinding })
    : openDatabase(stageDbPath);
  try {
    migrateDatabase(handle.db, {
      migrationsFolder: deps.migrationsDir,
      vecAvailable: false,
    });
    handle.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    handle.sqlite.close();
  }
  fs.rmSync(`${stageDbPath}-wal`, { force: true });
  fs.rmSync(`${stageDbPath}-shm`, { force: true });
}

function moveIfExists(from: string, to: string): void {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
}

function moveCurrentStoreToRollback(paths: AppPaths, rollbackDir: string): void {
  moveIfExists(paths.dbPath, path.join(rollbackDir, "app.sqlite"));
  moveIfExists(`${paths.dbPath}-wal`, path.join(rollbackDir, "app.sqlite-wal"));
  moveIfExists(`${paths.dbPath}-shm`, path.join(rollbackDir, "app.sqlite-shm"));
  moveIfExists(paths.assetsDir, path.join(rollbackDir, "assets"));
}

function restoreRollback(paths: AppPaths, rollbackDir: string): void {
  moveIfExists(path.join(rollbackDir, "app.sqlite"), paths.dbPath);
  moveIfExists(path.join(rollbackDir, "app.sqlite-wal"), `${paths.dbPath}-wal`);
  moveIfExists(path.join(rollbackDir, "app.sqlite-shm"), `${paths.dbPath}-shm`);
  moveIfExists(path.join(rollbackDir, "assets"), paths.assetsDir);
}

function hasRollbackStore(rollbackDir: string): boolean {
  return (
    fs.existsSync(path.join(rollbackDir, "app.sqlite")) ||
    fs.existsSync(path.join(rollbackDir, "app.sqlite-wal")) ||
    fs.existsSync(path.join(rollbackDir, "app.sqlite-shm")) ||
    fs.existsSync(path.join(rollbackDir, "assets"))
  );
}

function installStage(paths: AppPaths, stageDir: string): void {
  removeCurrentStore(paths);
  moveIfExists(path.join(stageDir, "app.sqlite"), paths.dbPath);
  moveIfExists(path.join(stageDir, "assets"), paths.assetsDir);
  fs.rmSync(`${paths.dbPath}-wal`, { force: true });
  fs.rmSync(`${paths.dbPath}-shm`, { force: true });
}

function removeCurrentStore(paths: AppPaths): void {
  fs.rmSync(paths.dbPath, { force: true });
  fs.rmSync(`${paths.dbPath}-wal`, { force: true });
  fs.rmSync(`${paths.dbPath}-shm`, { force: true });
  fs.rmSync(paths.assetsDir, { recursive: true, force: true });
}
