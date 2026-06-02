/**
 * OCR layer (T066): `ocr_pages`.
 *
 * The on-device OCR runner (a DB-free `utilityProcess` worker running
 * `tesseract.js` WASM) recognizes text for a scanned/image PDF page and posts the
 * result back to MAIN, which persists it HERE as a SEPARATE, REVIEWABLE layer —
 * NOT blindly merged into the document body. Each row is one page's recognized
 * text + its confidence metadata; a re-run UPSERTS by `(sourceElementId, page)`
 * (the `ocr_pages_source_page_idx` UNIQUE index) so the at-least-once job stays
 * idempotent — a crash-then-resume overwrites the page, never duplicates it.
 *
 * The text is `suggested` until the user explicitly ACCEPTS it (which merges it
 * into the page's body via the normal `documents.save` → `update_document` path,
 * making it searchable/extractable). Low confidence is flagged in the UI and never
 * auto-accepted. The recognized text is ALSO written to the vault as
 * `assets/sources/<source_id>/ocr/page-N.json` (the durable export copy); this
 * table is the queryable source of truth for the text + confidence.
 *
 * A nullable `sourceLocationId` is reserved so a future REGION-scoped OCR (T065's
 * `media_fragment` crop) can attach its recognized text to a `source_locations`
 * row instead of a page, without a reshape.
 *
 * The bytes of the page IMAGE the worker OCR'd never live here (they go to the
 * filesystem vault); this is only the structured, queryable OCR text + confidence.
 */

import { OCR_PAGE_STATUSES } from "@interleave/core";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { inList } from "./_shared";
import { elements } from "./elements";
import { sourceLocations } from "./sources";

export const ocrPages = sqliteTable(
  "ocr_pages",
  {
    /** Stable id (domain-generated). */
    id: text("id").primaryKey(),
    /** The PDF `source` element this OCR layer belongs to. */
    sourceElementId: text("source_element_id")
      .notNull()
      .references(() => elements.id, { onDelete: "cascade" }),
    /** The 1-based page number the recognized text covers. */
    page: integer("page").notNull(),
    /** The recognized (OCR) page text. */
    text: text("text").notNull().default(""),
    /** Mean page confidence 0–100 (tesseract's per-word confidences, averaged). */
    meanConfidence: integer("mean_confidence").notNull().default(0),
    /** Per-word `{ text, confidence, bbox }[]` JSON (for word-level placement). */
    words: text("words"),
    /** Lifecycle: `suggested` (un-reviewed) | `accepted` (merged) | `dismissed`. */
    status: text("status").notNull().default("suggested"),
    /**
     * Reserved (T066 notes/risks): a region-scoped OCR (a `media_fragment` crop,
     * T065) keys its recognized text to a `source_locations` row instead of a page.
     * `null` for the page-OCR path. Lets the region case slot in without a reshape.
     */
    sourceLocationId: text("source_location_id").references(() => sourceLocations.id, {
      onDelete: "cascade",
    }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    // The idempotent UPSERT key: one OCR record per (source, page). A re-OCR
    // overwrites the same page's record (the at-least-once job needs this).
    uniqueIndex("ocr_pages_source_page_idx").on(table.sourceElementId, table.page),
    index("ocr_pages_source_idx").on(table.sourceElementId),
    check("ocr_pages_status_check", inList(table.status, OCR_PAGE_STATUSES)),
  ],
);

export type OcrPageRow = typeof ocrPages.$inferSelect;
export type NewOcrPageRow = typeof ocrPages.$inferInsert;
