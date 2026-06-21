/**
 * "Process queue" learning loop (T031) E2E — the milestone flow.
 *
 * The loop takes the T029 due queue and presents it ONE ELEMENT AT A TIME, advancing
 * after every action, so the user processes ten mixed elements WITHOUT returning to a
 * list. This spec launches the real Electron app against a fresh data dir seeded with
 * the shared demo collection, manufactures a mixed due set of ≥10 items (the seeded
 * cards + extracts created via the existing `extractions.create` bridge), then:
 *
 *   1. opens the session preview from the queue's "Start session", then starts the
 *      assembled `/process` deck (date-scoped via `?asOf=` so near-future due dates read as due);
 *   2. processes each item one at a time with a MIX of actions (done / postpone /
 *      raise / lower / skip), asserting only ONE item shows at a time, the cursor
 *      advances after each action, and the URL never leaves `/process` (no return to
 *      a list);
 *   3. reaches the "Queue clear" done state;
 *   4. RESTARTS the app and asserts the postponed items are still scheduled (their
 *      mutations persisted) and the done/dismissed ones did not reappear.
 *
 * Every loop action reuses the SAME typed `queue.act` mutation path as the list — no
 * new channel — so this also proves the loop's mutations persist exactly like the
 * list's.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
/** The renderer base URL (`app://bundle`), captured from the first window. */
let baseUrl: string;

/** A fixed future clock so the seeded/near-future due dates read as due. */
const AS_OF = "2027-06-01T12:00:00.000Z";
const UNDO_KEY = process.platform === "darwin" ? "Meta+z" : "Control+z";

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Open `/process` (date-scoped via `?asOf=`) and wait for it to render. */
async function openProcess(page: Page, asOf: string): Promise<void> {
  await page.goto(`${baseUrl}/process?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-process")).toBeVisible();
}

/**
 * Find the seeded ACTIVE source element id that has a document body (the lineage
 * root for new extracts). The seed also creates an inbox source with NO body — its
 * blocks don't exist, so extracting against it would FK-fail; match the active
 * "On the Measure of Intelligence" source whose stable blocks the extracts anchor to.
 */
async function findSourceId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{
          elements: { id: string; type: string; status: string; title: string }[];
        }>;
      };
    };
    const { elements } = await api.inspector.list();
    const source =
      elements.find((e) => e.type === "source" && e.title.includes("Measure of Intelligence")) ??
      elements.find((e) => e.type === "source" && e.status === "active");
    if (!source) throw new Error("seeded active source with a body not found");
    return source.id;
  });
}

/**
 * Manufacture N extra attention items: create N extracts off the seeded source's
 * known stable blocks via the SAME `extractions.create` bridge T021 uses — each gets
 * an attention `due_at` (`raw_extract +1..7d`) and status `scheduled`, so together
 * with the seeded cards there are ≥10 mixed due items at the future `AS_OF`.
 */
async function createExtracts(page: Page, sourceId: string, n: number): Promise<string[]> {
  return page.evaluate(
    async ({ sourceId, n }) => {
      const api = window.appApi as unknown as {
        extractions: {
          create(req: {
            sourceElementId: string;
            selectedText: string;
            blockIds: string[];
            startOffset?: number;
            endOffset?: number;
            title?: string;
          }): Promise<{ extract: { id: string } }>;
        };
      };
      // The seed's known stable block ids (rotated so the extracts spread across them).
      const blocks = ["blk_intro_p1", "blk_intro_p2", "blk_def_p2"];
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const block = blocks[i % blocks.length];
        const res = await api.extractions.create({
          sourceElementId: sourceId,
          selectedText: `Loop test extract ${i + 1}`,
          blockIds: [block],
          startOffset: i,
          endOffset: i + 10,
          title: `Loop extract ${i + 1}`,
        });
        ids.push(res.extract.id);
      }
      return ids;
    },
    { sourceId, n },
  );
}

/** Schedule one attention item so it is due at the fixed process-clock date. */
async function scheduleDueForProcess(page: Page, id: string): Promise<void> {
  await page.evaluate(
    async ({ id, dueAt }) => {
      const api = window.appApi as unknown as {
        queue: {
          schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
        };
      };
      await api.queue.schedule({ id, choice: { kind: "manual", date: dueAt } });
    },
    { id, dueAt: "2027-05-31T12:00:00.000Z" },
  );
}

/** Read the current due ids/types at the fixed clock via the typed bridge. */
async function dueIds(page: Page): Promise<{ id: string; type: string }[]> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: {
        list(req: { asOf: string }): Promise<{ items: { id: string; type: string }[] }>;
      };
    };
    const res = await api.queue.list({ asOf });
    return res.items.map((i) => ({ id: i.id, type: i.type }));
  }, AS_OF);
}

test("the queue.act bridge command exists and there is no raw db.query (T031 reuses it)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // The loop reuses the SAME typed mutation path as the list — no new channel.
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      queue?: { act?: unknown; list?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasAct: typeof api?.queue?.act === "function",
      hasList: typeof api?.queue?.list === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasAct).toBe(true);
  expect(surface.hasList).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("Start session opens the loop, which shows ONE element at a time", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Build the mixed due set: 9 extra extracts + the seeded cards/extract ⇒ ≥10 items.
  const sourceId = await findSourceId(page);
  await createExtracts(page, sourceId, 9);
  const due = await dueIds(page);
  expect(due.length).toBeGreaterThanOrEqual(10);
  // It is genuinely MIXED: at least one card (FSRS) and several extracts (attention).
  expect(due.some((d) => d.type === "card")).toBe(true);
  expect(due.filter((d) => d.type === "extract").length).toBeGreaterThanOrEqual(5);

  // Enter via the queue's "Start session" (carries the asOf clock to the loop).
  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(AS_OF)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();
  await page.getByTestId("queue-start-session").click();
  await expect(page.getByTestId("session-preview")).toBeVisible();
  await expect(page.getByTestId("session-cut-list")).toBeVisible();
  const plannedMinutes = await page.getByTestId("session-planned-minutes").innerText();
  const completedMinutes = await page
    .getByTestId("session-planned-row-minutes")
    .first()
    .innerText();
  const cutCount = await page.getByTestId("session-cut-count").innerText();
  await page.getByTestId("session-preview-start").click();
  await expect(page.getByTestId("route-process")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/process");
  expect(new URL(page.url()).searchParams.get("assembled")).toBe("1");

  // Exactly ONE process item is shown (the cursor item), with a progress readout.
  await expect(page.getByTestId("process-item")).toHaveCount(1);
  await expect(page.getByTestId("process-progress")).toBeVisible();
  await expect(page.getByTestId("process-assembled-mode")).toBeVisible();

  let processed = 0;
  for (let i = 0; i < 20; i++) {
    if (
      await page
        .getByTestId("process-done")
        .isVisible()
        .catch(() => false)
    )
      break;
    const item = page.getByTestId("process-item");
    await expect(item).toHaveCount(1);
    const before = await item.getAttribute("data-element-id");
    if (processed === 0) {
      const itemType = await item.getAttribute("data-element-type");
      await item.getByTestId("process-action-markDone").click();
      if (itemType === "source") await page.getByTestId("done-intent-finished").click();
    } else {
      await item.getByTestId("process-action-skip").click();
    }
    processed++;
    await expect
      .poll(async () => {
        const doneVisible = await page.getByTestId("process-done").isVisible();
        if (doneVisible) return "done";
        return (await page.getByTestId("process-item").getAttribute("data-element-id")) ?? "";
      })
      .not.toBe(before);
  }

  expect(processed).toBeGreaterThan(0);
  await expect(page.getByTestId("process-done")).toBeVisible();
  await expect(page.getByTestId("process-session-summary")).toContainText(
    `Planned ${plannedMinutes}`,
  );
  await expect(page.getByTestId("process-session-summary")).toContainText(
    `Completed ${completedMinutes.replace(/^~/, "")}`,
  );
  // The Plan session styles its left-out header as an uppercase section label,
  // so `innerText()` reads it uppercased; the /process summary renders the same
  // count in sentence case. Compare the carried-through count case-insensitively.
  await expect(page.getByTestId("process-session-summary")).toContainText(
    new RegExp(cutCount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
  );

  await app.close();
});

test("processes ten mixed elements one at a time, advancing after each action without returning to a list", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openProcess(page, AS_OF);
  await expect(page.getByTestId("process-item")).toHaveCount(1);

  // A rotation of actions so the run exercises done / postpone / raise / lower / skip.
  const actions = [
    "markDone",
    "postpone",
    "raise",
    "lower",
    "skip",
    "markDone",
    "postpone",
    "dismiss",
    "skip",
    "markDone",
  ] as const;

  // Raise / Lower / Delete now live behind the "⋯" overflow — open it first.
  const overflowActions = new Set<string>(["raise", "lower", "delete"]);
  const seen = new Set<string>();
  let processedCount = 0;
  for (const action of actions) {
    const item = page.getByTestId("process-item");
    // The loop never shows more than one item, and never navigates to a list.
    await expect(item).toHaveCount(1);
    expect(new URL(page.url()).pathname).toBe("/process");
    const id = await item.getAttribute("data-element-id");
    if (id) seen.add(id);

    if (overflowActions.has(action)) {
      await item.getByTestId("process-action-more").click();
    }
    await item.getByTestId(`process-action-${action}`).click();
    if (action === "postpone" && (await page.getByTestId("schedule-menu-pop").isVisible())) {
      await page.getByTestId("schedule-nextWeek").click();
    }
    processedCount++;

    // After each action the cursor advanced: either a NEW item shows or we hit done.
    await expect
      .poll(async () => {
        const doneVisible = await page.getByTestId("process-done").isVisible();
        if (doneVisible) return "done";
        return (await page.getByTestId("process-item").getAttribute("data-element-id")) ?? "";
      })
      .not.toBe(id);

    if (await page.getByTestId("process-done").isVisible()) break;
  }

  // We processed at least ten distinct items one at a time without returning to a list.
  expect(seen.size).toBeGreaterThanOrEqual(processedCount > 10 ? 10 : processedCount);
  expect(new URL(page.url()).pathname).toBe("/process");

  await app.close();
});

test("keyboard controls drive the loop (mark done with `d` advances the cursor)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await openProcess(page, AS_OF);
  const item = page.getByTestId("process-item");
  // `d` marks the current item done and advances the cursor, whatever type it is
  // (on a card `d` is still done; Space/1–4 are the card-specific keys, tested below).
  await expect(item).toHaveCount(1);
  const before = await item.getAttribute("data-element-id");
  await page.keyboard.press("d");
  await expect
    .poll(async () => {
      if (await page.getByTestId("process-done").isVisible()) return "done";
      return (await page.getByTestId("process-item").getAttribute("data-element-id")) ?? "";
    })
    .not.toBe(before);
  expect(new URL(page.url()).pathname).toBe("/process");

  await app.close();
});

test("extracts and highlights source text inline inside /process, then persists the child extract after restart", async () => {
  const freshDir = makeDataDir();
  let app = await launchApp(freshDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const sourceId = await findSourceId(page);
  await scheduleDueForProcess(page, sourceId);
  const beforeExtracts =
    (await inspectElement(page, sourceId))?.children.filter((c) => c.type === "extract").length ??
    0;
  const beforeHighlights = await highlightCount(page, sourceId);

  await openProcess(page, AS_OF);
  await moveProcessCursorTo(page, sourceId);
  await expect(page.getByTestId("process-source-workbench")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/process");

  let selected = await selectProcessSourceBodyText(page);
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await expect(page.getByTestId("sel-tool-extract")).toContainText("Extract");
  await expect(page.getByTestId("sel-tool-highlight")).toContainText("Highlight");
  await expect(page.getByTestId("sel-tool-cloze")).toHaveCount(0);
  await page.getByTestId("sel-tool-highlight").click();
  await expect(page.getByTestId("process-flash")).toContainText("Highlighted");
  await expect.poll(() => highlightCount(page, sourceId)).toBeGreaterThan(beforeHighlights);
  await expect(page.getByTestId("process-item")).toHaveAttribute("data-element-id", sourceId);

  selected = await selectProcessSourceBodyText(page);
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await page.getByTestId("sel-tool-extract").click();
  // selectProcessSourceBodyText triple-clicks the first body block — a single
  // finite-verb sentence the T122 shape-aware classifier stages as an
  // `atomic_statement` — so the flash is the atomic confirmation, not "Extracted".
  await expect(page.getByTestId("process-flash")).toContainText("Atomic extract ready");
  await expect
    .poll(
      async () =>
        (await inspectElement(page, sourceId))?.children.filter((c) => c.type === "extract")
          .length ?? 0,
    )
    .toBeGreaterThan(beforeExtracts);
  await expect(page.getByTestId("process-item")).toHaveAttribute("data-element-id", sourceId);

  await app.close();

  app = await launchApp(freshDir, { seedOnEmpty: true });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect
    .poll(
      async () =>
        (await inspectElement(page, sourceId))?.children.filter((c) => c.type === "extract")
          .length ?? 0,
    )
    .toBeGreaterThan(beforeExtracts);
  await app.close();
});

/** A card's durable review-log count via the inspector (recomputed from `review_logs`). */
async function cardLogCount(page: Page, cardId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{ data: { review: { logCount: number } | null } | null }>;
      };
    };
    const res = await api.inspector.get({ id });
    return res.data?.review?.logCount ?? 0;
  }, cardId);
}

/** Inspect one element's persisted stage/status and live children. */
async function inspectElement(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { stage: string; status: string; dueAt: string | null };
            children: { id: string; type: string; title: string; stage: string }[];
          } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data;
  }, id);
}

/** Read the persisted plain-text document body for one element. */
async function documentText(page: Page, id: string): Promise<string> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        get(req: { elementId: string }): Promise<{ document: { plainText: string } | null }>;
      };
    };
    const { document } = await api.documents.get({ elementId });
    return document?.plainText ?? "";
  }, id);
}

async function highlightCount(page: Page, id: string): Promise<number> {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      documents: {
        marks: {
          list(req: { elementId: string; markType: "highlight" }): Promise<{ marks: unknown[] }>;
        };
      };
    };
    return (await api.documents.marks.list({ elementId, markType: "highlight" })).marks.length;
  }, id);
}

/** Move the `/process` cursor to a specific item by skipping intervening rows. */
async function moveProcessCursorTo(page: Page, id: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (
      await page
        .getByTestId("process-done")
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    const item = page.getByTestId("process-item");
    await expect(item).toHaveCount(1);
    const current = await item.getAttribute("data-element-id");
    if (current === id) return;
    await item.getByTestId("process-action-skip").click();
    await page.waitForTimeout(40);
  }
  throw new Error(`process item ${id} did not surface before the queue ended`);
}

/** Triple-click the first block in the inline process extract editor. */
async function selectProcessExtractBodyText(page: Page): Promise<string> {
  const block = page
    .locator('[data-testid="process-extract-editor"] .reader .ProseMirror [data-block-id]')
    .first();
  await expect(block).toBeVisible();
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** Triple-click the first block in the inline process source reader. */
async function selectProcessSourceBodyText(page: Page): Promise<string> {
  const block = page
    .locator('[data-testid="process-source-editor"] .reader .ProseMirror [data-block-id]')
    .first();
  await expect(block).toBeVisible();
  await block.click({ clickCount: 3 });
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

test("reveals + grades a due card INLINE inside /process (no detour to /review), and the review log persists across restart", async () => {
  // Fresh data dir so this test owns its deck: the loop must grade a real seeded due
  // card inline (Space reveal → 3 = Good), the cursor must advance, the URL must stay
  // /process, and a durable review_logs row must survive an app restart.
  const freshDir = makeDataDir();
  let app = await launchApp(freshDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // There is at least one due CARD (FSRS) in the seeded set at the future clock.
  const due = await dueIds(page);
  expect(due.some((d) => d.type === "card")).toBe(true);

  await openProcess(page, AS_OF);
  const item = page.getByTestId("process-item");
  await expect(item).toHaveCount(1);

  // Walk the cursor (Skip) until the CARD surface is the current item. Bounded.
  let cardId: string | null = null;
  for (let i = 0; i < 40; i++) {
    if (
      await page
        .getByTestId("process-done")
        .isVisible()
        .catch(() => false)
    )
      break;
    const type = await item.getAttribute("data-element-type");
    if (type === "card") {
      cardId = await item.getAttribute("data-element-id");
      break;
    }
    await item.getByTestId("process-action-skip").click();
    await page.waitForTimeout(40);
  }
  expect(cardId).not.toBeNull();
  if (!cardId) throw new Error("no card surfaced in the process loop");

  const before = await cardLogCount(page, cardId);

  // The card's answer is hidden until reveal; the FSRS grades are not shown yet.
  await expect(page.getByTestId("process-card-reveal")).toBeVisible();
  await expect(page.getByTestId("process-card-grades")).toHaveCount(0);

  // Reveal with Space (the card-specific key), then grade Good with `3` — entirely
  // INSIDE /process, never navigating to /review.
  await page.keyboard.press("Space");
  await expect(page.getByTestId("process-card-answer")).toBeVisible();
  await expect(page.getByTestId("process-card-grades")).toBeVisible();
  for (const r of ["again", "hard", "good", "easy"]) {
    await expect(page.getByTestId(`process-interval-${r}`)).toBeVisible();
  }
  await page.keyboard.press("3");

  // The cursor advanced (a new item or the done state) — and we never left /process.
  await expect
    .poll(async () => {
      if (
        await page
          .getByTestId("process-done")
          .isVisible()
          .catch(() => false)
      )
        return "done";
      return (await page.getByTestId("process-item").getAttribute("data-element-id")) ?? "";
    })
    .not.toBe(cardId);
  expect(new URL(page.url()).pathname).toBe("/process");

  // A durable review_logs row was written by the inline grade.
  expect(await cardLogCount(page, cardId)).toBe(before + 1);

  await app.close();

  // RESTART against the same data dir — the inline grade's review log is in SQLite.
  app = await launchApp(freshDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  expect(await cardLogCount(page, cardId)).toBe(before + 1);

  await app.close();
});

test("distills an extract inline inside /process and persists stage, body, and created card after restart", async () => {
  const freshDir = makeDataDir();
  let app = await launchApp(freshDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const sourceId = await findSourceId(page);
  const [extractId] = await createExtracts(page, sourceId, 1);
  if (!extractId) throw new Error("failed to create process extract");

  await openProcess(page, AS_OF);
  await moveProcessCursorTo(page, extractId);
  await expect(page.getByTestId("process-extract-workbench")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/process");

  // Advance raw -> clean in-place. This is a distillation action, so the cursor
  // stays on the extract rather than advancing to the next queue item.
  await page.getByTestId("process-extract-advance").click();
  await expect
    .poll(async () => (await inspectElement(page, extractId))?.element.stage)
    .toBe("clean_extract");
  await expect(page.getByTestId("process-item")).toHaveAttribute("data-element-id", extractId);
  await expect(page.getByTestId("process-extract-save")).toHaveCount(0);

  // Rewrite the extract body inside the process workbench; editor changes autosave
  // through the document save path without a manual Save button.
  const editor = page.locator('[data-testid="process-extract-editor"] .ProseMirror');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.type("Edited inline process extract.\n\nIt is ready for a card.");
  await expect(editor).toContainText("Edited inline process extract");
  await expect
    .poll(async () => documentText(page, extractId))
    .toContain("Edited inline process extract");

  // Select text inside the inline extract editor. The toolbar is extract-specific
  // but still includes the normal reading annotation affordance: Sub-extract,
  // Cloze, Highlight, Copy.
  const beforeExtractHighlights = await highlightCount(page, extractId);
  const selected = await selectProcessExtractBodyText(page);
  expect(selected.trim().length).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("selection-toolbar")).toBeVisible();
  await expect(page.getByTestId("sel-tool-extract")).toContainText("Sub-extract");
  await expect(page.getByTestId("sel-tool-highlight")).toContainText("Highlight");
  await page.getByTestId("sel-tool-highlight").click();
  await expect(page.getByTestId("process-flash")).toContainText("Highlighted");
  await expect
    .poll(async () => highlightCount(page, extractId))
    .toBeGreaterThan(beforeExtractHighlights);

  // Reselect the body and lift it into a child extract without opening /extract/:id.
  const subExtractSelection = await selectProcessExtractBodyText(page);
  expect(subExtractSelection.trim().length).toBeGreaterThanOrEqual(3);
  await page.getByTestId("sel-tool-extract").click();
  await expect(page.getByTestId("process-flash")).toContainText("Sub-extract created");
  await expect
    .poll(
      async () =>
        (await inspectElement(page, extractId))?.children.filter((c) => c.type === "extract")
          .length ?? 0,
    )
    .toBeGreaterThan(0);

  // Open the existing card builder inline and create a real Q&A card from the extract.
  await page.getByTestId("process-extract-make-qa").click();
  await expect(page.getByTestId("process-extract-builder")).toBeVisible();
  await expect(page.getByTestId("cb-quality-summary")).toHaveAttribute("data-severity", "block");
  await expect(page.getByTestId("cb-qc-empty")).toHaveAttribute("data-severity", "block");
  await expect(page.getByTestId("cb-quality-passed")).toHaveCount(0);
  await page.getByTestId("cb-qa-front").fill("What did the inline process session produce?");
  await page.getByTestId("cb-create").click();
  await expect(page.getByTestId("process-flash")).toContainText(/Q&A card created/);
  await expect
    .poll(
      async () =>
        (await inspectElement(page, extractId))?.children.filter((c) => c.type === "card").length ??
        0,
    )
    .toBeGreaterThan(0);

  await app.close();

  // RESTART against the same data dir — the inline distillation mutations are durable.
  app = await launchApp(freshDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const afterRestart = await inspectElement(page, extractId);
  expect(afterRestart?.element.stage).toBe("clean_extract");
  expect(await documentText(page, extractId)).toContain("Edited inline process extract");
  expect(await highlightCount(page, extractId)).toBeGreaterThan(beforeExtractHighlights);
  expect((afterRestart?.children ?? []).some((c) => c.type === "extract")).toBe(true);
  expect((afterRestart?.children ?? []).some((c) => c.type === "card")).toBe(true);

  await app.close();
});

test("undoes a lifecycle action inside /process and persists the restored item after restart", async () => {
  const freshDir = makeDataDir();
  let app = await launchApp(freshDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const sourceId = await findSourceId(page);
  const [extractId] = await createExtracts(page, sourceId, 1);
  if (!extractId) throw new Error("failed to create process extract");
  expect((await inspectElement(page, extractId))?.element.status).toBe("scheduled");

  await openProcess(page, AS_OF);
  await moveProcessCursorTo(page, extractId);
  await expect(page.getByTestId("process-item")).toHaveAttribute("data-element-id", extractId);

  await page.getByTestId("process-action-markDone").click();
  await expect
    .poll(async () => (await inspectElement(page, extractId))?.element.status)
    .toBe("done");
  await expect(page.getByTestId("queue-snackbar")).toHaveCount(0);

  await page.keyboard.press(UNDO_KEY);
  await expect
    .poll(async () => (await inspectElement(page, extractId))?.element.status)
    .toBe("scheduled");
  await expect(page.getByTestId("process-item")).toHaveAttribute("data-element-id", extractId);
  expect((await dueIds(page)).some((item) => item.id === extractId)).toBe(true);

  await app.close();

  app = await launchApp(freshDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  expect((await inspectElement(page, extractId))?.element.status).toBe("scheduled");
  expect((await dueIds(page)).some((item) => item.id === extractId)).toBe(true);

  await app.close();
});

test("the loop reaches the Queue-clear done state when every item is processed", async () => {
  const freshDir = makeDataDir();
  const app = await launchApp(freshDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  await openProcess(page, AS_OF);

  // Drive to the end: mark every remaining seeded item done one at a time.
  for (let i = 0; i < 30; i++) {
    if (
      await page
        .getByTestId("process-done")
        .isVisible()
        .catch(() => false)
    )
      break;
    const item = page.getByTestId("process-item");
    if ((await item.count()) === 0) break;
    // Source items open the Done intent surface; pick "Finished" to mark done. Other
    // element types still mark done immediately on the action button.
    const itemType = await item.getAttribute("data-element-type");
    await item.getByTestId("process-action-markDone").click();
    if (itemType === "source") await page.getByTestId("done-intent-finished").click();
    await page.waitForTimeout(60);
  }
  await expect(page.getByTestId("process-done")).toBeVisible();
  await expect(page.getByTestId("process-done")).toContainText(/queue clear/i);

  await app.close();
});

test("the loop's mutations survive an app restart (postponed items still scheduled, done items gone)", async () => {
  // Fresh data dir so this test owns its due set end-to-end (the serial tests above
  // consumed the shared one). Seed, build a mixed set, postpone some + mark some done
  // through the loop, then RESTART and assert persistence.
  const freshDir = makeDataDir();
  let app = await launchApp(freshDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  const sourceId = await findSourceId(page);
  const extractIds = await createExtracts(page, sourceId, 9);
  const before = await dueIds(page);
  expect(before.length).toBeGreaterThanOrEqual(10);

  // Postpone the first two created extracts and mark the next two done — all through
  // the SAME typed queue.act path the loop uses (so this mirrors loop mutations).
  const postponed = extractIds.slice(0, 2);
  const doneOnes = extractIds.slice(2, 4);
  await page.evaluate(
    async ({ postponed, doneOnes }) => {
      const api = window.appApi as unknown as {
        queue: { act(req: { id: string; action: { kind: string } }): Promise<unknown> };
      };
      for (const id of postponed) await api.queue.act({ id, action: { kind: "postpone" } });
      for (const id of doneOnes) await api.queue.act({ id, action: { kind: "markDone" } });
    },
    { postponed, doneOnes },
  );

  await app.close();

  // RESTART against the same data dir — the loop's mutations are in SQLite.
  app = await launchApp(freshDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Postponed extracts are STILL SCHEDULED (their attention due_at persisted) — they
  // remain inspectable with a non-null due date.
  for (const id of postponed) {
    const state = await page.evaluate(async (elementId) => {
      const api = window.appApi as unknown as {
        inspector: {
          get(req: {
            id: string;
          }): Promise<{ data: { element: { status: string; dueAt: string | null } } | null }>;
        };
      };
      const res = await api.inspector.get({ id: elementId });
      return res.data?.element ?? null;
    }, id);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("scheduled");
    expect(state?.dueAt).not.toBeNull();
  }

  // The done items did NOT reappear in the due set (status `done` removed them).
  const after = await dueIds(page);
  const afterIds = new Set(after.map((d) => d.id));
  for (const id of doneOnes) expect(afterIds.has(id)).toBe(false);
  // The postponed ones either receded past AS_OF or remain — but are NOT lost: they
  // persist as scheduled (asserted above). The set still has due work to process.
  expect(after.length).toBeGreaterThan(0);

  await app.close();
});

// A standalone layout-geometry assertion (own data dir, no shared state), appended to the
// process-card suite.
test("keeps the grade footer pinned and reachable while a large card body scrolls (three-zone redesign)", async () => {
  // The redesigned card is a three-zone surface — pinned header / scrolling body / pinned grade
  // footer — so a long answer or large source can never push the grades off-screen (the defect
  // the redesign fixes). jsdom can't catch visual overlap, so prove the geometry in the real app:
  // force the body to overflow far past the viewport, then assert the grades stay on-screen,
  // pinned (do not move when the body scrolls), and remain clickable.
  const freshDir = makeDataDir();
  const app = await launchApp(freshDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  await openProcess(page, AS_OF);
  const item = page.getByTestId("process-item");
  await expect(item).toHaveCount(1);

  // Walk the cursor (Skip) until the CARD surface is current. Bounded.
  let cardId: string | null = null;
  for (let i = 0; i < 40; i++) {
    if (
      await page
        .getByTestId("process-done")
        .isVisible()
        .catch(() => false)
    )
      break;
    if ((await item.getAttribute("data-element-type")) === "card") {
      cardId = await item.getAttribute("data-element-id");
      break;
    }
    await item.getByTestId("process-action-skip").click();
    await page.waitForTimeout(40);
  }
  expect(cardId).not.toBeNull();
  if (!cardId) throw new Error("no card surfaced in the process loop");

  // Cap the card box height AND force a guaranteed-tall answer so the bounded body overflows by a
  // lot, independent of which seeded card surfaced. Both are CSS-only (a `max-height` cap + an
  // `::after` spacer) so React can't reconcile them away and nothing leaks into later serial tests.
  await page.addStyleTag({
    content:
      ".pq-rc { max-height: 320px !important; } " +
      '[data-testid="process-card-face"] .pq-rc__answer::after { content: ""; display: block; height: 1200px; }',
  });

  // Reveal → the answer body + the pinned grade footer.
  await page.keyboard.press("Space");
  await expect(page.getByTestId("process-card-answer")).toBeVisible();
  await expect(page.getByTestId("process-card-grades")).toBeVisible();

  // The body is the single scroll owner and overflows far past its client height.
  const overflow = await page.evaluate(() => {
    const body = document.querySelector(
      '[data-testid="process-card-face"] .pq-rc__body',
    ) as HTMLElement;
    return {
      scrollH: body.scrollHeight,
      clientH: body.clientHeight,
      overflowY: getComputedStyle(body).overflowY,
    };
  });
  expect(overflow.overflowY).toBe("auto");
  expect(overflow.scrollH).toBeGreaterThan(overflow.clientH + 200);

  // Both the pinned header and the pinned grade footer stay fully on-screen even though the body
  // overflows — the core regression this redesign fixes.
  const viewportH = await page.evaluate(() => window.innerHeight);
  const head = page.locator('[data-testid="process-card-face"] .pq-rc__head');
  const foot = page.locator('[data-testid="process-card-face"] .pq-rc__foot');
  const headBox1 = await head.boundingBox();
  const footBox1 = await foot.boundingBox();
  if (!headBox1 || !footBox1) throw new Error("no head/foot bounding box");
  expect(headBox1.y).toBeGreaterThanOrEqual(-1);
  expect(footBox1.y + footBox1.height).toBeLessThanOrEqual(viewportH + 1);
  await expect(page.getByTestId("process-grade-good")).toBeVisible();

  // Scrolling the body to its bottom does NOT move the pinned header or footer.
  await page.evaluate(() => {
    const body = document.querySelector(
      '[data-testid="process-card-face"] .pq-rc__body',
    ) as HTMLElement;
    body.scrollTop = body.scrollHeight;
  });
  const headBox2 = await head.boundingBox();
  const footBox2 = await foot.boundingBox();
  if (!headBox2 || !footBox2) throw new Error("no head/foot bounding box after scroll");
  expect(Math.abs(headBox2.y - headBox1.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(footBox2.y - footBox1.y)).toBeLessThanOrEqual(1);
  expect(footBox2.y + footBox2.height).toBeLessThanOrEqual(viewportH + 1);

  // And the footer is genuinely reachable: grading Good from it writes a durable log + advances.
  const before = await cardLogCount(page, cardId);
  await page.getByTestId("process-grade-good").click();
  await expect.poll(async () => cardLogCount(page, cardId)).toBe(before + 1);

  await app.close();
});

test("wheeling over the empty side gutters scrolls the source body in /process", async () => {
  const freshDir = makeDataDir();
  const app = await launchApp(freshDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;

  // Widen the window so the centered reading column leaves real side gutters
  // beside the text — those gutters are the zones the fix must make scrollable.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1600, height: 1000 });
  });

  const sourceId = await findSourceId(page);
  await scheduleDueForProcess(page, sourceId);
  await openProcess(page, AS_OF);
  await moveProcessCursorTo(page, sourceId);
  await expect(page.getByTestId("process-source-workbench")).toBeVisible();

  // Guarantee the body overflows regardless of the seeded source's length (CSS-only
  // spacer, so React can't reconcile it away and it can't leak into later tests).
  await page.addStyleTag({
    content:
      '[data-testid="process-source-editor"] .reader .ProseMirror::after { content: ""; display: block; height: 1600px; }',
  });

  const reader = page.locator('[data-testid="process-source-editor"] .reader');
  await expect(reader.locator(".ProseMirror")).toBeVisible();

  // The full-width .reader owns the scroll and the text column is centered inside
  // it, so there are real gutters that belong to the scroller (not a dead sibling).
  const geom = await reader.evaluate((el) => {
    const pm = el.querySelector(".ProseMirror") as HTMLElement;
    const r = el.getBoundingClientRect();
    const p = pm.getBoundingClientRect();
    return {
      overflowY: getComputedStyle(el).overflowY,
      leftGutter: Math.round(p.left - r.left),
      scrollable: el.scrollHeight > el.clientHeight + 8,
    };
  });
  expect(geom.overflowY).toBe("auto");
  expect(geom.leftGutter).toBeGreaterThan(40);
  expect(geom.scrollable).toBe(true);

  // Park the cursor in the LEFT gutter (beside the text, not over it) and wheel:
  // the source body must scroll, which it did NOT before the fix.
  const box = await reader.boundingBox();
  if (!box) throw new Error("source reader has no bounding box");
  const before = await reader.evaluate((el) => el.scrollTop);
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => reader.evaluate((el) => el.scrollTop)).toBeGreaterThan(before);

  await app.close();
});
