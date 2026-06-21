---
title: "Process Queue Source Reader Library Header"
date: "2026-06-08"
category: "docs/solutions/ui-bugs/"
module: "apps/web process queue source reader"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "The Process Queue source workbench duplicated source title and metadata between generic process card chrome and the embedded source reader."
  - "Progress and read-point controls were grouped with the wrong source chrome instead of the centered reading rail."
  - "Imported article provenance values could render as clickable links even when the stored URL was not an external HTTP(S) URL."
  - "PDF and media sources still needed source context while bypassing the inline text reader."
root_cause: "scope_issue"
resolution_type: "code_fix"
severity: "medium"
related_components:
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
  - "apps/web/src/pages/queue/process-queue.css"
  - "apps/web/src/pages/queue/ProcessQueue.test.tsx"
  - "apps/web/src/pages/queue/process-queue-css.test.ts"
tags:
  - "process-queue"
  - "source-reader"
  - "reading-workbench"
  - "source-header"
  - "reader-rail"
  - "provenance-links"
  - "pdf-reader"
  - "desktop-ui"
---

# Process Queue Source Reader Library Header

## Problem

The `/process` source-reading workbench had drifted from the library-style source reader design. A source item rendered generic process-card title/meta chrome above a second source-specific area, while progress and read-point controls competed with source identity instead of living in the intended reading layout.

## Symptoms

- Source items could show the same source title through both `.pq-card__title` and the embedded source workbench.
- The source header did not group title, author, provenance, priority, lifecycle status, and scheduler state as one source identity block.
- Text-source progress was not centered with the readable source measure.
- PDF/media branches risked inheriting inline text-reader controls despite needing specialized reader workflows.
- Stored provenance strings were displayed as links without first proving they were `http:` or `https:` URLs.

## What Didn't Work

- Keeping generic `ProcessCard` title/meta for sources made the header impossible to align with the imported design because sources need richer source-specific metadata than cards and extracts.
- Restyling the old top row was not enough. Source identity belongs in the full workbench header, while progress belongs inside the centered reading rail.
- Treating PDF and media sources as text-reader variants blurred a real product boundary: those formats need page, region, or timestamp extraction surfaces, not block read-points and a ProseMirror text editor.

## Solution

Let `ProcessSourceWorkbench` own source identity and suppress generic card chrome for source items:

```tsx
{!isSource ? (
  <>
    <div className="pq-card__meta">...</div>
    <h1 className="pq-card__title">{titleFor(item)}</h1>
  </>
) : null}
```

Build the source header from inspector metadata when available, with queue-item fallback:

```tsx
const sourceTitle = inspector?.element.title ?? item.title;
const provenance = inspector?.provenance ?? null;
const sourceStatus = inspector?.element.status ?? item.status;
const sourcePriority = inspector?.element.priority ?? item.priority;
const sourceScheduler = inspector?.scheduler ?? chipSignals(item);
```

Render source title, author, guarded provenance URL, priority, status, `SchedulerChip`, and a `PDF source` or `Media source` label from that one header. Keep the read-point action in the header for text sources only.

Guard provenance links at render time:

```tsx
function sourceExternalHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
```

Text sources then render progress and the editor inside a centered `.pq-source__rail` constrained by `--reader-text-measure`. PDF and media sources return after the shared header plus specialized-reader message, without mounting the text rail, editor, or read-point control.

## Why This Works

The source workbench now has one owner for source identity. Generic queue-card chrome still works for cards and extracts, but source items use the reader model directly.

The split also matches the product model: text sources can use block progress and read-points, while PDF/media sources need later specialized extraction affordances. Guarding provenance links preserves useful metadata without turning malformed or non-web values into actionable links.

Moving progress into the reader rail keeps source status metadata out of the prose area and aligns the progress bar with the same readable measure used by long-form source text.

## Prevention

- Keep source queue items out of generic process-card title/meta rendering; source titles should appear exactly once.
- Test text, PDF, and media source branches separately when changing source-reading layout.
- Only render provenance anchors for `http:` and `https:` URLs; render other stored values as inert metadata.
- Preserve the FSRS-vs-attention split by showing source scheduling through `SchedulerChip`, not card-review UI.
- Add CSS contract tests for layout-critical reader surfaces: tokenized spacing, centered rail measure, progress placement, and header/action ownership.

## Related Issues

- [Process Queue Source Reader Unframed Workbench](./process-queue-source-reader-unframed-workbench.md) covers the source-specific full-height, unframed `/process` workbench this header builds on.
- [Source Reader Shared Text Measure](./source-reader-shared-text-measure.md) covers the shared `--reader-text-measure` contract used by the centered source rail.
- [Source Reader Taller Middle Area](./source-reader-taller-middle-area.md) covers adjacent standalone source-reader chrome compaction.
- [Source Reader Scroll Extents and Rich Source Rendering](./source-reader-scroll-extents-rich-source-rendering.md) covers scroll and rich-source rendering contracts that reader rail changes must preserve.
- [Large Selection Toolbar Must Anchor to Visible Viewport Geometry](./large-selection-toolbar-visible-viewport-anchoring.md) remains relevant because source extraction is still selection-driven.

## Superseded (2026-06-21)

The single-owner rule still holds, but the owner changed. In the process-session
top-bar redesign (`docs/plans/2026-06-21-001-feat-process-session-topbar-redesign-plan.md`)
the source workbench header stopped rendering identity entirely: author, URL,
status, priority, and the scheduler chip are now owned solely by the right-hand
Inspector SOURCE column (with its own `ExternalUrlLink` http/https guard). The
workbench header keeps only the document title; the reading-position caption moved
to the rail. When changing source identity rendering, edit the Inspector, not the
process workbench.
