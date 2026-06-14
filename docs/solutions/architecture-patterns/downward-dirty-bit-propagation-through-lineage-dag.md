---
title: "Propagate content-staleness down the lineage DAG when a source block is edited"
date: "2026-06-14"
category: "architecture-patterns"
module: "lineage-integrity/stale-propagation"
problem_type: "architecture_pattern"
component: "database"
severity: "medium"
related_components:
  - "service_object"
  - "testing_framework"
  - "documentation"
applies_when:
  - "A parent-node mutation should mark derived/downstream nodes as needing attention without eagerly rewriting them or blocking the edit."
  - "A denormalized boolean flag must stay consistent with a provenance side-table across a soft-delete-aware lineage DAG."
  - "Clearing a flag must reach soft-deleted targets that FK cascade will never touch."
  - "A non-invertible source mutation must not be desynced from its derived flag by global undo."
  - "drizzle-kit proposes a full table rebuild for an additive column/CHECK change on a self-referential FK table."
tags:
  - "stale-propagation"
  - "lineage-dag"
  - "dirty-bit"
  - "self-healing-projection"
  - "operation-log"
  - "soft-delete"
  - "drizzle-migration"
  - "content-staleness"
---

## Context

T123 added the **downward** counterpart to the upward review-to-attention back edge in
[`review-triggered-descendant-health-source-rescheduling.md`](./review-triggered-descendant-health-source-rescheduling.md).
That earlier pattern lets a struggling *child* card pull a *parent* source back sooner
(child → parent, upward). This one is the opposite direction: when a *source* block is
edited, every *derived* element beneath it (extract → clean extract → atomic statement →
card) gains a queryable "this might no longer match its source" flag (parent → children,
downward). Together they close the loop — edits flow down, review pain flows up.

Concretely: a user edits a paragraph in a source they already extracted from. The extract
anchored to that block, and every statement and card beneath it, may now misquote the
source. Source lineage is sacred in Interleave, so silently letting derived artifacts drift
is unacceptable — but so is blocking the edit or eagerly rewriting children. The pattern is
to record a durable, queryable *content-staleness* signal that propagates the dirty bit
downstream in the **same transaction** as the edit, **self-heals** when the edit is
reverted, and survives restart.

The reusable problem this solves: **how to maintain a denormalized "derived data is stale"
flag across a soft-delete-aware DAG, transactionally coupled to the mutation that dirties
it, without the flag desyncing under undo, idempotent re-runs, or soft-deleted targets.**

Files: `packages/local-db/src/reverify-propagation-repository.ts`,
`block-processing-repository.ts`, `block-processing-service.ts`, `undo-service.ts`; schema
in `packages/db/src/schema/elements.ts` + `documents.ts`; migration
`packages/db/drizzle/0037_nosy_lady_vermin.sql`.

## Guidance

Five techniques compose into the pattern. Each is verified against the shipped code.

### 1. The denormalized flag is a recomputed projection of a provenance table, never a flipped bit

Don't toggle a boolean on "I think I just dirtied this." Maintain a fact table —
`element_reverify_provenance(element_id, source_element_id, stable_block_id, batch_id)` —
and define the denormalized flag as `needs_reverify = EXISTS(provenance for this element)`.
Recompute it from the table; never set it from a local guess about whether a row was "newly
inserted."

`recomputeFlagWithin` reads the current flag, counts provenance rows, and writes **only when
the value actually changes** (and only then appends an op):

```ts
const hasProvenance = (provenance?.n ?? 0) > 0;
const currentFlag = current.needsReverify === true;
if (hasProvenance === currentFlag) return; // idempotent: no write, no op
// ... needs_reverify = hasProvenance, stale_since = hasProvenance ? (existing ?? now) : null
```

This is what makes the flag *self-healing*: two source blocks can independently stale the
same extract; clearing one block's provenance recomputes to `EXISTS = true` (the other block
still flags it), so the flag stays correct without any reference counting in the boolean
itself. The table is the single source of truth; the column is a cache that can always be
rebuilt — manually corrupt the column and the next propagation touch recomputes it back.

### 2. Clear provenance by block-key across BOTH live and soft-deleted targets — FK cascade only fires on hard delete

The provenance FKs are `ON DELETE cascade`, but **soft delete (the common trash path)
doesn't delete the element row**, so cascade never fires for trashed elements. If you cleared
provenance by walking only live descendants, a since-trashed-then-restored element would
resurrect still-flagged with stale provenance.

The un-stale arm therefore clears by `(source_element_id, stable_block_id)` directly, hitting
every target regardless of soft-delete state:

```ts
// Un-staled block → drop ALL provenance for the restored block, live or trashed.
tx.delete(elementReverifyProvenance)
  .where(and(
    eq(elementReverifyProvenance.sourceElementId, sourceElementId),
    eq(elementReverifyProvenance.stableBlockId, blockId),
  )).run();
```

The forward (staling) walk, by contrast, *is* live-scoped (`liveAnchorsByBlock` filters
`isNull(elements.deletedAt)`, `liveDescendantsWithin` skips soft-deleted rows) — you only flag
what is currently live, but you clear everything keyed to the block. Asymmetric on purpose.
Read-layer counts stay honest by re-filtering live (`countLiveReverifyOutputs` joins
`elements` with `isNull(deletedAt)`). This is how "dead/soft-deleted lineage never retains a
flag" is actually guaranteed — at the read layer and the clear path, **not** by cascade.

### 3. A dedicated `pre_stale_hash` column, captured once on processed → stale, recognizes restoration

To detect "the user edited the block back to what it was," you need the *last-processed* hash
— not the current hash (which `block_content_hash` already tracks for idempotence/hydration).
Conflating the two would corrupt one of the semantics. So add a **separate** `pre_stale_hash`,
captured **once** at the `processed → stale_after_edit` transition and cleared on any exit
from stale:

```ts
// reconcileStaleWithin, processed → stale arm:
preStaleHash: row.blockContentHash, // capture the last-processed hash ONCE

// upsertStateWithin enforces capture-once + clear-on-exit:
const preStaleHash =
  input.state === "stale_after_edit"
    ? input.preStaleHash !== undefined ? input.preStaleHash : (existing?.preStaleHash ?? null)
    : null; // any non-stale state clears it
```

The un-stale arm restores when `nextHash === row.preStaleHash` (and a known prior state is
recoverable via a shared `RESTORABLE_PROCESSED_STATES` constant). `reconcileStaleWithin`
returns a transition report `{ staled: BlockId[]; unStaled: BlockId[] }`; the propagation
consumes both arms in the same transaction. Because the hash is content-addressed,
`A → B → A` and `A → B → C → A` both clear correctly; a block whose *processed* content
advanced across generations is intentionally out of scope (it needs the resolution workflow,
not auto-clear).

### 4. An op-log `propagation: true` marker so global undo skips the flag flips

The flag flips are op-logged (preimage in `prev`, grouped by `batchId`) for audit and a
future resolution-undo. But the **source edit that caused them (`update_document`) is itself
non-invertible** by the global undo. If ⌘Z inverted the `update_element` flag flip while the
blocks stayed stale, the two layers would desync — the flag would say "clean" while the
content still drifted. So the propagation op carries a marker, and `UndoService` refuses it in
*both* the gate and the executor:

```ts
// reverify-propagation-repository.ts, in the op payload:
propagation: true, // global undo must NOT invert this flag flip

// undo-service.ts isInvertible() AND invertWithin():
if (op.payload.propagation === true) return false; // resp. return null
```

The clear path is re-reconciliation (edit the block back), not undo. This is the same family
of guard as the existing `reviewPromote`/`chronicPostponeReset` markers — a real preimage
exists for audit/sync, but inverting it in isolation would be an incoherent partial undo of a
compound action.

### 5. A hand-edited additive migration that dodges the SQLite table-rebuild lineage-wipe — tested for value survival AND row-count invariance

`drizzle-kit generate` wanted to **rebuild** the `elements` table (CREATE `__new_elements` →
copy → DROP → RENAME) to add two columns plus a CHECK. That 12-step rebuild is the exact shape
that fired `ON DELETE SET NULL` on the self-referential lineage FKs and nulled every
`parent_id`/`source_id` in the real vault during the migration-0030 incident (see
[`sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md`](../database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md)).
The migration was hand-edited to be **purely additive** (`ALTER TABLE ... ADD COLUMN` +
`CREATE TABLE`), which SQLite executes without a rebuild and cannot disturb lineage. A header
comment records why, and the end-state schema matches the generated snapshot so future
`db:generate` stays clean.

The migration test seeds a linked source→extract→card graph through the prior migration, runs
to HEAD, and asserts **two distinct survival properties**:

```ts
// Row-COUNT invariance: a rebuild that silently lost rows would still pass the column-value
// checks on surviving rows — so assert the full seeded set survived.
expect(elementCount.n).toBe(3);

// Column-VALUE survival (the 0030 regression guard): lineage columns themselves survive.
expect(lineage.get("ext")).toEqual({ parent_id: "src", source_id: "src" });
expect(lineage.get("card")).toEqual({ parent_id: "ext", source_id: "src" });
```

Both matter independently: value-survival catches the `SET NULL` wipe; count-invariance
catches a rebuild that drops rows entirely (which value-only checks on survivors would miss).

## Why This Matters

- **Correctness under partial failure.** Propagation runs in the *same transaction* as
  reconciliation (`reconcileSourceDocumentWithin` calls `propagateReverify` inline) — a crash
  never leaves blocks stale but descendants clean, or vice versa.
- **Self-healing means no drift.** Because the flag is `EXISTS(provenance)` recomputed, never
  a manually reference-counted bit, multi-block staling, idempotent re-runs, and restoration
  all converge to the correct flag with no special-case bookkeeping. An identical re-run
  inserts nothing (`ON CONFLICT DO NOTHING`), recomputes the same value (no write), appends no
  op.
- **Soft-delete honesty.** Trashed elements neither resurrect flagged nor pollute live counts,
  because clearing is keyed by block (not by cascade) and reads re-scope to live.
- **No undo desync.** The marker keeps ⌘Z from half-clearing a flag whose cause it cannot
  reverse — the nastiest bug class when a denormalized projection is op-logged but its trigger
  is not invertible.
- **Lineage stays sacred through schema evolution.** The additive-migration discipline plus
  the dual-assertion test mean a schema change to the most lineage-critical table can never
  silently repeat the 0030 wipe.

## When to Apply

Reach for this pattern when **all** of these hold:

- A mutation on a parent node should mark derived/downstream nodes as needing attention,
  *without* eagerly rewriting them or blocking the mutation.
- The "needs attention" signal must be **queryable and durable** (drive UI badges, gates,
  counts), so a denormalized flag is justified — but you want it correct, so back it with a
  fact table and recompute.
- The graph is **soft-delete-aware**: targets can be trashed and restored, so FK cascade is
  not a reliable clearing mechanism.
- The dirtying mutation is **not cleanly invertible** by your generic undo, so propagated flag
  changes must be marked non-invertible to avoid desync.
- The schema change touches a table whose rebuild has known destructive side effects
  (self-referential FKs with `SET NULL`/`CASCADE` delete actions) — prefer additive
  migrations and prove both value-survival and row-count invariance.

Do **not** apply the full weight of this pattern when the derived data is cheap to recompute
on read (just recompute), when there is no soft-delete dimension (cascade may suffice), or
when the triggering mutation is itself invertible (a normal op-logged flip is fine and you do
not need the marker).

## Examples

- **Recompute, don't flip** (`recomputeFlagWithin`): derive the boolean from
  `count(provenance) > 0`, write only on change, op-log the preimage with the `propagation`
  marker. Two blocks staling one extract → clearing one still leaves `EXISTS = true`, so the
  flag correctly stays set with zero reference-counting.
- **Clear by block-key, not by walk** (un-stale arm): a since-trashed extract that was
  flagged, then restored, comes back clean because the `DELETE ... WHERE source_element_id = ?
  AND stable_block_id = ?` removed its provenance even though no cascade fired on the soft
  delete.
- **Capture-once hash** (`upsertStateWithin`): the ternary preserves an existing
  `pre_stale_hash` on re-entry to stale and nulls it on any exit, so `A → B → C → A` is
  recognized as restored while `block_content_hash` independently keeps tracking the current
  value for the idempotence path.
- **Undo gate** (`isInvertible`): `if (op.payload.propagation === true) return false;` —
  short-circuits *before* the generic "has a usable `prev`" check, so even though these ops
  carry a real preimage they are never inverted by ⌘Z.
- **Hot-path skip** (`getSourceProcessingSummary`): provenance rows exist only for currently
  stale blocks, so `needsReverifyOutputs = staleAfterEditBlocks === 0 ? 0 :
  countLiveReverifyOutputs(...)` — the common clean-source summary read never runs the count
  query. The same short-circuit guards `reconcileSourceDocumentWithin` (skips propagation when
  both report arms are empty).
- **Defensive type filter** (`liveAnchorsByBlock` + the descendant walk): only
  `extract`/`card`/`media_fragment` elements may carry the flag (the type-coupled CHECK), so
  propagation filters to those types — flagging any other type would throw the CHECK mid-save.

## Related

- [`detach-tombstone-receipt-only-undo-and-per-triple-fingerprint-for-flag-resolution.md`](./detach-tombstone-receipt-only-undo-and-per-triple-fingerprint-for-flag-resolution.md)
  — the **resolution half** (T124): the human-in-the-loop drain that confirms / rebases /
  detaches the `needs_reverify` flag this doc produces. The "future resolution-undo" referenced
  below now ships as receipt-only undo there.
- [`review-triggered-descendant-health-source-rescheduling.md`](./review-triggered-descendant-health-source-rescheduling.md)
  — the **upward** back edge (review lapse → parent source reschedule). This doc is its
  **downward/forward** content counterpart (source edit → descendant needs-reverify flag).
  Same same-transaction + backend-owned-signal discipline; opposite direction, different
  scheduler, flag not reschedule.
- [`durable-source-block-processing-state.md`](./durable-source-block-processing-state.md)
  — the trigger: `stale_after_edit` + content-hash reconciliation. Propagation joins **that**
  transaction; `stale_after_edit` now *propagates*, not just flags the block.
- [`lineage-aware-deletion-tombstone-purge-guard.md`](./lineage-aware-deletion-tombstone-purge-guard.md)
  — live-only lineage walk (dead/soft-deleted ignored) + additive-op-payload symmetric
  reversibility; the precedent this pattern applies to a dirty-bit/un-stale-clears instead of
  a tombstone.
- [`queue-eligibility-inventory-scheduler-state.md`](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
  — read-model discipline: thread `needsReverify` as a typed contract field through every
  inventory producer; do not let the renderer re-derive it.
- [`sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md`](../database-issues/sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions.md)
  — the migration-0030 lineage-wipe the additive-migration discipline avoids.
- [`signal-hash-advisory-nudges.md`](../design-patterns/signal-hash-advisory-nudges.md)
  — contrast only: T123's flag is an inert, non-dismissible fact, **not** an advisory nudge
  (T124's resolution workflow may later adopt the nudge pattern).
