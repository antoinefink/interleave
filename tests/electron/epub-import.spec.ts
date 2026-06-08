/**
 * EPUB import E2E (T067) — drives the real Electron app end to end, fully on-device.
 *
 * The native file picker is stubbed via `INTERLEAVE_EPUB_IMPORT_PATH` (honored only
 * in the unpackaged build — mirrors the `INTERLEAVE_PDF_IMPORT_PATH` escape), pointed
 * at the committed EPUB3 fixture (3 chapters, one with a footnote). The spec proves:
 *
 *   1. the "Import file…" chip → modal → "Choose EPUB…" → MAIN reads + validates +
 *      streams `original.epub` into the vault + parses the book + creates an `inbox`
 *      book `source` (the book, NOT N rows, lands in the inbox);
 *   2. the book hangs 3 chapter `topic`s under it (`parent_child`, book = `sourceId`);
 *   3. opening a chapter in the source reader, it reads INCREMENTALLY like any source:
 *      a read-point is set on it AND a text extract is created from it (proving a
 *      chapter is a normal document-bearing element);
 *   4. after an APP RESTART against the same data dir, the book, its chapters, the
 *      read-point, the extract, and the `.epub` snapshot all survive.
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
  "epub",
  "epub3-three-chapters.epub",
);

let dataDir: string;
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Launch the app with the EPUB picker stubbed to the fixture. */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { epubImportPath: FIXTURE });
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

/** The chapter topic ids hanging under the book, via the bridge. */
async function chapterIds(page: Page, bookId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string }[] }>;
        get(req: { id: string }): Promise<{
          data: { source: { id: string } | null } | null;
        }>;
      };
    };
    const { elements } = await api.inspector.list();
    const out: string[] = [];
    for (const el of elements) {
      if (el.type !== "topic") continue;
      const { data } = await api.inspector.get({ id: el.id });
      if (data?.source?.id === id) out.push(el.id);
    }
    return out;
  }, bookId);
}

test("the bridge exposes sources.pickImportFile + importEpub (not raw SQL)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { pickImportFile?: unknown; importEpub?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasPick: typeof api?.sources?.pickImportFile === "function",
      hasImportEpub: typeof api?.sources?.importEpub === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasPick).toBe(true);
  expect(surface.hasImportEpub).toBe(true);
  expect(surface.hasQuery).toBe(false);
  await app.close();
});

test("importing an EPUB lands a book source with chapter topics under it", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Open the Import-file modal via the "Import file" chip, then choose + import.
  await page.getByTestId("inbox-import-import-file").click();
  await expect(page.getByTestId("import-file-modal")).toBeVisible();
  await page.getByTestId("import-file-choose").click();
  // The stubbed picker resolves the fixture path; the chosen filename shows.
  await expect(page.getByTestId("import-file-chosen")).toContainText("epub3-three-chapters.epub");
  await page.getByTestId("import-file-submit").click();

  // The modal closes and exactly ONE inbox row (the book) lands.
  await expect(page.getByTestId("import-file-modal")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-preview-title")).toContainText("The Memory Book");

  // The original.epub is in the vault.
  const bookId = await firstInboxId(page);
  expect(fs.existsSync(path.join(dataDir, "assets", "sources", bookId, "original.epub"))).toBe(
    true,
  );

  // Three chapter topics hang under the book.
  const chapters = await chapterIds(page, bookId);
  expect(chapters).toHaveLength(3);

  await app.close();
});

test("a chapter opens in the reader + reads incrementally (read-point + extract)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  const bookId = await firstInboxId(page);
  const chapters = await chapterIds(page, bookId);
  expect(chapters.length).toBe(3);
  const chapterId = chapters[0] as string;

  // Open the chapter in the source reader — it is a normal document-bearing element.
  await page.goto(`${baseUrl}/source/${chapterId}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();

  // Set a read-point on the chapter's first block.
  const blocks = page.locator(".reader .ProseMirror [data-block-id]");
  await expect(blocks.first()).toBeVisible();
  await blocks.first().click();
  await page.getByTestId("reader-set-readpoint").click();
  const readPoint = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      readPoints: {
        get(req: { elementId: string }): Promise<{ readPoint: { blockId: string } | null }>;
      };
    };
    return (await api.readPoints.get({ elementId: id })).readPoint;
  }, chapterId);
  expect(readPoint).not.toBeNull();

  // Extract a paragraph from the chapter. EPUB chapters are document-bearing
  // topic children: extraction anchors to the chapter while lineage roots at the
  // imported book source.
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
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.getByTestId("sel-tool-extract").click();
  await expect(page.getByTestId("reader-flash")).toContainText("Extracted");

  // The new extract is rooted at the EPUB book source and anchored to the chapter
  // document location.
  const extract = await page.evaluate(async ({ chId, sourceId }) => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string }[] }>;
        get(req: { id: string }): Promise<{
          data: {
            location: { sourceElementId: string | null } | null;
            source: { id: string } | null;
          } | null;
        }>;
      };
    };
    const { elements } = await api.inspector.list();
    for (const el of elements) {
      if (el.type !== "extract") continue;
      const { data } = await api.inspector.get({ id: el.id });
      if (data?.location?.sourceElementId === chId && data.source?.id === sourceId) {
        return { id: el.id, ok: true };
      }
    }
    return null;
  }, { chId: chapterId, sourceId: bookId });
  expect(extract?.ok).toBe(true);

  await app.close();
});

test("the book, chapters, read-point, extract + .epub survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await captureBaseUrl(page);

  // Still ONE inbox book after restart, with its .epub on disk.
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  const bookId = await firstInboxId(page);
  expect(fs.existsSync(path.join(dataDir, "assets", "sources", bookId, "original.epub"))).toBe(
    true,
  );

  // The 3 chapters + the read-point + the chapter extract persisted.
  const chapters = await chapterIds(page, bookId);
  expect(chapters).toHaveLength(3);

  const state = await page.evaluate(async ({ chIds, sourceId }) => {
    const api = window.appApi as unknown as {
      readPoints: { get(req: { elementId: string }): Promise<{ readPoint: unknown | null }> };
      inspector: {
        list(): Promise<{ elements: { id: string; type: string }[] }>;
        get(req: { id: string }): Promise<{
          data: {
            location: { sourceElementId: string | null } | null;
            source: { id: string } | null;
          } | null;
        }>;
      };
    };
    let hasReadPoint = false;
    for (const id of chIds) {
      const { readPoint } = await api.readPoints.get({ elementId: id });
      if (readPoint) hasReadPoint = true;
    }
    const { elements } = await api.inspector.list();
    let hasChapterExtract = false;
    for (const el of elements) {
      if (el.type !== "extract") continue;
      const { data } = await api.inspector.get({ id: el.id });
      if (
        data?.location?.sourceElementId &&
        chIds.includes(data.location.sourceElementId) &&
        data.source?.id === sourceId
      ) {
        hasChapterExtract = true;
      }
    }
    return { hasReadPoint, hasChapterExtract };
  }, { chIds: chapters, sourceId: bookId });
  expect(state.hasReadPoint).toBe(true);
  expect(state.hasChapterExtract).toBe(true);

  // The chapter still renders in the reader after restart.
  await page.goto(`${baseUrl}/source/${chapters[0]}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();

  await app.close();
});
