---
title: "Chronic postpone reckoning from operation-log reset markers"
date: 2026-06-11
category: architecture-patterns
module: "scheduler/maintenance"
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "Postpone behavior must distinguish current chronic state from historical postpone volume"
  - "Reset markers in operation_log define a new effective counting window"
  - "Scheduler, maintenance UI, and diagnostics must agree on the same reckoning model"
related_components:
  - database
  - testing_framework
tags:
  - chronic-postpone
  - operation-log
  - maintenance
  - scheduler
  - drift-diagnostics
---

# Chronic postpone reckoning from operation-log reset markers

## Context

T106 turns repeated postpones from silent scheduler drift into a Maintenance reckoning loop. The durable pattern is to keep `operation_log` append-only: postpones remain `reschedule_element` rows with `postpone: true`, and an explicit keep/demote decision writes a marker-only `update_element` row that resets the effective counting window.

No mutable postpone-count column is needed. The historical evidence remains intact while the current "since the last reckoning" count can reset and undo cleanly.

## Guidance

Use one repository method as the effective counter for every reader that means "current postpone debt": `OperationLogRepository.countPostpones(elementId)`.

Fold an element's log oldest-to-newest:

```ts
reschedule_element with postpone === true => count += 1
update_element with chronicPostponeReset => count = 0
update_element with chronicPostponeResetUndo => count = restoredEffectivePostponeCount
```

Keep and demote decisions append reset markers with `prevEffectivePostponeCount`. Undo appends a reset-undo marker instead of deleting or rewriting history. Because these reset rows do not have a normal `prev` patch payload, `UndoService` must explicitly treat the marker shape as invertible.

Maintenance owns the user-facing reckoning surface:

- The read model lists live supported rows, including future-due rows, whose effective count crosses the user threshold.
- The apply service accepts explicit `keep`, `demote`, `done`, and `delete` decisions.
- Every submitted id is revalidated inside the transaction.
- Stale rows return skip reasons instead of failing the whole batch.
- Applied rows share one `batchId`, so command undo reverses the whole decision set.

Scheduler behavior stays intentionally split. The log's effective count can keep increasing after more postpones, but the count passed into non-task attention interval growth is capped at one below the threshold while the row awaits a reckoning decision. Direct extract postpones use the same pause rule. Tasks remain outside this first chronic reckoning surface unless a task-specific apply/undo path is designed.

Any reader that surfaces postpone state must decide whether it needs lifetime evidence or effective debt. Extract stagnation uses the effective counter so a kept extract stops appearing stagnant from pre-reset postpones. Scheduler consistency reports both currently paused chronic rows and rows whose raw historical count exceeds the effective count because a reset marker exists.

## Why This Matters

Append-only reset markers preserve auditability and undo without schema churn. Historical postpones remain visible, reset decisions are durable receipts, and readers agree because they fold the same log semantics.

The pattern also prevents chronic rows from receding farther while waiting for a decision. The user can leave the Maintenance panel, but the item stays visible in the reckoning list instead of drifting deeper into the future through repeated postpone interval growth.

## When to Apply

- A derived behavioral count needs reset and undo semantics, but the event history must stay append-only.
- Multiple read models already derive state from `operation_log`.
- A UI needs a batched decision surface over rows that can go stale between list and apply.
- Scheduler inputs need "effective since reset" semantics while analytics may still need lifetime history.

## Examples

Reset marker:

```ts
{
  opType: "update_element",
  elementId: id,
  payload: {
    id,
    action: "chronicPostpone:keep",
    decision: "keep",
    chronicPostponeReset: true,
    prevEffectivePostponeCount,
    batchId,
  },
}
```

Undo marker:

```ts
{
  opType: "update_element",
  elementId: id,
  payload: {
    id,
    action: "chronicPostpone:undoReset",
    chronicPostponeResetUndo: true,
    restoredEffectivePostponeCount,
    batchId,
  },
}
```

Tests should cover the whole loop:

- reset and reset-undo folds in the counter;
- keep/demote marker undo symmetry;
- stale-row skips for missing, deleted, terminal, retired, unsupported, below-threshold, and gated source rows;
- scheduler and direct extract postpone pause behavior;
- reader alignment for extract stagnation and scheduler consistency;
- Electron E2E with keep/demote/done/delete, app restart, and one batch undo.

## Related

- [Model priority integrity as read-only analytics over durable logs](./priority-integrity-read-model.md) — durable-log receipt semantics and postpone debt attribution.
- [Save for later as a first-class parked state](../workflow-issues/save-for-later-first-class-parked-state.md) — maintenance decision sweep precedent with revalidation, skip reasons, `batchId`, and undo.
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md) — backend-owned eligibility, drift diagnostics, and undo preimage discipline.
- [Review analytics data capture in review logs](./review-analytics-data-capture-in-review-logs.md) — capture facts on the write path and derive receipts later.
- [Inbox triage Queue soon must schedule through attention scheduling](../workflow-issues/inbox-triage-queue-soon-attention-scheduling.md) — explicit operation-log action marker precedent.
