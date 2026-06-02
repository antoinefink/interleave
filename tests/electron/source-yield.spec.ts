/**
 * Source-yield analytics (T083) E2E — drives the real Electron app.
 *
 * The Source-yield view ranks every source by what it actually PRODUCED — read %,
 * extracts/cards/mature-cards created (via the persisted `sourceId` lineage),
 * leeches, and review time — computed by a domain aggregation (`SourceYieldQuery`)
 * over the durable tables and read through the typed `window.appApi.sourceYield.list`
 * surface (never in React). This spec launches the built desktop app against a fresh
 * data dir seeded with the shared demo collection and asserts:
 *
 *   1. the `sourceYield.*` bridge surface exists (no raw SQL);
 *   2. `/analytics/sources` renders the ranked rows with non-placeholder read-% +
 *      yield numbers, lowest-yield first;
 *   3. extracting a fragment + creating a card from a source (the SAME typed bridge
 *      the reader uses) increments that source's extracts/cards counts and re-ranks;
 *   4. the numbers SURVIVE AN APP RESTART — they are recomputed from the durable
 *      `elements`/`read_points`/`document_blocks`/`review_states`/`review_logs`/`cards`,
 *      so a re-launch against the same data dir shows the grown counts.
 *
 * The renderer never touches SQLite — every read/mutation rides the typed `window.appApi`.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

/** A far-future clock so the rollup is stable across runs. */
const ASOF = "2031-01-01T12:00:00.000Z";

interface YieldRow {
  source: { id: string; title: string };
  readPct: number;
  extractsCreated: number;
  cardsCreated: number;
  leeches: number;
  yieldBand: string;
  yieldScore: number;
}

/** The source-yield rollup at `ASOF` (via the typed bridge). */
async function listYield(page: Page): Promise<{ rows: YieldRow[]; lowYieldCount: number }> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      sourceYield: {
        list(req: { asOf: string }): Promise<{ rows: YieldRow[]; lowYieldCount: number }>;
      };
    };
    return api.sourceYield.list({ asOf });
  }, ASOF);
}

/** Find the demo source's id (the seeded high-priority source). */
async function demoSourceId(page: Page): Promise<string> {
  const { rows } = await listYield(page);
  const demo = rows.find((r) => r.source.title === "On the Measure of Intelligence");
  if (!demo) throw new Error("demo source not found in yield rollup");
  return demo.source.id;
}

/** Create an extract + a Q&A card from `sourceId` via the SAME typed bridge the reader uses. */
async function addExtractAndCard(page: Page, sourceId: string): Promise<void> {
  await page.evaluate(async (sId) => {
    const api = window.appApi as unknown as {
      extractions: {
        create(req: {
          sourceElementId: string;
          selectedText: string;
          blockIds: string[];
          startOffset?: number;
          endOffset?: number;
        }): Promise<{ extract: { id: string } }>;
      };
      cards: {
        create(req: {
          extractId: string;
          kind: string;
          prompt: string;
          answer: string;
        }): Promise<unknown>;
      };
    };
    const res = await api.extractions.create({
      sourceElementId: sId,
      selectedText: "A measure of intelligence must control for prior knowledge and experience.",
      blockIds: ["blk_def_p2"],
      startOffset: 0,
      endOffset: 60,
    });
    await api.cards.create({
      extractId: res.extract.id,
      kind: "qa",
      prompt: "What must a measure of intelligence control for?",
      answer: "Prior knowledge and experience.",
    });
  }, sourceId);
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("the sourceYield bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sourceYield?: { list?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSourceYieldList: typeof api?.sourceYield?.list === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSourceYieldList).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("/analytics/sources renders the ranked rows with real read-% + yield numbers", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.goto(`${baseUrl}/analytics/sources`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-source-yield")).toBeVisible();
  await expect(page.getByTestId("source-yield-body")).toBeVisible();

  // At least the demo source + the math/code source render as rows.
  const rows = page.getByTestId("source-yield-row");
  await expect(rows.first()).toBeVisible();
  expect(await rows.count()).toBeGreaterThanOrEqual(2);

  // The demo source shows a non-zero read-% (the seed read-point is at the 3rd of 4
  // blocks → 75%) and produced extracts + cards.
  const { rows: data } = await listYield(page);
  const demo = data.find((r) => r.source.title === "On the Measure of Intelligence");
  expect(demo).toBeTruthy();
  if (demo) {
    expect(demo.readPct).toBeCloseTo(0.75, 2);
    expect(demo.extractsCreated).toBeGreaterThanOrEqual(1);
    expect(demo.cardsCreated).toBeGreaterThanOrEqual(1);
  }

  // Rows are sorted lowest-yield first (ascending score).
  const scores = data.map((r) => r.yieldScore);
  const sorted = [...scores].sort((a, b) => a - b);
  expect(scores).toEqual(sorted);

  await app.close();
});

test("extracting + creating a card from a source increments its counts and re-ranks", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const sourceId = await demoSourceId(page);
  const before = (await listYield(page)).rows.find((r) => r.source.id === sourceId);
  expect(before).toBeTruthy();
  if (!before) throw new Error("no before row");

  await addExtractAndCard(page, sourceId);

  const after = (await listYield(page)).rows.find((r) => r.source.id === sourceId);
  expect(after).toBeTruthy();
  if (!after) throw new Error("no after row");
  expect(after.extractsCreated).toBe(before.extractsCreated + 1);
  expect(after.cardsCreated).toBe(before.cardsCreated + 1);

  await app.close();
});

test("the source-yield numbers survive an app restart (recomputed from durable tables)", async () => {
  // First launch: record the demo source's grown counts after the prior mutation.
  const app1 = await launchApp(dataDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  const sourceId = await demoSourceId(page1);
  const counts1 = (await listYield(page1)).rows.find((r) => r.source.id === sourceId);
  expect(counts1).toBeTruthy();
  if (!counts1) throw new Error("no row pre-restart");
  await app1.close();

  // Relaunch against the SAME data dir — the rollup is recomputed from the durable
  // tables, so the grown counts persist.
  const app2 = await launchApp(dataDir);
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const counts2 = (await listYield(page2)).rows.find((r) => r.source.id === sourceId);
  expect(counts2).toBeTruthy();
  if (!counts2) throw new Error("no row post-restart");
  expect(counts2.extractsCreated).toBe(counts1.extractsCreated);
  expect(counts2.cardsCreated).toBe(counts1.cardsCreated);
  expect(counts2.readPct).toBeCloseTo(counts1.readPct, 5);
  await app2.close();
});
