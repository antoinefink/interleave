/**
 * Embedding model loader (T087) — runs in the DB-free `utilityProcess` worker.
 *
 * The worker computes local EmbeddingGemma vectors off the main thread and posts a
 * plain `number[]` back. Main is the only process that writes the sqlite-vec store.
 * This module imports no database, repository, `better-sqlite3`, or `sqlite-vec`
 * code.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { DEFAULT_EMBEDDING_MODEL_ID, EMBEDDING_DIM, embedTextLocal } from "@interleave/core";

const nodeRequire = createRequire(__filename);

/** The model/cache directory resolved by the desktop main through fork env. */
export const MODEL_DIR = process.env.INTERLEAVE_MODEL_DIR ?? "";
const PACKAGED_MODEL_DIR = path.join(__dirname, "resources", "transformers", "models");

/** The Hugging Face / Transformers.js ONNX model repo used for local embeddings. */
export const EMBEDDINGGEMMA_MODEL_REPO = DEFAULT_EMBEDDING_MODEL_ID;

/** The model id recorded when the real local EmbeddingGemma model produced a vector. */
export const REAL_MODEL_ID = DEFAULT_EMBEDDING_MODEL_ID;

/** Distinct fallback id so lexical fallback vectors are never KNN-mixed with real vectors. */
export const FALLBACK_MODEL_ID = "local:embeddinggemma-hash-768";

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
  readonly provider: "local";
  readonly dim: number;
}

type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling?: "mean" | "cls"; normalize?: boolean },
) => Promise<unknown>;

interface TransformersModule {
  pipeline(
    task: "feature-extraction",
    model: string,
    options?: Record<string, unknown>,
  ): Promise<FeatureExtractionPipeline>;
  env?: {
    cacheDir?: string;
    localModelPath?: string;
    allowLocalModels?: boolean;
    allowRemoteModels?: boolean;
  };
}

let localModel: FeatureExtractionPipeline | null | undefined;
let localModelLoad: Promise<FeatureExtractionPipeline | null> | null = null;

function loadTransformers(): TransformersModule {
  const staged = path.join(
    __dirname,
    "resources",
    "transformers",
    "node_modules",
    "@huggingface",
    "transformers",
  );
  try {
    return nodeRequire(staged) as TransformersModule;
  } catch {
    return nodeRequire("@huggingface/transformers") as TransformersModule;
  }
}

async function loadLocalModel(): Promise<FeatureExtractionPipeline | null> {
  if (localModel !== undefined) return localModel;
  if (process.env.VITEST) {
    localModel = null;
    return null;
  }
  if (localModelLoad) return localModelLoad;

  localModelLoad = (async () => {
    try {
      const mod = loadTransformers();
      if (mod.env) {
        const localModelPath = existsSync(PACKAGED_MODEL_DIR) ? PACKAGED_MODEL_DIR : MODEL_DIR;
        if (MODEL_DIR) {
          mod.env.cacheDir = MODEL_DIR;
        }
        if (localModelPath) mod.env.localModelPath = localModelPath;
        // The semantic provider is local-only. If the model is not present in the
        // packaged/cache path, fall back deterministically instead of fetching.
        mod.env.allowLocalModels = true;
        mod.env.allowRemoteModels = false;
      }
      const model = await mod.pipeline("feature-extraction", EMBEDDINGGEMMA_MODEL_REPO, {
        dtype: "q8",
      });
      localModel = model;
      return model;
    } catch (err) {
      console.warn(
        "[embedding] local EmbeddingGemma unavailable — using deterministic fallback:",
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

/** Compute a local-only EmbeddingGemma vector, falling back deterministically offline. */
export async function computeEmbedding(payload: EmbedJobPayload): Promise<EmbeddingResult> {
  return runLocalEmbedding(payload);
}

async function runLocalEmbedding(payload: EmbedJobPayload): Promise<EmbeddingResult> {
  const dim = payload.dim || EMBEDDING_DIM;
  const model = await loadLocalModel();
  if (model) {
    try {
      const output = await model(payload.text, { pooling: "mean", normalize: true });
      const vector = tensorToVector(output);
      if (vector.length === dim) return { vector, modelId: REAL_MODEL_ID, dim };
    } catch (err) {
      console.warn(
        "[embedding] local EmbeddingGemma embed failed — using deterministic fallback:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { vector: embedTextLocal(payload.text, dim), modelId: FALLBACK_MODEL_ID, dim };
}

function tensorToVector(output: unknown): number[] {
  if (Array.isArray(output)) return flattenNumberArray(output);
  if (typeof output !== "object" || output === null) return [];
  const maybeTensor = output as {
    data?: ArrayLike<number>;
    dims?: readonly number[];
    tolist?: () => unknown;
  };
  if (typeof maybeTensor.tolist === "function") return flattenNumberArray(maybeTensor.tolist());
  if (maybeTensor.data && typeof maybeTensor.data.length === "number") {
    return Array.from(maybeTensor.data, Number);
  }
  return [];
}

function flattenNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      out.push(item);
    }
  };
  visit(value);
  return out;
}

/** A typed embedding error retained for stable worker error serialization. */
export class EmbedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EmbedError";
  }
}
