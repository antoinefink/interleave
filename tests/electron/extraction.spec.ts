/**
 * Extraction E2E (T021 — the keystone) — drives the real Electron app.
 *
 * Extraction lifts selected source text into a NEW, independent, attention-scheduled
 * `extract` element (its own body + a `source_locations` anchor + a `derived_from`
 * relation + inherited priority/tags + an attention `due_at`), and marks the parent
 * body `extracted_span` — NEVER an FSRS card. This spec launches the BUILT desktop
 * app against a fresh seeded data dir and proves the full T021 round-trip through the
 * real `extractions.create` bridge:
 *
 *   (a) SELECT → EXTRACT: selecting an un-extracted paragraph and pressing Extract
 *       creates exactly one new `extract` element whose `source_id`/`parent_id` are
 *       the source, with a `source_locations` anchor over the selected block — and
 *       NO FSRS `review_states` row;
 *   (b) NO RELOAD: the parent block shows the `.extracted` display marker and the
 *       inspector's children gain the new extract without a navigation;
 *   (c) RESTART: relaunching the Electron app against the same data dir still shows
 *       the extract, its lineage, the `extracted_span` mark, and the future attention
 *       `due_at` — it survives an app restart (the DoD bar).
 *
 * It reuses the shared seeded source ("On the Measure of Intelligence") and the same
 * launch/route helpers as the T018/T019/T020 reader specs. It extracts from the
 * INTRO paragraph (`blk_intro_p1`) so it never collides with the seed's existing
 * extract (anchored at `blk_def_p1`).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;

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

async function openReader(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

/** Triple-click a block to select its whole text (updates the editor selection). */
async function selectBlockText(page: Page, blockId: string): Promise<string> {
  const block = page.locator(`.reader [data-block-id="${blockId}"]`);
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
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

/** The full inspector payload for the source, via the bridge. */
async function inspectSource(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { children: { id: string; type: string; title: string }[] } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data;
  }, id);
}

/** The inspector payload for any element (to verify the new extract's lineage). */
async function inspectExtract(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { type: string; stage: string; status: string; dueAt: string | null };
            scheduler: { kind: string };
            source: { id: string } | null;
            location: {
              selectedText: string;
              label: string | null;
              sourceElementId: string;
              blockIds: string[];
            } | null;
            review: unknown | null;
          } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data;
  }, id);
}

/**
 * Select an extract in the inspector by clicking its lineage row (in the source's
 * "Children" section), so the inspector shows that extract's "Source location" +
 * "Jump to source" affordance (T022).
 */
async function selectExtractInInspector(page: Page, extractId: string): Promise<void> {
  const row = page.locator(`[data-testid="lineage-row"][data-element-id="${extractId}"]`).first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
}

/** Count `extracted_span` marks on the source body, via the bridge. */
async function extractedSpanCount(page: Page, id: string): Promise<number> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        marks: {
          list(req: { elementId: string; markType?: string }): Promise<{ marks: { id: string }[] }>;
        };
      };
    };
    const { marks } = await api.documents.marks.list({ elementId, markType: "extracted_span" });
    return marks.length;
  }, id);
}

test("extracting selected text creates a scheduled extract + lineage that survives restart", async () => {
  // (a) SELECT → EXTRACT.
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);
  await openReader(page, sourceId);

  const extractsBefore = await extractCount(page);
  const sourceBefore = await inspectSource(page, sourceId);
  const childrenBefore = sourceBefore?.children.length ?? 0;
  const spansBefore = await extractedSpanCount(page, sourceId);

  // Select the INTRO paragraph (distinct from the seed's existing extract block).
  const selected = await selectBlockText(page, "blk_intro_p1");
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.getByTestId("sel-tool-extract").click();
  await expect(page.getByTestId("reader-flash")).toContainText("Extracted");

  // Exactly one NEW extract element, and the parent gains an extracted_span mark.
  await expect.poll(() => extractCount(page)).toBe(extractsBefore + 1);
  await expect.poll(() => extractedSpanCount(page, sourceId)).toBe(spansBefore + 1);

  // (b) NO RELOAD: the parent block paints `.extracted` and the inspector children grow.
  await expect(page.locator('.reader [data-block-id="blk_intro_p1"].extracted')).toBeVisible();
  await expect
    .poll(async () => (await inspectSource(page, sourceId))?.children.length ?? 0)
    .toBe(childrenBefore + 1);

  // Identify the new extract (the child anchored at the intro block) via the bridge.
  const newExtractId = await page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { children: { id: string; type: string }[] } | null;
        }>;
      };
    };
    const before = await api.inspector.get({ id: elementId });
    const children = before.data?.children ?? [];
    // The newest extract child is the one we just made (the seed extract predates it).
    return children.filter((c) => c.type === "extract").at(-1)?.id ?? null;
  }, sourceId);
  expect(newExtractId).toBeTruthy();

  // The new extract is an attention item with the right lineage + location, NOT FSRS.
  const extract = await inspectExtract(page, newExtractId as string);
  expect(extract?.element.type).toBe("extract");
  expect(extract?.element.stage).toBe("raw_extract");
  expect(extract?.scheduler.kind).toBe("attention");
  expect(extract?.review).toBeNull(); // no FSRS review state
  expect(extract?.source?.id).toBe(sourceId);
  expect(extract?.location?.selectedText.length ?? 0).toBeGreaterThan(0);
  expect(extract?.element.dueAt).toBeTruthy();
  expect(Date.parse(extract?.element.dueAt ?? "")).toBeGreaterThan(Date.now());

  // (b2) JUMP TO SOURCE (T022): the extract's stored location carries its source +
  // block ids; select the extract so the inspector shows "Jump to source", click
  // it, and the originating paragraph scrolls into view + flashes the accent ring.
  await selectExtractInInspector(page, newExtractId as string);
  const jumpBtn = page.getByTestId("location-jump");
  await expect(jumpBtn).toBeVisible();
  await jumpBtn.click();
  await expect(page.getByText(/^Jumped to source/)).toBeVisible();
  await expect(page.locator('.reader [data-block-id="blk_intro_p1"].jumped')).toBeVisible();

  // (c) RESTART: relaunch against the same data dir — the extract + lineage + mark survive.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  expect(await extractCount(page)).toBe(extractsBefore + 1);
  expect(await extractedSpanCount(page, sourceId)).toBe(spansBefore + 1);
  const afterRestart = await inspectExtract(page, newExtractId as string);
  expect(afterRestart?.element.type).toBe("extract");
  expect(afterRestart?.source?.id).toBe(sourceId);
  expect(afterRestart?.review).toBeNull();
  expect(afterRestart?.element.dueAt).toBeTruthy();
  // T022 — the stored jump target (source element id + block ids + offsets) also
  // survives the restart, so jump-back stays correct.
  expect(afterRestart?.location?.sourceElementId).toBe(sourceId);
  expect(afterRestart?.location?.blockIds).toContain("blk_intro_p1");

  // The parent still paints `.extracted` on the originating block after reopening.
  await openReader(page, sourceId);
  await expect(page.locator('.reader [data-block-id="blk_intro_p1"].extracted')).toBeVisible();

  // Jump-to-source still lands on the exact paragraph after the restart (T022).
  await selectExtractInInspector(page, newExtractId as string);
  const jumpAfterRestart = page.getByTestId("location-jump");
  await expect(jumpAfterRestart).toBeVisible();
  await jumpAfterRestart.click();
  await expect(page.getByText(/^Jumped to source/)).toBeVisible();
  await expect(page.locator('.reader [data-block-id="blk_intro_p1"].jumped')).toBeVisible();

  await app.close();
});
