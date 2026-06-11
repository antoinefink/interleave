/**
 * Migration `0032` test — extract fates.
 *
 * T104 adds nullable `elements.extract_fate` with a CHECK that only permits the
 * closed fate set on extract rows. This proves an already-migrated 0031 database
 * keeps existing rows with NULL fates and enforces the new constraint afterward.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type DbHandle, MIGRATIONS_DIR, migrateDatabase, openDatabase } from "./index";

function stageMigrationsThrough(maxIdx: number): {
  readonly dir: string;
  readonly drizzle: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0032-"));
  const drizzle = path.join(dir, "drizzle");
  const meta = path.join(drizzle, "meta");
  mkdirSync(meta, { recursive: true });

  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };
  const entries = journal.entries.filter((entry) => entry.idx <= maxIdx);
  for (const entry of entries) {
    cpSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), path.join(drizzle, `${entry.tag}.sql`));
  }
  writeFileSync(path.join(meta, "_journal.json"), JSON.stringify({ ...journal, entries }));

  return { dir, drizzle };
}

function withDbThrough31<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(31);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

describe("migration 0032 — extract fates", () => {
  it("adds nullable extract_fate to existing rows and enforces extract-only values", () => {
    withDbThrough31((handle) => {
      handle.sqlite
        .prepare(
          `INSERT INTO elements (
            id, type, status, stage, priority, due_at, title, parent_id, source_id, created_at, updated_at, parked_at
          ) VALUES (
            'source_0032', 'source', 'active', 'raw_source', 0.5, NULL, 'Source 0032', NULL, NULL,
            '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL
          )`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO elements (
            id, type, status, stage, priority, due_at, title, parent_id, source_id, created_at, updated_at, parked_at
          ) VALUES (
            'extract_0032', 'extract', 'scheduled', 'atomic_statement', 0.5,
            '2026-06-02T00:00:00.000Z', 'Extract 0032', 'source_0032', 'source_0032',
            '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL
          )`,
        )
        .run();

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const columns = handle.sqlite.prepare("PRAGMA table_info(elements)").all() as {
        readonly name: string;
      }[];
      expect(columns.map((column) => column.name)).toContain("extract_fate");
      expect(
        handle.sqlite.prepare("SELECT extract_fate FROM elements WHERE id = 'extract_0032'").get(),
      ).toEqual({ extract_fate: null });

      handle.sqlite
        .prepare("UPDATE elements SET extract_fate = 'reference' WHERE id = 'extract_0032'")
        .run();
      expect(
        handle.sqlite.prepare("SELECT extract_fate FROM elements WHERE id = 'extract_0032'").get(),
      ).toEqual({ extract_fate: "reference" });

      expect(() =>
        handle.sqlite
          .prepare("UPDATE elements SET extract_fate = 'reference' WHERE id = 'source_0032'")
          .run(),
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        handle.sqlite
          .prepare("UPDATE elements SET extract_fate = 'invalid' WHERE id = 'extract_0032'")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });
  });
});
