CREATE TABLE `retirement_suggestion_dismissals` (
	`source_element_id` text PRIMARY KEY NOT NULL,
	`signal_hash` text NOT NULL,
	`dismissed_at` text NOT NULL,
	FOREIGN KEY (`source_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `retirement_suggestion_dismissals_hash_idx` ON `retirement_suggestion_dismissals` (`signal_hash`);
