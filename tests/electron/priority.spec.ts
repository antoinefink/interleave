/**
 * Priority (A/B/C/D) E2E (T027) — drives the real Electron app.
 *
 * Priority is a first-class, EDITABLE axis on every element. This spec launches
 * the built desktop app against a fresh data dir seeded with the shared demo
 * collection, then exercises the universal priority write path THROUGH the
 * inspector's A/B/C/D control (which calls the typed `elements.setPriority`
 * command — `set` / `raise` / `lower`):
 *
 *   1. the `elements.setPriority` bridge command exists (no generic db.query);
 *   2. raising / lowering / setting works on a SOURCE, an EXTRACT, and a CARD —
 *      priority is universal across element types;
 *   3. the change surfaces immediately as the A/B/C/D `Prio` badge + the Priority
 *      meta row, with no reload;
 *   4. it SURVIVES AN APP RESTART (the numeric value persisted to SQLite).
 *
 * The seed gives the source / top extract / Q&A card priority A and the cloze
 * card priority B, so we lower the A items by one band and raise the B card.
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
 * Select a seeded element from the inspector's picker by its (unique) title. The
 * picker only renders when nothing is selected, so clear any existing selection
 * first (so the helper can be called repeatedly within one page session).
 */
async function selectByTitle(page: Page, title: string) {
  const clear = page.getByTestId("inspector-clear");
  if (await clear.isVisible()) {
    await clear.click();
  }
  const item = page.getByTestId("element-picker-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.getByTestId("inspector-content")).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toHaveText(title);
}

/** The A/B/C/D label currently shown in the inspector's Priority meta row. */
async function currentLabel(page: Page): Promise<string> {
  const text = await page.getByTestId("meta-priority").innerText();
  return text.trim().charAt(0);
}

test("the priority control writes through elements.setPriority (no raw SQL)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      elements?: { setPriority?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSetPriority: typeof api?.elements?.setPriority === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSetPriority).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("lowering a SOURCE one band updates the badge in place (A → B)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "On the Measure of Intelligence");
  // Seeded at A.
  expect(await currentLabel(page)).toBe("A");

  await page.getByTestId("inspector-priority-lower").click();
  // The Prio badge + meta row reflect the new band without a reload.
  await expect(page.getByTestId("meta-priority")).toContainText("B");
  expect(await currentLabel(page)).toBe("B");

  await app.close();
});

test("setting an EXTRACT to an explicit label works (A → C)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "Intelligence = skill-acquisition efficiency");
  expect(await currentLabel(page)).toBe("A");

  // Click the explicit "C" chip in the segmented control.
  await page.getByTestId("inspector-priority-C").click();
  await expect(page.getByTestId("meta-priority")).toContainText("C");
  expect(await currentLabel(page)).toBe("C");

  await app.close();
});

test("raising a CARD one band works — priority is universal (B → A)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "Intelligence definition (cloze)");
  // The cloze card is seeded at B.
  const content = page.getByTestId("inspector-content");
  await expect(content).toHaveAttribute("data-element-type", "card");
  expect(await currentLabel(page)).toBe("B");

  await page.getByTestId("inspector-priority-raise").click();
  await expect(page.getByTestId("meta-priority")).toContainText("A");
  expect(await currentLabel(page)).toBe("A");

  await app.close();
});

test("raise is a no-op at A and lower is a no-op at D (clamps)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The cloze card was raised to A in the previous test (serial mode).
  await selectByTitle(page, "Intelligence definition (cloze)");
  expect(await currentLabel(page)).toBe("A");
  // The raise stepper is disabled at the top band.
  await expect(page.getByTestId("inspector-priority-raise")).toBeDisabled();

  // Drop it to D via the explicit chip, then assert lower is disabled.
  await page.getByTestId("inspector-priority-D").click();
  await expect(page.getByTestId("meta-priority")).toContainText("D");
  await expect(page.getByTestId("inspector-priority-lower")).toBeDisabled();

  await app.close();
});

test("priority changes survive an app restart (persisted to SQLite)", async () => {
  // Re-launch against the SAME data dir — the restart analogue. The earlier
  // serial tests left: source = B, extract = C, cloze card = D.
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "On the Measure of Intelligence");
  expect(await currentLabel(page)).toBe("B");

  await selectByTitle(page, "Intelligence = skill-acquisition efficiency");
  expect(await currentLabel(page)).toBe("C");

  await selectByTitle(page, "Intelligence definition (cloze)");
  expect(await currentLabel(page)).toBe("D");

  await app.close();
});

/**
 * Layout regression (hardening): the inspector priority editor (A/B/C/D segment +
 * raise/lower steppers) lives in the fixed-width (296px) inspector `meta-val` cell.
 * It must WRAP, not clip — every band button (especially the last, "D") and both
 * steppers must lie fully inside the inspector body's CONTENT box (the body box
 * minus its horizontal padding). Before the fix the un-wrapped flex row pushed the
 * "D" button + lower stepper past the panel edge (clipped). These bounding-box
 * assertions are the durable proof the editor never overflows the fixed width.
 */
test("the priority editor fits fully inside the fixed-width inspector (no clip) (layout)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await selectByTitle(page, "On the Measure of Intelligence");
  const editor = page.getByTestId("inspector-priority");
  await expect(editor).toBeVisible();

  /**
   * Assert the editor never clips: it does not overflow its own box AND every
   * interactive control (both steppers + all four bands, especially "D") sits
   * fully inside the inspector body's CONTENT box (body box inset by its computed
   * L/R padding). Re-used at the default 296px AND at a forced narrower width.
   */
  const assertNoClip = async (label: string) => {
    // The editor's own scroll width must not exceed its client width (it wraps
    // within its cell rather than overflowing/clipping it).
    const editorOverflow = await editor.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    expect(editorOverflow.scrollWidth, `${label}: editor does not overflow`).toBeLessThanOrEqual(
      editorOverflow.clientWidth,
    );

    // The inspector body content box = body box inset by its computed L/R padding.
    const body = page.locator(".shell-inspector__body");
    const bodyBox = await body.boundingBox();
    const pad = await body.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { left: parseFloat(cs.paddingLeft), right: parseFloat(cs.paddingRight) };
    });
    if (!bodyBox) throw new Error("expected inspector body box");
    const contentLeft = bodyBox.x + pad.left;
    const contentRight = bodyBox.x + bodyBox.width - pad.right;

    const eps = 0.5;
    const controls = [
      "inspector-priority-raise",
      "inspector-priority-lower",
      "inspector-priority-A",
      "inspector-priority-B",
      "inspector-priority-C",
      "inspector-priority-D",
    ];
    for (const testId of controls) {
      const box = await page.getByTestId(testId).boundingBox();
      if (!box) throw new Error(`expected box for ${testId}`);
      expect(box.x, `${label}: ${testId} left edge inside content box`).toBeGreaterThanOrEqual(
        contentLeft - eps,
      );
      expect(
        box.x + box.width,
        `${label}: ${testId} right edge inside content box`,
      ).toBeLessThanOrEqual(contentRight + eps);
    }
  };

  // 1) At the canonical fixed 296px inspector width.
  await assertNoClip("296px");

  // 2) At a FORCED narrower width (the safety net `.prio-edit{flex-wrap:wrap}` must
  // keep the control from clipping even when the panel is squeezed / under a larger
  // font scale). Shrink the inspector shell and re-assert — every band incl. "D" and
  // both steppers stay inside the (now narrower) body content box, with the editor
  // wrapping onto extra rows rather than overflowing.
  await page.locator(".shell-inspector").evaluate((el) => {
    (el as HTMLElement).style.width = "230px";
  });
  // The control reflows; wait for the body to reflect the narrower width.
  await expect
    .poll(async () => {
      const box = await page.locator(".shell-inspector__body").boundingBox();
      return box ? Math.round(box.width) : 0;
    })
    .toBeLessThan(280);
  await assertNoClip("narrow");

  await app.close();
});

/**
 * Layout regression (hardening, sibling of the priority clip): the FSRS three-stat
 * readout (`.fsrs-stats` = `repeat(3,1fr)`) lives in the same fixed-width (296px)
 * inspector. The un-wrappable single-word "Retrievability" label of the 3rd stat
 * used to widen the grid past the panel and clip at the edge. The `.fstat{min-width:0}`
 * + ellipsized `.fstat__l` fix keeps all three stats inside the body content box.
 * These bounding-box assertions guard the FSRS readout the same way.
 */
test("the FSRS stat readout fits fully inside the fixed-width inspector (no clip) (layout)", async () => {
  const app = await launchApp(dataDir);
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The seeded Q&A card has a review state, so it surfaces the FSRS (recall)
  // scheduler + the three-stat readout (Stability / Difficulty / Retrievability).
  await selectByTitle(page, "Chollet's definition of intelligence");
  const stats = page.getByTestId("fsrs-stats");
  await expect(stats).toBeVisible();

  // The grid never overflows its own box (the long label ellipsizes instead of
  // forcing the track wider than the panel).
  const statsOverflow = await stats.evaluate((el) => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  expect(statsOverflow.scrollWidth).toBeLessThanOrEqual(statsOverflow.clientWidth);

  // The inspector body content box = body box inset by its computed L/R padding.
  const body = page.locator(".shell-inspector__body");
  const bodyBox = await body.boundingBox();
  const pad = await body.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { right: parseFloat(cs.paddingRight) };
  });
  if (!bodyBox) throw new Error("expected inspector body box");
  const contentRight = bodyBox.x + bodyBox.width - pad.right;

  // The 3rd (rightmost) stat — "Retrievability" — must lie fully inside the panel.
  const eps = 0.5;
  const thirdStat = stats.locator(".fstat").nth(2);
  const box = await thirdStat.boundingBox();
  if (!box) throw new Error("expected box for the 3rd FSRS stat");
  expect(box.x + box.width, "3rd FSRS stat right edge inside content box").toBeLessThanOrEqual(
    contentRight + eps,
  );

  await app.close();
});
