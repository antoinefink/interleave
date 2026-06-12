---
title: "Persist adaptive attention intervals as bounded, undoable scheduler state"
date: "2026-06-12"
last_updated: "2026-06-12"
category: "docs/solutions/architecture-patterns"
module: "packages/scheduler"
problem_type: "architecture_pattern"
component: "service_object"
severity: "medium"
applies_when:
  - "Adding adaptive scheduler behavior that changes persisted cadence or due dates"
  - "Introducing behavior that should be OFF by default behind a typed setting"
  - "Persisting scheduler decisions that must remain transactional and undoable"
  - "Recording adaptive diagnostics in operation_log payloads for auditability"
  - "Clamping learned multipliers to preserve predictable scheduling bounds"
tags:
  - "adaptive-scheduling"
  - "attention-scheduler"
  - "operation-log"
  - "undo"
  - "sqlite"
  - "typed-settings"
  - "feature-flag"
  - "diagnostics"
---

# Persist adaptive attention intervals as bounded, undoable scheduler state

## Context

T112 added yield-adaptive attention intervals without changing default scheduler behavior. The
durable pattern is to persist only a bounded per-element multiplier, keep learned behavior gated
until UI explainability exists, compute changes from command-scoped yield deltas, and write enough
`operation_log` diagnostics and preimages for explainability and undo.

T113 completed the explanation path and flipped adaptive attention intervals on by default. Keep
the T112 persistence pattern paired with the T113 trusted schedule-reason projection before making
new learned scheduler behavior default-on.

The implementation touches four boundaries:

- typed settings in `packages/core/src/settings.ts`;
- persisted element state and migration files in `packages/db`;
- pure interval math in `packages/scheduler/src/attention-scheduler.ts`;
- transactional application, diagnostics, and undo in `packages/local-db`.

## Guidance

Adaptive scheduler learning should be small, explicit, and invertible.

Persist the learning state on the element, not as an unbounded history fold:

```ts
attentionIntervalMultiplier: real("attention_interval_multiplier")
  .notNull()
  .default(1.0)
```

Gate learned behavior through typed app settings until the UI can explain the learned schedule:

```ts
// T112 before schedule explainability shipped
adaptiveAttentionIntervals: false;

// T113 after trusted schedule reasons reached queue, home, and inspector surfaces
adaptiveAttentionIntervals: true;
```

Only adaptive source/extract processing commands should feed the multiplier. The scheduler service
captures a baseline before the command, reads counters after the command, and computes a
nonnegative delta:

```ts
const before = baseline ?? previousPayload?.counters.after ?? after;
const delta = deltaCounters(before, after);
```

Record the reason and compact counter evidence in `operation_log`, together with the schedule
write:

```ts
attentionAdaptive: {
  version: 1,
  enabled: true,
  settingKey: "scheduler.adaptiveAttentionIntervals",
  reason,
  priorMultiplier,
  newMultiplier,
  counters: { before, after, delta },
}
```

When the schedule write changes the multiplier, include the previous multiplier in the same
`reschedule_element` payload so global undo can restore it:

```ts
{
  attentionIntervalMultiplier: options.attentionIntervalMultiplier,
  prevAttentionIntervalMultiplier,
}
```

## Why This Matters

Adaptive scheduling can easily become invisible global drift. If it consumes lifetime yield, scans
the whole library, or stores only the new due date, future diagnostics cannot explain why an item
returned sooner or later.

The T112 pattern keeps the behavior auditable:

- The multiplier is bounded, so adaptation cannot run away.
- The setting is typed and off by default, so the legacy scheduler path remains stable until
  explicitly enabled.
- Deltas come from the command that just produced value, not from broad lifetime analytics.
- `operation_log` carries both diagnostic evidence and undo preimages.
- Cards remain outside this path; FSRS still owns active-recall scheduling.

## When to Apply

- Source/extract attention scheduling learns from user processing work.
- Command-shaped actions such as `extract` or `rewrite` create durable yield evidence.
- A feature needs future explainability, diagnostics, restart durability, and undo.
- Yield signals come from durable lineage, block processing, extract fates, cards, or synthesis
  references.

Do not apply this pattern to FSRS card scheduling, renderer-only heuristics, read-only analytics
views, lifetime rollups treated as one visit, or ungated behavior changes that would alter existing
scheduling by default.

## Examples

Source extraction captures a baseline before creating the extract, then reschedules the source
inside the same transaction after durable block/yield state changes:

```ts
const sourceBaseline =
  locationSource === input.sourceElementId
    ? this.scheduler.captureAdaptiveVisitBaseline(input.sourceElementId, "extract")
    : null;

this.scheduler.rescheduleProcessedVisitWithin(
  tx,
  input.sourceElementId,
  "extract",
  scheduledAt,
  sourceBaseline,
);
```

Extract stage changes use the same scheduler-owned baseline shape for `rewrite`:

```ts
const baseline = this.scheduler.captureAdaptiveVisitBaseline(id, "rewrite");
```

The pure scheduler computes one bounded step and returns diagnostics; it does not write database
state. The local-db service persists the result transactionally with the schedule and uses a
bounded latest-adaptive-payload lookup rather than scanning the full element history every visit.

Verification for T112 passed:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm e2e tests/electron/extraction.spec.ts tests/electron/extract-review.spec.ts`

## Related

- [Attention scheduler recency needs separate last-seen and action clocks](../logic-errors/attention-scheduler-last-seen-clock-semantics.md) is the predecessor learning for T111 clock semantics.
- [Trust schedule reasons only from the governing reschedule operation](./trusted-schedule-reasons-from-governing-reschedule-ops.md) is the T113 follow-on that explains learned and heuristic schedule changes safely enough to make adaptive intervals default-on.
- [Track source block processing as durable source-scoped state](./durable-source-block-processing-state.md) defines durable source-processing inputs that scheduler adaptation can consume.
- [Model honorable non-card extract fates as first-class value output](./extract-fates-value-model-v2-source-yield-stagnation.md) defines yield semantics beyond card creation.
- [Chronic postpone reckoning from operation-log reset markers](./chronic-postpone-reckoning-from-operation-log-reset-markers.md) documents operation-log-derived scheduler state.
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md) documents scheduler state diagnostics and undo preimage expectations.
- [Drizzle migrator tracks only a high-water mark](../database-issues/drizzle-migrator-high-water-mark-skips-out-of-order-migrations.md) is the migration-ordering guardrail to remember when adding scheduler state columns.
