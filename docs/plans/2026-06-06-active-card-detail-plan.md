---
title: "Fix Active Card Click-To-Open"
type: fix
status: active
date: 2026-06-06
---

# Fix Active Card Click-To-Open

## Summary

Clicking an `active_card` should open that exact card in a focused card detail surface where the user can read, reveal source-grounded content, and edit the card body. The existing backend and bridge already expose targeted card reads and card body edits, so the fix is a renderer routing and UI composition change, not a schema or IPC expansion.

## Problem Frame

Cards currently route to `/review`, which starts the FSRS session and loads the next card from the due deck. That means a clicked queue/library card is not necessarily the card the user sees, and if the daily deck state does not line up with the clicked row the interaction feels like nothing happened.

## Requirements

- R1. Opening a card row navigates to a stable card detail route for that card id, not to the general `/review` session.
- R2. The card detail route fetches the card by id through the typed `appApi.reviewCard` seam and never reads SQLite or filesystem data in the renderer.
- R3. The card detail view shows the card prompt/content, reveal-gated answer/source context, FSRS metadata, priority, stage, and repair actions.
- R4. Editing the card from the detail view reuses the existing `appApi.updateCard` mutation path and keeps lineage, review state, and operation logging main-side.
- R5. Existing `/review` behavior remains the due-card FSRS session, including grading and sibling burying.
- R6. Other card entry points that claim to open an element should route to the same card detail surface when they have a card id.

## Key Technical Decisions

- **Use `/card/$id` for detail:** A dedicated route preserves `/review` as the deck/session surface and makes element navigation match source/extract patterns.
- **Reuse `review.card` as the read model:** `ReviewCardView` already carries body, source reference, FSRS signals, leech/flag/expiry state, and media data needed for a readable card page.
- **Reuse `ReviewRepairBar` for edits:** The existing repair bar is already wired to `cards.update`, suspend/delete/flag/leech/retire commands and keeps all mutations behind the typed bridge.
- **Keep reveal gating on detail:** Source context and answers should remain hidden until reveal so opening a card does not accidentally expose the recall answer before the user asks.

## Implementation Units

### U1. Add Card Detail Route

- **Goal:** Register `/card/$id` and render a new card detail screen that loads one card by id.
- **Files:** Modify `apps/web/src/router.tsx`; create `apps/web/src/review/CardScreen.tsx`; create `apps/web/src/review/CardScreen.test.tsx`.
- **Patterns:** Follow `apps/web/src/review/ReviewScreen.tsx` for `ReviewCardView` rendering, `apps/web/src/reader/ExtractView.tsx` for route-param detail pages, and `apps/web/src/review/ReviewRepairBar.tsx` for edit/repair behavior.
- **Test Scenarios:** A valid card id calls `appApi.reviewCard({ cardId })`, selects the card, renders prompt metadata, reveals the answer and refblock on click, and updates the visible prompt/answer after an edit. A missing card renders a not-found/empty state without throwing.
- **Verification:** `pnpm --filter @interleave/web test -- ReviewScreen.test.tsx CardScreen.test.tsx`.

### U2. Route Card Opens To Detail

- **Goal:** Change card open behavior from `/review` to `/card/$id` across queue and browse/search surfaces.
- **Files:** Modify `apps/web/src/pages/queue/openQueueItem.ts`, `apps/web/src/pages/queue/openQueueItem.test.ts`, `apps/web/src/library/LibraryScreen.tsx`, `apps/web/src/library/BrowseScreen.tsx`, `apps/web/src/concepts/ConceptsScreen.tsx`, and their focused tests as needed.
- **Patterns:** Keep `openQueueItem` as the shared queue routing helper; mirror existing source/extract navigation objects.
- **Test Scenarios:** A direct card item and a task linked to a card navigate to `/card/$id` with the selected card id. Library/search/concept card rows route to `/card/$id` while sources and extracts keep their current routes.
- **Verification:** `pnpm --filter @interleave/web test -- openQueueItem.test.ts BrowseScreen.test.tsx LibraryScreen.test.tsx ConceptsScreen.test.tsx`.

### U3. Preserve Review Session Behavior

- **Goal:** Ensure `/review` remains a session route and that card detail edits do not affect grading or due-deck navigation.
- **Files:** Modify `apps/web/src/review/ReviewScreen.test.tsx` only if needed for shared helper fallout.
- **Patterns:** Keep `reviewSessionNext`, `reviewPreview`, and `reviewGrade` untouched in `ReviewScreen`.
- **Test Scenarios:** Existing review tests still show session-first loading through `reviewSessionNext`; card detail tests use `reviewCard` instead.
- **Verification:** Existing `ReviewScreen` tests pass unchanged or with only mock wiring updates for shared imports.

## Scope Boundaries

- Do not add new SQLite tables, IPC channels, or card edit APIs.
- Do not turn `/review` into a detail page or make clicking a card grade/review it.
- Do not add broad inspector editing; the card detail screen is the editing surface for this fix.
- Do not change FSRS scheduling, card creation, or due queue sorting.

## System-Wide Impact

This changes renderer navigation only. All card reads and mutations still go through the typed Electron bridge, so the renderer remains isolated from SQLite and filesystem access. Card edits continue to preserve source lineage and write `operation_log` entries main-side through the existing `CardEditService`.

## Sources / Research

- `apps/web/src/pages/queue/openQueueItem.ts` currently routes `type === "card"` to `/review`.
- `apps/web/src/review/ReviewScreen.tsx` loads the due deck with `appApi.reviewSessionNext`.
- `apps/web/src/lib/appApi.ts` exposes `reviewCard` and `updateCard`.
- `apps/desktop/src/main/db-service.ts` implements targeted `reviewCard` and card update behavior.
- `packages/local-db/src/card-edit-service.ts` preserves lineage/review state and logs `update_element` while editing card bodies.
