/**
 * HighlightImportService (T069) — the local-first highlight-import orchestrator (main).
 *
 * Turns an external highlight export (a Readwise CSV/JSON export, or a Kindle
 * `My Clippings.txt`) into inbox `extract` elements — NOT cards, NOT body highlights —
 * grouped under one `source` per book/article, preserving source attribution. It runs
 * ENTIRELY in the Electron main process: it reads the chosen file (the renderer passed
 * only a path), parses it main-side via the pure `@interleave/importers` adapters, and
 * authors the sources + extracts through the existing transactional `local-db`
 * pipeline (one transaction per source, logged).
 *
 * ## Extracts, NOT cards (the roadmap's load-bearing constraint)
 *
 * A highlight is raw, unprocessed material — exactly an `extract`'s role. Turning it
 * straight into an active card would bypass the minimum-information / quality checks
 * (T035) and flood review with un-distilled clippings. So the import floor is
 * `extract`: this service creates ONLY `extract` elements (+ their `source_locations`
 * anchor + `derived_from` lineage edge + inherited tags + an ATTENTION due date) and
 * NEVER touches `cards` / `review_states`. The user later runs the normal extract →
 * card distillation.
 *
 * ## Attribution over in-body anchoring
 *
 * These highlights did NOT come from a document we hold, so each extract's
 * `source_locations` anchor has empty `blockIds` (no jump-to-paragraph). The anchor
 * instead carries the attribution: the highlight's location label (`page` / `label`)
 * and the `selectedText` snapshot; the owning source carries `title` / `author` / `url`.
 *
 * ## Dedup (idempotent re-import)
 *
 *  - SOURCE dedup: a group reuses an existing LIVE source matched by canonical URL
 *    (`SourceRepository.findByCanonicalUrl`, the Readwise URL case) OR by title+author
 *    (`findByTitleAndAuthor`, the no-URL case), so re-running an export does not create
 *    duplicate books.
 *  - EXTRACT dedup: within a (reused or new) source, a highlight whose exact text already
 *    exists as an extract `selectedText` is skipped (`listExtractSelectedText`). Exact-
 *    text match only (no semantic dedup — that is T088).
 */

import { readFile } from "node:fs/promises";
import {
  canonicalizeUrl,
  type ElementId,
  type PriorityLabel,
  plainTextToProseMirrorDoc,
  priorityFromLabel,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  detectHighlightFormat,
  type HighlightFormat,
  type ImportedHighlight,
  parseHighlights,
} from "@interleave/importers";
import {
  type DbClient,
  type DocumentRepository,
  type ElementRepository,
  type InboxItemSummary,
  InboxQuery,
  type Repositories,
  type SourceRepository,
} from "@interleave/local-db";
import { addDays, rawExtractIntervalDays } from "@interleave/scheduler";

/** The friendly error codes the IPC layer maps to a user-facing message. */
export type HighlightImportErrorCode = "unrecognized" | "too_large" | "unreadable" | "empty";

/** A typed highlight-import failure carrying a `code` the IPC layer maps to a friendly line. */
export class HighlightImportError extends Error {
  readonly code: HighlightImportErrorCode;
  constructor(code: HighlightImportErrorCode, message: string) {
    super(message);
    this.name = "HighlightImportError";
    this.code = code;
  }
}

/** Hard cap so a hostile export cannot exhaust memory (a clippings file is small). */
const MAX_HIGHLIGHT_BYTES = 64 * 1024 * 1024; // 64 MB

/** Constructor dependencies (injected once; no vault — highlights are text). */
export interface HighlightImportServiceDeps {
  readonly db: InterleaveDatabase;
  readonly repositories: Repositories;
}

/** Arguments to {@link HighlightImportService.importFromFile}. */
export interface ImportHighlightsFromFileInput {
  /** ABSOLUTE path to the chosen export (resolved by the MAIN file picker). */
  readonly absPath: string;
  /** Optional explicit format; omitted ⇒ auto-detect by filename + content. */
  readonly format?: HighlightFormat;
  /** Coarse A/B/C/D priority; defaults `C` so imported highlights never dominate. */
  readonly priority?: PriorityLabel;
}

/** The successful import result — counts + the inbox summaries for the created sources. */
export interface HighlightImportResult {
  readonly status: "imported";
  readonly format: HighlightFormat;
  readonly sourceCount: number;
  readonly extractCount: number;
  readonly skipped: number;
  readonly items: readonly InboxItemSummary[];
}

/** A book/article group: its attribution + the highlights that belong to it. */
interface HighlightGroup {
  readonly title: string;
  readonly author: string | null;
  readonly sourceUrl: string | null;
  readonly highlights: ImportedHighlight[];
}

export class HighlightImportService {
  private readonly db: InterleaveDatabase;
  private readonly sources: SourceRepository;
  private readonly elements: ElementRepository;
  private readonly documents: DocumentRepository;
  private readonly inbox: InboxQuery;

  constructor(deps: HighlightImportServiceDeps) {
    this.db = deps.db;
    this.sources = deps.repositories.sources;
    this.elements = deps.repositories.elements;
    this.documents = deps.repositories.documents;
    this.inbox = new InboxQuery(deps.repositories);
  }

  /**
   * Import a local highlight export into inbox `extract`s grouped under one source per
   * book/article. Throws a typed {@link HighlightImportError} on an oversize /
   * unreadable / unrecognized / empty export (nothing is persisted).
   */
  async importFromFile(input: ImportHighlightsFromFileInput): Promise<HighlightImportResult> {
    // 1. Read the file in main (size-capped).
    let bytes: Buffer;
    try {
      bytes = await readFile(input.absPath);
    } catch {
      throw new HighlightImportError("unreadable", "The export file could not be read.");
    }
    if (bytes.byteLength > MAX_HIGHLIGHT_BYTES) {
      throw new HighlightImportError(
        "too_large",
        `The export is larger than the ${Math.round(MAX_HIGHLIGHT_BYTES / (1024 * 1024))} MB import limit.`,
      );
    }
    const content = bytes.toString("utf8");

    // 2. Detect (or use the supplied) format, then run the matching pure adapter.
    const format = input.format ?? detectHighlightFormat(input.absPath, content);
    if (!format) {
      throw new HighlightImportError(
        "unrecognized",
        "Couldn't recognize this highlight export (expected a Readwise CSV/JSON or a Kindle My Clippings.txt).",
      );
    }
    let highlights: ImportedHighlight[];
    try {
      highlights = parseHighlights(format, content);
    } catch {
      throw new HighlightImportError("unrecognized", "Couldn't recognize this highlight export.");
    }
    if (highlights.length === 0) {
      throw new HighlightImportError("empty", "No highlights were found in that export.");
    }

    // 3. Group by (title, author) — one source per book/article.
    const groups = groupByBook(highlights);
    const priority = priorityFromLabel(input.priority ?? "C");

    const items: InboxItemSummary[] = [];
    let extractCount = 0;
    let skipped = 0;

    // One transaction PER source (per the spec) so a failure on one book does not
    // discard the books already imported in this batch.
    for (const group of groups) {
      const { sourceId, addedExtracts, skippedExtracts } = this.importGroup(group, priority);
      extractCount += addedExtracts;
      skipped += skippedExtracts;
      const item =
        this.inbox.get(sourceId)?.summary ??
        this.inbox.list().find((i) => i.id === sourceId) ??
        null;
      if (item && !items.some((i) => i.id === item.id)) items.push(item);
    }

    return {
      status: "imported",
      format,
      sourceCount: items.length,
      extractCount,
      skipped,
      items,
    };
  }

  /**
   * Import one book/article group in ONE transaction: find-or-create its source, then
   * author one `extract` per (non-duplicate) highlight. Returns the source id + the
   * added / skipped extract counts.
   */
  private importGroup(
    group: HighlightGroup,
    priority: number,
  ): { sourceId: ElementId; addedExtracts: number; skippedExtracts: number } {
    return this.db.transaction((tx) => {
      // 3a. Find-or-create the book/article source (dedup: canonical URL, then title+author).
      const canonicalUrl = group.sourceUrl ? canonicalizeUrl(group.sourceUrl) : null;
      const existing =
        this.sources.findByCanonicalUrl(canonicalUrl) ??
        this.sources.findByTitleAndAuthor(group.title, group.author);

      let sourceId: ElementId;
      if (existing) {
        sourceId = existing.element.id;
      } else {
        // A near-empty readable body: the title as a heading (so the source is not
        // empty/blank) — the highlights live as its extract children, not in this body.
        const bodyConversion = plainTextToProseMirrorDoc(group.title);
        const created = this.sources.createWithDocumentWithin(tx, {
          title: group.title,
          priority,
          status: "inbox",
          stage: "raw_source",
          author: group.author,
          url: group.sourceUrl,
          originalUrl: group.sourceUrl,
          canonicalUrl,
          accessedAt: new Date().toISOString(),
          reasonAdded: "Imported highlights",
          // Capture origin (T126): a Readwise / Kindle highlight export import.
          capturedVia: "highlight_import",
          conversion: bodyConversion,
        });
        sourceId = created.element.id;
      }

      // 3b. Dedup the group's highlights against the extracts already under this source.
      const existingText = this.sources.listExtractSelectedText(sourceId);
      let added = 0;
      let skippedDup = 0;
      for (const hl of group.highlights) {
        if (existingText.has(hl.text)) {
          skippedDup++;
          continue;
        }
        existingText.add(hl.text); // guard against in-batch duplicates too.
        this.createHighlightExtract(tx, sourceId, hl, priority);
        added++;
      }
      return { sourceId, addedExtracts: added, skippedExtracts: skippedDup };
    });
  }

  /**
   * Author one inbox `extract` from a highlight, on an EXISTING transaction: the extract
   * element + its `source_locations` anchor (attribution only — empty `blockIds`), a
   * body seed (the highlight text, + the note as a second paragraph when present), a
   * `derived_from` lineage edge to the source, the highlight's tags, and an initial
   * ATTENTION due date. Never creates a card / review state.
   */
  private createHighlightExtract(
    tx: DbClient,
    sourceId: ElementId,
    hl: ImportedHighlight,
    priority: number,
  ): void {
    const label = hl.location ?? labelFromPage(hl.page);
    const { element } = this.sources.createExtractWithin(tx, {
      sourceElementId: sourceId,
      title: titleFromText(hl.text),
      priority,
      stage: "raw_extract",
      selectedText: hl.text,
      blockIds: [], // attribution-only anchor — no in-body location to jump to.
      page: hl.page,
      label,
    });

    // Seed the extract's own body: the highlight text, + the note (if any) as a
    // second paragraph so the user's annotation survives the import.
    const bodyText = hl.note && hl.note.trim().length > 0 ? `${hl.text}\n\n${hl.note}` : hl.text;
    const conversion = plainTextToProseMirrorDoc(bodyText);
    this.documents.upsertWithin(tx, {
      elementId: element.id,
      prosemirrorJson: conversion.doc,
      plainText: conversion.plainText,
      blocks: conversion.blocks.map((b) => ({
        blockType: b.blockType,
        order: b.order,
        stableBlockId: b.stableBlockId,
      })),
    });

    // derived_from edge extract → source (lineage is sacred).
    this.elements.addRelationWithin(tx, {
      fromElementId: element.id,
      toElementId: sourceId,
      relationType: "derived_from",
    });

    // Inherit the highlight's tags (Readwise tags, else none).
    for (const tag of hl.tags) {
      this.elements.addTagWithin(tx, element.id, tag);
    }

    // Initial ATTENTION due date + scheduled status — NEVER FSRS (no review_states row).
    const dueAt = addDays(nowIsoForExtract(), rawExtractIntervalDays(priority));
    this.elements.rescheduleWithin(tx, element.id, dueAt, "scheduled");
  }
}

/** A mutable accumulator for {@link groupByBook} (the public {@link HighlightGroup} is readonly). */
interface MutableHighlightGroup {
  readonly title: string;
  readonly author: string | null;
  sourceUrl: string | null;
  readonly highlights: ImportedHighlight[];
}

/** Group highlights by `(title, author)` — preserving first-seen order. */
function groupByBook(highlights: readonly ImportedHighlight[]): HighlightGroup[] {
  const groups = new Map<string, MutableHighlightGroup>();
  for (const hl of highlights) {
    const key = `${hl.title} ${hl.author ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        title: hl.title,
        author: hl.author,
        // The first non-null source URL in the group represents the book/article.
        sourceUrl: hl.sourceUrl,
        highlights: [],
      };
      groups.set(key, group);
    } else if (!group.sourceUrl && hl.sourceUrl) {
      group.sourceUrl = hl.sourceUrl;
    }
    group.highlights.push(hl);
  }
  return [...groups.values()];
}

/** A compact, human-readable extract title derived from the highlight text. */
function titleFromText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 80) return flat;
  return `${flat.slice(0, 77).trimEnd()}…`;
}

/** A fallback label when a highlight has a page but no raw location string. */
function labelFromPage(page: number | null): string | null {
  return page != null ? `Page ${page}` : null;
}

/** Current ISO timestamp (separated so the body reads clearly). */
function nowIsoForExtract(): string {
  return new Date().toISOString();
}
