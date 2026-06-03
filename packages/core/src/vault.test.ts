import { describe, expect, it } from "vitest";
import type { AssetId, ElementId } from "./ids";
import type { Asset, AssetLocation, LocalVaultPath } from "./vault";

describe("asset vault model shapes", () => {
  it("stores vault-relative locations and binary metadata without raw bytes", () => {
    const assetId = "asset" as AssetId;
    const vaultPath = {
      root: "assets",
      relativePath: "sources/source-1/original.pdf",
    } satisfies LocalVaultPath;
    const location = { assetId, vaultPath } satisfies AssetLocation;
    const asset = {
      id: assetId,
      owningElementId: "source-1" as ElementId,
      kind: "source_pdf",
      location,
      contentHash: "sha256:abc",
      mime: "application/pdf",
      size: 42,
      width: null,
      height: null,
      durationMs: null,
      createdAt: "2026-06-03T00:00:00.000Z",
    } satisfies Asset;

    expect(asset.location.vaultPath.root).toBe("assets");
    expect(asset.location.vaultPath.relativePath).not.toMatch(/^\/|\.\./);
    expect(asset.size).toBeGreaterThan(0);
  });
});
