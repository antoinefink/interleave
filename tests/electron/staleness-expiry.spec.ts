/**
 * Staleness & expiry (T090) E2E — drives the real Electron app.
 *
 * A fact (canonically a `card`) can carry a claim-LIFETIME — `fact_stability`,
 * `valid_from`/`valid_until`, `jurisdiction`, `software_version`, `review_by` — so it
 * can EXPIRE and trigger verification. "Expired" is a DERIVED attribute (a pure
 * `@interleave/core` `deriveExpiryStatus`), NOT a lifecycle status; editing the fields
 * is one `update_element` op through the typed `cards.setLifetime` bridge. This spec
 * launches the built desktop app against a fresh data dir seeded with the shared demo
 * collection (whose Q&A card ships a PAST lifetime → expired) and asserts:
 *
 *   1. the `cards.setLifetime` bridge surface exists (no raw SQL);
 *   2. opening the inspector on the seeded Q&A card → setting `valid_until` to a PAST
 *      date + a `review_by` → the Expiry badge reads "Expired";
 *   3. opening `/review` on that card → the prompt shows WITHOUT the expiry banner →
 *      reveal → the calm "may be out of date" banner appears (the reveal gate);
 *   4. it SURVIVES AN APP RESTART — the lifetime fields persist and the card still
 *      reads as expired (the derived status + the review banner).
 *
 * The seed clock is 2026; a fixed FUTURE `asOf` makes the seeded card read as due.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

const FUTURE = "2031-01-01T12:00:00.000Z";
const CARD_TITLE = "Chollet's definition of intelligence";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Select a seeded element from the inspector's picker by its (unique) title. */
async function selectByTitle(page: Page, type: string, title: string) {
  const item = page
    .locator(`[data-testid="element-picker-item"][data-element-type="${type}"]`)
    .filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText(title);
}

/** The id of the seeded Q&A card (the expired fact) via the typed inspector list. */
async function seededCardId(page: Page): Promise<string> {
  return page.evaluate(async (title) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const card = elements.find((e) => e.type === "card" && e.title === title);
    if (!card) throw new Error("seeded Q&A card not found");
    return card.id;
  }, CARD_TITLE);
}

/** Open `/review` (date-scoped via `?asOf=`) and wait for it to render. */
async function openReview(page: Page, asOf: string): Promise<void> {
  await page.goto(`${baseUrl}/review?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
}

test("the cards.setLifetime bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      cards?: { setLifetime?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSetLifetime: typeof api?.cards?.setLifetime === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSetLifetime).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("inspector Expiry: set a past valid_until + review_by → the badge reads Expired", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "card", CARD_TITLE);

  // The Expiry section is present for a card; open its editor and set a PAST window.
  await expect(page.getByTestId("expiry-section")).toBeVisible();
  await page.getByTestId("inspector-expiry-edit").click();
  await page.getByTestId("inspector-expiry-valid-until").fill("2020-01-01");
  await page.getByTestId("inspector-expiry-review-by").fill("2020-01-01");
  await page.getByTestId("inspector-expiry-stability").selectOption("volatile");
  await page.getByTestId("inspector-expiry-jurisdiction").fill("EU");
  await page.getByTestId("inspector-expiry-apply").click();

  // The derived status badge reads "Expired" (computed main-side, not in React).
  const badge = page.getByTestId("inspector-expiry-badge");
  await expect(badge).toHaveAttribute("data-expiry-status", "expired");
  await expect(badge).toContainText("Expired");
  // The edited fields render in the section.
  await expect(page.getByTestId("expiry-section")).toContainText("2020-01-01");
  await expect(page.getByTestId("expiry-section")).toContainText("EU");

  await app.close();
});

test("review: the expiry banner is hidden before reveal, shown after (reveal gate)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const cardId = await seededCardId(page);
  await openReview(page, FUTURE);

  // Advance the deck to the expired card (the seeded Q&A card).
  await expect(page.getByTestId("review-card")).toBeVisible();
  for (let i = 0; i < 20; i++) {
    const onCard = await page.getByTestId("review-card").getAttribute("data-card-id");
    if (onCard === cardId) break;
    // Reveal + grade "good" to advance to the next due card.
    await page.getByTestId("review-reveal").click();
    await expect(page.getByTestId("review-grades")).toBeVisible();
    await page.getByTestId("review-grade-good").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
  }
  await expect(page.getByTestId("review-card")).toHaveAttribute("data-card-id", cardId);

  // Before reveal: the prompt shows, the expiry banner is ABSENT (the reveal gate).
  await expect(page.getByTestId("review-prompt")).toBeVisible();
  await expect(page.getByTestId("review-expiry-banner")).toHaveCount(0);

  // Reveal: the calm "may be out of date" banner appears.
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-answer")).toBeVisible();
  const banner = page.getByTestId("review-expiry-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute("data-expiry-status", "expired");
  await expect(banner).toContainText(/out of date/i);

  await app.close();
});

test("the lifetime + the derived expiry survive an app restart", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const cardId = await seededCardId(page);

  // The persisted lifetime + the derived status read through the typed inspector.
  const lifetime = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            lifetime: {
              status: string;
              validUntil: string | null;
              jurisdiction: string | null;
              factStability: string | null;
            } | null;
          } | null;
        }>;
      };
    };
    const res = await api.inspector.get({ id });
    return res.data?.lifetime ?? null;
  }, cardId);

  expect(lifetime?.status).toBe("expired");
  expect(lifetime?.validUntil).toBe("2020-01-01");
  expect(lifetime?.jurisdiction).toBe("EU");
  expect(lifetime?.factStability).toBe("volatile");

  // The review card still carries the expiry block (resolved from the persisted fields).
  const expiry = await page.evaluate(
    async ({ id, clock }) => {
      const api = window.appApi as unknown as {
        review: {
          card(req: {
            cardId: string;
            asOf: string;
          }): Promise<{ card: { expiry: { status: string } | null } | null }>;
        };
      };
      const res = await api.review.card({ cardId: id, asOf: clock });
      return res.card?.expiry ?? null;
    },
    { id: cardId, clock: FUTURE },
  );
  expect(expiry?.status).toBe("expired");

  await app.close();
});
