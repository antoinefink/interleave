/**
 * AssetVaultService (T059) — the main-side orchestrator for the SCALED asset vault.
 *
 * It composes the streamed I/O primitives ({@link vault-io}) + {@link AssetRepository}
 * + the vault paths so the desktop app can handle LARGE binaries (PDFs, images,
 * audio/video, snapshots) robustly:
 *
 *   - `importAsset` — STREAM-WRITE a binary to the vault while hashing it (no
 *     whole-file-in-memory), with CONTENT-HASH DEDUP on write (identical bytes are
 *     stored once and reused), recording the metadata in ONE transaction.
 *   - `verifyIntegrity` — re-hash the stored bytes (streamed) and compare to the
 *     recorded `assets.content_hash`, reporting mismatched / missing / extra files.
 *   - `findOrphans` / `collectOrphans` — file-centric orphan GC: identify vault
 *     FILES that no live `assets` row references and remove ONLY confirmed ones.
 *
 * Construction-time injection (mirrors `UrlImportService`): `new AssetVaultService(
 * { db, repositories, assetsDir })`. The renderer never resolves a raw path, reads
 * /writes bytes, or runs SQL — it reaches this only through `window.appApi.vault.*`.
 * There is NO app-facing S3: the local filesystem vault is the canonical store.
 *
 * ## Canonicalization contract (verify + GC join key)
 *
 * The on-disk walk and `assets.relative_path` MUST use the SAME canonical key, or
 * verify/GC misclassify on a path-separator or leading-slash mismatch. The join key
 * is the **POSIX, leading-slash-free relative path under `assetsDir`** (exactly how
 * `listFilesRelative` yields paths and how `assets.relative_path` is stored —
 * `system.ts`: "POSIX `/`, no leading slash, no `..`"). Both sides are normalized
 * identically before comparing. `assets.relative_path` is relative to `vault_root`;
 * the URL-import snapshots store `original.html`/`cleaned.html` as `source_html`
 * rows under `sources/<id>/…` with `vault_root = "assets"`, so the reference set is
 * keyed on the SAME `relative_path` the walk yields under `assetsDir` — a real asset
 * file is never flagged as an `extraFile`. (Asset kinds with a non-`assets`
 * `vault_root` are out of scope for the vault walk; only `assets`-rooted rows live
 * under `assetsDir`.)
 *
 * ## Walk root is `assetsDir` ONLY
 *
 * Verify + GC walk ONLY `<dataDir>/assets`. `exports/` and `backups/` are SIBLINGS
 * of `assets/` under the data dir and are OUT OF SCOPE — a backup archive or an
 * export file is never considered, let alone flagged as an `extraFile` or reclaimed
 * as an orphan.
 *
 * ## Dedup policy (content-addressed shared-path reuse) — GC must match it
 *
 * When `importAsset` sees a content hash that already maps to a LIVE asset (via
 * {@link AssetRepository.findLiveByContentHash}), it does NOT write a second copy:
 * it records a NEW `assets` row for the new owning element that points at the SAME
 * `relative_path` (shared bytes). So two elements importing identical bytes store
 * ONE copy on disk. GC is consistent with this: it only reclaims a file when NO
 * live asset row references that path ({@link AssetRepository.referencedRelativePaths}
 * is the reference set), so a shared file survives as long as ANY owner is live.
 * Dedup intentionally reuses bytes whose owner is soft-deleted (still restorable —
 * the row is live, so the file is referenced and GC will not reclaim it).
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Asset, AssetId, AssetKind, ElementId, VaultRoot } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { type AssetRepository, newAssetId, type Repositories } from "@interleave/local-db";
import { listFilesRelative } from "./backup-service";
import { hashFileStreamed, writeStreamedToVault } from "./vault-io";

/** Constructor dependencies (injected once, mirroring `UrlImportService`). */
export interface AssetVaultServiceDeps {
  /** The open Drizzle database (for the atomic metadata transaction). */
  readonly db: InterleaveDatabase;
  /** The repository bag bound to the same DB. */
  readonly repositories: Repositories;
  /** The asset-vault root (`<dataDir>/assets`). */
  readonly assetsDir: string;
}

/** Arguments to {@link AssetVaultService.importAsset}. */
export interface ImportAssetInput {
  /** The element that owns the imported asset. */
  readonly owningElementId: ElementId;
  readonly kind: AssetKind;
  /** ABSOLUTE source path, or a readable stream of the bytes. */
  readonly source: string | NodeJS.ReadableStream;
  readonly mime: string;
  /**
   * Optional explicit destination path RELATIVE to `assetsDir` (POSIX, no leading
   * slash). Defaults to `media/<asset_id>/original.bin` (the canonical media
   * layout). A caller importing a source-scoped binary may pass e.g.
   * `sources/<source_id>/original.pdf`.
   */
  readonly destRelativePath?: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
}

/** The vault integrity report ({@link AssetVaultService.verifyIntegrity}). */
export interface VaultIntegrityReport {
  /** Count of live asset rows whose stored bytes hashed to the recorded hash. */
  readonly ok: number;
  /** Asset ids whose stored bytes hashed to a DIFFERENT value (corruption). */
  readonly mismatched: AssetId[];
  /** Asset ids whose referenced file is MISSING on disk. */
  readonly missing: AssetId[];
  /** Vault files (canonical relative paths) with NO `assets` row at all. */
  readonly extraFiles: string[];
}

/** One orphan candidate file ({@link AssetVaultService.findOrphans}). */
export interface OrphanFile {
  /** Canonical POSIX relative path under `assetsDir`. */
  readonly relativePath: string;
  /** Size in bytes (for the freed-space estimate the confirm dialog shows). */
  readonly size: number;
}

/** The orphan GC report ({@link AssetVaultService.findOrphans}). */
export interface OrphanReport {
  readonly orphans: OrphanFile[];
  /** Total bytes the candidate orphans occupy. */
  readonly totalBytes: number;
}

/** Arguments to {@link AssetVaultService.collectOrphans}. */
export interface CollectOrphansInput {
  /** A guard literal — a destructive sweep is impossible without it. */
  readonly confirm: true;
  /**
   * Optional allow-list of canonical relative paths to remove (so the UI confirms
   * exactly the files `findOrphans` showed). When omitted, every current orphan is
   * removed. Each path is RE-CHECKED against the live reference set before removal,
   * so a path that became referenced since the scan is never deleted.
   */
  readonly relativePaths?: string[];
}

export class AssetVaultService {
  private readonly db: InterleaveDatabase;
  private readonly assetsRepo: AssetRepository;
  private readonly assetsDir: string;

  constructor(deps: AssetVaultServiceDeps) {
    this.db = deps.db;
    this.assetsRepo = deps.repositories.assets;
    this.assetsDir = deps.assetsDir;
  }

  /**
   * Stream a large binary into the vault with content-hash dedup, recording the
   * metadata in ONE transaction. Returns the created (or dedup-reusing) {@link Asset}.
   *
   * Flow:
   *  1. Stream-write the bytes to a temp path under the destination dir, hashing as
   *     it writes (no whole-file-in-memory) → `{ contentHash, size }`.
   *  1b. UPSERT-BY-PATH: if a LIVE asset already owns this exact destination path
   *     (a re-import overwriting the SAME file — e.g. re-OCR / a T065 re-crop), the
   *     write above atomically replaced that one file, so REFRESH the existing row's
   *     bytes-metadata in place and return it (no redundant second row per path).
   *  2. DEDUP: if a LIVE asset already has that hash at a DIFFERENT path, DELETE the
   *     just-written copy and record a new metadata row pointing at the EXISTING
   *     bytes' relative path (shared-path reuse) — one copy on disk for identical
   *     content.
   *  3. Otherwise keep the written file and record its metadata.
   *  A failed metadata insert rolls back AND removes the partial file (best-effort),
   *  mirroring `UrlImportService`'s rollback discipline.
   */
  async importAsset(input: ImportAssetInput): Promise<Asset> {
    const assetId = newAssetId();
    const relativePath = normalizeRelative(
      input.destRelativePath ?? `media/${assetId}/original.bin`,
    );
    const destAbsPath = this.resolve(relativePath);

    // 1. Stream-write + hash (atomic temp → rename inside writeStreamedToVault).
    const { contentHash, size } = await writeStreamedToVault({
      source: input.source,
      destAbsPath,
    });

    // 1b. Upsert-by-path: if a LIVE asset already owns THIS exact destination path
    //     (e.g. a re-OCR overwriting `ocr/page-N.png`, or a T065 re-crop), the
    //     stream-write above atomically overwrote that one file — so REFRESH the
    //     existing row's bytes-metadata in place instead of minting a second row
    //     for the same path (which would slowly accumulate redundant metadata).
    const samePath = this.assetsRepo.findLiveByOwnerAndPath(
      input.owningElementId,
      "assets" as VaultRoot,
      relativePath,
    );
    if (samePath) {
      // The overwrite was atomic and the file is consistent, so a metadata-update
      // failure leaves the file for the row that already references this path (no
      // cleanup) — the error propagates naturally.
      return this.db.transaction((tx) =>
        this.assetsRepo.updateBytesWithin(tx, samePath.id, {
          contentHash,
          mime: input.mime,
          size,
          width: input.width ?? null,
          height: input.height ?? null,
          durationMs: input.durationMs ?? null,
        }),
      );
    }

    // 2. Content-hash dedup against a LIVE existing asset.
    const existing = this.assetsRepo.findLiveByContentHash(contentHash);
    const reuse = existing != null && existing.location.vaultPath.relativePath !== relativePath;
    const finalRelativePath = reuse ? existing.location.vaultPath.relativePath : relativePath;

    if (reuse) {
      // Identical bytes already live in the vault — drop the just-written copy and
      // point the new metadata row at the shared file (shared-path dedup policy).
      await fs.rm(destAbsPath, { force: true }).catch(() => {});
      await this.removeEmptyDir(path.dirname(destAbsPath));
    }

    // 3. Record metadata in one transaction; on failure remove the file we wrote
    //    (only if we kept it — a reused file belongs to another live row).
    try {
      return this.db.transaction((tx) =>
        this.assetsRepo.createWithin(tx, {
          owningElementId: input.owningElementId,
          kind: input.kind,
          vaultRoot: "assets" as VaultRoot,
          relativePath: finalRelativePath,
          contentHash,
          mime: input.mime,
          size: existing && reuse ? existing.size : size,
          width: input.width ?? null,
          height: input.height ?? null,
          durationMs: input.durationMs ?? null,
        }),
      );
    } catch (err) {
      if (!reuse) {
        await fs.rm(destAbsPath, { force: true }).catch(() => {});
        await this.removeEmptyDir(path.dirname(destAbsPath));
      }
      throw err;
    }
  }

  /**
   * Re-hash every live asset's stored bytes (STREAMED) and compare to the recorded
   * `assets.content_hash`. Read-only — it reports, never mutates. Big files are
   * hashed streamed (no whole-file read). `extraFiles` are vault files under
   * `assetsDir` with no `assets` row — the same set {@link findOrphans} surfaces.
   */
  async verifyIntegrity(): Promise<VaultIntegrityReport> {
    const all = this.assetsRepo.listAll();
    // The walk is scoped to `assetsDir`, so the reference set is scoped to the
    // `"assets"` vault root — a same-named path in another root never shadows it.
    const referenced = this.assetsRepo.referencedRelativePaths("assets");
    const mismatched: AssetId[] = [];
    const missing: AssetId[] = [];
    let ok = 0;

    for (const asset of all) {
      const rel = asset.location.vaultPath.relativePath;
      const abs = this.resolve(rel);
      let actual: string;
      try {
        actual = await hashFileStreamed(abs);
      } catch {
        missing.push(asset.id);
        continue;
      }
      if (actual === asset.contentHash) ok += 1;
      else mismatched.push(asset.id);
    }

    // Extra files = on-disk vault files whose canonical relative path is not in the
    // live reference set (a never-rowed stray, or the leftover bytes of a purge).
    const onDisk = listFilesRelative(this.assetsDir);
    const extraFiles = onDisk.filter((rel) => !referenced.has(rel) && !isVaultScratch(rel));

    return { ok, mismatched, missing, extraFiles };
  }

  /**
   * The orphan GC candidate set (T059), FILE-CENTRIC: vault files under `assetsDir`
   * whose canonical relative path is NOT referenced by any live asset row — the
   * bytes a hard-purge's cascade left on disk, plus any never-rowed stray file.
   * There is NO "asset row whose element is gone" arm (the cascade FK makes that
   * state unreachable; the unreferenced FILE is the orphan). Read-only.
   */
  async findOrphans(): Promise<OrphanReport> {
    // Scoped to the `"assets"` vault root to match the `assetsDir` walk (a row in
    // `exports`/`backups` sharing a relative path never protects an `assets/` file).
    const referenced = this.assetsRepo.referencedRelativePaths("assets");
    const onDisk = listFilesRelative(this.assetsDir);
    const orphans: OrphanFile[] = [];
    let totalBytes = 0;
    for (const rel of onDisk) {
      if (referenced.has(rel)) continue;
      // Skip in-flight atomic-write scratch — never an orphan (see isVaultScratch).
      if (isVaultScratch(rel)) continue;
      let size = 0;
      try {
        size = (await fs.stat(this.resolve(rel))).size;
      } catch {
        // Vanished between the walk and the stat — skip it.
        continue;
      }
      orphans.push({ relativePath: rel, size });
      totalBytes += size;
    }
    return { orphans, totalBytes };
  }

  /**
   * Remove confirmed orphan FILES (T059). Requires `confirm: true` (the guard
   * against an accidental destructive sweep). Re-computes the live reference set and
   * deletes ONLY files that are STILL unreferenced — never a file any live asset row
   * points at (consistent with the shared-path dedup policy: a soft-deleted-but-
   * restorable owner keeps a live row, so its file survives; GC reclaims only after
   * a HARD-purge). An optional `relativePaths` allow-list scopes the removal to
   * exactly the files the UI confirmed. Returns the counts freed.
   */
  async collectOrphans(
    input: CollectOrphansInput,
  ): Promise<{ removed: number; freedBytes: number }> {
    if (input.confirm !== true) {
      throw new Error("AssetVaultService.collectOrphans: confirm must be true");
    }
    const { orphans } = await this.findOrphans();
    const allow = input.relativePaths ? new Set(input.relativePaths.map(normalizeRelative)) : null;
    let removed = 0;
    let freedBytes = 0;
    for (const orphan of orphans) {
      if (allow && !allow.has(orphan.relativePath)) continue;
      const abs = this.resolve(orphan.relativePath);
      try {
        await fs.rm(abs, { force: true });
        await this.removeEmptyDir(path.dirname(abs));
        removed += 1;
        freedBytes += orphan.size;
      } catch {
        // Best-effort: a file that vanished or could not be removed is skipped; it
        // costs disk at worst, never user data (the predicate already proved it
        // unreferenced). Continue with the rest.
      }
    }
    return { removed, freedBytes };
  }

  // --- internals -----------------------------------------------------------

  /** Resolve a canonical relative path to its absolute path under `assetsDir`. */
  private resolve(relativePath: string): string {
    return path.join(this.assetsDir, ...relativePath.split("/"));
  }

  /**
   * Best-effort: remove `dir` if it is now empty (and stop at `assetsDir`). Keeps
   * the vault tidy after dropping a deduped temp or a collected orphan, without ever
   * touching `assetsDir` itself or a non-empty directory.
   */
  private async removeEmptyDir(dir: string): Promise<void> {
    const root = path.resolve(this.assetsDir);
    let current = path.resolve(dir);
    while (current.startsWith(root) && current !== root) {
      try {
        const entries = await fs.readdir(current);
        if (entries.length > 0) return;
        await fs.rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }
}

/** Normalize a relative path to the canonical POSIX, leading-slash-free form. */
function normalizeRelative(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * A `<dest>.tmp` is the in-flight scratch file `writeStreamedToVault` writes before
 * the atomic `rename` into place (see `vault-io.ts`). It has no `assets` row yet, so
 * an orphan/integrity walk would otherwise flag it as an `extraFile`/orphan and — if a
 * GC sweep raced an in-flight import — delete the bytes mid-write. `.tmp` is reserved
 * vault scratch and is NEVER a real asset, so both scans exclude it.
 */
function isVaultScratch(rel: string): boolean {
  return rel.endsWith(".tmp");
}
