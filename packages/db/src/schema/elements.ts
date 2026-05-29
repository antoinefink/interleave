/**
 * The `elements` table — the universal primitive (T006).
 *
 * Every source, topic, extract, card, task, concept, media fragment, and
 * synthesis note IS a row here. This mirrors {@link Element} from
 * `@interleave/core`: `type`/`status`/`stage` are the canonical enum strings,
 * `priority` is the normalized numeric store, and `deletedAt` is the soft-delete
 * marker (user data is never destroyed). Lineage is carried by `parentId`
 * (origin element) and `sourceId` (denormalized lineage root) — both
 * self-referencing foreign keys so a card can trace back to its source.
 *
 * IDs are stable UUID/ULID-style strings generated in the domain/service layer,
 * NEVER by SQLite autoincrement (lineage + operation-log replay depend on this).
 * Enum membership is enforced with CHECK constraints derived from the
 * `@interleave/core` tuples so the DB and the domain vocabulary cannot drift.
 */

import { DISTILLATION_STAGES, ELEMENT_STATUSES, ELEMENT_TYPES } from "@interleave/core";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";

export const elements = sqliteTable(
  "elements",
  {
    /** Stable UUID/ULID-style id, generated in the domain/service layer. */
    id: text("id").primaryKey(),
    /** Element type — one of the eight canonical `ElementType` values. */
    type: text("type").notNull(),
    /** Lifecycle status — one of the canonical `ElementStatus` values. */
    status: text("status").notNull(),
    /** Distillation stage — one of the canonical `DistillationStage` values. */
    stage: text("stage").notNull(),
    /** Normalized numeric priority `0.0`–`1.0` (higher = more important). */
    priority: real("priority").notNull(),
    /** ISO-8601 UTC timestamp for when this element next wants attention. */
    dueAt: text("due_at"),
    title: text("title").notNull(),
    /** Origin element this was derived from; `null` for top-level sources. */
    parentId: text("parent_id").references((): AnySQLiteColumn => elements.id, {
      onDelete: "set null",
    }),
    /** Denormalized lineage root (the owning `source` element). */
    sourceId: text("source_id").references((): AnySQLiteColumn => elements.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** Soft-delete marker; non-null means "in the trash", recoverable. */
    deletedAt: text("deleted_at"),
  },
  (table) => [
    check("elements_type_check", inList(table.type, ELEMENT_TYPES)),
    check("elements_status_check", inList(table.status, ELEMENT_STATUSES)),
    check("elements_stage_check", inList(table.stage, DISTILLATION_STAGES)),
    check("elements_priority_range_check", sql`${table.priority} >= 0 AND ${table.priority} <= 1`),
    index("elements_parent_idx").on(table.parentId),
    index("elements_source_idx").on(table.sourceId),
    index("elements_type_status_idx").on(table.type, table.status),
    index("elements_due_idx").on(table.dueAt),
  ],
);

export type ElementRow = typeof elements.$inferSelect;
export type NewElementRow = typeof elements.$inferInsert;
