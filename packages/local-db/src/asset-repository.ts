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
import { assets, type InterleaveDatabase } from "@interleave/db";
import { and, eq } from "drizzle-orm";
import { newAssetId, nowIso } from "./ids";
import { rowToAsset } from "./mappers";

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

  /** Insert asset metadata and return the domain {@link Asset}. */
  create(input: CreateAssetInput): Asset {
    const id = newAssetId();
    const createdAt = nowIso();
    this.db
      .insert(assets)
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
    const row = this.db.select().from(assets).where(eq(assets.id, id)).get();
    if (!row) throw new Error("AssetRepository.create: asset row missing after insert");
    return rowToAsset(row);
  }

  /** Fetch one asset by id, or `null`. */
  findById(id: AssetId): Asset | null {
    const row = this.db.select().from(assets).where(eq(assets.id, id)).get();
    return row ? rowToAsset(row) : null;
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

  /** Look up an asset by content hash (dedup / integrity), or `null`. */
  findByContentHash(contentHash: string): Asset | null {
    const row = this.db.select().from(assets).where(eq(assets.contentHash, contentHash)).get();
    return row ? rowToAsset(row) : null;
  }
}
