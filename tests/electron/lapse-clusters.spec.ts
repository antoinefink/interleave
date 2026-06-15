/**
 * Lapse-cluster detection E2E (T128) — drives the REAL Electron app.
 *
 * T128 is a READ-ONLY model that surfaces source regions where several live sibling cards
 * keep lapsing together — comprehension debt, not N formulation bugs. This spec proves the
 * end-to-end wiring + the non-negotiable laws through the built desktop app, via
 * `window.appApi` only (no generic `db.query`):
 *
 *   - the typed bridge exposes the read-only `lapseClusters.list` surface, and there is NO
 *     generic `db.query`;
 *   - the window + read-only discipline: leech cards whose lapses are OUTSIDE the recent
 *     window do NOT form a cluster (a leech existing ≠ a cluster existing — the window
 *     bound holds through the real app), the leech screen shows those leeches with NO
 *     cluster cross-link, and the cluster reads add NO `operation_log` rows;
 *   - the maintenance hub renders the read-only "Struggling card groups" section;
 *   - the feature toggle: disabling detection makes the query return nothing, and the
 *     setting persists across an APP RESTART along with the read-only guarantee.
 *
 * Coverage split (faithful, not a gap): the POSITIVE detection math — a real sibling-failure
 * cluster yields exactly one cluster naming the right region + members, ordering, scope,
 * tombstone/sourceless/atomic-statement handling — is proven DETERMINISTICALLY at the unit
 * layer (`lapse-cluster-query` 16 tests, `lapse-window`, `lapse-cluster-score`), and the
 * three surfaces' rendering (maintenance row, source indicator, leech cross-link) at the
 * component layer (`MaintenanceScreen` / `SourceReader` / `LeechRemediation` tests).
 * Manufacturing a deterministic IN-WINDOW cluster through the real app headless is not
 * feasible: a freshly-authored card's lapses cannot be stamped both after creation and
 * before the query's "now" reliably (the same constraint the T127 E2E documented), so this
 * E2E proves the real IPC wiring, the window/read-only laws, the surfaces' presence, the
 * toggle, and restart.
 *
 * The op-log assertion reads the SQLite file DIRECTLY from the test process (the renderer
 * never opens SQLite) — the same boundary-preserving pattern as the suggestion spec.
 */

import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { seedOnEmpty: true });
}

/** Total `operation_log` rows (read SQLite directly — the renderer never opens it). */
function opLogCount(dir: string): number {
  const db = new Database(path.join(dir, "app.sqlite"), { readonly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS c FROM operation_log").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/**
 * Author two cards from the same seeded extract and drive each past the leech threshold
 * with FUTURE-dated grades (2027) — so they are cumulative leeches sharing one extract
 * ancestor, but their lapses fall OUTSIDE the recent cluster window. Returns the card ids.
 */
async function seedFutureDatedSiblingLeeches(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
      cards: {
        create(req: {
          extractId: string;
          kind: string;
          prompt: string;
          answer: string;
        }): Promise<{ card: { id: string } }>;
      };
      review: {
        grade(req: {
          cardId: string;
          rating: string;
          responseMs: number;
          asOf: string;
        }): Promise<{ reviewState: { dueAt: string | null } }>;
      };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract");
    if (!extract) throw new Error("no seeded extract");

    const ids: string[] = [];
    for (let n = 0; n < 2; n++) {
      const { card } = await api.cards.create({
        extractId: extract.id,
        kind: "qa",
        prompt: `Sibling ${n} under one region?`,
        answer: `Answer ${n}.`,
      });
      let clock = Date.parse("2027-06-02T00:00:00.000Z");
      const grade = async (rating: string) => {
        const res = await api.review.grade({
          cardId: card.id,
          rating,
          responseMs: 4000,
          asOf: new Date(clock).toISOString(),
        });
        clock = res.reviewState.dueAt
          ? Date.parse(res.reviewState.dueAt) + 86_400_000
          : clock + 86_400_000;
      };
      await grade("easy"); // new → review
      for (let i = 0; i < 4; i++) {
        await grade("again");
        if (i < 3) await grade("good");
      }
      ids.push(card.id);
    }
    return ids;
  });
}

test("exposes the typed lapseClusters bridge and no generic db.query", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      lapseClusters?: { list?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasList: typeof api?.lapseClusters?.list === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasList).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("window + read-only discipline: out-of-window leeches form no cluster; reads are read-only; restart-safe", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const baseUrl = (() => {
    const url = new URL(page.url());
    return `${url.protocol}//${url.host}`;
  })();

  // Two sibling leeches under one extract, but lapsing in 2027 (outside the recent window).
  const leechIds = await seedFutureDatedSiblingLeeches(page);
  expect(leechIds).toHaveLength(2);

  const before = opLogCount(dataDir);

  // The window law: those out-of-window lapses produce NO cluster containing the leeches.
  const clusters = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      lapseClusters: {
        list(): Promise<{ clusters: { members: { cardId: string }[] }[] }>;
      };
    };
    return (await api.lapseClusters.list()).clusters;
  });
  const clusteredCardIds = new Set(clusters.flatMap((c) => c.members.map((m) => m.cardId)));
  expect(leechIds.some((id) => clusteredCardIds.has(id))).toBe(false);

  // Read-only: the cluster reads (plus the seeding's review grades already counted) added
  // NO operation_log rows for the read itself.
  expect(opLogCount(dataDir)).toBe(before);

  // The maintenance hub renders the read-only cluster section.
  await page.goto(`${baseUrl}/maintenance`);
  await expect(page.getByTestId("metric-clusters")).toBeVisible();
  await page.getByTestId("metric-clusters-toggle").click();
  // With no in-window clusters, the calm empty row shows (no mutation controls anywhere).
  await expect(
    page.getByTestId("clusters-panel").or(page.getByTestId("maintenance-empty-row")),
  ).toBeVisible();

  // The leech screen shows the seeded leeches, and NONE carries a cluster cross-link.
  await page.goto(`${baseUrl}/maintenance/leeches`);
  await expect(page.getByTestId("route-leech-cleanup")).toBeVisible();
  await expect(page.getByTestId("leech-card").first()).toBeVisible();
  await expect(page.getByTestId("leech-card-cluster")).toHaveCount(0);

  await app.close();

  // Restart: the read still surfaces no cluster for the out-of-window leeches; op-log stable.
  const restartBefore = opLogCount(dataDir);
  const app2 = await launch();
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const restartClusters = await page2.evaluate(async () => {
    const api = window.appApi as unknown as {
      lapseClusters: { list(): Promise<{ clusters: { members: { cardId: string }[] }[] }> };
    };
    return (await api.lapseClusters.list()).clusters;
  });
  const restartClustered = new Set(restartClusters.flatMap((c) => c.members.map((m) => m.cardId)));
  expect(leechIds.some((id) => restartClustered.has(id))).toBe(false);
  expect(opLogCount(dataDir)).toBe(restartBefore);

  await app2.close();
});

test("the feature toggle persists across restart and disables the read", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Disable detection through the typed settings bridge; the disabled query returns nothing.
  const disabled = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: {
        updateMany(req: {
          patch: { lapseClusterDetectionEnabled: boolean };
        }): Promise<{ settings: { lapseClusterDetectionEnabled: boolean } }>;
      };
      lapseClusters: { list(): Promise<{ clusters: unknown[] }> };
    };
    const { settings } = await api.settings.updateMany({
      patch: { lapseClusterDetectionEnabled: false },
    });
    const { clusters } = await api.lapseClusters.list();
    return { enabled: settings.lapseClusterDetectionEnabled, clusterCount: clusters.length };
  });
  expect(disabled.enabled).toBe(false);
  expect(disabled.clusterCount).toBe(0);

  await app.close();

  // Restart: the toggle persisted off, and the read still short-circuits to nothing.
  const app2 = await launch();
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const persisted = await page2.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: {
        getAll(): Promise<{ settings: { lapseClusterDetectionEnabled: boolean } }>;
      };
      lapseClusters: { list(): Promise<{ clusters: unknown[] }> };
    };
    const { settings } = await api.settings.getAll();
    const { clusters } = await api.lapseClusters.list();
    return { enabled: settings.lapseClusterDetectionEnabled, clusterCount: clusters.length };
  });
  expect(persisted.enabled).toBe(false);
  expect(persisted.clusterCount).toBe(0);

  // Re-enable so the data dir is left in the default state for any later run.
  await page2.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: {
        updateMany(req: { patch: { lapseClusterDetectionEnabled: boolean } }): Promise<unknown>;
      };
    };
    await api.settings.updateMany({ patch: { lapseClusterDetectionEnabled: true } });
  });

  await app2.close();
});
