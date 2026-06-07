---
title: "Command Palette Source Search"
type: "feat"
status: "completed"
date: "2026-06-07"
---

# Command Palette Source Search

## Summary

Add live source search to the existing command palette. When the user types in the top command/search affordance, the current command/navigation links remain visible above a source-only result section; selecting a result opens that source in the reader.

## Problem Frame

The shell advertises "Search, import, or run command..." but the palette currently searches only static command entries. The full `/search` page works, but the topbar affordance does not provide quick in-place results, so the label over-promises.

## Requirements

- R1. Typing in the `⌘K` palette must show current command/navigation rows above live source results.
- R2. Live palette results must search only sources, not extracts, cards, concepts, tags, or semantic results.
- R3. Selecting a source result must navigate to `/source/$id` and close the palette.
- R4. Empty input must preserve the existing command-palette behavior without issuing source search requests.
- R5. Loading, empty, error, non-desktop, and stale async responses must not hide the command/navigation rows.
- R6. The design must use existing command-palette visual primitives and design tokens.

## Key Technical Decisions

- **Use the existing search bridge:** Call `appApi.searchQuery({ q, type: "source", limit, includeCounts: false })` from the renderer rather than adding a backend endpoint. `apps/desktop/src/shared/contract.ts` already validates `type: "source"`, and `packages/local-db/src/search-repository.ts` already narrows FTS to sources. The optional `includeCounts` flag keeps full `/search` facet counts as the default while letting compact palette lookup skip unused count work.
- **Keep command links pinned above results:** The palette should keep matching command/navigation items first and append a "Sources" section below them once the trimmed query is non-empty. This matches the user's "above current links, below search results" intent while preserving keyboard predictability.
- **Do not use semantic search:** Palette lookup is meant as fast source finding. Semantic, extract/card, and faceted search remain owned by `/search`.
- **Keep renderer logic UI-only:** React may manage query/debounce/loading/selection state, but SQL, ranking, FTS sanitization, and source row enrichment stay behind `window.appApi.search.query`.

## Implementation Units

### U1. Palette Source Search

- **Goal:** Extend the existing command palette so typed queries fetch source-only hits and render them below current command/navigation links.
- **Files:** Modify `apps/web/src/shell/CommandPalette.tsx`, `apps/web/src/shell/Shell.tsx`, and `apps/web/src/shell/shell.css`.
- **Patterns:** Follow `apps/web/src/library/LibraryScreen.tsx` for debounced search and stale-response guards; follow existing `shell-cmdk__group` and `shell-cmdk__item` classes for layout.
- **Test scenarios:** Empty input shows commands only and does not search; typing calls source search with `type: "source"`; source rows render below command rows; selecting a source navigates to `/source/$id`; stale responses cannot overwrite newer query results; source-search failures render a calm source-section state while command rows remain usable.
- **Verification:** `apps/web/src/shell/CommandPalette.test.tsx` passes.

### U2. Boundary and Design Verification

- **Goal:** Prove the implementation reuses the typed renderer bridge and preserves the existing shell design.
- **Files:** Modify `apps/web/src/shell/CommandPalette.test.tsx`; inspect `apps/web/src/lib/appApi.ts`, `apps/desktop/src/shared/contract.ts`, and `packages/local-db/src/search-repository.ts` without changing them unless tests reveal a gap.
- **Patterns:** Keep source result rows compact and token-based; use existing icons from `apps/web/src/components/Icon.tsx`.
- **Test scenarios:** The palette does not issue raw database or filesystem calls; the search request includes a limit; non-source result types are ignored defensively if a malformed bridge response appears.
- **Verification:** Targeted web shell tests pass, followed by `pnpm typecheck`, `pnpm test`, and `pnpm lint`.

## Scope Boundaries

- Do not change `/search` result semantics, facets, semantic search, or collection browsing.
- Do not add a new IPC channel, repository method, schema change, or migration unless the existing `search.query` bridge proves insufficient.
- Do not search author, URL, canonical URL, or provenance fields; current source FTS covers source title, document plain text, and tags.

## Sources

- `apps/web/src/shell/CommandPalette.tsx` currently filters static command items only.
- `apps/web/src/shell/Shell.tsx` renders the top command bar copy.
- `apps/web/src/lib/appApi.ts` exposes `appApi.searchQuery`.
- `apps/desktop/src/shared/contract.ts` validates `SearchQueryRequestSchema`.
- `packages/local-db/src/search-repository.ts` implements source-only FTS via `type: "source"`.
- `docs/solutions/ui-bugs/search-filterbar-facet-counts-after-search.md` and `docs/solutions/ui-bugs/search-empty-query-facets-browse-rows.md` document search count and renderer-boundary invariants.
