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

import { SOURCE_BLOCK_OUTPUT_TYPES, SOURCE_BLOCK_PROCESSING_STATES } from "@interleave/core";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { elements } from "./elements";
import { sourceLocations } from "./sources";

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

export const sourceBlockProcessing = sqliteTable(
  "source_block_processing",
  {
    id: text("id").primaryKey(),
    sourceElementId: text("source_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    stableBlockId: text("stable_block_id").notNull(),
    state: text("state").notNull(),
    /**
     * Hash of normalized block text when the caller can provide it. Nullable so
     * legacy `processed_span` backfill can be non-destructive even though marks do
     * not carry block text.
     */
    blockContentHash: text("block_content_hash"),
    /**
     * The last-PROCESSED content hash, captured ONCE when a block transitions
     * `processed → stale_after_edit` (T123). It lets reconciliation recognize when an
     * edited block's content is restored to its pre-stale value (current hash ==
     * `pre_stale_hash`) so the block — and the derived `needs_reverify` flags it caused —
     * can be cleared. `null` outside the stale episode; cleared whenever the row leaves
     * `stale_after_edit`. Distinct from `block_content_hash` (which tracks the CURRENT
     * hash and is read by the idempotence/hydrate paths), to keep those semantics intact.
     */
    preStaleHash: text("pre_stale_hash"),
    metadata: text("metadata"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastAction: text("last_action"),
    lastActionAt: text("last_action_at"),
  },
  (table) => [
    check(
      "source_block_processing_state_check",
      inList(table.state, SOURCE_BLOCK_PROCESSING_STATES),
    ),
    uniqueIndex("source_block_processing_source_block_idx").on(
      table.sourceElementId,
      table.stableBlockId,
    ),
    index("source_block_processing_source_idx").on(table.sourceElementId),
    index("source_block_processing_state_idx").on(table.state),
  ],
);

export const sourceBlockProcessingOutputs = sqliteTable(
  "source_block_processing_outputs",
  {
    id: text("id").primaryKey(),
    sourceElementId: text("source_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    stableBlockId: text("stable_block_id").notNull(),
    outputElementId: text("output_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    outputType: text("output_type").notNull(),
    sourceLocationId: text("source_location_id").references(() => sourceLocations.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    check(
      "source_block_processing_outputs_type_check",
      inList(table.outputType, SOURCE_BLOCK_OUTPUT_TYPES),
    ),
    uniqueIndex("source_block_processing_outputs_unique_idx").on(
      table.sourceElementId,
      table.stableBlockId,
      table.outputElementId,
    ),
    index("source_block_processing_outputs_source_block_idx").on(
      table.sourceElementId,
      table.stableBlockId,
    ),
    index("source_block_processing_outputs_output_idx").on(table.outputElementId),
  ],
);

/**
 * T123 — content-staleness provenance. Each row records that source block
 * `(sourceElementId, stableBlockId)` caused derived element `elementId` to need
 * re-verification. `elements.needs_reverify` is a self-healing projection of this
 * table: an element is flagged iff it has ≥1 row here. The unique triple makes
 * re-propagation idempotent (`ON CONFLICT DO NOTHING`); the clear-by-block index
 * supports removing all rows for a restored block (across live AND trashed targets).
 *
 * Both FKs cascade on HARD purge of the element/source. Soft delete (the common
 * trash path) does NOT remove the element row, so it does NOT cascade — content
 * staleness is kept honest for soft-deleted elements at the read layer (live-scoped
 * counts/signals) and by clear-by-block, not by cascade. `batchId` groups one
 * reconciliation run's provenance for audit/T124.
 */
export const elementReverifyProvenance = sqliteTable(
  "element_reverify_provenance",
  {
    id: text("id").primaryKey(),
    /** The DERIVED element flagged as content-stale (extract/statement/card). */
    elementId: text("element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** The source whose block edit caused the flag. */
    sourceElementId: text("source_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** The specific source block (its content drifted). */
    stableBlockId: text("stable_block_id").notNull(),
    /** The reconciliation run that wrote this row (audit + T124 grouping). */
    batchId: text("batch_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("element_reverify_provenance_unique_idx").on(
      table.elementId,
      table.sourceElementId,
      table.stableBlockId,
    ),
    index("element_reverify_provenance_element_idx").on(table.elementId),
    index("element_reverify_provenance_source_block_idx").on(
      table.sourceElementId,
      table.stableBlockId,
    ),
  ],
);

/**
 * T124 — detach-resolution snapshot. When a re-verify flag is resolved with the
 * **detach** verb, the derived element becomes genuinely standalone WITHOUT severing
 * lineage: the live `source_locations` anchor is left fully intact, and instead this
 * row IS the tombstone — the propagation walk (`ReverifyPropagationRepository`) skips
 * any `(element, source, block)` tuple that has a snapshot here (a `NOT EXISTS` guard),
 * so a future source edit can no longer re-flag the detached output. Detach also clears
 * the provenance that flagged it. The row freezes the provenance snapshot — the
 * standalone element's frozen evidence root — recording the source block it was detached
 * from, the frozen anchor text (`selectedText`) and `blockIds`/offsets, and the
 * `pre_stale_hash` current at detach, grouped by the resolution `batchId`.
 *
 * `blockIds` is stored as a JSON array of stable block ids, mirroring
 * `source_locations.blockIds`. Both FKs cascade only on HARD purge of the
 * element/source (mirroring `element_reverify_provenance`): soft delete (the common
 * trash path) does NOT remove the element row, so it does NOT fire the cascade — the
 * frozen snapshot survives a soft delete. (The cascade needs no separate purge-guard:
 * the T135 guard exists to stop a hard purge from `SET NULL`-orphaning live lineage
 * edges; these `ON DELETE cascade` FKs just drop the snapshot cleanly when its element
 * is hard-purged.) Detach is recoverable: undo drops the matching snapshot row and
 * re-inserts provenance (the anchor was never touched, so there is nothing to restore).
 */
export const elementDetachSnapshot = sqliteTable(
  "element_detach_snapshot",
  {
    id: text("id").primaryKey(),
    /** The DERIVED element that was detached into a standalone output. */
    elementId: text("element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** The source the element was detached FROM (its frozen evidence root). */
    sourceElementId: text("source_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** The specific source block the element was anchored to at detach. */
    stableBlockId: text("stable_block_id").notNull(),
    /** The frozen anchor text snapshotted at detach (the evidence as it then read). */
    selectedText: text("selected_text").notNull(),
    /** Frozen anchor block ids, JSON array (mirrors `source_locations.block_ids`). */
    blockIds: text("block_ids").notNull(),
    /** Frozen anchor start offset within the first block; `null` when block-level. */
    startOffset: integer("start_offset"),
    /** Frozen anchor end offset within the last block; `null` when block-level. */
    endOffset: integer("end_offset"),
    /** The block's `pre_stale_hash` at detach time, if any (else `null`). */
    preStaleHash: text("pre_stale_hash"),
    /** The resolution run that wrote this snapshot (audit + undo grouping). */
    batchId: text("batch_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("element_detach_snapshot_element_idx").on(table.elementId),
    index("element_detach_snapshot_source_block_idx").on(
      table.sourceElementId,
      table.stableBlockId,
    ),
  ],
);

export type DocumentRow = typeof documents.$inferSelect;
export type NewDocumentRow = typeof documents.$inferInsert;
export type DocumentBlockRow = typeof documentBlocks.$inferSelect;
export type NewDocumentBlockRow = typeof documentBlocks.$inferInsert;
export type DocumentMarkRow = typeof documentMarks.$inferSelect;
export type NewDocumentMarkRow = typeof documentMarks.$inferInsert;
export type SourceBlockProcessingRow = typeof sourceBlockProcessing.$inferSelect;
export type NewSourceBlockProcessingRow = typeof sourceBlockProcessing.$inferInsert;
export type SourceBlockProcessingOutputRow = typeof sourceBlockProcessingOutputs.$inferSelect;
export type NewSourceBlockProcessingOutputRow = typeof sourceBlockProcessingOutputs.$inferInsert;
export type ElementReverifyProvenanceRow = typeof elementReverifyProvenance.$inferSelect;
export type NewElementReverifyProvenanceRow = typeof elementReverifyProvenance.$inferInsert;
export type ElementDetachSnapshotRow = typeof elementDetachSnapshot.$inferSelect;
export type NewElementDetachSnapshotRow = typeof elementDetachSnapshot.$inferInsert;
