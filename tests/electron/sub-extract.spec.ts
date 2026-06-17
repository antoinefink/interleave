/**
 * Extract splitting / sub-extracts E2E (T025) — drives the real Electron app.
 *
 * Selecting part of an EXTRACT's body and choosing Sub-extract/Split lifts that
 * fragment into a NEW child `extract` whose lineage is `source → extract →
 * sub-extract`, reusing the exact T021 extraction path (only `parentId` differs):
 * the sub-extract's `parent_id` is the parent extract, its `source_id` is the
 * ORIGINAL source root, its `source_locations` anchor points INTO the parent
 * extract (where the text was selected), it carries a `derived_from` edge to the
 * parent, inherits priority/tags, and gets an attention `due_at` (never FSRS).
 *
 * This spec launches the BUILT desktop app against a fresh seeded data dir, makes a
 * top-level extract through the real `extractions.create` bridge, opens the
 * `/extract/$id` review view, selects text inside the extract body, presses the
 * selection toolbar's Sub-extract (Extract) action, then proves:
 *
 *   (a) CREATE: exactly one new `extract` is created whose `parent_id` is the
 *       extract and `source_id` is the original source, with a `source_locations`
 *       anchor INTO the parent extract and NO FSRS `review_states` row;
 *   (b) LINEAGE: the lineage tree returns `source → extract → sub-extract` at
 *       depths 0/1/2 and is navigable;
 *   (c) RESTART: relaunching the Electron app against the same data dir still shows
 *       the sub-extract, its lineage, and its anchor — it survives an app restart.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;
let extractId: string;
let subExtractId: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

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

/** Create a fresh top-level extract from the intro block via the bridge. */
async function createIntroExtract(page: Page, srcId: string): Promise<string> {
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
    };
    const { extract } = await api.extractions.create({
      sourceElementId,
      selectedText:
        "To make deliberate progress towards more intelligent and more human-like artificial systems, we need to be following an appropriate feedback signal.",
      blockIds: ["blk_intro_p1"],
      startOffset: 0,
      endOffset: 150,
    });
    return extract.id;
  }, srcId);
}

/** Count `extract` elements via the bridge. */
async function extractCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.filter((e) => e.type === "extract").length;
  });
}

/** The inspector payload for any element (to verify lineage/location/scheduler). */
async function inspect(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { type: string; stage: string; status: string; dueAt: string | null };
            scheduler: { kind: string };
            parent: { id: string } | null;
            source: { id: string } | null;
            location: { sourceElementId: string; blockIds: string[] } | null;
            review: unknown | null;
          } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data;
  }, id);
}

/** The flattened lineage tree for an element, via the bridge. */
async function lineage(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: { id: string }): Promise<{
          lineage: {
            rootId: string;
            nodes: { id: string; type: string; depth: number; meta: string }[];
          };
        }>;
      };
    };
    const { lineage } = await api.lineage.get({ id: elementId });
    return lineage;
  }, id);
}

async function openExtract(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/extract/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("extract-stage-stepper")).toBeVisible();
  await expect(page.locator(".extract-editor .reader .ProseMirror")).toBeVisible();
}

/** Triple-click the first block in the extract body to select its whole text. */
async function selectExtractBodyText(page: Page): Promise<string> {
  const block = page.locator(".extract-editor .reader .ProseMirror [data-block-id]").first();
  await expect(block).toBeVisible();
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

test("splitting an extract creates a sub-extract whose lineage survives restart", async () => {
  // (a) Set up: a top-level extract from the intro paragraph.
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);
  extractId = await createIntroExtract(page, sourceId);

  await openExtract(page, extractId);

  const extractsBefore = await extractCount(page);

  // Select text inside the EXTRACT body and Sub-extract it via the toolbar.
  const selected = await selectExtractBodyText(page);
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.getByTestId("sel-tool-extract").click();
  // The parent extract's body is a single clean sentence, so sub-extracting it yields an
  // atomic sub-extract under T122 shape-aware staging ("Atomic sub-extract ready"). This
  // test's subject is the sub-extract's lineage (asserted below), not its birth stage.
  await expect(page.getByText("Atomic sub-extract ready")).toBeVisible();

  // Exactly one NEW extract element exists.
  await expect.poll(() => extractCount(page)).toBe(extractsBefore + 1);

  // Identify the sub-extract: the live child extract of the parent extract.
  subExtractId = (await page.evaluate(async (parentId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { children: { id: string; type: string }[] } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: parentId });
    return data?.children.filter((c) => c.type === "extract").at(-1)?.id ?? null;
  }, extractId)) as string;
  expect(subExtractId).toBeTruthy();

  // (a) The sub-extract: parent = the extract, source root = the original source,
  // location anchored INTO the parent extract, attention-scheduled, NOT FSRS.
  const sub = await inspect(page, subExtractId);
  expect(sub?.element.type).toBe("extract");
  expect(sub?.parent?.id).toBe(extractId);
  expect(sub?.source?.id).toBe(sourceId);
  expect(sub?.scheduler.kind).toBe("attention");
  expect(sub?.review).toBeNull();
  expect(sub?.element.dueAt).toBeTruthy();
  expect(sub?.location?.sourceElementId).toBe(extractId);

  // (b) LINEAGE: source → extract → sub-extract at depths 0 / 1 / 2.
  const tree = await lineage(page, subExtractId);
  expect(tree.rootId).toBe(sourceId);
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  expect(byId.get(sourceId)?.depth).toBe(0);
  expect(byId.get(extractId)?.depth).toBe(1);
  expect(byId.get(subExtractId)?.depth).toBe(2);
  expect(byId.get(subExtractId)?.meta).toBe("sub-extract");

  // (c) RESTART: relaunch against the same data dir — the chain survives.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  expect(await extractCount(page)).toBe(extractsBefore + 1);
  const afterRestart = await inspect(page, subExtractId);
  expect(afterRestart?.element.type).toBe("extract");
  expect(afterRestart?.parent?.id).toBe(extractId);
  expect(afterRestart?.source?.id).toBe(sourceId);
  expect(afterRestart?.review).toBeNull();
  expect(afterRestart?.location?.sourceElementId).toBe(extractId);

  const treeAfter = await lineage(page, subExtractId);
  const byIdAfter = new Map(treeAfter.nodes.map((n) => [n.id, n]));
  expect(byIdAfter.get(sourceId)?.depth).toBe(0);
  expect(byIdAfter.get(extractId)?.depth).toBe(1);
  expect(byIdAfter.get(subExtractId)?.depth).toBe(2);

  await app.close();
});
