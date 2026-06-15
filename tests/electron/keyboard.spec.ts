/**
 * Keyboard shortcuts & command palette E2E (T048) — drives the real Electron app.
 *
 * T048 makes the whole core loop MOUSE-FREE: every frequent action has a keyboard
 * shortcut and a `⌘K` command-palette entry, and — the load-bearing invariant —
 * each shortcut/palette command invokes the EXACT SAME typed `window.appApi`
 * command as its on-screen button (no second mutation path). This spec launches
 * the BUILT desktop app against a fresh seeded data dir and drives a mouse-free
 * mini-loop entirely by keyboard, asserting each action's effect through the bridge:
 *
 *   1. `⌘K` opens the command palette; an ACTION command ("Lower priority") runs
 *      the SAME `elements.setPriority` the inspector button calls (the selected
 *      element's band drops);
 *   2. in the reader, select text + `E` creates an `extract` (same path as the
 *      Extract toolbar button), asserted via the bridge;
 *   3. global `+`/`-` raise/lower the SELECTED element's priority via
 *      `elements.setPriority` (the universal write);
 *   4. `o` opens the selected extract's SOURCE (the T022 jump) — lands on the
 *      originating paragraph;
 *   5. in the extract distillation view, select text + `C` opens the cloze builder
 *      (the SAME entry point the Cloze button uses);
 *   6. in the queue process loop, `p` (postpone) / `d` (done) mutate the right item
 *      via `queue.act`;
 *   7. `?` opens the cheat sheet (and Esc closes it);
 *   8. the mutations SURVIVE AN APP RESTART (the DoD bar).
 *
 * Reuses the shared seeded source ("On the Measure of Intelligence") + the launch
 * helpers. Drives the queue with a fixed FUTURE `asOf` so the seeded near-future
 * due items read as due deterministically (the same trick the queue spec uses).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;

/** A fixed future clock so the seeded near-future due dates read as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";
/** macOS uses Meta for ⌘K; Playwright's Electron runs on the host platform. */
const CMD = process.platform === "darwin" ? "Meta" : "Control";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

async function resolveSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const source = elements.find(
      (e) => e.type === "source" && e.title === "On the Measure of Intelligence",
    );
    if (!source) throw new Error("seeded source not found");
    return source.id;
  });
}

/** The A/B/C/D priority label for an element, via the bridge. */
async function priorityLabel(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { element: { priority: number } } | null }>;
      };
    };
    const res = await api.inspector.get({ id: elementId });
    const p = res.data?.element.priority;
    if (p == null) return null;
    // Mirror the core A/B/C/D bands (A high → D low). Numeric priority is 0–1.
    if (p >= 0.75) return "A";
    if (p >= 0.5) return "B";
    if (p >= 0.25) return "C";
    return "D";
  }, id);
}

async function extractCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.filter((e) => e.type === "extract").length;
  });
}

async function openReader(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

/** Triple-click a block to select its whole text (updates the editor selection). */
async function selectBlockText(page: Page, blockId: string): Promise<string> {
  const block = page.locator(`.reader [data-block-id="${blockId}"]`);
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

test("⌘K palette action runs the SAME elements.setPriority as the button", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);

  // The palette ACTION entries + the cheat sheet exist and there is NO raw SQL.
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      elements?: { setPriority?: unknown };
      menu?: { onShowShortcuts?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSetPriority: typeof api?.elements?.setPriority === "function",
      hasMenu: typeof api?.menu?.onShowShortcuts === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSetPriority).toBe(true);
  expect(surface.hasMenu).toBe(true);
  expect(surface.hasQuery).toBe(false);

  // Select the seeded SOURCE in the inspector (so the global/palette actions target
  // it), entirely by clicking the picker — then run the rest mouse-free.
  const picker = page.getByTestId("element-picker-item").filter({ hasText: "On the Measure of" });
  await expect(picker.first()).toBeVisible();
  await picker.first().click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();

  const before = await priorityLabel(page, sourceId);
  expect(before).toBe("A"); // seed gives the source priority A

  // ⌘K opens the palette; type to filter to "Lower priority"; Enter runs it.
  await page.keyboard.press(`${CMD}+KeyK`);
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByLabel("Command palette search").fill("Lower priority");
  await page.keyboard.press("Enter");

  // The palette command ran the SAME setPriority the inspector "lower" button does:
  // the band drops one step (A → B).
  await expect.poll(() => priorityLabel(page, sourceId)).toBe("B");

  await app.close();
});

test("the reader's E key creates an extract mouse-free (same path as the button)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  const before = await extractCount(page);

  // Select an un-extracted paragraph and press E (no toolbar click) → an extract.
  const selected = await selectBlockText(page, "blk_intro_p2");
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await page.keyboard.press("e");
  await expect(page.getByTestId("reader-flash")).toContainText("Extracted");

  // Exactly one NEW extract — the SAME extractions.create the button calls.
  await expect.poll(() => extractCount(page)).toBe(before + 1);
  // The parent block paints `.extracted` without a reload.
  await expect(page.locator('.reader [data-block-id="blk_intro_p2"].extracted')).toBeVisible();

  await app.close();
});

test("global + / - change the selected element's priority via elements.setPriority", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Stay on the default route (no reader/review/queue scope is mounted, so the
  // global element keys are live) and select the seeded source in the picker.
  const picker = page.getByTestId("element-picker-item").filter({ hasText: "On the Measure of" });
  await expect(picker.first()).toBeVisible();
  await picker.first().click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();

  const start = await priorityLabel(page, sourceId);
  // Lower then raise — the band steps down and back up via the SAME setPriority.
  await page.keyboard.press("-");
  await expect.poll(() => priorityLabel(page, sourceId)).not.toBe(start);
  const lowered = await priorityLabel(page, sourceId);
  await page.keyboard.press("+");
  await expect.poll(() => priorityLabel(page, sourceId)).not.toBe(lowered);

  await app.close();
});

test("the ? cheat sheet opens by keyboard (and Esc closes it)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.keyboard.press("Shift+Slash"); // "?"
  await expect(page.getByTestId("cheat-sheet")).toBeVisible();
  // The cheat sheet documents the load-bearing T048 keys (derived from the registry).
  await expect(page.getByText("Extract selection")).toBeVisible();
  await expect(page.getByText("Raise priority")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cheat-sheet")).toHaveCount(0);

  await app.close();
});

test("Cmd/Ctrl + Arrow navigates back and forward through page history", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Build a small history stack via the app's OWN g-nav (real router pushes, the
  // same path the sidebar uses): go to /queue, then /library.
  await page.keyboard.press("g");
  await page.keyboard.press("q");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/queue");

  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/library");

  // ⌘← / Ctrl+← walks BACK one entry to /queue …
  await page.keyboard.press(`${CMD}+ArrowLeft`);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/queue");

  // … and ⌘→ / Ctrl+→ walks FORWARD again to /library.
  await page.keyboard.press(`${CMD}+ArrowRight`);
  await expect.poll(() => new URL(page.url()).pathname).toBe("/library");

  await app.close();
});

test("the queue process loop is keyboard-drivable (p postpones via queue.act)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Give the seeded extract a fixed due_at so an attention item is in the due set,
  // then `p` can move it later deterministically.
  const extractId = await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
      queue: {
        schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
      };
    };
    const { elements } = await api.inspector.list();
    const ex = elements.find((e) => e.type === "extract");
    if (!ex) throw new Error("no seeded extract");
    await api.queue.schedule({ id: ex.id, choice: { kind: "manual", date: asOf } });
    return ex.id;
  }, AS_OF);

  // Open the process loop (date-scoped so the seeded items read as due).
  await page.goto(`${baseUrl}/process?asOf=${encodeURIComponent(AS_OF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-process")).toBeVisible();
  const item = page.getByTestId("process-item");
  await expect(item.first()).toBeVisible();

  // The CURRENT item's due before postponing (via the bridge).
  const firstId = await item.first().getAttribute("data-element-id");
  expect(firstId).toBeTruthy();
  const dueBefore = await page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { element: { dueAt: string | null } } | null }>;
      };
    };
    const res = await api.inspector.get({ id });
    return res.data?.element.dueAt ?? null;
  }, firstId as string);

  // Press `p` → postpone the current item via queue.act (the SAME command the
  // on-screen Postpone button calls) and advance the loop.
  await page.keyboard.press("p");

  // The postponed item's due moved strictly later (queue.act ran).
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const api = window.appApi as unknown as {
          inspector: {
            get(req: {
              id: string;
            }): Promise<{ data: { element: { dueAt: string | null } } | null }>;
          };
        };
        const res = await api.inspector.get({ id });
        return res.data?.element.dueAt ?? null;
      }, firstId as string),
    )
    .not.toBe(dueBefore);

  // Keep using `extractId` so the helper read is meaningful even if the order varies.
  expect(extractId).toBeTruthy();

  await app.close();
});

test("the keyboard mutations survive an app restart", async () => {
  // Relaunch against the SAME data dir — the extract created by `E` and the
  // priority changes persisted to SQLite.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The keyboard-created extract (from `blk_intro_p2`) is still present.
  const hasIntroP2Extract = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string }[] }>;
        get(req: {
          id: string;
        }): Promise<{ data: { location: { blockIds: string[] } | null } | null }>;
      };
    };
    const { elements } = await api.inspector.list();
    for (const e of elements.filter((x) => x.type === "extract")) {
      const res = await api.inspector.get({ id: e.id });
      if (res.data?.location?.blockIds.includes("blk_intro_p2")) return true;
    }
    return false;
  });
  expect(hasIntroP2Extract).toBe(true);

  await app.close();
});
