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
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { elements } from "./elements";

export const concepts = sqliteTable(
  "concepts",
  {
    id: text("id").primaryKey(),
    /** Parent concept for the hierarchy; `null` for a root concept. */
    parentConceptId: text("parent_concept_id").references((): AnySQLiteColumn => concepts.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
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
