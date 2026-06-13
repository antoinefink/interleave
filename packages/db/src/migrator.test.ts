import { EMBEDDING_DIM } from "@interleave/core";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./client";
import { applyVecMigration, migrateDatabase } from "./migrator";
import { MIGRATIONS_DIR } from "./paths";
import { loadVectorExtension, vecFunctional } from "./vec";

function tableNames(filename = ":memory:") {
  const handle = openDatabase(filename);
  return {
    handle,
    names: () =>
      handle.sqlite
        .prepare("select name from sqlite_master where type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name),
  };
}

describe("migrateDatabase", () => {
  it("applies the generated migrations and can be called twice", () => {
    const { handle, names } = tableNames();
    try {
      migrateDatabase(handle.db);
      migrateDatabase(handle.db);
      expect(names()).toEqual(expect.arrayContaining(["elements", "sources", "operation_log"]));
    } finally {
      handle.sqlite.close();
    }
  });

  it("supports the legacy string migrations-folder argument", () => {
    const { handle, names } = tableNames();
    try {
      migrateDatabase(handle.db, MIGRATIONS_DIR);
      expect(names()).toContain("__drizzle_migrations");
    } finally {
      handle.sqlite.close();
    }
  });

  it("skips the sqlite-vec table unless vecAvailable is true", () => {
    const { handle, names } = tableNames();
    try {
      migrateDatabase(handle.db, { vecAvailable: false });
      expect(names()).not.toContain("element_vectors");
    } finally {
      handle.sqlite.close();
    }
  });

  it("restores foreign_keys = ON and leaves clean referential state", () => {
    // Migrations run with enforcement OFF (the documented SQLite table-rebuild
    // procedure — see 0030), so the runner must hand the connection back with
    // the mandatory pragma re-enabled and a clean foreign_key_check.
    const { handle } = tableNames();
    try {
      migrateDatabase(handle.db);
      expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(handle.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      handle.sqlite.close();
    }
  });

  it("refuses to run while a transaction is open (the pragma would silently no-op)", () => {
    const { handle } = tableNames();
    try {
      handle.sqlite.exec("BEGIN");
      expect(() => migrateDatabase(handle.db)).toThrow(/could not disable foreign_keys/);
      handle.sqlite.exec("ROLLBACK");
      // Recovery: the same connection migrates fine once the transaction ends.
      migrateDatabase(handle.db);
      expect(handle.sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    } finally {
      handle.sqlite.close();
    }
  });
});

describe("applyVecMigration", () => {
  it("throws clearly when called without a loaded sqlite-vec extension", () => {
    const { handle } = tableNames();
    try {
      expect(() => applyVecMigration(handle.db)).toThrow(/vec0|no such module/i);
    } finally {
      handle.sqlite.close();
    }
  });

  it("creates the vector table at the active embedding dimension when sqlite-vec works", () => {
    const { handle } = tableNames();
    try {
      loadVectorExtension(handle.sqlite);
      if (!vecFunctional(handle.sqlite)) return;

      applyVecMigration(handle.db);
      const row = handle.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'element_vectors'")
        .get() as { sql?: string } | undefined;
      expect(row?.sql).toContain(`float[${EMBEDDING_DIM}]`);
    } finally {
      handle.sqlite.close();
    }
  });

  it("rebuilds an old wrong-dimension vector table so the derived index can rehydrate", () => {
    const { handle } = tableNames();
    try {
      loadVectorExtension(handle.sqlite);
      if (!vecFunctional(handle.sqlite)) return;

      migrateDatabase(handle.db, { vecAvailable: false });
      handle.sqlite.exec("CREATE VIRTUAL TABLE element_vectors USING vec0(embedding float[384])");
      handle.sqlite
        .prepare(
          `INSERT INTO elements
            (id, type, status, stage, priority, title, created_at, updated_at)
           VALUES
            ('src-old-vector', 'source', 'inbox', 'raw_source', 0.5, 'Old vector',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      handle.sqlite
        .prepare(
          `INSERT INTO embeddings
            (element_id, vec_rowid, element_type, model_id, dim, content_hash, created_at, updated_at)
           VALUES
            ('src-old-vector', 1, 'source', 'local:all-MiniLM-L6-v2', 384, 'h-old',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run();
      applyVecMigration(handle.db);

      const row = handle.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'element_vectors'")
        .get() as { sql?: string } | undefined;
      expect(row?.sql).toContain(`float[${EMBEDDING_DIM}]`);
      expect(row?.sql).not.toContain("float[384]");
      expect(
        (handle.sqlite.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      handle.sqlite.close();
    }
  });
});
