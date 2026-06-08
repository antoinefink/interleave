---
title: "Large selection toolbar must anchor to visible viewport geometry"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "apps/web reader selection toolbar"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Creating a very large extract could place the selection toolbar above the visible viewport."
  - "The toolbar anchor followed the selection union rectangle instead of the currently visible selected text."
  - "Near-edge selections could keep the anchor in bounds while the centered toolbar still rendered partly offscreen."
  - "Toolbar action clicks could schedule a deferred mouseup recompute that reopened stale selection UI after dismissal."
root_cause: "logic_error"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "apps/web source reader"
  - "apps/web extract distillation workspace"
  - "Electron selection toolbar E2E"
tags:
  - "selection-toolbar"
  - "large-selection"
  - "viewport"
  - "getclientrects"
  - "source-reader"
  - "extract-view"
  - "electron-e2e"
---

# Large selection toolbar must anchor to visible viewport geometry

## Problem

Selecting a very large source or extract body and then creating an extract could leave the floating selection toolbar anchored to the top of the whole selection. For selections spanning far beyond the visible reader viewport, that made the toolbar unreachable or apparently missing.

## Symptoms

- Huge paragraph selections after internal reader scrolling placed the toolbar above the visible text.
- The shell route itself stayed at `scrollTop = 0`, while the inner reader scroller moved, so adding global page scroll offsets would not repair the anchor.
- A horizontal anchor clamped to the viewport edge was still insufficient because the toolbar is centered with `translate(-50%, -100%)`.
- Clicking a toolbar action could bubble a `mouseup` to the global listener before the `click` handler dismissed the toolbar, leaving a pending recompute capable of reopening stale UI.

## What Didn't Work

- Using `Range.getBoundingClientRect()` for the anchor is wrong for huge selections. The returned union rectangle can start thousands of pixels above the visible line the user just selected.
- Adding `window.scrollY` or an inner `.reader-page.scrollTop` to the coordinates is wrong because the toolbar is fixed-position and needs viewport coordinates, not document coordinates.
- Clamping only the numeric anchor point does not guarantee the rendered toolbar is visible. The toolbar is centered on that point, so half of it can still fall off the left or right edge.
- Testing only highlight actions does not prove the large extract path works. The regression needs to click `Extract` or `Sub-extract` and verify persisted source-location text.

## Solution

Split the problem into two responsibilities:

1. `useTextSelection` chooses an anchor from visible browser selection geometry.
2. `SelectionToolbar` measures its rendered size and clamps the final fixed-position anchor so the actual toolbar stays inside the viewport.

For selection geometry, prefer the first meaningful `Range.getClientRects()` entry with positive viewport intersection, then fall back to the union rectangle only when no visible client rect exists:

```ts
function bestVisibleSelectionRect(range: Range): DOMRect {
  const viewport = viewportSize();
  const visible = Array.from(range.getClientRects()).find((rect) =>
    intersectsViewport(rect, viewport),
  );
  return visible ?? range.getBoundingClientRect();
}
```

Keep the hook's output in viewport coordinates:

```ts
function toolbarPositionForRect(rect: DOMRect): SelectionToolbarPosition {
  const viewport = viewportSize();
  return {
    top: clamp(rect.top - ANCHOR_GAP, VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN),
    left: clamp(rect.left + rect.width / 2, VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN),
  };
}
```

Then clamp the measured toolbar, not just the desired anchor point:

```ts
function clampRenderedToolbarAnchor(
  position: SelectionToolbarPosition,
  toolbar: HTMLElement,
): SelectionToolbarPosition {
  const { width: viewportWidth, height: viewportHeight } = viewportSize();
  const rect = toolbar.getBoundingClientRect();
  if (viewportWidth <= 0 || viewportHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return position;
  }
  return {
    top: clamp(position.top, rect.height + VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN),
    left: clamp(
      position.left,
      rect.width / 2 + VIEWPORT_MARGIN,
      viewportWidth - rect.width / 2 - VIEWPORT_MARGIN,
    ),
  };
}
```

Finally, make deferred mouseup recomputes cancelable and ignore events originating from the toolbar:

```ts
const onMouseUp = (event: MouseEvent) => {
  const target = event.target;
  if (target instanceof Element && target.closest('[data-testid="selection-toolbar"]')) return;
  clearPendingMouseUpRecompute();
  pendingMouseUpRecompute.current = window.setTimeout(() => {
    pendingMouseUpRecompute.current = null;
    recompute();
  }, 0);
};
```

## Why This Works

`getClientRects()` exposes the browser's line-level selection fragments. For a selection spanning multiple screens, at least one client rect normally intersects the visible viewport even when the union rectangle starts far above it. Anchoring to the first positively visible fragment keeps the toolbar attached to text the user can currently see.

The toolbar remains a fixed-position UI element, so viewport coordinates are the correct coordinate system. Inner reader scroll positions explain why the selected text moved, but they should not be added to a fixed overlay's `top` or `left`.

Measuring the toolbar after render closes the horizontal and vertical edge cases. The hook can keep returning the desired selection anchor, while the presentational toolbar owns its real rendered width and height, including label changes, action-set changes, fonts, and future CSS adjustments.

The mouseup cleanup prevents the classic action-click race: mouseup schedules a recompute, click dismisses, then the timeout reopens the toolbar while the DOM selection is still live.

## Prevention

- For fixed overlays anchored to browser selections, keep coordinates viewport-relative and avoid adding window or inner-scroll offsets.
- For multi-line or huge selections, prefer visible `getClientRects()` fragments over the union `getBoundingClientRect()`.
- Clamp the rendered overlay's bounds, not only the conceptual anchor point, whenever CSS transforms center or offset the overlay.
- Cancel deferred selection recomputes on dismissal and ignore events from inside the overlay.
- Battletest selection overlays with Electron coverage that:
  - scrolls the inner source reader while the shell scroller stays still
  - selects a huge source paragraph and clicks `Extract`
  - opens a tall extract, scrolls the extract editor, selects a huge paragraph, and clicks `Sub-extract`
  - asserts the rendered toolbar stays within the viewport
  - verifies the created extract or sub-extract stored the sentinel selected text in source location

## Related Issues

- [Source Reader Scroll Extents and Rich Source Rendering](./source-reader-scroll-extents-rich-source-rendering.md) covers source-reader scroll ownership; this fix depends on that distinction but addresses selection-overlay geometry.
- [Extract distillation prose must scroll inside the editor panel](./extract-distillation-scroll-contained-editor.md) covers extract-editor scroll containment; this fix adds toolbar coverage for that inner scroller.
- [Rich Extractions Preserve Paragraphs and Images](../logic-errors/rich-extractions-preserve-paragraphs-and-images.md) covers preserving extracted content structure after creation, while this doc covers making the selection toolbar reachable before creation.
