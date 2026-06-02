/**
 * Backup manifest + integrity-helper tests (T047).
 *
 * Pure unit tests over the framework-free manifest model: the format version is
 * stamped, hashing is correct + deterministic, and the schema-version tag is
 * resolved from the runtime applied-migration COUNT + the staged journal.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  type BackupCounts,
  buildBackupManifest,
  type ManifestFileEntry,
  resolveSchemaVersion,
  sha256,
  sha256File,
} from "./backup-manifest";

const COUNTS: BackupCounts = { elements: 3, sources: 1, extracts: 1, cards: 1, assets: 2 };
const FILES: ManifestFileEntry[] = [
  { path: "app.sqlite", sha256: "a".repeat(64), size: 4096 },
  { path: "assets/sources/s1/snapshot.json", sha256: "b".repeat(64), size: 12 },
];

describe("buildBackupManifest (T047)", () => {
  it("stamps the current format version and passes through the inputs", () => {
    const manifest = buildBackupManifest({
      schemaVersion: "0002_search_fts5",
      appVersion: "1.2.3",
      createdAt: "2026-05-30T12:00:00.000Z",
      files: FILES,
      counts: COUNTS,
      assetVaultRoot: "assets",
    });
    expect(manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.schemaVersion).toBe("0002_search_fts5");
    expect(manifest.appVersion).toBe("1.2.3");
    expect(manifest.createdAt).toBe("2026-05-30T12:00:00.000Z");
    expect(manifest.files).toEqual(FILES);
    expect(manifest.counts).toEqual(COUNTS);
    expect(manifest.assetVaultRoot).toBe("assets");
  });

  it("round-trips through JSON unchanged (the on-disk manifest shape)", () => {
    const manifest = buildBackupManifest({
      schemaVersion: "0000_unique_squadron_supreme",
      appVersion: "0.0.0",
      createdAt: "2026-01-01T00:00:00.000Z",
      files: FILES,
      counts: COUNTS,
      assetVaultRoot: "assets",
    });
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});

describe("sha256 / sha256File (T047)", () => {
  it("hashes the known SHA-256 of an empty buffer", () => {
    // The canonical SHA-256 of the empty input.
    expect(sha256(Buffer.alloc(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic and detects a single-byte change", () => {
    const a = sha256(Buffer.from("hello world", "utf8"));
    const b = sha256(Buffer.from("hello world", "utf8"));
    const c = sha256(Buffer.from("hello worlx", "utf8"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("sha256File matches sha256 of the same bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-hash-"));
    const file = path.join(dir, "x.bin");
    const bytes = Buffer.from("integrity check payload");
    fs.writeFileSync(file, bytes);
    try {
      expect(sha256File(file)).toBe(sha256(bytes));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveSchemaVersion (T047)", () => {
  it("maps the applied-migration count to the latest tag via the real journal", () => {
    // The packaged journal currently has 15 entries (0000…0014). With all applied,
    // the latest tag is the image-occlusion `cards.kind` CHECK widening + the
    // `occlusion_masks` table (T071); fewer applied resolve to the prior tags.
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 15)).toBe("0014_remarkable_yellow_claw");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 14)).toBe("0013_charming_senator_kelly");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 13)).toBe("0012_abnormal_strong_guy");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 12)).toBe("0011_young_unicorn");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 11)).toBe("0010_free_silver_fox");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 10)).toBe("0009_public_steel_serpent");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 9)).toBe("0008_outgoing_sir_ram");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 8)).toBe("0007_parched_killmonger");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 7)).toBe("0006_round_vertigo");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 6)).toBe("0005_card_fts_softdelete");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 5)).toBe("0004_lovely_captain_midlands");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 4)).toBe("0003_overrated_thundra");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 3)).toBe("0002_search_fts5");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 2)).toBe("0001_clever_rictor");
    expect(resolveSchemaVersion(MIGRATIONS_DIR, 1)).toBe("0000_unique_squadron_supreme");
  });

  it("resolves the tag from an out-of-order journal (sorted by idx)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-journal-"));
    fs.mkdirSync(path.join(dir, "meta"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta", "_journal.json"),
      JSON.stringify({
        entries: [
          { idx: 2, tag: "0002_third" },
          { idx: 0, tag: "0000_first" },
          { idx: 1, tag: "0001_second" },
        ],
      }),
    );
    try {
      expect(resolveSchemaVersion(dir, 1)).toBe("0000_first");
      expect(resolveSchemaVersion(dir, 2)).toBe("0001_second");
      expect(resolveSchemaVersion(dir, 3)).toBe("0002_third");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when the count is out of range (corrupt-state signal)", () => {
    expect(() => resolveSchemaVersion(MIGRATIONS_DIR, 0)).toThrow(/out of range/);
    expect(() => resolveSchemaVersion(MIGRATIONS_DIR, 99)).toThrow(/out of range/);
  });
});
