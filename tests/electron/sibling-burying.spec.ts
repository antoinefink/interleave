/**
 * Sibling burying (T039) E2E — drives the real Electron app.
 *
 * Within a review session, two cards that share a sibling group (the same extract /
 * cloze set) must NOT appear back-to-back, so siblings don't prime each other's
 * answers. Burying is on by default and can be disabled via the `burySiblings`
 * setting; when off, the natural due order is used. This spec:
 *
 *   1. seeds, via the typed bridge, two CLOZE siblings from one extract (one
 *      shared sibling group) plus one UNRELATED card from a different extract, and
 *      makes all three due by grading each once;
 *   2. with burying ON (the default), walks `review.session.next` the way the
 *      renderer does — threading the previous card's `siblingGroupId` as
 *      `recentSiblingGroups` — and asserts the two siblings are NOT consecutive;
 *   3. toggles "Bury siblings" OFF in `/settings` and confirms the siblings ARE
 *      then allowed consecutively (natural due order);
 *   4. RESTARTS the Electron app and confirms the setting persisted.
 *
 * All deck selection happens MAIN-side; the renderer only carries the opaque group
 * id forward. The whole flow runs over `window.appApi` (no raw SQL).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

/** Base clock used to first-schedule the seeded cards (their grade time). */
const BASE = "2027-01-01T12:00:00.000Z";
/** A far-future review clock so all three cards read as due deterministically. */
const REVIEW_AS_OF = "2030-01-01T12:00:00.000Z";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** The seeded `atomic_statement` extract (parent of the demo Q&A + cloze cards). */
async function seededExtractId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string; stage: string }[] }>;
      };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract" && e.stage === "atomic_statement");
    if (!extract) throw new Error("seeded atomic extract not found");
    return extract.id;
  });
}

/** A SECOND extract id (the seeded sub-extract), for the unrelated card's lineage. */
async function secondExtractId(page: Page, exclude: string): Promise<string> {
  return page.evaluate(async (skip) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract" && e.id !== skip);
    if (!extract) throw new Error("second extract not found");
    return extract.id;
  }, exclude);
}

/**
 * Create a card from an extract via `cards.create`, optionally joining `group`.
 * Returns the new card id + the (minted or reused) sibling group id.
 */
async function createCloze(
  page: Page,
  extractId: string,
  cloze: string,
  group?: string,
): Promise<{ id: string; siblingGroupId: string }> {
  return page.evaluate(
    async ({ extractId: ex, cloze: c, group: g }) => {
      const api = window.appApi as unknown as {
        cards: {
          create(req: {
            extractId: string;
            kind: string;
            cloze?: string;
            siblingGroupId?: string;
          }): Promise<{ card: { id: string; siblingGroupId: string } }>;
        };
      };
      const { card } = await api.cards.create({
        extractId: ex,
        kind: "cloze",
        cloze: c,
        ...(g ? { siblingGroupId: g } : {}),
      });
      return { id: card.id, siblingGroupId: card.siblingGroupId };
    },
    { extractId, cloze, group },
  );
}

/** Grade a card once (Good) at `asOf` so it leaves `card_draft` and becomes due. */
async function gradeOnce(page: Page, cardId: string, asOf: string): Promise<void> {
  await page.evaluate(
    async ({ id, clock }) => {
      const api = window.appApi as unknown as {
        review: {
          grade(req: {
            cardId: string;
            rating: string;
            responseMs: number;
            asOf: string;
          }): Promise<unknown>;
        };
      };
      await api.review.grade({ cardId: id, rating: "good", responseMs: 1500, asOf: clock });
    },
    { id: cardId, clock: asOf },
  );
}

/**
 * Walk `review.session.next` exactly as the renderer does: thread the previous
 * card's `siblingGroupId` forward as `recentSiblingGroups`, exclude already-seen
 * ids, and stop when the deck is exhausted. Returns the ordered card ids.
 */
async function walkSession(page: Page, asOf: string, burySiblings?: boolean): Promise<string[]> {
  return page.evaluate(
    async ({ clock, bury }) => {
      const api = window.appApi as unknown as {
        review: {
          sessionNext(req: {
            asOf: string;
            exclude?: string[];
            recentSiblingGroups?: string[];
            burySiblings?: boolean;
          }): Promise<{ card: { id: string; siblingGroupId: string | null } | null }>;
        };
      };
      const order: string[] = [];
      const seen: string[] = [];
      let recent: string | null = null;
      for (let i = 0; i < 50; i++) {
        const res = await api.review.sessionNext({
          asOf: clock,
          exclude: seen,
          ...(recent ? { recentSiblingGroups: [recent] } : {}),
          ...(bury === undefined ? {} : { burySiblings: bury }),
        });
        if (!res.card) break;
        order.push(res.card.id);
        seen.push(res.card.id);
        recent = res.card.siblingGroupId;
      }
      return order;
    },
    { clock: asOf, bury: burySiblings },
  );
}

/** Read the persisted `burySiblings` setting via the typed bridge. */
async function readBurySetting(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { getAll(): Promise<{ settings: { burySiblings: boolean } }> };
    };
    const { settings } = await api.settings.getAll();
    return settings.burySiblings;
  });
}

/** True iff the two ids appear adjacent (in either order) in the sequence. */
function areConsecutive(order: string[], a: string, b: string): boolean {
  for (let i = 0; i + 1 < order.length; i++) {
    const pair = [order[i], order[i + 1]];
    if (pair.includes(a) && pair.includes(b)) return true;
  }
  return false;
}

test("with burying ON, two siblings from one group are never shown back-to-back", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const extractId = await seededExtractId(page);
  const otherExtractId = await secondExtractId(page, extractId);

  // Two cloze siblings from ONE extract (shared group) + one unrelated card.
  const sib1 = await createCloze(page, extractId, "A is {{c1::alpha}}.");
  const sib2 = await createCloze(page, extractId, "B is {{c1::beta}}.", sib1.siblingGroupId);
  const other = await createCloze(page, otherExtractId, "C is {{c1::gamma}}.");
  expect(sib1.siblingGroupId).toBe(sib2.siblingGroupId);
  expect(other.siblingGroupId).not.toBe(sib1.siblingGroupId);

  // Make all three due (each card is created un-due; one grade schedules it).
  for (const id of [sib1.id, sib2.id, other.id]) await gradeOnce(page, id, BASE);

  // Default setting is burySiblings = true.
  expect(await readBurySetting(page)).toBe(true);

  // Walk the session — all three are due; the two siblings must not be adjacent.
  const order = await walkSession(page, REVIEW_AS_OF);
  expect(order).toContain(sib1.id);
  expect(order).toContain(sib2.id);
  expect(order).toContain(other.id);
  expect(areConsecutive(order, sib1.id, sib2.id)).toBe(false);

  await app.close();
});

test("toggling Bury siblings OFF in /settings restores sibling adjacency", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: false });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The cards from the previous test persist (same data dir). Re-resolve them.
  const ids = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
      };
    };
    const { elements } = await api.inspector.list();
    const cards = elements.filter((e) => e.type === "card");
    return {
      sib1: cards.find((c) => c.title.startsWith("A is"))?.id ?? "",
      sib2: cards.find((c) => c.title.startsWith("B is"))?.id ?? "",
      other: cards.find((c) => c.title.startsWith("C is"))?.id ?? "",
    };
  });
  expect(ids.sib1 && ids.sib2 && ids.other).toBeTruthy();

  // Toggle "Bury siblings" OFF in the real /settings UI.
  await page.goto(`${baseUrl}/settings`);
  await page.waitForLoadState("domcontentloaded");
  const toggle = page.getByTestId("setting-bury-siblings");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");

  // The setting persisted to SQLite through the bridge.
  await expect.poll(() => readBurySetting(page)).toBe(false);

  // With burying OFF (read from the persisted setting), the natural due order is
  // used — the two siblings are now allowed to be consecutive. (We do not force a
  // per-request flag; the session reads the setting, proving the toggle drives it.)
  const order = await walkSession(page, REVIEW_AS_OF);
  expect(order).toContain(ids.sib1);
  expect(order).toContain(ids.sib2);
  expect(areConsecutive(order, ids.sib1, ids.sib2)).toBe(true);

  await app.close();
});

test("the burySiblings setting persists across an app restart", async () => {
  // A brand-new app process on the SAME data dir must still see burying OFF.
  const app = await launchApp(dataDir, { seedOnEmpty: false });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  expect(await readBurySetting(page)).toBe(false);

  // The /settings toggle reflects the persisted value after restart.
  await page.goto(`${baseUrl}/settings`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("setting-bury-siblings")).toHaveAttribute("aria-checked", "false");

  await app.close();
});
