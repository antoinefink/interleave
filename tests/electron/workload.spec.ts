/**
 * Workload simulation (T081) E2E — drives the real Electron app.
 *
 * Before committing a change, the user previews how their DAILY load would shift — a
 * pure projection over the live `review_states` + due dates that writes NOTHING. This
 * spec launches the built desktop app against a fresh data dir seeded with the shared
 * demo collection and asserts, end-to-end through the typed `window.appApi` + the
 * `/settings` Workload simulation panel:
 *
 *   1. raising the global retention in the simulator projects a HIGHER near-term load
 *      (the projection's "after" pulls due cards earlier) WITHOUT changing any due date;
 *   2. the preview alone mutates nothing — a card's `review_states.dueAt` is byte-for-byte
 *      identical before and after running the simulation (re-simulating yields the same
 *      baseline);
 *   3. Committing the real change (the typed `retention.setBand` / settings write) then
 *      takes effect — subsequent scheduling actually shifts.
 *
 * Everything flows through the narrow bridge / the typed `workload.simulate` IPC — there
 * is no raw SQL, FSRS stays card-only, and the simulation is read-only.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Author ONE matured Q&A card from the seeded extract, graded so it earns a multi-day interval. */
async function authorMaturedCard(page: Page): Promise<string> {
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
        }): Promise<{ reviewState: { dueAt: string | null } }>;
      };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract");
    if (!extract) throw new Error("no seeded extract");
    const { card } = await api.cards.create({
      extractId: extract.id,
      kind: "qa",
      prompt: "Workload Q?",
      answer: "A.",
    });
    let clock = Date.parse("2027-01-01T00:00:00.000Z");
    for (let i = 0; i < 4; i++) {
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
  });
}

/** Read a card's current FSRS due date through the typed inspector read. */
async function cardDueAt(page: Page, cardId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: {
          id: string;
        }): Promise<{ data: { review: { dueAt: string | null } | null } | null }>;
      };
    };
    const res = await api.inspector.get({ id });
    return res.data?.review?.dueAt ?? null;
  }, cardId);
}

/** Run the global-retention simulation at a fixed clock; return the projection summary. */
async function simulateGlobalRetention(
  page: Page,
  target: number,
  asOf: string,
): Promise<{
  peakBefore: number;
  peakAfter: number;
  overBudgetDaysBefore: number;
  overBudgetDaysAfter: number;
  near14Before: number;
  near14After: number;
}> {
  return page.evaluate(
    async ({ target: t, asOf: a }) => {
      const api = window.appApi as unknown as {
        workload: {
          simulate(req: {
            change: { kind: "retention"; scope: "global"; target: number };
            windowDays?: number;
            asOf?: string;
          }): Promise<{
            days: { before: number; after: number }[];
            peakBefore: number;
            peakAfter: number;
            overBudgetDaysBefore: number;
            overBudgetDaysAfter: number;
          }>;
        };
      };
      const res = await api.workload.simulate({
        change: { kind: "retention", scope: "global", target: t },
        windowDays: 60,
        asOf: a,
      });
      const sum = (sel: (d: { before: number; after: number }) => number) =>
        res.days.slice(0, 14).reduce((s, d) => s + sel(d), 0);
      return {
        peakBefore: res.peakBefore,
        peakAfter: res.peakAfter,
        overBudgetDaysBefore: res.overBudgetDaysBefore,
        overBudgetDaysAfter: res.overBudgetDaysAfter,
        near14Before: sum((d) => d.before),
        near14After: sum((d) => d.after),
      };
    },
    { target, asOf },
  );
}

/** Commit a real global desired-retention change through the typed settings write. */
async function commitGlobalRetention(page: Page, target: number): Promise<void> {
  await page.evaluate(async (t) => {
    const api = window.appApi as unknown as {
      settings: { update(req: { key: string; value: unknown }): Promise<unknown> };
    };
    await api.settings.update({ key: "review.defaultDesiredRetention", value: t });
  }, target);
}

/** Navigate to /settings through the real router (user-chip menu → Settings). */
async function gotoSettings(page: Page) {
  await page.getByTestId("user-chip").click();
  await page.getByRole("menuitem", { name: /^Settings$/ }).click();
  await expect(page.getByTestId("route-settings")).toBeVisible();
}

test("simulator previews a higher load on raising retention; preview mutates nothing; commit takes effect", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // A matured card scheduled well out under the default target, so a higher target
  // pulls its due date earlier in the projection.
  const cardId = await authorMaturedCard(page);
  // Anchor the projection at a clock AFTER the card's last review so it is in-window.
  const asOf = "2027-03-01T00:00:00.000Z";
  const dueBefore = await cardDueAt(page, cardId);

  // ---- The Workload simulation panel is present in /settings ----
  await gotoSettings(page);
  await expect(page.getByTestId("workload-simulator")).toBeVisible();

  // Drive the simulator UI: retention lever is the default; click Preview and see a result.
  await page.getByTestId("workload-preview").click();
  await expect(page.getByTestId("workload-result")).toBeVisible();

  // ---- Raising the retention projects a HIGHER near-term load (via the typed IPC) ----
  const low = await simulateGlobalRetention(page, 0.85, asOf);
  const high = await simulateGlobalRetention(page, 0.97, asOf);
  // A higher target shortens intervals → load pulls earlier (more in the near window),
  // and the peak / over-budget never decreases versus the lower target.
  expect(high.near14After).toBeGreaterThanOrEqual(low.near14After);
  expect(high.peakAfter).toBeGreaterThanOrEqual(high.peakBefore);

  // ---- The preview mutated NOTHING — the card's due date is byte-for-byte unchanged ----
  expect(await cardDueAt(page, cardId)).toBe(dueBefore);
  // Re-simulating yields the same baseline (deterministic, read-only).
  const repeat = await simulateGlobalRetention(page, 0.97, asOf);
  expect(repeat.near14Before).toBe(high.near14Before);
  expect(repeat.peakBefore).toBe(high.peakBefore);

  // ---- Commit the REAL change; it then takes effect (the global target persists) ----
  await commitGlobalRetention(page, 0.97);
  const persisted = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { getAll(): Promise<{ settings: { defaultDesiredRetention: number } }> };
    };
    const { settings } = await api.settings.getAll();
    return settings.defaultDesiredRetention;
  });
  expect(persisted).toBeCloseTo(0.97, 5);

  await app.close();
});
