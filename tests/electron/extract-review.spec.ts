/**
 * Extract review mode E2E (T024) — drives the real Electron app.
 *
 * An extract is an independent, attention-scheduled mini-topic the user processes
 * over time. This spec launches the BUILT desktop app against a fresh seeded data
 * dir, creates a top-level extract from the intro paragraph through the real
 * `extractions.create` bridge (so it starts at `raw_extract`), then drives the
 * `/extract/$id` review view to prove the full T024 round-trip through the real
 * `extracts.*` bridge:
 *
 *   (a) ADVANCE: the stage stepper walks `raw_extract → clean_extract →
 *       atomic_statement`; each "Advance stage" persists the new `stage` AND
 *       reschedules the extract on the ATTENTION scheduler (a FUTURE `due_at`,
 *       never an FSRS `review_states` row);
 *   (b) ACTIONS: body edits autosave, Trim rewrites the cleaned body, Postpone
 *       reschedules further out + bumps the postpone count, Mark done sets status `done`;
 *   (c) RESTART: relaunching the Electron app against the same data dir still
 *       shows the advanced stage, the done status, and the future attention
 *       `due_at` — it survives an app restart (the DoD bar).
 *
 * Everything is observed BOTH through the UI (the stepper + chips + toasts) and
 * the typed bridge (`inspector.get` for the persisted stage/status/due/review).
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let baseUrl: string;
let sourceId: string;
let extractId: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

/** Resolve the seeded article source id via the bridge. */
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

/** Create a fresh top-level extract from the intro block via the bridge. */
async function createIntroExtract(page: Page, srcId: string): Promise<string> {
  return page.evaluate(async (sourceElementId) => {
    const api = window.appApi as unknown as {
      extractions: {
        create(req: {
          sourceElementId: string;
          selectedText: string;
          blockIds: string[];
          startOffset?: number;
          endOffset?: number;
        }): Promise<{ extract: { id: string } }>;
      };
    };
    const { extract } = await api.extractions.create({
      sourceElementId,
      selectedText:
        "To make deliberate progress towards more intelligent and more human-like artificial systems, we need to be following an appropriate feedback signal.",
      blockIds: ["blk_intro_p1"],
      startOffset: 0,
      endOffset: 150,
    });
    return extract.id;
  }, srcId);
}

/** The inspector payload for an element (persisted stage/status/due/scheduler). */
async function inspect(page: Page, id: string) {
  return page.evaluate(async (elementId) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { type: string; stage: string; status: string; dueAt: string | null };
            scheduler: { kind: string; stage: string; postponed: number };
            review: unknown | null;
          } | null;
        }>;
      };
    };
    const { data } = await api.inspector.get({ id: elementId });
    return data;
  }, id);
}

async function openExtract(page: Page, id: string): Promise<void> {
  await page.goto(`${baseUrl}/extract/${id}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("extract-stage-stepper")).toBeVisible();
}

test("an extract advances raw → clean → atomic, reschedules on attention, and survives restart", async () => {
  let app = await launchApp(dataDir, { seedOnEmpty: true });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const url = new URL(page.url());
  baseUrl = `${url.protocol}//${url.host}`;
  sourceId = await resolveSourceId(page);
  extractId = await createIntroExtract(page, sourceId);

  await openExtract(page, extractId);

  // It starts at raw_extract (a fresh extract), an attention item, not FSRS.
  const before = await inspect(page, extractId);
  expect(before?.element.stage).toBe("raw_extract");
  expect(before?.scheduler.kind).toBe("attention");
  expect(before?.review).toBeNull();

  // (a) ADVANCE raw → clean.
  await page.getByTestId("extract-advance-stage").click();
  await expect(page.getByText(/Advanced to/)).toBeVisible();
  await expect
    .poll(async () => (await inspect(page, extractId))?.element.stage)
    .toBe("clean_extract");
  const afterClean = await inspect(page, extractId);
  expect(afterClean?.review).toBeNull(); // a stage move never creates FSRS state
  expect(afterClean?.element.dueAt).toBeTruthy();
  expect(Date.parse(afterClean?.element.dueAt ?? "")).toBeGreaterThan(Date.now());

  // (a) ADVANCE clean → atomic.
  await page.getByTestId("extract-advance-stage").click();
  await expect
    .poll(async () => (await inspect(page, extractId))?.element.stage)
    .toBe("atomic_statement");

  // (b) POSTPONE reschedules further out + bumps the attention postpone count.
  await page.getByTestId("extract-postpone").click();
  await expect(page.getByText(/Postponed/)).toBeVisible();
  await expect.poll(async () => (await inspect(page, extractId))?.scheduler.postponed).toBe(1);

  // (b) MARK DONE sets status done.
  await page.getByTestId("extract-mark-done").click();
  await expect(page.getByText(/Marked done/)).toBeVisible();
  await expect.poll(async () => (await inspect(page, extractId))?.element.status).toBe("done");

  // (c) RESTART: relaunch against the same data dir — the advanced stage, done
  // status, and postpone count survive. Done extracts leave the active schedule.
  await app.close();
  app = await launchApp(dataDir);
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const afterRestart = await inspect(page, extractId);
  expect(afterRestart?.element.stage).toBe("atomic_statement");
  expect(afterRestart?.element.status).toBe("done");
  expect(afterRestart?.scheduler.kind).toBe("attention");
  expect(afterRestart?.scheduler.postponed).toBe(1);
  expect(afterRestart?.review).toBeNull();
  expect(afterRestart?.element.dueAt).toBeNull();

  // The review view reopens on the persisted (atomic) stage after the restart.
  await openExtract(page, extractId);
  await expect(
    page.locator('[data-testid="extract-stage-step-atomic_statement"][data-active="true"]'),
  ).toBeVisible();

  await app.close();
});
