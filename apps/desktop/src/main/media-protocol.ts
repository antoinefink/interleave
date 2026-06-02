/**
 * Privileged `media://` protocol (T073) — streams a local media source's original
 * bytes from the asset vault to the renderer's `<video>`/`<audio>` element WITH HTTP
 * Range support, so a multi-hundred-MB video seeks without buffering the whole file
 * over IPC (the capped single-ArrayBuffer path `getPdfData` uses would not scale to
 * video).
 *
 * The URL is `media://<elementId>` — the renderer passes ONLY an element id; MAIN
 * resolves it to the source's `sources.snapshotKey` (`sources/<id>/original.<ext>`)
 * under `assetsDir`. There is no path in the URL, so path traversal is impossible: a
 * non-media / unknown element resolves to no file → a 404. The scheme is registered
 * as `secure` + `stream` so the media element can issue Range requests.
 *
 * The renderer NEVER receives a vault path and NEVER reads bytes over a generic
 * channel — main owns the path; the protocol streams. A YouTube source has no local
 * bytes (it plays via the IFrame embed), so it is never served here.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import type { DbService } from "./db-service";

/** The custom scheme used to play local media (`media://<elementId>`). */
export const MEDIA_SCHEME = "media";

/**
 * Register the scheme as privileged. MUST be called before `app.whenReady()`
 * (Electron requirement for `secure`/`stream` schemes). `standard: false` keeps the
 * host == the element id (a standard scheme would lowercase/normalize the host).
 */
export function registerMediaSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { secure: true, stream: true, supportFetchAPI: true, bypassCSP: false },
    },
  ]);
}

/** Parse the element id out of a `media://<elementId>` URL. */
function parseElementId(rawUrl: string): string | null {
  // Custom non-standard scheme → the id is the URL's "host" + (rarely) pathname.
  // Normalize: strip `media://`, then take everything up to a `/` or `?`.
  const withoutScheme = rawUrl.replace(/^media:\/\//i, "");
  const id = decodeURIComponent(withoutScheme.split(/[/?#]/)[0] ?? "").trim();
  return id.length > 0 ? id : null;
}

/**
 * Install the `media://` handler that streams a media source's vault bytes WITH
 * Range support. Resolves the element id → its `snapshotKey` → the absolute vault
 * path; a missing source / snapshot / file → a 404 (never an exception bubbling out
 * of the handler).
 */
export function registerMediaProtocol(dbService: DbService, assetsDir: string): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const elementId = parseElementId(request.url);
    if (!elementId) return new Response("Bad media id", { status: 400 });

    // Resolve the source's snapshot key (the original media path) main-side.
    const provenance = dbService.repos.sources.findById(elementId as never)?.source ?? null;
    const snapshotKey = provenance?.snapshotKey ?? null;
    const mediaKind = provenance?.mediaKind ?? null;
    // Only LOCAL media (video/audio) is served — a YouTube source has no vault bytes.
    if (!snapshotKey || (mediaKind !== "video" && mediaKind !== "audio")) {
      return new Response("Not found", { status: 404 });
    }

    const abs = path.join(assetsDir, ...snapshotKey.split("/"));
    let size: number;
    try {
      size = (await stat(abs)).size;
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const mime = guessMime(snapshotKey, mediaKind);
    const rangeHeader = request.headers.get("range");
    const range = rangeHeader ? parseRange(rangeHeader, size) : null;

    if (range) {
      const { start, end } = range;
      const stream = createReadStream(abs, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          "Content-Type": mime,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }

    const stream = createReadStream(abs);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      },
    });
  });
}

/** Parse a single `bytes=start-end` Range header against the file size, or `null`. */
function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1];
  const endRaw = match[2];
  let start: number;
  let end: number;
  if (startRaw === "") {
    // Suffix range `bytes=-N` → the last N bytes.
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

/** Best-effort MIME from a snapshot path's extension (falls back per kind). */
function guessMime(snapshotKey: string, kind: "video" | "audio"): string {
  const ext = path.extname(snapshotKey).replace(/^\./, "").toLowerCase();
  const map: Record<string, string> = {
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
  return map[ext] ?? (kind === "video" ? "video/mp4" : "audio/mpeg");
}
