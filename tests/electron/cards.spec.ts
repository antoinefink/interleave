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
 *       `card` element first-scheduled into active rotation (stage `active_card`)
 *       with kind `qa`, via `cards.create`;
 *   (c) LINEAGE: the new card appears under the extract in the lineage tree, with
 *       `parentId` = the extract and `sourceId` = the source root, an inherited
 *       `sourceLocationId` anchor, and a first-scheduled (DUE) `review_states` row
 *       (T036 first-schedules the card so it enters the deck; the first GRADE runs
 *       the interval math — fsrsState stays "new" until then);
 *   (d) RESTART: relaunching the Electron app against the same data dir still
 *       shows the card, its kind/prompt/answer, and its lineage — it survives an
 *       app restart (the DoD bar).
 *
 * Observed BOTH through the UI (the builder + the lineage tree) and the typed
 * bridge (`inspector.get` for the persisted card + its review state).
 *
 * T034 (cloze) extends this with a multi-cloze round-trip; T035 adds the quality
 * checklist step (an empty card blocks Create; an over-long prompt warns).
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

  // (a2) QUALITY (T035) — an empty Q&A is a hollow card: a `block` row + Create is
  // disabled; an over-long prompt is an advisory `warn` row that does NOT block.
  await expect(page.getByTestId("cb-qc-empty")).toHaveAttribute("data-severity", "block");
  await expect(page.getByTestId("cb-create")).toBeDisabled();
  await page.getByTestId("cb-qa-front").fill("Q? ".padEnd(180, "x"));
  await page.getByTestId("cb-qa-back").fill("A short answer.");
  await expect(page.getByTestId("cb-qc-prompt-too-long")).toHaveAttribute("data-severity", "warn");
  // The hollow blocker is gone (both fields filled) → Create is enabled despite the warn.
  await expect(page.getByTestId("cb-create")).toBeEnabled();

  // (b) AUTHOR — fill the Q&A fields with a clean prompt and create.
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

  // The persisted card: first-scheduled into active rotation (active_card),
  // parented on the extract, rooted at the source, with a DUE review_states row
  // (first FSRS schedule — but fsrsState stays "new" until the first grade).
  const card = await inspect(page, cardId);
  expect(card?.element.type).toBe("card");
  expect(card?.element.stage).toBe("active_card");
  expect(card?.parent?.id).toBe(extractId);
  expect(card?.source?.id).toBe(sourceId);
  expect(card?.scheduler.kind).toBe("fsrs");
  // review_states exists and is first-scheduled DUE (so the card enters the deck).
  expect(card?.review?.dueAt ?? null).not.toBeNull();
  expect(card?.review?.fsrsState).toBe("new");
  expect(card?.element.dueAt ?? null).not.toBeNull();

  // (d) RESTART — relaunch against the same data dir; the card + lineage survive.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const afterRestart = await inspect(page, cardId);
  expect(afterRestart?.element.type).toBe("card");
  expect(afterRestart?.element.stage).toBe("active_card");
  expect(afterRestart?.parent?.id).toBe(extractId);
  expect(afterRestart?.source?.id).toBe(sourceId);
  expect(afterRestart?.review?.dueAt ?? null).not.toBeNull();

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

/** The cloze document_marks on a card, via the typed bridge. */
async function clozeMarks(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        marks: {
          list(req: {
            elementId: string;
            markType?: string;
          }): Promise<{ marks: { blockId: string; markType: string; attrs: unknown }[] }>;
        };
      };
    };
    const { marks } = await api.documents.marks.list({ elementId, markType: "cloze" });
    return marks;
  }, id);
}

test("authoring a multi-cloze card from an extract persists canonical text + cloze marks and survives restart", async () => {
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  const srcId = await resolveSourceId(page);
  // A FRESH extract so its only card child is the cloze card we author here.
  const clozeExtractId = await createIntroExtract(page, srcId);

  await openExtract(page, clozeExtractId);

  // CONVERT → switch to the Cloze tab (the toolbar Cloze action also opens here; the
  // Convert button + tab click is the deterministic path for the E2E).
  await page.getByTestId("extract-convert").click();
  await expect(page.getByTestId("card-builder")).toBeVisible();
  await page.getByTestId("cb-tab-cloze").click();
  await expect(page.getByTestId("cb-cloze-text")).toBeVisible();

  // AUTHOR a multi-cloze deletion (`{{c1::…}} {{c2::…}}`).
  await page
    .getByTestId("cb-cloze-text")
    .fill("Memory moves from the {{c1::hippocampus}} to the {{c2::neocortex}}.");
  // The preview shows two hidden deletions; the count hint reflects 2.
  await expect(page.getByTestId("cb-cloze-count")).toContainText("2 cloze deletions");
  expect(await page.getByTestId("cb-cloze-deletion").count()).toBe(2);
  await page.getByTestId("cb-create").click();
  await expect(page.getByText("Cloze card created")).toBeVisible();

  // LINEAGE — the cloze card is the extract's one card child.
  await expect
    .poll(async () => {
      const data = await inspect(page, clozeExtractId);
      return (data?.children ?? []).filter((c) => c.type === "card").length;
    })
    .toBe(1);
  const exData = await inspect(page, clozeExtractId);
  const clozeCardId = (exData?.children ?? []).find((c) => c.type === "card")?.id ?? "";
  expect(clozeCardId).not.toBe("");

  // The persisted cloze card: stored canonical numbered text + 2 cloze marks.
  const clozeRow = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: { get(req: { id: string }): Promise<{ data: { element: { stage: string } } }> };
    };
    const { data } = await api.inspector.get({ id });
    return data?.element ?? null;
  }, clozeCardId);
  expect(clozeRow?.stage).toBe("active_card");
  const marks = await clozeMarks(page, clozeCardId);
  expect(marks.length).toBe(2);
  expect(new Set(marks.map((m) => (m.attrs as { clozeIndex: number }).clozeIndex))).toEqual(
    new Set([1, 2]),
  );

  // RESTART — the cloze card, its kind/canonical text, and its marks survive.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const afterRestart = await inspect(page, clozeCardId);
  expect(afterRestart?.element.type).toBe("card");
  expect(afterRestart?.element.stage).toBe("active_card");
  expect(afterRestart?.parent?.id).toBe(clozeExtractId);
  expect(afterRestart?.source?.id).toBe(srcId);

  const marksAfter = await clozeMarks(page, clozeCardId);
  expect(marksAfter.length).toBe(2);

  await app.close();
});

/**
 * Minimum-information-principle quality checks (T086) — drives the real Electron app.
 *
 * Proves the new advisory `qc` rows render in the builder over real IPC, never block
 * authoring, and — critically — that the `similar-answer` INTERFERENCE row fires from
 * the REAL `cards.siblingAnswers` read seam: after authoring one card under an extract,
 * re-opening the builder and typing a near-identical answer surfaces the interference
 * warning, computed main-side from the durable sibling answer (not a renderer guess).
 */
test("T086 quality checks surface advisory rows + interference from the real sibling read, without blocking", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  const srcId = await resolveSourceId(page);
  // A FRESH extract so its only card children are the ones authored here.
  const qcExtractId = await createIntroExtract(page, srcId);

  await openExtract(page, qcExtractId);
  await page.getByTestId("extract-convert").click();
  await expect(page.getByTestId("card-builder")).toBeVisible();
  await expect(page.getByTestId("cb-qa-front")).toBeVisible();

  // (a) Author a FIRST clean card so a sibling answer exists under this extract.
  await page.getByTestId("cb-qa-front").fill("What does deep sleep consolidate?");
  await page.getByTestId("cb-qa-back").fill("Deep sleep consolidates long-term memory.");
  await page.getByTestId("cb-create").click();
  await expect(page.getByText("Q&A card created")).toBeVisible();

  // (b) MULTIPLE-FACTS + LONG-LIST — advisory warns that do NOT block Create.
  await page.getByTestId("cb-qa-front").fill("What two things happen?");
  await page
    .getByTestId("cb-qa-back")
    .fill("Sleep consolidates memory. Caffeine blocks adenosine.");
  await expect(page.getByTestId("cb-qc-multiple-facts")).toHaveAttribute("data-severity", "warn");
  await expect(page.getByTestId("cb-create")).toBeEnabled();

  // (c) INTERFERENCE — a near-identical answer to the first card trips `similar-answer`,
  // computed from the REAL `cards.siblingAnswers` read of the durable sibling. The
  // candidate set was refreshed after the first create, so it is available now.
  await page.getByTestId("cb-qa-front").fill("What does deep sleep consolidate again?");
  await page.getByTestId("cb-qa-back").fill("Deep sleep consolidates long term memory.");
  await expect(page.getByTestId("cb-qc-similar-answer")).toHaveAttribute("data-severity", "warn");
  // It is advisory — Create stays enabled.
  await expect(page.getByTestId("cb-create")).toBeEnabled();

  // (d) A distinct answer clears the interference row (the heuristic is content-driven).
  await page.getByTestId("cb-qa-back").fill("The hippocampus first encodes new episodic events.");
  await expect(page.getByTestId("cb-qc-similar-answer")).toHaveCount(0);

  await app.close();
});
