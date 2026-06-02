/**
 * MediaImportService (T073) — the local-first media-import orchestrator (main side).
 *
 * Mirrors {@link PdfImportService} / {@link EpubImportService}: the ONE place the pure
 * `@interleave/importers` media transforms (transcript parse/map, YouTube fetch), the
 * filesystem asset vault (T059 `AssetVaultService`), and the `local-db` source pipeline
 * are composed for VIDEO/AUDIO import. It runs ENTIRELY in the Electron main process,
 * with two entry points:
 *
 *   - `importFromFile` — a LOCAL media file (`.mp4`/`.webm`/`.mov`/`.m4a`/`.mp3`/`.wav`):
 *     validate the extension + size cap, decide `video` vs `audio`, mint the source id,
 *     STREAM the original bytes into the vault (`sources/<id>/original.<ext>`, content-
 *     hashed; bytes NEVER touch SQLite), parse an optional sidecar `.vtt`/`.srt`
 *     transcript, build the constrained transcript ProseMirror doc, and create an
 *     `inbox` source via `createWithDocument` in one transaction. `sources.media_kind`
 *     = `"video"`/`"audio"`.
 *   - `importFromYouTube` — a YouTube URL: fetch oEmbed metadata + best-effort captions
 *     ON-DEVICE (the bytes are NOT downloaded — the canonical URL is the reference),
 *     build the transcript doc, and create an `inbox` source referencing the watch URL.
 *     `sources.media_kind` = `"youtube"`, `snapshotKey` = `null`.
 *
 * The renderer never reads the file, never fetches the transcript, and never touches the
 * vault — it ships only a path (the picker resolved it main-side) or a URL.
 *
 * ## Ordering + rollback (mirrors PdfImportService)
 *
 * The local-file path creates the source row first (with `snapshotKey` already pointing
 * at the original we are about to stream in), THEN streams the asset keyed by the now-
 * existing source id (`importAsset` opens its own metadata transaction). On ANY failure
 * after the source committed, the source is soft-deleted and the partial `sources/<id>/`
 * dir is best-effort removed — no orphan inbox row, no orphan files. The YouTube path
 * has NO vault stream (one transaction, no asset step).
 */

import { rmSync, statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type ElementId,
  type MediaKind,
  type PlainTextConversion,
  type PriorityLabel,
  priorityFromLabel,
} from "@interleave/core";
import type { InterleaveDatabase } from "@interleave/db";
import {
  type FetchLike,
  fetchYouTubeMetadata,
  MEDIA_PROBE_BYTES,
  parseTranscript,
  probeMediaDurationMs,
  type TranscriptCue,
  transcriptToProseMirrorDoc,
  YouTubeImportError,
} from "@interleave/importers";
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
export type MediaImportErrorCode = "not_media" | "too_large" | "unreadable" | "youtube_unavailable";

/** A typed media-import failure carrying a `code` the IPC layer maps to a friendly line. */
export class MediaImportError extends Error {
  readonly code: MediaImportErrorCode;
  constructor(code: MediaImportErrorCode, message: string) {
    super(message);
    this.name = "MediaImportError";
    this.code = code;
  }
}

/** Hard cap so a hostile media file cannot exhaust the disk in one import. */
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/** The video file extensions accepted by the local-file path. */
const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "mkv", "m4v", "ogv"]);
/** The audio file extensions accepted by the local-file path. */
const AUDIO_EXTS = new Set(["m4a", "mp3", "wav", "aac", "oga", "ogg", "flac", "opus"]);

/** Best-effort MIME by extension for the `<video>`/`<audio>` element. */
const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  m4v: "video/mp4",
  ogv: "video/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  flac: "audio/flac",
  opus: "audio/opus",
};

/** Constructor dependencies (injected once; mirroring `PdfImportService`). */
export interface MediaImportServiceDeps {
  /** The open Drizzle database (accepted for symmetry; createWithDocument opens its own tx). */
  readonly db: InterleaveDatabase;
  /** The repository bag bound to the same DB. */
  readonly repositories: Repositories;
  /** The asset-vault root (`<dataDir>/assets`). */
  readonly assetsDir: string;
  /** The T059 streamed asset importer (the original media goes through it). */
  readonly assetVault: AssetVaultService;
  /**
   * The fetch implementation for YouTube (defaults to the Node global `fetch`).
   * Injectable so the service test can mock the network without a live server —
   * the caller passes `UrlImportService`'s `fetchImpl`.
   */
  readonly fetchImpl?: FetchLike;
}

/** Arguments to {@link MediaImportService.importFromFile}. */
export interface ImportMediaFromFileInput {
  /** ABSOLUTE path to the chosen media file (resolved by the MAIN file picker). */
  readonly filePath: string;
  /** Optional ABSOLUTE path to a sidecar `.vtt`/`.srt` transcript. */
  readonly subtitlesPath?: string | null;
  /** Explicit title override; else the filename stem. */
  readonly title?: string | null;
  /** Coarse A/B/C/D priority; defaults `C` so new material never dominates. */
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
}

/** Arguments to {@link MediaImportService.importFromYouTube}. */
export interface ImportMediaFromYouTubeInput {
  readonly url: string;
  readonly priority?: PriorityLabel;
  readonly reasonAdded?: string | null;
}

/** The successful import result. */
export interface MediaImportResult {
  readonly id: string;
  readonly item: InboxItemSummary;
  /** `"video"`/`"audio"` (local file) or `"youtube"`. */
  readonly mediaKind: MediaKind;
  /** Whether a transcript body was produced (vs the placeholder). */
  readonly hasTranscript: boolean;
}

export class MediaImportService {
  private readonly sources: SourceRepository;
  private readonly elements: ElementRepository;
  private readonly inbox: InboxQuery;
  private readonly assetsDir: string;
  private readonly assetVault: AssetVaultService;
  private readonly fetchImpl: FetchLike;

  constructor(deps: MediaImportServiceDeps) {
    this.sources = deps.repositories.sources;
    this.elements = deps.repositories.elements;
    this.inbox = new InboxQuery(deps.repositories);
    this.assetsDir = deps.assetsDir;
    this.assetVault = deps.assetVault;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /**
   * Import a LOCAL media file as an inbox `source`. See the file header for the
   * ordering + rollback contract. Throws a typed {@link MediaImportError} on a
   * non-media / oversize / unreadable file (nothing is persisted; any partial vault
   * dir is removed).
   */
  async importFromFile(input: ImportMediaFromFileInput): Promise<MediaImportResult> {
    const filePath = input.filePath;
    const ext = fileExt(filePath);
    const kind: "video" | "audio" | null = VIDEO_EXTS.has(ext)
      ? "video"
      : AUDIO_EXTS.has(ext)
        ? "audio"
        : null;
    if (!kind) {
      throw new MediaImportError("not_media", "That file is not a supported video or audio file.");
    }

    // 1. Size cap (a cheap stat before touching the bytes).
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      throw new MediaImportError("unreadable", "The media file could not be read.");
    }
    if (size > MAX_MEDIA_BYTES) {
      throw new MediaImportError(
        "too_large",
        `The media file is larger than the ${Math.round(
          MAX_MEDIA_BYTES / (1024 * 1024 * 1024),
        )} GB import limit.`,
      );
    }

    // 2. Read ONLY the header bytes for the duration probe (never the whole file —
    //    `importAsset` streams the bytes into the vault separately).
    let durationMs: number | null = null;
    try {
      const head = await readHead(filePath, MEDIA_PROBE_BYTES);
      durationMs = probeMediaDurationMs(head);
    } catch {
      throw new MediaImportError("unreadable", "The media file could not be read.");
    }

    // 3. Parse the optional sidecar transcript (best-effort; a bad sidecar → no transcript).
    let cues: TranscriptCue[] = [];
    if (input.subtitlesPath) {
      try {
        const subText = await readFile(input.subtitlesPath, "utf-8");
        cues = parseTranscript(subText, "auto");
      } catch {
        cues = [];
      }
    }

    // 4. Mint the source id up front so the vault path is known before the row.
    const sourceId = newElementId() as ElementId;
    const snapshotRel = `sources/${sourceId}/original.${ext}`;
    const sourceDir = path.join(this.assetsDir, "sources", sourceId);
    const mime = MIME_BY_EXT[ext] ?? (kind === "video" ? "video/mp4" : "audio/mpeg");

    // 5. Build the constrained transcript doc (pure transform).
    const title =
      nonEmpty(input.title) ??
      nonEmpty(filenameStem(filePath)) ??
      (kind === "video" ? "Video" : "Audio");
    const conversion: PlainTextConversion = transcriptToProseMirrorDoc({ title, cues });

    let sourceCommitted = false;
    try {
      // 6. Create the source + its body in ONE transaction. `snapshotKey` already
      //    points at the media we are about to stream in (step 7); `media_kind` is
      //    the authoritative discriminator.
      this.sources.createWithDocument({
        id: sourceId,
        title,
        priority: priorityFromLabel(input.priority ?? "C"),
        status: "inbox",
        stage: "raw_source",
        accessedAt: new Date().toISOString(),
        snapshotKey: snapshotRel,
        reasonAdded: nonEmpty(input.reasonAdded ?? null),
        mediaKind: kind,
        conversion,
      });
      sourceCommitted = true;

      // 7. Stream the original media into the vault keyed by the now-existing source
      //    (its own metadata transaction; bytes never touch SQLite). The absolute
      //    path makes `importAsset` `createReadStream` it (no whole-file buffer).
      await this.assetVault.importAsset({
        owningElementId: sourceId,
        kind,
        source: filePath,
        mime,
        destRelativePath: snapshotRel,
        durationMs,
      });
    } catch (err) {
      // A partial import must leave NO trace (mirrors PdfImportService).
      if (sourceCommitted) {
        try {
          this.elements.softDelete(sourceId);
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

    return {
      id: sourceId,
      item: this.requireInbox(sourceId),
      mediaKind: kind,
      hasTranscript: cues.length > 0,
    };
  }

  /**
   * Import a YouTube URL as an inbox `source` REFERENCING the canonical watch URL
   * (the bytes are NOT downloaded). Fetches oEmbed metadata + best-effort captions
   * on-device. Throws a typed {@link MediaImportError} (`youtube_unavailable`) only
   * when the oEmbed metadata fetch fails; a missing transcript is the graceful
   * transcript-less path, never a failure.
   */
  async importFromYouTube(input: ImportMediaFromYouTubeInput): Promise<MediaImportResult> {
    let meta: Awaited<ReturnType<typeof fetchYouTubeMetadata>>;
    try {
      meta = await fetchYouTubeMetadata(input.url, this.fetchImpl);
    } catch (err) {
      if (err instanceof YouTubeImportError) {
        throw new MediaImportError(
          err.code === "not_youtube" ? "not_media" : "youtube_unavailable",
          err.message,
        );
      }
      throw new MediaImportError(
        "youtube_unavailable",
        "This YouTube video could not be imported.",
      );
    }

    const cues = meta.transcript ?? [];
    const conversion = transcriptToProseMirrorDoc({ title: meta.title, cues });
    const sourceId = newElementId() as ElementId;

    // No vault stream — a YouTube source has no local bytes (the canonical URL is the
    // reference). One transaction; `media_kind` = "youtube", `snapshotKey` = null.
    this.sources.createWithDocument({
      id: sourceId,
      title: meta.title,
      priority: priorityFromLabel(input.priority ?? "C"),
      status: "inbox",
      stage: "raw_source",
      url: meta.canonicalUrl,
      canonicalUrl: meta.canonicalUrl,
      originalUrl: input.url.trim(),
      author: meta.author,
      accessedAt: new Date().toISOString(),
      snapshotKey: null,
      reasonAdded: nonEmpty(input.reasonAdded ?? null),
      mediaKind: "youtube",
      conversion,
    });

    return {
      id: sourceId,
      item: this.requireInbox(sourceId),
      mediaKind: "youtube",
      hasTranscript: cues.length > 0,
    };
  }

  /** Fetch the fresh inbox summary for a created source (or throw). */
  private requireInbox(sourceId: ElementId): InboxItemSummary {
    const detail = this.inbox.get(sourceId);
    const item = detail?.summary ?? this.inbox.list().find((i) => i.id === sourceId) ?? null;
    if (!item) {
      throw new Error("MediaImportService: created source not found in inbox");
    }
    return item;
  }
}

/** The lowercase file extension (no dot), e.g. `mp4`. */
function fileExt(filePath: string): string {
  return path.extname(filePath).replace(/^\./, "").toLowerCase();
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

/** Read up to `maxBytes` leading bytes of a file (for the duration probe). */
async function readHead(filePath: string, maxBytes: number): Promise<Uint8Array> {
  // Read ONLY the leading header region — reading a multi-hundred-MB media file
  // whole would defeat the streamed-import design (`importAsset` streams the bytes
  // into the vault separately). A bounded `read()` from an open handle keeps the
  // probe O(maxBytes) regardless of the file size.
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } finally {
    await handle.close();
  }
}
