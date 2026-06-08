---
title: Fix large extract selection toolbar anchoring
status: active
created: 2026-06-08
origin: user bug report
execution: code
---

# Fix Large Extract Selection Toolbar Anchoring

## Problem

When a user creates a very large extract by selecting text across a long reader
span, the selection toolbar can stay anchored near the original selection start.
For selections that began above the current viewport, this leaves the toolbar
off-screen or effectively unavailable.

The likely cause is that `Range.getBoundingClientRect()` returns the union
rectangle for the whole selection. On a multi-viewport selection, that union
rect's `top` can point to the beginning of the selection instead of the visible
part the user just finished selecting.

## Scope

Fix the text-selection toolbar placement used by the source reader and extract
reader selection flows. Do not change extraction persistence, lineage creation,
scheduling, card creation, read-point behavior, or global reader typography.

## Requirements

- R1. The toolbar must anchor to a visible part of a large text selection, not to
  the off-screen start of the selection's union rect.
- R2. The toolbar must remain within the viewport when there is enough visible
  selection geometry to place it there.
- R3. Existing small-selection behavior must stay the same: fixed positioning
  centered above the selected text, preserving the live ProseMirror selection
  while buttons are clicked.
- R4. Selection coordinates must remain viewport coordinates. Do not mix in
  `window.scrollY`, shell scroll, or `.reader-page.scrollTop`.
- R5. The fix must be battletested with hook-level geometry coverage and real
  Electron coverage after internal reader scrolling.

## Key Technical Decisions

- **Use visible client rects before the union rect.** Prefer the first
  non-empty `Range.getClientRects()` rectangle that intersects the viewport.
  This represents an actually visible line box from the current selection.
- **Clamp the final anchor.** Clamp the computed toolbar anchor into viewport
  bounds with a small margin so near-edge selections do not make the toolbar
  unreachable.
- **Keep the toolbar presentational.** `SelectionToolbar` should continue to
  receive a `{ top, left }` viewport anchor and render fixed. The geometry fix
  belongs in `useTextSelection`.
- **Do not touch the mutation path.** `extractions.create` and the local-db
  transaction already own lineage, source locations, and operation logging.
  This bug is a frontend geometry bug.

## Existing Patterns

- `apps/web/src/reader/useTextSelection.ts` owns DOM selection geometry and
  resolved selection state.
- `apps/web/src/reader/SelectionToolbar.tsx` is presentational and prevents
  `mousedown` default so toolbar clicks keep the text selection alive.
- `apps/web/src/reader/useTextSelection.test.tsx` is the hook-level geometry
  seam for DOM range stubs.
- `tests/electron/selection-toolbar.spec.ts` drives real Electron selection
  toolbar behavior.
- `tests/electron/source-reader.spec.ts` already contains tall-source and
  reader-scroll ownership patterns.
- `docs/solutions/ui-bugs/source-reader-scroll-extents-rich-source-rendering.md`
  documents the one-scroll-owner pattern and geometry assertions for reader
  scroll bugs.

## Implementation Units

### U1. Visible Selection Anchor Geometry

- **Goal:** Compute toolbar anchors from visible selection client rects so a
  huge selection does not pin the toolbar to its off-screen start.
- **Files:**
  - Modify: `apps/web/src/reader/useTextSelection.ts`
  - Test: `apps/web/src/reader/useTextSelection.test.tsx`
- **Approach:** Add small pure helpers for viewport dimensions, visible rect
  selection, and anchor clamping. In `recompute`, use `range.getClientRects()`
  and choose a visible rect before falling back to `getBoundingClientRect()`.
  Keep the resolved `SelectionLocation` behavior unchanged.
- **Test Scenarios:**
  - Existing single-line selection still returns `{ top: rect.top - 8, left:
    rect.left + rect.width / 2 }`.
  - A huge multi-viewport range with an off-screen union rect anchors to the
    visible client rect instead of the union rect.
  - A near-edge visible rect clamps the anchor inside the viewport.
  - A fake large `window.scrollY` or internal scroller does not affect the
    returned viewport anchor.
- **Verification:** Targeted Vitest for `useTextSelection`.

### U2. Large-Selection Electron Regression

- **Goal:** Prove the real app keeps the toolbar reachable after internal reader
  scrolling and a large visible selection.
- **Files:**
  - Modify: `tests/electron/selection-toolbar.spec.ts`
- **Approach:** Create or import a tall source through the existing typed
  `window.appApi` path, open it in the source reader, scroll `.reader-page` near
  a late paragraph, select visible text there with real interaction, and assert
  toolbar geometry against the selected text.
- **Test Scenarios:**
  - After internal reader scroll, the toolbar is visible and fixed.
  - The toolbar rectangle is within viewport bounds.
  - The toolbar bottom is close to the visible selection rect top.
  - The toolbar horizontal center is close to the visible selection rect center.
  - `.shell-page.scrollTop` remains `0`, proving the hook does not rely on the
    shell scroller.
- **Verification:** Electron `selection-toolbar.spec.ts`.

### U3. Action Regression on Large Selection

- **Goal:** Ensure the positioned toolbar still acts on the live selection when
  the selected text is large.
- **Files:**
  - Modify: `tests/electron/selection-toolbar.spec.ts`
- **Approach:** Extend the large-selection Electron path to click a toolbar
  action after the geometry assertion. Prefer `Highlight` or `Extract` based on
  test stability; assert a visible toast and that the DOM selection remains
  non-empty after the button press.
- **Test Scenarios:**
  - A toolbar action dispatches after a deep/large selection.
  - Pressing the button does not collapse the DOM selection.
- **Verification:** Electron `selection-toolbar.spec.ts`.

## Verification Plan

- Run `pnpm --filter @interleave/web test -- useTextSelection`.
- Run the targeted Electron selection toolbar spec.
- Run `pnpm typecheck`.
- Run `pnpm test`.
- If Electron coverage is flaky because the app build is stale, rebuild through
  the existing Electron test harness and rerun the targeted spec.
