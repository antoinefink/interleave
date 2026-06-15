---
title: "Use descendant-card lapse evidence to transiently reschedule parent sources"
date: "2026-06-12"
category: "docs/solutions/architecture-patterns"
module: "adaptive-attention-scheduler/descendant-health"
problem_type: "architecture_pattern"
component: "service_object"
severity: "medium"
related_components:
  - "database"
  - "testing_framework"
  - "documentation"
applies_when:
  - "Card review outcomes should influence source attention scheduling without changing card FSRS state."
  - "A source should return sooner only when recent descendant-card lapse evidence crosses strict thresholds."
  - "Schedule explanations must be persisted with the governing reschedule operation and hidden after manual overrides."
tags:
  - "attention-scheduler"
  - "descendant-health"
  - "schedule-explainability"
  - "fsrs"
  - "operation-log"
  - "source-rescheduling"
---

# Use descendant-card lapse evidence to transiently reschedule parent sources

## Context

T114 added the first review-to-attention back edge: recent true lapse increments on live
descendant cards can pull a parent source back sooner in the attention scheduler. The boundary is
load-bearing: cards still belong to FSRS, while sources stay attention-scheduled work.

The reusable pattern is to treat descendant health as a narrow, durable, source-only scheduler
input. It is not renderer inference, it is not a lifetime rollup over `review_states`, and it does
not mutate card review state.

## Guidance

Compute evidence from review events, not current card counters. `DescendantHealthQuery` reads
`review_logs` for true lapse increments inside the recent window and joins through live descendant
cards:

```ts
sql`${reviewLogs.nextLapses} > ${reviewLogs.prevLapses}`;
```

The query should include only active or scheduled, non-deleted, non-retired card descendants whose
`source_id` matches the source being considered. It should return `null` below evidence floors,
including lapse count, affected-card count, and lapse-rate thresholds.

Keep interval math pure and capped in `packages/scheduler`. The scheduler input should be small:

```ts
descendantHealth: {
  descendantLapseCount,
  affectedCardCount,
  descendantCardCount,
}
```

The pure scheduler should only shorten sources, cap transient pressure, respect the adaptive
multiplier floor, preserve the one-day interval floor, and emit `descendant_lapses` only when it
beats the no-descendant baseline.

Wire the behavior from the review transaction, not from queue reads. `ReviewRepository.recordReview`
can call the scheduler service after it proves the current review incremented the lapse count:

```ts
if (outcome.lapses > before.lapses && cardElement.sourceId) {
  new SchedulerService(this.db).rescheduleSourceForDescendantHealthWithin(
    tx,
    cardElement.sourceId,
    outcome.reviewedAt,
  );
}
```

That service should write one source `reschedule_element` operation only when the descendant-health
decision produces an earlier due date than the source already has. Keep it transaction-composable
so the just-written review log is visible to the query and a later review failure rolls back both
the card review and the source reschedule.

Visible reasons remain trusted projections. The operation-log projection should revalidate every
`descendant_lapses` evidence field before exposing it to IPC, and the renderer should format only
complete evidence. Manual schedules, Queue soon, stale due dates, malformed payloads, and
under-evidenced payloads stay silent.

## Why This Matters

Descendant lapse pressure is useful because struggling cards often mean the source needs another
pass. It is also noisy: a single failed card, a stale historical lapse, or a retired descendant
should not make a source jump forward.

This pattern keeps the signal bounded and auditable:

- FSRS remains the only owner of card review schedules.
- Sources return sooner only from durable review-log evidence.
- Source rescheduling commits atomically with the review that created the evidence.
- The adjustment is transient and capped, not a persisted multiplier mutation.
- Queue, Home, and Inspector render the same backend-owned reason and hide it after explicit user
  scheduling.

## When to Apply

- Child evidence should influence a parent attention schedule.
- The parent and child use different schedulers.
- Evidence comes from durable event rows such as review logs.
- The signal needs floors, caps, and same-transaction visibility.
- The reason must survive restart and stay tied to the governing `operation_log` row.

Do not apply this pattern during queue materialization, renderer formatting, or manual scheduling
commands. Those layers can display or suppress trusted reasons, but they should not derive the
heuristic.

## Examples

Pure scheduler tests should cover the bounded interval behavior:

```ts
const decision = nextDueAt(
  {
    type: "source",
    priority: C,
    descendantHealth: {
      descendantLapseCount: 4,
      affectedCardCount: 2,
      descendantCardCount: 5,
    },
  },
  now,
);
```

That case shortens a C-priority source from its baseline while emitting a complete
`descendant_lapses` reason. A second regression should prove descendant pressure cannot compound
below the existing adaptive multiplier floor.

Repository tests should cover the transaction boundary. Force a later review-side write to fail
after descendant source rescheduling has run, then assert the review state, review log, source due
date, leech flag, and source operation log all roll back together.

Read-model and UI tests should cover both visibility and suppression:

- descendant reason projects only with consistent count, rate, and interval evidence;
- Queue, Home, and Inspector show the same reason text while it governs the due date;
- a manual schedule hides the descendant reason on every surface;
- restart preserves the current governing reason or its suppression.

## Related

- [Sibling clustering over the lineage DAG: the nearest-live-source-ancestor read model](./sibling-clustering-over-the-lineage-dag.md) — the SIDEWAYS counterpart (T128). Since T128, this query's lapse predicate (`nextLapses > prevLapses`, marker-excluded, live non-retired cards, inclusive window) lives in the SHARED `lapse-window.ts` helper that both queries import — so the cluster list and this upward reschedule can never disagree about what a lapse is. This doc carries review pain *up* the lineage (child → parent reschedule); T128 reads sibling lapses *sideways* (grouped under a shared source-region ancestor) without mutating anything.
- [Propagate content-staleness down the lineage DAG when a source block is edited](./downward-dirty-bit-propagation-through-lineage-dag.md) — the DOWNWARD/forward counterpart of this back edge: this doc carries review pain *up* the lineage (child → parent); that one carries edit staleness *down* it (source → descendants). Same same-transaction, backend-owned-signal discipline; opposite direction.
- [Trust schedule reasons only from the governing reschedule operation](./trusted-schedule-reasons-from-governing-reschedule-ops.md)
- [Persist adaptive attention intervals as bounded, undoable scheduler state](./yield-adaptive-attention-interval-multiplier.md)
- [Capture review analytics facts in review logs without analytics tables](./review-analytics-data-capture-in-review-logs.md)
- [Attention scheduler recency needs separate last-seen and action clocks](../logic-errors/attention-scheduler-last-seen-clock-semantics.md)
