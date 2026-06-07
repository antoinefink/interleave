---
title: "Drizzle migrator tracks only a high-water mark, so out-of-order journal `when` values silently skip migrations"
date: "2026-06-07"
category: "database-issues"
module: "db-migrations"
problem_type: "database_issue"
component: "database"
severity: "critical"
symptoms:
  - "`library:browse` IPC handler crashed with `SqliteError: no such table: source_block_processing`."
  - "Migration `0029_source_block_processing` was skipped on already-migrated databases, so its tables were never created."
  - "Fresh databases (vitest, CI, db:reset:dev, seed) passed, so no automated test caught the regression."
  - "`source_block_processing` and `source_block_processing_outputs` tables absent despite the migration existing on disk."
root_cause: "config_error"
resolution_type: "migration"
related_components:
  - "tooling"
  - "testing_framework"
tags:
  - "drizzle"
  - "better-sqlite3"
  - "migrations"
  - "high-water-mark"
  - "journal-ordering"
  - "sqlite"
---

# Drizzle migrator tracks only a high-water mark, so out-of-order journal `when` values silently skip migrations

## Problem

Drizzle's `better-sqlite3` migrator skips any journaled migration whose `when` timestamp is not strictly greater than the high-water mark of already-applied migrations. Migration `0029_source_block_processing` was generated with a `when` *earlier* than the already-applied `0028`, so it was silently skipped on real incrementally-migrated databases, leaving its tables uncreated and crashing the library screen.

## Symptoms

- Every `library:browse` IPC call failed at runtime with:
  ```
  SqliteError: no such table: source_block_processing   (code: SQLITE_ERROR)
  ```
- The throw originated in `BlockProcessingRepository.listRows` → `BlockProcessingService.listBlockViews`.
- Tables `source_block_processing` and `source_block_processing_outputs` were missing from the live DB at `~/Library/Application Support/Interleave/app.sqlite`, even though `0029_source_block_processing.sql` existed in `packages/db/drizzle/` and was listed in `meta/_journal.json`.
- Only affected developers/users with an existing, incrementally-migrated database; fresh installs were fine.

## What Didn't Work / Why It's Confusing

Several signals all said "everything is correct," which masked the real cause:

- **The `.sql` file existed and was journaled.** `0029_source_block_processing.sql` was present and had a proper entry in `meta/_journal.json`. By every static check the migration was "there" — nothing missing or malformed.
- **All tests and CI were green.** `pnpm test` (vitest, in-memory), `db:reset:dev`, `seed`, and CI all created the tables correctly. Nothing in the automated suite reproduced the failure.
- **Only existing databases broke.** The failure was invisible on any fresh DB and surfaced only on a real, long-lived database — the hardest environment to inspect and the easiest to dismiss as "local corruption."
- The natural first instincts (re-check the SQL, re-run `db:generate`, inspect the repository/service code) all came up clean, because the bug was not in the SQL, the schema, or the query code — it was in the *ordering metadata* and the migrator's comparison logic.

## Solution

1. **Fixed `0029`'s out-of-order timestamp.** In `packages/db/drizzle/meta/_journal.json`, changed `0029_source_block_processing`'s `when` from the generated `1780828800000` (earlier than `0028`'s `1780850800000`) to `1780861440000` (its real commit time, strictly after `0028`). On the existing DB the next launch evaluates `1780850800000 < 1780861440000` → true → `0029` applies and the tables are created; idempotent thereafter.

   | tag | when (before) | when (after) |
   |-----|---------------|--------------|
   | `0028_review_stats_snapshot` | 1780850800000 | 1780850800000 (unchanged) |
   | `0029_source_block_processing` | **1780828800000** | **1780861440000** |

2. **Normalized a pre-existing spike at `0002`.** `0002_search_fts5`'s `when` was `1780217202483`, which sat *above* its successors `0003` (1780157743366), `0004` (1780158801289), and `0005` (1780172530484) — the real outlier. Lowered `0002` to `1780140000000` (between `0001` = 1780130802483 and `0003` = 1780157743366).

   | tag | when (before) | when (after) |
   |-----|---------------|--------------|
   | `0001_clever_rictor` | 1780130802483 | 1780130802483 (unchanged) |
   | `0002_search_fts5` | **1780217202483** | **1780140000000** |
   | `0003_overrated_thundra` | 1780157743366 | 1780157743366 (unchanged) |

   `0002` was *lowered* rather than raising `0003`, because raising `0003` would cascade into `0004`/`0005` and risk re-running `0003`'s destructive `DROP TABLE concepts` rebuild (see Prevention).

3. **Added a regression guard:** `packages/db/src/journal-ordering.test.ts`, which reads `_journal.json` and asserts (a) `idx` values are sequential from 0, and (b) `when` timestamps are strictly increasing in `idx` order.

4. **Verified the fix on real data.** Copied the live DB and applied `0029`'s SQL (with `--> statement-breakpoint` markers stripped): both tables created, 0 legacy rows to backfill, `PRAGMA foreign_key_check` clean. `pnpm typecheck` (14/14) and the new ordering test both pass.

## Why This Works

Drizzle's `drizzle-orm/better-sqlite3` migrator does **not** track applied migrations by hash or tag. Inside `SQLiteSyncDialect.migrate`, it reads the high-water mark **once, before the apply loop**:

```sql
SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1
```

Then, for each journal entry, it applies the migration only when there is no prior record **or** `Number(lastDbMigration.created_at) < migration.folderMillis` (the `folderMillis` is the entry's `when` from `_journal.json`). Crucially, `lastDbMigration` is captured before the loop and **never refreshed inside it**.

This creates a **fresh-vs-existing-DB asymmetry**:

- **Existing DB:** `__drizzle_migrations` is populated, so the high-water mark is a real timestamp. `0028` (when = 1780850800000) had already advanced the mark above `0029`'s generated `when` (1780828800000), so `1780850800000 < 1780828800000` was false and `0029` was **skipped** — even though its `.sql` was present and journaled. Bumping `0029`'s `when` above `0028`'s makes the comparison true exactly once, applying it; on subsequent launches the mark is ≥ `0029`'s `when`, so it never re-runs.
- **Fresh DB:** `__drizzle_migrations` is empty, so `lastDbMigration` is `undefined` for the *entire* loop (read once, never updated). The "no prior record" branch is always taken, so **every** migration applies regardless of `when` order. All of Interleave's automated databases (vitest in-memory, `db:reset:dev`, `seed`, CI) are fresh-built, which is exactly why none of them could ever reproduce the skip.

The repo's `migrateDatabase` wrapper (`packages/db/src/migrator.ts`) delegates to this stock `migrate(...)`, so it inherits the behavior verbatim.

## Prevention

- **A monotonic-`when` guard test now blocks the failure mode at commit time.** `packages/db/src/journal-ordering.test.ts` asserts the journal's `when` values are strictly increasing in `idx` order:

  ```ts
  expect(
    curr.when,
    `journal entry ${curr.tag} (idx ${curr.idx}, when ${curr.when}) is not strictly after ` +
      `${prev.tag} (idx ${prev.idx}, when ${prev.when}) — it would be skipped on existing DBs`,
  ).toBeGreaterThan(prev.when);
  ```

  Because fresh DBs never reproduce the skip, this static check on the journal file is the only defense that runs in CI. If `drizzle-kit generate` ever emits an out-of-order `when` again, this test fails *before* the migration ships, instead of failing silently on users' existing databases.

- **`drizzle-kit generate` can legitimately emit an out-of-order `when`** (clock skew, rebasing/cherry-picking migrations across branches, or hand-edited journals). Never assume a freshly generated journal is monotonic — let the guard test verify it.

- **Prefer lowering an out-of-order *earlier* entry** over raising the new one. When a single entry spikes above its neighbours (as `0002` did), lowering that one entry fixes the whole sequence with minimal blast radius; raising a later entry can cascade through everything after it.

- **Choose the edit to avoid re-running destructive migrations.** Any DB past a given migration has a high-water mark ≥ that migration's old `when`, so *lowering* an already-applied entry can never re-trigger it. Conversely, *raising* an entry's `when` above some installed DBs' high-water mark could make a destructive step (e.g. a `DROP TABLE … rebuild`) re-run and lose data. This is why `0002` was lowered rather than raising `0003`.

## Related

- [Track source block processing as durable source-scoped state](../architecture-patterns/durable-source-block-processing-state.md) — the feature whose migration (`0029`) was the one silently skipped here. This doc is the migration-machinery failure mode of that feature's rollout.
- [Electron SQLite backup/restore/reset coordination](../architecture-patterns/electron-sqlite-backup-restore-reset-coordination.md) — `db:reset` and other fresh-DB paths read the high-water mark as `undefined`, so they re-apply everything and never hit this trap.
