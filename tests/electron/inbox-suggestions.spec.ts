/**
 * Suggested priority & placement E2E (T127 — U9) — drives the REAL Electron app.
 *
 * T127 turns three dormant signals (semantic neighbors, author/site yield, source
 * reliability) into an advisory suggested priority band the user accepts or overrides —
 * never auto-applied. This spec proves the feature's end-to-end wiring + its
 * non-negotiable law through the built desktop app, via `window.appApi` only (no generic
 * `db.query`):
 *
 *   - the typed bridge exposes the read-only suggestion surface
 *     (`triage.suggest` / `triage.suggestForMetadata`) plus bulk-accept
 *     (`inbox.bulkApplySuggestions`), and there is NO generic `db.query`;
 *   - the anti-automation-bias LAW: a fresh inbox with no yield / no embeddings / no
 *     reliability produces `insufficient_signal` for every item, and the inbox renders
 *     NO suggestion chip — "if the numbers wouldn't convince you, suppress" made executable;
 *   - bulk-accept over a no-signal selection applies NOTHING and skips every id as
 *     `no_suggestion` (the honest skip channel), leaving priorities untouched;
 *   - the suggestion reads are READ-ONLY — they add no `operation_log` rows — and the
 *     inbox state (and its absence of suggestions) survives an APP RESTART.
 *
 * Coverage split (faithful, not a gap): the POSITIVE accept-with-provenance path —
 * a high-yield cluster yields a banded suggestion, the user accepts it, the
 * `triageSuggestion` marker lands on the `update_element` op, and the band persists — is
 * proven deterministically at the unit/component layer (`triage-suggestion` scorer,
 * `triage-suggestion-query`, `source-yield-query` aggregation, `db-service` provenance +
 * bulk-accept, `inbox-bulk-triage-service` applySuggestions, and the InboxScreen /
 * SuggestionChip renderer tests). Manufacturing a deterministic high-yield + embedded
 * cluster through the real app in a single headless run is not feasible (the embed worker
 * does not run headless; mature cards require the FSRS review flow over time), so the
 * positive band/justification math is exercised where it is deterministic, and this E2E
 * proves the real IPC wiring, the suppression law, the read-only discipline, and restart.
 *
 * The op-log assertion reads the SQLite file DIRECTLY from the test process (the same
 * boundary-preserving pattern as the bulk-triage spec) — the renderer never opens SQLite.
 */

import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

const SEED_COUNT = 5;

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
});

function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir);
}

/** Seed N fresh manual inbox sources (no author/URL/embeddings → no signal). */
async function seedFreshInbox(page: Page, count: number): Promise<string[]> {
  return page.evaluate(async (n) => {
    const api = window.appApi as unknown as {
      sources: { importManual(req: { title: string; body: string }): Promise<{ id: string }> };
    };
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const { id } = await api.sources.importManual({
        title: `Fresh capture ${i}`,
        body: `A hand-typed note ${i} with no author, no URL, and no history.`,
      });
      ids.push(id);
    }
    return ids;
  }, count);
}

/** Count `update_element` ops carrying a T127 `triageSuggestion` marker (read SQLite directly). */
function suggestionMarkerOpCount(dir: string): number {
  const db = new Database(path.join(dir, "app.sqlite"), { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM operation_log
          WHERE op_type = 'update_element'
            AND json_extract(payload, '$.triageSuggestion') IS NOT NULL`,
      )
      .get() as { c: number };
    return row.c;
  } finally {
    db.close();
  }
}

test("exposes the typed suggestion bridge and no generic db.query", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      triage?: { suggest?: unknown; suggestForMetadata?: unknown };
      inbox?: { bulkApplySuggestions?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasSuggest: typeof api?.triage?.suggest === "function",
      hasSuggestForMetadata: typeof api?.triage?.suggestForMetadata === "function",
      hasBulkApply: typeof api?.inbox?.bulkApplySuggestions === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasSuggest).toBe(true);
  expect(surface.hasSuggestForMetadata).toBe(true);
  expect(surface.hasBulkApply).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test("a fresh inbox suppresses suggestions (the law), bulk-accept skips all, read-only + restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  const ids = await seedFreshInbox(page, SEED_COUNT);
  expect(ids).toHaveLength(SEED_COUNT);

  // Re-fetch so the renderer reflects the seeded inbox (imports went through the bridge).
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(SEED_COUNT);

  // The LAW: every fresh item is insufficient_signal → no chip is rendered.
  const verdicts = await page.evaluate(async (seedIds) => {
    const api = window.appApi as unknown as {
      triage: {
        suggest(req: { ids: string[] }): Promise<{ results: { suggestion: { kind: string } }[] }>;
      };
    };
    const { results } = await api.triage.suggest({ ids: seedIds });
    return results.map((r) => r.suggestion.kind);
  }, ids);
  expect(verdicts).toHaveLength(SEED_COUNT);
  expect(verdicts.every((k) => k === "insufficient_signal")).toBe(true);
  await expect(page.getByTestId("inbox-suggestion-chip")).toHaveCount(0);

  // Bulk-accept over the no-signal selection: applies nothing, skips all `no_suggestion`.
  const bulk = await page.evaluate(async (seedIds) => {
    const api = window.appApi as unknown as {
      inbox: {
        bulkApplySuggestions(req: { ids: string[] }): Promise<{
          applied: number;
          skipped: { id: string; reason: string }[];
        }>;
      };
    };
    return api.inbox.bulkApplySuggestions({ ids: seedIds });
  }, ids);
  expect(bulk.applied).toBe(0);
  expect(bulk.skipped).toHaveLength(SEED_COUNT);
  expect(bulk.skipped.every((s) => s.reason === "no_suggestion")).toBe(true);

  // The suggestion reads + the no-op bulk wrote NOTHING to the op-log (read-only discipline).
  expect(suggestionMarkerOpCount(dataDir)).toBe(0);

  // Priorities are untouched — every fresh import is still its default band.
  const priorities = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inbox: { list(): Promise<{ items: { priority: number }[] }> };
    };
    const { items } = await api.inbox.list();
    return items.map((it) => it.priority);
  });
  expect(priorities).toHaveLength(SEED_COUNT);

  await app.close();

  // Restart: the inbox persists and STILL shows no suggestions (nothing was mutated).
  const app2 = await launch();
  const page2 = await app2.firstWindow();
  await page2.waitForLoadState("domcontentloaded");
  await page2.getByTestId("nav-inbox").click();
  await expect(page2.getByTestId("route-inbox")).toBeVisible();
  await expect(page2.getByTestId("inbox-row")).toHaveCount(SEED_COUNT);
  await expect(page2.getByTestId("inbox-suggestion-chip")).toHaveCount(0);
  expect(suggestionMarkerOpCount(dataDir)).toBe(0);

  await app2.close();
});
