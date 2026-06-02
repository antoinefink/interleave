/**
 * Highlight import E2E (T069) — drives the real Electron app end to end, fully on-device.
 *
 * The native file picker is stubbed via `INTERLEAVE_HIGHLIGHTS_IMPORT_PATH` (honored
 * only in the unpackaged build — mirrors the `INTERLEAVE_EPUB_IMPORT_PATH` escape),
 * pointed at the committed Kindle `My Clippings.txt` fixture (2 books, 3 highlights,
 * plus a bookmark / note / malformed record that are skipped). The spec proves:
 *
 *   1. the "Import file…" chip → modal → the "Highlights" format tab → "Choose export…"
 *      → MAIN reads + parses + creates one `inbox` `source` per book/article, authoring
 *      `extract` elements (NEVER cards), and the modal surfaces the counts;
 *   2. the inbox shows the new book/article sources; the imported items are `extract`s
 *      (there are ZERO `card` elements — the load-bearing extracts-not-cards rule);
 *   3. after an APP RESTART against the same data dir, the sources + extracts survive.
 *
 * The renderer reaches all of this only through `window.appApi` — no fs/SQL.
 */

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
  "highlights",
  "MyClippings.txt",
);

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Launch the app with the highlights picker stubbed to the fixture. */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { highlightsImportPath: FIXTURE });
}

/** Element-type counts across the whole collection, via the bridge. */
async function typeCounts(page: Page): Promise<{ source: number; extract: number; card: number }> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const count = (t: string) => elements.filter((e) => e.type === t).length;
    return { source: count("source"), extract: count("extract"), card: count("card") };
  });
}

test("the bridge exposes sources.importHighlights (not raw SQL)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { pickImportFile?: unknown; importHighlights?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasPick: typeof api?.sources?.pickImportFile === "function",
      hasImportHighlights: typeof api?.sources?.importHighlights === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasPick).toBe(true);
  expect(surface.hasImportHighlights).toBe(true);
  expect(surface.hasQuery).toBe(false);
  await app.close();
});

test("importing highlights lands inbox extracts (not cards) grouped by book", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Open the Import-file modal, switch to the "Highlights" format, choose + import.
  await page.getByTestId("inbox-import-import-file").click();
  await expect(page.getByTestId("import-file-modal")).toBeVisible();
  await page.getByTestId("import-file-kind-highlights").click();
  await page.getByTestId("import-file-choose").click();
  await expect(page.getByTestId("import-file-chosen")).toContainText("MyClippings.txt");
  await page.getByTestId("import-file-submit").click();

  // The success summary shows the counts (3 highlights into 2 sources). The modal stays
  // open (highlights → many sources) until the user closes it.
  await expect(page.getByTestId("import-file-success")).toContainText(
    "3 highlights into 2 sources",
    {
      timeout: 20_000,
    },
  );
  await page.getByTestId("import-file-close").click();
  await expect(page.getByTestId("import-file-modal")).toBeHidden();

  // Two book/article sources landed in the inbox.
  await expect(page.getByTestId("inbox-row")).toHaveCount(2);

  // The imported items are EXTRACTS, not cards: 3 extracts, 2 sources, ZERO cards.
  const counts = await typeCounts(page);
  expect(counts.source).toBe(2);
  expect(counts.extract).toBe(3);
  expect(counts.card).toBe(0);

  await app.close();
});

test("the highlight sources + extracts survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  // Still 2 inbox sources after restart.
  await expect(page.getByTestId("inbox-row")).toHaveCount(2);

  // The 3 extracts + 2 sources persisted; still no cards.
  const counts = await typeCounts(page);
  expect(counts.source).toBe(2);
  expect(counts.extract).toBe(3);
  expect(counts.card).toBe(0);

  await app.close();
});
