-- T124 — detach-resolution provenance snapshot.
--
-- This migration is PURELY ADDITIVE: a single `CREATE TABLE element_detach_snapshot`
-- plus its two `CREATE INDEX` statements. `drizzle-kit generate` produced exactly this
-- — it did NOT propose an `elements` rebuild (CREATE __new_elements → copy → DROP
-- elements → RENAME), because the only change is a brand-new table. Adding a new table
-- cannot disturb the self-referential lineage FKs on `elements`.
--
-- It MUST STAY this way. A folded-in `elements` rebuild is the exact shape that fired
-- `ON DELETE SET NULL`/`cascade` on the lineage FKs and NULLED every parent/source link
-- in the real vault during migration 0030
-- (see docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md
-- and the 0037 header note). If a future `db:generate` ever proposes touching `elements`
-- here, hand-edit it back down to ONLY the additive DDL below. The end-state schema
-- matches the generated snapshot, so future runs stay clean.
--
-- Both FKs cascade only on HARD purge of the element/source; soft delete does not fire
-- the cascade, so the frozen snapshot survives the trash path (T135 purge-guard).
CREATE TABLE `element_detach_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`element_id` text NOT NULL,
	`source_element_id` text NOT NULL,
	`stable_block_id` text NOT NULL,
	`selected_text` text NOT NULL,
	`block_ids` text NOT NULL,
	`start_offset` integer,
	`end_offset` integer,
	`pre_stale_hash` text,
	`batch_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `element_detach_snapshot_element_idx` ON `element_detach_snapshot` (`element_id`);--> statement-breakpoint
CREATE INDEX `element_detach_snapshot_source_block_idx` ON `element_detach_snapshot` (`source_element_id`,`stable_block_id`);