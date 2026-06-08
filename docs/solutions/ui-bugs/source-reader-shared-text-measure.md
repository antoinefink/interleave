---
title: "Source Reader Shared Text Measure"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "apps/web source reader layout"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Standalone source reader prose used a constrained width while the /process source reader allowed full-width prose."
  - "The two source-reading surfaces felt visually inconsistent despite rendering the same source content."
  - "The existing constrained reader measure was slightly too narrow for comfortable desktop reading."
root_cause: "scope_issue"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "design/tokens.css"
  - "apps/web/src/pages/source/reader.css"
  - "apps/web/src/pages/queue/process-queue.css"
  - "apps/web source reader CSS contract tests"
  - "docs/design-system.md"
tags:
  - "source-reader"
  - "process-queue"
  - "reader-measure"
  - "css-layout"
  - "design-tokens"
  - "desktop-ui"
---

# Source Reader Shared Text Measure

## Problem

The standalone source reader and the `/process` source workbench rendered long-form source text with mismatched measures. The standalone reader constrained prose, while the embedded process reader allowed the same source content to stretch across the workbench, weakening readability during the daily incremental-reading loop.

## Symptoms

- Source text appeared at different line lengths between `/source/$id` and `/process`.
- The process source workbench risked wide, harder-to-read text lines.
- The process source pane needed to stay full-height and unframed, so copying the standalone reader shell was the wrong fix.

## What Didn't Work

- Treating the two readers as separate CSS surfaces let their text measures drift.
- Removing the process source workbench's full-width outer layout would have regressed the unframed, full-height workbench behavior.
- Hard-coding a new pixel width in both files would have fixed the immediate screenshot mismatch while preserving the underlying drift risk.

## Solution

Use a shared reader-measure token for long-form source text, and keep it separate from each surface's outer layout:

```css
:root {
  --reader-text-measure: 720px;
}

.reader,
.reader-rail {
  max-width: var(--reader-text-measure);
}

.pq-source__editor .reader {
  width: 100%;
  max-width: var(--reader-text-measure);
  margin: 0 auto;
}
```

The standalone source reader consumes the token through `.reader` and `.reader-rail`. The process source workbench keeps `.pq-card--source { max-width: none; }` so the workbench itself remains full-height and unframed, but the prose inside `.pq-source__editor .reader` uses the same text measure and centers within the available area.

Document the token in `docs/design-system.md` so the intentional reader width is discoverable instead of appearing as an unexplained divergence from the immutable prototype kit.

## Why This Works

The shared token separates the invariant from the layout. Both contexts need the same readable source-text measure, but they do not need the same surrounding frame, height behavior, scroll container, or process controls.

Keeping the token in `design/tokens.css` also lets routes that do not import `reader.css` directly still resolve the same value. That matters for `/process`, where `process-queue.css` owns the outer workbench but still embeds a `SourceEditor` that renders the `.reader` class.

## Prevention

- Use `--reader-text-measure` for future source/document reading surfaces instead of inventing a new prose width.
- Keep reader text measure separate from outer container framing and page layout.
- Preserve source-reader scroll ownership: `.reader-page` remains the standalone article scroller, while process workbench scroll/height behavior stays source-specific.
- Add CSS contract assertions when introducing new reader contexts.
- Visually verify source-like surfaces with browser or Electron geometry checks for max width, centering, and horizontal overflow.

## Related Issues

- [Source Reader Scroll Extents and Rich Source Rendering](./source-reader-scroll-extents-rich-source-rendering.md) covers the source-reader scroll-owner contract that text-measure changes must preserve.
- [Process Queue Source Reader Unframed Workbench](./process-queue-source-reader-unframed-workbench.md) covers the `/process` source workbench height/framing contract that the shared measure must not undo.
- [Source Reader Taller Middle Area](./source-reader-taller-middle-area.md) covers standalone source-reader chrome compaction and usable reading area.
- [Large Selection Toolbar Must Anchor to Visible Viewport Geometry](./large-selection-toolbar-visible-viewport-anchoring.md) covers selection-toolbar geometry after reader container changes.
