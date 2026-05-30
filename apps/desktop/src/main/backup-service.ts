/**
 * BackupService (T047) — Electron-main-only backup/export of the canonical local
 * store.
 *
 * A backup is a COPY of the canonical store, never a JSON re-serialization of the
 * domain:
 *   - the native SQLite database (`app.sqlite`), snapshotted CONSISTENTLY with
 *     better-sqlite3's online `db.backup()` API so un-checkpointed WAL pages are
 *     included without disturbing the live connection, and
 *   - the filesystem asset vault (`assets/`), copied byte-for-byte.
 *
 * It writes a deterministic, restore-ready layout under `backups/<timestamp>/`:
 *
 *   backups/<timestamp>/
 *     app.sqlite
 *     assets/…                 (recursive copy of the vault)
 *     manifest.json            (the restore contract — see below)
 *   backups/<timestamp>.zip    (the portable artifact = the directory zipped)
 *
 * The unzipped `backups/<timestamp>/` directory is the CANONICAL structure
 * (matching CLAUDE.md's asset-vault layout); the `.zip` is the portable artifact
 * the result reports. Backup logic lives in the MAIN process — it needs absolute
 * paths + the live DB handle — and is never reachable from the renderer except
 * through the typed `backups.create` command, which returns only the final path
 * string (no raw filesystem access crosses the IPC boundary).
 *
 * ## Restore (deferred to T055)
 *
 * Restore itself is NOT built here, but the format is designed so it is mechanical.
 * A future one-way restore-onto-a-fresh-install (M11/T055) consumes this archive as
 * follows:
 *   1. Unzip the archive and read `manifest.json`.
 *   2. Verify `formatVersion` is understood (reject an unknown/newer format).
 *   3. Verify `schemaVersion` is NOT NEWER than the installed Drizzle migration tag
 *      (reject a backup from a newer app — the installed schema cannot represent it;
 *      a backup OLDER than the installed schema is fine: migrations run forward).
 *   4. Verify every entry in `files[]` exists and its on-disk SHA-256 matches the
 *      recorded `sha256` (reject a corrupt/tampered archive before touching data).
 *   5. Copy `app.sqlite` into a FRESH app data directory's `dbPath`.
 *   6. Copy `assets/` (rooted at `assetVaultRoot`) into the vault.
 *   7. Open the DB and run migrations FORWARD if the backup's schema is older.
 * The manifest's `counts` give a quick human sanity check pre/post restore.
 */

import fs from "node:fs";
import path from "node:path";
import { ZipFile } from "yazl";
import {
  type BackupManifest,
  buildBackupManifest,
  type ManifestFileEntry,
  sha256File,
} from "./backup-manifest";
import type { DbService } from "./db-service";
import type { AppPaths } from "./paths";

/** What {@link BackupService.createBackup} returns to the IPC handler. */
export interface BackupResult {
  /** Absolute path to the produced `.zip` archive. */
  readonly path: string;
  /** The filesystem-safe timestamp the backup directory/archive is named with. */
  readonly timestamp: string;
  /** Total size of the `.zip` archive in bytes. */
  readonly sizeBytes: number;
  /** Number of files captured (`app.sqlite` + every asset file). */
  readonly fileCount: number;
  /** The captured schema version — the latest applied Drizzle migration tag. */
  readonly schemaVersion: string;
}

/** Inputs the service needs to package a backup. */
export interface BackupServiceDeps {
  /** The live DB service (for the online `db.backup()` snapshot + manifest counts). */
  readonly dbService: DbService;
  /** The resolved app-data paths (`dbPath`, `assetsDir`, `backupsDir`). */
  readonly paths: AppPaths;
  /** The Drizzle migrations folder (its `_journal.json` maps idx → migration tag). */
  readonly migrationsDir: string;
  /** The running app version (`app.getVersion()`), recorded in the manifest. */
  readonly appVersion: string;
}

/**
 * Make a filesystem-safe, sortable timestamp for the backup directory/archive
 * name, e.g. `2026-05-30T12-30-00-000Z` (ISO with `:`/`.` replaced by `-`).
 */
export function backupTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Recursively list every file under `dir` as POSIX-style paths RELATIVE to
 * `dir`, in a deterministic (sorted) order. Used to copy + hash the asset vault.
 * Returns `[]` when `dir` does not exist.
 */
export function listFilesRelative(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    // Sort for a deterministic manifest/zip ordering.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(dir, "");
  return out;
}

export class BackupService {
  constructor(private readonly deps: BackupServiceDeps) {}

  /**
   * Capture a full backup of the canonical store and return the produced archive.
   * Synchronous-by-design until the zip step (better-sqlite3 + fs are sync); the
   * final zip is awaited. Throws if the DB is not open.
   */
  async createBackup(now: Date = new Date()): Promise<BackupResult> {
    const { paths } = this.deps;
    // A unique, filesystem-safe timestamp directory. If two backups land in the
    // same millisecond, disambiguate with a numeric suffix so `VACUUM INTO` (which
    // requires a non-existent target) never collides.
    const baseTimestamp = backupTimestamp(now);
    let timestamp = baseTimestamp;
    let suffix = 1;
    while (
      fs.existsSync(path.join(paths.backupsDir, timestamp)) ||
      fs.existsSync(path.join(paths.backupsDir, `${timestamp}.zip`))
    ) {
      timestamp = `${baseTimestamp}-${suffix}`;
      suffix += 1;
    }
    const backupDir = path.join(paths.backupsDir, timestamp);
    fs.mkdirSync(backupDir, { recursive: true });

    // 1) Consistent SQLite snapshot via the online backup API (includes WAL).
    const snapshotDbPath = path.join(backupDir, "app.sqlite");
    this.deps.dbService.backupDatabaseTo(snapshotDbPath);

    // 2) Copy the asset vault recursively into <timestamp>/assets/.
    const ASSET_VAULT_ROOT = "assets";
    const destAssetsDir = path.join(backupDir, ASSET_VAULT_ROOT);
    const assetRelPaths = listFilesRelative(paths.assetsDir);
    for (const rel of assetRelPaths) {
      const from = path.join(paths.assetsDir, ...rel.split("/"));
      const to = path.join(destAssetsDir, ...rel.split("/"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }

    // 3) Hash every captured file (app.sqlite + each asset) for the manifest.
    //    Hashes are recomputed from the COPIED bytes on disk (authoritative for
    //    integrity), not read from `assets.contentHash` — a copy could differ from
    //    the recorded metadata, and the manifest must describe the archive itself.
    const files: ManifestFileEntry[] = [];
    const dbStat = fs.statSync(snapshotDbPath);
    files.push({ path: "app.sqlite", sha256: sha256File(snapshotDbPath), size: dbStat.size });
    for (const rel of assetRelPaths) {
      const abs = path.join(destAssetsDir, ...rel.split("/"));
      const stat = fs.statSync(abs);
      files.push({
        path: `${ASSET_VAULT_ROOT}/${rel}`,
        sha256: sha256File(abs),
        size: stat.size,
      });
    }

    // 4) Write manifest.json — the restore contract (version + hashes + counts).
    const manifest: BackupManifest = buildBackupManifest({
      schemaVersion: this.deps.dbService.getSchemaVersion(this.deps.migrationsDir),
      appVersion: this.deps.appVersion,
      createdAt: now.toISOString(),
      files,
      counts: this.deps.dbService.getBackupCounts(),
      assetVaultRoot: ASSET_VAULT_ROOT,
    });
    const manifestPath = path.join(backupDir, "manifest.json");
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // 5) Zip the <timestamp>/ directory into <timestamp>.zip. The manifest is added
    //    first, then app.sqlite, then the assets in deterministic order, so the
    //    archive is reproducible.
    const zipPath = path.join(paths.backupsDir, `${timestamp}.zip`);
    await zipDirectory(backupDir, zipPath, manifest);
    const zipStat = fs.statSync(zipPath);

    return {
      path: zipPath,
      timestamp,
      sizeBytes: zipStat.size,
      fileCount: files.length,
      schemaVersion: manifest.schemaVersion,
    };
  }
}

/**
 * Zip the backup directory into `zipPath` deterministically: `manifest.json`
 * first, then each manifest file entry in order (so `app.sqlite` precedes the
 * sorted assets). Uses yazl (pure-JS, no native build) so it bundles into the
 * main process. The promise resolves once the output stream is fully flushed.
 */
function zipDirectory(backupDir: string, zipPath: string, manifest: BackupManifest): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const out = fs.createWriteStream(zipPath);
    out.on("close", () => resolve());
    out.on("error", reject);
    zip.outputStream.on("error", reject);
    zip.outputStream.pipe(out);

    // Manifest first (the entry a reader looks for before anything else).
    zip.addFile(path.join(backupDir, "manifest.json"), "manifest.json");
    // Then every captured file, in the manifest's deterministic order.
    for (const entry of manifest.files) {
      const abs = path.join(backupDir, ...entry.path.split("/"));
      zip.addFile(abs, entry.path);
    }
    zip.end();
  });
}
