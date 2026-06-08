---
title: Source reader taller middle area
status: active
created: 2026-06-08
origin: user UX request
execution: code
---

# Source Reader Taller Middle Area

## Problem

The source reader's middle reading area feels shorter than it should. The reader
currently reserves vertical space for the source header, then reserves another
full header row for reader actions before the scrollable body begins. That makes
long sources require more scrolling and leaves less visible article content in
the central work area.

## Scope

Improve the source reader vertical layout only. Preserve the app shell, right
inspector, source lineage, typed IPC/data paths, read-point behavior, block
processing controls, selection toolbar behavior, and the existing one-scroll-owner
contract where `.reader-page` owns source reader scrolling.

## Requirements

- R1. The source reader should expose more vertical space to the central readable
  area on desktop.
- R2. Reader actions should remain visible and keyboard/mouse reachable.
- R3. Source reader routes must keep `.reader-page` as the only vertical scroll
  owner; do not re-enable shell-level source reader scrolling.
- R4. The first and last source blocks must remain reachable inside the reader
  body.
- R5. The change must use existing design tokens and preserve dense professional
  desktop styling.

## Key Technical Decisions

- **Collapse duplicated reader chrome.** Move the source reader action buttons
  into the source header instead of rendering a second `.reader-header` row.
- **Tighten source-only chrome.** Use a source-specific header class to reduce
  padding and action spacing without changing extract/review surfaces that reuse
  reader chrome.
- **Keep scroll ownership unchanged.** Leave `.shell-page:has(.source-reader-screen)`
  and `.reader-page { overflow-y: auto; min-height: 0; }` intact.
- **Guard with CSS/structure tests.** Add tests that catch a return of the extra
  action header and assert the source reader uses the compact source-specific
  spacing contract.

## Existing Patterns

- `apps/web/src/pages/source/SourceReader.tsx` renders the source reader route.
- `apps/web/src/pages/source/reader.css` owns reader/header/page spacing.
- `apps/web/src/pages/source/reader-css.test.ts` already validates source reader
  scroll ownership CSS.
- `apps/web/src/pages/source/SourceReader.test.tsx` validates route structure and
  interactions.
- `docs/solutions/ui-bugs/source-reader-scroll-extents-rich-source-rendering.md`
  documents why source reader scroll ownership must stay inside `.reader-page`.

## Implementation Units

### U1. Collapse Source Reader Action Chrome

- **Goal:** Remove the second source-reader header row so the scrollable reader
  body starts higher.
- **Files:**
  - Modify: `apps/web/src/pages/source/SourceReader.tsx`
  - Test: `apps/web/src/pages/source/SourceReader.test.tsx`
- **Approach:** Extend the existing `SourceHeader` usage with an actions slot or
  compose the actions inside the source header markup. Keep button labels,
  handlers, disabled states, and test ids unchanged.
- **Test Scenarios:**
  - The source reader route renders one source header, not a separate action
    header.
  - Existing action buttons still render with their current test ids.
  - Empty/loading/error source-reader branches continue to carry the
    `source-reader-screen` marker where applicable.
- **Verification:** Targeted `SourceReader` tests.

### U2. Source-Specific Compact Reader Spacing

- **Goal:** Give the middle reader area more height without affecting extract
  surfaces that reuse reader header classes.
- **Files:**
  - Modify: `apps/web/src/pages/source/reader.css`
  - Test: `apps/web/src/pages/source/reader-css.test.ts`
- **Approach:** Add a `.source-reader-screen .reader-header` spacing override,
  reduce source-reader action margin, and reduce reader-rail top padding while
  keeping bottom breathing room.
- **Test Scenarios:**
  - Source reader routes hide shell scrolling and keep `.reader-page` scrollable.
  - Source-reader-specific header padding is more compact than the generic
    reader header.
  - Reader rail keeps bottom breathing room and uses a smaller tokenized top
    padding.
- **Verification:** Targeted CSS contract tests.

## Verification Plan

- Run `pnpm --filter @interleave/web test -- SourceReader reader-css`.
- Run `pnpm typecheck`.
- Run `pnpm test`.
- Run relevant Electron/source-reader coverage if the local Electron harness is
  available in the current environment.
