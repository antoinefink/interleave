/**
 * Home command center (`/`) E2E — drives the real Electron app.
 *
 * The Home dashboard is a READ-ONLY landing surface that composes two existing
 * typed reads — `window.appApi.queue.list` (due counts + budget + the sorted items
 * for a top-due preview) and `window.appApi.analytics.get` (streak, retention,
 * reviews-per-day) — and routes INTO the interactive surfaces (/process, /queue,
 * /review). The renderer never touches SQLite; every number rides the typed bridge
 * and is computed main-side in `packages/local-db`.
 *
 * This spec launches the built desktop app against a fresh data dir seeded with the
 * shared demo collection (driven by a fixed FUTURE `?asOf=` clock so the seeded due
 * items register as due) and asserts:
 *
 *   1. `/` renders `route-home` (NOT the old placeholder) with non-placeholder due
 *      counts + the budget meter + the reviews-per-day spark from seeded data;
 *   2. after grading one due card at `asOf`, the streak banner appears (a review on
 *      `asOf`'s day → a 1-day streak) — proving the streak is real, not invented;
 *   3. clicking `home-start-session` opens session preview and confirmation lands on the /process loop;
 *   4. NAV-EXCLUSIVITY — on `/` exactly one `.shell-nav [aria-current="page"]`
 *      exists and it is `nav-home` (and nav-library/nav-concepts are NOT
 *      current), preserving the ac73484 single-active-nav fix;
 *   5. the due counts SURVIVE AN APP RESTART (relaunch the same data dir → same
 *      count), per the definition-of-done restart requirement.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

/** A far-future clock so every seeded due item registers as due. */
const ASOF = "2031-01-01T12:00:00.000Z";

/** Open `/` (date-scoped via `?asOf=`) and wait for the home dashboard to render. */
async function openHome(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/?asOf=${encodeURIComponent(ASOF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-home")).toBeVisible();
}

/** The due-today count the dashboard shows at `ASOF` (via the typed bridge). */
async function dueCount(page: Page): Promise<number> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: { list(req: { asOf: string }): Promise<{ counts: { all: number } }> };
    };
    return (await api.queue.list({ asOf })).counts.all;
  }, ASOF);
}

/** Grade the next due card at `ASOF` with `rating` (the SAME path the review UI uses). */
async function gradeNext(page: Page, rating: "again" | "good"): Promise<void> {
  await page.evaluate(
    async ({ asOf, rating }) => {
      const api = window.appApi as unknown as {
        review: {
          sessionNext(req: { asOf: string }): Promise<{ card: { id: string } | null }>;
          grade(req: {
            cardId: string;
            rating: string;
            responseMs: number;
            asOf: string;
          }): Promise<unknown>;
        };
      };
      const next = await api.review.sessionNext({ asOf });
      if (!next.card) throw new Error(`no due card at ${asOf}`);
      await api.review.grade({ cardId: next.card.id, rating, responseMs: 1500, asOf });
    },
    { asOf: ASOF, rating },
  );
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("/ renders the home command center with seeded due counts + budget + spark", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  await openHome(page);

  // The hero overload strip: budget meter + at-risk metrics render.
  await expect(page.getByTestId("budget-meter")).toBeVisible();
  await expect(page.getByTestId("home-due-today")).toBeVisible();
  await expect(page.getByTestId("home-spark")).toBeVisible();

  // Non-placeholder: the due-today metric matches the typed read (and is > 0 for the
  // seeded collection), so we are showing real data, not the old static placeholder.
  const due = await dueCount(page);
  expect(due).toBeGreaterThan(0);
  expect(await page.getByTestId("home-due-today").textContent()).toBe(String(due));

  // The seeded collection has at least one leech → the maintenance nudge links out.
  await expect(page.getByTestId("home-banner-leeches")).toBeVisible();

  await app.close();
});

test("grading a due card makes the streak banner appear (real, not invented)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // A fresh seed has no reviews → no streak. Grade one due card at `asOf` so a review
  // lands on `asOf`'s day, producing a 1-day streak the dashboard then surfaces.
  await gradeNext(page, "good");

  await openHome(page);
  await expect(page.getByTestId("home-streak")).toBeVisible();
  expect(await page.getByTestId("home-streak").textContent()).toContain("streak");

  await app.close();
});

test("Start session previews and confirms the /process loop", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openHome(page);
  await page.getByTestId("home-start-session").click();
  await expect(page.getByTestId("session-preview")).toBeVisible();
  await page.getByTestId("session-preview-start").click();
  await expect(page).toHaveURL(/\/process/);
  await expect(page.getByTestId("route-process")).toBeVisible();

  await app.close();
});

test("Library quick tile opens the Collection Explorer Browse mode", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openHome(page);
  await page.getByTestId("home-tile-library").click();
  await expect(page).toHaveURL(/\/library/);
  await expect(page.getByTestId("route-library")).toBeVisible();
  await expect(page.getByTestId("nav-library")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-search")).toHaveCount(0);

  await app.close();
});

test("NAV-EXCLUSIVITY — on `/` exactly one nav item is current, and it is nav-home", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openHome(page);

  // Exactly one sidebar entry carries aria-current="page", and it is Home.
  const activeNav = page.locator('.shell-nav [aria-current="page"]');
  await expect(activeNav).toHaveCount(1);
  await expect(page.getByTestId("nav-home")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-search")).toHaveCount(0);
  await expect(page.getByTestId("nav-library")).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-concepts")).not.toHaveAttribute("aria-current", "page");

  await app.close();
});

test("the home due counts survive an app restart", async () => {
  // First launch: record the due count at `asOf`. (Prior serial tests graded /
  // processed some seeded items, so this may be any value ≥ 0 — what matters for the
  // definition-of-done restart requirement is that it is IDENTICAL after a relaunch,
  // recomputed from the durable SQLite store, and that the dashboard renders it.)
  const app1 = await launchApp(dataDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  await openHome(page1);
  const count1 = await dueCount(page1);
  expect(await page1.getByTestId("home-due-today").textContent()).toBe(String(count1));
  await app1.close();

  // Relaunch against the SAME data dir — the counts are recomputed from the durable
  // SQLite store, so the dashboard shows the same number after restart.
  const app2 = await launchApp(dataDir);
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  await openHome(page2);
  const count2 = await dueCount(page2);
  expect(count2).toBe(count1);
  expect(await page2.getByTestId("home-due-today").textContent()).toBe(String(count2));
  await app2.close();
});
