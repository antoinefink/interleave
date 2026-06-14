/**
 * Inbox read query (T012) — assembles the Import & Inbox screen's list + preview
 * payloads by composing the repositories. Read-only: it performs no mutations and
 * appends nothing to the operation log (the triage/import writes go through the
 * repositories directly, in the DB service).
 *
 * This is the seam that keeps inbox list/preview logic OUT of React: the renderer
 * calls `window.appApi.inbox.list()` / `inbox.get(id)` and the Electron main
 * process runs THIS against the open database. It filters to live
 * (`deletedAt IS NULL`), `type === "source"`, `status === "inbox"` rows, joins
 * the `sources` provenance row, and slices a `documents.plainText` preview into
 * the flat, JSON-serializable shapes below so they cross IPC unchanged.
 */

import type {
  CapturedVia,
  ConfidenceLevel,
  Element,
  ElementId,
  MediaKind,
  ReliabilityTier,
  Source,
  SourceType,
} from "@interleave/core";
import type { Repositories } from "./index";

/** A flat, list-row summary for one inbox source. */
export interface InboxItemSummary {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly stage: string;
  readonly priority: number;
  readonly title: string;
  readonly srcType: string;
  readonly author: string | null;
  readonly accessedAt: string | null;
  readonly charCount: number;
  readonly previewSnippet: string | null;
  /**
   * Capture origin (T126) — the persisted `sources.captured_via` (`manual`/`url`/
   * `extension`/`highlight_import`/`file`), or `null` for a legacy / un-recorded
   * origin. The raw value (NOT a human label — the renderer labels it via
   * `capturedViaLabel`); the inbox group-by-origin view buckets `null` into "Other".
   */
  readonly origin: CapturedVia | null;
  /**
   * The host of `canonicalUrl ?? url` with a leading `www.` stripped (T126), or
   * `null` when the source has no URL or the URL is malformed. The key the inbox
   * group-by-domain view buckets on.
   */
  readonly domain: string | null;
}

/** Source provenance shown in the inbox preview's metadata rail. */
export interface InboxProvenance {
  readonly elementId: string;
  readonly url: string | null;
  /** Normalized URL derived from `url` (tracking params/fragment stripped). */
  readonly canonicalUrl: string | null;
  /** The as-entered URL preserved verbatim for provenance. */
  readonly originalUrl: string | null;
  readonly author: string | null;
  readonly publishedAt: string | null;
  readonly accessedAt: string | null;
  readonly reasonAdded: string | null;
  /** Source-reliability metadata (T091) — all nullable (no badge when all absent). */
  readonly sourceType: SourceType | null;
  readonly reliabilityTier: ReliabilityTier | null;
  readonly confidence: ConfidenceLevel | null;
  readonly reliabilityNotes: string | null;
}

/** Full preview payload for one inbox item. */
export interface InboxItemDetail {
  readonly summary: InboxItemSummary;
  readonly provenance: InboxProvenance;
  /** Full ProseMirror body JSON for the selected item; opaque to local-db. */
  readonly bodyDoc: unknown | null;
  /** Full plain-text mirror for fallback rendering; never truncated. */
  readonly bodyText: string | null;
  /** Deprecated plain-text preview kept for older renderer callers. */
  readonly bodyPreview: string | null;
}

/** Human labels for inbox source chips. */
const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  paper: "Paper",
  book: "Book",
  article: "Web article",
  docs: "Docs",
  reference: "Reference",
  blog: "Blog post",
  forum: "Forum thread",
  video: "Video",
  dataset: "Dataset",
  personal_note: "Manual note",
  other: "Source",
};

export function inboxSourceTypeLabel(source: Source | null): string {
  if (!source) return "Manual note";
  if (source.mediaKind) return mediaSourceLabel(source.mediaKind);
  if (source.sourceType) return SOURCE_TYPE_LABEL[source.sourceType];
  if (source.snapshotKey?.toLowerCase().endsWith(".pdf")) return "PDF";
  if (source.snapshotKey?.toLowerCase().endsWith(".epub")) return "Book";
  if (source.snapshotKey?.toLowerCase().endsWith(".html")) return "Web article";
  if (source.url || source.canonicalUrl || source.originalUrl) return "Web article";
  return "Manual note";
}

function mediaSourceLabel(kind: MediaKind): string {
  if (kind === "youtube") return "YouTube";
  return kind === "audio" ? "Audio" : "Video";
}

/**
 * Parse the group-by-domain key from a source's URL (T126): the host of
 * `canonicalUrl ?? url`, normalized by stripping a leading `www.` (so
 * `https://www.example.com/x` and `https://example.com/y` bucket together). Returns
 * `null` when there is no URL or the URL is malformed (the platform `URL` parser
 * throws on garbage — we swallow it rather than let the read query throw).
 *
 * Exported so the DB service's per-item summary builder (`summaryForId`) derives the
 * `domain` field through the SAME rule the list query uses — no divergent parse.
 */
export function inboxSourceDomain(source: Source | null): string | null {
  const raw = source?.canonicalUrl ?? source?.url ?? null;
  if (!raw) return null;
  try {
    const host = new URL(raw).hostname;
    if (!host) return null;
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Collapse whitespace + trim, then take the first `max` chars (no mid-word ellipsis fuss). */
function snippet(text: string, max: number): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  return normalized.length > max ? `${normalized.slice(0, max).trimEnd()}…` : normalized;
}

/**
 * Read-only inbox query layer. Constructed once per open database (alongside
 * {@link Repositories}); the main process exposes its two read methods over
 * validated IPC. The renderer never instantiates this.
 */
export class InboxQuery {
  constructor(private readonly repos: Repositories) {}

  /**
   * Live inbox-status `source` element summaries, newest first. Filters to
   * `type === "source"` AND `status === "inbox"` AND not soft-deleted, then joins
   * the `sources` provenance + a short `documents.plainText` preview slice.
   */
  list(): InboxItemSummary[] {
    const { elements } = this.repos;
    const inboxSources = elements.listByStatus("inbox").filter((el) => el.type === "source");
    inboxSources.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    );
    return inboxSources.map((el) => this.toSummary(el));
  }

  /**
   * The full preview payload for one inbox source, or `null` when the id is
   * unknown, soft-deleted, not a `source`, or not in the `inbox` status.
   */
  get(id: ElementId): InboxItemDetail | null {
    const { elements, sources } = this.repos;
    const element = elements.findById(id);
    if (!element || element.deletedAt) return null;
    if (element.type !== "source" || element.status !== "inbox") return null;

    const withProvenance = sources.findById(id);
    const provenanceRow = withProvenance?.source ?? null;

    const provenance: InboxProvenance = {
      elementId: id,
      url: provenanceRow?.url ?? null,
      canonicalUrl: provenanceRow?.canonicalUrl ?? null,
      originalUrl: provenanceRow?.originalUrl ?? null,
      author: provenanceRow?.author ?? null,
      publishedAt: provenanceRow?.publishedAt ?? null,
      accessedAt: provenanceRow?.accessedAt ?? null,
      reasonAdded: provenanceRow?.reasonAdded ?? null,
      // Source-reliability metadata (T091) — surfaced in the inbox preview rail.
      sourceType: provenanceRow?.sourceType ?? null,
      reliabilityTier: provenanceRow?.reliabilityTier ?? null,
      confidence: provenanceRow?.confidence ?? null,
      reliabilityNotes: provenanceRow?.reliabilityNotes ?? null,
    };

    const doc = this.repos.documents.findById(id);
    const bodyText = doc ? doc.plainText : null;
    const bodyPreview = doc ? snippet(doc.plainText, 4000) : null;

    return {
      summary: this.toSummary(element),
      provenance,
      bodyDoc: doc?.prosemirrorJson ?? null,
      bodyText,
      bodyPreview,
    };
  }

  /** Compose an element + its provenance + a preview slice into a flat summary. */
  private toSummary(element: Element): InboxItemSummary {
    const { sources, documents } = this.repos;
    const provenance = sources.findById(element.id)?.source ?? null;
    const doc = documents.findById(element.id);
    const plainText = doc?.plainText ?? "";
    return {
      id: element.id,
      type: element.type,
      status: element.status,
      stage: element.stage,
      priority: element.priority,
      title: element.title,
      srcType: inboxSourceTypeLabel(provenance),
      author: provenance?.author ?? null,
      accessedAt: provenance?.accessedAt ?? null,
      charCount: plainText.length,
      previewSnippet: snippet(plainText, 160),
      origin: provenance?.capturedVia ?? null,
      domain: inboxSourceDomain(provenance),
    };
  }
}
