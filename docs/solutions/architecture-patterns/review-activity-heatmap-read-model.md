---
title: Build review activity heatmaps as trusted analytics read models
date: 2026-06-07
category: architecture-patterns
module: analytics
problem_type: architecture_pattern
component: database
severity: medium
related_components:
  - "service_object"
  - "frontend_stimulus"
  - "testing_framework"
applies_when:
  - "A renderer analytics surface needs calendar-day activity from durable review logs."
  - "A yearly grid must preserve local calendar semantics across IPC."
  - "A read-only analytics feature spans local-db, Electron main/preload, and React UI."
tags: [analytics, review-logs, heatmap, ipc, local-day, stale-response-guard, e2e]
---

# Build review activity heatmaps as trusted analytics read models

## Context

Interleave needed a GitHub-style Analytics review activity heatmap showing a full local calendar year of card review activity. The feature crossed the durable review log store, the Electron IPC boundary, the typed renderer API, and a dense desktop Analytics UI.

The hardening work after review clarified that this should not be a chart-only React feature. It is a read-only analytics model rooted in review logs, shaped on the trusted side, then rendered by React from a stable, zero-filled payload.

## Guidance

Keep yearly review activity aggregation in `packages/local-db`, not in React. `packages/local-db/src/analytics-query.ts` defines `computeReviewActivity(asOf, { year? })`, returns one bucket per local calendar day, and exposes sparse year navigation metadata: `minYear`, `maxYear`, `previousYear`, and `nextYear`.

Use local calendar bounds explicitly. The selected year is `[Jan 1 00:00, next Jan 1 00:00)` in local time, then each day is counted with a bounded SQL `COUNT(*)` range against `review_logs.reviewed_at`. Do not use SQLite UTC date grouping for user-facing calendar days, and do not materialize a year of review logs into JS just to count them.

Validate the full IPC path. The contract in `apps/desktop/src/shared/contract.ts` adds `AnalyticsReviewActivityRequestSchema` with `IsoTimestampInputSchema.optional()` and `year: z.number().int().min(1000).max(9998).optional()`. The channel is `analytics:reviewActivity` in `apps/desktop/src/shared/channels.ts`, parsed in `apps/desktop/src/main/ipc.ts`, served by `DbService.getReviewActivity()` in `apps/desktop/src/main/db-service.ts`, exposed in `apps/desktop/src/preload/index.ts`, and wrapped as `appApi.getReviewActivity()` in `apps/web/src/lib/appApi.ts`.

Render from the read model. `apps/web/src/analytics/ReviewActivityHeatmap.tsx` builds weeks/month labels from already zero-filled days, renders accessible day cells with `data-date` and `data-count`, uses FSRS scheduler color tokens for intensity, and shows previous/next arrows only when the backend returns concrete target years.

Harden async UI state. `apps/web/src/analytics/AnalyticsScreen.tsx` uses a request-id guard so out-of-order year loads cannot overwrite newer activity. On a failed reload, it clears stale heatmap data while keeping the rest of the Analytics screen visible.

## Why This Matters

Review activity is source-of-truth analytics, not decorative UI state. If React groups raw logs, the renderer owns calendar semantics it should not own, risks stale or race-prone year switches, and can accidentally drift from the durable local database behavior.

The trusted read-model approach preserves Interleave's core constraints:

- SQLite remains canonical for review logs.
- The renderer never gets raw DB access.
- Local calendar days match what the user expects.
- Empty years and empty days are intentional, not missing data.
- The heatmap remains fast even as years of review history accumulate.
- The feature survives app restart because it is recomputed from durable review logs.

## When to Apply

- Yearly or calendar-day review history.
- Queue or scheduling analytics with local-day semantics.
- UI navigation that depends on sparse historical data.
- Renderer surfaces where stale async responses could show the wrong year.
- Any feature where a tempting React-only implementation would require raw rows from SQLite.

Do not append `operation_log` entries for these reads. They are analytics queries, not mutations.

## Examples

Local-db aggregation shape:

```ts
// packages/local-db/src/analytics-query.ts
computeReviewActivity(asOf, { year }) {
  const selectedYear = assertReviewActivityYear(year ?? localYear(asOf));
  const yearStart = startOfLocalYear(selectedYear);
  const nextYearStart = startOfLocalYear(selectedYear + 1);

  for (const d = new Date(yearStart); d < nextYearStart; d.setDate(d.getDate() + 1)) {
    const nextDay = new Date(d);
    nextDay.setDate(nextDay.getDate() + 1);
    countReviewsInRange(d.toISOString(), nextDay.toISOString());
  }
}
```

IPC validation shape:

```ts
// apps/desktop/src/shared/contract.ts
export const AnalyticsReviewActivityRequestSchema = z
  .object({
    asOf: IsoTimestampInputSchema.optional(),
    year: z.number().int().min(1000).max(9998).optional(),
  })
  .optional();
```

Renderer stale-response guard:

```ts
// apps/web/src/analytics/AnalyticsScreen.tsx
const requestId = activityRequestId.current + 1;
activityRequestId.current = requestId;

const res = await appApi.getReviewActivity(year === undefined ? undefined : { year });
if (activityRequestId.current !== requestId) return;
setActivity(res);
```

Tests should cover the whole path:

- `packages/local-db/src/analytics-query.test.ts`: 365/366 buckets, exclusive local-year bounds, empty history, sparse previous/next years, invalid year rejection.
- `apps/desktop/src/shared/contract.test.ts`, `channels.test.ts`, `preload/index.test.ts`, and `main/db-service.test.ts`: contract, channel, bridge, and service shape.
- `apps/web/src/lib/appApi.test.ts`: renderer wrapper forwarding and typed result shape.
- `apps/web/src/analytics/AnalyticsScreen.test.tsx`: year arrows, stale-response guard, failed reload clearing stale activity, and empty-year rendering.
- `tests/electron/analytics.spec.ts`: real Electron bridge availability, no `db.query`, heatmap rendering, review grading incrementing activity, and restart persistence.

Visual verification should include at least one screenshot or browser harness pass proving the panel sits above Reviews per Day, renders the expected cell count, exposes the legend, and aligns with the analytics panel styling.

## Related

- `docs/solutions/ui-bugs/search-filterbar-facet-counts-after-search.md` — closest precedent for trusted aggregation feeding typed renderer counts plus stale response guards.
- `docs/solutions/ui-bugs/balance-banner-queue-inbox-action-gating.md` — analytics/actionable-count precedent for keeping computed counts behind main-side contracts.
- `docs/solutions/ui-bugs/command-palette-source-lookup-search-query.md` — typed bridge and request-id guard precedent for async renderer reads.
- `docs/solutions/architecture-patterns/extract-card-ipc-invariant-test-hardening.md` — IPC validation and boundary test-hardening precedent.
- `docs/solutions/architecture-patterns/test-audit-driven-battle-testing.md` — broad test-hardening precedent for `window.appApi`, persistence, and restart behavior.
