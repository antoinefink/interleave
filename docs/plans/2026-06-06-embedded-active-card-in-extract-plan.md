---
title: "Embed Active Card Detail In Extract Workspace"
type: fix
status: active
date: 2026-06-06
origin: "user request: active_card link replaces distill extract section with card edit/stats section"
---

# Embed Active Card Detail In Extract Workspace

## Summary

Clicking an `active_card` lineage node inside `/extract/$id` should keep the user in the extract workspace and replace the center "Distill extract" section with a targeted card section for that exact card. The section should load through the existing typed card read model, show FSRS stats, and reuse the existing card edit/repair path.

## Problem Frame

The extract workspace's `LineageTree` currently navigates source and extract nodes, but card nodes only select the inspector. That does not give the user a main-area card editing/stat surface from the extract, and it conflicts with the expectation that a visible `active_card` link opens the card itself.

## Requirements

- R1. Clicking a card lineage node in `apps/web/src/reader/ExtractView.tsx` keeps the route on `/extract/$id`.
- R2. The center `extract-distill` panel is replaced by a card detail section for the clicked card id.
- R3. The card section fetches through `appApi.reviewCard({ cardId })`; no renderer SQL, filesystem, or new IPC surface.
- R4. The card section shows card kind, prompt/body, priority, stage, FSRS scheduler chip, and FSRS stats.
- R5. Edits and repair actions reuse `ReviewRepairBar` / `appApi.updateCard` and related typed card commands.
- R6. Removing a card from the embedded section returns to the extract distill section and refreshes lineage/inspector state.
- R7. The existing `/card/$id` route continues to work, and `/review` remains the active-recall grading session.

## Key Decisions

- **Extract a reusable card detail component.** Move the core targeted-card UI from `CardScreen` into a reusable component so route and embedded use share read, reveal, source-jump, patching, and repair behavior.
- **Keep embedded state local.** Use local `activeCardId` state in `ExtractView` rather than query params; this is a contextual in-workspace drill-in, not a new deep-link requirement.
- **Open embedded cards as detail surfaces.** The standalone `/card/$id` route stays reveal-first, but the extract-embedded card section opens revealed because it is an edit/stats drill-in, not a quiz prompt. If the user hides the answer, the repair/source-context tools unmount and the card selection is cleared again.
- **Close the builder on card drill-in.** Clicking an existing card should focus the existing card; it should not leave the new-card builder open beside it.

## Implementation Units

### U1. Shared Card Detail Surface

- **Goal:** Extract the reusable targeted card detail UI from the standalone card route.
- **Files:** Create `apps/web/src/review/CardDetailPanel.tsx`; modify `apps/web/src/review/CardScreen.tsx`.
- **Patterns:** Follow current `CardScreen` and `ReviewRepairBar`; keep `ReviewCardView` as the read model and `ReviewRepairBar` as the mutation path.
- **Test Scenarios:** Existing `CardScreen` tests continue to pass after refactor. A valid id loads through `reviewCard`, reveal shows answer/source, and edit patches visible content.
- **Verification:** `pnpm --filter @interleave/web test -- CardScreen.test.tsx`.

### U2. Embed Card Drill-In In ExtractView

- **Goal:** Card lineage clicks replace the center distill panel with the shared card detail panel.
- **Files:** Modify `apps/web/src/reader/ExtractView.tsx`; modify `apps/web/src/reader/extract-view.css`.
- **Patterns:** Keep `LineageTree` presentational. Source/topic nodes still route to `/source/$id`; extract nodes still route to `/extract/$id`; only card nodes set the embedded `activeCardId`.
- **Test Scenarios:** Clicking `card_1` calls `appApi.reviewCard({ cardId: "card_1" })`, hides `extract-distill`, renders the embedded card section, does not navigate, and returns to distill after closing/removal.
- **Verification:** `pnpm --filter @interleave/web test -- ExtractView.test.tsx`.

### U3. Focused E2E Coverage

- **Goal:** Update the lineage E2E expectation so the desktop flow verifies the embedded card section.
- **Files:** Modify `tests/electron/lineage.spec.ts` if the stale card-click behavior is asserted there.
- **Patterns:** Keep existing route-level card tests unchanged; this change is only for card drill-in from within `/extract/$id`.
- **Test Scenarios:** In the extract workspace, click an active card in the lineage tree and assert the card detail section is visible while the page remains on the extract route.
- **Verification:** Run the focused unit tests first; run the relevant E2E if feasible after the dev app is available.

## Scope Boundaries

- Do not add schemas, migrations, repositories, or IPC channels.
- Do not start or grade a review session from this interaction.
- Do not replace or remove the standalone `/card/$id` route.
- Do not change card creation in `CardBuilder`.
- Do not expose source context while a card is hidden; the embedded section intentionally starts revealed so editing can be immediate.

## Risks

- Refactoring `CardScreen` can accidentally weaken reveal gating or source-navigation race guards. Keep those behaviors in the shared component and preserve tests.
- `ReviewRepairBar` edit/source controls can expose answer/source context, so they must only be mounted while the embedded card is revealed. Returning to hidden state or distill unmounts those controls and closes the drawer.
- The review CSS was designed for full-page centering. Add small embedded modifiers rather than duplicating card styles.
