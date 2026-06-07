/**
 * DocumentImportService integration tests (T068) — against a real temp-file SQLite DB
 * + temp `assetsDir`/download export dir, pointing at the committed Markdown/HTML fixtures
 * (`@interleave/importers/src/__fixtures__`). No Electron — the service is built
 * through `DbService` (the same accessor the IPC layer uses).
 *
 * Proves: a `.md` file import creates an `inbox` source whose body parses to the
 * expected constrained nodes + the right ops; a `.html` file import reuses the
 * sanitize/HTML→PM path AND writes `original.html` to the vault; pasted Markdown
 * imports without a file; `exportToMarkdown` writes a `.md` to the injected export dir whose
 * content re-imports to an equivalent doc (the round-trip end-to-end through the DB);
 * and the imported source survives re-opening the DB (restart-persistence).
 */

import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { markdownToProseMirrorDoc } from "@interleave/importers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";
import { DocumentImportError } from "./document-import-service";

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
const MD_FIXTURE = path.join(FIXTURES, "markdown", "sample.md");
const HTML_FIXTURE = path.join(FIXTURES, "html", "sample.html");

let dir: string;
let dbPath: string;
let assetsDir: string;
let exportDestinationDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-docimp-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  exportDestinationDir = path.join(dir, "downloads");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(exportDestinationDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openSvc(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir, exportDestinationDir });
  return svc;
}

/** Walk a stored doc's node-type names. */
function nodeTypes(doc: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (n: Record<string, unknown>): void => {
    out.add(n.type as string);
    for (const c of (n.content ?? []) as Record<string, unknown>[]) walk(c);
  };
  walk(doc as Record<string, unknown>);
  return out;
}

describe("DocumentImportService.importFromFile (Markdown)", () => {
  it("imports a .md into an inbox source with the right nodes + ops", async () => {
    const svc = openSvc();
    const result = await svc.documentImportService.importFromFile({
      absPath: MD_FIXTURE,
      format: "markdown",
    });
    expect(result.status).toBe("imported");
    expect(result.item.status).toBe("inbox");
    expect(result.item.type).toBe("source");

    const id = result.id;
    const src = svc.repos.sources.findById(id as never);
    // The title comes from the first `# heading`.
    expect(src?.element.title).toBe("The Spacing Effect");
    // Non-dominating default priority.
    expect(src?.element.priority).toBeLessThan(0.75);

    const doc = svc.repos.documents.findById(id as never);
    const types = nodeTypes(doc?.prosemirrorJson);
    expect(types.has("heading")).toBe(true);
    expect(types.has("bulletList")).toBe(true);
    expect(types.has("blockquote")).toBe(true);
    expect(types.has("codeBlock")).toBe(true);
    // Stable blocks were written.
    expect(svc.repos.documents.listBlocks(id as never).length).toBeGreaterThan(0);

    const ops = svc.repos.operationLog.listForElement(id as never).map((e) => e.opType);
    expect(ops).toContain("create_element");
    expect(ops).toContain("create_source");
    expect(ops).toContain("update_document");
    svc.close();
  });
});

describe("DocumentImportService.importFromFile (HTML)", () => {
  it("imports a .html into an inbox source + stores original.html in the vault", async () => {
    const svc = openSvc();
    const result = await svc.documentImportService.importFromFile({
      absPath: HTML_FIXTURE,
      format: "html",
    });
    const id = result.id;
    const src = svc.repos.sources.findById(id as never);
    // The title comes from the HTML <title>.
    expect(src?.element.title).toBe("An HTML Note");
    expect(src?.source.snapshotKey).toBe(`sources/${id}/original.html`);

    // The original .html lives in the vault as a source_html asset.
    expect(fs.existsSync(path.join(assetsDir, "sources", id, "original.html"))).toBe(true);
    const assets = svc.repos.assets.listForElement(id as never);
    expect(assets.some((a) => a.kind === "source_html")).toBe(true);

    // Scripts/styles were sanitized away; the link survived.
    const doc = svc.repos.documents.findById(id as never);
    expect(doc?.plainText).not.toContain("alert");
    expect(doc?.plainText).not.toContain("color: red");
    const types = nodeTypes(doc?.prosemirrorJson);
    expect(types.has("heading")).toBe(true);
    expect(types.has("bulletList")).toBe(true);
    svc.close();
  });
});

describe("DocumentImportService.importFromText (paste path)", () => {
  it("imports pasted Markdown without a file", async () => {
    const svc = openSvc();
    const result = await svc.documentImportService.importFromText({
      text: "# Pasted\n\nA **bold** line.\n",
      priority: "B",
    });
    const src = svc.repos.sources.findById(result.id as never);
    expect(src?.element.title).toBe("Pasted");
    expect(svc.repos.documents.listBlocks(result.id as never).length).toBeGreaterThan(0);
    svc.close();
  });

  it("rejects empty pasted Markdown with a typed error", async () => {
    const svc = openSvc();
    await expect(
      svc.documentImportService.importFromText({ text: "   \n " }),
    ).rejects.toBeInstanceOf(DocumentImportError);
    svc.close();
  });
});

describe("DocumentImportService.exportToMarkdown (round-trip through the DB)", () => {
  it("exports a .md to the injected export directory whose content re-imports to an equivalent doc", async () => {
    const svc = openSvc();
    const imported = await svc.documentImportService.importFromFile({
      absPath: MD_FIXTURE,
      format: "markdown",
    });
    const exportResult = await svc.documentImportService.exportToMarkdown({
      elementId: imported.id as never,
    });
    // The file landed in the main-process injected export directory.
    expect(fs.existsSync(exportResult.absPath)).toBe(true);
    expect(exportResult.relativePath.endsWith(".md")).toBe(true);
    expect(exportResult.absPath.startsWith(exportDestinationDir)).toBe(true);

    // Exporting is read-only — no op-log entry was appended for the export.
    const opsAfterImport = svc.repos.operationLog
      .listForElement(imported.id as never)
      .map((e) => e.opType);
    // (create_element/create_source/update_document only — no extra mutation op.)
    expect(opsAfterImport.filter((o) => o === "update_document")).toHaveLength(1);

    // The exported Markdown re-imports to a doc structurally equal to the stored one
    // (modulo block ids). Compare node-type sequences as a structural proxy.
    const storedDoc = svc.repos.documents.findById(imported.id as never)?.prosemirrorJson;
    const exportedMd = readFileSync(exportResult.absPath, "utf8");
    const reimported = markdownToProseMirrorDoc(exportedMd).doc;
    expect([...nodeTypes(reimported)].sort()).toEqual([...nodeTypes(storedDoc)].sort());
    svc.close();
  });

  it("DbService exportMarkdown returns display-safe metadata only", async () => {
    const svc = openSvc();
    const imported = await svc.documentImportService.importFromFile({
      absPath: MD_FIXTURE,
      format: "markdown",
    });
    const result = await svc.exportMarkdown({ elementId: imported.id as never });
    expect(result.relativePath.endsWith(".md")).toBe(true);
    expect(result.directoryLabel).toBe("Downloads");
    expect(result).not.toHaveProperty("absPath");
    svc.close();
  });
});

describe("restart-persistence", () => {
  it("the imported source survives re-opening the DB", async () => {
    const svc = openSvc();
    const { id } = await svc.documentImportService.importFromFile({
      absPath: MD_FIXTURE,
      format: "markdown",
    });
    svc.close();

    const reopened = openSvc();
    const src = reopened.repos.sources.findById(id as never);
    expect(src?.element.title).toBe("The Spacing Effect");
    expect(reopened.repos.documents.listBlocks(id as never).length).toBeGreaterThan(0);
    reopened.close();
  });
});
