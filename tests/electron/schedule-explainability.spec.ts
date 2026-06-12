/**
 * Schedule explainability (T113) E2E — proves adaptive attention reasons cross the
 * real Electron bridge and render in the due queue.
 *
 * The fixture uses the real extraction command: extracting from a source creates a
 * productive visit, which reschedules the source with `yield_shortened` now that
 * adaptive attention intervals default on. The renderer never touches SQLite.
 */

import { expect, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

test("productive source visits show the shortened schedule reason in the queue", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const base = new URL(page.url());
  const baseUrl = `${base.protocol}//${base.host}`;

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
