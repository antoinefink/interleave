/**
 * PdfImportService (T064) — the local-first PDF-import orchestrator (main side).
 *
 * Mirrors {@link UrlImportService}: the ONE place the pure `@interleave/importers`
 * PDF transforms, the filesystem asset vault (T059 `AssetVaultService`), and the
 * `local-db` source pipeline are composed for PDF import. It runs ENTIRELY in the
 * Electron main process — it reads the chosen `.pdf` from disk, validates it
 * (magic bytes + size cap + page-count cap), STREAMS the original bytes into the
 * vault (`assets/sources/<id>/original.pdf`, content-hashed; bytes NEVER touch
 * SQLite), parses the per-page text with `pdfjs-dist` (legacy Node build), builds
 * a constrained ProseMirror page doc (one "Page N" heading + a paragraph per
 * line, stable block ids + per-block page numbers), and creates an `inbox` source
 * through `createWithDocument` in ONE transaction (`create_element` +
 * `create_source` + `update_document`). The renderer never reads the file, never
 * parses the PDF, and never touches the vault.
 *
 * ## Ordering (source row first, then streamed asset)
 *
 * The `assets` row's FK requires the owning source element to exist, and
 * `importAsset` opens its OWN metadata transaction. So we (1) create the source
 * row + body in one transaction with `snapshotKey` already pointing at
 * `sources/<id>/original.pdf`, then (2) `importAsset` the streamed bytes keyed by
 * the now-existing `sourceId`. We deliberately do NOT hold a 200 MB write inside
 * the source-row transaction (unlike the URL path's two tiny HTML snapshots, the
 * PDF is large and streamed). On ANY failure after the vault dir was created we
 * best-effort `rmSync` the partial `sources/<id>/` dir (mirroring `UrlImportService`),
 * so no orphan files or half-committed rows linger.
 */

import { rmSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type ElementId,
  type PlainTextConversion,
  type PriorityLabel,
  priorityFromLabel,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import { extractPdfPages, extractPdfTitle, pdfPagesToProseMirrorDoc } from "@interleave/importers";
import {
  type ElementRepository,
  type InboxItemSummary,
  InboxQuery,
  newElementId,
  type Repositories,
  type SourceRepository,
} from "@interleave/local-db";
import type { AssetVaultService } from "./asset-vault-service";

/** The friendly error codes the IPC layer maps to a user-facing message. */
export type PdfImportErrorCode =
  | "not_pdf"
  | "too_large"
  | "too_many_pages"
  | "encrypted"
  | "unreadable";

/** A typed PDF-import failure carrying a `code` the IPC layer maps to a friendly line. */
export class PdfImportError extends Error {
  readonly code: PdfImportErrorCode;
  constructor(code: PdfImportErrorCode, message: string) {
    super(message);
    this.name = "PdfImportError";
    this.code = code;
  }
}

/** Hard caps so a hostile PDF cannot exhaust memory. */
const MAX_PDF_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_PDF_PAGES = 2000;
/** The "no embedded text" note attached when every page is text-free (scanned). */
const NO_TEXT_NOTE = "No embedded text — run OCR";

/** Constructor dependencies (injected once; mirroring `UrlImportService`). */
export interface PdfImportServiceDeps {
  /** The open Drizzle database (for the atomic source transaction). */
  readonly db: InterleaveDatabase;
  /** The repository bag bound to the same DB. */
  readonly repositories: Repositories;
  /** The asset-vault root (`<dataDir>/assets`). */
  readonly assetsDir: string;
  /** The T059 streamed asset importer (the original PDF goes through it). */
  readonly assetVault: AssetVaultService;
}

/** Arguments to {@link PdfImportService.importFromFile}. */
export interface ImportPdfFromFileInput {
  /** ABSOLUTE path to the chosen `.pdf` (resolved by the MAIN file picker). */
  readonly filePath: string;
  /** Explicit title override; else the PDF's `/Title`, else the filename stem. */
  readonly title?: string | null;
  /** Coarse A/B/C/D priority; defaults `C` so new material never dominates. */
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
}

/** The successful import result. */
export interface PdfImportResult {
  readonly id: string;
  readonly item: InboxItemSummary;
}

export class PdfImportService {
  private readonly sources: SourceRepository;
  private readonly elements: ElementRepository;
  private readonly inbox: InboxQuery;
  private readonly assetsDir: string;
  private readonly assetVault: AssetVaultService;

  constructor(deps: PdfImportServiceDeps) {
    // `deps.db` is accepted for symmetry with `UrlImportService` (and a future
    // tx-composable path); `createWithDocument` opens its own transaction, so it is
    // not stored here.
    this.sources = deps.repositories.sources;
    this.elements = deps.repositories.elements;
    this.inbox = new InboxQuery(deps.repositories);
    this.assetsDir = deps.assetsDir;
    this.assetVault = deps.assetVault;
  }

  /**
   * Import a local `.pdf` as an inbox `source`. See the file header for the
   * ordering + rollback contract. Throws a typed {@link PdfImportError} on a
   * non-PDF / oversize / too-many-pages / encrypted / unreadable file (nothing is
   * persisted; any partial vault dir is removed).
   */
  async importFromFile(input: ImportPdfFromFileInput): Promise<PdfImportResult> {
    const filePath = input.filePath;

    // 1a. Size cap (a cheap stat before reading the whole file).
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      throw new PdfImportError("unreadable", "The PDF file could not be read.");
    }
    if (size > MAX_PDF_BYTES) {
      throw new PdfImportError(
        "too_large",
        `The PDF is larger than the ${Math.round(MAX_PDF_BYTES / (1024 * 1024))} MB import limit.`,
      );
    }

    // 1b. Read the bytes once (for the magic-byte check + the parse). The same
    //     absolute path is streamed into the vault by `importAsset` (no double-read
    //     of the bytes through this buffer — `importAsset` re-opens the file).
    let bytes: Buffer;
    try {
      bytes = await readFile(filePath);
    } catch {
      throw new PdfImportError("unreadable", "The PDF file could not be read.");
    }

    // 1c. Magic-byte check: a real PDF starts with `%PDF-`.
    if (!startsWithPdfHeader(bytes)) {
      throw new PdfImportError("not_pdf", "That file is not a PDF.");
    }

    // 1d. Parse the per-page text (also surfaces the page-count cap + encrypted /
    //     unreadable signals). pdfjs throws on a password-protected PDF.
    const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pages: Awaited<ReturnType<typeof extractPdfPages>>;
    let pdfTitle: string | null = null;
    try {
      pages = await extractPdfPages(data);
      pdfTitle = await extractPdfTitle(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/password|encrypt/i.test(message)) {
        throw new PdfImportError("encrypted", "This PDF is password-protected.");
      }
      throw new PdfImportError("unreadable", "This PDF could not be parsed.");
    }
    if (pages.length > MAX_PDF_PAGES) {
      throw new PdfImportError(
        "too_many_pages",
        `The PDF has more than the ${MAX_PDF_PAGES}-page import limit.`,
      );
    }

    // 2. Mint the source id up front so the vault path is known before the row.
    const sourceId = newElementId();
    const snapshotRel = `sources/${sourceId}/original.pdf`;
    const sourceDir = path.join(this.assetsDir, "sources", sourceId);

    // 3. Build the constrained page doc (pure transform).
    const conversion: PlainTextConversion = pdfPagesToProseMirrorDoc(pages);

    // Title fallback chain: explicit override → PDF /Title → the filename stem.
    const title =
      nonEmpty(input.title) ?? nonEmpty(pdfTitle) ?? nonEmpty(filenameStem(filePath)) ?? "PDF";

    // A text-free (scanned) PDF gets a note so the user (and T066) knows to OCR it.
    const noText = pages.length > 0 && pages.every((p) => !p.hasText);
    const userReason = nonEmpty(input.reasonAdded);
    const reasonAdded = userReason
      ? noText
        ? `${userReason} — ${NO_TEXT_NOTE}`
        : userReason
      : noText
        ? NO_TEXT_NOTE
        : null;

    // `createWithDocument` and `importAsset` are SEPARATE transactions (the latter
    // opens its own metadata tx), so a failure in step 5 cannot roll back step 4.
    // Track whether the source row committed so the catch can undo a partial import
    // rather than leave an orphan inbox source pointing at a snapshot that never landed.
    let sourceCommitted = false;
    try {
      // 4. Create the source + its body in ONE transaction. `snapshotKey` already
      //    points at the PDF we are about to stream in (step 5).
      this.sources.createWithDocument({
        id: sourceId as ElementId,
        title,
        priority: priorityFromLabel(input.priority ?? "C"),
        status: "inbox",
        stage: "raw_source",
        accessedAt: new Date().toISOString(),
        snapshotKey: snapshotRel,
        reasonAdded,
        conversion,
      });
      sourceCommitted = true;

      // 5. Stream the original PDF into the vault keyed by the now-existing source
      //    (its own metadata transaction; bytes never touch SQLite). Passing the
      //    absolute path makes `importAsset` `createReadStream` it (no whole-file
      //    buffer held while writing).
      await this.assetVault.importAsset({
        owningElementId: sourceId as ElementId,
        kind: "source_pdf",
        source: filePath,
        mime: "application/pdf",
        destRelativePath: snapshotRel,
      });
    } catch (err) {
      // A partial import must leave NO trace. If the source row committed (the throw
      // came from `importAsset`), soft-delete it so the inbox never shows a source
      // whose `snapshotKey` points at a PDF that was never stored. Then drop the
      // partial vault dir. Both are best-effort; we re-throw the original error.
      if (sourceCommitted) {
        try {
          this.elements.softDelete(sourceId as ElementId);
        } catch {
          // ignore — surface the original import error below
        }
      }
      try {
        rmSync(sourceDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure; surface the original error
      }
      throw err;
    }

    // 6. Return the fresh inbox summary (like the URL path).
    const detail = this.inbox.get(sourceId as ElementId);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === sourceId) ?? null;
    if (!item) {
      throw new Error("PdfImportService: created source not found in inbox");
    }
    return { id: sourceId, item };
  }
}

/** Whether the bytes begin with the PDF magic header `%PDF-`. */
function startsWithPdfHeader(bytes: Buffer): boolean {
  // `%PDF-` = 0x25 0x50 0x44 0x46 0x2d. Some PDFs have a leading BOM/whitespace,
  // so scan the first few bytes for the header.
  const head = bytes.subarray(0, 1024).toString("latin1");
  return head.includes("%PDF-");
}

/** The filename without its directory + extension (a title fallback). */
function filenameStem(filePath: string): string {
  const base = path.basename(filePath);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/** Trim a string to a non-empty value, or `null`. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
