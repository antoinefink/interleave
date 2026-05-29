/**
 * Stable block-id persistence E2E (T016) — drives the real Electron app.
 *
 * T016's load-bearing guarantee is that a block's stable id is assigned once and
 * PRESERVED across editing, saving, reloading, and an app restart — extracts,
 * read-points, source-locations, and sync all anchor to it, so any churn would
 * silently break lineage. The T018 reader UI lands later; this spec exercises the
 * guarantee through the real bridge + native SQLite, with no raw DB/Node/fs in
 * the renderer.
 *
 * It asserts, end-to-end:
 *   1. an imported source's body carries a stable `blockId` attribute on every
 *      block (the core converter embeds it, so the editor adopts rather than
 *      re-mints it);
 *   2. saving edited content that PRESERVES those ids (plus one genuinely new
 *      block) keeps the original ids and adds exactly the new one — reloaded
 *      identically in the same session;
 *   3. after a full Electron restart against the same data dir, every original
 *      block id is still present (no churn across restart).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

interface DocumentPayload {
  prosemirrorJson: unknown;
  plainText: string;
  schemaVersion: number;
  updatedAt: string;
}

interface BlockInput {
  blockType: string;
  order: number;
  stableBlockId: string;
}

/** Minimal mirror of the bridge surface this spec touches. */
interface RendererAppApi {
  sources: { importManual(req: { title: string; body?: string }): Promise<{ id: string }> };
  documents: {
    get(req: { elementId: string }): Promise<{ document: DocumentPayload | null }>;
    save(req: {
      elementId: string;
      prosemirrorJson: unknown;
      plainText: string;
      blocks?: BlockInput[];
    }): Promise<{ document: DocumentPayload }>;
  };
}
declare global {
  interface Window {
    appApi?: RendererAppApi;
  }
}

test.describe.configure({ mode: "serial" });

let dataDir: string;
let sourceId: string;
/** The two block ids minted at import — must survive every save + the restart. */
let originalIds: string[] = [];

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Pull the ordered `blockId` attrs off a doc's top-level block nodes. */
function topLevelBlockIds(doc: unknown): string[] {
  const content = (doc as { content?: { attrs?: { blockId?: string } }[] })?.content ?? [];
  return content.map((node) => node.attrs?.blockId ?? "");
}

async function inRenderer<T>(page: Page, fn: () => Promise<T> | T): Promise<T> {
  return page.evaluate(fn);
}

test("an imported source body carries a stable blockId on every block", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const result = await inRenderer(page, async () => {
    const api = window.appApi;
    if (!api) throw new Error("no appApi");
    const created = await api.sources.importManual({
      title: "Block-id source",
      body: "Alpha paragraph.\n\nBeta paragraph.",
    });
    const loaded = await api.documents.get({ elementId: created.id });
    return { id: created.id, doc: loaded.document?.prosemirrorJson ?? null };
  });

  sourceId = result.id;
  originalIds = topLevelBlockIds(result.doc);
  expect(originalIds).toHaveLength(2);
  // Both ids are present, non-empty, and distinct (the lineage anchors).
  expect(originalIds.every((id) => id.length > 0)).toBe(true);
  expect(new Set(originalIds).size).toBe(2);

  await app.close();
});

test("saving edited content preserves existing ids and adds exactly one new one", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const reloaded = await page.evaluate(
    async ({ id, ids }: { id: string; ids: string[] }) => {
      const api = window.appApi;
      if (!api) throw new Error("no appApi");
      // Edit the body: keep both original blocks (with their ids) and insert a
      // new paragraph in the middle carrying a brand-new stable id.
      const newId = "NEW_BLOCK_ID_T016";
      const editedJson = {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: ids[0] },
            content: [{ type: "text", text: "Alpha edited." }],
          },
          {
            type: "paragraph",
            attrs: { blockId: newId },
            content: [{ type: "text", text: "Inserted." }],
          },
          {
            type: "paragraph",
            attrs: { blockId: ids[1] },
            content: [{ type: "text", text: "Beta paragraph." }],
          },
        ],
      };
      const blocks = editedJson.content.map((node, order) => ({
        blockType: node.type,
        order,
        stableBlockId: node.attrs.blockId,
      }));
      await api.documents.save({
        elementId: id,
        prosemirrorJson: editedJson,
        plainText: "Alpha edited.\nInserted.\nBeta paragraph.",
        blocks,
      });
      const r = await api.documents.get({ elementId: id });
      return r.document?.prosemirrorJson ?? null;
    },
    { id: sourceId, ids: originalIds },
  );

  const afterIds = topLevelBlockIds(reloaded);
  // Original ids preserved in place; the new id sits between them.
  expect(afterIds).toEqual([originalIds[0], "NEW_BLOCK_ID_T016", originalIds[1]]);

  await app.close();
});

test("block ids survive a full app restart (no churn across restart)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const persisted = await page.evaluate(async (id: string) => {
    const api = window.appApi;
    if (!api) throw new Error("no appApi");
    const r = await api.documents.get({ elementId: id });
    return r.document?.prosemirrorJson ?? null;
  }, sourceId);

  const afterRestart = topLevelBlockIds(persisted);
  expect(afterRestart).toEqual([originalIds[0], "NEW_BLOCK_ID_T016", originalIds[1]]);

  await app.close();
});
