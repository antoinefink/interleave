---
title: "fix: Packaged embedding model load via app.asar.unpacked + debuggable fallback"
type: fix
date: 2026-06-17
status: planned
---

# fix: Packaged embedding model load via `app.asar.unpacked` + debuggable fallback

## Summary

In the packaged macOS app (0.5.0) on-device EmbeddingGemma embeddings silently fall
back to the deterministic lexical embedder, so semantic search runs in "reduced mode".
The embed worker resolves the model directory and the staged `@huggingface/transformers`
dir from `__dirname`, which in a packaged build is a path **through `app.asar`** (a file,
not a directory). `onnxruntime-node` opens the `.onnx` file with a native `open()` that
bypasses Electron's `app.asar` → `app.asar.unpacked` fs redirect → `errno 20` (`ENOTDIR`)
→ the load throws, is caught, and the worker returns a fallback vector. Dev works because
`__dirname` is a real directory.

This plan (1) applies the `app.asar.unpacked` rewrite the codebase already uses for its two
other native assets, lifting that helper into one shared module; and (2) makes the failure
debuggable — surfacing *why* the model didn't load instead of swallowing it, and fixing the
misleading "reinstall the app to repair it" copy.

Root cause is confirmed by reproduction: loading the model through the real
`…/app.asar/dist/resources/transformers/models/…/model_fp16.onnx` path fails with
`ENOTDIR`, while the same files load correctly from the `app.asar.unpacked` path.

---

## Problem Frame

- **Observed:** Settings → Search Intelligence shows "Search model: The on-device model
  isn't loaded… Using basic keyword fallback — quality reduced" and "Model verified ⚠"
  in the packaged app; semantic search is degraded. Works fine under `pnpm dev`.
- **Confirmed cause:** `apps/desktop/src/worker/embedding-model.ts` builds
  `PACKAGED_MODEL_DIR` (line 25) and the staged transformers require path (lines 74–81)
  from `__dirname`. In the packaged app the worker bundle `dist/job-worker.cjs` is packed
  **inside** `app.asar` (only `native/**`, `dist/resources/tesseract/**`, and
  `dist/resources/transformers/**` are `asarUnpack`'d — see
  `apps/desktop/electron-builder.config.cjs`), so `__dirname` is `…/app.asar/dist` and the
  derived asset paths traverse the asar archive. JS `fs` reads are transparently redirected
  to `app.asar.unpacked`; the native `open()`/`mmap` inside `onnxruntime-node` is **not**,
  so it sees a non-directory and fails with `ENOTDIR`.
- **Why it's silent:** a fallback embed is a *successful* job (`modelId =
  FALLBACK_EMBEDDING_MODEL_ID`), never a `kind: "error"`. The caught load error is only
  `console.warn`'d in the worker (whose stdout goes nowhere in a Finder-launched app), so
  the reason never reaches the status surface, a log, or the user.
- **Precedent already in the repo:** `apps/desktop/src/main/native-binding.ts` and
  `apps/desktop/src/main/sqlite-vec-binding.ts` solve the identical problem for
  `better_sqlite3.node` and `vec0.dylib` with a private `asarUnpackedVariant()` rewrite.
  The embed worker is the one native-asset resolver that never got it.

---

## Scope

In scope:
- Resolve the embed worker's model dir + staged transformers dir to `app.asar.unpacked`.
- Lift the duplicated `asarUnpackedVariant()` into one shared module used by all three
  native-asset resolvers.
- Surface the model-load failure reason: thread it from the worker to the semantic status
  surface (so the "Search model" row explains *why*), and persist it to an app-data log
  file (main-owned write).
- Fix the misleading "reinstall the app to repair it" copy and related Settings copy.

### Deferred to Follow-Up Work
- **OCR worker (`apps/desktop/src/worker/ocr.ts`) latent same-shape bug.** `ocr.ts`
  derives `resourcesDir()` from `__dirname` too and its comment claims "electron rewrites
  the worker fork path" — a premise the confirmed embedding bug disproves. OCR likely
  survives today only because tesseract.js reads its assets through JS `fs` (which *is*
  redirected), unlike onnxruntime's native open. Applying the new shared helper to
  `ocr.ts` and correcting the comment is the consistent fix, but OCR was not reported
  broken and warrants its own verification pass. Tracked as follow-up, not done here.

### Non-Goals
- No change to `EMBEDDING_DIM` (768), the model id, dtype, the `vec0` schema, or the
  build-time model staging (`build.mjs`). The model + runtime are already bundled and
  signed correctly; only runtime path resolution is wrong.
- No new renderer filesystem/IPC capability.

---

## Key Technical Decisions

1. **Lift `asarUnpackedVariant()` into `apps/desktop/src/shared/asar.ts` (rule of three).**
   The helper is byte-identical in `native-binding.ts:28-33` and `sqlite-vec-binding.ts:38-43`;
   the embed worker is the third caller. `src/shared/` already holds cross-process code
   (`channels.ts`, `contract.ts`). **Constraint:** the module must import only Node built-ins
   (`node:path`, and `node:fs` only if a candidate-resolver is also lifted) — the worker
   esbuild bundle (`build.mjs:399-429`) inlines everything it imports except a small externals
   list, so any `electron`/`@interleave/db`/`better-sqlite3` dependency would break or bloat
   the DB-free worker. Each bundle inlines its own copy from shared source; that is expected.

2. **Resolve the worker's model path through a pure, exported function.** `embedding-model.test.ts`
   short-circuits on `process.env.VITEST` and never loads the real model, so the rewrite must be
   a pure exported function (e.g. `resolvePackagedModelDir(dirname)` returning the
   unpacked-preferred path) that a unit test can call directly with a mocked `node:fs` — mirroring
   how `resolveNativeBinding` is tested. Apply it to both `PACKAGED_MODEL_DIR` and the staged
   transformers require dir in `loadTransformers()`. `mod.env.localModelPath` (and the staged
   require target) must receive the real on-disk (`app.asar.unpacked`) path.

3. **Add a model-load-failure reason channel; main owns persistence.** Extend the embed
   `result.data` shape with an optional reason string. The worker captures the caught load error
   and includes it when it falls back (still `console.warn`s). Main reads it: `EmbeddingService`
   caches it next to `modelStateCache`, `db-service.semanticStatus()` passes it into
   `assembleSemanticStatus`, and a new optional `SemanticStatusResult` field carries it to the UI.
   This keeps the worker DB/FS-light per `apps/desktop/AGENTS.md`; main does the log write.

4. **Persist the reason to an app-data log file, written by main.** Add `logsDir`
   (`<dataDir>/logs`) to `AppPaths`/`computeAppPaths`/`ensureVaultSkeleton` and append model-load
   failures there from the main-side embed path. This honors the "main is the only code that
   knows absolute on-disk paths" invariant (`paths.ts`) and avoids new worker file I/O. Use
   `app.getPath("logs")`-style app-data location via the existing `dataDir`.

5. **Dedicated status field over reusing `lastError`.** `lastError` means "couldn't index"
   (failed job rows); the model-load reason is a distinct concept tied to `modelState`. Add an
   optional `modelLoadError` to `SemanticStatusResult` rather than overloading `lastError`, so the
   "Search model" row and the "Couldn't index" row stay semantically separate.

---

## Implementation Units

### U1. Lift `asarUnpackedVariant` into a shared module

**Goal:** Single source of truth for the `app.asar` → `app.asar.unpacked` path rewrite, with
direct unit coverage. Pure refactor — no behavior change for the two existing callers.

**Files:**
- `apps/desktop/src/shared/asar.ts` (new) — export `asarUnpackedVariant(p: string): string | null`
  (byte-for-byte the existing logic; `node:path` only).
- `apps/desktop/src/shared/asar.test.ts` (new).
- `apps/desktop/src/main/native-binding.ts` (modify) — import shared helper, delete local copy.
- `apps/desktop/src/main/sqlite-vec-binding.ts` (modify) — import shared helper, delete local copy.

**Approach:** Move the existing function verbatim; keep the existing doc rationale as the module
docblock. Both resolvers keep their candidate-ordering logic and just import the helper.

**Patterns to follow:** existing `native-binding.ts` / `sqlite-vec-binding.ts` structure and their
`.test.ts` (`vi.mock("node:fs")`, `path.sep`-normalized assertions).

**Test scenarios (`asar.test.ts`):**
- Path containing `${sep}app.asar${sep}` → returns the same path with `app.asar.unpacked` substituted.
- Path with no asar marker (dev/test) → returns `null`.
- Only the first `app.asar` segment is rewritten (documents current `String.replace` semantics).
- Windows-style and POSIX separators both handled via `path.sep`.

**Verification:** `native-binding.test.ts` and `sqlite-vec-binding.test.ts` still pass unchanged;
new `asar.test.ts` passes; `pnpm typecheck` clean (no remaining local definitions).

---

### U2. Resolve the embed worker's model + staged transformers paths to `app.asar.unpacked`

**Goal:** The confirmed fix — hand `onnxruntime`/transformers a real on-disk directory so the
native model open succeeds in the packaged app.

**Dependencies:** U1.

**Files:**
- `apps/desktop/src/worker/embedding-model.ts` (modify) — apply the shared rewrite to
  `PACKAGED_MODEL_DIR` (line 25) and the staged transformers require dir in `loadTransformers()`
  (lines 74–81); extract the path computation into a pure exported function.
- `apps/desktop/src/worker/embedding-model.test.ts` (modify) — cover the new pure function.

**Approach:** Add `resolvePackagedModelDir(dirname)` (and reuse for the staged require dir) that
prefers the `asarUnpackedVariant` rewrite when present and the file exists, else the literal path —
the same prefer-unpacked-then-exists ordering as `resolveNativeBinding`. Use the resolved real path
for `existsSync(PACKAGED_MODEL_DIR)`, `mod.env.localModelPath`, and the `nodeRequire(staged)` target.
Keep the `nodeRequire("@huggingface/transformers")` fallback. No change to `allowRemoteModels=false`,
dtype, or device order.

**Patterns to follow:** `resolveNativeBinding` (prefer unpacked rewrite → `existsSync` pick).

**Test scenarios:**
- Given a packaged `…/app.asar/dist` dirname and a mocked fs where only the `app.asar.unpacked`
  variant exists, the resolver returns the unpacked path (`toContain(`${sep}app.asar.unpacked${sep}`)`).
- Given a dev dirname with no asar marker, returns the literal `…/resources/transformers/models` path.
- When neither exists, returns a deterministic value the caller treats as "not packaged" (falls
  through to `MODEL_DIR`) — must not throw.
- The pure function is callable under `VITEST` without loading the model (no transformers import at
  module-eval time for the resolver).

**Verification:** Unit tests pass; pure-function behavior matches the native resolver; reproduced
manually via the `ELECTRON_RUN_AS_NODE` harness against a packaged bundle the resolved path is the
unpacked one and the model loads (see Verification Strategy).

---

### U3. Surface and persist the model-load failure reason

**Goal:** Replace the swallowed `console.warn` with a reason that reaches the status surface and a
durable app-data log, so a future regression is diagnosable without a terminal.

**Dependencies:** U2.

**Files:**
- `apps/desktop/src/worker/messages.ts` (modify) — allow an optional reason on the embed result
  payload (keep Zod validation).
- `apps/desktop/src/worker/embedding-model.ts` / `job-worker.ts` (modify) — capture the caught load
  error message and include it in the result `data` when falling back.
- `apps/desktop/src/main/embedding-service.ts` (modify) — store the reason alongside
  `modelStateCache`; expose via a getter (mirroring `cachedModelState`); append failures to the log.
- `apps/desktop/src/main/paths.ts` (modify) — add `logsDir` (`<dataDir>/logs`) to `AppPaths`,
  `computeAppPaths`, and `ensureVaultSkeleton`.
- `apps/desktop/src/main/semantic-status.ts` (modify) — add `modelLoadError` to
  `SemanticStatusInputs` + forward to result.
- `apps/desktop/src/shared/contract.ts` (modify) — add optional `modelLoadError` to
  `SemanticStatusResult`.
- `apps/desktop/src/main/db-service.ts` (modify) — pass the cached reason into
  `assembleSemanticStatus`.
- Tests: `apps/desktop/src/main/semantic-status.test.ts`, `embedding-service.test.ts`,
  `apps/desktop/src/worker/messages.test.ts`, `apps/desktop/src/main/paths` coverage as applicable;
  update `contract.test.ts` / enumeration fixtures if the new field is enumerated.

**Approach:** Worker → result.data carries an optional `modelLoadError`. The probe
(`probeModelState`) and `applyResult` read it; when present (state `fallback`), cache it and append
a timestamped line to `<logsDir>/embedding.log` from main. `assembleSemanticStatus` forwards
`modelLoadError` only when `modelState === "fallback"`; otherwise `null`.

**Patterns to follow:** `cachedModelState` getter + `modelStateCache` (embedding-service.ts:134,
149-152); `assembleSemanticStatus` input-forwarding (semantic-status.ts).

**Test scenarios:**
- `assembleSemanticStatus` forwards `modelLoadError` when `modelState === "fallback"` and nulls it
  when `ready`.
- The embed result schema accepts a result with and without the optional reason (round-trip).
- `computeAppPaths` includes `logsDir = <dataDir>/logs`; `ensureVaultSkeleton` creates it.
- `EmbeddingService` caches the reason from a fallback probe result and clears it once a `ready`
  result is observed.

**Verification:** Status result includes a human-readable reason in the fallback case; a log line is
appended under app-data `logs/`; no `operation_log` writes added; worker gains no DB/electron deps.

---

### U4. Fix misleading Settings copy and render the reason

**Goal:** Stop telling users to reinstall (which can't fix a path bug) and show the actual reason.

**Dependencies:** U3 (for the `modelLoadError` field).

**Files:**
- `apps/web/src/pages/Settings.tsx` (modify) — replace the line 792 "reinstall the app to repair it"
  hint; when `status.modelLoadError` is present, render it (concise) in the "Search model" row;
  review adjacent copy (lines 605, 620, 632, 817–818) for honesty/consistency.

**Approach:** Conditional hint: when a reason is available, show "Search model couldn't load:
<reason>"; otherwise a non-blaming generic message that does not prescribe reinstalling. Keep the
"Runs entirely on-device…" non-fallback hint. No logic change to `modelState` derivation.

**Patterns to follow:** existing `SettingRow` hint rendering and `modelStateChip` in `Settings.tsx`.

**Test scenarios:** `Test expectation: none — renderer copy/conditional only; covered by existing
Settings rendering and the e2e semantic-status surface.` (If a Settings unit test exists for the
panel, assert the fallback hint no longer contains "reinstall" and renders `modelLoadError` when
present.)

**Verification:** With a fallback status, the panel shows the reason and no "reinstall" text; with a
ready status, the on-device hint shows.

---

## Verification Strategy

- **Definition of Done:** `pnpm lint`, `pnpm typecheck`, `pnpm test` all green; relevant Electron
  `pnpm e2e` for the semantic-status surface where feasible.
- **Pure-resolver unit tests** (U1, U2) are the CI guard — CI never builds a packaged app, so the
  `app.asar` marker + candidate ordering must be covered as pure functions (mocked `node:fs`).
- **Packaged smoke test (manual, gold standard):** this bug *cannot* reproduce in `pnpm dev`.
  Re-confirm with the `ELECTRON_RUN_AS_NODE` harness that the resolved path is the
  `app.asar.unpacked` one and the model loads; ideally a full signed build where Settings → Search
  Intelligence shows "Model verified ✓" / "Vectors compatible ✓" and `modelState === "ready"`.
- The probe must keep bypassing the query cache and use its generous timeout (prior learning:
  `self-healing-derived-index-supervisor.md`) so a cold load is not misreported as fallback.

---

## Risks & Dependencies

- **Contract field addition** (`modelLoadError`): backward-compatible optional field, but check
  `contract.test.ts` / enumeration fixtures and update if the field is enumerated.
- **Worker bundle purity:** the shared `asar.ts` must stay Node-built-ins-only or the worker
  utility process will fail to `require` an externalized electron dep. Guarded by typecheck +
  worker tests.
- **OCR parity (deferred):** leaving `ocr.ts` unchanged is a conscious scope choice; documented as
  follow-up so the latent bug/misleading comment is not lost.

---

## Sources & Research

- Reproduction: native model open through `…/app.asar/…/model_fp16.onnx` → `ENOTDIR`; same files
  load from `app.asar.unpacked`.
- Repo precedent: `apps/desktop/src/main/native-binding.ts`, `apps/desktop/src/main/sqlite-vec-binding.ts`
  (+ their `.test.ts`), `apps/desktop/RELEASE.md`, `docs/tasks/M18-semantic.md`.
- Learnings: `docs/solutions/architecture-patterns/local-only-semantic-search-sqlite-vec-model-isolation.md`,
  `docs/solutions/architecture-patterns/self-healing-derived-index-supervisor.md`.
