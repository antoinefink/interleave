CREATE TABLE `embeddings` (
	`element_id` text PRIMARY KEY NOT NULL,
	`vec_rowid` integer NOT NULL,
	`element_type` text NOT NULL,
	`model_id` text NOT NULL,
	`dim` integer NOT NULL,
	`content_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "embeddings_type_check" CHECK("embeddings"."element_type" IN ('source', 'extract', 'card'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embeddings_vec_rowid_idx` ON `embeddings` (`vec_rowid`);--> statement-breakpoint
CREATE INDEX `embeddings_type_idx` ON `embeddings` (`element_type`);--> statement-breakpoint
CREATE INDEX `embeddings_model_idx` ON `embeddings` (`model_id`);