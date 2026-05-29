/**
 * In-memory SQLite test harness (T008).
 *
 * Repository tests need a real, fully-migrated `better-sqlite3` database — not a
 * mock — so behaviour matches production exactly (the same pragmas, the same
 * CHECK/foreign-key constraints, the same Drizzle client). This helper opens an
 * in-memory database via `@interleave/db` and runs the generated Drizzle
 * migrations against it, returning the bound Drizzle client plus the raw handle
 * so a test can close it in `afterEach`.
 *
 * Using the canonical `openDatabase` + `migrateDatabase` keeps tests honest: a
 * test that passes here exercises the same schema the Electron main process
 * opens at runtime. No PGlite — native SQLite end to end.
 */

import { type DbHandle, migrateDatabase, openDatabase } from "@interleave/db";

/**
 * Open a fresh in-memory SQLite database with all M1 migrations applied. Callers
 * MUST close `handle.sqlite` when done (e.g. in `afterEach`).
 */
export function createInMemoryDb(): DbHandle {
  const handle = openDatabase(":memory:");
  migrateDatabase(handle.db);
  return handle;
}
