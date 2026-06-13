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

  // The control reflects the DB-backed value (60 min default), not a hard-coded
  // literal — proving it loaded through settings.getAll().
  await expect(page.getByTestId("setting-budget-value")).toHaveText("60 min");
  await expect(page.getByTestId("setting-theme-option-dark")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await app.close();
});

test("settings no longer exposes semantic search provider controls", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await gotoSettings(page);

  await expect(page.getByText(/^Semantic search$/)).toHaveCount(0);
  await expect(page.getByTestId("setting-semantic-enabled")).toHaveCount(0);
  await expect(page.getByTestId("setting-embedding-provider")).toHaveCount(0);
  await expect(page.getByTestId("setting-embedding-api-key")).toHaveCount(0);

  await app.close();
});

test("settings scrolling stays inside the app shell instead of moving the document", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await gotoSettings(page);

  const shellPage = page.locator(".shell-page");
  await expect(shellPage).toBeVisible();
  const initial = await page.evaluate(() => {
    const routeScroller = document.querySelector<HTMLElement>(".shell-page");
    const shell = document.querySelector<HTMLElement>(".app-shell");
    return {
      bodyOverflow: getComputedStyle(document.body).overflowY,
      documentTop: document.scrollingElement?.scrollTop ?? -1,
      routeClientHeight: routeScroller?.clientHeight ?? 0,
      routeScrollHeight: routeScroller?.scrollHeight ?? 0,
      rootOverflow: getComputedStyle(document.documentElement).overflowY,
      shellBottom: shell?.getBoundingClientRect().bottom ?? 0,
      viewportHeight: window.innerHeight,
      windowY: window.scrollY,
    };
  });
  expect(initial.rootOverflow).toBe("hidden");
  expect(initial.bodyOverflow).toBe("hidden");
  expect(initial.windowY).toBe(0);
  expect(initial.documentTop).toBe(0);
  expect(initial.routeScrollHeight).toBeGreaterThanOrEqual(initial.routeClientHeight);
  expect(Math.abs(initial.shellBottom - initial.viewportHeight)).toBeLessThanOrEqual(1);

  await shellPage.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await shellPage.hover();
  await page.mouse.wheel(0, 2500);

  const afterWheel = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    return {
      documentTop: document.scrollingElement?.scrollTop ?? -1,
      shellBottom: shell?.getBoundingClientRect().bottom ?? 0,
      viewportHeight: window.innerHeight,
      windowY: window.scrollY,
    };
  });

  expect(afterWheel.windowY).toBe(0);
  expect(afterWheel.documentTop).toBe(0);
  expect(Math.abs(afterWheel.shellBottom - afterWheel.viewportHeight)).toBeLessThanOrEqual(1);

  await app.close();
});

test("changing a setting persists and SURVIVES a full app restart", async () => {
  // First launch: change the daily review budget + keyboard layout through the UI.
  const first = await launchApp(dataDir);
  const firstPage = await first.firstWindow();
  await firstPage.waitForLoadState("domcontentloaded");
  await gotoSettings(firstPage);

  // Drag the minute budget slider to its max (300) and pick the Vim layout.
  await firstPage.getByTestId("setting-budget").fill("300");
  await expect(firstPage.getByTestId("setting-budget-value")).toHaveText("300 min");
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
  expect(beforeRestart.dailyBudgetMinutes).toBe(300);
  expect(beforeRestart.keyboardLayout).toBe("vim");

  await first.close();

  // Second launch: a brand-new Electron process, SAME data dir → values persist.
  const second = await launchApp(dataDir);
  const secondPage = await second.firstWindow();
  await secondPage.waitForLoadState("domcontentloaded");
  await gotoSettings(secondPage);

  // The UI shows the persisted values, read through settings.getAll().
  await expect(secondPage.getByTestId("setting-budget-value")).toHaveText("300 min");
  await expect(secondPage.getByTestId("setting-keyboard-option-vim")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await second.close();
});

test("the sidebar user chip reflects the display-name setting + survives restart", async () => {
  // A dedicated data dir so the name change is isolated from the other tests.
  const nameDir = makeDataDir();

  const first = await launchApp(nameDir);
  const firstPage = await first.firstWindow();
  await firstPage.waitForLoadState("domcontentloaded");

  // A fresh vault has no name yet: the chip degrades to the neutral local-vault
  // identity (NOT a hardcoded persona) and the streak chip is hidden (no reviews).
  await expect(firstPage.getByTestId("user-chip-name")).toHaveText("Local vault");
  await expect(firstPage.getByTestId("shell-streak")).toHaveCount(0);

  // Opening the user menu shows the honest, non-interactive vault status (the old
  // misleading "Local vault · synced" button is gone — sync is a later feature).
  await firstPage.getByTestId("user-chip").click();
  const vaultStatus = firstPage.getByTestId("shell-vault-status");
  await expect(vaultStatus).toHaveText(/Local vault · offline-first/);
  // It is a non-interactive status row, not a button/menuitem — nothing to click.
  await expect(vaultStatus).toHaveJSProperty("tagName", "DIV");
  await firstPage.keyboard.press("Escape");

  // Set a name through the real /settings UI — it persists through the bridge.
  await gotoSettings(firstPage);
  await firstPage.getByTestId("setting-display-name").fill("Ada Lovelace");
  await firstPage.getByTestId("setting-display-name").blur();
  await expect(firstPage.getByTestId("settings-saved")).toHaveCount(0);

  // The sidebar chip now shows the set name + derived avatar initials.
  await expect(firstPage.getByTestId("user-chip-name")).toHaveText("Ada Lovelace");
  await expect(firstPage.getByTestId("user-chip").locator(".shell-avatar")).toHaveText("AL");

  await first.close();

  // Relaunch the SAME data dir: the name was SQLite-backed, so the chip still
  // shows it on boot — read through settings.getAll(), no hardcoded value.
  const second = await launchApp(nameDir);
  const secondPage = await second.firstWindow();
  await secondPage.waitForLoadState("domcontentloaded");
  await expect(secondPage.getByTestId("user-chip-name")).toHaveText("Ada Lovelace");
  await expect(secondPage.getByTestId("user-chip").locator(".shell-avatar")).toHaveText("AL");

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
  await expect(firstPage.getByTestId("settings-saved")).toHaveCount(0);

  await first.close();

  // Relaunch: the boot reconciliation reads the SQLite theme and applies it
  // app-wide before the user touches Settings.
  const second = await launchApp(themeDir);
  const secondPage = await second.firstWindow();
  await secondPage.waitForLoadState("domcontentloaded");
  await expect(secondPage.locator("html")).toHaveAttribute("data-theme", "light");

  await second.close();
});
