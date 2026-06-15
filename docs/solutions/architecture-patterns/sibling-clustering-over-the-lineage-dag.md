---
title: "Sibling clustering over the lineage DAG: the nearest-live-source-ancestor read model"
date: "2026-06-15"
category: "docs/solutions/architecture-patterns"
module: "local-db/lapse-cluster-detection"
problem_type: "architecture_pattern"
component: "service_object"
severity: "medium"
related_components:
  - "database"
  - "scheduler"
  - "testing_framework"
applies_when:
  - "Building a read-only view that correlates leaf records by a shared ANCESTOR in a parent-pointer lineage tree/DAG, where neither the denormalized root nor the direct parent is the right grain."
  - "The same signal is shown on more than one surface and the surfaces must never contradict each other."
  - "Doing a single-row lookup (.get() / LIMIT 1) on a NON-unique key, or joining through an intentionally non-unique foreign key."
  - "A read produces a window-scoped count that lives next to a cumulative one."
  - "Adding tunable thresholds without risking a schema migration (store them in settings)."
tags:
  - "read-model"
  - "lineage-dag"
  - "fsrs"
  - "clustering"
  - "non-unique-join"
  - "determinism"
  - "settings-tunable"
---

# Sibling clustering over the lineage DAG: the nearest-live-source-ancestor read model

## Context

Interleave's leech screen answers a per-card question — "is *this* card failing?" But several
live cards descended from one source region all lapsing inside a recent window is **one
comprehension problem, not N independent formulation bugs**. T128 (`LapseClusterQuery`) is the
read model that surfaces that correlation: it groups live, lapsing cards by the source region
they ultimately came from, applies conservative floors, and returns an ordered, capped list of
struggling regions (surfaced in the maintenance hub, on the source page, and as a leech-screen
cross-link).

The hard part is not the aggregation. It is choosing the **grain** the cards cluster on,
keeping that grain's "lapse" definition byte-for-byte identical to the sibling surfaces it sits
next to (the leech screen and T114's descendant-health rescheduling), and making the grouping
**deterministic** over a lineage DAG whose anchor key is non-unique. This is the "sibling
clustering over the lineage DAG" read model — a strictly read-only view that walks
`elements.parentId` to find a shared ancestor, then aggregates siblings under it.

Relevant files:
- `packages/local-db/src/lapse-cluster-query.ts` — the read model.
- `packages/local-db/src/lapse-window.ts` — the shared lapse predicate.
- `packages/local-db/src/descendant-health-query.ts` — the sibling (T114) surface that now imports the same predicate.
- `packages/local-db/src/lapse-cluster-score.ts` — the pure ordering score.
- `packages/db/src/schema/sources.ts` — `source_locations`, where the determinism trap lives.

## Guidance

### 1. Cluster on the nearest *live source-region ancestor* — not the denormalized root, not the direct parent

The cluster key is the extract pulled directly from the source — the first ancestor whose
`source_locations` anchor points into a live `source` element. Resolve it by walking
`elements.parentId` upward through any intermediary extracts and atomic statements until you hit
that source-anchored extract. Two tempting shortcuts fail in opposite directions:

- **The denormalized `elements.sourceId` root over-clusters** — it collapses a whole book into
  one bucket; every card from every chapter lands in the same cluster (useless as a
  "which region is struggling" signal, and it just duplicates the source-level T114 signal).
- **The direct parent under-clusters** — a card authored straight off the extract and a card
  authored off an *atomic statement* derived from that extract have different direct parents, so
  they never cluster, even though they are the same comprehension problem. The walk *through* the
  intermediary is what unifies them.

```ts
let current: ElementId | null = startParentId;
for (let i = 0; i < MAX_WALK && current; i += 1) {
  const el = getElement(current);
  if (!el || el.deletedAt) break;            // tombstoned/missing ancestor → no cluster
  const sourceAnchor = getSourceAnchor(el.id);
  if (sourceAnchor) {                          // nearest source-region extract = cluster key
    resolved = { ancestorId: el.id, source: sourceAnchor.source, anchor: sourceAnchor.anchor };
    break;
  }
  current = el.parentId;                        // skip atomic-statement intermediaries; keep climbing
}
```

A card with no live source-region ancestor (tombstoned ancestor, sourceless/lineage-wiped, or
anchored straight to a source with no extract between) simply does not cluster — correct, since
there is no shared region to name. Bound the walk (`MAX_WALK = 64`) as a cycle/depth guard.

### 2. One shared lapse predicate, imported by every sibling surface

The definition of "a lapse happened" — `nextLapses > prevLapses`, `editMarkerAt IS NULL` (T125
marker exclusion), inclusive `[since, asOf]` window, live (`active`/`scheduled`) non-retired
cards — must live in exactly one place. T128 extracted it from T114 into `lapse-window.ts` as
`liveCardLapseWhere`; both the upward-propagation query (descendant-health) and the
sibling-clustering query import it. Each caller adds only its own *scope* and *thresholds*; the
lapse *definition* is never re-derived. That makes it structurally impossible for the cluster
list to claim a card lapsed while the leech screen disagrees. Keep the `editMarkerAt IS NULL`
filter explicit and grep-able even though the increment predicate already drops marker rows by
construction — redundant-but-visible beats clever-but-invisible for a definition this
load-bearing.

### 3. Treat window-boundedness as first-class, and label it

A windowed read is a different question than a cumulative one. A card can be a cumulative leech
yet contribute **zero** to an in-window cluster (its lapses predate `since`); a region can show
in the 30-day cluster list without any cumulative-leech cards. These counts *should not* be
equal — code and UI must never imply they are. Encode it in the names: `windowLapseCount`,
`totalWindowLapses`, with the cross-link showing membership only (no count) so it can never read
as contradicting the leech screen's cumulative badge.

### 4. Read-only discipline, pinned by an all-tables row-count snapshot

A read model must not mutate, append to `operation_log`, or touch FSRS / attention state. The
non-obvious lesson is *how to prove it*: an op-log-only assertion is insufficient, because a
lazy cache materialization (a "read" that quietly writes a derived row) slips past it. Pin the
invariant with a snapshot of **all per-table row counts** before and after the call. Use pure
read paths only — no lazy materialization.

### 5. The determinism trap — a non-unique anchor key plus an unordered `.get()`

This is the headline. `source_locations.elementId` is **non-unique** (it carries a plain
`index`, not a unique constraint). One element can own several `source_locations` rows, and not
all point into the source — some point into a parent extract. So the obvious lookup is wrong
twice: an unordered `.get()` over multiple matching rows returns an **arbitrary** one (the
cluster key/region flickers between runs on identical data), and if that row is a parent-extract
anchor, resolution **over-climbs** past the real ancestor.

```ts
// BEFORE — non-deterministic AND prone to over-climbing.
const row = db
  .select({ sourceElementId: sourceLocations.sourceElementId /* … */ })
  .from(sourceLocations)
  .where(eq(sourceLocations.elementId, elementId))
  .get();                       // arbitrary row among many; may be a parent-extract anchor

// AFTER — deterministic, and only ever resolves a TRUE live source-region anchor.
const row = db
  .select({ sourceElementId: sourceLocations.sourceElementId, sourceTitle: elements.title /* … */ })
  .from(sourceLocations)
  .innerJoin(elements, eq(elements.id, sourceLocations.sourceElementId))
  .where(
    and(
      eq(sourceLocations.elementId, elementId),
      eq(elements.type, "source"),   // ignore anchors pointing into a parent extract
      isNull(elements.deletedAt),     // and into tombstoned sources
    ),
  )
  .orderBy(sourceLocations.id)        // stable column → same rows always pick the same anchor
  .get();
```

General rule: **any `.get()` / `LIMIT 1` over a non-unique key is a latent non-determinism
bug.** Either enforce uniqueness, or add an `ORDER BY` over a stable column — and usually also a
join/filter that narrows the rows to the *kind* you actually meant.

## Why This Matters

- **Cross-surface consistency is structural, not aspirational.** One imported predicate means the
  leech screen, descendant-health rescheduling, and the cluster list cannot drift apart — there
  is no second copy.
- **The grain *is* the feature.** Over-clustering (book-level) and under-clustering
  (per-direct-parent) both destroy the signal *silently* — the query still returns something,
  just nothing useful.
- **Determinism is correctness, not polish.** A non-unique key with an unordered `.get()` flickers
  between runs on unchanged data — the worst kind of bug, because it passes a casual test and
  fails intermittently in the field. The join-plus-`ORDER BY` fix is cheap and total.
- **The right invariant test catches the right class of bug.** An op-log-only assertion gives
  false confidence; the all-tables row-count snapshot is what actually proves a read is a read.
- **No migration, no new failure class.** Storing thresholds in settings keeps the feature a pure
  read model and sidesteps the self-referential-FK table-rebuild lineage-wipe class entirely
  (see the migration-0030 incident).

## When to Apply

- A **read-only aggregation** that correlates leaf records by a **shared ancestor** in a tree/DAG
  (lineage, org charts, threaded comments, category hierarchies, dependency graphs).
- The same signal is shown on **more than one surface** that must agree — extract the predicate
  once, import it everywhere.
- The grouping key is reached by **walking a parent pointer** past **intermediary node types** you
  must skip to avoid fragmenting the group.
- A single-row lookup on a **non-unique key** — add a stable `ORDER BY` (and a row-kind filter).
- A **window-scoped count** lives next to a cumulative one — name and document the window.

Do **not** reach for it when the grouping key is genuinely unique (no walk, no ordering trap), or
when the view legitimately mutates (then it is a command, not a read model — give it a
transaction and an `operation_log` entry).

## Examples

Inclusion is gated by conservative floors; the strength score *only orders* (breadth weighted
above depth, so 5 cards × 1 lapse outranks 1 card × 5 lapses), with a fully deterministic
tiebreak so ties never reorder between runs:

```ts
if (affectedCardCount < minCards || bucket.total < minLapses) continue;   // floors GATE
strength: scoreLapseCluster({ totalWindowLapses: bucket.total, affectedCardCount }), // score ORDERS
clusters.sort((a, b) =>
  b.strength - a.strength ||
  (a.mostRecentLapseAt < b.mostRecentLapseAt ? 1 : a.mostRecentLapseAt > b.mostRecentLapseAt ? -1 : 0) ||
  (a.ancestorId < b.ancestorId ? -1 : a.ancestorId > b.ancestorId ? 1 : 0),
);
return clusters.slice(0, limit);                                          // cap last
```

The sibling surface that proves the shared predicate pays off — `descendant-health-query.ts`
(T114) imports the exact same `liveCardLapseWhere`, adding only its per-source scope and its own
thresholds, so its lapse counting is identical to T128's by construction:

```ts
.where(liveCardLapseWhere(since, input.asOf, eq(elements.sourceId, input.sourceId)))
```

## Related

- [`review-triggered-descendant-health-source-rescheduling.md`](./review-triggered-descendant-health-source-rescheduling.md) —
  **T114, the direct sibling.** Same lapse evidence + now-shared predicate, opposite axis: T114
  reschedules a parent source *upward* (a write inside the review txn); T128 is a *sideways*,
  read-only grouping of lapsing cards. Together with T123 (downward staleness) they form the
  lineage-DAG direction triad: pain up, staleness down, lapse evidence sideways.
- [`downward-dirty-bit-propagation-through-lineage-dag.md`](./downward-dirty-bit-propagation-through-lineage-dag.md) —
  the lineage-DAG direction-axis template and the live-scoped (`isNull(deletedAt)`) walk discipline.
- [`card-edit-write-barrier-restabilization.md`](./card-edit-write-barrier-restabilization.md) —
  T125 marker rows; the shared predicate carries the explicit `editMarkerAt IS NULL` exclusion.
- [`priority-integrity-read-model.md`](./priority-integrity-read-model.md) — read-only-receipt
  discipline (no new mutable analytics state) this read model mirrors.
- [`../database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md`](../database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md) —
  the migration-0030 lineage-wipe class T128 sidesteps by storing thresholds in settings (no migration).
- [`../logic-errors/rich-extractions-preserve-paragraphs-and-images.md`](../logic-errors/rich-extractions-preserve-paragraphs-and-images.md) —
  `source_locations` anchor semantics (an element can carry multiple anchor rows — the non-unique-key hazard).
