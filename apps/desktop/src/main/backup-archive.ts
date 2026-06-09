/**
 * Backup-archive extraction helper — PURE + framework-free (no Electron, no DB).
 *
 * Restore-from-file ingests an UNTRUSTED `.zip` the user picked on disk (moved
 * from another machine, recovered from external storage, or an old archive the
 * retention policy already pruned). The archive could be malformed or hostile,
 * so this helper is the FIRST line of defence: it validates every entry name
 * against zip-slip BEFORE writing anything that could escape `destDir`, and
 * surfaces a clear error on a non-zip / truncated buffer instead of swallowing
 * it. Verification of the extracted contents (manifest / hashes / SQLite
 * integrity) happens downstream in `backup-restore-service.ts`.
 *
 * It deliberately depends only on `node:fs`, `node:path`, and `fflate`
 * (pure-JS, already proven in `@interleave/importers`), mirroring the
 * pure-helper style of `backup-manifest.ts` so it is trivially unit-testable.
 */

import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { safeContainedJoin } from "./safe-archive-path";

/**
 * Maximum compressed size (8 GiB) of a backup `.zip` we will read into memory.
 * DoS backstop only: a real backup is tens of MB, so this never rejects a
 * realistic archive, but it stops us from reading an absurdly large untrusted
 * file off disk before we even try to decompress it.
 */
export const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Maximum CUMULATIVE uncompressed size (16 GiB) across all entries of a backup
 * `.zip`. DoS backstop only against a decompression ("zip") bomb: a small
 * hostile archive can otherwise expand to fill memory/disk. Enforced via the
 * unzip `filter` BEFORE any entry is decompressed, so the bomb never expands.
 * Generous enough to never reject a realistic backup, finite enough to stop a
 * bomb.
 */
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 16 * 1024 * 1024 * 1024;

/**
 * Validate an archive entry path against zip-slip and resolve it to an absolute
 * path that is GUARANTEED to stay inside `destDir`. Delegates to the shared
 * {@link safeContainedJoin} guard (reject absolute paths, backslashes, empty
 * names, and any `/`-split segment that is empty / `.` / `..`, then re-check
 * containment). Throws `backup restore: unsafe archive entry <path>` on any
 * violation BEFORE the caller writes a single byte.
 */
export function assertSafeArchiveEntry(destDir: string, entryPath: string): string {
  return safeContainedJoin(destDir, entryPath, "backup restore: unsafe archive entry");
}

/**
 * Extract a backup `.zip` into `destDir`. The archive is UNTRUSTED, so before
 * reading anything this rejects an archive whose compressed size exceeds
 * `maxArchiveBytes` and, via the unzip `filter`, rejects one whose cumulative
 * uncompressed size would exceed `maxTotalUncompressedBytes` BEFORE decompressing
 * (a decompression-bomb backstop). It then parses with `fflate.unzipSync` and,
 * for each non-directory entry, validates the path with
 * {@link assertSafeArchiveEntry} before creating parent dirs and writing the
 * bytes. Directory entries (a trailing `/`) are skipped — their files still
 * extract because each file entry recreates its own parent chain. A truncated /
 * non-zip buffer surfaces as a descriptive Error rather than being swallowed.
 *
 * `limits` lets callers (and tests) inject tiny caps; unset caps fall back to
 * {@link MAX_ARCHIVE_BYTES} / {@link MAX_TOTAL_UNCOMPRESSED_BYTES}.
 */
export function extractBackupArchive(
  zipPath: string,
  destDir: string,
  limits: { maxArchiveBytes?: number; maxTotalUncompressedBytes?: number } = {},
): void {
  const maxArchiveBytes = limits.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
  const maxTotalUncompressedBytes =
    limits.maxTotalUncompressedBytes ?? MAX_TOTAL_UNCOMPRESSED_BYTES;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(zipPath);
  } catch (cause) {
    throw new Error("backup restore: could not read archive file", { cause });
  }
  if (stat.size > maxArchiveBytes) {
    throw new Error(`backup restore: archive too large (${stat.size} bytes)`);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(zipPath));
  } catch (cause) {
    throw new Error("backup restore: could not read archive file", { cause });
  }

  let totalUncompressed = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        // `originalSize` is the UNCOMPRESSED size; `size` is compressed.
        totalUncompressed += file.originalSize;
        if (totalUncompressed > maxTotalUncompressedBytes) {
          throw new Error(
            `backup restore: archive expands too large (> ${maxTotalUncompressedBytes} bytes uncompressed)`,
          );
        }
        return true;
      },
    });
  } catch (cause) {
    // Re-throw our own size-cap error verbatim; wrap genuine parse failures.
    if (
      cause instanceof Error &&
      cause.message.startsWith("backup restore: archive expands too large")
    ) {
      throw cause;
    }
    throw new Error("backup restore: could not read archive", { cause });
  }
  for (const [entryPath, data] of Object.entries(entries)) {
    if (entryPath.endsWith("/")) {
      continue;
    }
    const abs = assertSafeArchiveEntry(destDir, entryPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(data));
  }
}
