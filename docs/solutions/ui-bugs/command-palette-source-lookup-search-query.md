---
title: "Command palette source search should use compact typed search and reset stale async state"
date: "2026-06-07"
category: "ui-bugs"
module: "apps/web command palette source search"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "The command palette advertised search but only filtered static commands."
  - "Palette source lookup needed source-only results without full Search facet-count overhead."
  - "Rapid close and reopen could issue a stale source search before palette state reset."
root_cause: "async_timing"
resolution_type: "code_fix"
related_components:
  - "service_object"
  - "testing_framework"
tags:
  - "command-palette"
  - "source-search"
  - "search-query"
  - "include-counts"
  - "renderer-bridge"
  - "ipc"
  - "stale-response-guard"
  - "async-state"
---

# Command palette source search should use compact typed search and reset stale async state

## Problem

The shell command palette claimed users could search, but typing only filtered command rows. Adding live source lookup risked either duplicating search IPC or making a compact palette pay the full `/search` facet-count cost.

## Symptoms

- The top command/search affordance opened a palette that could not find sources directly.
- A palette lookup needed only a few source rows, but the general search path also computes Type, Concept, and Priority counts for the full Search screen.
- Closing and immediately reopening the palette after a completed query could let the old query and debounce state issue one stale IPC search before reset landed.

## What Didn't Work

- Adding a palette-specific search endpoint would duplicate the existing typed `search.query` bridge and create another search contract to keep in sync.
- Calling `search.query` without a compact mode worked functionally, but every palette query still paid for unused drill-down counts.
- Clearing only result state on query changes did not cover the close/reopen lifecycle because the old query and debounced query could still match on the first reopened render.

## Solution

Reuse the existing typed search bridge for compact lookup surfaces, but make count work optional:

```ts
appApi.searchQuery({
  q: debouncedQuery,
  type: "source",
  limit: 8,
  includeCounts: false,
});
```

Keep `includeCounts` optional and default-compatible. `/search` omits the flag and keeps exact facet counts. `DbService.search` skips only `facetCounts()` when `includeCounts === false`, returning `emptySearchFacetCounts()` while preserving the normal source-only filtering, result limit, row enrichment, and typed response shape.

In the palette, keep command rows independent from live source rows. Guard empty, whitespace, and one-character queries before crossing the bridge; debounce valid queries; filter malformed non-source bridge rows defensively; and reset `query`, `debouncedQuery`, selected index, source results, source status, and request id when the palette closes or opens.

Source rows use the existing reader route:

```ts
onNavigate("/source/$id", { params: { id: source.id } });
```

## Why This Works

The renderer still owns only UI state. Search semantics, FTS sanitization, ranking, source-only filtering, and row enrichment stay behind the typed `window.appApi` bridge.

The optional count flag avoids a new IPC surface while keeping the heavy `/search` count contract intact. Resetting the palette state on close invalidates pending debounce/search work before the next open, so stale queries cannot leak into a fresh palette session.

## Prevention

- For compact lookup UI, prefer extending an existing typed command with an explicit lightweight option before adding a parallel IPC endpoint.
- Do not use `includeCounts: false` on `/search`, filterbars, or any UI that renders Type, Concept, or Priority counts.
- Guard short queries before running broad FTS prefix searches from hot keyboard paths.
- For debounced overlays, reset query, debounce, result, status, selection, and request-id state on close as well as open.
- Test every boundary touched by lookup features: palette UI, Shell route params, renderer `appApi` forwarding, shared Zod contract, and `DbService` behavior.

## Related Issues

- `docs/solutions/ui-bugs/search-filterbar-facet-counts-after-search.md` covers the full `/search` count contract that compact lookup opts out of.
- `docs/solutions/ui-bugs/search-empty-query-facets-browse-rows.md` covers empty-input and stale-result guardrails for search-adjacent UI.
- `docs/solutions/architecture-patterns/collection-explorer-route-owned-modes.md` covers keeping compact Search intent distinct from Collection Explorer route modes.
- `docs/solutions/architecture-patterns/test-audit-driven-battle-testing.md` covers testing high-risk `window.appApi` seams.
