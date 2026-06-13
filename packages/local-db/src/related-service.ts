/**
 * RelatedService (T088) — DERIVED related-item suggestions for an element.
 *
 * Given a selected element it produces four buckets, surfaced in the inspector's
 * "Related" section:
 *
 *  1. **similar extracts** — `vec0` nearest-neighbors of type `extract` of the
 *     element's own stored vector (mapped distance → a 0..1 similarity);
 *  2. **possible duplicates** — the nearest SAME-type neighbors whose distance is
 *     below {@link DUPLICATE_DISTANCE_THRESHOLD} (a tuned, high-confidence cutoff),
 *     flagged distinctly so the UI styles them as "possible duplicate — review";
 *  3. **prerequisite concepts** — the element's member concepts PLUS their parent
 *     chain (`concepts.parentConceptId`), the ancestors first (more general →
 *     learn first), each with a hierarchy `level` (0 = a direct member, 1+ = an
 *     ancestor). Works without vec/model availability (pure concept hierarchy);
 *  4. **sibling sources** — `source` elements that share at least one
 *     `concept_membership` concept with the element, ordered by vector similarity
 *     when available else by shared-concept count. Works without vec/model availability.
 *
 * EVERYTHING here is a DERIVED READ over the T087 `vec0` store + the existing
 * `element_relations` / `concepts` lineage graph:
 *  - it NEVER writes `element_relations` (the closed `RELATION_TYPES` set does not
 *    grow — related/duplicate/prerequisite are NOT new relation members),
 *  - it appends NO `operation_log` entry (it mutates nothing),
 *  - it NEVER mutates lineage,
 *  - it excludes the element itself + soft-deleted elements.
 *
 * It degrades gracefully: when vec/model capability is unavailable or the element is
 * not embedded, the vector buckets (`similar`, `duplicates`) return `[]` with
 * `semanticAvailable: false`, while the concept + sibling-source buckets still
 * resolve from lineage. It never throws on a degraded store.
 *
 * The renderer reaches this only through the typed `semantic.related`
 * `window.appApi`; no vectors cross IPC (only ids/titles/similarities).
 */

import type { ElementId, SourceRef } from "@interleave/core";
import type { ConceptRepository, ConceptSummary } from "./concept-repository";
import type { ElementRepository } from "./element-repository";
import type { EmbeddableType, EmbeddingRepository, KnnHit } from "./embedding-repository";

/**
 * The cosine/L2 `vec0` distance below which two SAME-type elements are flagged a
 * "possible duplicate". A deliberately CONSERVATIVE (small) cutoff: we err toward
 * fewer false duplicate flags — a near-identical re-import or a re-worded extract —
 * and let the `similar` bucket carry everything above it. It is SUGGESTIVE (a flag
 * the user reviews), never an automatic merge. The default model's L2 distance over
 * unit-normalized vectors ranges ~0 (identical) .. ~2 (opposite); 0.15 corresponds
 * to a cosine similarity ~0.99.
 */
export const DUPLICATE_DISTANCE_THRESHOLD = 0.15;

/** How many neighbors each vector bucket fetches before the post-filter. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

/** A related element (a similar extract, a possible duplicate, or a sibling source). */
export interface RelatedItem {
  readonly id: ElementId;
  readonly type: EmbeddableType;
  readonly title: string;
  /** A 0..1 similarity derived from the `vec0` distance, when vector-ranked; else absent. */
  readonly similarity?: number;
  /** `similar` for a near neighbor, `duplicate` for a below-threshold near-identical one. */
  readonly kind: "similar" | "duplicate";
  /** The originating source reference (refblock), when resolvable. */
  readonly ref?: SourceRef;
}

/** A prerequisite/ancestor concept with its hierarchy level (0 = a direct member). */
export interface RelatedConcept {
  readonly id: ElementId;
  readonly name: string;
  /** 0 = a direct member concept; 1+ = a parent/ancestor (more general → learn first). */
  readonly level: number;
}

/** The four derived buckets + whether the vector buckets actually ran. */
export interface RelatedResult {
  readonly similar: readonly RelatedItem[];
  readonly duplicates: readonly RelatedItem[];
  readonly prerequisiteConcepts: readonly RelatedConcept[];
  readonly siblingSources: readonly RelatedItem[];
  /** False when `vec0` is absent / the element is not embedded. */
  readonly semanticAvailable: boolean;
}

/** Options narrowing a {@link RelatedService.related} read. */
export interface RelatedOptions {
  readonly limit?: number;
  /** Semantic capability gate — when false this is a lineage-only read. */
  readonly semanticEnabled: boolean;
}

/** The narrow repository slice {@link RelatedService} composes. */
export interface RelatedDeps {
  readonly elements: ElementRepository;
  readonly concepts: ConceptRepository;
  readonly embeddings: EmbeddingRepository;
  /** Resolve an element's {@link SourceRef} (the refblock), or `null` (orphan). */
  readonly resolveRef: (id: ElementId) => SourceRef | null;
}

/**
 * Map a `vec0` distance (L2 over unit-normalized vectors, lower = nearer) to a 0..1
 * similarity for display. `distance == 0` → `1`; the score decays linearly and is
 * clamped to `[0, 1]` so a far neighbor reads `0` rather than a negative value. This
 * is a DISPLAY transform only — ranking always uses the raw distance.
 */
export function distanceToSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  // L2 over unit vectors: d^2 = 2(1 - cos). similarity ≈ cos = 1 - d^2/2.
  const sim = 1 - (distance * distance) / 2;
  return sim < 0 ? 0 : sim > 1 ? 1 : sim;
}

export class RelatedService {
  constructor(private readonly deps: RelatedDeps) {}

  /**
   * The four derived related-item buckets for `elementId`. The vector buckets
   * (`similar`, `duplicates`) resolve only when semantics are enabled, `vec0` is
   * available, AND the element has a stored vector; otherwise they are `[]` and
   * `semanticAvailable` is `false`. The concept + sibling buckets ALWAYS resolve
   * from lineage (they work with semantics off). Returns empty buckets for an
   * unknown / soft-deleted element (never throws).
   */
  related(elementId: ElementId, options: RelatedOptions): RelatedResult {
    const element = this.deps.elements.findById(elementId);
    if (!element || element.deletedAt) {
      return {
        similar: [],
        duplicates: [],
        prerequisiteConcepts: [],
        siblingSources: [],
        semanticAvailable: false,
      };
    }

    const limit = clampLimit(options.limit);

    // The element's own stored vector — the seed for the KNN buckets. `null` when
    // vec/model capability is unavailable, `vec0` is absent, or the element is not
    // (yet) embedded.
    const ownEmbedding =
      options.semanticEnabled && this.deps.embeddings.available
        ? this.deps.embeddings.getVectorRecord(elementId)
        : null;
    const semanticAvailable = ownEmbedding != null;

    const { similar, duplicates } = semanticAvailable
      ? this.vectorBuckets(
          elementId,
          element.type,
          ownEmbedding.vector,
          ownEmbedding.modelId,
          limit,
        )
      : { similar: [] as RelatedItem[], duplicates: [] as RelatedItem[] };

    const prerequisiteConcepts = this.prerequisiteConcepts(elementId);
    const siblingSources = this.siblingSources(
      elementId,
      ownEmbedding?.vector ?? null,
      ownEmbedding?.modelId ?? null,
      limit,
    );

    return { similar, duplicates, prerequisiteConcepts, siblingSources, semanticAvailable };
  }

  /**
   * The two vector buckets from ONE KNN over the element's own vector:
   *  - `similar`: nearest neighbors of type `extract` (the spec's "similar
   *    extracts"), excluding the element itself + soft-deleted (the repo already
   *    filters soft-deleted);
   *  - `duplicates`: nearest neighbors of the SAME type as the element whose
   *    distance is below {@link DUPLICATE_DISTANCE_THRESHOLD}.
   * A duplicate is NOT also listed under `similar` (a below-threshold same-type
   * neighbor is the higher-signal "duplicate" flag).
   */
  private vectorBuckets(
    elementId: ElementId,
    elementType: string,
    ownVector: readonly number[],
    modelId: string,
    limit: number,
  ): { similar: RelatedItem[]; duplicates: RelatedItem[] } {
    // Over-fetch a broad neighbor pool once; partition it into the two buckets.
    const neighbors = this.deps.embeddings.knn(ownVector, {
      limit: Math.min(limit * 3, MAX_LIMIT * 3),
      modelId,
      excludeElementId: elementId,
    });

    const duplicateIds = new Set<ElementId>();
    const duplicates: RelatedItem[] = [];
    for (const hit of neighbors) {
      if (hit.type !== elementType) continue;
      if (hit.distance >= DUPLICATE_DISTANCE_THRESHOLD) continue;
      duplicates.push(this.toItem(hit, "duplicate"));
      duplicateIds.add(hit.elementId);
      if (duplicates.length >= limit) break;
    }

    const similar: RelatedItem[] = [];
    for (const hit of neighbors) {
      if (hit.type !== "extract") continue;
      if (duplicateIds.has(hit.elementId)) continue; // a duplicate is not also "similar"
      similar.push(this.toItem(hit, "similar"));
      if (similar.length >= limit) break;
    }

    return { similar, duplicates };
  }

  /** Build a {@link RelatedItem} from a KNN hit (title + ref from the live element). */
  private toItem(hit: KnnHit, kind: "similar" | "duplicate"): RelatedItem {
    const el = this.deps.elements.findById(hit.elementId);
    const ref = this.deps.resolveRef(hit.elementId);
    return {
      id: hit.elementId,
      type: hit.type,
      title: el?.title ?? "",
      similarity: distanceToSimilarity(hit.distance),
      kind,
      ...(ref ? { ref } : {}),
    };
  }

  /**
   * The prerequisite/ancestor concepts: the element's member concepts (`level 0`)
   * plus each member concept's parent chain walked up via `parentConceptId`
   * (`level 1+`), ANCESTORS first (more general → learn first), deduped by concept
   * id (the shallowest level wins). Pure concept hierarchy — works with semantics
   * off. Cycles are guarded by a visited set.
   */
  private prerequisiteConcepts(elementId: ElementId): RelatedConcept[] {
    const members = this.deps.concepts.conceptsForElement(elementId);
    if (members.length === 0) return [];

    // Build a level map: shallowest (smallest) level wins for a shared ancestor.
    const byId = new Map<ElementId, ConceptSummary>();
    const level = new Map<ElementId, number>();

    for (const member of members) {
      let current: ConceptSummary | null = member;
      let depth = 0;
      const seen = new Set<ElementId>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        byId.set(current.id, current);
        const existing = level.get(current.id);
        if (existing === undefined || depth < existing) level.set(current.id, depth);
        const parentId: ElementId | null = current.parentConceptId;
        current = parentId ? this.deps.concepts.findById(parentId) : null;
        depth += 1;
      }
    }

    return (
      [...level.entries()]
        .map(([id, lvl]) => {
          const summary = byId.get(id);
          return { id, name: summary?.name ?? "", level: lvl };
        })
        // Ancestors (higher level) first — most general first ("learn first"); ties by name.
        .sort((a, b) => (b.level !== a.level ? b.level - a.level : a.name.localeCompare(b.name)))
    );
  }

  /**
   * Sibling sources: `source` elements sharing ≥1 `concept_membership` concept with
   * the element, ordered by vector similarity to the element when its own vector is
   * available, else by shared-concept count (desc) then title. Excludes the element
   * itself + soft-deleted (the concept reads already filter soft-deleted members).
   * Works with semantics off.
   */
  private siblingSources(
    elementId: ElementId,
    ownVector: readonly number[] | null,
    modelId: string | null,
    limit: number,
  ): RelatedItem[] {
    const memberConcepts = this.deps.concepts.conceptsForElement(elementId);
    if (memberConcepts.length === 0) return [];

    // Count shared concepts per candidate source (a source can share several).
    const sharedCount = new Map<ElementId, number>();
    for (const concept of memberConcepts) {
      for (const memberId of this.deps.concepts.elementsForConcept(concept.id)) {
        if (memberId === elementId) continue;
        const el = this.deps.elements.findById(memberId);
        if (!el || el.deletedAt || el.type !== "source") continue;
        sharedCount.set(memberId, (sharedCount.get(memberId) ?? 0) + 1);
      }
    }
    if (sharedCount.size === 0) return [];

    // Distance to each candidate source when we can rank by vector (else NaN).
    const distanceOf = new Map<ElementId, number>();
    if (ownVector && modelId) {
      const knn = this.deps.embeddings.knn(ownVector, {
        limit: MAX_LIMIT * 2,
        modelId,
        type: "source",
        excludeElementId: elementId,
      });
      for (const hit of knn) distanceOf.set(hit.elementId, hit.distance);
    }

    const candidates = [...sharedCount.keys()];
    candidates.sort((a, b) => {
      const da = distanceOf.get(a);
      const db = distanceOf.get(b);
      // Both ranked by vector → nearer first.
      if (da !== undefined && db !== undefined) return da - db;
      // A ranked one beats an unranked one (a vector neighbor is the stronger signal).
      if (da !== undefined) return -1;
      if (db !== undefined) return 1;
      // Neither ranked → more shared concepts first, then title.
      const sa = sharedCount.get(a) ?? 0;
      const sb = sharedCount.get(b) ?? 0;
      if (sa !== sb) return sb - sa;
      const ta = this.deps.elements.findById(a)?.title ?? "";
      const tb = this.deps.elements.findById(b)?.title ?? "";
      return ta.localeCompare(tb);
    });

    return candidates.slice(0, limit).map((id) => {
      const el = this.deps.elements.findById(id);
      const ref = this.deps.resolveRef(id);
      const distance = distanceOf.get(id);
      return {
        id,
        type: "source" as const,
        title: el?.title ?? "",
        ...(distance !== undefined ? { similarity: distanceToSimilarity(distance) } : {}),
        kind: "similar" as const,
        ...(ref ? { ref } : {}),
      };
    });
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_LIMIT);
}
