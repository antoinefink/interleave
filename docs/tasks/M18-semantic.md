# M18 — On-device semantic search & AI: embeddings, related items, contradictions (T087–T089)

> **Current T087 override (2026-06-13):** semantic embeddings are local-only and always-on when
> local capability is available. The implementation uses Transformers.js with the local
> EmbeddingGemma-300M ONNX model (`onnx-community/embeddinggemma-300m-ONNX`) and a 768-dimension
> `sqlite-vec` table. There is no remote embedding provider, no embedding API key setting, and no
> semantic-search Settings toggle; legacy stored provider/model/toggle values are accepted only for
> compatibility and coerced to the local EmbeddingGemma shape. Older MiniLM / fastembed / API /
> off-by-default wording below is historical and superseded by this note.

Detailed, buildable specs for the first three tasks of M18 — the **semantic** layer that sits
on top of the M8 keyword search (T042 FTS5) and the M12 background runner (T058). All three are
**100% on-device**: there is **no server, no Postgres, no `pgvector`** in the loop. Three
capabilities land:

- **T087 — Semantic search (local):** **on-device embeddings** for sources / extracts / cards,
  computed on the **T058 `utilityProcess` runner** (a new `embed` job, already a reserved
  `JobType`) using a **local ONNX MiniLM model** (default) **or** the user's **own embedding API
  key** (opt-in), stored in a **`sqlite-vec` `vec0` virtual table** loaded into the same
  better-sqlite3 connection in the Electron MAIN. A new `SemanticSearchRepository` runs a
  `vec0` KNN MATCH and the existing `SearchRepository.search` (FTS5) and **fuses** them, so
  search finds conceptually related material **without** a keyword match. **OFF BY DEFAULT** —
  when semantics are disabled (or the model has not been downloaded), search degrades cleanly to
  FTS-only.
- **T088 — Related-item suggestions:** each element's inspector shows **similar extracts**,
  **possible duplicates**, **prerequisite concepts**, and **sibling sources** — all derived from
  **`vec0` nearest-neighbors** over the T087 store (plus the existing lineage edges), surfaced
  through a new `semantic.related` command. These are **derived/suggestive reads**, not new
  op-logged relations (`RELATION_TYPES` stays the closed set).
- **T089 — Contradiction detection:** **semantic similarity + claim metadata** flag possibly
  **conflicting** cards/extracts ("a newer source conflicts with an older card"). A pure
  `packages/core` heuristic combines high cosine similarity with **opposing/superseding** signals
  (negation, numeric divergence, a newer `accessedAt`/`publishedAt` source than the card's
  source). It is **explicitly heuristic and suggestive**, never authoritative — a flag the user
  reviews, never an automatic edit.

After M18's first three tasks the knowledge base becomes **conceptually navigable**: a user can
find material by meaning (not just keywords), see what an element relates to, and be warned when
two pieces of knowledge may disagree — all locally, with the heavy compute off the main thread,
and **degrading gracefully** to keyword-only when the embedding model/AI is off.

The architecture is unchanged and non-negotiable (see [`../../CLAUDE.md`](../../CLAUDE.md), the
roadmap M18 header [`../roadmap.md`](../roadmap.md) lines ~306–332, and the rewritten AI/search
sections of [`../architecture.md`](../architecture.md) lines ~21, ~73–77, ~253–257). The React
**renderer** (`apps/web`) never touches SQLite, Node, the filesystem, the embedding model, or
any AI API. Every read/mutation flows React UI → typed client wrapper
(`apps/web/src/lib/appApi.ts`) → preload bridge (`apps/desktop/src/preload/index.ts`) →
validated IPC (Zod) on the main side (`apps/desktop/src/main/ipc.ts`) → `DbService`
(`apps/desktop/src/main/db-service.ts`) → `packages/local-db` repositories + the T058
`JobRunner` → SQLite + the `sqlite-vec` index + the local model. **Embeddings/AI never reach a
first-party server by default** — the optional managed proxy (deferred to T093) is off until the
user enables it, and enabling it visibly discloses that content is sent.

> **Local-first invariants (load-bearing — every deliverable honors these).**
> 1. **No server, no `pgvector`.** The vector store is `sqlite-vec` (`vec0`) on the **same
>    better-sqlite3 file** the rest of the app uses. The semantic search query, the KNN, and the
>    index all live on-device. (The roadmap re-scope explicitly replaced Postgres/pgvector with
>    a local vector store — [`../roadmap.md`](../roadmap.md) line ~316,
>    [`../architecture.md`](../architecture.md) lines ~253–254.)
> 2. **Embeddings run on the T058 runner, never inline on main.** A new `embed` job (already a
>    reserved `JobType` in [`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts)
>    line ~201) runs the model in the **DB-free `utilityProcess` worker**; **main** writes the
>    resulting vector into `vec0` through a repository (single-writer). This is the **exact
>    `fsrs_optimize` / `ocr` pattern** already shipped (T080/T066) — a DB-free worker computes,
>    a main-side apply handler persists.
> 3. **Single-writer SQLite stays main-owned.** The worker NEVER opens the DB and NEVER loads
>    `sqlite-vec`. It produces a plain `Float32Array`/number[] and posts it back; main loads the
>    extension once at open and writes the vector.
> 4. **Off by default, graceful degrade.** Semantic search is a **setting** (`semanticSearchEnabled`,
>    default `false`). When disabled — or the model is not present, or `sqlite-vec` failed to
>    load — every semantic surface **falls back to FTS-only / hides**, and **never throws**.
> 5. **The closed `OPERATION_TYPES` set does not grow.** Embeddings are a **derived index** (like
>    FTS5), not a domain mutation — they append **NO `operation_log` entry** (document this in
>    the repo docblock, mirroring `AssetRepository`/`JobsRepository`). Related-items and
>    contradictions are **derived reads**, not new relations — `RELATION_TYPES`
>    ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts) line ~77) stays
>    closed.
> 6. **Lineage sacred.** Nothing here mutates lineage. Related/duplicate/conflict flags are
>    presentation over the existing `element_relations` + `sources` + `source_locations` graph.

### What already exists (inspect before building — do not duplicate)

The M8 (search) and M12 (runner) substrate provides almost the entire seam M18 plugs into; M18
adds **one native dependency (`sqlite-vec`), one local model, two migrations, three repositories,
the `embed` job apply path, and three `semantic.*` commands + the inspector panel**.

- **The runner + the `embed` JobType (T058 — `[x]`).**
  - `JOB_TYPES` ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts) lines
    ~193–214) **already reserves `embed`, `ai`, `cleanup`** — "declared, not yet wired" — so M18
    adds an `embed` worker dispatch case + a main-side apply handler **without a `JOB_TYPES`
    change**, exactly as the spec promised (the `jobs.type` CHECK already permits it). (`ai` is
    reserved for T093, out of this file's scope.)
  - `JobRunner` ([`../../apps/desktop/src/main/job-runner.ts`](../../apps/desktop/src/main/job-runner.ts)):
    `enqueue(type, payload, opts?)` (~line 200+), the apply-handler registry
    `JobApplyHandlers = Partial<Record<JobType, JobApplyHandler>>` (~lines 64–70), `observe()`
    (the `job:update` emitter the renderer subscribes to), and **the fork-env seam** — the
    default fork already passes `INTERLEAVE_ASSETS_DIR` into the worker's env
    (`defaultFork`, ~lines 132–144). **M18 adds an analogous `INTERLEAVE_MODEL_DIR`** so the
    DB-free worker can resolve the bundled/downloaded ONNX model path (the same seam, one more
    env var).
  - The **worker** ([`../../apps/desktop/src/worker/job-worker.ts`](../../apps/desktop/src/worker/job-worker.ts)):
    `dispatch(jobId, type, payload)` switch (~lines 160–193) with `url_import` / `ocr` /
    `fsrs_optimize` / `vault_verify` / `vault_gc` cases — **M18 adds a `case "embed":`** calling
    a new `runEmbed(jobId, payload)` that loads the model and posts `{ kind: "result", jobId,
    data: { vectors } }`. The worker talks over `process.parentPort` (~line 64) and posts
    `progress`/`result`/`error` ([`../../apps/desktop/src/worker/messages.ts`](../../apps/desktop/src/worker/messages.ts),
    the Zod-validated `WorkerRequest`/`WorkerMessage` shapes — `JsonValueSchema` already carries
    arbitrary JSON, so an embedding `number[][]` is a valid `result.data` with no message-shape
    change).
  - The **apply-handler registry** ([`../../apps/desktop/src/main/job-apply-handlers.ts`](../../apps/desktop/src/main/job-apply-handlers.ts)):
    `createJobApplyHandlers(deps)` returns `{ ocr, fsrs_optimize, vault_verify, vault_gc,
    url_import }` — **M18 adds an `embed` handler** that calls a new `EmbeddingService.applyResult`
    (mirroring how `ocr` calls `OcrService.applyResult` ~lines 87–92). The `deps` object gains a
    `getEmbeddingService` lazy accessor (mirroring `getOcrService`).
- **`OcrService` — the exact template for `EmbeddingService`**
  ([`../../apps/desktop/src/main/ocr-service.ts`](../../apps/desktop/src/main/ocr-service.ts)):
  `enqueuePage(...)` writes a vault file then `this.getRunner().enqueue("ocr", payload)` and
  returns `{ jobId }` (~lines 102–122); `applyResult(payload, result)` UPSERTs the worker output
  through a repository (~lines 131+), idempotent by key. **`EmbeddingService` mirrors this 1:1**:
  `enqueueElement(elementId)` (build the text payload in main → `enqueue("embed", payload)`),
  `applyResult(payload, result)` (UPSERT the vector into `vec0` by `element_id`).
- **The FTS5 search seam (T042 — `[x]`).**
  - `SearchRepository` ([`../../packages/local-db/src/search-repository.ts`](../../packages/local-db/src/search-repository.ts)):
    `search(query, options): SearchHit[]` (~lines 164+) where
    `SearchHit = { id, type: "source"|"extract"|"card", title, snippet, score }` (the `bm25`
    rank, lower is better, ~lines 87–95); `toMatchExpression(raw)` (~lines 124–133, the safe
    FTS5 MATCH builder); `query(...)` (the back-compat `Element[]` surface). **This is the seam
    semantic search FUSES with** — the new `SemanticSearchRepository.search` calls **both**
    `SearchRepository.search` (FTS) and the `vec0` KNN and merges them.
  - The FTS5 migration `packages/db/drizzle/0002_search_fts5.sql` (referenced in the
    `SearchRepository` docblock) is the **precedent for a hand-authored virtual-table migration**
    — M18's `vec0` migration follows the same hand-authored pattern (Drizzle does not model
    virtual tables).
  - The `search.*` IPC surface: channel `searchQuery: "search:query"`
    ([`../../apps/desktop/src/shared/channels.ts`](../../apps/desktop/src/shared/channels.ts)
    line ~123); `SearchResult` + `search` group on `AppApi`
    ([`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts)
    lines ~3629–3712, ~4696+); the `/search` `LibraryScreen` (the screen the semantic toggle +
    fused results render in).
- **The DB open path + native-binding precedent (T007/T050).**
  - `openDatabase(filename, { nativeBinding })` ([`../../packages/db/src/client.ts`](../../packages/db/src/client.ts)
    lines ~56–63) opens better-sqlite3 and applies pragmas; `DbHandle = { db, sqlite }` exposes
    the **raw `sqlite` handle** — that is where `sqliteVec.load(sqlite)` (which calls
    `sqlite.loadExtension(...)`) runs. **`OpenDatabaseOptions` gains an optional
    `loadSqliteVec?: boolean`** (or main calls a `loadVectorExtension(handle.sqlite, binaryPath)`
    helper right after open — pick one; the helper keeps the package dependency-free for tests
    that don't need vec).
  - `resolveNativeBinding(distDir)` ([`../../apps/desktop/src/main/native-binding.ts`](../../apps/desktop/src/main/native-binding.ts)):
    the **exact precedent for shipping a native artifact in a packaged Electron app** — it finds
    `better_sqlite3.node` and prefers the `app.asar.unpacked` rewrite because **a native addon
    cannot be `dlopen`ed from inside an asar archive** (~lines 28–34, 49–58). The `sqlite-vec`
    `.dylib`/`.so`/`.dll` has the **same constraint** — M18 adds `resolveSqliteVecBinary(distDir)`
    that finds `vec0.{dylib,so,dll}` with the same `asarUnpack` discipline.
  - `db-service.ts` `open()` ([`../../apps/desktop/src/main/db-service.ts`](../../apps/desktop/src/main/db-service.ts)
    ~lines 513–544) already threads `nativeBinding` from the main bootstrap; the vec-load call
    slots in right after `openDatabase(...)` and before `createRepositories(...)`.
- **Settings (T011) — the on/off + API-key + model home.**
  - `AppSettings` / `SETTINGS_KEYS` / `DEFAULT_APP_SETTINGS`
    ([`../../packages/core/src/settings.ts`](../../packages/core/src/settings.ts) lines ~70–163):
    the typed key/value model. **M18 adds the M18 settings keys** (below) here, with defaults,
    the stable storage strings, and coercion — exactly like `fsrsParamsGlobal` (T080) was added.
  - `SettingsRepository` (`packages/local-db/src/settings-repository.ts`) + the
    `settings.getAll/updateMany` IPC surface — already wired; M18 only adds keys.
- **Source provenance + `SourceRef` (T014/T043) — the claim/recency signals for T089.**
  - `sources` schema ([`../../packages/db/src/schema/sources.ts`](../../packages/db/src/schema/sources.ts)
    lines ~28–40): `url`, `canonicalUrl`, `originalUrl`, `author`, `publishedAt`, `accessedAt`,
    `snapshotKey`, `reasonAdded`. T089's "newer source" signal reads `publishedAt`/`accessedAt`.
  - `SourceRef` + `formatSourceRef` ([`../../packages/core/src/source-ref.ts`](../../packages/core/src/source-ref.ts)):
    the framework-agnostic citation shape T088/T089 reuse to render the related/conflicting item's
    origin. Note `yearOf(publishedAt)` (~line 79) is a **private, non-exported** helper — it is the
    *pattern* T089's recency signal mirrors, but `contradiction.ts` cannot import it as-is. T089
    must either **export `yearOf` from `source-ref.ts`** for reuse OR **derive the year inline** in
    the pure heuristic (it takes the source dates as plain strings — see T089).
- **The inspector (T010/T041/T043) — where T088 renders.**
  `InspectorGetResult` ([`../../apps/desktop/src/shared/contract.ts`](../../apps/desktop/src/shared/contract.ts)
  line ~416) + `Inspector.tsx` (`apps/web/src/components/inspector/Inspector.tsx`) already render
  type/status/stage/priority/tags/provenance/lineage with the `insp-sec`/`MetaRow` structure.
  **T088 adds a "Related" `insp-sec`** fed by `semantic.related`, reusing `ConceptTag`/`Tag`/the
  `RefBlock` primitives.
- **Concepts + relations (T041) — the `prerequisite concepts` + `sibling sources` inputs for T088.**
  - `RELATION_TYPES` ([`../../packages/core/src/enums.ts`](../../packages/core/src/enums.ts)
    lines ~77–83): the **closed** set — `parent_child`, `derived_from`, `sibling_group`,
    `concept_membership`, `references` (the lineage edges are `parent_child` + `derived_from`;
    there is no member literally named `lineage`). **No `duplicate`/`prerequisite`/`conflicts`
    member** → T088/T089 are **derived**, not persisted relations. "Sibling sources" = sources
    sharing a `concept_membership`; "prereq
    concepts" = the parent chain in `concepts.parentConceptId`
    ([`../../packages/db/src/schema/organize.ts`](../../packages/db/src/schema/organize.ts)) of
    the element's member concepts, ranked by vector similarity.
- **The seed/fixtures (T009):** `DEMO_FIXTURES` + factories
  ([`../../packages/testing/src/factories.ts`](../../packages/testing/src/factories.ts)) seed a
  source + extract + sub-extract + Q&A + cloze + concept hierarchy + tags. M18 tests embed these
  seeded elements (with a **deterministic fake embedder** in unit/integration tests — never the
  real model under Vitest, which has no model bundle) and assert KNN/related/conflict behavior.

### What M18 (T087–T089) must add (the gaps)

- **The native vector store + model dependency** (T087): add `sqlite-vec` (npm) + a bundled
  ONNX MiniLM model (e.g. `all-MiniLM-L6-v2`, 384-dim) via `@huggingface/transformers`
  (transformers.js v3, ONNX runtime) **or** `fastembed-js`. Load `vec0` into the main
  better-sqlite3 connection; ship the binary `asarUnpack`ed like `better_sqlite3.node`.
- **Two migrations** (T087): the `embeddings` bookkeeping table (which elements are embedded,
  with which model + a content hash so re-embed is idempotent + skip-if-unchanged) — generated by
  `pnpm db:generate`; and the **hand-authored** `vec0` virtual-table migration (Drizzle can't
  model it, exactly like FTS5's `0002`). **Do NOT hard-code the migration indices** — the latest
  is `0020_optimal_zombie.sql`, but T087–T095 are parallel siblings in the same milestone built
  sequentially, so each slice consumes the next free index. **Use the next two available indices
  in `meta/_journal.json` at build time** (the bookkeeping table, then the `*_semantic_vec0.sql`
  vec0 table) — whichever M18 slice built first will already have taken `0021`+.
- **`EmbeddingService` + `EmbeddingRepository` + `SemanticSearchRepository`** (T087), the `embed`
  worker case + apply handler, and the `semantic.*` IPC surface (`reindex`/`status`/`search`).
- **`semantic.related`** (T088) + the inspector "Related" panel.
- **A pure `detectContradictions` heuristic in `packages/core`** (T089) +
  `semantic.contradictions` + a calm "possible conflict" surface on the card/extract.
- **The M18 settings**: `semanticSearchEnabled`, `embeddingProvider` (`local`|`api`),
  `embeddingApiKey` (the user's own key, opt-in), `embeddingModelDownloaded` (first-run state).

Read first:
- [`../../CLAUDE.md`](../../CLAUDE.md) — "Preferred stack" (FSRS for cards; custom scheduler for
  topics/tasks; **AI drafts only**); "MVP boundaries" (semantic search is a Part-II gold-standard
  feature, **local-first**); "SQLite rules" (single-writer, WAL, no large blobs); "Data rules"
  (closed `operation_log`, soft-delete); "Architectural rules" (no domain logic in React).
- [`../architecture.md`](../architecture.md) — lines ~21 / ~73–77 / ~253–257 (embeddings + AI +
  search run **on-device**; the vector store is `sqlite-vec`, **not** `pgvector`; AI uses a local
  model or the user's own key; the managed proxy is off by default).
- [`../roadmap.md`](../roadmap.md) — the **M18 header** (lines ~306–314: local-first; off-by-
  default; AI output is drafts) and the **T087–T089 lines** (~315–320).
- [`../domain-model.md`](../domain-model.md) — element types (incl. `task`, `synthesis_note`);
  "Relationships & lineage" (the closed `RELATION_TYPES`; concepts hierarchical via
  `concepts.parentConceptId`; the sacred `card → extract → source location → source` chain).
- [`./M8-organize.md`](./M8-organize.md) — the T042 FTS5 search seam this builds on (the
  hand-authored virtual-table migration pattern, the `search.*` surface, the `LibraryScreen`).
- [`./M12-runner-and-vault.md`](./M12-runner-and-vault.md) — the **T058 runner** the `embed` job
  runs on (the DB-free worker + main-side apply contract; the `INTERLEAVE_ASSETS_DIR` fork-env
  seam the `embed` job extends with `INTERLEAVE_MODEL_DIR`; the "every apply handler MUST be
  idempotent/dedup-guarded" rule).
- [`./_TEMPLATE.md`](./_TEMPLATE.md) — the required spec shape.
- `sqlite-vec` docs: `npm install sqlite-vec`; `import * as sqliteVec from "sqlite-vec";
  sqliteVec.load(db)` (better-sqlite3); `CREATE VIRTUAL TABLE … USING vec0(embedding float[384])`;
  KNN `WHERE embedding MATCH :query ORDER BY distance LIMIT k` returning `rowid, distance`.

Build order is the task order. **T088 deps T087; T089 deps T087** — T088 and T089 are
independent of each other and can proceed in parallel once the T087 `vec0` store + `semantic.*`
seam exist.

---

## T087 — Semantic search (local)

- **Status:** `[ ]` not started  · **Depends on:** T058 (the runner), T042 (FTS5 search)
- **Roadmap line:** Done when embeddings for sources/extracts/cards are generated **on-device**
  (a local model via the background runner, or an embedding API called with the user's own key)
  and stored in a **local vector index** (e.g. `sqlite-vec` on the same better-sqlite3 DB); search
  finds conceptually related material without keyword match. (Re-scope: local vector store, **not**
  Postgres/pgvector.)

### Goal

The app gains **on-device semantic search**. Each live `source` / `extract` / `card` is
embedded into a vector by a job on the **T058 runner** — by default a **bundled local ONNX MiniLM
model** running in the DB-free worker, or (opt-in) by an **embedding API called with the user's
OWN key**, never our server. **Main** stores the vector in a **`sqlite-vec` `vec0` virtual table**
on the same SQLite file. A new `SemanticSearchRepository` answers a query by embedding the query
text, running a `vec0` **KNN** (cosine/L2 nearest-neighbors), and **fusing** the result with the
existing **FTS5** keyword hits (reciprocal-rank fusion) — so the `/search` library finds
conceptually related material **even when no keyword matches** ("spaced repetition" surfacing a
card about "review intervals"). The whole feature is **OFF BY DEFAULT** (`semanticSearchEnabled =
false`): when disabled, the model is absent, or `sqlite-vec` fails to load, search **degrades to
FTS-only** and never throws. The renderer reaches all of this only through a typed `semantic.*`
`window.appApi`; the model, the extension, and the vectors never leave the device.

### Context to load first

- Reference: the roadmap M18 header + T087 line; [`../architecture.md`](../architecture.md) lines
  ~253–254 (local `sqlite-vec`, not pgvector); [`./M12-runner-and-vault.md`](./M12-runner-and-vault.md)
  (the DB-free-worker + main-apply contract; the fork-env seam; idempotency).
- Existing code to inspect (all cited above): `JOB_TYPES` (`embed` reserved),
  `job-worker.ts` `dispatch` switch, `job-apply-handlers.ts` `createJobApplyHandlers`,
  `OcrService` (the enqueue+applyResult template), `JobRunner` `defaultFork`/`enqueue`/`observe`,
  `SearchRepository.search` + `SearchHit` + `toMatchExpression`, `openDatabase`/`DbHandle.sqlite`,
  `resolveNativeBinding` (the asar-unpack precedent), `AppSettings`/`SETTINGS_KEYS`, the
  `search.*` IPC seam + `LibraryScreen`.
- Invariants in play: the **worker never opens the DB and never loads `sqlite-vec`** (it returns
  a `number[]`); **main is the single writer** and the only place `vec0` is read/written;
  embeddings append **NO `operation_log`** (derived index); **off by default + graceful FTS-only
  fallback**; the embedding is **idempotent** (re-embedding an unchanged element is a no-op via a
  content hash) and **at-least-once safe** (a crash-resume re-run UPSERTs the same vector).

### Library + model decisions (pick + justify — REQUIRED; build to these)

1. **Vector store: `sqlite-vec` (`vec0`), loaded into the main better-sqlite3 connection.**
   - **Why `sqlite-vec` over `pgvector`/Chroma/an in-process JS HNSW:** the roadmap re-scope
     mandates a **local** store on the **same SQLite file** (no server, no second datastore) so
     the vectors back up with the DB (the T055 encrypted-backup archive captures the one
     `app.sqlite`), survive restart, and need no extra process. `sqlite-vec` is a single C
     extension that loads into better-sqlite3 via `db.loadExtension(...)` (the `sqliteVec.load(db)`
     helper) and exposes `vec0` virtual tables with `MATCH`-based KNN — it is the canonical
     local-first choice the architecture doc names. A pure-JS HNSW would re-implement persistence
     + risk drift from the canonical DB; `pgvector` requires a Postgres server (explicitly out).
   - **Electron load + ship story (this is the central T087 infra risk — spell it out):**
     `sqlite-vec` ships prebuilt loadable binaries (`vec0.dylib`/`.so`/`.dll`) via its npm
     package. `sqliteVec.load(sqlite)` calls `sqlite.loadExtension(absolutePath)`. **Constraints,
     mirrored from the `better_sqlite3.node` precedent:** (a) the extension must match the
     platform/arch (ship per-target; `electron-builder` already builds per-platform); (b) a
     loadable extension **cannot be `dlopen`ed from inside `app.asar`** — so the binary is
     **`asarUnpack`ed** (extend the existing `electron-builder.yml` `asarUnpack` glob that already
     unpacks `native/**`), and a new `resolveSqliteVecBinary(distDir)` finds the
     `app.asar.unpacked` path first (copy the `asarUnpackedVariant` logic from `native-binding.ts`
     verbatim); (c) loading is gated by `sqlite.loadExtension` being permitted — better-sqlite3
     allows it by default on a normal `Database` handle (no special compile flag needed; verify
     `PRAGMA compile_options` does NOT include `OMIT_LOAD_EXTENSION` — note it in the migration/
     load helper).
   - **CRITICAL — the better-sqlite3-12 ↔ sqlite-vec ABI mismatch (a successful load is NOT
     enough; spell this out and build to it).** This repo pins **better-sqlite3 `^12.10.0`**
     (`packages/db/package.json:26`, `apps/desktop/package.json:22`), which bundles a **newer
     SQLite (~3.50/3.51.x)**, while the prebuilt `sqlite-vec` (v0.1.9) loadable binaries are
     compiled against an **older SQLite (~3.45.x)**. (Build-time guard scripts referenced here land
     in `apps/desktop/scripts/` alongside `vendor-native.mjs` — there is no top-level `scripts/`
     dir for these.) The documented, recurring failure mode is
     that **`db.loadExtension` SUCCEEDS (no throw) but `vec0` registers NO functions** — so a later
     `CREATE VIRTUAL TABLE … USING vec0(…)` or a KNN `MATCH` **silently fails / throws on first
     use** instead of degrading. Therefore **a successful `loadExtension` call must NOT be the
     source of truth for `vecAvailable`.** Instead, **`vecAvailable` is set from a FUNCTIONAL
     round-trip smoke test** run once at `db-service.open()` after the load: `load → vec_version()
     returns a string → CREATE VIRTUAL TABLE _vec_smoke USING vec0(embedding float[384]) → INSERT
     one float[384] row → KNN WHERE embedding MATCH :q ORDER BY distance LIMIT 1 returns the row →
     DROP _vec_smoke`. Only if **every** step succeeds is `vecAvailable = true`; any throw at any
     step (the load-succeeds-but-no-functions case included) sets `vecAvailable = false`, logs the
     ABI-mismatch hint, and the app **continues FTS-only**. This keeps the graceful degrade honest
     — otherwise a loaded-but-non-functional `vec0` throws on the first real `vec0` query instead
     of degrading. **Build-time guard:** add a check (in `apps/desktop/scripts/vendor-sqlite-vec.mjs`
     or a CI
     step) that the shipped `sqlite-vec` binary's SQLite ABI is compatible with the `better-sqlite3`
     build — run the same functional smoke test against the packaged binary at build time and
     **fail the build** if it does not register `vec0` functions — OR pin `better-sqlite3` to a
     `sqlite-vec`-compatible SQLite version; document whichever is chosen in the load-helper
     docblock. **Load once in `db-service.open()`** right after `openDatabase(...)` and BEFORE
     `migrateDatabase(...)` (so the migration guard can read `vecAvailable` — see below), wrapped in
     try/catch, and run this functional smoke test there to set `this.vecAvailable`. The dev
     scripts / Vitest path (Node-ABI better-sqlite3) load the **Node** `sqlite-vec` binary the npm
     package resolves for the host — but that host better-sqlite3 is ALSO 12.x, so the **same
     functional smoke test (not mere resolvability) gates whether the real-`vec0` integration tests
     run** (see the test deliverables): the suite skips with a clear message on an ABI-mismatched
     host instead of failing inside a `vec0` query it assumed worked.
   - **Vendoring:** add a `apps/desktop/scripts/vendor-sqlite-vec.mjs` (mirroring the existing
     `apps/desktop/scripts/vendor-native.mjs` — the precedent lives in `apps/desktop/scripts/`, NOT
     a top-level `scripts/` dir, so land the new vendor script as its sibling) that copies the
     platform `vec0.*` into `apps/desktop/native/` for packaging, OR resolve it from the installed
     `sqlite-vec` package at runtime in dev and from `app.asar.unpacked` when packaged — pick one and
     document it next to `resolveNativeBinding`'s docblock.

2. **Embedding model: a bundled local ONNX MiniLM (default), the user's own API key (opt-in).**
   - **Default = local `all-MiniLM-L6-v2` (384-dim) via `@huggingface/transformers` (transformers.js
     v3, onnxruntime-node).** **Why:** it is small (~23 MB quantized int8 ONNX), CPU-only, fast
     enough per element, fully offline, and a well-understood sentence-embedding baseline — good
     enough for "find conceptually related material". It runs in the **DB-free worker** (no
     Electron/DB import). **Honest first-run UX (REQUIRED to spell out):** bundling ~23 MB in the
     app is acceptable but inflates the installer; the chosen approach is **download-on-first-
     enable**, and it uses the **same concrete download discipline T093 pins for its local-model
     fetch** (`docs/tasks/M18-ai.md` `AiService.downloadModel`) — do NOT leave "a job / a guarded
     fetch" unresolved. Concretely: a **guarded MAIN-side fetch** (not a worker job, not a new
     `JOB_TYPES` member) streams the model files to `INTERLEAVE_MODEL_DIR` under the app data dir
     via a `*.partial` temp path with a **content-length / checksum integrity check** + **atomic
     rename** on completion, emits progress over a **dedicated `semantic:modelDownload` named
     event** (mirroring T093's `ai:modelDownload`), is **cancellable** (`AbortController`), and on
     success flips `embeddingModelDownloaded = true` in `settings` **in one transaction**
     (idempotent — re-running with verified files present just re-flips the flag). Until it
     completes, `embeddingModelDownloaded = false` and search stays FTS-only with a
     "Downloading model…" affordance. The model files are **cached on disk** and reused across
     restarts. (Alternative: bundle the model in `resources/` and skip the download — note the
     installer-size tradeoff; either is acceptable, pick one and document it.) **No model bytes are
     sent anywhere** — the download is from the public model host (Hugging Face) the first time
     only; the embeddings are computed locally thereafter.
   - **Opt-in API provider:** when `embeddingProvider = "api"` and `embeddingApiKey` is set, the
     **worker** calls the user's chosen embedding endpoint (OpenAI `text-embedding-3-small`, etc.)
     with the user's key, posts the vector back. **The key lives in SQLite settings, never our
     server; the only network call is to the provider the user configured.** Dimension must match
     the `vec0` column — **store the model id + dim per embedding row** (the `embeddings` table)
     and **refuse to KNN-mix vectors of different models/dims** (a model change triggers a re-index;
     see Notes). For T087, support **one active model at a time** (the active model id is a setting);
     switching models re-embeds.
   - **transformers.js vs fastembed-js:** prefer `@huggingface/transformers` (active, ONNX,
     broad model support, runs in a Node worker). `fastembed-js` is acceptable (smaller surface).
     Justify the pick in the `embedding-model.ts` worker module docblock.

### The data model (specify concretely)

- **`embeddings` table** (Drizzle, generated via `pnpm db:generate` at the **next free migration
  index** — do NOT hard-code `0021`; see the migrations note above) — bookkeeping that maps each
  embedded element to its `vec0` rowid + the model + a content hash, so re-embed is idempotent and
  skip-if-unchanged works. Module `packages/db/src/schema/embeddings.ts`, mirroring the
  `assets`/`jobs` table shape:
  - `element_id` (text PK, FK → `elements.id` `onDelete: "cascade"` — when an element is hard-
    purged the bookkeeping row goes too); `vec_rowid` (integer, the `vec0` table's rowid, UNIQUE);
    `element_type` (text, `check` against `source`/`extract`/`card`); `model_id` (text, e.g.
    `"local:all-MiniLM-L6-v2"` or `"openai:text-embedding-3-small"`); `dim` (integer);
    `content_hash` (text — sha256 of the exact text that was embedded, so an unchanged element is
    skipped and a changed one is re-embedded); `created_at`/`updated_at` (text ISO). Indexes:
    `embeddings_type_idx` on `element_type`, `embeddings_model_idx` on `model_id`. Export from the
    schema barrel. **No op-log** (derived index).
  - **Why a sidecar bookkeeping table + a separate `vec0` table** (not embedding columns on a
    domain table): `vec0` is a virtual table addressed by `rowid` and cannot hold the FK/cascade/
    hash metadata; the sidecar carries the join + the idempotency hash + the model id. The cascade
    on `embeddings` removes the bookkeeping row on purge; the matching `vec0` rowid is pruned by the
    **DEFAULT path: an explicit application-level delete** — `EmbeddingRepository.delete(elementId)`
    deletes the `element_vectors` rowid **and** the bookkeeping row in one transaction, which is
    fully portable and never depends on virtual-table trigger support. A `DELETE` trigger on
    `embeddings` (prune the `element_vectors` row by `vec_rowid`) is an **OPTIONAL, verified-only
    optimization** layered on top — ship it **only if** a smoke test proves the shipped
    `sqlite-vec` permits a DELETE issued from inside a trigger body against the `vec0` virtual table
    (`vec_version()` + assert the trigger fires and the rowid is gone); some virtual-table
    implementations restrict trigger-driven writes (the same write-restriction family as the ABI
    risk), so **cleanup correctness must never depend on the trigger.** A `vault_gc`-adjacent sweep
    that removes any `element_vectors` rowids with no surviving `embeddings` row is the
    belt-and-braces backstop. (If the trigger IS shipped and active, the explicit delete is a
    harmless no-op double-delete.)
- **`vec0` virtual table** (a hand-authored `*_semantic_vec0.sql` at the **next free index after
  the `embeddings` migration** — do NOT hard-code `0022`; **hand-authored** because Drizzle can't
  model it, exactly like FTS5's `0002`):
  `CREATE VIRTUAL TABLE element_vectors USING vec0(embedding float[384]);` (the dim is a constant
  shared with `packages/core`, e.g. `EMBEDDING_DIM = 384`; if a model with a different dim is
  chosen the constant + the DDL move together — note this couples the migration to the default
  model). Registered in `packages/db/drizzle/meta/_journal.json` like `0002`, applied by both the
  dev migrator and the Electron-startup migrator. **Guard (name the concrete skip mechanism — the
  stock migrator has NO per-migration hook).** `migrateDatabase` is Drizzle's standard
  `migrate(db, { migrationsFolder })` (`packages/db/src/migrator.ts:11,17`), which applies **every**
  journaled `.sql` **unconditionally** — there is no built-in per-migration feature check, so a
  `CREATE VIRTUAL TABLE … USING vec0(…)` against a connection where vec is NOT loaded **throws and
  breaks `migrateDatabase`** (it does not silently skip). The FTS5 `0002` precedent does not hit this
  because better-sqlite3 ships `ENABLE_FTS5` compiled in; `vec0` is a runtime-loaded extension that may
  be absent. Pick **ONE** concrete mechanism and build to it (do NOT write "a feature check"):
  - **In production / Electron main:** the load + `vecFunctional` check runs BEFORE `migrateDatabase`
    (see the `db-service.open()` deliverable), so when `vecAvailable` is `true` the `vec0` DDL applies
    normally and the migrator needs no guard there.
  - **For the dev migrator + the Vitest test DB (the connection that may lack the extension):** the
    chosen mechanism is a **thin guarded migrator wrapper** in `@interleave/db` — e.g.
    `migrateDatabase(db, { migrationsFolder, vecAvailable })` (or a sibling
    `runVecMigrationIfAvailable`) that, when `vecAvailable` is `false`, **skips the single
    `*_semantic_vec0.sql` step** (it is the only `vec0`-dependent migration) while applying all
    others; preferred for the test harness: **always load the Node `sqlite-vec` and pass
    `vecFunctional(testDb)` as `vecAvailable`** so the smoke test (not mere resolvability) gates that
    step. The Vitest harness therefore loads the Node `sqlite-vec` and computes `vecFunctional(testDb)`
    BEFORE calling the wrapped migrator; on an ABI-mismatched / extension-absent host `vecFunctional`
    is `false`, the wrapper omits the `vec0` step, and `pnpm test` stays green with FTS-only coverage.
    Do NOT leave this to the stock unconditional `migrate(...)`, which would throw on the `vec0` DDL.
    Document the wrapper next to the migrator docblock.

### Deliverables

- [ ] **Add the `sqlite-vec` dependency + the load helper + the functional smoke test.**
      `pnpm add sqlite-vec -w` (or to `@interleave/db`). Add `loadVectorExtension(sqlite,
      binaryPath?): boolean` to `@interleave/db` (`packages/db/src/vec.ts`) wrapping
      `sqliteVec.load(sqlite)` (or `sqlite.loadExtension(binaryPath)` when an explicit path is
      given), returning `true` on success / `false` (logged) on failure — **never throwing**. Add
      a companion `vecFunctional(sqlite): boolean` (the source of truth for `vecAvailable`) that
      runs the round-trip smoke test — `vec_version()` returns → `CREATE VIRTUAL TABLE _vec_smoke
      USING vec0(embedding float[384])` → INSERT one `float[384]` → KNN `MATCH … LIMIT 1` returns
      → `DROP _vec_smoke` — and returns `true` **only if every step succeeds**, `false` (logged,
      with the ABI-mismatch hint) on any throw (this catches the better-sqlite3-12-vs-SQLite-3.45
      load-succeeds-but-no-functions case the load call alone misses). Export both from the barrel;
      callers gate on `vecFunctional`, not on `loadVectorExtension` returning.
- [ ] **Add `resolveSqliteVecBinary(distDir)`** in `apps/desktop/src/main/sqlite-vec-binding.ts`
      mirroring `native-binding.ts` (the `app.asar.unpacked` preference + the `..`/`native`
      candidates). Add the platform `vec0.*` to the `electron-builder.yml` `asarUnpack` list and to
      the vendor step (`apps/desktop/scripts/vendor-sqlite-vec.mjs`, modeled on the existing
      `apps/desktop/scripts/vendor-native.mjs` — both live in `apps/desktop/scripts/`, not a
      top-level `scripts/`).
- [ ] **Load `vec0` in `db-service.open()`** ([`db-service.ts`](../../apps/desktop/src/main/db-service.ts)
      ~lines 538–547): the current order is `openDatabase(...)` (lines 539–540) → `migrateDatabase(this.handle.db, ...)`
      (line 541) → `createRepositories(...)` (line 547). **Insert the load + functional check SPECIFICALLY
      BETWEEN `openDatabase(...)` and `migrateDatabase(...)`** (not merely "before `createRepositories`" —
      that boundary is too loose and would let a builder place the load AFTER migrations and break the
      guard below). Concretely: right after `openDatabase(...)`, call `loadVectorExtension(this.handle.sqlite,
      resolveSqliteVecBinary(distDir))` inside a try/catch, then **set `this.vecAvailable =
      vecFunctional(this.handle.sqlite)`** — the **functional smoke test**, not the load call, is
      the source of truth (so a loaded-but-non-functional `vec0` from an ABI mismatch degrades to
      FTS-only instead of throwing on first query). **Only then** does `migrateDatabase(...)` run — so the
      `*_semantic_vec0.sql` migration creates `element_vectors` only when `vecAvailable` is already known
      to be `true` (and the FTS path is independent). Expose `vecAvailable` to the services that gate on it.
- [ ] **Two migrations (use the next two free `meta/_journal.json` indices at build time — do NOT
      hard-code `0021`/`0022`; T087–T095 are parallel siblings and the first-built slice consumes
      `0021`+):** the `embeddings` table (`pnpm db:generate`, commit the SQL + snapshot) and the
      hand-authored `*_semantic_vec0.sql` (the `vec0` virtual table) + its `meta/_journal.json`
      entry. **Cleanup is the explicit app-level delete (`EmbeddingRepository.delete` removes the
      `element_vectors` rowid + the bookkeeping row in one transaction) — the DEFAULT, portable
      path; do NOT make correctness depend on a `vec0` trigger.** The `DELETE` trigger on
      `embeddings` is an **optional optimization** added to the migration **only if** a smoke test
      proves the trigger-driven `vec0` DELETE actually works against the shipped `sqlite-vec`
      version (see the cleanup-path note above); otherwise omit it and rely on the explicit delete +
      the `vault_gc`-adjacent sweep. Add `EMBEDDING_DIM` + the `embeddings` row type to
      `@interleave/core`.
- [ ] **`EmbeddingRepository`** in `packages/local-db/src/embedding-repository.ts` (registered in
      `Repositories` + `createRepositories`, exported from the barrel), all main-side, **NO
      op-log** (document it, mirroring `JobsRepository`):
      - `upsert({ elementId, elementType, modelId, dim, contentHash, vector }): void` — in ONE
        transaction: INSERT the `float[]` into `element_vectors` (or reuse the existing `vec_rowid`
        on re-embed), then UPSERT the `embeddings` bookkeeping row. Idempotent by `element_id`.
        (Write the vector as the `vec0` JSON or compact-BLOB format `sqlite-vec` accepts.)
      - `needsEmbedding(elementId, contentHash, modelId): boolean` — true when no row, or the
        stored `content_hash`/`model_id` differs (the skip-if-unchanged gate).
      - `delete(elementId)` — remove the bookkeeping row **and** the matching `element_vectors`
        rowid in one transaction (do NOT rely on the trigger here — deleting the `vec0` rowid
        explicitly makes this the portable cleanup path that works even if the trigger is
        unsupported; if the trigger IS active it is a harmless no-op double-delete); idempotent.
      - `knn(queryVector, { limit, type? }): { elementId; type; distance }[]` — the `vec0`
        `WHERE embedding MATCH :q ORDER BY distance LIMIT k` join back to `embeddings` + live
        `elements` (`deleted_at IS NULL`), optionally narrowed by `element_type`. Returns `[]` when
        `!vecAvailable`.
      - `stats(): { embedded: number; total: number; modelId: string | null }` — for the status
        surface + the "N of M embedded" affordance.
- [ ] **`EmbeddingService`** in `apps/desktop/src/main/embedding-service.ts` (the `OcrService`
      twin — constructed with `{ repositories, getRunner, getSettings, getModelDir }`):
      - `buildText(element): string` — the text to embed per type (source: title + a bounded
        slice of `documents.plainText`; extract: title + body; card: prompt + answer) — main
        reads the DB and passes pure text into the payload (the worker stays DB-free). Bound the
        length (e.g. first ~512 tokens worth) so a huge source doesn't blow the model context.
      - `enqueueElement(elementId)` — compute `contentHash`; if `needsEmbedding` is false, no-op
        (return `{ skipped: true }`); else `getRunner().enqueue("embed", { elementId, modelId,
        provider, text, dim })` and return `{ jobId }`. (The provider/key/model come from settings;
        for `api` the key is read main-side and passed in the payload — it never touches the
        renderer.)
      - `reindexAll({ onlyMissing }?)` — enqueue `embed` jobs for every live source/extract/card
        that `needsEmbedding` (a small fixed batch size; the runner's concurrency caps it). This
        is the "build the index" path the `semantic.reindex` command calls.
      - `applyResult(payload, result)` — the runner's **single** `embed` apply handler calls this
        (the registry has exactly one entry per `JobType` — `job-apply-handlers.ts` delegates each to
        a service `applyResult`, so there is **no second handler** to register for the query path).
        `applyResult` **branches on `payload.persist`**: when `persist !== false` (the normal index
        path) it validates the vector length === `dim` then `repositories.embeddings.upsert(...)`
        (idempotent UPSERT by element); when `payload.persist === false` (the transient query path,
        below) it does **NOT** upsert — instead it stashes the vector in `pendingQueryVectors` (or
        drops it if the `jobId` is abandoned). Same function, one `persist` branch — do NOT register a
        second `embed` handler. Returns a small serializable summary (`{ elementId, modelId }`) for
        the persist path.
- [ ] **The `embed` worker case** in [`job-worker.ts`](../../apps/desktop/src/worker/job-worker.ts):
      add `case "embed": await runEmbed(jobId, payload); return;` to `dispatch`. `runEmbed` loads
      the model (local: `@huggingface/transformers` pipeline from `INTERLEAVE_MODEL_DIR` — the new
      fork-env var, resolved like `INTERLEAVE_ASSETS_DIR`; api: `fetch` the provider with the
      payload's key), embeds the payload `text`, posts `{ kind: "progress" }` then
      `{ kind: "result", jobId, data: { vector, modelId, dim } }`. On a missing model / a provider
      error post `{ kind: "error", jobId, code, message }`. **It imports NO `@interleave/db`/
      better-sqlite3/`sqlite-vec`** — pure model compute. Put the model-loading code in
      `apps/desktop/src/worker/embedding-model.ts` (lazy-cache the pipeline across jobs).
- [ ] **The `embed` apply handler (ONE registry entry — branches happen inside `applyResult`)** in
      [`job-apply-handlers.ts`](../../apps/desktop/src/main/job-apply-handlers.ts):
      add a single `embed: async (job, resultData) => getEmbeddingService().applyResult(job.payload, resultData)`
      to the registry; add `getEmbeddingService` to `JobApplyHandlerDeps`; wire it in
      `index.ts` `bootstrap()` (lazy accessor like `getOcrService`). **There is exactly one `embed`
      handler** — the normal-index UPSERT and the `persist:false` query-vector stash are BOTH
      `EmbeddingService.applyResult` branching on `job.payload.persist`; do NOT register a second
      handler for the query path.
- [ ] **`SemanticSearchRepository`** in `packages/local-db/src/semantic-search-repository.ts` —
      the **fusion** layer (constructed with the FTS `SearchRepository` + `EmbeddingRepository` +
      a `getQueryVector` callback, since query-embedding also runs via the runner/model — see
      below). `search(query, { limit, type?, semanticEnabled, queryVector? }): FusedHit[]`:
      - if `!semanticEnabled` or `!vecAvailable` or `queryVector == null` → return the FTS
        `SearchRepository.search(...)` hits mapped to `FusedHit` (so the surface is uniform) —
        **this is the graceful degrade**;
      - else run `embeddings.knn(queryVector, { limit, type })` AND `searchRepo.search(query,
        {...})`, and **fuse** with **reciprocal-rank fusion** (RRF: `score = Σ 1/(k + rank)` across
        the two lists, k≈60), dedupe per element, sort, cap. Each `FusedHit = { id, type, title,
        snippet, ftsScore?, vecDistance?, source: "fts"|"semantic"|"both" }` so the UI can label
        purely-semantic hits ("related").
      - **Query embedding (specify the concrete return channel — `waitForTerminal` does NOT carry
        the vector).** The query text must also be embedded, and because the model lives in the
        worker the query path enqueues a tiny transient `embed` job for the query string (caching
        the model in main is forbidden — main is DB+UI, not the model host). **Decision:** add an
        `embedQuery(text): Promise<number[] | null>` to `EmbeddingService` that enqueues a transient
        `embed` job with a `persist: false` flag (so the **same** `EmbeddingService.applyResult` —
        the ONE `embed` handler, branching on `payload.persist === false` — returns the vector
        **without UPSERTing** an `embeddings` row). **The vector reaches `embedQuery` via a main-side
        in-memory map, NOT via the `Job` row:** `applyResult`, on its `persist:false` branch,
        stashes the returned vector in `EmbeddingService`'s `pendingQueryVectors: Map<jobId,
        number[]>` (and resolves any waiter), because `JobRunner.waitForTerminal(jobId)`
        (`job-runner.ts:236`) resolves with the **persisted `Job` snapshot** — it does **not**
        surface the apply handler's return value. `embedQuery` therefore: enqueues → races
        `waitForTerminal(jobId)` against an explicit **short timeout** (`Promise.race`, e.g. 800 ms —
        `waitForTerminal` has no built-in timeout, so the caller MUST add it) → on terminal-success
        reads the vector out of the `pendingQueryVectors` map (deleting it) → returns it; a
        timeout / non-success / disabled / `!vecAvailable` result returns `null` so the caller falls
        back to FTS-only and `/search` never hangs. Document this query path explicitly (it is the
        one place a "read" rides the job runner — justified because the model only exists in the
        worker), including the explicit timeout and the map-based return channel.
      - **Leak/cleanup on the abandoned-job case (REQUIRED).** When the timeout fires *before* the
        `persist:false` branch of `applyResult` runs, the job later succeeds and that branch would
        stash a vector **no waiter ever reads** — an unbounded `pendingQueryVectors` leak over a long
        `/search` session. So on timeout, `embedQuery` records the `jobId` in an `abandonedQueries:
        Set<jobId>` and the `persist:false` branch **drops (does NOT stash)** any result
        whose `jobId` is abandoned (clearing it from the set). As defense-in-depth, also bound the
        map: a small TTL/size cap that evicts the oldest entries, so a pathological run can never
        grow it without bound. Cover both in a test (a timed-out query's late result is not retained;
        the map does not grow across many queries).
- [ ] **The `semantic.*` IPC surface** (channels + contract + preload + ipc + db-service + appApi),
      Zod-validated, following the `search.*` pattern:
      - `semantic.search({ q, type?, limit? }) → { results: FusedSearchResult[]; mode:
        "semantic"|"fts"|"disabled" }` — `mode` tells the UI whether semantics actually ran (so it
        can show "keyword only" when the model is off/absent). Reuses the `SearchResult` shape +
        adds `vecDistance?`/`semantic: boolean`.
      - `semantic.status() → { enabled, vecAvailable, modelDownloaded, embedded, total, modelId }`
        — drives the Settings toggle + the library "N of M embedded / Build index" affordance.
      - `semantic.reindex({ onlyMissing? }) → { enqueued: number }` — enqueues the `embed` jobs;
        the renderer observes progress via the existing `jobs.subscribe`.
      - **No raw vectors cross IPC** to the renderer; it sees only ids/titles/snippets/distances.
- [ ] **Auto-embed on mutation (keep the index fresh — pin the EXACT post-commit seams).** When a
      source/extract/card is created/edited, **enqueue an `embed` job after the transaction commits**
      (fire-and-forget, gated on `semanticSearchEnabled`). The concrete insertion points are the
      **`DbService` main-side methods** that own these mutations (the IPC-contract names
      `extractions.create`/`cards.create`/`documents.save` map to these methods — confirm each
      against the file before wiring; do NOT assume the contract name === the method name):
      - **`DbService.createExtraction`** (`db-service.ts:2057`) — after
        `this.extractionService.createExtraction({...})` returns, enqueue an `embed` for the new
        extract element.
      - **`DbService.createCard`** (`db-service.ts:2133`) — after `this.cardService.createFromExtract`
        completes, enqueue an `embed` for the new card element.
      - **`DbService.saveDocument`** (`db-service.ts:1968`) — after `this.repos.documents.upsert({...})`
        returns, enqueue an `embed` for the owning source element (the edited document body is the
        source's embed text). Note this path commits inside `DocumentRepository.upsert` (a repository
        transaction), so the enqueue goes **after `saveDocument` returns in the service method, NOT
        inside the repo transaction** — embedding is async + off-main and must never ride the write tx.
      For any path whose commit lives inside a repository transaction rather than the service method,
      place the enqueue in the service method **after** the repo call returns (post-commit), never
      inside the repo. Re-embed is idempotent (the content hash skips unchanged text). Document that a
      freshly enabled feature back-fills via `reindex({ onlyMissing: true })`.
- [ ] **Embedding-model download (pin the concrete mechanism — reuse T093's `downloadModel`
      discipline; NOT a new job type).** On first enable of the local provider,
      `EmbeddingService.downloadModel()` (main) streams the MiniLM ONNX files to
      `INTERLEAVE_MODEL_DIR/<modelId>/` with a **content-length / checksum** check, writing to a
      `*.partial` temp path and **atomically renaming** on completion (a half-download never reads
      as present), emits progress over a dedicated **`semantic:modelDownload`** named event, is
      **cancellable** (`AbortController`), and on success flips `embeddingModelDownloaded = true` in
      `settings` **in one transaction** (idempotent — re-running with verified files present just
      re-flips the flag). It is **a guarded main-side fetch, not a worker job and not a new
      `JOB_TYPES` member** — identical mechanism to T093's `AiService.downloadModel`
      (`docs/tasks/M18-ai.md`); reuse that discipline rather than re-inventing "job vs fetch". Until
      it completes, `semantic.status().modelDownloaded` is `false` and search stays FTS-only with a
      "Downloading model…" affordance — never a crash or a silent no-op.
- [ ] **The M18 settings** in [`settings.ts`](../../packages/core/src/settings.ts): add
      `semanticSearchEnabled: boolean` (default `false`), `embeddingProvider: "local"|"api"`
      (default `"local"`), `embeddingApiKey: string` (default `""`, **the user's own key**),
      `embeddingModelId: string` (default `"local:all-MiniLM-L6-v2"`),
      `embeddingModelDownloaded: boolean` (default `false`) — with `SETTINGS_KEYS` strings
      (`semantic.enabled`, `semantic.provider`, `semantic.apiKey`, `semantic.modelId`,
      `semantic.modelDownloaded`), `DEFAULT_APP_SETTINGS` entries, and coercion (mirror the
      `fsrsParamsGlobal` precedent). The Settings screen gets a "Semantic search" section: the
      on/off switch (with a one-time "this downloads a ~23 MB model, then runs fully offline"
      disclosure), the provider choice, and the API-key field (masked) — all calling
      `settings.updateMany`. **The API key is stored in SQLite settings only; it is never sent to
      our server.**
- [ ] **Library wiring** (`apps/web/src/library/LibraryScreen.tsx`): when
      `semantic.status().enabled`, call `semantic.search` (fused) and label purely-semantic rows
      ("related" / a subtle vec icon); when disabled/not-downloaded, keep the existing FTS
      `search.query` path and show a calm "Semantic search off — enable in Settings" hint + (if
      enabled-but-empty) a "Build index (N of M embedded)" button that calls `semantic.reindex` and
      watches `jobs.subscribe`. **Pure UI** — one command + one subscription; no model/SQL in React.
- [ ] **Tests (unit, `packages/db`):** `loadVectorExtension` loads `vec0` in a Node better-sqlite3
      handle; a `vec0` table accepts a `float[384]` insert and a KNN MATCH returns nearest by
      distance. Guard the whole suite behind the **`vecFunctional` smoke test** (NOT mere
      resolvability) — `it.skipIf(!vecFunctional(testDb))` with a clear message — so on an
      ABI-mismatched host where the binary resolves and loads but registers no `vec0` functions the
      suite **skips cleanly** instead of failing inside a `vec0` query it assumed worked. The CI/dev
      environment passes the smoke test, so the path runs there.
- [ ] **Tests (unit, `packages/local-db`):** with a **deterministic fake embedder** (a pure
      function mapping known seeded text → a fixed vector, so KNN is asserted exactly),
      `EmbeddingRepository.upsert` writes `element_vectors` + the `embeddings` row in one
      transaction and is idempotent (re-upsert reuses `vec_rowid`); `needsEmbedding` skips an
      unchanged element and re-embeds a changed one; `knn` returns the seeded near-neighbors in
      distance order, excludes soft-deleted, narrows by type; `delete(elementId)` prunes both the
      `embeddings` row and the `element_vectors` rowid in one transaction (the explicit app-level
      delete — the portable default; if the optional trigger is present it's a harmless no-op
      double-delete); embeddings append **NO `operation_log`** (assert the op-log count is
      unchanged across an embed lifecycle). `SemanticSearchRepository.search` **fuses** FTS + KNN
      (a purely-semantic neighbor with no keyword overlap still appears; `mode` is `"fts"` when
      `semanticEnabled=false`).
- [ ] **Tests (integration, `apps/desktop` main, real temp-file DB + real `vec0` under Vitest,
      fake worker):** `new DbService()` + `open(...)` loads `vec0`; enqueue an `embed` job whose
      **fake worker** returns a known vector (the `fork`-factory fake, same seam as
      `job-runner.test.ts`) → the apply handler UPSERTs it → `semantic.search` returns the seeded
      element for a semantically-near (keyword-disjoint) query → **re-open the DB** (restart
      simulation) → the vector + the search result **survive**. `utilityProcess` is NOT available
      in Vitest (so no real worker), but `sqlite-vec` IS available in Node **when the `vecFunctional`
      smoke test passes** — gate this suite on it (`describe.skipIf(!vecFunctional)`) so an
      ABI-mismatched host (binary resolves + loads but registers no `vec0` functions) skips with a
      clear message rather than failing inside a `vec0` query; on a healthy host the vec store +
      apply + restart is fully covered here, and the **real model + real worker** runs in E2E.
- [ ] **Tests (contract):** the `Semantic*` Zod schemas round-trip valid `semantic.search`/
      `status`/`reindex` payloads and reject malformed ones; the `embed` worker message
      (`result.data = { vector, modelId, dim }`) round-trips through the existing
      `WorkerMessageSchema`.
- [ ] **Tests (E2E, Electron — the real model + real `utilityProcess`):**
      `tests/electron/semantic-search.spec.ts`: with the feature enabled + the model present
      (gate the spec on the model being available in CI — bundle a tiny test model or skip-with-
      reason if the download is unavailable in CI; document the gate), open `/search`, run a query
      that has **no keyword match** but a clear semantic match against a seeded element → the
      semantic result appears (labeled "related") → toggle the feature OFF in Settings → the same
      query returns FTS-only and the app does not error → **restart the app** → with the feature on
      again the embeddings are still present (no re-index needed) and the semantic result returns.
      Assert the UI never freezes during indexing (the embed jobs run off-main).
- [ ] **Fixtures/seed:** no schema-time seed change required (the index builds from existing
      elements). Optionally add a dev affordance to trigger `reindex`. The unit/integration tests
      supply the **fake embedder**; do not seed real vectors.
- [ ] **Docs:** check the T087 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line: `sqlite-vec` local store, the `embed` job + apply, the bundled/downloaded
      local MiniLM (off by default), the FTS+vec fusion, and the graceful FTS-only degrade.

### Done when

- Embeddings for live sources/extracts/cards are generated **on-device** — by default a **local
  ONNX MiniLM** in the **T058 `utilityProcess` worker**, or (opt-in) an **embedding API with the
  user's OWN key** — and stored in a **`sqlite-vec` `vec0`** table on the same better-sqlite3 DB;
  the **worker never opens the DB or loads vec**, **main** writes the vector (single-writer), and
  embeddings append **NO `operation_log`**.
- `/search` finds **conceptually related material without a keyword match** (the FTS+vec fusion),
  and the whole feature is **OFF BY DEFAULT**: disabled / model-absent / vec-load-failed all
  **degrade cleanly to FTS-only** and never throw; `semantic.status().mode` tells the UI which ran.
- Re-embedding is **idempotent** (content-hash skip) and **at-least-once safe** (a crash-resume
  re-run UPSERTs the same vector); the index **survives app restart** (it persists in the SQLite
  file; the `vec0` migration applies on both the dev and Electron-startup migrators).
- The renderer reaches everything only through the typed `semantic.*` `window.appApi`
  (search/status/reindex) + the existing `jobs.subscribe`; **no raw vectors, model, SQL, or fs
  cross to React**; the user's API key lives only in SQLite settings, never our server.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the semantic-search Playwright spec pass; the
  two new migrations (the `embeddings` table + the `vec0` table, at whatever indices were free at
  build time) apply cleanly on an existing dev DB.

### Notes / risks

- **`sqlite-vec` Electron load is the central infra risk.** It is a loadable extension that
  cannot be `dlopen`ed from inside `app.asar` — `asarUnpack` it and resolve the unpacked path
  exactly like `better_sqlite3.node` (the precedent in `native-binding.ts`). Ship the correct
  per-platform `vec0.*`. Verify in the packaged app that the extension loads (`vec_version()`
  returns) and that load failure degrades to FTS-only rather than crashing.
- **ABI mismatch is the SPECIFIC reason a successful load is not enough.** better-sqlite3 `^12.x`
  (this repo's pin, `packages/db/package.json:26` / `apps/desktop/package.json:22`) bundles a
  newer SQLite (~3.50/3.51.x) than the prebuilt `sqlite-vec` v0.1.9 binaries (~3.45.x); the known
  failure is that `loadExtension` succeeds but `vec0` registers no functions, so `CREATE VIRTUAL
  TABLE … USING vec0` / KNN throw on first use. **`vecAvailable` is therefore set from a FUNCTIONAL
  round-trip smoke test (`vec_version()` + create-vec0 + insert + KNN + drop), not from
  `loadExtension` returning** — see the load-helper deliverable (`vecFunctional`). Add a build-time
  check that the shipped binary's SQLite ABI matches the better-sqlite3 build (run the smoke test
  at package time and fail the build on no `vec0` functions), or pin better-sqlite3 to a
  sqlite-vec-compatible SQLite; document the choice next to the load helper.
- **Model first-run UX — be honest.** The default local model is a one-time **download on first
  enable** (~23 MB) cached under the app data dir; until it completes, search is FTS-only with a
  "Downloading model…" state. The download mechanism is **pinned, not left open** — a guarded
  main-side fetch with a `*.partial` temp + content-length/checksum + atomic rename + a dedicated
  `semantic:modelDownload` named event + an `AbortController` cancel + a one-transaction flag flip,
  **the same discipline T093's `AiService.downloadModel` uses** (reuse it, do not re-invent
  "job vs fetch"). Bundling it in `resources/` (no download, bigger installer) is an acceptable
  alternative — pick one and document the tradeoff. **No content is uploaded** — the download is
  model weights from a public host the first time only; embeddings are computed locally forever
  after.
- **Dimension/model coupling.** The `vec0` column dim is fixed at migration time (384 for MiniLM).
  Switching to a different-dim model is a re-index + a column change — out of T087 scope: support
  **one active model**; storing `model_id`/`dim` per row lets `knn` refuse to mix mismatched
  vectors and lets a future model-switch re-embed. Note this clearly.
- **Query embedding rides the job runner** (the one "read" that uses a job) because the model only
  lives in the worker — a transient `embed` with `persist: false`. Because `JobRunner.waitForTerminal`
  resolves with the persisted `Job` snapshot (not the apply handler's return value) and has **no
  built-in timeout**, `embedQuery` must (a) recover the vector from a main-side
  `pendingQueryVectors: Map<jobId, number[]>` the `persist:false` apply handler fills, and (b) wrap
  the await in an explicit `Promise.race` short timeout, falling back to FTS-only on timeout/disable
  so a slow model never hangs `/search`. **(c) On timeout, the `jobId` goes into an
  `abandonedQueries` set so the late-arriving `persist:false` apply result is DROPPED (not stashed)
  — otherwise the map leaks a stale query vector per timed-out search over a long session; a small
  TTL/size cap on the map is the belt-and-braces backstop.** (See the `SemanticSearchRepository`
  query-embedding deliverable for the concrete channel.)
- **No op-log, derived index.** Embeddings are rebuildable from the base tables (like FTS5) — never
  a domain mutation. `reindex` re-derives them; a corrupt/missing `vec0` is recoverable by re-index,
  not data loss. The closed `OPERATION_TYPES` does not grow.
- **`ai` is NOT this task.** T087 is embeddings + vector search only. AI-assisted distillation
  (the `ai` JobType, the managed-proxy disclosure, drafts-only) is **T093/T094** — keep the
  `embed` path free of any generation/LLM call.

---

## T088 — Related-item suggestions

- **Status:** `[ ]` not started  · **Depends on:** T087
- **Roadmap line:** Done when each element shows similar extracts, possible duplicates,
  prerequisite concepts, and sibling sources.

### Goal

Every selected element's **inspector** gains a **"Related" section** that surfaces, from the
T087 vector store + the existing lineage graph: **similar extracts** (vector nearest-neighbors of
the same/compatible type), **possible duplicates** (very-near neighbors above a similarity
threshold, flagged distinctly so the user can merge/dismiss), **prerequisite concepts** (the
element's member concepts and their parent chain in `concepts.parentConceptId`, ranked by vector
relevance), and **sibling sources** (sources sharing a `concept_membership` with the element,
ordered by vector similarity). All of it is a **derived read** over `vec0` + `element_relations` +
`concepts` — **no new relation types, no op-log writes** — reached through a single typed
`semantic.related` command. When semantic search is off / the element isn't embedded, the panel
degrades to the **lineage-only** relations (concepts + siblings by `concept_membership`) and hides
the vector-derived "similar/duplicate" rows with a calm "enable semantic search for suggestions"
hint.

### Context to load first

- Reference: the roadmap T088 line; [`../domain-model.md`](../domain-model.md) "Relationships &
  lineage" (concepts hierarchical; the closed `RELATION_TYPES`); [`./M8-organize.md`](./M8-organize.md)
  (concepts + `concept_membership` reads — `ConceptRepository.conceptsForElement`/
  `elementsForConcept`).
- Existing code to inspect: `EmbeddingRepository.knn` (T087 — the neighbor source);
  `SemanticSearchRepository` (reuse the KNN + the `vecAvailable`/`enabled` gating); the
  `ConceptRepository` (T041 — `conceptsForElement`, `listConcepts` for the parent chain) +
  `concepts.parentConceptId` ([`organize.ts`](../../packages/db/src/schema/organize.ts)); the
  `concept_membership` edge reads on `ElementRepository` (`listRelationsFrom`); `InspectorGetResult`
  + `Inspector.tsx` (the `insp-sec`/`MetaRow` structure + `ConceptTag`/`Tag`/`RefBlock`
  primitives); `SourceRef`/`formatSourceRef` (render the related item's origin).
- Invariants in play: **derived, not persisted** — related/duplicate/prereq/sibling are computed
  on read, never written as `element_relations` (the set is closed) and never op-logged; the
  panel **never mutates lineage**; it degrades gracefully when semantics are off; it excludes
  soft-deleted elements and the element itself.

### The four buckets (specify how each is computed)

1. **Similar extracts** — `EmbeddingRepository.knn(vectorOf(element), { type: "extract",
   limit })`, excluding the element itself + soft-deleted, mapped distance → a 0–1 similarity.
   (If the selected element has no stored vector — not embedded yet — return `[]` for this bucket
   and surface "not indexed".)
2. **Possible duplicates** — the **nearest neighbors of the SAME type** whose distance is **below
   a duplicate threshold** (a tuned cosine-distance cutoff, e.g. `distance < DUP_THRESHOLD`),
   flagged `kind: "duplicate"` so the UI styles them distinctly ("possible duplicate — review").
   The threshold is a documented constant; **it is suggestive** (a near-identical re-import or a
   re-worded extract), never an automatic merge.
3. **Prerequisite concepts** — the element's member concepts (`conceptsForElement`) plus each
   member concept's **parent chain** (`concepts.parentConceptId`, walked up via `listConcepts`),
   ranked by vector similarity of the concept's representative text to the element (a concept's
   text = its name; if concepts have no vector, fall back to the lineage order). "Prerequisite" =
   the parent/ancestor concepts (more general → learn first), surfaced as `ConceptTag`s with a
   "prereq" affordance. This bucket works **even with semantics off** (pure concept hierarchy).
4. **Sibling sources** — sources that share at least one `concept_membership` concept with the
   element (`elementsForConcept` ∩ `type = source`), ordered by vector similarity when available
   else by shared-concept count. Rendered with their `RefBlock`/title. Also works **with semantics
   off** (pure membership).

### Deliverables

- [ ] **`RelatedService`** (or methods on `SemanticSearchRepository` + `ConceptRepository`,
      composed in `db-service.ts`) producing `RelatedResult = { similar: RelatedItem[];
      duplicates: RelatedItem[]; prerequisiteConcepts: RelatedConcept[]; siblingSources:
      RelatedItem[]; semanticAvailable: boolean }` where `RelatedItem = { id, type, title,
      similarity?, kind: "similar"|"duplicate", ref?: SourceRef }` and `RelatedConcept = { id,
      name, level }`. Each bucket computed as above; all exclude the element + soft-deleted; the
      vector buckets return `[]` (with `semanticAvailable: false`) when semantics are off/the
      element isn't embedded, while the concept/sibling buckets still resolve from lineage.
- [ ] **`semantic.related` IPC surface** (channels + contract + preload + ipc + db-service +
      appApi), Zod-validated: `semantic.related({ elementId, limit? }) → RelatedResult`. Reuse
      `SourceRef` from the contract. No vectors cross IPC (only ids/titles/similarities).
- [ ] **Inspector "Related" panel** (`apps/web/src/components/inspector/Inspector.tsx` +
      `primitives.tsx`): a new `insp-sec` titled "Related" that calls `semantic.related` for the
      selected element and renders the four buckets — similar extracts (clickable rows that select
      the element), possible duplicates (distinct styling + a "review"/"dismiss" affordance — the
      dismiss is local UI state for now; a persisted "not a duplicate" mark is **deferred**, note
      it), prerequisite concepts (`ConceptTag`s), sibling sources (title + `RefBlock`). Each row is
      keyboard-navigable and selects-on-click (reuse the existing inspector selection plumbing).
      When `!semanticAvailable`, show the concept/sibling buckets + a calm "Enable semantic search
      in Settings for similarity suggestions" line — never an error or an empty crash.
- [ ] **Tests (unit, `packages/local-db`):** with the **fake embedder** + the seeded fixtures,
      `related` returns the seeded near-extract as `similar`; a deliberately near-duplicate (a
      second extract with near-identical text → near-zero distance) appears under `duplicates`;
      `prerequisiteConcepts` returns the element's member concept's PARENT (the seeded
      "Cognition" → "Intelligence" hierarchy) with the right `level`; `siblingSources` returns a
      source sharing the element's concept and excludes one that doesn't; the element itself + a
      soft-deleted neighbor are excluded; with semantics off, the vector buckets are empty and the
      concept/sibling buckets still resolve.
- [ ] **Tests (contract):** `semantic.related` validates `{ elementId, limit? }` and returns the
      typed `RelatedResult`.
- [ ] **Tests (renderer):** the Inspector "Related" panel renders the four buckets from a mocked
      `semantic.related`, styles duplicates distinctly, navigates on row click, and shows the
      degrade hint when `semanticAvailable: false` (mock `window.appApi.semantic`).
- [ ] **Playwright E2E** (`tests/electron/related-items.spec.ts`): with semantics enabled +
      indexed, select the seeded extract → the inspector "Related" section shows a similar extract
      + the prerequisite concept + a sibling source → click a related row → it selects that
      element → **restart the app** → the related suggestions still resolve (derived from the
      persisted vectors + lineage).
- [ ] **Docs:** check the T088 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line (the derived related panel; no new relation types; graceful degrade).

### Done when

- Each element's inspector shows **similar extracts, possible duplicates, prerequisite concepts,
  and sibling sources**, computed from the T087 `vec0` neighbors + the existing
  `concept_membership`/`concepts.parentConceptId` lineage — **all derived reads**: no new
  `RELATION_TYPES` member, no `element_relations` writes, no `operation_log` entries.
- The panel **degrades gracefully** when semantics are off / the element isn't embedded (the
  lineage buckets still resolve; the vector buckets hide with a calm hint), never throwing.
- Everything reaches the renderer only through the typed `semantic.related` `window.appApi`; no
  vectors/SQL in React; the suggestions **survive app restart** (derived from persisted data).
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the related-items Playwright spec pass.

### Notes / risks

- **Derived, not persisted.** Duplicates/prereqs/siblings are suggestions over the graph, not new
  edges. Do NOT add a `duplicate`/`prerequisite` `RELATION_TYPES` member or write
  `element_relations` — the set is closed ("a rename is a migration"). A future "merge duplicates"
  or "mark not-a-duplicate" action that DOES persist is a **separate, later** task (note the
  deferral); T088 surfaces, it doesn't mutate.
- **Duplicate threshold is heuristic.** The cutoff is a tuned constant surfaced as a suggestion,
  not a verdict. Err toward fewer false "duplicate" flags (a high-confidence cutoff); the
  `similar` bucket carries the rest.
- **Performance.** `related` runs a few small KNN queries per inspector open — cheap (the corpus
  is one person's library). If it ever lags, debounce on selection + cap `limit`; do NOT precompute
  a full similarity matrix (overkill for the scale).
- **Concept vectors are optional.** If concepts aren't embedded, rank prereqs by hierarchy depth
  (parents first) rather than vector similarity — the bucket must work with semantics off.

---

## T089 — Contradiction detection

- **Status:** `[ ]` not started  · **Depends on:** T087
- **Roadmap line:** Done when semantic similarity + claim metadata flag possibly conflicting
  cards/extracts ("newer source conflicts with older card").

### Goal

The app gains a **heuristic, suggestive** contradiction detector: it flags pairs of
**highly-similar** cards/extracts (T087 vector neighbors) that also carry **opposing or
superseding signals** — a negation/antonym divergence, a numeric/quantity mismatch, or one being
backed by a **newer source** than the other (a newer `publishedAt`/`accessedAt`) — and surfaces a
calm **"possible conflict"** flag on the affected card/extract ("a newer source may conflict with
this older card"). The detection is a **pure `packages/core` heuristic** combining the vector
similarity (passed in) with claim-metadata signals; it is **explicitly NOT authoritative** — it
never edits, suspends, or reschedules anything automatically. The user sees a flag they can open
(to compare the two and decide) or dismiss. When semantics are off, contradiction detection is
unavailable (the panel hides), since the high-similarity gate needs the vector store.

### Context to load first

- Reference: the roadmap T089 line + the M18 header (heuristic, suggestive, drafts/flags only);
  [`../domain-model.md`](../domain-model.md) (sources + `publishedAt`/`accessedAt`; the lineage
  chain that ties a card/extract to its source); the downstream T090 (staleness fields:
  `valid_from`/`valid_until`/`fact_stability`) + T091 (source reliability) are **later** — T089
  uses only what exists today (the `sources` provenance dates + the card/extract text + the
  vectors), and is written so T090/T091 can ENRICH its signals later (note the seam).
- Existing code to inspect: `EmbeddingRepository.knn` (the high-similarity candidate source);
  `sources` schema (`publishedAt`/`accessedAt` — the recency signal) + the
  `card → extract → source` lineage (`source_locations.sourceElementId`, the source-resolution
  `db-service.ts` already does for the refblock, T043); `SourceRef`/`formatSourceRef`
  (the `yearOf` helper at `source-ref.ts:79` is the recency *pattern* — but it is **private/
  non-exported**, so T089 either exports it for reuse or derives the year inline in the pure
  heuristic); `cards` schema (prompt/answer text); the card review + extract views (where the
  flag renders).
- Invariants in play: **heuristic + suggestive**, never authoritative — no auto-edit/suspend/
  reschedule; **no op-log writes, no persisted "conflict" relation** (derived, like T088); needs
  semantics on (high-similarity gate); excludes soft-deleted; lineage untouched.

### The heuristic (specify concretely — pure `packages/core`)

`detectContradictions(candidatePairs): ContradictionFlag[]` in
`packages/core/src/contradiction.ts` (pure, unit-tested, no React/Drizzle). Each input pair is
`{ a, b }` where each side carries `{ id, type, text, similarity, sourcePublishedAt,
sourceAccessedAt }` (main resolves these via lineage + KNN; the heuristic is data-only). A pair is
flagged when **ALL** of:
1. **High semantic similarity** — `similarity >= CONTRADICTION_SIMILARITY_MIN` (a tuned constant;
   the pair is about the same thing). This is the gate — without the vector store there are no
   candidate pairs.
2. **At least one opposing/superseding signal**, any of:
   - **Negation/polarity divergence** — one text contains a negation/antonym the other lacks
     around the shared key terms (a small, documented negation-cue + antonym check; deliberately
     simple — it is suggestive, accepts false positives/negatives);
   - **Numeric divergence** — both texts state a number/quantity for the same unit and they differ
     beyond a tolerance (e.g. "7 days" vs "14 days");
   - **Recency supersession** — one side's source is **meaningfully newer** than the other's
     (the extracted year of `publishedAt`, or `accessedAt`, differs by ≥ a documented gap), so a
     newer source may supersede an older card/extract — this is the roadmap's literal "newer source
     conflicts with older card". (For the year extraction either **export `yearOf` from
     `source-ref.ts`** and reuse it, or inline an equivalent 4-digit-year parse in
     `contradiction.ts` — the heuristic takes the dates as plain strings, so it stays pure.)
Each flag = `{ aId, bId, reasons: ("negation"|"numeric"|"recency")[], severity: "low"|"medium",
newerSide: "a"|"b"|null }`. **No flag is high-severity** — the whole thing is suggestive.

### Deliverables

- [ ] **`detectContradictions` in `packages/core`** (`packages/core/src/contradiction.ts` +
      `contradiction.test.ts`): the pure heuristic above, with the `CONTRADICTION_SIMILARITY_MIN`,
      numeric-tolerance, and recency-gap constants documented + exported. Negation/antonym uses a
      small built-in cue list (extensible; note it's intentionally minimal). **No I/O, no React, no
      DB** — data in, flags out — so it's trivially testable and reusable.
- [ ] **`ContradictionService`** (main-side, in `db-service.ts` or
      `apps/desktop/src/main/contradiction-service.ts`): `findForElement(elementId) →
      ContradictionFlag[]` — resolve the element's vector, run `knn` for same/compatible-type
      high-similarity neighbors (gated on `vecAvailable` + `semanticSearchEnabled`), resolve each
      side's source dates via lineage (the T043 source-resolution path), build the
      `detectContradictions` input, and return the flags (each enriched with the neighbor's title +
      `SourceRef` for display). Returns `[]` when semantics are off (the surface hides). Idempotent
      read; no writes.
- [ ] **`semantic.contradictions` IPC surface** (channels + contract + preload + ipc + db-service +
      appApi), Zod-validated: `semantic.contradictions({ elementId }) → { flags:
      ContradictionFlagView[] }` where `ContradictionFlagView` carries the other element's
      `id/type/title/ref` + `reasons`/`severity`/`newerSide` (enough for the calm conflict card).
      No vectors cross IPC.
- [ ] **A calm "possible conflict" surface** on the card review + extract view (and the inspector):
      when `flags.length > 0`, render an unobtrusive "Possible conflict" chip/row (NOT a blocking
      modal, NOT during the answer-hidden review face — surface it post-reveal or in the inspector
      so it can't leak the answer) that, on click, opens a small **compare** view showing both
      items + their sources + the reasons ("newer source (2026) may supersede this card's source
      (2019)"), with **open-both / dismiss** actions. **Dismiss is local UI state** for now (a
      persisted "not a conflict" acknowledgement is **deferred** to a later task — note it); the
      flag never auto-changes the card. Reuse `RefBlock`/`formatSourceRef` for both sides.
- [ ] **Tests (unit, `packages/core`):** `detectContradictions` flags a high-similarity pair with a
      negation divergence; flags a numeric divergence ("7 days" vs "14 days") past tolerance; flags
      a recency supersession (a 2026 source vs a 2019 source on near-identical claims) with
      `newerSide` set; does NOT flag a high-similarity pair that AGREES (same polarity, same
      numbers, same-era sources); does NOT flag a low-similarity pair regardless of metadata;
      handles missing dates/numbers cleanly (no throw, just fewer signals).
- [ ] **Tests (unit, `apps/desktop`/`packages/local-db`):** `ContradictionService.findForElement`
      (with the fake embedder + seeded near-duplicate-but-opposing fixtures) returns a flag with the
      neighbor's title + ref + reasons; returns `[]` when `semanticSearchEnabled=false`; resolves
      the source dates from lineage correctly; excludes soft-deleted neighbors.
- [ ] **Tests (contract):** `semantic.contradictions` validates `{ elementId }` and returns the
      typed `flags`.
- [ ] **Tests (renderer):** the conflict surface renders from a mocked `semantic.contradictions`
      (chip → compare view → dismiss hides it), is **absent during the hidden-answer review face**
      and present post-reveal/in the inspector, and shows nothing when `flags` is empty.
- [ ] **Playwright E2E** (`tests/electron/contradiction.spec.ts`): seed two near-identical
      cards/extracts whose sources differ in recency (or polarity) → with semantics enabled +
      indexed, open the newer/older one → a "Possible conflict" flag shows → open the compare view →
      both sources + the reason render → dismiss → it hides → **restart the app** → the flag
      re-derives (it's computed from persisted vectors + lineage, so it returns after restart;
      dismiss being local UI state, it re-appears — document this expected behavior).
- [ ] **Docs:** check the T089 box in [`../roadmap.md`](../roadmap.md) with the commit ref + a
      Progress-log line (the heuristic, suggestive contradiction flag; pure-core heuristic; no
      auto-edit; the T090/T091 enrichment seam).

### Done when

- Highly-similar cards/extracts that also carry an **opposing/superseding signal** (negation,
  numeric divergence, or a **newer source** than the other) are flagged with a calm "possible
  conflict" surface that the user opens (to compare) or dismisses — **heuristic and suggestive,
  never authoritative**: nothing is auto-edited, suspended, or rescheduled, and the flag never
  leaks an answer during the hidden-answer review face.
- The heuristic lives in **pure `packages/core`** (`detectContradictions`, unit-tested);
  detection is a **derived read** over the T087 vectors + the `sources` provenance dates via
  lineage — **no op-log writes, no persisted "conflict" relation**; it requires semantics on and
  hides cleanly when off.
- Everything reaches the renderer only through the typed `semantic.contradictions`
  `window.appApi`; no vectors/SQL in React; the flags **re-derive after app restart**.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the contradiction Playwright spec pass.

### Notes / risks

- **Honest framing — this is a heuristic, not a fact-checker.** It will miss real conflicts and
  flag non-conflicts. The UI copy must say "possible conflict — review", never "conflict". It is a
  prompt to the user's judgment, not an automatic correction. This is the load-bearing constraint
  of the task.
- **No auto-action, ever.** A flag never edits/suspends/reschedules/merges — those are explicit
  user actions (and persisting a resolution is a later task). High-priority fragile memory is
  protected (CLAUDE.md): a heuristic must never silently disturb scheduling.
- **The answer-leak guard.** In review the flag must NOT appear on the hidden-answer face (it could
  hint the answer) — surface it post-reveal or in the inspector, mirroring the T043 refblock
  reveal-gate discipline.
- **Built for T090/T091 enrichment.** Today the recency signal is the `sources` `publishedAt`/
  `accessedAt`. T090 adds `valid_from`/`valid_until`/`fact_stability` and T091 adds reliability
  (primary/secondary, confidence) — `detectContradictions` takes its signals as data, so those
  tasks ENRICH the input (a stronger "superseded" signal, a reliability-weighted severity) without
  changing the core shape. Keep the input struct extensible (extra optional fields), note the seam.
- **Dismiss is local for now.** A persisted "acknowledged / not a conflict" mark (so a dismissed
  flag stays dismissed across restarts) needs a new persisted shape — **deferred**; document that a
  dismissed flag re-derives after restart in the MVP.

---

## Exit criteria for M18 (T087–T089)

- All of T087–T089 are `[x]` in [`../roadmap.md`](../roadmap.md).
- **Semantic search (T087):** on-device embeddings (local ONNX MiniLM by default, or the user's
  own embedding API key opt-in) computed on the **T058 `utilityProcess` runner** (`embed` job +
  apply handler), stored in a **`sqlite-vec` `vec0`** table on the same better-sqlite3 DB
  (`asarUnpack`ed extension, loaded in main, single-writer); `/search` finds conceptually related
  material via an **FTS+vec fusion**; the feature is **OFF BY DEFAULT** and **degrades to FTS-only**
  (disabled / model-absent / vec-load-failed) without throwing; embeddings append **NO
  `operation_log`** and **survive app restart**.
- **Related items (T088):** every element's inspector shows similar extracts / possible duplicates
  / prerequisite concepts / sibling sources — **derived reads** over the vectors + the closed
  lineage graph (no new `RELATION_TYPES`, no op-log), degrading to lineage-only when semantics are
  off.
- **Contradiction detection (T089):** a **pure-core heuristic** flags highly-similar cards/extracts
  with an opposing/superseding signal (negation, numeric divergence, newer source) as a calm,
  **suggestive** "possible conflict" — never authoritative, never auto-editing, never leaking an
  answer in review; built so T090/T091 enrich its signals.
- All new capabilities reach the renderer **only** through new typed `window.appApi` commands
  (`semantic.search`/`status`/`reindex`/`related`/`contradictions`) with Zod-validated IPC; **no
  raw DB/filesystem/model/vector access is exposed to the renderer**, no generic `db.query`, and
  the user's embedding API key lives only in SQLite settings (never our server).
- Everything is **100% on-device** (no server, no `pgvector`); the heavy embedding compute runs in
  the DB-free worker off the main thread; everything **survives app restart**.
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the M18 Playwright specs (semantic search finds
  a keyword-disjoint match + degrades to FTS-only; related items surface in the inspector;
  contradiction flag shows + compares) are green; the two new T087 migrations (the `embeddings`
  table + the `vec0` table, at whatever indices were free at build time) apply cleanly.

When T087–T089 are complete, continue with T090–T092 (staleness/expiry, source-reliability,
verification `task` elements) and T093–T095 (AI-assisted distillation with the user's own key /
local model + drafts-only, AI source grounding, synthesis notes) — generate their detailed spec
section(s) from the roadmap before starting T090.
