/**
 * Source-reliability metadata (T091) E2E — drives the real Electron app.
 *
 * A `source` records HOW TRUSTWORTHY it is — `source_type` / `reliability_tier`
 * (primary/secondary/tertiary) / `confidence` / `reliability_notes` — extending the
 * T014 provenance row + the T043 refblock. Editing it is one `update_element` op through
 * the typed `sources.updateReliability` bridge (no raw SQL, no new lineage model). The
 * reliability badge + uncertainty note surface in the refblock + inspector on sources,
 * extracts, and IMPORTANT CARDS (a card derived from the source inherits it), and in
 * review POST-REVEAL (it rides the reveal gate). This spec launches the built desktop app
 * against a fresh data dir seeded with the shared demo collection (whose source ships
 * reliability) and asserts:
 *
 *   1. the `sources.updateReliability` bridge surface exists (no raw SQL);
 *   2. opening the inspector on the seeded source → setting tier = primary / confidence =
 *      high / type = paper + a note → the Reliability badge updates;
 *   3. opening the inspector on a CARD derived from that source → the same reliability
 *      shows on the card's refblock;
 *   4. opening `/review` on the card → the badge is ABSENT before reveal, present after;
 *   5. it SURVIVES AN APP RESTART — the reliability persists.
 *
 * The seed clock is 2026; a fixed FUTURE `asOf` makes the seeded card read as due.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

const FUTURE = "2031-01-01T12:00:00.000Z";
const SOURCE_TITLE = "On the Measure of Intelligence";
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

/** The id of a seeded element of a given type + title via the typed inspector list. */
async function seededId(page: Page, type: string, title: string): Promise<string> {
  return page.evaluate(
    async ({ type, title }) => {
      const api = window.appApi as unknown as {
        inspector: {
          list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
        };
      };
      const { elements } = await api.inspector.list();
      const el = elements.find((e) => e.type === type && e.title === title);
      if (!el) throw new Error(`seeded ${type} "${title}" not found`);
      return el.id;
    },
    { type, title },
  );
}

/** Open `/review` (date-scoped via `?asOf=`) and wait for it to render. */
async function openReview(page: Page, asOf: string): Promise<void> {
  await page.goto(`${baseUrl}/review?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-review")).toBeVisible();
}

test("the sources.updateReliability bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      sources?: { updateReliability?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasUpdateReliability: typeof api?.sources?.updateReliability === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasUpdateReliability).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("inspector Reliability: set tier=primary / confidence=high / type=paper → the badge updates", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "source", SOURCE_TITLE);

  // The Reliability section is present for a source; the seed ships a secondary/medium
  // badge. Open its editor and raise it to primary / high / paper + a note.
  await expect(page.getByTestId("reliability-section")).toBeVisible();
  await page.getByTestId("inspector-reliability-edit").click();
  await page.getByTestId("inspector-reliability-tier").selectOption("primary");
  await page.getByTestId("inspector-reliability-type").selectOption("paper");
  await page.getByTestId("inspector-reliability-confidence").selectOption("high");
  await page
    .getByTestId("inspector-reliability-notes-input")
    .fill("Foundational ARC paper; widely cited.");
  await page.getByTestId("inspector-reliability-apply").click();

  // The badge reads the assembled label (computed main-side via formatSourceRef).
  const badge = page.getByTestId("inspector-reliability-badge");
  await expect(badge).toHaveAttribute("data-reliability-tier", "primary");
  await expect(badge).toContainText("Primary source · high confidence");
  await expect(page.getByTestId("reliability-section")).toContainText("Paper");
  await expect(page.getByTestId("inspector-reliability-notes")).toContainText(
    "Foundational ARC paper",
  );

  await app.close();
});

test("a card derived from the source shows the same reliability on its refblock", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "card", CARD_TITLE);

  // The card's refblock (T043) carries the source's reliability badge (inherited
  // through lineage) — the "reliability on important cards" surfacing.
  const badge = page.getByTestId("inspector-refblock-reliability");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-reliability-tier", "primary");
  await expect(badge).toContainText("Primary source · high confidence");

  await app.close();
});

test("review: the reliability badge is hidden before reveal, shown after (reveal gate)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const cardId = await seededId(page, "card", CARD_TITLE);
  await openReview(page, FUTURE);

  // Advance the deck to the target card.
  await expect(page.getByTestId("review-card")).toBeVisible();
  for (let i = 0; i < 20; i++) {
    const onCard = await page.getByTestId("review-card").getAttribute("data-card-id");
    if (onCard === cardId) break;
    await page.getByTestId("review-reveal").click();
    await expect(page.getByTestId("review-grades")).toBeVisible();
    await page.getByTestId("review-grade-good").click();
    await expect(page.getByTestId("review-card")).toBeVisible();
  }
  await expect(page.getByTestId("review-card")).toHaveAttribute("data-card-id", cardId);

  // Before reveal: the prompt shows, the reliability badge is ABSENT (the reveal gate —
  // the badge is part of the refblock, hidden until reveal so it can't leak the answer).
  await expect(page.getByTestId("review-prompt")).toBeVisible();
  await expect(page.getByTestId("review-refblock-reliability")).toHaveCount(0);

  // Reveal: the refblock + its reliability badge appear.
  await page.getByTestId("review-reveal").click();
  await expect(page.getByTestId("review-answer")).toBeVisible();
  const badge = page.getByTestId("review-refblock-reliability");
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute("data-reliability-tier", "primary");
  await expect(badge).toContainText("Primary source · high confidence");

  await app.close();
});

test("the reliability survives an app restart", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const sourceId = await seededId(page, "source", SOURCE_TITLE);

  // The persisted reliability reads through the typed inspector (provenance + sourceRef).
  const reliability = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            provenance: {
              sourceType: string | null;
              reliabilityTier: string | null;
              confidence: string | null;
              reliabilityNotes: string | null;
            } | null;
            sourceRef: { reliabilityTier: string | null } | null;
          } | null;
        }>;
      };
    };
    const res = await api.inspector.get({ id });
    return {
      provenance: res.data?.provenance ?? null,
      sourceRefTier: res.data?.sourceRef?.reliabilityTier ?? null,
    };
  }, sourceId);

  expect(reliability.provenance?.reliabilityTier).toBe("primary");
  expect(reliability.provenance?.confidence).toBe("high");
  expect(reliability.provenance?.sourceType).toBe("paper");
  expect(reliability.provenance?.reliabilityNotes).toContain("Foundational ARC paper");
  expect(reliability.sourceRefTier).toBe("primary");

  await app.close();
});
