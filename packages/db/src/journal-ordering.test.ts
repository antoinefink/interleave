import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "./paths";

/**
 * Guard against the Drizzle high-water-mark migration skip.
 *
 * Drizzle's better-sqlite3 migrator does NOT track applied migrations by tag or
 * hash. It records only the `created_at` (= the journal entry's `when`/folderMillis)
 * of the most-recently-applied migration, then runs a migration only when
 * `migration.when > maxAppliedWhen`. On an ALREADY-migrated database, a new
 * migration whose `when` is <= the current high-water mark is therefore SILENTLY
 * SKIPPED — its tables are never created even though the `.sql` exists and is
 * journaled.
 *
 * Fresh databases escape this entirely: the high-water mark is read once, before
 * the apply loop, so it stays `undefined` and every migration applies regardless
 * of `when` order. That is exactly why `pnpm test`, `db:reset:dev`, and CI (all of
 * which build from empty) never catch an out-of-order `when` — only a real,
 * incrementally-migrated app database does (this happened to 0029, whose generated
 * `when` predated 0028 and was skipped on existing installs).
 *
 * The only durable defense is to keep journal `when` values STRICTLY INCREASING in
 * `idx` order, so a newer migration always out-ranks every older one. If
 * `drizzle-kit generate` ever emits an out-of-order `when` again, this test fails
 * before the migration ships.
 */
interface JournalEntry {
  readonly idx: number;
  readonly when: number;
  readonly tag: string;
}
interface Journal {
  readonly entries: readonly JournalEntry[];
}

function loadJournal(): Journal {
  const file = path.join(MIGRATIONS_DIR, "meta", "_journal.json");
  return JSON.parse(readFileSync(file, "utf8")) as Journal;
}

describe("migration journal ordering", () => {
  it("assigns sequential idx values starting at 0", () => {
    const { entries } = loadJournal();
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });
  });

  it("keeps `when` timestamps strictly increasing in idx order", () => {
    const { entries } = loadJournal();
    let prev: JournalEntry | undefined;
    for (const curr of entries) {
      if (prev) {
        // A failure here means `curr` (and anything else <= the high-water mark)
        // would be SILENTLY SKIPPED on an already-migrated database. Fix it by
        // lowering the offending earlier entry's `when` (preferred when one entry
        // spikes above its neighbours) or raising this one, until the sequence is
        // monotonic. See this file's header for the full failure mode.
        expect(
          curr.when,
          `journal entry ${curr.tag} (idx ${curr.idx}, when ${curr.when}) is not strictly after ` +
            `${prev.tag} (idx ${prev.idx}, when ${prev.when}) — it would be skipped on existing DBs`,
        ).toBeGreaterThan(prev.when);
      }
      prev = curr;
    }
  });
});
