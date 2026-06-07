/**
 * OcrPagesRepository (T066) — typed, transactional access to the `ocr_pages` OCR
 * layer.
 *
 * The on-device OCR runner (a DB-free `utilityProcess` worker, `tesseract.js`
 * WASM) recognizes a scanned page's text off-main and posts it back; MAIN's apply
 * handler persists it HERE as a SEPARATE, REVIEWABLE suggestion layer — NOT merged
 * into the document body. {@link upsertPage} is the IDEMPOTENT write the
 * at-least-once job needs: a re-run (a crash-then-resume re-OCR) OVERWRITES the
 * page's record by its `(sourceElementId, page)` UNIQUE key, never duplicating it.
 *
 * OCR rows append NO `operation_log` op — the recognized text is a suggestion.
 * ACCEPTING it (an explicit user action) merges it into the page body via the
 * normal `documents.save` → `update_document` path (logged there), so accepted OCR
 * becomes ordinary searchable/extractable body text.
 */

import type { ElementId, OcrPageStatus } from "@interleave/core";
import { type InterleaveDatabase, ocrPages } from "@interleave/db";
import { and, asc, eq } from "drizzle-orm";
import { newRowId, nowIso } from "./ids";
import type { DbClient } from "./types";

/** One recognized word stored in `ocr_pages.words` (per-word confidence + bbox). */
export interface OcrPageWord {
  readonly text: string;
  readonly confidence: number;
  readonly bbox: {
    readonly x0: number;
    readonly y0: number;
    readonly x1: number;
    readonly y1: number;
  };
}

/** A persisted OCR page record (the domain shape the repository returns). */
export interface OcrPage {
  readonly id: string;
  readonly sourceElementId: string;
  readonly page: number;
  readonly text: string;
  /** Mean page confidence 0–100. */
  readonly meanConfidence: number;
  readonly words: readonly OcrPageWord[];
  readonly status: OcrPageStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Arguments to {@link OcrPagesRepository.upsertPage}. */
export interface UpsertOcrPageInput {
  readonly sourceElementId: ElementId;
  readonly page: number;
  readonly text: string;
  readonly meanConfidence: number;
  readonly words: readonly OcrPageWord[];
  /** Defaults to `"suggested"` — a fresh OCR result is always a suggestion. */
  readonly status?: OcrPageStatus;
}

function parseWords(raw: string | null): OcrPageWord[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as OcrPageWord[]) : [];
  } catch {
    return [];
  }
}

function rowToOcrPage(row: typeof ocrPages.$inferSelect): OcrPage {
  return {
    id: row.id,
    sourceElementId: row.sourceElementId,
    page: row.page,
    text: row.text,
    meanConfidence: row.meanConfidence,
    words: parseWords(row.words),
    status: row.status as OcrPageStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class OcrPagesRepository {
  constructor(private readonly db: InterleaveDatabase) {}

  /**
   * Insert-or-replace the OCR record for one `(sourceElementId, page)` — the
   * idempotent write the at-least-once OCR job needs. A re-OCR of the same page
   * OVERWRITES (preserving the existing `createdAt` + a re-OCR resets status to
   * `suggested` unless overridden), never appending a duplicate row.
   */
  upsertPage(input: UpsertOcrPageInput): OcrPage {
    const now = nowIso();
    const existing = this.findPage(input.sourceElementId, input.page);
    const status = input.status ?? "suggested";
    const wordsJson = JSON.stringify(input.words ?? []);
    if (existing) {
      this.db
        .update(ocrPages)
        .set({
          text: input.text,
          meanConfidence: clampPercent(input.meanConfidence),
          words: wordsJson,
          status,
          updatedAt: now,
        })
        .where(eq(ocrPages.id, existing.id))
        .run();
      return {
        ...existing,
        text: input.text,
        meanConfidence: clampPercent(input.meanConfidence),
        words: [...(input.words ?? [])],
        status,
        updatedAt: now,
      };
    }
    const id = newRowId();
    this.db
      .insert(ocrPages)
      .values({
        id,
        sourceElementId: input.sourceElementId,
        page: input.page,
        text: input.text,
        meanConfidence: clampPercent(input.meanConfidence),
        words: wordsJson,
        status,
        sourceLocationId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return {
      id,
      sourceElementId: input.sourceElementId,
      page: input.page,
      text: input.text,
      meanConfidence: clampPercent(input.meanConfidence),
      words: [...(input.words ?? [])],
      status,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** All OCR records for one source, ordered by page. */
  listForSource(sourceElementId: ElementId): OcrPage[] {
    const rows = this.db
      .select()
      .from(ocrPages)
      .where(eq(ocrPages.sourceElementId, sourceElementId))
      .orderBy(asc(ocrPages.page))
      .all();
    return rows.map(rowToOcrPage);
  }

  /** The OCR record for one `(source, page)`, or `null`. */
  findPage(sourceElementId: ElementId, page: number): OcrPage | null {
    const row = this.db
      .select()
      .from(ocrPages)
      .where(and(eq(ocrPages.sourceElementId, sourceElementId), eq(ocrPages.page, page)))
      .get();
    return row ? rowToOcrPage(row) : null;
  }

  /** Transition an OCR record's review status (`accepted` / `dismissed`). */
  setStatus(id: string, status: OcrPageStatus): OcrPage | null {
    return this.setStatusWithin(this.db, id, status);
  }

  /** Transactional form of {@link setStatus}. */
  setStatusWithin(tx: DbClient, id: string, status: OcrPageStatus): OcrPage | null {
    tx.update(ocrPages).set({ status, updatedAt: nowIso() }).where(eq(ocrPages.id, id)).run();
    const row = tx.select().from(ocrPages).where(eq(ocrPages.id, id)).get();
    return row ? rowToOcrPage(row) : null;
  }
}

/** Clamp a confidence to an integer percent 0–100. */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}
