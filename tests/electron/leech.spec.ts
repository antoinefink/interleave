/**
 * Basic leech detection (T040) E2E — drives the real Electron app.
 *
 * A card that keeps failing is automatically flagged a leech once its FSRS
 * `lapses` cross the threshold (4 — `@interleave/scheduler` `LEECH_LAPSE_THRESHOLD`);
 * the review session shows a leech banner + badge, and the card surfaces in a
 * cleanup view offering rewrite / suspend / delete. This spec launches the built
 * desktop app against a fresh data dir seeded with the shared demo collection
 * (which ships ONE seeded leech card with four lapses) and asserts:
 *
 *   1. the `review.leeches` / `cards.markLeech` bridge surface exists (no raw SQL);
 *   2. grading a card `again` past 4 lapses (through the typed bridge) sets the
 *      durable leech flag, and the `/review` screen shows the leech banner + badge
 *      for that card;
 *   3. the leech cleanup view (`/maintenance/leeches`) lists the leech card with its
 *      lapse count + source and offers rewrite / suspend / delete;
 *   4. suspending the leech from the cleanup view removes it from the review deck;
 *   5. it SURVIVES AN APP RESTART — the leech flag + the suspension persist.
 *
 * The seed clock is 2026; a fixed FUTURE `asOf` makes the seeded cards read as due.
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

/** Open the leech cleanup view and wait for it to render. */
async function openCleanup(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/maintenance/leeches`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-leech-cleanup")).toBeVisible();
}

/** Drive a fresh card past 4 lapses through the typed bridge; returns its id + leech state. */
async function makeFreshLeech(page: Page): Promise<{ cardId: string; leech: boolean }> {
  return page.evaluate(async () => {
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
      review: {
        grade(req: {
          cardId: string;
          rating: string;
          responseMs: number;
          asOf: string;
        }): Promise<{ reviewState: { dueAt: string | null; lapses: number } }>;
        sessionNext(req: {
          asOf: string;
          exclude?: string[];
        }): Promise<{ card: { id: string; leech: boolean } | null }>;
      };
    };

    // Author a fresh card from the seeded extract (it already has a valid source
    // location anchor — no need to create a new extraction).
    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract");
    if (!extract) throw new Error("no seeded extract");
    const { card } = await api.cards.create({
      extractId: extract.id,
      kind: "qa",
      prompt: "A persistently-forgotten fact?",
      answer: "The answer.",
    });

    // FSRS only counts a lapse on a `review`-state fail, so graduate (easy) then
    // alternate again/good to accrue four lapses; advance the clock each grade.
    let clock = Date.parse("2027-06-02T00:00:00.000Z");
    const grade = async (rating: string) => {
      const at = new Date(clock).toISOString();
      const res = await api.review.grade({ cardId: card.id, rating, responseMs: 4000, asOf: at });
      clock = res.reviewState.dueAt
        ? Date.parse(res.reviewState.dueAt) + 86_400_000
        : clock + 86_400_000;
    };
    await grade("easy"); // new → review
    for (let i = 0; i < 4; i++) {
      await grade("again");
      if (i < 3) await grade("good");
    }

    // Read the leech flag off the review card view (the renderer's banner source).
    const next = await api.review.sessionNext({ asOf: new Date(clock).toISOString(), exclude: [] });
    // Walk to find our card (it may not be the soonest-due).
    let view = next.card;
    const seen: string[] = [];
    while (view && view.id !== card.id) {
      seen.push(view.id);
      const more = await api.review.sessionNext({
        asOf: new Date(clock).toISOString(),
        exclude: seen,
      });
      view = more.card;
    }
    return { cardId: card.id, leech: view?.leech ?? false };
  });
}

test("the leech bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      review?: { leeches?: unknown };
      cards?: { markLeech?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasLeeches: typeof api?.review?.leeches === "function",
      hasMarkLeech: typeof api?.cards?.markLeech === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasLeeches).toBe(true);
  expect(surface.hasMarkLeech).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("grading a card past 4 lapses flags it a leech and shows the banner in review", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const FUTURE = "2031-01-01T12:00:00.000Z";
  const { cardId, leech } = await makeFreshLeech(page);
  expect(leech).toBe(true);

  // Make the leech card the SOLE due card so the review screen shows it first
  // (deterministic) — suspend every other currently-due card through the bridge.
  await page.evaluate(
    async ({ keepId, clock }) => {
      const api = window.appApi as unknown as {
        review: {
          sessionNext(req: {
            asOf: string;
            exclude?: string[];
          }): Promise<{ card: { id: string } | null }>;
        };
        cards: { suspend(req: { cardId: string }): Promise<unknown> };
      };
      const exclude: string[] = [];
      for (let i = 0; i < 200; i++) {
        const res = await api.review.sessionNext({ asOf: clock, exclude });
        if (!res.card) break;
        if (res.card.id === keepId) {
          exclude.push(res.card.id); // keep it; just skip it in the walk
        } else {
          await api.cards.suspend({ cardId: res.card.id });
        }
      }
    },
    { keepId: cardId, clock: FUTURE },
  );

  // Open /review — the leech card is now the deck head; the banner + badge show.
  await page.goto(`${baseUrl}/review?asOf=${encodeURIComponent(FUTURE)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
  await expect(page.getByTestId("review-card")).toHaveAttribute("data-card-id", cardId);
  await expect(page.getByTestId("review-leech-banner")).toBeVisible();
  await expect(page.getByText(/leech ·/i)).toBeVisible();

  await app.close();
});

test("the cleanup view lists the leech card with rewrite/suspend/delete", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openCleanup(page);

  // At least the seeded leech card (4 lapses) is listed.
  const cards = page.getByTestId("leech-card");
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBeGreaterThanOrEqual(1);

  // The first card exposes its lapse count + the three remediation actions.
  const first = cards.first();
  await expect(first.getByTestId("leech-card-lapses")).toBeVisible();
  await expect(first.getByTestId("leech-rewrite")).toBeVisible();
  await expect(first.getByTestId("leech-suspend")).toBeVisible();
  await expect(first.getByTestId("leech-delete")).toBeVisible();

  await app.close();
});

test("suspending a leech from the cleanup view removes it from the review deck; survives restart", async () => {
  // Identify a leech card id + suspend it from the cleanup view.
  let leechId = "";
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    leechId = await page.evaluate(async () => {
      const api = window.appApi as unknown as {
        review: { leeches(): Promise<{ cards: { id: string; status: string }[] }> };
      };
      const { cards } = await api.review.leeches();
      const active = cards.find((c) => c.status !== "suspended") ?? cards[0];
      if (!active) throw new Error("no leech card to suspend");
      return active.id;
    });

    await openCleanup(page);
    // Click the suspend action on the matching card.
    const card = page.locator(`[data-testid="leech-card"][data-card-id="${leechId}"]`);
    await expect(card).toBeVisible();
    await card.getByTestId("leech-suspend").click();

    // The card's status becomes suspended (it leaves the active review deck).
    const suspended = await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        inspector: {
          get(req: { id: string }): Promise<{ data: { element: { status: string } } | null }>;
        };
      };
      const res = await api.inspector.get({ id });
      return res.data?.element.status;
    }, leechId);
    expect(suspended).toBe("suspended");

    await app.close();
  }

  // Restart: the leech flag + the suspension persist.
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const state = await page.evaluate(async (id) => {
      const api = window.appApi as unknown as {
        review: { leeches(): Promise<{ cards: { id: string; status: string }[] }> };
        inspector: {
          get(req: { id: string }): Promise<{ data: { element: { status: string } } | null }>;
        };
      };
      const { cards } = await api.review.leeches();
      const insp = await api.inspector.get({ id });
      return {
        stillLeech: cards.some((c) => c.id === id),
        status: insp.data?.element.status,
      };
    }, leechId);
    // The leech flag is durable (still listed) and the suspension persisted.
    expect(state.stillLeech).toBe(true);
    expect(state.status).toBe("suspended");

    await app.close();
  }
});
