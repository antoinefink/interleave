/**
 * @interleave/db — the native SQLite schema, client, and migrations (T006).
 *
 * The canonical local store is **native SQLite** (`better-sqlite3` + Drizzle,
 * SQLite dialect). This package owns the Drizzle schema for all 18 M1 tables, a
 * client factory that opens SQLite with the mandatory pragmas
 * (`foreign_keys = ON`, `journal_mode = WAL`, `busy_timeout = 5000`), and the
 * migration runner. The Electron main/DB service (T007) opens the DB and runs
 * migrations on startup; `packages/local-db` (T008) builds the repositories on
 * top. The renderer never imports this — all SQLite access stays behind the
 * Electron/IPC boundary.
 *
 * Table column shapes mirror `@interleave/core`, and enum columns are constrained
 * by CHECK lists derived from the same core tuples, so the DB and the domain
 * vocabulary cannot drift.
 */

export const DB_PACKAGE = "@interleave/db" as const;

export {
  applyPragmas,
  type DbHandle,
  type InterleaveDatabase,
  openDatabase,
  type SqliteDatabase,
} from "./client";
export { migrateDatabase } from "./migrator";
export { DEV_DB_PATH, MIGRATIONS_DIR, PACKAGE_ROOT } from "./paths";
export * from "./schema";
