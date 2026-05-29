/**
 * Drizzle Kit config (T006) — native SQLite dialect.
 *
 * `drizzle-kit generate` reads the schema barrel and writes SQL migrations +
 * snapshots into `./drizzle`. `dbCredentials.url` points at the package-local
 * dev database used by `db:migrate` / `db:reset:dev`; production migrations are
 * run by the Electron main process against the app data directory DB (T007).
 */

import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./.dev/dev.sqlite",
  },
  strict: true,
  verbose: true,
});
