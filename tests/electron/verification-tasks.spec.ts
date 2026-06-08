/**
 * Verification tasks (T092) E2E — drives the real Electron app.
 *
 * A `task` is the EXISTING core element type — an ATTENTION-scheduled maintenance
 * action ("verify this claim" / "find a better source" / "update this outdated card" /
 * "check the current version" / "custom") that protects time-sensitive knowledge from
 * rotting. Tasks are created by hand (the inspector) or GENERATED from T090 expiry,
 * link back to the element they protect (a `references` edge + `linked_element_id`),
 * appear in the daily queue + the inspector, and complete/postpone like any attention
 * item. Each mutation is one transaction + the correct EXISTING op (`create_element` /
 * `add_relation` / `reschedule_element`) — through the typed `tasks.*` `window.appApi`
 * (no raw SQL). This spec launches the built desktop app against a fresh data dir
 * seeded with the shared demo collection (whose Q&A card ships a PAST lifetime → expired
 * — and a seeded `verify_claim` task linked to it) and asserts:
 *
 *   1. the `tasks.*` bridge surface exists (no raw SQL);
 *   2. from the expired card's inspector, CREATE a "verify this claim" task → it appears
 *      in the inspector's Maintenance section AND in the daily queue as a task row, whose
 *      open affordance jumps to the protected card's review surface;
 *   3. COMPLETE a task from the inspector → it leaves the open Maintenance list;
 *   4. run "generate from expiry" → a task is created for the still-expired card and a
 *      SECOND run creates NO duplicate (idempotent);
 *   5. it SURVIVES AN APP RESTART — the remaining task + its link to the card persist.
 *
 * The seed clock is ~2026; a fixed FUTURE `asOf` makes the due task read as due.
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

/**
 * Select the seeded CARD from the inspector's picker by title. Scoped to
 * `data-element-type="card"` because the seeded verify task's title also contains the
 * card title (so a bare text filter would match two picker rows).
 */
async function selectCardByTitle(page: Page, title: string) {
  const item = page
    .locator('[data-testid="element-picker-item"][data-element-type="card"]')
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

/** Count the OPEN tasks protecting an element via the typed `tasks.list` bridge. */
async function openTaskCount(page: Page, cardId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      tasks: { list(req: { linkedElementId: string }): Promise<{ tasks: { id: string }[] }> };
    };
    const res = await api.tasks.list({ linkedElementId: id });
    return res.tasks.length;
  }, cardId);
}

test("the tasks.* bridge surface exists (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      tasks?: {
        create?: unknown;
        list?: unknown;
        complete?: unknown;
        postpone?: unknown;
        generateFromExpiry?: unknown;
      };
      db?: { query?: unknown };
    };
    return {
      hasCreate: typeof api?.tasks?.create === "function",
      hasList: typeof api?.tasks?.list === "function",
      hasComplete: typeof api?.tasks?.complete === "function",
      hasPostpone: typeof api?.tasks?.postpone === "function",
      hasGenerate: typeof api?.tasks?.generateFromExpiry === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasCreate).toBe(true);
  expect(surface.hasList).toBe(true);
  expect(surface.hasComplete).toBe(true);
  expect(surface.hasPostpone).toBe(true);
  expect(surface.hasGenerate).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("inspector Maintenance: create a verification task → it shows in the section + the queue", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  await selectCardByTitle(page, CARD_TITLE);
  const protectedCardId = await seededCardId(page);

  // The Maintenance section is present for a card and already lists the SEEDED
  // verify_claim task (the first seeded `task`).
  await expect(page.getByTestId("maintenance-section")).toBeVisible();
  await expect(page.getByTestId("maintenance-task")).toHaveCount(1);

  // Create a SECOND, distinct task kind (a "find better source" maintenance action).
  await page.getByTestId("maintenance-create").click();
  await page.getByTestId("maintenance-type").selectOption("find_better_source");
  await page.getByTestId("maintenance-note").fill("Swap the pre-print for the published paper");
  await page.getByTestId("maintenance-due").selectOption("tomorrow");
  await page.getByTestId("maintenance-create-save").click();

  // It appears in the Maintenance list (two open tasks now protect this card).
  await expect(page.getByTestId("maintenance-task")).toHaveCount(2);

  // And in the daily queue as a task row (the seeded task is due in the FUTURE clock).
  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(FUTURE)}`);
  await expect(page.getByTestId("route-queue")).toBeVisible();
  const taskRows = page.locator('[data-testid="queue-item"][data-element-type="task"]');
  await expect(taskRows.first()).toBeVisible();
  await expect(taskRows.first()).toContainText(/Protects card|Verify/i);

  // The seeded task PROTECTS the card → its open affordance reads "Verify" (a jump to
  // the protected element), not the generic "Open" (T092). Clicking it SELECTS the
  // protected CARD in the shell inspector and opens the FSRS review surface with the
  // same fixed clock, never opening the maintenance task itself.
  const seededTaskRow = taskRows.filter({ hasText: CARD_TITLE }).first();
  await expect(seededTaskRow).toBeVisible();
  await expect(seededTaskRow).toContainText(/Protects card/i);
  await expect(seededTaskRow.getByTestId("queue-open")).toContainText(/Verify/i);
  await seededTaskRow.getByTestId("queue-open").click();
  expect(new URL(page.url()).pathname).toMatch(/^\/card\//);
  await expect(page.getByTestId("route-card")).toBeVisible();
  await expect(page.getByTestId("card-detail")).toHaveAttribute("data-card-id", protectedCardId);

  await app.close();
});

test("inspector Maintenance: complete a task → it leaves the open list", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectCardByTitle(page, CARD_TITLE);
  await expect(page.getByTestId("maintenance-section")).toBeVisible();
  const before = await page.getByTestId("maintenance-task").count();
  expect(before).toBeGreaterThanOrEqual(1);

  // Complete the first open task.
  await page.getByTestId("maintenance-complete").first().click();
  await expect(page.getByTestId("maintenance-task")).toHaveCount(before - 1);

  await app.close();
});

test("generate from expiry: creates a task for the still-expired card and is idempotent", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const cardId = await seededCardId(page);
  const before = await openTaskCount(page, cardId);

  // Run generate-from-expiry: the seeded Q&A card is EXPIRED (past valid_until) → an
  // `update_outdated_card` task is created (a kind no open task protects yet).
  const first = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      tasks: { generateFromExpiry(req: Record<string, never>): Promise<{ created: number }> };
    };
    return api.tasks.generateFromExpiry({});
  });
  expect(first.created).toBeGreaterThanOrEqual(1);
  expect(await openTaskCount(page, cardId)).toBe(before + first.created);

  // A SECOND run creates NO duplicate (idempotent — one open task per kind).
  const second = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      tasks: { generateFromExpiry(req: Record<string, never>): Promise<{ created: number }> };
    };
    return api.tasks.generateFromExpiry({});
  });
  expect(second.created).toBe(0);
  expect(await openTaskCount(page, cardId)).toBe(before + first.created);

  await app.close();
});

test("the remaining tasks + their link to the card survive an app restart", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const cardId = await seededCardId(page);

  // Read the open tasks through the typed bridge: at least one remains, linked to the card.
  const tasks = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      tasks: {
        list(req: { linkedElementId: string }): Promise<{
          tasks: { id: string; linkedElement: { id: string; type: string } | null }[];
        }>;
      };
    };
    const res = await api.tasks.list({ linkedElementId: id });
    return res.tasks;
  }, cardId);

  expect(tasks.length).toBeGreaterThanOrEqual(1);
  for (const t of tasks) {
    expect(t.linkedElement?.id).toBe(cardId);
    expect(t.linkedElement?.type).toBe("card");
  }

  await app.close();
});
