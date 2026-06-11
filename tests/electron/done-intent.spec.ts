/**
 * Partial-source "Done" intent surface (DoneIntentMenu) E2E.
 *
 * Pressing Done on a source that still has unresolved blocks no longer fires a native
 * `window.confirm` — it opens a non-modal in-app surface offering Return later / Finished /
 * Abandon. This spec proves, against the real Electron app:
 *
 *   1. the surface appears in-app (no native dialog) and renders the per-state breakdown;
 *   2. Finished marks the source done and the status survives an app restart;
 *   3. Return later reschedules the source WITHOUT touching its read-point, and both the
 *      schedule and the read-point survive a restart (read-point/due-date stay decoupled);
 *   4. Abandon dismisses; Escape cancels with NO mutation;
 *   5. in the queue list, Finished raises a snackbar whose Undo restores the prior status.
 *
 * Every intent routes through the SAME typed `queue.act` mutations the rest of the app uses —
 * no new channel — so persistence behaves exactly like the list/loop paths.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

let baseUrl = "";

/** A fixed future clock so the seeded/near-future due dates read as due in the list. */
const AS_OF = "2027-06-01T12:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
});

async function captureBaseUrl(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
}

/** The seeded ACTIVE source with a document body (its blocks are all unread → unresolved). */
async function findSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{
          elements: { id: string; type: string; status: string; title: string }[];
        }>;
      };
    };
    const { elements } = await api.inspector.list();
    const source =
      elements.find((e) => e.type === "source" && e.title.includes("Measure of Intelligence")) ??
      elements.find((e) => e.type === "source" && e.status === "active");
    if (!source) throw new Error("seeded active source with a body not found");
    return source.id;
  });
}

async function inspect(
  page: Page,
  id: string,
): Promise<{ status: string; dueAt: string | null } | null> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: {
          id: string;
        }): Promise<{ data: { element: { status: string; dueAt: string | null } } | null }>;
      };
    };
    const res = await api.inspector.get({ id: elementId });
    return res.data?.element ?? null;
  }, id);
}

async function setReadPoint(
  page: Page,
  id: string,
  blockId: string,
  offset: number,
): Promise<void> {
  await page.evaluate(
    async ({ id, blockId, offset }) => {
      const api = window.appApi as unknown as {
        readPoints: {
          set(req: {
            elementId: string;
            documentId: string;
            blockId: string;
            offset: number;
          }): Promise<unknown>;
        };
      };
      await api.readPoints.set({ elementId: id, documentId: id, blockId, offset });
    },
    { id, blockId, offset },
  );
}

async function getReadPoint(page: Page, id: string): Promise<{ blockId: string } | null> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      readPoints: {
        get(req: { elementId: string }): Promise<{ readPoint: { blockId: string } | null }>;
      };
    };
    const res = await api.readPoints.get({ elementId });
    return res.readPoint;
  }, id);
}

async function scheduleDueNow(page: Page, id: string): Promise<void> {
  await page.evaluate(
    async ({ id, dueAt }) => {
      const api = window.appApi as unknown as {
        queue: {
          schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
        };
      };
      await api.queue.schedule({ id, choice: { kind: "manual", date: dueAt } });
    },
    { id, dueAt: "2027-05-30T12:00:00.000Z" },
  );
}

async function openReader(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-mark-done")).toBeVisible();
}

async function openProcess(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/process?asOf=${encodeURIComponent(AS_OF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-process")).toBeVisible();
}

/** Skip through the in-session loop until the given element is the active item. */
async function moveLoopTo(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (
      await page
        .getByTestId("process-done")
        .isVisible()
        .catch(() => false)
    ) {
      throw new Error(`reached the done state before ${id} surfaced in the loop`);
    }
    const item = page.getByTestId("process-item");
    await expect(item).toHaveCount(1);
    if ((await item.getAttribute("data-element-id")) === id) return;
    await item.getByTestId("process-action-skip").click();
    await page.waitForTimeout(40);
  }
  throw new Error(`loop item ${id} did not surface`);
}

test("reader Done opens the intent surface (no native dialog) and Finished persists across restart", async () => {
  const dir = makeDataDir();
  let app = await launchApp(dir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await captureBaseUrl(page);

  // A native window.confirm would surface as a Playwright 'dialog' — fail if one ever fires.
  let dialogFired = false;
  page.on("dialog", (d) => {
    dialogFired = true;
    void d.dismiss();
  });

  const id = await findSourceId(page);
  await openReader(page, id);

  await page.getByTestId("reader-mark-done").click();
  await expect(page.getByTestId("done-intent-pop")).toBeVisible();
  await expect(page.getByTestId("done-intent-breakdown")).toBeVisible();

  await page.getByTestId("done-intent-finished").click();
  await expect.poll(async () => (await inspect(page, id))?.status).toBe("done");
  expect(dialogFired).toBe(false);

  await app.close();

  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  expect((await inspect(page, id))?.status).toBe("done");
  await app.close();
});

test("Return later reschedules the source and its read-point survives a restart", async () => {
  const dir = makeDataDir();
  let app = await launchApp(dir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await captureBaseUrl(page);

  const id = await findSourceId(page);
  // A read-point is "where reading stopped"; Return later must not touch it.
  await setReadPoint(page, id, "blk_intro_p2", 7);

  await openReader(page, id);
  await page.getByTestId("reader-mark-done").click();
  await expect(page.getByTestId("done-intent-pop")).toBeVisible();
  await page.getByTestId("done-intent-later").click();

  // Stays active/scheduled (NOT done/dismissed) with a return date, and the reader does not leave.
  await expect.poll(async () => (await inspect(page, id))?.dueAt).not.toBeNull();
  const after = await inspect(page, id);
  expect(after?.status === "done" || after?.status === "dismissed").toBe(false);

  await app.close();

  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const rp = await getReadPoint(page, id);
  expect(rp?.blockId).toBe("blk_intro_p2");
  const restored = await inspect(page, id);
  expect(restored?.status === "done" || restored?.status === "dismissed").toBe(false);
  expect(restored?.dueAt).not.toBeNull();
  await app.close();
});

test("Abandon dismisses the source; Escape cancels with no mutation", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await captureBaseUrl(page);

  const id = await findSourceId(page);
  const before = await inspect(page, id);
  await openReader(page, id);

  // Escape cancels — surface closes, status unchanged.
  await page.getByTestId("reader-mark-done").click();
  await expect(page.getByTestId("done-intent-pop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("done-intent-pop")).toHaveCount(0);
  expect((await inspect(page, id))?.status).toBe(before?.status);

  // Abandon → dismissed.
  await page.getByTestId("reader-mark-done").click();
  await expect(page.getByTestId("done-intent-pop")).toBeVisible();
  await page.getByTestId("done-intent-abandon").click();
  await expect.poll(async () => (await inspect(page, id))?.status).toBe("dismissed");

  await app.close();
});

test("queue-list Finished raises a snackbar whose Undo restores the prior status", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await captureBaseUrl(page);

  const id = await findSourceId(page);
  await scheduleDueNow(page, id);
  const before = await inspect(page, id);

  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(AS_OF)}`);
  await page.waitForLoadState("domcontentloaded");
  const row = page.locator(`[data-testid="queue-item"][data-element-id="${id}"]`);
  await expect(row).toBeVisible();

  await row.getByTestId("queue-action-markDone").click();
  await expect(page.getByTestId("done-intent-pop")).toBeVisible();
  await page.getByTestId("done-intent-finished").click();

  await expect.poll(async () => (await inspect(page, id))?.status).toBe("done");
  await expect(page.getByTestId("queue-snackbar")).toBeVisible();

  await page.getByTestId("queue-snackbar-undo").click();
  await expect
    .poll(async () => (await inspect(page, id))?.status)
    .toBe(before?.status ?? "scheduled");

  await app.close();
});

test("in-session loop Done on a source opens the surface (no native dialog) and Finished marks it done", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await captureBaseUrl(page);

  let dialogFired = false;
  page.on("dialog", (d) => {
    dialogFired = true;
    void d.dismiss();
  });

  const id = await findSourceId(page);
  await scheduleDueNow(page, id);

  await openProcess(page);
  await moveLoopTo(page, id);

  await page.getByTestId("process-action-markDone").click();
  await expect(page.getByTestId("done-intent-pop")).toBeVisible();
  await page.getByTestId("done-intent-finished").click();

  await expect.poll(async () => (await inspect(page, id))?.status).toBe("done");
  expect(dialogFired).toBe(false);

  await app.close();
});
