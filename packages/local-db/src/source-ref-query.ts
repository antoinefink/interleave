/**
 * Source-reference resolver (T043) — the ONE main-side place that assembles an
 * element's {@link SourceRef} (the refblock) from the persisted lineage.
 *
 * Read-only + framework-free (no IPC, no React): it composes the existing
 * repositories to resolve, for a source / extract / card, the originating source's
 * provenance (`sources` row: title/url/author/publishedAt) + the element's
 * `source_locations` anchor (label + verbatim snippet). The {@link InspectorQuery}
 * and the review/extract payload builders both call this so review, the extract
 * view, the inspector, and the library result rows agree on how a reference reads
 * (the citation formatting itself lives in `@interleave/core`'s `formatSourceRef`).
 *
 * Lineage is SACRED but read-only here: this never mutates it. A soft-deleted or
 * missing source degrades to a calm partial/orphan ref (fields left `null`), never
 * a throw or a broken link.
 */

import type { ElementId, ElementLocation, SourceLocationId, SourceRef } from "@interleave/core";
import type { Repositories } from "./index";

/** The repositories {@link resolveSourceRef} reads (a narrow slice of {@link Repositories}). */
type SourceRefRepos = Pick<Repositories, "elements" | "sources" | "review">;

/**
 * Resolve the {@link SourceRef} for an element from its lineage, or `null` when the
 * element is unknown / soft-deleted. The element itself is the resolution anchor:
 *
 *  - a `source` references itself (its own provenance; no location);
 *  - an `extract` references its owning source element + its own `source_locations`
 *    anchor;
 *  - a `card` references its owning source element + the `cards.source_location_id`
 *    anchor (card → source location → source).
 *
 * Every field is best-effort: a missing source/location simply leaves that field
 * `null`. The caller renders it through `formatSourceRef` (which degrades the calm
 * orphan case).
 */
export function resolveSourceRef(repos: SourceRefRepos, id: ElementId): SourceRef | null {
  const element = repos.elements.findById(id);
  if (!element || element.deletedAt) return null;

  // --- source: the element IS the source; read its own provenance row. ---
  if (element.type === "source") {
    const row = repos.sources.findById(id);
    return {
      sourceElementId: id,
      sourceTitle: element.title,
      url: row?.source.url ?? null,
      author: row?.source.author ?? null,
      publishedAt: row?.source.publishedAt ?? null,
      locationLabel: null,
      snippet: null,
    };
  }

  // --- extract / card: resolve the owning source + the element's location anchor. ---
  // The location anchors an extract by its own element id; a card references it
  // through `cards.source_location_id` (the card → source location → source chain).
  let location: ElementLocation | null = repos.sources.findLocationForElement(id);
  if (!location && element.type === "card") {
    const card = repos.review.findCardById(id);
    const sourceLocationId = card?.card.sourceLocationId as SourceLocationId | null | undefined;
    if (sourceLocationId) location = repos.sources.findLocationById(sourceLocationId);
  }

  // The owning source element (lineage root) + its provenance. A soft-deleted
  // source degrades to a null title (a calm "source unavailable"), never a throw.
  const sourceId = element.sourceId ?? null;
  const sourceEl = sourceId ? repos.elements.findById(sourceId) : null;
  const liveSource = sourceEl && !sourceEl.deletedAt ? sourceEl : null;
  const provenance = liveSource ? repos.sources.findById(liveSource.id) : null;

  return {
    sourceElementId: liveSource?.id ?? null,
    sourceTitle: liveSource?.title ?? null,
    url: provenance?.source.url ?? null,
    author: provenance?.source.author ?? null,
    publishedAt: provenance?.source.publishedAt ?? null,
    locationLabel: location?.label ?? null,
    snippet: location?.selectedText ?? null,
  };
}
