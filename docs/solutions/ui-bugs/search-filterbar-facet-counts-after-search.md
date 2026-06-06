---
title: Search filterbar facet counts after search
date: 2026-06-06
category: ui-bugs
module: search
problem_type: ui_bug
component: database
symptoms:
  - "Search filterbar counters for Type, Concept, and Priority stayed stale or incorrect after running a search"
  - "Search results and facet counts diverged on /search"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [search, facet-counts, filterbar, search-repository, library-screen, sql-aggregates]
---

# Search filterbar facet counts after search

## Problem

The `/search` page's left filterbar counters were not derived from the same filtered search universe as the result list. Type, Concept, and Priority chips could show zero, stale global counts, or counts that disagreed with the rows a chip would reveal.

## Symptoms

- Type chips did not show live backend counts after a keyword search.
- Concept chips could show global concept volume instead of query-scoped drill-down counts.
- Priority filtering could happen only in the renderer, so concept counts ignored the active priority facet.
- Semantic search could show result rows while clearing or zeroing the filterbar counts.
- Out-of-order search responses could leave counters from an older query.

## What Didn't Work

- Folding counts from display `search()` results looked reusable, but that path was ranking/snippet-oriented and originally materialized too many matches before applying the JavaScript result cap.
- Raising the count scan cap made narrow cases pass, but a capped count universe could still undercount broad queries.
- Clearing counts on the semantic path avoided claiming keyword counts for semantic results, but produced visible semantic rows with zeroed filter chips.
- Folding semantic counts from the active type-filtered result set undercounted inactive Type chips because those chips need counts from their own hypothetical searches.
- Keeping priority filtering in React made concept counts overstate the priority-narrowed result list.

## Solution

Use one shared `SearchCounts` contract across the desktop contract, renderer wrapper, DB service, and UI:

```ts
type SearchCounts = {
  byType: { source: number; extract: number; card: number };
  byConcept: Record<string, number>;
  byPriority: { A: number; B: number; C: number; D: number };
};
```

Thread `priorityLabel` through the search request and apply it main-side using the same A/B/C/D priority bands the UI renders.

For keyword search, compute exact facet counts in SQL instead of counting display rows:

```sql
WITH matched AS (<source_fts UNION extract_fts UNION card_fts>),
base AS (<live elements + all other active facets>)
SELECT type, COUNT(*) FROM base GROUP BY type;
```

Each count dimension drops only its own active predicate:

```ts
byType; // keyword + concept + priority, without type
byPriority; // keyword + type + concept, without priority
byConcept; // keyword + type + priority, without concept
```

Concept counts join through live concept endpoints and use distinct matched element ids, so duplicate membership edges and soft-deleted concepts do not inflate counts.

For semantic search, include `counts` in `SemanticSearchResult`. Count over the fused result universe for Concept and Priority, and populate Type counts by running the fused query per searchable type when a type filter is active. That keeps the visible semantic rows and the Type chips from disagreeing.

In the renderer, store one `searchCounts` object and update it with the same cancellation guard as `results`. Render Type, Concept, and Priority counts from it when a query exists; fall back to global concept volume only when there is no query.

## Why This Works

The filterbar and result list now share the same main-side filtering model. A chip count means: "how many rows would appear if this chip were selected while keeping the other active facets."

Keyword counters are exact aggregate queries, not capped display rows or renderer-side scans. Result search itself has a SQL `LIMIT`, so broad keyword searches do not materialize the full FTS match set in the main process before returning the first page.

## Prevention

- Keep `/search` facet counts main-side; do not derive domain counters in React.
- Preserve the drill-down invariant in tests:

```ts
counts.byType[t] === search({ ...filters, type: t }).results.length;
counts.byPriority[p] === search({ ...filters, priorityLabel: p }).results.length;
counts.byConcept[c] === search({ ...filters, conceptId: c }).results.length;
```

- Cover every seam where count shape can drift: shared contract, renderer wrapper, `DbService`, `SearchRepository`, `LibraryScreen`, property tests, and Electron E2E.
- Add semantic-specific tests: semantic results must return counts, and active type filters must still populate inactive Type chip counts.
- Update `results` and `counts` behind the same async cancellation guard so stale responses cannot partially overwrite the current query state.

## Related Issues

- Low-overlap related docs:
  - `docs/solutions/ui-bugs/active-card-rows-open-card-detail-surface.md`
  - `docs/solutions/ui-bugs/url-imported-articles-inbox-processing.md`
  - `docs/solutions/architecture-patterns/electron-main-rolling-backups-over-renderer-reminders.md`
- No matching GitHub issues were found for search filterbar facet counters.
