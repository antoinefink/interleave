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

import { ELEMENT_STATUSES } from "@interleave/core";
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
    /** Kind of maintenance action, e.g. `verify_claim`, `update_card`. */
    taskType: text("task_type").notNull(),
    dueAt: text("due_at"),
    /** Task status — reuses the canonical `ElementStatus` vocabulary. */
    status: text("status").notNull(),
  },
  (table) => [
    check("tasks_status_check", inList(table.status, ELEMENT_STATUSES)),
    index("tasks_due_idx").on(table.dueAt),
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
