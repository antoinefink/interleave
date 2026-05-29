/**
 * Migration runner (T006).
 *
 * Applies the generated Drizzle migrations (from `MIGRATIONS_DIR`) to a SQLite
 * database. The Electron main process (T007) calls {@link migrateDatabase} on
 * startup to bring the local DB up to date safely; the dev scripts call it to
 * build a database from empty. Using Drizzle's own migrator keeps the journal
 * (`__drizzle_migrations`) consistent with `drizzle-kit generate`.
 */

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { InterleaveDatabase } from "./client";
import { MIGRATIONS_DIR } from "./paths";

/** Run all pending migrations against the given Drizzle client. */
export function migrateDatabase(db: InterleaveDatabase, migrationsFolder = MIGRATIONS_DIR): void {
  migrate(db, { migrationsFolder });
}
