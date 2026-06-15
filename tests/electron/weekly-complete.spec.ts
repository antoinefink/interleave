/**
 * Weekly Review "Complete" -> acknowledgment E2E — drives the real Electron app.
 *
 * Regression for the bug where clicking "Complete" on the Weekly Review screen
 * silently re-rendered what looked like the SAME session with every Done/Skipped
 * pill reset to Pending and the same week window — indistinguishable from "Complete
 * erased all my work." The real cause: `completeSession()` correctly creates the
 * NEXT session with `dueAt = now + cadence` (so the surfaced summary becomes
 * `due === false` while `session` stays non-null), but the renderer only gated the
 * editable form on `summary.session` presence and never on `summary.due`
 * actionability, so it rendered a fresh, reset-looking editable form.
 *
 * The fix makes `WeeklyReviewBody` render a calm complete-acknowledgment panel when
 * `summary.session && !summary.due`. Unit + component tests cover that branch (and
 * the StrictMode mount-guard family, the no-loading-flash transition, banner
 * precedence) in isolation against mocked summaries. This spec proves the behavior
 * end-to-end through the REAL renderer<->main IPC + persistence round-trip — the
 * layer those tests cannot exercise: that clicking Complete actually drives the
 * live `completeWeeklyReview` mutation, the next session is persisted with a future
 * `dueAt`, the background (stale-while-revalidate) reload surfaces `due === false`,
 * and the live UI lands on the acknowledgment state rather than a silently-reset
 * editable form.
 *
 *   1. a genuinely DUE session is established through the typed settings bridge:
 *      the demo collection is seeded at boot, but the desktop's open-time
 *      `initializeSession` runs BEFORE the seed populates material, so the
 *      boot-created session is created not-yet-due. Toggling weekly review off then
 *      on re-creates the session AFTER material exists, so `initialDueAt` returns
 *      `now` and the session is immediately due (verified: `summary.due === true`);
 *   2. /weekly shows the EDITABLE form (`weekly-review`), not the acknowledgment;
 *   3. clicking the header "Complete" action transitions the live app into the
 *      `weekly-complete` acknowledgment panel ("Weekly review complete" +
 *      "Next session due <date>"), and the editable form is gone;
 *   4. the "Review now" escape hatch reopens the editable form for the not-yet-due
 *      session — proving no capability is lost.
 *
 * Launches the built desktop app against a fresh data dir seeded with the shared
 * demo collection.
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
 * Toggling the setting off dismisses it, and toggling it back on re-creates the
 * session now that the seeded material exists — so `initialDueAt` returns `now` and
 * the session is immediately due (the editable-form path). Pure typed-bridge calls.
 */
async function makeDueWeeklySession(page: Page): Promise<void> {
  await setWeeklyReviewEnabled(page, false);
  await setWeeklyReviewEnabled(page, true);
}

test("Weekly review 'Complete' transitions the live app into the acknowledgment state", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // Re-create the weekly session after seeded material exists so it is immediately due.
  await makeDueWeeklySession(page);

  // Open the weekly surface. The session is due, so the EDITABLE form renders and the
  // acknowledgment panel is NOT yet present.
  await page.goto(`${baseUrl}/weekly`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("weekly-review")).toBeVisible();
  await expect(page.getByTestId("weekly-complete")).toHaveCount(0);

  // Click the header "Complete" action. It carries no testid; its accessible name is
  // unambiguous on this screen.
  await page.getByRole("button", { name: "Complete", exact: true }).click();

  // The live `completeWeeklyReview` mutation creates the next (not-yet-due) session,
  // the background reload surfaces `due === false`, and the body lands on the
  // complete-acknowledgment panel — never a reset-looking editable form.
  await expect(page.getByTestId("weekly-complete")).toBeVisible();
  await expect(page.getByText("Weekly review complete")).toBeVisible();
  await expect(page.getByText(/Next session due/)).toBeVisible();
  await expect(page.getByTestId("weekly-review")).toHaveCount(0);

  // The "Review now" escape hatch reopens the editable form for the not-yet-due
  // session — proving no capability is lost relative to before the gate.
  await page.getByTestId("weekly-review-now").click();
  await expect(page.getByTestId("weekly-review")).toBeVisible();
  await expect(page.getByTestId("weekly-complete")).toHaveCount(0);

  await app.close();
});
