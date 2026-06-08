/**
 * Import/process balance warnings (T046) E2E — drives the real Electron app.
 *
 * The balance banner catches the core failure mode of incremental reading —
 * importing faster than you process. The week's four headline numbers (sources
 * imported / extracts created / cards created / reviews due) + the imbalance
 * judgment are computed by a DOMAIN aggregation (`AnalyticsService.computeBalance`
 * + the pure `@interleave/core` `judgeBalance` rule) and read through the typed
 * `window.appApi.balance.get` surface. This spec launches the built desktop app
 * against a fresh data dir and asserts:
 *
 *   1. the `balance.*` bridge surface exists (no raw SQL);
 *   2. after importing many sources with no processing, the advisory `Banner`
 *      appears on the inbox with the four weekly numbers and no false queue CTA;
 *   3. toggling the `balanceWarnings` setting off hides the banner;
 *   4. the imported counts SURVIVE AN APP RESTART — recomputed from the durable
 *      `elements` rows, so re-enabling the warning shows the banner again.
 *
 * The renderer never touches SQLite — every read/write rides the typed bridge.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

/** Import `n` sources through the SAME typed command the New-source modal uses. */
async function importSources(page: Page, n: number): Promise<void> {
  await page.evaluate(async (count) => {
    const api = window.appApi as unknown as {
      sources: { importManual(req: { title: string; priority?: string }): Promise<unknown> };
    };
    for (let i = 0; i < count; i++) {
      await api.sources.importManual({ title: `Imported source ${i}`, priority: "C" });
    }
  }, n);
}

/** Read the balance snapshot via the typed bridge. */
async function balance(page: Page): Promise<{
  sourcesImported: number;
  extractsCreated: number;
  cardsCreated: number;
  inboxSources: number;
  dueQueueItems: number;
  imbalanced: boolean;
  severity: string;
}> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      balance: {
        get(): Promise<{
          sourcesImported: number;
          extractsCreated: number;
          cardsCreated: number;
          inboxSources: number;
          dueQueueItems: number;
          imbalanced: boolean;
          severity: string;
        }>;
      };
    };
    return api.balance.get();
  });
}

/** Flip the `balanceWarnings` setting through the typed settings surface. */
async function setBalanceWarnings(page: Page, on: boolean): Promise<void> {
  await page.evaluate(async (value) => {
    const api = window.appApi as unknown as {
      settings: { updateMany(req: { patch: { balanceWarnings: boolean } }): Promise<unknown> };
    };
    await api.settings.updateMany({ patch: { balanceWarnings: value } });
  }, on);
}

async function balanceWarningsEnabled(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { getAll(): Promise<{ settings: { balanceWarnings: boolean } }> };
    };
    return (await api.settings.getAll()).settings.balanceWarnings;
  });
}

async function balanceNoticeDismissalUntil(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { get(req: { key: string }): Promise<{ settings: Record<string, unknown> }> };
    };
    const { settings } = await api.settings.get({ key: "ui.noticeDismissals" });
    const raw = settings["ui.noticeDismissals"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const notice = (raw as Record<string, unknown>)["balance.importProcess"];
    if (!notice || typeof notice !== "object" || Array.isArray(notice)) return null;
    const until = (notice as Record<string, unknown>).until;
    return typeof until === "string" ? until : null;
  });
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("the balance bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      balance?: { get?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasBalanceGet: typeof api?.balance?.get === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasBalanceGet).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("the balance banner appears on the inbox when imports outpace processing", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Import 10 sources with NO extracts/cards → an imbalanced (danger) week.
  await importSources(page, 10);

  const b = await balance(page);
  expect(b.sourcesImported).toBeGreaterThanOrEqual(10);
  expect(b.extractsCreated).toBe(0);
  expect(b.cardsCreated).toBe(0);
  expect(b.inboxSources).toBeGreaterThanOrEqual(10);
  expect(b.dueQueueItems).toBe(0);
  expect(b.imbalanced).toBe(true);

  // The advisory banner shows on the inbox with the four weekly numbers and only
  // the action that can actually lead to work. Imported inbox sources are not due
  // queue items yet.
  await page.goto(`${baseUrl}/inbox`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  const banner = page.getByTestId("balance-banner");
  await expect(banner).toBeVisible();
  await expect(page.getByTestId("balance-sources")).toHaveText(/\d+/);
  await expect(page.getByTestId("balance-extracts")).toHaveText("0");
  await expect(page.getByTestId("balance-cards")).toHaveText("0");
  await expect(page.getByTestId("balance-reviews")).toHaveText(/\d+/);
  await expect(page.getByTestId("balance-open-queue")).toHaveCount(0);
  await expect(page.getByTestId("balance-triage-inbox")).toBeVisible();

  await page.getByTestId("balance-triage-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row").first()).toHaveAttribute("aria-current", "true");

  await page.getByTestId("balance-dismiss-menu-trigger").click();
  await expect(page.getByTestId("balance-dismiss-menu")).toBeVisible();
  await expect(page.getByTestId("balance-hide-week")).toHaveText("Hide for a week");
  await expect(page.getByTestId("balance-turn-off")).toContainText("Hide forever");
  await page.screenshot({
    path: test.info().outputPath("balance-warning-dismiss-menu.png"),
  });

  const bannerBox = await banner.boundingBox();
  const rowBox = await page.getByTestId("inbox-row").first().boundingBox();
  const routeBox = await page.getByTestId("route-inbox").boundingBox();
  if (!bannerBox || !rowBox || !routeBox) throw new Error("Could not measure inbox geometry");
  expect(Math.abs(bannerBox.x - rowBox.x)).toBeLessThanOrEqual(1);
  const bannerLeftGutter = bannerBox.x - routeBox.x;
  const bannerRightGutter = routeBox.x + routeBox.width - (bannerBox.x + bannerBox.width);
  expect(Math.abs(bannerLeftGutter - bannerRightGutter)).toBeLessThanOrEqual(1);

  await app.close();
});

test("hide for a week persists through an app restart", async () => {
  const weeklyDir = makeDataDir();
  const app1 = await launchApp(weeklyDir);
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  await importSources(page1, 10);

  await page1.goto(`${baseUrl}/inbox`);
  await page1.waitForLoadState("domcontentloaded");
  await expect(page1.getByTestId("balance-banner")).toBeVisible();
  await page1.getByTestId("balance-dismiss-menu-trigger").click();
  await page1.getByTestId("balance-hide-week").click();
  await expect(page1.getByTestId("balance-banner")).toHaveCount(0);
  const until = await balanceNoticeDismissalUntil(page1);
  expect(typeof until).toBe("string");
  expect(Date.parse(until as string)).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  await app1.close();

  const app2 = await launchApp(weeklyDir);
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  await page2.goto(`${baseUrl}/inbox`);
  await page2.waitForLoadState("domcontentloaded");
  await expect(page2.getByTestId("route-inbox")).toBeVisible();
  await expect(page2.getByTestId("balance-banner")).toHaveCount(0);
  await app2.close();
});

test("hiding forever through the banner menu persists in typed settings", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The imbalance still exists (the imported sources persist), so the banner is up.
  await page.goto(`${baseUrl}/inbox`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("balance-banner")).toBeVisible();

  // Hide forever through the real menu action -> the typed setting flips off and
  // the banner stays hidden after reload.
  await page.getByTestId("balance-dismiss-menu-trigger").click();
  await expect(page.getByTestId("balance-turn-off")).toContainText("Hide forever");
  await page.getByTestId("balance-turn-off").click();
  await expect(page.getByTestId("balance-banner")).toHaveCount(0);
  expect(await balanceWarningsEnabled(page)).toBe(false);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("balance-banner")).toHaveCount(0);

  await app.close();
});

test("the imbalance survives an app restart (recomputed from durable elements)", async () => {
  // Re-enable warnings, then restart.
  const app1 = await launchApp(dataDir);
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  await setBalanceWarnings(page1, true);
  const before = await balance(page1);
  expect(before.imbalanced).toBe(true);
  await app1.close();

  // Relaunch against the SAME data dir — the counts are recomputed from the
  // durable `elements` rows, so the banner is back on the inbox.
  const app2 = await launchApp(dataDir);
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const after = await balance(page2);
  expect(after.sourcesImported).toBe(before.sourcesImported);
  expect(after.imbalanced).toBe(true);

  await page2.goto(`${baseUrl}/inbox`);
  await page2.waitForLoadState("domcontentloaded");
  await expect(page2.getByTestId("balance-banner")).toBeVisible();
  await app2.close();
});
