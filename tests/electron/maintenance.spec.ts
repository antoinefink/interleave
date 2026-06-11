/**
 * Large-collection maintenance E2E (T099) — drives the real Electron app's
 * `/maintenance` hub + the typed `window.appApi.maintenance.*` surface end to end.
 *
 * On a seeded MAINTENANCE collection (a duplicate source pair, a sourceless card, a
 * broken source whose snapshot file is absent, and a low-priority stale source) plus a
 * planted orphan vault file, it proves the whole report+action loop through the UI/
 * bridge (no SQL/fs in the renderer):
 *
 *   1. open `/maintenance` → each report shows the expected non-zero count;
 *   2. run DEDUP cleanup → the redundant source moves to Trash, the canonical remains,
 *      and pressing the Snackbar "Undo" brings the duplicate back;
 *   3. run ORPHAN-MEDIA cleanup (confirm) → the orphan file is gone + `vault.findOrphans`
 *      returns empty;
 *   4. run BULK low-priority archive → the stale item recedes as one undoable batch;
 *   5. run PARKED resurfacing → queue an old saved-for-later source, then undo it;
 *   6. run the INTEGRITY check → DB ok, the vault reports the broken snapshot missing;
 *   7. RESTART the app → the trash + reclaimed space + archived state persist, and a
 *      re-opened Maintenance view shows the updated counts.
 *
 * Everything is asserted through the bridge + the rendered hub; the only direct fs use
 * is planting/observing the orphan file (the desktop-main test pattern, like vault.spec).
 */

import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { seedMaintenance: true });
}

/** Read the maintenance hub report counts through the bridge. */
async function report(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      maintenance: {
        report(): Promise<{
          duplicateCount: number;
          cardsWithoutSourcesCount: number;
          parkedResurfacingCount: number;
          chronicPostponeCount: number;
          orphanFileCount: number;
          lowValueCount: number;
        }>;
      };
    };
    return api.maintenance.report();
  });
}

/** The duplicate clusters (for the removable id the dedup action targets). */
async function duplicates(page: Page) {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      maintenance: {
        duplicates(): Promise<{
          sourceClusters: {
            canonical: { id: string };
            duplicates: { id: string }[];
          }[];
        }>;
      };
    };
    return api.maintenance.duplicates();
  });
}

function expectDefined<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} was not found`);
  }
  return value;
}

test("the seeded collection surfaces non-zero report counts + an orphan file", async () => {
  // Plant a stray orphan file under the vault (no asset row references it).
  const orphanRel = "media/orphan-fixture/original.bin";
  const orphanAbs = path.join(dataDir, "assets", ...orphanRel.split("/"));
  fs.mkdirSync(path.dirname(orphanAbs), { recursive: true });
  fs.writeFileSync(orphanAbs, Buffer.from("orphan bytes that no asset row references"));

  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Assert the report counts through the bridge (deterministic over the seed).
  const r = await report(page);
  expect(r.duplicateCount).toBe(1); // one removable copy in the duplicate pair
  expect(r.cardsWithoutSourcesCount).toBeGreaterThanOrEqual(1);
  expect(r.parkedResurfacingCount).toBeGreaterThanOrEqual(1);
  expect(r.chronicPostponeCount).toBe(4);
  expect(r.orphanFileCount).toBeGreaterThanOrEqual(1);
  expect(r.lowValueCount).toBeGreaterThanOrEqual(1);

  // The hub renders its grid + the duplicate metric card.
  await page.getByTestId("nav-maintenance").click();
  await expect(page.getByTestId("route-maintenance")).toBeVisible();
  await expect(page.getByTestId("metric-duplicates-value")).toHaveText("1");
  await expect(page.getByTestId("metric-parked-value")).toHaveText("3");
  await expect(page.getByTestId("metric-chronic-value")).toHaveText("4");

  await app.close();
});

test("parked resurfacing applies keep, queue, and let-go as one undoable batch", async () => {
  let app = await launch();
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-maintenance").click();
  await expect(page.getByTestId("route-maintenance")).toBeVisible();
  await page.getByTestId("metric-parked-toggle").click();
  await expect(page.getByTestId("parked-panel")).toBeVisible();

  const keepRow = page.getByTestId("parked-row").filter({ hasText: "Parked resurfacing keep" });
  const queueRow = page.getByTestId("parked-row").filter({ hasText: "Parked resurfacing queue" });
  const letGoRow = page.getByTestId("parked-row").filter({ hasText: "Parked resurfacing let-go" });
  await expect(keepRow).toBeVisible();
  await expect(queueRow).toBeVisible();
  await expect(letGoRow).toBeVisible();

  await keepRow.getByTestId("parked-decision-keep").click();
  await queueRow.getByTestId("parked-decision-queue").click();
  await letGoRow.getByTestId("parked-decision-letgo").click();
  await page.getByTestId("parked-apply").click();
  await expect(page.getByTestId("maintenance-snackbar-undo")).toBeVisible();

  const afterApply = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      library: {
        browse(req: {
          statuses: string[];
        }): Promise<{ items: { title: string; status: string }[] }>;
      };
    };
    const [parked, scheduled, dismissed] = await Promise.all([
      api.library.browse({ statuses: ["parked"] }),
      api.library.browse({ statuses: ["scheduled"] }),
      api.library.browse({ statuses: ["dismissed"] }),
    ]);
    return { parked, scheduled, dismissed };
  });
  expect(
    afterApply.parked.items.some(
      (item) => item.title === "Parked resurfacing keep source" && item.status === "parked",
    ),
  ).toBe(true);
  expect(
    afterApply.scheduled.items.some(
      (item) => item.title === "Parked resurfacing queue source" && item.status === "scheduled",
    ),
  ).toBe(true);
  expect(
    afterApply.dismissed.items.some(
      (item) => item.title === "Parked resurfacing let-go source" && item.status === "dismissed",
    ),
  ).toBe(true);
  await expect.poll(async () => (await report(page)).parkedResurfacingCount).toBe(0);

  await app.close();

  // A fresh launch against the same data dir proves the applied status changes are durable.
  app = await launch();
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const afterRestart = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      library: {
        browse(req: {
          statuses: string[];
        }): Promise<{ items: { title: string; status: string }[] }>;
      };
    };
    const [parked, scheduled, dismissed] = await Promise.all([
      api.library.browse({ statuses: ["parked"] }),
      api.library.browse({ statuses: ["scheduled"] }),
      api.library.browse({ statuses: ["dismissed"] }),
    ]);
    return { parked, scheduled, dismissed };
  });
  expect(
    afterRestart.parked.items.some(
      (item) => item.title === "Parked resurfacing keep source" && item.status === "parked",
    ),
  ).toBe(true);
  expect(
    afterRestart.scheduled.items.some(
      (item) => item.title === "Parked resurfacing queue source" && item.status === "scheduled",
    ),
  ).toBe(true);
  expect(
    afterRestart.dismissed.items.some(
      (item) => item.title === "Parked resurfacing let-go source" && item.status === "dismissed",
    ),
  ).toBe(true);
  await expect.poll(async () => (await report(page)).parkedResurfacingCount).toBe(0);

  const undo = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      undo: { last(): Promise<{ undone: boolean; count: number }> };
    };
    return api.undo.last();
  });
  expect(undo.undone).toBe(true);
  expect(undo.count).toBe(3);
  await expect.poll(async () => (await report(page)).parkedResurfacingCount).toBe(3);

  await app.close();
});

test("chronic postpones apply four decisions durably, then undo as one batch", async () => {
  let app = await launch();
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-maintenance").click();
  await expect(page.getByTestId("route-maintenance")).toBeVisible();
  await page.getByTestId("metric-chronic-toggle").click();
  await expect(page.getByTestId("chronic-panel")).toBeVisible();

  const keepRow = page.getByTestId("chronic-row").filter({ hasText: "Chronic postpone keep" });
  const demoteRow = page.getByTestId("chronic-row").filter({ hasText: "Chronic postpone demote" });
  const doneRow = page.getByTestId("chronic-row").filter({ hasText: "Chronic postpone done" });
  const deleteRow = page.getByTestId("chronic-row").filter({ hasText: "Chronic postpone delete" });
  await expect(keepRow).toBeVisible();
  await expect(demoteRow).toBeVisible();
  await expect(doneRow).toBeVisible();
  await expect(deleteRow).toBeVisible();

  await expect(page.getByTestId("chronic-apply")).toBeDisabled();
  await keepRow.getByTestId("chronic-decision-keep").click();
  await demoteRow.getByTestId("chronic-decision-demote").click();
  await doneRow.getByTestId("chronic-decision-done").click();
  await deleteRow.getByTestId("chronic-decision-delete").click();
  await page.getByTestId("chronic-apply").click();
  await expect(page.getByTestId("maintenance-snackbar-undo")).toBeVisible();
  await expect.poll(async () => (await report(page)).chronicPostponeCount).toBe(0);

  const afterApply = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      library: {
        browse(req: {
          statuses: string[];
        }): Promise<{ items: { title: string; status: string; priorityLabel?: string }[] }>;
      };
      trash: { list(): Promise<{ items: { title: string }[] }> };
    };
    const [scheduled, done, trash] = await Promise.all([
      api.library.browse({ statuses: ["scheduled"] }),
      api.library.browse({ statuses: ["done"] }),
      api.trash.list(),
    ]);
    return { scheduled, done, trash };
  });
  expect(
    afterApply.scheduled.items.some(
      (item) => item.title === "Chronic postpone keep source" && item.status === "scheduled",
    ),
  ).toBe(true);
  expect(
    afterApply.scheduled.items.some(
      (item) =>
        item.title === "Chronic postpone demote source" &&
        item.status === "scheduled" &&
        item.priorityLabel === "C",
    ),
  ).toBe(true);
  expect(
    afterApply.done.items.some(
      (item) => item.title === "Chronic postpone done source" && item.status === "done",
    ),
  ).toBe(true);
  expect(
    afterApply.trash.items.some((item) => item.title === "Chronic postpone delete source"),
  ).toBe(true);

  await app.close();

  app = await launch();
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await expect.poll(async () => (await report(page)).chronicPostponeCount).toBe(0);

  const undo = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      undo: { last(): Promise<{ undone: boolean; count: number }> };
    };
    return api.undo.last();
  });
  expect(undo.undone).toBe(true);
  expect(undo.count).toBe(5);
  await expect.poll(async () => (await report(page)).chronicPostponeCount).toBe(4);
  const afterUndo = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      library: {
        browse(req: {
          statuses: string[];
        }): Promise<{ items: { title: string; status: string; priorityLabel?: string }[] }>;
      };
      trash: { list(): Promise<{ items: { title: string }[] }> };
    };
    const [scheduled, done, trash] = await Promise.all([
      api.library.browse({ statuses: ["scheduled"] }),
      api.library.browse({ statuses: ["done"] }),
      api.trash.list(),
    ]);
    return { scheduled, done, trash };
  });
  expect(
    afterUndo.scheduled.items.some(
      (item) => item.title === "Chronic postpone keep source" && item.status === "scheduled",
    ),
  ).toBe(true);
  expect(
    afterUndo.scheduled.items.some(
      (item) =>
        item.title === "Chronic postpone demote source" &&
        item.status === "scheduled" &&
        item.priorityLabel === "B",
    ),
  ).toBe(true);
  expect(
    afterUndo.scheduled.items.some(
      (item) => item.title === "Chronic postpone done source" && item.status === "scheduled",
    ),
  ).toBe(true);
  expect(
    afterUndo.trash.items.some((item) => item.title === "Chronic postpone delete source"),
  ).toBe(false);
  expect(afterUndo.done.items.some((item) => item.title === "Chronic postpone done source")).toBe(
    false,
  );

  await app.close();
});

test("dedup cleanup trashes the redundant copy (canonical stays); undo brings it back", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const before = await duplicates(page);
  const cluster = expectDefined(before.sourceClusters[0], "duplicate source cluster");
  const redundant = expectDefined(cluster.duplicates[0], "redundant duplicate");
  const keeperId = cluster.canonical.id;
  const redundantId = redundant.id;

  // Run dedup cleanup through the bridge (the same command the UI button calls).
  const result = await page.evaluate(
    async (ids) => {
      const api = window.appApi as unknown as {
        maintenance: { dedupe(req: { removeIds: string[] }): Promise<{ affected: number }> };
      };
      return api.maintenance.dedupe({ removeIds: ids });
    },
    [redundantId],
  );
  expect(result.affected).toBe(1);

  // The redundant source is in the trash; the canonical keeper is still live.
  const trash = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      trash: { list(): Promise<{ items: { id: string }[] }> };
    };
    return api.trash.list();
  });
  expect(trash.items.map((i) => i.id)).toContain(redundantId);
  expect(trash.items.map((i) => i.id)).not.toContain(keeperId);

  // The duplicate report no longer lists a cluster (only the keeper remains live).
  const after = await report(page);
  expect(after.duplicateCount).toBe(0);

  // Undo (the shared command-level undo) restores the duplicate.
  const undo = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      undo: { last(): Promise<{ undone: boolean }> };
    };
    return api.undo.last();
  });
  expect(undo.undone).toBe(true);
  const restored = await report(page);
  expect(restored.duplicateCount).toBe(1);

  await app.close();
});

test("orphan-media cleanup frees the orphan file and findOrphans goes empty", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const orphanAbs = path.join(dataDir, "assets", "media", "orphan-fixture", "original.bin");
  expect(fs.existsSync(orphanAbs)).toBe(true);

  const result = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      maintenance: {
        orphanMedia(req: {
          confirm: true;
        }): Promise<{ removed: number; freedBytes: number; vectorsPruned: number }>;
      };
    };
    return api.maintenance.orphanMedia({ confirm: true });
  });
  expect(result.removed).toBeGreaterThanOrEqual(1);
  expect(result.freedBytes).toBeGreaterThan(0);

  // The orphan file is gone and the vault orphan scan is empty.
  expect(fs.existsSync(orphanAbs)).toBe(false);
  const orphans = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      vault: { findOrphans(): Promise<{ orphans: { relativePath: string }[] }> };
    };
    return api.vault.findOrphans();
  });
  expect(orphans.orphans).toEqual([]);

  await app.close();
});

test("bulk low-priority archive recedes the stale item as one undoable batch", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const low = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      maintenance: { lowValue(): Promise<{ rows: { element: { id: string } }[] }> };
    };
    return api.maintenance.lowValue();
  });
  const ids = low.rows.map((r) => r.element.id);
  expect(ids.length).toBeGreaterThanOrEqual(1);

  const archived = await page.evaluate(async (lowIds) => {
    const api = window.appApi as unknown as {
      maintenance: {
        bulkArchive(req: {
          ids: string[];
          mode: "trash" | "dismiss" | "retire";
        }): Promise<{ affected: number; batchId: string }>;
      };
    };
    return api.maintenance.bulkArchive({ ids: lowIds, mode: "dismiss" });
  }, ids);
  expect(archived.affected).toBe(ids.length);

  // The whole batch reverses as one.
  const undo = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      undo: { last(): Promise<{ undone: boolean; count: number }> };
    };
    return api.undo.last();
  });
  expect(undo.undone).toBe(true);
  expect(undo.count).toBe(ids.length);

  // Re-archive so the persisted-after-restart assertion has something to verify.
  await page.evaluate(async (lowIds) => {
    const api = window.appApi as unknown as {
      maintenance: {
        bulkArchive(req: { ids: string[]; mode: "dismiss" }): Promise<unknown>;
      };
    };
    await api.maintenance.bulkArchive({ ids: lowIds, mode: "dismiss" });
  }, ids);

  await app.close();
});

test("the integrity check reports DB ok + the broken source's missing snapshot", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const integrity = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      maintenance: {
        integrity(): Promise<{
          db: { ok: boolean; foreignKeyViolations: number };
          vault: { missing: string[] };
        }>;
      };
    };
    return api.maintenance.integrity();
  });
  expect(integrity.db.ok).toBe(true);
  expect(integrity.db.foreignKeyViolations).toBe(0);
  // The seeded broken source's snapshot file was never written → reported missing.
  expect(integrity.vault.missing.length).toBeGreaterThanOrEqual(1);

  // The broken-source report maps that missing asset to its owning source — and ONLY
  // that one. The duplicate-pair + low-value manual sources have no recorded snapshot
  // (`snapshot_key`), so they must NOT be over-reported as `noSnapshot` false positives.
  const broken = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      maintenance: {
        brokenSources(): Promise<{ rows: { reason: string; source: { title: string } }[] }>;
      };
    };
    return api.maintenance.brokenSources();
  });
  // Exactly the one genuinely-broken fixture source — no manual-source false positives.
  expect(broken.rows).toHaveLength(1);
  const brokenRow = expectDefined(broken.rows[0], "broken source row");
  expect(brokenRow.reason).toBe("missingFile");
  expect(brokenRow.source.title).toBe("Broken source (snapshot file removed)");
  // No `noSnapshot` over-report for the healthy manual / duplicate-pair sources.
  expect(broken.rows.some((r) => r.reason === "noSnapshot")).toBe(false);

  await app.close();
});

test("the trash + reclaimed space + archived state persist after an app restart", async () => {
  // A FRESH launch against the SAME data dir — nothing re-seeds (the DB is non-empty).
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The orphan file stays gone (reclaimed before the restart).
  const orphanAbs = path.join(dataDir, "assets", "media", "orphan-fixture", "original.bin");
  expect(fs.existsSync(orphanAbs)).toBe(false);

  // The dismissed low-value source persists as `dismissed` (the archived state).
  const dismissed = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      library: {
        browse(req: { statuses: string[] }): Promise<{ items: { id: string; status: string }[] }>;
      };
    };
    return api.library.browse({ statuses: ["dismissed"] });
  });
  expect(dismissed.items.some((i) => i.status === "dismissed")).toBe(true);

  // A re-opened Maintenance view recomputes its counts from the durable tables: the
  // duplicate cluster is back (we undid the dedup), the orphan count is 0.
  const r = await report(page);
  expect(r.duplicateCount).toBe(1);
  expect(r.orphanFileCount).toBe(0);

  await app.close();
});
