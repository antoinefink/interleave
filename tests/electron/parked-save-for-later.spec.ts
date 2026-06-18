/**
 * Parked Save-for-later E2E (T101).
 *
 * Drives the real Electron app through the typed renderer bridge:
 *  - a manual inbox source is saved for later from the Inbox UI;
 *  - the row becomes `parked`, gains `parkedAt`, and leaves Inbox/Queue;
 *  - the parked state survives an app restart;
 *  - Library's Parked facet shows the row and can move it back to Inbox.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

const TITLE = "Parked E2E reading";
const AS_OF = "2099-01-01T00:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
});

function baseUrl(page: Page): string {
  const url = new URL(page.url());
  return `${url.protocol}//${url.host}`;
}

async function parkedState(page: Page) {
  return page.evaluate(
    async ({ title, asOf }) => {
      const api = window.appApi as unknown as {
        inbox: { list(): Promise<{ items: { id: string; title: string }[] }> };
        queue: {
          list(request: { asOf: string }): Promise<{ items: { id: string; title: string }[] }>;
        };
        library: {
          browse(request: { statuses?: string[] }): Promise<{
            items: {
              id: string;
              title: string;
              status: string;
              parkedAt: string | null;
            }[];
            counts: { byStatus: Record<string, number> };
          }>;
        };
      };
      const [inbox, queue, parked] = await Promise.all([
        api.inbox.list(),
        api.queue.list({ asOf }),
        api.library.browse({ statuses: ["parked"] }),
      ]);
      return {
        inboxHasTitle: inbox.items.some((item) => item.title === title),
        queueHasTitle: queue.items.some((item) => item.title === title),
        parked: parked.items.find((item) => item.title === title) ?? null,
        parkedCount: parked.counts.byStatus.parked ?? 0,
      };
    },
    { title: TITLE, asOf: AS_OF },
  );
}

test("Save for later parks an inbox source, persists, and restores from Library", async () => {
  const dir = makeDataDir();
  let app = await launchApp(dir);
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await page.getByTestId("inbox-empty-new").click();
  await expect(page.getByTestId("new-source-modal")).toBeVisible();
  await page.getByTestId("new-source-title").fill(TITLE);
  await page.getByTestId("new-source-submit").click();
  await expect(page.getByTestId("new-source-modal")).toBeHidden();
  await expect(page.getByTestId("inbox-row").filter({ hasText: TITLE })).toBeVisible();

  await page.getByTestId("inbox-keep").click();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  const parkedBeforeRestart = await parkedState(page);
  expect(parkedBeforeRestart.inboxHasTitle).toBe(false);
  expect(parkedBeforeRestart.queueHasTitle).toBe(false);
  expect(parkedBeforeRestart.parked).toMatchObject({ title: TITLE, status: "parked" });
  expect(parkedBeforeRestart.parked?.parkedAt).toBeTruthy();

  await app.close();

  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = baseUrl(page);

  const parkedAfterRestart = await parkedState(page);
  expect(parkedAfterRestart.inboxHasTitle).toBe(false);
  expect(parkedAfterRestart.queueHasTitle).toBe(false);
  expect(parkedAfterRestart.parked).toMatchObject({ title: TITLE, status: "parked" });
  expect(parkedAfterRestart.parked?.parkedAt).toBe(parkedBeforeRestart.parked?.parkedAt);

  await page.goto(`${url}/library`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-library")).toBeVisible();
  await page.getByTestId("library-filter-status-parked").click();
  const row = page.getByTestId("library-group-source").getByTestId("library-result").filter({
    hasText: TITLE,
  });
  await expect(row).toBeVisible();
  await row.click();
  // The parked controls + "Parked {date}" context line relocated from the removed
  // detail column into the shared shell inspector.
  await expect(page.getByTestId("inspector-parked-date")).toContainText("Parked");

  await page.getByTestId("inspector-parked-inbox").click();
  await expect(row).toHaveCount(0);

  const restored = await parkedState(page);
  expect(restored.parked).toBeNull();
  expect(restored.inboxHasTitle).toBe(true);
  expect(restored.queueHasTitle).toBe(false);

  await app.close();
});
