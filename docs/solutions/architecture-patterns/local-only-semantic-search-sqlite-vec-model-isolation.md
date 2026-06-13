---
title: "Local-only semantic search needs model-owned vector dimensions and settings"
date: "2026-06-13"
category: "architecture-patterns"
module: "semantic-search"
problem_type: "architecture_pattern"
component: "database"
severity: "high"
applies_when:
  - "Semantic search must stay local-first and never depend on remote embedding providers."
  - "A sqlite-vec index is coupled to the embedding model dimension and must be recreated when that dimension changes."
  - "Multiple semantic consumers share embeddings, such as search, related items, and contradiction detection."
  - "Embedding models are vendored or prepared by build scripts and need regression tests."
related_components:
  - "service_object"
  - "tooling"
  - "testing_framework"
tags:
  - "semantic-search"
  - "embeddings"
  - "sqlite-vec"
  - "local-first"
  - "transformers-js"
  - "embeddinggemma-300m"
  - "migrations"
  - "model-isolation"
---

# Local-only semantic search needs model-owned vector dimensions and settings

## Context

Semantic search moved from an optional, provider-selectable feature to an always-on local capability. That exposed several coupled assumptions: settings still allowed disabled or remote embedding modes, the worker/build path still carried old MiniLM-era assumptions, and `sqlite-vec` could keep an existing fixed-width vector table even after the embedding dimension changed.

The higher-level semantic consumers also seeded KNN from stored vectors without carrying the model id that produced those vectors. That made it possible for real EmbeddingGemma vectors and deterministic fallback vectors to share a width but be compared as if they lived in the same semantic space.

## Guidance

Treat semantic search as one local subsystem with one active model contract. The model id, vector dimension, settings projection, migration behavior, worker runtime, build packaging, and KNN call sites all need to agree.

Pin the core semantic contract in one place and coerce legacy settings into it:

```ts
export const EMBEDDING_DIM = 768;
export const DEFAULT_EMBEDDING_MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
```

Renderer-facing settings should not expose provider selection, embedding API keys, model selection, or a semantic-search off switch. Legacy stored values can remain readable for vault compatibility, but they should project as local/default/always-on.

When the embedding dimension changes, migration must inspect the existing `sqlite-vec` table shape. `CREATE VIRTUAL TABLE IF NOT EXISTS` is not enough because it preserves the old fixed-width vector column. If the table is missing or has the wrong dimension, drop and recreate the derived vec table and clear derived embedding rows so re-indexing can rebuild from canonical elements/documents.

KNN queries should carry the model id that produced the query vector. For ad hoc search, that comes from the query embedding result. For element-seeded reads, store-vector access should return both values:

```ts
interface StoredEmbeddingVector {
  readonly vector: number[];
  readonly modelId: string;
}
```

Pass that `modelId` into every KNN consumer: search fusion, related-item vector buckets, sibling-source ranking, contradiction detection, and review-mode semantic context. Apply the model filter before the nearest-neighbor window, not after it, so wrong-model vectors cannot fill the inner KNN limit and crowd out valid same-model neighbors.

The packaging path is part of the semantic contract. Keep runtime jobs local-only, but let the build step acquire and stage the model for distributable builds. Dist builds should fail if the required model cannot be staged; dev and e2e builds can skip the large model and use the deterministic fallback.

## Why This Matters

`sqlite-vec` vector columns are fixed-width. If the app changes from one embedding model dimension to another without rebuilding the virtual table, writes and queries can fail or silently operate against stale derived rows.

Model id isolation matters even when two models produce vectors with the same dimension. Equal width only proves the blobs fit the column; it does not mean distances are meaningful across model spaces. Fallback vectors are useful for deterministic tests and degraded local operation, but they should never rank against real model vectors.

Settings are also part of correctness. If the UI or renderer contract still exposes a remote provider or semantic-off state, the rest of the local-only implementation has to keep defending paths that product no longer supports.

## When to Apply

- Changing the embedding model, embedding dimension, or vector runtime.
- Moving a feature from optional/remote-capable to built-in local-only behavior.
- Adding a new semantic consumer that seeds KNN from a stored element vector.
- Packaging local model/runtime assets that are required in release builds but optional in dev.
- Migrating a derived SQLite index whose schema is coupled to non-SQL model metadata.

## Examples

Use separate ids for real and fallback model outputs:

```ts
const REAL_MODEL_ID = DEFAULT_EMBEDDING_MODEL_ID;
const FALLBACK_MODEL_ID = "local:embeddinggemma-hash-768";
```

Then regression-test mixed-model isolation at each semantic surface:

```ts
const result = semantic.search(queryText, {
  semanticEnabled: true,
  queryVector: embed(queryText),
  queryModelId: REAL_MODEL_ID,
  limit: 10,
});

expect(result.hits.map((h) => h.id)).not.toContain(fallbackElement.id);
```

For element-seeded features, assert that fallback neighbors do not become duplicates, related rows, sibling-source vector-ranked rows, or contradiction candidates for a real-model subject.

Build-script tests should cover the release-only model staging branch without downloading the real model. Export a narrow test seam, inject a mocked Transformers module, and assert three behaviors: ordinary dev builds skip acquisition, required builds fail on acquisition errors, and successful required builds configure cache/local paths and write a readiness marker.

## Related

- [Search filterbar facet counts after search](../ui-bugs/search-filterbar-facet-counts-after-search.md) — adjacent semantic search result contract coverage.
- [SQLite table rebuild with foreign keys on fires ON DELETE actions](../database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md) — adjacent migration-safety warning for SQLite rebuilds and non-empty tests.
