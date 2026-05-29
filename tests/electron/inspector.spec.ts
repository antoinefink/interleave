/**
 * Universal element inspector E2E (T010) — drives the real Electron app.
 *
 * Launches the built desktop app against a fresh data dir seeded with the shared
 * demo collection (source → extract → sub-extract → Q&A/cloze cards), selects
 * elements in the shell's right inspector, and asserts:
 *
 *   1. selecting a CARD shows type-appropriate metadata AND the FSRS scheduler
 *      chip (brain · recall % · stability), with the FSRS stat readout;
 *   2. selecting a SOURCE shows the attention scheduler chip (gauge · stage) and
 *      source provenance — proving the load-bearing FSRS-vs-attention split;
 *   3. the inspector reads everything THROUGH `window.appApi` (the inspector.list
 *      / inspector.get bridge commands exist; there is no generic db.query);
 *   4. it renders correctly in both light and dark themes.
 *
 * Read-only for M1: the inspector shows metadata + lineage + scheduler signals;
 * editing lands with later features.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Select a seeded element from the inspector's picker by its (unique) title. */
async function selectByTitle(page: Page, title: string) {
  const item = page.getByTestId("element-picker-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText(title);
}

test("the inspector reads through window.appApi (inspector.list/get), not raw SQL", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      inspector?: { list?: unknown; get?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasList: typeof api?.inspector?.list === "function",
      hasGet: typeof api?.inspector?.get === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasList).toBe(true);
  expect(surface.hasGet).toBe(true);
  expect(surface.hasQuery).toBe(false);

  // The list command returns the seeded elements.
  const count = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: unknown[] }> };
    };
    const res = await api.inspector.list();
    return res.elements.length;
  });
  expect(count).toBeGreaterThanOrEqual(3);

  await app.close();
});

test("selecting a CARD shows card metadata and the FSRS scheduler chip", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "Chollet's definition of intelligence");

  const content = page.getByTestId("inspector-content");
  await expect(content).toHaveAttribute("data-element-type", "card");
  await expect(page.getByTestId("meta-type")).toHaveText("Card");

  // The load-bearing split: a card is on the FSRS scheduler.
  const chip = page.getByTestId("scheduler-chip").first();
  await expect(chip).toHaveAttribute("data-scheduler", "fsrs");
  await expect(chip).toContainText("recall");

  // FSRS stat readout + a review section are present for the reviewed card.
  await expect(page.getByTestId("fsrs-stats")).toBeVisible();
  await expect(page.getByTestId("review-section")).toBeVisible();

  await app.close();
});

test("selecting a SOURCE shows the attention scheduler chip + provenance", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "On the Measure of Intelligence");

  const content = page.getByTestId("inspector-content");
  await expect(content).toHaveAttribute("data-element-type", "source");
  await expect(page.getByTestId("meta-type")).toHaveText("Source");

  // The load-bearing split: a source is on the attention scheduler.
  const chip = page.getByTestId("scheduler-chip").first();
  await expect(chip).toHaveAttribute("data-scheduler", "attention");

  // A source has no FSRS readout but does have its children (the extract).
  await expect(page.getByTestId("fsrs-stats")).toHaveCount(0);
  await expect(page.getByTestId("children-section")).toContainText(
    "Intelligence = skill-acquisition efficiency",
  );

  await app.close();
});

test("the inspector renders in both light and dark themes", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "Chollet's definition of intelligence");
  const html = page.locator("html");
  const before = await html.getAttribute("data-theme");

  // Flip the theme via the user-chip menu and re-assert the inspector chip.
  await page.getByTestId("user-chip").click();
  await page.getByRole("menuitem", { name: /mode/i }).click();
  const after = await html.getAttribute("data-theme");
  expect(after).not.toBe(before);

  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("scheduler-chip").first()).toHaveAttribute(
    "data-scheduler",
    "fsrs",
  );

  await app.close();
});
