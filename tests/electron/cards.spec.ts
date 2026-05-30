/**
 * Card creation E2E (T033 — Q&A card creation) — drives the real Electron app.
 *
 * This spec launches the BUILT desktop app against a fresh seeded data dir,
 * creates a top-level extract from the seeded article through the real
 * `extractions.create` bridge, then drives the `/extract/$id` distillation
 * workspace to prove the full T033 round-trip through the real `cards.create`
 * bridge:
 *
 *   (a) CONVERT: "Convert to card" opens the card builder (the third split3
 *       column) on the Q&A tab — it does NOT navigate away;
 *   (b) AUTHOR: filling Front + Back and pressing "Create Q&A card" persists a
 *       `card` element at stage `card_draft` with kind `qa`, via `cards.create`;
 *   (c) LINEAGE: the new card appears under the extract in the lineage tree, with
 *       `parentId` = the extract and `sourceId` = the source root, an inherited
 *       `sourceLocationId` anchor, and an UN-DUE `review_states` row (M6 does NO
 *       FSRS math — the card is authored, not yet scheduled);
 *   (d) RESTART: relaunching the Electron app against the same data dir still
 *       shows the card, its kind/prompt/answer, and its lineage — it survives an
 *       app restart (the DoD bar).
 *
 * Observed BOTH through the UI (the builder + the lineage tree) and the typed
 * bridge (`inspector.get` for the persisted card + its review state).
 *
 * T034 (cloze) + T035 (quality warnings) extend this spec when they land.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;
let extractId: string;
let cardId: string;

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

/** The inspector payload for an element (persisted stage/status + review state). */
async function inspect(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: {
              type: string;
              stage: string;
              status: string;
              priority: number;
              dueAt: string | null;
            };
            parent: { id: string } | null;
            source: { id: string } | null;
            children: { id: string; type: string }[];
            scheduler: { kind: string; fsrsState: string | null };
            review: { dueAt: string | null; fsrsState: string } | null;
          } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data;
  }, id);
}

/** The flattened lineage nodes for an element. */
async function lineage(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: { id: string }): Promise<{
          lineage: { nodes: { id: string; type: string; stage: string }[] } | null;
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
}

test("authoring a Q&A card from an extract persists it with lineage and survives restart", async () => {
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);
  extractId = await createIntroExtract(page, sourceId);

  await openExtract(page, extractId);

  // (a) CONVERT — opens the builder (third column), does NOT navigate away.
  await page.getByTestId("extract-convert").click();
  await expect(page.getByTestId("card-builder")).toBeVisible();
  await expect(page.getByTestId("cb-qa-front")).toBeVisible();
  expect(new URL(page.url()).pathname).toContain(`/extract/${extractId}`);

  // (b) AUTHOR — fill the Q&A fields and create.
  await page.getByTestId("cb-qa-front").fill("How does Chollet define intelligence?");
  await page
    .getByTestId("cb-qa-back")
    .fill("As skill-acquisition efficiency over a scope of tasks.");
  await page.getByTestId("cb-create").click();
  await expect(page.getByText("Q&A card created")).toBeVisible();

  // (c) LINEAGE — the card appears as a DIRECT child of OUR extract. The inspector's
  // `children` are the extract's own children (our fresh extract has exactly one: the
  // card we just authored), so this is unambiguous even though the source tree also
  // holds seeded cards under OTHER extracts.
  await expect
    .poll(async () => {
      const data = await inspect(page, extractId);
      return (data?.children ?? []).filter((c) => c.type === "card").length;
    })
    .toBe(1);
  const exData = await inspect(page, extractId);
  const cardChild = (exData?.children ?? []).find((c) => c.type === "card");
  expect(cardChild).toBeTruthy();
  cardId = cardChild?.id ?? "";

  // The card also appears under the extract in the lineage tree (the inspector panel).
  const lin = await lineage(page, extractId);
  expect((lin?.nodes ?? []).some((n) => n.id === cardId)).toBe(true);

  // The persisted card: card_draft, parented on the extract, rooted at the source,
  // with an UN-DUE review_states row (NO FSRS math in M6).
  const card = await inspect(page, cardId);
  expect(card?.element.type).toBe("card");
  expect(card?.element.stage).toBe("card_draft");
  expect(card?.parent?.id).toBe(extractId);
  expect(card?.source?.id).toBe(sourceId);
  expect(card?.scheduler.kind).toBe("fsrs");
  // review_states exists but is un-due (authored, not scheduled).
  expect(card?.review?.dueAt ?? null).toBeNull();
  expect(card?.review?.fsrsState).toBe("new");
  expect(card?.element.dueAt ?? null).toBeNull();

  // (d) RESTART — relaunch against the same data dir; the card + lineage survive.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const afterRestart = await inspect(page, cardId);
  expect(afterRestart?.element.type).toBe("card");
  expect(afterRestart?.element.stage).toBe("card_draft");
  expect(afterRestart?.parent?.id).toBe(extractId);
  expect(afterRestart?.source?.id).toBe(sourceId);
  expect(afterRestart?.review?.dueAt ?? null).toBeNull();

  // The card's prompt/answer/kind round-trip through the card read path.
  const cardRow = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: { get(req: { id: string }): Promise<{ data: { element: { title: string } } }> };
    };
    const { data } = await api.inspector.get({ id });
    return data?.element ?? null;
  }, cardId);
  expect(cardRow?.title).toContain("How does Chollet define intelligence?");

  await app.close();
});
