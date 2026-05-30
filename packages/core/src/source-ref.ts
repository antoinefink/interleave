/**
 * Source reference (the `refblock`) — the framework-agnostic citation model (T043).
 *
 * Every extract and card consistently shows WHERE it came from: the originating
 * source title / URL / author / published date / location, plus the verbatim
 * source snippet. This module is the SINGLE source of truth for how a reference
 * READS — the citation line, the location label, the openable href — so review,
 * the extract view, the inspector, and the library result rows all agree.
 *
 * It is deliberately framework-free (no React, no Drizzle, no Electron): the main
 * process assembles the {@link SourceRef} from the persisted lineage
 * (`card → source location → source` / `extract → source`) and the renderer's
 * `RefBlock` component renders {@link formatSourceRef}. T043 adds presentation +
 * the missing provenance fields, NOT a new lineage model.
 *
 * No remote fetching — provenance is whatever was captured at import (T014).
 * `publishedAt` is a loose date string stored as-is; the formatter shows the year
 * when it parses and otherwise leaves the value untouched (it does not aggressively
 * reformat). Richer citation styles + source-reliability metadata are M18/T091.
 */

/**
 * A resolved reference to the origin of an extract/card, assembled main-side from
 * the persisted `sources` provenance row + the `source_locations` anchor. Every
 * field is nullable because manual imports may omit provenance and a (rare)
 * source-less element must degrade gracefully (a calm "source unavailable" line,
 * never a broken link).
 */
export interface SourceRef {
  /** The owning `source` element's id (the reader to open on "jump to source"). */
  readonly sourceElementId: string | null;
  /** The source title (provenance), or `null` when the source is gone/unknown. */
  readonly sourceTitle: string | null;
  /** The as-entered URL, when the source came from the web. */
  readonly url: string | null;
  /** The source author, when known. */
  readonly author: string | null;
  /** A loose published-date string stored as-is at import (NOT reformatted). */
  readonly publishedAt: string | null;
  /** The human-readable source location ("Definition · ¶ 4" / "p. 12"), or `null`. */
  readonly locationLabel: string | null;
  /** A verbatim snapshot of the originating text (the `refblock` quote), or `null`. */
  readonly snippet: string | null;
}

/** A {@link SourceRef} whose source could not be resolved (the calm orphan case). */
export const EMPTY_SOURCE_REF: SourceRef = {
  sourceElementId: null,
  sourceTitle: null,
  url: null,
  author: null,
  publishedAt: null,
  locationLabel: null,
  snippet: null,
};

/**
 * The presentation-ready pieces a `RefBlock` renders. `citation` is the single
 * "Author. Title (Year)." line (omitting any missing part cleanly); `locationLabel`
 * is the spot inside the source; `href` is a usable link target derived from the
 * URL, or `null` when there is none. `hasSource` distinguishes a resolved
 * reference from the orphan placeholder so the renderer can show a calm
 * "source unavailable" line instead of a broken link.
 */
export interface FormattedSourceRef {
  /** The assembled citation line ("François Chollet. On the Measure… (2019)."), or "". */
  readonly citation: string;
  /** The source location label, or `null`. */
  readonly locationLabel: string | null;
  /** A usable href derived from the URL, or `null`. */
  readonly href: string | null;
  /** The verbatim source snippet (the quote), or `null`. */
  readonly snippet: string | null;
  /** False when nothing about the source could be resolved (the orphan case). */
  readonly hasSource: boolean;
}

/** Extract a 4-digit year from a loose date string, when one parses; else `null`. */
function yearOf(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const trimmed = publishedAt.trim();
  if (trimmed === "") return null;
  // A leading ISO/RFC year (e.g. "2019-11-05…" or "2019") is the common case and
  // does not depend on the host locale/timezone.
  const leading = trimmed.match(/^(\d{4})\b/);
  if (leading) return leading[1] ?? null;
  // Otherwise fall back to Date parsing for human-entered dates ("Nov 5, 2019").
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) {
    // Last resort: any 4-digit run that looks like a year (1000–2999).
    const any = trimmed.match(/\b([12]\d{3})\b/);
    return any ? (any[1] ?? null) : null;
  }
  return String(new Date(t).getUTCFullYear());
}

/** Trim a string to a non-empty value, or `null`. */
function clean(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/**
 * Derive a usable href from a reference's URL. Returns the as-entered URL when it
 * already carries a scheme, prefixes a bare `host/path` with `https://`, and
 * returns `null` for an empty/unusable value — never throwing, so a malformed URL
 * degrades to "no link" rather than an error.
 */
function hrefOf(url: string | null): string | null {
  const u = clean(url);
  if (!u) return null;
  // Already absolute (http/https/file/…): use verbatim.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
  // A scheme-less host (e.g. "example.com/x"): assume https.
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(u)) return `https://${u}`;
  return null;
}

/**
 * Assemble the presentation-ready {@link FormattedSourceRef} from a {@link SourceRef}.
 * Pure + framework-free: the citation omits missing parts cleanly, the year is
 * appended only when it parses, and the href is `null` when there is no usable URL.
 * When nothing about the source resolves, `hasSource` is `false` so the renderer
 * shows a calm placeholder instead of a broken reference.
 */
export function formatSourceRef(ref: SourceRef | null | undefined): FormattedSourceRef {
  const r = ref ?? EMPTY_SOURCE_REF;
  const author = clean(r.author);
  const title = clean(r.sourceTitle);
  const year = yearOf(r.publishedAt);
  const href = hrefOf(r.url);
  const locationLabel = clean(r.locationLabel);
  const snippet = clean(r.snippet);

  // "Author. Title (Year)." — each piece appears only when present.
  const parts: string[] = [];
  if (author) parts.push(author);
  if (title) parts.push(year ? `${title} (${year})` : title);
  else if (year) parts.push(`(${year})`);
  const citation = parts.join(". ");

  const hasSource =
    author != null ||
    title != null ||
    year != null ||
    href != null ||
    locationLabel != null ||
    snippet != null ||
    clean(r.sourceElementId) != null;

  return { citation, locationLabel, href, snippet, hasSource };
}
