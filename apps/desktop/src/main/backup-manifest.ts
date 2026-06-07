/**
 * Backup manifest model + integrity helpers (T047).
 *
 * The manifest is the RESTORE CONTRACT: it describes a backup archive precisely
 * enough that a future restore (deferred to T055) can verify the archive and
 * reject one that is too new or corrupt, with NO knowledge of how it was written.
 * It is deliberately framework-free (no Electron, no DB) so it is pure + unit
 * testable; `BackupService` composes it with the live DB handle + filesystem.
 *
 * The `schemaVersion` is the latest applied Drizzle MIGRATION TAG (e.g.
 * `"0002_search_fts5"`), NOT a `schema_version` column (there is none) and NOT
 * `documents.schemaVersion` (an unrelated ProseMirror-doc field). The runtime
 * `__drizzle_migrations` table records HOW MANY migrations are applied (one row
 * per migration, ordered by `created_at`); the staged `drizzle/meta/_journal.json`
 * maps each migration index → its tag. Resolving the tag therefore combines the
 * two: count applied migrations from the runtime table, then index into the
 * journal entries (sorted by `idx`) — see {@link resolveSchemaVersion}.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The backup-format version. Bump when the layout/manifest shape changes. */
export const BACKUP_FORMAT_VERSION = 1 as const;

/** One file captured in a backup archive, with its integrity hash. */
export interface ManifestFileEntry {
  /** POSIX-style path WITHIN the archive (e.g. `app.sqlite`, `assets/sources/…`). */
  readonly path: string;
  /** Hex-encoded SHA-256 of the file's bytes (integrity check). */
  readonly sha256: string;
  /** Size in bytes. */
  readonly size: number;
}

/** A quick human sanity check of what the backup contains. */
export interface BackupCounts {
  readonly elements: number;
  readonly sources: number;
  readonly extracts: number;
  readonly cards: number;
  readonly assets: number;
}

/** The full `manifest.json` written alongside the captured files. */
export interface BackupManifest {
  /** The backup-format version (starts at `1`). */
  readonly formatVersion: number;
  /** The latest applied Drizzle migration tag (the "schema version"). */
  readonly schemaVersion: string;
  /** The app version that produced the backup. */
  readonly appVersion: string;
  /** ISO-8601 timestamp the backup was created at. */
  readonly createdAt: string;
  /** Every captured file with its SHA-256 + size (`app.sqlite` first, then assets). */
  readonly files: readonly ManifestFileEntry[];
  /** Element/source/extract/card/asset counts for a quick sanity check. */
  readonly counts: BackupCounts;
  /** The in-archive directory the asset vault was copied into (`"assets"`). */
  readonly assetVaultRoot: string;
}

/** Inputs to {@link buildBackupManifest} (everything except the format version). */
export interface BuildManifestInput {
  readonly schemaVersion: string;
  readonly appVersion: string;
  readonly createdAt: string;
  readonly files: readonly ManifestFileEntry[];
  readonly counts: BackupCounts;
  readonly assetVaultRoot: string;
}

/** Assemble a {@link BackupManifest} (pure — stamps the current format version). */
export function buildBackupManifest(input: BuildManifestInput): BackupManifest {
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: input.schemaVersion,
    appVersion: input.appVersion,
    createdAt: input.createdAt,
    files: input.files,
    counts: input.counts,
    assetVaultRoot: input.assetVaultRoot,
  };
}

/** Hex-encoded SHA-256 of a buffer (the integrity primitive). */
export function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Hex-encoded SHA-256 of a file's bytes on disk. */
export function sha256File(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

/** One entry in a Drizzle `_journal.json` (the parts we read). */
interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
}

function readJournalEntries(migrationsDir: string): JournalEntry[] {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  const raw = fs.readFileSync(journalPath, "utf8");
  const journal = JSON.parse(raw) as { entries?: JournalEntry[] };
  return [...(journal.entries ?? [])].sort((a, b) => a.idx - b.idx);
}

/**
 * Resolve the latest applied migration TAG from the runtime count of applied
 * migrations + the staged journal (`drizzle/meta/_journal.json`).
 *
 * `appliedCount` is the number of rows in `__drizzle_migrations` (the runtime
 * source of truth — Drizzle inserts one per applied migration). The journal lists
 * every generated migration with its `idx` + `tag`. The latest applied tag is the
 * journal entry at index `appliedCount - 1` (entries sorted by `idx`). Throws if
 * the journal is missing/empty or the count is out of range — a corrupt-state
 * signal we prefer over silently writing a wrong schema version into the manifest.
 */
export function resolveSchemaVersion(migrationsDir: string, appliedCount: number): string {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  const entries = readJournalEntries(migrationsDir);
  if (entries.length === 0) {
    throw new Error(`resolveSchemaVersion: no migration entries in ${journalPath}`);
  }
  if (appliedCount < 1 || appliedCount > entries.length) {
    throw new Error(
      `resolveSchemaVersion: applied migration count ${appliedCount} out of range ` +
        `(journal has ${entries.length} entries)`,
    );
  }
  const entry = entries[appliedCount - 1];
  if (!entry) {
    throw new Error(`resolveSchemaVersion: no journal entry at index ${appliedCount - 1}`);
  }
  return entry.tag;
}

/** Resolve the newest migration tag this installed app knows how to migrate to. */
export function latestSchemaVersion(migrationsDir: string): string {
  const journalPath = path.join(migrationsDir, "meta", "_journal.json");
  const entries = readJournalEntries(migrationsDir);
  const entry = entries.at(-1);
  if (!entry) {
    throw new Error(`latestSchemaVersion: no migration entries in ${journalPath}`);
  }
  return entry.tag;
}

/**
 * Compare two Drizzle migration tags by their order in the installed journal.
 * Returns a negative number when `left` is older than `right`, zero when equal,
 * and a positive number when `left` is newer. Unknown tags are corrupt/unsupported
 * restore signals and throw.
 */
export function compareSchemaVersions(migrationsDir: string, left: string, right: string): number {
  const entries = readJournalEntries(migrationsDir);
  const order = new Map(entries.map((entry, index) => [entry.tag, index]));
  const leftIndex = order.get(left);
  if (leftIndex === undefined) {
    throw new Error(`compareSchemaVersions: unknown schema version ${left}`);
  }
  const rightIndex = order.get(right);
  if (rightIndex === undefined) {
    throw new Error(`compareSchemaVersions: unknown schema version ${right}`);
  }
  return leftIndex - rightIndex;
}
