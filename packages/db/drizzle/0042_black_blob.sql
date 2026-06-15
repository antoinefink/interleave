CREATE TABLE `reread_proposal_dismissals` (
	`ancestor_id` text PRIMARY KEY NOT NULL,
	`state_hash` text NOT NULL,
	`total_window_lapses` integer NOT NULL,
	`affected_card_count` integer NOT NULL,
	`dismissed_at` text NOT NULL,
	FOREIGN KEY (`ancestor_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reread_proposal_dismissals_hash_idx` ON `reread_proposal_dismissals` (`state_hash`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`element_id` text PRIMARY KEY NOT NULL,
	`task_type` text NOT NULL,
	`due_at` text,
	`status` text NOT NULL,
	`linked_element_id` text,
	`note` text,
	FOREIGN KEY (`element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`linked_element_id`) REFERENCES `elements`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "tasks_status_check" CHECK("__new_tasks"."status" IN ('inbox', 'pending', 'active', 'scheduled', 'done', 'parked', 'dismissed', 'suspended', 'deleted')),
	CONSTRAINT "tasks_task_type_check" CHECK("__new_tasks"."task_type" IN ('verify_claim', 'find_better_source', 'update_outdated_card', 'check_current_version', 'custom', 'weekly_review', 'reread_region'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("element_id", "task_type", "due_at", "status", "linked_element_id", "note") SELECT "element_id", "task_type", "due_at", "status", "linked_element_id", "note" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`due_at`);--> statement-breakpoint
CREATE INDEX `tasks_linked_element_idx` ON `tasks` (`linked_element_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_open_link_type_uq` ON `tasks` (`linked_element_id`,`task_type`) WHERE status NOT IN ('done', 'parked', 'dismissed', 'deleted');--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_open_weekly_review_uq` ON `tasks` (`task_type`) WHERE task_type = 'weekly_review' AND status NOT IN ('done', 'parked', 'dismissed', 'deleted');