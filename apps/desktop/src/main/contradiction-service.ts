/**
 * ContradictionService (T089) — the main-side resolver for the pure-core
 * {@link detectContradictions} heuristic.
 *
 * `findForElement(elementId)` builds the candidate pairs the heuristic needs:
 *  1. resolve the element's own vector (gated on local vec/model availability; when
 *     unavailable it returns `[]` and the surface hides);
 *  2. run a `vec0` KNN for highly-similar SAME/compatible-type neighbors;
 *  3. for the element + each neighbor, resolve the embedded text
 *     (`EmbeddingService.buildText`) and the source dates via lineage
 *     (`resolveSourceRef` → the owning source's `publishedAt`/`accessedAt`);
 *  4. call {@link detectContradictions} and enrich each flag with the neighbor's
 *     title + {@link SourceRef} for the calm "possible conflict" surface.
 *
 * Load-bearing constraints (CLAUDE.md + the T089 spec):
 *  - **Heuristic + suggestive, NEVER authoritative.** It NEVER edits, suspends,
 *    reschedules, or merges anything. It is an idempotent READ.
 *  - **No writes.** No `operation_log` entry, no persisted "conflict" relation (the
 *    closed `RELATION_TYPES` set does not grow — this is a DERIVED read, like T088).
 *    Lineage is untouched.
 *  - **Needs semantics on.** The high-similarity gate needs the `vec0` store; with it
 *    off this returns `[]` so the renderer hides the surface (graceful degrade, never
 *    a throw).
 *  - **Excludes soft-deleted neighbors** (the KNN already filters `deleted_at IS NULL`).
 *  - **Built for T090/T091 enrichment** — the per-side input takes its dates as data,
 *    so later tasks enrich the signals without changing this shape.
 *
 * The renderer reaches this only through the typed `semantic.contradictions`
 * `window.appApi`; no vectors cross IPC (only ids/titles/refs/reasons).
 */

import {
  CONTRADICTION_SIMILARITY_MIN,
  type ContradictionFlag,
  type ContradictionPair,
  type ContradictionSide,
  detectContradictions,
  type ElementId,
  type SourceRef,
} from "@interleave/core";
import { distanceToSimilarity, type EmbeddableType, type Repositories } from "@interleave/local-db";

/**
 * How many comparable (card/extract) candidate pairs to build at most. The KNN
 * window itself is widened to {@link NEIGHBOR_FETCH_LIMIT} so that non-comparable
 * (`source`) neighbors ranking above the comparable ones can't crowd a genuine
 * conflict out of this cap — we scan the wider pool, then keep up to this many
 * comparable hits (mirrors the T088 over-fetch idiom).
 */
const COMPARABLE_PAIR_LIMIT = 8;
/** The wider neighbor pool we scan to fill {@link COMPARABLE_PAIR_LIMIT}. */
const NEIGHBOR_FETCH_LIMIT = 25;

/** The element types contradiction detection compares (claims live on cards + extracts). */
const COMPARABLE_TYPES: ReadonlySet<EmbeddableType> = new Set(["card", "extract"]);

/**
 * A resolved contradiction flag, enriched for the UI. Carries the OTHER element's
 * id/type/title + its {@link SourceRef} (for the compare view's two-source display)
 * plus the heuristic's reasons/severity/newerSide. The "self" side is always the
 * queried element; `other` is the conflicting neighbor.
 */
export interface ContradictionFlagView {
  /** The conflicting neighbor's element id. */
  readonly otherId: string;
  readonly otherType: EmbeddableType;
  readonly otherTitle: string;
  /** The neighbor's source reference (refblock) for the compare view, or `null`. */
  readonly otherRef: SourceRef | null;
  /** The queried element's own source reference, for the side-by-side compare. */
  readonly selfRef: SourceRef | null;
  readonly reasons: readonly ContradictionFlag["reasons"][number][];
  readonly severity: ContradictionFlag["severity"];
  /**
   * `self` when the queried element's source is the newer one, `other` when the
   * neighbor's is, `null` when recency did not fire. (Mapped from the heuristic's
   * `a`/`b`, where `a` is always the queried element.)
   */
  readonly newerSide: "self" | "other" | null;
}

/** The narrow slice {@link ContradictionService} composes (testable in isolation). */
export interface ContradictionDeps {
  readonly repositories: Repositories;
  /** Resolve the pure text that was embedded for an element (the signal source). */
  readonly buildText: (elementId: ElementId) => { type: EmbeddableType; text: string } | null;
  /** Resolve an element's {@link SourceRef} (refblock) via lineage, or `null`. */
  readonly resolveRef: (id: ElementId) => SourceRef | null;
  /** Whether `sqlite-vec` `vec0` is loaded + functional on this connection. */
  readonly vecAvailable: boolean;
  /** Whether semantic vector lookups are available for this service instance. */
  readonly semanticEnabled: () => boolean;
}

export class ContradictionService {
  constructor(private readonly deps: ContradictionDeps) {}

  /**
   * The possible-conflict flags for `elementId` — highly-similar neighbors that also
   * carry an opposing/superseding signal. Returns `[]` when semantic vector lookup is
   * unavailable / `vec0` is absent / the element isn't a comparable type / isn't embedded. An
   * idempotent read; writes nothing.
   */
  findForElement(elementId: ElementId): ContradictionFlagView[] {
    if (!this.deps.vecAvailable || !this.deps.semanticEnabled()) return [];

    const self = this.deps.repositories.elements.findById(elementId);
    if (!self || self.deletedAt) return [];
    if (!COMPARABLE_TYPES.has(self.type as EmbeddableType)) return [];

    const ownEmbedding = this.deps.repositories.embeddings.getVectorRecord(elementId);
    if (!ownEmbedding) return [];

    const selfText = this.deps.buildText(elementId);
    if (!selfText) return [];

    // High-similarity neighbors of the element's own vector. Scan a wide pool so
    // non-comparable (`source`) neighbors can't crowd a comparable conflict out of
    // the COMPARABLE_PAIR_LIMIT cap applied in the loop below.
    const neighbors = this.deps.repositories.embeddings.knn(ownEmbedding.vector, {
      limit: NEIGHBOR_FETCH_LIMIT,
      modelId: ownEmbedding.modelId,
      excludeElementId: elementId,
    });

    const selfDates = this.sourceDates(elementId);
    const selfSide: ContradictionSide = {
      id: elementId,
      type: selfText.type === "card" ? "card" : "extract",
      text: selfText.text,
      sourcePublishedAt: selfDates.publishedAt,
      sourceAccessedAt: selfDates.accessedAt,
    };

    // Build one candidate pair per comparable, embedded neighbor (capped).
    const pairs: ContradictionPair[] = [];
    const neighborById = new Map<string, { type: EmbeddableType }>();
    for (const hit of neighbors) {
      if (pairs.length >= COMPARABLE_PAIR_LIMIT) break;
      if (!COMPARABLE_TYPES.has(hit.type)) continue;
      const similarity = distanceToSimilarity(hit.distance);
      // Skip work below the gate (the heuristic gates too, but this avoids the text +
      // date resolution for clearly-unrelated neighbors).
      if (!(similarity >= CONTRADICTION_SIMILARITY_MIN)) continue;

      const neighborText = this.deps.buildText(hit.elementId);
      if (!neighborText) continue;

      const dates = this.sourceDates(hit.elementId);
      pairs.push({
        a: selfSide,
        b: {
          id: hit.elementId,
          type: hit.type === "card" ? "card" : "extract",
          text: neighborText.text,
          sourcePublishedAt: dates.publishedAt,
          sourceAccessedAt: dates.accessedAt,
        },
        similarity,
      });
      neighborById.set(hit.elementId, { type: hit.type });
    }

    const flags = detectContradictions(pairs);

    // Enrich each flag for the calm conflict surface. `a` is always the queried
    // element (`self`); `b` is the conflicting neighbor (`other`).
    const selfRef = this.deps.resolveRef(elementId);
    return flags.map((flag) => {
      const otherId = flag.bId;
      const otherEl = this.deps.repositories.elements.findById(otherId as ElementId);
      const neighbor = neighborById.get(otherId);
      const newerSide = flag.newerSide === "a" ? "self" : flag.newerSide === "b" ? "other" : null;
      return {
        otherId,
        otherType: (neighbor?.type ?? "extract") as EmbeddableType,
        otherTitle: otherEl?.title ?? "",
        otherRef: this.deps.resolveRef(otherId as ElementId),
        selfRef,
        reasons: flag.reasons,
        severity: flag.severity,
        newerSide,
      };
    });
  }

  /**
   * Resolve an element's owning-source dates via lineage. Uses `resolveSourceRef` to
   * find the owning source element, then reads the source row for `accessedAt`
   * (`resolveSourceRef` only exposes `publishedAt`). Best-effort: a source-less /
   * undated element returns `{ null, null }`, never a throw.
   */
  private sourceDates(elementId: ElementId): {
    publishedAt: string | null;
    accessedAt: string | null;
  } {
    const ref = this.deps.resolveRef(elementId);
    const sourceElementId = ref?.sourceElementId ?? null;
    if (!sourceElementId) {
      return { publishedAt: ref?.publishedAt ?? null, accessedAt: null };
    }
    const source = this.deps.repositories.sources.findById(sourceElementId as ElementId);
    return {
      publishedAt: source?.source.publishedAt ?? ref?.publishedAt ?? null,
      accessedAt: source?.source.accessedAt ?? null,
    };
  }
}
