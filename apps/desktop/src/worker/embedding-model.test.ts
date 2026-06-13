/**
 * Worker embedding-model unit tests (T087) — the "distinct id, never KNN-mixed"
 * invariant asserted DIRECTLY.
 *
 * The spec's load-bearing guarantee is that the REAL EmbeddingGemma semantic
 * space and the deterministic lexical FALLBACK are recorded under DISTINCT model
 * ids, so a host that flips between them re-embeds via the `model_id` gate rather
 * than KNN-mixing incompatible vectors under one id. Under Vitest `loadLocalModel`
 * short-circuits to the deterministic fallback via the `process.env.VITEST` guard
 * (so the suite never loads the real model), and `computeEmbedding`
 * deterministically takes the FALLBACK path here — we pin that it labels the vector
 * with {@link FALLBACK_MODEL_ID} REGARDLESS of the requested id (the real path labels
 * with {@link REAL_MODEL_ID}, exercised against the live model in the Electron E2E).
 */

import { DEFAULT_EMBEDDING_MODEL_ID, EMBEDDING_DIM, embedTextLocal } from "@interleave/core";
import { describe, expect, it } from "vitest";
import {
  computeEmbedding,
  type EmbedJobPayload,
  FALLBACK_MODEL_ID,
  REAL_MODEL_ID,
} from "./embedding-model";

function localPayload(overrides: Partial<EmbedJobPayload> = {}): EmbedJobPayload {
  return {
    text: "spaced repetition and review intervals",
    modelId: REAL_MODEL_ID,
    provider: "local",
    dim: EMBEDDING_DIM,
    ...overrides,
  };
}

describe("embedding-model model ids (T087 — distinct, never KNN-mixed)", () => {
  it("the real and fallback ids are distinct so the two spaces are never mixed", () => {
    expect(REAL_MODEL_ID).not.toBe(FALLBACK_MODEL_ID);
  });

  it("the shipped settings default is the REAL model id (not the fallback id)", () => {
    expect(DEFAULT_EMBEDDING_MODEL_ID).toBe(REAL_MODEL_ID);
    expect(DEFAULT_EMBEDDING_MODEL_ID).not.toBe(FALLBACK_MODEL_ID);
  });

  it("labels the deterministic fallback with the FALLBACK id, ignoring the requested id", async () => {
    // The worker skips the real model under Vitest and drops to the deterministic
    // embedder. The row must NOT inherit the requested real id.
    const result = await computeEmbedding(localPayload({ modelId: REAL_MODEL_ID }));
    expect(result.modelId).toBe(FALLBACK_MODEL_ID);
    expect(result.dim).toBe(EMBEDDING_DIM);
    // It is the same pure vector `@interleave/core` exposes, so tests/worker agree.
    expect(result.vector).toEqual(embedTextLocal(localPayload().text, EMBEDDING_DIM));
  });

  it("still labels the fallback distinctly even when an arbitrary id is requested", async () => {
    const result = await computeEmbedding(
      localPayload({ modelId: "openai:text-embedding-3-small" }),
    );
    expect(result.modelId).toBe(FALLBACK_MODEL_ID);
  });
});
