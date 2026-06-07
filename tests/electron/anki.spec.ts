/**
 * Anki import/export E2E (T070) — drives the real Electron app end to end, on-device.
 *
 * The native `.apkg` picker is stubbed via `INTERLEAVE_ANKI_IMPORT_PATH` (honored only
 * in the unpackaged build — mirrors the EPUB escape), pointed at a fixture `.apkg`
 * BUILT in `beforeAll` (a Basic + a Cloze note, the Basic with scheduling history)
 * using `better-sqlite3` + `fflate` so no binary blob is committed. The spec proves:
 *
 *   1. the "Import file…" chip → modal → Anki tab → "Choose .apkg…" → MAIN unwraps the
 *      ZIP + reads the embedded collection + authors the notes as `card` elements under
 *      a per-deck `source` (the deck, NOT N rows, lands in the inbox);
 *   2. the imported cards appear in the review deck (one is reviewable);
 *   3. exporting a selection back to `.apkg` or CSV writes a file into Downloads;
 *   4. after an APP RESTART against the same data dir, the deck + cards survive.
 *
 * The renderer reaches all of this only through `window.appApi` — no fs/SQL.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import Database from "better-sqlite3";
import { strToU8, unzipSync, zipSync } from "fflate";
import { ensureBuilt, launchApp, makeDataDir } from "./launch";

test.describe.configure({ mode: "serial" });

const SEP = "\x1f";
let dataDir: string;
let fixtureDir: string;
let apkgPath: string;

/** The minimal Basic + Cloze models JSON the fixture collection ships. */
const MODELS_JSON = JSON.stringify({
  "1": {
    id: 1,
    name: "Basic",
    type: 0,
    flds: [
      { name: "Front", ord: 0 },
      { name: "Back", ord: 1 },
    ],
  },
  "2": {
    id: 2,
    name: "Cloze",
    type: 1,
    flds: [
      { name: "Text", ord: 0 },
      { name: "Back Extra", ord: 1 },
    ],
  },
});

/** Build a fixture `.apkg` on disk (a Basic note WITH scheduling + a Cloze note). */
function buildFixtureApkg(dir: string): string {
  const collectionPath = path.join(dir, "collection.anki2");
  const db = new Database(collectionPath);
  db.exec(`
    CREATE TABLE col (id integer PRIMARY KEY, crt integer, mod integer, scm integer, ver integer,
      dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notes (id integer PRIMARY KEY, guid text, mid integer, mod integer, usn integer,
      tags text, flds text, sfld integer, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer PRIMARY KEY, nid integer, did integer, ord integer, mod integer,
      usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer,
      lapses integer, left integer, odue integer, odid integer, flags integer, data text);
    CREATE TABLE revlog (id integer PRIMARY KEY, cid integer, usn integer, ease integer, ivl integer,
      lastIvl integer, factor integer, time integer, type integer);
    CREATE TABLE graves (usn integer, oid integer, type integer);
  `);
  db.prepare(
    "INSERT INTO col VALUES (1, 1700000000, 1700000000, 1700000000, 11, 0, 0, 0, '{}', ?, '{}', '{}', '{}')",
  ).run(MODELS_JSON);
  db.prepare(
    "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    100,
    "g-basic",
    1,
    1700000000,
    -1,
    " geo ",
    `Capital of France?${SEP}Paris`,
    "Capital of France?",
    0,
    0,
    "",
  );
  db.prepare(
    "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    200,
    "g-cloze",
    2,
    1700000000,
    -1,
    "",
    `The capital is {{c1::Paris}}.${SEP}`,
    "The capital is",
    0,
    0,
    "",
  );
  db.prepare(
    "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(100, 100, 1, 0, 1700000000, -1, 2, 2, 5, 30, 2100, 7, 2, 0, 0, 0, 0, "");
  db.close();

  const collectionBytes = new Uint8Array(fs.readFileSync(collectionPath));
  // A tiny 1x1 PNG packed as numbered media entry "0" → original name "pic.png".
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ]);
  const apkg = zipSync({
    "collection.anki2": collectionBytes,
    media: strToU8(JSON.stringify({ "0": "pic.png" })),
    "0": png,
  });
  const out = path.join(dir, "deck.apkg");
  fs.writeFileSync(out, Buffer.from(apkg));
  return out;
}

test.beforeAll(() => {
  ensureBuilt();
  dataDir = makeDataDir();
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-anki-fixture-"));
  apkgPath = buildFixtureApkg(fixtureDir);
});

test.afterAll(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

/** Launch the app with the Anki picker stubbed to the fixture. */
async function launch(): Promise<ElectronApplication> {
  return launchApp(dataDir, { ankiImportPath: apkgPath });
}

/** The number of live `card` elements via the bridge. */
async function cardCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { type: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.filter((e) => e.type === "card").length;
  });
}

/** The statuses of the live `card` elements via the bridge. */
async function cardStatuses(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = window.appApi as unknown as {
      inspector: { list(): Promise<{ elements: { type: string; status: string }[] }> };
    };
    const { elements } = await api.inspector.list();
    return elements.filter((e) => e.type === "card").map((e) => e.status);
  });
}

test("the bridge exposes cards.importAnki + exportAnki (not raw SQL)", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const surface = await page.evaluate(() => {
    const api = window.appApi as unknown as {
      cards?: { importAnki?: unknown; exportAnki?: unknown };
      db?: { query?: unknown };
    };
    return {
      hasImport: typeof api?.cards?.importAnki === "function",
      hasExport: typeof api?.cards?.exportAnki === "function",
      hasQuery: typeof api?.db?.query === "function",
    };
  });
  expect(surface.hasImport).toBe(true);
  expect(surface.hasExport).toBe(true);
  expect(surface.hasQuery).toBe(false);
  await app.close();
});

test("importing an .apkg lands a deck source with cards, then exports back to .apkg", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();

  // Open the Import-file modal, switch to the Anki tab, choose + import.
  await page.getByTestId("inbox-import-import-file").click();
  await expect(page.getByTestId("import-file-modal")).toBeVisible();
  await page.getByTestId("import-file-kind-anki").click();
  await page.getByTestId("import-file-choose").click();
  await expect(page.getByTestId("import-file-chosen")).toContainText("deck.apkg");
  await page.getByTestId("import-file-submit").click();

  // A success summary surfaces the counts (2 cards, 1 with scheduling).
  await expect(page.getByTestId("import-file-success")).toContainText("Imported 2 cards", {
    timeout: 20_000,
  });

  // Two card elements were authored under the per-deck source.
  expect(await cardCount(page)).toBe(2);

  // Both imported cards land ACTIVE (in the Library deck facet) — the card WITH review
  // history is not parked as "pending", and the fresh card is placed in the deck too.
  const statuses = await cardStatuses(page);
  expect(statuses).toHaveLength(2);
  expect(statuses.every((s) => s === "active")).toBe(true);

  // The deck's media file was extracted into the vault as an addressable asset (its
  // original filename preserved under the deck source's media dir).
  const sourcesDir = path.join(dataDir, "assets", "sources");
  const mediaHit = fs
    .readdirSync(sourcesDir)
    .flatMap((deckDir) => {
      const mediaDir = path.join(sourcesDir, deckDir, "media");
      return fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir) : [];
    })
    .some((f) => f.includes("pic.png"));
  expect(mediaHit).toBe(true);

  const downloadsDir = path.join(dataDir, "downloads");

  // Export ALL cards back to an .apkg via the bridge; the file lands in Downloads.
  const exported = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      cards: {
        exportAnki(req: { format: string; all: boolean }): Promise<{
          relativePath: string;
          directoryLabel: "Downloads";
          cardCount: number;
          absPath?: string;
        }>;
      };
    };
    return api.cards.exportAnki({ format: "apkg", all: true });
  });
  expect(exported.cardCount).toBe(2);
  expect(exported).not.toHaveProperty("absPath");
  expect(exported.directoryLabel).toBe("Downloads");
  expect(exported.relativePath.endsWith(".apkg")).toBe(true);
  const exportedApkgPath = path.join(downloadsDir, exported.relativePath);
  expect(fs.existsSync(exportedApkgPath)).toBe(true);
  const exportedApkg = unzipSync(new Uint8Array(fs.readFileSync(exportedApkgPath)));
  expect(exportedApkg["collection.anki2"]?.byteLength ?? 0).toBeGreaterThan(0);

  const exportedCsv = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      cards: {
        exportAnki(req: { format: string; all: boolean }): Promise<{
          relativePath: string;
          directoryLabel: "Downloads";
          cardCount: number;
          absPath?: string;
        }>;
      };
    };
    return api.cards.exportAnki({ format: "csv", all: true });
  });
  expect(exportedCsv.cardCount).toBe(2);
  expect(exportedCsv).not.toHaveProperty("absPath");
  expect(exportedCsv.directoryLabel).toBe("Downloads");
  expect(exportedCsv.relativePath.endsWith(".csv")).toBe(true);
  const exportedCsvPath = path.join(downloadsDir, exportedCsv.relativePath);
  expect(fs.existsSync(exportedCsvPath)).toBe(true);
  const csv = fs.readFileSync(exportedCsvPath, "utf8");
  expect(csv.split("\n")[0]).toBe("Front,Back,Cloze,Tags,Source");
  expect(csv).toContain("Capital of France?");
  expect(csv).toContain("Paris");
  expect(csv).toContain("The capital is {{c1::Paris}}.");

  await app.close();
});

test("an imported card is reviewable in the deck", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // The review deck surfaces at least one of the imported cards.
  const next = await page.evaluate(async () => {
    const api = window.appApi as unknown as {
      review: { sessionNext(req?: unknown): Promise<{ card: { id: string } | null }> };
    };
    const { card } = await api.review.sessionNext({});
    return card?.id ?? null;
  });
  expect(next).not.toBeNull();

  await app.close();
});

test("the deck + cards survive an app restart", async () => {
  const app = await launch();
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Still ONE inbox deck source + 2 cards after restart.
  await page.getByTestId("nav-inbox").click();
  await expect(page.getByTestId("route-inbox")).toBeVisible();
  await expect(page.getByTestId("inbox-row")).toHaveCount(1);
  await expect(page.getByTestId("inbox-preview-title")).toContainText("Imported Anki deck");
  expect(await cardCount(page)).toBe(2);

  await app.close();
});
