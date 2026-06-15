---
title: "Promoting a JSON-payload key to an indexed column (json_valid-guarded backfill + partial index)"
date: 2026-06-15
category: database-issues
module: packages/db (migrations), packages/local-db (operation_log)
problem_type: database_issue
component: database
symptoms:
  - "SQLite json_type / json_extract RAISE a malformed JSON error on a non-JSON payload row — they do NOT return NULL"
  - "An unguarded json_extract backfill aborts the entire Drizzle migration transaction, which rolls back at app startup and bricks the next launch"
  - "A full B-tree index on a sparse nullable column (mostly NULL) adds index-write cost to every INSERT on the hot append path for no read benefit"
root_cause: wrong_api
resolution_type: migration
severity: high
tags:
  - sqlite
  - json-extract
  - drizzle-migration
  - backfill
  - partial-index
  - operation-log
related_components:
  - background_job
---

# Promoting a JSON-payload key to an indexed column (json_valid-guarded backfill + partial index)

## Problem

A frequently-queried key buried in a JSON `payload` text column (here `operation_log.payload.batchId`, read on every batch undo) is an unindexed `O(total rows)` scan. Promoting it to a real indexed column needs an additive migration that (a) backfills historical rows from the payload and (b) indexes the new column — and both steps have a non-obvious trap that only bites a long-lived or dirty database.

## Symptoms

- An additive migration whose backfill calls `json_extract(payload, '$.key')` / `json_type(payload, '$.key')` **aborts with "malformed JSON"** the moment it meets one non-JSON `payload` row. Because Drizzle wraps each migration file in a single transaction, the `ALTER TABLE`, `CREATE INDEX`, and `UPDATE` all roll back together — and since migrations run at Electron startup, the app fails to open and retries the same failing migration on every launch.
- The bug is invisible on a fresh DB and in CI (every seeded payload is well-formed), so it ships green and only fires on a real user vault that accumulated a malformed row.
- A plain (non-partial) index on the new nullable column is mostly NULL entries (the key is set on a small minority of rows), so every `INSERT` on the hot write path pays to maintain a NULL index entry that no equality lookup will ever read.

## What Didn't Work

- **Unguarded backfill** — `UPDATE ... SET key = json_extract(payload,'$.key') WHERE key IS NULL AND json_type(payload,'$.key') = 'text'`. Verified against the app's better-sqlite3 (SQLite 3.53.1): a single row with a non-JSON `payload` makes the `UPDATE` throw `malformed JSON`, rolling back the whole migration. (A reviewer initially asserted `json_type` returns NULL on malformed input — it does not; it RAISES. Confirm API failure-modes empirically, do not assume.)
- **Relying on "payloads are always well-formed"** — true for code-written rows (everything goes through `JSON.stringify`), but it is not a safe assumption for a migration that runs once, irreversibly, against years of accumulated data on a vault that has had data-integrity incidents before. Honest-robust beats confidently-fragile when the failure mode is "brick startup."
- **A full index on the sparse column** — correct, but it taxes the hot append path (every meaningful mutation writes an `operation_log` row) and bloats the index with NULL entries.

## Solution

Three pieces, all additive (an `ALTER TABLE ... ADD COLUMN`, never the 0030-style table rebuild — see Related):

**1. Guard the backfill with `json_valid(payload)`.** Skip malformed rows (they backfill to NULL → "no key") instead of aborting:

```sql
-- packages/db/drizzle/0041_empty_menace.sql
UPDATE `operation_log`
  SET `batch_id` = json_extract(`payload`, '$.batchId')
  WHERE `batch_id` IS NULL
    AND json_valid(`payload`)                         -- <- load-bearing
    AND json_type(`payload`, '$.batchId') = 'text';
```

**2. Make the index PARTIAL** so only the rows that carry the key are indexed:

```sql
CREATE INDEX `operation_log_batch_idx`
  ON `operation_log` (`batch_id`) WHERE "batch_id" IS NOT NULL;
```

```ts
// packages/db/src/schema/system.ts — Drizzle declaration
index("operation_log_batch_idx").on(table.batchId).where(sql`"batch_id" IS NOT NULL`)
```

SQLite still uses a partial index for `WHERE batch_id = ?` because an equality literal implies `IS NOT NULL` (verified via `EXPLAIN QUERY PLAN`: `SEARCH ... USING INDEX operation_log_batch_idx`).

**3. Dual-write with the SAME guard as the backfill**, so live rows and historical rows agree. The write path only denormalizes a *string* key; the backfill's `json_type(...) = 'text'` mirrors that exactly:

```ts
// packages/local-db/src/operation-log-repository.ts
function batchIdFromPayload(payload: unknown): string | null {
  const obj = payloadObject(payload);
  return obj && typeof obj.batchId === "string" ? obj.batchId : null;
}
// ...in append(), inside the caller's transaction:
const batchId = batchIdFromPayload(input.payload);
tx.insert(operationLog).values({ ...row, batchId }).run();
```

The payload keeps the key as the canonical command record; the column is a denormalized index. The reader (`UndoService.collectBatch`) becomes a single `WHERE batch_id = ?` indexed lookup.

## Why This Works

- **`json_valid` guard:** SQLite's JSON1 functions validate their input and raise on malformed text. In a *read query* that runs per-row a bad row fails gracefully (one row errors, the rest are fine — see `attention-scheduler-last-seen-clock-semantics`, which reads `json_extract(payload,'$.action')` unguarded). In a *migration backfill* the same call runs inside one transaction, so one bad row aborts everything. The guard converts "abort the migration" into "leave that row's column NULL," which is the correct, total outcome.
- **Partial index:** the index b-tree contains only the minority of rows where the key is non-null, so it is tiny and adds zero index-maintenance cost to the common single-op `INSERT`. The equality lookup the reader needs is fully served by it.
- **Dual-write + backfill symmetry:** the backfill only covers pre-migration rows; without the dual-write, every row created *after* the migration would have a NULL column and the index would be useless for exactly the rows that matter. Using one shared string-only guard on both paths guarantees live and historical rows never disagree.

## Prevention

- **Always `json_valid(payload)`-guard a migration backfill that calls `json_extract`/`json_type` over a whole table.** A read query can skip it; a transactional backfill cannot.
- **Verify SQLite (and any DB) API failure modes empirically** rather than from memory — `json_type` RAISES, it does not return NULL. A 10-line probe against the app's actual `better-sqlite3` build settled a reviewer disagreement in two minutes.
- **Use a partial index (`WHERE col IS NOT NULL`) for a sparse nullable column.** NOTE: Drizzle's SQLite generator can silently drop the `.where()` from the generated `CREATE INDEX`; the snapshot keeps the predicate, so a dropped WHERE also shows as `db:generate` drift. Hand-verify the generated SQL and pin the partial predicate in a migration test:

```ts
const indexSql = db.prepare(
  "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
).get("operation_log_batch_idx") as { sql: string };
expect(indexSql.sql).toMatch(/WHERE\s+"?batch_id"?\s+IS\s+NOT\s+NULL/i);
```

- **Test the migration against the dirty case**, not just the happy path: seed a malformed-JSON payload row before migrating and assert the migration does not throw and leaves that row's column NULL while valid rows backfill.
- **Lock the read path's cost with `EXPLAIN QUERY PLAN`** (assert `USING INDEX <name>`, never `SCAN`) — a deterministic guard that survives CI jitter, unlike a wall-clock timing assertion. Tie it to the actual ORM-generated SQL (`query.toSQL()`) so the test cannot drift from production.
- **When you add the indexed column, sweep sibling lookups** of the same key. Promoting `batch_id` also let `TrashQuery.restoreBatch` drop its `json_extract(payload,'$.batchId')` scan for the indexed `WHERE batch_id = ?`.

## Related Issues

- `docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md` — why this migration is a purely additive `ALTER TABLE ADD COLUMN` (the 0030 table-rebuild wiped lineage); its 0034 repair is the prior payload-backfill precedent (which did not need `json_valid` because its rows were all well-formed `create_element` ops).
- `docs/solutions/database-issues/drizzle-migrator-high-water-mark-skips-out-of-order-migrations.md` — the journal-`when` monotonicity prerequisite every new migration must satisfy (guarded by `journal-ordering.test.ts`).
- `docs/solutions/architecture-patterns/bulk-command-heterogeneous-batch-undo-guard.md` — the T126 batch-undo consumer of `batch_id`; `collectBatch` must keep its newest-first ordering for reverse-replay undo.
- `docs/solutions/architecture-patterns/attention-scheduler-last-seen-clock-semantics.md` — uses unguarded `json_extract(payload,...)` in a *read* query, the contrasting context where the `json_valid` guard is not required.
