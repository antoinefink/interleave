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

import path from "node:path";
import { DEFAULT_EMBEDDING_MODEL_ID, EMBEDDING_DIM, embedTextLocal } from "@interleave/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const existsSync = vi.fn<(p: string) => boolean>();
vi.mock("node:fs", () => ({ existsSync: (p: string) => existsSync(p) }));

import {
  computeEmbedding,
  type EmbedJobPayload,
  FALLBACK_MODEL_ID,
  REAL_MODEL_ID,
  resolveUnpackedDir,
} from "./embedding-model";

const sep = path.sep;

afterEach(() => {
  existsSync.mockReset();
});

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

describe("resolveUnpackedDir (packaged app.asar.unpacked rewrite)", () => {
  it("returns the app.asar.unpacked sibling when packaged and only that path exists", () => {
    // Packaged worker bundle dirname: …/app.asar/dist
    const inAsar = path.join(sep, "App", "Contents", "Resources", "app.asar", "dist");
    const unpacked = inAsar.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);

    // Only the unpacked variant exists on disk (the in-asar path is not a real dir).
    existsSync.mockImplementation((p: string) => p === unpacked);

    const result = resolveUnpackedDir(inAsar);
    expect(result).toBe(unpacked);
    expect(result).toContain(`${sep}app.asar.unpacked${sep}`);
  });

  it("returns the literal path unchanged in dev (no asar marker)", () => {
    const devDir = path.join(sep, "repo", "apps", "desktop", "dist");

    // No fs lookup happens because there is no asar marker, but guard anyway.
    existsSync.mockReturnValue(false);

    const result = resolveUnpackedDir(devDir);
    expect(result).toBe(devDir);
    expect(result).not.toContain("app.asar");
  });

  it("returns p unchanged when neither the unpacked nor in-asar path exists (no throw)", () => {
    const inAsar = path.join(sep, "App", "Contents", "Resources", "app.asar", "dist");

    existsSync.mockReturnValue(false);

    expect(resolveUnpackedDir(inAsar)).toBe(inAsar);
  });
});
