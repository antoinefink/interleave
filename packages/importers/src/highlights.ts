/**
 * Highlight import adapters (T069) — PURE, framework-agnostic transforms.
 *
 * Turn an external highlight export (a Readwise CSV/JSON export, or a Kindle
 * `My Clippings.txt`) into a normalized {@link ImportedHighlight}[] that the main-side
 * `HighlightImportService` groups into one `source` per book/article and authors as
 * inbox `extract` elements — NEVER cards. This module owns ONLY the parse; it does no
 * I/O (`fs`/network), no DB, and no Electron, so it bundles cleanly into `main.cjs` and
 * is fully fixture-testable.
 *
 * ## Why these adapters all converge on one shape
 *
 * `ImportedHighlight` is the single intermediate every adapter produces, so the import
 * service has ONE grouping + extract-authoring path regardless of the source tool. Each
 * adapter is tolerant: a malformed record is SKIPPED (and counted via the returned
 * array's length vs the raw record count), never fatal — Kindle clippings in particular
 * are notoriously messy (locale-specific dates/locations, bookmark entries, duplicates).
 *
 * ## CSV parsing — `papaparse`
 *
 * Readwise CSV cells contain commas + newlines inside quoted highlights, so a naive
 * `split(",")` is wrong. `papaparse` is a tiny, pure-JS, dependency-free RFC-4180 CSV
 * parser (robust quoting/escaping, no native bindings) — chosen over a hand-rolled
 * splitter for correctness on quoted commas/newlines, and over heavier streaming CSV
 * libs we do not need (the export is already a string in memory).
 */

import Papa from "papaparse";

/** The format an adapter / the auto-detector recognizes. */
export type HighlightFormat = "readwise_csv" | "readwise_json" | "kindle_clippings";

/**
 * The normalized intermediate every highlight adapter produces. The import service
 * groups these by `(title, author)` into one `source` per book/article; each becomes
 * one `extract` whose `source_locations` anchor carries the attribution
 * (`page`/`location`/`selectedText`) and whose owning source carries `title`/`author`.
 */
export interface ImportedHighlight {
  /** The highlighted passage (required, non-empty — empty ones are dropped). */
  readonly text: string;
  /** The user's note on the highlight, if any. */
  readonly note: string | null;
  /** The book/article it came from (required — a highlight with no title is dropped). */
  readonly title: string;
  readonly author: string | null;
  /** Article URL (Readwise), else null. */
  readonly sourceUrl: string | null;
  /** Raw location label ("Location 1234", "Page 56", "12:34"), else null. */
  readonly location: string | null;
  /** Parsed page number when derivable from the location, else null. */
  readonly page: number | null;
  /** ISO timestamp when highlighted, if known. */
  readonly highlightedAt: string | null;
  /** Readwise tags, else []. */
  readonly tags: readonly string[];
}

/** Trim to a non-empty string, or null. */
function nonEmpty(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse a raw location label into a page number when it denotes a page. Recognizes
 * "Page 56", "p. 56", "56" (bare numeric), but NOT a Kindle "Location 1234" (a
 * location is not a page). Returns null when no page is derivable.
 */
function pageFromLocation(location: string | null): number | null {
  if (!location) return null;
  const lower = location.toLowerCase();
  // A Kindle "location" is an addressing unit, NOT a page — do not coerce it.
  if (lower.includes("location") && !lower.includes("page")) return null;
  const match = lower.match(/page\s+(\d+)|p\.?\s*(\d+)|^\s*(\d+)\s*$/);
  if (!match) return null;
  const num = match[1] ?? match[2] ?? match[3];
  if (!num) return null;
  const parsed = Number.parseInt(num, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Normalize a date-ish string to an ISO timestamp, or null when unparseable. */
function toIso(value: string | null): string | null {
  const trimmed = nonEmpty(value);
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Split a Readwise tag cell ("tag1, tag2" or space-separated) into clean tags. */
function splitTags(raw: string | null | undefined): string[] {
  const trimmed = nonEmpty(raw ?? null);
  if (!trimmed) return [];
  return trimmed
    .split(/[,\s]+/)
    .map((t) => t.replace(/^#/, "").trim())
    .filter((t) => t.length > 0);
}

/**
 * Resolve a value from a CSV row by candidate header names, CASE-INSENSITIVELY (and
 * tolerant of surrounding whitespace in the header). Readwise/Kindle exports vary the
 * header casing across versions/locales, so an exact-key lookup would silently drop a
 * column whose case differs from every candidate. The first candidate that resolves to
 * a non-empty trimmed value wins.
 */
function pick(row: Record<string, string>, ...names: string[]): string | null {
  for (const name of names) {
    const wanted = name.trim().toLowerCase();
    for (const [key, value] of Object.entries(row)) {
      if (key.trim().toLowerCase() !== wanted) continue;
      if (value != null && value.trim().length > 0) return value.trim();
    }
  }
  return null;
}

/**
 * Parse a Readwise CSV export into normalized highlights. Readwise's CSV columns are
 * `Highlight`, `Title`, `Author`, `Note`, `Location`, `Location Type`, `Highlighted
 * at`, `URL`, `Tags` (header order varies; we resolve by name). Rows with no highlight
 * text or no title are skipped. Quoted commas/newlines inside cells are handled by
 * `papaparse`.
 */
export function parseReadwiseCsv(csv: string): ImportedHighlight[] {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: true,
    // Keep cells as strings; we normalize ourselves.
    dynamicTyping: false,
  });
  const out: ImportedHighlight[] = [];
  for (const row of parsed.data) {
    if (!row || typeof row !== "object") continue;
    const text = pick(row, "Highlight", "highlight", "Text", "text");
    const title = pick(row, "Title", "title", "Book Title");
    if (!text || !title) continue;
    const location = pick(row, "Location", "location");
    out.push({
      text,
      note: pick(row, "Note", "note"),
      title,
      author: pick(row, "Author", "author"),
      sourceUrl: pick(row, "URL", "url", "Url"),
      location,
      page: pageFromLocation(location),
      highlightedAt: toIso(pick(row, "Highlighted at", "Highlighted At", "highlighted_at")),
      tags: splitTags(pick(row, "Tags", "tags")),
    });
  }
  return out;
}

/** One book in Readwise's JSON export. */
interface ReadwiseJsonBook {
  readonly title?: unknown;
  readonly author?: unknown;
  readonly source_url?: unknown;
  readonly readable_title?: unknown;
  readonly highlights?: unknown;
}

/** One highlight in a Readwise JSON book. */
interface ReadwiseJsonHighlight {
  readonly text?: unknown;
  readonly note?: unknown;
  readonly location?: unknown;
  readonly location_type?: unknown;
  readonly highlighted_at?: unknown;
  readonly url?: unknown;
  readonly tags?: unknown;
}

/** A typed failure the service maps to a friendly "unrecognized export" message. */
export class HighlightParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HighlightParseError";
  }
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return nonEmpty(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** A Readwise JSON `tags` array is `[{ name }]` or `["tag"]`; normalize either. */
function jsonTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const tag of value) {
    if (typeof tag === "string") {
      const clean = tag.replace(/^#/, "").trim();
      if (clean) out.push(clean);
    } else if (tag && typeof tag === "object" && "name" in tag) {
      const name = asString((tag as { name?: unknown }).name);
      if (name) out.push(name.replace(/^#/, ""));
    }
  }
  return out;
}

/**
 * Parse a Readwise JSON export — an array of books, each with a `highlights[]` array
 * (the documented Readwise export shape). Tolerant: a book with no title or a highlight
 * with no text is skipped. Throws {@link HighlightParseError} when the JSON does not
 * parse or is not the expected book-array shape.
 */
export function parseReadwiseJson(json: string): ImportedHighlight[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new HighlightParseError("Not valid JSON.");
  }
  // The export is `{ "books": [...] }` OR a bare array of books.
  const books: unknown = Array.isArray(data)
    ? data
    : data && typeof data === "object" && "books" in data
      ? (data as { books: unknown }).books
      : null;
  if (!Array.isArray(books)) {
    throw new HighlightParseError("Unrecognized Readwise JSON shape.");
  }
  const out: ImportedHighlight[] = [];
  for (const rawBook of books) {
    if (!rawBook || typeof rawBook !== "object") continue;
    const book = rawBook as ReadwiseJsonBook;
    const title = asString(book.title) ?? asString(book.readable_title);
    if (!title) continue;
    const author = asString(book.author);
    const bookUrl = asString(book.source_url);
    const highlights = Array.isArray(book.highlights) ? book.highlights : [];
    for (const rawHl of highlights) {
      if (!rawHl || typeof rawHl !== "object") continue;
      const hl = rawHl as ReadwiseJsonHighlight;
      const text = asString(hl.text);
      if (!text) continue;
      const locationType = asString(hl.location_type);
      const locationNum = asString(hl.location);
      const location =
        locationNum != null && locationType != null
          ? `${capitalize(locationType)} ${locationNum}`
          : locationNum;
      out.push({
        text,
        note: asString(hl.note),
        title,
        author,
        sourceUrl: asString(hl.url) ?? bookUrl,
        location,
        page: locationType?.toLowerCase() === "page" ? safeInt(locationNum) : null,
        highlightedAt: toIso(asString(hl.highlighted_at)),
        tags: jsonTags(hl.tags),
      });
    }
  }
  return out;
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function safeInt(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The Kindle clippings record separator. */
const KINDLE_SEPARATOR = "==========";

/**
 * Parse a Kindle `My Clippings.txt`. Records are separated by a line of `==========`.
 * Each record is:
 *
 *   1. a TITLE line — "Title (Author)" (author optional);
 *   2. a METADATA line — "- Your Highlight on page 56 | location 1234-1240 | Added on …"
 *      (or a "- Your Bookmark …" / "- Your Note …" line);
 *   3. a blank line;
 *   4. the highlight TEXT (one or more lines).
 *
 * Tolerant by design — Kindle clippings are messy: bookmark entries (no body),
 * empty entries, and malformed records are SKIPPED (counted as the gap between the raw
 * record count and the returned length). Notes attached to a highlight come through as
 * their own records (Kindle emits a separate "- Your Note" record); we keep highlight
 * records and drop bookmarks.
 */
export function parseKindleClippings(text: string): ImportedHighlight[] {
  // Strip a BOM Kindle sometimes prefixes, then split on the separator line.
  const normalized = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const records = normalized.split(new RegExp(`\\n?${KINDLE_SEPARATOR}\\n?`));
  const out: ImportedHighlight[] = [];
  for (const record of records) {
    const lines = record.split("\n");
    // Trim leading blank lines a separator may have left.
    while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
    if (lines.length < 1) continue;
    const titleLine = (lines[0] ?? "").trim();
    if (titleLine.length === 0) continue;
    const metaLine = (lines[1] ?? "").trim();
    // A bookmark has no body and is not useful as an extract — skip it.
    if (/your bookmark/i.test(metaLine)) continue;
    // Drop a standalone note record (it is metadata, not a highlight passage).
    if (/your note/i.test(metaLine)) continue;

    const { title, author } = parseKindleTitleLine(titleLine);
    if (!title) continue;

    // The body is everything after the (blank) line 3. Join + trim.
    const body = lines.slice(2).join("\n").trim();
    if (body.length === 0) continue;

    const location = parseKindleLocation(metaLine);
    out.push({
      text: body,
      note: null,
      title,
      author,
      sourceUrl: null,
      location,
      page: pageFromLocation(location),
      highlightedAt: parseKindleAddedDate(metaLine),
      tags: [],
    });
  }
  return out;
}

/** Parse "Title (Author Name)" → { title, author }; author optional. */
function parseKindleTitleLine(line: string): { title: string | null; author: string | null } {
  // Match a trailing "(...)" as the author; everything before is the title.
  const match = line.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  if (match) {
    return { title: nonEmpty(match[1] ?? null), author: nonEmpty(match[2] ?? null) };
  }
  return { title: nonEmpty(line), author: null };
}

/**
 * Extract the human-readable location label from a Kindle metadata line. Prefers the
 * page when present ("on page 56"), else the location ("location 1234-1240"). Returns
 * a normalized label like "Page 56" / "Location 1234-1240", or null.
 */
function parseKindleLocation(metaLine: string): string | null {
  const pageMatch = metaLine.match(/page\s+([\divxlcdm-]+)/i);
  if (pageMatch?.[1]) return `Page ${pageMatch[1]}`;
  const locMatch = metaLine.match(/location\s+([\d-]+)/i);
  if (locMatch?.[1]) return `Location ${locMatch[1]}`;
  return null;
}

/** Pull the "Added on <date>" timestamp out of a Kindle metadata line, if parseable. */
function parseKindleAddedDate(metaLine: string): string | null {
  const match = metaLine.match(/added on\s+(.+?)\s*$/i);
  if (!match?.[1]) return null;
  return toIso(match[1]);
}

/**
 * Sniff the highlight-export format by filename extension + content shape so the
 * service can auto-route a picked file. Returns null (→ a friendly "unrecognized
 * export" error) when nothing matches.
 *
 *   - a `.txt` (or any text) containing `==========` → kindle_clippings;
 *   - a `.json` (or content starting `[`/`{`) that parses to the Readwise book shape →
 *     readwise_json;
 *   - a `.csv` (or content with a Readwise-style header row) → readwise_csv.
 */
export function detectHighlightFormat(filename: string, content: string): HighlightFormat | null {
  const lowerName = filename.toLowerCase();
  const trimmed = content.replace(/^﻿/, "").trimStart();

  // Kindle clippings: the unmistakable separator (regardless of extension).
  if (trimmed.includes(KINDLE_SEPARATOR)) return "kindle_clippings";

  // JSON: extension OR a leading `[`/`{` that parses to the Readwise shape.
  const looksJson =
    lowerName.endsWith(".json") || trimmed.startsWith("[") || trimmed.startsWith("{");
  if (looksJson) {
    try {
      const data = JSON.parse(trimmed);
      const books = Array.isArray(data)
        ? data
        : data && typeof data === "object" && "books" in data
          ? (data as { books: unknown }).books
          : null;
      if (
        Array.isArray(books) &&
        books.some((b) => b && typeof b === "object" && "highlights" in b)
      ) {
        return "readwise_json";
      }
      // A JSON array of books with no `highlights` key still counts as the shape.
      if (Array.isArray(books)) return "readwise_json";
    } catch {
      // Not valid JSON — fall through.
    }
  }

  // CSV: extension OR a header row mentioning the Readwise columns.
  const firstLine = trimmed.split(/\r?\n/, 1)[0]?.toLowerCase() ?? "";
  const looksReadwiseCsv =
    firstLine.includes("highlight") && firstLine.includes("title") && firstLine.includes(",");
  if (lowerName.endsWith(".csv") || looksReadwiseCsv) {
    if (looksReadwiseCsv) return "readwise_csv";
  }

  return null;
}

/** Dispatch to the matching adapter for a detected/declared format. */
export function parseHighlights(format: HighlightFormat, content: string): ImportedHighlight[] {
  switch (format) {
    case "readwise_csv":
      return parseReadwiseCsv(content);
    case "readwise_json":
      return parseReadwiseJson(content);
    case "kindle_clippings":
      return parseKindleClippings(content);
  }
}
