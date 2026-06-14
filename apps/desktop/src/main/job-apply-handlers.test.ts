import { describe, expect, it, vi } from "vitest";
import { createJobApplyHandlers } from "./job-apply-handlers";

function makeJob(type: string, payload: unknown = {}) {
  return {
    id: `job-${type}`,
    type,
    payload,
    status: "running",
    progress: { ratio: 0 },
    attempts: 1,
    maxAttempts: 3,
    error: null,
    result: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as never;
}

describe("createJobApplyHandlers", () => {
  it("delegates ai, embed, and ocr worker results to their main-owned services", async () => {
    const ai = { applyResult: vi.fn(() => ({ id: "ai-1" })) };
    const embedding = { applyResult: vi.fn(() => ({ stored: true })) };
    const ocr = { applyResult: vi.fn(async () => ({ page: 1, status: "suggested" })) };
    const handlers = createJobApplyHandlers({
      getUrlImportService: () => ({}) as never,
      getAssetVaultService: () => ({}) as never,
      getOcrService: () => ocr as never,
      getEmbeddingService: () => embedding as never,
      getAiService: () => ai as never,
    });
    const aiHandler = handlers.ai;
    const embedHandler = handlers.embed;
    const ocrHandler = handlers.ocr;
    if (!aiHandler || !embedHandler || !ocrHandler) throw new Error("missing apply handler");

    expect(aiHandler(makeJob("ai", { request: "draft" }), { text: "suggestion" })).toEqual({
      id: "ai-1",
    });
    expect(embedHandler(makeJob("embed", { persist: true }), { vector: [0.1] })).toEqual({
      stored: true,
    });
    await expect(ocrHandler(makeJob("ocr", { page: 1 }), { text: "ocr" })).resolves.toEqual({
      page: 1,
      status: "suggested",
    });

    expect(ai.applyResult).toHaveBeenCalledWith({ request: "draft" }, { text: "suggestion" });
    expect(embedding.applyResult).toHaveBeenCalledWith(
      { persist: true },
      { vector: [0.1] },
      "job-embed",
    );
    expect(ocr.applyResult).toHaveBeenCalledWith({ page: 1 }, { text: "ocr" });
  });

  it("keeps fsrs optimization side-effect free and maps vault sweeps to renderer-safe JSON", async () => {
    const assetVault = {
      verifyIntegrity: vi.fn(async () => ({
        ok: 2,
        mismatched: ["asset-bad"],
        missing: ["asset-missing"],
        extraFiles: ["stray.bin"],
      })),
      findOrphans: vi.fn(async () => ({
        orphans: [{ relativePath: "old.bin", size: 12 }],
        totalBytes: 12,
      })),
    };
    const handlers = createJobApplyHandlers({
      getUrlImportService: () => ({}) as never,
      getAssetVaultService: () => assetVault as never,
      getOcrService: () => ({}) as never,
      getEmbeddingService: () => ({}) as never,
      getAiService: () => ({}) as never,
    });
    const optimizeHandler = handlers.fsrs_optimize;
    const vaultVerifyHandler = handlers.vault_verify;
    const vaultGcHandler = handlers.vault_gc;
    if (!optimizeHandler || !vaultVerifyHandler || !vaultGcHandler) {
      throw new Error("missing apply handler");
    }

    const suggestion = { params: [1, 2, 3], sufficientData: true };
    expect(optimizeHandler(makeJob("fsrs_optimize"), suggestion)).toBe(suggestion);
    await expect(vaultVerifyHandler(makeJob("vault_verify"), null)).resolves.toEqual({
      ok: 2,
      mismatched: ["asset-bad"],
      missing: ["asset-missing"],
      extraFiles: ["stray.bin"],
    });
    await expect(vaultGcHandler(makeJob("vault_gc"), null)).resolves.toEqual({
      orphans: [{ relativePath: "old.bin", size: 12 }],
      totalBytes: 12,
    });
  });

  it("applies fetched URL-import HTML through the shared import service using finalUrl as canonical", async () => {
    const urlImport = {
      importFromHtml: vi.fn(async () => ({
        status: "imported" as const,
        id: "source-1",
        item: { title: "Fetched" },
      })),
    };
    const handlers = createJobApplyHandlers({
      getUrlImportService: () => urlImport as never,
      getAssetVaultService: () => ({}) as never,
      getOcrService: () => ({}) as never,
      getEmbeddingService: () => ({}) as never,
      getAiService: () => ({}) as never,
    });
    const urlImportHandler = handlers.url_import;
    if (!urlImportHandler) throw new Error("missing url_import apply handler");

    await expect(
      urlImportHandler(
        makeJob("url_import", {
          url: "https://example.com/original",
          priority: "A",
          reasonAdded: "high value",
          forceNewVersion: true,
        }),
        { html: "<article>Fetched</article>", finalUrl: "https://example.com/final" },
      ),
    ).resolves.toEqual({
      status: "imported",
      id: "source-1",
      item: { title: "Fetched" },
    });

    expect(urlImport.importFromHtml).toHaveBeenCalledWith({
      url: "https://example.com/final",
      originalUrl: "https://example.com/original",
      html: "<article>Fetched</article>",
      priority: "A",
      reasonAdded: "high value",
      forceNewVersion: true,
      // T126: the URL background runner stamps capture origin `url`.
      capturedVia: "url",
    });
  });
});
