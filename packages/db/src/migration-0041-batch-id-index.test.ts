/**
 * Migration `0041` test — promote `operation_log.batch_id` to an indexed column.
 *
 * The migration adds a nullable `operation_log.batch_id` TEXT column + the
 * `operation_log_batch_idx` index, then backfills it from the canonical JSON payload
 * (`json_extract(payload, '$.batchId')`, string-only) so batch undo
 * (`UndoService.collectBatch`) becomes an O(batch) indexed lookup instead of an
 * O(total ops) full-table scan + JS filter. It is purely additive — an
 * `ALTER TABLE … ADD COLUMN` (+ `CREATE INDEX` + one backfill UPDATE), NOT the table
 * rebuild that nulled lineage in the 0030 incident.
 *
 * This test seeds pre-0041 `operation_log` rows (a multi-op batch sharing a string
 * `batchId`, a single op with no `batchId`, and a row whose `batchId` is non-string),
 * runs to HEAD, and asserts: the column exists + is nullable, the index exists, the
 * string-only backfill is correct, every seeded row survives untouched, and FK /
 * integrity checks pass.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0041-"));
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

function withDbThrough40<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(40);
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

/** Insert a pre-0041 `operation_log` row (no `batch_id` column yet). */
function seedOp(handle: DbHandle, id: string, payload: unknown): void {
  handle.sqlite
    .prepare(
      `INSERT INTO operation_log (id, op_type, payload, element_id, created_at)
       VALUES (?, 'reschedule_element', ?, NULL, ?)`,
    )
    .run(id, JSON.stringify(payload), CREATED);
}

describe("migration 0041 — operation_log.batch_id index", () => {
  it("adds the nullable batch_id column and the operation_log_batch_idx index", () => {
    withDbThrough40((handle) => {
      seedOp(handle, "op1", { choice: "nextWeek" });
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const columns = handle.sqlite.prepare("PRAGMA table_info(operation_log)").all() as {
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }[];
      const batch = columns.find((c) => c.name === "batch_id");
      expect(batch).toBeDefined();
      expect(batch?.notnull).toBe(0); // nullable

      const indexes = handle.sqlite.prepare("PRAGMA index_list(operation_log)").all() as {
        readonly name: string;
      }[];
      expect(indexes.some((i) => i.name === "operation_log_batch_idx")).toBe(true);
    });
  });

  it("backfills string batchId from the payload; single ops stay NULL", () => {
    withDbThrough40((handle) => {
      // A bulk batch of two ops sharing one string batchId.
      seedOp(handle, "b1", { batchId: "batch-1", postpone: true });
      seedOp(handle, "b2", { batchId: "batch-1" });
      // A single-op action with no batchId.
      seedOp(handle, "s1", { choice: "nextWeek" });

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const batchId = (id: string) =>
        (
          handle.sqlite.prepare("SELECT batch_id FROM operation_log WHERE id = ?").get(id) as {
            batch_id: string | null;
          }
        ).batch_id;

      expect(batchId("b1")).toBe("batch-1");
      expect(batchId("b2")).toBe("batch-1");
      expect(batchId("s1")).toBeNull();
    });
  });

  it("does not backfill a non-string payload.batchId (mirrors the append guard)", () => {
    withDbThrough40((handle) => {
      seedOp(handle, "num", { batchId: 99 });
      seedOp(handle, "obj", { batchId: { nested: true } });
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const batchId = (id: string) =>
        (
          handle.sqlite.prepare("SELECT batch_id FROM operation_log WHERE id = ?").get(id) as {
            batch_id: string | null;
          }
        ).batch_id;

      expect(batchId("num")).toBeNull();
      expect(batchId("obj")).toBeNull();
    });
  });

  it("leaves existing rows otherwise untouched (additive, no rebuild row loss)", () => {
    withDbThrough40((handle) => {
      seedOp(handle, "b1", { batchId: "batch-1" });
      seedOp(handle, "s1", { choice: "nextWeek" });

      const before = handle.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_log").get() as {
        n: number;
      };

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const after = handle.sqlite
        .prepare(
          "SELECT id, op_type, payload, element_id, created_at FROM operation_log ORDER BY id",
        )
        .all() as {
        id: string;
        op_type: string;
        payload: string;
        element_id: string | null;
        created_at: string;
      }[];
      expect(after).toHaveLength(before.n);
      expect(after).toEqual([
        {
          id: "b1",
          op_type: "reschedule_element",
          payload: JSON.stringify({ batchId: "batch-1" }),
          element_id: null,
          created_at: CREATED,
        },
        {
          id: "s1",
          op_type: "reschedule_element",
          payload: JSON.stringify({ choice: "nextWeek" }),
          element_id: null,
          created_at: CREATED,
        },
      ]);

      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    });
  });

  it("a query filtering batch_id uses the new index (bounded cost)", () => {
    withDbThrough40((handle) => {
      seedOp(handle, "b1", { batchId: "batch-1" });
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const plan = handle.sqlite
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT * FROM operation_log WHERE batch_id = ? ORDER BY created_at DESC, rowid DESC`,
        )
        .all("batch-1") as { detail: string }[];
      const details = plan.map((row) => row.detail).join(" | ");
      expect(details).toContain("operation_log_batch_idx");
      expect(details).not.toMatch(/SCAN operation_log\b/);
    });
  });
});
