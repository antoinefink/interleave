---
title: "Process Queue Source Reader Metadata Row Chrome"
date: "2026-06-09"
category: "docs/solutions/ui-bugs/"
module: "apps/web process queue source reader"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Block progress and word count rendered inside the narrow reader rail/footer instead of alongside source metadata."
  - "Source progress felt visually detached from title, provenance, priority, status, and scheduler details."
  - "Source header and bottom action dividers did not span the full source workbench width."
root_cause: "scope_issue"
resolution_type: "code_fix"
severity: "low"
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
  - "metadata-row"
  - "reader-rail"
  - "reader-chrome"
  - "css-layout"
---

# Process Queue Source Reader Metadata Row Chrome

## Problem

The `/process` source reader still treated text-source counters as narrow reader-rail
chrome. The block progress label appeared above the article rail, while the word
count lived in a rail-local footer, so the information was detached from the source
identity row and the footer divider read as an article-column rule.

## Symptoms

- `process-source-progress` lived in `.pq-source__railhead` above the article body.
- Word count lived in `.pq-source__foot`, inside the constrained `.pq-source__rail`.
- The source header and bottom action separators visually stopped inside the source
  card padding instead of spanning the source workbench.
- Specialized PDF/video fallback readers could inherit text-reader counters unless
  those counters were explicitly gated by source format.

## What Didn't Work

- Keeping counters inside the reader rail treated source metadata as article-body
  chrome. That made the label and word count compete with the reading surface.
- Making the whole rail full-width would have solved the divider width but regressed
  the shared `--reader-text-measure` boundary that keeps prose readable.
- Showing counters whenever `plainText` exists is too broad because specialized
  sources can still carry fallback text while using PDF/page or media/timestamp
  readers.

## Solution

Move the text-source counters into the `ProcessSourceWorkbench` metadata row and
gate them to plain text sources:

```tsx
{doc.sourceFormat === null ? (
  <>
    <SourceMetaDot />
    <span className="pq-source__meta pq-source__meta--mono" data-testid="process-source-progress">
      {progressLabel}
    </span>
    <SourceMetaDot />
    <span className="pq-source__meta pq-source__meta--mono" data-testid="process-source-words">
      {wordCount(doc.plainText)} words
    </span>
  </>
) : null}
```

Remove the old `.pq-source__railhead`, `.pq-source__progresslabel`, and
`.pq-source__foot` markup/classes. Keep only the progress bar inside the constrained
reader rail.

Make the structural dividers belong to the full source workbench by breaking the
header and action row out through the source card's horizontal padding:

```css
.pq-source__header {
  margin-inline: calc(var(--s-6) * -1);
  padding: var(--s-3) var(--s-6) var(--s-2);
  border-bottom: 1px solid var(--border);
}

.pq-card--source .pq-actions {
  margin-inline: calc(var(--s-6) * -1);
  padding-inline: var(--s-6);
}
```

## Why This Works

Progress text and word count are source-session metadata, so they belong beside the
author, URL, priority, lifecycle status, and scheduler chip. The progress bar stays
rail-local because it is a visual measure of reading position against the source text.

The CSS split preserves both layout contracts: source workbench chrome can span the
full pane, while long-form source text and its progress bar remain constrained to the
shared reader measure.

## Prevention

- Treat text counters as metadata-row content unless they directly manipulate or
  annotate the article body.
- Gate text-reader chrome with `sourceFormat === null`; do not infer from
  `plainText`, because PDF/video sources may still expose fallback text.
- Keep CSS contract tests tied to both sides of a breakout: the child negative
  margin and the parent padding it cancels.
- Regression-test each specialized source format when changing shared source-header
  chrome.

## Related Issues

- [Reader Session Metadata And Dividers](../../plans/2026-06-09-reader-session-metadata-dividers.md)
  is the implementation plan for this fix.
- [Process Queue Source Reader Library Header](./process-queue-source-reader-library-header.md)
  established that `ProcessSourceWorkbench` owns source identity; this refines its
  progress guidance by keeping only the progress bar in the rail.
- [Process Queue Source Reader Unframed Workbench](./process-queue-source-reader-unframed-workbench.md)
  covers the full-height, unframed source workbench this divider breakout builds on.
- [Source Reader Shared Text Measure](./source-reader-shared-text-measure.md) covers
  why the source prose rail must remain constrained even when surrounding chrome
  spans full width.
- [Source Reader Taller Middle Area](./source-reader-taller-middle-area.md) covers
  the adjacent one-header ownership pattern in the standalone source route.

## Superseded (2026-06-21)

The dense source **metadata row** described here was removed in the process-session
top-bar redesign (`docs/plans/2026-06-21-001-feat-process-session-topbar-redesign-plan.md`).
Author / URL / status / priority / scheduler were duplicates of the right-hand
Inspector SOURCE column, which is now the single identity owner. The one piece of
the row not owned by the Inspector — the reading-position caption (`block N of M ·
% · N words`) — moved to a rail-local caption (`.pq-source__railmeta`) directly
under the progress bar, consistent with this doc's rail-local progress guidance.
The `.pq-source__metarow` / `.pq-source__meta` / `.pq-source__meta--link` /
`.pq-source__format` selectors and the `sourceUrlLabel` / `sourceExternalHref`
helpers are gone; the css-contract test now pins `.pq-source__railmeta` instead.
