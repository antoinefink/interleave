---
title: Fix Search Filterbar Counts
type: fix
status: completed
date: 2026-06-06
---

# Fix Search Filterbar Counts

## Summary

When a keyword search runs on `/search`, every left filterbar counter should reflect the active search result universe. The fix extends the existing FTS-backed search count pass so Type, Concept, and Priority chips are all filter-aware without adding renderer-side SQL, extra per-chip calls, or client-only result scans.

---

## Problem Frame

`apps/web/src/library/LibraryScreen.tsx` already requests `SearchQueryResult.counts.byConcept` from `apps/desktop/src/main/db-service.ts`, but the Type and Priority filter rows on `/search` do not render live counters. The user sees stale or absent numbers for “Sources”, “Extracts”, “Cards”, and priority chips after searching, while the result sections update.

---

## Requirements

- R1. A keyword search updates Type counters for Sources, Extracts, and Cards to the counts that would be shown if that type were selected with the same keyword and other active facets.
- R2. A keyword search updates Priority counters for A, B, C, and D to the counts that would be shown if that priority were selected with the same keyword and other active facets.
- R3. Existing Concept counters keep their drill-down behavior and remain synchronized with Type and Priority filters.
- R4. Count computation stays main-side behind the typed `window.appApi.search.query` bridge; the renderer does not compute domain counts from SQLite or issue per-chip requests.
- R5. The implementation preserves search performance by reusing the existing bounded FTS count scan and live concept-membership map instead of adding N+1 queries.

---

## Key Technical Decisions

- **Extend `SearchCounts`:** Add `byType` and `byPriority` to `SearchQueryResult.counts` beside `byConcept`, matching the drill-down count model used by `LibraryQuery`.
- **Compute all facets from one count universe:** In `DbService.search`, take one bounded un-narrowed FTS match set for the keyword and fold it through type, priority, and concept predicates. This reuses the existing high-performance shape for concept counts.
- **Keep result search and count search separate:** The displayed result list remains capped by the normal request limit. The count universe continues to use the higher safety cap, so counters are useful for broad searches without making the UI render thousands of rows.
- **Render counters only on the keyword `/search` filterbar:** `/library` already has browse counts. Maintenance rows on `/search` remain disabled and outside this bug fix.

---

## Implementation Units

### U1. Extend Search Counts Main-Side

- **Goal:** Return `byType`, `byConcept`, and `byPriority` from `search.query` using one bounded FTS count pass.
- **Files:** Modify `packages/local-db/src/search-repository.ts`, `apps/desktop/src/main/db-service.ts`, `apps/desktop/src/shared/contract.ts`, `apps/web/src/lib/appApi.ts` if generated/shared types require alignment.
- **Patterns:** Follow `packages/local-db/src/library-query.ts` for drill-down semantics and `packages/local-db/src/search-concept-counts.property.test.ts` for search count invariants.
- **Test Scenarios:** Type counts equal concept/priority-narrowed result rows when a type chip is selected; priority counts equal type/concept-narrowed result rows when a priority chip is selected; soft-deleted elements and dead concept endpoints do not inflate counts.
- **Verification:** `pnpm test --filter @interleave/local-db -- search-concept-counts` or the closest Vitest target for local-db search count tests passes.

### U2. Render Search Filterbar Counters

- **Goal:** Show live count spans for Type and Priority chips on `/search`, while Concept chips keep their no-query global-count fallback and query-time drill-down counts.
- **Files:** Modify `apps/web/src/library/LibraryScreen.tsx` and `apps/web/src/library/LibraryScreen.test.tsx`.
- **Patterns:** Mirror `apps/web/src/library/BrowseScreen.tsx` chip markup and count rendering.
- **Test Scenarios:** After a query, Sources/Extracts/Cards chips render backend `byType` counts; priority chips render backend `byPriority` counts; stale async search responses cannot leave counters from a different query.
- **Verification:** `pnpm test --filter @interleave/web -- LibraryScreen` or the closest Vitest target for `LibraryScreen.test.tsx` passes.

---

## Risks & Dependencies

- Broad queries can match more rows than the result cap, so the count scan must remain bounded by the existing search safety cap.
- Semantic search currently returns fused rows without faceted count metadata; if semantic mode is active, counters can only be exact for the FTS path unless the semantic contract is expanded later.

---

## Sources

- `apps/web/src/library/LibraryScreen.tsx`
- `apps/web/src/library/BrowseScreen.tsx`
- `apps/desktop/src/main/db-service.ts`
- `apps/desktop/src/shared/contract.ts`
- `packages/local-db/src/search-repository.ts`
- `packages/local-db/src/library-query.ts`
- `packages/local-db/src/search-concept-counts.property.test.ts`
