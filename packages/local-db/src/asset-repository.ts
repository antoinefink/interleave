/**
 * AssetRepository (T008) — metadata for large binaries in the filesystem vault.
 *
 * SQLite stores ONLY metadata for assets (a stable id, owning element, kind, the
 * vault root + relative path, content hash, MIME, size, optional media
 * dimensions/duration, timestamp). The bytes live on disk in the asset vault and
 * are written exclusively by the Electron main process — storing blob payloads
 * in SQLite is forbidden, and the renderer never resolves a raw path.
 *
 * Asset rows have no dedicated operation in the canonical `OPERATION_TYPES`
 * vocabulary (those track element/source/extract/card/review/relation/tag
 * mutations), so creating asset metadata does not append an op-log entry; the
 * owning element's `create_*` op already records the user action that produced
 * it. Integrity is enforced by the `assets` foreign key to `elements`.
 */

import type { Asset, AssetId, AssetKind, ElementId, VaultRoot } from "@interleave/core";
import { assets, elements, type InterleaveDatabase } from "@interleave/db";
import { and, eq } from "drizzle-orm";
import { newAssetId, nowIso } from "./ids";
import { rowToAsset } from "./mappers";
import type { DbClient } from "./types";

/** Metadata for a new asset (the bytes are written to the vault separately). */
export interface CreateAssetInput {
  readonly owningElementId: ElementId;
  readonly kind: AssetKind;
  readonly vaultRoot: VaultRoot;
  /** Path relative to `vaultRoot` (POSIX `/`, no leading slash, no `..`). */
  readonly relativePath: string;
  readonly contentHash: string;
  readonly mime: string;
  readonly size: number;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly durationMs?: number | null;
}

export class AssetRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Insert asset metadata and return the domain {@link Asset}. Runs in its own
   * single-statement transaction. For atomicity with an owning element's source
   * insert (so a thrown error rolls BOTH back — no orphan asset row), use
   * {@link createWithin} on the outer transaction instead.
   */
  create(input: CreateAssetInput): Asset {
    return this.db.transaction((tx) => this.createWithin(tx, input));
  }

  /**
   * Insert asset metadata using an EXISTING transaction — the tx-composable seam
   * (T060) that lets the URL-import service write the two `source_html` snapshot
   * rows in the SAME transaction as the source + document insert, so a failure
   * anywhere rolls them all back (no orphan source/asset/file). Mirrors
   * {@link SourceRepository.createExtractWithin}: it inserts on the passed `tx`.
   */
  createWithin(tx: DbClient, input: CreateAssetInput): Asset {
    const id = newAssetId();
    const createdAt = nowIso();
    tx.insert(assets)
      .values({
        id,
        owningElementId: input.owningElementId,
        kind: input.kind,
        vaultRoot: input.vaultRoot,
        relativePath: input.relativePath,
        contentHash: input.contentHash,
        mime: input.mime,
        size: input.size,
        width: input.width ?? null,
        height: input.height ?? null,
        durationMs: input.durationMs ?? null,
        createdAt,
      })
      .run();
    const row = tx.select().from(assets).where(eq(assets.id, id)).get();
    if (!row) throw new Error("AssetRepository.createWithin: asset row missing after insert");
    return rowToAsset(row);
  }

  /** Fetch one asset by id, or `null`. */
  findById(id: AssetId): Asset | null {
    const row = this.db.select().from(assets).where(eq(assets.id, id)).get();
    return row ? rowToAsset(row) : null;
  }

  /**
   * The first LIVE asset row owned by `owningElementId` whose `(vault_root,
   * relative_path)` matches (its owning `elements` row still exists). This backs
   * {@link AssetVaultService.importAsset}'s upsert-by-path: re-importing to the
   * SAME destination path (e.g. re-OCR overwriting `ocr/page-N.png`, or a T065
   * re-crop) UPDATES the existing metadata row in place rather than minting a new
   * one for the same overwritten file (which would accumulate redundant rows).
   */
  findLiveByOwnerAndPath(
    owningElementId: ElementId,
    vaultRoot: VaultRoot,
    relativePath: string,
  ): Asset | null {
    const row = this.db
      .select({ asset: assets })
      .from(assets)
      .innerJoin(elements, eq(assets.owningElementId, elements.id))
      .where(
        and(
          eq(assets.owningElementId, owningElementId),
          eq(assets.vaultRoot, vaultRoot),
          eq(assets.relativePath, relativePath),
        ),
      )
      .get();
    return row ? rowToAsset(row.asset) : null;
  }

  /**
   * Refresh an existing asset row's bytes-metadata IN PLACE (content hash, size,
   * mime, optional media dimensions) on the passed transaction — used when an
   * import overwrites the SAME `(owner, vault_root, relative_path)` file, so the
   * row stays unique per path instead of duplicating. The id/owner/kind/path are
   * unchanged; the `createdAt` is preserved (it is the row's first-seen time).
   */
  updateBytesWithin(
    tx: DbClient,
    id: AssetId,
    fields: {
      readonly contentHash: string;
      readonly mime: string;
      readonly size: number;
      readonly width?: number | null;
      readonly height?: number | null;
      readonly durationMs?: number | null;
    },
  ): Asset {
    tx.update(assets)
      .set({
        contentHash: fields.contentHash,
        mime: fields.mime,
        size: fields.size,
        width: fields.width ?? null,
        height: fields.height ?? null,
        durationMs: fields.durationMs ?? null,
      })
      .where(eq(assets.id, id))
      .run();
    const row = tx.select().from(assets).where(eq(assets.id, id)).get();
    if (!row) throw new Error("AssetRepository.updateBytesWithin: asset row missing after update");
    return rowToAsset(row);
  }

  /** All assets owned by a given element. */
  listForElement(owningElementId: ElementId): Asset[] {
    return this.db
      .select()
      .from(assets)
      .where(eq(assets.owningElementId, owningElementId))
      .all()
      .map(rowToAsset);
  }

  /** All assets of a given kind owned by an element (e.g. a source's PDF). */
  listForElementByKind(owningElementId: ElementId, kind: AssetKind): Asset[] {
    return this.db
      .select()
      .from(assets)
      .where(and(eq(assets.owningElementId, owningElementId), eq(assets.kind, kind)))
      .all()
      .map(rowToAsset);
  }

  /**
   * Look up the FIRST asset by content hash (any-by-hash), or `null`. NOT
   * liveness-aware — it can return a row whose owning element has been hard-purged
   * (in practice unreachable, since the `assets.owning_element_id` FK cascades a
   * purge to the asset row). For the T059 dedup-on-write decision use
   * {@link findLiveByContentHash} instead, which joins `elements` to guarantee the
   * reused bytes belong to a still-reachable owner.
   */
  findByContentHash(contentHash: string): Asset | null {
    const row = this.db.select().from(assets).where(eq(assets.contentHash, contentHash)).get();
    return row ? rowToAsset(row) : null;
  }

  /**
   * The liveness-aware dedup lookup (T059): the first asset row with this content
   * hash whose owning `elements` row STILL EXISTS — i.e. reachable, NOT a phantom
   * row whose element is gone. This is what {@link AssetVaultService.importAsset}'s
   * content-hash dedup calls so the bytes it reuses are provably still referenced
   * by a live row (the owner may be soft-deleted-but-restorable — that row is still
   * present, so the file is still live and GC will not reclaim it).
   *
   * An INNER JOIN to `elements` enforces "the owning element exists": because the
   * `assets.owning_element_id` FK cascades a hard-purge to the asset row, a hash
   * row whose element is truly gone cannot exist today, so in practice this matches
   * {@link findByContentHash}; the explicit join makes the "LIVE asset" wording
   * backed by a signature and future-proofs it against any non-cascading delete.
   */
  findLiveByContentHash(contentHash: string): Asset | null {
    const row = this.db
      .select({ asset: assets })
      .from(assets)
      .innerJoin(elements, eq(assets.owningElementId, elements.id))
      .where(eq(assets.contentHash, contentHash))
      .get();
    return row ? rowToAsset(row.asset) : null;
  }

  /** Every asset row (for the vault integrity-verify + orphan-GC sweep, T059). */
  listAll(): Asset[] {
    return this.db.select().from(assets).all().map(rowToAsset);
  }

  /**
   * The set of `relative_path` values referenced by every live asset row UNDER A
   * GIVEN `vaultRoot` (T059) — an asset whose owning element row still exists
   * (`INNER JOIN elements`), which includes a soft-deleted-but-restorable owner (its
   * row is still present, so its file is still referenced). This is the file-centric
   * orphan GC's REFERENCE SET: a vault file is an orphan iff its canonical relative
   * path is NOT in this set.
   *
   * Keyed on the COMPOSITE `(vault_root, relative_path)` — the predicate filters to
   * the supplied `vaultRoot` (default `"assets"`, the only root that lives under
   * `assetsDir`) so a row in a DIFFERENT root (`exports`/`backups`) that happens to
   * share a `relative_path` with an `assets/` file can never falsely protect that
   * file from GC. The walk is scoped to one root's tree, so the reference set must be
   * scoped to the same root for an exact match. Today every asset row is
   * `vault_root = "assets"`, so this is precise rather than merely conservative.
   *
   * Consistent with the shared-path dedup policy in {@link AssetVaultService}: two
   * asset rows may share one `relative_path` (identical deduped bytes), so GC must
   * only reclaim a file when NO live asset row references its path — exactly what a
   * set-membership test answers. A path leaves this set only after the owning
   * element is HARD-purged (`TrashRepository.purge`/`emptyTrash`), which cascades
   * the asset row away while leaving the bytes on disk — that leftover file is the
   * orphan.
   */
  referencedRelativePaths(vaultRoot: VaultRoot = "assets"): Set<string> {
    const rows = this.db
      .select({ relativePath: assets.relativePath })
      .from(assets)
      .innerJoin(elements, eq(assets.owningElementId, elements.id))
      .where(eq(assets.vaultRoot, vaultRoot))
      .all();
    return new Set(rows.map((r) => r.relativePath));
  }
}
