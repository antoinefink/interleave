/**
 * Media-source persistence tests (T073) — the `document_blocks.timestamp_ms` +
 * `sources.media_kind` widenings and the read-point dual-meaning convention, against
 * a fresh in-memory migrated DB.
 *
 * Pins:
 *  - a timestamp-tagged `conversion` stores `document_blocks.timestamp_ms`; an
 *    HTML/text conversion stores `null` (unchanged);
 *  - `sources.media_kind` round-trips (`"video"`/`"audio"`/`"youtube"`, `null` for a
 *    non-media source);
 *  - the read-point dual-meaning round-trip: (a) a transcript-backed media source sets
 *    a read-point on a CUE block id and resumes at that block's `timestamp_ms`; (b) a
 *    transcript-less media source sets the read-point on the TITLE-HEADING block id
 *    with `offset = floor(currentTimeMs)` (the offset-as-seconds convention) and
 *    round-trips that integer back — the title heading's `timestamp_ms` is `null`, so
 *    the resume logic special-cases "offset is seconds, not a char offset".
 */

import type { BlockId, PlainTextConversion } from "@interleave/core";
import { priorityFromLabel } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "./document-repository";
import { newElementId } from "./ids";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb } from "./test-db";

let handle: DbHandle;

beforeEach(() => {
  handle = createInMemoryDb();
});

afterEach(() => {
  handle.sqlite.close();
});

/**
 * Build a transcript-shaped conversion inline (mirrors `transcriptToProseMirrorDoc`
 * from `@interleave/importers`, kept inline here so `local-db` does not depend on the
 * importers package): a title heading (no timestamp) + one cue paragraph each tagged
 * with its `timestampMs`. An empty `cues` → the title + ONE placeholder paragraph.
 */
function buildTranscriptConversion(
  title: string,
  cues: { startMs: number; text: string }[],
): PlainTextConversion {
  const titleId = "mblk-title" as BlockId;
  const content: PlainTextConversion["doc"]["content"][number][] = [
    {
      type: "heading",
      attrs: { level: 2, blockId: titleId },
      content: [{ type: "text", text: title }],
    },
  ];
  const blocks: PlainTextConversion["blocks"][number][] = [
    { blockType: "heading", order: 0, stableBlockId: titleId, timestampMs: null },
  ];
  if (cues.length === 0) {
    const phId = "mblk-ph" as BlockId;
    content.push({
      type: "paragraph",
      attrs: { blockId: phId },
      content: [{ type: "text", text: "No transcript available." }],
    });
    blocks.push({ blockType: "paragraph", order: 1, stableBlockId: phId, timestampMs: null });
  } else {
    cues.forEach((cue, i) => {
      const id = `mblk-cue-${i + 1}` as BlockId;
      content.push({
        type: "paragraph",
        attrs: { blockId: id },
        content: [{ type: "text", text: cue.text }],
      });
      blocks.push({
        blockType: "paragraph",
        order: i + 1,
        stableBlockId: id,
        timestampMs: cue.startMs,
      });
    });
  }
  return { doc: { type: "doc", content }, plainText: title, blocks };
}

describe("document_blocks.timestamp_ms (T073)", () => {
  it("stores per-cue timestamps for a transcript conversion", () => {
    const repo = new SourceRepository(handle.db);
    const conversion = buildTranscriptConversion("A Talk", [
      { startMs: 1000, text: "Hello" },
      { startMs: 4000, text: "World" },
    ]);
    const result = repo.createWithDocument({
      title: "A Talk",
      priority: priorityFromLabel("C"),
      mediaKind: "video",
      conversion,
    });
    const blocks = new DocumentRepository(handle.db).listBlocks(result.element.id);
    // heading (null) + two cue paragraphs (1000, 4000).
    expect(blocks.map((b) => b.timestampMs)).toEqual([null, 1000, 4000]);
  });

  it("stores timestamp_ms = null for a non-media (HTML/text) conversion", () => {
    const repo = new SourceRepository(handle.db);
    const conversion: PlainTextConversion = {
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "p-1" as BlockId },
            content: [{ type: "text", text: "body" }],
          },
        ],
      },
      plainText: "body",
      blocks: [{ blockType: "paragraph", order: 0, stableBlockId: "p-1" as BlockId }],
    };
    const result = repo.createWithDocument({
      title: "Plain source",
      priority: priorityFromLabel("C"),
      conversion,
    });
    const blocks = new DocumentRepository(handle.db).listBlocks(result.element.id);
    expect(blocks.every((b) => b.timestampMs === null)).toBe(true);
  });
});

describe("sources.media_kind (T073)", () => {
  it("round-trips the media discriminator", () => {
    const repo = new SourceRepository(handle.db);
    const video = repo.create({
      title: "Local video",
      priority: priorityFromLabel("C"),
      mediaKind: "video",
    });
    const youtube = repo.create({
      title: "YouTube",
      priority: priorityFromLabel("C"),
      mediaKind: "youtube",
    });
    const plain = repo.create({ title: "Article", priority: priorityFromLabel("C") });

    expect(repo.findById(video.element.id)?.source.mediaKind).toBe("video");
    expect(repo.findById(youtube.element.id)?.source.mediaKind).toBe("youtube");
    expect(repo.findById(plain.element.id)?.source.mediaKind).toBeNull();
  });
});

describe("read-point dual-meaning round-trip (T073)", () => {
  it("(a) a transcript-backed media source resumes at the cue block's timestamp_ms", () => {
    const sources = new SourceRepository(handle.db);
    const docs = new DocumentRepository(handle.db);
    const conversion = buildTranscriptConversion("Lecture", [
      { startMs: 2000, text: "Intro" },
      { startMs: 5000, text: "Main point" },
    ]);
    const id = newElementId();
    sources.createWithDocument({
      id,
      title: "Lecture",
      priority: priorityFromLabel("C"),
      mediaKind: "video",
      conversion,
    });

    // The second cue's block id (the third block — heading, cue1, cue2).
    const blocks = docs.listBlocks(id);
    const cueBlock = blocks[2];
    expect(cueBlock?.timestampMs).toBe(5000);

    // Set the read-point on that cue (offset 0 — the resume keys off the cue's time).
    docs.setReadPoint({
      elementId: id,
      documentId: id,
      blockId: cueBlock?.stableBlockId as BlockId,
      offset: 0,
    });
    const rp = docs.getReadPoint(id);
    expect(rp?.blockId).toBe(cueBlock?.stableBlockId);
    // The resume second is that block's timestamp_ms (not the char offset).
    const resumeBlock = docs.listBlocks(id).find((b) => b.stableBlockId === rp?.blockId);
    expect(resumeBlock?.timestampMs).toBe(5000);
  });

  it("(b) a transcript-less media source stores offset = seconds on the title heading", () => {
    const sources = new SourceRepository(handle.db);
    const docs = new DocumentRepository(handle.db);
    // No cues → the title heading + ONE placeholder paragraph.
    const conversion = buildTranscriptConversion("Silent video", []);
    const id = newElementId();
    sources.createWithDocument({
      id,
      title: "Silent video",
      priority: priorityFromLabel("C"),
      mediaKind: "video",
      conversion,
    });

    const blocks = docs.listBlocks(id);
    const titleBlock = blocks[0];
    expect(titleBlock?.blockType).toBe("heading");
    // The title heading carries NO timestamp (it is `null`) — so the resume MUST use
    // the offset as the raw second, not the (null) timestamp.
    expect(titleBlock?.timestampMs).toBeNull();

    // Set the read-point at the title heading with offset = floor(currentSeconds).
    docs.setReadPoint({
      elementId: id,
      documentId: id,
      blockId: titleBlock?.stableBlockId as BlockId,
      offset: 42, // 42 seconds into the video
    });
    const rp = docs.getReadPoint(id);
    expect(rp?.blockId).toBe(titleBlock?.stableBlockId);
    // The single stored integer round-trips back as the resume second.
    expect(rp?.offset).toBe(42);
  });
});
