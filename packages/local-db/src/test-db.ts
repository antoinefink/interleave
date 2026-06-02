/**
 * In-memory SQLite test harness for this package's own repository tests (T008).
 *
 * `packages/local-db` is a LEAF of the workspace graph (it depends only on
 * `@interleave/core` + `@interleave/db`). The higher-level `@interleave/testing`
 * package, which carries the shared demo-collection factory, depends on THIS
 * package — so local-db must not depend back on testing (that would be a package
 * cycle Turbo rejects). This tiny helper therefore lives here: it opens a fresh
 * in-memory `better-sqlite3` database via `@interleave/db` and runs the generated
 * Drizzle migrations, exactly mirroring `@interleave/testing`'s harness, so these
 * tests still exercise the real schema + pragmas.
 */

import {
  type DbHandle,
  loadVectorExtension,
  migrateDatabase,
  openDatabase,
  vecFunctional,
} from "@interleave/db";

/**
 * Open a fresh in-memory SQLite database with all M1 migrations applied. Callers
 * MUST close `handle.sqlite` when done (e.g. in `afterEach`).
 *
 * T087: it ALSO loads `sqlite-vec` and runs the functional smoke test, passing
 * `vecFunctional(sqlite)` to the guarded migrator. On a healthy host (CI/dev) the
 * `element_vectors` `vec0` table is created and the semantic tests run; on an
 * ABI-mismatched / extension-absent host `vecFunctional` is `false`, the vec0
 * step is skipped, and the rest of the schema migrates normally (FTS-only) — the
 * semantic tests then `it.skipIf(!vecFunctional(...))` so the suite stays green.
 */
export function createInMemoryDb(): DbHandle {
  const handle = openDatabase(":memory:");
  loadVectorExtension(handle.sqlite);
  const vecAvailable = vecFunctional(handle.sqlite);
  migrateDatabase(handle.db, { vecAvailable });
  return handle;
}

/** Whether `sqlite-vec` `vec0` is loaded AND functional on `handle`. Tests gate on this. */
export function isVecAvailable(handle: DbHandle): boolean {
  return vecFunctional(handle.sqlite);
}
