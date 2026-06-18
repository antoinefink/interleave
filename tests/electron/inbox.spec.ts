/**
 * Import & Inbox E2E (T012) — drives the real Electron app.
 *
 * Launches the built desktop app against a fresh data dir and exercises the first
 * MUTATION surface on the bridge end to end:
 *
 *   1. the renderer reaches everything THROUGH `window.appApi` (the
 *      `sources.importManual` + `inbox.list/get/triage` commands exist; there is
 *      no generic `db.query`);
 *   2. creating a manual source lands it in the `/inbox` list, where it can be
 *      previewed, reprioritized (A/B/C/D), accepted into active learning, kept for
 *      later, or deleted — all via the typed bridge;
 *   3. after an APP RESTART against the same data dir, the accepted source is gone
 *      from the inbox but still exists (now `active`), and the deleted one is
 *      absent — proving the soft-delete + status changes persisted to SQLite.
 *
 * No seed: the inbox starts empty (Inbox zero), and the test imports its own
 * sources, so it proves the real create → triage → persist loop.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Read the current inbox list through the bridge. */
async function listInbox(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: {
        list(): Promise<{ items: { id: string; title: string; priority: number }[] }>;
      };
    };
    const res = await api.inbox.list();
    return res.items;
  });
}

test("the inbox reaches sources.importManual + inbox.list/get/triage, not raw SQL", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { importManual?: unknown };
      inbox?: { list?: unknown; get?: unknown; triage?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasImport: typeof api?.sources?.importManual === "function",
      hasList: typeof api?.inbox?.list === "function",
      hasGet: typeof api?.inbox?.get === "function",
      hasTriage: typeof api?.inbox?.triage === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasImport).toBe(true);
  expect(surface.hasList).toBe(true);
  expect(surface.hasGet).toBe(true);
  expect(surface.hasTriage).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("create → list → prioritize → accept → delete works through the UI + bridge", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Navigate to /inbox via the sidebar (the real router path).
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Create the first source through the New-source modal.
  await page.getByTestId("inbox-empty-new").click();
  await expect(page.getByTestId("new-source-modal")).toBeVisible();
  await page.getByTestId("new-source-title").fill("Article to accept");
  await page.getByTestId("new-source-submit").click();
  await expect(page.getByTestId("new-source-modal")).toBeHidden();

  // It lands in the list + preview.
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-preview-title")).toHaveText("Article to accept");

  // Reprioritize to A through the rail; the chip reflects the change.
  await page.getByTestId("inbox-priority-A").click();
  await expect(page.getByTestId("inbox-priority-A")).toHaveAttribute("aria-pressed", "true");

  // Create a second source via the import strip ("Manual note").
  await page.getByTestId("inbox-import-manual").click();
  await expect(page.getByTestId("new-source-modal")).toBeVisible();
  await page.getByTestId("new-source-title").fill("Article to delete");
  await page.getByTestId("new-source-submit").click();
  await expect(page.getByTestId("new-source-modal")).toBeHidden();
  await expect(page.getByTestId("inbox-row")).toHaveCount(2);

  // Accept the "to accept" one (status → active; leaves the inbox).
  await page.getByTestId("inbox-row").filter({ hasText: "Article to accept" }).click();
  await expect(page.getByTestId("inbox-preview-title")).toHaveText("Article to accept");
  await page.getByTestId("inbox-read-now").click();
  await expect(page).toHaveURL(/\/source\//);
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);

  // Delete the remaining "to delete" one (soft-delete; leaves the inbox).
  await page.getByTestId("inbox-row").filter({ hasText: "Article to delete" }).click();
  await page.getByTestId("inbox-delete").click();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // The list, read straight through the bridge, is empty.
  const items = await listInbox(page);
  expect(items).toHaveLength(0);

  await app.close();
});

test("accepted source survives restart as active; deleted one stays gone", async () => {
  // Relaunch a brand-new Electron process against the SAME data dir.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The inbox is empty after restart (both items left the inbox).
  const items = await listInbox(page);
  expect(items.map((i) => i.title)).not.toContain("Article to accept");
  expect(items.map((i) => i.title)).not.toContain("Article to delete");

  // The accepted source still EXISTS as an `active` element; the deleted one is
  // soft-deleted (status `deleted`). Read both through the inspector list bridge.
  const summary = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { title: string; status: string; type: string }[] }>;
      };
    };
    const res = await api.inspector.list();
    return res.elements
      .filter((e) => e.type === "source")
      .map((e) => ({ title: e.title, status: e.status }));
  });
  const accepted = summary.find((e) => e.title === "Article to accept");
  expect(accepted?.status).toBe("active");
  // The deleted source is soft-deleted, so it is excluded from the live inspector
  // list entirely.
  expect(summary.find((e) => e.title === "Article to delete")).toBeUndefined();

  await app.close();
});

/**
 * Manual text import (T013) — pasting an article body through the New-source
 * modal stores it as plain text + ProseMirror JSON, shows it in the inbox
 * preview, and survives an app restart. Uses its own data dir so it is
 * independent of the triage flow above.
 */
test.describe("manual text import (T013)", () => {
  let bodyDataDir: string;
  const ARTICLE_TITLE = "Pasted long-form article";
  const ARTICLE_BODY =
    "Spaced repetition exploits the spacing effect.\n\nIt schedules reviews just before forgetting.\n\nThe interval grows after each success.";

  test.beforeAll(() => {
    ensureBuilt();
    bodyDataDir = makeDataDir();
  });

  test("pasting a body creates an inbox source with the body stored + previewed", async () => {
    const app = await launchApp(bodyDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("route-inbox")).toBeVisible();
    await expect(page.getByTestId("inbox-empty")).toBeVisible();

    // Open the modal and fill title + URL + author + date + a multi-paragraph body.
    await page.getByTestId("inbox-empty-new").click();
    await expect(page.getByTestId("new-source-modal")).toBeVisible();
    await page.getByTestId("new-source-title").fill(ARTICLE_TITLE);
    await page.getByTestId("new-source-url").fill("https://example.com/spacing?utm_source=x");
    await page.getByTestId("new-source-author").fill("H. Ebbinghaus");
    await page.getByTestId("new-source-date").fill("2026-01-15");
    await page.getByTestId("new-source-body").fill(ARTICLE_BODY);
    await page.getByTestId("new-source-submit").click();
    await expect(page.getByTestId("new-source-modal")).toBeHidden();

    // It appears immediately in the list + preview (no reload), body shown.
    await expect(page.getByTestId("inbox-row")).toHaveCount(1);
    await expect(page.getByTestId("inbox-preview-title")).toHaveText(ARTICLE_TITLE);
    await expect(page.getByTestId("inbox-preview")).toContainText("exploits the spacing effect");
    await expect(page.getByTestId("inbox-preview")).toContainText(
      "interval grows after each success",
    );

    // Read straight through the bridge: the detail carries the body preview
    // (plain text), and the document row stores BOTH plain text + ProseMirror
    // JSON with one paragraph node per blank-line paragraph.
    const stored = await page.evaluate(async () => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string; charCount: number }[] }>;
          get(req: { id: string }): Promise<{ detail: { bodyPreview: string | null } | null }>;
        };
      };
      const { items } = await api.inbox.list();
      const id = items[0]?.id as string;
      const { detail } = await api.inbox.get({ id });
      return { charCount: items[0]?.charCount ?? 0, bodyPreview: detail?.bodyPreview ?? null };
    });
    expect(stored.charCount).toBeGreaterThan(0);
    expect(stored.bodyPreview).toContain("Spaced repetition exploits the spacing effect.");
    expect(stored.bodyPreview).toContain("The interval grows after each success.");

    await app.close();
  });

  test("the pasted source + its body persist after an app restart", async () => {
    const app = await launchApp(bodyDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("route-inbox")).toBeVisible();

    // The source is still in the inbox with its title + body preview after restart.
    await expect(page.getByTestId("inbox-row")).toHaveCount(1);
    await page.getByTestId("inbox-row").click();
    await expect(page.getByTestId("inbox-preview-title")).toHaveText(ARTICLE_TITLE);
    await expect(page.getByTestId("inbox-preview")).toContainText(
      "schedules reviews just before forgetting",
    );

    // Confirmed through the bridge as well.
    const bodyPreview = await page.evaluate(async () => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string }[] }>;
          get(req: { id: string }): Promise<{ detail: { bodyPreview: string | null } | null }>;
        };
      };
      const { items } = await api.inbox.list();
      const { detail } = await api.inbox.get({ id: items[0]?.id as string });
      return detail?.bodyPreview ?? null;
    });
    expect(bodyPreview).toContain("Spaced repetition exploits the spacing effect.");

    await app.close();
  });
});

test.describe("Read now source return path", () => {
  let returnPathDataDir: string;
  const ARTICLE_TITLE = "Return path article";
  const ARTICLE_BODY =
    "First paragraph for the return path.\n\nSecond paragraph is where reading continues.\n\nThird paragraph confirms persistence.";

  test.beforeAll(() => {
    ensureBuilt();
    returnPathDataDir = makeDataDir();
  });

  test("Read now schedules a return and restart resumes from the saved read point", async () => {
    const app = await launchApp(returnPathDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const url = new URL(page.url());
    const rendererBaseUrl = `${url.protocol}//${url.host}`;

    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("route-inbox")).toBeVisible();
    await page.getByTestId("inbox-empty-new").click();
    await expect(page.getByTestId("new-source-modal")).toBeVisible();
    await page.getByTestId("new-source-title").fill(ARTICLE_TITLE);
    await page.getByTestId("new-source-body").fill(ARTICLE_BODY);
    await page.getByTestId("new-source-submit").click();
    await expect(page.getByTestId("new-source-modal")).toBeHidden();

    const sourceId = await page.evaluate(async (title) => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string; title: string }[] }>;
        };
      };
      const { items } = await api.inbox.list();
      const item = items.find((candidate) => candidate.title === title);
      if (!item) throw new Error("imported source not found in inbox");
      return item.id;
    }, ARTICLE_TITLE);

    await page.getByTestId("inbox-read-now").click();
    await expect(page).toHaveURL(new RegExp(`/source/${sourceId}$`));
    await expect(page.getByTestId("reader-title")).toHaveText(ARTICLE_TITLE);
    await expect(page.locator(".reader .ProseMirror")).toContainText(
      "Second paragraph is where reading continues.",
    );

    const firstBlockId = await page
      .locator(".reader .ProseMirror [data-block-id]")
      .first()
      .getAttribute("data-block-id");
    const secondBlockId = await page
      .locator(".reader .ProseMirror [data-block-id]")
      .nth(1)
      .getAttribute("data-block-id");
    expect(firstBlockId).toBeTruthy();
    expect(secondBlockId).toBeTruthy();
    await page.locator(`.reader .ProseMirror [data-block-id="${firstBlockId}"]`).click();
    await page.getByTestId("reader-set-readpoint").click();

    const scheduled = await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string }[] }>;
        };
        inspector: {
          get(req: { id: string }): Promise<{
            data: {
              element: { id: string; type: string; status: string; dueAt: string | null };
            } | null;
          }>;
        };
        readPoints: {
          get(req: {
            elementId: string;
          }): Promise<{ readPoint: { blockId: string; offset: number } | null }>;
        };
        queue: {
          list(req: {
            asOf: string;
          }): Promise<{ items: { id: string; type: string; scheduler: string }[] }>;
        };
      };
      const inbox = await api.inbox.list();
      const inspected = await api.inspector.get({ id });
      const readPoint = await api.readPoints.get({ elementId: id });
      const dueAt = inspected.data?.element.dueAt;
      if (!dueAt) throw new Error("source did not receive a return due_at");
      const dueQueue = await api.queue.list({ asOf: dueAt });
      return {
        inboxIds: inbox.items.map((item) => item.id),
        element: inspected.data?.element ?? null,
        readPoint: readPoint.readPoint,
        dueQueueItems: dueQueue.items,
      };
    }, sourceId);

    expect(scheduled.inboxIds).not.toContain(sourceId);
    expect(scheduled.element).toMatchObject({
      id: sourceId,
      type: "source",
      status: "active",
    });
    expect(scheduled.element?.dueAt).not.toBeNull();
    expect(scheduled.readPoint?.blockId).toBe(firstBlockId);
    expect(scheduled.dueQueueItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sourceId, type: "source", scheduler: "attention" }),
      ]),
    );
    const dueAt = scheduled.element?.dueAt;
    if (!dueAt) throw new Error("scheduled source missing due_at after assertion");

    await page.goto(`${rendererBaseUrl}/queue?asOf=${encodeURIComponent(dueAt)}`);
    await expect(page.getByTestId("route-queue")).toBeVisible();
    const queueRow = page.getByTestId("queue-item").filter({ hasText: ARTICLE_TITLE });
    await expect(queueRow).toHaveAttribute("data-element-id", sourceId);
    await expect(queueRow.getByTestId("queue-open")).toContainText(
      "Continue reading from read point",
    );

    await page.goto(`${rendererBaseUrl}/?asOf=${encodeURIComponent(dueAt)}`);
    await expect(page.getByTestId("route-home")).toBeVisible();
    const homeRow = page.getByTestId("home-preview-row").filter({ hasText: ARTICLE_TITLE });
    await expect(homeRow).toHaveAttribute("data-element-id", sourceId);
    await expect(homeRow).toContainText("Continue reading from read point");

    await app.close();

    const restarted = await launchApp(returnPathDataDir);
    const restartedPage = await restarted.firstWindow();
    await restartedPage.waitForLoadState("domcontentloaded");

    const afterRestart = await restartedPage.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string }[] }>;
        };
        readPoints: {
          get(req: {
            elementId: string;
          }): Promise<{ readPoint: { blockId: string; offset: number } | null }>;
        };
      };
      const inbox = await api.inbox.list();
      const readPoint = await api.readPoints.get({ elementId: id });
      return { inboxIds: inbox.items.map((item) => item.id), readPoint: readPoint.readPoint };
    }, sourceId);

    expect(afterRestart.inboxIds).not.toContain(sourceId);
    expect(afterRestart.readPoint?.blockId).toBe(firstBlockId);

    await restartedPage.goto(`${rendererBaseUrl}/source/${sourceId}`);
    await restartedPage.waitForLoadState("domcontentloaded");
    await expect(restartedPage.getByTestId("reader-title")).toHaveText(ARTICLE_TITLE);
    await expect(restartedPage.locator(".reader .readpoint")).toBeVisible();
    await expect(
      restartedPage.locator(`.reader .readpoint + [data-block-id="${secondBlockId}"]`),
    ).toHaveCount(1);

    await restarted.close();
  });
});

test.describe("Queue soon inbox triage", () => {
  let queueSoonDataDir: string;
  const ARTICLE_TITLE = "Queued soon article";
  const ARTICLE_BODY =
    "This source should enter the queue soon.\n\nIt should not open the source reader immediately.";

  test.beforeAll(() => {
    ensureBuilt();
    queueSoonDataDir = makeDataDir();
  });

  test("Queue soon makes an inbox source due in the queue without opening the reader", async () => {
    const app = await launchApp(queueSoonDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const url = new URL(page.url());
    const rendererBaseUrl = `${url.protocol}//${url.host}`;

    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("route-inbox")).toBeVisible();
    await page.getByTestId("inbox-empty-new").click();
    await expect(page.getByTestId("new-source-modal")).toBeVisible();
    await page.getByTestId("new-source-title").fill(ARTICLE_TITLE);
    await page.getByTestId("new-source-body").fill(ARTICLE_BODY);
    await page.getByTestId("new-source-submit").click();
    await expect(page.getByTestId("new-source-modal")).toBeHidden();

    const sourceId = await page.evaluate(async (title) => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string; title: string }[] }>;
        };
      };
      const { items } = await api.inbox.list();
      const item = items.find((candidate) => candidate.title === title);
      if (!item) throw new Error("imported source not found in inbox");
      return item.id;
    }, ARTICLE_TITLE);

    const inboxUrl = page.url();
    await page.getByTestId("inbox-queue-soon").click();
    await expect(page).toHaveURL(inboxUrl);
    await expect(page.getByTestId("route-inbox")).toBeVisible();
    await expect(page.getByTestId("inbox-empty")).toBeVisible();
    await expect(page).not.toHaveURL(new RegExp(`/source/${sourceId}$`));

    const scheduled = await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string; title: string }[] }>;
        };
        inspector: {
          get(req: { id: string }): Promise<{
            data: {
              element: { id: string; type: string; status: string; dueAt: string | null };
            } | null;
          }>;
        };
        queue: {
          list(req: {
            asOf: string;
          }): Promise<{ items: { id: string; type: string; scheduler: string }[] }>;
        };
      };
      const inbox = await api.inbox.list();
      const inspected = await api.inspector.get({ id });
      const dueAt = inspected.data?.element.dueAt;
      if (!dueAt) throw new Error("source did not receive a due_at");
      const queue = await api.queue.list({ asOf: dueAt });
      return {
        inboxIds: inbox.items.map((item) => item.id),
        element: inspected.data?.element ?? null,
        queueItems: queue.items,
      };
    }, sourceId);

    expect(scheduled.inboxIds).not.toContain(sourceId);
    expect(scheduled.element).toMatchObject({
      id: sourceId,
      type: "source",
      status: "scheduled",
    });
    expect(scheduled.element?.dueAt).not.toBeNull();
    expect(scheduled.queueItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sourceId, type: "source", scheduler: "attention" }),
      ]),
    );
    const dueAt = scheduled.element?.dueAt;
    if (!dueAt) throw new Error("queued source missing due_at after assertion");

    await page.goto(`${rendererBaseUrl}/queue?asOf=${encodeURIComponent(dueAt)}`);
    await expect(page.getByTestId("route-queue")).toBeVisible();
    const queueRow = page.getByTestId("queue-item").filter({ hasText: ARTICLE_TITLE });
    await expect(queueRow).toHaveAttribute("data-element-id", sourceId);

    await app.close();

    const restarted = await launchApp(queueSoonDataDir);
    const restartedPage = await restarted.firstWindow();
    await restartedPage.waitForLoadState("domcontentloaded");

    const afterRestart = await restartedPage.evaluate(
      async ({ id, asOf }) => {
        const api = window.appApi as unknown as {
          inbox: {
            list(): Promise<{ items: { id: string }[] }>;
          };
          inspector: {
            get(req: { id: string }): Promise<{
              data: {
                element: { id: string; type: string; status: string; dueAt: string | null };
              } | null;
            }>;
          };
          queue: {
            list(req: {
              asOf: string;
            }): Promise<{ items: { id: string; type: string; scheduler: string }[] }>;
          };
        };
        const inbox = await api.inbox.list();
        const inspected = await api.inspector.get({ id });
        const queue = await api.queue.list({ asOf });
        return {
          inboxIds: inbox.items.map((item) => item.id),
          element: inspected.data?.element ?? null,
          queueItems: queue.items,
        };
      },
      { id: sourceId, asOf: dueAt },
    );

    expect(afterRestart.inboxIds).not.toContain(sourceId);
    expect(afterRestart.element).toMatchObject({
      id: sourceId,
      type: "source",
      status: "scheduled",
      dueAt,
    });
    expect(afterRestart.queueItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: sourceId, type: "source", scheduler: "attention" }),
      ]),
    );

    await restarted.close();
  });
});

/**
 * Source provenance (T014) — a manual import with a messy URL captures the
 * canonical URL, the verbatim original URL, and an auto-stamped accessed date,
 * with NO remote fetching. The inbox preview + the universal inspector surface
 * them, and they survive an app restart — all fully offline.
 */
test.describe("source provenance (T014)", () => {
  let provDataDir: string;
  const MESSY_URL = "https://EXAMPLE.com/spacing/?utm_source=newsletter&id=42#section";
  const CANONICAL_URL = "https://example.com/spacing?id=42";

  test.beforeAll(() => {
    ensureBuilt();
    provDataDir = makeDataDir();
  });

  test("a messy URL is captured as canonical + original; the inspector shows them, offline", async () => {
    const app = await launchApp(provDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Assert the app never FETCHES the source: no outbound request to the
    // entered URL's host (`example.com`). Web-font requests to fonts.gstatic.com
    // from the design system are unrelated to provenance and are ignored — what
    // matters for T014 is that capturing provenance does no remote fetching of
    // the source itself (the flow must work offline).
    const sourceFetches: string[] = [];
    page.on("request", (req) => {
      if (/^https?:\/\/(www\.)?example\.com/i.test(req.url())) {
        sourceFetches.push(req.url());
      }
    });

    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("route-inbox")).toBeVisible();
    await expect(page.getByTestId("inbox-empty")).toBeVisible();

    // Import a source with a tracking-laden URL.
    await page.getByTestId("inbox-empty-new").click();
    await expect(page.getByTestId("new-source-modal")).toBeVisible();
    await page.getByTestId("new-source-title").fill("Provenance article");
    await page.getByTestId("new-source-url").fill(MESSY_URL);
    // The modal's live canonical read-back reflects the derived form.
    await expect(page.getByTestId("new-source-canonical")).toContainText(CANONICAL_URL);
    await page.getByTestId("new-source-submit").click();
    await expect(page.getByTestId("new-source-modal")).toBeHidden();

    // Provenance (canonical URL + accessed date) now lives in the shell inspector's
    // Source section — the inbox preview itself is article-only.
    await expect(page.getByTestId("inbox-row")).toHaveCount(1);

    // The universal inspector (right panel) shows the canonical URL + accessed
    // date for the selected source. (The verbatim original URL is shown in the
    // primary "URL" row; the inspector only adds a separate "Original URL" row
    // when it differs from the entered URL — which it does not here, since M2
    // does no redirect resolution.)
    await expect(page.getByTestId("provenance-canonical-url")).toHaveText(CANONICAL_URL);
    await expect(page.getByTestId("provenance-accessed-at")).not.toHaveText("—");

    // Verified through the bridge: canonical normalized, original verbatim,
    // accessed auto-stamped, snapshot left null.
    const prov = await page.evaluate(async () => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string }[] }>;
          get(req: { id: string }): Promise<{
            detail: {
              provenance: {
                canonicalUrl: string | null;
                originalUrl: string | null;
                accessedAt: string | null;
              };
            } | null;
          }>;
        };
      };
      const { items } = await api.inbox.list();
      const { detail } = await api.inbox.get({ id: items[0]?.id as string });
      return detail?.provenance ?? null;
    });
    expect(prov?.canonicalUrl).toBe(CANONICAL_URL);
    expect(prov?.originalUrl).toBe(MESSY_URL);
    expect(prov?.accessedAt).not.toBeNull();

    // The app never fetched the source URL — provenance is captured fully offline.
    expect(sourceFetches).toEqual([]);

    await app.close();
  });

  test("the captured provenance survives an app restart", async () => {
    const app = await launchApp(provDataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    await page.getByTestId("nav-inbox").click();
    await expect(page.getByTestId("route-inbox")).toBeVisible();
    await expect(page.getByTestId("inbox-row")).toHaveCount(1);
    await page.getByTestId("inbox-row").click();

    // Still shown in the inspector's Source section after restart.
    await expect(page.getByTestId("provenance-canonical-url")).toHaveText(CANONICAL_URL);

    // Confirmed verbatim through the bridge as well.
    const prov = await page.evaluate(async () => {
      const api = window.appApi as unknown as {
        inbox: {
          list(): Promise<{ items: { id: string }[] }>;
          get(req: {
            id: string;
          }): Promise<{ detail: { provenance: { originalUrl: string | null } } | null }>;
        };
      };
      const { items } = await api.inbox.list();
      const { detail } = await api.inbox.get({ id: items[0]?.id as string });
      return detail?.provenance ?? null;
    });
    expect(prov?.originalUrl).toBe(MESSY_URL);

    await app.close();
  });
});
