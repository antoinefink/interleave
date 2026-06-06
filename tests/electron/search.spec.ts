/**
 * Search (T042) E2E — drives the real Electron app.
 *
 * Local FTS5 full-text search over source title/body + extract body + card
 * prompt/answer + tags, ranked best-first, reaches the renderer only through the
 * typed `search.query` `window.appApi` command (no generic `db.query`). This
 * spec launches the built desktop app against a fresh data dir seeded with the
 * shared demo collection (the word "intelligence" appears in the source title +
 * body, the extract title/body, and the card prompt/answer), then:
 *
 *   1. the `search.query` bridge command exists (no raw SQL channel);
 *   2. opening `/search` and typing "intelligence" returns the seeded source,
 *      extract, and card grouped by type, with the match highlighted, ranked;
 *   3. clicking a result shows its detail/refblock (the source title);
 *   4. the bridge returns ranked, type-narrowable results (asserted directly);
 *   5. it SURVIVES AN APP RESTART — searching the same term still finds the
 *      seeded items (the FTS index persisted in the SQLite file).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

/** The seeded term that hits all three searchable types. */
const TERM = "intelligence";
const SOURCE_TITLE = "On the Measure of Intelligence";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open `/search` and wait for the library screen to render. */
async function openSearch(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/search`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-search")).toBeVisible();
}

test("the search.query bridge command exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      search?: { query?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSearch: typeof api?.search?.query === "function",
      hasRawQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSearch).toBe(true);
  expect(surface.hasRawQuery).toBe(false);

  await app.close();
});

test("typing a seeded term returns the source, extract, and card grouped + highlighted", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openSearch(page);

  await page.getByTestId("library-search-input").fill(TERM);

  // All three searchable groups appear (the seed has the term in each type).
  await expect(page.getByTestId("library-group-source")).toBeVisible();
  await expect(page.getByTestId("library-group-extract")).toBeVisible();
  await expect(page.getByTestId("library-group-card")).toBeVisible();
  const counts = await page.evaluate(async (term) => {
    const api = window.appApi as unknown as {
      search: {
        query(r: { q: string }): Promise<{
          counts: {
            byType: Record<string, number>;
            byConcept: Record<string, number>;
            byPriority: Record<string, number>;
          };
        }>;
      };
    };
    return (await api.search.query({ q: term })).counts;
  }, TERM);
  await expect(
    page.getByTestId("library-filter-type-source").locator(".filter-opt__count"),
  ).toHaveText(String(counts.byType.source));
  await expect(
    page.getByTestId("library-filter-type-extract").locator(".filter-opt__count"),
  ).toHaveText(String(counts.byType.extract));
  await expect(
    page.getByTestId("library-filter-type-card").locator(".filter-opt__count"),
  ).toHaveText(String(counts.byType.card));
  await expect(page.getByTestId("library-filter-prio-A").locator(".filter-opt__count")).toHaveText(
    String(counts.byPriority.A),
  );
  const conceptCount = Object.entries(counts.byConcept).find(([, count]) => count > 0);
  expect(conceptCount).toBeDefined();
  if (conceptCount) {
    await expect(
      page.getByTestId(`library-filter-concept-${conceptCount[0]}`).locator(".filter-opt__count"),
    ).toHaveText(String(conceptCount[1]));
  }

  // The matched term is highlighted in at least one result.
  await expect(page.locator('[data-testid="library-result"] em').first()).toBeVisible();

  // Clicking the seeded source result shows its detail panel + refblock.
  const sourceRow = page.getByTestId("library-group-source").getByTestId("library-result").first();
  await sourceRow.click();
  await expect(page.getByTestId("library-detail")).toBeVisible();
  await expect(page.getByTestId("library-detail-ref")).toContainText(SOURCE_TITLE);
  // The detail surfaces the load-bearing scheduler chip (kit parity) — a source is
  // on the attention scheduler.
  const detail = page.getByTestId("library-detail");
  await expect(detail.getByTestId("scheduler-chip")).toHaveAttribute("data-scheduler", "attention");

  // A card hit's snippet is matched prompt/answer text, never the element ULID.
  const cardRow = page.getByTestId("library-group-card").getByTestId("library-result").first();
  const cardId = await cardRow.getAttribute("data-result-id");
  await cardRow.click();
  const cardSnippet = page.getByTestId("library-detail-snippet");
  await expect(cardSnippet).toBeVisible();
  await expect(cardSnippet).not.toHaveText(cardId ?? "");
  // The card detail shows the FSRS scheduler chip (the other side of the split).
  await expect(detail.getByTestId("scheduler-chip")).toHaveAttribute("data-scheduler", "fsrs");

  await app.close();
});

test("the search bridge returns ranked, type-narrowable results", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const res = await page.evaluate(async (term) => {
    const api = window.appApi as unknown as {
      search: {
        query(r: { q: string; type?: string }): Promise<{
          results: { id: string; type: string; score: number }[];
          counts: {
            byType: Record<string, number>;
            byConcept: Record<string, number>;
            byPriority: Record<string, number>;
          };
        }>;
      };
    };
    const all = await api.search.query({ q: term });
    const cards = await api.search.query({ q: term, type: "card" });
    const empty = await api.search.query({ q: "   " });
    return {
      types: all.results.map((r) => r.type),
      // Ranked: scores are non-decreasing (lower bm25 is better, sorted first).
      ranked: all.results.every(
        (r, i) => i === 0 || r.score >= (all.results[i - 1]?.score ?? -Infinity),
      ),
      cardsOnly: cards.results.every((r) => r.type === "card"),
      cardCount: cards.results.length,
      emptyCount: empty.results.length,
      counts: all.counts,
    };
  }, TERM);

  expect(res.types).toContain("source");
  expect(res.types).toContain("extract");
  expect(res.types).toContain("card");
  expect(res.ranked).toBe(true);
  expect(res.cardsOnly).toBe(true);
  expect(res.cardCount).toBeGreaterThan(0);
  expect(res.emptyCount).toBe(0);
  expect(res.counts.byType.source).toBeGreaterThan(0);
  expect(res.counts.byType.extract).toBeGreaterThan(0);
  expect(res.counts.byType.card).toBeGreaterThan(0);
  expect(res.counts.byPriority.A).toBeGreaterThanOrEqual(0);
  expect(Object.values(res.counts.byConcept).some((count) => count > 0)).toBe(true);

  await app.close();
});

test("search still finds the seeded items after an app restart (FTS persisted)", async () => {
  // Re-launch against the SAME data dir — the restart analogue.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const ids = await page.evaluate(async (term) => {
    const api = window.appApi as unknown as {
      search: { query(r: { q: string }): Promise<{ results: { id: string; type: string }[] }> };
    };
    const { results } = await api.search.query({ q: term });
    return {
      count: results.length,
      types: [...new Set(results.map((r) => r.type))],
    };
  }, TERM);

  expect(ids.count).toBeGreaterThan(0);
  expect(ids.types).toContain("source");
  expect(ids.types).toContain("extract");
  expect(ids.types).toContain("card");

  await app.close();
});
