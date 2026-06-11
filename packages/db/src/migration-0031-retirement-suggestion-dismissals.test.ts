/**
 * Migration `0031` test — source retirement suggestion dismissals.
 *
 * T103 adds one tiny source-keyed table for durable, hash-scoped dismissal of
 * proactive "done with no yield" suggestions.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0031-"));
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

function withDbThrough30<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(30);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

function tableExists(handle: DbHandle, name: string): boolean {
  const row = handle.sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

describe("migration 0031 — retirement suggestion dismissals", () => {
  it("adds the dismissal table with its hash index and source FK cascade", () => {
    withDbThrough30((handle) => {
      expect(tableExists(handle, "retirement_suggestion_dismissals")).toBe(false);

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      expect(tableExists(handle, "retirement_suggestion_dismissals")).toBe(true);
      expect(
        handle.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'retirement_suggestion_dismissals_hash_idx'",
          )
          .get(),
      ).toBeTruthy();

      handle.sqlite
        .prepare(
          `INSERT INTO elements (
            id, type, status, stage, priority, due_at, title, parent_id, source_id, created_at, updated_at, parked_at
          ) VALUES (
            'source_0031', 'source', 'active', 'raw_source', 0.5, NULL, 'Source 0031', NULL, NULL,
            '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL
          )`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO retirement_suggestion_dismissals (
            source_element_id, signal_hash, dismissed_at
          ) VALUES ('source_0031', 'hash-0031', '2026-06-01T00:01:00.000Z')`,
        )
        .run();

      expect(
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM retirement_suggestion_dismissals")
          .get(),
      ).toEqual({ count: 1 });

      handle.sqlite.prepare("DELETE FROM elements WHERE id = 'source_0031'").run();

      expect(
        handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM retirement_suggestion_dismissals")
          .get(),
      ).toEqual({ count: 0 });
    });
  });
});
