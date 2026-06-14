---
title: "Resolve a self-healing staleness flag: detach tombstone, receipt-only undo, per-triple fingerprint"
date: "2026-06-14"
category: "architecture-patterns"
module: "lineage-integrity/reverify-resolution"
problem_type: "architecture_pattern"
component: "database"
severity: "medium"
related_components:
  - "service_object"
  - "frontend_stimulus"
  - "testing_framework"
applies_when:
  - "A human-in-the-loop drain must resolve (confirm / rebase / detach) a self-healing flag raised by an automated downstream-propagation pass."
  - "Making a derived node standalone must preserve lineage and stay recoverable, so mutating the immutable anchor row is off the table."
  - "A flag-clearing resolution runs a non-invertible recompute that shadows it in the global-undo stack, so a generic command-undo would desync a persisted receipt."
  - "A batch resolves multiple flagged items captured against one frozen preview, and sibling decisions must not invalidate each other."
  - "A flag propagates through a DAG and a per-node opt-out must hold for the whole subtree, descendants included, not just the directly-anchored node."
tags:
  - "lineage-dag"
  - "detach-tombstone"
  - "snapshot-row"
  - "receipt-only-undo"
  - "revalidation-fingerprint"
  - "self-healing-flag"
  - "operation-log"
  - "content-staleness"
---

# Resolve a self-healing staleness flag: detach tombstone, receipt-only undo, per-triple fingerprint

## Context

T123 introduced a *content-staleness* signal for the lineage DAG: editing a source block
writes `element_reverify_provenance` rows for every live downstream output, which a
self-healing projection collapses into the denormalized `elements.needs_reverify` flag
(`needs_reverify = EXISTS(provenance)`, recomputed — never flipped). T124 builds the
human-in-the-loop *drain* — each flagged output (extract / atomic statement / card) resolves
as **confirm**, **rebase**, or **detach**, transactionally, op-logged, and receipt-undoable.

Building that drain surfaced three problems that recur in any "self-healing flag with a manual
resolution layer" design, and the fixes are reusable beyond this feature:

1. How to make a flagged output *standalone* (never re-flagged) without severing its
   provenance — and how a propagation walk must honor that across the *whole* descendant
   subtree, not just the directly-anchored node.
2. How undo should work when a resolution clears a flag by **deleting** provenance and then
   runs a non-invertible recompute, so the global command-undo (`⌘Z`) can silently desync a
   persisted receipt.
3. How a per-item revalidation fingerprint for a frozen-session batch can **self-invalidate**
   when sibling items in the same batch mutate shared state.

Each has a concrete bug — two caught in code review, one by design analysis — and a small,
surgical fix.

## Guidance

**1. Detach via a snapshot-row tombstone, not anchor mutation.**
To make a flagged output standalone, do *not* mutate or null its lineage anchor
(`source_locations`). Instead freeze a tombstone row (`element_detach_snapshot`) keyed by the
exact `(element, source, block)` triple, and have the propagation walk skip any triple that has
a tombstone via a `NOT EXISTS` / `isDetached` check. The output becomes (a) **standalone** — it
won't re-flag on a future edit of that block, (b) **recoverable** — undo drops the tombstone and
re-inserts provenance, and (c) **lineage-preserving** — the anchor is never touched.

The correctness rule worth burning in: **apply the tombstone check to descendants in the
propagation walk, not only to directly-anchored nodes.** A staleness flag flows *down* the
lineage (extract → statement → card); if the walk filters tombstones only when resolving the
direct anchor (`liveAnchorsByBlock`) but not when expanding `liveDescendantsWithin`, a detached
*descendant* re-flags the moment an ancestor's block is edited — silently breaking the detach's
standalone promise for non-anchor outputs.

**2. Receipt-only undo for self-healing-flag resolutions.**
When a resolution clears a self-healing flag by *deleting* provenance and then running a
non-invertible `propagation: true` recompute (which becomes the newest op and shadows the
resolution in the global-undo stack), do **not** also expose the resolution to global `⌘Z`. Make
resolutions invertible through exactly **one** guarded path — the persisted receipt's undo, with
a four-part current-state guard (op exists + carries the marker + target still exists + target
still in the system-written resolved state). Have `isInvertible` / `invertWithin` return
`false` / `null` for any op carrying the resolution marker.

**3. Per-triple revalidation fingerprint for frozen-session batches.**
When a frozen-session batch revalidates each item against current state via a signature, scope
any signature over mutable shared rows to **that decision's own key**, not the element's whole
set. A provenance signature that signs *all* of an element's provenance rows self-invalidates a
multi-item batch: resolving block A deletes A's row, which shifts block B's recomputed signature,
so B is skipped as `target-changed` and the element stays flagged forever. Constrain the
provenance query to the decision's `(element, source, block)` triple so each decision's
fingerprint is independent of its siblings' resolution.

## Why This Matters

- **Tombstone over anchor mutation** keeps "source lineage is sacred" intact while still
  delivering a standalone output. Mutating the anchor would be lossy, irreversible without a
  separate preimage, and would corrupt every other lineage query that reads `source_locations`.
  The descendant-coverage rule matters because the failure is *silent and delayed*: nothing
  breaks at detach time; the standalone promise breaks weeks later when an unrelated ancestor
  edit re-flags a card the user already resolved — exactly the class of bug a flag system exists
  to prevent.
- **A single authoritative undo path** prevents two undo mechanisms from disagreeing about
  persisted state. A second, unguarded global-undo would re-insert provenance (re-flagging the
  element) while leaving the receipt marked `actionable` — so the snackbar Undo then *falsely
  refuses* with "source changed," and the boolean, the provenance rows, and the receipt status
  drift apart. Worse, the "global undo of a resolution" was never actually reachable (the newest
  op is the non-invertible recompute, so `undoLast` short-circuits on it anyway), so the second
  path is pure desync risk with zero user benefit.
- **Per-triple fingerprint scope** is the difference between bulk-confirm working and a
  multi-block-flagged element being *permanently un-resolvable*. The bug is order-dependent and
  only appears on elements flagged by ≥2 blocks resolved in one batch — easy to miss in
  single-item tests, catastrophic for the exact maintenance workflow the feature exists to serve.

## When to Apply

- You have a denormalized "needs attention" flag derived from provenance/edge rows, and you need
  a "dismiss / accept current state" action that makes an item *stop re-flagging* without
  deleting its lineage.
- A flag propagates through a DAG/tree and a per-node opt-out must hold for the node's entire
  subtree, not just the node itself.
- A mutation clears a self-healing flag by deleting rows and re-running a non-invertible
  recompute, *and* a generic command-level undo exists in the same system. (Decide deliberately
  which undo path owns the inverse; don't let both.)
- You batch decisions captured against a frozen preview and revalidate each at apply-time with a
  signature — and the items can share mutable rows that other items in the same batch delete or
  rewrite.

## Examples

**1. Detach tombstone must cover descendants (the review bug).** In
`ReverifyPropagationRepository.propagateReverify`, the `affected` loop walks the anchor *plus* its
live descendants. `liveAnchorsByBlock` already filtered tombstoned direct anchors, but the
descendants flowed straight into provenance insertion.

Before — a detached descendant card re-flags when its ancestor's block is edited:

```ts
const affected: ElementId[] = [
  anchorId,
  ...liveDescendantsWithin(tx, anchorId)
    .filter((row) => REVERIFY_FLAGGABLE_TYPES.has(row.type))
    .map((row) => row.id as ElementId),
];
for (const elementId of affected) {
  this.insertProvenanceWithin(tx, { elementId, sourceElementId, stableBlockId: blockId, batchId });
  touched.add(elementId);
}
```

After — the `isDetached` tombstone check is applied per affected element, descendants included:

```ts
for (const elementId of affected) {
  if (this.isDetached(tx, elementId, sourceElementId, blockId)) continue;
  this.insertProvenanceWithin(tx, { elementId, sourceElementId, stableBlockId: blockId, batchId });
  touched.add(elementId);
}
```

The tombstone itself is just a frozen row (`reverify-resolution-repository.ts`
`writeDetachSnapshotWithin` / `detachWithin`); the anchor is never written, and undo drops it
(`restoreResolutionWithin`).

**2. Resolutions are receipt-only-undoable.** In `UndoService.isInvertible`, any op carrying the
`reverifyResolution` marker returns `false` (mirrored by `invertWithin` returning `null`):

```ts
// T124 resolution ops are reversed ONLY through the guarded receipt path
// (ReverifyResolutionService.undoReceipt → restoreResolutionWithin), never global ⌘Z.
if (typeof op.payload.reverifyResolution === "object" && op.payload.reverifyResolution !== null) {
  return false;
}
```

The single authoritative inverse lives in `ReverifyResolutionService.undoReceipt`, gated by a
four-part current-state guard, and calls `restoreResolutionWithin` *directly inside its own
transaction* (so it appends no globally-undoable op and a later `⌘Z` cannot partially reverse an
already-undone receipt).

**3. Fingerprint scoped to the decision's own triple.** In
`ReverifyResolutionService.fingerprintWithin`, the provenance-signature query was narrowed from
"all of this element's provenance" to the exact triple:

Before (conceptually) — signs every block's provenance row for the element, so resolving one
block shifts a sibling block's signature:

```ts
.where(and(
  eq(elementReverifyProvenance.elementId, elementId),
  eq(elementReverifyProvenance.sourceElementId, sourceElementId),
))
```

After — scoped to `(element, source, block)`, so each decision's fingerprint is independent:

```ts
.where(and(
  eq(elementReverifyProvenance.elementId, elementId),
  eq(elementReverifyProvenance.sourceElementId, sourceElementId),
  eq(elementReverifyProvenance.stableBlockId, blockId),
))
```

With the wider scope, a bulk batch over an element flagged by blocks A and B self-invalidated:
resolving A deleted A's row, B's recomputed signature drifted, and `revalidate` skipped B as
`target-changed`, leaving the element permanently flagged. Per-triple scoping makes bulk-confirm
correct.

These three patterns generalize as: **(1)** opt-out of a propagating flag belongs in a side
tombstone honored across the whole subtree, never in the lineage anchor; **(2)** a flag-clearing
mutation that runs a non-invertible recompute must have exactly one owning undo path, never two;
**(3)** a per-item revalidation signature over shared mutable rows must be scoped to the item's
own key so a batch can't invalidate itself.

Key files: `packages/local-db/src/reverify-propagation-repository.ts`,
`packages/local-db/src/reverify-resolution-repository.ts`,
`packages/local-db/src/reverify-resolution-service.ts`,
`packages/local-db/src/undo-service.ts`,
`packages/db/src/schema/documents.ts` (`elementDetachSnapshot`, `elementReverifyProvenance`).

## Related

- [`downward-dirty-bit-propagation-through-lineage-dag.md`](./downward-dirty-bit-propagation-through-lineage-dag.md)
  — the upstream producer (T123 sets/self-heals the flag this drains; the `propagation` marker +
  `element_reverify_provenance` + `pre_stale_hash` restoration this builds on).
- [`lineage-aware-deletion-tombstone-purge-guard.md`](./lineage-aware-deletion-tombstone-purge-guard.md)
  — the tombstone-and-keep precedent (additive preimage row, never silently orphan, descendant
  propagation, symmetric restore) — here applied to `source_locations` anchors instead of
  lineage FKs.
- [`frozen-conversion-session-revalidation.md`](./frozen-conversion-session-revalidation.md)
  — the frozen-session + per-item fingerprint revalidation origin pattern; the per-triple
  fingerprint generalizes its session fingerprint to a composite key.
- [`extract-aging-policy-receipt-demotion.md`](./extract-aging-policy-receipt-demotion.md)
  — the receipt + apply-time-revalidation + explicit-skip-reasons template.
- [`standing-auto-postpone-trusted-current-day-materialization.md`](./standing-auto-postpone-trusted-current-day-materialization.md)
  — the four-part receipt-undo guard + mark-restore-non-global-undoable rule reused here.
- [`topic-fallow-rest-operation-log-preimages.md`](./topic-fallow-rest-operation-log-preimages.md)
  — shared-`batchId` batch undo with skip-newer-intent restore.
- [`queue-eligibility-inventory-scheduler-state.md`](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
  — backend-owned typed read-model field discipline (thread the resolution/flag state through
  producers, never re-derive in the renderer).
