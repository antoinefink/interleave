/**
 * Embedding model loader (T087) — runs in the DB-FREE `utilityProcess` worker.
 *
 * The worker computes an element/query embedding OFF the main thread and posts a
 * plain `number[]` back; MAIN writes it into the `sqlite-vec` store (single
 * writer). This module owns the model compute ONLY — it imports NO `@interleave/db`,
 * `better-sqlite3`, `sqlite-vec`, repository, or `DbService`.
 *
 * ## The default local model: a real on-device sentence-transformer (decision)
 *
 * The default `embeddingProvider = "local"` runs the real **`all-MiniLM-L6-v2`**
 * (384-dim) ONNX sentence-transformer via **`fastembed`** ({@link loadLocalModel}),
 * lazily loaded once per worker and cached across jobs. `fastembed` was chosen over
 * `@huggingface/transformers` because the latter hard-depends on `sharp` (native
 * image codecs, irrelevant to text embeddings) which does not build on every host;
 * `fastembed` ships prebuilt `onnxruntime-node` + tokenizer binaries, has a tiny
 * surface (`FlagEmbedding.init` → `embed`/`queryEmbed`), and produces TRUE semantic
 * vectors — "spaced repetition" lands NEAR "review intervals" with ZERO shared
 * tokens (cos ≈ 0.73) while landing FAR from "tomato soup" (cos ≈ 0.54). This is the
 * capability the roadmap's "Done when" promises: find conceptually related material
 * WITHOUT a keyword match.
 *
 * **Download-on-first-enable / offline cache.** `fastembed` streams the ~23 MB
 * quantized ONNX model + tokenizer to `cacheDir = INTERLEAVE_MODEL_DIR` (the
 * fork-env seam, resolved like `INTERLEAVE_ASSETS_DIR`) on the first `init`, then
 * reuses it from disk across restarts — no model bytes leave the device after that.
 * `EmbeddingService.downloadModel` (main) pre-warms this on first enable so search
 * is FTS-only with a "Downloading model…" affordance until it completes.
 *
 * **Deterministic fallback (test / model-absent hosts only).** When the real model
 * cannot load — `fastembed` is not resolvable (the dev/Vitest path bundles no model),
 * the cache is empty AND offline, or `onnxruntime` fails — the worker falls back to
 * the dependency-free deterministic feature-hashing embedder from `@interleave/core`
 * ({@link embedTextLocal}). The fallback uses a DISTINCT model id
 * ({@link FALLBACK_MODEL_ID}) so its lexical vectors are NEVER KNN-mixed with the
 * real model's: the bookkeeping `model_id` differs, so flipping environments
 * re-embeds rather than comparing incompatible spaces. Unit/integration tests inject
 * a fake worker that calls `embedTextLocal` directly, so they assert exact KNN
 * without a model; the Electron E2E exercises THIS module against the real worker
 * (real model when the cache is warm, fallback when offline — both surface a hit).
 *
 * ## The opt-in API provider
 *
 * When `provider === "api"`, the worker calls the user's OWN embedding endpoint
 * with the user's key. The key is read main-side from SQLite settings and injected
 * into the worker request OUT-OF-BAND at post time (never enqueued / persisted to a
 * `jobs` row, never seen by the renderer, never our server). The only network call
 * is to the provider the user configured.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { EMBEDDING_DIM, embedTextLocal } from "@interleave/core";

/**
 * A real Node `require` resolved relative to THIS worker bundle, so the staged
 * `fastembed` (kept EXTERNAL — see build.mjs) is loaded from disk at runtime, not
 * inlined. Mirrors the `tesseract.js` staging in `ocr.ts`. `createRequire(__filename)`
 * works in the esbuild CJS worker bundle.
 */
const nodeRequire = createRequire(__filename);

/** The model directory the worker resolves / caches the real ONNX model into (fork-env seam). */
export const MODEL_DIR = process.env.INTERLEAVE_MODEL_DIR ?? "";

/**
 * The model id recorded when the REAL `all-MiniLM-L6-v2` ONNX sentence-transformer
 * produced the vector. This is the SHIPPED default ({@link DEFAULT_EMBEDDING_MODEL_ID})
 * and the worker labels the real-model output with THIS id regardless of the requested
 * id, so the true-semantic space is never recorded under the fallback's id.
 */
export const REAL_MODEL_ID = "local:all-MiniLM-L6-v2";

/**
 * The model id recorded when the deterministic fallback embedder produced the vector
 * (DISTINCT from {@link REAL_MODEL_ID} so the two vector spaces are never KNN-mixed —
 * a host that flips between the real model and the lexical fallback re-embeds via the
 * `model_id` gate rather than comparing incompatible vectors under one id).
 */
export const FALLBACK_MODEL_ID = "local:minilm-hash-384";

/** A computed embedding + the model id + dim it was produced with. */
export interface EmbeddingResult {
  readonly vector: number[];
  readonly modelId: string;
  readonly dim: number;
}

/** The shape of the `embed` job payload the worker receives. */
export interface EmbedJobPayload {
  readonly text: string;
  readonly modelId: string;
  /** `"local"` (on-device model) or `"api"` (the user's own endpoint). */
  readonly provider: "local" | "api";
  readonly dim: number;
  /**
   * The user's OWN API key (only for `provider === "api"`). Injected into the worker
   * request OUT-OF-BAND by the runner at post time — never enqueued / persisted to a
   * `jobs` row, never logged.
   */
  readonly apiKey?: string;
  /** The API endpoint + model name for `provider === "api"`. */
  readonly apiEndpoint?: string;
  readonly apiModel?: string;
}

/**
 * The minimal `fastembed` surface the worker uses (typed locally so this module
 * does not need `fastembed`'s types at build time — it is a runtime-external dep
 * loaded dynamically, mirroring how `tesseract.js` is kept external for the worker).
 */
interface FastEmbedModel {
  embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
}

/** The `fastembed` module surface the worker uses (typed locally; it is external). */
interface FastEmbedModule {
  FlagEmbedding: {
    init(opts: {
      model: string;
      cacheDir?: string;
      maxLength?: number;
      showDownloadProgress?: boolean;
    }): Promise<FastEmbedModel>;
  };
  EmbeddingModel: { AllMiniLML6V2: string };
}

/**
 * Load the runtime-external `fastembed` module: the PACKAGED app ships it under
 * `dist/resources/fastembed/node_modules/` (build.mjs `stageFastEmbed`), so prefer
 * that on-disk staged tree (its native onnxruntime addon must be a real file, not
 * inlined); fall back to bare resolution for dev/Vitest, where it resolves from the
 * workspace store. Throws if neither resolves — the caller degrades deterministically.
 */
function loadFastEmbed(): FastEmbedModule {
  const staged = path.join(__dirname, "resources", "fastembed", "node_modules", "fastembed");
  try {
    return nodeRequire(staged) as FastEmbedModule;
  } catch {
    return nodeRequire("fastembed") as FastEmbedModule;
  }
}

/**
 * Lazy singleton for the loaded local model. `undefined` = not attempted yet;
 * `null` = load failed once (do not retry every job — fall back deterministically);
 * a model = ready and reused across jobs.
 */
let localModel: FastEmbedModel | null | undefined;
let localModelLoad: Promise<FastEmbedModel | null> | null = null;

/**
 * Load (and cache) the real `all-MiniLM-L6-v2` model via `fastembed`, downloading
 * it into {@link MODEL_DIR} on first use and reusing it from disk thereafter.
 * Resolves `null` (logged once) when `fastembed`/`onnxruntime` cannot load or the
 * model cannot be fetched — the caller then falls back to {@link embedTextLocal}.
 * Loaded via a guarded dynamic import so the worker bundle keeps it EXTERNAL (the
 * native `onnxruntime` addon must be a real file on disk, not inlined).
 */
async function loadLocalModel(): Promise<FastEmbedModel | null> {
  if (localModel !== undefined) return localModel;
  if (localModelLoad) return localModelLoad;
  localModelLoad = (async () => {
    try {
      // Dynamic, runtime-external require (kept out of the esbuild bundle, like
      // tesseract.js) — the staged `fastembed` + its prebuilt onnxruntime binary
      // resolve from the worker's on-disk `node_modules`. Prefer the packaged
      // staged tree next to the worker bundle; fall back to bare resolution for the
      // dev/Vitest path (it resolves from the workspace store).
      const mod = loadFastEmbed();
      const model = await mod.FlagEmbedding.init({
        model: mod.EmbeddingModel.AllMiniLML6V2,
        ...(MODEL_DIR ? { cacheDir: MODEL_DIR } : {}),
        maxLength: 256,
        showDownloadProgress: false,
      });
      localModel = model;
      return model;
    } catch (err) {
      // Model/runtime unavailable (no bundle, offline first run, ABI) — degrade to
      // the deterministic embedder. Logged once; subsequent jobs skip the retry.
      console.warn(
        "[embedding] real local model unavailable — using deterministic fallback:",
        err instanceof Error ? err.message : String(err),
      );
      localModel = null;
      return null;
    } finally {
      localModelLoad = null;
    }
  })();
  return localModelLoad;
}

/**
 * Compute the embedding for `payload.text`. Routes to the real on-device model
 * (default) or the user's API endpoint. Always returns a `dim`-length vector. Throws
 * a typed-ish error on an API failure so the runner records the job's terminal error
 * and the search degrades to FTS-only.
 */
export async function computeEmbedding(payload: EmbedJobPayload): Promise<EmbeddingResult> {
  if (payload.provider === "api") {
    return runApiEmbedding(payload);
  }
  return runLocalEmbedding(payload);
}

/**
 * The default on-device embedding: the real `all-MiniLM-L6-v2` sentence-transformer
 * when available (true semantics — disjoint-vocabulary conceptual matches), falling
 * back to the deterministic feature-hashing embedder (under a DISTINCT model id) only
 * when the real model cannot load. Always returns a 384-dim vector.
 */
async function runLocalEmbedding(payload: EmbedJobPayload): Promise<EmbeddingResult> {
  const dim = payload.dim || EMBEDDING_DIM;
  const model = await loadLocalModel();
  if (model) {
    try {
      for await (const batch of model.embed([payload.text], 1)) {
        const vector = batch[0];
        if (Array.isArray(vector) && vector.length === dim) {
          // Label the real-model output with the REAL model id (NOT the requested
          // id) so the true-semantic space is never recorded under the fallback's
          // id — the two spaces stay KNN-isolated even if the requested id drifts.
          return { vector, modelId: REAL_MODEL_ID, dim };
        }
        // A model whose dim does not match the fixed vec0 column is unusable —
        // fall back deterministically rather than corrupt the store.
        break;
      }
    } catch (err) {
      console.warn(
        "[embedding] real local embed failed — using deterministic fallback:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  // Deterministic fallback — DISTINCT model id so its space is never KNN-mixed.
  return { vector: embedTextLocal(payload.text, dim), modelId: FALLBACK_MODEL_ID, dim };
}

/**
 * Call the user's OWN embedding endpoint (OpenAI-compatible `/embeddings`). The
 * endpoint/model come from the payload; the key is injected out-of-band at post
 * time (read main-side from SQLite settings). The worker never persists or logs
 * them. Validates the returned vector length matches
 * the expected dim — a mismatched provider model is rejected (it would corrupt the
 * fixed-dim `vec0` column) rather than silently stored.
 */
async function runApiEmbedding(payload: EmbedJobPayload): Promise<EmbeddingResult> {
  const dim = payload.dim || EMBEDDING_DIM;
  const endpoint = payload.apiEndpoint ?? "https://api.openai.com/v1/embeddings";
  const model = payload.apiModel ?? "text-embedding-3-small";
  if (!payload.apiKey) {
    throw new EmbedError("embed_no_api_key", "API embedding selected but no API key configured");
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${payload.apiKey}`,
    },
    body: JSON.stringify({ model, input: payload.text, dimensions: dim }),
  });
  if (!response.ok) {
    throw new EmbedError(
      "embed_api_error",
      `Embedding API returned ${response.status} ${response.statusText}`,
    );
  }
  const json = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== dim) {
    throw new EmbedError(
      "embed_api_dim_mismatch",
      `Embedding API returned a ${vector?.length ?? 0}-dim vector, expected ${dim}`,
    );
  }
  return { vector, modelId: payload.modelId, dim };
}

/** A typed embedding error so the worker posts a stable `code` to main. */
export class EmbedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}
