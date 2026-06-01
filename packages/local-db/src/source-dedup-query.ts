/**
 * SourceDedupQuery (T061) — the typed duplicate-detection lookups for URL import.
 *
 * URL import (T060) imports unconditionally; T061 makes it dedup-aware. Before
 * creating a source the {@link UrlImportService} asks this query whether the page
 * is already imported, by TWO signals:
 *
 *   1. **canonical URL** — the primary signal. `canonicalizeUrl` (a single shared
 *      normalizer in `@interleave/core`) strips tracking params / fragment, so two
 *      URLs for the same page collapse to one key. Backed by the indexed
 *      `sources_canonical_url_idx` over the LIVE `sources` table.
 *   2. **content hash** — a backstop for the same article reached via two URLs that
 *      do NOT canonicalize equal. The cleaned-HTML snapshot's sha-256 (already
 *      computed in T060) is looked up against the `assets` table.
 *
 * Both lookups consider ONLY live sources (`elements.deleted_at IS NULL`, type
 * `source`) — a soft-deleted source must not block a re-import. This is the
 * local-first equivalent of M2's deferred "possible duplicate" banner: it DETECTS
 * duplicates; it never merges or destroys anything (no auto-merge), and the user
 * always has the explicit "import new version anyway" escape hatch.
 *
 * Read-only + framework-free (no IPC, no React): a typed `packages/local-db` query,
 * never SQL in the renderer.
 */

import type { ElementId } from "@interleave/core";
import { elements, type InterleaveDatabase, sources } from "@interleave/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { AssetRepository } from "./asset-repository";

/** How a duplicate was detected — surfaced to the user so they know WHY it matched. */
export type SourceDuplicateMatchKind = "canonicalUrl" | "contentHash";

/** A live source that matches an import candidate (canonical URL or content hash). */
export interface SourceDuplicateMatch {
  /** The existing source element's id (so the renderer can "Open existing"). */
  readonly elementId: ElementId;
  readonly title: string;
  /** Lifecycle status (`inbox` / `active` / `scheduled` / …) — never `deleted`. */
  readonly status: string;
  /** When it was imported/snapshotted (ISO-8601), or `null`. */
  readonly accessedAt: string | null;
  /** Which signal matched. */
  readonly matchedBy: SourceDuplicateMatchKind;
}

/** The cleaned-HTML snapshot filename — the dedup-relevant `source_html` asset. */
const CLEANED_SNAPSHOT_SUFFIX = "cleaned.html";

export class SourceDedupQuery {
  constructor(
    private readonly db: InterleaveDatabase,
    private readonly assets: AssetRepository,
  ) {}

  /**
   * Live `source` elements whose `sources.canonical_url` equals `canonicalUrl`,
   * newest first (by `accessed_at`). Soft-deleted sources are excluded. An empty
   * list means "not yet imported under this canonical URL". Returns `[]` for a
   * `null`/empty key (nothing to match).
   */
  findSourcesByCanonicalUrl(canonicalUrl: string | null): SourceDuplicateMatch[] {
    if (!canonicalUrl) return [];
    const rows = this.db
      .select({
        elementId: elements.id,
        title: elements.title,
        status: elements.status,
        accessedAt: sources.accessedAt,
      })
      .from(sources)
      .innerJoin(elements, eq(sources.elementId, elements.id))
      .where(
        and(
          eq(sources.canonicalUrl, canonicalUrl),
          eq(elements.type, "source"),
          isNull(elements.deletedAt),
        ),
      )
      // Newest first; rows with a null accessedAt sort last (NULLS sort low in
      // SQLite DESC). Deterministic tiebreak on id so the order is stable.
      .orderBy(desc(sources.accessedAt), desc(elements.id))
      .all();
    return rows.map((r) => ({
      elementId: r.elementId as ElementId,
      title: r.title,
      status: r.status,
      accessedAt: r.accessedAt,
      matchedBy: "canonicalUrl" as const,
    }));
  }

  /**
   * The live `source` whose CLEANED-HTML snapshot has the given content hash, or
   * `null`. {@link AssetRepository.findByContentHash} is hash-ONLY — it returns
   * whichever asset carries that hash regardless of whether it is an
   * `original.html` or a `cleaned.html`, so a raw lookup could resolve via the
   * WRONG logical file (matching an `original.html` byte-collision and pointing at
   * the wrong source). This query therefore DISAMBIGUATES: the matched asset must
   * be a `source_html` asset whose relative path ends in `cleaned.html`, AND its
   * owning element must be a live source. Pass only the cleaned-HTML hash here
   * (T060 hashes both files; dedup uses the `cleaned.html` one).
   */
  findSourceBySnapshotHash(contentHash: string): SourceDuplicateMatch | null {
    if (!contentHash) return null;
    const asset = this.assets.findByContentHash(contentHash);
    if (!asset) return null;
    // Disambiguate: only the cleaned-HTML snapshot is the dedup criterion.
    if (asset.kind !== "source_html") return null;
    if (!asset.location.vaultPath.relativePath.endsWith(CLEANED_SNAPSHOT_SUFFIX)) return null;

    // Resolve the owning source element — must be a live `source`.
    const row = this.db
      .select({
        elementId: elements.id,
        title: elements.title,
        status: elements.status,
        accessedAt: sources.accessedAt,
      })
      .from(elements)
      .innerJoin(sources, eq(sources.elementId, elements.id))
      .where(
        and(
          eq(elements.id, asset.owningElementId),
          eq(elements.type, "source"),
          isNull(elements.deletedAt),
        ),
      )
      .get();
    if (!row) return null;
    return {
      elementId: row.elementId as ElementId,
      title: row.title,
      status: row.status,
      accessedAt: row.accessedAt,
      matchedBy: "contentHash",
    };
  }
}
