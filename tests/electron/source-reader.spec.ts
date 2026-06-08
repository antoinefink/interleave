/**
 * Source reading mode E2E (T018) — drives the real Electron app.
 *
 * `/source/$id` is now a real incremental reading workspace: a serif reading
 * column rendered by the constrained editor, a read-point marker, extracted-span
 * display markers, a progress bar, and an action bar — all reading through
 * `window.appApi` (`documents.get` / `readPoints.get` / `readPoints.set` /
 * `inspector.get`). This spec launches the BUILT desktop app against a fresh data
 * dir seeded with the shared demo collection (a source with 4 blocks, a child
 * extract anchored at `blk_def_p1`, and a read-point at `blk_def_p1`) and asserts:
 *
 *   (a) EDIT → RELOAD: opening the source, editing the body, and reopening the
 *       route shows the persisted edit (the T015 persistence path, through the
 *       reader);
 *   (b) REOPEN → RESUME-AT-READ-POINT: the read-point divider renders before the
 *       first unread block (`blk_def_p2`, the block after the read-point's
 *       `blk_def_p1`), not at the top;
 *   (c) the reader renders in BOTH light and dark themes;
 *   (d) extracted-span display markers are present (the definition block carries
 *       the `extracted` class), and the reader reaches data through the bridge
 *       (no generic `db.query`).
 *
 * The full restart-app persistence guarantee is covered by the T015/T017
 * repository + document/read-point E2E specs (and lands again in T049); this spec
 * proves the reader surface itself works against the real bridge.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The seeded source id, resolved once via the bridge. */
let sourceId: string;
/**
 * The renderer base URL (`app://bundle`), captured from the first window. The
 * custom `app://` scheme is non-special, so `URL#origin` is the string `"null"`;
 * we keep `protocol + "//" + host` instead so SPA route navigation works.
 */
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Resolve the seeded "On the Measure of Intelligence" source id via the bridge. */
async function resolveSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
      };
    };
    const { elements } = await api.inspector.list();
    // The demo seeds two sources; pick the article with the 4-block body + the
    // read-point at `blk_def_p1` (not the inbox "Bitter Lesson" source).
    const source = elements.find(
      (e) => e.type === "source" && e.title === "On the Measure of Intelligence",
    );
    if (!source) throw new Error("seeded source not found");
    return source.id;
  });
}

/** Open `/source/<id>` via the SPA route and wait for the reader to render. */
async function openReader(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  // The editor mounts asynchronously after the document loads.
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

test("the reader reaches documents/readPoints/inspector through the bridge, not raw SQL", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      documents?: { get?: unknown };
      readPoints?: { get?: unknown; set?: unknown };
      inspector?: { get?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasDocGet: typeof api?.documents?.get === "function",
      hasRpGet: typeof api?.readPoints?.get === "function",
      hasRpSet: typeof api?.readPoints?.set === "function",
      hasInspGet: typeof api?.inspector?.get === "function",
      // biome-ignore lint/suspicious/noExplicitAny: probing for a forbidden method
      hasQuery: typeof (api as any)?.db?.query === "function",
    };
  });
  expect(surface.hasDocGet).toBe(true);
  expect(surface.hasRpGet).toBe(true);
  expect(surface.hasRpSet).toBe(true);
  expect(surface.hasInspGet).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("the reader shows title, body, progress, action bar, and extracted-span markers", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  // Header + provenance.
  await expect(page.getByTestId("reader-title")).toHaveText("On the Measure of Intelligence");
  await expect(page.getByTestId("reader-url")).toContainText("arxiv.org");

  // The body rendered (the definition paragraph is present).
  await expect(page.locator(".reader .ProseMirror")).toContainText("skill-acquisition efficiency");

  // Action bar: read-point plus working source lifecycle exits.
  await expect(page.getByTestId("reader-set-readpoint")).toBeEnabled();
  await expect(page.getByTestId("reader-postpone")).toBeEnabled();
  await expect(page.getByTestId("reader-mark-done")).toBeEnabled();

  // Progress bar present.
  await expect(page.getByTestId("reader-pbar-fill")).toBeVisible();

  // Extracted-span display marker: the seeded extract anchors at the definition
  // block (`blk_def_p1`), so that block carries the `extracted` class.
  await expect(page.locator('.reader [data-block-id="blk_def_p1"].extracted')).toBeVisible();

  await app.close();
});

test("the Library breadcrumb opens the Library route", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  await page
    .getByRole("navigation", { name: "Breadcrumb" })
    .getByRole("button", { name: "Library" })
    .click();

  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByTestId("route-library")).toBeVisible();

  await app.close();
});

test("(b) reopening resumes at the read-point: the divider renders before the first unread block", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  // The seeded read-point is at `blk_def_p1`; the first UNREAD block is the next
  // one (`blk_def_p2`). The reader inserts the `.readpoint` divider before it.
  const divider = page.locator(".reader .readpoint");
  await expect(divider).toBeVisible();
  await expect(divider).toContainText("unread from here");

  // The divider sits immediately before the first-unread block in the DOM.
  const dividerThenBlock = page.locator('.reader .readpoint + [data-block-id="blk_def_p2"]');
  await expect(dividerThenBlock).toHaveCount(1);

  await app.close();
});

test("(a) editing the body and reopening the route shows the persisted edit", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  const marker = ` [edited-${Date.now()}]`;

  // Type into the editor: place the caret at the end of the first paragraph and
  // append a unique marker. The reader saves debounced through documents.save.
  const firstBlock = page.locator('.reader [data-block-id="blk_intro_p1"]');
  await firstBlock.click();
  await page.keyboard.press("End");
  await page.keyboard.type(marker);

  // Wait for the debounced save to land in SQLite via the bridge.
  await expect
    .poll(
      async () => {
        return page.evaluate(async (id: string) => {
          const api = window.appApi as unknown as {
            documents: {
              get(req: { elementId: string }): Promise<{ document: { plainText: string } | null }>;
            };
          };
          const { document } = await api.documents.get({ elementId: id });
          return document?.plainText ?? "";
        }, sourceId);
      },
      { timeout: 6000 },
    )
    .toContain(marker);

  // Reopen the route fresh; the edit is still in the rendered body.
  await openReader(page, sourceId);
  await expect(page.locator(".reader .ProseMirror")).toContainText(marker);

  await app.close();
});

test("(c) the reader renders in both light and dark themes", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");

  // Flip the theme via the shell's user-chip menu.
  await page.getByTestId("user-chip").click();
  await page
    .getByTestId(before === "light" ? "shell-theme-option-dark" : "shell-theme-option-light")
    .click();
  const after = await html.getAttribute("data-theme");
  expect(after).not.toBe(before);

  // The reader is still intact + the read-point divider still renders.
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .readpoint")).toBeVisible();

  await app.close();
});
