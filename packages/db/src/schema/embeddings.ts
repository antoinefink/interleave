/**
 * Embedding bookkeeping (T087): `embeddings`.
 *
 * A SIDECAR table that maps each embedded element to its `sqlite-vec` `vec0`
 * rowid (in the separate `element_vectors` virtual table) + the model that
 * produced the vector + a content hash. It is a DERIVED index (like FTS5): the
 * base tables (`elements`/`documents`/`cards`) are the source of truth, and an
 * `embeddings` write appends NO `operation_log` entry — embeddings are
 * rebuildable from scratch by a re-index, never a domain mutation. The closed
 * `OPERATION_TYPES` set does not grow for it.
 *
 * Why a sidecar + a separate `vec0` table rather than embedding columns on a
 * domain table: a `vec0` virtual table is addressed by `rowid` and cannot hold
 * FK/cascade/hash metadata. This sidecar carries:
 *  - the join back to the live element (`element_id` PK, FK → `elements.id`
 *    `onDelete: "cascade"`, so a hard-purge removes the bookkeeping row),
 *  - the `vec_rowid` join into `element_vectors` (UNIQUE),
 *  - the idempotency `content_hash` (sha256 of the exact embedded text), so an
 *    unchanged element is skipped and a changed one re-embedded,
 *  - the `model_id` + `dim`, so KNN refuses to mix vectors of different models and
 *    a model switch triggers a re-index.
 *
 * Cleanup is the DEFAULT explicit app-level delete (`EmbeddingRepository.delete`
 * removes the `element_vectors` rowid + this row in one transaction) — fully
 * portable, never dependent on a `vec0`-trigger. A `vault_gc`-adjacent sweep prunes
 * any `element_vectors` rowid with no surviving `embeddings` row as the backstop.
 */

import { EMBEDDABLE_TYPES } from "@interleave/core";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { elements } from "./elements";

export const embeddings = sqliteTable(
  "embeddings",
  {
    /** The embedded element (PK; cascades on a hard-purge of the element). */
    elementId: text("element_id")
      .primaryKey()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** The `element_vectors` (`vec0`) rowid holding this element's vector. */
    vecRowid: integer("vec_rowid").notNull(),
    /** The embedded element's type — one of the embeddable (`source`/`extract`/`card`) types. */
    elementType: text("element_type").notNull(),
    /** The model that produced the vector, e.g. `"onnx-community/embeddinggemma-300m-ONNX"`. */
    modelId: text("model_id").notNull(),
    /** The vector dimension (matches the `element_vectors` column dim). */
    dim: integer("dim").notNull(),
    /** sha256 of the exact text embedded — the skip-if-unchanged / re-embed gate. */
    contentHash: text("content_hash").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("embeddings_type_check", inList(table.elementType, EMBEDDABLE_TYPES)),
    uniqueIndex("embeddings_vec_rowid_idx").on(table.vecRowid),
    index("embeddings_type_idx").on(table.elementType),
    index("embeddings_model_idx").on(table.modelId),
  ],
);

export type EmbeddingRow = typeof embeddings.$inferSelect;
export type NewEmbeddingRow = typeof embeddings.$inferInsert;
