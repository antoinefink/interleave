---
title: Self-healing derived-index supervisor for a silently-degradable producer
date: 2026-06-13
last_updated: 2026-06-14
category: architecture-patterns
module: semantic-search
problem_type: architecture_pattern
component: background_job
severity: high
applies_when:
  - "Auto-(re)building a derived index (embeddings/search vectors/thumbnails) on launch and on a schedule"
  - "The index producer can silently fall back to a DEGRADED result instead of failing loudly"
  - "A deterministic input can fail every attempt (oversized item, malformed data, dimension mismatch)"
  - "The index is rebuildable derived state (no operation_log), maintained by a main-process service"
  - "The maintainer can be paused by a power/cost policy, or its producer depends on a vendored build artifact"
related_components: [database, service_object]
tags:
  - semantic-search
  - embedding
  - derived-index
  - background-maintenance
  - fallback-guard
  - idempotency
  - electron
  - build-vendoring
---

# Self-healing derived-index supervisor for a silently-degradable producer

## Context

Interleave's semantic index (the `sqlite-vec` embedding store) was fully built in tests
but inert in the real app: nothing started indexing after install, so a pre-existing
corpus sat at "0 of N embedded" forever, and search silently degraded to keyword-only
with no signal. The fix was a main-process supervisor
(`apps/desktop/src/main/embedding-maintenance-service.ts`) that auto-indexes on launch
and scrubs on a poll.

Building that supervisor surfaced a class of hazards that recur for **any** auto-maintained
derived index whose producer can silently degrade — embeddings here, but the same shape
applies to thumbnails, OCR text, search vectors, or any rebuildable projection computed by a
background worker. The non-obvious lessons live in how the supervisor stays *safe*, not in
the indexing itself. This complements the model/dimension/fallback-id *contract* documented
in `docs/solutions/architecture-patterns/local-only-semantic-search-sqlite-vec-model-isolation.md`;
this doc is the *lifecycle* layer on top of that contract.

## Guidance

**1. A launch-time readiness gate is necessary but NOT sufficient — also reject the degraded
result at the persistence boundary.** The producer (a DB-free worker) decides real-vs-fallback
*per job* at execution time. A probe that says "real model ready" at launch does not stop a
later mid-session degradation (model evicted, OOM, ABI hiccup) from feeding a fallback result
into a job that was already queued. So gate the auto-build on a `ready` probe AND make the
apply handler refuse to persist a fallback-tagged result:

```ts
// apps/desktop/src/main/embedding-service.ts — applyResult INDEX path
// The launch gate avoids needless fallback work; THIS guard makes poisoning impossible
// regardless of which path enqueued the job.
if (result.modelId === FALLBACK_EMBEDDING_MODEL_ID) {
  return { elementId: payload.elementId, modelId: result.modelId }; // skip upsert; retry later
}
```

**2. Exclude in-flight AND failed work from the auto-(re)build — one query closes two bugs.**
The idempotency gate (`needsEmbedding`, comparing content hash + model id) only consults
*persisted* rows, never *pending jobs*. Without an extra guard:
- a manual "Rebuild" racing the supervisor's batch **double-queues** every still-draining element;
- a deterministically-failing element (oversized text) has no persisted row, so the supervisor
  **re-enqueues it every catch-up pass forever**.

Excluding elements that already have a `queued`/`running`/`failed` embed job fixes both. Cap the
exclusion set so the downstream `NOT IN (...)` stays under SQLite's bound-parameter limit
(capping is safe because re-enqueue is idempotent):

```ts
// packages/local-db/src/jobs-repository.ts
activeOrFailedEmbedElementIds(): string[] {
  const rows = this.db.all<{ element_id: string | null }>(sql`
    SELECT DISTINCT json_extract(payload, '$.elementId') AS element_id FROM jobs
    WHERE type = 'embed'
      AND status IN ('queued', 'running', 'failed')
      AND json_extract(payload, '$.elementId') IS NOT NULL
    LIMIT ${EXCLUDE_IDS_CAP}`); // 500 — well under the bound-param cap
  // ...
}
```

The explicit user "Retry failed" action clears the failed rows (a failed row has spent its
attempt budget, so re-queueing it re-fails immediately) and enqueues fresh jobs with a full
budget — so a permanent failure stays visible and retryable, never silently looping.

**3. The auto-(re)build must be progress-guaranteed, not a blind `LIMIT`.** Selecting "the first
N elements" and relying on the idempotency skip stalls on a corpus larger than N: a page that is
all-already-embedded enqueues nothing. Select rows that *need* embedding (no row, or a different
model id), ordered, limited — so repeated passes converge.

**4. Tick safety: single-flight + re-check guards after every `await`.** The supervisor's tick is
failure-isolated (a throw is logged, the timer survives), single-flighted (`passInFlight`), and —
crucially — re-checks its guards *after* the async probe resolves, because state can change during
the await:

```ts
const modelState = await this.deps.probeModelState();
if (modelState !== "ready") return;
if (reason !== "manual" && !this.running) return;     // stop() during the await
if (this.deps.isReplacingLocalData()) return;          // restore/reset began during the await
```

**5. Register the supervisor in the backup restore/reset drain path and stop it before DB close.**
A long-lived main-process writer must drain before the store is swapped or closed — see
`docs/solutions/architecture-patterns/electron-sqlite-backup-restore-reset-coordination.md`.
Thread the instance into `IpcHandlerContext`, `stop()` it before `runner.stopAndDrain()` in
`beforeReplaceLocalData`, and `stop()` it before `jobRunner.stop()`/`dbService.close()` in
will-quit. The tick is fire-and-forget (`void this.tick(...)`), so teardown is never blocked; the
post-`await` `!this.running` re-check (point 4) prevents an in-flight tick from writing after stop.

**6. Probe with its own generous timeout, not the search-query timeout.** The honest model probe
runs a real embed to learn real-vs-fallback. A cold model load takes seconds, so reusing the
800 ms search-query timeout would misreport a healthy model as `fallback`. Give the probe its own
ceiling (60 s) and a transient `loading` state while it resolves; cache only terminal results.

**7. A power/cost gate must defer the expensive WORK, not the cheap honest SIGNAL.** The supervisor
originally returned at an `isOnBattery()` check placed *before* the model probe and the reindex, to
spare the battery — but that also skipped the probe, so on battery the status never resolved: the
panel showed a permanent "Loading model…" and a frozen "0 of N" with no hint indexing was
*deliberately* paused. Order the gate so only the heavy bulk reindex defers; the cheap probe + prune
always run, keeping the reported model state honest:

```ts
// apps/desktop/src/main/embedding-maintenance-service.ts — tick()
const modelState = await this.deps.probeModelState();   // cheap: one transient embed, then cached
if (modelState !== "ready") return;
const { embedded, total } = this.deps.stats();
if (embedded >= total) return;
if (this.deps.isOnBattery()) return;   // defer ONLY the expensive reindex below — never the probe above
```

Then *surface the pause* rather than letting it read as a stall: derive `autoIndexPaused: "battery"`
from the live `powerMonitor` (only when work remains and nothing is draining) and render "Indexing
paused" + "plug in to finish indexing, or rebuild now". The ungated manual Rebuild stays the escape
hatch. General rule: power/idle/cost gates defer the work, never the signal that reports the truth.

**8. The producer's vendored model must survive an incremental rebuild, or it silently degrades.**
The worker is local-only — it never fetches the model at runtime, so the real EmbeddingGemma ONNX
weights are vendored at build time into `dist/resources/transformers/models/`. `stageTransformers()`
wiped that entire tree on *every* build and only re-downloaded behind a flag, so a plain flagless
`pnpm dev` deleted the vendored model and dropped the worker to the deterministic hash fallback — the
exact "silently degraded to keyword-only" failure this doc is about, reintroduced from the build side.
Make staging preserve the expensive artifact and be idempotent:

```js
// apps/desktop/build.mjs
rmSync(path.join(stageDir, "node_modules"), { recursive: true, force: true }); // NOT the whole stageDir
// stageEmbeddingModel: skip when a valid model (ready marker + q8 weights + matching id) is already
// staged — vendor once, every later build keeps it; a model-id bump still re-vendors.
if (isEmbeddingModelStaged(modelDir)) return;
```

## Why This Matters

The headline failure ("0 of N embedded, forever, silently") is a *missing trigger*, but the
dangerous failures are the silent-correctness ones the supervisor could introduce: poisoning the
index with meaningless fallback vectors that read as "100% indexed", or burning the worker forever
re-trying a deterministically-failing element. Both are invisible to a count-based status. The
two-layer guard (gate + persistence-boundary rejection) and the active/failed exclusion make those
states *structurally* impossible rather than relying on the happy path. For a knowledge tool,
silently-meaningless "related by meaning" results are the worst failure mode — they destroy trust
in the core feature.

An honest status surface is also *debugging infrastructure*, not only UX. Making the probe run on
battery (point 7) is precisely what exposed the silent build regression (point 8): the panel had been
showing a fake "Loading model…" that masked a real "fallback", and the moment the signal stopped lying
the root cause was obvious. A status that can only ever report the comforting state hides the bugs
underneath it.

## When to Apply

- A derived index/projection is auto-(re)built in the background, not only on explicit user action.
- The producer can return a degraded/fallback result instead of throwing (so a status count alone
  cannot tell "done" from "done but worthless").
- Some inputs can fail every attempt, so naive auto-retry would loop.
- The maintainer is a main-process service holding a DB reference (must join the restore/reset drain).
- A power/cost policy can pause the maintainer, or the producer depends on a vendored build artifact an
  incremental rebuild could wipe.

## Examples

Index-health rollup that drives honest UI — distinguishing *actively building* from *stale and
idle* so a user watching the index self-heal is not told search is broken:

```ts
// apps/desktop/src/main/semantic-status.ts (pure, unit-testable)
if (!vecAvailable || modelState === "fallback") indexHealth = "degraded";
else if (total === 0) indexHealth = "healthy";          // empty vault is healthy, not "stale"
else if (building) indexHealth = "building";
else if (coverageRatio < SEMANTIC_COVERAGE_THRESHOLD) indexHealth = "stale";
else indexHealth = "healthy";
```

A deliberate pause must read differently from a stall — derive the reason from the live power source
so the panel can say so instead of showing a frozen "building":

```ts
// apps/desktop/src/main/db-service.ts — semanticStatus()
autoIndexPaused:
  isOnBattery() && embedded < total && queued + running === 0 ? "battery" : null,
```

ETA from observed throughput (resets per launch; null until enough samples — never false
precision): record a completion timestamp on each successful index upsert, then
`remaining / observed-rate`. The observed rate already reflects worker concurrency, so no
concurrency division is needed.

## Related

- `docs/solutions/architecture-patterns/local-only-semantic-search-sqlite-vec-model-isolation.md` — the model/dimension/fallback-id contract this lifecycle sits on (consolidation candidate: the two together describe the full embedding subsystem).
- `docs/solutions/architecture-patterns/electron-main-rolling-backups-over-renderer-reminders.md` — the "background maintenance lives in Electron main" lifecycle pattern this mirrors.
- `docs/solutions/architecture-patterns/electron-sqlite-backup-restore-reset-coordination.md` — the drain-before-swap contract the supervisor registers into.
- `docs/solutions/database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md` — why this work added NO `elements`-table migration (all new status fields are computed or read from the `jobs` table).
