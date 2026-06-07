/**
 * AnkiExportService (T070) — the local-first Anki `.apkg`/CSV export orchestrator (main).
 *
 * Exports a selection of Interleave cards to an Anki-compatible `.apkg` (and/or a
 * CSV) in the user export destination, CARRYING SOURCE REFERENCES into Anki (the
 * originating source title/URL/location → an Anki `Source` field AND an
 * `interleave::source::<slug>` tag) so the lineage is not lost on the way out. It is
 * READ-ONLY on the Interleave DB (no mutation, no op-log) — it produces a file.
 *
 * The `.apkg` build runs main-side: the pure `@interleave/importers` transforms build
 * the per-note rows + the `col` JSON, and this service writes a MINIMAL but
 * Anki-importable `collection.anki2` with `better-sqlite3` (a fresh temp DB) and
 * `buildApkgZip`s it. We target Anki's IMPORTER, not byte-identical internals; the
 * contract is the round-trip (our import of our export).
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Element, ElementId, ElementLocation } from "@interleave/core";
import {
  buildAnkiDconf,
  buildAnkiDecks,
  buildAnkiModels,
  buildApkgZip,
  EXPORT_DECK_ID,
  type ExportNote,
  notesToAnkiRows,
} from "@interleave/importers";
import type {
  ConceptRepository,
  ElementRepository,
  Repositories,
  ReviewRepository,
  SourceRepository,
} from "@interleave/local-db";
import { writeAnkiCollection } from "./anki-collection";

/** The card-selection scope for an export. */
export interface AnkiExportSelection {
  /** Explicit card element ids. */
  readonly cardIds?: readonly ElementId[];
  /** A concept's cards (all live cards assigned to the concept). */
  readonly conceptId?: ElementId;
  /** All live cards. */
  readonly all?: boolean;
}

/** The export-file result (relative + absolute path + the card count written). */
export interface AnkiExportFileResult {
  readonly relativePath: string;
  readonly absPath: string;
  readonly cardCount: number;
}

/** A typed Anki-export failure (e.g. an empty selection). */
export class AnkiExportError extends Error {
  readonly code: "empty_selection";
  constructor(message: string) {
    super(message);
    this.name = "AnkiExportError";
    this.code = "empty_selection";
  }
}

/** Constructor dependencies (injected once; mirroring the other services). */
export interface AnkiExportServiceDeps {
  readonly repositories: Repositories;
  /** The user export destination — Downloads in the Electron app. */
  readonly exportDestinationDir: string;
  /** The Electron-ABI `better-sqlite3` binding for writing the export collection. */
  readonly nativeBinding?: string | undefined;
}

export class AnkiExportService {
  private readonly elements: ElementRepository;
  private readonly review: ReviewRepository;
  private readonly sources: SourceRepository;
  private readonly concepts: ConceptRepository;
  private readonly exportDestinationDir: string;
  private readonly nativeBinding: string | undefined;

  constructor(deps: AnkiExportServiceDeps) {
    this.elements = deps.repositories.elements;
    this.review = deps.repositories.review;
    this.sources = deps.repositories.sources;
    this.concepts = deps.repositories.concepts;
    this.exportDestinationDir = deps.exportDestinationDir;
    this.nativeBinding = deps.nativeBinding;
  }

  /**
   * Export selected cards to an Anki `.apkg` in the user export destination. Read-only on the DB.
   * Throws {@link AnkiExportError} when the selection resolves to no cards.
   */
  async exportApkg(input: AnkiExportSelection): Promise<AnkiExportFileResult> {
    const notes = this.resolveExportNotes(input);
    if (notes.length === 0) {
      throw new AnkiExportError("No cards matched the export selection.");
    }

    const now = Date.now();
    const baseId = now; // epoch-ms note/card ids (unique within the export).
    const mod = Math.floor(now / 1000);

    // Per-note SHA-1 of the first field (for Anki's `csum` note-dedup checksum).
    const firstFieldSha1 = new Map<string, string>();
    for (const note of notes) {
      const firstField = note.kind === "cloze" ? (note.cloze ?? "") : (note.prompt ?? "");
      firstFieldSha1.set(note.id, sha1Hex(stripFirstFieldForChecksum(firstField)));
    }

    const rows = notesToAnkiRows(notes, { baseId, firstFieldSha1 });

    // Build the minimal `col` JSON (Basic + Cloze note types + one deck).
    const models = JSON.stringify(buildAnkiModels(mod));
    const decks = JSON.stringify(buildAnkiDecks("Interleave export", mod));
    const dconf = JSON.stringify(buildAnkiDconf(mod));
    const conf = JSON.stringify({
      nextPos: 1,
      estTimes: true,
      activeDecks: [EXPORT_DECK_ID],
      sortType: "noteFld",
      timeLim: 0,
      sortBackwards: false,
      addToCur: true,
      curDeck: EXPORT_DECK_ID,
      newBury: true,
      newSpread: 0,
      dueCounts: true,
      curModel: null,
      collapseTime: 1200,
    });

    // Write the collection.anki2 to a temp file, zip it into the .apkg, clean up.
    const dir = mkdtempSync(path.join(tmpdir(), "interleave-anki-export-"));
    const collectionPath = path.join(dir, "collection.anki2");
    try {
      writeAnkiCollection(
        collectionPath,
        { crt: Math.floor(now / 1000), mod, models, decks, dconf, conf },
        rows.notes,
        rows.cards,
        this.nativeBinding,
      );
      const collectionBytes = new Uint8Array(readFileSync(collectionPath));
      const apkg = buildApkgZip({ collectionBytes, media: {}, mediaFiles: {} });

      const relativePath = `anki-export-${now}.apkg`;
      const absPath = path.join(this.exportDestinationDir, relativePath);
      mkdirSync(this.exportDestinationDir, { recursive: true });
      await writeFile(absPath, Buffer.from(apkg));
      return { relativePath, absPath, cardCount: notes.length };
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup.
      }
    }
  }

  /**
   * Export selected cards to a CSV in the user export destination — one row per note
   * (the fields + a `Tags` column + a `Source` column). Anki's "import CSV" reads
   * this directly. Read-only on the DB.
   */
  async exportCsv(input: AnkiExportSelection): Promise<AnkiExportFileResult> {
    const notes = this.resolveExportNotes(input);
    if (notes.length === 0) {
      throw new AnkiExportError("No cards matched the export selection.");
    }
    const header = ["Front", "Back", "Cloze", "Tags", "Source"];
    const lines = [header.map(csvCell).join(",")];
    for (const note of notes) {
      const row = [
        note.kind === "qa" ? (note.prompt ?? "") : "",
        note.kind === "qa" ? (note.answer ?? "") : "",
        note.kind === "cloze" ? (note.cloze ?? "") : "",
        note.tags.join(" "),
        note.sourceRef ?? "",
      ];
      lines.push(row.map(csvCell).join(","));
    }
    const csv = `${lines.join("\n")}\n`;

    const now = Date.now();
    const relativePath = `anki-export-${now}.csv`;
    const absPath = path.join(this.exportDestinationDir, relativePath);
    mkdirSync(this.exportDestinationDir, { recursive: true });
    await writeFile(absPath, csv, "utf8");
    return { relativePath, absPath, cardCount: notes.length };
  }

  /**
   * Resolve the card selection (explicit ids / a concept's cards / all live cards) and
   * build an {@link ExportNote} per card, deriving the SOURCE REFERENCE from the card's
   * `sourceUri` and/or its `source_locations` anchor + the owning source's title/URL.
   */
  private resolveExportNotes(input: AnkiExportSelection): ExportNote[] {
    const cardElements = this.resolveCardElements(input);
    const notes: ExportNote[] = [];
    for (const el of cardElements) {
      const found = this.review.findCardById(el.id);
      if (!found) continue;
      const card = found.card;
      const tags = this.elements.listTags(el.id);
      const sourceRef = this.deriveSourceRef(el, card.sourceUri ?? null, card.sourceLocationId);
      notes.push({
        id: el.id,
        kind: card.kind === "cloze" ? "cloze" : "qa",
        prompt: card.prompt,
        answer: card.answer,
        cloze: card.cloze,
        tags,
        sourceRef,
      });
    }
    return notes;
  }

  /** Resolve the selection scope to a list of live `card` elements. */
  private resolveCardElements(input: AnkiExportSelection): Element[] {
    if (input.cardIds && input.cardIds.length > 0) {
      const out: Element[] = [];
      for (const id of input.cardIds) {
        const found = this.review.findCardById(id);
        if (found && !found.element.deletedAt && found.element.type === "card") {
          out.push(found.element);
        }
      }
      return out;
    }
    if (input.conceptId) {
      const ids = this.concepts.elementsForConcept(input.conceptId);
      const out: Element[] = [];
      for (const id of ids) {
        const found = this.review.findCardById(id);
        if (found && !found.element.deletedAt && found.element.type === "card") {
          out.push(found.element);
        }
      }
      return out;
    }
    if (input.all) {
      return this.elements.listByType("card");
    }
    return [];
  }

  /**
   * Build the human-readable source reference carried OUT to Anki's `Source` field.
   * Precedence: the card's own `sourceUri` (an Anki-imported card kept its ref), else
   * the owning source's title (+ URL) and the source-location label when present.
   */
  private deriveSourceRef(
    card: Element,
    sourceUri: string | null,
    sourceLocationId: string | null,
  ): string | null {
    if (sourceUri && sourceUri.trim().length > 0) return sourceUri.trim();

    const sourceId = card.sourceId;
    if (!sourceId) return null;
    const source = this.sources.findById(sourceId as ElementId);
    if (!source) return null;

    const parts: string[] = [source.element.title];
    if (source.source.url) parts.push(source.source.url);
    // Append the source-location label (e.g. "Page 12" / "Chapter 3") when present.
    if (sourceLocationId) {
      const loc = this.findLocationLabel(card.id);
      if (loc) parts.push(loc);
    }
    const ref = parts.filter((p) => p && p.trim().length > 0).join(" — ");
    return ref.length > 0 ? ref : null;
  }

  /** The card's source-location label (e.g. "Page 12"), or null. */
  private findLocationLabel(cardElementId: ElementId): string | null {
    const loc: ElementLocation | null = this.sources.findLocationForElement(cardElementId);
    return loc?.label ?? null;
  }
}

/** SHA-1 hex of a string (Anki's note-dedup checksum is built from this). */
function sha1Hex(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/**
 * Anki computes its `csum` over the first field with HTML + media stripped. Our
 * fields are already plain text, so just strip residual tags + whitespace.
 */
function stripFirstFieldForChecksum(field: string): string {
  return field.replace(/<[^>]+>/g, "").trim();
}

/** Quote a CSV cell per RFC-4180 (escape quotes; wrap when it contains , " or newline). */
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
