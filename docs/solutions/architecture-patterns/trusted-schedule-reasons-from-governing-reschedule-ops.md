---
title: "Trust schedule reasons only from the governing reschedule operation"
date: "2026-06-12"
category: "docs/solutions/architecture-patterns"
module: "attention-scheduler/read-models"
problem_type: "architecture_pattern"
component: "database"
severity: "medium"
related_components:
  - "service_object"
  - "testing_framework"
  - "documentation"
applies_when:
  - "Attention scheduler decisions need user-visible explanations without renderer inference."
  - "A due-date explanation must only render while durable evidence still matches the current due date."
  - "Existing command payloads can carry diagnostic evidence without adding mutable explanation tables."
  - "Manual schedule choices or queue-soon actions should suppress heuristic explanations."
  - "A setting can flip default-on only after the UI exposes trusted reasons for learned behavior."
tags:
  - "schedule-explainability"
  - "attention-scheduler"
  - "operation-log"
  - "read-model"
  - "scheduler-signals"
  - "ipc"
  - "undo"
  - "trusted-evidence"
---

# Trust schedule reasons only from the governing reschedule operation

## Context

T113 made attention scheduling explainable across the write path, read models, IPC contracts, and
UI. The scheduler now emits a closed `AttentionScheduleReason` value for adaptive yield, recency
damping, postpone recession, source-processing outcomes, descendant lapse signals, and the silent
`band_base` baseline.

The important boundary is that the UI does not trust the latest diagnostic ever written. Local DB
projects only the reason that still governs the current schedule: the newest relevant
`reschedule_element` operation whose payload due date still matches the element's current due date.
Explicit manual choices, queue-soon shortcuts, stale rows, malformed payloads, and under-evidenced
payloads stay silent.

## Guidance

Persist schedule reasons with the schedule mutation, not as renderer-only labels:

```ts
operation_log.payload = {
  action: "reschedule_element",
  dueAt,
  scheduleReason,
};
```

Then project current explainability from durable evidence:

```ts
if (!payload || payload.dueAt !== currentDueAt) return null;
if (payload.choice !== undefined || payload.queueSoon === true) return null;
```

The projection should validate every visible reason kind before it reaches IPC. It is not enough
that the current write path is well-formed: old rows, manual test fixtures, and future migrations
can all produce partial payloads. Require positive productive output for `yield_shortened`, zero
productive output for `yield_lengthened`, finite recency evidence for `recency_damped`, an effective
postpone count for `postpone_recession`, and concrete source-processing evidence for source
reasons. Keep `band_base` hidden.

Expose the same trusted projection to every read surface. Queue rows, Home previews, and Inspector
details should all receive the same backend-owned `scheduleReason` shape. The renderer's job is to
format a validated value, hide `null` and `band_base`, and attach visible reason text to controls
with accessibility relationships such as `aria-describedby`.

Undo needs special care. When undo restores a prior due date, the inverse reschedule should carry
the restored schedule evidence for that due date without copying command markers such as
`queueSoon`, explicit choices, or batch identifiers. Otherwise a learned return date can come back
unexplained even though its governing evidence still exists.

## Why This Matters

Adaptive attention intervals change when work returns. Without visible reasons, users experience
learned schedule movement as arbitrary drift. But showing stale or over-claimed reasons is worse
than silence because it trains users not to trust the scheduler.

This pattern keeps explainability honest:

- the scheduler records why it chose an interval;
- the write path stores that reason transactionally with the due-date change;
- the read model decides whether that reason still governs current state;
- the renderer only formats trusted structured data.

That separation also keeps explicit user intent clean. A manual return date or Queue soon action is
a scheduling command, not heuristic evidence that should be reinterpreted as adaptive or recency
logic later.

## When to Apply

- A due date is affected by scheduler heuristics, learned multipliers, source-processing evidence,
  descendant-card lapse evidence, recency damping, or repeated postpones.
- A user-facing surface needs to explain why a non-card item is returning sooner or later.
- The explanation must survive app restart, undo, and read-model refresh without renderer
  inference.
- A scheduler feature can only become default-on once its behavior is visible and evidence-backed.

Do not use this pattern for FSRS card review math, manual explicit schedule choices, Queue soon
shortcuts, or renderer-inferred explanations. Those should either have their own explicit command
label or remain silent.

## Examples

Source-processing work can compose interval math and explanation differently. A barren source can
lengthen its return cadence because it produced no output; a source with unresolved blocks can
return sooner because there is still processing work left. Descendant-card lapse pressure can also
return a source sooner when recent live descendant cards cross the evidence floors. All of these
reasons need concrete evidence, not just a changed interval.

Visible formatting should stay evidence-gated:

```ts
case "yield_shortened":
  return productiveOutputCount > 0
    ? `Returning sooner: last visit produced ${productiveOutputCount} output(s).`
    : null;
case "postpone_recession":
  return postponeCount > 0 ? `Receding after postpone x${postponeCount}.` : null;
case "descendant_lapses":
  return hasCompleteDescendantEvidence(reason)
    ? "Returning sooner: descendant cards are struggling."
    : null;
```

T113 verification covered the whole path:

- scheduler reason emission and adaptive/source/postpone branches;
- operation-log projection, stale suppression, malformed suppression, and undo preservation;
- desktop contract parsing and renderer API parity;
- Queue, Home, and Inspector rendering with hidden baseline/card cases;
- Electron queue coverage for a real extraction producing a visible schedule reason.

## Related

- [Persist adaptive attention intervals as bounded, undoable scheduler state](./yield-adaptive-attention-interval-multiplier.md)
- [Use descendant-card lapse evidence to transiently reschedule parent sources](./review-triggered-descendant-health-source-rescheduling.md)
- [Chronic postpone reckoning from operation-log reset markers](./chronic-postpone-reckoning-from-operation-log-reset-markers.md)
- [Model priority integrity as read-only analytics over durable logs](./priority-integrity-read-model.md)
- [Track source block processing as durable source-scoped state](./durable-source-block-processing-state.md)
- [Attention scheduler recency needs separate last-seen and action clocks](../logic-errors/attention-scheduler-last-seen-clock-semantics.md)
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
