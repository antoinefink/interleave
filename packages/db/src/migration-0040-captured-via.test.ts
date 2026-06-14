/**
 * Migration `0040` test — T126 persisted capture origin (`sources.captured_via`).
 *
 * The migration adds nullable `sources.captured_via` with a nullable-domain CHECK
 * (NULL or one of the core CAPTURED_VIA origins) and an HONEST backfill of legacy
 * rows: a URL-bearing source → `url`, a URL-less source → `manual`. It is deliberately
 * HAND-EDITED to a purely additive `ALTER TABLE … ADD COLUMN` (+ two UPDATEs) rather
 * than the table rebuild `drizzle-kit` wanted — a rebuild of `sources` is the exact
 * shape that nulled lineage in the 0030 incident (and the generated copy was also
 * mis-shaped by the Drizzle rebuild-SELECT bug).
 *
 * This test seeds a linked source→extract lineage graph through migration 39, runs to
 * HEAD, and asserts: the column is added + nullable, the URL/no-URL backfill is honest
 * (no `reason_added` heuristic), the CHECK enforces the closed domain (NULL allowed),
 * every seeded source row survives, and source lineage columns are untouched.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0040-"));
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

function withDbThrough39<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(39);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

const CREATED = "2026-06-01T00:00:00.000Z";

/** Seed a source element + its `sources` provenance row (pre-0040 column shape). */
function seedSource(handle: DbHandle, id: string, url: string | null): void {
  handle.sqlite
    .prepare(
      `INSERT INTO elements (
        id, type, status, stage, priority, title, parent_id, source_id, created_at, updated_at
      ) VALUES (?, 'source', 'inbox', 'raw_source', 0.5, ?, NULL, NULL, ?, ?)`,
    )
    .run(id, `Source ${id}`, CREATED, CREATED);
  handle.sqlite
    .prepare(
      `INSERT INTO sources (element_id, url, canonical_url, accessed_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, url, url, CREATED);
}

describe("migration 0040 — captured_via", () => {
  it("adds nullable captured_via and backfills legacy rows honestly (url / manual)", () => {
    withDbThrough39((handle) => {
      // A URL-bearing legacy source, a bare (no-URL) manual source, and an extract
      // child so the lineage-survival assertion is meaningful.
      seedSource(handle, "url_src", "https://example.com/a");
      seedSource(handle, "manual_src", null);
      handle.sqlite
        .prepare(
          `INSERT INTO elements (
            id, type, status, stage, priority, title, parent_id, source_id, created_at, updated_at
          ) VALUES ('ext', 'extract', 'pending', 'raw_extract', 0.5, 'Extract', 'url_src', 'url_src', ?, ?)`,
        )
        .run(CREATED, CREATED);

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      // The column exists and is nullable.
      const columns = handle.sqlite.prepare("PRAGMA table_info(sources)").all() as {
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }[];
      const captured = columns.find((c) => c.name === "captured_via");
      expect(captured).toBeDefined();
      expect(captured?.notnull).toBe(0);

      // Honest backfill: url → 'url', no-url → 'manual'. No `reason_added` heuristic.
      expect(
        handle.sqlite
          .prepare("SELECT captured_via FROM sources WHERE element_id = 'url_src'")
          .get(),
      ).toEqual({ captured_via: "url" });
      expect(
        handle.sqlite
          .prepare("SELECT captured_via FROM sources WHERE element_id = 'manual_src'")
          .get(),
      ).toEqual({ captured_via: "manual" });

      // Both seeded source rows survive the additive migration (no rebuild row loss).
      const sourceCount = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM sources").get() as {
        n: number;
      };
      expect(sourceCount.n).toBe(2);

      // Lineage columns are untouched (the 0030 regression guard).
      expect(
        handle.sqlite.prepare("SELECT parent_id, source_id FROM elements WHERE id = 'ext'").get(),
      ).toEqual({ parent_id: "url_src", source_id: "url_src" });

      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    });
  });

  it("enforces the closed captured_via domain and allows NULL", () => {
    withDbThrough39((handle) => {
      seedSource(handle, "s1", "https://example.com/b");
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      // Every canonical origin is accepted.
      for (const origin of ["manual", "url", "extension", "highlight_import", "file"]) {
        expect(() =>
          handle.sqlite
            .prepare("UPDATE sources SET captured_via = ? WHERE element_id = 's1'")
            .run(origin),
        ).not.toThrow();
      }

      // NULL (a legacy / un-recorded origin) passes the nullable-domain CHECK.
      expect(() =>
        handle.sqlite
          .prepare("UPDATE sources SET captured_via = NULL WHERE element_id = 's1'")
          .run(),
      ).not.toThrow();

      // An off-tuple value is rejected.
      expect(() =>
        handle.sqlite
          .prepare("UPDATE sources SET captured_via = 'legacy_value' WHERE element_id = 's1'")
          .run(),
      ).toThrow(/CHECK constraint failed/);
    });
  });
});
