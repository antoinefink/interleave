CREATE TABLE `cards` (
	`element_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`prompt` text,
	`answer` text,
	`cloze` text,
	`source_location_id` text,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_location_id`) REFERENCES `source_locations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "cards_kind_check" CHECK("cards"."kind" IN ('qa', 'cloze'))
);
--> statement-breakpoint
CREATE INDEX `cards_source_location_idx` ON `cards` (`source_location_id`);--> statement-breakpoint
CREATE TABLE `review_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`element_id` text NOT NULL,
	`rating` text NOT NULL,
	`reviewed_at` text NOT NULL,
	`response_ms` integer NOT NULL,
	`prev_state` text NOT NULL,
	`next_state` text NOT NULL,
	`next_stability` real NOT NULL,
	`next_difficulty` real NOT NULL,
	`next_due_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_logs_rating_check" CHECK("review_logs"."rating" IN ('again', 'hard', 'good', 'easy')),
	CONSTRAINT "review_logs_prev_state_check" CHECK("review_logs"."prev_state" IN ('new', 'learning', 'review', 'relearning')),
	CONSTRAINT "review_logs_next_state_check" CHECK("review_logs"."next_state" IN ('new', 'learning', 'review', 'relearning'))
);
--> statement-breakpoint
CREATE INDEX `review_logs_element_idx` ON `review_logs` (`element_id`);--> statement-breakpoint
CREATE INDEX `review_logs_reviewed_idx` ON `review_logs` (`reviewed_at`);--> statement-breakpoint
CREATE TABLE `review_states` (
	`element_id` text PRIMARY KEY NOT NULL,
	`due_at` text,
	`stability` real DEFAULT 0 NOT NULL,
	`difficulty` real DEFAULT 0 NOT NULL,
	`elapsed_days` real DEFAULT 0 NOT NULL,
	`scheduled_days` real DEFAULT 0 NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`fsrs_state` text DEFAULT 'new' NOT NULL,
	`last_reviewed_at` text,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "review_states_fsrs_state_check" CHECK("review_states"."fsrs_state" IN ('new', 'learning', 'review', 'relearning'))
);
--> statement-breakpoint
CREATE INDEX `review_states_due_idx` ON `review_states` (`due_at`);--> statement-breakpoint
CREATE TABLE `document_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`block_type` text NOT NULL,
	`order` integer NOT NULL,
	`stable_block_id` text NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`element_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_blocks_stable_idx` ON `document_blocks` (`document_id`,`stable_block_id`);--> statement-breakpoint
CREATE INDEX `document_blocks_document_idx` ON `document_blocks` (`document_id`);--> statement-breakpoint
CREATE TABLE `document_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`block_id` text NOT NULL,
	`mark_type` text NOT NULL,
	`range` text NOT NULL,
	`attrs` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`element_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_marks_document_idx` ON `document_marks` (`document_id`);--> statement-breakpoint
CREATE INDEX `document_marks_block_idx` ON `document_marks` (`block_id`);--> statement-breakpoint
CREATE TABLE `documents` (
	`element_id` text PRIMARY KEY NOT NULL,
	`prosemirror_json` text NOT NULL,
	`plain_text` text DEFAULT '' NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `elements` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`stage` text NOT NULL,
	`priority` real NOT NULL,
	`due_at` text,
	`title` text NOT NULL,
	`parent_id` text,
	`source_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`parent_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "elements_type_check" CHECK("elements"."type" IN ('source', 'topic', 'extract', 'card', 'task', 'concept', 'media_fragment', 'synthesis_note')),
	CONSTRAINT "elements_status_check" CHECK("elements"."status" IN ('inbox', 'pending', 'active', 'scheduled', 'done', 'dismissed', 'suspended', 'deleted')),
	CONSTRAINT "elements_stage_check" CHECK("elements"."stage" IN ('raw_source', 'rough_topic', 'raw_extract', 'clean_extract', 'atomic_statement', 'card_draft', 'active_card', 'mature_card', 'synthesis')),
	CONSTRAINT "elements_priority_range_check" CHECK("elements"."priority" >= 0 AND "elements"."priority" <= 1)
);
--> statement-breakpoint
CREATE INDEX `elements_parent_idx` ON `elements` (`parent_id`);--> statement-breakpoint
CREATE INDEX `elements_source_idx` ON `elements` (`source_id`);--> statement-breakpoint
CREATE INDEX `elements_type_status_idx` ON `elements` (`type`,`status`);--> statement-breakpoint
CREATE INDEX `elements_due_idx` ON `elements` (`due_at`);--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_concept_id` text,
	`name` text NOT NULL,
	FOREIGN KEY (`parent_concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `concepts_parent_idx` ON `concepts` (`parent_concept_id`);--> statement-breakpoint
CREATE TABLE `element_tags` (
	`element_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`element_id`, `tag_id`),
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `element_tags_tag_idx` ON `element_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`element_id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`due_at` text,
	`status` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" IN ('inbox', 'pending', 'active', 'scheduled', 'done', 'dismissed', 'suspended', 'deleted'))
);
--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`due_at`);--> statement-breakpoint
CREATE TABLE `element_relations` (
	`id` text PRIMARY KEY NOT NULL,
	`from_element_id` text NOT NULL,
	`to_element_id` text NOT NULL,
	`relation_type` text NOT NULL,
	`sibling_group_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`from_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "element_relations_type_check" CHECK("element_relations"."relation_type" IN ('parent_child', 'derived_from', 'sibling_group', 'concept_membership', 'references'))
);
--> statement-breakpoint
CREATE INDEX `element_relations_from_idx` ON `element_relations` (`from_element_id`);--> statement-breakpoint
CREATE INDEX `element_relations_to_idx` ON `element_relations` (`to_element_id`);--> statement-breakpoint
CREATE INDEX `element_relations_sibling_idx` ON `element_relations` (`sibling_group_id`);--> statement-breakpoint
CREATE TABLE `read_points` (
	`id` text PRIMARY KEY NOT NULL,
	`element_id` text NOT NULL,
	`document_id` text NOT NULL,
	`block_id` text NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`element_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `read_points_element_idx` ON `read_points` (`element_id`);--> statement-breakpoint
CREATE TABLE `source_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`element_id` text NOT NULL,
	`source_element_id` text NOT NULL,
	`block_ids` text NOT NULL,
	`start_offset` integer,
	`end_offset` integer,
	`page` integer,
	`timestamp_ms` integer,
	`label` text,
	`selected_text` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `source_locations_element_idx` ON `source_locations` (`element_id`);--> statement-breakpoint
CREATE INDEX `source_locations_source_idx` ON `source_locations` (`source_element_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`element_id` text PRIMARY KEY NOT NULL,
	`url` text,
	`canonical_url` text,
	`original_url` text,
	`author` text,
	`published_at` text,
	`accessed_at` text,
	`snapshot_key` text,
	`reason_added` text,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owning_element_id` text NOT NULL,
	`kind` text NOT NULL,
	`vault_root` text NOT NULL,
	`relative_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`owning_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "assets_kind_check" CHECK("assets"."kind" IN ('source_html', 'source_pdf', 'snapshot', 'image', 'audio', 'video', 'export', 'backup')),
	CONSTRAINT "assets_vault_root_check" CHECK("assets"."vault_root" IN ('assets', 'exports', 'backups'))
);
--> statement-breakpoint
CREATE INDEX `assets_owning_element_idx` ON `assets` (`owning_element_id`);--> statement-breakpoint
CREATE INDEX `assets_content_hash_idx` ON `assets` (`content_hash`);--> statement-breakpoint
CREATE TABLE `operation_log` (
	`id` text PRIMARY KEY NOT NULL,
	`op_type` text NOT NULL,
	`payload` text NOT NULL,
	`element_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "operation_log_op_type_check" CHECK("operation_log"."op_type" IN ('create_element', 'update_element', 'soft_delete_element', 'restore_element', 'create_source', 'update_document', 'set_read_point', 'create_extract', 'create_card', 'add_review_log', 'reschedule_element', 'add_relation', 'remove_relation', 'add_tag', 'remove_tag'))
);
--> statement-breakpoint
CREATE INDEX `operation_log_element_idx` ON `operation_log` (`element_id`);--> statement-breakpoint
CREATE INDEX `operation_log_created_idx` ON `operation_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
