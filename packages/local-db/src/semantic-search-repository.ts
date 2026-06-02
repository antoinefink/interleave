/**
 * SemanticSearchRepository (T087) — the FTS + vector FUSION layer.
 *
 * On-device semantic search answers a query by combining two ranked lists:
 *  1. the existing FTS5 keyword hits ({@link SearchRepository.search}, T042), and
 *  2. the `sqlite-vec` KNN nearest-neighbors ({@link EmbeddingRepository.knn}) of
 *     the query's embedding,
 * fused with RECIPROCAL-RANK FUSION (RRF) so a purely-semantic neighbor with NO
 * keyword overlap still surfaces ("spaced repetition" finding a card about "review
 * intervals"). The whole feature is OFF BY DEFAULT and degrades cleanly:
 *
 *  - when `semanticEnabled` is false, `vec0` is unavailable, or no query vector
 *    was produced → it returns the FTS hits mapped to {@link FusedHit} (uniform
 *    surface, `mode: "fts"`), and NEVER throws.
 *
 * Query embedding rides the job runner (the model lives only in the DB-free
 * worker), so this layer does NOT embed the query itself — the caller passes the
 * pre-computed `queryVector` (the DB service's `embedQuery`, which enqueues a
 * transient `persist:false` embed job and recovers the vector via a main-side
 * map). This repository is pure SQLite + math: it fuses, dedupes, and ranks.
 *
 * It is READ-ONLY (appends nothing to the operation log) and excludes soft-deleted
 * elements (both underlying reads already do).
 */

import type { ElementId, ElementType } from "@interleave/core";
import type { EmbeddableType, EmbeddingRepository, KnnHit } from "./embedding-repository";
import type { SearchHit, SearchRepository } from "./search-repository";

/** The RRF constant: a larger `k` flattens the rank weighting (60 is the common default). */
export const RRF_K = 60;

/** A fused hit: a uniform row for both keyword and semantic matches. */
export interface FusedHit {
  readonly id: ElementId;
  readonly type: EmbeddableType;
  readonly title: string;
  readonly snippet: string;
  /** The FTS `bm25` rank (lower better), when this element matched the keyword index. */
  readonly ftsScore?: number;
  /** The `vec0` distance (lower nearer), when this element was a semantic neighbor. */
  readonly vecDistance?: number;
  /** Which list(s) produced this hit, so the UI can label purely-semantic rows. */
  readonly source: "fts" | "semantic" | "both";
  /** The fused RRF score (higher is a better combined match) — for ordering/debug. */
  readonly fusedScore: number;
}

/** Options for {@link SemanticSearchRepository.search}. */
export interface FusedSearchOptions {
  readonly limit?: number;
  readonly type?: ElementType;
  /** The `semanticSearchEnabled` setting — when false, this is pure FTS. */
  readonly semanticEnabled: boolean;
  /**
   * The pre-computed query embedding (from the runner). `null`/omitted → FTS-only,
   * the graceful degrade when the model is off/absent or the embed job timed out.
   */
  readonly queryVector?: readonly number[] | null;
}

/** Which retrieval modes actually ran, surfaced to the UI. */
export type FusedMode = "semantic" | "fts" | "disabled";

/** The fused result + the mode telling the UI whether semantics ran. */
export interface FusedSearchResult {
  readonly hits: FusedHit[];
  readonly mode: FusedMode;
}

const DEFAULT_LIMIT = 50;

export class SemanticSearchRepository {
  constructor(
    private readonly searchRepo: SearchRepository,
    private readonly embeddings: EmbeddingRepository,
  ) {}

  /**
   * Fused search. Always runs FTS; additionally runs the `vec0` KNN and fuses with
   * RRF when semantics are enabled, `vec0` is available, and a query vector was
   * produced. Returns the ranked, deduped, capped {@link FusedHit}s + the `mode`.
   * Degrades to FTS-only (never throws) on any disabled/absent/missing-vector
   * condition.
   */
  search(query: string, options: FusedSearchOptions): FusedSearchResult {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const ftsHits = this.searchRepo.search(query, {
      ...(options.type ? { type: options.type } : {}),
      // Over-fetch FTS so the fusion has a deep pool to rank from before the cap.
      limit: Math.min(Math.max(limit * 2, limit), 200),
    });

    const canSemantic =
      options.semanticEnabled &&
      this.embeddings.available &&
      options.queryVector != null &&
      options.queryVector.length > 0;

    if (!canSemantic) {
      // FTS-only degrade: map keyword hits to the uniform fused shape.
      const hits = ftsHits.slice(0, limit).map((h, idx) => ftsOnlyHit(h, idx));
      return { hits, mode: options.semanticEnabled ? "fts" : "disabled" };
    }

    const knnHits = this.embeddings.knn(options.queryVector as number[], {
      limit: Math.min(Math.max(limit * 2, limit), 200),
      ...(isEmbeddable(options.type) ? { type: options.type } : {}),
    });

    const fused = fuse(ftsHits, knnHits, limit);
    return { hits: fused, mode: "semantic" };
  }
}

/** Map a pure FTS hit (no semantic match) to a {@link FusedHit}. */
function ftsOnlyHit(h: SearchHit, rank: number): FusedHit {
  return {
    id: h.id,
    type: h.type,
    title: h.title,
    snippet: h.snippet,
    ftsScore: h.score,
    source: "fts",
    fusedScore: 1 / (RRF_K + rank),
  };
}

/** Whether a type narrows to an embeddable (KNN-able) type. */
function isEmbeddable(type: ElementType | undefined): type is EmbeddableType {
  return type === "source" || type === "extract" || type === "card";
}

/**
 * Reciprocal-rank fusion: `score = Σ 1/(RRF_K + rank)` across the FTS and KNN
 * lists (rank is 0-based within each list), keyed per element. The title/snippet
 * come from the FTS hit when present, else are synthesized from the semantic
 * neighbor (the caller enriches title/snippet downstream from the element row, so
 * a placeholder is fine — but we carry the FTS title/snippet when we have it).
 * Deduped per element, sorted by the fused score (desc), capped to `limit`.
 */
function fuse(
  ftsHits: readonly SearchHit[],
  knnHits: readonly KnnHit[],
  limit: number,
): FusedHit[] {
  const byId = new Map<string, FusedHit>();

  ftsHits.forEach((h, rank) => {
    byId.set(h.id, {
      id: h.id,
      type: h.type,
      title: h.title,
      snippet: h.snippet,
      ftsScore: h.score,
      source: "fts",
      fusedScore: 1 / (RRF_K + rank),
    });
  });

  knnHits.forEach((h, rank) => {
    const contribution = 1 / (RRF_K + rank);
    const existing = byId.get(h.elementId);
    if (existing) {
      byId.set(h.elementId, {
        ...existing,
        vecDistance: h.distance,
        source: "both",
        fusedScore: existing.fusedScore + contribution,
      });
    } else {
      byId.set(h.elementId, {
        id: h.elementId,
        type: h.type,
        // Purely-semantic hit: no FTS title/snippet — the caller enriches both from
        // the element row. Empty placeholders keep the shape uniform.
        title: "",
        snippet: "",
        vecDistance: h.distance,
        source: "semantic",
        fusedScore: contribution,
      });
    }
  });

  return [...byId.values()].sort((a, b) => b.fusedScore - a.fusedScore).slice(0, limit);
}
