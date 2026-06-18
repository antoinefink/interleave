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

import type {
  Element,
  ElementId,
  ElementLocation,
  SourceLocationId,
  SourceRef,
} from "@interleave/core";
import type { Repositories } from "./index";
import type { SourceWithElement } from "./source-repository";

/** The repositories {@link resolveSourceRef} reads (a narrow slice of {@link Repositories}). */
type SourceRefRepos = Pick<Repositories, "elements" | "sources" | "review">;

/**
 * Extended repos slice for the batched {@link resolveSourceRefMany}.
 * Adds batch-read methods alongside the per-item ones already in {@link SourceRefRepos}.
 *
 * File-local: callers (db-service) pass `this.repos` which satisfies this structurally.
 * Not exported from index.ts — use {@link SourceRefRepos} (the single-item slice) for
 * the public surface, or {@link Repositories} for the full object.
 */
type SourceRefManyRepos = {
  elements: {
    findById(id: ElementId): Element | null | undefined;
    findManyLive(ids: readonly ElementId[]): Element[];
  };
  sources: {
    findById(id: ElementId): SourceWithElement | null | undefined;
    findManyById(ids: readonly ElementId[]): Map<ElementId, SourceWithElement>;
    findLocationForElement(id: ElementId): ElementLocation | null | undefined;
    findLocationsByElementIds(ids: readonly ElementId[]): Map<ElementId, ElementLocation>;
    findLocationById(id: SourceLocationId): ElementLocation | null | undefined;
    findLocationsByIds(ids: readonly SourceLocationId[]): Map<SourceLocationId, ElementLocation>;
  };
  review: {
    findCardById(
      id: ElementId,
    ): { card: { sourceLocationId: string | null | undefined } } | null | undefined;
    findCardSourceLocationIds(ids: readonly ElementId[]): Map<ElementId, SourceLocationId | null>;
  };
};

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
      // Source-reliability metadata (T091) — the badge + uncertainty note.
      sourceType: row?.source.sourceType ?? null,
      reliabilityTier: row?.source.reliabilityTier ?? null,
      confidence: row?.source.confidence ?? null,
      reliabilityNotes: row?.source.reliabilityNotes ?? null,
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
    // Source-reliability metadata (T091) — inherited from the owning source so a card's
    // refblock carries its source's reliability (the "reliability on important cards"
    // surfacing). A soft-deleted/missing source leaves these `null` (no badge).
    sourceType: provenance?.source.sourceType ?? null,
    reliabilityTier: provenance?.source.reliabilityTier ?? null,
    confidence: provenance?.source.confidence ?? null,
    reliabilityNotes: provenance?.source.reliabilityNotes ?? null,
  };
}

/**
 * Batched twin of {@link resolveSourceRef} — resolves {@link SourceRef} for many
 * elements in a constant number of DB round-trips (one per table), replacing per-row
 * `resolveSourceRef` in list/search paths.
 *
 * Mirrors `resolveSourceRef`'s branching exactly:
 *  - source elements → provenance from `sources` table keyed by their own id.
 *  - extract/card elements → location anchor from `source_locations` by elementId;
 *    cards fall back to `cards.source_location_id` when no direct location row exists.
 *  - Both non-source types → owning source element + its provenance.
 *
 * Elements missing from the live set (unknown / soft-deleted) are absent from the
 * returned map (matching `resolveSourceRef` returning `null`). Empty `ids` → empty map.
 */
export function resolveSourceRefMany(
  repos: SourceRefManyRepos,
  ids: readonly ElementId[],
): Map<ElementId, SourceRef> {
  if (ids.length === 0) return new Map();

  // Step 1: batch-read all live elements.
  const liveEls = repos.elements.findManyLive(ids);
  if (liveEls.length === 0) return new Map();

  const elMap = new Map<ElementId, Element>(liveEls.map((e) => [e.id, e]));

  // Partition by type to batch reads appropriately.
  const sourceIds: ElementId[] = [];
  const nonSourceIds: ElementId[] = [];
  const cardIds: ElementId[] = [];

  for (const el of liveEls) {
    if (el.type === "source") {
      sourceIds.push(el.id);
    } else {
      nonSourceIds.push(el.id);
      if (el.type === "card") cardIds.push(el.id);
    }
  }

  // Step 2: batch-read source provenance for source-type elements (and for the
  // owning source elements of non-source elements — collected after step 3).
  const sourceProvenanceMap =
    sourceIds.length > 0
      ? repos.sources.findManyById(sourceIds)
      : new Map<ElementId, SourceWithElement>();

  // Step 3: batch-read source_locations by elementId for non-source elements.
  const locationByElementMap =
    nonSourceIds.length > 0
      ? repos.sources.findLocationsByElementIds(nonSourceIds)
      : new Map<ElementId, ElementLocation>();

  // Step 4: for cards that had no direct location, batch-read cards.sourceLocationId,
  // then batch-read those source_location rows by id.
  const cardLocationIdMap =
    cardIds.length > 0
      ? repos.review.findCardSourceLocationIds(cardIds)
      : new Map<ElementId, SourceLocationId | null>();

  const fallbackLocationIds: SourceLocationId[] = [];
  for (const cardId of cardIds) {
    if (!locationByElementMap.has(cardId)) {
      const locId = cardLocationIdMap.get(cardId) ?? null;
      if (locId) fallbackLocationIds.push(locId);
    }
  }

  const locationByIdMap =
    fallbackLocationIds.length > 0
      ? repos.sources.findLocationsByIds(fallbackLocationIds)
      : new Map<SourceLocationId, ElementLocation>();

  // Step 5: collect unique owning source ids for non-source elements.
  const owningSourceIdSet = new Set<ElementId>();
  for (const el of liveEls) {
    if (el.type !== "source" && el.sourceId) owningSourceIdSet.add(el.sourceId as ElementId);
  }
  const owningSourceIds = [...owningSourceIdSet];

  // Batch-read the owning source elements + their provenance (they may or may not
  // be live — we need to know their deletedAt to degrade calmly).
  // Use findManyLive for the element rows (only live sources get title/provenance).
  const owningSourceElMap =
    owningSourceIds.length > 0
      ? new Map<ElementId, Element>(
          repos.elements.findManyLive(owningSourceIds).map((e) => [e.id, e]),
        )
      : new Map<ElementId, Element>();

  // Owning source provenance (for non-source elements whose source is live).
  const liveOwningSourceIds = [...owningSourceElMap.keys()];
  const owningProvenanceMap =
    liveOwningSourceIds.length > 0
      ? repos.sources.findManyById(liveOwningSourceIds)
      : new Map<ElementId, SourceWithElement>();

  // Step 6: assemble results, mirroring resolveSourceRef's per-element branching.
  const out = new Map<ElementId, SourceRef>();

  for (const id of ids) {
    const el = elMap.get(id);
    if (!el) continue; // missing or soft-deleted → absent from map

    if (el.type === "source") {
      const prov = sourceProvenanceMap.get(id);
      out.set(id, {
        sourceElementId: id,
        sourceTitle: el.title,
        url: prov?.source.url ?? null,
        author: prov?.source.author ?? null,
        publishedAt: prov?.source.publishedAt ?? null,
        locationLabel: null,
        snippet: null,
        sourceType: prov?.source.sourceType ?? null,
        reliabilityTier: prov?.source.reliabilityTier ?? null,
        confidence: prov?.source.confidence ?? null,
        reliabilityNotes: prov?.source.reliabilityNotes ?? null,
      });
      continue;
    }

    // extract / card
    let location: ElementLocation | null = locationByElementMap.get(id) ?? null;
    if (!location && el.type === "card") {
      const locId = cardLocationIdMap.get(id) ?? null;
      if (locId) location = locationByIdMap.get(locId) ?? null;
    }

    const sourceId = (el.sourceId as ElementId | null) ?? null;
    const liveSourceEl = sourceId ? (owningSourceElMap.get(sourceId) ?? null) : null;
    const provenance = liveSourceEl ? (owningProvenanceMap.get(liveSourceEl.id) ?? null) : null;

    out.set(id, {
      sourceElementId: liveSourceEl?.id ?? null,
      sourceTitle: liveSourceEl?.title ?? null,
      url: provenance?.source.url ?? null,
      author: provenance?.source.author ?? null,
      publishedAt: provenance?.source.publishedAt ?? null,
      locationLabel: location?.label ?? null,
      snippet: location?.selectedText ?? null,
      sourceType: provenance?.source.sourceType ?? null,
      reliabilityTier: provenance?.source.reliabilityTier ?? null,
      confidence: provenance?.source.confidence ?? null,
      reliabilityNotes: provenance?.source.reliabilityNotes ?? null,
    });
  }

  return out;
}
