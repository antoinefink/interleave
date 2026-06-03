import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAnkiCollection, writeAnkiCollection } from "./anki-collection";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-anki-collection-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Anki collection read/write", () => {
  it("writes a minimal importable collection and reads notes, cards, revlog, and models back", () => {
    const filePath = path.join(dir, "collection.anki2");
    const models = {
      "100": {
        id: 100,
        name: "Basic",
        flds: [{ name: "Front" }, { name: "Back" }],
        tmpls: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{Back}}" }],
      },
    };

    writeAnkiCollection(
      filePath,
      {
        crt: 1_700_000_000,
        mod: 1_700_000_010,
        models: JSON.stringify(models),
        decks: "{}",
        dconf: "{}",
        conf: "{}",
      },
      [
        {
          id: 11,
          guid: "guid-11",
          mid: 100,
          mod: 1_700_000_020,
          tags: " interleave ",
          flds: "Question\u001fAnswer",
          sfld: "Question",
          csum: 1234,
        },
      ],
      [{ id: 22, nid: 11, did: 1, ord: 0, mod: 1_700_000_030 }],
      undefined,
    );

    const rows = readAnkiCollection(filePath, undefined);

    expect(rows.notes).toEqual([
      {
        id: 11,
        guid: "guid-11",
        mid: 100,
        tags: " interleave ",
        flds: "Question\u001fAnswer",
      },
    ]);
    expect(rows.cards).toEqual([
      { id: 22, nid: 11, due: 22, ivl: 0, factor: 0, reps: 0, lapses: 0 },
    ]);
    expect(rows.revlog).toEqual([]);
    expect(rows.models).toEqual(models);
  });

  it("tolerates missing revlog and malformed model JSON from older exports", () => {
    const filePath = path.join(dir, "legacy.anki2");
    const db = new Database(filePath);
    try {
      db.exec(`
        CREATE TABLE notes (id integer, guid text, mid integer, tags text, flds text);
        CREATE TABLE cards (id integer, nid integer, due integer, ivl integer, factor integer, reps integer, lapses integer);
        CREATE TABLE col (models text);
      `);
      db.prepare("INSERT INTO notes (id, guid, mid, tags, flds) VALUES (1, 'g', 2, '', 'F')").run();
      db.prepare(
        "INSERT INTO cards (id, nid, due, ivl, factor, reps, lapses) VALUES (3, 1, 4, 5, 6, 7, 8)",
      ).run();
      db.prepare("INSERT INTO col (models) VALUES ('not-json')").run();
    } finally {
      db.close();
    }

    const rows = readAnkiCollection(filePath, undefined);

    expect(rows.notes).toEqual([{ id: 1, guid: "g", mid: 2, tags: "", flds: "F" }]);
    expect(rows.cards).toEqual([{ id: 3, nid: 1, due: 4, ivl: 5, factor: 6, reps: 7, lapses: 8 }]);
    expect(rows.revlog).toEqual([]);
    expect(rows.models).toEqual({});
  });
});
