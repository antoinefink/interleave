/**
 * `sqlite-vec` load + KNN tests (T087).
 *
 * Prove the low-level vec0 contract `@interleave/db` exposes: `loadVectorExtension`
 * loads the extension into a Node `better-sqlite3` handle, the `vecFunctional`
 * smoke test confirms `vec0` actually works (the source of truth for
 * `vecAvailable`), and a `vec0` table accepts a fixed-dimension insert + a KNN MATCH
 * returns the nearest by distance.
 *
 * The whole suite is gated on `vecFunctional` (NOT mere resolvability), so on an
 * ABI-mismatched host where the binary resolves + loads but registers no `vec0`
 * functions, the suite SKIPS with a clear message rather than failing inside a
 * `vec0` query it assumed worked. CI/dev pass the smoke test, so the path runs.
 */

import { EMBEDDING_DIM } from "@interleave/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { loadVectorExtension, vecFunctional, vectorToBlob } from "./vec";

/** Probe vec availability once (so the suite skips cleanly when vec0 is non-functional). */
const VEC_OK = (() => {
  const db = new Database(":memory:");
  loadVectorExtension(db);
  const ok = vecFunctional(db);
  db.close();
  if (!ok) {
    console.warn(
      "[vec.test] skipping: sqlite-vec vec0 not functional on this host (ABI mismatch) — FTS-only",
    );
  }
  return ok;
})();

describe("loadVectorExtension never throws on a missing binary", () => {
  it("returns false (not throws) for an obviously bad explicit path", () => {
    const db = new Database(":memory:");
    expect(loadVectorExtension(db, "/no/such/vec0.dylib")).toBe(false);
    db.close();
  });
});

describe.skipIf(!VEC_OK)("sqlite-vec vec0 (T087)", () => {
  it("loads + passes the functional smoke test", () => {
    const db = new Database(":memory:");
    expect(loadVectorExtension(db)).toBe(true);
    expect(vecFunctional(db)).toBe(true);
    db.close();
  });

  it("accepts a fixed-dimension insert and returns the nearest by distance via KNN MATCH", () => {
    const db = new Database(":memory:");
    loadVectorExtension(db);
    db.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding float[${EMBEDDING_DIM}])`);

    // Two distinct vectors; the query is identical to the first → it must rank #1.
    const a = new Array(EMBEDDING_DIM).fill(0).map((_, i) => (i < 8 ? 1 : 0));
    const b = new Array(EMBEDDING_DIM).fill(0).map((_, i) => (i >= EMBEDDING_DIM - 8 ? 1 : 0));
    db.prepare("INSERT INTO v(rowid, embedding) VALUES (1, ?)").run(vectorToBlob(a));
    db.prepare("INSERT INTO v(rowid, embedding) VALUES (2, ?)").run(vectorToBlob(b));

    const rows = db
      .prepare("SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 2")
      .all(vectorToBlob(a)) as Array<{ rowid: number; distance: number }>;

    expect(rows[0]?.rowid).toBe(1);
    expect(rows[0]?.distance).toBeLessThan(rows[1]?.distance ?? Number.POSITIVE_INFINITY);
    db.close();
  });
});
