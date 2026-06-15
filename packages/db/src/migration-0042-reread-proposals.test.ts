/**
 * Migration `0042` test — re-read proposals (T129).
 *
 * T129 widens the closed task-kind CHECK with `reread_region` (a system-owned task
 * that re-reads a source region whose descendant cards keep lapsing) and adds the
 * `reread_proposal_dismissals` table for dismissal memory. Widening the CHECK rebuilds
 * `tasks`, so this test stages a pre-0042 database with an existing lineage graph + a
 * linked task row, migrates to HEAD, and verifies BOTH the preservation guarantee
 * (the rebuild never wipes lineage — the migration-0030 regression class) and the new
 * constraints (CHECK widening, both partial unique indexes intact, the new table).
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0042-"));
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

function withDbThrough41<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(41);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

function insertElement(
  handle: DbHandle,
  id: string,
  type: string,
  opts: { parentId?: string | null; sourceId?: string | null } = {},
): void {
  handle.sqlite
    .prepare(
      `INSERT INTO elements (
        id, type, status, stage, priority, title, parent_id, source_id, created_at, updated_at
      ) VALUES (?, ?, 'scheduled', 'rough_topic', 0.5, ?, ?, ?, '2026-06-12T00:00:00.000Z', '2026-06-12T00:00:00.000Z')`,
    )
    .run(id, type, `Element ${id}`, opts.parentId ?? null, opts.sourceId ?? null);
}

function insertTaskRow(
  handle: DbHandle,
  id: string,
  taskType: string,
  status = "scheduled",
  linkedElementId: string | null = null,
): void {
  handle.sqlite
    .prepare(
      `INSERT INTO tasks (element_id, task_type, due_at, status, linked_element_id, note)
       VALUES (?, ?, '2026-06-12T00:00:00.000Z', ?, ?, NULL)`,
    )
    .run(id, taskType, status, linkedElementId);
}

describe("migration 0042 — re-read proposals", () => {
  it("preserves lineage across the tasks rebuild (migration-0030 regression class)", () => {
    withDbThrough41((handle) => {
      // Seed a real lineage graph: source <- extract <- card, plus a linked task.
      insertElement(handle, "src-1", "source");
      insertElement(handle, "ext-1", "extract", { parentId: "src-1", sourceId: "src-1" });
      insertElement(handle, "card-1", "card", { parentId: "ext-1", sourceId: "src-1" });
      insertElement(handle, "task-1", "task");
      insertTaskRow(handle, "task-1", "custom", "scheduled", "ext-1");

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      // Lineage survives the tasks rebuild — parent_id / source_id intact.
      expect(
        handle.sqlite.prepare("SELECT parent_id, source_id FROM elements WHERE id = 'ext-1'").get(),
      ).toEqual({ parent_id: "src-1", source_id: "src-1" });
      expect(
        handle.sqlite
          .prepare("SELECT parent_id, source_id FROM elements WHERE id = 'card-1'")
          .get(),
      ).toEqual({ parent_id: "ext-1", source_id: "src-1" });
      // The linked task row + its FK survive.
      expect(
        handle.sqlite
          .prepare("SELECT task_type, linked_element_id FROM tasks WHERE element_id = 'task-1'")
          .get(),
      ).toEqual({ task_type: "custom", linked_element_id: "ext-1" });
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });

  it("widens the task-kind CHECK to accept reread_region and still rejects unknown kinds", () => {
    withDbThrough41((handle) => {
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      insertElement(handle, "ext-1", "extract");
      insertElement(handle, "rr-1", "task");
      expect(() =>
        insertTaskRow(handle, "rr-1", "reread_region", "scheduled", "ext-1"),
      ).not.toThrow();

      insertElement(handle, "bad-1", "task");
      expect(() => insertTaskRow(handle, "bad-1", "not_a_task_type")).toThrow(
        /CHECK constraint failed/,
      );
    });
  });

  it("enforces one OPEN reread_region per linked region via the partial unique index", () => {
    withDbThrough41((handle) => {
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      insertElement(handle, "ext-1", "extract");
      insertElement(handle, "rr-open", "task");
      insertTaskRow(handle, "rr-open", "reread_region", "scheduled", "ext-1");

      // A second OPEN reread_region for the same region is rejected.
      insertElement(handle, "rr-open-2", "task");
      expect(() =>
        insertTaskRow(handle, "rr-open-2", "reread_region", "scheduled", "ext-1"),
      ).toThrow(/tasks_open_link_type_uq|UNIQUE constraint failed/);

      // A DONE reread_region for the same region is allowed (the index is partial).
      insertElement(handle, "rr-done", "task");
      expect(() =>
        insertTaskRow(handle, "rr-done", "reread_region", "done", "ext-1"),
      ).not.toThrow();

      // The weekly-review singleton index is still intact after the rebuild.
      insertElement(handle, "wk-1", "task");
      insertTaskRow(handle, "wk-1", "weekly_review");
      insertElement(handle, "wk-2", "task");
      expect(() => insertTaskRow(handle, "wk-2", "weekly_review")).toThrow(
        /tasks_open_weekly_review_uq|UNIQUE constraint failed/,
      );
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });

  it("creates reread_proposal_dismissals with counter round-trip and FK cascade", () => {
    withDbThrough41((handle) => {
      migrateDatabase(handle.db, MIGRATIONS_DIR);

      insertElement(handle, "anc-1", "extract");
      handle.sqlite
        .prepare(
          `INSERT INTO reread_proposal_dismissals
             (ancestor_id, state_hash, total_window_lapses, affected_card_count, dismissed_at)
           VALUES ('anc-1', 'v1:hash', 7, 3, '2026-06-15T00:00:00.000Z')`,
        )
        .run();
      expect(
        handle.sqlite
          .prepare(
            "SELECT state_hash, total_window_lapses, affected_card_count FROM reread_proposal_dismissals WHERE ancestor_id = 'anc-1'",
          )
          .get(),
      ).toEqual({ state_hash: "v1:hash", total_window_lapses: 7, affected_card_count: 3 });

      // FK cascade: hard-deleting the ancestor element removes the dismissal.
      handle.sqlite.prepare("DELETE FROM elements WHERE id = 'anc-1'").run();
      expect(
        handle.sqlite.prepare("SELECT COUNT(*) AS n FROM reread_proposal_dismissals").get(),
      ).toMatchObject({ n: 0 });
    });
  });
});
