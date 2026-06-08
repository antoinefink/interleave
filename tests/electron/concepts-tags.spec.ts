/**
 * Concepts & tags (T041) E2E — drives the real Electron app.
 *
 * Concepts (hierarchical) and tags (flat) can be created/assigned to any element
 * and filtered by, all through the typed `concepts.*` / `tags.*` `window.appApi`
 * surface (no generic `db.query`). This spec launches the built desktop app
 * against a fresh data dir seeded with the shared demo collection, then:
 *
 *   1. the `concepts.*` + `tags.*` bridge commands exist (no raw SQL channel);
 *   2. on a seeded element (the Q&A card, which the seed leaves UN-organized) it
 *      CREATES a new concept (via the inspector "New concept…" affordance, which
 *      also assigns it) and ADDS a tag (via the tag input) → both pills appear in
 *      the inspector;
 *   3. filtering the queue by that concept INCLUDES the element and EXCLUDES an
 *      unrelated one; the same for the tag filter (asserted at the bridge);
 *   4. it SURVIVES AN APP RESTART — the concept membership + tag persist (read
 *      back through `inspector.get`).
 *
 * The seed already attaches the "Intelligence" concept + tags to the SOURCE and
 * EXTRACT; the cards are intentionally left un-organized so this spec exercises a
 * fresh assignment end-to-end without colliding with the seeded data.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The concept name + tag this spec assigns/adds. */
const CONCEPT_NAME = "Spaced Repetition";
const TAG_NAME = "e2e-tag";
/** The seeded Q&A card title (left un-organized by the seed). */
const CARD_TITLE = "Chollet's definition of intelligence";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Select a seeded element from the inspector's picker by type + title. */
async function selectByTitle(page: Page, title: string, type?: string) {
  const clear = page.getByTestId("inspector-clear");
  if (await clear.isVisible()) {
    await clear.click();
  }
  const item = page
    .locator(`[data-testid="element-picker-item"][data-element-type="${type ?? "card"}"]`)
    .filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText(title);
}

test("the concepts.* + tags.* bridge commands exist (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      concepts?: { create?: unknown; list?: unknown; assign?: unknown; unassign?: unknown };
      tags?: { list?: unknown; add?: unknown; remove?: unknown };
      db?: { query?: unknown };
    };
    return {
      conceptsCreate: typeof api?.concepts?.create === "function",
      conceptsList: typeof api?.concepts?.list === "function",
      conceptsAssign: typeof api?.concepts?.assign === "function",
      conceptsUnassign: typeof api?.concepts?.unassign === "function",
      tagsAdd: typeof api?.tags?.add === "function",
      tagsRemove: typeof api?.tags?.remove === "function",
      tagsList: typeof api?.tags?.list === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.conceptsCreate).toBe(true);
  expect(surface.conceptsList).toBe(true);
  expect(surface.conceptsAssign).toBe(true);
  expect(surface.conceptsUnassign).toBe(true);
  expect(surface.tagsAdd).toBe(true);
  expect(surface.tagsRemove).toBe(true);
  expect(surface.tagsList).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("create a concept + add a tag on a card via the inspector → both pills appear", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, CARD_TITLE, "card");

  // Add a tag via the inspector tag input.
  await page.getByTestId("tag-input").fill(TAG_NAME);
  await page.getByTestId("tag-add").click();
  await expect(page.getByTestId("tag-pill").filter({ hasText: TAG_NAME })).toBeVisible();

  // CREATE a brand-new concept through the inspector UI (T041 fix — a human path
  // to make a concept, not just assign an existing one). The create flow makes the
  // `concept` element AND assigns it to this card in one step, so the pill appears.
  await page.getByTestId("concept-new").click();
  await page.getByTestId("concept-create-name").fill(CONCEPT_NAME);
  await page.getByTestId("concept-create-submit").click();
  await expect(page.getByTestId("concept-pill").filter({ hasText: CONCEPT_NAME })).toBeVisible();

  await app.close();
});

test("the queue filters by the assigned concept and tag (includes the card, excludes others)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Resolve the card id (the one we organized) + an unrelated card id, and make
  // both due so they would BOTH be in the unfiltered queue.
  const ids = await page.evaluate(async (cardTitle) => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
      };
      elements: { setPriority(r: unknown): Promise<unknown> };
      queue: {
        list(r: unknown): Promise<{ items: { id: string }[] }>;
      };
    };
    const { elements } = await api.inspector.list();
    const organized = elements.find((e) => e.type === "card" && e.title === cardTitle);
    const other = elements.find((e) => e.type === "card" && e.title !== cardTitle);
    return { organizedId: organized?.id ?? "", otherId: other?.id ?? "" };
  }, CARD_TITLE);
  expect(ids.organizedId).not.toBe("");

  // Use a far-future asOf so both seeded cards read as due.
  const asOf = "2030-01-01T12:00:00.000Z";
  const filtered = await page.evaluate(
    async ({ asOf, concept, tag }) => {
      const api = window.appApi as unknown as {
        queue: { list(r: unknown): Promise<{ items: { id: string }[] }> };
      };
      const byConcept = await api.queue.list({ asOf, concept });
      const byTag = await api.queue.list({ asOf, tag });
      const all = await api.queue.list({ asOf });
      return {
        byConcept: byConcept.items.map((i) => i.id),
        byTag: byTag.items.map((i) => i.id),
        all: all.items.map((i) => i.id),
      };
    },
    { asOf, concept: CONCEPT_NAME, tag: TAG_NAME },
  );

  // The organized card is in BOTH filtered lists; an unrelated card is not.
  expect(filtered.byConcept).toContain(ids.organizedId);
  expect(filtered.byTag).toContain(ids.organizedId);
  if (ids.otherId) {
    expect(filtered.byConcept).not.toContain(ids.otherId);
    expect(filtered.byTag).not.toContain(ids.otherId);
  }

  await app.close();
});

test("the concept membership + tag survive an app restart (persisted to SQLite)", async () => {
  // Re-launch against the SAME data dir — the restart analogue.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const state = await page.evaluate(async (cardTitle) => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
        get(r: {
          id: string;
        }): Promise<{ data: { concepts: { name: string }[]; tags: string[] } | null }>;
      };
    };
    const { elements } = await api.inspector.list();
    const card = elements.find((e) => e.type === "card" && e.title === cardTitle);
    if (!card) return { concepts: [], tags: [] };
    const { data } = await api.inspector.get({ id: card.id });
    return {
      concepts: (data?.concepts ?? []).map((c) => c.name),
      tags: data?.tags ?? [],
    };
  }, CARD_TITLE);

  expect(state.concepts).toContain(CONCEPT_NAME);
  expect(state.tags).toContain(TAG_NAME);

  await app.close();
});
