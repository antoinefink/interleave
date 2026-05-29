/**
 * Shared schema helpers (T006).
 *
 * These keep the SQLite schema honest against the `@interleave/core` vocabulary
 * and keep the column definitions portable toward the later Postgres mirror.
 */

import { type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Build a portable `column IN ('a','b',...)` CHECK expression from a core enum
 * tuple. Using the `@interleave/core` tuples as the single source of truth means
 * the DB constraint and the domain union can never silently drift — adding a new
 * enum value in core (a migration) is the only way to widen the constraint.
 *
 * `IN (...)` is plain ANSI SQL (no SQLite-only construct), so the same schema
 * generates cleanly for the future Postgres server mirror.
 */
export function inList(column: AnySQLiteColumn, values: readonly string[]): SQL {
  const quoted = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
  return sql`${column} IN (${sql.raw(quoted)})`;
}
