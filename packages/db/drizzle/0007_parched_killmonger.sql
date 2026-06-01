CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer NOT NULL,
	`progress_ratio` integer DEFAULT 0 NOT NULL,
	`progress_note` text,
	`not_before` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT "jobs_type_check" CHECK("jobs"."type" IN ('url_import', 'ocr', 'embed', 'ai', 'cleanup', 'vault_verify', 'vault_gc')),
	CONSTRAINT "jobs_status_check" CHECK("jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_created_idx` ON `jobs` (`created_at`);