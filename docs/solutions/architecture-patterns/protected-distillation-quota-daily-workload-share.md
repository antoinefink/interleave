---
title: "Protected distillation quotas should reserve daily minutes before trimming due work"
date: "2026-06-13"
category: "architecture-patterns"
module: "queue-distillation-quota"
problem_type: "architecture_pattern"
component: "service_object"
severity: "medium"
applies_when:
  - "Daily work composition must keep extract distillation from being crowded out by card review load."
  - "A configurable share of a minute budget should protect a class of due work without making the renderer own queue policy."
  - "Auto-postpone and session assembly both need to respect the same protected due-work floor."
related_components:
  - "database"
  - "frontend_stimulus"
  - "testing_framework"
tags:
  - "queue"
  - "distillation"
  - "daily-budget"
  - "auto-postpone"
  - "session-assembly"
  - "time-cost"
  - "ipc"
---

# Protected distillation quotas should reserve daily minutes before trimming due work

## Context

T119 added a protected distillation quota so heavy card load cannot silently starve extract processing. The setting is a user-facing share of the Daily budget, but the behavior spans scheduler composition, queue read models, auto-postpone protection, typed IPC, and renderer-only display.

The reusable split is: quota math belongs in trusted scheduler and local-db services, while React displays the resulting composition and sends only validated setting changes.

## Guidance

Keep the canonical quota helpers in the pure scheduler layer. A quota candidate should be defined by the actual due-work type plus the extract distillation stage, not by renderer labels or display grouping:

```ts
isDistillationQuotaCandidate(candidate)
// true only for extract work in an extract distillation stage
```

Session planning should reserve quota-eligible extract minutes first, fill the rest by the existing score order, then return the share when the due extract backlog is empty:

```ts
const plan = planSession(candidates, {
  targetMinutes,
  distillationQuotaPercent,
  distillationQuotaApplies: filtersAllowExtracts,
});
```

Compute day composition from the same full time-estimated due universe used by queue and session planning. It can respect durable user filters, but it must not use visible rows, pagination windows, or a deck after the first fill pass has already crowded out extracts.

For mutation planners, apply the same floor before choosing victims. Auto-postpone can move lower-value work until the day is closer to budget, but it should skip quota-eligible extract victims when moving them would drop remaining due distillation below the protected floor.

Expose the floor as metadata on previews, applied receipts, and standing-policy receipts. That keeps the user-visible explanation tied to the same calculation that protected the work:

```ts
{
  distillationFloor: {
    quotaFloorMinutes,
    dueDistillationMinutes,
    remainingDistillationMinutes
  }
}
```

Renderer components should render trusted composition only. Settings may update `distillationQuotaPercent`; queue gauges, session previews, and process summaries should not recompute eligibility, pricing, or quota state from local row lists.

## Why This Matters

Protected quota is a composition rule, not a score tweak. Mutating the score would make the queue order harder to reason about and would not automatically protect due extracts from trimming. Reserving a floor at planning time keeps priority order intact within each bucket while still guaranteeing some conversion throughput.

The full-due-universe boundary is the load-bearing part. If composition uses visible rows, a display limit can hide due extracts and falsely return the share to cards. If it uses already-fit session candidates, a card-heavy fill can erase the exact extract work the quota exists to protect. Then the queue gauge, session preview, and auto-postpone receipt disagree about what the day contains.

Keeping the calculation main-side also preserves Interleave's trust boundary. The renderer never opens SQLite, never derives due eligibility, and never decides which work is protected from postponement.

## When to Apply

- A budget, quota, protection floor, or composition summary is derived from current due work.
- The quota protects one class of due work while preserving score order inside that class.
- A read model and a mutation planner must agree on the same filtered due universe.
- The UI can filter queue membership, but display limits or virtualized rows should not affect planning math.
- A standing policy writes durable receipts that need to explain which protected floor was applied.

Do not apply this pattern by making the renderer split visible cards and extracts. That produces a display summary, not a protected workload policy.

## Examples

The daily queue read can keep visible rows and full-pricing rows separate:

```ts
const data = queueQuery.list({ filters });
const fullEstimate = timeCostQuery.estimateQueue(data.timeCostSummary, {
  visibleItems: data.timeCostItems,
});

const visibleEstimateItems = fullEstimate.items.filter((item) =>
  data.items.some((visible) => visible.id === item.id)
);

const dayComposition = planSession(fullEstimate.items, {
  targetMinutes: settings.dailyBudgetMinutes,
  distillationQuotaPercent: settings.distillationQuotaPercent,
  distillationQuotaApplies: filtersAllowExtracts,
}).composition;
```

Tests should pin the boundaries separately:

- settings tests cover quota defaulting, bounds, persistence, and IPC validation;
- pure scheduler tests cover active quota, empty-backlog return, inactive filters, zero target, and invalid estimates;
- auto-postpone tests cover protecting extract victims at the floor;
- local-db tests cover full filtered due-universe composition and standing receipt metadata;
- renderer tests cover settings, budget split, session preview copy, and accepted-session summary;
- Electron coverage should open an overloaded day and prove mixed card/distillation composition is visible.

## Related

- [Model queue time cost as an opt-in trusted read model](./queue-time-cost-read-model.md)
- [Minute-denominated overload budgets should price the full due universe](./minute-denominated-overload-budget.md)
- [Assemble minute-sized sessions as read-only queue plans with one-shot deck handoff](./session-assembly-read-model-accepted-deck-handoff.md)
- [Standing auto-postpone uses trusted current-day materialization](./standing-auto-postpone-trusted-current-day-materialization.md)
- [Queue eligibility must be canonical across inventory, actions, and undo](../logic-errors/queue-eligibility-inventory-scheduler-state.md)
