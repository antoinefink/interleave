/**
 * Migration `0038` test — T124 detach-resolution provenance snapshot.
 *
 * The migration adds the `element_detach_snapshot` table only. It is PURELY ADDITIVE
 * (a single `CREATE TABLE` + two `CREATE INDEX`) — `drizzle-kit` did NOT propose an
 * `elements` rebuild, because the only diff is a brand-new table. A rebuild of
 * `elements` is the exact shape that nulled lineage in the 0030 incident, so this test
 * guards against one ever being folded in: it asserts the generated `.sql` contains
 * exactly one `CREATE TABLE` and zero `__new_elements` / `DROP TABLE` / `RENAME`
 * statements, that applying 0038 leaves `elements`, `element_reverify_provenance`, and
 * `source_locations` row counts unchanged, and that a seeded element's lineage column
 * VALUES (`parent_id`/`source_id`) are byte-identical across the migration.
 *
 * It seeds a linked source→extract lineage graph (plus a provenance row and a
 * source_locations anchor) through migration 37, runs to HEAD, and asserts the new
 * table exists with the expected columns and that a detach snapshot row round-trips
 * with all anchor fields intact.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0038-"));
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

function withDbThrough37<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(37);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

function migration0038Sql(): string {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };
  const entry = journal.entries.find((e) => e.idx === 38);
  if (!entry) throw new Error("migration 0038 not found in journal");
  return readFileSync(path.join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
}

const CREATED = "2026-06-14T00:00:00.000Z";

/** Seed a source→extract lineage graph + a provenance row + a source_locations anchor. */
function seedLineageGraph(handle: DbHandle): void {
  const insertElement = handle.sqlite.prepare(
    `INSERT INTO elements (
      id, type, status, stage, priority, title, parent_id, source_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0.5, ?, ?, ?, ?, ?)`,
  );
  insertElement.run(
    "src",
    "source",
    "active",
    "raw_source",
    "Source",
    null,
    null,
    CREATED,
    CREATED,
  );
  insertElement.run(
    "ext",
    "extract",
    "active",
    "raw_extract",
    "Extract",
    "src",
    "src",
    CREATED,
    CREATED,
  );

  // A provenance row (the T123 flag) — its count must survive the additive migration.
  handle.sqlite
    .prepare(
      `INSERT INTO element_reverify_provenance (
        id, element_id, source_element_id, stable_block_id, batch_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("prov1", "ext", "src", "blk1", "batch1", CREATED);

  // A source_locations anchor — the row detach later tombstones; its count must survive.
  handle.sqlite
    .prepare(
      `INSERT INTO source_locations (
        id, element_id, source_element_id, block_ids, selected_text
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("loc1", "ext", "src", '["blk1"]', "anchored text");
}

describe("migration 0038 — detach-resolution provenance snapshot", () => {
  it("adds element_detach_snapshot with the expected columns", () => {
    withDbThrough37((handle) => {
      seedLineageGraph(handle);
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const columns = handle.sqlite
        .prepare("PRAGMA table_info('element_detach_snapshot')")
        .all() as { readonly name: string; readonly notnull: number }[];
      const byName = new Map(columns.map((c) => [c.name, c]));

      // Every expected column is present.
      for (const name of [
        "id",
        "element_id",
        "source_element_id",
        "stable_block_id",
        "selected_text",
        "block_ids",
        "start_offset",
        "end_offset",
        "pre_stale_hash",
        "batch_id",
        "created_at",
      ]) {
        expect(byName.has(name), `column ${name} should exist`).toBe(true);
      }
      // Exactly that column set — no extras, none missing.
      expect(byName.size).toBe(11);

      // NOT NULL shape: anchor identity is required; offsets + pre_stale_hash nullable.
      expect(byName.get("element_id")?.notnull).toBe(1);
      expect(byName.get("source_element_id")?.notnull).toBe(1);
      expect(byName.get("stable_block_id")?.notnull).toBe(1);
      expect(byName.get("selected_text")?.notnull).toBe(1);
      expect(byName.get("block_ids")?.notnull).toBe(1);
      expect(byName.get("batch_id")?.notnull).toBe(1);
      expect(byName.get("created_at")?.notnull).toBe(1);
      expect(byName.get("start_offset")?.notnull).toBe(0);
      expect(byName.get("end_offset")?.notnull).toBe(0);
      expect(byName.get("pre_stale_hash")?.notnull).toBe(0);

      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    });
  });

  it("is generated as a single additive CREATE TABLE (no elements rebuild)", () => {
    const sql = migration0038Sql();
    // String-level guard against a folded-in elements rebuild. Count only executable
    // DDL statements (lines starting with the keyword) so the header comment — which
    // mentions "CREATE TABLE"/"DROP elements" in prose — does not skew the count.
    const ddlLines = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    const createTableCount = (ddlLines.match(/CREATE TABLE/g) ?? []).length;
    expect(createTableCount).toBe(1);
    expect(ddlLines).not.toMatch(/__new_elements/);
    expect(ddlLines).not.toMatch(/DROP TABLE/);
    expect(ddlLines).not.toMatch(/RENAME/);
    // The one table it creates is the detach snapshot.
    expect(ddlLines).toMatch(/CREATE TABLE `element_detach_snapshot`/);
  });

  it("leaves elements / provenance / source_locations row counts unchanged (0030-wipe guard)", () => {
    withDbThrough37((handle) => {
      seedLineageGraph(handle);

      const count = (table: string): number =>
        (handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      const before = {
        elements: count("elements"),
        provenance: count("element_reverify_provenance"),
        sourceLocations: count("source_locations"),
      };

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      expect(count("elements")).toBe(before.elements);
      expect(count("element_reverify_provenance")).toBe(before.provenance);
      expect(count("source_locations")).toBe(before.sourceLocations);
    });
  });

  it("preserves the seeded element's lineage column VALUES byte-for-byte", () => {
    withDbThrough37((handle) => {
      seedLineageGraph(handle);

      const lineageOf = (id: string) =>
        handle.sqlite.prepare("SELECT parent_id, source_id FROM elements WHERE id = ?").get(id) as {
          parent_id: string | null;
          source_id: string | null;
        };
      const before = lineageOf("ext");

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const after = lineageOf("ext");
      expect(after).toEqual(before);
      // Explicit value assertion (not just equality to a possibly-nulled `before`).
      expect(after).toEqual({ parent_id: "src", source_id: "src" });

      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });

  it("round-trips a detach snapshot row with all anchor fields intact", () => {
    withDbThrough37((handle) => {
      seedLineageGraph(handle);
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const insert = handle.sqlite.prepare(
        `INSERT INTO element_detach_snapshot (
          id, element_id, source_element_id, stable_block_id, selected_text,
          block_ids, start_offset, end_offset, pre_stale_hash, batch_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      expect(() =>
        insert.run(
          "snap1",
          "ext",
          "src",
          "blk1",
          "frozen anchor text",
          '["blk1"]',
          3,
          17,
          "hash-pre-stale",
          "batch1",
          CREATED,
        ),
      ).not.toThrow();

      const row = handle.sqlite
        .prepare("SELECT * FROM element_detach_snapshot WHERE id = 'snap1'")
        .get() as Record<string, unknown>;
      expect(row).toEqual({
        id: "snap1",
        element_id: "ext",
        source_element_id: "src",
        stable_block_id: "blk1",
        selected_text: "frozen anchor text",
        block_ids: '["blk1"]',
        start_offset: 3,
        end_offset: 17,
        pre_stale_hash: "hash-pre-stale",
        batch_id: "batch1",
        created_at: CREATED,
      });

      // Nullable anchor fields accept NULL (block-level detach, no pre-stale hash).
      expect(() =>
        insert.run(
          "snap2",
          "ext",
          "src",
          "blk1",
          "block-level anchor",
          '["blk1"]',
          null,
          null,
          null,
          "batch1",
          CREATED,
        ),
      ).not.toThrow();

      // Hard-deleting the element cascades its detach snapshots away.
      handle.sqlite.prepare("DELETE FROM elements WHERE id = 'ext'").run();
      const remaining = handle.sqlite
        .prepare("SELECT COUNT(*) AS n FROM element_detach_snapshot WHERE element_id = 'ext'")
        .get() as { n: number };
      expect(remaining.n).toBe(0);
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });
});
