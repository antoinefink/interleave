/**
 * AnkiImportService integration tests (T070) — against a real temp-file SQLite DB +
 * a temp `assetsDir`, importing a `.apkg` built IN-TEST (via `writeAnkiCollection` +
 * `buildApkgZip`) so no binary blob is committed. No Electron is involved — the
 * service is built through `DbService` (the same accessor the IPC layer uses).
 *
 * Proves: importing creates a per-deck `source` + N `card` elements (Basic → qa,
 * Cloze → cloze) with the right ops; a note WITH scheduling carries `reps`/`lapses` +
 * a seeded `stability`/`difficulty` + a preserved `dueAt` into `review_states` (and
 * `withHistory` counts it); a note WITHOUT scheduling imports as a new un-due-now card;
 * NO fabricated `review_logs` (the honest mapping); the imported `.apkg` lands in the
 * vault as an `import_archive`; and the cards + states survive re-opening the DB.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { buildApkgZip, ANKI_FIELD_SEPARATOR as SEP } from "@interleave/importers";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAnkiCollection } from "./anki-collection";
import { AnkiImportError } from "./anki-import-service";
import { DbService } from "./db-service";

let dir: string;
let dbPath: string;
let assetsDir: string;
let exportDestinationDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-ankiimp-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  exportDestinationDir = path.join(dir, "downloads");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(exportDestinationDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function openSvc(): DbService {
  const svc = new DbService();
  svc.open(dbPath, { migrationsDir: MIGRATIONS_DIR, assetsDir, exportDestinationDir });
  return svc;
}

/** The minimal Basic + Cloze `col.models` JSON the fixture collection ships. */
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

/**
 * Build a fixture `.apkg` on disk: a Basic note WITH scheduling (reps/lapses/interval),
 * a Cloze note WITHOUT scheduling, and the minimal `col`. We author the collection.anki2
 * with the same `writeAnkiCollection` helper the EXPORT uses, then hand-insert the test
 * notes/cards via a second raw SQLite open (kept simple here in-test).
 */
function buildFixtureApkg(): string {
  const collectionPath = path.join(dir, "fixture-collection.anki2");
  // Author an empty-but-valid collection, then insert our test notes/cards directly.
  writeAnkiCollection(
    collectionPath,
    { crt: 1700000000, mod: 1700000000, models: MODELS_JSON, decks: "{}", dconf: "{}", conf: "{}" },
    [],
    [],
    undefined,
  );
  // Insert the test notes + cards with a raw better-sqlite3 handle.
  // (Default Node-ABI binding is fine in Vitest.)
  const db = new Database(collectionPath);
  db.prepare(
    "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    100,
    "g-basic",
    1,
    1700000000,
    -1,
    " geo ",
    `Capital of France?${SEP}<b>Paris</b>`,
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
  // The Basic note has a card WITH scheduling history (reps 7, lapses 2, interval 30).
  db.prepare(
    "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(100, 100, 1, 0, 1700000000, -1, 2, 2, 5, 30, 2100, 7, 2, 0, 0, 0, 0, "");
  // The Cloze note has NO card row ⇒ no scheduling ⇒ imports as a new card.
  db.close();

  const collectionBytes = new Uint8Array(fs.readFileSync(collectionPath));
  // Ship one media file: a tiny 1x1 PNG, mapped from archive entry "0" → "pic.png".
  // (Anki packs media as NUMBERED files keyed to original names via the `media` map.)
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89,
  ]);
  const apkg = buildApkgZip({
    collectionBytes,
    media: { "0": "pic.png" },
    mediaFiles: { "0": pngBytes },
  });
  const apkgPath = path.join(dir, "deck.apkg");
  fs.writeFileSync(apkgPath, Buffer.from(apkg));
  return apkgPath;
}

describe("AnkiImportService.importFromFile (T070)", () => {
  it("imports Basic→qa + Cloze→cloze under a per-deck source, carrying history honestly", async () => {
    const svc = openSvc();
    const apkg = buildFixtureApkg();
    const result = await svc.ankiImportService.importFromFile({ absPath: apkg });

    expect(result.status).toBe("imported");
    expect(result.deckCount).toBe(1);
    expect(result.cardCount).toBe(2);
    expect(result.withHistory).toBe(1); // only the Basic note had scheduling.
    expect(result.item.type).toBe("source");
    expect(result.item.status).toBe("inbox");

    const deckId = result.item.id;
    // A per-deck lineage-root source ("Imported Anki deck: deck").
    const deck = svc.repos.sources.findById(deckId as never);
    expect(deck?.element.type).toBe("source");
    expect(deck?.element.title).toContain("Imported Anki deck");

    // Two card children under the deck.
    const children = svc.repos.elements.listByType("card");
    expect(children).toHaveLength(2);
    const qa = children.find((c) => svc.repos.review.findCardById(c.id)?.card.kind === "qa");
    const cloze = children.find((c) => svc.repos.review.findCardById(c.id)?.card.kind === "cloze");
    expect(qa).toBeDefined();
    expect(cloze).toBeDefined();

    // Both cards point back to the deck source (never orphaned) + carry a sourceUri.
    const qaCard = svc.repos.review.findCardById(qa?.id as never);
    expect(qaCard?.element.sourceId).toBe(deckId);
    expect(qaCard?.card.prompt).toBe("Capital of France?");
    expect(qaCard?.card.answer).toBe("Paris"); // field HTML stripped.
    expect(qaCard?.card.sourceUri).toContain("Anki deck");
    // A card carrying real review history lands ACTIVE (in the Library deck facet),
    // not parked as "pending" — it already has a schedule + counters.
    expect(qaCard?.element.status).toBe("active");
    expect(qaCard?.element.stage).toBe("active_card");

    const clozeCard = svc.repos.review.findCardById(cloze?.id as never);
    expect(clozeCard?.card.cloze).toBe("The capital is {{c1::Paris}}.");

    // The Basic card carried scheduling: reps/lapses + a SEEDED stability/difficulty + due.
    const qaState = svc.repos.review.findReviewState(qa?.id as never);
    expect(qaState?.reps).toBe(7);
    expect(qaState?.lapses).toBe(2);
    expect(qaState?.fsrsState).toBe("review");
    // stability ≈ the 30-day interval; difficulty seeded in [1,10].
    expect(qaState?.stability).toBeGreaterThanOrEqual(1);
    expect(qaState?.difficulty).toBeGreaterThan(1);
    expect(qaState?.difficulty).toBeLessThanOrEqual(10);
    expect(qaState?.dueAt).not.toBeNull();

    // The Cloze card imported as a NEW card (no scheduling): fsrs new, due now.
    const clozeState = svc.repos.review.findReviewState(cloze?.id as never);
    expect(clozeState?.fsrsState).toBe("new");
    expect(clozeState?.reps).toBe(0);
    // A freshly first-scheduled import is also ACTIVE (placed in the deck, due now) —
    // not parked "pending".
    expect(cloze && svc.repos.review.findCardById(cloze.id)?.element.status).toBe("active");

    // NO fabricated historical review_logs — the grading history stays truthful.
    expect(svc.repos.review.listReviewLogs(qa?.id as never)).toHaveLength(0);

    // The imported .apkg lands in the vault as an import_archive.
    const archive = svc.repos.assets
      .listForElement(deckId as never)
      .find((a) => a.kind === "import_archive");
    expect(archive).toBeDefined();
    expect(
      fs.existsSync(path.join(assetsDir, archive?.location.vaultPath.relativePath ?? "")),
    ).toBe(true);

    // The deck's media file is extracted into the vault as an addressable `image` asset
    // owned by the deck source, with its ORIGINAL filename preserved in the path.
    const image = svc.repos.assets.listForElement(deckId as never).find((a) => a.kind === "image");
    expect(image).toBeDefined();
    expect(image?.location.vaultPath.relativePath).toContain("pic.png");
    expect(fs.existsSync(path.join(assetsDir, image?.location.vaultPath.relativePath ?? ""))).toBe(
      true,
    );

    svc.close();
  });

  it("survives an app restart (cards + states persist after re-open)", async () => {
    let svc = openSvc();
    const apkg = buildFixtureApkg();
    await svc.ankiImportService.importFromFile({ absPath: apkg });
    svc.close();

    // Re-open the SAME DB file (a fresh DbService / repositories).
    svc = openSvc();
    const cards = svc.repos.elements.listByType("card");
    expect(cards).toHaveLength(2);
    const withHistory = cards.filter((c) => {
      const state = svc.repos.review.findReviewState(c.id);
      return (state?.reps ?? 0) > 0;
    });
    expect(withHistory).toHaveLength(1);
    svc.close();
  });

  it("rejects a non-.apkg path with a typed error", async () => {
    const svc = openSvc();
    await expect(
      svc.ankiImportService.importFromFile({ absPath: path.join(dir, "notes.txt") }),
    ).rejects.toBeInstanceOf(AnkiImportError);
    svc.close();
  });

  it("rejects an empty deck (no notes) with a typed empty_collection error", async () => {
    const svc = openSvc();
    // An empty-but-valid collection ⇒ zero notes.
    const collectionPath = path.join(dir, "empty.anki2");
    writeAnkiCollection(
      collectionPath,
      { crt: 1, mod: 1, models: MODELS_JSON, decks: "{}", dconf: "{}", conf: "{}" },
      [],
      [],
      undefined,
    );
    const collectionBytes = new Uint8Array(fs.readFileSync(collectionPath));
    const apkgPath = path.join(dir, "empty.apkg");
    fs.writeFileSync(
      apkgPath,
      Buffer.from(buildApkgZip({ collectionBytes, media: {}, mediaFiles: {} })),
    );
    await expect(svc.ankiImportService.importFromFile({ absPath: apkgPath })).rejects.toMatchObject(
      {
        code: "empty_collection",
      },
    );
    svc.close();
  });
});
