CREATE TABLE `source_block_processing` (
	`id` text PRIMARY KEY NOT NULL,
	`source_element_id` text NOT NULL,
	`stable_block_id` text NOT NULL,
	`state` text NOT NULL,
	`block_content_hash` text,
	`metadata` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_action` text,
	`last_action_at` text,
	FOREIGN KEY (`source_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `source_block_processing_state_check` CHECK(`source_block_processing`.`state` IN ('unread', 'read', 'extracted', 'ignored', 'processed_without_output', 'needs_later', 'stale_after_edit'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_block_processing_source_block_idx` ON `source_block_processing` (`source_element_id`,`stable_block_id`);
--> statement-breakpoint
CREATE INDEX `source_block_processing_source_idx` ON `source_block_processing` (`source_element_id`);
--> statement-breakpoint
CREATE INDEX `source_block_processing_state_idx` ON `source_block_processing` (`state`);
--> statement-breakpoint
CREATE TABLE `source_block_processing_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_element_id` text NOT NULL,
	`stable_block_id` text NOT NULL,
	`output_element_id` text NOT NULL,
	`output_type` text NOT NULL,
	`source_location_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`output_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_location_id`) REFERENCES `source_locations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `source_block_processing_outputs_type_check` CHECK(`source_block_processing_outputs`.`output_type` IN ('extract', 'card'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_block_processing_outputs_unique_idx` ON `source_block_processing_outputs` (`source_element_id`,`stable_block_id`,`output_element_id`);
--> statement-breakpoint
CREATE INDEX `source_block_processing_outputs_source_block_idx` ON `source_block_processing_outputs` (`source_element_id`,`stable_block_id`);
--> statement-breakpoint
CREATE INDEX `source_block_processing_outputs_output_idx` ON `source_block_processing_outputs` (`output_element_id`);
--> statement-breakpoint
INSERT INTO `source_block_processing` (
	`id`,
	`source_element_id`,
	`stable_block_id`,
	`state`,
	`block_content_hash`,
	`metadata`,
	`created_at`,
	`updated_at`,
	`last_action`,
	`last_action_at`
)
SELECT
	lower(hex(randomblob(16))),
	m.`document_id`,
	m.`block_id`,
	'processed_without_output',
	NULL,
	json_object('legacyMarkIds', json_group_array(m.`id`)),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	'legacy_processed_span_backfill',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `document_marks` m
INNER JOIN `document_blocks` b
	ON b.`document_id` = m.`document_id`
	AND b.`stable_block_id` = m.`block_id`
LEFT JOIN `source_block_processing` existing
	ON existing.`source_element_id` = m.`document_id`
	AND existing.`stable_block_id` = m.`block_id`
WHERE m.`mark_type` = 'processed_span'
	AND existing.`id` IS NULL
GROUP BY m.`document_id`, m.`block_id`;
