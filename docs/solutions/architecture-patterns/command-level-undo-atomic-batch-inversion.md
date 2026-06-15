---
title: "Global command-level undo must invert a batch in ONE transaction, not N independent ones"
date: 2026-06-15
category: architecture-patterns
module: packages/local-db
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "A single action or bulk sweep writes N operation_log ops under one batchId that undo reverses together"
  - "The per-op inverse runs through a repository write that opens its OWN transaction internally"
  - "Adding or reviewing a global undo path that reverses the most-recent op or batch"
related_components:
  - local-db
  - operation-log
  - electron-ipc
tags:
  - undo
  - transaction
  - atomicity
  - operation-log
  - batch-id
  - command-level-undo
---

# Global command-level undo must invert a batch in ONE transaction, not N independent ones

## Context

`UndoService.undoLast()` (`packages/local-db/src/undo-service.ts`) is the global ⌘Z path:
it reads the most-recent `operation_log` op and applies its inverse through the existing
repository write paths. When that op carries a `batchId` (a bulk-postpone, an inbox bulk-triage
sweep, a lineage subtree delete), `undoLast` reverses EVERY op sharing it, newest-first, so the
whole batch undoes as one user-visible action.

The batch inversion was a bare loop:

```ts
const batch = batchId ? this.collectBatch(batchId) : [last];
for (const op of batch) {
  const opLabel = this.invert(op);     // invert → invertWithin(this.db, op)
  ...
}
```

The trap is that `invert(op)` calls `invertWithin(this.db, op)`, and the per-op-type inverses
go through repository methods (`ElementRepository.restore` / `softDelete` / `update`) that each
open their OWN `this.db.transaction(...)` internally. So undoing an N-op batch committed **N
independent transactions**. If op K of N threw (a stale row, a constraint violation), ops
`0..K-1` were already durably committed and ops `K+1..N` never ran — the batch was left
half-undone on disk with no compensation.

This is the read/undo-side twin of the write-side anti-precedent documented in
[Bulk command = per-item verbs in one transaction](bulk-command-heterogeneous-batch-undo-guard.md):
the same "N independent transactions instead of one" mistake, one layer down. The sibling method
`undoBatch` (same file) was already correct — it wrapped the whole batch inversion in a single
`this.db.transaction((tx) => { ... invertWithin(tx, op) ... })` — so the fix was to make
`undoLast` match it.

Flagged as **REL-01** during the code review of the `operation_log.batch_id` index change. It
was pre-existing (predates that change) and was deferred to keep the perf fix scoped, then fixed
on its own.

## Guidance

1. **Wrap the whole batch inversion in ONE `db.transaction`.** Collect the batch, then invert
   every op inside a single outer transaction so the undo is all-or-nothing. A throw on any op
   rolls the entire batch back instead of stranding the ops already applied. Mirror the sibling
   `undoBatch`, which was the correct precedent the whole time.

2. **Pass the transaction client down — `invertWithin(tx, op)`, not `invert(op)`.** The bare
   `invert(op)` helper re-opened `this.db`; passing `tx` keeps every inverse on the same
   transaction. Once the loop is wrapped, that helper is dead — delete it (Biome's
   `noUnusedPrivateClassMembers` will flag it otherwise).

3. **Atomicity holds even when an inverse opens its own nested transaction.** Some inverses still
   call `this.db.transaction(...)` internally (e.g. `soft_delete_element` → `elements.restore`).
   That is fine: better-sqlite3 turns a nested `BEGIN` into a `SAVEPOINT`, and the inner savepoint
   releases into the *outer* transaction, which has not hit disk yet. A throw triggers the outer
   `ROLLBACK`, discarding everything — including ops whose savepoints already "committed." The bug
   was never the nesting; it was the *absence of an outer transaction*.

4. **Preserve the existing skip / order / result contract.** Keep the newest-first
   (reverse-insertion) iteration order, keep skipping ops whose `invertWithin` returns `null` (a
   marker op with no usable pre-image — see `isInvertible`), and keep the same `UndoResult` shape
   (`count`, label `"Undid N changes"` for a multi-op batch, reason `Can't undo "…"` when nothing
   inverted). Wrapping in a transaction changes durability, not semantics.

5. **Regression-test the atomic boundary with fault injection, not a happy path.** A normal
   bulk-undo test never exercises the failure — every op inverts cleanly, so it passes on the buggy
   code too. Force a mid-batch inverse to throw and assert all-or-nothing.

## Why This Matters

Source lineage is sacred and the project prefers reversible, auditable mutations over data loss.
A half-undone batch is the worst of both: the user pressed ⌘Z once and got a state that is neither
the before nor the after — some items reverted, some not, with no record of which. For a lineage
subtree delete, that means some nodes restored and some still trashed; for a bulk-postpone, some
items back on their old schedule and some still pushed out.

The failure is also silent on the happy path. The pre-existing tests (bulk postpone, lineage
branch delete, chronic-postpone) all undid cleanly because nothing threw, so the non-atomic loop
shipped and survived review until a perf-adjacent review (`operation_log.batch_id` index) noticed
the missing transaction by reading the code, not by a failing test.

**Prevention:** a fault-injection regression test. Seed a multi-op batch, force the inverse of a
mid-batch op to throw (a stale row / constraint violation stand-in), and assert the database is
fully rolled back — no row reverted, no inverting op leaked into the log. The test must fail on
the bare-loop version (it does: an earlier-iterated op commits its revert before the throw) and
pass on the wrapped version.

## When To Apply

- Any global / command-level undo that reverses the most-recent op OR a `batchId`-grouped batch.
- Especially when the per-op inverse goes through a repository write that opens its own
  transaction — the independent-commit hazard is invisible at the call site (`this.invert(op)`
  looks like one atomic step).
- Whenever you review a batch loop that mutates durable state: ask "if op K throws, what is on
  disk?" If the answer is "ops 0..K-1," it needs an outer transaction.
- When you find a sibling method that already does it right (`undoBatch` here), the cheapest
  correct fix is to make the broken one match it, not to invent a new shape.

## Examples

**The fix** (`packages/local-db/src/undo-service.ts`, `undoLast`):

```ts
// BEFORE — N independent transactions; a throw on op K strands ops 0..K-1:
let undoneCount = 0;
for (const op of batch) {
  const opLabel = this.invert(op);          // invertWithin(this.db, op) → own tx per op
  if (opLabel === null) continue;
  undoneCount += 1;
  if (!label && opLabel) label = opLabel;
}

// AFTER — one transaction; any throw rolls the whole batch back:
let undoneCount = 0;
this.db.transaction((tx) => {
  for (const op of batch) {
    const opLabel = this.invertWithin(tx, op);
    if (opLabel === null) continue;          // marker op, no pre-image — skip, unchanged
    undoneCount += 1;
    if (!label && opLabel) label = opLabel;
  }
});
```

**The regression test** (`packages/local-db/src/undo-service.test.ts`) — fault-inject one
mid-batch inverse, assert nothing partial survives:

```ts
qa.bulkPostpone([a, b, c], now);            // 3 reschedule_element ops, one batchId
const postponed = { a: dueOf(a), b: dueOf(b), c: dueOf(c) };
const opsAfterBatch = log.count();

// Inversion of `a` (oldest op, inverted LAST) throws; c and b invert cleanly first.
const real = ElementRepository.prototype.rescheduleWithin;
const spy = vi
  .spyOn(ElementRepository.prototype, "rescheduleWithin")
  .mockImplementation(function (this: ElementRepository, ...args: Parameters<typeof real>) {
    if (args[1] === a) throw new Error("simulated stale row during inversion");
    return real.apply(this, args);
  });
try {
  expect(() => undo.undoLast()).toThrow(/simulated stale row/);
} finally {
  spy.mockRestore();
}

// ALL-OR-NOTHING: no row reverted (full rollback), no inverting op leaked.
expect(dueOf(a)).toBe(postponed.a);
expect(dueOf(b)).toBe(postponed.b);          // ← fails on the bare-loop version: b was reverted
expect(dueOf(c)).toBe(postponed.c);
expect(log.count()).toBe(opsAfterBatch);
```

On the buggy bare loop this fails — `c` and `b` revert and durably commit before `a` throws, so
`b` reads its original (pre-postpone) due. On the wrapped version every revert rolls back and all
three stay at their post-postpone state.

## Related Issues

- [Bulk command = per-item verbs in one transaction; heterogeneous batches need an op-type-agnostic undo guard](bulk-command-heterogeneous-batch-undo-guard.md)
  — the WRITE-side twin: the same "one transaction, one `batchId`" lesson when *applying* a bulk
  sweep. This doc is the READ/undo-side: the same lesson when *inverting* one. The two are
  complementary halves of the same batch-atomicity principle.
- [Standing auto-postpone trusted current-day materialization](standing-auto-postpone-trusted-current-day-materialization.md)
  — `AutoPostponeService.apply` is the good single-transaction batch precedent both this fix and
  the write-side doc point back to.
- [Lineage-aware deletion tombstone purge guard](lineage-aware-deletion-tombstone-purge-guard.md)
  — a `batchId`-grouped soft-delete subtree, one of the multi-op batches `undoLast` now reverses
  atomically.
