/**
 * AI-assisted distillation E2E (T093/T094) — drives the real Electron app.
 *
 * The AI worker provider is a DETERMINISTIC FAKE injected via `INTERLEAVE_AI_FAKE=1`
 * (the `aiFake` launch option) — NO live model, NO network. The spec proves the full
 * drafts-only flow through the real `ai.*` bridge + the T058 runner:
 *
 *   (1) DISABLED STATE: with AI off (the default), the extract surface shows the calm
 *       "Turn on AI assistance in Settings" disabled state.
 *   (2) ENABLE + RUN: enabling AI (own-key provider) and running "suggest Q&A" over the
 *       extract's span produces a DRAFT suggestion with its grounding refblock (the
 *       source quote it was made about, T094) + the card-quality warnings.
 *   (3) APPROVE → DRAFT CARD: approving mints a PARKED, un-due `card_draft` (stage
 *       `card_draft`, NOT `active_card`, NO `review_states` due row — it is NOT in the
 *       review deck) through the draft-only seam.
 *   (4) RESTART: the draft suggestion AND the approved card survive an app restart.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;
let extractId: string;

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

/** Enable AI assistance with an own-key provider via the typed settings bridge. */
async function enableAi(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { updateMany(req: { patch: Record<string, unknown> }): Promise<unknown> };
    };
    await api.settings.updateMany({
      patch: { aiEnabled: true, aiProviderKind: "anthropic", aiApiKey: "sk-e2e-fake-key" },
    });
  });
}

/** The inspector payload for an element (persisted stage/status/review + the refblock). */
async function inspect(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { type: string; stage: string; status: string; dueAt: string | null };
            review: unknown | null;
            // The resolved refblock (T043/T094) — the minted card inherits the grounding.
            sourceRef: {
              sourceElementId: string | null;
              sourceTitle: string | null;
              snippet: string | null;
            } | null;
          } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data;
  }, id);
}

async function openExtract(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/extract/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("extract-stage-stepper")).toBeVisible();
}

test("AI off → calm disabled state on the extract surface", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true, aiFake: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);
  extractId = await createIntroExtract(page, sourceId);

  await openExtract(page, extractId);

  // AI is OFF by default → the calm disabled state, and the rest of the app works.
  await expect(page.getByTestId("ai-assist-disabled")).toBeVisible();
  await expect(page.getByTestId("ai-assist-disabled")).toContainText(/Turn on AI assistance/i);

  await app.close();
});

test("suggest Q&A → a grounded draft → approve mints a parked card_draft that survives restart", async () => {
  // This flow mounts the source reader twice (the in-app jump-to-source + the return),
  // runs the AI worker, AND restarts the app — so it needs more than the 30s default.
  test.setTimeout(90_000);
  let app = await launchApp(dataDir, { aiFake: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // Enable AI (own-key provider) → the actions surface replaces the disabled state.
  await enableAi(page);
  await openExtract(page, extractId);
  await expect(page.getByTestId("ai-assist")).toBeVisible();

  // (2) RUN "suggest Q&A" over the extract's span → a DRAFT appears (via the runner).
  // The action buttons stay disabled until the extract's grounding (its source-location
  // anchor) has loaded into the surface, so wait for enabled before clicking.
  const runQa = page.getByTestId("ai-action-suggest_qa");
  await expect(runQa).toBeEnabled({ timeout: 15_000 });
  await runQa.click();
  await expect(page.getByTestId("ai-draft")).toBeVisible({ timeout: 15_000 });
  // The grounding refblock shows the source quote the suggestion was made ABOUT (T094).
  await expect(page.getByTestId("ai-draft-grounding")).toBeVisible();
  await expect(page.getByTestId("ai-draft-grounding")).toContainText(
    /deliberate progress|feedback signal/i,
  );

  // (T094) The draft's grounding refblock carries a WORKING in-app "jump to source"
  // that lands on the ORIGINATING block — exactly like an extract/card refblock. The
  // intro extract was created over `blk_intro_p1`, so the jump scrolls/flashes it.
  const draftJump = page.getByTestId("ai-draft-grounding").getByTestId("refblock-open-source");
  await expect(draftJump).toBeVisible();
  await draftJump.click();
  await expect(page.locator('.reader [data-block-id="blk_intro_p1"].jumped')).toBeVisible({
    timeout: 15_000,
  });

  // Return to the extract surface to continue the approve flow (the jump navigated away).
  await openExtract(page, extractId);
  await expect(page.getByTestId("ai-draft")).toBeVisible({ timeout: 15_000 });

  // (3) APPROVE → mint a parked card_draft. Resolve its id via a set-difference of the
  // card ids before/after (the seeded collection already has cards; insertion order is
  // not guaranteed, so we diff the id sets to find the just-minted draft).
  const idsBefore = new Set(await cardIds(page));
  await page.getByTestId("ai-draft-approve").click();
  await expect.poll(async () => (await cardIds(page)).length).toBe(idsBefore.size + 1);

  const idsAfter = await cardIds(page);
  const newCard = idsAfter.find((id) => !idsBefore.has(id)) ?? null;
  expect(newCard).not.toBeNull();
  const cardId = newCard as string;

  // The minted card is a PARKED card_draft — NOT active, NOT in the FSRS review deck.
  const cardData = await inspect(page, cardId);
  expect(cardData?.element.type).toBe("card");
  expect(cardData?.element.stage).toBe("card_draft");
  expect(cardData?.element.stage).not.toBe("active_card");
  expect(cardData?.element.dueAt).toBeNull();

  // The suggestion flipped to approved (it leaves the live drafts list).
  await expect.poll(async () => listAiStatuses(page, extractId)).not.toContain("draft-visible");

  // (4) RESTART — the approved card + the persisted suggestion survive.
  await app.close();
  app = await launchApp(dataDir, { aiFake: true });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const afterRestart = await inspect(page, cardId);
  expect(afterRestart?.element.type).toBe("card");
  expect(afterRestart?.element.stage).toBe("card_draft");
  expect(afterRestart?.element.dueAt).toBeNull();

  // (T094) The approved card INHERITED the grounding as a real source_location: its
  // refblock resolves the SAME source (the seeded article) + the verbatim source quote,
  // so jump-to-source + provenance work exactly like an extract-derived card — and it
  // survives the restart (lineage `card → source location → source` is intact).
  expect(afterRestart?.sourceRef?.sourceElementId).toBe(sourceId);
  expect(afterRestart?.sourceRef?.snippet).toMatch(/deliberate progress|feedback signal/i);

  await app.close();
});

/** The ids of all live `card`-type elements via the inspector list. */
async function cardIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.filter((e) => e.type === "card").map((e) => e.id);
  });
}

/** The visible (draft-status) AI suggestions for an element, as a status marker list. */
async function listAiStatuses(page: Page, elementId: string): Promise<string[]> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      ai: { list(req: { elementId: string }): Promise<{ suggestions: { status: string }[] }> };
    };
    const { suggestions } = await api.ai.list({ elementId: id });
    return suggestions.map((s) => (s.status === "draft" ? "draft-visible" : s.status));
  }, elementId);
}
