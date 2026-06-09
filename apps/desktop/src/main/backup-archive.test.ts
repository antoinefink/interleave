/**
 * Backup-archive extraction-helper tests.
 *
 * Restore-from-file ingests an UNTRUSTED `.zip`, so the extraction helper is a
 * security boundary: it must extract a well-formed archive byte-for-byte, reject
 * every zip-slip shape (absolute paths, `..`, backslashes, empty segments)
 * WITHOUT writing outside the destination, surface a clear error on a non-zip
 * buffer, and skip directory entries while still writing the files they contain.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeArchiveEntry, extractBackupArchive } from "./backup-archive";

let workDir: string;
let destDir: string;
let zipPath: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-backup-archive-"));
  destDir = path.join(workDir, "dest");
  fs.mkdirSync(destDir, { recursive: true });
  zipPath = path.join(workDir, "backup.zip");
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function writeZip(entries: Record<string, Uint8Array>): void {
  fs.writeFileSync(zipPath, Buffer.from(zipSync(entries)));
}

describe("extractBackupArchive", () => {
  it("extracts a well-formed archive to disk byte-for-byte", () => {
    const manifest = strToU8("{}");
    const sqlite = new Uint8Array([1, 2, 3, 4, 255, 0]);
    const asset = strToU8("hi");
    writeZip({
      "manifest.json": manifest,
      "app.sqlite": sqlite,
      "assets/sources/a.txt": asset,
    });

    extractBackupArchive(zipPath, destDir);

    expect(new Uint8Array(fs.readFileSync(path.join(destDir, "manifest.json")))).toEqual(manifest);
    expect(new Uint8Array(fs.readFileSync(path.join(destDir, "app.sqlite")))).toEqual(sqlite);
    expect(new Uint8Array(fs.readFileSync(path.join(destDir, "assets/sources/a.txt")))).toEqual(
      asset,
    );
  });

  it("rejects an entry with an absolute path and writes nothing outside destDir", () => {
    writeZip({
      "manifest.json": strToU8("{}"),
      "/etc/evil": strToU8("pwned"),
    });

    expect(() => extractBackupArchive(zipPath, destDir)).toThrow(/unsafe archive entry/);
    expect(fs.existsSync("/etc/evil")).toBe(false);
  });

  it("rejects a zip-slip entry containing `..` and creates no file at the escaped location", () => {
    writeZip({
      "manifest.json": strToU8("{}"),
      "assets/../../escape.txt": strToU8("pwned"),
    });

    expect(() => extractBackupArchive(zipPath, destDir)).toThrow(/unsafe archive entry/);
    // The escape target is two levels up from destDir.
    expect(fs.existsSync(path.join(destDir, "..", "..", "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(workDir, "escape.txt"))).toBe(false);
  });

  it("rejects an entry with a leading `..` segment", () => {
    writeZip({ "../escape.txt": strToU8("pwned") });

    expect(() => extractBackupArchive(zipPath, destDir)).toThrow(/unsafe archive entry/);
    expect(fs.existsSync(path.join(workDir, "escape.txt"))).toBe(false);
  });

  it("rejects an entry with a backslash", () => {
    writeZip({ "assets\\evil.txt": strToU8("pwned") });

    expect(() => extractBackupArchive(zipPath, destDir)).toThrow(/unsafe archive entry/);
  });

  it("rejects an entry with an empty segment", () => {
    writeZip({ "assets//evil.txt": strToU8("pwned") });

    expect(() => extractBackupArchive(zipPath, destDir)).toThrow(/unsafe archive entry/);
  });

  it("throws a clear error on a non-zip / truncated buffer", () => {
    fs.writeFileSync(zipPath, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]));

    expect(() => extractBackupArchive(zipPath, destDir)).toThrow(/could not read archive/);
  });

  it("rejects an archive that expands past the uncompressed cap before writing anything past it", () => {
    writeZip({
      "manifest.json": strToU8("aaaa"),
      "app.sqlite": strToU8("bbbb"),
      "assets/sources/a.txt": strToU8("cccc"),
    });

    // A 4-byte cumulative cap is exceeded by the first entry's uncompressed size,
    // so the decompression-bomb backstop trips before extraction completes.
    expect(() => extractBackupArchive(zipPath, destDir, { maxTotalUncompressedBytes: 4 })).toThrow(
      /expands too large/,
    );
    // Nothing escaped the cap: none of the entries were written to disk.
    expect(fs.existsSync(path.join(destDir, "manifest.json"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "app.sqlite"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "assets/sources/a.txt"))).toBe(false);
  });

  it("rejects an archive whose compressed file size exceeds the archive cap", () => {
    writeZip({ "manifest.json": strToU8("{}") });

    expect(() => extractBackupArchive(zipPath, destDir, { maxArchiveBytes: 1 })).toThrow(
      /archive too large/,
    );
  });

  it("throws a clear error when the archive file does not exist", () => {
    const missing = path.join(workDir, "does-not-exist.zip");

    expect(() => extractBackupArchive(missing, destDir)).toThrow(/could not read archive file/);
  });

  it("skips directory entries and still writes the contained files", () => {
    writeZip({
      "assets/": new Uint8Array(),
      "assets/sources/": new Uint8Array(),
      "assets/sources/a.txt": strToU8("hi"),
    });

    extractBackupArchive(zipPath, destDir);

    // No file was written for the directory entries themselves...
    expect(fs.statSync(path.join(destDir, "assets")).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(destDir, "assets/sources")).isDirectory()).toBe(true);
    // ...and the contained file is present.
    expect(fs.readFileSync(path.join(destDir, "assets/sources/a.txt"), "utf8")).toBe("hi");
  });
});

describe("assertSafeArchiveEntry", () => {
  it("resolves a safe nested entry to an absolute path inside destDir", () => {
    const abs = assertSafeArchiveEntry(destDir, "assets/sources/a.txt");
    expect(abs).toBe(path.join(destDir, "assets", "sources", "a.txt"));
  });

  it("rejects absolute, traversal, backslash, and empty-segment entries", () => {
    expect(() => assertSafeArchiveEntry(destDir, "/etc/evil")).toThrow(/unsafe archive entry/);
    expect(() => assertSafeArchiveEntry(destDir, "../escape.txt")).toThrow(/unsafe archive entry/);
    expect(() => assertSafeArchiveEntry(destDir, "a/../../escape")).toThrow(/unsafe archive entry/);
    expect(() => assertSafeArchiveEntry(destDir, "a\\b")).toThrow(/unsafe archive entry/);
    expect(() => assertSafeArchiveEntry(destDir, "a//b")).toThrow(/unsafe archive entry/);
    expect(() => assertSafeArchiveEntry(destDir, "")).toThrow(/unsafe archive entry/);
  });
});
