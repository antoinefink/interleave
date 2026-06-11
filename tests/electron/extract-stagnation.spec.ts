/**
 * Extract-stagnation analytics (T084) E2E — drives the real Electron app.
 *
 * The incremental-reading failure mode this catches on the EXTRACT side: an extract
 * that keeps coming back (attention-due, again and again) but never PROGRESSES — its
 * stage never advances, it never produced children, and it has been postponed
 * repeatedly. The detection is a PURE `@interleave/scheduler` heuristic (`isStagnant`,
 * the attention mirror of the FSRS `isLeech`) run by a read-only domain scan
 * (`ExtractStagnationQuery`) over the durable signals (stage / children / op-log
 * postpone markers) and read through the typed `window.appApi.extractStagnation.list`
 * surface (never in React). The remediations reuse the EXISTING `extracts.*` commands.
 *
 * This spec launches the built desktop app against a fresh data dir seeded with the
 * shared demo collection and asserts:
 *
 *   1. the `extractStagnation.*` bridge surface exists (no raw SQL);
 *   2. a fresh raw extract postponed 3× (through the typed `extracts.postpone`) with no
 *      children is detected as stagnant by the read-only scan (at a far-future `asOf`);
 *   3. `/maintenance/stagnant` lists it with its reasons + a suggested remediation;
 *   4. DELETING it from the view (the existing soft-delete `extracts.delete`) removes
 *      the row and the extract leaves the live universe (it is in trash);
 *   5. the detection SURVIVES AN APP RESTART — recomputed from the durable op-log
 *      postpone markers, a re-launch against the same data dir re-detects correctly.
 *
 * The seed clock is 2026; a fixed FUTURE `asOf` makes a never-aged extract read as
 * stale (the heuristic measures days-since-progress from `createdAt`). The renderer
 * never touches SQLite — every read/mutation rides the typed `window.appApi`.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let stagnantExtractId: string;
let referenceExtractId: string;

/** A far-future clock so a fresh, never-aged extract reads as stale + stable across runs. */
const ASOF = "2031-01-01T12:00:00.000Z";

interface StagnantRow {
  extract: { id: string; title: string; stage: string; extractFate?: string | null };
  postponeCount: number;
  childCount: number;
  daysSinceProgress: number;
  reasons: string[];
  suggestion: string;
}

/** The stagnation scan at `ASOF` (via the typed bridge). */
async function listStagnation(page: Page): Promise<{ rows: StagnantRow[]; stagnantCount: number }> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      extractStagnation: {
        list(req: { asOf: string }): Promise<{ rows: StagnantRow[]; stagnantCount: number }>;
      };
    };
    return api.extractStagnation.list({ asOf });
  }, ASOF);
}

/** Resolve the seeded article source id via the bridge. */
async function resolveSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const source = elements.find(
      (e) => e.type === "source" && e.title === "On the Measure of Intelligence",
    );
    if (!source) throw new Error("seeded source not found");
    return source.id;
  });
}

/** Create a fresh raw extract from the intro block + postpone it 3× via the typed bridge. */
async function makeStagnantExtract(page: Page, srcId: string): Promise<string> {
  return page.evaluate(async (sourceElementId) => {
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
      extracts: { postpone(req: { id: string }): Promise<unknown> };
    };
    const { extract } = await api.extractions.create({
      sourceElementId,
      selectedText:
        "To make deliberate progress towards more intelligent and more human-like artificial systems, we need to be following an appropriate feedback signal.",
      blockIds: ["blk_intro_p1"],
      startOffset: 0,
      endOffset: 150,
    });
    // Postpone it 3× (the default STAGNATION_POSTPONE_THRESHOLD): never advanced, no
    // children → at a far-future asOf it is stagnant. Real op-log postpone markers.
    await api.extracts.postpone({ id: extract.id });
    await api.extracts.postpone({ id: extract.id });
    await api.extracts.postpone({ id: extract.id });
    return extract.id;
  }, srcId);
}

/** Whether `id` is still a LIVE element (visible in the inspector universe). */
async function isLive(page: Page, id: string): Promise<boolean> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.some((e) => e.id === elementId);
  }, id);
}

/** The persisted extract fate through the inspector bridge. */
async function extractFate(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { element: { extractFate: string | null } } | null;
        }>;
      };
    };
    return (await api.inspector.get({ id: elementId })).data?.element.extractFate ?? null;
  }, id);
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("the extractStagnation bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      extractStagnation?: { list?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasStagnationList: typeof api?.extractStagnation?.list === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasStagnationList).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("a repeatedly-postponed, never-advanced extract is detected as stagnant", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const sourceId = await resolveSourceId(page);
  // Baseline: the seed's own extract was advanced raw→clean→atomic, so nothing is
  // stagnant yet.
  expect((await listStagnation(page)).stagnantCount).toBe(0);

  stagnantExtractId = await makeStagnantExtract(page, sourceId);

  const { rows, stagnantCount } = await listStagnation(page);
  expect(stagnantCount).toBe(1);
  const row = rows.find((r) => r.extract.id === stagnantExtractId);
  expect(row).toBeTruthy();
  if (row) {
    expect(row.extract.stage).toBe("raw_extract");
    expect(row.postponeCount).toBe(3);
    expect(row.childCount).toBe(0);
    expect(row.reasons).toEqual(
      expect.arrayContaining(["postponed-repeatedly", "no-progress", "no-children", "stale"]),
    );
    expect(["rewrite", "convert", "postpone", "delete", "keep_as_reference"]).toContain(
      row.suggestion,
    );
  }

  await app.close();
});

test("/maintenance/stagnant lists the extract with reasons + a suggested remediation", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Drive the view at the far-future asOf (the dev-clock search param) so the
  // never-aged extract reads as stale in the UI exactly as in the bridge.
  await page.goto(`${baseUrl}/maintenance/stagnant?asOf=${encodeURIComponent(ASOF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-stagnant-extracts")).toBeVisible();

  const row = page.locator(`[data-extract-id="${stagnantExtractId}"]`);
  await expect(row).toBeVisible();

  // Its reasons + postpone count + a suggested action render.
  await expect(row.getByTestId("stagnant-postpones")).toContainText("×3");
  await expect(row.getByTestId("stagnant-reasons")).toContainText("Postponed repeatedly");
  await expect(row.getByTestId("stagnant-suggestion")).toContainText("Suggested:");
  // Exactly one of the four action buttons is highlighted as the suggested one.
  await expect(row.locator(".se-btn--suggested")).toHaveCount(1);

  // Sanity: the bridge agrees there is one stagnant row.
  expect((await listStagnation(page)).stagnantCount).toBe(1);

  await app.close();
});

test("keeping a stagnant extract as reference removes it and survives restart", async () => {
  const app1 = await launchApp(dataDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");

  const sourceId = await resolveSourceId(page1);
  referenceExtractId = await makeStagnantExtract(page1, sourceId);

  await page1.goto(`${baseUrl}/maintenance/stagnant?asOf=${encodeURIComponent(ASOF)}`);
  await page1.waitForLoadState("domcontentloaded");
  const row = page1.locator(`[data-extract-id="${referenceExtractId}"]`);
  await expect(row).toBeVisible();
  await row.getByTestId("stagnant-reference").click();
  await expect(row).toHaveCount(0);
  expect(await extractFate(page1, referenceExtractId)).toBe("reference");
  expect((await listStagnation(page1)).rows.some((r) => r.extract.id === referenceExtractId)).toBe(
    false,
  );
  await app1.close();

  const app2 = await launchApp(dataDir);
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  expect(await extractFate(page2, referenceExtractId)).toBe("reference");
  expect((await listStagnation(page2)).rows.some((r) => r.extract.id === referenceExtractId)).toBe(
    false,
  );
  await app2.close();
});

test("deleting the stagnant extract from the view removes the row + soft-deletes it", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.goto(`${baseUrl}/maintenance/stagnant?asOf=${encodeURIComponent(ASOF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-stagnant-extracts")).toBeVisible();

  const row = page.locator(`[data-extract-id="${stagnantExtractId}"]`);
  await expect(row).toBeVisible();
  expect(await isLive(page, stagnantExtractId)).toBe(true);

  // Delete via the EXISTING soft-delete command, the suggested-or-not button.
  await row.getByTestId("stagnant-delete").click();

  // The row disappears, the scan drops to 0, and the extract leaves the live universe.
  await expect(row).toHaveCount(0);
  await expect.poll(async () => (await listStagnation(page)).stagnantCount).toBe(0);
  expect(await isLive(page, stagnantExtractId)).toBe(false);

  await app.close();
});

test("the stagnation detection survives an app restart (recomputed from durable markers)", async () => {
  // A fresh stagnant extract on the SAME data dir, then relaunch + re-detect.
  const app1 = await launchApp(dataDir, { seedOnEmpty: true });
  const page1 = await app1.firstWindow();
  await page1.waitForLoadState("domcontentloaded");
  const sourceId = await resolveSourceId(page1);
  const id = await makeStagnantExtract(page1, sourceId);
  const before = (await listStagnation(page1)).rows.find((r) => r.extract.id === id);
  expect(before?.postponeCount).toBe(3);
  await app1.close();

  // Relaunch against the SAME data dir — the scan recomputes from the durable op-log
  // postpone markers + the extract stage, so the same row is re-detected.
  const app2 = await launchApp(dataDir);
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const after = (await listStagnation(page2)).rows.find((r) => r.extract.id === id);
  expect(after).toBeTruthy();
  expect(after?.postponeCount).toBe(3);
  expect(after?.reasons).toEqual(expect.arrayContaining(["postponed-repeatedly", "no-progress"]));
  await app2.close();
});
