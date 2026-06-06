/**
 * Element hierarchy view E2E (T023) — drives the real Electron app.
 *
 * The lineage tree surfaces the full chain `source → extract → sub-extract → card`
 * as a navigable tree in the inspector, computed main-side (`lineage.get`) and
 * rendered as the kit's `LineageTree`. This spec launches the BUILT desktop app
 * against a fresh seeded data dir (the shared demo collection already contains the
 * `source → extract → sub-extract → Q&A/cloze card` chain) and proves bidirectional
 * navigation through the REAL bridge:
 *
 *   (a) the tree renders for the source with the source + extract + sub-extract +
 *       both cards, depth-indented, source-node active;
 *   (b) DOWN: clicking the extract node selects it (inspector shows the extract,
 *       tree now marks the extract active);
 *   (c) UP: from the extract, clicking the source node re-selects the source and
 *       opens its reader (`/source/$id`);
 *   (d) CARD: from the extract workspace lineage panel, clicking a card opens the
 *       embedded card detail section without incorrectly starting `/review`;
 *   (e) RESTART: relaunching against the same data dir still shows the full tree —
 *       lineage survives an app restart (the DoD bar).
 *
 * It reads element ids only through `window.appApi` (the lineage tree + selection),
 * never raw SQL.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Resolve a seeded element id by type + (optional) title via the bridge. */
async function resolveId(page: Page, type: string, title?: string): Promise<string> {
  return page.evaluate(
    async ({ type, title }) => {
      const api = window.appApi as unknown as {
        inspector: {
          list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
        };
      };
      const { elements } = await api.inspector.list();
      const match = elements.find((e) => e.type === type && (!title || e.title === title));
      if (!match) throw new Error(`seeded ${type}${title ? ` "${title}"` : ""} not found`);
      return match.id;
    },
    { type, title },
  );
}

/** The `lineage.get` payload for an element, via the bridge. */
async function lineageOf(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: { id: string }): Promise<{
          lineage: {
            rootId: string;
            nodes: { id: string; type: string; depth: number; meta: string; active: boolean }[];
          } | null;
        }>;
      };
    };
    const { lineage } = await api.lineage.get({ id: elementId });
    return lineage;
  }, id);
}

/** Select a seeded element from the inspector's picker by its (unique) title. */
async function selectByTitle(page: Page, title: string) {
  const item = page.getByTestId("element-picker-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText(title);
}

/** A lineage-tree node button by element id. */
function treeNode(page: Page, id: string) {
  return page.locator(`[data-testid="lineage-tree-node"][data-element-id="${id}"]`).first();
}

test("the lineage surface exposes lineage.get through the bridge, not raw SQL", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      lineage?: { get?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasGet: typeof api?.lineage?.get === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasGet).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("the lineage tree shows the full chain and navigates both directions, surviving restart", async () => {
  // (a) Tree renders for the source.
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const sourceId = await resolveId(page, "source", "On the Measure of Intelligence");
  const extractId = await resolveId(page, "extract", "Intelligence = skill-acquisition efficiency");
  const subExtractId = await resolveId(page, "extract", "Must control for priors and experience");

  // The lineage payload (computed main-side) carries the full chain with depths.
  const fromSource = await lineageOf(page, sourceId);
  expect(fromSource?.rootId).toBe(sourceId);
  const ids = (fromSource?.nodes ?? []).map((n) => n.id);
  expect(ids).toContain(sourceId);
  expect(ids).toContain(extractId);
  expect(ids).toContain(subExtractId);
  const cardId = fromSource?.nodes.find((n) => n.type === "card")?.id;
  expect(cardId).toBeTruthy();
  const sourceNode = fromSource?.nodes.find((n) => n.id === sourceId);
  const extractNode = fromSource?.nodes.find((n) => n.id === extractId);
  const subNode = fromSource?.nodes.find((n) => n.id === subExtractId);
  expect(sourceNode?.depth).toBe(0);
  expect(extractNode?.depth).toBe(1);
  expect(subNode?.depth).toBe(2);
  expect(subNode?.meta).toBe("sub-extract");

  // Select the source in the inspector → the tree renders with the source active.
  await selectByTitle(page, "On the Measure of Intelligence");
  await expect(page.getByTestId("lineage-tree")).toBeVisible();
  await expect(treeNode(page, sourceId)).toHaveAttribute("data-active", "true");
  // The extract + sub-extract appear as descendant nodes (navigable down).
  await expect(treeNode(page, extractId)).toBeVisible();
  await expect(treeNode(page, subExtractId)).toBeVisible();

  // (b) DOWN: click the extract node → the inspector now shows the extract.
  await treeNode(page, extractId).click();
  await expect(page.getByTestId("inspector-content")).toHaveAttribute(
    "data-element-type",
    "extract",
  );
  // The tree (still showing the same rooted chain) now marks the extract active.
  await expect(treeNode(page, extractId)).toHaveAttribute("data-active", "true");
  await expect(treeNode(page, sourceId)).toHaveAttribute("data-active", "false");

  // (c) UP: from the extract, click the source node → re-selects the source AND
  // opens its reader (sources navigate to /source/$id).
  await treeNode(page, sourceId).click();
  await expect(page).toHaveURL(new RegExp(`/source/${sourceId}$`));
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(treeNode(page, sourceId)).toHaveAttribute("data-active", "true");

  // (d) CARD: in the extract workspace's own lineage panel, clicking a card opens
  // the embedded targeted-card section and stays on the extract route instead of
  // detouring into the review session.
  if (!cardId) throw new Error("seeded lineage card not found");
  await page.goto(`${baseUrl}/extract/${extractId}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-extract")).toBeVisible();
  await expect(page.getByTestId("extract-distill")).toBeVisible();
  const extractLineage = page.getByTestId("extract-context");
  await extractLineage
    .locator(`[data-testid="lineage-tree-node"][data-element-id="${cardId}"]`)
    .click();
  await expect(page).toHaveURL(new RegExp(`/extract/${extractId}$`));
  await expect(page).not.toHaveURL(/\/review/);
  await expect(page.getByTestId("extract-card-detail")).toBeVisible();
  const cardDetail = page.getByTestId("card-detail");
  await expect(cardDetail).toHaveAttribute("data-card-id", cardId);
  await expect(cardDetail.getByTestId("fsrs-stats")).toBeVisible();
  await expect(cardDetail.getByTestId("card-answer")).toBeVisible();
  await expect(cardDetail.getByTestId("review-repair-edit")).toBeVisible();
  const embeddedLayout = await page.evaluate(() => {
    const context = document.querySelector<HTMLElement>('[data-testid="extract-context"]');
    const detail = document.querySelector<HTMLElement>('[data-testid="extract-card-detail"]');
    const stats = detail?.querySelector<HTMLElement>('[data-testid="fsrs-stats"]');
    if (!context || !detail || !stats) return null;
    const contextBox = context.getBoundingClientRect();
    const detailBox = detail.getBoundingClientRect();
    return {
      columnsDoNotOverlap: contextBox.right <= detailBox.left || detailBox.right <= contextBox.left,
      detailFitsWidth: detail.scrollWidth <= detail.clientWidth + 1,
      statsFitWidth: stats.scrollWidth <= stats.clientWidth + 1,
      detailInsideViewport: detailBox.left >= 0 && detailBox.right <= window.innerWidth,
    };
  });
  expect(embeddedLayout).toEqual({
    columnsDoNotOverlap: true,
    detailFitsWidth: true,
    statsFitWidth: true,
    detailInsideViewport: true,
  });
  await expect(page.getByTestId("extract-distill")).toHaveCount(0);
  await page.getByTestId("extract-card-back").click();
  await expect(page.getByTestId("extract-distill")).toBeVisible();
  await expect(page.getByTestId("extract-card-detail")).toHaveCount(0);

  // (e) RESTART: relaunch against the same data dir — the tree survives.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const afterRestart = await lineageOf(page, extractId);
  expect(afterRestart?.rootId).toBe(sourceId);
  const restartIds = (afterRestart?.nodes ?? []).map((n) => n.id);
  expect(restartIds).toContain(sourceId);
  expect(restartIds).toContain(extractId);
  expect(restartIds).toContain(subExtractId);
  // The active flag follows the entry element after restart (bidirectional hinge).
  expect(afterRestart?.nodes.find((n) => n.id === extractId)?.active).toBe(true);

  // The tree is navigable in the UI after restart too: open the source reader and
  // click the sub-extract node (navigating DOWN two levels).
  await page.goto(`${baseUrl}/source/${sourceId}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("lineage-tree")).toBeVisible();
  await treeNode(page, subExtractId).click();
  await expect(page.getByTestId("inspector-content")).toHaveAttribute(
    "data-element-type",
    "extract",
  );
  await expect(treeNode(page, subExtractId)).toHaveAttribute("data-active", "true");

  await app.close();
});
