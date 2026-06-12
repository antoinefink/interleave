/**
 * Migration runner (T006; vec-guarded for T087).
 *
 * Applies the generated Drizzle migrations (from `MIGRATIONS_DIR`) to a SQLite
 * database. The Electron main process (T007) calls {@link migrateDatabase} on
 * startup to bring the local DB up to date safely; the dev scripts call it to
 * build a database from empty. Using Drizzle's own migrator keeps the journal
 * (`__drizzle_migrations`) consistent with `drizzle-kit generate`.
 *
 * ## The `vec0` guard (T087)
 *
 * The on-device semantic-search vector store lives in a `sqlite-vec` `vec0` virtual
 * table (`element_vectors`). `vec0` is a RUNTIME-LOADED extension that may be absent
 * (or loaded-but-non-functional on an ABI-mismatched host), so `CREATE VIRTUAL
 * TABLE … USING vec0(…)` throws when vec is not available — and Drizzle's stock
 * `migrate(...)` applies EVERY journaled `.sql` unconditionally, with no per-step
 * hook. (The FTS5 `0002` precedent does not hit this because better-sqlite3 ships
 * `ENABLE_FTS5` compiled in; `vec0` is loaded at runtime.)
 *
 * The journaled `*_semantic_vec0.sql` is therefore intentionally a NO-OP comment
 * file: Drizzle records it as applied on EVERY host (so the journal stays
 * consistent), but it creates nothing. The real `element_vectors` DDL lives in
 * {@link applyVecMigration} and is run by this wrapper ONLY when `vecAvailable` is
 * `true` (the caller passes `vecFunctional(sqlite)` — the functional smoke test,
 * not mere resolvability). On an extension-absent / ABI-mismatched host the table
 * is simply never created, all other migrations apply, and `pnpm test` stays green
 * with FTS-only coverage. Creating `element_vectors` is idempotent
 * (`IF NOT EXISTS`), so re-running on an already-migrated DB where vec is now
 * available is safe.
 */

import { EMBEDDING_DIM } from "@interleave/core";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { InterleaveDatabase, SqliteDatabase } from "./client";
import { MIGRATIONS_DIR } from "./paths";

/** Options for {@link migrateDatabase}. */
export interface MigrateOptions {
  readonly migrationsFolder?: string;
  /**
   * Whether `sqlite-vec` is loaded AND functional on this connection (T087). Pass
   * `vecFunctional(sqlite)` — the round-trip smoke test, NOT `loadVectorExtension`
   * returning. When `true`, the `element_vectors` `vec0` table is created; when
   * `false`/omitted, the vec0 step is skipped and the rest of the schema migrates
   * normally (FTS-only). Default `false` so a caller that never loaded vec (most
   * tests) does not attempt the `vec0` DDL.
   */
  readonly vecAvailable?: boolean;
}

/**
 * Run all pending migrations against the given Drizzle client. When `vecAvailable`
 * is `true`, additionally create the `sqlite-vec` `element_vectors` table (the
 * guarded vec0 step). Back-compat: a bare `migrateDatabase(db)` or
 * `migrateDatabase(db, "folder")` still works.
 *
 * ## Foreign keys are OFF while migrations run (load-bearing)
 *
 * SQLite table rebuilds (`CREATE __new_x` → copy rows → `DROP TABLE x` → rename)
 * are the only way to change a CHECK constraint, and the documented ALTER
 * procedure requires `foreign_keys = OFF` for their duration: with enforcement
 * ON, `DROP TABLE x` performs an implicit `DELETE FROM x` whose referential
 * actions fire into OTHER tables — `0030_parked_elements` shipped that way and
 * the implicit delete's `ON DELETE SET NULL` nulled every freshly copied
 * `__new_elements.parent_id`/`source_id` (the lineage-wipe `0034` repairs).
 * The pragma is a connection-level no-op inside a transaction, and Drizzle's
 * `migrate(...)` wraps each migration in one — so it MUST be toggled here,
 * outside any transaction. Enforcement is restored afterward, and whenever new
 * migrations were applied a full `foreign_key_check` makes a
 * violation-introducing migration fail loudly instead of corrupting silently
 * (the check is skipped on the no-migration fast path so routine startups stay
 * O(1)).
 */
export function migrateDatabase(
  db: InterleaveDatabase,
  options: MigrateOptions | string = {},
): void {
  const opts: MigrateOptions =
    typeof options === "string" ? { migrationsFolder: options } : options;
  const sqlite = db.$client;

  sqlite.pragma("foreign_keys = OFF");
  if (Number(sqlite.pragma("foreign_keys", { simple: true })) !== 0) {
    throw new Error(
      "migrateDatabase: could not disable foreign_keys — a transaction is open on this connection",
    );
  }
  const before = appliedMigrationCount(sqlite);
  try {
    migrate(db, { migrationsFolder: opts.migrationsFolder ?? MIGRATIONS_DIR });
    if (appliedMigrationCount(sqlite) !== before) {
      const violations = sqlite.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `migrateDatabase: migrations left ${violations.length} foreign-key violation(s): ` +
            JSON.stringify(violations.slice(0, 5)),
        );
      }
    }
  } finally {
    // The mandatory pragma set (see `applyPragmas`) — never leave enforcement off.
    sqlite.pragma("foreign_keys = ON");
  }
  if (opts.vecAvailable) {
    applyVecMigration(db);
  }
}

/** Rows in `__drizzle_migrations`, or 0 before the first migration ever runs. */
function appliedMigrationCount(sqlite: SqliteDatabase): number {
  try {
    const row = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get() as {
      readonly n: number;
    };
    return row.n;
  } catch {
    return 0;
  }
}

/**
 * Create the `sqlite-vec` `element_vectors` virtual table (T087). Idempotent
 * (`IF NOT EXISTS`). The dim is the shared {@link EMBEDDING_DIM} constant — the
 * column DDL and the constant move together if a different-dim model is ever
 * chosen. MUST only be called on a connection where `vecFunctional(sqlite)` is
 * `true` (the caller's responsibility); otherwise `CREATE VIRTUAL TABLE … USING
 * vec0` throws. Kept OUT of the journaled migration so the stock unconditional
 * migrator never runs it on a vec-absent host.
 */
export function applyVecMigration(db: InterleaveDatabase): void {
  db.run(
    sql.raw(
      `CREATE VIRTUAL TABLE IF NOT EXISTS element_vectors USING vec0(embedding float[${EMBEDDING_DIM}])`,
    ),
  );
}
