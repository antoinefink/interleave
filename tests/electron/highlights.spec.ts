/**
 * Highlights E2E (T020) — drives the real Electron app.
 *
 * A highlight is a lightweight reading annotation persisted as a `document_marks`
 * row (a STABLE block id + a `[start,end]` range) — NOT an extract, NOT an element,
 * NOT lineage. This spec launches the BUILT desktop app against a fresh seeded data
 * dir and proves the full T020 round-trip against the real `documents.marks.*`
 * bridge:
 *
 *   (a) SELECT → HIGHLIGHT: selecting a paragraph and pressing Highlight renders an
 *       inline `mark.hl` over the text and creates exactly one `highlight`
 *       `document_marks` row (and NO new element — a highlight is an annotation);
 *   (b) RELOAD: reopening the route still shows the highlight (loaded from
 *       `documents.marks.list`);
 *   (c) RESTART: relaunching the Electron app against the same data dir still shows
 *       the highlight — it survives an app restart (the DoD bar);
 *   (d) REMOVE: clicking the highlight deletes its `document_marks` row, and after a
 *       reload it is gone.
 *
 * It reuses the shared seeded source ("On the Measure of Intelligence") and the
 * same launch/route helpers as the T018/T019 reader specs.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Resolve the seeded article source id via the bridge. */
async function resolveSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const source = elements.find(
      (e) => e.type === "source" && e.title === "On the Measure of Intelligence",
    );
    if (!source) throw new Error("seeded source not found");
    return source.id;
  });
}

async function openReader(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

/** Triple-click a block to select its whole text (updates the editor selection). */
async function selectBlockText(page: Page, blockId: string): Promise<string> {
  const block = page.locator(`.reader [data-block-id="${blockId}"]`);
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** Count `highlight` document_marks rows for the source via the bridge. */
async function highlightCount(page: Page, id: string): Promise<number> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        marks: {
          list(req: { elementId: string; markType?: string }): Promise<{ marks: { id: string }[] }>;
        };
      };
    };
    const { marks } = await api.documents.marks.list({ elementId, markType: "highlight" });
    return marks.length;
  }, id);
}

/** Count live source elements via the bridge (to prove highlighting makes none). */
async function sourceElementCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.filter((e) => e.type === "source").length;
  });
}

test("highlighting persists, reloads, survives restart, and is removable", async () => {
  // (a) SELECT → HIGHLIGHT.
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);
  await openReader(page, sourceId);

  const sourcesBefore = await sourceElementCount(page);
  expect(await highlightCount(page, sourceId)).toBe(0);

  const selected = await selectBlockText(page, "blk_def_p1");
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.getByTestId("sel-tool-highlight").click();
  await expect(page.getByText("Highlighted")).toBeVisible();

  // Exactly one highlight row, an inline `mark.hl` is rendered, and NO new element.
  await expect.poll(() => highlightCount(page, sourceId)).toBe(1);
  await expect(page.locator(".reader mark.hl[data-mark-id]").first()).toBeVisible();
  expect(await sourceElementCount(page)).toBe(sourcesBefore);

  // (b) RELOAD: the highlight is still there after navigating away + back.
  await page.goto(`${baseUrl}/queue`);
  await openReader(page, sourceId);
  await expect(page.locator(".reader mark.hl[data-mark-id]").first()).toBeVisible();
  expect(await highlightCount(page, sourceId)).toBe(1);

  // (c) RESTART: relaunch the app against the same data dir — highlight survives.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);
  await expect(page.locator(".reader mark.hl[data-mark-id]").first()).toBeVisible();
  expect(await highlightCount(page, sourceId)).toBe(1);

  // (d) REMOVE: clicking the highlight deletes it; after a reload it is gone.
  await page.locator(".reader mark.hl[data-mark-id]").first().click();
  await expect(page.getByText("Highlight removed")).toBeVisible();
  await expect.poll(() => highlightCount(page, sourceId)).toBe(0);
  await page.goto(`${baseUrl}/queue`);
  await openReader(page, sourceId);
  await expect(page.locator(".reader mark.hl[data-mark-id]")).toHaveCount(0);
  expect(await highlightCount(page, sourceId)).toBe(0);

  await app.close();
});
