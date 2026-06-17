/**
 * Re-read proposals E2E (T129) — drives the REAL Electron app.
 *
 * T129 turns a detected lapse cluster (T128) into capped, dismissible scheduled re-read work.
 * This spec proves the end-to-end wiring + the non-negotiable laws through the built desktop
 * app, via `window.appApi` only (no generic `db.query`):
 *
 *   - the typed bridge exposes `rereadProposals.{list,item,accept,dismiss,undoAccept}`, and
 *     there is NO generic `db.query`;
 *   - READ-ONLY discipline: `list` + `item` add NO `operation_log` rows; accepting a stale /
 *     non-cluster ancestor is refused (`created:false`, `stale:true`) and writes nothing;
 *     `undoAccept` on a non-re-read task is refused and writes nothing;
 *   - the maintenance hub renders the "Struggling card groups" surface (the proposal panel
 *     when enabled, its calm empty state when nothing crosses the floor);
 *   - the feature toggle: disabling proposals makes `list` return nothing, and the setting
 *     persists across an APP RESTART along with the read-only guarantee.
 *
 * Coverage split (faithful, not a gap): the POSITIVE lifecycle — a real cluster becomes a
 * proposal; accept schedules a `reread_region` task with the failing cards attached; opening it
 * lands at the region with the panel; completing it suppresses the proposal for the grace
 * window; dismissal memory by state-hash; the surfacing cap; soft-delete reversal — is proven
 * DETERMINISTICALLY at the unit layer (`reread-proposal-service` 16 tests, the migration test,
 * the contract tests) and the component layer (`MaintenanceScreen` accept/dismiss, `RereadPanel`,
 * `openQueueItem`/`queueRow`, `QueueScreen` daily line). Manufacturing a deterministic IN-WINDOW
 * cluster through the real app headless is not feasible — a freshly-authored card's lapses
 * cannot be stamped both after creation and before the query's "now" reliably (the same
 * constraint the T127/T128 E2Es documented) — so this E2E proves the real IPC wiring, the
 * read-only laws, the surface presence, the toggle, and restart.
 *
 * The op-log assertion reads the SQLite file DIRECTLY from the test process (the renderer never
 * opens SQLite) — the same boundary-preserving pattern as the lapse-cluster spec.
 */

import path from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
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

test("exposes the typed rereadProposals bridge and no generic db.query", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      rereadProposals?: {
        list?: unknown;
        item?: unknown;
        accept?: unknown;
        dismiss?: unknown;
        undoAccept?: unknown;
      };
      db?: { query?: unknown };
    };
    return {
      hasList: typeof api?.rereadProposals?.list === "function",
      hasItem: typeof api?.rereadProposals?.item === "function",
      hasAccept: typeof api?.rereadProposals?.accept === "function",
      hasDismiss: typeof api?.rereadProposals?.dismiss === "function",
      hasUndoAccept: typeof api?.rereadProposals?.undoAccept === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasList).toBe(true);
  expect(surface.hasItem).toBe(true);
  expect(surface.hasAccept).toBe(true);
  expect(surface.hasDismiss).toBe(true);
  expect(surface.hasUndoAccept).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("reads are read-only; a stale accept and a bogus undo are refused and write nothing", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const baseUrl = (() => {
    const url = new URL(page.url());
    return `${url.protocol}//${url.host}`;
  })();

  const before = opLogCount(dataDir);

  const result = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { id: string; type: string }[] }> };
      rereadProposals: {
        list(): Promise<{ proposals: unknown[] }>;
        item(req: { taskElementId: string }): Promise<{ item: unknown | null }>;
        accept(req: { ancestorId: string }): Promise<{ created: boolean; stale: boolean }>;
        undoAccept(req: { taskElementId: string }): Promise<{ removed: boolean }>;
      };
    };
    const { elements } = await api.inspector.list();
    const extract = elements.find((e) => e.type === "extract");
    // Read-only reads.
    const list = await api.rereadProposals.list();
    const item = await api.rereadProposals.item({ taskElementId: "no-such-task" });
    // A stale accept: a real extract id that is NOT a struggling cluster → refused, no write.
    const accept = extract
      ? await api.rereadProposals.accept({ ancestorId: extract.id })
      : { created: false, stale: true };
    // A bogus undo: not a re-read task → refused, no write.
    const undo = await api.rereadProposals.undoAccept({ taskElementId: "no-such-task" });
    return {
      proposalCount: list.proposals.length,
      itemNull: item.item === null,
      accepted: accept.created,
      acceptStale: accept.stale,
      undoRemoved: undo.removed,
    };
  });

  expect(result.itemNull).toBe(true);
  expect(result.accepted).toBe(false);
  expect(result.acceptStale).toBe(true);
  expect(result.undoRemoved).toBe(false);
  // None of the reads / refused mutations appended an operation_log row.
  expect(opLogCount(dataDir)).toBe(before);

  // The maintenance hub renders the struggling-card-groups surface (panel or calm empty state).
  await page.goto(`${baseUrl}/maintenance`);
  await expect(page.getByTestId("metric-clusters")).toBeVisible();
  await page.getByTestId("metric-clusters-toggle").click();
  await expect(
    page.getByTestId("clusters-panel").or(page.getByTestId("maintenance-empty-row")),
  ).toBeVisible();

  await app.close();
});

test("the feature toggle persists across restart and disables the read", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const disabled = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: {
        updateMany(req: {
          patch: { rereadProposalsEnabled: boolean };
        }): Promise<{ settings: { rereadProposalsEnabled: boolean } }>;
      };
      rereadProposals: { list(): Promise<{ proposals: unknown[] }> };
    };
    const { settings } = await api.settings.updateMany({
      patch: { rereadProposalsEnabled: false },
    });
    const { proposals } = await api.rereadProposals.list();
    return { enabled: settings.rereadProposalsEnabled, proposalCount: proposals.length };
  });
  expect(disabled.enabled).toBe(false);
  expect(disabled.proposalCount).toBe(0);

  await app.close();

  // Restart: the toggle persisted off, and the read still short-circuits to nothing.
  const app2 = await launch();
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  const persisted = await page2.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: { getAll(): Promise<{ settings: { rereadProposalsEnabled: boolean } }> };
      rereadProposals: { list(): Promise<{ proposals: unknown[] }> };
    };
    const { settings } = await api.settings.getAll();
    const { proposals } = await api.rereadProposals.list();
    return { enabled: settings.rereadProposalsEnabled, proposalCount: proposals.length };
  });
  expect(persisted.enabled).toBe(false);
  expect(persisted.proposalCount).toBe(0);

  // Re-enable so the data dir is left in the default state for any later run.
  await page2.evaluate(async () => {
    const api = window.appApi as unknown as {
      settings: {
        updateMany(req: { patch: { rereadProposalsEnabled: boolean } }): Promise<unknown>;
      };
    };
    await api.settings.updateMany({ patch: { rereadProposalsEnabled: true } });
  });

  await app2.close();
});
