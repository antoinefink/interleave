/**
 * AssetRepository GC/verify query tests (T059).
 *
 * Covers the read queries the vault integrity-verify + file-centric orphan GC rely
 * on: `findByContentHash` (any-by-hash), the liveness-aware `findLiveByContentHash`,
 * `referencedRelativePaths` (the GC reference set), `listAll`, and the upsert-by-path
 * pair (`findLiveByOwnerAndPath` + `updateBytesWithin`, which let a re-import to the
 * same owner+path refresh one row in place instead of duplicating). The load-bearing
 * GC-safety property is asserted directly: a soft-deleted-but-restorable owner keeps
 * its path REFERENCED (so its file is NOT an orphan), and only a HARD-purge (whose
 * cascade FK deletes the asset row) drops the path from the reference set — so the
 * leftover FILE becomes a GC candidate. There is no "asset row whose element is gone"
 * state to test: the cascade makes it unreachable.
 */

import type { AssetKind, ElementId, VaultRoot } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetRepository } from "./asset-repository";
import { ElementRepository } from "./element-repository";
import { createInMemoryDb } from "./test-db";
import { TrashRepository } from "./trash-query";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

/** Create a `source` element + one asset row owned by it (default `assets` root). */
function seedSourceWithAsset(input: {
  contentHash: string;
  relativePath: string;
  size?: number;
  vaultRoot?: VaultRoot;
  kind?: AssetKind;
}): {
  sourceId: ElementId;
  assetId: string;
} {
  const elements = new ElementRepository(handle.db);
  const assets = new AssetRepository(handle.db);
  const source = elements.create({
    type: "source",
    status: "inbox",
    stage: "raw_source",
    priority: 0.375,
    title: `source for ${input.relativePath}`,
  });
  const asset = assets.create({
    owningElementId: source.id,
    kind: input.kind ?? "source_html",
    vaultRoot: input.vaultRoot ?? "assets",
    relativePath: input.relativePath,
    contentHash: input.contentHash,
    mime: "text/html",
    size: input.size ?? 100,
  });
  return { sourceId: source.id, assetId: asset.id };
}

describe("AssetRepository — dedup/GC/verify queries (T059)", () => {
  it("findByContentHash returns an existing asset (any-by-hash) and null for an unknown hash", () => {
    const assets = new AssetRepository(handle.db);
    seedSourceWithAsset({ contentHash: "hash-a", relativePath: "sources/s1/original.html" });

    expect(assets.findByContentHash("hash-a")?.contentHash).toBe("hash-a");
    expect(assets.findByContentHash("nope")).toBeNull();
  });

  it("findLiveByContentHash returns the asset whose owning element still exists", () => {
    const assets = new AssetRepository(handle.db);
    const elements = new ElementRepository(handle.db);
    const { sourceId } = seedSourceWithAsset({
      contentHash: "hash-live",
      relativePath: "sources/s2/cleaned.html",
    });

    // Live owner → found.
    expect(assets.findLiveByContentHash("hash-live")?.contentHash).toBe("hash-live");
    // Soft-deleted-but-restorable owner → STILL found (the row is present).
    elements.softDelete(sourceId);
    expect(assets.findLiveByContentHash("hash-live")?.contentHash).toBe("hash-live");
    // Unknown hash → null.
    expect(assets.findLiveByContentHash("missing")).toBeNull();
  });

  it("findLiveByOwnerAndPath + updateBytesWithin upsert a re-imported same-path asset in place", () => {
    const assets = new AssetRepository(handle.db);
    const { sourceId, assetId } = seedSourceWithAsset({
      contentHash: "hash-v1",
      relativePath: "sources/sX/ocr/page-1.png",
      size: 100,
    });

    // The owner+path lookup finds the row (any-root default "assets").
    const found = assets.findLiveByOwnerAndPath(sourceId, "assets", "sources/sX/ocr/page-1.png");
    if (!found) throw new Error("expected the same-path asset row to be found");
    expect(found.id).toBe(assetId);
    // A different owner / path / root does NOT match.
    expect(
      assets.findLiveByOwnerAndPath(sourceId, "assets", "sources/sX/ocr/page-2.png"),
    ).toBeNull();

    // Update bytes-metadata in place → SAME id, refreshed hash/size, still one row.
    const updated = handle.db.transaction((tx) =>
      assets.updateBytesWithin(tx, found.id, {
        contentHash: "hash-v2",
        mime: "image/png",
        size: 250,
      }),
    );
    expect(updated.id).toBe(assetId);
    expect(updated.contentHash).toBe("hash-v2");
    expect(updated.size).toBe(250);
    expect(assets.listForElement(sourceId)).toHaveLength(1);
    expect(assets.findById(found.id)?.contentHash).toBe("hash-v2");
  });

  it("referencedRelativePaths includes a soft-deleted-but-restorable owner's path (NOT an orphan)", () => {
    const assets = new AssetRepository(handle.db);
    const elements = new ElementRepository(handle.db);
    const { sourceId } = seedSourceWithAsset({
      contentHash: "hash-soft",
      relativePath: "sources/s3/original.html",
    });

    expect(assets.referencedRelativePaths().has("sources/s3/original.html")).toBe(true);
    // Soft-delete keeps the asset row LIVE — its path stays referenced, so its file
    // would NOT be reclaimed by GC (the element is restorable from the Trash).
    elements.softDelete(sourceId);
    expect(assets.referencedRelativePaths().has("sources/s3/original.html")).toBe(true);
  });

  it("after a HARD-purge the cascade deletes the asset row, so its path leaves the reference set", () => {
    const assets = new AssetRepository(handle.db);
    const elements = new ElementRepository(handle.db);
    const trash = new TrashRepository(handle.db);
    const { sourceId } = seedSourceWithAsset({
      contentHash: "hash-purge",
      relativePath: "sources/s4/cleaned.html",
    });

    // Soft-delete first (the only way into the Trash), then hard-purge.
    elements.softDelete(sourceId);
    expect(trash.purge(sourceId)).toBe(true);

    // The cascade FK deleted the asset ROW (no dangling-row state is reachable);
    // its path is now ABSENT from the reference set, so its leftover FILE is an
    // orphan GC candidate.
    expect(assets.referencedRelativePaths().has("sources/s4/cleaned.html")).toBe(false);
    // The asset row itself is gone (the cascade deleted it) — no dangling row.
    expect(assets.findByContentHash("hash-purge")).toBeNull();
  });

  it("listAll returns every asset row (the verify/GC iteration source)", () => {
    const assets = new AssetRepository(handle.db);
    seedSourceWithAsset({ contentHash: "h1", relativePath: "sources/a/original.html" });
    seedSourceWithAsset({ contentHash: "h2", relativePath: "sources/b/original.html" });

    const all = assets.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.location.vaultPath.relativePath).sort()).toEqual([
      "sources/a/original.html",
      "sources/b/original.html",
    ]);
  });

  it("two live owners sharing one relative_path keep that path referenced until BOTH are purged", () => {
    const assets = new AssetRepository(handle.db);
    const elements = new ElementRepository(handle.db);
    const trash = new TrashRepository(handle.db);

    // Two distinct elements pointing at the SAME shared file (the dedup policy).
    const shared = "media/shared/original.bin";
    const a = seedSourceWithAsset({ contentHash: "shared", relativePath: shared });
    const b = seedSourceWithAsset({ contentHash: "shared", relativePath: shared });

    expect(assets.referencedRelativePaths().has(shared)).toBe(true);
    // Purge ONE owner — the path is still referenced by the other live row.
    elements.softDelete(a.sourceId);
    expect(trash.purge(a.sourceId)).toBe(true);
    expect(assets.referencedRelativePaths().has(shared)).toBe(true);
    // Purge the second — now NO live row references it; the file is an orphan.
    elements.softDelete(b.sourceId);
    expect(trash.purge(b.sourceId)).toBe(true);
    expect(assets.referencedRelativePaths().has(shared)).toBe(false);
  });

  it("referencedRelativePaths is keyed on (vault_root, relative_path): a same-path row in another root does not protect the assets/ file", () => {
    const assets = new AssetRepository(handle.db);
    // Two rows sharing one relative_path but under DIFFERENT vault roots. Only the
    // `assets`-rooted file lives under `assetsDir` and is subject to the vault walk.
    const shared = "shared/collision.bin";
    seedSourceWithAsset({ contentHash: "in-assets", relativePath: shared, vaultRoot: "assets" });
    seedSourceWithAsset({
      contentHash: "in-exports",
      relativePath: shared,
      vaultRoot: "exports",
      kind: "export",
    });

    // The `assets`-scoped set contains the path (an `assets` row references it).
    expect(assets.referencedRelativePaths("assets").has(shared)).toBe(true);
    // The `exports`-scoped set ALSO contains it — but scoped to its own root.
    expect(assets.referencedRelativePaths("exports").has(shared)).toBe(true);

    // Now drop ONLY the `assets`-rooted row (hard-purge its owner). The `exports`
    // row still exists, but it must NOT keep the assets/ path referenced — i.e. the
    // assets/-scoped set no longer contains it, so the assets/ file is a GC orphan.
    const elements = new ElementRepository(handle.db);
    const trash = new TrashRepository(handle.db);
    const assetsRow = assets.listAll().find((a) => a.location.vaultPath.root === "assets");
    expect(assetsRow).toBeDefined();
    const ownerId = assetsRow?.owningElementId;
    expect(ownerId).toBeDefined();
    if (ownerId) {
      elements.softDelete(ownerId);
      expect(trash.purge(ownerId)).toBe(true);
    }

    // The assets/-scoped reference set no longer protects the path, even though the
    // exports/ row with the SAME relative_path is still live.
    expect(assets.referencedRelativePaths("assets").has(shared)).toBe(false);
    expect(assets.referencedRelativePaths("exports").has(shared)).toBe(true);
  });
});
