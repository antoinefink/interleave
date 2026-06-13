/**
 * On-device embedding primitives (T087).
 *
 * The semantic-search layer embeds each live source / extract / card into a fixed
 * `float[EMBEDDING_DIM]` vector, stored in a `sqlite-vec` `vec0` virtual table on
 * the same SQLite file. The embedding is a DERIVED index (like FTS5) — it appends
 * NO `operation_log` entry and is rebuildable from the base tables.
 *
 * ## The default local model + the deterministic FALLBACK (decision, justified)
 *
 * The shipped DEFAULT on-device model is **EmbeddingGemma-300M** (768-dim) as an
 * ONNX model, run in the DB-free worker via Transformers.js
 * (`apps/desktop/src/worker/embedding-model.ts`). It produces TRUE semantic vectors:
 * "spaced repetition" lands near "review intervals" with ZERO shared tokens — the
 * roadmap "Done when" (find conceptually related material WITHOUT a keyword match).
 *
 * THIS module is the dependency-free **deterministic fallback** the worker drops to
 * ONLY when the real model cannot load (the dev/Vitest path bundles no model; an
 * offline first run with an empty cache; an `onnxruntime` ABI miss). It is a
 * feature-hashing bag-of-words → L2-normalized `float[768]` ({@link embedTextLocal}).
 * Why keep it:
 *  - it is **fully offline with ZERO native/model dependency**, so the feature never
 *    hard-fails — it degrades to a lexical baseline instead of throwing;
 *  - it is **deterministic**, so the unit/integration tests assert exact KNN
 *    neighbors without mocking a model, and a re-embed of unchanged text is a true
 *    no-op (the content hash matches);
 *  - similar text (shared tokens) → near vectors, which still surfaces conceptually-
 *    related material that shares vocabulary even without a literal FTS hit.
 *
 * The fallback is a lexical baseline (token co-occurrence, not deep semantics), so
 * the worker records its vectors under a DISTINCT model id (`local:embeddinggemma-hash-768`,
 * see `FALLBACK_MODEL_ID`) — the model id is stored per `embeddings` row, so the two
 * spaces are NEVER KNN-mixed and a host that flips between them re-embeds rather than
 * comparing incompatible vectors. The function lives in `@interleave/core`
 * (dependency-free) so BOTH the worker (the fallback path) and the tests (assertion
 * parity) call the identical implementation.
 */

/**
 * The embedding vector dimension. Fixed at `vec0` migration time — the `vec0`
 * column DDL (`embedding float[768]`) and this constant MUST move together. 768
 * matches the default EmbeddingGemma-300M model AND the deterministic fallback, so
 * both write the same fixed-dim column (only the model id differs per row).
 */
export const EMBEDDING_DIM = 768;

/**
 * The model id recorded for the deterministic FALLBACK embedder ({@link embedTextLocal}).
 * Distinct from any real model id so fallback (hash) vectors are NEVER KNN-mixed with
 * real semantic vectors, and so main can recognize a fallback result at the persistence
 * boundary and refuse to index it (the no-poison guard). Lives here (dependency-free) so
 * the worker, main, and tests share one source of truth.
 */
export const FALLBACK_EMBEDDING_MODEL_ID = "local:embeddinggemma-hash-768";

/** A bookkeeping row mapping an embedded element to its `vec0` rowid + model + hash. */
export interface Embedding {
  /** The embedded element (PK; FK → `elements.id`). */
  readonly elementId: string;
  /** The `vec0` virtual-table rowid holding the vector (UNIQUE). */
  readonly vecRowid: number;
  /** The embedded element's type (`source` | `extract` | `card`). */
  readonly elementType: "source" | "extract" | "card";
  /** The model that produced the vector, e.g. `"onnx-community/embeddinggemma-300m-ONNX"`
   * (the real default) or `"local:embeddinggemma-hash-768"` (the deterministic fallback). */
  readonly modelId: string;
  /** The vector dimension (must equal {@link EMBEDDING_DIM} for the current column). */
  readonly dim: number;
  /** sha256 of the exact text embedded — the skip-if-unchanged / re-embed gate. */
  readonly contentHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The element types that get embedded (the searchable types). */
export const EMBEDDABLE_TYPES = ["source", "extract", "card"] as const;
export type EmbeddableType = (typeof EMBEDDABLE_TYPES)[number];

/**
 * The deterministic FALLBACK embedder (used when the real EmbeddingGemma model cannot
 * load — see the module docblock): tokenize → feature-hash each token into
 * `dim` buckets (a stable FNV-1a hash, signed by a second hash bit) → L2-normalize.
 * Pure + dependency-free. Identical text always yields the identical vector, and
 * text sharing tokens yields a near (small cosine distance) vector — the property
 * KNN relies on. Empty/whitespace text yields the zero vector (distance is then
 * undefined, so callers skip embedding empty text).
 */
export function embedTextLocal(text: string, dim: number = EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const h = fnv1a(token);
    const bucket = h % dim;
    // A second, independent hash bit gives each token a stable ±1 sign, so two
    // different tokens that collide on a bucket don't always reinforce.
    const sign = (fnv1a(`#${token}`) & 1) === 0 ? 1 : -1;
    vec[bucket] = (vec[bucket] ?? 0) + sign;
  }
  // L2-normalize so cosine/L2 distance compares direction, not token count.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm === 0) return vec; // all-zero (empty text) — leave as zeros.
  for (let i = 0; i < dim; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

/** Lowercase, split on non-alphanumeric (Unicode-aware), drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** A stable 32-bit FNV-1a hash of a string (unsigned). */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // FNV prime multiply in 32-bit space (Math.imul keeps it 32-bit).
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
