---
date: 2026-06-06
topic: collection-explorer
---

# Collection Explorer Requirements

## Summary

Interleave should present Library and Search as two explicit modes inside one shared Collection Explorer. `/library` opens Browse mode, `/search` opens Search mode, and both entry points keep their distinct user intent while sharing layout, interaction patterns, and terminology.

---

## Problem Frame

Library and Search currently overlap in visual structure but differ in purpose. Search is for retrieving source, extract, and card content by keyword or semantic match. Library is for browsing the whole live collection by facets, including elements that keyword search does not cover.

The current separation is defensible, but the product surface feels blurry because both screens use similar rows and filters, Search already borrows browse behavior in some empty-query states, and some navigation copy points users to Search while calling it Library. The integration should make the mental model clearer, not hide the real differences between retrieval and inventory.

---

## Key Decisions

- **Collection Explorer is the umbrella.** Product copy may describe the shared shell as Collection Explorer. The sidebar says Library for browse-first collection access; Search remains a command/shortcut/direct-route entry point rather than a sidebar item.
- **Route intent selects mode.** `/library` opens Browse mode and `/search` opens Search mode with the query focused; neither route should remember a last-used mode that overrides its meaning.
- **Search does not browse by default.** Empty Search shows a prompt, even when compatible filters are active; filters become pending constraints for the next query.
- **The first pass is UI/product consolidation.** The initial work should reuse the existing search and browse reads instead of reshaping backend contracts.

---

## Requirements

**Explorer Shape**

- R1. The Collection Explorer must expose Browse and Search as explicit modes in one shared shell.
- R2. The Library sidebar entry, `g l`, and Library command-palette action must open Browse mode.
- R3. The `/` shortcut, direct `/search` route, and Search command-palette action must open Search mode and focus the query box.
- R4. The Home quick tile must not label a Search destination as Library; it must either open Browse as Library or use Search wording for a Search destination.

**Browse Mode**

- R5. Browse mode must list live browsable elements without requiring a query.
- R6. Browse mode must include sources, extracts, cards, topics, synthesis notes, and tasks.
- R7. Browse mode must support type, concept, priority, and status facets.
- R8. Browse mode may keep a lightweight title filter, but it must be described as filtering visible browse rows rather than full-text search.

**Search Mode**

- R9. Search mode must use a prominent query input and treat non-empty input as keyword or semantic retrieval.
- R10. Search mode must return only searchable result types: sources, extracts, and cards.
- R11. Empty Search mode must show a search prompt rather than defaulting to browse rows.
- R12. When Search has pending compatible filters but no query, the prompt must make clear that typing will search within those filters.
- R13. Search mode must keep existing search-specific affordances such as highlighted snippets, semantic mode hints, related badges, and review of matching or related cards where applicable.

**Mode Switching And Filters**

- R14. Typing in the shared explorer's main query input must switch the explorer to Search mode.
- R15. Switching modes must preserve compatible filters such as concept, priority, and searchable element type.
- R16. Switching from Browse to Search must drop Browse-only filters such as status and non-searchable element types.
- R17. Switching from Search to Browse must keep compatible filters and return to browse-first results.
- R18. The UI must visibly distinguish an active filter from a pending Search constraint so users understand why later results may be narrowed.

**Shared Result Experience**

- R19. Browse and Search rows must share the same core result language: element type, title, priority, concept, scheduler signal, due state, and source reference when available.
- R20. Opening a row must keep the existing destination semantics: sources open the reader, extracts open the extract view, cards open card detail, synthesis notes open the synthesis editor, and tasks open their protected target when one exists.
- R21. The shared detail panel must preserve source lineage cues and the FSRS-versus-attention scheduler distinction.

**Concept Map**

- R22. Browse and Search modes must both retain a secondary Concept Map tab for filtering by concept.
- R23. The Concept Map tab must remain a filtering aid, not a concept-management replacement.
- R24. `/concepts` must remain the deeper concept-management and concept-member exploration surface.

---

## Key Flows

- F1. **Open Library**
  - **Trigger:** The user clicks Library or presses `g l`.
  - **Steps:** The explorer opens in Browse mode, lists live browse rows, and shows Browse-appropriate facets.
  - **Outcome:** The user can inspect and narrow the whole collection without knowing a search term.

- F2. **Open Search**
  - **Trigger:** The user clicks Search, presses `/`, or chooses Search from the command palette.
  - **Steps:** The explorer opens in Search mode with focus in the query input.
  - **Outcome:** The user sees a focused prompt until they type, then gets ranked searchable results.

- F3. **Type From Browse**
  - **Trigger:** The user starts typing a full-text query while browsing.
  - **Steps:** The explorer switches to Search mode, preserves compatible filters, and runs retrieval when the query is non-empty.
  - **Outcome:** The user moves from inventory browsing to retrieval without choosing a separate page first.

- F4. **Carry Filters Into Search**
  - **Trigger:** The user browses within a concept or priority band, then switches to Search.
  - **Steps:** Compatible filters stay visible; Browse-only filters are dropped; empty Search shows "type to search within these filters" style guidance.
  - **Outcome:** Search does not show misleading browse rows, and the user understands that the next query will be constrained.

---

## Acceptance Examples

- AE1. **Covers R2, R5, R6.** Given the user opens `/library`, when the explorer loads, then Browse mode is active and rows can include topics, synthesis notes, and tasks.
- AE2. **Covers R3, R9, R11.** Given the user opens `/search`, when no query has been typed, then the query input is focused and the result area shows the Search prompt rather than browse rows.
- AE3. **Covers R12, R15, R16.** Given the user is browsing Priority A scheduled topics and switches to Search, when Search opens with no query, then Priority A remains active, the topic and status constraints are dropped, and the prompt explains that typing will search within the remaining filters.
- AE4. **Covers R14.** Given the user is in Browse mode, when they type a query into the main query input, then the explorer switches to Search mode and retrieves matching source, extract, and card results.
- AE5. **Covers R22, R24.** Given the user opens the Concept Map tab inside the explorer, when they click a concept, then the active explorer mode is filtered by that concept and `/concepts` remains available for deeper concept work.

---

## Success Criteria

- Users can state the difference between Browse and Search after seeing the integrated surface.
- Empty Search no longer implies that Search can browse every element type.
- Library remains the sidebar entry for collection exploration; Search remains a fast command/shortcut/direct-route entry point.
- Compatible filters survive mode switches without making results appear to vanish mysteriously.
- Existing search ranking, semantic search behavior, review-mode entry points, and browse coverage remain intact.

---

## Scope Boundaries

- Do not unify or rename backend contracts in the first implementation.
- Do not add keyword or semantic Search coverage for topics, synthesis notes, or tasks.
- Do not remove the dedicated `/concepts` surface.
- Do not turn Search into unfiltered browse-all when the query is empty.
- Do not perform a broad cleanup of historical plans, help docs, or component names unless stale copy directly undermines the new product behavior.

---

## Dependencies And Assumptions

- The existing browse and search reads remain available and keep their current result universes.
- The current design system can support the shared shell without inventing a new visual language.
- The implementation can keep renderer logic limited to UI state and bridge calls; ranking, browse counts, and scheduler enrichment stay behind typed app APIs.

---

## Sources

- `CONCEPTS.md`
- `docs/design-system.md`
- `docs/onboarding-and-help-center-brief.md`
- `docs/plans/2026-06-06-search-empty-facet-browse.md`
- `docs/solutions/ui-bugs/search-empty-query-facets-browse-rows.md`
- `apps/web/src/router.tsx`
- `apps/web/src/library/LibraryScreen.tsx`
- `apps/web/src/library/BrowseScreen.tsx`
- `apps/web/src/shell/nav.ts`
- `apps/web/src/pages/home/HomeScreen.tsx`
- `packages/local-db/src/search-repository.ts`
- `packages/local-db/src/library-query.ts`
