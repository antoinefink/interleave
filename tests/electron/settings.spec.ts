/**
 * Local settings E2E (T011) — drives the real Electron app.
 *
 * Asserts what the Definition of Done requires of T011:
 *   1. the typed settings surface exists on `window.appApi`
 *      (`settings.getAll` / `settings.updateMany`) and there is still no generic
 *      `db.query`;
 *   2. the `/settings` UI reads + writes the typed settings THROUGH the bridge
 *      (no hard-coded values) — changing a control persists immediately;
 *   3. a changed setting SURVIVES a full app restart (relaunch Electron against
 *      the same data dir; the value is still there and is what the UI shows);
 *   4. the theme setting is SQLite-backed and applied app-wide on boot.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Navigate to /settings through the real router (user-chip menu → Settings). */
async function gotoSettings(page: Page) {
  await page.getByTestId("user-chip").click();
  await page.getByRole("menuitem", { name: /^Settings$/ }).click();
  await expect(page.getByTestId("route-settings")).toBeVisible();
}

test("the typed settings surface exists through window.appApi (no generic db.query)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      settings?: { getAll?: unknown; updateMany?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasGetAll: typeof api?.settings?.getAll === "function",
      hasUpdateMany: typeof api?.settings?.updateMany === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasGetAll).toBe(true);
  expect(surface.hasUpdateMany).toBe(true);
  expect(surface.hasQuery).toBe(false);

  // getAll returns the complete, validated defaults on a fresh DB.
  const settings = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { getAll(): Promise<{ settings: Record<string, unknown> }> };
    };
    const res = await api.settings.getAll();
    return res.settings;
  });
  expect(settings.dailyReviewBudget).toBe(60);
  expect(settings.theme).toBe("dark");

  await app.close();
});

test("the /settings UI reads the persisted settings through the bridge", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await gotoSettings(page);

  // The control reflects the DB-backed value (60/day default), not a hard-coded
  // literal — proving it loaded through settings.getAll().
  await expect(page.getByTestId("setting-budget-value")).toHaveText("60/day");
  await expect(page.getByTestId("setting-theme-option-dark")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await app.close();
});

test("changing a setting persists and SURVIVES a full app restart", async () => {
  // First launch: change the daily review budget + keyboard layout through the UI.
  const first = await launchApp(dataDir);
  const firstPage = await first.firstWindow();
  await firstPage.waitForLoadState("domcontentloaded");
  await gotoSettings(firstPage);

  // Drag the budget slider to its max (300) and pick the Vim layout.
  await firstPage.getByTestId("setting-budget").fill("300");
  await expect(firstPage.getByTestId("setting-budget-value")).toHaveText("300/day");
  await firstPage.getByTestId("setting-keyboard-option-vim").click();
  await expect(firstPage.getByTestId("setting-keyboard-option-vim")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // The write went through the bridge; confirm via getAll before restart.
  const beforeRestart = await firstPage.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { getAll(): Promise<{ settings: Record<string, unknown> }> };
    };
    return (await api.settings.getAll()).settings;
  });
  expect(beforeRestart.dailyReviewBudget).toBe(300);
  expect(beforeRestart.keyboardLayout).toBe("vim");

  await first.close();

  // Second launch: a brand-new Electron process, SAME data dir → values persist.
  const second = await launchApp(dataDir);
  const secondPage = await second.firstWindow();
  await secondPage.waitForLoadState("domcontentloaded");
  await gotoSettings(secondPage);

  // The UI shows the persisted values, read through settings.getAll().
  await expect(secondPage.getByTestId("setting-budget-value")).toHaveText("300/day");
  await expect(secondPage.getByTestId("setting-keyboard-option-vim")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await second.close();
});

test("the theme setting is SQLite-backed and applied on boot after restart", async () => {
  // Use a dedicated data dir so this test's theme flip is isolated.
  const themeDir = makeDataDir();

  const first = await launchApp(themeDir);
  const firstPage = await first.firstWindow();
  await firstPage.waitForLoadState("domcontentloaded");
  await gotoSettings(firstPage);

  // Default is dark; switch to light through the UI.
  const html = firstPage.locator("html");
  await firstPage.getByTestId("setting-theme-option-light").click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect(firstPage.getByTestId("settings-saved")).toBeVisible();

  await first.close();

  // Relaunch: the boot reconciliation reads the SQLite theme and applies it
  // app-wide before the user touches Settings.
  const second = await launchApp(themeDir);
  const secondPage = await second.firstWindow();
  await secondPage.waitForLoadState("domcontentloaded");
  await expect(secondPage.locator("html")).toHaveAttribute("data-theme", "light");

  await second.close();
});
