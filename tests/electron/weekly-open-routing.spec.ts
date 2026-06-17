/**
 * Queue "Open" -> weekly routing E2E — drives the real Electron app.
 *
 * Regression for the bug where opening the system "Weekly review" task surfaced the
 * next due Q&A card (via the /process queue loop) instead of the weekly review surface.
 * Root cause: the queue-item IPC read-model contract dropped `taskType`, so the
 * renderer's central `openQueueItem` helper could not match its
 * `taskType === "weekly_review"` branch and fell through to /process. Unit + component
 * tests cover the mapper and the renderer seam in isolation; this spec proves the field
 * now survives the REAL renderer<->main IPC round-trip (the layer those tests cannot
 * exercise):
 *
 *   1. enabling weekly review through the typed settings bridge creates the recurring
 *      "Weekly review" system task, made immediately due by re-creating the session
 *      after the seeded material exists;
 *   2. in /queue, selecting that task's row and clicking "Open" lands on the /weekly
 *      surface — NOT the /process queue loop, NOT a /card detail.
 *
 * The Queue (not the Library) is the driving surface: commit 0aa7a1f9 made the Library
 * browse intentionally EXCLUDE system-owned tasks (weekly_review / reread_region), so
 * the weekly task no longer appears there. The Queue still surfaces the due weekly task
 * and routes it through the same `openQueueItem` helper this regression guards.
 *
 * Launches the built desktop app against a fresh data dir seeded with the shared demo
 * collection.
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

/** Toggle the weekly-review setting through the typed settings bridge (no raw SQL). */
async function setWeeklyReviewEnabled(page: Page, value: boolean): Promise<void> {
  await page.evaluate(async (enabled) => {
    const api = window.appApi as unknown as {
      settings: { updateMany(req: { patch: Record<string, unknown> }): Promise<unknown> };
    };
    await api.settings.updateMany({ patch: { weeklyReviewEnabled: enabled } });
  }, value);
}

/**
 * Establish a genuinely DUE weekly session. The desktop creates a weekly session at
 * DB-open time (before the demo seed runs), so the boot session is not-yet-due.
 * Toggling the setting off dismisses it, and toggling it back on re-creates the session
 * now that the seeded material exists — so the session is immediately due and the
 * "Weekly review" task surfaces in the queue. Pure typed-bridge calls.
 */
async function makeDueWeeklySession(page: Page): Promise<void> {
  await setWeeklyReviewEnabled(page, false);
  await setWeeklyReviewEnabled(page, true);
}

test("Queue 'Open' on the weekly-review task routes to /weekly", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // Enabling weekly review (re-created after the seed) creates an immediately-due
  // "Weekly review" system task.
  await makeDueWeeklySession(page);

  // Browse the due queue; the task row carries the weekly-review row.
  await page.goto(`${baseUrl}/queue`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();

  const weeklyRow = page.getByTestId("queue-item").filter({ hasText: "Weekly review" });
  await expect(weeklyRow).toBeVisible();

  // Opening the weekly-review queue item must reach the weekly surface, not the queue
  // loop (the pre-fix behavior surfaced the next due Q&A card via /process).
  await weeklyRow.getByTestId("queue-open").click();

  await expect(page.getByTestId("weekly-review")).toBeVisible();
  expect(page.url()).toContain("/weekly");

  await app.close();
});
