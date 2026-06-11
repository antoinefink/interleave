/**
 * Migration `0030` test — parked lifecycle state for Save for later.
 *
 * T101 widens the shared ElementStatus CHECKs and adds `elements.parked_at`.
 * Historical `dismissed` rows cannot be reclassified because old data does not
 * distinguish "saved for later" from Abandon, so the migration leaves them as-is.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0030-"));
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

function withDbThrough29<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(29);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

function seedLegacyGraph(handle: DbHandle): void {
  const created = "2026-05-01T00:00:00.000Z";
  const updated = "2026-05-02T00:00:00.000Z";
  const insertElement = handle.sqlite.prepare(
    `INSERT INTO elements (
      id, type, status, stage, priority, due_at, title, parent_id, source_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0.5, ?, ?, ?, ?, ?, ?)`,
  );
  insertElement.run(
    "source_legacy",
    "source",
    "dismissed",
    "raw_source",
    null,
    "Legacy dismissed",
    null,
    null,
    created,
    updated,
  );
  insertElement.run(
    "extract_legacy",
    "extract",
    "active",
    "raw_extract",
    null,
    "Legacy extract",
    "source_legacy",
    "source_legacy",
    created,
    updated,
  );
  insertElement.run(
    "card_legacy",
    "card",
    "scheduled",
    "active_card",
    "2026-05-03T00:00:00.000Z",
    "Legacy card",
    "extract_legacy",
    "source_legacy",
    created,
    updated,
  );
  insertElement.run(
    "task_legacy",
    "task",
    "dismissed",
    "rough_topic",
    null,
    "Legacy task",
    null,
    null,
    created,
    updated,
  );

  handle.sqlite
    .prepare("INSERT INTO sources (element_id, url) VALUES (?, ?)")
    .run("source_legacy", "https://example.test/legacy");
  handle.sqlite
    .prepare(
      `INSERT INTO documents (
        element_id, prosemirror_json, plain_text, schema_version, updated_at
      ) VALUES (?, ?, ?, 1, ?)`,
    )
    .run("source_legacy", JSON.stringify({ type: "doc", content: [] }), "Legacy body", updated);
  handle.sqlite
    .prepare(
      `INSERT INTO document_blocks (
        id, document_id, block_type, "order", stable_block_id
      ) VALUES (?, ?, 'paragraph', 0, ?)`,
    )
    .run("block_row_legacy", "source_legacy", "blk_legacy");
  handle.sqlite
    .prepare(
      `INSERT INTO document_marks (
        id, document_id, block_id, mark_type, range, attrs
      ) VALUES (?, ?, ?, 'highlight', '[0,6]', NULL)`,
    )
    .run("mark_legacy", "source_legacy", "blk_legacy");
  handle.sqlite
    .prepare(
      `INSERT INTO source_locations (
        id, element_id, source_element_id, block_ids, start_offset, end_offset, label, selected_text
      ) VALUES (?, ?, ?, ?, 0, 6, ?, ?)`,
    )
    .run(
      "loc_legacy",
      "extract_legacy",
      "source_legacy",
      JSON.stringify(["blk_legacy"]),
      "Legacy · ¶1",
      "Legacy selection",
    );
  handle.sqlite
    .prepare(
      `INSERT INTO cards (
        element_id, kind, prompt, answer, source_location_id
      ) VALUES (?, 'qa', ?, ?, ?)`,
    )
    .run("card_legacy", "Legacy prompt", "Legacy answer", "loc_legacy");
  handle.sqlite
    .prepare(
      `INSERT INTO review_states (
        element_id, due_at, stability, difficulty, elapsed_days, scheduled_days, reps, lapses, fsrs_state
      ) VALUES (?, ?, 2, 5, 1, 3, 1, 0, 'review')`,
    )
    .run("card_legacy", "2026-05-03T00:00:00.000Z");
  handle.sqlite
    .prepare(
      `INSERT INTO review_logs (
        id, element_id, rating, reviewed_at, response_ms, prev_state, next_state,
        next_stability, next_difficulty, next_due_at
      ) VALUES (?, ?, 'good', ?, 1200, 'new', 'review', 2, 5, ?)`,
    )
    .run("review_log_legacy", "card_legacy", updated, "2026-05-03T00:00:00.000Z");
  handle.sqlite
    .prepare(
      `INSERT INTO element_relations (
        id, from_element_id, to_element_id, relation_type, created_at
      ) VALUES (?, ?, ?, 'derived_from', ?)`,
    )
    .run("relation_legacy", "extract_legacy", "source_legacy", created);
  handle.sqlite
    .prepare(
      `INSERT INTO read_points (
        id, element_id, document_id, block_id, offset, updated_at
      ) VALUES (?, ?, ?, ?, 5, ?)`,
    )
    .run("read_point_legacy", "source_legacy", "source_legacy", "blk_legacy", updated);
  handle.sqlite
    .prepare(
      `INSERT INTO assets (
        id, owning_element_id, kind, vault_root, relative_path, content_hash, mime, size, created_at
      ) VALUES (?, ?, 'snapshot', 'assets', ?, ?, 'text/html', 42, ?)`,
    )
    .run(
      "asset_legacy",
      "source_legacy",
      "sources/source_legacy/snapshot.html",
      "sha256-legacy",
      created,
    );
  handle.sqlite
    .prepare(
      `INSERT INTO operation_log (
        id, op_type, payload, element_id, created_at
      ) VALUES (?, 'create_element', ?, ?, ?)`,
    )
    .run(
      "op_legacy",
      JSON.stringify({ id: "source_legacy", type: "source" }),
      "source_legacy",
      created,
    );
  handle.sqlite
    .prepare(
      `INSERT INTO tasks (
        element_id, task_type, due_at, status, linked_element_id, note
      ) VALUES (?, 'custom', NULL, 'dismissed', NULL, NULL)`,
    )
    .run("task_legacy");
}

function count(handle: DbHandle, table: string, where = "1=1"): number {
  return (
    handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as {
      readonly n: number;
    }
  ).n;
}

function ftsIds(handle: DbHandle, table: string, term: string): string[] {
  return (
    handle.sqlite.prepare(`SELECT element_id FROM ${table} WHERE ${table} MATCH ?`).all(term) as {
      readonly element_id: string;
    }[]
  ).map((row) => row.element_id);
}

describe("migration 0030 — parked lifecycle state", () => {
  it("adds parked_at, preserves dependent rows, and keeps FTS triggers live", () => {
    withDbThrough29((handle) => {
      seedLegacyGraph(handle);

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const columnInfo = handle.sqlite.prepare("PRAGMA table_info('elements')").all() as {
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }[];
      const parkedAt = columnInfo.find((column) => column.name === "parked_at");
      expect(parkedAt).toBeDefined();
      expect(parkedAt?.notnull).toBe(0);
      expect(parkedAt?.dflt_value).toBeNull();

      const legacy = handle.sqlite
        .prepare("SELECT status, parked_at FROM elements WHERE id = ?")
        .get("source_legacy") as { status: string; parked_at: string | null };
      expect(legacy).toEqual({ status: "dismissed", parked_at: null });

      const legacyTask = handle.sqlite
        .prepare("SELECT status FROM tasks WHERE element_id = ?")
        .get("task_legacy") as { status: string };
      expect(legacyTask.status).toBe("dismissed");

      expect(count(handle, "sources", "element_id = 'source_legacy'")).toBe(1);
      expect(count(handle, "documents", "element_id = 'source_legacy'")).toBe(1);
      expect(count(handle, "document_blocks", "document_id = 'source_legacy'")).toBe(1);
      expect(count(handle, "document_marks", "document_id = 'source_legacy'")).toBe(1);
      expect(count(handle, "source_locations", "element_id = 'extract_legacy'")).toBe(1);
      expect(count(handle, "cards", "element_id = 'card_legacy'")).toBe(1);
      expect(count(handle, "review_states", "element_id = 'card_legacy'")).toBe(1);
      expect(count(handle, "review_logs", "element_id = 'card_legacy'")).toBe(1);
      expect(count(handle, "element_relations", "from_element_id = 'extract_legacy'")).toBe(1);
      expect(count(handle, "read_points", "element_id = 'source_legacy'")).toBe(1);
      expect(count(handle, "assets", "owning_element_id = 'source_legacy'")).toBe(1);
      expect(count(handle, "operation_log", "element_id = 'source_legacy'")).toBe(1);

      expect(() => {
        handle.sqlite
          .prepare(
            `INSERT INTO elements (
              id, type, status, stage, priority, parked_at, title, created_at, updated_at
            ) VALUES (?, 'source', 'parked', 'raw_source', 0.5, ?, 'Parked source', ?, ?)`,
          )
          .run(
            "source_parked",
            "2026-06-11T00:00:00.000Z",
            "2026-06-11T00:00:00.000Z",
            "2026-06-11T00:00:00.000Z",
          );
      }).not.toThrow();

      expect(() => {
        handle.sqlite
          .prepare(
            `INSERT INTO elements (
              id, type, status, stage, priority, title, created_at, updated_at
            ) VALUES (?, 'task', 'parked', 'rough_topic', 0.5, 'Parked task', ?, ?)`,
          )
          .run("task_parked", "2026-06-11T00:00:00.000Z", "2026-06-11T00:00:00.000Z");
        handle.sqlite
          .prepare(
            `INSERT INTO tasks (
              element_id, task_type, due_at, status, linked_element_id, note
            ) VALUES (?, 'custom', NULL, 'parked', NULL, NULL)`,
          )
          .run("task_parked");
      }).not.toThrow();

      expect(() => {
        handle.sqlite
          .prepare(
            `INSERT INTO elements (
              id, type, status, stage, priority, title, created_at, updated_at
            ) VALUES (?, 'task', 'scheduled', 'rough_topic', 0.5, 'Open duplicate', ?, ?)`,
          )
          .run("task_open_dup", "2026-06-11T00:00:00.000Z", "2026-06-11T00:00:00.000Z");
        handle.sqlite
          .prepare(
            `INSERT INTO tasks (
              element_id, task_type, due_at, status, linked_element_id, note
            ) VALUES (?, 'verify_claim', NULL, 'scheduled', 'card_legacy', NULL)`,
          )
          .run("task_open_dup");
        handle.sqlite
          .prepare(
            `INSERT INTO elements (
              id, type, status, stage, priority, title, created_at, updated_at
            ) VALUES (?, 'task', 'scheduled', 'rough_topic', 0.5, 'Fresh duplicate', ?, ?)`,
          )
          .run("task_open_fresh", "2026-06-11T00:00:00.000Z", "2026-06-11T00:00:00.000Z");
        handle.sqlite
          .prepare(
            `INSERT INTO tasks (
              element_id, task_type, due_at, status, linked_element_id, note
            ) VALUES (?, 'verify_claim', NULL, 'scheduled', 'card_legacy', NULL)`,
          )
          .run("task_open_fresh");
      }).toThrow();

      handle.sqlite
        .prepare("UPDATE tasks SET status = 'parked' WHERE element_id = ?")
        .run("task_open_dup");
      expect(() => {
        handle.sqlite
          .prepare(
            `INSERT INTO tasks (
              element_id, task_type, due_at, status, linked_element_id, note
            ) VALUES (?, 'verify_claim', NULL, 'scheduled', 'card_legacy', NULL)`,
          )
          .run("task_open_fresh");
      }).not.toThrow();

      expect(() => {
        handle.sqlite
          .prepare(
            `INSERT INTO elements (
              id, type, status, stage, priority, title, created_at, updated_at
            ) VALUES (?, 'source', 'not-a-status', 'raw_source', 0.5, 'Bad', ?, ?)`,
          )
          .run("source_bad", "2026-06-11T00:00:00.000Z", "2026-06-11T00:00:00.000Z");
      }).toThrow();

      handle.sqlite
        .prepare("UPDATE documents SET plain_text = ? WHERE element_id = ?")
        .run("source trigger searchable", "source_legacy");
      expect(ftsIds(handle, "source_fts", "searchable")).toContain("source_legacy");

      handle.sqlite
        .prepare("UPDATE source_locations SET selected_text = ? WHERE id = ?")
        .run("extract trigger searchable", "loc_legacy");
      expect(ftsIds(handle, "extract_fts", "searchable")).toContain("extract_legacy");

      handle.sqlite
        .prepare("UPDATE cards SET prompt = ? WHERE element_id = ?")
        .run("card trigger searchable", "card_legacy");
      expect(ftsIds(handle, "card_fts", "searchable")).toContain("card_legacy");

      expect(handle.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });
});
