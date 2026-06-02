# M18 — Semantic search & AI (T087–T095)

Detailed, buildable specs for the AI-and-semantics half of Part II's M18. This file
covers the **last three** M18 tasks — the on-device AI + incremental-writing layer:

- **T093 — AI-assisted distillation (local-first):** AI _formulation_ actions
  (explain / simplify / suggest Q&A / suggest cloze / detect ambiguity / propose
  prerequisites / summarize) over a selected extract/source span. AI runs **on-device**
  from the Electron main on the **T058 background runner** with a **local model OR the
  user's own API key**, is **OFF by default**, and every output is a **DRAFT** that can
  never schedule an unapproved card.
- **T094 — AI source grounding:** every AI suggestion **links back** to the exact
  selected source text, and AI output is stored **separately** from source quotes
  (provenance: which source span produced which suggestion).
- **T095 — Incremental writing / synthesis notes:** scheduled `synthesis_note` elements
  (an existing core element type) collect linked extracts/cards and **return** for
  refinement on the attention scheduler — incremental writing.

> **The rest of M18 lives in sibling specs.** The **trust** slice — T090 (staleness/
> expiry), T091 (source-reliability metadata), T092 (verification `task` elements) — is
> specced in [`M18-trust.md`](./M18-trust.md). The **semantic-search** slice — T087
> (semantic search, `sqlite-vec`), T088 (related-item suggestions), T089 (contradiction
> detection) — is the on-device embedding/vector layer (its own spec file, generated when
> that slice is built). **T093 depends on T058 + T024 only** (the runner + extract
> distillation), so it does NOT need the semantic-search stack to land first; **T094
> depends on T093**; **T095 depends on T024 + T028** (extract review + attention
> scheduling). This file is buildable on its own. Where a deliverable here could later
> reuse the embedding/vector layer (e.g. an AI "similar extracts" hint, or making a
> synthesis note findable) it links to that slice rather than re-specifying it.

---

## Architecture invariants (non-negotiable — every deliverable honors these)

Everything here obeys [`../../CLAUDE.md`](../../CLAUDE.md) + [`../architecture.md`](../architecture.md)
+ the Part II direction note ([`../roadmap.md`](../roadmap.md) lines ~184–195, M18 header
lines ~339–348):

```txt
React UI (renderer)                          ← shows DRAFTS, requires explicit approval; never calls a model
  → typed client API wrapper (apps/web/src/lib/appApi.ts)
  → Electron preload bridge (window.appApi)  ← narrow typed surface; named-event progress
  → Electron main / DB service (validated IPC) ← OWNS the SQLite writer + the runner host + the API key
  → AiService / SynthesisService / JobRunner (apps/desktop/src/main) + repositories (packages/local-db)
  → SQLite + the T058 utilityProcess runner (the AI/model call runs OFF-main)
```

- **100% on-device by default; no first-party server in the loop.** AI runs from the
  Electron main with **(a)** a **local model** (an ONNX/`transformers.js`/`node-llama-cpp`
  model bundled-or-downloaded) OR **(b)** the **user's OWN API key** (Anthropic / OpenAI),
  stored in the SQLite `settings` table. **Off by default** (`ai.enabled = false`). An
  **optional managed proxy** (route through the future T051 backup server) MAY exist but is
  **off** until the user enables it, and enabling it **visibly discloses** that content is
  sent off-device. Your infrastructure is **never** in the loop by default.
- **The heavy/blocking work runs on the T058 runner**, not the main event loop. A local
  model inference or a remote HTTP call is an `ai` job (the reserved `JOB_TYPES` slot,
  `packages/core/src/enums.ts:202`). The DB-free `utilityProcess` worker does the
  compute/network; **main** applies the result (persists the draft) through the
  repositories — exactly the OcrService pattern (`apps/desktop/src/main/ocr-service.ts`).
- **AI output is ALWAYS a draft.** It NEVER schedules a card, NEVER creates an `active_card`,
  NEVER touches FSRS. A suggested card lands as a **parked, un-due `card_draft`**-stage element
  (`review_states.dueAt = null`, NOT `active_card`, NOT in the deck) only after the
  user **explicitly approves** it through a **draft-only `CardService` seam** that reuses the
  extract→card lineage/op path **but omits `firstScheduledAt`** (the stock
  `CardService.createFromExtract` is due-now and would activate + first-schedule the card — it is NOT
  reused verbatim here; see the T093 approve-to-card deliverable), where the existing T035/T086
  card-quality checks run on it. An unapproved suggestion is an inert `ai_suggestion` row,
  soft-deletable, never in any queue.
- **Lineage is sacred + grounding is separate (T094).** Every AI suggestion stores which
  **source span** generated it (source element id + block ids + offsets + the verbatim
  selected text), and the AI's generated text is stored in a **different column/row** from
  the source quote — so we always know "the model said X _about_ this exact source text",
  and a card minted from a suggestion inherits the lineage (`derived_from` → extract →
  source location → source).
- **The renderer never touches SQLite/Node/fs/the model/the API key.** It calls the narrow
  typed `window.appApi.ai.*` / `window.appApi.synthesis.*` surface. The API key is written
  and read main-side only; it is **never** returned to the renderer in plaintext (the
  settings read returns a `aiKeyConfigured: boolean`, not the key).
- **Mutations are transactional + append the existing `operation_log` ops.** `OPERATION_TYPES`
  (`packages/core/src/operation-log.ts:23`) is the **closed 15-op set** — "a rename is a
  migration." M18-AI adds **no new op type**: a synthesis note is a `create_element`; linking
  an extract into it is `add_relation`; approving a suggested card is the existing
  `create_card` path; scheduling a synthesis note's return is `reschedule_element`. **An AI
  suggestion row itself appends NO op** (it is a transient draft/infra artifact, like a `jobs`
  row or an `ocr_pages` row — document this in the repo docblock, mirroring
  `AssetRepository`'s "asset rows have no dedicated operation" note).
- **Deletes are soft; everything survives an app restart** (drafts persist in SQLite, the
  enable/key settings persist, a synthesis note + its links persist). **Schema changes ship a
  Drizzle migration** (`pnpm db:generate`). **Migration index: read `meta/_journal.json` at build
  time and use whatever the highest COMMITTED index is + 1 — do NOT hard-code, and do NOT assume
  T087–T092 have already landed.** The latest committed migration today is `0020_optimal_zombie.sql`
  (no `0021` exists yet), and T093 explicitly **depends only on T058 + T024** (it is "buildable on
  its own", below) — so a builder may legitimately build T093 BEFORE the T087–T092 siblings, in which
  case the `ai_suggestions` migration is actually `0021`, not `0022+`. Trust the journal, not a prose
  ordering assumption. Verify with native `pnpm`
  (`pnpm typecheck`/`pnpm test`/`pnpm lint`/`pnpm e2e`).

### The AI provider abstraction (specified once, used by T093 + T094)

Pick a **provider-agnostic seam** so the local-model / own-key / managed-proxy choice is one
swappable interface, and so **tests mock the provider — never a live call**:

```ts
// packages/core/src/ai.ts — the framework-agnostic contract (no fs/Electron/SQLite here)
export type AiProviderKind = "local" | "anthropic" | "openai" | "managed_proxy";

export interface AiRequest {
  readonly action: AiActionType;            // explain | simplify | suggest_qa | …
  readonly sourceText: string;              // the verbatim selected span (the grounding)
  readonly context?: string;                // optional surrounding extract/source context
}
export interface AiSuggestion {
  readonly kind: "text" | "card_qa" | "card_cloze" | "prerequisite_list";
  readonly text: string;                    // the model's generated text (NOT the source)
  readonly cards?: readonly DraftCard[];    // structured drafts for the card-shaped actions
}
export interface AiProvider {
  /** Generate suggestions for one request. The ONLY method that calls a model. */
  complete(request: AiRequest, signal?: AbortSignal): Promise<AiSuggestion>;
  readonly kind: AiProviderKind;
}
```

- The concrete providers live main-side (`apps/desktop/src/main/ai-providers/`): a
  `LocalModelProvider` (runs the bundled/downloaded model on the worker), an
  `AnthropicProvider` / `OpenAiProvider` (call the user's-own-key HTTP endpoint from the
  worker), and a `ManagedProxyProvider` (the off-by-default first-party route). A
  `selectProvider(settings)` factory reads the `settings` (kind + key presence) and returns
  the configured provider, or throws a typed `AiDisabledError` when `ai.enabled = false`.
- **Concrete recommended default:** ship with the local provider **available but its model
  not bundled** — first enable triggers an explicit, cancellable one-time **model download**
  (size/UX called out in each task's Notes). The own-key providers need no download. This
  keeps the installer small and AI genuinely opt-in.
- The provider's `complete` is what the `ai` job's worker dispatch calls. The job payload
  carries the request + the selected provider kind — but **never the API key** (a key must
  not land in the persisted, restart-safe `jobs` row that `JobsRepository.enqueue` writes via
  `JSON.stringify(payload)`).

#### How the API key actually reaches the worker (REQUIRED — pin ONE real mechanism)

The reviewer correctly flagged that the runner has **no per-job env channel**: `JobRunner`
forks **exactly one** long-lived worker in `start()` (`this.worker = this.forkFactory()`,
`job-runner.ts:191`) whose env is baked **once at construction** via `defaultFork(workerPath,
assetsDir)` (`job-runner.ts:138–144`, bound at `:182` from `index.ts` bootstrap), and
`enqueue(type, payload, { maxAttempts })` (`job-runner.ts:203`) has **no env parameter** and
there is **no re-fork / setEnv** method. So the key can ride **neither** a per-job fork-env
**nor** the persisted payload. **Pick mechanism (c) — construct the runner's worker env with
the key when AI is enabled — and accept its one honest cost (a key change requires a worker
restart).** Concretely:

- The **model dir** is static and rides the existing construction-time fork-env seam exactly
  like `INTERLEAVE_ASSETS_DIR`: extend `defaultFork`/`JobRunnerDeps` with a `modelDir` so the
  one worker is forked with `INTERLEAVE_AI_MODEL_DIR` baked in at `start()`. (This is the same
  one-more-env-var extension the embedding spec uses; no new runner capability.)
- The **own-key** is a **secret the worker needs only while AI is enabled**, so it is baked
  into that same one-time fork env (`INTERLEAVE_AI_API_KEY` / `INTERLEAVE_AI_PROVIDER`) **at
  worker construction**, NOT per job. Because the worker is long-lived, this means **enabling
  AI / changing the key requires the runner to (re)construct its worker** so the new env takes
  effect — `AiService` triggers a `runner.restartWorker()` (a small new `JobRunner` method:
  kill + re-fork via the factory; the persisted queue is untouched) when the key/enabled setting
  changes. **Because the re-fork is GATED ON IDLE (`inFlight.size === 0`, see the bound below), by
  construction there is nothing in flight when the worker is re-forked — so there is no kill-mid-job
  to recover from, and the idle-gated path does NOT rely on `recoverRunning()`.** (`recoverRunning()`
  is called exactly once, in `start()` (`job-runner.ts:193`), not on every fork — a bare re-fork does
  not call it. If a builder ever adds a FORCED, non-idle restart variant, that variant MUST itself
  call `recoverRunning()` + `kick()` after re-forking so any requeued `running` rows actually drain;
  the idle-gated default never needs this.) This is the **only** real channel given today's
  single-worker architecture; the
  spec MUST add the tiny `restartWorker()` capability + thread `apiKey`/`provider` into the
  fork factory, and the key is read **main-side from `settings`** and passed to the fork
  factory — it is **never** in `enqueue`'s payload and so **never** in a `jobs` row.
  - **Bound the restart so it does not collaterally re-run an unrelated in-flight job (REQUIRED).**
    **Mind the real concurrency model: the runner forks exactly ONE worker (`job-runner.ts:191`),
    but posts up to `DEFAULT_CONCURRENCY = 2` jobs to it concurrently (`job-runner.ts:120,283`,
    tracked in the `inFlight` Set `:175`).** So at restart time there can be **two** unrelated
    in-flight jobs, not one. Killing the single worker mid-flight kills **every** in-flight job — an
    OCR page AND a `url_import` the user just triggered — which then requeue via `recoverRunning()`
    and **re-run** purely because the user toggled an AI setting. `restartWorker()` MUST therefore
    **gate on the worker being fully idle — `inFlight.size === 0` (ALL in-flight jobs drained), NOT
    merely "the current job finished"**: if `inFlight` is non-empty, **defer** the restart (mark a
    `pendingRestart` flag) and re-fork **on the transition to an EMPTY `inFlight` set** (the next time
    `inFlight.size` reaches 0), not when any single job finishes. (All worker apply handlers —
    OCR/url_import/embed — are already idempotent-on-replay, so a forced requeue is *safe*;
    deferring-to-idle additionally avoids the surprising "changing my API key re-ran my OCR" wasted
    work + any non-idempotent step's duplicate
    side effects.) Document this bound + cover it in a test that exercises the **two-concurrent-job**
    case (a restart requested while **two** non-AI jobs are in flight does not interrupt either; it
    applies only once `inFlight` reaches 0 — not after just the first of the two finishes).
- **Tests** assert the key is absent from every persisted `jobs.payload` (the enqueued payload
  carries only `{ action, providerKind, request }`), and absent from any IPC result — the
  `FakeAiProvider` injection means no real key/env is needed under Vitest.
- **Honest caveat (the fork-env key is the least-bad on-device channel, but it IS in the worker's
  process env).** A key baked into the child-process env is visible to anything that can read that
  process's environment (`ps -E` on some platforms, crash dumps, an accidental
  `console.log(process.env)` in dev). It is still the **least-bad** channel given the single-worker
  architecture — the rejected `postMessage` side-channel adds a second secret path + a
  strip-before-persist invariant, and the payload would persist the key into a `jobs` row. The key
  is **never returned to the renderer** (settings project to `aiKeyConfigured: boolean`) and MUST
  **never be logged**; the worker must **not** echo `process.env`. Documentation-only — the design
  is unchanged.

*(Rejected alternatives, for the record: (a) a dedicated short-lived per-AI-job fork is a
bigger runner redesign than this milestone needs; (b) a main→worker postMessage secret
side-channel stripped before persistence works but adds a second secret path and a
strip-before-persist invariant the single-worker env channel avoids. Mechanism (c) reuses the
proven `INTERLEAVE_ASSETS_DIR` fork-env discipline with one added `restartWorker()`.)*

---

## T093 — AI-assisted distillation (local-first)

- **Status:** `[ ]` not started
- **Depends on:** T058 (the local background runner — `[x]` done), T024 (extract review /
  distillation — `[x]` done). In practice also leans on T035/T086 (card-quality checks, `[x]`)
  to vet drafted cards.
- **Roadmap line:** Done when AI actions (explain/simplify/suggest Q&A/suggest cloze/detect
  ambiguity/propose prerequisites/summarize) help formulation but never schedule unapproved
  cards (drafts only). AI calls run from the Electron main with the user's own API key (or a
  local model via the background runner) — your infrastructure is never in the loop by
  default; an optional, off-by-default managed proxy may route calls through the first-party
  server, disclosing that content is sent.

### Goal

From the extract distillation / card builder surface, the user can select a span and run an
**AI formulation action** — _explain_, _simplify_, _suggest Q&A_, _suggest cloze_, _detect
ambiguity_, _propose prerequisites_, or _summarize_ — and get back **drafts**. A card-shaped
suggestion (Q&A / cloze) appears as a reviewable draft with the existing card-quality warnings
already evaluated on it; the user **explicitly approves** it to mint a **parked, un-due
`card_draft`** element through a **draft-only `CardService` seam** that reuses the extract→card
lineage/op path but omits the due-now first-schedule (so lineage is unchanged and FSRS only ever
engages on the user's later explicit activation — the AI approve step never activates or
first-schedules). The AI
runs **on-device**, **off by default**: with no provider configured, the surface shows a calm
disabled state ("Turn on AI assistance in Settings") and the rest of the app is unaffected. When
enabled, the heavy call runs on the **T058 runner** so the UI never freezes; the suggestion is
persisted as an inert `ai_suggestions` row that never enters a queue and is freely dismissible.

### Context to load first

- Reference: [`../architecture.md`](../architecture.md) (the on-device AI note lines ~21,
  ~254–257; the "no apps/worker — on-device jobs run in the local runner" note line ~111),
  [`../../CLAUDE.md`](../../CLAUDE.md) ("Card-quality rules" — AI cards must be drafts until
  approved; "Electron runtime & security"; the closed `operation_log` vocabulary),
  [`../roadmap.md`](../roadmap.md) M18 header (off-by-default, managed-proxy disclosure, drafts
  only), [`../scheduling-and-priority.md`](../scheduling-and-priority.md) (cards are FSRS-only —
  a draft never enters FSRS).
- Existing code to inspect — **the runner + apply pattern (copy this exactly):**
  - `apps/desktop/src/main/ocr-service.ts` — the **canonical model** for an `ai`-style flow:
    `enqueuePage` (main does prep, then `getRunner().enqueue("ocr", payload)` — line ~120),
    `applyResult` (the runner apply handler persists the result, status `suggested`, idempotent,
    NEVER auto-merged into the body). The AiService mirrors this verbatim.
  - `apps/desktop/src/main/job-apply-handlers.ts` — `createJobApplyHandlers` (line 75); the `ocr`
    handler (line 87) + `fsrs_optimize` pass-through (line 101) are the two shapes the `ai`
    handler chooses between. The reserved `ai` slot is dispatched as "unsupported" today
    (`apps/desktop/src/worker/job-worker.ts:183` default case) — T093 wires it.
  - `apps/desktop/src/worker/job-worker.ts` — the DB-free worker: `dispatch` switch (line 160),
    `runOcr` (line 88, the fork-env `INTERLEAVE_ASSETS_DIR` resolve, line 61), `runFsrsOptimize`
    (line 136, the pure-compute shape). T093 adds a `runAi(jobId, payload)` case.
  - `apps/desktop/src/main/job-runner.ts` — `enqueue` (line 203), `waitForTerminal` (line 236),
    the `defaultFork` **fork-env seam** (`INTERLEAVE_ASSETS_DIR`, line 132–162 — the pattern the
    AI key/model-path env reuses), `JobApplyHandlers` type (line 70).
  - `apps/desktop/src/worker/messages.ts` — the Zod-validated main↔worker channel
    (`WorkerRequestSchema` line 40, `WorkerResultMessageSchema` line 59); the `ai` payload/result
    ride the existing `JsonValueSchema`.
- Existing code — **the extract→card path the approve step reuses:**
  - `packages/local-db/src/extract-service.ts` (`ExtractService`, the distillation seam — class
    line 105; `setStage` line 153) and `packages/local-db/src/card-service.ts` (`CardService` —
    the extract→`card_draft`→active path; `create_card` op). Approving a drafted card calls these,
    NOT a new path.
  - `packages/core/src/card-quality.ts` (`evaluateCardQuality` + `detectInterference`, T035/T086)
    — run on a drafted card BEFORE the user approves, so the same warnings show on AI drafts as on
    hand-authored ones.
- Existing code — **the seam to copy for the new surface:**
  - `apps/desktop/src/shared/contract.ts` (`AppApi` line 4236; the `search`/`sources` groups for
    shape), `apps/desktop/src/shared/channels.ts` (`IPC_CHANNELS`, e.g. `sourcesRunOcr` line 46),
    `apps/desktop/src/main/ipc.ts` (the async `sourcesRunOcr` handler + `requireRunner` guard),
    `apps/desktop/src/preload/index.ts`, `apps/web/src/lib/appApi.ts`.
  - `packages/core/src/settings.ts` (`AppSettings` line 70, `SETTINGS_KEYS` line 119,
    `DEFAULT_APP_SETTINGS` line 141, the `coerce*` choke points) + `SettingsRepository` —
    the new AI settings keys live here.
- Invariants in play: AI off-by-default; output always a draft; the heavy call on the runner
  (never main's event loop); the API key never persisted to a `jobs` row and never returned to
  the renderer; cards stay FSRS-only (a draft is not scheduled); the closed op set; soft-delete;
  survives restart.

### Provider + model decision (pick + justify — REQUIRED in the spec, build to it)

1. **Provider seam = `AiProvider` (above), selected by settings.** Default `ai.providerKind`
   is `"local"`, but because the local instruction model needs a one-time download (item 2), the
   recommended *working* generation path is the user's **own key** — the disabled-state UX guides a
   freshly-enabling user to either configure a key (works immediately) or download the experimental
   local model. (`ai.enabled` is still `false` by default, so nothing runs until the user opts in
   AND configures a provider.) Justify in the module docblock exactly this way: a single
   `complete(request)`
   interface keeps the local-model / own-key / managed-proxy choice swappable, keeps the call
   site (the `ai` worker dispatch) provider-agnostic, and makes the provider **trivially
   mockable** in tests (a `FakeAiProvider` returns a canned `AiSuggestion` — no model, no
   network). This is the same "inject the heavy capability behind a narrow interface"
   discipline the runner's `WorkerForkFactory` (`job-runner.ts:87`) and the media service's
   `mediaFetchImpl` (`db-service.ts:534`) already use.
2. **Generation default = the user's own key; the local model is the EXPLICITLY-EXPERIMENTAL
   option.** Unlike T087's embedding model (MiniLM, ~23 MB int8 ONNX, a well-understood baseline
   that reliably produces usable vectors on CPU), a local *instruction* model good enough to
   produce usable explain / suggest-QA / summarize drafts on-device is a materially bigger, less
   certain bet (tens-to-hundreds of MB to a few GB; CPU-only quality is uneven). So the spec does
   **not** leave the model as an open "transformers.js or node-llama-cpp" choice with no floor:
   - **The recommended default generation path is an own-key provider** (Anthropic / OpenAI) — it
     needs no download, has predictable quality, and keeps AI strictly opt-in. With AI on and an
     own-key configured the seven actions work immediately.
   - **The local provider is shipped as an explicitly-experimental option. To remove the build-time
     coin-flip, pin ONE library + ONE concrete model AND allow a stub fallback (the builder picks
     neither at random):**
     - **Pinned library + model (build to this if shipping a working local provider):**
       **`node-llama-cpp`** (a maintained Node binding for `llama.cpp`, runs GGUF on CPU in the
       worker) with **`Llama-3.2-3B-Instruct` Q4_K_M GGUF (~2 GB int4)** as the named default
       (the `aiLocalModelId` setting, default `"local:Llama-3.2-3B-Instruct-Q4_K_M"`; see AI
       settings). Prefer this over `transformers.js`
       for instruction generation: GGUF int4 + `llama.cpp` is the better-trodden on-device-LLM path
       and keeps the download to ~2 GB. Document a **realistic quality caveat** (CPU-only on-device
       output is weaker/slower than an own-key call; best-effort drafts only).
     - **ALLOWED fallback for T093 (so the milestone is buildable without committing to the LLM
       infra now):** the `LocalModelProvider` MAY ship as a **not-yet-available stub** — exactly like
       `ManagedProxyProvider` throws `AiProxyUnavailableError` — that throws a typed
       `AiProviderError` ("local model not yet available — configure an own-key provider") until the
       `node-llama-cpp` integration lands, with the concrete model id above reserved. In that case
       T093 ships **own-key fully working** + the local provider as the reserved stub, and the
       disabled-state UX routes a freshly-enabling user to an own-key provider. **Pick ONE of these
       two (working local provider with the pinned model, OR the reserved stub) — both are acceptable;
       do NOT leave it as an unpinned "transformers.js or node-llama-cpp, some model" choice.**
     It runs **in the `utilityProcess` worker** (DB-free, off-main; the worker
     isolation means a heavy inference never stalls main or the SQLite writer, same reason OCR's
     `tesseract.js` runs in the worker, `job-worker.ts:88`), is **not bundled into the installer**
     (first enable triggers the explicit, cancellable one-time download into `<dataDir>/models/`
     with size + progress shown).
   The **drafts-only + off-by-default + degrade-gracefully** invariants fully contain the residual
   risk: a weak, absent, or stubbed local model just means the action is disabled or routed to
   own-key — it can never produce an unapproved card or a bad active card.
3. **Own-key providers (Anthropic / OpenAI) = a plain HTTPS call from the worker** using the
   user's key, passed via the **construction-time fork-env seam** (`INTERLEAVE_AI_API_KEY` /
   `INTERLEAVE_AI_PROVIDER`), baked into the **one long-lived worker** when AI is enabled (see
   "How the API key actually reaches the worker" above), never written to the `jobs` row.
   Justify: env (not payload) is the established secret-handling pattern (`INTERLEAVE_ASSETS_DIR`,
   `job-runner.ts:142`), and it keeps the restart-safe persisted queue free of secrets. **Honest
   cost:** because the runner forks one worker with env baked at construction (`job-runner.ts:182,191`),
   enabling AI / changing the key requires `AiService` to call the new `runner.restartWorker()`
   so the worker re-forks with the new env — there is no per-job env channel today.
4. **Managed proxy = off by default**, behind `ai.managedProxyEnabled = false`. Enabling it is
   gated by a confirm dialog that **discloses content is sent to the first-party server**
   (the T051 backup API gains a thin `/ai/complete` route later — out of scope here; T093 only
   declares the provider kind + the disclosure, and the proxy provider can throw
   `AiProxyUnavailableError` until the server route lands).

### Deliverables

- [ ] **AI domain contract** — `packages/core/src/ai.ts`: the `AiActionType` union
      (`explain | simplify | suggest_qa | suggest_cloze | detect_ambiguity | propose_prerequisites
      | summarize`), `AiProviderKind`, `AiRequest`, `AiSuggestion`, `DraftCard`, `AiProvider`,
      and the typed errors `AiDisabledError` / `AiProviderError` / `AiProxyUnavailableError`.
      Framework-agnostic (no fs/Electron/SQLite — like `source-ref.ts`/`job.ts`). Export from
      the `@interleave/core` barrel + a Zod schema mirror for IPC validation. Add `ai` to
      nothing in `enums.ts` except confirming the reserved `JOB_TYPES` `"ai"` slot is now wired
      (no enum change — it already exists, `enums.ts:202`).
- [ ] **AI settings** — extend `AppSettings` (`packages/core/src/settings.ts`) with:
      `aiEnabled: boolean` (default `false`), `aiProviderKind: AiProviderKind` (default
      `"local"`), `aiManagedProxyEnabled: boolean` (default `false`), `aiModelDownloaded: boolean`
      (default `false`, flipped after the local-model download), `aiLocalModelId: string` (default
      `"local:Llama-3.2-3B-Instruct-Q4_K_M"` — the pinned local instruction model from the
      provider/model decision item 2; identifies the model dir + the download), and the
      **API-key handling**:
      store the own-key under `SETTINGS_KEYS.aiApiKey = "ai.apiKey"` but **never expose it to the
      renderer** — the typed-settings read PROJECTS it to `aiKeyConfigured: boolean`. Add the
      `SETTINGS_KEYS` entries, `DEFAULT_APP_SETTINGS` values, and a `coerceAiProviderKind` choke
      point (unknown kind → `"local"`). Document that the key write is main-side only.
- [ ] **Runner fork-env + `restartWorker()` (the real key/model-dir channel).** Because the
      runner forks ONE long-lived worker with env baked at construction (`job-runner.ts:138–144,
      182, 191`) and `enqueue` has no env parameter, T093 adds the only viable secret channel:
      (1) extend `JobRunnerDeps`/`defaultFork` to bake `INTERLEAVE_AI_API_KEY` /
      `INTERLEAVE_AI_PROVIDER` / `INTERLEAVE_AI_MODEL_DIR` into the worker fork (the same shape as
      the existing `INTERLEAVE_ASSETS_DIR` seam), with the values read **main-side from `settings`
      at bootstrap**; (2) add a small `JobRunner.restartWorker()` (kill the current worker +
      re-fork via the factory; the persisted queue is untouched — **and because the re-fork is gated
      on `inFlight.size === 0` (below), nothing is in flight at re-fork time, so the idle-gated path
      does NOT depend on `recoverRunning()`** (which runs only at `start()`, `job-runner.ts:193`, and
      is NOT called by a bare re-fork) — there is nothing to recover) that `AiService` calls when the
      AI enable/key/provider
      settings change, so the new env takes effect. **`restartWorker()` gates on the worker being
      fully idle — `inFlight.size === 0` (ALL in-flight jobs drained), NOT merely "the current job
      finished".** The runner posts up to `DEFAULT_CONCURRENCY = 2` jobs to its single worker
      concurrently (`job-runner.ts:120,283`, tracked in `inFlight` `:175`), so there can be TWO
      unrelated in-flight jobs at restart time. If `inFlight` is non-empty, DEFER the re-fork (a
      `pendingRestart` flag) and re-fork **on the transition to an empty `inFlight` set** (not after
      just the first job finishes), so toggling an AI setting never kills + re-runs any of the (up to
      two) in-flight OCR/`url_import`/embed jobs (see the bound in the API-key mechanism above). **The
      key is never in `enqueue`'s payload and never in a `jobs` row.** Test: changing the key triggers
      a re-fork; a restart requested while **two** non-AI jobs are in flight does NOT interrupt either
      and applies only once `inFlight` reaches 0; the persisted queue survives; no key appears in any
      `jobs.payload`.
- [ ] **`ai_suggestions` table + migration** — a new table module
      `packages/db/src/schema/ai.ts` (mirror `assets`/`ocr_pages` shape): `id` (text PK),
      `owning_element_id` (FK → `elements`, `onDelete: cascade` — the extract/source the action
      ran on), `action` (text, CHECK against `AI_ACTION_TYPES`), `kind` (text — text/card_qa/…),
      `provider_kind` (text), `suggestion_text` (text — the **model's** output), **the grounding
      columns (T094, see below):** `source_element_id`, `source_block_ids` (JSON), `start_offset`,
      `end_offset`, `selected_text` (text — the **verbatim source quote, stored SEPARATELY** from
      `suggestion_text`), `status` (text — `draft | approved | dismissed`, default `draft`),
      `created_at`. Indexes: `ai_suggestions_owning_idx`, `ai_suggestions_status_idx`. Export from
      the schema barrel; `pnpm db:generate` → the **next available migration index at build time**
      (read `meta/_journal.json` and use the highest COMMITTED index + 1 — do NOT hard-code, and do
      NOT assume the T087–T092 siblings have landed: T093 depends only on T058 + T024 and may build
      first, in which case this is `0021`, not `0022+`; commit the generated SQL + snapshot). **No
      `operation_log` entry for a suggestion row** (transient draft/infra).
- [ ] **`AiSuggestionRepository`** — `packages/local-db/src/ai-suggestion-repository.ts`: typed
      CRUD for the draft rows — `createWithin(tx, input)` / `create(input)` (writes the row, NO
      op — document this like `AssetRepository`), `listForElement(id)`, `findById(id)`,
      `setStatus(id, status)`, `softDismiss(id)`. Map rows ↔ an `AiSuggestion` domain shape.
      Register in `Repositories` + `createRepositories` (`packages/local-db/src/index.ts`).
- [ ] **The `ai` worker dispatch** — in `apps/desktop/src/worker/job-worker.ts` add a
      `runAi(jobId, payload)` case to `dispatch` (line 160) that: reads the provider kind +
      request from the validated payload, resolves the provider (local model from
      `INTERLEAVE_AI_MODEL_DIR` env / own-key from `INTERLEAVE_AI_API_KEY` env — both baked into
      the worker fork at construction time, NOT in the payload; see the API-key mechanism above),
      runs `provider.complete(request)` off-main posting `progress`, and posts a `result` carrying
      the `AiSuggestion` JSON (or a typed `error`). **Worker stays DB-free** — it imports the pure
      `@interleave/core` AI types + the provider impls only, NEVER `@interleave/db`/repositories.
- [ ] **Local-model download (pin ONE concrete path — NOT a new job type).** The model download is
      **a guarded main-side fetch**, not a worker job and not a new `JOB_TYPES` member
      (`ai_model_download` is NOT in `enums.ts:193–214`; adding it would break the "no new
      `JOB_TYPES`" promise). `AiService.downloadModel()` (main): on first enable of the local
      provider, stream the model files to `<dataDir>/models/<modelId>/` with a **content-length /
      checksum** verification, writing to a `*.partial` temp path and atomically renaming on
      completion (so a half-download never looks present — partial-file resume is a documented
      later nicety, NOT required for the MVP: a failed/cancelled download deletes the `.partial`
      and retries from zero). It emits **progress over a dedicated `ai:modelDownload` named event**
      (mirroring the `jobs.subscribe` progress channel), is **cancellable** (an `AbortController`),
      and on success flips `aiModelDownloaded = true` in `settings` **in one transaction**
      (idempotent: re-running when the verified files already exist is a no-op that just flips the
      flag). Until it completes, `ai.status()` reports `modelDownloaded: false` and every action
      stays disabled with the "downloading model…" affordance — never a crash or silent no-op.
- [ ] **`AiService`** — `apps/desktop/src/main/ai-service.ts` (mirror `OcrService`): `enqueue(input:
      { owningElementId; action; sourceRef })` — reads settings, throws `AiDisabledError` when
      `aiEnabled = false`, builds the `AiRequest` from the selected source text, then
      `getRunner().enqueue("ai", { action, providerKind, request })`, returns `{ jobId }`. **The
      key is NOT in this payload** — it was baked into the worker's fork env when AI was enabled
      (see the API-key mechanism above); `AiService` is responsible for calling
      `runner.restartWorker()` when the enable/key/provider settings change so the worker re-forks
      with the current env (it does NOT re-fork per `enqueue`). `enqueue` carries only the
      non-secret request shape;
      `applyResult(payload, result)` — the runner's `ai` apply handler: persists ONE
      `ai_suggestions` row (status `draft`) with the grounding (T094), runs `evaluateCardQuality`
      on any card draft and stashes the warnings on the returned summary, returns a renderer-safe
      `AiSuggestionSummary` (NO key, NO raw provider internals). `listForElement` / `dismiss`.
      Idempotent (a re-run on crash-resume overwrites/no-dups by job id).
- [ ] **The `ai` apply handler** — register it in `createJobApplyHandlers`
      (`job-apply-handlers.ts`) delegating to `AiService.applyResult` (exactly like the `ocr`
      handler, line 87). Add the `getAiService` lazy accessor to `JobApplyHandlerDeps`.
- [ ] **Approve-to-card path (the draft → real card step) — needs a NEW draft-only seam; the
      existing `createFromExtract` is NOT reusable verbatim.** A main-side
      `AiService.approveCard(suggestionId)` that, in ONE transaction: re-validates the draft card
      against `evaluateCardQuality` (reject on a hard `empty` block), creates a **parked, un-due
      `card_draft`** element, writes the `derived_from` lineage from the suggestion's
      `owning_element_id` + the grounding source location, and flips the suggestion row to `approved`.
      **Critical correction — verify against the code:** the existing
      `CardService.createFromExtract` (`packages/local-db/src/card-service.ts:160–244`) **hardcodes
      `firstScheduledAt = input.asOf ?? nowIso()` (line 226)**, which makes
      `ReviewRepository.createCardWithin` write a **DUE `review_states` row AND activate the element
      `card_draft → active_card`** (confirmed by `card-service.test.ts:96,114,141`). So you **CANNOT**
      reuse `createFromExtract` and also satisfy "never activate / never first-schedule". Instead:
      - **Add a new draft-only seam** that **omits `firstScheduledAt`** so
        `ReviewRepository.createCardWithin` leaves the card **parked un-due**
        (`review_states.dueAt = null`, element stays `card_draft`, `fsrsState: "new"`,
        **not in the due deck**) — `createCardWithin` already supports this exact shape when
        `firstScheduledAt` is omitted (`review-repository.ts:192–204`), but **no public `CardService`
        method exposes it today** (`createFromExtract` is due-now only). Add e.g.
        `CardService.createDraftFromSuggestion(...)` (or a `firstSchedule: false` option on the
        extract→card path) that builds the same `card_draft` lineage + `create_element`/`create_card`
        ops **without** `firstScheduledAt`, and route `approveCard` through THAT. Do **not** call the
        due-now `createFromExtract`.
      - **Wording fix:** the card does get a `review_states` **row** (every card-creation path writes
        one — the parked variant just has `dueAt = null`). So the invariant is **"parked un-due
        (`dueAt = null`), NOT in the due deck, NOT activated (`card_draft`, not `active_card`), and
        not yet FSRS-scheduled"** — NOT "no `review_states` row" (that is impossible via any
        card-creation path). Activation (first-schedule / FSRS) stays the user's existing explicit
        card action.
      A non-card suggestion (explain/summarize) has no approve-to-card; its text is copy-or-insert
      only.
- [ ] **IPC seam** — `contract.ts`: an `ai` group on `AppApi` — `run(request): Promise<{ jobId }>`
      (enqueue an action; the renderer then observes via the existing `jobs.subscribe`),
      `list(request): Promise<AiListResult>` (the draft suggestions for an element),
      `approveCard(request): Promise<AiApproveResult>`, `dismiss(request): Promise<AiDismissResult>`,
      and `status(): Promise<AiStatusResult>` (`{ enabled, providerKind, keyConfigured,
      modelDownloaded, managedProxyEnabled }` — the disabled-state + disclosure data). **No generic
      `jobs.enqueue`** — `ai.run` is the only AI enqueue path (mirroring `sources.runOcr`). Add the
      channels (`ai:run` / `ai:list` / `ai:approveCard` / `ai:dismiss` / `ai:status`), the ipc.ts
      handlers (with a `requireRunner`/`requireAiService` guard), preload, and `appApi.ts` client.
      Zod schemas for every request/result (`contract.test.ts`).
- [ ] **Renderer — the AI actions surface** — in the extract distillation / card builder
      (`apps/web/src/...` extract review / `CardBuilder`): a span-selection "AI" menu offering the
      seven actions, a drafts panel showing each suggestion with its **grounding ref** (the source
      quote it was made about, T094) + the card-quality warnings, an **Approve** button (mints the
      draft card) and a **Dismiss**, and a **calm disabled state** when `ai.status().enabled` is
      false ("Turn on AI assistance in Settings →") plus the **managed-proxy disclosure** banner
      when that route is selected. The renderer NEVER calls a model, holds a key, or mints a card
      directly — it sends intents and shows what main computed. Settings page (`/settings`) gains
      an "AI assistance" section: enable toggle, provider picker, own-key field (write-only —
      shows `keyConfigured`, never the key), the model-download button + progress, and the
      managed-proxy toggle behind the disclosure confirm.
- [ ] **Tests:**
  - **Unit (`@interleave/core`):** `ai.test.ts` — the action union, the Zod schemas, the typed
    errors; `settings.test.ts` additions — the AI defaults, `coerceAiProviderKind`, and that the
    typed read PROJECTS the key to `keyConfigured` (never returns the raw key).
  - **Repository (`packages/local-db`):** `ai-suggestion-repository.test.ts` — create/list/status/
    soft-dismiss; the grounding columns round-trip; **NO `operation_log` row** is appended for a
    suggestion (assert the op-log is empty after a create); the approve path goes through the
    **draft-only `CardService` seam** (NOT the due-now `createFromExtract`) and DOES append
    `create_element` + `create_card` while leaving the card parked un-due (`review_states.dueAt =
    null`, still `card_draft`).
  - **Main (`apps/desktop`):** `ai-service.test.ts` — with a **`FakeAiProvider`** (canned
    suggestion, **no model/network**): `enqueue` throws `AiDisabledError` when off; when on, the
    job applies a `draft` suggestion with card-quality warnings attached; `approveCard` mints a
    **parked, un-due** `card_draft` via the draft-only seam (assert the element stays `card_draft`
    (NOT `active_card`), the `review_states` row exists but has `dueAt = null` — i.e. NOT due, NOT in
    the FSRS deck — NOT that no row exists, since every card-creation path writes one); the API key is
    NEVER present in the persisted `jobs` row (assert the enqueued `jobs.payload` carries only
    `{ action, providerKind, request }` — no key) and is NEVER in an `AiStatusResult`; changing the
    key/enable setting triggers `runner.restartWorker()` (the worker re-forks with the new env)
    while the persisted queue survives; `contract.test.ts` + `db-service.test.ts` wiring; a
    `job-worker` unit test for the `ai` dispatch with a fake provider.
  - **E2E (`tests/electron/ai-distillation.spec.ts`):** with AI enabled via a fake provider
    injected through the test seam (NO live model/network): run "suggest Q&A" on a selected span →
    a draft appears with its grounding ref + quality warnings → Approve mints a `card_draft` that
    is NOT yet in review → the draft and the approved card survive an **app restart**. A second
    spec asserts the disabled state renders when AI is off.
  - `pnpm typecheck` + `pnpm test` + `pnpm lint` + `pnpm e2e` green.

### Done when

- The seven AI actions are available over a selected span and **produce drafts only** — no
  action ever creates an `active_card`, writes `review_states`, or enqueues anything into a
  review/attention queue without an explicit user approval.
- AI is **off by default**; with no provider configured the surface shows a calm disabled state
  and the rest of the app works unchanged.
- When enabled, the AI call runs on the **T058 runner** (the UI never blocks); a suggestion is
  persisted as a `draft` `ai_suggestions` row, freely dismissible.
- A drafted card shows the **existing T035/T086 card-quality warnings** before approval;
  approving it mints a **parked, un-due `card_draft`** (`review_states.dueAt = null`, element stays
  `card_draft`, NOT `active_card`, NOT in the due deck, not yet FSRS-scheduled) through a
  **draft-only `CardService` seam** (`createFromExtract` is due-now and is NOT reused verbatim — see
  the approve-to-card deliverable) with full `create_element`/`create_card`/`derived_from` lineage.
  Activation/first-schedule (which sets `dueAt` and enters FSRS) stays the user's existing explicit
  card action.
- The **user's API key is never written to a `jobs` row and never returned to the renderer**;
  the managed proxy is off by default and enabling it shows the content-is-sent disclosure.
- No new `operation_log` op type; the suggestion row appends none; approving appends the existing
  `create_element`/`create_card`. Multi-table writes are transactional; deletes are soft.
- The feature survives **app restart**; source lineage is preserved.
- `pnpm typecheck` / `pnpm test` / `pnpm lint` / relevant `pnpm e2e` pass; the migration is
  included.

### Notes / risks

- **Local-model download UX (be honest + concrete).** A usable on-device instruction model is
  tens-to-hundreds of MB to a few GB, and CPU-only generation quality is uneven — so the **own-key
  provider is the recommended default generation path** and the **local model is the
  explicitly-experimental option**, pinned to **ONE** library + model: **`node-llama-cpp` running
  `Llama-3.2-3B-Instruct` Q4_K_M GGUF (~2 GB int4)**, with a documented best-effort-quality caveat
  (see the provider/model decision, item 2). **The `LocalModelProvider` MAY instead ship as a
  reserved not-yet-available stub in T093** (throwing a typed `AiProviderError`, like
  `ManagedProxyProvider` throws `AiProxyUnavailableError`), deferring the actual `node-llama-cpp`
  integration while own-key ships fully working — pick the working provider OR the reserved stub, not
  an unpinned choice. We do NOT bundle the model (keeps the installer small + AI opt-in).
  The download is a **guarded main-side fetch** (`AiService.downloadModel()`), **not** a worker
  job and **not** a new `JOB_TYPES` member — it streams to `<dataDir>/models/<modelId>/` via a
  `*.partial` temp file with a checksum/content-length check + atomic rename, emits progress over
  a dedicated `ai:modelDownload` named event, is cancellable (`AbortController`), and flips
  `aiModelDownloaded` in one transaction on success (idempotent — re-running with verified files
  present just re-flips the flag). A failed/cancelled download deletes the `.partial` and retries
  from zero (true resume is a documented later nicety, not MVP). **Degrade gracefully:** with no
  model and no key, `ai.status()` reports `enabled:false`-equivalent and every action is disabled
  with a clear "configure a provider" prompt — never a crash or a silent no-op. A user with only
  an own-key configured skips the download entirely.
- **The managed proxy is declared, not built here.** T093 ships the `ManagedProxyProvider` kind
  + the disclosure UX, but the server `/ai/complete` route is a later backup-API addition; until
  then the proxy provider throws `AiProxyUnavailableError` and the toggle explains it is not yet
  available. This keeps "no first-party server in the loop by default" honest.
- **Tests never call a model or network.** All AI tests inject a `FakeAiProvider`; CI must have
  no path to a live model/endpoint. Document the injection seam (the `selectProvider` factory
  accepts an override, like `mediaFetchImpl`).
- **Reserved-slot reuse.** `ai` is already a `JOB_TYPES` member (`enums.ts:202`) and the worker
  default-cases it as unsupported today (`job-worker.ts:183`) — T093 only adds the dispatch case
  + apply handler, no queue/table/IPC shape change to the runner itself.
- Downstream: T094 fills the grounding columns this task already declares; T095's synthesis notes
  may later run an AI "summarize linked extracts" action through this exact seam.

---

## T094 — AI source grounding

- **Status:** `[ ]` not started
- **Depends on:** T093.
- **Roadmap line:** Done when every AI suggestion links back to selected source text and AI
  output is stored separately from source quotes.

### Goal

Every AI suggestion is **anchored to the exact source span** that produced it, and the model's
generated text is kept **physically separate** from the verbatim source quote — so the user (and
any later audit) can always see "the model proposed _this_ **about** _that exact source text_,
at _that_ location in _that_ source." A suggestion is never an unmoored blob: it carries a
resolvable `SourceRef` (jump-to-source works), and a card minted from it inherits that lineage.
This is the lineage-sacred guarantee applied to AI output.

### Context to load first

- Reference: [`../../CLAUDE.md`](../../CLAUDE.md) ("Do not implement features in a way that
  breaks source lineage"; the extraction-stores list — parent/source element id, source block
  ids, offsets, selected-text snapshot, inherited metadata), [`../domain-model.md`](../domain-model.md)
  ("Relationships & lineage" lines ~65–73 — `source_locations`, `derived_from`).
- Existing code to inspect — **the grounding substrate already exists, reuse it:**
  - `packages/core/src/source-ref.ts` — `SourceRef` (line 29: `sourceElementId`, `sourceTitle`,
    `url`, `author`, `publishedAt`, `locationLabel`, `snippet`), `EMPTY_SOURCE_REF` (line 47),
    `FormattedSourceRef` (line 65) — the EXACT shape an AI suggestion's grounding reuses; do NOT
    invent a parallel ref model.
  - `packages/local-db/src/source-ref-query.ts` (the read-only `SourceRef` resolver behind the
    refblock, T043) + `source-location-label.ts` (the human label) — the suggestion grounding
    resolves through these.
  - `source_locations` table (`packages/db/src/schema`, columns: `source_element_id`,
    `block_ids[]`, `start_offset`, `end_offset`, `selected_text`, `label`) + the extraction-service
    persistence (`packages/local-db/src/extraction-service.ts`) — the same columns the
    `ai_suggestions` grounding columns mirror.
- Existing code — the `ai_suggestions` table from T093 (this task FILLS its grounding columns +
  the resolver); the refblock renderer (`apps/web/.../RefBlock` reused by extracts/cards) the AI
  drafts panel reuses to show the grounding.
- Invariants: the model output (`suggestion_text`) and the source quote (`selected_text`) live in
  **separate columns** — never concatenated; a suggestion always resolves a `SourceRef` (or the
  calm `EMPTY_SOURCE_REF` orphan case); an approved card inherits the grounding as a real
  `source_location`.

### Deliverables

- [ ] **Grounding capture on enqueue** — `AiService.enqueue` (T093) takes a `sourceRef`
      ({ sourceElementId, blockIds, startOffset, endOffset, selectedText }) captured from the
      renderer selection (the SAME selection payload the T021 extraction path uses), and the `ai`
      apply handler persists it into the `ai_suggestions` grounding columns. **`selected_text`
      (the verbatim source quote) is stored in its own column, distinct from `suggestion_text`
      (the model output)** — assert this separation in a test.
- [ ] **Grounding resolver** — extend `AiSuggestionRepository` (or a small `AiGroundingQuery`)
      with `groundingFor(suggestionId): SourceRef` that resolves the stored span to a
      `SourceRef` via the existing `source-ref-query` + `source-location-label` helpers (jump-to-
      source target + the human location label + the verbatim quote). Orphan case (source gone)
      degrades to `EMPTY_SOURCE_REF` — a calm "source unavailable", never a broken link (matching
      `source-ref.ts`'s documented orphan behavior).
- [ ] **Approve inherits the grounding** — `AiService.approveCard` (T093) writes a real
      `source_locations` row from the suggestion's grounding when minting the `card_draft`, so the
      approved card's refblock + jump-to-source work identically to an extract-derived card. The
      `derived_from` edge points the card at the suggestion's `owning_element_id` (the extract/
      source), keeping `card → extract → source location → source` intact.
- [ ] **IPC + renderer** — the `ai.list` result (T093) includes each suggestion's resolved
      grounding `SourceRef`; the drafts panel renders it through the existing **RefBlock**
      component (so an AI draft shows its source provenance exactly like a card/extract does),
      with the model text and the source quote visually distinct.
- [ ] **Tests:**
  - **Repository:** `ai-suggestion-repository.test.ts` additions — the grounding columns
    round-trip; `groundingFor` resolves a `SourceRef` with the right `sourceElementId`/
    `locationLabel`/`snippet`; the orphan case returns `EMPTY_SOURCE_REF`; **`selected_text` and
    `suggestion_text` are separate** (a test that sets distinct values and reads them back
    independently).
  - **Main:** `ai-service.test.ts` additions — `approveCard` writes a `source_locations` row and a
    `derived_from` edge so the minted card resolves the same `SourceRef`; the lineage chain
    `card → … → source` is intact.
  - **E2E:** extend `ai-distillation.spec.ts` — a suggestion's drafts panel shows the source quote
    + a working "jump to source" that lands on the originating block; the approved card's refblock
    shows the same provenance; survives **app restart**.
  - `pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm e2e` green.

### Done when

- Every AI suggestion stores **which source span produced it** (source element id + block ids +
  offsets + the verbatim `selected_text`) and resolves a `SourceRef` with a working jump-to-source.
- The model's output (`suggestion_text`) is stored **separately** from the source quote
  (`selected_text`) — never merged; a test asserts the separation.
- A card approved from a suggestion **inherits the grounding** as a real `source_location` +
  `derived_from` edge, so its lineage + refblock match an extract-derived card.
- The orphan case (source deleted) degrades to the calm "source unavailable" placeholder, not a
  broken link.
- No new op type; the approve path appends the existing ops; survives **app restart**; lineage
  preserved.
- `pnpm typecheck` / `pnpm test` / `pnpm lint` / relevant `pnpm e2e` pass (migration from T093
  already carries the columns — no new migration unless a column was missed).

### Notes / risks

- **No new schema if T093 declared the columns.** T093's `ai_suggestions` table already includes
  the grounding columns; T094 is mostly the **resolver + the approve-inherits-grounding wiring +
  the renderer**. If a column was missed, ship a small additive migration.
- **Reuse, do not reinvent.** The whole point is that AI grounding is the SAME lineage substrate
  (`SourceRef` / `source_locations` / `derived_from`) extracts and cards already use — a reviewer
  should see no parallel provenance model.

---

## T095 — Incremental writing / synthesis notes

- **Status:** `[ ]` not started
- **Depends on:** T024 (extract review — `[x]` done), T028 (explicit attention scheduling /
  `queue.schedule` — `[x]` done).
- **Roadmap line:** Done when scheduled `synthesis_note` elements collect linked extracts/cards
  and return for refinement.

### Goal

The user can create a **synthesis note** — a `synthesis_note` element (an existing core type,
`enums.ts:28`; stage `synthesis`, `domain-model.md:46`) — a writing/thinking surface that
**collects linked extracts and cards** and is **scheduled to return** for incremental refinement
on the **attention scheduler** (NOT FSRS — a synthesis note is processed, not recalled). It is
the "incremental writing" counterpart to incremental reading: a long-lived note where ideas from
many sources are woven together over repeated passes, surfacing in the due queue like any other
attention item, with its linked source material one click away. A synthesis note is first-class
in the inspector/library/lineage like every other element.

### Context to load first

- Reference: [`../concept.md`](../concept.md) (incremental writing / synthesis in the pipeline),
  [`../domain-model.md`](../domain-model.md) (`synthesis_note` element type line 17, `synthesis`
  stage line 46, lineage via `element_relations`/`references` lines 65–73),
  [`../scheduling-and-priority.md`](../scheduling-and-priority.md) (the attention scheduler
  schedules sources/topics/extracts — and now synthesis notes; **FSRS schedules cards only**).
- Existing code to inspect — **the element + document + scheduling substrate already exists:**
  - `packages/core/src/enums.ts` — `synthesis_note` is already in `ELEMENT_TYPES` (line 28) and
    `synthesis` in `DISTILLATION_STAGES` (line 66); `LibraryQuery` already lists
    `topic/synthesis_note/task` (`db-service.ts:553`). No enum change — T095 makes the type
    actually creatable + editable + scheduled.
  - `packages/local-db/src/element-repository.ts` (`ElementRepository.createWithin` —
    `create_element`), `document-repository.ts` (the ProseMirror body the note edits, reusing the
    Tiptap editor from T015), `queue-repository.ts` / `queue-query.ts` (the attention due read),
    and **the explicit-return seam `queue.schedule`** (`QueueScheduleRequest`, the
    `reschedule_element` apply behind `apps/web` — `contract.ts` queue group) — a synthesis note
    reschedules through the SAME attention path an extract/topic uses (cards are rejected there).
  - `packages/local-db/src/extract-service.ts` (`ExtractService` — the attention reschedule on
    `setStage`, line 153, the interval heuristic) — the model for "a non-card element returns on
    the attention scheduler."
  - `packages/local-db/src/lineage-query.ts` + `inspector-query.ts` — the children/parent tree a
    synthesis note's linked extracts/cards render in.
  - `apps/web/src/...` the Tiptap editor (T015) + the reader/extract editor surfaces a synthesis
    note's editor reuses; the inspector + library (T010/T023) it appears in.
- Invariants: a synthesis note is scheduled on the **attention scheduler** (`reschedule_element`),
  **never** FSRS / `review_states`; links to extracts/cards are explicit `element_relations`
  (`references` for the collected material; `derived_from` is NOT it — the note is not derived
  FROM them, it references them) — added via `add_relation`, removed via `remove_relation`;
  creating the note is `create_element`; editing the body is `update_document`; soft-delete only;
  survives restart.

### Decision (pick + justify — REQUIRED)

- **A synthesis note is a `synthesis_note` element + a `documents` body**, NOT a new table.
  Justify: it is "either an element or belongs to one" (the universal primitive); it reuses the
  whole element/document/lineage/scheduling substrate, so the inspector, library, search (its
  body can later join the FTS/embedding index), trash/undo, and backup all work for free. The
  only new persistence is the **link relations** (already modeled by `element_relations`) — so
  **no new table is needed** beyond confirming the relation type. (If a small side-table is
  wanted for synthesis-specific metadata like a "last refined at" timestamp, justify it; the
  default is to reuse `elements.updated_at` + the op log, i.e. **no new table**.)
- **The collected links use the `references` relation type** (`RELATION_TYPES`, `enums.ts:82`) —
  from the synthesis note TO each collected extract/card — so the note "references" its material
  without claiming lineage descent (the extracts/cards are NOT children of the note; they keep
  their own source lineage). The note's lineage tree shows them as referenced material.
- **The return cadence uses the attention scheduler** via the existing `reschedule_element` /
  `queue.schedule` seam — a synthesis note is `scheduled` for tomorrow/next-week/next-month/a
  manual date exactly like an extract's explicit return (T028). It NEVER gets a `review_states`
  row.

### Deliverables

- [ ] **`SynthesisService`** — `packages/local-db/src/synthesis-service.ts`: the transactional
      domain seam (no React, no SQL in the renderer):
      - `create(input: { title; priority?; bodyJson? }): ElementResult` — creates a
        `synthesis_note` element (status `pending`/`active`, stage `synthesis`) + an initial
        `documents` body, in ONE transaction logging `create_element` (+ `update_document` if a
        body is supplied). Inherits the default source priority.
      - `linkElement(noteId, targetId): RelationResult` — adds a `references` edge note→target
        (an extract or card), logging `add_relation`; rejects a non-extract/non-card target and a
        cycle; idempotent (a duplicate link is a no-op).
      - `unlinkElement(noteId, targetId)` — removes the edge, logging `remove_relation`.
      - `editBody(noteId, bodyJson)` — upserts the ProseMirror body via `DocumentRepository`
        (`update_document`), preserving stable block ids (so the note's own text can later be
        extracted-from / searched).
      - `scheduleReturn(noteId, when)` — delegates to the EXISTING attention reschedule
        (`reschedule_element`, status → `scheduled`); **rejects nothing about cards** because a
        synthesis note is not a card — but it MUST refuse to write `review_states` (it uses the
        attention path only). Reuse the `queue.schedule` apply rather than duplicating it.
      Register in `Repositories`/`createRepositories` and the `DbService` lazy accessors.
- [ ] **No schema migration unless a side-table is chosen.** Per the decision, T095 reuses
      `elements` + `documents` + `element_relations` (`references`). If you add a synthesis side-
      table, ship the migration; the default path adds **none**.
- [ ] **IPC seam** — a `synthesis` group on `AppApi` (`contract.ts`): `create(request)`,
      `link(request)`, `unlink(request)`, `editBody(request)`, `scheduleReturn(request)`,
      `get(request)` (the note + its linked extracts/cards + due date). Channels
      (`synthesis:create` / `:link` / `:unlink` / `:editBody` / `:scheduleReturn` / `:get`),
      ipc.ts handlers, preload, `appApi.ts`, Zod schemas (`contract.test.ts`). A synthesis note's
      due/return also flows through the EXISTING `queue.list` (it is an attention item) — assert
      a scheduled note appears in the due queue.
- [ ] **Renderer — the synthesis note surface** — a synthesis-note editor (reusing the Tiptap
      editor from T015) with: a **linked-material panel** (the collected extracts/cards, each
      jump-to-able), an **"add to note"** affordance from an extract/card (links it), and a
      **schedule-return** control (tomorrow / next week / next month / manual — reusing the T028
      schedule UI). The note appears in the **library** (it already lists `synthesis_note`), the
      **inspector** (type/stage/priority/due/links), the **due queue** (when scheduled), and the
      **lineage tree** (referenced material). It must be reachable from the key screens, not an
      isolated UI (per the "Key screens" charter rule). Creating a synthesis note from the command
      palette / a "New synthesis note" action.
- [ ] **Tests:**
  - **Repository/service (`packages/local-db`):** `synthesis-service.test.ts` — create logs
    `create_element` (+ `update_document`); `linkElement` logs `add_relation` with `references`
    and rejects a non-extract/non-card target + a duplicate; `unlinkElement` logs
    `remove_relation`; `editBody` logs `update_document` preserving stable block ids;
    `scheduleReturn` reschedules on the attention scheduler (`reschedule_element`, status
    `scheduled`) and **writes NO `review_states` row** (assert it is absent — the two-scheduler
    split); the note appears in the attention due read when due; soft-delete + undo work.
  - **IPC:** `contract.test.ts` + `db-service.test.ts` wiring for the `synthesis` group; a
    `queue-query` test that a scheduled synthesis note shows up in `queue.list`.
  - **E2E (`tests/electron/synthesis-notes.spec.ts`):** create a synthesis note → link two
    extracts and a card → write some body → schedule it to return next week → it appears in the
    due queue / library / inspector / lineage with its linked material → everything survives an
    **app restart**.
  - `pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm e2e` green.

### Done when

- A `synthesis_note` element can be **created, titled, prioritized, and edited** (its own
  ProseMirror body, stable block ids preserved).
- It **collects linked extracts/cards** via explicit `references` relations (add/remove), shown
  in a linked-material panel + the lineage tree, each jump-to-able; the linked extracts/cards
  keep their own source lineage (they are referenced, not re-parented).
- It is **scheduled to return** on the **attention scheduler** (tomorrow/next-week/next-month/
  manual) and appears in the **due queue** when due — and it **never** gets a `review_states` row
  or enters FSRS (the two-scheduler split).
- It is first-class in the **library, inspector, and lineage** surfaces (not an isolated UI).
- Creating/linking/editing/scheduling are transactional and append the existing
  `create_element`/`update_document`/`add_relation`/`remove_relation`/`reschedule_element` ops —
  **no new op type, no new element type** (`synthesis_note` already exists).
- The feature survives **app restart**; soft-delete + undo work; lineage preserved.
- `pnpm typecheck` / `pnpm test` / `pnpm lint` / relevant `pnpm e2e` pass; a migration is included
  only if a side-table was chosen.

### Notes / risks

- **No new element type or op type.** `synthesis_note` is already in `ELEMENT_TYPES` and the
  `LibraryQuery` already surfaces it — T095 makes it _creatable + schedulable + linkable_, reusing
  the element/document/relation/attention substrate. A reviewer should see no parallel model.
- **`references`, not `derived_from`.** The collected extracts/cards are referenced material, not
  lineage descendants of the note — using `references` keeps each extract/card's own
  `card → extract → source` chain intact. Be deliberate so the inspector/lineage do not mis-render
  the note as the parent of its source material.
- **AI synthesis is later/optional.** A future "summarize my linked extracts into a draft" action
  can run through the T093 `AiService` seam (an `ai` job over the note's referenced material) — but
  T095 ships the manual incremental-writing loop; do not couple it to AI being enabled.
- **Embeddings/search.** A synthesis note's body can later join the FTS5 + `sqlite-vec` index
  (T042/T087) so it is findable — out of scope here, but the element+document substrate means it
  is a non-breaking later addition.
```

