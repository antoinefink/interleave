/**
 * Library "Open task" -> weekly routing E2E — drives the real Electron app.
 *
 * Regression for the bug where clicking "Open task" on the system "Weekly review"
 * task in the Library browse detail panel opened the next due Q&A card (via the
 * /process queue loop) instead of the weekly review surface. Root cause: the
 * `LibraryItem` IPC read-model contract dropped `taskType`, so the renderer's
 * central `openQueueItem` helper could not match its `taskType === "weekly_review"`
 * branch and fell through to /process. Unit + component tests cover the mapper and
 * the renderer seam in isolation; this spec proves the field now survives the REAL
 * renderer<->main IPC round-trip (the layer those tests cannot exercise):
 *
 *   1. enabling weekly review through the typed settings bridge creates the
 *      recurring "Weekly review" system task;
 *   2. in /library, selecting that task row and clicking "Open task" lands on the
 *      /weekly surface — NOT the /process queue loop, NOT a /card detail.
 *
 * Launches the built desktop app against a fresh data dir seeded with the shared
 * demo collection (which also ships a seeded verify_claim task, so the task group
 * holds more than one row — the row is disambiguated by its "Weekly review" title).
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

/** Enable weekly review through the typed settings bridge (no raw SQL). */
async function enableWeeklyReview(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { updateMany(req: { patch: Record<string, unknown> }): Promise<unknown> };
    };
    await api.settings.updateMany({ patch: { weeklyReviewEnabled: true } });
  });
}

test("Library 'Open task' on the weekly-review task routes to /weekly", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // Enabling weekly review creates the recurring "Weekly review" system task.
  await enableWeeklyReview(page);

  // Browse the whole collection; the task group carries the weekly-review row.
  await page.goto(`${baseUrl}/library`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-library")).toBeVisible();

  const weeklyRow = page
    .getByTestId("library-group-task")
    .getByTestId("library-result")
    .filter({ hasText: "Weekly review" });
  await expect(weeklyRow).toBeVisible();
  await weeklyRow.click();

  // The detail panel's "Open task" must reach the weekly surface, not the queue
  // loop (the pre-fix behavior surfaced the next due Q&A card via /process).
  await page.getByTestId("library-detail-open").click();

  await expect(page.getByTestId("weekly-review")).toBeVisible();
  expect(page.url()).toContain("/weekly");

  await app.close();
});
