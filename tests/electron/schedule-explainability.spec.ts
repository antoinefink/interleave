/**
 * Schedule explainability (T113) E2E — proves adaptive attention reasons cross the
 * real Electron bridge and render in the due queue.
 *
 * The fixture uses the real extraction command: extracting from a source creates a
 * productive visit, which reschedules the source with `yield_shortened` now that
 * adaptive attention intervals default on. The renderer never touches SQLite.
 */

import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

const DESCENDANT_LAPSE_REASON_TEXT = "Returning sooner: descendant cards are struggling.";
const MANUAL_OVERRIDE_DUE_AT = "2028-02-01T00:00:00.000Z";

async function readAttentionSchedule(page: Page, sourceId: string) {
  return page.evaluate(async (id) => {
    const api = window.appApi as unknown as {
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { dueAt: string | null };
            scheduler: {
              kind: string;
              scheduleReason?: {
                kind: string;
                descendantLapseCount?: number | null;
                affectedCardCount?: number | null;
              } | null;
            };
          } | null;
        }>;
      };
    };
    const res = await api.inspector.get({ id });
    if (!res.data?.element.dueAt) throw new Error("source was not rescheduled");
    return {
      dueAt: res.data.element.dueAt,
      schedulerKind: res.data.scheduler.kind,
      reason: res.data.scheduler.scheduleReason ?? null,
    };
  }, sourceId);
}

function baseUrlFor(page: Page) {
  const base = new URL(page.url());
  return `${base.protocol}//${base.host}`;
}

async function openQueue(page: Page, baseUrl: string, asOf: string) {
  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();
}

async function openHome(page: Page, baseUrl: string, asOf: string) {
  await page.goto(`${baseUrl}/?asOf=${encodeURIComponent(asOf)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-home")).toBeVisible();
}

async function manuallySchedule(page: Page, sourceId: string, date: string) {
  await page.evaluate(
    async ({ id, dueAt }) => {
      const api = window.appApi as unknown as {
        queue: {
          schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
        };
      };
      await api.queue.schedule({ id, choice: { kind: "manual", date: dueAt } });
    },
    { id: sourceId, dueAt: date },
  );
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("productive source visits show the shortened schedule reason in the queue", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const baseUrl = baseUrlFor(page);

  const source = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string; title: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    const row = elements.find(
      (element) => element.type === "source" && element.title === "On the Measure of Intelligence",
    );
    if (!row) throw new Error("seeded source not found");
    return row;
  });

  const scheduled = await page.evaluate(async (sourceId) => {
    const api = window.appApi as unknown as {
      extractions: {
        create(req: {
          sourceElementId: string;
          selectedText: string;
          blockIds: string[];
          startOffset?: number;
          endOffset?: number;
        }): Promise<unknown>;
      };
      inspector: {
        get(req: { id: string }): Promise<{
          data: {
            element: { dueAt: string | null };
            scheduler: {
              kind: string;
              scheduleReason?: { kind: string; productiveOutputCount?: number | null } | null;
            };
          } | null;
        }>;
      };
    };

    await api.extractions.create({
      sourceElementId: sourceId,
      selectedText: "A measure of intelligence must control for prior knowledge and experience.",
      blockIds: ["blk_def_p2"],
      startOffset: 0,
      endOffset: 60,
    });

    const res = await api.inspector.get({ id: sourceId });
    if (!res.data?.element.dueAt) throw new Error("source was not rescheduled");
    return {
      dueAt: res.data.element.dueAt,
      schedulerKind: res.data.scheduler.kind,
      reason: res.data.scheduler.scheduleReason ?? null,
    };
  }, source.id);

  expect(scheduled.schedulerKind).toBe("attention");
  expect(scheduled.reason).toMatchObject({
    kind: "yield_shortened",
  });
  expect(scheduled.reason?.productiveOutputCount).toBeGreaterThan(0);
  const reasonText = `Returning sooner: last visit produced ${scheduled.reason?.productiveOutputCount} output(s).`;

  await page.goto(`${baseUrl}/queue?asOf=${encodeURIComponent(scheduled.dueAt)}`);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("route-queue")).toBeVisible();

  const row = page.locator(`[data-testid="queue-item"][data-element-id="${source.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("schedule-reason-line")).toHaveText(reasonText);
  await expect(row.getByTestId("queue-open")).toHaveAttribute("aria-describedby", /.+/);

  await app.close();
});

test("descendant card lapses explain queue/home/inspector until manual override", async () => {
  const descendantDir = makeDataDir();
  const app = await launchApp(descendantDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const baseUrl = baseUrlFor(page);

  const seeded = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: {
        list(): Promise<{ elements: { id: string; type: string; title: string }[] }>;
      };
    };
    const { elements } = await api.inspector.list();
    const source = elements.find(
      (element) => element.type === "source" && element.title === "On the Measure of Intelligence",
    );
    const extract = elements.find(
      (element) =>
        element.type === "extract" &&
        element.title === "Intelligence = skill-acquisition efficiency",
    );
    if (!source) throw new Error("seeded source not found");
    if (!extract) throw new Error("seeded extract not found");
    return { source, extract };
  });

  const setup = await page.evaluate(
    async ({ sourceId, extractId }) => {
      const api = window.appApi as unknown as {
        elements: {
          setPriority(req: {
            id: string;
            action: { kind: "set"; priority: "C" | "D" };
          }): Promise<unknown>;
        };
        queue: {
          schedule(req: { id: string; choice: { kind: "manual"; date: string } }): Promise<unknown>;
        };
        cards: {
          create(req: {
            extractId: string;
            kind: "qa";
            prompt: string;
            answer: string;
            title?: string;
          }): Promise<{ card: { id: string } }>;
        };
        review: {
          grade(req: {
            cardId: string;
            rating: "again" | "easy";
            responseMs: number;
            promptMs?: number;
            asOf: string;
          }): Promise<{ reviewState: { dueAt: string | null; lapses: number } }>;
        };
        inspector: {
          list(): Promise<{ elements: { id: string }[] }>;
          get(req: { id: string }): Promise<{
            data: {
              source: { id: string } | null;
              scheduler: {
                scheduleReason?: { kind: string; descendantLapseCount?: number | null } | null;
              };
            } | null;
          }>;
        };
      };

      const existing = await api.inspector.list();
      for (const element of existing.elements) {
        if (element.id === sourceId) continue;
        await api.elements.setPriority({ id: element.id, action: { kind: "set", priority: "D" } });
      }
      await api.elements.setPriority({ id: sourceId, action: { kind: "set", priority: "C" } });
      await api.queue.schedule({
        id: sourceId,
        choice: { kind: "manual", date: "2028-01-01T00:00:00.000Z" },
      });

      const outcomes: { sourceId: string | null; lapses: number }[] = [];
      for (let index = 0; index < 3; index += 1) {
        const { card } = await api.cards.create({
          extractId,
          kind: "qa",
          title: `Descendant lapse ${index + 1}`,
          prompt: `Descendant lapse prompt ${index + 1}?`,
          answer: "A.",
        });
        const firstReview = await api.review.grade({
          cardId: card.id,
          rating: "easy",
          responseMs: 900,
          promptMs: 300,
          asOf: `2026-06-1${index}T09:00:00.000Z`,
        });
        const failingReviewAt = firstReview.reviewState.dueAt
          ? new Date(Date.parse(firstReview.reviewState.dueAt) + 86_400_000).toISOString()
          : `2026-06-1${index}T09:10:00.000Z`;
        const failed = await api.review.grade({
          cardId: card.id,
          rating: "again",
          responseMs: 1100,
          promptMs: 300,
          asOf: failingReviewAt,
        });
        const inspected = await api.inspector.get({ id: card.id });
        await api.elements.setPriority({ id: card.id, action: { kind: "set", priority: "D" } });
        outcomes.push({
          sourceId: inspected.data?.source?.id ?? null,
          lapses: failed.reviewState.lapses,
        });
      }
      const source = await api.inspector.get({ id: sourceId });
      return { outcomes, reason: source.data?.scheduler.scheduleReason ?? null };
    },
    { sourceId: seeded.source.id, extractId: seeded.extract.id },
  );
  expect(setup.outcomes).toEqual([
    { sourceId: seeded.source.id, lapses: 1 },
    { sourceId: seeded.source.id, lapses: 1 },
    { sourceId: seeded.source.id, lapses: 1 },
  ]);

  const scheduled = await readAttentionSchedule(page, seeded.source.id);

  expect(scheduled.schedulerKind).toBe("attention");
  expect(scheduled.reason).toMatchObject({
    kind: "descendant_lapses",
    descendantLapseCount: 3,
    affectedCardCount: 3,
  });

  await openQueue(page, baseUrl, scheduled.dueAt);

  const row = page.locator(`[data-testid="queue-item"][data-element-id="${seeded.source.id}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("schedule-reason-line")).toHaveText(DESCENDANT_LAPSE_REASON_TEXT);

  await openHome(page, baseUrl, scheduled.dueAt);
  const homeRow = page.locator(
    `[data-testid="home-preview-row"][data-element-id="${seeded.source.id}"]`,
  );
  await expect(homeRow).toBeVisible();
  await expect(homeRow.getByTestId("schedule-reason-line")).toHaveText(
    DESCENDANT_LAPSE_REASON_TEXT,
  );

  await openQueue(page, baseUrl, scheduled.dueAt);
  await expect(row).toBeVisible();
  await row.getByTestId("queue-open").click();
  await expect(page.getByTestId("route-source")).toBeVisible();
  await expect(page.getByTestId("inspector-content")).toHaveAttribute(
    "data-element-type",
    "source",
  );
  await expect(page.getByTestId("inspector-title")).toHaveText(seeded.source.title);
  await expect(
    page.getByTestId("scheduler-section").getByTestId("schedule-reason-line"),
  ).toHaveText(DESCENDANT_LAPSE_REASON_TEXT);

  await manuallySchedule(page, seeded.source.id, MANUAL_OVERRIDE_DUE_AT);
  const manualSchedule = await readAttentionSchedule(page, seeded.source.id);
  expect(manualSchedule.dueAt).toBe(MANUAL_OVERRIDE_DUE_AT);
  expect(manualSchedule.schedulerKind).toBe("attention");
  expect(manualSchedule.reason?.kind).not.toBe("descendant_lapses");

  await openQueue(page, baseUrl, MANUAL_OVERRIDE_DUE_AT);
  await expect(row).toBeVisible();
  await expect(row.getByText(DESCENDANT_LAPSE_REASON_TEXT)).toHaveCount(0);

  await openHome(page, baseUrl, MANUAL_OVERRIDE_DUE_AT);
  await expect(page.getByTestId("route-home")).not.toContainText(DESCENDANT_LAPSE_REASON_TEXT);

  await openQueue(page, baseUrl, MANUAL_OVERRIDE_DUE_AT);
  await expect(row).toBeVisible();
  await row.getByTestId("queue-open").click();
  await expect(page.getByTestId("route-source")).toBeVisible();
  await expect(page.getByTestId("inspector-content")).toHaveAttribute(
    "data-element-type",
    "source",
  );
  await expect(page.getByTestId("scheduler-section")).not.toContainText(
    DESCENDANT_LAPSE_REASON_TEXT,
  );

  await app.close();

  const relaunched = await launchApp(descendantDir, { seedOnEmpty: true });
  const relaunchedPage = await relaunched.firstWindow();
  await relaunchedPage.waitForLoadState("domcontentloaded");
  const relaunchedBaseUrl = baseUrlFor(relaunchedPage);

  const restartedSchedule = await readAttentionSchedule(relaunchedPage, seeded.source.id);
  expect(restartedSchedule.dueAt).toBe(MANUAL_OVERRIDE_DUE_AT);
  expect(restartedSchedule.schedulerKind).toBe("attention");
  expect(restartedSchedule.reason?.kind).not.toBe("descendant_lapses");

  await openQueue(relaunchedPage, relaunchedBaseUrl, MANUAL_OVERRIDE_DUE_AT);

  const restartedRow = relaunchedPage.locator(
    `[data-testid="queue-item"][data-element-id="${seeded.source.id}"]`,
  );
  await expect(restartedRow).toBeVisible();
  await expect(restartedRow.getByText(DESCENDANT_LAPSE_REASON_TEXT)).toHaveCount(0);

  await relaunched.close();
});
