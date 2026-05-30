/**
 * Backup / export (T047) E2E — drives the real Electron app.
 *
 * The backup command captures the ENTIRE local knowledge base — the consistently
 * checkpointed `app.sqlite` + the filesystem asset vault + a versioned, hashed
 * `manifest.json` — into `backups/<timestamp>/` and a portable `.zip`, produced
 * entirely in the Electron main process and reached only through the typed
 * `window.appApi.backups.create` surface (no raw filesystem access in the
 * renderer, no generic `db.query`). This spec asserts the Definition of Done:
 *
 *   1. the `backups.*` bridge surface exists (no raw SQL);
 *   2. `/settings` → "Back up now" returns a `BackupResult` and the `.zip` exists
 *      on disk under the test `backups/` dir;
 *   3. the `.zip` unzips to `manifest.json` + `app.sqlite` + the seeded asset
 *      files, and every manifest `sha256` verifies against the bytes;
 *   4. the backup SURVIVES AN APP RESTART (it lives in the vault, outside the DB)
 *      and a second backup produces a DISTINCT timestamped archive.
 *
 * The renderer never touches SQLite — the backup rides the typed bridge; the test
 * itself (Node side) reads the produced files directly to verify integrity.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

let dataDir: string;

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
  // Seed a real asset file into the vault so the backup's recursive vault copy +
  // per-file hashing have a non-DB file to capture (the demo seed only writes
  // asset metadata rows, not bytes). The renderer never does this — the test does
  // it directly on disk before launch, mirroring a real source's snapshot asset.
  const assetDir = path.join(dataDir, "assets", "sources", "e2e-seed");
  fs.mkdirSync(assetDir, { recursive: true });
  fs.writeFileSync(path.join(assetDir, "snapshot.json"), '{"e2e":"asset"}');
});

/** Navigate to /settings through the real router (user-chip menu → Settings). */
async function gotoSettings(page: Page) {
  await page.getByTestId("user-chip").click();
  await page.getByRole("menuitem", { name: /^Settings$/ }).click();
  await expect(page.getByTestId("route-settings")).toBeVisible();
}

/**
 * The latest applied Drizzle migration tag — read from the staged `_journal.json`
 * (the same source of truth `DbService.getSchemaVersion` resolves against). Reading
 * it dynamically means this spec cannot re-rot when a later migration is added.
 */
function latestMigrationTag(): string {
  const journalPath = path.join(
    __dirname,
    "..",
    "..",
    "packages",
    "db",
    "drizzle",
    "meta",
    "_journal.json",
  );
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const latest = journal.entries.reduce((a, b) => (b.idx > a.idx ? b : a));
  return latest.tag;
}

/** The shape `backups.create()` returns. */
interface BackupResult {
  path: string;
  timestamp: string;
  sizeBytes: number;
  fileCount: number;
  schemaVersion: string;
}

test("the backups surface exists through window.appApi (no generic db.query)", async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      backups?: { create?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasCreate: typeof api?.backups?.create === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasCreate).toBe(true);
  expect(surface.hasQuery).toBe(false);

  await app.close();
});

test('/settings → "Back up now" produces a valid, hashed zip on disk', async () => {
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await gotoSettings(page);

  // Click the UI button + read the BackupResult the bridge returned (we re-issue
  // the bridge call to capture the structured result; the button path is the same
  // command, exercised for the UI affordance + spinner/result toast).
  await page.getByTestId("settings-backup-now").click();
  await expect(page.getByTestId("settings-backup-result")).toBeVisible({ timeout: 15_000 });

  const result = (await page.evaluate(async () => {
    const api = window.appApi as unknown as { backups: { create(): Promise<BackupResult> } };
    return api.backups.create();
  })) as BackupResult;

  expect(result.path.endsWith(".zip")).toBe(true);
  expect(result.sizeBytes).toBeGreaterThan(0);
  expect(result.fileCount).toBeGreaterThanOrEqual(2); // app.sqlite + ≥1 asset
  // The captured schema version is the live latest Drizzle migration tag. Assert it
  // against the source of truth (the last entry of the staged `_journal.json`) and a
  // shape guard rather than a hardcoded literal, so this can never re-rot when a later
  // migration is added (it previously pinned `0002_search_fts5`, which went stale once
  // migrations 0003–0005 landed).
  expect(result.schemaVersion).toMatch(/^\d{4}_/);
  expect(result.schemaVersion).toBe(latestMigrationTag());

  // The zip lives under the test data dir's backups/ — outside the DB.
  expect(result.path.startsWith(path.join(dataDir, "backups"))).toBe(true);
  expect(fs.existsSync(result.path)).toBe(true);

  // Unzip with the SYSTEM unzip (proves a standard, tool-readable archive) and
  // verify the canonical layout + every manifest hash.
  const unzipDir = fs.mkdtempSync(path.join(dataDir, "unzip-"));
  execFileSync("unzip", ["-q", result.path, "-d", unzipDir]);
  expect(fs.existsSync(path.join(unzipDir, "app.sqlite"))).toBe(true);
  expect(fs.existsSync(path.join(unzipDir, "manifest.json"))).toBe(true);
  expect(fs.existsSync(path.join(unzipDir, "assets", "sources", "e2e-seed", "snapshot.json"))).toBe(
    true,
  );

  const manifest = JSON.parse(fs.readFileSync(path.join(unzipDir, "manifest.json"), "utf8"));
  expect(manifest.formatVersion).toBe(1);
  // The manifest's schema version must match the BackupResult's (both come from the
  // same live migration-tag resolution) and the journal's latest tag — never a pinned
  // literal that rots on the next migration.
  expect(manifest.schemaVersion).toBe(result.schemaVersion);
  expect(manifest.schemaVersion).toBe(latestMigrationTag());
  expect(manifest.assetVaultRoot).toBe("assets");
  expect(manifest.counts.elements).toBeGreaterThan(0);
  expect(manifest.files[0].path).toBe("app.sqlite");
  for (const entry of manifest.files as { path: string; sha256: string; size: number }[]) {
    const bytes = fs.readFileSync(path.join(unzipDir, ...entry.path.split("/")));
    const recomputed = crypto.createHash("sha256").update(bytes).digest("hex");
    expect(entry.sha256).toBe(recomputed);
    expect(entry.size).toBe(bytes.length);
  }

  await app.close();
});

test("the backup persists across an app restart and a second backup is distinct", async () => {
  // The backups/ dir already holds at least one .zip from the prior test.
  const backupsDir = path.join(dataDir, "backups");
  const before = fs.readdirSync(backupsDir).filter((f) => f.endsWith(".zip"));
  expect(before.length).toBeGreaterThanOrEqual(1);

  // Relaunch a brand-new Electron process against the SAME data dir.
  const app = await launchApp(dataDir, { seedOnEmpty: true });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The prior backups still exist (they live on disk, outside the DB).
  const afterRestart = fs.readdirSync(backupsDir).filter((f) => f.endsWith(".zip"));
  expect(afterRestart.length).toBeGreaterThanOrEqual(before.length);

  // A new backup produces a DISTINCT, timestamped archive.
  const second = (await page.evaluate(async () => {
    const api = window.appApi as unknown as { backups: { create(): Promise<BackupResult> } };
    return api.backups.create();
  })) as BackupResult;
  expect(fs.existsSync(second.path)).toBe(true);
  expect(before).not.toContain(path.basename(second.path));

  await app.close();
});
