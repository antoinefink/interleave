/**
 * Unit tests for the YouTube metadata + transcript fetch (T073), against the
 * recorded oEmbed/watch-page/timedtext fixtures under `src/__fixtures__/youtube/`,
 * with an INJECTED FAKE FETCH (no live network).
 *
 * Proves: a normal video → title/author + transcript cues; captions disabled →
 * `transcript: null` (graceful); oEmbed 404 → throws `YouTubeImportError`;
 * `isYouTubeUrl`/`parseYouTubeId` accept the common forms and reject a non-YouTube
 * URL; `discoverCaptionTrackUrl` reads the watch page's player response.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  discoverCaptionTrackUrl,
  type FetchLike,
  fetchYouTubeMetadata,
  isYouTubeUrl,
  parseYouTubeId,
  YouTubeImportError,
} from "./youtube";

const here = path.dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): string {
  return readFileSync(path.join(here, "__fixtures__", "youtube", name), "utf-8");
}

const OEMBED = readFixture("oembed.json");
const WATCH = readFixture("watch.html");
const WATCH_NO_CAPTIONS = readFixture("watch-no-captions.html");
const TIMEDTEXT = readFixture("timedtext.vtt");

const WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

/**
 * Build a fake fetch from a route map. Each route is matched by substring; an
 * unmatched URL → a 404 (so missing routes surface as graceful nulls, not hangs).
 */
function fakeFetch(routes: { match: string; body: string; status?: number }[]): FetchLike {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes.find((r) => url.includes(r.match));
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body, { status: route.status ?? 200 });
  }) as FetchLike;
}

describe("isYouTubeUrl / parseYouTubeId", () => {
  it("accepts watch / youtu.be / shorts / embed forms", () => {
    expect(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe(true);
    expect(isYouTubeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(parseYouTubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")).toBe("dQw4w9WgXcQ");
  });

  it("rejects a non-YouTube URL and garbage", () => {
    expect(isYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBe(false);
    expect(isYouTubeUrl("https://vimeo.com/123")).toBe(false);
    expect(isYouTubeUrl("not a url")).toBe(false);
    expect(parseYouTubeId("https://www.youtube.com/watch?v=short")).toBeNull();
  });
});

describe("discoverCaptionTrackUrl", () => {
  it("reads the first manual caption track baseUrl from the watch page", () => {
    const url = discoverCaptionTrackUrl(WATCH);
    expect(url).toContain("timedtext");
    expect(url).toContain("manual=1"); // prefers the non-asr (manual) track
  });

  it("returns null when the watch page has no captions", () => {
    expect(discoverCaptionTrackUrl(WATCH_NO_CAPTIONS)).toBeNull();
    expect(discoverCaptionTrackUrl("<html>bot check</html>")).toBeNull();
  });
});

describe("fetchYouTubeMetadata", () => {
  it("returns title/author/thumbnail + transcript cues for a normal video", async () => {
    const fetch = fakeFetch([
      { match: "oembed", body: OEMBED },
      { match: "timedtext", body: TIMEDTEXT },
      { match: "/watch", body: WATCH },
    ]);
    const meta = await fetchYouTubeMetadata(WATCH_URL, fetch);
    expect(meta.videoId).toBe("dQw4w9WgXcQ");
    expect(meta.title).toBe("An Example Talk");
    expect(meta.author).toBe("Example Channel");
    expect(meta.thumbnailUrl).toContain("ytimg.com");
    expect(meta.canonicalUrl).toBe(WATCH_URL);
    expect(meta.transcript).not.toBeNull();
    expect(meta.transcript?.map((c) => c.text)).toEqual([
      "Welcome to the talk",
      "Today we discuss spaced repetition",
    ]);
  });

  it("degrades to transcript: null when captions are disabled (graceful)", async () => {
    const fetch = fakeFetch([
      { match: "oembed", body: OEMBED },
      { match: "/watch", body: WATCH_NO_CAPTIONS },
    ]);
    const meta = await fetchYouTubeMetadata(WATCH_URL, fetch);
    expect(meta.title).toBe("An Example Talk");
    expect(meta.transcript).toBeNull();
  });

  it("degrades to transcript: null when the timedtext fetch fails (graceful)", async () => {
    const fetch = fakeFetch([
      { match: "oembed", body: OEMBED },
      { match: "/watch", body: WATCH },
      // timedtext route returns 404 → null, not an exception.
      { match: "timedtext", body: "", status: 404 },
    ]);
    const meta = await fetchYouTubeMetadata(WATCH_URL, fetch);
    expect(meta.transcript).toBeNull();
  });

  it("throws YouTubeImportError when oEmbed 404s (unavailable video)", async () => {
    const fetch = fakeFetch([{ match: "oembed", body: "", status: 404 }]);
    await expect(fetchYouTubeMetadata(WATCH_URL, fetch)).rejects.toBeInstanceOf(YouTubeImportError);
    await expect(fetchYouTubeMetadata(WATCH_URL, fetch)).rejects.toMatchObject({
      code: "youtube_unavailable",
    });
  });

  it("throws not_youtube for a non-YouTube URL", async () => {
    const fetch = fakeFetch([]);
    await expect(
      fetchYouTubeMetadata("https://example.com/watch?v=dQw4w9WgXcQ", fetch),
    ).rejects.toMatchObject({ code: "not_youtube" });
  });
});
