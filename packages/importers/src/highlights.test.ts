/**
 * Highlight adapter unit tests (T069) — fixture-driven, pure (no DB, no I/O beyond
 * reading the committed fixtures). Proves each adapter parses the right
 * `ImportedHighlight[]` (text/title/author/location/page/tags), that the Kindle parser
 * tolerates messy input (skips a bookmark, a note, and a malformed record), and that
 * `detectHighlightFormat` routes each fixture + returns null for garbage.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectHighlightFormat,
  HighlightParseError,
  parseKindleClippings,
  parseReadwiseCsv,
  parseReadwiseJson,
} from "./highlights";

const FIXTURES = path.resolve(__dirname, "__fixtures__", "highlights");
const read = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

describe("parseReadwiseCsv", () => {
  const csv = read("readwise.csv");
  const highlights = parseReadwiseCsv(csv);

  it("drops the empty-text row and keeps the rest", () => {
    // 4 data rows, one with empty highlight text → 3 kept.
    expect(highlights).toHaveLength(3);
  });

  it("parses text/title/author/url and handles quoted commas + newlines", () => {
    const first = highlights[0];
    expect(first?.text).toBe("Attention is all you need, and nothing more.");
    expect(first?.title).toBe("Attention Paper");
    expect(first?.author).toBe("Vaswani, Ashish");
    expect(first?.sourceUrl).toBe("https://arxiv.org/abs/1706.03762");
    expect(first?.note).toBe("My note here");
    // A quoted cell with an embedded comma + newline survives intact.
    expect(highlights[1]?.text).toContain("a comma and");
    expect(highlights[1]?.text).toContain("a newline inside");
  });

  it("parses a page location into a page number, leaves a Kindle-style location alone", () => {
    // Row 1 is "Location 1234" → no page; row 2 is "Page 12" → page 12.
    expect(highlights[0]?.location).toBe("Location 1234");
    expect(highlights[0]?.page).toBeNull();
    expect(highlights[1]?.location).toBe("Page 12");
    expect(highlights[1]?.page).toBe(12);
  });

  it("splits the tags cell", () => {
    expect(highlights[0]?.tags).toEqual(["transformers", "nlp"]);
    expect(highlights[1]?.tags).toEqual(["nlp"]);
  });
});

describe("parseReadwiseJson", () => {
  const highlights = parseReadwiseJson(read("readwise.json"));

  it("flattens books → highlights, skipping empty-text and title-less books", () => {
    // Book 1: 3 highlights, one empty → 2. Book 2: 1. Book 3: no title → skipped.
    expect(highlights).toHaveLength(3);
    expect(highlights.map((h) => h.title)).toEqual([
      "Thinking, Fast and Slow",
      "Thinking, Fast and Slow",
      "Deep Work",
    ]);
  });

  it("carries author/url/tags and derives the page only for a page location_type", () => {
    expect(highlights[0]?.author).toBe("Daniel Kahneman");
    expect(highlights[0]?.sourceUrl).toBe("https://example.com/tfas");
    expect(highlights[0]?.tags).toEqual(["psychology", "cognition"]);
    // location_type=location → no page.
    expect(highlights[0]?.location).toBe("Location 101");
    expect(highlights[0]?.page).toBeNull();
    // location_type=page → page 56.
    expect(highlights[1]?.location).toBe("Page 56");
    expect(highlights[1]?.page).toBe(56);
  });

  it("throws a typed error on non-JSON or an unrecognized shape", () => {
    expect(() => parseReadwiseJson("not json")).toThrow(HighlightParseError);
    expect(() => parseReadwiseJson('{"foo":1}')).toThrow(HighlightParseError);
  });
});

describe("parseKindleClippings", () => {
  const highlights = parseKindleClippings(read("MyClippings.txt"));

  it("keeps real highlights and skips bookmarks, notes, and malformed records", () => {
    // 2 Pragmatic highlights + 1 Sapiens highlight = 3 kept; bookmark/note/malformed dropped.
    expect(highlights).toHaveLength(3);
  });

  it("parses the title/author off the first line", () => {
    expect(highlights[0]?.title).toBe("The Pragmatic Programmer");
    expect(highlights[0]?.author).toBe("David Thomas;Andrew Hunt");
    expect(highlights[2]?.title).toBe("Sapiens");
    expect(highlights[2]?.author).toBe("Yuval Noah Harari");
  });

  it("parses the page + body and the added date", () => {
    expect(highlights[0]?.location).toBe("Page 24");
    expect(highlights[0]?.page).toBe(24);
    expect(highlights[0]?.text).toContain("Care about your craft");
    expect(highlights[0]?.highlightedAt).not.toBeNull();
    // A location-only record (no page) keeps the location label, no page number.
    expect(highlights[2]?.location).toBe("Location 512-514");
    expect(highlights[2]?.page).toBeNull();
  });
});

describe("detectHighlightFormat", () => {
  it("routes each fixture to its format", () => {
    expect(detectHighlightFormat("readwise.csv", read("readwise.csv"))).toBe("readwise_csv");
    expect(detectHighlightFormat("readwise.json", read("readwise.json"))).toBe("readwise_json");
    expect(detectHighlightFormat("MyClippings.txt", read("MyClippings.txt"))).toBe(
      "kindle_clippings",
    );
  });

  it("detects by content even when the extension is misleading", () => {
    // A .txt that is actually Kindle clippings.
    expect(detectHighlightFormat("export.dat", read("MyClippings.txt"))).toBe("kindle_clippings");
  });

  it("returns null for unrecognized garbage", () => {
    expect(detectHighlightFormat("notes.txt", "just some prose, no structure")).toBeNull();
    expect(detectHighlightFormat("data.bin", "{not really json")).toBeNull();
  });
});
