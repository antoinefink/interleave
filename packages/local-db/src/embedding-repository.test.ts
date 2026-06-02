/**
 * EmbeddingRepository tests (T087).
 *
 * Run against a fresh in-memory `better-sqlite3` with `sqlite-vec` loaded. The
 * whole suite is gated on the FUNCTIONAL `vec0` smoke test (`isVecAvailable`), NOT
 * mere resolvability — so on an ABI-mismatched host (binary resolves + loads but
 * registers no `vec0` functions) the suite skips cleanly with a clear message
 * rather than failing inside a `vec0` query it assumed worked. CI/dev pass the
 * smoke test, so the path runs there.
 *
 * They use the DETERMINISTIC local embedder as the fake/real embedder (same
 * function the worker calls), so KNN neighbors are asserted exactly. They prove:
 * upsert writes both rows in one tx + is idempotent (reuses `vec_rowid`);
 * `needsEmbedding` skips unchanged / re-embeds changed; `knn` returns near
 * neighbors in distance order, excludes soft-deleted, narrows by type; `delete`
 * prunes both rows; and that an embed lifecycle appends NO `operation_log`.
 */

import { EMBEDDING_DIM, embedTextLocal } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EmbeddingRepository } from "./embedding-repository";
import { OperationLogRepository } from "./operation-log-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb, isVecAvailable } from "./test-db";

const MODEL = "local:minilm-hash-384";

/**
 * Probe vec availability ONCE at module load (closing the probe handle), so the
 * whole suite skips with a clear message on an ABI-mismatched / extension-absent
 * host — instead of failing inside a `vec0` query it assumed worked.
 */
const VEC_OK = (() => {
  const probe = createInMemoryDb();
  const ok = isVecAvailable(probe);
  probe.sqlite.close();
  if (!ok) {
    console.warn(
      "[embedding-repository.test] skipping: sqlite-vec vec0 not functional on this host " +
        "(better-sqlite3 ↔ sqlite-vec SQLite ABI mismatch) — semantic tests skip, FTS-only coverage stands",
    );
  }
  return ok;
})();

describe.skipIf(!VEC_OK)("EmbeddingRepository (sqlite-vec, T087)", () => {
  let handle: DbHandle;
  let embeddings: EmbeddingRepository;
  let sources: SourceRepository;
  let ops: OperationLogRepository;

  beforeEach(() => {
    handle = createInMemoryDb();
    embeddings = new EmbeddingRepository(handle.db, isVecAvailable(handle));
    sources = new SourceRepository(handle.db);
    ops = new OperationLogRepository(handle.db);
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  /** A `float[DIM]` hash of `text` (the deterministic embedder the worker uses). */
  function embed(text: string): number[] {
    return embedTextLocal(text, EMBEDDING_DIM);
  }

  /** Count the `element_vectors` rows directly (the virtual table). */
  function vecRowCount(): number {
    const row = handle.db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM element_vectors`);
    return row?.n ?? 0;
  }

  it("upserts the vector + bookkeeping row in one tx and is idempotent (reuses vec_rowid)", () => {
    const { element } = sources.create({ title: "Spaced repetition", priority: 0.5 });
    embeddings.upsert({
      elementId: element.id,
      elementType: "source",
      modelId: MODEL,
      dim: EMBEDDING_DIM,
      contentHash: "hash-1",
      vector: embed("spaced repetition review intervals"),
    });

    const row = handle.db.get<{ vec_rowid: number; content_hash: string }>(
      sql`SELECT vec_rowid, content_hash FROM embeddings WHERE element_id = ${element.id}`,
    );
    expect(row?.content_hash).toBe("hash-1");
    expect(vecRowCount()).toBe(1);
    const firstRowid = row?.vec_rowid;

    // Re-embed (changed text) reuses the same vec_rowid (no duplicate vec row).
    embeddings.upsert({
      elementId: element.id,
      elementType: "source",
      modelId: MODEL,
      dim: EMBEDDING_DIM,
      contentHash: "hash-2",
      vector: embed("memory retention scheduling"),
    });
    const row2 = handle.db.get<{ vec_rowid: number; content_hash: string }>(
      sql`SELECT vec_rowid, content_hash FROM embeddings WHERE element_id = ${element.id}`,
    );
    expect(row2?.vec_rowid).toBe(firstRowid);
    expect(row2?.content_hash).toBe("hash-2");
    expect(vecRowCount()).toBe(1);
  });

  it("needsEmbedding skips an unchanged element and re-embeds a changed one", () => {
    const { element } = sources.create({ title: "Topic", priority: 0.5 });
    expect(embeddings.needsEmbedding(element.id, "h1", MODEL)).toBe(true);
    embeddings.upsert({
      elementId: element.id,
      elementType: "source",
      modelId: MODEL,
      dim: EMBEDDING_DIM,
      contentHash: "h1",
      vector: embed("topic body"),
    });
    // Same hash + model → no-op.
    expect(embeddings.needsEmbedding(element.id, "h1", MODEL)).toBe(false);
    // Changed hash → re-embed.
    expect(embeddings.needsEmbedding(element.id, "h2", MODEL)).toBe(true);
    // Model switch → re-embed (refuse to mix models).
    expect(embeddings.needsEmbedding(element.id, "h1", "openai:text-embedding-3-small")).toBe(true);
  });

  it("knn returns the nearest neighbor first, excludes soft-deleted, narrows by type", () => {
    const near = sources.create({ title: "Review intervals scheduling", priority: 0.5 }).element;
    const far = sources.create({ title: "Photosynthesis chlorophyll", priority: 0.5 }).element;
    const deleted = sources.create({ title: "Review intervals memory", priority: 0.5 }).element;

    for (const [el, text] of [
      [near, "review intervals scheduling memory"],
      [far, "photosynthesis chlorophyll sunlight leaves"],
      [deleted, "review intervals memory retention"],
    ] as const) {
      embeddings.upsert({
        elementId: el.id,
        elementType: "source",
        modelId: MODEL,
        dim: EMBEDDING_DIM,
        contentHash: `h-${el.id}`,
        vector: embed(text),
      });
    }
    // Soft-delete the deleted source.
    handle.db.run(
      sql`UPDATE elements SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE id = ${deleted.id}`,
    );

    const queryVec = embed("scheduling review intervals");
    const hits = embeddings.knn(queryVec, { limit: 5 });
    const ids = hits.map((h) => h.elementId);
    // The near source is the closest live neighbor; the soft-deleted one is excluded.
    expect(ids[0]).toBe(near.id);
    expect(ids).not.toContain(deleted.id);
    // Distances are sorted ascending.
    const distances = hits.map((h) => h.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
  });

  it("knn type-narrows to a single element type", () => {
    const src = sources.create({ title: "Review intervals source", priority: 0.5 }).element;
    embeddings.upsert({
      elementId: src.id,
      elementType: "source",
      modelId: MODEL,
      dim: EMBEDDING_DIM,
      contentHash: "h-src",
      vector: embed("review intervals scheduling"),
    });
    // Narrow to `extract`: no extract embedded → empty.
    expect(embeddings.knn(embed("review intervals"), { type: "extract" })).toEqual([]);
    // Narrow to `source`: the source is returned.
    expect(
      embeddings.knn(embed("review intervals"), { type: "source" }).map((h) => h.elementId),
    ).toContain(src.id);
  });

  it("delete prunes both the embeddings row and the element_vectors rowid", () => {
    const { element } = sources.create({ title: "Doomed", priority: 0.5 });
    embeddings.upsert({
      elementId: element.id,
      elementType: "source",
      modelId: MODEL,
      dim: EMBEDDING_DIM,
      contentHash: "h",
      vector: embed("doomed text"),
    });
    expect(vecRowCount()).toBe(1);
    embeddings.delete(element.id);
    expect(vecRowCount()).toBe(0);
    expect(embeddings.has(element.id)).toBe(false);
    // Idempotent — a second delete is a no-op.
    expect(() => embeddings.delete(element.id)).not.toThrow();
  });

  it("rejects a wrong-length vector (a dim mismatch never reaches the column)", () => {
    const { element } = sources.create({ title: "Bad dim", priority: 0.5 });
    expect(() =>
      embeddings.upsert({
        elementId: element.id,
        elementType: "source",
        modelId: MODEL,
        dim: EMBEDDING_DIM,
        contentHash: "h",
        vector: [1, 2, 3],
      }),
    ).toThrow(/length/);
  });

  it("appends NO operation_log across an embed lifecycle (derived index)", () => {
    const before = ops.count();
    const { element } = sources.create({ title: "Logged source", priority: 0.5 });
    const afterCreate = ops.count();
    // Creating the source DID log (create_element/create_source) — embedding must not.
    embeddings.upsert({
      elementId: element.id,
      elementType: "source",
      modelId: MODEL,
      dim: EMBEDDING_DIM,
      contentHash: "h",
      vector: embed("logged source body"),
    });
    embeddings.delete(element.id);
    expect(ops.count()).toBe(afterCreate);
    expect(afterCreate).toBeGreaterThan(before);
  });

  it("stats reports embedded/total and the active model", () => {
    const a = sources.create({ title: "A", priority: 0.5 }).element;
    sources.create({ title: "B", priority: 0.5 });
    embeddings.upsert({
      elementId: a.id,
      elementType: "source",
      modelId: MODEL,
      dim: EMBEDDING_DIM,
      contentHash: "h",
      vector: embed("a body"),
    });
    const stats = embeddings.stats();
    expect(stats.total).toBe(2);
    expect(stats.embedded).toBe(1);
    expect(stats.modelId).toBe(MODEL);
  });

  it("pruneOrphanVectors removes element_vectors rows with no bookkeeping row", () => {
    // Insert a raw vec row with no matching embeddings row (a simulated drift).
    handle.db.run(
      sql`INSERT INTO element_vectors(embedding) VALUES (${Buffer.from(new Float32Array(EMBEDDING_DIM).fill(0.1).buffer)})`,
    );
    expect(vecRowCount()).toBe(1);
    expect(embeddings.pruneOrphanVectors()).toBe(1);
    expect(vecRowCount()).toBe(0);
  });
});
