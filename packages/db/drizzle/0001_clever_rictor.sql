ALTER TABLE `cards` ADD `is_leech` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `cards_is_leech_idx` ON `cards` (`is_leech`);