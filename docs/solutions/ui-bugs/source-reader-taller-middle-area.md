---
title: "Source Reader Taller Middle Area"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "apps/web source reader layout"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "The source reader's central reading body felt too short on desktop."
  - "SourceReader reserved vertical space for both the source header and a separate action-header row."
  - "Long sources showed less article content before scrolling, even though the reader body owned the vertical scroll."
root_cause: "scope_issue"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "apps/web/src/pages/source/SourceReader.tsx"
  - "apps/web/src/pages/source/reader.css"
  - "apps/web/src/pages/source/SourceReader.test.tsx"
  - "apps/web/src/pages/source/reader-css.test.ts"
tags:
  - "source-reader"
  - "reader-chrome"
  - "vertical-layout"
  - "scroll-area"
  - "compact-spacing"
  - "desktop-ui"
---

# Source Reader Taller Middle Area

## Problem

The source reader's middle reading area had less usable vertical space because
the page rendered two stacked pieces of top chrome: the main source metadata
header and a separate action header for reader controls.

That pushed article, PDF, and media reader bodies downward, so the user saw less
content before needing to scroll.

## Symptoms

- The central source reader body felt shorter than the available desktop window.
- Article mode rendered a source header, then a second `.reader-header` row for
  Set read-point, workflow actions, Open original, and Delete.
- PDF and video modes had the same duplicated top-chrome pattern.
- CSS-only spacing reductions could not fully recover the lost height because the
  extra row was structural.

## What Didn't Work

- Treating branch-specific controls as independent header rows kept duplicating
  the same layout responsibility across article, PDF, and media branches.
- Reducing generic `.reader-header` padding would also affect extract/review
  surfaces that reuse reader chrome.
- Changing shell scroll behavior was the wrong target. Source-reader scroll
  ownership should remain with `.reader-page`, as documented in
  [Source Reader Scroll Extents and Rich Source Rendering](./source-reader-scroll-extents-rich-source-rendering.md).

## Solution

Make `SourceHeader` the single owner of source-reader top chrome by giving it an
optional actions slot:

```tsx
function SourceHeader({
  actions,
  data,
}: {
  data: InspectorData | null;
  actions?: ReactNode;
}) {
  // title, provenance, chips...
  return (
    <header className="reader-header" data-testid="reader-header">
      {/* metadata */}
      {actions ? <div className="reader-actions">{actions}</div> : null}
    </header>
  );
}
```

Article, PDF, and video source-reader branches now pass their controls into that
slot instead of rendering a second sibling `.reader-header`.

Then scope the remaining density changes to source-reader routes only:

```css
.source-reader-screen .reader-header {
  padding: var(--s-3) var(--s-6) var(--s-3);
}

.source-reader-screen .reader-actions {
  margin-top: var(--s-2);
}

.source-reader-screen .reader-rail {
  padding-top: var(--s-4);
}
```

Keep the existing reader-body contract intact:

```css
.reader-page {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
```

## Why This Works

The fix removes the structural cause of the cramped reader body. There is now
one source header that owns metadata and source actions, so article, PDF, and
media branches share the same top-chrome layout instead of each adding another
row above the scrollable body.

The compact CSS is source-scoped, so it improves the source reader without
changing extract distillation surfaces that use the same generic reader classes.
The scroll owner stays unchanged: `.reader-page` still owns vertical movement,
which keeps read-point reachability and selection-toolbar viewport geometry
aligned with earlier source-reader fixes.

## Prevention

- Compose source-reader controls through `SourceHeader` slots rather than adding
  sibling header/action rows in individual source-type branches.
- Keep tests that assert article, PDF, and video source-reader modes render one
  `reader-header`.
- Preserve CSS contract tests for `.reader-page` scroll ownership and
  source-scoped chrome compaction.
- When reclaiming vertical space, remove duplicated chrome before tuning spacing.
- Re-test selection toolbar behavior after source-reader scroll/container changes;
  see [Large Selection Toolbar Visible Viewport Anchoring](./large-selection-toolbar-visible-viewport-anchoring.md).

## Related Issues

- [Source Reader Scroll Extents and Rich Source Rendering](./source-reader-scroll-extents-rich-source-rendering.md) documents the source-reader single-scroll-owner contract this fix preserves.
- [Extract Distillation Prose Must Scroll Inside the Editor Panel](./extract-distillation-scroll-contained-editor.md) covers the adjacent pattern for keeping long prose and controls from competing for one unbounded vertical flow.
- [Large Selection Toolbar Visible Viewport Anchoring](./large-selection-toolbar-visible-viewport-anchoring.md) covers the viewport-geometry assumptions that depend on source reader inner scrolling.
