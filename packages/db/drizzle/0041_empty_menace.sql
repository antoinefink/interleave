-- Promote `operation_log.batch_id` out of the JSON `payload` into a real indexed
-- column so batch undo (`UndoService.collectBatch`) is an O(batch) indexed lookup
-- instead of an O(total ops) full-table scan + JS filter (the PERF-01/R-002 issue
-- deferred from the T126 bulk-inbox-triage review).
--
-- PURELY ADDITIVE. `batch_id` is plain nullable TEXT with NO CHECK/NOT NULL
-- constraint, so `drizzle-kit generate` emitted a clean `ALTER TABLE … ADD COLUMN`
-- + `CREATE INDEX` rather than the table-REBUILD shape (CREATE __new → copy → DROP
-- → RENAME). That rebuild shape is the exact one that fired `ON DELETE` actions and
-- NULLED every lineage link during migration 0030
-- (see docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md
-- and the 0037/0039/0040 header notes). If a future `db:generate` ever proposes an
-- `operation_log` rebuild here, hand-edit it back down to ONLY the additive
-- `ALTER TABLE … ADD COLUMN` + `CREATE INDEX` + the backfill below.
--
-- The index is PARTIAL (`WHERE "batch_id" IS NOT NULL`): almost every op-log row is a
-- single-op action with a NULL batch_id, and batch undo only ever looks up a concrete
-- batch id, so indexing only the non-NULL rows keeps the index tiny and removes
-- index-maintenance cost from the hot single-op append path. SQLite still uses it for
-- `batch_id = ?` (an equality literal implies IS NOT NULL). Drizzle's SQLite generator
-- can drop the `.where()` predicate; if a future regen drops `WHERE "batch_id" IS NOT
-- NULL` from the CREATE INDEX above, hand-add it back (the snapshot keeps the partial
-- predicate, so a dropped WHERE would also show as drift).
ALTER TABLE `operation_log` ADD `batch_id` text;--> statement-breakpoint
CREATE INDEX `operation_log_batch_idx` ON `operation_log` (`batch_id`) WHERE "batch_id" IS NOT NULL;--> statement-breakpoint
-- Backfill historical rows from the canonical payload. SQLite JSON1 `json_extract`
-- (idiomatic here — see migration 0034's lineage backfill): a row that carried a
-- STRING `batchId` in its payload gets that value; single-op rows (no `batchId`)
-- stay NULL. The `json_type(...) = 'text'` guard mirrors the append path exactly,
-- which only denormalizes a string `batchId` (a non-string is treated as none), so
-- backfilled history and newly-appended rows agree. The `json_valid(payload)` guard
-- is load-bearing: SQLite's `json_type`/`json_extract` RAISE "malformed JSON" (not
-- NULL) on a non-JSON payload, which inside this migration transaction would roll back
-- the whole 0041 and brick startup on the next launch; skipping malformed rows (they
-- backfill to NULL → "no batch") keeps the migration total even on a dirty vault. New
-- ops set `batch_id` at append time, so this only touches pre-0041 rows; the payload
-- still carries `batchId` as the canonical command record.
UPDATE `operation_log`
  SET `batch_id` = json_extract(`payload`, '$.batchId')
  WHERE `batch_id` IS NULL
    AND json_valid(`payload`)
    AND json_type(`payload`, '$.batchId') = 'text';
