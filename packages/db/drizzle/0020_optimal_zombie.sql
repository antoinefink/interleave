ALTER TABLE `cards` ADD `is_retired` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `cards_is_retired_idx` ON `cards` (`is_retired`);