/**
 * Desired retention by priority/concept (T079) E2E — drives the real Electron app.
 *
 * A card's FSRS desired-retention target is RESOLVED from an ordered rule set
 * (per-card override → concept → priority band → global default) and FSRS schedules
 * each card against its resolved target. This spec launches the built desktop app
 * against a fresh data dir seeded with the shared demo collection (so it has an
 * extract to author cards from) and asserts, end-to-end through the typed
 * `window.appApi` + the `/settings` UI:
 *
 *   1. raising the B-band target in `/settings` makes a B-priority card schedule a
 *      SHORTER next interval on a `Good` grade than the same grade under the default;
 *   2. a per-concept target resolves for a card in that concept (winning over the
 *      band), via the typed debug read `retention.resolveFor`;
 *   3. it SURVIVES AN APP RESTART — the band + concept targets and the resulting
 *      scheduling persist.
 *
 * Everything flows through the narrow bridge / the typed retention IPC — there is no
 * raw SQL and FSRS stays card-only (the attention scheduler is never touched).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/**
 * Author ONE matured Q&A card from the seeded extract at the given A/B/C/D priority
 * through the typed bridge, then grade it `Good` once at a fixed clock so it leaves
 * "new" and earns a multi-day stability — the next interval then responds to the
 * resolved target. Returns the card id.
 */
async function authorMaturedCard(page: Page, priority: string): Promise<string> {
  return page.evaluate(async (priority) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
      cards: {
        create(req: {
          extractId: string;
          kind: string;
          prompt: string;
          answer: string;
          priority: string;
        }): Promise<{ card: { id: string } }>;
      };
      review: {
        grade(req: {
          cardId: string;
          rating: string;
          responseMs: number;
          asOf: string;
        }): Promise<{ reviewState: { dueAt: string | null } }>;
      };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract");
    if (!extract) throw new Error("no seeded extract");
    const { card } = await api.cards.create({
      extractId: extract.id,
      kind: "qa",
      prompt: "Retention Q?",
      answer: "A.",
      priority,
    });
    // Mature the card with two `Good` grades (advancing the clock past each due) so it
    // reaches a multi-day `review`-state stability — the next interval then responds
    // clearly to the resolved retention target.
    let clock = Date.parse("2027-01-01T00:00:00.000Z");
    for (let i = 0; i < 3; i++) {
      const res = await api.review.grade({
        cardId: card.id,
        rating: "good",
        responseMs: 1000,
        asOf: new Date(clock).toISOString(),
      });
      clock = res.reviewState.dueAt
        ? Date.parse(res.reviewState.dueAt) + 86_400_000
        : clock + 86_400_000;
    }
    return card.id;
  }, priority);
}

/** The resolved retention target + which rule won, via the typed debug read. */
async function resolveFor(
  page: Page,
  cardId: string,
): Promise<{ target: number | null; source: string | null }> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      retention: {
        resolveFor(req: {
          cardId: string;
        }): Promise<{ target: number | null; source: string | null }>;
      };
    };
    return api.retention.resolveFor({ cardId: id });
  }, cardId);
}

/** Preview the `Good` next-interval (days) for a card at a fixed FUTURE clock. */
async function goodIntervalDays(page: Page, cardId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      review: {
        preview(req: {
          cardId: string;
          asOf: string;
        }): Promise<{ intervals: { good: { scheduledDays: number } } | null }>;
      };
    };
    const res = await api.review.preview({ cardId: id, asOf: "2099-01-01T00:00:00.000Z" });
    return res.intervals?.good.scheduledDays ?? 0;
  }, cardId);
}

/** Navigate to /settings through the real router (user-chip menu → Settings). */
async function gotoSettings(page: Page) {
  await page.getByTestId("user-chip").click();
  await page.getByRole("menuitem", { name: /^Settings$/ }).click();
  await expect(page.getByTestId("route-settings")).toBeVisible();
}

test("raising the B-band target in /settings shortens a B card's interval; concept wins; survives restart", async () => {
  let bCardId: string;
  let conceptCardId: string;

  // ---- Session 1: author cards, raise the B band in the UI, set a concept target ----
  {
    const app = await launchApp(dataDir, { seedOnEmpty: true });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // A B-priority card. Band B is empty in the seed (only A is set), so it resolves
    // to the global default — the baseline for the "raising B shortens it" assertion.
    bCardId = await authorMaturedCard(page, "B");
    expect(await resolveFor(page, bCardId)).toMatchObject({ source: "global" });
    const beforeInterval = await goodIntervalDays(page, bCardId);
    expect(beforeInterval).toBeGreaterThan(0);

    // Raise the B band in the UI: per-priority retention is already on in the seed,
    // but assert + ensure it, then set band B to 96% (> the 0.9 global default).
    await gotoSettings(page);
    const enableToggle = page.getByTestId("setting-retention-by-band");
    if ((await enableToggle.getAttribute("aria-checked")) !== "true") {
      await enableToggle.click();
    }
    const bSlider = page.getByTestId("setting-retention-band-B");
    await expect(bSlider).toBeEnabled();
    await bSlider.fill("96");
    await bSlider.dispatchEvent("change");
    await expect(page.getByTestId("setting-retention-band-B-value")).toHaveText("96%");

    // The B card now resolves to the band target (0.96) and schedules a SHORTER interval.
    await expect.poll(async () => (await resolveFor(page, bCardId)).source).toBe("band");
    expect((await resolveFor(page, bCardId)).target).toBeCloseTo(0.96, 5);
    expect(await goodIntervalDays(page, bCardId)).toBeLessThan(beforeInterval);

    // A per-concept target wins over the band for a card in that concept.
    conceptCardId = await authorMaturedCard(page, "B");
    await page.evaluate(async (cardId) => {
      const api = window.appApi as unknown as {
        concepts: {
          create(req: { name: string }): Promise<{ concept: { id: string } }>;
          assign(req: { elementId: string; conceptId: string }): Promise<unknown>;
        };
        retention: { setConcept(req: { conceptId: string; target: number }): Promise<unknown> };
      };
      const { concept } = await api.concepts.create({ name: "FragileT079" });
      await api.retention.setConcept({ conceptId: concept.id, target: 0.97 });
      await api.concepts.assign({ elementId: cardId, conceptId: concept.id });
    }, conceptCardId);

    const resolved = await resolveFor(page, conceptCardId);
    expect(resolved.source).toBe("concept");
    expect(resolved.target).toBeCloseTo(0.97, 5);

    await app.close();
  }

  // ---- Session 2: RESTART — targets + resolved scheduling persist ----
  {
    const app = await launchApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // The B-band target persisted: the B card still resolves to the band (0.96).
    const bResolved = await resolveFor(page, bCardId);
    expect(bResolved.source).toBe("band");
    expect(bResolved.target).toBeCloseTo(0.96, 5);

    // The per-concept target persisted: the concept card still resolves to it (0.97).
    const conceptResolved = await resolveFor(page, conceptCardId);
    expect(conceptResolved.source).toBe("concept");
    expect(conceptResolved.target).toBeCloseTo(0.97, 5);

    // The `/settings` Retention section reflects the persisted band + enabled state.
    await gotoSettings(page);
    await expect(page.getByTestId("setting-retention-by-band")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByTestId("setting-retention-band-B-value")).toHaveText("96%");

    await app.close();
  }
});
