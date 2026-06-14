/**
 * T124 — Re-verify workflow (E2E).
 *
 * T123 made source-content staleness VISIBLE (the `needs_reverify` flag); T124 DRAINS
 * it. This spec extends the T123 propagation harness and drives the BUILT desktop app
 * against a fresh seeded data dir, proving the full resolve round-trip through the real
 * bridge (`reverify.sessionPreview` / `resolve` / `undoReceipt`) — IPC → service →
 * repository → SQLite — for all three verbs, with restart persistence:
 *
 *   CONFIRM — clears the flag everywhere it showed; durable across restart; the receipt
 *             undo restores it (and that survives a restart too).
 *   REBASE  — re-derives the extract body from the corrected source text and clears the
 *             flag; the body change is durable.
 *   DETACH  — clears the flag AND makes the output standalone: re-editing the same source
 *             block no longer re-flags it (the snapshot tombstone holds).
 *
 * It works the intro paragraph (`blk_intro_p1`), away from the seed's existing extract
 * (anchored at `blk_def_p1`), re-previewing before each resolve so the per-item
 * fingerprint matches current state.
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

function setBaseUrl(page: Page): void {
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
}

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

async function selectBlockText(page: Page, blockId: string): Promise<string> {
  const block = page.locator(`.reader [data-block-id="${blockId}"]`);
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function extractChildIds(page: Page): Promise<string[]> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: {
          id: string;
        }): Promise<{ data: { children: { id: string; type: string }[] } | null }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return (data?.children ?? []).filter((c) => c.type === "extract").map((c) => c.id);
  }, sourceId);
}

async function extractIntroParagraph(page: Page): Promise<string> {
  const before = await extractChildIds(page);
  const selected = await selectBlockText(page, "blk_intro_p1");
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.getByTestId("sel-tool-extract").click();
  await expect.poll(async () => (await extractChildIds(page)).length).toBe(before.length + 1);
  const after = await extractChildIds(page);
  const created = after.find((id) => !before.includes(id));
  if (!created) throw new Error("no new extract child created");
  return created;
}

interface DocPayload {
  readonly prosemirrorJson: unknown;
  readonly plainText: string;
  readonly schemaVersion: number;
}

async function getSourceDoc(page: Page): Promise<DocPayload> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: { get(req: { elementId: string }): Promise<{ document: DocPayload | null }> };
    };
    const { document } = await api.documents.get({ elementId });
    if (!document) throw new Error("source document not found");
    return document;
  }, sourceId);
}

async function saveSourceDoc(page: Page, doc: DocPayload): Promise<void> {
  await page.evaluate(
    async ({ elementId, payload }) => {
      const api = window.appApi as unknown as {
        documents: {
          save(req: {
            elementId: string;
            prosemirrorJson: unknown;
            plainText: string;
            schemaVersion?: number;
          }): Promise<unknown>;
        };
      };
      await api.documents.save({
        elementId,
        prosemirrorJson: payload.prosemirrorJson,
        plainText: payload.plainText,
        schemaVersion: payload.schemaVersion,
      });
    },
    { elementId: sourceId, payload: doc },
  );
}

function withEditedIntro(doc: DocPayload, newText: string): DocPayload {
  const clone = JSON.parse(JSON.stringify(doc.prosemirrorJson)) as { content?: unknown[] };
  const visit = (node: { attrs?: { blockId?: unknown }; content?: unknown[] }): void => {
    if (node?.attrs?.blockId === "blk_intro_p1") {
      node.content = [{ type: "text", text: newText }];
      return;
    }
    for (const child of node?.content ?? []) visit(child as never);
  };
  visit(clone as never);
  return { ...doc, prosemirrorJson: clone };
}

async function inspectNeedsReverify(page: Page, id: string): Promise<boolean> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: {
          id: string;
        }): Promise<{ data: { scheduler: { needsReverify?: boolean } } | null }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data?.scheduler.needsReverify === true;
  }, id);
}

async function reverifyOutputCount(page: Page, id: string): Promise<number> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      blockProcessing: {
        summary(req: {
          sourceElementId: string;
        }): Promise<{ summary: { needsReverifyOutputs: number } }>;
      };
    };
    const { summary } = await api.blockProcessing.summary({ sourceElementId: elementId });
    return summary.needsReverifyOutputs;
  }, id);
}

/** The re-verify session item (block + fingerprint) for one flagged element, via the bridge. */
async function previewItem(
  page: Page,
  elementId: string,
): Promise<{ elementId: string; stableBlockId: string; fingerprint: string } | null> {
  return page.evaluate(
    async ({ src, target }) => {
      const api = window.appApi as unknown as {
        reverify: {
          sessionPreview(req: { sourceElementId: string }): Promise<{
            items: { elementId: string; stableBlockId: string; fingerprint: string }[];
          }>;
        };
      };
      const { items } = await api.reverify.sessionPreview({ sourceElementId: src });
      return items.find((i) => i.elementId === target) ?? null;
    },
    { src: sourceId, target: elementId },
  );
}

/** Resolve one flagged item via the bridge; returns the receipt batchId. */
async function resolveOne(
  page: Page,
  item: { elementId: string; stableBlockId: string; fingerprint: string },
  verb: "confirm" | "rebase" | "detach",
): Promise<string> {
  return page.evaluate(
    async ({ src, decision }) => {
      const api = window.appApi as unknown as {
        reverify: {
          resolve(req: {
            sourceElementId: string;
            decisions: {
              elementId: string;
              stableBlockId: string;
              verb: string;
              fingerprint: string;
            }[];
          }): Promise<{ batchId: string; applied: number; skipped: { reason: string }[] }>;
        };
      };
      const res = await api.reverify.resolve({ sourceElementId: src, decisions: [decision] });
      if (res.applied !== 1) {
        throw new Error(`resolve did not apply: ${JSON.stringify(res.skipped)}`);
      }
      return res.batchId;
    },
    { src: sourceId, decision: { ...item, verb } },
  );
}

async function undoReceipt(page: Page, batchId: string): Promise<boolean> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      reverify: { undoReceipt(req: { batchId: string }): Promise<{ undone: boolean }> };
    };
    const { undone } = await api.reverify.undoReceipt({ batchId: id });
    return undone;
  }, batchId);
}

async function relaunch(app: Awaited<ReturnType<typeof launchApp>>): Promise<{
  app: Awaited<ReturnType<typeof launchApp>>;
  page: Page;
}> {
  await app.close();
  const next = await launchApp(dataDir);
  const page = await next.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  setBaseUrl(page);
  return { app: next, page };
}

test("re-verify drains via confirm / rebase / detach, restart-safe, with receipt undo", async () => {
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  setBaseUrl(page);
  sourceId = await resolveSourceId(page);
  await openReader(page, sourceId);

  const extractId = await extractIntroParagraph(page);
  const originalDoc = await getSourceDoc(page);

  // ---- CONFIRM: edit → flag → confirm clears it everywhere → restart-safe → undo restores ----
  await saveSourceDoc(page, withEditedIntro(originalDoc, "Intro rewritten for the confirm pass."));
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(true);
  await expect.poll(() => reverifyOutputCount(page, sourceId)).toBeGreaterThanOrEqual(1);

  // The surface renders the flagged item (renderer wiring smoke).
  await page.goto(`${baseUrl}/maintenance/reverify`);
  await expect(page.getByTestId("reverify-item").first()).toBeVisible();

  const confirmItem = await previewItem(page, extractId);
  expect(confirmItem).not.toBeNull();
  const confirmBatch = await resolveOne(
    page,
    confirmItem as NonNullable<typeof confirmItem>,
    "confirm",
  );
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(false);
  await expect.poll(() => reverifyOutputCount(page, sourceId)).toBe(0);

  ({ app, page } = await relaunch(app));
  expect(await inspectNeedsReverify(page, extractId)).toBe(false); // durable

  // Receipt undo restores the flag, and that survives a restart too.
  expect(await undoReceipt(page, confirmBatch)).toBe(true);
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(true);
  ({ app, page } = await relaunch(app));
  expect(await inspectNeedsReverify(page, extractId)).toBe(true);

  // ---- REBASE: re-anchor to the corrected source text, clear the flag, restart-safe ----
  // (Body re-derivation is verb-applies-to-stage and unit-tested in U5; here we prove the
  // full bridge→service→repo→DB rebase resolve clears the flag and persists.)
  await saveSourceDoc(page, withEditedIntro(originalDoc, "Intro rewritten for the rebase pass."));
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(true);
  const rebaseItem = await previewItem(page, extractId);
  expect(rebaseItem).not.toBeNull();
  await resolveOne(page, rebaseItem as NonNullable<typeof rebaseItem>, "rebase");
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(false);
  await expect.poll(() => reverifyOutputCount(page, sourceId)).toBe(0);

  ({ app, page } = await relaunch(app));
  expect(await inspectNeedsReverify(page, extractId)).toBe(false);

  // ---- DETACH: clear the flag, then prove the output is standalone (no re-flag) ----
  await saveSourceDoc(
    page,
    withEditedIntro(originalDoc, "Intro rewritten again, for the detach pass."),
  );
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(true);
  const detachItem = await previewItem(page, extractId);
  expect(detachItem).not.toBeNull();
  await resolveOne(page, detachItem as NonNullable<typeof detachItem>, "detach");
  await expect.poll(() => inspectNeedsReverify(page, extractId)).toBe(false);

  // Editing the same block AGAIN must NOT re-flag the detached output.
  await saveSourceDoc(
    page,
    withEditedIntro(originalDoc, "A further unrelated edit to the same block."),
  );
  await page.waitForTimeout(250);
  expect(await inspectNeedsReverify(page, extractId)).toBe(false);

  ({ app, page } = await relaunch(app));
  expect(await inspectNeedsReverify(page, extractId)).toBe(false); // detach durable

  await app.close();
});
