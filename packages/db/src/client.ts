/**
 * Native SQLite client factory (T006).
 *
 * Opens a `better-sqlite3` database with the mandatory pragmas
 * (`foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`) and wraps it
 * in a Drizzle instance bound to the full schema. The Electron main/DB service
 * (T007) and the repositories (T008) build on this; tests open an in-memory
 * database with the same factory so behavior matches production.
 *
 * The renderer never imports this — all SQLite access stays behind the
 * Electron/IPC boundary.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type SqliteDatabase = Database.Database;
export type InterleaveDatabase = ReturnType<typeof drizzle<typeof schema>>;

/** A bound Drizzle client plus the raw `better-sqlite3` handle behind it. */
export interface DbHandle {
  readonly db: InterleaveDatabase;
  readonly sqlite: SqliteDatabase;
}

/**
 * Apply the mandatory pragmas to a raw `better-sqlite3` connection.
 *
 * `journal_mode = WAL` is a no-op (and harmlessly returns `memory`) for in-memory
 * databases, so the same call is safe in tests and in production.
 */
export function applyPragmas(sqlite: SqliteDatabase): void {
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
}

/**
 * Open a SQLite database at `filename` (use `":memory:"` for tests) and return a
 * Drizzle client bound to the schema. Pragmas are applied on open.
 */
export function openDatabase(filename: string): DbHandle {
  const sqlite = new Database(filename);
  applyPragmas(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}
