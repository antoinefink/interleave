/**
 * Source provenance + source locations (T006): `sources`, `source_locations`.
 *
 * `sources` is the provenance side-table for a `source`-type element (keyed 1:1
 * by element id), mirroring {@link Source} in `@interleave/core`. Most columns
 * are nullable because manual imports may omit them (auto-fetch lands later).
 * `snapshotKey` points at a saved snapshot asset in the vault — the bytes are
 * never in SQLite.
 *
 * `source_locations` is the anchor that makes lineage *actionable* ("jump to the
 * exact paragraph"), mirroring {@link ElementLocation}. `elementId` is the
 * element this location belongs to (e.g. the extract); `sourceElementId` is the
 * source/parent it points INTO. `blockIds` is stored as a JSON array of stable
 * block ids; `selectedText` snapshots the selection so the origin survives a
 * re-import of the source document.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { elements } from "./elements";

export const sources = sqliteTable(
  "sources",
  {
    /** Mirrors the owning `source` element's id (one-to-one). */
    elementId: text("element_id")
      .primaryKey()
      .references(() => elements.id, { onDelete: "cascade" }),
    url: text("url"),
    /** Normalized URL used for duplicate detection (tracking params stripped). */
    canonicalUrl: text("canonical_url"),
    /** Original/pre-redirect URL, preserved for provenance. */
    originalUrl: text("original_url"),
    author: text("author"),
    publishedAt: text("published_at"),
    /** When the user imported/snapshotted the source. */
    accessedAt: text("accessed_at"),
    /** Vault key/relative path of the saved snapshot asset, if any. */
    snapshotKey: text("snapshot_key"),
    /** Why the user added this source (free text), aiding later triage. */
    reasonAdded: text("reason_added"),
    /**
     * The MEDIA discriminator (T073): `"video"`/`"audio"` for a local media file
     * (its bytes are in the vault), `"youtube"` for a referenced YouTube embed (no
     * local bytes), and `null` for every non-media source. This — not a snapshot-key
     * derivation — is the authoritative signal `documents.get` reads to return
     * `sourceFormat: "video"` + `mediaSource`/`mediaKind`, so the reader can reliably
     * pick `<video>` vs the YouTube IFrame even for a transcript-less YouTube source
     * that has neither a vault asset nor a distinctive snapshot key. Pure widening,
     * no backfill (existing rows get `null`).
     */
    mediaKind: text("media_kind"),
  },
  (table) => [
    // T061: the canonical-URL duplicate-detection lookup. Non-unique by design —
    // distinct sources MAY legitimately share a canonical URL (an explicit
    // "import new version anyway"), so uniqueness would block that escape hatch.
    index("sources_canonical_url_idx").on(table.canonicalUrl),
  ],
);

export const sourceLocations = sqliteTable(
  "source_locations",
  {
    id: text("id").primaryKey(),
    /** The element this location belongs to (e.g. the extract). */
    elementId: text("element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** The `source`/parent element this location points INTO. */
    sourceElementId: text("source_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** Stable block ids spanned by the selection, stored as a JSON array. */
    blockIds: text("block_ids").notNull(),
    /** Character offset within the first block, when available. */
    startOffset: integer("start_offset"),
    /** Character offset within the last block, when available. */
    endOffset: integer("end_offset"),
    /** 1-based page number for paginated sources (PDF/EPUB), else `null`. */
    page: integer("page"),
    /** Media timestamp in milliseconds for audio/video sources, else `null`. */
    timestampMs: integer("timestamp_ms"),
    /**
     * Normalized bounding box JSON `{ x0, y0, x1, y1 }` (fractions 0–1) for a PDF
     * region extract (T065), else `null`. Anchors a figure/table crop to its page
     * region; pure widening, no backfill (existing rows get `null`).
     */
    region: text("region"),
    /** Human-readable label, e.g. "Chapter 2 · ¶4". */
    label: text("label"),
    /** Verbatim snapshot of the selected text at extraction time. */
    selectedText: text("selected_text").notNull(),
  },
  (table) => [
    index("source_locations_element_idx").on(table.elementId),
    index("source_locations_source_idx").on(table.sourceElementId),
  ],
);

export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type SourceLocationRow = typeof sourceLocations.$inferSelect;
export type NewSourceLocationRow = typeof sourceLocations.$inferInsert;
