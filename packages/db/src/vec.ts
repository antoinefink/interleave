/**
 * `sqlite-vec` (`vec0`) loader + functional smoke test (T087).
 *
 * The on-device semantic-search vector store is a `sqlite-vec` `vec0` virtual
 * table on the SAME better-sqlite3 file the rest of the app uses (no server, no
 * `pgvector`, no second datastore — the vectors back up with the DB and survive
 * restart). `sqlite-vec` is a loadable C extension: {@link loadVectorExtension}
 * loads it into the raw `better-sqlite3` handle (via `sqliteVec.load(db)`, which
 * calls `db.loadExtension(...)`), and the `vec0` virtual table + KNN `MATCH`
 * become available on that one connection. Main is the single writer; the DB-free
 * worker NEVER loads this or opens the DB.
 *
 * ## CRITICAL: a successful load is NOT proof the extension works
 *
 * This repo pins `better-sqlite3 ^12.x` (a newer bundled SQLite ~3.50/3.51.x) while
 * the prebuilt `sqlite-vec` v0.1.9 loadable binaries are compiled against an older
 * SQLite (~3.45.x). The documented failure mode on an ABI mismatch is that
 * `db.loadExtension` SUCCEEDS (no throw) but `vec0` registers NO functions — so a
 * later `CREATE VIRTUAL TABLE … USING vec0(…)` or a KNN `MATCH` silently fails /
 * throws on first use instead of degrading. Therefore the source of truth for
 * "is vec available?" is NOT {@link loadVectorExtension} returning — it is
 * {@link vecFunctional}, a FUNCTIONAL round-trip smoke test (load → `vec_version()`
 * → create a `vec0` table → insert a `float[384]` → KNN `MATCH … LIMIT 1` →
 * drop). Only if EVERY step succeeds is vec usable; any throw degrades the app to
 * FTS-only. Callers MUST gate on `vecFunctional`, never on `loadVectorExtension`.
 *
 * The same `vecFunctional` smoke test gates the real-`vec0` integration/unit tests
 * (`it.skipIf(!vecFunctional(testDb))`) so an ABI-mismatched host skips cleanly
 * instead of failing inside a `vec0` query it assumed worked, AND gates the
 * `*_semantic_vec0.sql` migration step in the guarded migrator (see `migrator.ts`).
 *
 * **Build-time guard:** `apps/desktop/scripts/vendor-sqlite-vec.mjs` runs this same
 * functional smoke test against the shipped binary at package time and fails the
 * build if `vec0` does not register — so a packaged app can never ship a
 * loaded-but-non-functional `vec0`.
 */

import { EMBEDDING_DIM } from "@interleave/core";
import { getLoadablePath, load as loadSqliteVec } from "sqlite-vec";
import type { SqliteDatabase } from "./client";

/**
 * The absolute path of the `sqlite-vec` loadable binary the installed npm package
 * resolves for the HOST platform/arch (dev / Vitest / scripts). The desktop main
 * resolves the PACKAGED `app.asar.unpacked` path instead (it cannot rely on
 * `node_modules` being present), so it passes an explicit `binaryPath` to
 * {@link loadVectorExtension}; this is the fallback for everything else.
 */
export function resolveHostVecBinaryPath(): string {
  return getLoadablePath();
}

/**
 * Load the `sqlite-vec` extension into a raw `better-sqlite3` handle. When
 * `binaryPath` is given, load that explicit `vec0.{dylib,so,dll}` (the packaged
 * `app.asar.unpacked` path the desktop main resolves); otherwise let the installed
 * `sqlite-vec` npm package resolve the host binary (dev / Vitest / scripts).
 *
 * Returns `true` on a successful `loadExtension` call, `false` (logged) on a throw
 * — it NEVER throws, so a missing/incompatible binary degrades to FTS-only rather
 * than crashing open(). NOTE: a `true` return does NOT mean `vec0` works — gate on
 * {@link vecFunctional}, not on this (see the module docblock's ABI-mismatch note).
 */
export function loadVectorExtension(sqlite: SqliteDatabase, binaryPath?: string): boolean {
  try {
    if (binaryPath) {
      sqlite.loadExtension(binaryPath);
    } else {
      loadSqliteVec(sqlite);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[vec] sqlite-vec load failed — semantic search degrades to FTS-only: ${message}`);
    return false;
  }
}

/**
 * The SOURCE OF TRUTH for `vecAvailable`: run a full `vec0` round-trip and return
 * `true` only if every step succeeds. This catches the ABI-mismatch case where
 * `loadExtension` succeeded but `vec0` registered no functions (the
 * better-sqlite3-12-vs-SQLite-3.45 trap). Any throw → `false` (logged with the
 * ABI-mismatch hint), and the app continues FTS-only. Uses a uniquely-named
 * scratch table dropped at the end, so it is side-effect-free on success and on
 * the (rolled-back) failure path.
 *
 * The caller MUST have called {@link loadVectorExtension} on this same handle
 * first; this only verifies the loaded extension actually works.
 */
export function vecFunctional(sqlite: SqliteDatabase): boolean {
  const table = "_vec_smoke";
  try {
    // 1) vec_version() must return a string (the extension registered its functions).
    const version = sqlite.prepare("SELECT vec_version() AS v").get() as
      | { v?: unknown }
      | undefined;
    if (typeof version?.v !== "string") return false;

    // 2) Create a vec0 table, insert one float[DIM] row, KNN-match it, drop.
    sqlite.exec(`CREATE VIRTUAL TABLE ${table} USING vec0(embedding float[${EMBEDDING_DIM}])`);
    const probe = vectorToBlob(new Array(EMBEDDING_DIM).fill(0.0123));
    sqlite.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (1, ?)`).run(probe);
    const row = sqlite
      .prepare(
        `SELECT rowid, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT 1`,
      )
      .get(probe) as { rowid?: unknown } | undefined;
    sqlite.exec(`DROP TABLE ${table}`);
    return row?.rowid === 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[vec] vec0 functional smoke test failed — likely a better-sqlite3 ↔ sqlite-vec ` +
        `SQLite ABI mismatch (loadExtension succeeded but vec0 registered no functions); ` +
        `semantic search degrades to FTS-only: ${message}`,
    );
    // Best-effort cleanup if the create succeeded but a later step threw.
    try {
      sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
    } catch {
      // ignore — the table may not exist; this is only hygiene.
    }
    return false;
  }
}

/**
 * Encode a vector as the compact little-endian `float32` BLOB `sqlite-vec`'s `vec0`
 * accepts for inserts and KNN `MATCH`. (Passing the raw bytes is faster + smaller
 * than the JSON-array form.) The length is NOT enforced here — the repository
 * validates `vector.length === dim` before calling, so a wrong-length vector never
 * reaches the column.
 */
export function vectorToBlob(vector: readonly number[]): Buffer {
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
