/**
 * Migration `0034` test — lineage-link repair.
 *
 * The original `0030_parked_elements` rebuilt `elements` on an enforcing
 * connection, where `DROP TABLE elements` fired `ON DELETE SET NULL` into the
 * freshly copied `__new_elements` rows and nulled every `parent_id`/`source_id`.
 * `0034` backfills the wiped links from the append-only `create_element`
 * operation-log payloads. These tests stage a database through `0033`, simulate
 * the wiped state directly (NULL links + intact op-log payloads — exactly what a
 * damaged vault looks like), then migrate to HEAD and assert the repair's
 * contract: fill only NULLs, only when the referenced element still exists, and
 * leave clean referential state behind.
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
  const dir = mkdtempSync(path.join(os.tmpdir(), "interleave-db-0034-"));
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

function withDbThrough33<T>(fn: (handle: DbHandle) => T): T {
  const staged = stageMigrationsThrough(33);
  const handle = openDatabase(":memory:");
  try {
    migrateDatabase(handle.db, staged.drizzle);
    return fn(handle);
  } finally {
    handle.sqlite.close();
    rmSync(staged.dir, { recursive: true, force: true });
  }
}

/** Insert an element row with explicit (possibly NULL) lineage links. */
function insertElement(
  handle: DbHandle,
  id: string,
  type: string,
  stage: string,
  parentId: string | null,
  sourceId: string | null,
  deletedAt: string | null = null,
): void {
  handle.sqlite
    .prepare(
      `INSERT INTO elements (
        id, type, status, stage, priority, title, parent_id, source_id, created_at, updated_at, deleted_at
      ) VALUES (?, ?, 'active', ?, 0.5, ?, ?, ?, '2026-06-08T00:00:00.000Z', '2026-06-08T00:00:00.000Z', ?)`,
    )
    .run(id, type, stage, `Title ${id}`, parentId, sourceId, deletedAt);
}

/** Insert the `create_element` op-log row a real creation would have appended. */
function insertCreateOp(
  handle: DbHandle,
  elementId: string,
  parentId: string | null,
  sourceId: string | null,
): void {
  handle.sqlite
    .prepare(
      `INSERT INTO operation_log (id, op_type, payload, element_id, created_at)
       VALUES (?, 'create_element', ?, ?, '2026-06-08T00:00:00.000Z')`,
    )
    .run(
      `op_${elementId}`,
      JSON.stringify({ element: { id: elementId, parentId, sourceId } }),
      elementId,
    );
}

describe("migration 0034 — repair lineage links", () => {
  it("backfills wiped parent/source links from create_element payloads", () => {
    withDbThrough33((handle) => {
      // The wiped shape: links NULL in `elements`, intact in the op log.
      insertElement(handle, "src", "source", "raw_source", null, null);
      insertElement(handle, "ext", "extract", "raw_extract", null, null);
      insertElement(handle, "card", "card", "active_card", null, null);
      insertCreateOp(handle, "src", null, null);
      insertCreateOp(handle, "ext", "src", "src");
      insertCreateOp(handle, "card", "ext", "src");

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const links = handle.sqlite.prepare("SELECT parent_id, source_id FROM elements WHERE id = ?");
      expect(links.get("src")).toEqual({ parent_id: null, source_id: null });
      expect(links.get("ext")).toEqual({ parent_id: "src", source_id: "src" });
      expect(links.get("card")).toEqual({ parent_id: "ext", source_id: "src" });
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  });

  it("repairs soft-deleted elements too — trash restore needs lineage", () => {
    withDbThrough33((handle) => {
      insertElement(handle, "src", "source", "raw_source", null, null);
      insertElement(handle, "gone", "card", "active_card", null, null, "2026-06-09T00:00:00.000Z");
      insertCreateOp(handle, "gone", "src", "src");

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      expect(
        handle.sqlite.prepare("SELECT parent_id, source_id FROM elements WHERE id = 'gone'").get(),
      ).toEqual({ parent_id: "src", source_id: "src" });
    });
  });

  it("fills only NULLs, skips dangling references, and tolerates link-less payloads", () => {
    withDbThrough33((handle) => {
      insertElement(handle, "src", "source", "raw_source", null, null);
      insertElement(handle, "kept", "extract", "raw_extract", null, null);
      // A link that was later changed legitimately: already non-NULL — untouched
      // even though the creation payload disagrees.
      insertElement(handle, "moved", "extract", "raw_extract", "src", "src");
      // The creation payload references an element that was since hard-purged.
      insertElement(handle, "orphan", "extract", "raw_extract", null, null);
      // Payload carries explicit nulls (a root-less element) — stays NULL.
      insertElement(handle, "rootless", "extract", "raw_extract", null, null);
      insertCreateOp(handle, "kept", "src", "src");
      insertCreateOp(handle, "moved", "ghost_parent", "ghost_source");
      insertCreateOp(handle, "orphan", "ghost_parent", "ghost_source");
      insertCreateOp(handle, "rootless", null, null);

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      const links = handle.sqlite.prepare("SELECT parent_id, source_id FROM elements WHERE id = ?");
      expect(links.get("kept")).toEqual({ parent_id: "src", source_id: "src" });
      expect(links.get("moved")).toEqual({ parent_id: "src", source_id: "src" });
      expect(links.get("orphan")).toEqual({ parent_id: null, source_id: null });
      expect(links.get("rootless")).toEqual({ parent_id: null, source_id: null });
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    });
  });

  it("leaves no element whose payload names a live parent while the row stays NULL", () => {
    withDbThrough33((handle) => {
      insertElement(handle, "src", "source", "raw_source", null, null);
      insertElement(handle, "a", "extract", "raw_extract", null, null);
      insertElement(handle, "b", "card", "active_card", null, null);
      insertCreateOp(handle, "a", "src", "src");
      insertCreateOp(handle, "b", "a", "src");

      migrateDatabase(handle.db, MIGRATIONS_DIR);

      // The repair's invariant, stated as the query a future audit would run:
      // zero rows where the op log says a parent existed, that parent is still
      // present, and the element's parent_id is NULL.
      const mismatches = handle.sqlite
        .prepare(
          `SELECT COUNT(*) AS n
           FROM elements e
           JOIN operation_log o ON o.element_id = e.id AND o.op_type = 'create_element'
           JOIN elements p ON p.id = json_extract(o.payload, '$.element.parentId')
           WHERE e.parent_id IS NULL`,
        )
        .get() as { readonly n: number };
      expect(mismatches.n).toBe(0);
    });
  });
});
