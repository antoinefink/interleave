/**
 * YouTube metadata + transcript fetch (T073) — a pure, on-device, injected-fetch
 * transform. NO server, NO API key, NO video download.
 *
 * It reaches YouTube ONLY through an INJECTED `fetch` (the caller passes
 * `UrlImportService`'s `fetchImpl`, defaulting to the Node global `fetch`), so the
 * module stays pure + testable (the tests pass a recorded fake fetch — no live
 * network). It does NOT import Node `fetch`, `fs`, or Electron — string/URL in,
 * structured {@link YouTubeMeta} out.
 *
 * Two paths, with very different reliability:
 *   - **oEmbed (reliable)** — `https://www.youtube.com/oembed?url=…&format=json` is a
 *     single keyless GET returning `title`/`author_name`/`thumbnail_url` as plain
 *     JSON. A failure here is the ONE hard error: a typed {@link YouTubeImportError}
 *     the importer maps to `youtube_unavailable` (a bad/private/removed video).
 *   - **captions (best-effort)** — there is no stable, documented caption endpoint, so
 *     discovering the `timedtext` URL means GETting the WATCH PAGE and parsing its
 *     `ytInitialPlayerResponse` (`captions.playerCaptionsTracklistRenderer.captionTracks[].baseUrl`)
 *     before a second GET for the caption XML/JSON. YouTube increasingly returns
 *     bot-checks / empty bodies for server-side watch-page fetches, so the WHOLE
 *     caption path is best-effort: a missing player response, an empty body, a missing
 *     track, or a fetch/parse failure ALL resolve to `transcript: null` (the graceful
 *     transcript-less path), NEVER an exception, NEVER a failed import.
 *
 * The load-bearing decision is the graceful transcript-less degrade — not the
 * discovery method (which YouTube may change at any time).
 */

import { parseTranscript, type TranscriptCue } from "./transcript";

/** The metadata + (best-effort) transcript for a YouTube source. */
export interface YouTubeMeta {
  /** The 11-char video id parsed from the URL. */
  readonly videoId: string;
  /** The video title (from oEmbed). */
  readonly title: string;
  /** The channel/author name, or `null`. */
  readonly author: string | null;
  /** The thumbnail URL (from oEmbed), or `null`. */
  readonly thumbnailUrl: string | null;
  /** The canonical watch URL (`https://www.youtube.com/watch?v=<id>`). */
  readonly canonicalUrl: string;
  /** The best-effort transcript cues, or `null` when none could be fetched. */
  readonly transcript: TranscriptCue[] | null;
}

/** The friendly error code the importer maps for a failed YouTube import. */
export type YouTubeImportErrorCode = "youtube_unavailable" | "not_youtube";

/** A typed YouTube-import failure carrying a `code` the importer maps. */
export class YouTubeImportError extends Error {
  readonly code: YouTubeImportErrorCode;
  constructor(code: YouTubeImportErrorCode, message: string) {
    super(message);
    this.name = "YouTubeImportError";
    this.code = code;
  }
}

/** A `fetch`-shaped function (the injected on-device fetch). */
export type FetchLike = typeof fetch;

/**
 * Whether `url` is a YouTube watch / short / youtu.be URL. Accepts the common
 * forms (`youtube.com/watch?v=…`, `youtu.be/…`, `youtube.com/shorts/…`,
 * `m.youtube.com`, `music.youtube.com`, `youtube.com/embed/…`) and rejects anything
 * else. A garbage string returns `false` (never throws).
 */
export function isYouTubeUrl(url: string): boolean {
  return parseYouTubeId(url) !== null;
}

/**
 * Parse the 11-char video id out of a YouTube URL, or `null` when it is not a
 * recognizable YouTube URL. Pure string work (no network).
 */
export function parseYouTubeId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const isYouTubeHost =
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "music.youtube.com" ||
    host === "youtu.be";
  if (!isYouTubeHost) return null;

  // youtu.be/<id>
  if (host === "youtu.be") {
    const id = parsed.pathname.replace(/^\/+/, "").split("/")[0] ?? "";
    return isValidVideoId(id) ? id : null;
  }
  // youtube.com/watch?v=<id>
  const v = parsed.searchParams.get("v");
  if (v && isValidVideoId(v)) return v;
  // youtube.com/shorts/<id> · /embed/<id> · /v/<id>
  const m = parsed.pathname.match(/^\/(?:shorts|embed|v)\/([^/?#]+)/);
  if (m?.[1] && isValidVideoId(m[1])) return m[1];
  return null;
}

/** A YouTube video id is 11 URL-safe base64 chars. */
function isValidVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

/** The canonical watch URL for a video id. */
export function youTubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Fetch a YouTube video's metadata (oEmbed, reliable) + transcript (watch-page
 * discovery → timedtext, best-effort) ON-DEVICE through the injected `fetch`.
 *
 * Throws {@link YouTubeImportError} ONLY when oEmbed fails (`youtube_unavailable`)
 * or the URL is not a YouTube URL (`not_youtube`). A caption discovery/fetch/parse
 * failure is swallowed → `transcript: null`.
 */
export async function fetchYouTubeMetadata(
  url: string,
  fetchImpl: FetchLike,
): Promise<YouTubeMeta> {
  const videoId = parseYouTubeId(url);
  if (!videoId) {
    throw new YouTubeImportError("not_youtube", "That URL is not a YouTube video.");
  }
  const canonicalUrl = youTubeWatchUrl(videoId);

  // --- oEmbed (the reliable metadata GET) ---
  const oembed = await fetchOEmbed(canonicalUrl, fetchImpl);

  // --- captions (best-effort; any failure → null) ---
  let transcript: TranscriptCue[] | null = null;
  try {
    transcript = await fetchBestEffortTranscript(canonicalUrl, fetchImpl);
  } catch {
    transcript = null;
  }

  return {
    videoId,
    title: oembed.title,
    author: oembed.author,
    thumbnailUrl: oembed.thumbnailUrl,
    canonicalUrl,
    transcript,
  };
}

/** The reliable oEmbed metadata (title/author/thumbnail). */
interface OEmbedResult {
  readonly title: string;
  readonly author: string | null;
  readonly thumbnailUrl: string | null;
}

/** GET the oEmbed JSON; a non-OK / non-JSON / missing-title body throws. */
async function fetchOEmbed(watchUrl: string, fetchImpl: FetchLike): Promise<OEmbedResult> {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    watchUrl,
  )}&format=json`;
  let response: Response;
  try {
    response = await fetchImpl(oembedUrl);
  } catch (err) {
    throw new YouTubeImportError(
      "youtube_unavailable",
      `Could not reach YouTube: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    throw new YouTubeImportError(
      "youtube_unavailable",
      "This YouTube video is unavailable (private, removed, or region-locked).",
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new YouTubeImportError("youtube_unavailable", "YouTube returned an unexpected response.");
  }
  const obj = (json ?? {}) as Record<string, unknown>;
  const title =
    typeof obj.title === "string" && obj.title.trim().length > 0 ? obj.title.trim() : "";
  if (!title) {
    throw new YouTubeImportError("youtube_unavailable", "This YouTube video has no title.");
  }
  return {
    title,
    author: typeof obj.author_name === "string" ? obj.author_name : null,
    thumbnailUrl: typeof obj.thumbnail_url === "string" ? obj.thumbnail_url : null,
  };
}

/**
 * Best-effort transcript: GET the watch page → parse `ytInitialPlayerResponse` →
 * pick a caption track `baseUrl` → GET the timedtext → parse to cues. Returns
 * `null` (NEVER throws) when any step yields nothing.
 */
async function fetchBestEffortTranscript(
  watchUrl: string,
  fetchImpl: FetchLike,
): Promise<TranscriptCue[] | null> {
  let watchHtml: string;
  try {
    const res = await fetchImpl(watchUrl);
    if (!res.ok) return null;
    watchHtml = await res.text();
  } catch {
    return null;
  }
  const baseUrl = discoverCaptionTrackUrl(watchHtml);
  if (!baseUrl) return null;

  // Prefer VTT (subsrt-ts reads it natively); the timedtext endpoint serves VTT
  // when `&fmt=vtt` is appended.
  const vttUrl = appendFormat(baseUrl, "vtt");
  let captionText: string;
  try {
    const res = await fetchImpl(vttUrl);
    if (!res.ok) return null;
    captionText = await res.text();
  } catch {
    return null;
  }
  if (captionText.trim().length === 0) return null;

  const cues = parseTranscript(captionText, "auto");
  return cues.length > 0 ? cues : null;
}

/**
 * Parse the watch-page HTML for the first caption track's `baseUrl`. Extracts the
 * `ytInitialPlayerResponse` JSON blob and reads
 * `captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl`. Returns
 * `null` when the blob/track is absent (a bot-check page, captions disabled, etc.).
 *
 * Exported for the unit test (it is the fragile, YouTube-shaped step worth pinning).
 */
export function discoverCaptionTrackUrl(watchHtml: string): string | null {
  const player = extractPlayerResponse(watchHtml);
  if (!player) return null;
  const captions = (player as Record<string, unknown>).captions as
    | Record<string, unknown>
    | undefined;
  const renderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const tracks = renderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  // Prefer a non-auto-generated (manual) track if present, else the first.
  const manual = tracks.find(
    (t) =>
      (t as Record<string, unknown>).kind !== "asr" &&
      typeof (t as Record<string, unknown>).baseUrl === "string",
  ) as Record<string, unknown> | undefined;
  const chosen = manual ?? (tracks[0] as Record<string, unknown>);
  const baseUrl = chosen?.baseUrl;
  return typeof baseUrl === "string" && baseUrl.length > 0 ? baseUrl : null;
}

/**
 * Extract the `ytInitialPlayerResponse = {…};` JSON object from watch-page HTML by
 * brace-matching from the `{` after the assignment. Returns the parsed object or
 * `null`. Tolerant of either `var ytInitialPlayerResponse =` or
 * `ytInitialPlayerResponse =` (with/without `var`/`window.`).
 */
function extractPlayerResponse(html: string): unknown {
  const marker = /ytInitialPlayerResponse\s*=\s*/;
  const match = marker.exec(html);
  if (!match) return null;
  const start = html.indexOf("{", match.index + match[0].length);
  if (start < 0) return null;

  // Brace-match, respecting strings + escapes, to find the object's end.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const json = html.slice(start, i + 1);
        try {
          return JSON.parse(json);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Append/replace a `fmt` query param on a timedtext URL. */
function appendFormat(baseUrl: string, fmt: string): string {
  try {
    const u = new URL(baseUrl);
    u.searchParams.set("fmt", fmt);
    return u.toString();
  } catch {
    // A relative or odd URL — fall back to a naive append.
    const sep = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${sep}fmt=${fmt}`;
  }
}
