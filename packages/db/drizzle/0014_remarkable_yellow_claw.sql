CREATE TABLE `occlusion_masks` (
	`id` text PRIMARY KEY NOT NULL,
	`image_element_id` text NOT NULL,
	`card_element_id` text,
	`region` text NOT NULL,
	`label` text,
	`order` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`image_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `occlusion_masks_image_idx` ON `occlusion_masks` (`image_element_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `occlusion_masks_card_idx` ON `occlusion_masks` (`card_element_id`);--> statement-breakpoint
-- Widening the `cards.kind` CHECK to allow `image_occlusion` (T071) requires a
-- table rebuild (SQLite cannot ALTER a CHECK). The FTS sync triggers that
-- reference `cards` (cards_fts_*, elements_fts_au) must be DROPPED before the
-- DROP/RENAME and RECREATED verbatim after — otherwise the rename fails with
-- "no such table: main.cards" from inside a trigger body referencing the
-- mid-rewrite table. Recreated exactly as they stood (migrations 0002 + 0005).
DROP TRIGGER `cards_fts_ai`;--> statement-breakpoint
DROP TRIGGER `cards_fts_au`;--> statement-breakpoint
DROP TRIGGER `cards_fts_ad`;--> statement-breakpoint
DROP TRIGGER `elements_fts_au`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cards` (
	`element_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`prompt` text,
	`answer` text,
	`cloze` text,
	`source_location_id` text,
	`source_uri` text,
	`is_leech` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_location_id`) REFERENCES `source_locations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "cards_kind_check" CHECK("__new_cards"."kind" IN ('qa', 'cloze', 'image_occlusion'))
);
--> statement-breakpoint
INSERT INTO `__new_cards`("element_id", "kind", "prompt", "answer", "cloze", "source_location_id", "source_uri", "is_leech") SELECT "element_id", "kind", "prompt", "answer", "cloze", "source_location_id", "source_uri", "is_leech" FROM `cards`;--> statement-breakpoint
DROP TABLE `cards`;--> statement-breakpoint
ALTER TABLE `__new_cards` RENAME TO `cards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `cards_source_location_idx` ON `cards` (`source_location_id`);--> statement-breakpoint
CREATE INDEX `cards_is_leech_idx` ON `cards` (`is_leech`);--> statement-breakpoint
-- Recreate the dropped FTS sync triggers verbatim (migrations 0002 + 0005).
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
END;
