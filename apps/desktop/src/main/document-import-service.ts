/**
 * DocumentImportService (T068) — local Markdown / HTML import + Markdown export.
 *
 * The ONE main-side place the pure `@interleave/importers` Markdown/HTML transforms,
 * the `local-db` source/document pipeline, and the filesystem vault are composed for
 * document import/export. Runs ENTIRELY in the Electron main process: it reads the
 * chosen file (the renderer passed only a path / pasted text), parses it main-side,
 * and creates an `inbox` `source` through the existing transactional pipeline (one
 * transaction, logged) with the body mapped to the constrained ProseMirror schema +
 * stable block ids. The reverse — `exportToMarkdown` — serializes a stored document
 * back to a `.md` written into the user export destination.
 *
 * ## Format paths
 *
 *  - **Markdown** (`.md`/`.markdown`, or pasted text): `markdownToProseMirrorDoc`
 *    (CommonMark, raw-HTML passthrough OFF). The text body IS the source — no separate
 *    `original.*` snapshot is stored (Markdown is its own canonical form).
 *  - **HTML** (`.html`/`.htm`): `htmlFileToProseMirrorDoc` = `sanitizeArticleHtml` (the
 *    load-bearing security boundary) → `htmlToProseMirrorDoc`. The ORIGINAL untrusted
 *    `.html` bytes are ALSO stored in the vault as a `source_html` asset (mirroring URL
 *    import) so the original survives.
 *
 * ## Export is a FILE ARTIFACT, not a mutation
 *
 * `exportToMarkdown` is read-only on the DB: it loads the stored ProseMirror doc, runs
 * `proseMirrorDocToMarkdown`, and writes `<element_id>-<slug>.md` into the injected
 * export destination. It appends NO `operation_log` entry (it changes no domain data).
 * The renderer never picks the path; main owns the destination.
 *
 * ## Fidelity ceiling (documented)
 *
 * The constrained schema is the fidelity ceiling: images (→ alt text), code-block
 * language, tables, and HTML passthrough are normalized away on import and do NOT
 * round-trip. Exported Markdown round-trips structurally (the fixed-point contract in
 * `@interleave/importers`'s markdown tests).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CapturedVia,
  type ElementId,
  type PlainTextConversion,
  type PriorityLabel,
  type ProseMirrorDoc,
  priorityFromLabel,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  extractHtmlTitle,
  htmlFileToProseMirrorDoc,
  markdownToProseMirrorDoc,
  proseMirrorDocToMarkdown,
} from "@interleave/importers";
import {
  type AssetRepository,
  type DocumentRepository,
  type InboxItemSummary,
  InboxQuery,
  newBlockId,
  newElementId,
  type Repositories,
  type SourceRepository,
} from "@interleave/local-db";
import { sha256 } from "./backup-manifest";

/** The document formats a file import dispatches on. */
export type DocumentImportFormat = "markdown" | "html";

/** The friendly error codes the IPC layer maps to a user-facing message. */
export type DocumentImportErrorCode = "not_supported" | "too_large" | "unreadable" | "empty";

/** A typed document-import failure carrying a `code` the IPC layer maps to a friendly line. */
export class DocumentImportError extends Error {
  readonly code: DocumentImportErrorCode;
  constructor(code: DocumentImportErrorCode, message: string) {
    super(message);
    this.name = "DocumentImportError";
    this.code = code;
  }
}

/** Hard cap so a hostile file cannot exhaust memory (a note is tiny; books go via EPUB). */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024; // 32 MB

/** Constructor dependencies (injected once; mirroring `UrlImportService`). */
export interface DocumentImportServiceDeps {
  readonly db: InterleaveDatabase;
  readonly repositories: Repositories;
  /** The asset-vault root (`<dataDir>/assets`) — for storing `original.html`. */
  readonly assetsDir: string;
  /** The user export destination — Downloads in the Electron app. */
  readonly exportDestinationDir: string;
}

/** Arguments to {@link DocumentImportService.importFromFile}. */
export interface ImportDocumentFromFileInput {
  readonly absPath: string;
  readonly format: DocumentImportFormat;
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
}

/** Arguments to {@link DocumentImportService.importFromText} (the paste path). */
export interface ImportMarkdownFromTextInput {
  readonly text: string;
  readonly title?: string | null;
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
}

/** The successful import result (the inbox summary for the created source). */
export interface DocumentImportResult {
  readonly status: "imported";
  readonly id: string;
  readonly item: InboxItemSummary;
}

/** The export result — the relative + absolute path of the written `.md`. */
export interface MarkdownExportResult {
  readonly relativePath: string;
  readonly absPath: string;
}

export class DocumentImportService {
  private readonly db: InterleaveDatabase;
  private readonly sources: SourceRepository;
  private readonly assetsRepo: AssetRepository;
  private readonly documents: DocumentRepository;
  private readonly inbox: InboxQuery;
  private readonly assetsDir: string;
  private readonly exportDestinationDir: string;

  constructor(deps: DocumentImportServiceDeps) {
    this.db = deps.db;
    this.sources = deps.repositories.sources;
    this.assetsRepo = deps.repositories.assets;
    this.documents = deps.repositories.documents;
    this.inbox = new InboxQuery(deps.repositories);
    this.assetsDir = deps.assetsDir;
    this.exportDestinationDir = deps.exportDestinationDir;
  }

  /**
   * Import a local `.md`/`.html` file as an `inbox` `source`. Throws a typed
   * {@link DocumentImportError} on an oversize / unreadable / empty file.
   */
  async importFromFile(input: ImportDocumentFromFileInput): Promise<DocumentImportResult> {
    const { absPath, format } = input;

    let bytes: Buffer;
    try {
      bytes = await readFile(absPath);
    } catch {
      throw new DocumentImportError("unreadable", "The file could not be read.");
    }
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new DocumentImportError(
        "too_large",
        `The file is larger than the ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB import limit.`,
      );
    }
    const text = bytes.toString("utf8");
    const filenameTitle = basenameTitle(absPath);

    if (format === "markdown") {
      const conversion = markdownToProseMirrorDoc(text, newBlockId);
      const title = firstHeadingTitle(conversion) ?? filenameTitle;
      return this.createSource(
        { title, conversion, priority: input.priority, capturedVia: "file" },
        input.reasonAdded,
      );
    }

    // HTML: sanitize → HTML→PM, AND store the original untrusted bytes in the vault.
    const conversion = htmlFileToProseMirrorDoc(text, newBlockId);
    const title = extractHtmlTitle(text) ?? firstHeadingTitle(conversion) ?? filenameTitle;
    return this.createHtmlSource(
      { title, conversion, priority: input.priority, capturedVia: "file" },
      input.reasonAdded,
      bytes,
    );
  }

  /**
   * Import pasted Markdown as an `inbox` `source` (the paste path — no file read).
   * Throws {@link DocumentImportError} `empty` on whitespace-only text.
   */
  async importFromText(input: ImportMarkdownFromTextInput): Promise<DocumentImportResult> {
    if (input.text.trim().length === 0) {
      throw new DocumentImportError("empty", "There is no Markdown to import.");
    }
    const conversion = markdownToProseMirrorDoc(input.text, newBlockId);
    const title =
      nonEmpty(input.title ?? null) ?? firstHeadingTitle(conversion) ?? "Pasted Markdown";
    // Capture origin (T126): pasted Markdown is a manual capture, not a file import.
    return this.createSource(
      { title, conversion, priority: input.priority, capturedVia: "manual" },
      input.reasonAdded,
    );
  }

  /** Create an `inbox` source from a pre-built conversion (the shared MD/paste path). */
  private createSource(
    args: {
      title: string;
      conversion: PlainTextConversion;
      priority?: PriorityLabel | undefined;
      capturedVia: CapturedVia;
    },
    reasonAdded: string | null | undefined,
  ): DocumentImportResult {
    const id = newElementId() as ElementId;
    this.db.transaction((tx) => {
      this.sources.createWithDocumentWithin(tx, {
        id,
        title: args.title,
        priority: priorityFromLabel(args.priority ?? "C"),
        status: "inbox",
        stage: "raw_source",
        accessedAt: new Date().toISOString(),
        reasonAdded: nonEmpty(reasonAdded ?? null),
        // Capture origin (T126) — `file` for a read file, `manual` for pasted text.
        capturedVia: args.capturedVia,
        conversion: args.conversion,
      });
    });
    return this.finish(id);
  }

  /**
   * Create an `inbox` source from an HTML conversion AND stream the ORIGINAL `.html`
   * bytes into the vault as a `source_html` asset (mirroring URL import), all in ONE
   * transaction. The file write happens BEFORE the transaction (bytes on disk); on
   * rollback the partial vault dir is best-effort removed.
   */
  private createHtmlSource(
    args: {
      title: string;
      conversion: PlainTextConversion;
      priority?: PriorityLabel | undefined;
      capturedVia: CapturedVia;
    },
    reasonAdded: string | null | undefined,
    bytes: Buffer,
  ): DocumentImportResult {
    const id = newElementId() as ElementId;
    const snapshotRel = `sources/${id}/original.html`;
    const sourceDir = path.join(this.assetsDir, "sources", id);
    const snapshotAbs = path.join(this.assetsDir, ...snapshotRel.split("/"));
    const contentHash = sha256(bytes);

    let wroteDir = false;
    try {
      mkdirSync(sourceDir, { recursive: true });
      wroteDir = true;
      // Synchronous write so the bytes exist before the (synchronous) transaction.
      writeFileSync(snapshotAbs, bytes);

      this.db.transaction((tx) => {
        this.sources.createWithDocumentWithin(tx, {
          id,
          title: args.title,
          priority: priorityFromLabel(args.priority ?? "C"),
          status: "inbox",
          stage: "raw_source",
          accessedAt: new Date().toISOString(),
          snapshotKey: snapshotRel,
          reasonAdded: nonEmpty(reasonAdded ?? null),
          // Capture origin (T126) — `file` for a read file, `manual` for pasted text.
          capturedVia: args.capturedVia,
          conversion: args.conversion,
        });
        this.assetsRepo.createWithin(tx, {
          owningElementId: id,
          kind: "source_html",
          vaultRoot: "assets",
          relativePath: snapshotRel,
          contentHash,
          mime: "text/html",
          size: bytes.byteLength,
        });
      });
    } catch (err) {
      if (wroteDir) {
        try {
          rmSync(sourceDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; surface the original error.
        }
      }
      throw err;
    }
    return this.finish(id);
  }

  /** Resolve + return the fresh inbox summary for a created source. */
  private finish(id: ElementId): DocumentImportResult {
    const detail = this.inbox.get(id);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === id) ?? null;
    if (!item) {
      throw new Error("DocumentImportService: created source not found in inbox");
    }
    return { status: "imported", id, item };
  }

  /**
   * Export an element's stored document body to a `.md` in the user export destination.
   * Read-only on the DB (no mutation, no op-log entry — it produces a file artifact).
   * Throws if the element has no stored document.
   */
  async exportToMarkdown(input: { elementId: ElementId }): Promise<MarkdownExportResult> {
    const doc = this.documents.findById(input.elementId);
    if (!doc) {
      throw new DocumentImportError("not_supported", "That element has no document to export.");
    }
    const markdown = proseMirrorDocToMarkdown(doc.prosemirrorJson as ProseMirrorDoc);
    const title = this.sources.findById(input.elementId)?.element.title ?? null;
    const relativePath = `${input.elementId}-${slug(title)}.md`;
    const absPath = path.join(this.exportDestinationDir, relativePath);
    mkdirSync(this.exportDestinationDir, { recursive: true });
    await writeFile(absPath, markdown, "utf8");
    return { relativePath, absPath };
  }
}

/** The first `# heading` text of a conversion (the natural doc title), or null. */
function firstHeadingTitle(conversion: PlainTextConversion): string | null {
  const first = conversion.doc.content[0];
  if (first && first.type === "heading") {
    const text = (first.content ?? [])
      .map((n) => (n.type === "text" ? n.text : ""))
      .join("")
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

/** The filename stem (without extension) as a fallback title. */
function basenameTitle(absPath: string): string {
  const base = absPath.split(/[\\/]/).pop() ?? absPath;
  const stem = base.replace(/\.[^.]+$/, "").trim();
  return stem.length > 0 ? stem : "Imported document";
}

/** A filesystem-safe slug for the export filename (lowercase, hyphenated). */
function slug(title: string | null): string {
  const base = (title ?? "document")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base.length > 0 ? base : "document";
}

/** Trim a string to a non-empty value, or `null`. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
