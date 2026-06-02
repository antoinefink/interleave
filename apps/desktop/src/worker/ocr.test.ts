/**
 * Worker OCR config + path-resolver unit tests (T066).
 *
 * The load-bearing OFFLINE invariant is asserted DIRECTLY here (the E2E proves
 * the real WASM worker recognizes text; this proves the worker is configured to
 * never reach a CDN): `offlineTesseractPaths` resolves the engine/core/langdata
 * to LOCAL staged paths under the bundle's resources dir — never an `http(s)`/CDN
 * URL — and disables the cache (`cacheMethod: "none"`), so a network fetch is
 * impossible by construction. `resolveVaultImagePath` is also covered (the
 * worker resolves the persisted vault-RELATIVE page path against `assetsDir`,
 * rejecting `..` traversal).
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { offlineTesseractPaths, resolveVaultImagePath } from "./ocr";

describe("offlineTesseractPaths (T066 — offline by construction)", () => {
  const stageDir = path.join("/tmp", "app", "dist", "resources", "tesseract");
  const cfg = offlineTesseractPaths(stageDir);

  it("disables the CDN cache (fully offline)", () => {
    expect(cfg.cacheMethod).toBe("none");
  });

  it("resolves the worker/core/lang paths LOCALLY under the staged dir — never a CDN URL", () => {
    for (const p of [cfg.workerPath, cfg.corePath, cfg.langPath]) {
      // Local absolute path under the staged resources dir — NOT a remote URL.
      expect(p.startsWith(stageDir)).toBe(true);
      expect(/^https?:\/\//.test(p)).toBe(false);
      expect(p.includes("://")).toBe(false);
    }
    // The staged engine + WASM core come from the bundled tree, not a CDN.
    expect(cfg.workerPath).toContain(path.join("tesseract.js", "src", "worker-script", "node"));
    expect(cfg.corePath).toContain("tesseract.js-core");
    expect(cfg.langPath).toBe(path.join(stageDir, "lang"));
  });
});

describe("resolveVaultImagePath (T066)", () => {
  const assetsDir = path.join("/tmp", "vault", "assets");

  it("joins a POSIX vault-relative page path against the assets root", () => {
    expect(resolveVaultImagePath(assetsDir, "sources/s1/ocr/page-3.png")).toBe(
      path.join(assetsDir, "sources", "s1", "ocr", "page-3.png"),
    );
  });

  it("strips `..` traversal segments so the path stays inside the vault", () => {
    const resolved = resolveVaultImagePath(assetsDir, "../../etc/passwd");
    expect(resolved).toBe(path.join(assetsDir, "etc", "passwd"));
    expect(resolved.startsWith(assetsDir)).toBe(true);
  });
});
