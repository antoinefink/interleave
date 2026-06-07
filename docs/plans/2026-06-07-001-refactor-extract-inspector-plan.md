---
title: "refactor: Extract inspector responsibility split"
type: "refactor"
status: "completed"
date: "2026-06-07"
---

# refactor: Extract inspector responsibility split

## Summary

Refactor the extract-focused inspector layout so each fact appears in one section with one clear owner: identity in the header, editable controls in properties, attention state in the scheduler summary, and source evidence in one lineage block.

---

## Problem Frame

The current inspector asks the user to reconcile the same concepts across header chips, metadata rows, the attention section, and three separate source sections. For extracts, priority/status/stage appear repeatedly, and source lineage is split between "From source", "Source reference", and "Source location" with two jump actions that appear to do the same thing.

---

## Requirements

- R1. The inspector header identifies the selected item and renders one compact state line in the shape `Type · Priority · Status · Stage`, without additional priority/status/stage chips.
- R2. The properties section is the editable control surface for element metadata: type display, priority editing, status display, and due date display; it must not include a duplicate stage row when the scheduler state already carries stage.
- R3. The attention section for non-card elements renders a compact scheduler summary such as `Raw extract · Seen today · Postponed 0x`, plus a small existing reschedule affordance where valid.
- R4. The source lineage block replaces the separate "From source", "Source reference", and "Source location" sections for sourced non-source elements.
- R5. The source lineage block shows source title, selected-text quote, citation/link metadata, location metadata, and exactly one primary `Jump to source` action.
- R6. The duplicated `Open source at this location` action from the inspector source reference is removed.
- R7. Existing review-scope redaction for card source context remains intact.
- R8. Export remains separate and lower priority than the core identity/properties/attention/lineage sections.
- R9. The refactor stays behind the existing typed `window.appApi` bridge; no renderer SQLite/filesystem access and no new mutation path unless implementation proves it necessary.

---

## Key Technical Decisions

- KTD1. Keep this as a renderer composition refactor: `InspectorData` already carries the element, scheduler, source, sourceRef, and location data needed for the requested layout.
- KTD2. Reuse the existing `queue.schedule` seam through `appApi.scheduleQueueItem` and `ScheduleMenu` for the optional attention reschedule action instead of adding inspector-specific IPC.
- KTD3. Keep `RefBlock` generic for review/library/extract surfaces, but do not pass its `onOpenSource` affordance from the inspector lineage block; the inspector owns a single `Jump to source` action.
- KTD4. For source lineage, compose source row, quote, citation/link, and location metadata in one inspector section rather than nesting existing sections. This preserves scanability without changing source-reference formatting rules.
- KTD5. Target renderer tests for the duplicate-fact and source-action regressions. Repository, IPC, and operation-log tests are unnecessary unless implementation introduces a new mutation surface.

---

## Scope Boundaries

- No database schema, repository, or IPC contract changes are planned.
- No new status or due-date editor is planned unless an existing typed API already supports it; status and due date stay display-only in this pass.
- Review/session source redaction behavior stays unchanged.
- `RefBlock` keeps its existing public behavior for non-inspector callers.
- Broader visual redesign of the universal inspector, lineage tree, related section, maintenance section, and card review metadata is out of scope.

---

## Implementation Units

### U1. Extract Header And Properties Responsibilities

- **Goal:** Replace the header chip row with a compact state line and make the metadata/properties block the single place for type, priority editing, status, and due date.
- **Requirements:** R1, R2.
- **Dependencies:** None.
- **Files:** Modify `apps/web/src/components/inspector/Inspector.tsx`; modify `apps/web/src/components/inspector/inspector.css`; test in `apps/web/src/components/inspector/Inspector.test.tsx`.
- **Approach:** Add small display helpers for status/stage labels where needed, render the header state as plain compact text, rename or retune the metadata block toward "Properties", remove the duplicate stage metadata row, and keep `PriorityControl` as the only priority editor.
- **Patterns to follow:** `apps/web/src/components/inspector/primitives.tsx` for labels and scheduler primitives; existing `.insp-head` and `.meta-row` styles in `apps/web/src/components/inspector/inspector.css`.
- **Test scenarios:** For an extract with priority B, scheduled status, and raw/clean stage, assert the header state line contains the type, A/B/C/D label, status label, and stage label; assert metadata/properties still contains priority controls and due date; assert metadata/properties does not render a `Stage` row.
- **Verification:** Extract inspector scans with identity in the header and editable metadata in properties without duplicate stage/priority/status rows.

### U2. Compact Attention Scheduler Summary

- **Goal:** Replace the attention section's metadata-style rows with a compact scheduler summary and small reschedule control.
- **Requirements:** R3, R8, R9.
- **Dependencies:** U1.
- **Files:** Modify `apps/web/src/components/inspector/Inspector.tsx`; modify `apps/web/src/components/inspector/inspector.css`; test in `apps/web/src/components/inspector/Inspector.test.tsx`.
- **Approach:** Introduce an `AttentionSummary` renderer for attention-scheduled items. It should show stage, last-seen text, postponed count, and source yield when present. Mount the existing `ScheduleMenu` for non-card attention items and route selections to `appApi.scheduleQueueItem`, then refresh inspector data through the existing refresh path.
- **Patterns to follow:** `apps/web/src/components/queue/ScheduleMenu.tsx`; queue/process uses of `appApi.scheduleQueueItem`; scheduler label helpers in `primitives.tsx`.
- **Test scenarios:** For an extract, assert the attention section includes a compact summary like `Clean extract`, `Seen`, and `Postponed 0x`; assert the old attention `Stage`/`Postponed` metadata row duplication is gone; selecting a schedule preset calls `scheduleQueueItem` with the inspected id and refreshes inspector data.
- **Verification:** Attention reads as scheduler state rather than repeated metadata, with the FSRS section for cards unchanged.

### U3. Unified Source Lineage Block

- **Goal:** Merge "From source", "Source reference", and "Source location" into one coherent source-lineage section with one primary jump action.
- **Requirements:** R4, R5, R6, R7.
- **Dependencies:** U1.
- **Files:** Modify `apps/web/src/components/inspector/Inspector.tsx`; modify `apps/web/src/components/inspector/inspector.css`; test in `apps/web/src/components/inspector/Inspector.test.tsx`.
- **Approach:** Add a `SourceLineageSection` that receives `source`, `sourceRef`, and `location`. It should render the source row/title, selected text quote, citation/link metadata through `RefBlock` without `onOpenSource`, location label/offset context where available, and one `Jump to source` button wired to `onJumpToLocation(location)` when block ids exist. Hide it behind the existing review-scope redaction condition.
- **Patterns to follow:** Existing `LineageRow`, `RefBlock`, `ExternalUrlLink`, and `navigateToLocation` usage; redaction assertions in `Inspector.test.tsx`.
- **Test scenarios:** For an extract/card with source context, assert only one source-lineage section renders; assert old `source-section`, `source-ref-section`, and `location-section` are gone; assert `Jump to source` calls `navigateToLocation`; assert `inspector-refblock-open-source` is absent; assert review-scope card redaction hides the unified section.
- **Verification:** Source evidence is visible in one block, and the inspector has only one source-jump affordance.

### U4. Visual And Regression Verification

- **Goal:** Verify the refactor with focused tests and broad workspace checks.
- **Requirements:** R1-R9.
- **Dependencies:** U1, U2, U3.
- **Files:** Test `apps/web/src/components/inspector/Inspector.test.tsx`; optionally update `apps/web/src/components/inspector/inspector-css.test.ts` only if CSS invariants need adjustment.
- **Approach:** Run focused inspector tests first, then workspace typecheck, unit tests, and lint. Use renderer-only verification unless the implementation unexpectedly touches Electron/main behavior.
- **Patterns to follow:** Existing inspector test harness mocks `appApi`, `useSelection`, and `useNavigateToLocation`.
- **Test scenarios:** Full extract inspector render with compact header, properties, attention summary, unified lineage, export after core sections, and no duplicate source actions.
- **Verification:** `pnpm typecheck`, `pnpm test`, and `pnpm lint` pass or any inability to run them is documented with the exact failure.

---

## Sources And Research

- `apps/web/src/components/inspector/Inspector.tsx` currently renders duplicated metadata, attention rows, and three source sections.
- `apps/web/src/components/inspector/primitives.tsx` owns type/status/stage/priority/scheduler display primitives.
- `apps/web/src/components/RefBlock.tsx` owns reusable citation/quote/link rendering and its optional open-source affordance.
- `apps/web/src/components/queue/ScheduleMenu.tsx` provides the existing explicit attention reschedule UI over `appApi.scheduleQueueItem`.
- `docs/design-system.md` defines `MetaRow`, `SchedulerChip`, `LineageTree`, FSRS-vs-attention split, and the inspector's role.
- `docs/scheduling-and-priority.md` confirms extracts use the attention scheduler and cards use FSRS.
- `docs/solutions/ui-bugs/embedded-active-card-detail-in-extract-workspace.md` and `docs/solutions/ui-bugs/active-card-rows-open-card-detail-surface.md` flag source-context/redaction and lineage navigation risks.
