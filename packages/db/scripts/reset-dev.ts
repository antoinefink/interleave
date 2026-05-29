/**
 * Dev reset script (T006): `pnpm --filter @interleave/db db:reset:dev`.
 *
 * Deletes the package-local dev SQLite database (and its `-wal`/`-shm`
 * siblings), then re-creates it from empty by applying all migrations. Proves
 * the schema builds from scratch and resets cleanly. This never touches the
 * production app data directory DB — only the gitignored dev file.
 */

import fs from "node:fs";
import path from "node:path";
import { migrateDatabase, openDatabase } from "../src/index";
import { DEV_DB_PATH } from "../src/paths";

for (const suffix of ["", "-wal", "-shm"]) {
  fs.rmSync(`${DEV_DB_PATH}${suffix}`, { force: true });
}

fs.mkdirSync(path.dirname(DEV_DB_PATH), { recursive: true });

const { db, sqlite } = openDatabase(DEV_DB_PATH);
migrateDatabase(db);
sqlite.close();

console.log(`[db:reset:dev] reset and re-migrated ${DEV_DB_PATH}`);
