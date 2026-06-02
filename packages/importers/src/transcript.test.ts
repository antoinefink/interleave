/**
 * Unit tests for the pure transcript transforms (T073), against the committed
 * `.vtt`/`.srt` fixtures under `src/__fixtures__/transcript/`.
 *
 * Proves `parseTranscript` handles each cue-timing edge case (overlap, no-end /
 * zero-duration dropped, `\r\n`, empty cue dropped, styling stripped, SRT-comma
 * vs VTT-dot ms, BOM) and sorts by `startMs`; and `transcriptToProseMirrorDoc`
 * maps cues to one heading + one paragraph per cue (each block tagged with its
 * `timestampMs`), produces a doc that VALIDATES against `buildSchema()` with every
 * node ∈ `ALLOWED_NODE_NAMES`, gives every row-bearing node a unique stable id, and
 * maps an EMPTY cue list to the title + ONE placeholder paragraph (no crash).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BlockId } from "@interleave/core";
import { ALLOWED_NODE_NAMES, buildSchema } from "@interleave/editor/schema";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "./transcript";
import { NO_TRANSCRIPT_PLACEHOLDER, transcriptToProseMirrorDoc } from "./transcript-to-prosemirror";

const here = path.dirname(fileURLToPath(import.meta.url));

function readFixture(name: string): string {
  return readFileSync(path.join(here, "__fixtures__", "transcript", name), "utf-8");
}

/** A deterministic block-id minter so tests assert exact ids. */
function makeMinter(): () => BlockId {
  let n = 0;
  return () => `blk-${++n}` as BlockId;
}

describe("parseTranscript", () => {
  it("parses a VTT fixture: BOM, NOTE header, styling tags, overlap, empty/zero-duration dropped", () => {
    const cues = parseTranscript(readFixture("sample.vtt"), "vtt");
    // The empty/whitespace zero-duration cue at 7s is dropped → 3 cues remain.
    expect(cues).toEqual([
      { startMs: 1000, endMs: 4000, text: "Hello world" },
      { startMs: 3500, endMs: 6000, text: "Overlapping cue" }, // overlaps the first, kept
      { startMs: 8000, endMs: 11000, text: "Third line here" },
    ]);
    // Styling tags (`<c.…>`, `<i>`) are stripped to plain text.
    expect(cues[0]?.text).not.toContain("<");
  });

  it("auto-detects the format from the WEBVTT magic header", () => {
    const autoCues = parseTranscript(readFixture("sample.vtt"), "auto");
    const vttCues = parseTranscript(readFixture("sample.vtt"), "vtt");
    expect(autoCues).toEqual(vttCues);
  });

  it("parses an SRT fixture: CRLF line endings + comma-millisecond timings", () => {
    const cues = parseTranscript(readFixture("sample.srt"), "srt");
    expect(cues).toEqual([
      { startMs: 500, endMs: 2000, text: "First SRT cue" },
      { startMs: 2500, endMs: 5000, text: "Second SRT cue" },
    ]);
  });

  it("sorts cues by startMs even when supplied out of order", () => {
    const out = parseTranscript(
      [
        "WEBVTT",
        "",
        "00:00:09.000 --> 00:00:10.000",
        "later",
        "",
        "00:00:02.000 --> 00:00:03.000",
        "earlier",
      ].join("\n"),
      "vtt",
    );
    expect(out.map((c) => c.text)).toEqual(["earlier", "later"]);
  });

  it("yields endMs null for a cue whose end does not exceed its start", () => {
    const out = parseTranscript(
      ["WEBVTT", "", "00:00:05.000 --> 00:00:05.000", "instant"].join("\n"),
      "vtt",
    );
    // A zero-duration cue with text is kept (text non-empty) but endMs is null.
    expect(out).toEqual([{ startMs: 5000, endMs: null, text: "instant" }]);
  });

  it("returns [] for empty / unparseable input (best-effort, never throws)", () => {
    expect(parseTranscript("", "auto")).toEqual([]);
    expect(parseTranscript("   \n  ", "auto")).toEqual([]);
    expect(parseTranscript("not a transcript at all", "vtt")).toEqual([]);
  });
});

describe("transcriptToProseMirrorDoc", () => {
  it("maps cues to a title heading + one paragraph per cue, each tagged with timestampMs", () => {
    const cues = parseTranscript(readFixture("sample.vtt"), "vtt");
    const conv = transcriptToProseMirrorDoc({ title: "My Video", cues }, makeMinter());

    // heading + 3 cue paragraphs.
    expect(conv.doc.content).toHaveLength(4);
    expect(conv.doc.content[0]?.type).toBe("heading");
    expect(conv.doc.content.slice(1).every((n) => n.type === "paragraph")).toBe(true);

    // blocks: heading has timestampMs null; cue paragraphs carry their cue start.
    expect(conv.blocks[0]).toMatchObject({ blockType: "heading", timestampMs: null });
    expect(conv.blocks[1]).toMatchObject({ blockType: "paragraph", timestampMs: 1000 });
    expect(conv.blocks[2]).toMatchObject({ blockType: "paragraph", timestampMs: 3500 });
    expect(conv.blocks[3]).toMatchObject({ blockType: "paragraph", timestampMs: 8000 });

    // plainText is timestamp-prefixed for search/preview.
    expect(conv.plainText).toContain("My Video");
    expect(conv.plainText).toContain("[0:01] Hello world");
  });

  it("gives every row-bearing node a unique stable blockId", () => {
    const cues = parseTranscript(readFixture("sample.vtt"), "vtt");
    const conv = transcriptToProseMirrorDoc({ title: "My Video", cues });
    const ids = conv.blocks.map((b) => b.stableBlockId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(4);
  });

  it("produces a doc that validates against buildSchema() (all nodes allowed)", () => {
    const cues = parseTranscript(readFixture("sample.vtt"), "vtt");
    const conv = transcriptToProseMirrorDoc({ title: "My Video", cues });
    const schema = buildSchema();
    // nodeFromJSON does not throw on a valid doc (no direct prosemirror-model dep).
    expect(() => schema.nodeFromJSON(conv.doc)).not.toThrow();
    // Every node type is in the constrained allow-list.
    const node = schema.nodeFromJSON(conv.doc);
    node.descendants((child) => {
      expect(ALLOWED_NODE_NAMES).toContain(child.type.name);
      return true;
    });
  });

  it("maps an EMPTY cue list to the title + ONE placeholder paragraph (no crash)", () => {
    const conv = transcriptToProseMirrorDoc({ title: "Silent Clip", cues: [] }, makeMinter());
    expect(conv.doc.content).toHaveLength(2);
    expect(conv.doc.content[0]?.type).toBe("heading");
    expect(conv.doc.content[1]?.type).toBe("paragraph");
    // The placeholder is the body text; the title is the only plainText mirror.
    const para = conv.doc.content[1];
    const text = para?.type === "paragraph" ? para.content?.[0] : null;
    expect(text && "text" in text ? text.text : "").toBe(NO_TRANSCRIPT_PLACEHOLDER);
    expect(conv.plainText).toBe("Silent Clip");
    // The placeholder paragraph carries no timestamp.
    expect(conv.blocks[1]).toMatchObject({ blockType: "paragraph", timestampMs: null });
  });

  it("falls back to a default title when the title is empty", () => {
    const conv = transcriptToProseMirrorDoc({ title: "   ", cues: [] });
    const heading = conv.doc.content[0];
    const text = heading?.type === "heading" ? heading.content?.[0] : null;
    expect(text && "text" in text ? text.text : "").toBe("Media");
  });
});
