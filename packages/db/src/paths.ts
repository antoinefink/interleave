/**
 * Filesystem paths for migrations and the dev database (T006).
 *
 * Centralizes where the generated Drizzle migrations live and where the local
 * *dev* SQLite database file sits, so the migrator, the dev-reset script, and
 * `drizzle.config.ts` all agree. The production app data directory (under
 * `~/Library/Application Support/<app>/`) is owned by the Electron main process
 * (T007) — this module only covers the package-local dev/migration paths.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path to `packages/db`. */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Where `drizzle-kit generate` writes migrations and snapshots. */
export const MIGRATIONS_DIR = path.join(PACKAGE_ROOT, "drizzle");

/** Local dev SQLite database file (gitignored). */
export const DEV_DB_PATH = path.join(PACKAGE_ROOT, ".dev", "dev.sqlite");
