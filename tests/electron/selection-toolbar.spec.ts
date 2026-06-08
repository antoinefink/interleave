/**
 * Text-selection toolbar E2E (T019) — drives the real Electron app.
 *
 * Selecting a run of text in the source reader must pop the inline selection
 * toolbar (Extract / Cloze / Highlight / Copy / Cancel) anchored above the
 * selection, WITHOUT collapsing the live ProseMirror selection, and each button
 * must dispatch its action. Highlight persists a `document_marks` row; Extract
 * creates a child extract; Cloze remains a later card-builder entry point. This
 * spec asserts the seam: the toolbar appears with all five actions on a ≥3-char
 * selection, the DOM selection survives a button press (the `onMouseDown`
 * preventDefault), an action dispatches, and Cancel / Escape dismiss it without
 * mutating the body. The full highlight persist/reload/restart/remove round-trip
 * is covered by `highlights.spec.ts`.
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
  if (!baseUrl) {
    const url = new URL(page.url());
    baseUrl = `${url.protocol}//${url.host}`;
  }
  await page.goto(`${baseUrl}/source/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("reader-title")).toBeVisible();
  await expect(page.locator(".reader .ProseMirror")).toBeVisible();
}

async function openExtract(page: Page, id: string): Promise<void> {
  if (!baseUrl) {
    const url = new URL(page.url());
    baseUrl = `${url.protocol}//${url.host}`;
  }
  await page.goto(`${baseUrl}/extract/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("extract-title")).toBeVisible();
  await expect(page.getByTestId("extract-editor")).toBeVisible();
  await expect(page.locator(".extract-editor .reader .ProseMirror")).toBeVisible();
}

async function createTallLateParagraphSource(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      sources: {
        importManual(req: {
          title: string;
          body: string;
          priority: "A" | "B" | "C" | "D";
        }): Promise<{ id: string }>;
      };
      inbox: {
        triage(req: { id: string; action: { kind: "accept" } }): Promise<unknown>;
      };
    };
    const hugeParagraph = Array.from(
      { length: 90 },
      (_, i) =>
        `Large toolbar target sentence ${i} with enough words to wrap into many visible client rectangles.`,
    ).join(" ");
    const body = [
      ...Array.from({ length: 35 }, (_, i) => `Filler paragraph ${i}.`),
      `LATE_TARGET_START ${hugeParagraph} LATE_TARGET_END`,
      "Bottom sentinel paragraph.",
    ].join("\n\n");
    const { id } = await api.sources.importManual({
      title: "Large toolbar geometry source",
      body,
      priority: "C",
    });
    await api.inbox.triage({ id, action: { kind: "accept" } });
    return id;
  });
}

async function createTallExtract(page: Page, srcId: string): Promise<string> {
  return page.evaluate(async (sourceElementId) => {
    const api = window.appApi as unknown as {
      extractions: {
        create(req: {
          sourceElementId: string;
          selectedText: string;
          blockIds: string[];
          title?: string;
        }): Promise<{ extract: { id: string } }>;
      };
    };
    const body = [
      "EXTRACT_TARGET_START",
      ...Array.from(
        { length: 120 },
        (_, i) =>
          `Nested large extract sentence ${i} with enough material to wrap through the extract editor viewport.`,
      ),
      "EXTRACT_TARGET_END",
    ].join(" ");
    const { extract } = await api.extractions.create({
      sourceElementId,
      selectedText: body,
      blockIds: ["blk_intro_p1"],
      title: "Large extract editor geometry target",
    });
    return extract.id;
  }, srcId);
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

async function latestChildExtractId(page: Page, parentId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { children: { id: string; type: string }[] } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id });
    return data?.children.filter((child) => child.type === "extract").at(-1)?.id ?? null;
  }, parentId);
}

async function sourceLocationText(page: Page, elementId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: { location: { selectedText: string } | null } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id });
    return data?.location?.selectedText ?? "";
  }, elementId);
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

async function selectVisibleLineInLateTarget(page: Page): Promise<string> {
  const point = await page.evaluate(async () => {
    const shell = document.querySelector<HTMLElement>(".shell-page");
    const reader = document.querySelector<HTMLElement>(".reader-page");
    const target = Array.from(
      document.querySelectorAll<HTMLElement>(".reader .ProseMirror p"),
    ).find((p) => p.textContent?.includes("LATE_TARGET_START"));
    if (!shell || !reader || !target) throw new Error("large-selection target missing");

    reader.scrollTop = target.offsetTop + Math.floor(target.offsetHeight * 0.55);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const targetRect = target.getBoundingClientRect();
    const readerRect = reader.getBoundingClientRect();
    const y = Math.min(
      window.innerHeight - 120,
      Math.max(readerRect.top + 120, targetRect.top + targetRect.height * 0.55),
    );
    const x = targetRect.left + Math.min(80, Math.max(24, targetRect.width * 0.15));
    return {
      x,
      y,
      shellTop: shell.scrollTop,
      paragraphTop: targetRect.top,
      paragraphBottom: targetRect.bottom,
      readerTop: reader.scrollTop,
    };
  });

  expect(point.shellTop).toBe(0);
  expect(point.readerTop).toBeGreaterThan(0);
  expect(point.paragraphTop).toBeLessThan(0);
  expect(point.paragraphBottom).toBeGreaterThan(point.y);

  await page.mouse.click(point.x, point.y, { clickCount: 3 });
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function selectVisibleLineInExtractTarget(page: Page): Promise<string> {
  const point = await page.evaluate(async () => {
    const shell = document.querySelector<HTMLElement>(".shell-page");
    const reader = document.querySelector<HTMLElement>(".extract-editor .reader");
    const target = Array.from(
      document.querySelectorAll<HTMLElement>(".extract-editor .reader .ProseMirror p"),
    ).find((p) => p.textContent?.includes("EXTRACT_TARGET_START"));
    if (!shell || !reader || !target) throw new Error("large extract-editor target missing");

    reader.scrollTop = target.offsetTop + Math.floor(target.offsetHeight * 0.55);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const targetRect = target.getBoundingClientRect();
    const readerRect = reader.getBoundingClientRect();
    const y = Math.min(
      window.innerHeight - 120,
      Math.max(readerRect.top + 120, targetRect.top + targetRect.height * 0.55),
    );
    const x = targetRect.left + Math.min(80, Math.max(24, targetRect.width * 0.15));
    return {
      x,
      y,
      shellTop: shell.scrollTop,
      paragraphTop: targetRect.top,
      paragraphBottom: targetRect.bottom,
      readerTop: reader.scrollTop,
    };
  });

  expect(point.shellTop).toBe(0);
  expect(point.readerTop).toBeGreaterThan(0);
  expect(point.paragraphTop).toBeLessThan(0);
  expect(point.paragraphBottom).toBeGreaterThan(point.y);

  await page.mouse.click(point.x, point.y, { clickCount: 3 });
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function firstVisibleSelectionRect(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) throw new Error("selection missing");
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const visibleArea = (rect: DOMRect) => {
      const visibleWidth = Math.max(
        0,
        Math.min(rect.right, viewport.width) - Math.max(rect.left, 0),
      );
      const visibleHeight = Math.max(
        0,
        Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0),
      );
      return visibleWidth * visibleHeight;
    };
    const rect =
      Array.from(selection.getRangeAt(0).getClientRects()).find(
        (candidate) => candidate.width > 0 && candidate.height > 0 && visibleArea(candidate) > 0,
      ) ?? selection.getRangeAt(0).getBoundingClientRect();
    const unionRect = selection.getRangeAt(0).getBoundingClientRect();
    return {
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
      centerX: rect.left + rect.width / 2,
      unionTop: unionRect.top,
    };
  });
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
  if (!sourceId) sourceId = await resolveSourceId(page);
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

test("a huge extract selection after internal reader scroll keeps the toolbar reachable", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const tallSourceId = await createTallLateParagraphSource(page);
  await openReader(page, tallSourceId);

  const extractsBefore = await extractCount(page);
  const selected = await selectVisibleLineInLateTarget(page);
  expect(selected).toContain("LATE_TARGET_START");
  expect(selected).toContain("LATE_TARGET_END");

  const toolbar = page.getByTestId("selection-toolbar");
  await expect(toolbar).toHaveCSS("position", "fixed");

  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('[data-testid="selection-toolbar"]');
    const shell = document.querySelector<HTMLElement>(".shell-page");
    if (!toolbar || !shell) throw new Error("toolbar/shell missing");
    const toolbarRect = toolbar.getBoundingClientRect();
    return {
      toolbar: {
        top: toolbarRect.top,
        bottom: toolbarRect.bottom,
        left: toolbarRect.left,
        right: toolbarRect.right,
        height: toolbarRect.height,
        centerX: toolbarRect.left + toolbarRect.width / 2,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shellTop: shell.scrollTop,
    };
  });
  const selectedRect = await firstVisibleSelectionRect(page);

  expect(geometry.shellTop).toBe(0);
  expect(selectedRect.unionTop).toBeLessThan(0);
  expect(geometry.toolbar.top).toBeGreaterThanOrEqual(0);
  expect(geometry.toolbar.left).toBeGreaterThanOrEqual(0);
  expect(geometry.toolbar.right).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.toolbar.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  if (selectedRect.top >= geometry.toolbar.height + 12) {
    expect(Math.abs(geometry.toolbar.bottom - selectedRect.top)).toBeLessThanOrEqual(16);
  }
  expect(Math.abs(geometry.toolbar.centerX - selectedRect.centerX)).toBeLessThanOrEqual(32);

  await page.getByTestId("sel-tool-extract").click();
  await expect(page.getByTestId("reader-flash")).toContainText("Extracted");
  await expect.poll(() => extractCount(page)).toBe(extractsBefore + 1);
  await expect(toolbar).toBeHidden();
  const newExtractId = await latestChildExtractId(page, tallSourceId);
  expect(newExtractId).toBeTruthy();
  const storedSelection = await sourceLocationText(page, newExtractId as string);
  expect(storedSelection).toContain("LATE_TARGET_START");
  expect(storedSelection).toContain("LATE_TARGET_END");

  await app.close();
});

test("a huge sub-extract selection after internal extract-editor scroll keeps the toolbar reachable", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  if (!sourceId) sourceId = await resolveSourceId(page);

  const tallExtractId = await createTallExtract(page, sourceId);
  await openExtract(page, tallExtractId);

  const extractsBefore = await extractCount(page);
  const selected = await selectVisibleLineInExtractTarget(page);
  expect(selected).toContain("EXTRACT_TARGET_START");
  expect(selected).toContain("EXTRACT_TARGET_END");

  const toolbar = page.getByTestId("selection-toolbar");
  await expect(toolbar).toHaveCSS("position", "fixed");

  const geometry = await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('[data-testid="selection-toolbar"]');
    const shell = document.querySelector<HTMLElement>(".shell-page");
    if (!toolbar || !shell) throw new Error("toolbar/shell missing");
    const toolbarRect = toolbar.getBoundingClientRect();
    return {
      toolbar: {
        top: toolbarRect.top,
        bottom: toolbarRect.bottom,
        left: toolbarRect.left,
        right: toolbarRect.right,
        height: toolbarRect.height,
        centerX: toolbarRect.left + toolbarRect.width / 2,
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shellTop: shell.scrollTop,
    };
  });
  const selectedRect = await firstVisibleSelectionRect(page);

  expect(geometry.shellTop).toBe(0);
  expect(selectedRect.unionTop).toBeLessThan(0);
  expect(geometry.toolbar.top).toBeGreaterThanOrEqual(0);
  expect(geometry.toolbar.left).toBeGreaterThanOrEqual(0);
  expect(geometry.toolbar.right).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.toolbar.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  if (selectedRect.top >= geometry.toolbar.height + 12) {
    expect(Math.abs(geometry.toolbar.bottom - selectedRect.top)).toBeLessThanOrEqual(16);
  }
  expect(Math.abs(geometry.toolbar.centerX - selectedRect.centerX)).toBeLessThanOrEqual(32);

  await page.getByTestId("sel-tool-extract").click();
  await expect(page.getByTestId("extract-flash")).toContainText("Sub-extract created");
  await expect.poll(() => extractCount(page)).toBe(extractsBefore + 1);
  await expect(toolbar).toBeHidden();
  const subExtractId = await latestChildExtractId(page, tallExtractId);
  expect(subExtractId).toBeTruthy();
  const storedSelection = await sourceLocationText(page, subExtractId as string);
  expect(storedSelection).toContain("EXTRACT_TARGET_START");
  expect(storedSelection).toContain("EXTRACT_TARGET_END");

  await app.close();
});

test("the H shortcut dispatches highlight without typing into the editable body", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  if (!sourceId) sourceId = await resolveSourceId(page);
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
  if (!sourceId) sourceId = await resolveSourceId(page);
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
