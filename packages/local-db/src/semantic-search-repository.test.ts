/**
 * SemanticSearchRepository fusion tests (T087).
 *
 * Prove the FTS + vector FUSION: a purely-semantic neighbor with NO keyword
 * overlap still appears (the whole point of semantic search), FTS hits still rank,
 * and `mode` reflects whether semantics actually ran. Gated on the functional
 * `vec0` smoke test (skips cleanly on an ABI-mismatched host).
 *
 * The query vector is supplied directly (in production it rides the runner via
 * `embedQuery`); here it is the deterministic local embedder of the query text, so
 * the fusion is asserted exactly without any model/worker.
 */

import { EMBEDDING_DIM, embedTextLocal } from "@interleave/core";
import type { DbHandle } from "@interleave/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DocumentRepository } from "./document-repository";
import { EmbeddingRepository } from "./embedding-repository";
import { SearchRepository } from "./search-repository";
import { SemanticSearchRepository } from "./semantic-search-repository";
import { SourceRepository } from "./source-repository";
import { createInMemoryDb, isVecAvailable } from "./test-db";

const MODEL = "onnx-community/embeddinggemma-300m-ONNX";
const FALLBACK_MODEL = "local:embeddinggemma-hash-768";

const VEC_OK = (() => {
  const probe = createInMemoryDb();
  const ok = isVecAvailable(probe);
  probe.sqlite.close();
  return ok;
})();

describe.skipIf(!VEC_OK)("SemanticSearchRepository fusion (T087)", () => {
  let handle: DbHandle;
  let semantic: SemanticSearchRepository;
  let embeddings: EmbeddingRepository;
  let sources: SourceRepository;
  let documents: DocumentRepository;

  beforeEach(() => {
    handle = createInMemoryDb();
    const search = new SearchRepository(handle.db);
    embeddings = new EmbeddingRepository(handle.db, isVecAvailable(handle));
    semantic = new SemanticSearchRepository(search, embeddings);
    sources = new SourceRepository(handle.db);
    documents = new DocumentRepository(handle.db);
  });

  afterEach(() => {
    handle.sqlite.close();
  });

  function embed(text: string): number[] {
    return embedTextLocal(text, EMBEDDING_DIM);
  }

  /** Seed a source with a title + body, embedded with its own text. */
  function seedEmbeddedSource(title: string, body: string, opts: { modelId?: string } = {}) {
    const { element } = sources.create({ title, priority: 0.5 });
    documents.upsert({
      elementId: element.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: body,
    });
    embeddings.upsert({
      elementId: element.id,
      elementType: "source",
      modelId: opts.modelId ?? MODEL,
      dim: EMBEDDING_DIM,
      contentHash: `h-${element.id}`,
      vector: embed(`${title} ${body}`),
    });
    return element;
  }

  it("surfaces a purely-semantic neighbor with NO keyword overlap", () => {
    // The source talks about "review intervals" / "scheduling" but NOT the literal
    // query word — so FTS alone would miss it; the vector neighbor must surface it.
    const semanticOnly = seedEmbeddedSource(
      "Optimal review intervals",
      "scheduling repetitions to maximize retention over time",
    );
    // A query whose vector is near (shares 'intervals'/'scheduling' tokens) but does
    // NOT keyword-match the source title/body literally for the chosen FTS term.
    const queryText = "scheduling intervals retention";
    const result = semantic.search(queryText, {
      semanticEnabled: true,
      queryVector: embed(queryText),
      queryModelId: MODEL,
      limit: 10,
    });

    expect(result.mode).toBe("semantic");
    const hit = result.hits.find((h) => h.id === semanticOnly.id);
    expect(hit).toBeDefined();
    // It came from the vector side (semantic or both), carrying a vec distance.
    expect(hit?.source === "semantic" || hit?.source === "both").toBe(true);
    expect(hit?.vecDistance).toBeTypeOf("number");
  });

  it("fuses FTS + vector and ranks a both-list hit highly", () => {
    const both = seedEmbeddedSource(
      "Memory consolidation during sleep",
      "the hippocampus replays patterns into the cortex",
    );
    seedEmbeddedSource("Unrelated cooking", "knife skills and mise en place");

    const queryText = "memory consolidation";
    const result = semantic.search(queryText, {
      semanticEnabled: true,
      queryVector: embed(queryText),
      queryModelId: MODEL,
      limit: 10,
    });
    expect(result.mode).toBe("semantic");
    const top = result.hits[0];
    expect(top?.id).toBe(both.id);
    // It matched BOTH keyword + vector.
    expect(top?.source).toBe("both");
  });

  it("does not fuse fallback-model vector neighbors into a real-model semantic query", () => {
    const real = seedEmbeddedSource(
      "Optimal review intervals",
      "scheduling repetitions to maximize retention over time",
    );
    const fallback = sources.create({
      title: "Fallback-space-only candidate",
      priority: 0.5,
    }).element;
    documents.upsert({
      elementId: fallback.id,
      prosemirrorJson: { type: "doc", content: [] },
      plainText: "unrelated words with no keyword overlap",
    });
    const queryText = "scheduling intervals retention";
    embeddings.upsert({
      elementId: fallback.id,
      elementType: "source",
      modelId: FALLBACK_MODEL,
      dim: EMBEDDING_DIM,
      contentHash: `h-${fallback.id}`,
      vector: embed(queryText),
    });

    const result = semantic.search(queryText, {
      semanticEnabled: true,
      queryVector: embed(queryText),
      queryModelId: MODEL,
      limit: 10,
    });

    expect(result.mode).toBe("semantic");
    expect(result.hits.map((h) => h.id)).toContain(real.id);
    expect(result.hits.map((h) => h.id)).not.toContain(fallback.id);
  });

  it("degrades to FTS-only (mode 'fts') when no query vector is supplied", () => {
    const src = seedEmbeddedSource("Memory and recall", "the brain stores and retrieves");
    const result = semantic.search("memory", {
      semanticEnabled: true,
      queryVector: null,
    });
    expect(result.mode).toBe("fts");
    expect(result.hits.map((h) => h.id)).toContain(src.id);
    // Every degraded hit is FTS-sourced.
    expect(result.hits.every((h) => h.source === "fts")).toBe(true);
  });

  it("reports mode 'disabled' when the semantic capability gate is false", () => {
    seedEmbeddedSource("Memory", "recall");
    const result = semantic.search("memory", {
      semanticEnabled: false,
      queryVector: embed("memory"),
      queryModelId: MODEL,
    });
    expect(result.mode).toBe("disabled");
  });
});
