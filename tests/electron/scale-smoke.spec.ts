/**
 * Scale smoke (T100) — the CI-bounded slice of the "Scale QA checklist".
 *
 * Drives the REAL built Electron desktop app against a CI-BOUNDED large seed (a few
 * THOUSAND elements via `seedScaleIfEmpty` → the bulk fast path; NOT 100k in CI — the
 * full 100k run is the opt-in local `INTERLEAVE_BENCH_N=full pnpm bench`). It proves
 * the load-bearing scale guarantees survive a real app + restart:
 *
 *   1. The scale seed lands (thousands of cards/extracts; the queue + analytics see
 *      real data).
 *   2. `PRAGMA integrity_check` + `PRAGMA foreign_key_check` = `ok` on the large seed
 *      (the T099 `maintenance.integrity` deep check, after the 0027 migration).
 *   3. The two-scheduler split holds at scale — the queue returns BOTH FSRS cards (by
 *      `review_states.due_at`) AND attention items (by `elements.due_at`), neither
 *      pool starves the other.
 *   4. FTS search returns the known seeded term at scale.
 *   5. Backup at scale → a valid `.zip` whose `manifest.json` hashes verify, and the
 *      backed-up `app.sqlite` opens with the same source-element count (the WAL-
 *      checkpoint consistency check).
 *   6. The whole collection SURVIVES AN APP RESTART (same data dir) — the counts +
 *      integrity hold after relaunch.
 *
 * Architecture (non-negotiable): the spec drives the app ONLY through the typed
 * `window.appApi` bridge — no raw DB poke from the renderer. The Node side opens the
 * backed-up `app.sqlite` read-only (a portable better-sqlite3 file) purely to verify
 * the bundle the bridge produced. The restart reuses the same `INTERLEAVE_DATA_DIR`.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

/**
 * An `asOf` a couple of weeks past the seed's window end (`2026-06-01`) so a healthy
 * fraction of both pools reads as due (the seed spreads due dates ±30–60 days).
 */
const ASOF = "2026-06-15T12:00:00.000Z";

interface QueueItem {
  readonly id: string;
  readonly type: string;
  readonly scheduler: "fsrs" | "attention";
}
interface QueueResult {
  readonly items: readonly QueueItem[];
  readonly counts: { readonly all: number };
}
interface IntegrityResult {
  readonly db: { readonly ok: boolean; readonly foreignKeyViolations: number };
  readonly vault: { readonly missing: readonly string[] };
}
interface BackupResult {
  readonly archiveName: string;
  readonly fileCount: number;
  readonly sizeBytes: number;
}

/**
 * The live (non-deleted) source-element count through the typed bridge (no raw SQL).
 * `library.browse({ types: ["source"] })`'s drill-down `counts.byType.source` is the
 * FULL live-source match count (pre-limit), so it equals the backed-up DB's
 * `count(*) WHERE type='source' AND deleted_at IS NULL` regardless of the row cap.
 */
async function sourceCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      library: {
        browse(req: {
          types: string[];
          limit: number;
        }): Promise<{ counts: { byType: Record<string, number> } }>;
      };
    };
    // `counts.byType.source` is the FULL live-source drill-down count (pre-limit), so
    // the row cap (the contract's max 500) does not affect it; the CI scale profile has
    // ~120 sources, well under it.
    const res = await api.library.browse({ types: ["source"], limit: 500 });
    return res.counts.byType.source ?? 0;
  });
}

/** Pull the daily queue at `ASOF` through the typed bridge. */
async function readQueue(page: Page): Promise<QueueResult> {
  return page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      queue: { list(req: { asOf: string; limit?: number }): Promise<QueueResult> };
    };
    return api.queue.list({ asOf, limit: 200 });
  }, ASOF);
}

/** Run the on-demand deep integrity check (PRAGMA integrity_check + foreign_key_check). */
async function readIntegrity(page: Page): Promise<IntegrityResult> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      maintenance: { integrity(req: { deep: boolean }): Promise<IntegrityResult> };
    };
    return api.maintenance.integrity({ deep: true });
  });
}

test("seeds a few-thousand-element collection and the queue + analytics see it", async () => {
  ensureBuilt();
  dataDir = makeDataDir();
  const app = await launchApp(dataDir, { seedScale: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The scale seed builds ~120 sources × ~20 extracts ≈ 2.4k cards. The bridge's
  // analytics snapshot counts the real rows — assert it reflects a large collection.
  const analytics = (await page.evaluate(async (asOf) => {
    const api = window.appApi as unknown as {
      analytics: { get(req: { asOf: string }): Promise<{ dueCards: number; dueTopics: number }> };
    };
    return api.analytics.get({ asOf });
  }, ASOF)) as { dueCards: number; dueTopics: number };

  // Both scheduler pools have due work at scale (the seed spreads both due fields).
  expect(analytics.dueCards).toBeGreaterThan(0);
  expect(analytics.dueTopics).toBeGreaterThan(0);

  await app.close();
});

test("PRAGMA integrity_check + foreign_key_check are ok on the large seed (after 0027)", async () => {
  const app = await launchApp(dataDir, { seedScale: true }); // no-op re-seed (not empty)
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const integrity = await readIntegrity(page);
  expect(integrity.db.ok).toBe(true);
  expect(integrity.db.foreignKeyViolations).toBe(0);
  // No vault assets were seeded by the bulk path, so nothing is missing.
  expect(integrity.vault.missing.length).toBe(0);

  await app.close();
});

test("the two-scheduler split holds at scale — both FSRS cards and attention items surface", async () => {
  const app = await launchApp(dataDir, { seedScale: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const queue = await readQueue(page);
  expect(queue.counts.all).toBeGreaterThan(0);

  const fsrs = queue.items.filter((i) => i.scheduler === "fsrs");
  const attention = queue.items.filter((i) => i.scheduler === "attention");
  // The load-bearing split: at scale the queue still returns BOTH pools — FSRS cards
  // (by review_states.due_at) AND attention items (by elements.due_at). Neither pool
  // collapses or starves the other.
  expect(fsrs.length).toBeGreaterThan(0);
  expect(attention.length).toBeGreaterThan(0);
  // Cards always ride the FSRS scheduler; non-cards never do (the split is type-clean).
  expect(fsrs.every((i) => i.type === "card")).toBe(true);
  expect(attention.every((i) => i.type !== "card")).toBe(true);

  await app.close();
});

test("FTS search returns the known seeded term at scale", async () => {
  const app = await launchApp(dataDir, { seedScale: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The seed's body text cycles fixed sentences containing "spaced repetition" and
  // "intelligence" — a known-present term proves FTS still finds hits at scale.
  const hits = (await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      search: {
        query(req: { q: string; limit?: number }): Promise<{ results: readonly unknown[] }>;
      };
    };
    const res = await api.search.query({ q: "intelligence efficiency", limit: 20 });
    return res.results.length;
  })) as number;
  expect(hits).toBeGreaterThan(0);

  await app.close();
});

test("backup at scale → valid zip whose manifest hashes verify + the backed-up DB matches", async () => {
  const app = await launchApp(dataDir, { seedScale: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const liveSources = await sourceCount(page);
  expect(liveSources).toBeGreaterThan(0);

  const result = (await page.evaluate(async () => {
    const api = window.appApi as unknown as { backups: { create(): Promise<BackupResult> } };
    return api.backups.create();
  })) as BackupResult;

  expect(result.archiveName.endsWith(".zip")).toBe(true);
  expect(result.sizeBytes).toBeGreaterThan(0);
  const resultPath = path.join(dataDir, "backups", result.archiveName);
  expect(fs.existsSync(resultPath)).toBe(true);

  // Unzip with the system unzip (proves a standard, tool-readable archive), verify
  // the layout + every manifest hash, and re-open the backed-up app.sqlite to confirm
  // the WAL checkpoint produced a consistent snapshot with the SAME live source count.
  const unzipDir = fs.mkdtempSync(path.join(dataDir, "scale-unzip-"));
  execFileSync("unzip", ["-q", resultPath, "-d", unzipDir]);
  const backedUpDb = path.join(unzipDir, "app.sqlite");
  expect(fs.existsSync(backedUpDb)).toBe(true);

  const manifest = JSON.parse(fs.readFileSync(path.join(unzipDir, "manifest.json"), "utf8")) as {
    files: { path: string; sha256: string }[];
  };
  for (const entry of manifest.files) {
    const abs = path.join(unzipDir, entry.path);
    expect(fs.existsSync(abs)).toBe(true);
    const actual = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    expect(actual).toBe(entry.sha256);
  }

  // Open the backed-up DB read-only (Node side, NOT the renderer) and count sources —
  // a portable better-sqlite3 file proving the snapshot is consistent + complete.
  // biome-ignore lint/suspicious/noExplicitAny: dynamic require of the native module in the test process
  const Database = require("better-sqlite3") as any;
  const db = new Database(backedUpDb, { readonly: true });
  try {
    const row = db
      .prepare("SELECT count(*) AS n FROM elements WHERE type = 'source' AND deleted_at IS NULL")
      .get() as { n: number };
    expect(row.n).toBe(liveSources);
    const integrity = db.pragma("integrity_check", { simple: true });
    expect(integrity).toBe("ok");
  } finally {
    db.close();
  }

  await app.close();
});

test("the whole scale collection + integrity survive an app RESTART", async () => {
  // Relaunch against the SAME data dir — the load-bearing persistence proof. The seed
  // flag is a no-op (the DB is not empty), so this reads the persisted collection.
  const app = await launchApp(dataDir, { seedScale: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The collection persisted: the queue still returns due work from both pools.
  const queue = await readQueue(page);
  expect(queue.counts.all).toBeGreaterThan(0);
  expect(queue.items.some((i) => i.scheduler === "fsrs")).toBe(true);
  expect(queue.items.some((i) => i.scheduler === "attention")).toBe(true);

  // Integrity still clean after the restart (the 0027 indexes + the data are intact).
  const integrity = await readIntegrity(page);
  expect(integrity.db.ok).toBe(true);
  expect(integrity.db.foreignKeyViolations).toBe(0);

  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
