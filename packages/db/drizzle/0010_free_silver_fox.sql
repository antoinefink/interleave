CREATE TABLE `ocr_pages` (
	`id` text PRIMARY KEY NOT NULL,
	`source_element_id` text NOT NULL,
	`page` integer NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`mean_confidence` integer DEFAULT 0 NOT NULL,
	`words` text,
	`status` text DEFAULT 'suggested' NOT NULL,
	`source_location_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_location_id`) REFERENCES `source_locations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "ocr_pages_status_check" CHECK("ocr_pages"."status" IN ('suggested', 'accepted', 'dismissed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ocr_pages_source_page_idx` ON `ocr_pages` (`source_element_id`,`page`);--> statement-breakpoint
CREATE INDEX `ocr_pages_source_idx` ON `ocr_pages` (`source_element_id`);