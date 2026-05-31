/**
 * Concepts knowledge-map (`/concepts`) E2E — drives the real Electron app.
 *
 * The dedicated `/concepts` route renders the read-only concept knowledge-map plus
 * a member drill-in: selecting a concept node lists the LIVE elements assigned to
 * it (the genuinely-new data), each openable in its reader. It reaches the renderer
 * only through the typed `concepts.list` + the narrow new `concepts.members`
 * `window.appApi` commands (no generic SQL). This spec launches the built desktop
 * app against a fresh data dir seeded with the shared demo collection, then:
 *
 *   1. the `concepts.members` bridge command exists (and `db.query` does NOT);
 *   2. navigating to `/concepts` via the `g`+`c` chord highlights the Concepts nav
 *      item EXCLUSIVELY (the ac73484 triple-highlight stays fixed for the new route);
 *   3. the seeded "Intelligence" concept node is present on the map;
 *   4. clicking it lists its seeded source + extract members, and opening a member
 *      navigates to its reader;
 *   5. it SURVIVES AN APP RESTART — the members read back identically.
 *
 * The seed attaches the "Intelligence" concept to the SOURCE and the EXTRACT (the
 * cards are left un-organized), so those two are this concept's expected members.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;

const CONCEPT_NAME = "Intelligence";
const SOURCE_TITLE = "On the Measure of Intelligence";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open `/concepts` and wait for the knowledge-map screen to render. */
async function openConcepts(page: Page): Promise<void> {
  await page.goto(`${baseUrl}/concepts`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-concepts")).toBeVisible();
}

test("the concepts.members bridge command exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      concepts?: { members?: unknown; list?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasMembers: typeof api?.concepts?.members === "function",
      hasList: typeof api?.concepts?.list === "function",
      hasRawQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasMembers).toBe(true);
  expect(surface.hasList).toBe(true);
  expect(surface.hasRawQuery).toBe(false);

  await app.close();
});

test("the seeded 'Intelligence' concept node is present on the map", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openConcepts(page);

  // The graph renders, and the seeded child concept is one of its nodes.
  await expect(page.getByTestId("concept-graph")).toBeVisible();
  const node = page.getByTestId("concept-node").filter({ hasText: CONCEPT_NAME });
  await expect(node).toHaveCount(1);

  await app.close();
});

test("clicking the Intelligence node lists its seeded source + extract members", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openConcepts(page);

  await page.getByTestId("concept-node").filter({ hasText: CONCEPT_NAME }).click();

  // The drill-in panel appears with the seeded source + extract groups.
  await expect(page.getByTestId("concepts-members")).toBeVisible();
  const sourceGroup = page.getByTestId("concepts-members-group-source");
  const extractGroup = page.getByTestId("concepts-members-group-extract");
  await expect(sourceGroup).toBeVisible();
  await expect(extractGroup).toBeVisible();
  // The seeded source is the (single) member in the Sources group.
  const sourceRow = sourceGroup.getByTestId("concepts-member");
  await expect(sourceRow).toHaveCount(1);
  await expect(sourceRow).toContainText(SOURCE_TITLE);

  // Opening the source member navigates to its reader.
  await sourceRow.dblclick();
  await expect(page).toHaveURL(/\/source\//);

  await app.close();
});

test("NAV-EXCLUSIVITY — g+c navigates to /concepts and highlights Concepts exclusively", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Start somewhere else, then drive the keyboard goto chord.
  await page.goto(`${baseUrl}/queue`);
  await page.waitForLoadState("domcontentloaded");

  await page.keyboard.press("g");
  await page.keyboard.press("c");

  await expect(page.getByTestId("route-concepts")).toBeVisible();

  // Exactly one sidebar entry carries aria-current="page", and it is Concepts —
  // NOT Search or Library (the triple-highlight bug stays fixed for the new route).
  const activeNav = page.locator('.shell-nav [aria-current="page"]');
  await expect(activeNav).toHaveCount(1);
  await expect(page.getByTestId("nav-concepts")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-concepts")).toHaveAttribute("data-status", "active");
  await expect(page.getByTestId("nav-search")).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("nav-library")).not.toHaveAttribute("aria-current", "page");

  await app.close();
});

test("the concept members read back identically after an app restart (persisted)", async () => {
  // Re-launch against the SAME data dir — the restart analogue.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const res = await page.evaluate(async (conceptName) => {
    const api = window.appApi as unknown as {
      concepts: {
        list(): Promise<{ concepts: { id: string; name: string }[] }>;
        members(r: {
          conceptId: string;
        }): Promise<{ members: { id: string; type: string; title: string }[] }>;
      };
    };
    const { concepts } = await api.concepts.list();
    const concept = concepts.find((c) => c.name === conceptName);
    if (!concept) return { types: [] as string[], titles: [] as string[] };
    const { members } = await api.concepts.members({ conceptId: concept.id });
    return {
      types: [...new Set(members.map((m) => m.type))],
      titles: members.map((m) => m.title),
    };
  }, CONCEPT_NAME);

  // The seed assigns the source + the extract to Intelligence — both persist.
  expect(res.types).toContain("source");
  expect(res.types).toContain("extract");
  expect(res.titles).toContain(SOURCE_TITLE);

  // And the UI still renders the map + drill-in after restart.
  await openConcepts(page);
  await page.getByTestId("concept-node").filter({ hasText: CONCEPT_NAME }).click();
  await expect(page.getByTestId("concepts-members-group-source")).toBeVisible();

  await app.close();
});
