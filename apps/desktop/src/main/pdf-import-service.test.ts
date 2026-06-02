/**
 * PdfImportService integration tests (T064) — against a real temp-file SQLite DB +
 * a temp `assetsDir`, pointing `importFromFile` at the committed fixture PDFs
 * (`@interleave/importers/src/__fixtures__`). No Electron is involved — the service
 * is constructed through `DbService` (the same accessor the IPC layer uses).
 *
 * Proves: a successful import writes `sources/<id>/original.pdf` under the vault,
 * records a `source_pdf` asset whose contentHash matches the file, creates an
 * `inbox` source whose `snapshotKey` is the PDF path and whose body parses to the
 * page headings/paragraphs with per-block pages, and appends `create_source` +
 * `update_document` ops; the source + provenance + body + page-tagged blocks + the
 * PDF asset row survive re-opening the DB on the same file (restart-persistence);
 * and the error paths (non-PDF / encrypted-style unreadable) throw the typed
 * `PdfImportError` and leave NO source row + NO partial vault dir.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssetVaultService } from "./asset-vault-service";
import { DbService } from "./db-service";
import { PdfImportError } from "./pdf-import-service";

const FIXTURES = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
);

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-pdfimp-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openSvc(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir });
  return svc;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("PdfImportService.importFromFile", () => {
  it("imports a 2-page text PDF into an inbox source with a vault PDF + page-tagged body", async () => {
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "two-page-text.pdf");
    const { id, item } = await svc.pdfImportService.importFromFile({ filePath: fixture });

    expect(item.status).toBe("inbox");
    expect(item.type).toBe("source");

    // The original PDF lives in the vault.
    const pdfRel = path.join("sources", id, "original.pdf");
    const pdfAbs = path.join(assetsDir, pdfRel);
    expect(fs.existsSync(pdfAbs)).toBe(true);

    // A `source_pdf` asset row whose contentHash matches the file bytes.
    const assets = svc.repos.assets.listForElement(id as never);
    const pdfAsset = assets.find((a) => a.kind === "source_pdf");
    expect(pdfAsset).toBeDefined();
    expect(pdfAsset?.contentHash).toBe(sha256File(fixture));
    expect(pdfAsset?.location.vaultPath.relativePath).toBe(`sources/${id}/original.pdf`);

    // The source's snapshotKey is the PDF; the body parses to page headings + paras.
    const source = svc.repos.sources.findById(id as never);
    expect(source?.source.snapshotKey).toBe(`sources/${id}/original.pdf`);
    const blocks = svc.repos.documents.listBlocks(id as never);
    const headings = blocks.filter((b) => b.blockType === "heading");
    expect(headings).toHaveLength(2);
    expect(headings.map((b) => b.page)).toEqual([1, 2]);
    expect(blocks.every((b) => b.page === 1 || b.page === 2)).toBe(true);

    // The create_source + update_document ops were appended.
    const ops = svc.repos.operationLog.listForElement(id as never).map((e) => e.opType);
    expect(ops).toContain("create_source");
    expect(ops).toContain("update_document");

    // getDocument flags it as a PDF + exposes the block→page map.
    const docResult = svc.getDocument({ elementId: id });
    expect(docResult.sourceFormat).toBe("pdf");
    expect(Object.values(docResult.blockPages)).toContain(1);
    expect(Object.values(docResult.blockPages)).toContain(2);

    svc.close();
  });

  it("survives re-opening the DB on the same file (restart-persistence)", async () => {
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "two-page-text.pdf");
    const { id } = await svc.pdfImportService.importFromFile({ filePath: fixture });
    svc.close();

    const reopened = openSvc();
    const source = reopened.repos.sources.findById(id as never);
    expect(source?.source.snapshotKey).toBe(`sources/${id}/original.pdf`);
    const blocks = reopened.repos.documents.listBlocks(id as never);
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((b) => b.page === 2)).toBe(true);
    const assets = reopened.repos.assets.listForElement(id as never);
    expect(assets.some((a) => a.kind === "source_pdf")).toBe(true);
    expect(fs.existsSync(path.join(assetsDir, "sources", id, "original.pdf"))).toBe(true);
    reopened.close();
  });

  it("imports a scanned/no-text PDF without crashing + notes the OCR target", async () => {
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "scanned-no-text.pdf");
    const { id } = await svc.pdfImportService.importFromFile({ filePath: fixture });
    const source = svc.repos.sources.findById(id as never);
    // The "no embedded text" note is recorded so the user (and T066) knows to OCR.
    expect(source?.source.reasonAdded).toContain("OCR");
    const blocks = svc.repos.documents.listBlocks(id as never);
    // Only page headings, no body paragraphs.
    expect(blocks.every((b) => b.blockType === "heading")).toBe(true);
    svc.close();
  });

  it("rejects a non-PDF file with code 'not_pdf' and writes no source / no vault dir", async () => {
    const svc = openSvc();
    const notPdf = path.join(dir, "not.pdf");
    fs.writeFileSync(notPdf, "this is plain text, not a PDF");
    const before = svc.listInbox().items.length;
    await expect(svc.pdfImportService.importFromFile({ filePath: notPdf })).rejects.toMatchObject({
      code: "not_pdf",
    });
    expect(svc.listInbox().items.length).toBe(before);
    // No `sources/` dir was left behind for a failed import.
    const sourcesDir = path.join(assetsDir, "sources");
    const entries = fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir) : [];
    expect(entries).toHaveLength(0);
    svc.close();
  });

  it("soft-deletes the orphan source if the vault PDF import fails after the row commits", async () => {
    const svc = openSvc();
    const fixture = path.join(FIXTURES, "two-page-text.pdf");
    const before = svc.listInbox().items.length;

    // Force step 5 (importAsset) to fail AFTER the source row + body committed in
    // step 4 — the partial-import case the catch must undo (e.g. disk full).
    const spy = vi
      .spyOn(AssetVaultService.prototype, "importAsset")
      .mockRejectedValueOnce(new Error("disk full"));

    await expect(svc.pdfImportService.importFromFile({ filePath: fixture })).rejects.toThrow(
      "disk full",
    );
    spy.mockRestore();

    // The orphan source was soft-deleted: the inbox is back to its prior count and
    // no live source dangles with a snapshotKey pointing at a PDF that never landed.
    expect(svc.listInbox().items.length).toBe(before);
    const sourcesDir = path.join(assetsDir, "sources");
    const entries = fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir) : [];
    expect(entries).toHaveLength(0);
    svc.close();
  });

  it("rejects an oversize PDF with code 'too_large'", async () => {
    const svc = openSvc();
    // A file that starts with %PDF- but exceeds the 200 MB cap would be slow to
    // create; instead point the size check at a sparse file via truncate.
    const big = path.join(dir, "big.pdf");
    const fd = fs.openSync(big, "w");
    fs.writeSync(fd, "%PDF-1.4\n");
    fs.ftruncateSync(fd, 201 * 1024 * 1024);
    fs.closeSync(fd);
    await expect(svc.pdfImportService.importFromFile({ filePath: big })).rejects.toBeInstanceOf(
      PdfImportError,
    );
    await expect(svc.pdfImportService.importFromFile({ filePath: big })).rejects.toMatchObject({
      code: "too_large",
    });
    svc.close();
  });
});
