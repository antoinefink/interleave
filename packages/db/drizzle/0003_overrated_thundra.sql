PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_concepts` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_concept_id` text,
	`name` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_concepts`("id", "parent_concept_id", "name") SELECT "id", "parent_concept_id", "name" FROM `concepts`;--> statement-breakpoint
DROP TABLE `concepts`;--> statement-breakpoint
ALTER TABLE `__new_concepts` RENAME TO `concepts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `concepts_parent_idx` ON `concepts` (`parent_concept_id`);