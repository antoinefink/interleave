---
title: "Lineage-aware deletion: tombstone-and-keep, a purge guard at every hard-delete seam, and symmetric restore"
date: 2026-06-12
category: architecture-patterns
module: local-db / lineage deletion
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - "Soft-deleting an element that has both an ancestor and live descendants in a self-referential lineage"
  - "The lineage FKs (parentId / sourceId) use ON DELETE SET NULL, so any hard delete nulls children's links"
  - "Building trash / restore / undo over scheduled or review-bearing elements"
tags: [lineage, soft-delete, tombstone, purge-guard, foreign-keys, restore, batch-undo]
---

# Lineage-aware deletion: tombstone-and-keep, a purge guard at every hard-delete seam, and symmetric restore

## Context

Deleting an element in the *middle* of the lineage tree — a topic/extract/sub-extract that has both an ancestor and live descendants — is a sharp edge in a system where "source lineage is sacred" and `elements.parentId`/`sourceId` are self-referencing FKs declared `onDelete: "set null"`. Two distinct failure modes hide behind one "delete" button:

- A **hard delete** (purge) fires the `ON DELETE SET NULL` actions and nulls every direct child's `parentId`/`sourceId` — the exact mechanism that wiped the real vault in migration 0030 (see [[sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions]]), reproduced at the user-facing delete path instead of a migration.
- A **single-row soft delete** leaves descendants pointing at a now-deleted parent. A live-only lineage walk (`listChildren` filtering `deletedAt IS NULL`) then prunes the whole subtree from view, so a *live* focused element silently vanishes from its own lineage.

This note captures the design that makes mid-tree deletion safe, reversible, and non-hiding — born from building Interleave's T135 and hardened by the code review that followed it.

## Guidance

**1. Tombstone-and-keep by default; surface deleted ancestors via an opt-in tombstone read.** Deleting a node with live descendants should keep the descendants live and connected, and render the deleted node as a muted *tombstone*. Implement this as a flag on the lineage read (`get(id, { includeTombstones })`) that (a) does not early-return for a deleted focused node, (b) walks *through* deleted ancestors to the live root, and (c) emits soft-deleted nodes tagged `deleted: true`. Keep the **default path byte-for-byte live-only** so yield/analytics/"review this branch" consumers are unaffected. The tombstone is a derived display state from `deletedAt` — not a new status or op type.

**2. Guard hard-delete at EVERY seam, checking every self-FK.** Because the `set null` cascade fires on any real `DELETE`, a guard that blocks purging a node with live dependents must run in **every** hard-delete path — manual `purge`, `emptyTrash`, and any future auto/30-day purge — not just the one the UI happens to call. Check **both** self-FKs (`parentId` AND `sourceId`); a node can anchor a live child through either. `emptyTrash` should **skip** guarded rows and report the count, not abort the whole empty. Add a schema test asserting the element table has *exactly* the known self-FKs so a future third FK forces the guard to be revisited.

**3. One preimage-aware soft-delete underlies both "keep" and "branch", with symmetric restore.** A single command soft-deletes a target node and *optionally* its live subtree in one transaction under one shared `batchId`. Make it preimage-aware with **additive op-payload fields** on the existing `soft_delete_element` op (no new op type): record `prevDueAt` and, for cards, `prevReviewDueAt`, and clear **both** `elements.due_at` and `review_states.due_at` (the queue-exit two-store rule, see [[queue-eligibility-inventory-scheduler-state]]). Restore must re-establish the schedule from the preimage in **all** restore paths — undo, single restore-from-trash, and batch restore — because the base `restore` touches only status/`deletedAt`. Keep undo-the-undo symmetric (re-clear on the inverse). Distinguish a genuinely-null due (`null`) from a card with no review row (`undefined`) so you never write a bogus preimage.

**4. Restore the ancestor chain, not the subtree.** Restoring a tombstone — or the "an ancestor was deleted" hint on a live focused node — must restore only the focused element's **actual ancestor chain up to the first live root**, via a dedicated primitive (`restoreAncestorChain(id)` that walks `parentId` upward). Filtering the tombstone-aware tree for "every deleted node" and restoring all of them resurrects unrelated **sibling/cousin branches** the user intentionally trashed. The same primitive prevents the inverse bug: restoring a single mid-chain tombstone whose parent is still deleted leaves a live node under a tombstone parent.

**5. Batch restore must propagate skip and be atomically undoable.** When restoring a batch, processing root-first, skip a node if **any** ancestor is skipped (newer-intent / purged / not-deleted) — not just when the *root* is skipped — or a descendant gets restored live under a still-tombstoned intermediate. Thread a fresh shared `batchId` through the N `restore_element` ops so a follow-up `undoLast` (which groups by the most-recent op's batchId) reverses the whole restore as one unit, matching the delete's atomicity (the `batchId` pattern from [[topic-fallow-rest-operation-log-preimages]]).

## Why This Matters

Lineage is the product's deepest invariant and it has already been destroyed once (migration 0030). These rules close the orphaning vector at the *user-facing* delete path, guarantee that live work is never silently hidden, and make review investment (FSRS state) survive a delete/restore round-trip exactly. The subtle bugs the code review caught — guarding only `purge` and not `emptyTrash`, restoring every tombstone instead of the ancestor chain, skipping only the root in batch restore, swallowing undo IPC rejections — all *pass the happy-path tests* and all silently violate the invariant. They are the failure modes to look for in any soft-delete-over-lineage feature.

## When to Apply

- Any soft-delete / trash / restore feature over a **self-referential lineage** whose FKs are `ON DELETE SET NULL`.
- Any "delete a node that has dependents" UX where the children carry independent value (review history, derived work).
- Any delete of a **scheduled** element (attention or FSRS) — clear *and* preimage the due fields so restore is faithful and the deleted row never lingers as a phantom "Due today".

## Examples

Guard at every seam (not just the manual purge):

```ts
// trash-query.ts — the live-dependent check runs before EVERY real DELETE
function liveDependentCountWithin(tx, id) {
  return countLive(tx, or(eq(elements.parentId, id), eq(elements.sourceId, id)));
}
purge(id)      { if (liveDependentCountWithin(tx, id) > 0) throw new PurgeBlockedByLiveDescendantsError(...); ... }
emptyTrash()   { for (row of trashed) { if (liveDependentCountWithin(tx, row.id) > 0) { skipped++; continue } purge(row.id) } return { purged, skipped } }
```

Restore the chain, not the subtree (the bug → the fix):

```ts
// WRONG — resurrects intentionally-trashed sibling branches:
const toRestore = lineage.nodes.filter((n) => n.deleted && !n.active);
// RIGHT — only the focused element's ancestor chain, up to a live root:
await appApi.restoreAncestorChain({ id: focusedId });
```

Additive preimage on the existing op (no new op type), symmetric on undo:

```ts
// soft_delete_element payload gains optional fields ONLY on the schedule-clearing path:
{ id, deletedAt, prev: { status }, ...(batchId && { batchId }),
  ...(prevDueAt !== undefined && { prevDueAt }),
  ...(prevReviewDueAt !== undefined && { prevReviewDueAt }) }   // undefined ⇒ field absent ⇒ legacy behavior
```

## Related

- [[sqlite-table-rebuild-with-foreign-keys-on-fires-on-delete-actions]] — the migration-side cause: the same FK-set-null wipe, fixed in the migration runner + repair migration 0034. This note is its delete-path counterpart; the two are cross-linked but kept distinct (migration cause/repair vs. delete-path design).
- [[queue-eligibility-inventory-scheduler-state]] — clear both `elements.due_at` and `review_states.due_at` on queue exit; symmetric undo.
- [[topic-fallow-rest-operation-log-preimages]] — shared-`batchId` batch mutation with intent-aware, preimage-based restore.
- [[extract-fates-value-model-v2-source-yield-stagnation]] — reconciling the cached `synthesized` extract-fate on delete/restore.
- [[extract-card-ipc-invariant-test-hardening]] — negative+positive IPC boundary tests for the new delete/restore channels.
- [[electron-e2e-stale-build-lock-and-lineage-contract]] — asserting lineage + restart persistence in Electron E2E.
- Plan: `docs/plans/2026-06-12-004-feat-lineage-aware-deletion-plan.md` (T135).
