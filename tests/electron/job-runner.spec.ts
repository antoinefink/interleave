/**
 * Local background runner E2E (T058) — drives the REAL Electron `utilityProcess`
 * worker against a LOCAL fixture HTTP server (no live network).
 *
 * Because the real Electron runtime is present here, THIS is where the actual
 * `dist/job-worker.cjs` `utilityProcess` runs end-to-end (Vitest cannot fork a
 * `utilityProcess`). It proves:
 *
 *   1. pasting a URL runs the import via the BACKGROUND RUNNER — the real worker
 *      fetches the page OFF-MAIN, then MAIN applies the snapshot+createSource
 *      pipeline → an `inbox` source with its `original.html`/`cleaned.html`
 *      snapshots lands in the vault;
 *   2. the renderer reaches the runner ONLY through the typed `window.appApi`
 *      (`jobs.list` / `jobs.subscribe` exist; no raw worker messages, no
 *      `db.query`), and the queue shows a `succeeded` `url_import` job;
 *   3. after an APP RESTART against the same data dir, the source + snapshots
 *      survive and NO orphan `running` job lingers.
 *
 * The fixture server binds 127.0.0.1, which the SSRF guard normally blocks — the
 * test sets INTERLEAVE_ALLOW_LOOPBACK_IMPORT=1 so the worker's guard permits
 * loopback for the E2E (production keeps it blocked).
 */

import fs from "node:fs";
import { type AddressInfo, createServer, type Server } from "node:http";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const ARTICLE_PATH = "/runner-article";
const ARTICLE_TITLE = "The Forgetting Curve";
const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${ARTICLE_TITLE} — Notes</title></head>
  <body>
    <header><nav>Home · About</nav></header>
    <article>
      <h1>${ARTICLE_TITLE}</h1>
      <p>Retention decays predictably without reinforcement; reviewing just before
         forgetting flattens the curve at minimal cost, which is the whole point of
         spaced repetition run on a background schedule.</p>
      <p>A job runner lets the heavy fetch happen off the main thread, so the UI
         stays responsive while the page is downloaded and cleaned.</p>
    </article>
    <footer>© 2026 Memory Lab</footer>
  </body>
</html>`;

let server: Server;
let baseUrl: string;
let dataDir: string;

test.beforeAll(async () => {
  ensureBuilt();
  dataDir = makeDataDir();
  server = createServer((req, res) => {
    if (req.url === ARTICLE_PATH) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE_HTML);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Launch the app with loopback import permitted (so the worker can reach the test server). */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { allowLoopbackImport: true });
}

/** Read the background-runner queue through the bridge. */
async function listJobs(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      jobs?: {
        list?: (req?: unknown) => Promise<{
          jobs: { id: string; type: string; status: string }[];
        }>;
        subscribe?: unknown;
      };
    };
    if (!api.jobs?.list) return null;
    const { jobs } = await api.jobs.list();
    return jobs;
  });
}

test("the renderer exposes jobs.list/subscribe on the bridge (observe only; no raw worker)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      jobs?: { list?: unknown; subscribe?: unknown; enqueue?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasList: typeof api?.jobs?.list === "function",
      hasSubscribe: typeof api?.jobs?.subscribe === "function",
      hasEnqueue: typeof api?.jobs?.enqueue === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  // The renderer observes the queue (list + subscribe) but cannot enqueue a
  // generic job and has no raw SQL.
  expect(surface.hasList).toBe(true);
  expect(surface.hasSubscribe).toBe(true);
  expect(surface.hasEnqueue).toBe(false);
  expect(surface.hasQuery).toBe(false);
  await app.close();
});

test("importing a URL runs on the runner (real worker fetches off-main) → inbox source + vault snapshots", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  await page.getByTestId("inbox-import-paste-url").click();
  await expect(page.getByTestId("import-url-modal")).toBeVisible();
  await page.getByTestId("import-url-input").fill(`${baseUrl}${ARTICLE_PATH}`);
  await page.getByTestId("import-url-submit").click();

  // The modal closes (the job reached terminal `succeeded`) and the cleaned source
  // lands in the inbox — proving the worker fetched off-main + main applied.
  await expect(page.getByTestId("import-url-modal")).toBeHidden({ timeout: 20_000 });
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-preview-title")).toContainText(ARTICLE_TITLE);
  await expect(page.getByTestId("inbox-preview")).toContainText("flattens the curve");

  // The queue shows a `succeeded` `url_import` job (the proof the runner ran it).
  const jobs = await listJobs(page);
  expect(jobs).not.toBeNull();
  expect(jobs?.some((j) => j.type === "url_import" && j.status === "succeeded")).toBe(true);
  expect(jobs?.some((j) => j.status === "running")).toBe(false);

  // The snapshot files exist in the vault (original.html + cleaned.html).
  const id = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
  const sourceDir = path.join(dataDir, "assets", "sources", id);
  expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(true);
  expect(fs.existsSync(path.join(sourceDir, "cleaned.html"))).toBe(true);

  await app.close();
});

test("after an app restart the source + snapshots survive and no orphan running job lingers", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();

  // The imported source is still in the inbox after restart.
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await page.getByTestId("inbox-row").click();
  await expect(page.getByTestId("inbox-preview-title")).toContainText(ARTICLE_TITLE);

  // The persisted queue survived: the `url_import` job is still `succeeded` and
  // recovery left NO orphan `running` job after the restart.
  const jobs = await listJobs(page);
  expect(jobs?.some((j) => j.type === "url_import" && j.status === "succeeded")).toBe(true);
  expect(jobs?.some((j) => j.status === "running")).toBe(false);

  // Snapshots still on disk.
  const id = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { id: string }[] }> };
    };
    const { items } = await api.inbox.list();
    return items[0]?.id as string;
  });
  const sourceDir = path.join(dataDir, "assets", "sources", id);
  expect(fs.existsSync(path.join(sourceDir, "original.html"))).toBe(true);
  expect(fs.existsSync(path.join(sourceDir, "cleaned.html"))).toBe(true);

  await app.close();
});
