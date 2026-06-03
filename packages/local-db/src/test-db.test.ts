import { describe, expect, it } from "vitest";
import { createInMemoryDb, isVecAvailable } from "./test-db";

describe("createInMemoryDb", () => {
  it("opens a migrated in-memory database with mandatory pragmas", () => {
    const handle = createInMemoryDb();
    try {
      const foreignKeys = handle.sqlite.pragma("foreign_keys", { simple: true });
      const busyTimeout = handle.sqlite.pragma("busy_timeout", { simple: true });
      const tables = handle.sqlite
        .prepare("select name from sqlite_master where type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);

      expect(foreignKeys).toBe(1);
      expect(busyTimeout).toBe(5000);
      expect(tables).toEqual(expect.arrayContaining(["elements", "sources", "settings"]));
      expect(typeof isVecAvailable(handle)).toBe("boolean");
    } finally {
      handle.sqlite.close();
    }
  });
});
