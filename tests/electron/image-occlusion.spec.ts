/**
 * Image-occlusion E2E (T071) — generate sibling cards from an image extract,
 * review one masked region, and survive an app restart.
 *
 * Launches the BUILT desktop app against a fresh SEEDED data dir (the demo
 * collection includes a `media_fragment` image extract with a clean base `image`
 * asset). It drives the on-device occlusion path end to end:
 *
 *   1. open the seeded image extract → the occlusion editor surface mounts (the
 *      card-builder's third "Image occlusion" tab is enabled for an image extract);
 *   2. generate 2 sibling `image_occlusion` cards from 2 masks via the typed
 *      `cards.generateOcclusion` bridge — the renderer ships ONLY the element id +
 *      the vector masks (no bytes / no path); MAIN mints one card per mask in one
 *      `sibling_group`, storing the masks SEPARATELY from the base image;
 *   3. the 2 sibling cards appear under the extract in the lineage tree;
 *   4. one card's reveal-ready view carries its occlusion data (the masked region +
 *      the sibling masks) — the review face reads the base image masked;
 *   5. after an APP RESTART, the cards, their masks, the sibling grouping, the base
 *      image asset, and the lineage all survive.
 *
 * The renderer reaches everything through `window.appApi` — no fs/SQL/image
 * re-encoding in React. Masks are vector regions stored separately; the base crop
 * is never mutated.
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

/** Resolve the seeded `media_fragment` image extract id via the bridge. */
async function resolveImageExtractId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const img = elements.find((e) => e.type === "media_fragment");
    if (!img) throw new Error("seeded media_fragment image extract not found");
    return img.id;
  });
}

/** Generate occlusion cards from an image extract via the typed bridge. */
async function generateOcclusion(
  page: Page,
  imageElementId: string,
): Promise<{ siblingGroupId: string; cardIds: string[] }> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      cards: {
        generateOcclusion(req: {
          imageElementId: string;
          masks: { region: { x0: number; y0: number; x1: number; y1: number }; label?: string }[];
        }): Promise<{ siblingGroupId: string; cards: { id: string }[] }>;
      };
    };
    const result = await api.cards.generateOcclusion({
      imageElementId: id,
      masks: [
        { region: { x0: 0.15, y0: 0.25, x1: 0.45, y1: 0.5 }, label: "Left region" },
        { region: { x0: 0.55, y0: 0.25, x1: 0.85, y1: 0.5 }, label: "Right region" },
      ],
    });
    return { siblingGroupId: result.siblingGroupId, cardIds: result.cards.map((c) => c.id) };
  }, imageElementId);
}

/** The full inspector payload for an element. */
async function inspect(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { type: string; stage: string; status: string };
            parent: { id: string } | null;
            source: { id: string } | null;
            scheduler: { kind: string };
          } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data;
  }, id);
}

/** The reveal-ready review view (incl. occlusion data) for one card. */
async function reviewCard(page: Page, id: string) {
  return page.evaluate(async (cardId) => {
    const api = window.appApi as unknown as {
      review: {
        card(req: { cardId: string }): Promise<{
          card: {
            kind: string;
            occlusion: {
              imageElementId: string;
              region: { x0: number; y0: number; x1: number; y1: number };
              label: string | null;
              otherRegions: { x0: number; y0: number; x1: number; y1: number }[];
            } | null;
          } | null;
        }>;
      };
    };
    const { card } = await api.review.card({ cardId });
    return card;
  }, id);
}

test("generate occlusion cards from an image extract, review one masked region, survive restart", async () => {
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const imageElementId = await resolveImageExtractId(page);

  // (a) Open the seeded image extract → the occlusion editor mounts (the third tab
  //     is enabled for an image extract; the builder swaps to the occlusion surface).
  await page.goto(`${baseUrl}/extract/${imageElementId}`);
  await page.waitForLoadState("domcontentloaded");
  // The "Occlude image" action opens the builder; for an image extract it mounts the
  // OcclusionEditor directly.
  await expect(page.getByTestId("extract-convert")).toBeVisible();
  await page.getByTestId("extract-convert").click();
  await expect(page.getByTestId("occlusion-editor")).toBeVisible();

  // (b) GENERATE — 2 masks → 2 sibling image_occlusion cards via the typed bridge.
  const { siblingGroupId, cardIds } = await generateOcclusion(page, imageElementId);
  expect(cardIds.length).toBe(2);
  expect(siblingGroupId).toBeTruthy();

  // (c) Each card is an image_occlusion `card` under the extract (lineage intact).
  for (const cardId of cardIds) {
    const data = await inspect(page, cardId);
    expect(data?.element.type).toBe("card");
    expect(data?.element.stage).toBe("card_draft");
    expect(data?.parent?.id).toBe(imageElementId);
    // It is FSRS-scheduled (a card), not attention.
    expect(data?.scheduler.kind).toBe("fsrs");
  }

  // (d) LINEAGE — the 2 siblings appear as children of the extract in the tree.
  const lineageNodes = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: { id: string }): Promise<{
          lineage: { nodes: { id: string; type: string }[] } | null;
        }>;
      };
    };
    const { lineage } = await api.lineage.get({ id });
    return lineage?.nodes ?? [];
  }, imageElementId);
  for (const cardId of cardIds) {
    expect(lineageNodes.some((n) => n.id === cardId && n.type === "card")).toBe(true);
  }

  // (e) REVIEW VIEW — one card carries its occlusion render data (its masked region
  //     + the sibling masks). The review face reads the base image masked from this.
  const view = await reviewCard(page, cardIds[0]);
  expect(view?.kind).toBe("image_occlusion");
  expect(view?.occlusion).not.toBeNull();
  expect(view?.occlusion?.imageElementId).toBe(imageElementId);
  // The card's own region + exactly one sibling region (the OTHER card's mask).
  expect(view?.occlusion?.region).toBeTruthy();
  expect(view?.occlusion?.otherRegions.length).toBe(1);
  expect(view?.occlusion?.label).toBeTruthy();

  // (f) RESTART — relaunch against the same data dir; everything survives.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  for (const cardId of cardIds) {
    const after = await inspect(page, cardId);
    expect(after?.element.type).toBe("card");
    expect(after?.parent?.id).toBe(imageElementId);
  }
  // The occlusion render data still resolves after restart (masks persisted).
  const afterView = await reviewCard(page, cardIds[0]);
  expect(afterView?.occlusion?.imageElementId).toBe(imageElementId);
  expect(afterView?.occlusion?.otherRegions.length).toBe(1);

  // The base image asset still belongs to the extract (never mutated/duplicated).
  const imageAfter = await inspect(page, imageElementId);
  expect(imageAfter?.element.type).toBe("media_fragment");

  await app.close();
});
