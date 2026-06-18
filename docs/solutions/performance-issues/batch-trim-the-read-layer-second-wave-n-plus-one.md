---
title: "Batch+trim the read layer: the second-wave N+1 sweep and its cross-cutting traps"
date: "2026-06-18"
category: "performance-issues"
module: "packages/local-db query layer + apps/desktop db-service read paths"
problem_type: "performance_issue"
component: "main_process_sqlite"
tags:
  - "n-plus-one"
  - "drizzle"
  - "better-sqlite3"
  - "main-process"
  - "batched-read"
  - "inArray"
  - "sqlite-variable-limit"
  - "batch-trim"
  - "drift-test"
  - "read-model"
---

# Batch+trim the read layer: the second-wave N+1 sweep and its cross-cutting traps

## Context

Commit `93e8dbc8` fixed one instance of a per-row over-enrichment N+1 (the
`/search` keystroke freeze) with the **batch+trim** pattern — see
[[search-typing-stutter-is-renderer-rerender-not-async-work]]. A follow-up audit
(parallel hunter agents + independent verifiers) then found **11 more HIGH
instances of the same anti-pattern class** scattered across the read layer:
`libraryBrowse`, `conceptMembers`, the residual in `search`/`enrichFusedHit`,
`source-yield` (`listSourceYield` + `getSourceYield`), the queue tag filter,
topic-knowledge retention resolution, chronic-postpone / scheduler-consistency
op-log counts, and one renderer twin (`ProcessedSpanButtons` remeasuring on every
editor transaction).

This doc captures what the *sweep* taught beyond the single fix: the repeatable
mechanics, and — more valuable — the **cross-cutting traps that only surface when
you convert per-row reads to batched reads at scale**. Several of these were
invisible to per-unit work and were caught only by a cross-cutting review pass.

## Guidance

### The batch+trim recipe (per consumer)

A list / feed / search / count surface must never enrich rows with a
selection-detail payload built for ONE element. For each per-row hot path:

1. **Resolve element rows once**: `elements.findManyLive(ids)` instead of
   `findById` in a loop.
2. **Trim the enrichment**: replace the full `inspectorQuery.get(id)` (lineage +
   provenance + tags + the source-yield/`listBlockViews` rollup) with the thin
   `InspectorQuery.buildSchedulerSignals(element, asOf, { includeYield: false })`
   slice. The yield chip is selection-detail, surfaced by the inspector's
   single-element `get()` — not list data.
3. **Batch every remaining per-row lookup** into one `inArray` map built before
   the loop: tags (`listTagsForMany`), source refs (`resolveSourceRefMany`),
   concept names (`firstConceptNameMapForMembers`), queue summary
   (`summaryForMany`), op-log postpone counts (`postponeCountsForMany`), review
   states (`findReviewStatesForMany`), schedule projections
   (`currentScheduleProjectionsForMany`).
4. **Count paths resolve only the projection they count over** (`{id, type,
   priority}`) via one batched read — never the display enrichment, and never
   re-run per facet/type.

### The keystone: a batched read-model producer that does NOT inherit the due-only shortcut

Four db-service consumers shared one per-row call: `queueQuery.summaryFor`. The
fix was one batched `QueueQuery.summaryForMany(ids, asOf)` reused by all of them.

**The trap (caught in review before it shipped):** the existing `list()`
`BatchContext` hardcodes `queueEligible: true` / `retirementSuggestion: null` /
`fallow: null` because `list()` only ever sees *due, eligible* elements. The
inventory surfaces (library, concept members) pass **non-due, parked, retired,
and fallow** elements. Reusing the due-only shortcut would have silently emitted
`queueEligible: true` for a retired card. The batched producer must compute
eligibility per element via the same `queueEligibilityFor(...)` the single-row
path uses, fed by batched inputs — threaded through an explicit `inventory`
extension of `BatchContext` so the two code paths share one producer and cannot
drift.

### The cross-cutting traps (the real compounding value)

These are the failure modes that the per-row→batched conversion *introduces* and
that per-unit work cannot see:

1. **Unchunked `inArray` over an unbounded set is a NEW crash.** A per-row loop of
   N single-row reads never hits a SQL limit. The batched `inArray(col, ids)`
   replacement does: better-sqlite3 throws "too many SQL variables" past
   `SQLITE_MAX_VARIABLE_NUMBER` (999 on old builds, 32766 on newer). Concept
   members, the full due set, and the whole-library source set are all unbounded.
   **Chunk inside the primitive** so every caller is safe — reuse the shared
   `SQLITE_SAFE_IN_ARRAY_SIZE` (900) helper in `packages/local-db/src/chunk-in-array.ts`.
   This is a zero-drift violation if missed: the batched path *errors* where the
   per-row path returned a value.

2. **"Batched" is a lie until it's batched all the way down.** `visibleForSourceMany`
   batched its dismissal lookup but still called a per-source block-processing
   rollup (`getSourceProcessingSummary`) inside the loop — re-introducing the
   O(N) cost the sweep was removing. Grep the body of every `*ForMany` method for
   a per-element repo call.

3. **A residual per-row read can hide inside a per-row *helper*.** `enrichElementRows`
   looked batched but called `buildSchedulerSignals(el, …)` per row, which does a
   per-element `currentScheduleProjection` / `findReviewState`. The fix: a
   `buildSchedulerSignalsForMany` that builds the batched maps once and shares a
   private per-element core with the single-row method (drift impossible by
   construction, not just by test).

4. **Count/aggregate scans must evaluate ALL candidates, not just rows that have a
   child row.** Scoping the batched op-log scan to "elements that have a postpone
   op" silently drops candidates the per-element full scan evaluated. Fetch the
   full candidate set, then default absent ids to 0.

5. **Same-millisecond ordering parity.** The per-element fold consumed
   `listForElement(id).reverse()` (oldest-first); the batched scan must
   `ORDER BY created_at ASC, rowid ASC` (the `rowid` tiebreak is required) or
   same-ms markers fold in a different order and produce a wrong count.

6. **Stale-source safety + empty-`IN()`.** A batched block-processing read must not
   route through a guard that `throw`s on a soft-deleted id (one stale id crashes
   the whole rollup); build the map from the underlying reads filtered to the live
   set. Guard every `inArray` against an empty id list (drizzle emits `IN ()` →
   SQLite syntax error). See [[block-processing-stale-source-ids-zero-summary]].

### Drift tests are the load-bearing guarantee

Every batched producer ships a **"batched output `deepEquals` per-row output"**
test, with fixtures that exercise the *risky* cases, not the happy path:
non-due / retired / parked / fallow elements, a source with a visible retirement
suggestion, same-ms op-log rows, an element with NO op-log rows, dual-signal yield
(a productive extract via a synthesis `references` edge with no `extract_fate`),
and an id list larger than one chunk. Make each test non-vacuous (inject a wrong
value, confirm it fails, revert). Exclude only genuinely time-continuous fields
(`retrievability`) from the deepEqual, and confirm they're guarded elsewhere.

## Why This Matters

- The first fix removed ~7s/keystroke from one path; the same anti-pattern was
  silently costing O(N) synchronous main-process SQLite work on every library
  load, concept drill-in, queue render with a tag filter, analytics dashboard,
  and maintenance-hub open. Batching is multiplicative because drizzle rebuilds
  the query AST per `.get()`/`.all()`.
- The conversion is **not** behavior-preserving by default: it introduces a new
  crash class (unbounded `inArray`) and is easy to leave half-done (partial
  batching, residual per-row helper). The drift-test discipline + the
  chunk-at-the-primitive rule are what make it safe.
- **Process learning:** per-unit implementation agents each had isolated context
  and could not see the unchunked-`inArray` crash or the partial-batching N+1 —
  those span the boundary between a new primitive and its callers. The
  cross-cutting code-review pass is what caught both. Sweep-style refactors need a
  whole-diff review, not just per-unit tests.

## When to Apply

- Any list / feed / search / count / facet surface that enriches rows with reads
  meant for a single selected element.
- Any new `*ForMany` / batched repository method: chunk the `inArray`, batch all
  the way down, and add a `deepEquals`-vs-single-row drift test with risky-case
  fixtures.
- Any per-row → batched conversion: assume it introduces the SQLite-variable-limit
  crash until you've chunked it, and assume a "constant batched reads" claim is
  false until you've grepped the loop for a hidden per-row call.

## Examples

```text
BEFORE  for (row of hits) { findById; inspectorQuery.get; summaryFor; refMeta; concept }   // N × ~15 reads, AST rebuilt each
AFTER   els  = findManyLive(ids)            // 1 (chunked)
        tags = listTagsForMany(ids)         // 1 (chunked)
        refs = resolveSourceRefMany(ids)    // 1 (chunked)
        names= firstConceptNameMapForMembers(ids)
        sums = summaryForMany(ids)          // batched eligibility, NOT the due-only shortcut
        for (row of hits) { build from maps + buildSchedulerSignals(el,{includeYield:false}) }
```

Chunk at the primitive (the rule that prevents the new crash):

```text
// packages/local-db/src/chunk-in-array.ts
export const SQLITE_SAFE_IN_ARRAY_SIZE = 900;
// findManyLive / listTagsForMany / postponeCountsForMany / the source-yield
// batched reads all slice ids into <=900-id chunks and merge — output-identical
// to one read, but safe on an unbounded vault.
```

## Related

- [[search-typing-stutter-is-renderer-rerender-not-async-work]] — the original
  batch+trim fix (`93e8dbc8`) and `buildSchedulerSignals`; this doc is the sweep
  that followed it.
- [[queue-eligibility-inventory-scheduler-state]] — the `queueEligible` /
  `notInQueueReason` contract every inventory row must carry (the R4 the keystone
  `summaryForMany` preserves).
- [[extract-fates-value-model-v2-source-yield-stagnation]] — the dual-signal
  productive-extract semantics the batched `listSourceYield` must not regress.
- [[block-processing-stale-source-ids-zero-summary]] — stale-tolerant read vs
  strict mutation guard, relied on by the batched block-processing read.
