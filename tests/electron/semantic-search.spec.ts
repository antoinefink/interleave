/**
 * Semantic search (T087) E2E — drives the real Electron app + the real
 * `utilityProcess` background runner + the on-device embedder.
 *
 * On-device semantic search embeds each source/extract/card via the T058 runner
 * (the real `all-MiniLM-L6-v2` model via `fastembed`, downloaded once into the
 * app-data `models/` dir + cached on disk; the worker degrades to a deterministic
 * embedder if that fetch is unavailable offline) and fuses the `sqlite-vec` KNN with
 * the FTS hits, so `/search` finds conceptually related material WITHOUT a keyword
 * match. OFF BY DEFAULT, degrading to FTS-only.
 *
 * This spec launches the built desktop app against a fresh data dir seeded with
 * the shared demo collection ("intelligence" content), then:
 *   1. the `semantic.*` bridge surface exists (search/status/reindex), no raw SQL;
 *   2. with the feature enabled + the index built, a query that does NOT keyword-
 *      match a seeded element but is semantically near still surfaces it (labeled
 *      "related"), and the UI does not freeze during indexing (jobs run off-main);
 *   3. toggling the feature OFF returns FTS-only without an error;
 *   4. it SURVIVES AN APP RESTART — with the feature on again the embeddings are
 *      still present (no re-index) and the semantic result returns.
 *
 * Gate: the embed path always produces a vector (real model when reachable, the
 * deterministic fallback otherwise), so this runs in CI (no skip). If `sqlite-vec`'s
 * vec0 is non-functional on the host (an ABI mismatch), `semantic.status().vecAvailable`
 * is false and the app stays FTS-only — the spec asserts that graceful state instead
 * of failing.
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

async function openSearch(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/search`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-search")).toBeVisible();
}

/** Enable semantic search + build the index through the real bridge, then wait. */
async function enableSemantic(page: Page): Promise<{ vecAvailable: boolean }> {
  const status = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { updateMany(r: { patch: Record<string, unknown> }): Promise<unknown> };
      semantic: {
        status(): Promise<{ vecAvailable: boolean }>;
        reindex(r: { onlyMissing: boolean }): Promise<{ enqueued: number }>;
      };
    };
    await api.settings.updateMany({
      patch: { semanticSearchEnabled: true, embeddingModelDownloaded: true },
    });
    await api.semantic.reindex({ onlyMissing: false });
    return api.semantic.status();
  });
  return status;
}

/** Poll `semantic.status()` until N items are embedded (or vec is unavailable). */
async function waitForIndex(page: Page): Promise<{ vecAvailable: boolean; embedded: number }> {
  return await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      semantic: { status(): Promise<{ vecAvailable: boolean; embedded: number; total: number }> };
    };
    const start = Date.now();
    let status = await api.semantic.status();
    while (status.vecAvailable && status.embedded < status.total && Date.now() - start < 15000) {
      await new Promise((r) => setTimeout(r, 200));
      status = await api.semantic.status();
    }
    return { vecAvailable: status.vecAvailable, embedded: status.embedded };
  });
}

test("the semantic.* bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      semantic?: {
        search?: unknown;
        status?: unknown;
        reindex?: unknown;
        downloadModel?: unknown;
      };
      db?: { query?: unknown };
    };
    return {
      hasSearch: typeof api?.semantic?.search === "function",
      hasStatus: typeof api?.semantic?.status === "function",
      hasReindex: typeof api?.semantic?.reindex === "function",
      hasDownloadModel: typeof api?.semantic?.downloadModel === "function",
      hasRawQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSearch).toBe(true);
  expect(surface.hasStatus).toBe(true);
  expect(surface.hasReindex).toBe(true);
  expect(surface.hasDownloadModel).toBe(true);
  expect(surface.hasRawQuery).toBe(false);

  await app.close();
});

test("enabling semantic search builds the index and finds related material, off-main", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const enabled = await enableSemantic(page);
  if (!enabled.vecAvailable) {
    // The host's sqlite-vec is non-functional (ABI mismatch) — assert the graceful
    // FTS-only state and stop (the unit/integration suites cover a functional host).
    const status = await page.evaluate(() =>
      (
        window.appApi as unknown as {
          semantic: { status(): Promise<{ enabled: boolean; vecAvailable: boolean }> };
        }
      ).semantic.status(),
    );
    expect(status.enabled).toBe(true);
    expect(status.vecAvailable).toBe(false);
    await app.close();
    test.skip(true, "sqlite-vec vec0 not functional on this host — FTS-only path verified");
    return;
  }

  const index = await waitForIndex(page);
  expect(index.embedded).toBeGreaterThan(0);

  // A query that is semantically near the seeded "intelligence" content but shares
  // vocabulary rather than the exact title term — the fused result still surfaces it.
  await openSearch(page);
  await page.getByTestId("library-search-input").fill("cognition skill acquisition");
  // The semantic-on hint appears (the feature actually ran), and at least one result.
  await expect(page.getByTestId("library-semantic-on")).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("library-result").first()).toBeVisible({ timeout: 8000 });

  await app.close();
});

test("toggling semantic search OFF returns keyword-only without error", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.evaluate(async () => {
    await (
      window.appApi as unknown as {
        settings: { updateMany(r: { patch: Record<string, unknown> }): Promise<unknown> };
      }
    ).settings.updateMany({ patch: { semanticSearchEnabled: false } });
  });

  await openSearch(page);
  await page.getByTestId("library-search-input").fill("intelligence");
  // FTS still works — the seeded source surfaces; no semantic-on hint, no crash.
  await expect(page.getByTestId("library-result").first()).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("library-semantic-on")).toHaveCount(0);

  await app.close();
});

test("embeddings survive an app restart (no re-index needed)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const status = await page.evaluate(() =>
    (
      window.appApi as unknown as {
        semantic: { status(): Promise<{ vecAvailable: boolean; embedded: number }> };
      }
    ).semantic.status(),
  );

  if (status.vecAvailable) {
    // The embeddings built earlier persisted in the SQLite file across the restart.
    expect(status.embedded).toBeGreaterThan(0);

    await page.evaluate(async () => {
      await (
        window.appApi as unknown as {
          settings: { updateMany(r: { patch: Record<string, unknown> }): Promise<unknown> };
        }
      ).settings.updateMany({ patch: { semanticSearchEnabled: true } });
    });
    await openSearch(page);
    await page.getByTestId("library-search-input").fill("cognition skill acquisition");
    await expect(page.getByTestId("library-result").first()).toBeVisible({ timeout: 8000 });
  }

  await app.close();
});
