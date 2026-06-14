/**
 * EpubImportService (T067) — the local-first EPUB-import orchestrator (main side).
 *
 * Mirrors {@link UrlImportService} / {@link PdfImportService}: the ONE place the pure
 * `@interleave/importers` EPUB transforms, the filesystem asset vault (T059), and the
 * `local-db` source/document pipeline are composed for EPUB import. It runs ENTIRELY
 * in the Electron main process — it reads the chosen `.epub` from disk, validates it
 * (extension + size cap + a `parseEpub`-backed ZIP/OPF/spine/DRM check), writes the
 * ORIGINAL `original.epub` bytes into the vault (`assets/sources/<book_id>/`, content-
 * hashed; bytes NEVER touch SQLite), and creates a small LINEAGE TREE of sources:
 *
 *   - one **book `source`** carrying the book's title/author/published date + the
 *     `original.epub` as its `snapshotKey`, with a structured table-of-contents body
 *     (the title as a heading + the chapter titles as a bulletList) so it is
 *     readable/inspectable (not empty);
 *   - one **chapter `topic`** per spine item, each a schedulable, independently-
 *     readable element whose body is the chapter XHTML mapped to the constrained
 *     ProseMirror schema (stable block ids, headings preserved, footnotes lifted to an
 *     endnotes section), linked `book → chapter` via `parent_child` with the book as
 *     each chapter's `sourceId` lineage root, and a `source_locations` anchor recording
 *     the chapter's place in the book (`page` = spine ordinal, `label` = chapter title).
 *
 * ## Atomicity (load-bearing)
 *
 * The WHOLE book import — the book source, every chapter topic + its blocks + its
 * `parent_child` edge + its `source_locations` row, AND the `source_epub` asset row —
 * runs in ONE `db.transaction` via the `*Within(tx, …)` seams, so a parse/insert
 * failure mid-book rolls back the entire book (no orphan book-with-half-its-chapters,
 * no orphan asset row). The `original.epub` FILE is written to the vault BEFORE the
 * transaction (so its bytes exist for the asset row to reference); on ANY failure the
 * partial `assets/sources/<book_id>/` dir is best-effort removed (mirroring
 * `UrlImportService` / `PdfImportService`). A very large book in one transaction is
 * acceptable for SQLite (better-sqlite3 is synchronous + fast).
 *
 * ## Runner option (deferred, non-breaking)
 *
 * v1 parses + converts inline in main (a book parse is sub-second to a few seconds).
 * `epub_import` is RESERVED as a `JobType` so a future heavy-book path can move the
 * parse + conversion onto the T058 runner without a schema/IPC change.
 *
 * ## Out of scope (documented limits)
 *
 *  - Images (cover/figures) are NOT imported as image extracts — `sanitizeArticleHtml`
 *    drops `<img>` (keeping alt text); the `original.epub` retains them for a later pass.
 *  - A cross-chapter endnotes file is resolved best-effort by the pure transform (the
 *    `[n]` marker stays; the note surfaces in whichever chapter owns its body).
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type ElementId, type PriorityLabel, priorityFromLabel } from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  chapterToProseMirror,
  EpubParseError,
  type EpubParseErrorCode,
  htmlToProseMirrorDoc,
  type ParsedEpub,
  parseEpub,
} from "@interleave/importers";
import {
  type AssetRepository,
  type ElementRepository,
  type InboxItemSummary,
  InboxQuery,
  newBlockId,
  newElementId,
  type Repositories,
  type SourceRepository,
} from "@interleave/local-db";
import { sha256 } from "./backup-manifest";

/** The friendly error codes the IPC layer maps to a user-facing message. */
export type EpubImportErrorCode = EpubParseErrorCode | "not_epub" | "too_large" | "unreadable";

/** A typed EPUB-import failure carrying a `code` the IPC layer maps to a friendly line. */
export class EpubImportError extends Error {
  readonly code: EpubImportErrorCode;
  constructor(code: EpubImportErrorCode, message: string) {
    super(message);
    this.name = "EpubImportError";
    this.code = code;
  }

  /** Reconstruct an `EpubImportError` from a pure-transform `EpubParseError`. */
  static fromParseError(error: EpubParseError): EpubImportError {
    return new EpubImportError(error.code, error.message);
  }
}

/** Hard cap so a hostile EPUB cannot exhaust memory (a book is tens of MB at most). */
const MAX_EPUB_BYTES = 200 * 1024 * 1024; // 200 MB

/** Constructor dependencies (injected once; mirroring `UrlImportService`). */
export interface EpubImportServiceDeps {
  /** The open Drizzle database (for the atomic whole-book transaction). */
  readonly db: InterleaveDatabase;
  /** The repository bag bound to the same DB. */
  readonly repositories: Repositories;
  /** The asset-vault root (`<dataDir>/assets`). */
  readonly assetsDir: string;
}

/** Arguments to {@link EpubImportService.importFromFile}. */
export interface ImportEpubFromFileInput {
  /** ABSOLUTE path to the chosen `.epub` (resolved by the MAIN file picker). */
  readonly absPath: string;
  /** Coarse A/B/C/D priority; defaults `C` so new material never dominates. */
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
}

/** The successful import result (the inbox summary is for the BOOK source). */
export interface EpubImportResult {
  readonly status: "imported";
  readonly bookId: string;
  readonly chapterCount: number;
  readonly item: InboxItemSummary;
}

export class EpubImportService {
  private readonly db: InterleaveDatabase;
  private readonly sources: SourceRepository;
  private readonly elements: ElementRepository;
  private readonly assetsRepo: AssetRepository;
  private readonly inbox: InboxQuery;
  private readonly assetsDir: string;

  constructor(deps: EpubImportServiceDeps) {
    this.db = deps.db;
    this.sources = deps.repositories.sources;
    this.elements = deps.repositories.elements;
    this.assetsRepo = deps.repositories.assets;
    this.inbox = new InboxQuery(deps.repositories);
    this.assetsDir = deps.assetsDir;
  }

  /**
   * Import a local `.epub` as a book `source` + one chapter `topic` per spine item.
   * Throws a typed {@link EpubImportError} on a non-EPUB / oversize / malformed /
   * DRM-protected / unreadable file (nothing is persisted; any partial vault dir is
   * removed).
   */
  async importFromFile(input: ImportEpubFromFileInput): Promise<EpubImportResult> {
    const absPath = input.absPath;

    // 1a. Extension + size cap (a cheap stat before reading the whole file).
    if (!absPath.toLowerCase().endsWith(".epub")) {
      throw new EpubImportError("not_epub", "That file is not an EPUB.");
    }
    let size: number;
    try {
      size = statSync(absPath).size;
    } catch {
      throw new EpubImportError("unreadable", "The EPUB file could not be read.");
    }
    if (size > MAX_EPUB_BYTES) {
      throw new EpubImportError(
        "too_large",
        `The EPUB is larger than the ${Math.round(MAX_EPUB_BYTES / (1024 * 1024))} MB import limit.`,
      );
    }

    // 1b. Read the bytes once (for the vault write + the parse).
    let bytes: Buffer;
    try {
      bytes = await readFile(absPath);
    } catch {
      throw new EpubImportError("unreadable", "The EPUB file could not be read.");
    }

    // 2. Parse (pure transform): metadata + spine-ordered chapters. A malformed /
    //    DRM / empty archive throws a typed `EpubParseError`, re-wrapped here.
    let parsed: ParsedEpub;
    try {
      parsed = parseEpub(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch (err) {
      if (err instanceof EpubParseError) throw EpubImportError.fromParseError(err);
      throw new EpubImportError("unreadable", "This EPUB could not be parsed.");
    }

    // 3. Mint the book id up front so the vault path is known before any row.
    const bookId = newElementId() as ElementId;
    const snapshotRel = `sources/${bookId}/original.epub`;
    const sourceDir = path.join(this.assetsDir, "sources", bookId);
    const snapshotAbs = path.join(this.assetsDir, ...snapshotRel.split("/"));
    const contentHash = sha256(bytes);

    // 4. Convert each chapter (pure transform) BEFORE the transaction so a malformed
    //    chapter aborts the whole import without having written any row. A single
    //    shared minter keeps stable block ids unique across the whole book.
    const mint = newBlockId;
    const chapters = parsed.chapters.map((chapter) => ({
      chapter,
      conversion: chapterToProseMirror(chapter, mint),
      title: chapter.title ?? `Chapter ${chapter.order + 1}`,
    }));

    const priority = priorityFromLabel(input.priority ?? "C");
    const accessedAt = new Date().toISOString();
    const reasonAdded = nonEmpty(input.reasonAdded ?? null);

    // The book-overview body: the title as a real `heading` node + a TOC
    // `bulletList` of chapter titles, so the book source itself is readable/
    // inspectable (not empty) AND structured (not one mashed paragraph). We render
    // a tiny TOC HTML and run it through the SAME constrained HTML→PM converter the
    // URL/EPUB-chapter paths use, so it produces a heading + bulletList with stable
    // block ids that validate against `buildSchema()` — no bespoke doc shape here.
    const bookTitle = parsed.metadata.title ?? "Untitled book";
    const tocHtml = [
      `<h1>${escapeHtml(bookTitle)}</h1>`,
      "<ul>",
      ...chapters.map((c) => `<li>${escapeHtml(c.title)}</li>`),
      "</ul>",
    ].join("");
    const bookConversion = htmlToProseMirrorDoc(tocHtml, mint);

    // 5. Write the `original.epub` to the vault FIRST (outside the tx — bytes on disk),
    //    then create the book + every chapter + the asset row in ONE transaction.
    let wroteDir = false;
    try {
      mkdirSync(sourceDir, { recursive: true });
      wroteDir = true;
      await writeFile(snapshotAbs, bytes);

      this.db.transaction((tx) => {
        // 5a. The book source (its `snapshotKey` points at the epub we just wrote).
        this.sources.createWithDocumentWithin(tx, {
          id: bookId,
          title: bookTitle,
          priority,
          status: "inbox",
          stage: "raw_source",
          author: parsed.metadata.author,
          publishedAt: parsed.metadata.publishedAt,
          accessedAt,
          snapshotKey: snapshotRel,
          reasonAdded,
          // Capture origin (T126): a local EPUB file import.
          capturedVia: "file",
          conversion: bookConversion,
        });

        // 5b. The `source_epub` asset row (bytes already on disk; metadata only).
        this.assetsRepo.createWithin(tx, {
          owningElementId: bookId,
          kind: "source_epub",
          vaultRoot: "assets",
          relativePath: snapshotRel,
          contentHash,
          mime: "application/epub+zip",
          size: bytes.byteLength,
        });

        // 5c. One chapter `topic` per spine item: body + lineage edge + book anchor.
        for (const { chapter, conversion, title } of chapters) {
          const topic = this.sources.createTopicWithDocumentWithin(tx, {
            title,
            priority,
            status: "inbox",
            stage: "rough_topic",
            parentId: bookId,
            sourceId: bookId,
            conversion,
          });
          // book → chapter `parent_child` lineage edge (logs `add_relation`).
          this.elements.addRelationWithin(tx, {
            fromElementId: bookId,
            toElementId: topic.element.id,
            relationType: "parent_child",
          });
          // The chapter's place in the book (`page` = 1-based spine ordinal).
          this.sources.createElementLocationWithin(tx, {
            elementId: topic.element.id,
            sourceElementId: bookId,
            page: chapter.order + 1,
            label: title,
          });
        }
      });
    } catch (err) {
      // Best-effort: remove the partial vault dir so no orphan files linger.
      if (wroteDir) {
        try {
          rmSync(sourceDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; surface the original error below.
        }
      }
      throw err;
    }

    // 6. Return the fresh inbox summary for the BOOK source (chapters appear under it
    //    in the hierarchy view, not as N separate inbox rows).
    const detail = this.inbox.get(bookId);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === bookId) ?? null;
    if (!item) {
      throw new Error("EpubImportService: created book source not found in inbox");
    }
    return { status: "imported", bookId, chapterCount: chapters.length, item };
  }
}

/** Trim a string to a non-empty value, or `null`. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Escape the five XML/HTML metacharacters so a book/chapter title that contains
 * `<`, `>`, `&`, `"`, or `'` is treated as TEXT by the TOC HTML→PM converter,
 * never as markup (titles come from untrusted EPUB metadata).
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
