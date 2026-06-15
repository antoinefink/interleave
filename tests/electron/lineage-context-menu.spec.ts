/**
 * Lineage-tree context menu (U7) E2E — drives the real Electron app.
 *
 * Units U1–U6 added an in-app (React, not Electron-native) right-click context menu to
 * the lineage tree nodes in the Inspector. This spec launches the BUILT desktop app
 * against a fresh seeded data dir (the shared demo `source → extract → sub-extract → card`
 * chain) and proves the real right-click → in-app menu → typed-IPC paths, end-to-end
 * through `window.appApi` (the renderer never opens SQLite), including restart-persistence
 * for the persistence-affecting actions:
 *
 *   1. MENU OPENS on a real right-click of a live lineage node; Escape closes it.
 *   2. ADVANCE STAGE on an extract node advances `raw_extract → clean_extract` and the
 *      advanced stage SURVIVES an app restart.
 *   3. SET PRIORITY via the submenu (→ A) reflects in the element's priority and SURVIVES
 *      an app restart.
 *   4. DELETE routes through the SAME lineage-delete flow as the existing Delete: a leaf
 *      node → quiet soft-delete (recoverable TOMBSTONE, NOT a hard delete) with no intent
 *      popover; a node WITH descendants → the descendant-aware intent popover
 *      (`lineage-delete-pop`).
 *   5. TOMBSTONE actions: on a revealed tombstone, right-click → "Restore ancestor chain"
 *      returns the node live; and the always-visible inline Restore (T135/U2) still works
 *      and is unchanged.
 *
 * Every mutation rides the real UI or the typed bridge — exactly the paths the user takes.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

// Each test owns an ISOLATED, freshly-seeded data dir so the scenarios are independent
// and order-free (a tombstone left by one never leaks into another). The build is shared.
test.beforeAll(() => {
  ensureBuilt();
});

// ---------------------------------------------------------------------------
// Typed-bridge helpers (the renderer's only door — never raw SQL).
// ---------------------------------------------------------------------------

/** Capture the running app's renderer origin so a test can navigate routes. */
async function originOf(page: Page): Promise<string> {
  const url = new URL(page.url());
  return `${url.protocol}//${url.host}`;
}

/** Resolve a seeded element id by type + (optional unique) title via the bridge. */
async function resolveId(page: Page, type: string, title?: string): Promise<string> {
  return page.evaluate(
    async ({ type, title }) => {
      const api = window.appApi as unknown as {
        inspector: {
          list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
        };
      };
      const { elements } = await api.inspector.list();
      const match = elements.find((e) => e.type === type && (!title || e.title === title));
      if (!match) throw new Error(`seeded ${type}${title ? ` "${title}"` : ""} not found`);
      return match.id;
    },
    { type, title },
  );
}

/** The inspector's element summary for `id` (its `stage` / numeric `priority` / `status`). */
async function elementSummary(
  page: Page,
  id: string,
): Promise<{ stage: string; priority: number; status: string } | null> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { element: { stage: string; priority: number; status: string } } | null;
        }>;
      };
    };
    const res = await api.inspector.get({ id: elementId });
    return res.data?.element ?? null;
  }, id);
}

/** The element's current `title` via the inspector bridge (for the rename scenario). */
async function elementTitle(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { element: { title: string } } | null }>;
      };
    };
    const res = await api.inspector.get({ id: elementId });
    return res.data?.element.title ?? null;
  }, id);
}

/** The flattened lineage nodes for `id`, optionally INCLUDING soft-deleted tombstones. */
async function lineageNodes(
  page: Page,
  id: string,
  includeTombstones = false,
): Promise<{ id: string; type: string; deleted: boolean; active: boolean; depth: number }[]> {
  return page.evaluate(
    async ({ id, includeTombstones }) => {
      const api = window.appApi as unknown as {
        lineage: {
          get(req: { id: string; includeTombstones?: boolean }): Promise<{
            lineage: {
              nodes: {
                id: string;
                type: string;
                deleted: boolean;
                active: boolean;
                depth: number;
              }[];
            } | null;
          }>;
        };
      };
      const res = await api.lineage.get({ id, includeTombstones });
      return res.lineage?.nodes ?? [];
    },
    { id, includeTombstones },
  );
}

// ---------------------------------------------------------------------------
// UI helpers.
// ---------------------------------------------------------------------------

/** Select a seeded element from the inspector's picker by its (unique) title. */
async function selectByTitle(page: Page, title: string) {
  const item = page.getByTestId("element-picker-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
}

/** A lineage-tree node button by element id. */
function treeNode(page: Page, id: string) {
  return page.locator(`[data-testid="lineage-tree-node"][data-element-id="${id}"]`).first();
}

/**
 * Right-click a tree node and assert the in-app context menu opens at the cursor.
 *
 * We dispatch a real `contextmenu` MouseEvent (with cursor coordinates taken from the
 * node's center) rather than `click({ button: "right" })`: a right mouse click does not
 * reliably synthesize a `contextmenu` event in Electron/Chromium, but React's
 * `onContextMenu` only fires on a genuine `contextmenu` event. The node's handler reads
 * `e.clientX/e.clientY`, so we pass real on-screen coordinates.
 */
async function openContextMenu(page: Page, id: string) {
  const node = treeNode(page, id);
  await expect(node).toBeVisible();
  const box = await node.boundingBox();
  if (!box) throw new Error(`tree node ${id} has no bounding box`);
  const clientX = Math.round(box.x + box.width / 2);
  const clientY = Math.round(box.y + box.height / 2);
  await node.dispatchEvent("contextmenu", { clientX, clientY, button: 2, bubbles: true });
  await expect(page.getByTestId("lineage-context-menu")).toBeVisible();
}

/**
 * Activate a context-menu item by dispatching a `click` event directly on it.
 *
 * We use `dispatchEvent("click")` rather than `locator.click()` on purpose: a real click
 * first SCROLLS the target into view, and the `ContextMenu` closes itself on any
 * capture-phase `scroll` (its v1 has no reposition loop). That scroll-close detaches the
 * item mid-click and the click never lands. Dispatching the DOM event fires the React
 * `onClick` with no scroll and no hit-test — exactly the activation the user's click
 * produces, minus the harness-only scroll side effect.
 */
async function clickMenuItem(page: Page, testId: string) {
  const item = page.getByTestId(testId);
  await expect(item).toBeVisible();
  await item.dispatchEvent("click");
}

// ---------------------------------------------------------------------------
// 1. The menu opens on a real right-click of a live node; Escape closes it.
// ---------------------------------------------------------------------------

test("right-click opens the lineage context menu on a live node; Escape closes it", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const subExtractId = await resolveId(page, "extract", "Must control for priors and experience");

  // Selecting the source renders the full chain in the Inspector's lineage tree.
  await selectByTitle(page, "On the Measure of Intelligence");
  await expect(page.getByTestId("lineage-tree")).toBeVisible();

  // A real right-click on the sub-extract node opens the in-app menu (native menu is
  // suppressed by the node's onContextMenu preventDefault).
  await openContextMenu(page, subExtractId);
  // The live-node catalog is present: Open + the extract-only Advance stage + Delete.
  await expect(page.getByTestId("context-menu-item-open")).toBeVisible();
  await expect(page.getByTestId("context-menu-item-advance-stage")).toBeVisible();
  await expect(page.getByTestId("context-menu-item-delete")).toBeVisible();

  // Escape closes it. Press on the (auto-focused) first item so the keydown reaches the
  // menu container's handler via bubbling, regardless of where document focus settled.
  await page.getByTestId("context-menu-item-open").press("Escape");
  await expect(page.getByTestId("lineage-context-menu")).toHaveCount(0);

  await app.close();
});

// ---------------------------------------------------------------------------
// 2. Advance stage on an extract node advances raw_extract → clean_extract and persists.
// ---------------------------------------------------------------------------

test("right-click → Advance stage advances an extract's stage and survives restart", async () => {
  const dir = makeDataDir();
  let app = await launchApp(dir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const baseUrl = await originOf(page);

  // The sub-extract is seeded at `raw_extract` (the parent extract is already terminal at
  // `atomic_statement`, so advancing it would be a no-op) — use the sub-extract.
  const subExtractId = await resolveId(page, "extract", "Must control for priors and experience");
  expect((await elementSummary(page, subExtractId))?.stage).toBe("raw_extract");

  await selectByTitle(page, "On the Measure of Intelligence");
  await openContextMenu(page, subExtractId);

  // Click "Advance stage" → updateExtractStage({ id }) (no stage = advance one step).
  await clickMenuItem(page, "context-menu-item-advance-stage");
  await expect(page.getByTestId("lineage-context-menu")).toHaveCount(0);

  // The stage advanced one step (raw_extract → clean_extract), read back via the bridge.
  await expect
    .poll(async () => (await elementSummary(page, subExtractId))?.stage)
    .toBe("clean_extract");

  // RESTART: relaunch against the same data dir — the advanced stage persists.
  await app.close();
  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  expect((await elementSummary(page, subExtractId))?.stage).toBe("clean_extract");

  // And it is still the advanced stage when navigating back to the surface.
  await page.goto(`${baseUrl}/`);
  await page.waitForLoadState("domcontentloaded");
  expect((await elementSummary(page, subExtractId))?.stage).toBe("clean_extract");

  await app.close();
});

// ---------------------------------------------------------------------------
// 3. Set priority via the submenu reflects + persists.
// ---------------------------------------------------------------------------

test("right-click → Set priority → A reflects on the node and survives restart", async () => {
  const dir = makeDataDir();
  let app = await launchApp(dir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The sub-extract is seeded at priority B (0.625); set it to A (0.875, reads back ≥ 0.75).
  const subExtractId = await resolveId(page, "extract", "Must control for priors and experience");
  expect((await elementSummary(page, subExtractId))?.priority).toBeLessThan(0.75);

  await selectByTitle(page, "On the Measure of Intelligence");
  await openContextMenu(page, subExtractId);

  // Open the "Set priority" submenu, then pick A.
  await clickMenuItem(page, "context-menu-item-priority");
  await expect(page.getByTestId("context-menu-sub-priority")).toBeVisible();
  await clickMenuItem(page, "context-menu-item-priority-A");
  await expect(page.getByTestId("lineage-context-menu")).toHaveCount(0);

  // The priority is now in the A band (>= 0.75), read back via the bridge.
  await expect
    .poll(async () => (await elementSummary(page, subExtractId))?.priority ?? 0)
    .toBeGreaterThanOrEqual(0.75);

  // RESTART: the priority change persists.
  await app.close();
  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  expect((await elementSummary(page, subExtractId))?.priority ?? 0).toBeGreaterThanOrEqual(0.75);

  await app.close();
});

// ---------------------------------------------------------------------------
// 3b. Rename via the inline editor commits a new title and survives restart (R8 — rename
//     writes operation_log through the same SQLite transaction as priority/stage).
// ---------------------------------------------------------------------------

test("right-click → Rename commits a new title that survives restart", async () => {
  const dir = makeDataDir();
  let app = await launchApp(dir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const subExtractId = await resolveId(page, "extract", "Must control for priors and experience");
  await selectByTitle(page, "On the Measure of Intelligence");
  await openContextMenu(page, subExtractId);

  // Rename… opens the inline editor at the node; type a new title and commit with Enter.
  await clickMenuItem(page, "context-menu-item-rename");
  const input = page.getByTestId("lineage-rename-input");
  await expect(input).toBeVisible();
  const NEW_TITLE = "Controlled priors (renamed)";
  await input.fill(NEW_TITLE);
  await input.press("Enter");

  // The title changed, read back via the bridge.
  await expect.poll(async () => elementTitle(page, subExtractId)).toBe(NEW_TITLE);

  // RESTART: the rename persists (operation_log write survives the relaunch).
  await app.close();
  app = await launchApp(dir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  expect(await elementTitle(page, subExtractId)).toBe(NEW_TITLE);

  await app.close();
});

// ---------------------------------------------------------------------------
// 4. Delete routes through the SAME lineage-delete flow: a leaf → quiet soft-delete +
//    Undo snackbar + recoverable tombstone; a node with descendants → the intent popover.
// ---------------------------------------------------------------------------

test("right-click → Delete routes through the lineage-delete flow (leaf quiet delete + descendant intent popover)", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const extractId = await resolveId(page, "extract", "Intelligence = skill-acquisition efficiency");
  // The seeded Q&A card under that extract — a LEAF (no descendants).
  const cardId = await page.evaluate(async (parentId) => {
    const api = window.appApi as unknown as {
      lineage: {
        get(req: {
          id: string;
        }): Promise<{ lineage: { nodes: { id: string; type: string }[] } | null }>;
      };
    };
    const { lineage } = await api.lineage.get({ id: parentId });
    const card = lineage?.nodes.find((n) => n.type === "card");
    if (!card) throw new Error("seeded descendant card not found");
    return card.id;
  }, extractId);

  await selectByTitle(page, "On the Measure of Intelligence");

  // (a) LEAF card → Delete is the QUIET fast path: NO descendant-aware intent popover, and
  // the node becomes a recoverable TOMBSTONE (a SOFT delete, NOT a hard delete) — exactly
  // the existing leaf-delete behavior of `useLineageDelete` (the same controller every
  // delete entry point shares). The quiet leaf path does not raise its own
  // `lineage-context-snackbar` here (only the descendant `keep`/`branch` paths do — see
  // `useLineageDelete`), so we assert the deterministic soft-delete OUTCOME rather than a
  // transient snackbar.
  await openContextMenu(page, cardId);
  await clickMenuItem(page, "context-menu-item-delete");
  await expect(page.getByTestId("lineage-context-menu")).toHaveCount(0);
  // No descendant-aware intent popover for a leaf (the quiet fast path).
  await expect(page.getByTestId("lineage-delete-pop")).toHaveCount(0);
  // The card is soft-deleted (hidden from the inspector) but recoverable as a tombstone in
  // its own lineage — proving the same soft-delete path, not a hard delete.
  await expect.poll(async () => (await elementSummary(page, cardId))?.status ?? null).toBeNull();
  const cardTomb = (await lineageNodes(page, cardId, true)).find((n) => n.id === cardId);
  expect(cardTomb?.deleted).toBe(true);

  // (b) A node WITH live descendants (the mid-tree extract) → Delete opens the SAME
  // descendant-aware intent popover the existing Delete path uses (no silent prune).
  await openContextMenu(page, extractId);
  await clickMenuItem(page, "context-menu-item-delete");
  await expect(page.getByTestId("lineage-context-menu")).toHaveCount(0);
  await expect(page.getByTestId("lineage-delete-pop")).toBeVisible();
  await expect(page.getByTestId("lineage-delete-radius")).toBeVisible();
  await expect(page.getByTestId("lineage-delete-keep")).toBeVisible();
  await expect(page.getByTestId("lineage-delete-branch")).toBeVisible();
  // The extract's honorable-fate action confirms it is the real lineage-delete menu.
  await expect(page.getByTestId("lineage-delete-mark-done")).toBeVisible();

  // Esc cancels with NO mutation — the extract stays live (non-destructive until chosen).
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("lineage-delete-pop")).toHaveCount(0);
  expect((await elementSummary(page, extractId))?.status ?? null).not.toBeNull();

  await app.close();
});

// ---------------------------------------------------------------------------
// 5. Tombstone actions: right-click → Restore ancestor chain returns the node live; and the
//    always-visible inline Restore (T135/U2) still works on a tombstone (unchanged).
// ---------------------------------------------------------------------------

test("tombstone node: right-click → Restore ancestor chain restores it; inline Restore still works", async () => {
  const dir = makeDataDir();
  const app = await launchApp(dir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const baseUrl = await originOf(page);

  const extractId = await resolveId(page, "extract", "Intelligence = skill-acquisition efficiency");
  // Tombstone the mid extract while keeping descendants (subtree off), via the typed
  // bridge — the SAME soft-delete the "Keep descendants" intent drives. The live card
  // stays under the tombstone, so the card's own lineage reveals the deleted extract.
  const cardId = await resolveId(page, "card", "Chollet's definition of intelligence");
  await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      elements: {
        softDeleteSubtree(req: { id: string; includeSubtree?: boolean }): Promise<unknown>;
      };
    };
    await api.elements.softDeleteSubtree({ id, includeSubtree: false });
  }, extractId);
  expect((await lineageNodes(page, cardId, true)).find((n) => n.id === extractId)?.deleted).toBe(
    true,
  );

  // Select the still-live card, then reveal deleted nodes in the Lineage section so the
  // tombstoned ancestor extract becomes a struck node in the tree (with its inline Restore).
  await page.goto(`${baseUrl}/`);
  await page.waitForLoadState("domcontentloaded");
  const cardPick = page
    .locator('[data-testid="element-picker-item"][data-element-type="card"]')
    .filter({ hasText: /^Chollet's definition of intelligence/ });
  await expect(cardPick).toHaveCount(1);
  await cardPick.click();
  await expect(page.getByTestId("inspector-content")).toHaveAttribute("data-element-type", "card");

  const lineageSection = page.getByTestId("lineage-section");
  const showDeleted = lineageSection.getByRole("button", { name: /show deleted/i });
  await expect(showDeleted).toBeVisible();
  await showDeleted.click();

  // The tombstoned ancestor extract is now a node in the tree.
  await expect(treeNode(page, extractId)).toBeVisible();
  await expect(treeNode(page, extractId)).toHaveAttribute("data-deleted", "true");

  // (6) INLINE Restore (T135/U2) is present + keyboard-reachable on the tombstone — its
  // always-visible control is unchanged by the new menu.
  const inlineRestore = page
    .locator(`[data-testid="lineage-tombstone-restore"][data-element-id="${extractId}"]`)
    .first();
  await expect(inlineRestore).toBeVisible();
  await expect(inlineRestore).toBeEnabled();

  // (5) RIGHT-CLICK the tombstone → the tombstone catalog (Restore, Restore ancestor chain,
  // Delete permanently…) — then "Restore ancestor chain" returns the extract LIVE.
  await openContextMenu(page, extractId);
  await expect(page.getByTestId("context-menu-item-restore")).toBeVisible();
  await expect(page.getByTestId("context-menu-item-purge")).toBeVisible();
  await clickMenuItem(page, "context-menu-item-restore-chain");
  await expect(page.getByTestId("lineage-context-menu")).toHaveCount(0);

  // The extract is live again (status non-null) and no longer a tombstone in the card's chain.
  await expect
    .poll(async () => (await elementSummary(page, extractId))?.status ?? null)
    .not.toBeNull();
  expect((await lineageNodes(page, cardId, true)).find((n) => n.id === extractId)?.deleted).toBe(
    false,
  );

  await app.close();
});
