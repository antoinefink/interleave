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
ALTER TABLE `operation_log` ADD `batch_id` text;--> statement-breakpoint
CREATE INDEX `operation_log_batch_idx` ON `operation_log` (`batch_id`);--> statement-breakpoint
-- Backfill historical rows from the canonical payload. SQLite JSON1 `json_extract`
-- (idiomatic here — see migration 0034's lineage backfill): a row that carried a
-- STRING `batchId` in its payload gets that value; single-op rows (no `batchId`)
-- stay NULL. The `json_type(...) = 'text'` guard mirrors the append path exactly,
-- which only denormalizes a string `batchId` (a non-string is treated as none), so
-- backfilled history and newly-appended rows agree. New ops set `batch_id` at append
-- time, so this only touches pre-0041 rows; the payload still carries `batchId` as
-- the canonical command record.
UPDATE `operation_log`
  SET `batch_id` = json_extract(`payload`, '$.batchId')
  WHERE `batch_id` IS NULL AND json_type(`payload`, '$.batchId') = 'text';
