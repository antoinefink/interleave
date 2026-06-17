---
title: "Native asset paths in a packaged Electron app must resolve to app.asar.unpacked"
date: 2026-06-17
category: architecture-patterns
module: desktop-packaging
problem_type: architecture_pattern
component: background_job
severity: high
applies_when:
  - "Handing a file path to NATIVE code in a packaged Electron app — a .node addon, a dlopen'd loadable extension, or a native runtime (onnxruntime/tesseract) that opens a model/wasm/dylib by string path"
  - "The path is derived from `__dirname` (or `app.getAppPath()`) inside code that runs from within `app.asar`"
  - "The asset is `asarUnpack`'d by electron-builder (it must be, since native opens cannot read inside the archive)"
  - "A failure to load it degrades silently to a fallback instead of crashing"
related_components: [service_object, database]
tags:
  - electron
  - asar
  - packaging
  - native-addon
  - embedding
  - semantic-search
---

# Native asset paths in a packaged Electron app must resolve to `app.asar.unpacked`

## Context

In the packaged macOS build (Interleave 0.5.0) on-device EmbeddingGemma embeddings
silently fell back to the deterministic lexical embedder — semantic search ran in
"reduced mode" even though the ONNX model, `onnxruntime-node`, and `sqlite-vec` were all
correctly bundled and Developer-ID signed. It worked perfectly under `pnpm dev`.

The embed utility-process worker (`apps/desktop/src/worker/embedding-model.ts`) derived
its model directory and the staged `@huggingface/transformers` directory from
`__dirname`. In a packaged build the worker bundle (`dist/job-worker.cjs`) runs from
**inside** `app.asar`, so `__dirname` is `…/app.asar/dist` and the derived asset paths
traverse the archive: `…/app.asar/dist/resources/transformers/models/…/model_fp16.onnx`.

Electron transparently redirects `app.asar/…` → `app.asar.unpacked/…` **only for
JavaScript `fs` calls**. `onnxruntime-node` opens the `.onnx` weights with a native
`open()`/`mmap` in C++ that **bypasses that redirect**, so it hit `errno 20` (`ENOTDIR`)
— `app.asar` is a file, not a directory, and the native syscall cannot descend into it.
The load threw, was caught, and the worker returned a fallback vector.

This is the third time this exact class of bug appeared in this codebase. The two prior
native assets — `better_sqlite3.node` (`apps/desktop/src/main/native-binding.ts`) and the
`vec0.dylib` loadable extension (`apps/desktop/src/main/sqlite-vec-binding.ts`) — already
solve it with a private `asarUnpackedVariant()` rewrite. The embed worker's model
resolver was the missing "rule of three" caller.

## Guidance

**Any path handed to native code must be rewritten to the `app.asar.unpacked` sibling
before use — the JS `fs` asar redirect does not cover native `open`/`dlopen`/`mmap`.**

1. Keep one shared rewrite helper. Lifted `asarUnpackedVariant()` into
   `apps/desktop/src/shared/asar.ts` (imports `node:path` only, so the DB-free worker
   bundle can include it without pulling in `electron`/`@interleave/db`/`better-sqlite3`).
   `native-binding.ts` and `sqlite-vec-binding.ts` now import it instead of each keeping a
   copy.

2. Resolve with prefer-unpacked-then-exists ordering. A pure `resolveUnpackedDir(p)`
   returns the `app.asar.unpacked` sibling when that real path exists on disk, else `p`
   unchanged (dev/test, where there is no asar). This mirrors `resolveNativeBinding`.

3. Test the rewrite as a pure function with mocked `node:fs`. CI never builds a packaged
   `.app`, so the in-asar path is never exercised there. A pure unit test of the
   `${sep}app.asar${sep}` → `${sep}app.asar.unpacked${sep}` rewrite + candidate ordering is
   the only automated regression guard. Packaged behavior is a manual smoke test (drive the
   real bundle with `ELECTRON_RUN_AS_NODE=1` and confirm the resolved path is the unpacked
   one and the model loads), because the bug is only reproducible in a real asar.

4. Make silent degradation observable. The fallback embed is a *successful* job (it
   returns a fallback `modelId`), so the failed-job-derived `lastError` channel never
   carried the reason. A new channel was needed: the worker now attaches an optional
   `modelLoadError` to the fallback result; main caches it, surfaces it on the semantic
   status surface (the Settings "Search model" row), and appends it to
   `<dataDir>/logs/embedding.log` (main-owned, async, de-duped, crash-safe). The misleading
   "reinstall the app to repair it" copy was replaced with the actual reason.

## Why This Matters

A silent fallback is the worst failure mode: the feature "works" (returns vectors), tests
pass, the build is signed and notarized, and nothing crashes — but the result is quietly
wrong, and the diagnostic that would explain it is `console.warn` in a utility process
whose stdout goes nowhere when the app is launched from Finder. The honest status surface
(see [[self-healing-derived-index-supervisor]]) is what turns "silently degraded" into
"visibly degraded, with a reason." Resolving native paths to `app.asar.unpacked` is what
prevents the degradation in the first place.

## When to Apply

- Adding any new native addon, loadable extension, or native runtime that opens a bundled
  asset (model, wasm, traineddata, dylib) by path in the desktop app.
- Reviewing any `path.join(__dirname, …)` / `app.getAppPath()`-derived path that is later
  handed to a `require('*.node')`, `db.loadExtension()`, `dlopen`, or a native library's
  "load from this path" API.
- Whenever a feature "works in `pnpm dev` but not in the released `.dmg`" and touches a
  bundled binary or model. `__dirname` being a real directory in dev is what masks it.

Note the masking trap: a repro that loads the asset directly from the `app.asar.unpacked`
path will "work" and hide the bug — only the true in-`app.asar` path reproduces `ENOTDIR`.

## Examples

The fix (worker side):

```ts
// apps/desktop/src/shared/asar.ts — single source of truth (node:path only)
export function asarUnpackedVariant(p: string): string | null {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!p.includes(marker)) return null;
  return p.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
}

// apps/desktop/src/worker/embedding-model.ts
export function resolveUnpackedDir(p: string): string {
  const unpacked = asarUnpackedVariant(p);
  if (unpacked && existsSync(unpacked)) return unpacked;
  return p; // dev/test: no asar → unchanged
}
// PACKAGED_MODEL_DIR and the staged transformers require dir both go through this
// before being handed to onnxruntime / transformers.js.
```

Gotchas worth remembering:

- The model-load reason is captured **after** `await loadLocalModel()`, never before — the
  load failure message is set during the await, so reading the module-global earlier misses
  it on the very first fallback (including the first probe).
- Under `exactOptionalPropertyTypes: true`, passing `logsDir: x ?? undefined` to an optional
  `logsDir?: string` dependency is a **type error** — use a conditional spread
  (`...(x ? { logsDir: x } : {})`).
- An async fire-and-forget `appendFile` means a test must poll for the flushed **content**,
  not file existence — the file opens before the write lands.

## Related

- [[local-only-semantic-search-sqlite-vec-model-isolation]] — the model-isolation contract
  this fix must not violate (`EMBEDDING_DIM` = 768 pinned; never persist a fallback vector;
  probe bypasses the query cache).
- [[self-healing-derived-index-supervisor]] — the honest status surface + probe lifecycle
  the `modelLoadError` reason now feeds (point 8 already noted packaging-silent-degradation).
- `apps/desktop/src/main/native-binding.ts`, `apps/desktop/src/main/sqlite-vec-binding.ts` —
  the two prior callers of the same rewrite; `apps/desktop/RELEASE.md` and
  `docs/tasks/M18-semantic.md` carry the original rationale.
