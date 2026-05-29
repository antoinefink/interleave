/**
 * Read-point persistence E2E (T017) — drives the real Electron app.
 *
 * The T018 reader UI (the `/source/$id` page with the Set-read-point button +
 * `.readpoint` divider) is built later; T017's guarantee is the persistence PATH:
 * a read-point set through `window.appApi.readPoints.set` (→
 * `DocumentRepository.setReadPoint`, logging `set_read_point`) reloads through
 * `readPoints.get`, stays a SINGLE row per element across updates, and survives a
 * full app restart. This spec exercises exactly that round-trip through the real
 * bridge + native SQLite, with no raw DB/Node/fs access in the renderer.
 *
 * It asserts:
 *   1. the `readPoints.{get,set}` bridge surface exists (and no generic
 *      `db.query` was added);
 *   2. a read-point (a stable block id + offset) set on a source reads back
 *      identically in the same session, and advancing it UPDATES the same row;
 *   3. after a full Electron restart against the same data dir, the read-point is
 *      still there (the Definition-of-Done restart requirement).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

interface ReadPointPayload {
  blockId: string;
  offset: number;
  updatedAt: string;
}

/** Minimal mirror of the bridge surface the in-renderer closures touch. */
interface RendererAppApi {
  sources: { importManual(req: { title: string; body?: string }): Promise<{ id: string }> };
  documents: {
    save(req: {
      elementId: string;
      prosemirrorJson: unknown;
      plainText: string;
      blocks?: { blockType: string; order: number; stableBlockId: string }[];
    }): Promise<unknown>;
  };
  readPoints: {
    get(req: { elementId: string }): Promise<{ readPoint: ReadPointPayload | null }>;
    set(req: {
      elementId: string;
      documentId: string;
      blockId: string;
      offset: number;
    }): Promise<{ readPoint: ReadPointPayload }>;
  };
}
declare global {
  interface Window {
    appApi?: RendererAppApi;
  }
}

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The source element id created in the first test, reused across the restart. */
let sourceId: string;

/** The stable block ids the source's body carries (set via `documents.save`). */
const BLK_A = "01J0AAAAAAAAAAAAAAAAAAAAAA";
const BLK_B = "01J0BBBBBBBBBBBBBBBBBBBBBB";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Evaluate a fn in the renderer's main world (where `window.appApi` lives). */
async function inRenderer<T>(page: Page, fn: () => Promise<T> | T): Promise<T> {
  return page.evaluate(fn);
}

test("readPoints.{get,set} exist on the bridge and there is no generic db.query", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await inRenderer(page, () => {
    const api = window.appApi;
    return {
      hasGet: typeof api?.readPoints?.get === "function",
      hasSet: typeof api?.readPoints?.set === "function",
      // biome-ignore lint/suspicious/noExplicitAny: probing for a forbidden method
      hasQuery: typeof (api as any)?.db?.query === "function",
    };
  });
  expect(surface.hasGet).toBe(true);
  expect(surface.hasSet).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("a read-point set on a source reads back, and advancing it updates the same point", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const result = await page.evaluate(
    async ({ blkA, blkB }) => {
      const api = window.appApi;
      if (!api) throw new Error("no appApi");
      // Create a source (which always has a document body) and give that body two
      // stable blocks the read-point can anchor to.
      const created = await api.sources.importManual({
        title: "Resumable source",
        body: "First paragraph.\n\nSecond paragraph.",
      });
      await api.documents.save({
        elementId: created.id,
        prosemirrorJson: { type: "doc", content: [] },
        plainText: "First paragraph.\nSecond paragraph.",
        blocks: [
          { blockType: "paragraph", order: 0, stableBlockId: blkA },
          { blockType: "paragraph", order: 1, stableBlockId: blkB },
        ],
      });

      // Unset until a read-point is written.
      const before = await api.readPoints.get({ elementId: created.id });

      // Set a read-point partway into the first block.
      await api.readPoints.set({
        elementId: created.id,
        documentId: created.id,
        blockId: blkA,
        offset: 5,
      });
      const first = await api.readPoints.get({ elementId: created.id });

      // Advance it to the second block — UPSERT (one row per element).
      await api.readPoints.set({
        elementId: created.id,
        documentId: created.id,
        blockId: blkB,
        offset: 3,
      });
      const advanced = await api.readPoints.get({ elementId: created.id });

      return {
        id: created.id,
        before: before.readPoint,
        first: first.readPoint,
        advanced: advanced.readPoint,
      };
    },
    { blkA: BLK_A, blkB: BLK_B },
  );

  sourceId = result.id;
  expect(sourceId).toBeTruthy();
  expect(result.before).toBeNull();
  expect(result.first?.blockId).toBe(BLK_A);
  expect(result.first?.offset).toBe(5);
  expect(result.advanced?.blockId).toBe(BLK_B);
  expect(result.advanced?.offset).toBe(3);

  await app.close();
});

test("the read-point survives a full app restart", async () => {
  // A brand-new Electron process, SAME data dir → the read-point persists.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const persisted = await page.evaluate(async (id: string) => {
    const api = window.appApi;
    if (!api) throw new Error("no appApi");
    const r = await api.readPoints.get({ elementId: id });
    return r.readPoint;
  }, sourceId);

  expect(persisted).not.toBeNull();
  expect(persisted?.blockId).toBe(BLK_B);
  expect(persisted?.offset).toBe(3);

  await app.close();
});
