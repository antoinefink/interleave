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
    /** ISO-8601 UTC timestamp for when the user deliberately parked the element. */
    parkedAt: text("parked_at"),
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
    // T100 (migration 0027): the analytics "new X in window" scans filter
    // `type = ? AND created_at BETWEEN ? AND ?` (AnalyticsService.countCreatedInWindow);
    // EXPLAIN QUERY PLAN at scale showed a full `SCAN elements` without this composite
    // and a clean `SEARCH ... USING INDEX elements_type_created_idx` with it. PROVEN.
    index("elements_type_created_idx").on(table.type, table.createdAt),
    // T100 (migration 0027): the analytics `deletions` count + the trash list both scan
    // `deleted_at` (`WHERE deleted_at IS NOT NULL [AND BETWEEN] ORDER BY deleted_at`).
    // EXPLAIN QUERY PLAN at scale showed a full `SCAN elements` + a TEMP B-TREE for the
    // trash sort without it, both eliminated with `SEARCH ... USING INDEX
    // elements_deleted_at_idx`. PROVEN. (The candidate `elements(type, due_at)` was
    // measured and REJECTED: for the `dueAttentionItems` read — `type NOT IN ('card')
    // AND deleted_at IS NULL AND ... AND due_at <= ? ORDER BY due_at` — the planner
    // keeps `elements_due_idx` (verified via EXPLAIN QUERY PLAN at scale, post-ANALYZE),
    // because a leading `type` column under `NOT IN ('card')` is non-sargable, so a
    // `(type, due_at)` composite cannot seek and would only ever be a redundant cost.)
    index("elements_deleted_at_idx").on(table.deletedAt),
  ],
);

export type ElementRow = typeof elements.$inferSelect;
export type NewElementRow = typeof elements.$inferInsert;
