/**
 * Typed lineage edges + read-points (T006): `element_relations`, `read_points`.
 *
 * `element_relations` models relationships as explicit rows, NOT implicit
 * nesting (mirrors {@link ElementRelation}). `relationType` is one of the
 * canonical `RelationType` values; `siblingGroupId` groups interfering siblings
 * (cloze/Q&A) so they are not shown back-to-back in review. This keeps lineage
 * queryable in both directions.
 *
 * `read_points` records how far the user has processed a source/topic (mirrors
 * {@link ReadPoint}): a stable block id + character offset, so reopening resumes
 * near where they left off. One read-point per element.
 */

import { RELATION_TYPES } from "@interleave/core";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { documents } from "./documents";
import { elements } from "./elements";

export const elementRelations = sqliteTable(
  "element_relations",
  {
    id: text("id").primaryKey(),
    fromElementId: text("from_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    toElementId: text("to_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** Edge kind — one of the canonical `RelationType` values. */
    relationType: text("relation_type").notNull(),
    /** Set when `relationType` is `sibling_group`; groups interfering siblings. */
    siblingGroupId: text("sibling_group_id"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check("element_relations_type_check", inList(table.relationType, RELATION_TYPES)),
    index("element_relations_from_idx").on(table.fromElementId),
    index("element_relations_to_idx").on(table.toElementId),
    index("element_relations_sibling_idx").on(table.siblingGroupId),
  ],
);

export const readPoints = sqliteTable(
  "read_points",
  {
    id: text("id").primaryKey(),
    /** The source/topic element this read-point belongs to. */
    elementId: text("element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** The document the block lives in. */
    documentId: text("document_id")
      .notNull()
      .references(() => documents.elementId, { onDelete: "cascade" }),
    /** The stable block id the user has read up to. */
    blockId: text("block_id").notNull(),
    /** Character offset within that block. */
    offset: integer("offset").notNull().default(0),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("read_points_element_idx").on(table.elementId)],
);

export type ElementRelationRow = typeof elementRelations.$inferSelect;
export type NewElementRelationRow = typeof elementRelations.$inferInsert;
export type ReadPointRow = typeof readPoints.$inferSelect;
export type NewReadPointRow = typeof readPoints.$inferInsert;
