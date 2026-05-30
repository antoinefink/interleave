/**
 * Priority (A/B/C/D) E2E (T027) — drives the real Electron app.
 *
 * Priority is a first-class, EDITABLE axis on every element. This spec launches
 * the built desktop app against a fresh data dir seeded with the shared demo
 * collection, then exercises the universal priority write path THROUGH the
 * inspector's A/B/C/D control (which calls the typed `elements.setPriority`
 * command — `set` / `raise` / `lower`):
 *
 *   1. the `elements.setPriority` bridge command exists (no generic db.query);
 *   2. raising / lowering / setting works on a SOURCE, an EXTRACT, and a CARD —
 *      priority is universal across element types;
 *   3. the change surfaces immediately as the A/B/C/D `Prio` badge + the Priority
 *      meta row, with no reload;
 *   4. it SURVIVES AN APP RESTART (the numeric value persisted to SQLite).
 *
 * The seed gives the source / top extract / Q&A card priority A and the cloze
 * card priority B, so we lower the A items by one band and raise the B card.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/**
 * Select a seeded element from the inspector's picker by its (unique) title. The
 * picker only renders when nothing is selected, so clear any existing selection
 * first (so the helper can be called repeatedly within one page session).
 */
async function selectByTitle(page: Page, title: string) {
  const clear = page.getByTestId("inspector-clear");
  if (await clear.isVisible()) {
    await clear.click();
  }
  const item = page.getByTestId("element-picker-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText(title);
}

/** The A/B/C/D label currently shown in the inspector's Priority meta row. */
async function currentLabel(page: Page): Promise<string> {
  const text = await page.getByTestId("meta-priority").innerText();
  return text.trim().charAt(0);
}

test("the priority control writes through elements.setPriority (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      elements?: { setPriority?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSetPriority: typeof api?.elements?.setPriority === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSetPriority).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("lowering a SOURCE one band updates the badge in place (A → B)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "On the Measure of Intelligence");
  // Seeded at A.
  expect(await currentLabel(page)).toBe("A");

  await page.getByTestId("inspector-priority-lower").click();
  // The Prio badge + meta row reflect the new band without a reload.
  await expect(page.getByTestId("meta-priority")).toContainText("B");
  expect(await currentLabel(page)).toBe("B");

  await app.close();
});

test("setting an EXTRACT to an explicit label works (A → C)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "Intelligence = skill-acquisition efficiency");
  expect(await currentLabel(page)).toBe("A");

  // Click the explicit "C" chip in the segmented control.
  await page.getByTestId("inspector-priority-C").click();
  await expect(page.getByTestId("meta-priority")).toContainText("C");
  expect(await currentLabel(page)).toBe("C");

  await app.close();
});

test("raising a CARD one band works — priority is universal (B → A)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "Intelligence definition (cloze)");
  // The cloze card is seeded at B.
  const content = page.getByTestId("inspector-content");
  await expect(content).toHaveAttribute("data-element-type", "card");
  expect(await currentLabel(page)).toBe("B");

  await page.getByTestId("inspector-priority-raise").click();
  await expect(page.getByTestId("meta-priority")).toContainText("A");
  expect(await currentLabel(page)).toBe("A");

  await app.close();
});

test("raise is a no-op at A and lower is a no-op at D (clamps)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The cloze card was raised to A in the previous test (serial mode).
  await selectByTitle(page, "Intelligence definition (cloze)");
  expect(await currentLabel(page)).toBe("A");
  // The raise stepper is disabled at the top band.
  await expect(page.getByTestId("inspector-priority-raise")).toBeDisabled();

  // Drop it to D via the explicit chip, then assert lower is disabled.
  await page.getByTestId("inspector-priority-D").click();
  await expect(page.getByTestId("meta-priority")).toContainText("D");
  await expect(page.getByTestId("inspector-priority-lower")).toBeDisabled();

  await app.close();
});

test("priority changes survive an app restart (persisted to SQLite)", async () => {
  // Re-launch against the SAME data dir — the restart analogue. The earlier
  // serial tests left: source = B, extract = C, cloze card = D.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "On the Measure of Intelligence");
  expect(await currentLabel(page)).toBe("B");

  await selectByTitle(page, "Intelligence = skill-acquisition efficiency");
  expect(await currentLabel(page)).toBe("C");

  await selectByTitle(page, "Intelligence definition (cloze)");
  expect(await currentLabel(page)).toBe("D");

  await app.close();
});
