/**
 * Desktop shell E2E (T007) — drives the real Electron app.
 *
 * Asserts the three things the Definition of Done requires of the shell:
 *   1. `app.health()` works through `window.appApi` (the bridge is wired and the
 *      DB is open + migrated);
 *   2. the secure window flags are correct — context isolation on, node
 *      integration off, sandbox on — and the renderer has no raw Node/require/
 *      process/fs/SQLite access;
 *   3. a value written through the typed API SURVIVES a full app restart
 *      (relaunch Electron against the same data dir; the value is still there).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

/**
 * Minimal mirror of the bridge surface so the in-renderer `page.evaluate`
 * closures type-check. The authoritative contract lives in
 * `apps/desktop/src/shared/contract.ts`.
 */
interface RendererAppApi {
  app: { health(): Promise<{ status: string; dbOpen: boolean; migrated: boolean }> };
  db: {
    getStatus(): Promise<{
      open: boolean;
      migrated: boolean;
      journalMode: string;
      foreignKeys: number;
      busyTimeoutMs: number;
      appliedMigrations: number;
    }>;
  };
  settings: {
    get(req?: { key?: string }): Promise<{ settings: Record<string, unknown> }>;
    update(req: { key: string; value: unknown }): Promise<{ key: string; value: unknown }>;
  };
  queue: {
    list(req?: unknown): Promise<{ counts: { all: number; card: number } }>;
  };
  inbox: {
    list(): Promise<{ items: readonly unknown[] }>;
  };
}
declare global {
  interface Window {
    appApi?: RendererAppApi;
  }
}

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Evaluate a fn in the renderer's main world (where `window.appApi` lives). */
async function inRenderer<T>(page: Page, fn: () => Promise<T> | T): Promise<T> {
  return page.evaluate(fn);
}

test("app.health() and db.getStatus() work through window.appApi", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The bridge exists and is the ONLY surface (no generic db.query).
  const surface = await inRenderer(page, () => {
    const api = window.appApi;
    return {
      hasApi: typeof api !== "undefined",
      hasHealth: typeof api?.app?.health === "function",
      hasDbStatus: typeof api?.db?.getStatus === "function",
      hasSettings: typeof api?.settings?.get === "function",
      // biome-ignore lint/suspicious/noExplicitAny: probing for a forbidden method
      hasQuery: typeof (api as any)?.db?.query === "function",
    };
  });
  expect(surface.hasApi).toBe(true);
  expect(surface.hasHealth).toBe(true);
  expect(surface.hasDbStatus).toBe(true);
  expect(surface.hasSettings).toBe(true);
  expect(surface.hasQuery).toBe(false);

  const health = await inRenderer(page, () => window.appApi?.app.health());
  expect(health?.status).toBe("ok");
  expect(health?.dbOpen).toBe(true);
  expect(health?.migrated).toBe(true);

  const status = await inRenderer(page, () => window.appApi?.db.getStatus());
  expect(status?.open).toBe(true);
  expect(status?.migrated).toBe(true);
  expect(status?.journalMode).toBe("wal");
  expect(status?.foreignKeys).toBe(1);
  expect(status?.busyTimeoutMs).toBe(5000);
  expect(status?.appliedMigrations ?? 0).toBeGreaterThan(0);

  await app.close();
});

test("Electron E2E launches keep the main window hidden but automation-usable", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const state = await app.evaluate(({ BrowserWindow, app: electronApp }) => {
    const [win] = BrowserWindow.getAllWindows();
    return {
      dockVisible: process.platform === "darwin" ? (electronApp.dock?.isVisible?.() ?? null) : null,
      isVisible: win?.isVisible(),
      windowCount: BrowserWindow.getAllWindows().length,
    };
  });

  expect(state.windowCount).toBe(1);
  expect(state.isVisible).toBe(false);
  if (state.dockVisible !== null) {
    expect(state.dockVisible).toBe(false);
  }
  await expect(page.locator(".app-shell")).toBeAttached();
  await page.getByTestId("user-chip").click();
  await expect(page.getByRole("menuitem", { name: /^Settings$/ })).toBeVisible();

  await app.close();
});

test("the window is locked down and the renderer has no raw Node/fs/SQLite access", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The secure webPreferences, read from the main process.
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows();
    const wp = win?.webContents.getLastWebPreferences();
    return {
      contextIsolation: wp?.contextIsolation,
      nodeIntegration: wp?.nodeIntegration,
      sandbox: wp?.sandbox,
    };
  });
  expect(prefs.contextIsolation).toBe(true);
  expect(prefs.nodeIntegration).toBe(false);
  expect(prefs.sandbox).toBe(true);

  // The renderer global scope must not expose Node/require/process/module.
  const leaks = await inRenderer(page, () => ({
    hasRequire: typeof (globalThis as { require?: unknown }).require !== "undefined",
    hasProcess: typeof (globalThis as { process?: unknown }).process !== "undefined",
    hasModule: typeof (globalThis as { module?: unknown }).module !== "undefined",
    hasGlobal: typeof (globalThis as { global?: unknown }).global !== "undefined",
    hasBuffer: typeof (globalThis as { Buffer?: unknown }).Buffer !== "undefined",
  }));
  expect(leaks.hasRequire).toBe(false);
  expect(leaks.hasProcess).toBe(false);
  expect(leaks.hasModule).toBe(false);
  expect(leaks.hasGlobal).toBe(false);
  expect(leaks.hasBuffer).toBe(false);

  await app.close();
});

test("navigation is locked down: popups are denied, http(s) links go to the OS browser", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The window MUST have a window-open handler installed (modern Electron denies
  // renderer-initiated windows unless one is set), so external provenance links
  // ("Open original" / RefBlock) actually open. Stub `shell.openExternal` in the
  // main process, then simulate a renderer popup and assert it is denied + routed.
  const result = await app.evaluate(async ({ BrowserWindow, shell }) => {
    const [win] = BrowserWindow.getAllWindows();
    const opened: string[] = [];
    // Replace openExternal with a recorder for the duration of this assertion.
    const original = shell.openExternal;
    // biome-ignore lint/suspicious/noExplicitAny: test-only monkeypatch
    (shell as any).openExternal = async (url: string) => {
      opened.push(url);
    };
    try {
      // Open an http(s) URL the way the renderer would; the handler denies the
      // new window and forwards to shell.openExternal.
      await win?.webContents.executeJavaScript(
        `window.open('https://example.com/provenance', '_blank'); true;`,
      );
      // A non-http scheme must be denied with NO external open.
      await win?.webContents.executeJavaScript(
        `window.open('file:///etc/passwd', '_blank'); true;`,
      );
      // Give the synchronous handler a tick to record.
      await new Promise((r) => setTimeout(r, 50));
      return { opened, windowCount: BrowserWindow.getAllWindows().length };
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: restore the real impl
      (shell as any).openExternal = original;
    }
  });

  // The http(s) URL was routed to the OS browser; the file:// URL was not.
  expect(result.opened).toContain("https://example.com/provenance");
  expect(result.opened).not.toContain("file:///etc/passwd");
  // No second BrowserWindow was created — every popup is denied.
  expect(result.windowCount).toBe(1);

  await app.close();
});

test("a value written through window.appApi survives a full app restart", async () => {
  const marker = `e2e-${Date.now()}`;

  // First launch: write a setting through the bridge.
  const first = await launchApp(dataDir);
  const firstPage = await first.firstWindow();
  await firstPage.waitForLoadState("domcontentloaded");

  const written = await firstPage.evaluate(
    (value: string) => window.appApi?.settings.update({ key: "e2e.persisted", value }),
    marker,
  );
  expect(written?.value).toBe(marker);

  await first.close();

  // Second launch: a brand-new Electron process, SAME data dir → value persists.
  const second = await launchApp(dataDir);
  const secondPage = await second.firstWindow();
  await secondPage.waitForLoadState("domcontentloaded");

  const read = await inRenderer(secondPage, () =>
    window.appApi?.settings.get({ key: "e2e.persisted" }),
  );
  expect(read?.settings["e2e.persisted"]).toBe(marker);

  await second.close();
});

test("the Settings screen renders the desktop status panel from the bridge", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Navigate to /settings through the real router (user-chip menu → Settings),
  // matching how a user reaches it — raw history pushState won't drive TanStack
  // Router.
  await page.getByTestId("user-chip").click();
  await page.getByRole("menuitem", { name: /^Settings$/ }).click();
  await expect(page.getByTestId("route-settings")).toBeVisible();

  const panel = page.getByTestId("desktop-status");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-desktop", "true");
  await expect(page.getByTestId("health-status")).toHaveText("Healthy");
  await expect(page.getByTestId("db-journal-mode")).toHaveText("wal");

  // The write button persists through the bridge and reflects back.
  await page.getByTestId("persist-button").click();
  await expect(page.getByTestId("persisted-value")).toContainText("checked-");

  await app.close();
});

test("the sidebar count badges are hidden on a fresh empty vault (no fake placeholders)", async () => {
  // A dedicated, EMPTY data dir (not seeded): nothing is due / in the inbox, so
  // the Queue / Inbox / Review badges must NOT render — the old hardcoded
  // 42 / 4 / 28 placeholders are gone.
  const emptyDir = makeDataDir();
  const app = await launchApp(emptyDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await expect(page.getByTestId("nav-queue")).toBeVisible();
  await expect(page.getByTestId("nav-queue-badge")).toHaveCount(0);
  await expect(page.getByTestId("nav-inbox-badge")).toHaveCount(0);
  await expect(page.getByTestId("nav-review-badge")).toHaveCount(0);

  await app.close();
});

test("the sidebar count badges reflect the LIVE queue.list / inbox.list counts (no hardcoding)", async () => {
  // Seed the demo collection so there is real due/inbox data, then prove each
  // rendered badge equals the count the bridge returns — i.e. it is wired to the
  // real window.appApi source, not a literal.
  const seededDir = makeDataDir();
  const app = await launchApp(seededDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const counts = await inRenderer(page, async () => {
    const queue = await window.appApi?.queue.list();
    const inbox = await window.appApi?.inbox.list();
    return {
      all: queue?.counts.all ?? 0,
      card: queue?.counts.card ?? 0,
      inbox: inbox?.items.length ?? 0,
    };
  });

  // A seeded vault has at least something due + in the inbox (guards against the
  // badges silently reading 0 for every nav entry).
  expect(counts.all + counts.inbox).toBeGreaterThan(0);

  async function expectBadge(id: string, n: number) {
    const badge = page.getByTestId(`nav-${id}-badge`);
    if (n > 0) {
      await expect(badge).toHaveText(String(n));
    } else {
      await expect(badge).toHaveCount(0);
    }
  }
  await expectBadge("queue", counts.all);
  await expectBadge("inbox", counts.inbox);
  await expectBadge("review", counts.card);

  await app.close();
});
