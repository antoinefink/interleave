/**
 * Text-selection toolbar E2E (T019) — drives the real Electron app.
 *
 * Selecting a run of text in the source reader must pop the inline selection
 * toolbar (Extract / Cloze / Highlight / Copy / Cancel) anchored above the
 * selection, WITHOUT collapsing the live ProseMirror selection, and each button
 * must dispatch its action. Highlight is now wired (T020 — it persists a
 * `document_marks` row and toasts "Highlighted"); Extract (T021) and Cloze (M6)
 * remain stubs that toast — so this spec asserts the seam: the toolbar appears
 * with all five actions on a ≥3-char selection, the DOM selection survives a button
 * press (the `onMouseDown` preventDefault), an action dispatches (a toast), and
 * Cancel / Escape dismiss it without mutating the body. The full highlight
 * persist/reload/restart/remove round-trip is covered by `highlights.spec.ts`.
 *
 * It reuses the shared seeded source ("On the Measure of Intelligence") and the
 * same launch/route helpers as the T018 reader spec; no persistence is involved
 * (T019 writes nothing), so this is a single-launch UI flow.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;

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

async function openReader(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

/**
 * Select the text of a block by stable block id with a real triple-click (which
 * selects the whole paragraph in ProseMirror — updating BOTH the DOM selection and
 * the editor's internal selection — and emits a genuine `mouseup`, the toolbar's
 * trigger). Returns the selected string so the test can assert it is non-trivial.
 * A real interaction is used (not a synthetic DOM Range) because the toolbar reads
 * `editor.state.selection`, which a bare DOM Range would not update.
 */
async function selectBlockText(page: Page, blockId: string): Promise<string> {
  const block = page.locator(`.reader [data-block-id="${blockId}"]`);
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** The current DOM selection text (for the "selection not broken" assertion). */
function currentSelection(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

test("selecting text shows the toolbar with all five actions", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);
  await openReader(page, sourceId);

  const selected = await selectBlockText(page, "blk_def_p1");
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);

  const toolbar = page.getByTestId("selection-toolbar");
  await expect(toolbar).toBeVisible();
  // The toolbar floats fixed above the selection.
  await expect(toolbar).toHaveCSS("position", "fixed");
  for (const id of [
    "sel-tool-extract",
    "sel-tool-cloze",
    "sel-tool-highlight",
    "sel-tool-copy",
    "sel-tool-cancel",
  ]) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  await app.close();
});

test("pressing a toolbar button keeps the selection and dispatches the action", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  const selected = await selectBlockText(page, "blk_def_p1");
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();

  // Highlight now persists (T020) — it must dispatch (a toast) AND keep the
  // selection alive (the toolbar prevents the mousedown default). Assert on the
  // toast TEXT (the visible `position:fixed` span) rather than its zero-size
  // wrapper div.
  await page.getByTestId("sel-tool-highlight").click();
  await expect(page.getByText("Highlighted")).toBeVisible();
  // The DOM selection survived the button press (not collapsed to empty).
  expect((await currentSelection(page)).trim().length).toBeGreaterThan(0);
  // The selection text is unchanged by the action (no doc mutation).
  expect(await currentSelection(page)).toBe(selected);

  await app.close();
});

test("the H shortcut dispatches highlight without typing into the editable body", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  const before = await page.locator(".reader .ProseMirror").innerText();

  await selectBlockText(page, "blk_def_p1");
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();

  // Press the bare letter shortcut. The capture-phase handler must run the action
  // AND suppress the keystroke so "h" is never inserted into the contentEditable.
  await page.keyboard.press("h");
  await expect(page.getByText("Highlighted")).toBeVisible();

  // The body is unchanged — the shortcut did not type "h" over the selection.
  const after = await page.locator(".reader .ProseMirror").innerText();
  expect(after).toBe(before);

  await app.close();
});

test("Escape dismisses the toolbar without mutating the document", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await openReader(page, sourceId);

  const before = await page.locator(".reader .ProseMirror").innerText();

  await selectBlockText(page, "blk_def_p1");
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("selection-toolbar")).toBeHidden();

  // The body is untouched — no surround/mutation happened on selection.
  const after = await page.locator(".reader .ProseMirror").innerText();
  expect(after).toBe(before);

  await app.close();
});
