/**
 * Dev migration script (T006): `pnpm --filter @interleave/db db:migrate`.
 *
 * Opens the package-local dev SQLite database (creating its directory if needed)
 * with the mandatory pragmas and applies all generated Drizzle migrations. This
 * is the dev-side counterpart to the startup migration the Electron main process
 * runs in production (T007).
 */

import fs from "node:fs";
import path from "node:path";
import { migrateDatabase, openDatabase } from "../src/index";
import { DEV_DB_PATH } from "../src/paths";

fs.mkdirSync(path.dirname(DEV_DB_PATH), { recursive: true });

const { db, sqlite } = openDatabase(DEV_DB_PATH);
migrateDatabase(db);
sqlite.close();

console.log(`[db:migrate] migrations applied to ${DEV_DB_PATH}`);
