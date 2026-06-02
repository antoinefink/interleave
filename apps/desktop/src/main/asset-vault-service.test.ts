/**
 * AssetVaultService integration tests (T059) — against a real temp-file SQLite DB
 * + a temp `assetsDir` (the desktop-main pattern, like db-service.test.ts).
 *
 * Covers the load-bearing vault-scaling behavior end-to-end:
 *  - `importAsset` streams bytes to the vault + records metadata whose contentHash
 *    matches a streamed re-hash; importing IDENTICAL bytes a second time DEDUPS
 *    (one copy on disk, two metadata rows sharing the relative path); re-importing
 *    to the SAME owner+path (a re-OCR / re-crop) UPDATES the row in place rather
 *    than minting a duplicate;
 *  - `verifyIntegrity` reports `ok` for an intact vault, MISMATCH for a corrupted
 *    file, MISSING for a deleted referenced file, and lists an `extraFile`;
 *  - `findOrphans` finds the leftover FILE of a HARD-purged element (a real
 *    `TrashRepository.purge` cascade deletes the asset ROW while the file stays) +
 *    a stray no-row file, but NOT a live/soft-deleted owner's file;
 *  - `collectOrphans({ confirm: true })` removes ONLY confirmed orphans;
 *  - the survivors + the removed-files-stay-gone property hold across a DB re-open
 *    (restart persistence).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { ElementId } from "@interleave/core";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";
import { hashFileStreamed } from "./vault-io";

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-vault-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir });
  return svc;
}

/** Create a live `source` element to own imported assets. */
function makeSource(svc: DbService, title = "owner"): ElementId {
  return svc.repos.elements.create({
    type: "source",
    status: "inbox",
    stage: "raw_source",
    priority: 0.375,
    title,
  }).id;
}

const PAYLOAD = Buffer.from("a sizable pretend-PDF payload ".repeat(1000));

describe("AssetVaultService.importAsset (T059)", () => {
  it("streams bytes to the vault and records metadata matching a streamed re-hash", async () => {
    const svc = openDb();
    const owner = makeSource(svc);
    const vault = svc.assetVaultService;

    const asset = await vault.importAsset({
      owningElementId: owner,
      kind: "source_pdf",
      source: Readable.from(PAYLOAD),
      mime: "application/pdf",
    });

    const abs = path.join(assetsDir, ...asset.location.vaultPath.relativePath.split("/"));
    expect(fs.existsSync(abs)).toBe(true);
    expect(asset.size).toBe(PAYLOAD.byteLength);
    expect(await hashFileStreamed(abs)).toBe(asset.contentHash);
    svc.close();
  });

  it("dedups identical bytes — one copy on disk, two rows sharing the path", async () => {
    const svc = openDb();
    const ownerA = makeSource(svc, "A");
    const ownerB = makeSource(svc, "B");
    const vault = svc.assetVaultService;

    const a = await vault.importAsset({
      owningElementId: ownerA,
      kind: "image",
      source: Readable.from(PAYLOAD),
      mime: "image/png",
    });
    const b = await vault.importAsset({
      owningElementId: ownerB,
      kind: "image",
      source: Readable.from(PAYLOAD),
      mime: "image/png",
    });

    // Same content hash → SHARED relative path (one copy of the bytes on disk).
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.location.vaultPath.relativePath).toBe(a.location.vaultPath.relativePath);
    // Two metadata rows exist (one per owner) but only one file on disk.
    expect(svc.repos.assets.listAll()).toHaveLength(2);
    const allRel = svc.repos.assets.listAll().map((x) => x.location.vaultPath.relativePath);
    expect(new Set(allRel).size).toBe(1);
    expect(
      fs.existsSync(path.join(assetsDir, ...a.location.vaultPath.relativePath.split("/"))),
    ).toBe(true);
    svc.close();
  });

  it("re-importing to the SAME owner+path UPDATES the row in place (no duplicate metadata)", async () => {
    const svc = openDb();
    const owner = makeSource(svc);
    const vault = svc.assetVaultService;
    const rel = `sources/${owner}/ocr/page-1.png`;

    const first = await vault.importAsset({
      owningElementId: owner,
      kind: "snapshot",
      source: Readable.from(Buffer.from("first ocr render")),
      mime: "image/png",
      destRelativePath: rel,
    });
    // Re-OCR the same page: different bytes overwrite the SAME path.
    const second = await vault.importAsset({
      owningElementId: owner,
      kind: "snapshot",
      source: Readable.from(Buffer.from("a DIFFERENT, re-rendered ocr image payload")),
      mime: "image/png",
      destRelativePath: rel,
    });

    // SAME row id (updated in place), refreshed hash/size, still ONE metadata row.
    expect(second.id).toBe(first.id);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(svc.repos.assets.listForElement(owner)).toHaveLength(1);
    // The single file on disk is the latest render (matches the updated hash).
    const abs = path.join(assetsDir, ...rel.split("/"));
    expect(fs.existsSync(abs)).toBe(true);
    expect(await hashFileStreamed(abs)).toBe(second.contentHash);
    svc.close();
  });
});

describe("AssetVaultService.verifyIntegrity (T059)", () => {
  it("reports ok for an intact vault, mismatch on corruption, missing on delete, extra files", async () => {
    const svc = openDb();
    const owner = makeSource(svc);
    const vault = svc.assetVaultService;

    const intact = await vault.importAsset({
      owningElementId: owner,
      kind: "source_pdf",
      source: Readable.from(PAYLOAD),
      mime: "application/pdf",
    });
    const corrupt = await vault.importAsset({
      owningElementId: owner,
      kind: "image",
      source: Readable.from(Buffer.from("original-image-bytes")),
      mime: "image/png",
    });
    const gone = await vault.importAsset({
      owningElementId: owner,
      kind: "audio",
      source: Readable.from(Buffer.from("audio-clip-bytes")),
      mime: "audio/mpeg",
    });

    // All intact at first.
    let report = await vault.verifyIntegrity();
    expect(report.ok).toBe(3);
    expect(report.mismatched).toEqual([]);
    expect(report.missing).toEqual([]);
    expect(report.extraFiles).toEqual([]);

    // Corrupt one stored file on disk → mismatch.
    const corruptAbs = path.join(assetsDir, ...corrupt.location.vaultPath.relativePath.split("/"));
    fs.writeFileSync(corruptAbs, "tampered-bytes");
    // Delete one referenced file → missing.
    const goneAbs = path.join(assetsDir, ...gone.location.vaultPath.relativePath.split("/"));
    fs.rmSync(goneAbs);
    // Drop a stray file with no asset row → extraFile.
    fs.mkdirSync(path.join(assetsDir, "media", "stray"), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "media", "stray", "orphan.bin"), "no-row");

    report = await vault.verifyIntegrity();
    expect(report.ok).toBe(1); // only `intact`
    expect(report.mismatched).toEqual([corrupt.id]);
    expect(report.missing).toEqual([gone.id]);
    expect(report.extraFiles).toContain("media/stray/orphan.bin");
    // The intact + corrupt files (still referenced rows) are NOT extra files.
    expect(report.extraFiles).not.toContain(intact.location.vaultPath.relativePath);
    expect(report.extraFiles).not.toContain(corrupt.location.vaultPath.relativePath);
    svc.close();
  });
});

describe("AssetVaultService orphan GC (T059)", () => {
  it("finds a purged element's leftover file + a stray file, never a live/soft-deleted owner's file", async () => {
    const svc = openDb();
    const liveOwner = makeSource(svc, "live");
    const softOwner = makeSource(svc, "soft");
    const purgedOwner = makeSource(svc, "purged");
    const vault = svc.assetVaultService;

    const liveAsset = await vault.importAsset({
      owningElementId: liveOwner,
      kind: "image",
      source: Readable.from(Buffer.from("live-bytes")),
      mime: "image/png",
    });
    const softAsset = await vault.importAsset({
      owningElementId: softOwner,
      kind: "image",
      source: Readable.from(Buffer.from("soft-bytes")),
      mime: "image/png",
    });
    const purgedAsset = await vault.importAsset({
      owningElementId: purgedOwner,
      kind: "image",
      source: Readable.from(Buffer.from("purged-bytes")),
      mime: "image/png",
    });

    // A stray file with no asset row at all.
    fs.mkdirSync(path.join(assetsDir, "media", "stray"), { recursive: true });
    fs.writeFileSync(path.join(assetsDir, "media", "stray", "x.bin"), "stray");

    // Soft-delete one owner (its file MUST survive — restorable from Trash).
    svc.repos.elements.softDelete(softOwner);
    // HARD-purge another owner (its cascade deletes the asset ROW; the file stays).
    svc.repos.elements.softDelete(purgedOwner);
    expect(svc.repos.trash.purge(purgedOwner)).toBe(true);

    const { orphans } = await vault.findOrphans();
    const orphanPaths = orphans.map((o) => o.relativePath).sort();

    // Orphans = the purged element's leftover FILE + the stray no-row file.
    expect(orphanPaths).toContain(purgedAsset.location.vaultPath.relativePath);
    expect(orphanPaths).toContain("media/stray/x.bin");
    // NOT the live owner's file, NOT the soft-deleted-but-restorable owner's file.
    expect(orphanPaths).not.toContain(liveAsset.location.vaultPath.relativePath);
    expect(orphanPaths).not.toContain(softAsset.location.vaultPath.relativePath);
    svc.close();
  });

  it("never treats an in-flight `<dest>.tmp` scratch file as an orphan / extra file, and GC never deletes it", async () => {
    const svc = openDb();
    const owner = makeSource(svc, "keep");
    const vault = svc.assetVaultService;

    const live = await vault.importAsset({
      owningElementId: owner,
      kind: "image",
      source: Readable.from(Buffer.from("live-bytes")),
      mime: "image/png",
    });

    // Simulate an import streaming bytes: writeStreamedToVault writes `<dest>.tmp`
    // before the atomic rename. A GC/verify sweep that races it must NOT see it.
    fs.mkdirSync(path.join(assetsDir, "media", "inflight"), { recursive: true });
    const tmpRel = "media/inflight/original.bin.tmp";
    const tmpAbs = path.join(assetsDir, ...tmpRel.split("/"));
    fs.writeFileSync(tmpAbs, "half-written-bytes");

    // Neither scan surfaces the scratch file.
    const { orphans } = await vault.findOrphans();
    expect(orphans.map((o) => o.relativePath)).not.toContain(tmpRel);
    const report = await vault.verifyIntegrity();
    expect(report.extraFiles).not.toContain(tmpRel);

    // An unguarded "remove every orphan" sweep must leave the in-flight scratch
    // (and the live asset) untouched.
    await vault.collectOrphans({ confirm: true });
    expect(fs.existsSync(tmpAbs)).toBe(true);
    expect(
      fs.existsSync(path.join(assetsDir, ...live.location.vaultPath.relativePath.split("/"))),
    ).toBe(true);
    svc.close();
  });

  it("collectOrphans removes ONLY confirmed orphan files and survives a DB re-open", async () => {
    let svc = openDb();
    const liveOwner = makeSource(svc, "keep");
    const purgedOwner = makeSource(svc, "drop");
    const vault = svc.assetVaultService;

    const survivor = await vault.importAsset({
      owningElementId: liveOwner,
      kind: "image",
      source: Readable.from(Buffer.from("survivor-bytes")),
      mime: "image/png",
    });
    const doomed = await vault.importAsset({
      owningElementId: purgedOwner,
      kind: "image",
      source: Readable.from(Buffer.from("doomed-bytes")),
      mime: "image/png",
    });

    svc.repos.elements.softDelete(purgedOwner);
    expect(svc.repos.trash.purge(purgedOwner)).toBe(true);

    const survivorAbs = path.join(
      assetsDir,
      ...survivor.location.vaultPath.relativePath.split("/"),
    );
    const doomedAbs = path.join(assetsDir, ...doomed.location.vaultPath.relativePath.split("/"));
    expect(fs.existsSync(survivorAbs)).toBe(true);
    expect(fs.existsSync(doomedAbs)).toBe(true);

    // confirm: true required; the optional allow-list scopes removal.
    const result = await vault.collectOrphans({
      confirm: true,
      relativePaths: [doomed.location.vaultPath.relativePath],
    });
    expect(result.removed).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(0);

    // The orphan is gone; the referenced survivor is untouched.
    expect(fs.existsSync(doomedAbs)).toBe(false);
    expect(fs.existsSync(survivorAbs)).toBe(true);

    // Restart persistence: re-open the DB and assert the survivor + its bytes are
    // intact and the removed file stays gone.
    svc.close();
    svc = openDb();
    expect(svc.repos.assets.findById(survivor.id)?.contentHash).toBe(survivor.contentHash);
    expect(fs.existsSync(survivorAbs)).toBe(true);
    expect(fs.existsSync(doomedAbs)).toBe(false);
    // And a fresh verify reports the survivor OK with no lingering orphan.
    const report = await svc.assetVaultService.verifyIntegrity();
    expect(report.ok).toBe(1);
    expect(report.extraFiles).toEqual([]);
    svc.close();
  });

  it("collectOrphans rejects a payload without confirm: true", async () => {
    const svc = openDb();
    const vault = svc.assetVaultService;
    await expect(
      // @ts-expect-error — the guard literal must be present.
      vault.collectOrphans({ confirm: false }),
    ).rejects.toThrow(/confirm must be true/);
    svc.close();
  });
});
