/**
 * AnkiImportService (T070) — the local-first Anki `.apkg` import orchestrator (main).
 *
 * Turns an Anki `.apkg` deck into Interleave `card` elements (Basic → Q&A, Cloze →
 * cloze) under a per-deck lineage-root `source`, PRESERVING review history when
 * available. It runs ENTIRELY in the Electron main process: it reads the chosen
 * `.apkg` from disk, unwraps the ZIP + opens the embedded `collection.anki2` with
 * `better-sqlite3`, maps the rows via the pure `@interleave/importers` transforms,
 * and authors the cards through the existing transactional `local-db` pipeline.
 *
 * ## Cards, never orphaned (the lineage invariant)
 *
 * Every imported note becomes a `card` element under a per-deck `source` ("Imported
 * Anki deck: <name>") so a card always points back to a source. The Anki `Source`
 * field / deck name is also carried into the card's new `cards.source_uri` column so
 * attribution survives even without an in-app `source_locations` anchor.
 *
 * ## Review history: FSRS-vs-Anki-SM-2 (handled HONESTLY)
 *
 * Anki schedules with SM-2 (interval + ease) or its own FSRS; OUR scheduler is
 * ts-fsrs. There is no exact map from SM-2 ease/interval to FSRS stability/
 * difficulty. We carry what IS comparable and seed the rest plausibly:
 *
 *   - `reps`/`lapses` → carried directly (they are comparable counters);
 *   - `dueAt` → preserved (the most user-visible continuity — the card lands on
 *     roughly the same review schedule);
 *   - `stability` → seeded ≈ the Anki interval (FSRS stability is "days until ~90%
 *     retrievability"; a stable Anki interval is a reasonable proxy);
 *   - `difficulty` → seeded from a transform of the Anki ease factor (lower ease ⇒
 *     higher difficulty), neutral default when ease is unavailable.
 *
 * This is an APPROXIMATION, not a faithful FSRS history — the real FSRS parameters
 * re-converge over the next few reviews. We do NOT fabricate per-review `review_logs`
 * for historical Anki reviews (that would corrupt analytics + future FSRS
 * optimization); only real in-Interleave reviews ever appear in `review_logs`. A
 * note with NO scheduling imports as a brand-new un-due card. All of this flows
 * through the WIDENED `ReviewRepository.createCardWithin` `reviewSeed` input.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { AssetKind } from "@interleave/core";
import {
  canonicalizeCloze,
  type ElementId,
  type FsrsState,
  type PriorityLabel,
  plainTextToProseMirrorDoc,
  priorityFromLabel,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type AnkiNoteRecord,
  AnkiParseError,
  type AnkiScheduling,
  ankiRowsToNotes,
  parseApkgZip,
} from "@interleave/importers";
import {
  type AssetRepository,
  type DbClient,
  type ElementRepository,
  type InboxItemSummary,
  InboxQuery,
  newElementId,
  type Repositories,
  type ReviewRepository,
  type ReviewStateSeed,
  type SourceRepository,
} from "@interleave/local-db";
import { addDays } from "@interleave/scheduler";
import { readAnkiCollection } from "./anki-collection";
import type { AssetVaultService } from "./asset-vault-service";
import { sha256 } from "./backup-manifest";

/** The friendly error codes the IPC layer maps to a user-facing message. */
export type AnkiImportErrorCode =
  | "not_apkg"
  | "too_large"
  | "unreadable"
  | "not_a_zip"
  | "no_collection"
  | "unsupported_compression"
  | "empty_collection";

/** A typed Anki-import failure carrying a `code` the IPC layer maps to a friendly line. */
export class AnkiImportError extends Error {
  readonly code: AnkiImportErrorCode;
  constructor(code: AnkiImportErrorCode, message: string) {
    super(message);
    this.name = "AnkiImportError";
    this.code = code;
  }

  /** Reconstruct an `AnkiImportError` from a pure-transform `AnkiParseError`. */
  static fromParseError(error: AnkiParseError): AnkiImportError {
    return new AnkiImportError(error.code, error.message);
  }
}

/** Hard cap so a hostile `.apkg` cannot exhaust memory (a deck is tens of MB at most). */
const MAX_APKG_BYTES = 500 * 1024 * 1024; // 500 MB

/** Constructor dependencies (injected once; mirroring the other import services). */
export interface AnkiImportServiceDeps {
  readonly db: InterleaveDatabase;
  readonly repositories: Repositories;
  /** The asset-vault root (`<dataDir>/assets`) — the retained `.apkg` lands here. */
  readonly assetsDir: string;
  /** The vault service used to stream the deck's media files in as addressable assets. */
  readonly assetVault: AssetVaultService;
  /** The Electron-ABI `better-sqlite3` binding for opening the embedded collection. */
  readonly nativeBinding?: string | undefined;
}

/** Arguments to {@link AnkiImportService.importFromFile}. */
export interface ImportAnkiFromFileInput {
  /** ABSOLUTE path to the chosen `.apkg` (resolved by the MAIN file picker). */
  readonly absPath: string;
  /** Coarse A/B/C/D priority; defaults `C` so a fresh deck never dominates. */
  readonly priority?: PriorityLabel;
}

/** The successful import result — counts + the inbox summary for the deck source. */
export interface AnkiImportResult {
  readonly status: "imported";
  readonly deckCount: number;
  readonly cardCount: number;
  /** How many cards carried scheduling history over (the rest imported as new). */
  readonly withHistory: number;
  readonly item: InboxItemSummary;
}

export class AnkiImportService {
  private readonly db: InterleaveDatabase;
  private readonly sources: SourceRepository;
  private readonly elements: ElementRepository;
  private readonly review: ReviewRepository;
  private readonly assetsRepo: AssetRepository;
  private readonly inbox: InboxQuery;
  private readonly assetsDir: string;
  private readonly assetVault: AssetVaultService;
  private readonly nativeBinding: string | undefined;

  constructor(deps: AnkiImportServiceDeps) {
    this.db = deps.db;
    this.sources = deps.repositories.sources;
    this.elements = deps.repositories.elements;
    this.review = deps.repositories.review;
    this.assetsRepo = deps.repositories.assets;
    this.inbox = new InboxQuery(deps.repositories);
    this.assetsDir = deps.assetsDir;
    this.assetVault = deps.assetVault;
    this.nativeBinding = deps.nativeBinding;
  }

  /**
   * Import a local `.apkg` as Interleave `card` elements under a per-deck lineage-root
   * `source`. Throws a typed {@link AnkiImportError} on a non-`.apkg` / oversize /
   * malformed / compressed / empty archive (nothing is persisted).
   */
  async importFromFile(input: ImportAnkiFromFileInput): Promise<AnkiImportResult> {
    const absPath = input.absPath;

    // 1. Extension + size cap.
    if (!absPath.toLowerCase().endsWith(".apkg")) {
      throw new AnkiImportError("not_apkg", "That file is not an Anki package (.apkg).");
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(absPath);
    } catch {
      throw new AnkiImportError("unreadable", "The Anki package could not be read.");
    }
    if (bytes.byteLength > MAX_APKG_BYTES) {
      throw new AnkiImportError(
        "too_large",
        `The .apkg is larger than the ${Math.round(MAX_APKG_BYTES / (1024 * 1024))} MB import limit.`,
      );
    }

    // 2. Unwrap the ZIP (pure) → collection bytes + media. A malformed / compressed
    //    archive throws a typed `AnkiParseError`, re-wrapped here.
    let parsed: ReturnType<typeof parseApkgZip>;
    try {
      parsed = parseApkgZip(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch (err) {
      if (err instanceof AnkiParseError) throw AnkiImportError.fromParseError(err);
      throw new AnkiImportError("not_a_zip", "That .apkg could not be parsed.");
    }

    // 3. Open the embedded collection with better-sqlite3 (a temp file), read its rows,
    //    and map them to normalized notes via the pure transform. Clean up the temp.
    const notes = this.readNotesFromCollection(parsed.collectionBytes);
    if (notes.length === 0) {
      throw new AnkiImportError("empty_collection", "That Anki deck has no cards to import.");
    }

    const priority = priorityFromLabel(input.priority ?? "C");
    const deckName = deriveDeckName(absPath);

    // 4. Mint the deck source id up front so the vault path is known before any row.
    const deckId = newElementId() as ElementId;
    const archiveRel = `sources/${deckId}/original.apkg`;
    const deckDir = path.join(this.assetsDir, "sources", deckId);
    const archiveAbs = path.join(this.assetsDir, ...archiveRel.split("/"));
    const contentHash = sha256(bytes);

    // 5. Author the deck source + the import_archive asset row + every card in ONE
    //    transaction (atomic — a failure rolls the whole deck back). The `.apkg` FILE
    //    is written to the vault BEFORE the tx (so its bytes exist for the asset row);
    //    on rollback the partial vault dir is best-effort removed (mirrors EPUB import).
    let withHistory = 0;
    const overviewBody = `${deckName}\n\nImported Anki deck — ${notes.length} card${notes.length === 1 ? "" : "s"}.`;
    let wroteDir = false;
    try {
      mkdirSync(deckDir, { recursive: true });
      wroteDir = true;
      await writeFile(archiveAbs, bytes);

      this.db.transaction((tx) => {
        // 5a. The per-deck lineage-root source (so imported cards are never orphaned).
        this.sources.createWithDocumentWithin(tx, {
          id: deckId,
          title: `Imported Anki deck: ${deckName}`,
          priority,
          status: "inbox",
          stage: "raw_source",
          accessedAt: new Date().toISOString(),
          reasonAdded: "Imported Anki deck",
          snapshotKey: archiveRel,
          // Capture origin (T126): a local `.apkg` file import.
          capturedVia: "file",
          conversion: plainTextToProseMirrorDoc(overviewBody),
        });

        // 5b. The retained `.apkg` asset row (bytes already on disk; metadata only).
        this.assetsRepo.createWithin(tx, {
          owningElementId: deckId,
          kind: "import_archive",
          vaultRoot: "assets",
          relativePath: archiveRel,
          contentHash,
          mime: "application/octet-stream",
          size: bytes.byteLength,
        });

        // 5c. One card element per note (Basic → qa, Cloze → cloze), with the mapped
        //     review seed (when the note had scheduling) + the source-ref provenance.
        for (const note of notes) {
          const created = this.authorCard(tx, deckId, note, priority, deckName);
          if (created.withHistory) withHistory++;
        }
      });
    } catch (err) {
      if (wroteDir) {
        try {
          rmSync(deckDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup; surface the original error.
        }
      }
      throw err;
    }

    // 6. Best-effort: stream the deck's media files into the vault as individually
    //    addressable image/audio/video assets owned by the deck source (so they are
    //    not buried inside the retained `.apkg`). This runs AFTER the cards commit (it
    //    is non-critical — `importAsset` is async + runs its own tx; the deck + cards
    //    already exist, and the bytes also live in the retained archive). A failure
    //    here NEVER fails the import (the deck is already valid).
    await this.importDeckMedia(deckId, parsed.media, parsed.mediaFiles);

    // 7. Return the deck inbox summary (cards appear under it, not as N inbox rows).
    const detail = this.inbox.get(deckId);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === deckId) ?? null;
    if (!item) {
      throw new Error("AnkiImportService: created deck source not found in inbox");
    }
    return {
      status: "imported",
      deckCount: 1,
      cardCount: notes.length,
      withHistory,
      item,
    };
  }

  /**
   * Open the embedded `collection.anki2` bytes with better-sqlite3 (a temp file),
   * read its rows, map them to {@link AnkiNoteRecord}[], and delete the temp file.
   */
  private readNotesFromCollection(collectionBytes: Uint8Array): AnkiNoteRecord[] {
    const dir = mkdtempSync(path.join(tmpdir(), "interleave-anki-"));
    const collectionPath = path.join(dir, "collection.anki2");
    try {
      // Synchronous write so the file exists for the synchronous better-sqlite3 open
      // (better-sqlite3 is sync; a deck read is sub-second).
      writeFileSync(collectionPath, Buffer.from(collectionBytes));
      const rows = readAnkiCollection(collectionPath, this.nativeBinding);
      return ankiRowsToNotes(rows);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup.
      }
    }
  }

  /**
   * Best-effort: stream the deck's media files into the vault as individually
   * addressable assets owned by the deck `source`, preserving each file's ORIGINAL
   * filename in the destination path (`sources/<deck_id>/media/<filename>`). The
   * `media` map keys the numbered archive entries to their original names; an entry
   * with no mapped name falls back to its numbered key. Each file is classified
   * image/audio/video by its extension; an unrecognized type is skipped (the bytes
   * still live in the retained `.apkg`). A failure on any one file is swallowed so the
   * already-committed deck import never fails.
   */
  private async importDeckMedia(
    deckId: ElementId,
    media: Record<string, string>,
    mediaFiles: Record<string, Uint8Array>,
  ): Promise<void> {
    const entries = Object.entries(mediaFiles);
    if (entries.length === 0) return;
    const seen = new Set<string>();
    for (const [key, bytes] of entries) {
      try {
        const originalName = media[key] ?? key;
        const { mime, kind } = mediaTypeForFilename(originalName);
        if (!kind) continue; // not an image/audio/video — leave it in the archive only.
        // Sanitize the filename to a vault-safe leaf, de-duping collisions.
        let leaf = sanitizeMediaFilename(originalName, key);
        if (seen.has(leaf)) leaf = `${key}-${leaf}`;
        seen.add(leaf);
        await this.assetVault.importAsset({
          owningElementId: deckId,
          kind,
          mime,
          source: Readable.from(Buffer.from(bytes)),
          destRelativePath: `sources/${deckId}/media/${leaf}`,
        });
      } catch {
        // Best-effort per file — the bytes are still preserved in the retained .apkg.
      }
    }
  }

  /**
   * Author ONE card element from a normalized Anki note, on an EXISTING transaction:
   * the card element + its `cards` row (+ `source_uri`) + a `review_states` row seeded
   * from the Anki scheduling when present, the imported tags, and lineage to the deck
   * source. Returns whether scheduling history was carried.
   */
  private authorCard(
    tx: DbClient,
    deckId: ElementId,
    note: AnkiNoteRecord,
    priority: number,
    deckName: string,
  ): { withHistory: boolean } {
    const cloze = note.kind === "cloze" && note.cloze ? canonicalizeCloze(note.cloze) : null;
    const title = titleFromNote(note);
    // The source ref carried into `cards.source_uri` — the Anki `Source` field
    // (a custom field some decks add) if present, else the deck name. So attribution
    // round-trips back OUT to Anki on a re-export.
    const sourceUri = ankiSourceField(note) ?? `Anki deck: ${deckName}`;

    const seed = note.scheduling ? schedulingToSeed(note.scheduling) : null;

    // NOTE: we do NOT pass `stage` here. The seam owns activation: a seeded card (real
    // history) and a freshly first-scheduled card both default to `card_draft` and are
    // promoted to active_card/active by `createCardWithin`, so an imported card lands in
    // the deck as "active" (Library facet) rather than parked "pending". Passing
    // stage:"active_card" explicitly would sidestep that activation path.
    const { element } = this.review.createCardWithin(tx, {
      kind: note.kind,
      title,
      priority,
      prompt: note.kind === "qa" ? (note.prompt ?? "") : null,
      answer: note.kind === "qa" ? (note.answer ?? "") : null,
      cloze,
      parentId: deckId,
      sourceId: deckId,
      sourceUri,
      ...(seed ? { reviewSeed: seed } : { firstScheduledAt: new Date().toISOString() }),
    });

    // Inherit the note's Anki tags (skip the interleave provenance tags on re-import).
    for (const tag of note.tags) {
      if (tag.startsWith("interleave::source::")) continue;
      this.elements.addTagWithin(tx, element.id, tag);
    }

    return { withHistory: seed != null };
  }
}

/**
 * Map an Anki SM-2 scheduling record to an FSRS-state seed — the HONEST approximation
 * (see the file header). `reps`/`lapses`/`dueAt` are carried; `stability` ≈ interval;
 * `difficulty` from the ease factor. A never-graduated card (interval ≤ 0, in learning)
 * seeds a small stability + a `learning` phase.
 */
export function schedulingToSeed(s: AnkiScheduling): ReviewStateSeed {
  // Anki `ivl` is days when positive; negative values are seconds (pre-graduation).
  const intervalDays = s.interval > 0 ? s.interval : Math.max(0, Math.ceil(-s.interval / 86400));
  const graduated = s.interval > 0 && s.reps > 0;

  // FSRS stability ≈ "days until ~90% retrievability" — a stable Anki interval is a
  // reasonable proxy. A learning card seeds a small positive stability.
  const stability = graduated ? Math.max(1, intervalDays) : 0.5;

  // Anki ease factor is permille (2500 = 250%). Higher ease ⇒ easier ⇒ lower
  // difficulty. Map [1300, 3500] ease → difficulty [10, 1] (FSRS difficulty 1..10),
  // clamped. A neutral 5 when ease is unavailable.
  const difficulty = s.ease > 0 ? easeToDifficulty(s.ease) : 5;

  // Preserve the next-due date. Anki `cards.due` is ambiguous (day number vs epoch)
  // by queue/type, so we DON'T trust it for an absolute date; instead we place the
  // card `intervalDays` from now (a graduated card with interval N is due in ~N days).
  const dueAt =
    graduated && intervalDays > 0
      ? addDays(new Date().toISOString(), intervalDays)
      : new Date().toISOString(); // a learning / fresh card is due now.

  const fsrsState: FsrsState = graduated ? "review" : "learning";

  return {
    reps: Math.max(0, s.reps),
    lapses: Math.max(0, s.lapses),
    stability,
    difficulty,
    scheduledDays: graduated ? intervalDays : 0,
    fsrsState,
    dueAt,
  };
}

/** Map an Anki ease factor (permille) to an FSRS difficulty (1 easy … 10 hard). */
function easeToDifficulty(ease: number): number {
  // Clamp ease to the typical [1300, 3500] band, then linearly invert to [10, 1].
  const clamped = Math.min(3500, Math.max(1300, ease));
  const t = (clamped - 1300) / (3500 - 1300); // 0 (hard) … 1 (easy)
  const difficulty = 10 - t * 9; // 10 … 1
  return Math.round(difficulty * 100) / 100;
}

/** The recognized media extensions → `{ mime, AssetKind }`. Unknown ⇒ `kind: null`. */
const MEDIA_TYPES: Record<string, { mime: string; kind: AssetKind }> = {
  png: { mime: "image/png", kind: "image" },
  jpg: { mime: "image/jpeg", kind: "image" },
  jpeg: { mime: "image/jpeg", kind: "image" },
  gif: { mime: "image/gif", kind: "image" },
  webp: { mime: "image/webp", kind: "image" },
  svg: { mime: "image/svg+xml", kind: "image" },
  bmp: { mime: "image/bmp", kind: "image" },
  mp3: { mime: "audio/mpeg", kind: "audio" },
  ogg: { mime: "audio/ogg", kind: "audio" },
  oga: { mime: "audio/ogg", kind: "audio" },
  wav: { mime: "audio/wav", kind: "audio" },
  m4a: { mime: "audio/mp4", kind: "audio" },
  flac: { mime: "audio/flac", kind: "audio" },
  mp4: { mime: "video/mp4", kind: "video" },
  webm: { mime: "video/webm", kind: "video" },
  mov: { mime: "video/quicktime", kind: "video" },
};

/** Classify a media filename by extension → `{ mime, kind }`; unknown ⇒ `kind: null`. */
function mediaTypeForFilename(filename: string): { mime: string; kind: AssetKind | null } {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const hit = MEDIA_TYPES[ext];
  return hit
    ? { mime: hit.mime, kind: hit.kind }
    : { mime: "application/octet-stream", kind: null };
}

/** A vault-safe leaf filename from an Anki media name, falling back to the archive key. */
function sanitizeMediaFilename(name: string, fallbackKey: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").trim();
  return cleaned.length > 0 ? cleaned : `media-${fallbackKey}`;
}

/** The deck name from the `.apkg` filename stem (Anki deck names aren't in the file). */
function deriveDeckName(absPath: string): string {
  const base = absPath.split(/[\\/]/).pop() ?? absPath;
  const stem = base.replace(/\.apkg$/i, "").trim();
  return stem.length > 0 ? stem : "Untitled deck";
}

/** A compact card title derived from the note's prompt / cloze / first field. */
function titleFromNote(note: AnkiNoteRecord): string {
  const raw =
    note.kind === "cloze"
      ? (note.cloze ?? note.fields[0] ?? "")
      : (note.prompt ?? note.fields[0] ?? "");
  const flat = raw
    .replace(/\{\{c\d+::([^}:]*?)(::[^}]*)?\}\}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length === 0) return note.kind === "cloze" ? "Cloze card" : "Q&A card";
  return flat.length > 80 ? `${flat.slice(0, 77).trimEnd()}…` : flat;
}

/**
 * The Anki `Source` field's value, if the note's model carried one. Decks exported
 * FROM Interleave put the source ref in a `Source` field (the LAST field). We detect
 * it heuristically: a non-empty last field that looks like a source ref (contains a
 * URL, a "Page"/"Location" label, or our own attribution). Returns null otherwise.
 */
function ankiSourceField(note: AnkiNoteRecord): string | null {
  const last = note.fields[note.fields.length - 1];
  if (!last || last.trim().length === 0) return null;
  // Avoid misreading a 2-field Basic note's answer as a source ref: only treat the
  // last field as a source when there are ≥3 fields (our export adds a 3rd `Source`).
  if (note.fields.length < 3) return null;
  return last.trim();
}
