---
title: "Process Source Reader Scroll Owner Must Be Full-Width, with the Measure on the Content"
date: "2026-06-17"
category: "docs/solutions/ui-bugs/"
module: "apps/web process queue source reader layout"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "In the /process session, wheeling the mouse over the empty side gutters beside the centered source text scrolled nothing."
  - "Scrolling only worked when the pointer was directly over the narrow centered text column."
  - "The process source workbench used a different scroll-owner/measure layout than the standalone reader, where gutter scrolling works."
root_cause: "scope_issue"
resolution_type: "code_fix"
related_components:
  - "apps/web/src/pages/queue/process-queue.css"
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
  - "apps/web/src/pages/source/reader.css"
  - "design/tokens.css"
tags:
  - "process-queue"
  - "source-reader"
  - "scroll-owner"
  - "reader-measure"
  - "css-layout"
  - "gutter-scroll"
---

# Process Source Reader Scroll Owner Must Be Full-Width, with the Measure on the Content

## Problem

In the `/process` source workbench, mouse-wheel scrolling only worked when the pointer was over the centered text column. Wheeling over the wide empty gutters on either side did nothing, even though they look like part of the same reading pane.

## Symptoms

- Wheel over the left/right margin of the source panel: no scroll.
- Wheel over the text column: scrolls normally.

## Root Cause

The reading measure was applied to `.pq-source__rail`, an **ancestor** of the scroll owner (`.pq-source__editor .reader`):

```css
.pq-source__rail {
  max-width: var(--reader-text-measure); /* ~720px */
  margin: 0 auto;
}
```

That constrained the whole subtree — including the `overflow-y: auto` `.reader` — to ~720px wide and centered. The wide side gutters therefore lived on `.pq-center--source`, which is `overflow: hidden`. Wheel events over the gutters hit a non-scrolling, overflow-hidden ancestor and produced no scroll.

This is the inverse of the standalone reader, where the **full-width** `.reader-page` is the scroll owner and the centered `.reader-rail` (the measure) lives *inside* it — so the gutters are inside the scroller and scroll fine.

## What Didn't Work

Putting the measure on the rail (an ancestor of the scroller) is fine for static centering, but it makes the scroll container only as wide as the measure, leaving the gutters outside the scroller. The fix is **not** to attach `wheel` listeners to the gutters and forward `scrollTop` — that fights native scrolling and breaks the single-scroll-owner contract.

## Solution

Make a full-width element the scroll owner and move the measure onto the editor **content**, mirroring `.reader-page` / `.reader-rail` (`apps/web/src/pages/queue/process-queue.css`):

```css
/* Rail goes full-width so the scroll owner (.reader) covers the gutters. */
.pq-source__rail {
  width: 100%;
  /* removed: max-width: var(--reader-text-measure); margin: 0 auto; */
}

/* The full-width .reader stays the single scroll owner — gutters now inside it. */
.pq-source__editor .reader {
  width: 100%;
  max-width: none;
  overflow-y: auto;
}

/* The reading measure moves to the content node, keeping the text centered
   inside the full-width scroller. */
.pq-source__editor .ProseMirror {
  max-width: var(--reader-text-measure);
  margin: 0 auto;
}

/* The progress bar re-centers itself now that the rail is full-width. */
.pq-source__pbar {
  max-width: var(--reader-text-measure);
  margin: 0 auto var(--s-5);
}
```

## Why This Works

A wheel event scrolls the nearest scrollable ancestor under the pointer. When `.reader` is full-width, the side gutters are *inside* it, so wheeling anywhere in the panel — gutter or text — is captured by the correct scroll owner. Moving `max-width` to `.ProseMirror` keeps the text column visually identical (still 720px, centered) without narrowing the scroll container. The single-scroll-owner + `min-height: 0` ancestor chain is preserved; no second scroller is introduced.

## Prevention

- **Put the reading measure on (or inside) the scroll owner, never on an ancestor of it.** The scroll owner should span the full available width so its empty gutters are part of the scrollable hit area.
- Pin the contract with a CSS-contract test (`process-queue-css.test.ts`): the rail is `width: 100%` and has **no** `max-width`; `.reader` keeps `overflow-y: auto` + `max-width: none`; the measure lives on `.pq-source__editor .ProseMirror`.
- Add an Electron geometry E2E: widen the window so real gutters exist, force overflow, park the cursor in a side gutter, `mouse.wheel`, and assert `scrollTop` increases (jsdom can't prove wheel/layout — `process-queue.spec.ts` "wheeling over the empty side gutters scrolls the source body").

## Related Issues

- [Source Reader Shared Text Measure](./source-reader-shared-text-measure.md) defines the `--reader-text-measure` token both readers share; this doc covers *where* that measure must sit relative to the scroll owner.
- [Source Reader Scroll Extents and Rich Source Rendering](./source-reader-scroll-extents-rich-source-rendering.md) covers the single-scroll-owner contract for the standalone reader.
- [Process Queue Source Reader Unframed Workbench](./process-queue-source-reader-unframed-workbench.md) covers the full-height/unframed workbench chain this scroll fix lives inside.
