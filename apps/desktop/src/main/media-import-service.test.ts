/**
 * MediaImportService integration tests (T073) — against a real temp-file SQLite DB +
 * a temp `assetsDir`, pointing `importFromFile` at the tiny committed fixture media
 * files (`@interleave/importers/src/__fixtures__/transcript/`) + a `.vtt` sidecar, and
 * `importFromYouTube` at an INJECTED FAKE FETCH (no live network). No Electron is
 * involved — the service is constructed through `DbService` (the same accessor the IPC
 * layer uses); the YouTube fetch is injected via `open({ mediaFetchImpl })`.
 *
 * Proves:
 *  - a successful local import writes `sources/<id>/original.<ext>` under the vault,
 *    records a `video`/`audio` asset whose contentHash matches the file + `durationMs`
 *    set, creates an `inbox` source whose `sources.media_kind` is `"video"`/`"audio"`
 *    and whose body parses to the transcript heading/paragraphs with per-block
 *    timestamps, and appends `create_source` + `update_document` ops; `documents.get`
 *    reports `sourceFormat: "video"` + `mediaSource: "local"`;
 *  - a YouTube import (fake fetch) creates an `inbox` source with the canonical
 *    YouTube URL, `sources.media_kind = "youtube"` (so `documents.get` reports
 *    `mediaSource: "youtube"`), the transcript body, and NO vault asset;
 *  - restart-persistence: re-opening the DB on the same file keeps the source +
 *    provenance + transcript body + timestamp-tagged blocks + the media asset, and
 *    `original.<ext>` still exists on disk;
 *  - error paths: a non-media / unreadable file throws the typed `MediaImportError`
 *    with the right code (clean rollback, no source row, no partial vault dir); a
 *    YouTube import whose oEmbed fails throws `youtube_unavailable`.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MIGRATIONS_DIR } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DbService } from "./db-service";
import { MediaImportError } from "./media-import-service";

const FIXTURES = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "importers",
  "src",
  "__fixtures__",
);
const TRANSCRIPT_FIXTURES = path.join(FIXTURES, "transcript");
const YT_FIXTURES = path.join(FIXTURES, "youtube");
const TINY_VIDEO = path.join(TRANSCRIPT_FIXTURES, "tiny-video.mp4");
const TINY_AUDIO = path.join(TRANSCRIPT_FIXTURES, "tiny-audio.mp3");
const TINY_VTT = path.join(TRANSCRIPT_FIXTURES, "tiny-video.vtt");

const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

let dir: string;
let dbPath: string;
let assetsDir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "interleave-mediaimp-"));
  dbPath = path.join(dir, "app.sqlite");
  assetsDir = path.join(dir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Open a DbService (optionally with a fake YouTube fetch) on the temp DB + vault. */
function openSvc(mediaFetchImpl?: typeof fetch): DbService {
  const svc = new DbService();
  svc.open(dbPath, {
    migrationsDir: MIGRATIONS_DIR,
    assetsDir,
    ...(mediaFetchImpl ? { mediaFetchImpl } : {}),
  });
  return svc;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** A fake fetch built from the recorded YouTube fixtures (no live network). */
function youtubeFakeFetch(opts: { oembedStatus?: number } = {}): typeof fetch {
  const oembed = fs.readFileSync(path.join(YT_FIXTURES, "oembed.json"), "utf-8");
  const watch = fs.readFileSync(path.join(YT_FIXTURES, "watch.html"), "utf-8");
  const timedtext = fs.readFileSync(path.join(YT_FIXTURES, "timedtext.vtt"), "utf-8");
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("oembed")) {
      return new Response(opts.oembedStatus === 404 ? "" : oembed, {
        status: opts.oembedStatus ?? 200,
      });
    }
    if (url.includes("timedtext")) return new Response(timedtext, { status: 200 });
    if (url.includes("/watch")) return new Response(watch, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("MediaImportService.importFromFile (local video + sidecar transcript)", () => {
  it("imports a tiny video + .vtt into an inbox source with a vault asset + timestamp body", async () => {
    const svc = openSvc();
    const result = await svc.mediaImportService.importFromFile({
      filePath: TINY_VIDEO,
      subtitlesPath: TINY_VTT,
    });
    const { id, item, mediaKind, hasTranscript } = result;

    expect(item.status).toBe("inbox");
    expect(item.type).toBe("source");
    expect(mediaKind).toBe("video");
    expect(hasTranscript).toBe(true);

    // The original media lives in the vault.
    const mediaAbs = path.join(assetsDir, "sources", id, "original.mp4");
    expect(fs.existsSync(mediaAbs)).toBe(true);

    // A `video` asset whose contentHash matches the file + durationMs set.
    const assets = svc.repos.assets.listForElement(id as never);
    const videoAsset = assets.find((a) => a.kind === "video");
    expect(videoAsset).toBeDefined();
    expect(videoAsset?.contentHash).toBe(sha256File(TINY_VIDEO));
    expect(videoAsset?.durationMs).toBeGreaterThan(0);

    // The provenance carries media_kind = "video"; the body has timestamp-tagged cues.
    const source = svc.repos.sources.findById(id as never);
    expect(source?.source.mediaKind).toBe("video");
    expect(source?.source.snapshotKey).toBe(`sources/${id}/original.mp4`);
    const blocks = svc.repos.documents.listBlocks(id as never);
    expect(blocks[0]?.blockType).toBe("heading");
    const cueBlocks = blocks.filter((b) => typeof b.timestampMs === "number");
    expect(cueBlocks.length).toBe(2); // two cues in the sidecar
    expect(cueBlocks[0]?.timestampMs).toBe(0);

    // The ops log carries create_source + update_document.
    const ops = svc.repos.operationLog.listForElement(id as never).map((o) => o.opType);
    expect(ops).toContain("create_source");
    expect(ops).toContain("update_document");

    // documents.get reports the media format + local source.
    const doc = svc.getDocument({ elementId: id });
    expect(doc.sourceFormat).toBe("video");
    expect(doc.mediaSource).toBe("local");
    expect(doc.mediaKind).toBe("video");
    expect(Object.keys(doc.blockTimestamps).length).toBe(2);

    // getMediaData returns the privileged media:// URL + mime + duration.
    const media = await svc.getMediaData({ elementId: id });
    expect(media.mediaSource).toBe("local");
    expect(media.mediaUrl).toBe(`media://${id}`);
    expect(media.mime).toContain("video");
    expect(media.durationMs).toBeGreaterThan(0);

    svc.close();
  });

  it("imports a transcript-less audio file (placeholder body, no crash)", async () => {
    const svc = openSvc();
    const { id, mediaKind, hasTranscript } = await svc.mediaImportService.importFromFile({
      filePath: TINY_AUDIO,
    });
    expect(mediaKind).toBe("audio");
    expect(hasTranscript).toBe(false);

    const source = svc.repos.sources.findById(id as never);
    expect(source?.source.mediaKind).toBe("audio");
    // The body is the title heading + ONE placeholder paragraph (no cue timestamps).
    const blocks = svc.repos.documents.listBlocks(id as never);
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.timestampMs === null)).toBe(true);

    const media = await svc.getMediaData({ elementId: id });
    expect(media.mediaSource).toBe("local");
    expect(media.mediaKind).toBe("audio");

    svc.close();
  });

  it("survives an app restart (re-open the DB on the same file)", async () => {
    let svc = openSvc();
    const { id } = await svc.mediaImportService.importFromFile({
      filePath: TINY_VIDEO,
      subtitlesPath: TINY_VTT,
    });
    svc.close();

    // Re-open on the same file (a fresh DbService → fresh repositories).
    svc = openSvc();
    const source = svc.repos.sources.findById(id as never);
    expect(source?.source.mediaKind).toBe("video");
    const blocks = svc.repos.documents.listBlocks(id as never);
    expect(blocks.filter((b) => typeof b.timestampMs === "number").length).toBe(2);
    const assets = svc.repos.assets.listForElement(id as never);
    expect(assets.some((a) => a.kind === "video")).toBe(true);
    // The original file still exists on disk.
    expect(fs.existsSync(path.join(assetsDir, "sources", id, "original.mp4"))).toBe(true);
    svc.close();
  });

  it("rejects a non-media file with a typed error + no source row / vault dir", async () => {
    const svc = openSvc();
    const notMedia = path.join(dir, "notes.txt");
    fs.writeFileSync(notMedia, "just some text");
    const before = svc.listInbox().items.length;
    await expect(
      svc.mediaImportService.importFromFile({ filePath: notMedia }),
    ).rejects.toBeInstanceOf(MediaImportError);
    await expect(
      svc.mediaImportService.importFromFile({ filePath: notMedia }),
    ).rejects.toMatchObject({ code: "not_media" });
    // No source row was created and no `sources/` vault dir leaked.
    expect(svc.listInbox().items.length).toBe(before);
    const sourcesDir = path.join(assetsDir, "sources");
    const entries = fs.existsSync(sourcesDir) ? fs.readdirSync(sourcesDir) : [];
    expect(entries).toHaveLength(0);
    svc.close();
  });

  it("rejects an unreadable (missing) file with the unreadable code", async () => {
    const svc = openSvc();
    await expect(
      svc.mediaImportService.importFromFile({ filePath: path.join(dir, "ghost.mp4") }),
    ).rejects.toMatchObject({ code: "unreadable" });
    svc.close();
  });
});

describe("MediaImportService.importFromYouTube (fake fetch)", () => {
  it("creates an inbox source referencing the canonical URL with a transcript + NO vault asset", async () => {
    const svc = openSvc(youtubeFakeFetch());
    const { id, mediaKind, hasTranscript } = await svc.mediaImportService.importFromYouTube({
      url: YT_URL,
    });
    expect(mediaKind).toBe("youtube");
    expect(hasTranscript).toBe(true);

    const source = svc.repos.sources.findById(id as never);
    expect(source?.source.mediaKind).toBe("youtube");
    expect(source?.source.canonicalUrl).toBe(YT_URL);
    expect(source?.source.snapshotKey).toBeNull();
    expect(source?.source.author).toBe("Example Channel");

    // NO vault asset (the bytes are not downloaded).
    expect(svc.repos.assets.listForElement(id as never)).toHaveLength(0);

    // The transcript body has timestamp-tagged cues.
    const blocks = svc.repos.documents.listBlocks(id as never);
    expect(blocks.filter((b) => typeof b.timestampMs === "number").length).toBe(2);

    // documents.get reports the youtube media source; getMediaData returns the id.
    const doc = svc.getDocument({ elementId: id });
    expect(doc.sourceFormat).toBe("video");
    expect(doc.mediaSource).toBe("youtube");
    const data = await svc.getMediaData({ elementId: id });
    expect(data.mediaSource).toBe("youtube");
    expect(data.youtubeId).toBe("dQw4w9WgXcQ");

    svc.close();
  });

  it("throws youtube_unavailable when oEmbed fails", async () => {
    const svc = openSvc(youtubeFakeFetch({ oembedStatus: 404 }));
    const before = svc.listInbox().items.length;
    await expect(svc.mediaImportService.importFromYouTube({ url: YT_URL })).rejects.toMatchObject({
      code: "youtube_unavailable",
    });
    expect(svc.listInbox().items.length).toBe(before);
    svc.close();
  });
});
