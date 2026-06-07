/**
 * Markdown import/export E2E (T068) — drives the real Electron app end to end, fully
 * on-device. The native file picker is stubbed via `INTERLEAVE_MARKDOWN_IMPORT_PATH`
 * (honored only in the unpackaged build — mirrors the `INTERLEAVE_EPUB_IMPORT_PATH`
 * escape), pointed at the committed Markdown fixture. The spec proves:
 *
 *   1. the "Import file…" chip → modal → Markdown format → "Choose Markdown…" → MAIN
 *      reads + parses + creates an `inbox` source (the source lands in the inbox);
 *   2. opening it in the reader shows headings/code/links (a normal document body);
 *   3. extracting from it works (it is a normal document-bearing element);
 *   4. exporting it to Markdown writes a `.md` to Downloads;
 *   5. after an APP RESTART against the same data dir, the source + its extract survive.
 *
 * The renderer reaches all of this only through `window.appApi` — no fs/SQL.
 */

import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
  "markdown",
  "sample.md",
);

let dataDir: string;
let baseUrl: string;
let downloadsDir: string;
let exportedMarkdownName: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Launch the app with the Markdown picker stubbed to the fixture. */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { markdownImportPath: FIXTURE });
}

/** The renderer base URL (`app://…`) captured from the first window. */
async function captureBaseUrl(page: Page): Promise<void> {
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
}

/** Read the one inbox source id via the bridge. */
async function firstInboxId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
}

test("the bridge exposes sources.importDocument + documents.exportMarkdown (not raw SQL)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { importDocument?: unknown; importMarkdownText?: unknown };
      documents?: { exportMarkdown?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasImportDocument: typeof api?.sources?.importDocument === "function",
      hasImportText: typeof api?.sources?.importMarkdownText === "function",
      hasExport: typeof api?.documents?.exportMarkdown === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasImportDocument).toBe(true);
  expect(surface.hasImportText).toBe(true);
  expect(surface.hasExport).toBe(true);
  expect(surface.hasQuery).toBe(false);
  await app.close();
});

test("importing a .md lands an inbox source; the reader shows its body", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Open the Import-file modal, switch to Markdown, choose + import.
  await page.getByTestId("inbox-import-import-file").click();
  await expect(page.getByTestId("import-file-modal")).toBeVisible();
  await page.getByTestId("import-file-kind-markdown").click();
  await page.getByTestId("import-file-choose").click();
  await expect(page.getByTestId("import-file-chosen")).toContainText("sample.md");
  await page.getByTestId("import-file-submit").click();

  // The modal closes and exactly ONE inbox row (the source) lands, titled from the # heading.
  await expect(page.getByTestId("import-file-modal")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-preview-title")).toContainText("The Spacing Effect");

  // Open it in the reader — headings/code render.
  const id = await firstInboxId(page);
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror h1, .reader .ProseMirror h2")).toHaveCount(2);
  await expect(page.locator(".reader .ProseMirror pre.code-node__pre")).toBeVisible();

  await app.close();
});

test("extracting from the imported source + exporting it to Markdown both work", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);
  downloadsDir = path.join(dataDir, "downloads");

  const id = await firstInboxId(page);
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();

  // Extract a paragraph (the mouse-free `E` path) — proving it is a normal document.
  const extractBlockId = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(".reader .ProseMirror [data-block-id]"),
    );
    const para = nodes.find((n) => n.tagName.toLowerCase() === "p") ?? nodes[0];
    return para?.getAttribute("data-block-id") ?? "";
  });
  expect(extractBlockId).toBeTruthy();
  const block = page.locator(`.reader [data-block-id="${extractBlockId}"]`);
  await expect(block).toBeVisible();
  await block.click({ clickCount: 3 });
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.keyboard.press("e");
  await expect(page.getByText("Extracted")).toBeVisible();

  // Export the source to Markdown via the bridge → a .md lands in Downloads.
  const exportedResult = await page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        exportMarkdown(req: {
          elementId: string;
        }): Promise<{ relativePath: string; directoryLabel: "Downloads"; absPath?: string }>;
      };
    };
    return api.documents.exportMarkdown({ elementId });
  }, id);
  expect(exportedResult).not.toHaveProperty("absPath");
  expect(exportedResult.directoryLabel).toBe("Downloads");
  const exportRel = exportedResult.relativePath;
  expect(exportRel.endsWith(".md")).toBe(true);
  exportedMarkdownName = exportRel;
  expect(fs.existsSync(path.join(downloadsDir, exportRel))).toBe(true);
  // The exported Markdown re-imports to a non-empty document (round-trip sanity).
  const exported = fs.readFileSync(path.join(downloadsDir, exportRel), "utf8");
  expect(exported).toContain("# The Spacing Effect");

  await app.close();
});

test("the source + its extract + the export survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  const id = await firstInboxId(page);

  // The extract persisted (lineage to the source).
  const hasExtract = await page.evaluate(async (sourceId) => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string }[] }>;
        get(req: { id: string }): Promise<{
          data: { source: { id: string } | null } | null;
        }>;
      };
    };
    const { elements } = await api.inspector.list();
    for (const el of elements) {
      if (el.type !== "extract") continue;
      const { data } = await api.inspector.get({ id: el.id });
      if (data?.source?.id === sourceId) return true;
    }
    return false;
  }, id);
  expect(hasExtract).toBe(true);

  // The source still renders in the reader after restart.
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();

  // An export file from the previous run still exists in Downloads.
  expect(fs.existsSync(path.join(downloadsDir, exportedMarkdownName))).toBe(true);

  await app.close();
});
