---
title: "Model queue time cost as an opt-in trusted read model"
date: 2026-06-12
category: architecture-patterns
module: queue-time-cost
problem_type: architecture_pattern
component: database
severity: medium
applies_when:
  - "A due-work surface needs minute estimates without moving scheduling or budget semantics into React"
  - "Card timing can be learned from durable review logs, but attention-work timing is not yet persisted"
  - "A queue read should expose heavier computed data only when a caller requests it"
  - "Consumers need confidence labels so default-priced estimates are not presented as fully learned"
related_components:
  - service_object
  - testing_framework
  - ipc-contract
tags: [queue, time-cost, read-model, review-logs, ipc, defaults, accessibility]
---

# Model queue time cost as an opt-in trusted read model

## Context

The Due queue already answers "what is actionable now"; T115 needed it to also answer "roughly how many minutes is that?" without turning the renderer into the owner of queue membership, review timing, or attention defaults.

The reusable split is: `QueueQuery` owns queue membership and filtering, while `TimeCostQuery` prices the resulting due universe as a read-only projection.

## Guidance

Keep time estimation as a main-process/local-db read model. The renderer should receive a typed estimate, not raw review logs, queue predicates, or card timing logic.

Cards can use durable learned timing from `review_logs`. Price a card bucket from recent valid total review time:

```ts
const totalReviewMs = promptMs + responseMs;
```

Bound the sample before trusting it. T115 uses only valid timings, only reviews at or before the queue clock, the most recent observations per bucket, and a minimum observation count before marking a bucket learned. Thin buckets fall back to documented card-kind defaults.

Attention-scheduled rows should use documented defaults until the app persists real elapsed attention-work telemetry. Do not infer source-reading or extract-cleaning time from row count, renderer state, or inbox-only heuristics.

Compute the aggregate from the full filtered due universe, not just visible rows:

```ts
queue.list({ asOf, limit: 1 }).timeCostSummary.pricedItemCount;
// equals the full filtered due count, not 1
```

That keeps virtualized or capped queue screens honest. A visible list can render a small subset while the header still prices all currently due work under the active filters.

Expose the estimate as opt-in:

```ts
appApi.listQueue({ includeTimeEstimate: true });
appApi.listQueue({ asOf, includeTimeEstimate: true });
```

Count-only consumers such as navigation badges should omit `includeTimeEstimate` and keep the lean queue response. Home and Queue opt in because they render minutes.

Classify audio cards from a valid parsed media reference, not from a non-null string. Malformed `media_ref` data should fall back to the underlying card kind instead of silently entering an audio bucket.

## Why This Matters

A queue time estimate is useful only if it prices the work the user actually faces. Estimating from visible rows undercounts overload, while pricing the unfiltered global queue ignores the user's active type, status, or concept filters. The correct scope is the full filtered due universe.

Keeping pricing main-side preserves Interleave's trusted boundary. The renderer never opens SQLite and never reconstructs queue eligibility. It formats an already-validated projection.

The learned/default confidence flag prevents false precision. Sparse timing history should be shown as approximate, with accessible wording that explains defaults are involved:

```ts
formatQueueTimeEstimate({
  confidence: "default",
  totalMinutes: 19,
  pricedItemCount: 4,
  items: [],
});
// text: "~19 min"
// ariaLabel: "About 19 minutes; some estimates use defaults."
```

The `asOf` bound also matters. A queue rendered for a fixed or historical clock must not learn from reviews that happened after that clock.

## When to Apply

- The derived model depends on multiple local tables or trusted queue predicates.
- The result must respect queue filters and fixed clocks.
- Some parts of the estimate are learned and other parts use documented defaults.
- The UI needs compact, accessible approximate text instead of exact-looking numbers.
- The computation is heavier than a count and should not run for every badge or count-only refresh.

Do not use this pattern for mutations. A queue time estimate is read-only; it should not mutate schedules, budgets, review state, or `operation_log`.

## Examples

The main-process composition should keep membership and pricing separate:

```ts
const data = queueQuery.list({ asOf, filters });
const timeEstimate = request.includeTimeEstimate
  ? timeCostQuery.estimateQueue(data.timeCostSummary, {
      asOf,
      visibleItems: data.items.map(({ id, type, stage }) => ({ id, type, stage })),
    })
  : undefined;
```

Tests should cover the boundary, not just the formatter:

- `time-cost-query.test.ts` covers learned medians, defaults, `asOf`, malformed media refs, and read-only behavior.
- `queue-query.test.ts` covers full filtered due-universe summaries even when visible rows are limited.
- Contract, preload, and app API tests cover the opt-in IPC surface.
- Home and Queue tests cover accessible rendering.
- Electron Queue E2E verifies the native app route renders due rows and estimate text.

## Related

- [Capture review analytics facts in review logs without analytics tables](review-analytics-data-capture-in-review-logs.md)
- [Daily work read models should keep inbox-only routing out of due queue actions](../ui-bugs/daily-work-read-model-inbox-only-routing.md)
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
- [Trusted schedule reasons come from governing reschedule operations](trusted-schedule-reasons-from-governing-reschedule-ops.md)
- [Yield-adaptive attention intervals need bounded, explainable scheduler state](yield-adaptive-attention-interval-multiplier.md)
