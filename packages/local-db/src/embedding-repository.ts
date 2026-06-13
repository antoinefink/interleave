/**
 * EmbeddingRepository (T087) — the main-owned single writer/reader for the
 * on-device semantic-search vector store.
 *
 * The DB-free worker computes a plain `number[]` vector and posts it back; THIS
 * repository (in main) writes it into the `sqlite-vec` `element_vectors` (`vec0`)
 * virtual table + the `embeddings` bookkeeping sidecar, and runs the KNN. The
 * worker NEVER opens the DB or loads `sqlite-vec` — single-writer SQLite stays
 * main-owned.
 *
 * Embeddings are a DERIVED index (like FTS5): every write here appends **NO
 * `operation_log` entry** (the closed `OPERATION_TYPES` set does not grow), and the
 * whole store is rebuildable from the base tables by a re-index. This mirrors
 * `JobsRepository`/`AssetRepository` (infra, not a domain mutation).
 *
 * Everything degrades gracefully when `vec0` is not available: the repository is
 * constructed with a `vecAvailable` flag; when `false`, `knn` returns `[]` and
 * `upsert` is a no-op guarded write (so a stray enqueue on a vec-absent host never
 * throws). The owning service additionally gates enqueues on the
 * local vec/model availability.
 */

import type { ElementId } from "@interleave/core";
import { EMBEDDING_DIM, type Embedding } from "@interleave/core";
import { embeddings, type InterleaveDatabase, vectorToBlob } from "@interleave/db";
import { eq, sql } from "drizzle-orm";
import { nowIso } from "./ids";

/** The element types that get embedded (the searchable types). */
export type EmbeddableType = "source" | "extract" | "card";

/** Arguments to {@link EmbeddingRepository.upsert}. */
export interface UpsertEmbeddingInput {
  readonly elementId: ElementId;
  readonly elementType: EmbeddableType;
  readonly modelId: string;
  readonly dim: number;
  readonly contentHash: string;
  /** The dense vector; its length MUST equal `dim` (validated here). */
  readonly vector: readonly number[];
}

/** A KNN neighbor: the live element id + type + the raw `vec0` distance (lower = nearer). */
export interface KnnHit {
  readonly elementId: ElementId;
  readonly type: EmbeddableType;
  readonly distance: number;
}

export interface StoredEmbeddingVector {
  readonly vector: number[];
  readonly modelId: string;
}

/** Options narrowing a {@link EmbeddingRepository.knn} query. */
export interface KnnOptions {
  readonly limit?: number;
  /** Restrict neighbors to a single element type. */
  readonly type?: EmbeddableType;
  /** Restrict neighbors to the embedding model that produced the query vector. */
  readonly modelId?: string;
  /** Exclude this element id from the results (e.g. the query's own element). */
  readonly excludeElementId?: ElementId;
}

/** Index coverage stats for the status surface. */
export interface EmbeddingStats {
  readonly embedded: number;
  readonly total: number;
  readonly modelId: string | null;
}

const DEFAULT_KNN_LIMIT = 10;
/** `vec0` KNN requires a finite `LIMIT k`; bound it so a caller can't ask for an unbounded scan. */
const MAX_KNN_LIMIT = 200;

export class EmbeddingRepository {
  /**
   * @param vecAvailable whether `sqlite-vec` `vec0` is loaded AND functional on
   *   this connection (the caller passes `vecFunctional(sqlite)` — the functional
   *   smoke test, not mere resolvability). When `false`, `knn` returns `[]` and
   *   `upsert` no-ops, so the repository never touches the absent `vec0` table.
   */
  constructor(
    private readonly db: InterleaveDatabase,
    private readonly vecAvailable: boolean,
  ) {}

  /** Whether the `vec0` store is usable on this connection. */
  get available(): boolean {
    return this.vecAvailable;
  }

  /**
   * Insert/replace an element's vector + bookkeeping row in ONE transaction.
   * Idempotent by `element_id`: a re-embed REUSES the existing `vec_rowid` (so the
   * `vec0` row is updated in place, never duplicated). At-least-once safe — a
   * crash-resume re-run UPSERTs the same vector. A no-op when `vecAvailable` is
   * `false`. Throws on a wrong-length vector (a model/dim mismatch must never reach
   * the fixed-dim column).
   */
  upsert(input: UpsertEmbeddingInput): void {
    if (!this.vecAvailable) return;
    if (input.vector.length !== input.dim) {
      throw new Error(
        `EmbeddingRepository.upsert: vector length ${input.vector.length} !== dim ${input.dim}`,
      );
    }
    if (input.dim !== EMBEDDING_DIM) {
      throw new Error(
        `EmbeddingRepository.upsert: dim ${input.dim} !== column dim ${EMBEDDING_DIM} ` +
          `(switching to a different-dim model needs a re-index + column change)`,
      );
    }
    const blob = vectorToBlob(input.vector);
    const now = nowIso();

    this.db.transaction((tx) => {
      // Reuse the existing vec_rowid on re-embed; else allocate the next rowid.
      const existing = tx
        .select({ vecRowid: embeddings.vecRowid })
        .from(embeddings)
        .where(eq(embeddings.elementId, input.elementId))
        .get();

      let vecRowid: number;
      if (existing) {
        vecRowid = existing.vecRowid;
        // `vec0` has no UPSERT; delete-then-insert the same rowid replaces the vector.
        // The rowid is a controlled integer we read back from `embeddings` — inline it
        // (`sql.raw`) because `vec0` requires an INTEGER LITERAL for its rowid PK, not a
        // bound parameter ("Only integers are allowed for primary key values").
        const ridLiteral = sql.raw(String(Math.trunc(vecRowid)));
        tx.run(sql`DELETE FROM element_vectors WHERE rowid = ${ridLiteral}`);
        tx.run(sql`INSERT INTO element_vectors(rowid, embedding) VALUES (${ridLiteral}, ${blob})`);
        tx.update(embeddings)
          .set({
            elementType: input.elementType,
            modelId: input.modelId,
            dim: input.dim,
            contentHash: input.contentHash,
            updatedAt: now,
          })
          .where(eq(embeddings.elementId, input.elementId))
          .run();
      } else {
        // Insert lets `vec0` allocate the rowid; read it from `lastInsertRowid`.
        // (`vec0` does NOT support `INSERT … RETURNING rowid` — it returns NULL —
        // so we rely on the driver's last-insert-rowid, captured inside the tx.)
        const info = tx.run(sql`INSERT INTO element_vectors(embedding) VALUES (${blob})`);
        vecRowid = Number(info.lastInsertRowid);
        tx.insert(embeddings)
          .values({
            elementId: input.elementId,
            vecRowid,
            elementType: input.elementType,
            modelId: input.modelId,
            dim: input.dim,
            contentHash: input.contentHash,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    });
  }

  /**
   * Whether `elementId` needs (re-)embedding: true when there is no row, or the
   * stored `content_hash`/`model_id` differs from the current ones. The
   * skip-if-unchanged gate — an unchanged element with the active model returns
   * `false` (no-op), a changed one or a model switch returns `true` (re-embed).
   * Returns `false` only when a matching, current row already exists.
   */
  needsEmbedding(elementId: ElementId, contentHash: string, modelId: string): boolean {
    if (!this.vecAvailable) return false;
    const row = this.db
      .select({ contentHash: embeddings.contentHash, modelId: embeddings.modelId })
      .from(embeddings)
      .where(eq(embeddings.elementId, elementId))
      .get();
    if (!row) return true;
    return row.contentHash !== contentHash || row.modelId !== modelId;
  }

  /** Whether `elementId` currently has a stored vector (used by related-item lookups). */
  has(elementId: ElementId): boolean {
    if (!this.vecAvailable) return false;
    const row = this.db
      .select({ elementId: embeddings.elementId })
      .from(embeddings)
      .where(eq(embeddings.elementId, elementId))
      .get();
    return row != null;
  }

  /**
   * Read an element's stored vector as a `number[]` (via `vec_to_json` →
   * `JSON.parse`), or `null` if not embedded / vec unavailable. Used by the
   * related-item suggestions (T088) to KNN from an element's own vector without
   * re-embedding it.
   */
  getVector(elementId: ElementId): number[] | null {
    return this.getVectorRecord(elementId)?.vector ?? null;
  }

  getVectorRecord(elementId: ElementId): StoredEmbeddingVector | null {
    if (!this.vecAvailable) return null;
    const row = this.db
      .select({ vecRowid: embeddings.vecRowid, modelId: embeddings.modelId })
      .from(embeddings)
      .where(eq(embeddings.elementId, elementId))
      .get();
    if (!row) return null;
    const vecRow = this.db.get<{ embedding: string }>(
      sql`SELECT vec_to_json(embedding) AS embedding FROM element_vectors WHERE rowid = ${row.vecRowid}`,
    );
    if (!vecRow) return null;
    try {
      const parsed = JSON.parse(String(vecRow.embedding));
      return Array.isArray(parsed) ? { vector: parsed as number[], modelId: row.modelId } : null;
    } catch {
      return null;
    }
  }

  /**
   * Remove an element's bookkeeping row AND its `element_vectors` rowid in ONE
   * transaction — the explicit, PORTABLE cleanup path (it never relies on a `vec0`
   * trigger, which some virtual-table builds restrict). Idempotent: deleting an
   * absent element is a no-op. A no-op when `vecAvailable` is `false`.
   */
  delete(elementId: ElementId): void {
    if (!this.vecAvailable) return;
    this.db.transaction((tx) => {
      const row = tx
        .select({ vecRowid: embeddings.vecRowid })
        .from(embeddings)
        .where(eq(embeddings.elementId, elementId))
        .get();
      if (!row) return;
      tx.run(
        sql`DELETE FROM element_vectors WHERE rowid = ${sql.raw(String(Math.trunc(row.vecRowid)))}`,
      );
      tx.delete(embeddings).where(eq(embeddings.elementId, elementId)).run();
    });
  }

  /**
   * K-nearest-neighbors over the `vec0` index for a query vector. Runs the `vec0`
   * `WHERE embedding MATCH :q ORDER BY distance LIMIT k` join back to `embeddings`
   * + live `elements` (`deleted_at IS NULL`), optionally narrowed by type and with
   * an element excluded. Returns `[]` when `vecAvailable` is `false` or the query
   * vector is the wrong length (graceful degrade, never a throw on a degraded
   * store). Over-fetches then filters so type/exclude/liveness narrowing still
   * returns up to `limit` neighbors.
   */
  knn(queryVector: readonly number[], options: KnnOptions = {}): KnnHit[] {
    if (!this.vecAvailable) return [];
    if (queryVector.length !== EMBEDDING_DIM) return [];
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_KNN_LIMIT), MAX_KNN_LIMIT);
    // `vec0`'s KNN LIMIT must be applied inside the MATCH; over-fetch a margin so the
    // post-filter (type/exclude/liveness) can still return up to `limit`.
    const kVec = Math.min(limit + 16, MAX_KNN_LIMIT + 16);
    const blob = vectorToBlob(queryVector);

    const rows = this.db.all<{
      id: string;
      type: EmbeddableType;
      distance: number;
    }>(sql`
      SELECT b.element_id AS id, b.element_type AS type, v.distance AS distance
      FROM (
        SELECT rowid, distance
        FROM element_vectors
        WHERE embedding MATCH ${blob}
        ${
          options.modelId
            ? sql`
              AND rowid IN (
                SELECT vec_rowid FROM embeddings WHERE model_id = ${options.modelId}
              )
            `
            : sql``
        }
        ORDER BY distance
        LIMIT ${kVec}
      ) v
      JOIN embeddings b ON b.vec_rowid = v.rowid
      JOIN elements e ON e.id = b.element_id AND e.deleted_at IS NULL
    `);

    const out: KnnHit[] = [];
    for (const row of rows) {
      if (options.type && row.type !== options.type) continue;
      if (options.excludeElementId && row.id === options.excludeElementId) continue;
      out.push({ elementId: row.id as ElementId, type: row.type, distance: row.distance });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Coverage stats for the status surface: how many live searchable elements are
   * embedded, the total, and the active model id (the most common stored model, or
   * `null` when the index is empty). When `vecAvailable` is `false`, `embedded` is
   * `0` (no vec store) but `total` still reflects the searchable corpus.
   */
  stats(): EmbeddingStats {
    const totalRow = this.db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM elements
      WHERE deleted_at IS NULL AND type IN ('source', 'extract', 'card')
    `);
    const total = totalRow?.n ?? 0;
    if (!this.vecAvailable) return { embedded: 0, total, modelId: null };

    const embeddedRow = this.db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM embeddings b
      JOIN elements e ON e.id = b.element_id AND e.deleted_at IS NULL
    `);
    const modelRow = this.db.get<{ model_id: string }>(sql`
      SELECT model_id FROM embeddings GROUP BY model_id ORDER BY COUNT(*) DESC LIMIT 1
    `);
    return {
      embedded: embeddedRow?.n ?? 0,
      total,
      modelId: modelRow?.model_id ?? null,
    };
  }

  /**
   * Live source/extract/card elements that still need embedding for `modelId`
   * (U3/R11): those with NO `embeddings` row OR a row produced by a DIFFERENT model.
   * Ordered by `rowid` and capped at `limit`. Unlike a blind `LIMIT` over ALL
   * elements, this never returns an all-embedded page, so repeated reindex passes
   * converge even on a corpus larger than the batch cap — without re-selecting rows
   * that are already current. (Content drift on a same-model row is caught by the
   * per-mutation auto-embed, not this scan.) Empty when `vecAvailable` is `false`.
   */
  listNeedingEmbedding(
    modelId: string,
    limit: number,
    excludeIds: readonly string[] = [],
  ): { id: ElementId; type: EmbeddableType }[] {
    if (!this.vecAvailable) return [];
    // Skip elements the caller flagged (U4: those with a currently-failed embed job,
    // so a deterministically-failing element is not auto-re-enqueued forever).
    const exclude =
      excludeIds.length > 0
        ? sql`AND e.id NOT IN (${sql.join(
            excludeIds.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : sql``;
    const rows = this.db.all<{ id: string; type: EmbeddableType }>(sql`
      SELECT e.id AS id, e.type AS type
      FROM elements e
      LEFT JOIN embeddings b ON b.element_id = e.id
      WHERE e.deleted_at IS NULL
        AND e.type IN ('source', 'extract', 'card')
        AND (b.element_id IS NULL OR b.model_id != ${modelId})
        ${exclude}
      ORDER BY e.rowid
      LIMIT ${limit}
    `);
    return rows.map((r) => ({ id: r.id as ElementId, type: r.type }));
  }

  /**
   * Backstop sweep (belt-and-braces for the `vault_gc`-adjacent cleanup): the count
   * of `element_vectors` rowids with no surviving `embeddings` row would indicate a
   * drift the explicit `delete` should have prevented. Returns the pruned count.
   * Safe no-op when `vecAvailable` is `false`. (Not wired to a job in T087; exposed
   * for a future maintenance sweep + tested for correctness.)
   */
  pruneOrphanVectors(): number {
    if (!this.vecAvailable) return 0;
    const orphans = this.db.all<{ rowid: number }>(sql`
      SELECT v.rowid AS rowid FROM element_vectors v
      LEFT JOIN embeddings b ON b.vec_rowid = v.rowid
      WHERE b.element_id IS NULL
    `);
    if (orphans.length === 0) return 0;
    this.db.transaction((tx) => {
      for (const o of orphans) {
        tx.run(
          sql`DELETE FROM element_vectors WHERE rowid = ${sql.raw(String(Math.trunc(o.rowid)))}`,
        );
      }
    });
    return orphans.length;
  }
}

/** Re-export for the typed `Embedding` row used by callers. */
export type { Embedding };
