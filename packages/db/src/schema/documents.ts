/**
 * Document body tables (T006): `documents`, `document_blocks`, `document_marks`.
 *
 * A `documents` row is the editable rich-text body of an element (keyed 1:1 by
 * its element id), mirroring {@link Document} in `@interleave/core`. The
 * ProseMirror JSON is stored as text; `plainText` is the flattened mirror used
 * for search/preview. `document_blocks` carries the **stable block IDs** that
 * extracts, read-points, and the eventual sync all anchor to — they must survive
 * re-imports and saves. `document_marks` records highlight / extracted-span /
 * processed-span / cloze annotations over those blocks.
 *
 * The bytes of large assets never live here (those go to the filesystem vault);
 * this is only the structured, queryable document substrate for lineage.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { elements } from "./elements";

export const documents = sqliteTable("documents", {
  /** Mirrors the owning element's id (one-to-one). */
  elementId: text("element_id")
    .primaryKey()
    .references(() => elements.id, { onDelete: "cascade" }),
  /** ProseMirror document JSON, stored as text (validated/narrowed above). */
  prosemirrorJson: text("prosemirror_json").notNull(),
  /** Flattened text mirror for full-text search and previews. */
  plainText: text("plain_text").notNull().default(""),
  /** ProseMirror schema version the body was authored against. */
  schemaVersion: integer("schema_version").notNull().default(1),
  updatedAt: text("updated_at").notNull(),
});

export const documentBlocks = sqliteTable(
  "document_blocks",
  {
    /** Stable id row PK (domain-generated). */
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.elementId, { onDelete: "cascade" }),
    /** ProseMirror node type, e.g. `paragraph`, `heading`. */
    blockType: text("block_type").notNull(),
    /** Position of the block within the document (0-based). */
    order: integer("order").notNull(),
    /**
     * The STABLE block id extracts/read-points/sync reference. Preserved across
     * imports and saves — the load-bearing anchor for lineage. Unique per doc.
     */
    stableBlockId: text("stable_block_id").notNull(),
    /**
     * The 1-based PAGE number this block belongs to, for PAGINATED sources (PDFs,
     * T064). `null` for non-paginated HTML/text bodies. The canonical block→page
     * map the page-granular read-point + the page-level source-location path read
     * (a pure widening — no backfill; existing rows stay `null`).
     */
    page: integer("page"),
    /**
     * The media START TIMESTAMP (milliseconds) this block belongs to, for MEDIA
     * sources (video/audio transcripts, T073). One transcript cue → one paragraph
     * block tagged with its cue start; `null` for the title heading, the
     * transcript-less placeholder, and every non-media body. The canonical
     * block→time map the timestamp read-point + the T074 clip path read (a pure
     * widening — no backfill; existing rows stay `null`).
     */
    timestampMs: integer("timestamp_ms"),
  },
  (table) => [
    uniqueIndex("document_blocks_stable_idx").on(table.documentId, table.stableBlockId),
    index("document_blocks_document_idx").on(table.documentId),
  ],
);

export const documentMarks = sqliteTable(
  "document_marks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => documents.elementId, { onDelete: "cascade" }),
    /** The stable block id this mark applies to. */
    blockId: text("block_id").notNull(),
    /** Mark kind, e.g. `highlight`, `extracted_span`, `processed_span`, `cloze`. */
    markType: text("mark_type").notNull(),
    /** Character range within the block, stored as JSON `[start, end]`. */
    range: text("range").notNull(),
    /** Mark-specific attributes, stored as JSON; `null` when none. */
    attrs: text("attrs"),
  },
  (table) => [
    index("document_marks_document_idx").on(table.documentId),
    index("document_marks_block_idx").on(table.blockId),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
export type DocumentBlockRow = typeof documentBlocks.$inferSelect;
export type NewDocumentBlockRow = typeof documentBlocks.$inferInsert;
export type DocumentMarkRow = typeof documentMarks.$inferSelect;
export type NewDocumentMarkRow = typeof documentMarks.$inferInsert;
