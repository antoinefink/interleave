---
title: Review Activity Heatmap
type: feat
status: active
date: 2026-06-07
---

# Review Activity Heatmap

## Summary

Add a full-width GitHub-style review activity heatmap to the Analytics screen above
`Reviews per day`. The heatmap shows one calendar year of review-log activity, supports
previous/next year navigation when historical data exists, and keeps the existing
30-day analytics metrics unchanged.

## Problem Frame

The Analytics page currently shows a 30-day bar spark and a day-streak metric, but it
does not let users see long-term review consistency, dense review periods, gaps, or
older-year activity. The new panel should make the review habit visible without
turning Analytics into a different workflow surface.

## User Request

The user asked for a new full-width Analytics section above `Reviews per Day` that
works like the GitHub contribution heatmap, colors days by review count, and provides
arrows to move backward and forward when older review years exist. Visual consistency
with the existing app and a GitHub-style heatmap are required.

## Requirements

- R1. Render a new full-width `Review activity` panel inside the existing Analytics
  column, directly above `Reviews per day`.
- R2. Show a GitHub-style day grid for the selected calendar year, with color
  intensity based on review count.
- R3. Preserve local-calendar bucketing from the domain layer; the renderer must not
  read SQLite or infer review counts from raw data.
- R4. Provide previous and next year arrow controls only when those years are relevant
  based on available review history.
- R5. Keep existing 30-day metrics and the `Reviews per day` spark semantics unchanged.
- R6. Use app tokens and analytics panel chrome so light and dark themes remain aligned
  with the current product design.
- R7. Ship tests for domain bucketing, bridge contract shape, renderer placement and
  navigation, and the persistence-backed desktop service read.

## Key Technical Decisions

- **Dedicated activity read:** Add a typed `analytics.reviewActivity` read rather than
  calling `analytics.get({ windowDays: 365 })`. A true calendar-year heatmap needs
  leap-year support and year navigation, while `analytics.get` is the 30-day summary
  contract used by Home and the existing Analytics metrics.
- **Main-side aggregation:** Bucket review counts in `packages/local-db` from
  `review_logs.reviewed_at`, using the same local-day strategy as
  `AnalyticsService.computeAnalytics`. React receives zero-filled day counts and
  min/max navigation bounds.
- **Calendar-year navigation:** Return `year`, `minYear`, and `maxYear` from the typed
  read for context, plus explicit `previousYear` and `nextYear` targets for sparse
  history. The UI disables arrows from those explicit targets instead of walking
  through empty in-range years.
- **Calendar-year contract:** The selected year covers the local interval
  `[Jan 1 00:00, next Jan 1 00:00)`, with an exclusive upper bound. Omitted `year`
  defaults to the local year of `asOf`; min/max and previous/next years are derived
  by converting review timestamps through local-date logic, not UTC substrings.
- **Presentation-only heatmap layout:** React may arrange the returned day buckets into
  weeks and month labels for display, but all review counts and navigation relevance
  come from the typed app API.
- **FSRS-green intensity:** Use `--sched-fsrs` with token-based `color-mix()` levels,
  because reviews are card-memory activity and the color echoes the GitHub heatmap
  without hard-coding GitHub colors.

## Scope Boundaries

- Do not change the existing 30-day retention, streak, due, throughput, or spark
  calculations.
- Do not add drilldown behavior when clicking heatmap cells.
- Do not add new database tables or migrations; `review_logs.reviewed_at` is already
  indexed for this read path.
- Do not expose generic database or filesystem access to the renderer.

## Implementation Units

### U1. Add Review Activity Aggregation

- **Goal:** Extend `AnalyticsService` with a read-only calendar-year activity query.
- **Files:** Modify `packages/local-db/src/analytics-query.ts`; modify
  `packages/local-db/src/analytics-query.test.ts`.
- **Patterns:** Follow `computeAnalytics` local-day bucketing and zero-fill behavior.
- **Test Scenarios:** A selected year returns one bucket per calendar day; leap-year
  years return 366 buckets; reviews on year boundaries land in the right year; empty
  history returns a selected year with zero counts and no arrow targets; min/max years
  reflect the full review-log history; sparse history returns previous/next targets
  that skip years with no reviews.
- **Verification:** Targeted local-db analytics tests pass.

### U2. Thread the Typed Bridge Contract

- **Goal:** Expose `analytics.reviewActivity({ asOf?, year? })` through the existing
  Electron preload and renderer `appApi` wrapper.
- **Files:** Modify `apps/desktop/src/shared/contract.ts`,
  `apps/desktop/src/shared/channels.ts`, `apps/desktop/src/shared/contract.test.ts`,
  `apps/desktop/src/shared/channels.test.ts`,
  `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/db-service.ts`,
  `apps/desktop/src/main/db-service.test.ts`, `apps/desktop/src/preload/index.ts`,
  `apps/desktop/src/preload/index.test.ts`, `apps/web/src/lib/appApi.ts`, and
  `apps/web/src/lib/appApi.test.ts`.
- **Patterns:** Mirror the existing `analytics.get` request validation, IPC handler,
  preload surface, and renderer wrapper naming.
- **Test Scenarios:** Request schema accepts omitted year/asOf and rejects invalid year;
  channel inventory includes the new IPC channel; `DbService` returns year/day counts;
  a persisted review grade is visible after reopening the same database.
- **Verification:** Desktop contract and db-service tests pass.

### U3. Render the Analytics Heatmap

- **Goal:** Add the `Review activity` panel above `Reviews per day`, with year arrows,
  accessible cell labels, month/weekday labels, and token-aligned intensity levels.
- **Files:** Modify `apps/web/src/analytics/AnalyticsScreen.tsx`,
  `apps/web/src/analytics/analytics.css`, and
  `apps/web/src/analytics/AnalyticsScreen.test.tsx`; create
  `apps/web/src/analytics/ReviewActivityHeatmap.tsx` if the component is large enough
  to keep `AnalyticsScreen` readable.
- **Patterns:** Reuse `.an-panel`, `.an-panel__head`, `.an-panel__title`, and
  `.an-panel__meta`; add heatmap-specific classes only to avoid bleeding into Home's
  reused analytics CSS. Keep heatmap state separate from the existing `load()` path:
  `activity`, `activityLoading`, `activityError`, and `loadActivity(year)` so a heatmap
  failure never blanks the existing Analytics metrics.
- **Test Scenarios:** The panel renders before the spark; it renders one cell per
  returned day; intensity classes are assigned for zero and non-zero counts; previous
  and next arrows are disabled according to min/max bounds; clicking an enabled arrow
  refetches that year; empty activity renders intentionally.
- **Verification:** Renderer analytics tests pass.

### U4. Visual and End-to-End Verification

- **Goal:** Prove the heatmap works and fits the app visually.
- **Files:** Update Electron/Playwright coverage if an existing analytics test route is
  present; otherwise rely on targeted renderer/domain/desktop tests plus manual browser
  visual inspection.
- **Patterns:** Use the Electron desktop app for full fidelity when feasible; the bare
  renderer is acceptable only for isolated visual layout because live data comes from
  `window.appApi`.
- **Test Scenarios:** Light and dark themes remain legible; the year grid does not
  overflow incoherently at desktop width; a review created through the app persists and
  appears after restart when covered by the existing test harness.
- **Verification:** `pnpm typecheck`, `pnpm test`, relevant Electron/Playwright tests,
  and a visual screenshot pass.

## Risks & Dependencies

- Calendar and DST edge cases are the main correctness risk; tests should seed local-noon
  timestamps and explicit boundary timestamps.
- The activity query must remain cheap on large review histories; use indexed
  `reviewed_at` range queries and cheap min/max reads.
- `analytics.css` is imported by Home, so generic analytics classes should stay stable.
- Year navigation can confuse users if the selected year is not obvious; the panel meta
  should name the year and total review count.

## Sources / Research

- `apps/web/src/analytics/AnalyticsScreen.tsx` — existing Analytics layout and placement.
- `apps/web/src/analytics/analytics.css` — existing Analytics panel, metric, and spark
  styling.
- `packages/local-db/src/analytics-query.ts` — local-day review bucketing pattern.
- `apps/desktop/src/shared/contract.ts` — typed analytics IPC contract.
- `design/kit/app/screen-analytics.jsx` and `docs/design-system.md` — Analytics visual
  source of truth.
