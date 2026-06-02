/**
 * Mature-card retirement (T082) E2E — drives the real Electron app.
 *
 * A low-value MATURE card can be RETIRED (the durable `cards.is_retired` flag) so it
 * gracefully leaves active review without being deleted or losing its lineage; a
 * retired card is SKIPPED by the due/review reads, and retirement is REVERSIBLE
 * (un-retire restores normal scheduling). This spec launches the built desktop app
 * against a fresh data dir seeded with the shared demo collection (which ships ONE
 * seeded retired mature card) and asserts:
 *
 *   1. the `cards.retire` / `cards.unretire` / `cards.retired` bridge surface exists
 *      (no raw SQL);
 *   2. the seeded retired card surfaces in the Retired-cards inventory
 *      (`/maintenance/retired`) with its stability + lineage, and NOT in the due read;
 *   3. retiring a fresh due card through the typed bridge drops it from the review
 *      deck / due read, and it shows in the inventory;
 *   4. un-retiring it from the inventory returns it to the due read;
 *   5. it SURVIVES AN APP RESTART — the retired state + lineage persist.
 *
 * The seed clock is 2026; a fixed FUTURE `asOf` makes the seeded cards read as due.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

const FUTURE = "2031-01-01T12:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open the retired-cards inventory and wait for it to render. */
async function openInventory(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/maintenance/retired`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-retired-cards")).toBeVisible();
}

/** Whether a card id is currently in the FSRS due deck at `asOf`. */
async function isDue(page: Page, cardId: string, asOf: string): Promise<boolean> {
  return page.evaluate(
    async ({ id, clock }) => {
      const api = window.appApi as unknown as {
        review: {
          sessionNext(req: {
            asOf: string;
            exclude?: string[];
          }): Promise<{ card: { id: string } | null }>;
        };
      };
      const exclude: string[] = [];
      for (let i = 0; i < 500; i++) {
        const res = await api.review.sessionNext({ asOf: clock, exclude });
        if (!res.card) return false;
        if (res.card.id === id) return true;
        exclude.push(res.card.id);
      }
      return false;
    },
    { id: cardId, clock: asOf },
  );
}

test("the retirement bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      cards?: { retire?: unknown; unretire?: unknown; retired?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasRetire: typeof api?.cards?.retire === "function",
      hasUnretire: typeof api?.cards?.unretire === "function",
      hasRetired: typeof api?.cards?.retired === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasRetire).toBe(true);
  expect(surface.hasUnretire).toBe(true);
  expect(surface.hasRetired).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("the seeded retired card shows in the inventory and is skipped by the due read", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openInventory(page);

  // At least the seeded retired mature card is listed, with stability + un-retire.
  const cards = page.getByTestId("retired-card");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThanOrEqual(1);
  const first = cards.first();
  await expect(first.getByTestId("retired-card-badge")).toBeVisible();
  await expect(first.getByTestId("retired-card-stability")).toBeVisible();
  await expect(first.getByTestId("retired-unretire")).toBeVisible();

  // The seeded retired card is NOT in the due deck (the flag excludes it).
  const seededRetiredId = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      cards: { retired(): Promise<{ cards: { id: string }[] }> };
    };
    const { cards } = await api.cards.retired();
    return cards[0]?.id ?? "";
  });
  expect(seededRetiredId).not.toBe("");
  expect(await isDue(page, seededRetiredId, FUTURE)).toBe(false);

  await app.close();
});

test("retire a fresh card → leaves the deck → un-retire → returns; survives restart", async () => {
  let cardId = "";

  // Author a fresh due card and retire it through the typed bridge.
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    cardId = await page.evaluate(async () => {
      const api = window.appApi as unknown as {
        inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
        cards: {
          create(req: {
            extractId: string;
            kind: string;
            prompt: string;
            answer: string;
          }): Promise<{ card: { id: string } }>;
        };
      };
      const { elements } = await api.inspector.list();
      const extract = elements.find((e) => e.type === "extract");
      if (!extract) throw new Error("no seeded extract");
      const { card } = await api.cards.create({
        extractId: extract.id,
        kind: "qa",
        prompt: "A low-value mature fact to retire?",
        answer: "The answer.",
      });
      return card.id;
    });

    // Due before retiring (a freshly authored card is first-scheduled DUE).
    expect(await isDue(page, cardId, FUTURE)).toBe(true);

    const retired = await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        cards: { retire(req: { cardId: string }): Promise<{ card: { retired: boolean } }> };
      };
      const res = await api.cards.retire({ cardId: id });
      return res.card.retired;
    }, cardId);
    expect(retired).toBe(true);

    // Gone from the due deck (by the flag, not a status/delete).
    expect(await isDue(page, cardId, FUTURE)).toBe(false);

    // It shows in the inventory, and the inspector reports it not deleted.
    await openInventory(page);
    await expect(
      page.locator(`[data-testid="retired-card"][data-card-id="${cardId}"]`),
    ).toBeVisible();
    const status = await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        inspector: {
          get(req: { id: string }): Promise<{ data: { element: { status: string } } | null }>;
        };
      };
      const res = await api.inspector.get({ id });
      return res.data?.element.status;
    }, cardId);
    expect(status).not.toBe("deleted");

    await app.close();
  }

  // Restart: the retired state persists; un-retire from the inventory returns it.
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Still retired (durable flag) + still excluded from the due read.
    const stillRetired = await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        cards: { retired(): Promise<{ cards: { id: string }[] }> };
      };
      const { cards } = await api.cards.retired();
      return cards.some((c) => c.id === id);
    }, cardId);
    expect(stillRetired).toBe(true);
    expect(await isDue(page, cardId, FUTURE)).toBe(false);

    // Un-retire from the inventory view → the card leaves the inventory + returns due.
    await openInventory(page);
    const row = page.locator(`[data-testid="retired-card"][data-card-id="${cardId}"]`);
    await expect(row).toBeVisible();
    await row.getByTestId("retired-unretire").click();
    await expect(row).toBeHidden();

    expect(await isDue(page, cardId, FUTURE)).toBe(true);

    await app.close();
  }
});
