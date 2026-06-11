/**
 * Organization tables (T006): `concepts`, `tags`, `element_tags`, `tasks`.
 *
 * `concepts` are hierarchical knowledge nodes (`parentConceptId` self-reference);
 * `tags` are flat labels; `element_tags` is the many-to-many join between an
 * element and its tags. `tasks` is the side-table for `task`-type elements —
 * maintenance/verification actions ("verify this claim") with their own
 * scheduling. `taskStatus` reuses the canonical `ElementStatus` vocabulary.
 *
 * Concepts/tags themselves are lightweight rows here; concept *membership* of an
 * element is modeled as a typed edge in `element_relations` (`concept_membership`).
 */

import { ELEMENT_STATUSES, TASK_TYPES } from "@interleave/core";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { elements } from "./elements";

export const concepts = sqliteTable(
  "concepts",
  {
    /**
     * Mirrors the owning `concept` element's id (one-to-one), like every other
     * element-keyed side-table. Cascades on element delete so a hard purge of the
     * concept element removes this hierarchy row too — no orphan survives.
     */
    id: text("id")
      .primaryKey()
      .references((): AnySQLiteColumn => elements.id, { onDelete: "cascade" }),
    /** Parent concept for the hierarchy; `null` for a root concept. */
    parentConceptId: text("parent_concept_id").references((): AnySQLiteColumn => concepts.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    /**
     * Per-concept FSRS desired-retention target (T079), a probability in
     * `[DESIRED_RETENTION_MIN, DESIRED_RETENTION_MAX]`, or `null` = inherit the
     * band/global default. Read by the per-card scheduler factory: a card in this
     * concept schedules against this target instead of its priority-band/global
     * one. `null`-default so existing concepts are unchanged on upgrade
     * (backfill-free). The resolver collapses duplicate concept NAMES to the
     * HIGHEST target, so a fragile concept is never under-protected.
     */
    desiredRetention: real("desired_retention"),
    /**
     * Per-concept FSRS parameter set (T080) — a JSON-encoded `number[]` (the 21-weight
     * FSRS-6 `w` vector), or `null` = inherit the global preset / ts-fsrs `default_w`.
     * Stored here (the queryable store the scheduler reads) so an optimized per-concept
     * preset reaches `schedulerForCard`. Added in this T079 `0018` migration so T080 adds
     * no second `concepts` migration; written only by T080's optimization apply.
     */
    fsrsParams: text("fsrs_params"),
  },
  (table) => [index("concepts_parent_idx").on(table.parentConceptId)],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
  },
  (table) => [uniqueIndex("tags_name_unique").on(table.name)],
);

export const elementTags = sqliteTable(
  "element_tags",
  {
    elementId: text("element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.elementId, table.tagId] }),
    index("element_tags_tag_idx").on(table.tagId),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    /** Mirrors the owning `task` element's id (one-to-one). */
    elementId: text("element_id")
      .primaryKey()
      .references(() => elements.id, { onDelete: "cascade" }),
    /**
     * Kind of maintenance action (T092) — one of the `@interleave/core`
     * {@link TASK_TYPES} (`verify_claim` / `find_better_source` /
     * `update_outdated_card` / `check_current_version` / `custom`). The CHECK is
     * built from the SAME core tuple as the domain union (the DB + domain can't drift).
     */
    taskType: text("task_type").notNull(),
    dueAt: text("due_at"),
    /** Task status — reuses the canonical `ElementStatus` vocabulary. */
    status: text("status").notNull(),
    /**
     * The element this verification task PROTECTS (T092) — the card/extract/source it
     * watches over, or `null` for a hand-created custom task with no link. DUAL-MODELED
     * (like `cards.source_location_id`): the canonical lineage is the `references`
     * `element_relations` edge written in the same create transaction; this denormalized
     * column is a convenience for cheap inspector/queue joins. `on delete set null` so a
     * soft/hard-deleted protected element does not orphan the task.
     */
    linkedElementId: text("linked_element_id").references((): AnySQLiteColumn => elements.id, {
      onDelete: "set null",
    }),
    /** Free-text task detail ("v18 released, check the hook API"), ≤2048, or `null`. */
    note: text("note"),
  },
  (table) => [
    check("tasks_status_check", inList(table.status, ELEMENT_STATUSES)),
    // The verification-task kind is the closed core vocabulary (T092).
    check("tasks_task_type_check", inList(table.taskType, TASK_TYPES)),
    index("tasks_due_idx").on(table.dueAt),
    // Cheap reverse lookup: "open tasks protecting element X" (the inspector Maintenance
    // read + the generation idempotency check).
    index("tasks_linked_element_idx").on(table.linkedElementId),
    // PARTIAL unique index (T092): at most ONE OPEN task of a given kind may protect a
    // given element, so `generateVerificationTasks` is idempotent at the DB level (a
    // duplicate generation insert FAILS rather than relying on the read-check
    // serializing). The `WHERE status NOT IN (...)` predicate excludes terminal rows so a
    // SECOND task of the same kind is allowed once the first is done/dismissed/deleted; a
    // NULL `linked_element_id` (a custom, unlinked task) is never deduped (NULLs are
    // distinct in a UNIQUE index). NOTE: Drizzle's SQLite generator can drop the `.where()`
    // predicate — the generated migration is hand-verified to emit `WHERE status NOT IN
    // (...)` (see migration 0025 + the migration-level test).
    uniqueIndex("tasks_open_link_type_uq")
      .on(table.linkedElementId, table.taskType)
      .where(sql`status NOT IN ('done', 'parked', 'dismissed', 'deleted')`),
  ],
);

export type ConceptRow = typeof concepts.$inferSelect;
export type NewConceptRow = typeof concepts.$inferInsert;
export type TagRow = typeof tags.$inferSelect;
export type NewTagRow = typeof tags.$inferInsert;
export type ElementTagRow = typeof elementTags.$inferSelect;
export type NewElementTagRow = typeof elementTags.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
