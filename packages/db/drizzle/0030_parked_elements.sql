-- T101: "Save for later" becomes a first-class parked lifecycle state.
--
-- SQLite cannot ALTER an existing CHECK constraint, so this migration rebuilds
-- the two tables whose status checks derive from ELEMENT_STATUSES: `elements`
-- and `tasks`. Drizzle runs migrations inside a transaction, where
-- `PRAGMA foreign_keys=OFF` cannot protect child rows from `DROP TABLE elements`
-- cascades. To keep this migration data-preserving, every element-dependent
-- side-table is copied to a TEMP backup before the rebuild and restored after
-- the new `elements` table exists.
CREATE TEMP TABLE `__backup_sources` AS SELECT * FROM `sources`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_documents` AS SELECT * FROM `documents`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_document_blocks` AS SELECT * FROM `document_blocks`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_document_marks` AS SELECT * FROM `document_marks`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_source_block_processing` AS SELECT * FROM `source_block_processing`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_source_block_processing_outputs` AS SELECT * FROM `source_block_processing_outputs`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_source_locations` AS SELECT * FROM `source_locations`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_concepts` AS SELECT * FROM `concepts`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_element_tags` AS SELECT * FROM `element_tags`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_tasks` AS SELECT * FROM `tasks`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_cards` AS SELECT * FROM `cards`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_review_states` AS SELECT * FROM `review_states`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_review_logs` AS SELECT * FROM `review_logs`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_element_relations` AS SELECT * FROM `element_relations`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_read_points` AS SELECT * FROM `read_points`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_assets` AS SELECT * FROM `assets`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_occlusion_masks` AS SELECT * FROM `occlusion_masks`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_ai_suggestions` AS SELECT * FROM `ai_suggestions`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_embeddings` AS SELECT * FROM `embeddings`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_ocr_pages` AS SELECT * FROM `ocr_pages`;--> statement-breakpoint
CREATE TEMP TABLE `__backup_operation_log` AS SELECT * FROM `operation_log`;--> statement-breakpoint
DROP TRIGGER `documents_fts_ai`;--> statement-breakpoint
DROP TRIGGER `documents_fts_au`;--> statement-breakpoint
DROP TRIGGER `documents_fts_ad`;--> statement-breakpoint
DROP TRIGGER `source_locations_fts_ai`;--> statement-breakpoint
DROP TRIGGER `source_locations_fts_au`;--> statement-breakpoint
DROP TRIGGER `source_locations_fts_ad`;--> statement-breakpoint
DROP TRIGGER `cards_fts_ai`;--> statement-breakpoint
DROP TRIGGER `cards_fts_au`;--> statement-breakpoint
DROP TRIGGER `cards_fts_ad`;--> statement-breakpoint
DROP TRIGGER `elements_fts_au`;--> statement-breakpoint
DROP TRIGGER `elements_fts_ad`;--> statement-breakpoint
CREATE TABLE `__new_elements` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`stage` text NOT NULL,
	`priority` real NOT NULL,
	`due_at` text,
	`parked_at` text,
	`title` text NOT NULL,
	`parent_id` text,
	`source_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`parent_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "elements_type_check" CHECK("__new_elements"."type" IN ('source', 'topic', 'extract', 'card', 'task', 'concept', 'media_fragment', 'synthesis_note')),
	CONSTRAINT "elements_status_check" CHECK("__new_elements"."status" IN ('inbox', 'pending', 'active', 'scheduled', 'done', 'parked', 'dismissed', 'suspended', 'deleted')),
	CONSTRAINT "elements_stage_check" CHECK("__new_elements"."stage" IN ('raw_source', 'rough_topic', 'raw_extract', 'clean_extract', 'atomic_statement', 'card_draft', 'active_card', 'mature_card', 'synthesis')),
	CONSTRAINT "elements_priority_range_check" CHECK("__new_elements"."priority" >= 0 AND "__new_elements"."priority" <= 1)
);--> statement-breakpoint
INSERT INTO `__new_elements`(
	"id",
	"type",
	"status",
	"stage",
	"priority",
	"due_at",
	"parked_at",
	"title",
	"parent_id",
	"source_id",
	"created_at",
	"updated_at",
	"deleted_at"
)
SELECT
	"id",
	"type",
	"status",
	"stage",
	"priority",
	"due_at",
	NULL,
	"title",
	"parent_id",
	"source_id",
	"created_at",
	"updated_at",
	"deleted_at"
FROM `elements`;--> statement-breakpoint
DROP TABLE `elements`;--> statement-breakpoint
ALTER TABLE `__new_elements` RENAME TO `elements`;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`element_id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`due_at` text,
	`status` text NOT NULL,
	`linked_element_id` text,
	`note` text,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_status_check" CHECK("__new_tasks"."status" IN ('inbox', 'pending', 'active', 'scheduled', 'done', 'parked', 'dismissed', 'suspended', 'deleted')),
	CONSTRAINT "tasks_task_type_check" CHECK("__new_tasks"."task_type" IN ('verify_claim', 'find_better_source', 'update_outdated_card', 'check_current_version', 'custom'))
);--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
INSERT INTO `sources` SELECT * FROM `__backup_sources`;--> statement-breakpoint
INSERT INTO `documents` SELECT * FROM `__backup_documents`;--> statement-breakpoint
INSERT INTO `source_locations` SELECT * FROM `__backup_source_locations`;--> statement-breakpoint
INSERT INTO `concepts` SELECT * FROM `__backup_concepts`;--> statement-breakpoint
INSERT INTO `tasks` SELECT * FROM `__backup_tasks`;--> statement-breakpoint
INSERT INTO `cards` SELECT * FROM `__backup_cards`;--> statement-breakpoint
INSERT INTO `review_states` SELECT * FROM `__backup_review_states`;--> statement-breakpoint
INSERT INTO `review_logs` SELECT * FROM `__backup_review_logs`;--> statement-breakpoint
INSERT INTO `document_blocks` SELECT * FROM `__backup_document_blocks`;--> statement-breakpoint
INSERT INTO `document_marks` SELECT * FROM `__backup_document_marks`;--> statement-breakpoint
INSERT INTO `source_block_processing` SELECT * FROM `__backup_source_block_processing`;--> statement-breakpoint
INSERT INTO `source_block_processing_outputs` SELECT * FROM `__backup_source_block_processing_outputs`;--> statement-breakpoint
INSERT INTO `element_tags` SELECT * FROM `__backup_element_tags`;--> statement-breakpoint
INSERT INTO `element_relations` SELECT * FROM `__backup_element_relations`;--> statement-breakpoint
INSERT INTO `read_points` SELECT * FROM `__backup_read_points`;--> statement-breakpoint
INSERT INTO `assets` SELECT * FROM `__backup_assets`;--> statement-breakpoint
INSERT INTO `occlusion_masks` SELECT * FROM `__backup_occlusion_masks`;--> statement-breakpoint
INSERT INTO `ai_suggestions` SELECT * FROM `__backup_ai_suggestions`;--> statement-breakpoint
INSERT INTO `embeddings` SELECT * FROM `__backup_embeddings`;--> statement-breakpoint
INSERT INTO `ocr_pages` SELECT * FROM `__backup_ocr_pages`;--> statement-breakpoint
DELETE FROM `operation_log`;--> statement-breakpoint
INSERT INTO `operation_log` SELECT * FROM `__backup_operation_log`;--> statement-breakpoint
CREATE INDEX `elements_parent_idx` ON `elements` (`parent_id`);--> statement-breakpoint
CREATE INDEX `elements_source_idx` ON `elements` (`source_id`);--> statement-breakpoint
CREATE INDEX `elements_type_status_idx` ON `elements` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `elements_due_idx` ON `elements` (`due_at`);--> statement-breakpoint
CREATE INDEX `elements_type_created_idx` ON `elements` (`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `elements_deleted_at_idx` ON `elements` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_linked_element_idx` ON `tasks` (`linked_element_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_open_link_type_uq` ON `tasks` (`linked_element_id`,`task_type`) WHERE status NOT IN ('done', 'parked', 'dismissed', 'deleted');--> statement-breakpoint
CREATE TRIGGER `documents_fts_ai` AFTER INSERT ON `documents` BEGIN
	DELETE FROM `source_fts` WHERE element_id = new.element_id;
	INSERT INTO `source_fts`(element_id, title, body, tags)
		SELECT e.id, e.title, new.plain_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = e.id)
		FROM elements e WHERE e.id = new.element_id AND e.type = 'source' AND e.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `documents_fts_au` AFTER UPDATE ON `documents` BEGIN
	DELETE FROM `source_fts` WHERE element_id = new.element_id;
	INSERT INTO `source_fts`(element_id, title, body, tags)
		SELECT e.id, e.title, new.plain_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = e.id)
		FROM elements e WHERE e.id = new.element_id AND e.type = 'source' AND e.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `documents_fts_ad` AFTER DELETE ON `documents` BEGIN
	DELETE FROM `source_fts` WHERE element_id = old.element_id;
END;--> statement-breakpoint
CREATE TRIGGER `source_locations_fts_ai` AFTER INSERT ON `source_locations` BEGIN
	DELETE FROM `extract_fts` WHERE element_id = new.element_id;
	INSERT INTO `extract_fts`(element_id, title, body, tags)
		SELECT e.id, e.title, new.selected_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = e.id)
		FROM elements e WHERE e.id = new.element_id AND e.type = 'extract' AND e.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `source_locations_fts_au` AFTER UPDATE ON `source_locations` BEGIN
	DELETE FROM `extract_fts` WHERE element_id = new.element_id;
	INSERT INTO `extract_fts`(element_id, title, body, tags)
		SELECT e.id, e.title, new.selected_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = e.id)
		FROM elements e WHERE e.id = new.element_id AND e.type = 'extract' AND e.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `source_locations_fts_ad` AFTER DELETE ON `source_locations` BEGIN
	DELETE FROM `extract_fts` WHERE element_id = old.element_id;
END;--> statement-breakpoint
CREATE TRIGGER `cards_fts_ai` AFTER INSERT ON `cards` BEGIN
	DELETE FROM `card_fts` WHERE element_id = new.element_id;
	INSERT INTO `card_fts`(element_id, prompt, answer, tags)
		SELECT new.element_id,
			COALESCE(new.prompt, new.cloze, ''),
			COALESCE(new.answer, ''),
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.element_id)
		FROM elements e WHERE e.id = new.element_id AND e.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `cards_fts_au` AFTER UPDATE ON `cards` BEGIN
	DELETE FROM `card_fts` WHERE element_id = new.element_id;
	INSERT INTO `card_fts`(element_id, prompt, answer, tags)
		SELECT new.element_id,
			COALESCE(new.prompt, new.cloze, ''),
			COALESCE(new.answer, ''),
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.element_id)
		FROM elements e WHERE e.id = new.element_id AND e.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `cards_fts_ad` AFTER DELETE ON `cards` BEGIN
	DELETE FROM `card_fts` WHERE element_id = old.element_id;
END;--> statement-breakpoint
CREATE TRIGGER `elements_fts_au` AFTER UPDATE ON `elements` BEGIN
	DELETE FROM `source_fts` WHERE element_id = new.id;
	DELETE FROM `extract_fts` WHERE element_id = new.id;
	DELETE FROM `card_fts` WHERE element_id = new.id;
	INSERT INTO `source_fts`(element_id, title, body, tags)
		SELECT new.id, new.title, d.plain_text,
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.id)
		FROM documents d
		WHERE d.element_id = new.id AND new.type = 'source' AND new.deleted_at IS NULL;
	INSERT INTO `extract_fts`(element_id, title, body, tags)
		SELECT new.id, new.title,
			(SELECT COALESCE(group_concat(sl.selected_text, ' '), '')
				FROM source_locations sl WHERE sl.element_id = new.id),
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.id)
		FROM elements e
		WHERE e.id = new.id AND new.type = 'extract' AND new.deleted_at IS NULL;
	INSERT INTO `card_fts`(element_id, prompt, answer, tags)
		SELECT new.id,
			COALESCE(c.prompt, c.cloze, ''),
			COALESCE(c.answer, ''),
			(SELECT COALESCE(group_concat(t.name, ' '), '')
				FROM element_tags et JOIN tags t ON t.id = et.tag_id
				WHERE et.element_id = new.id)
		FROM cards c
		WHERE c.element_id = new.id AND new.type = 'card' AND new.deleted_at IS NULL;
END;--> statement-breakpoint
CREATE TRIGGER `elements_fts_ad` AFTER DELETE ON `elements` BEGIN
	DELETE FROM `source_fts` WHERE element_id = old.id;
	DELETE FROM `extract_fts` WHERE element_id = old.id;
	DELETE FROM `card_fts` WHERE element_id = old.id;
END;
