---
title: "Process Queue Inline Session Controls"
date: "2026-06-09"
category: "ui-bugs"
module: "apps/web process queue"
problem_type: "ui_bug"
component: "frontend_stimulus"
severity: "medium"
symptoms:
  - "The /process route reserved a dedicated full-width header bar for progress, mode switching, and ending the session."
  - "The extra bar competed with source and extract workbenches instead of letting the active item own the workspace."
  - "Removing the bar still needed to preserve progress, mode controls, and end-session navigation."
root_cause: "logic_error"
resolution_type: "code_fix"
related_components:
  - "apps/web/src/pages/queue/ProcessQueue.tsx"
  - "apps/web/src/pages/queue/process-queue.css"
  - "apps/web/src/pages/queue/ProcessQueue.test.tsx"
  - "apps/web/src/pages/queue/process-queue-css.test.ts"
tags:
  - "process-queue"
  - "session-controls"
  - "header-chrome"
  - "inline-controls"
  - "source-workbench"
  - "queue-navigation"
  - "desktop-ui"
---

# Process Queue Inline Session Controls

## Problem

The `/process` route used a dedicated full-width header bar for session progress,
mode steering, and `End session`. After the source-reader workbench became more
immersive, that bar read as unrelated chrome above the actual queue item.

The controls were still necessary. The fix needed to remove the page-level bar
without losing progress feedback, mode switching, or the dated return path back to
`/queue`.

## Symptoms

- `/process` reserved a separate top band before the live item, loading state, or
  done state.
- Progress, mode controls, and end-session navigation were useful but visually
  detached from the active work.
- Source reading and extract distillation were still framed by generic session
  chrome even after their local workbenches had been simplified.

## What Didn't Work

- Deleting the header outright would remove required session affordances.
- Keeping a smaller page-level header would preserve the same layout problem.
- Moving only some controls inline would risk losing mode switching, progress
  feedback, or `asOf`-scoped navigation back to the queue.
- Passing an opaque rendered node into `ProcessCard` made the item component depend
  on hidden session chrome. Passing explicit control props keeps that dependency
  visible.

## Solution

Extract the old header behavior into a concrete local control component:

```tsx
type ProcessSessionControlsProps = {
  cursor: number;
  total: number;
  done: boolean;
  remaining: number;
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  onEnd: () => void;
};
```

Render `ProcessSessionControls` inside the state-specific work area:

- inside `process-loading`
- inside `process-done`
- inside each live `ProcessCard`

The same stable test ids remain attached to the behavioral controls:

```tsx
<div className="pq-session" data-testid="process-session-controls">
  <div className="pq-progress" data-testid="process-progress">...</div>
  <div className="pq-modes" data-testid="process-modes">...</div>
  <button data-testid="process-end" onClick={onEnd}>End session</button>
</div>
```

The CSS replaces the page-level header surface with compact inline chrome:

```css
.pq-session {
  display: flex;
  align-items: center;
  gap: var(--s-4);
  padding-bottom: var(--s-3);
  border-bottom: 1px solid var(--border);
  background: transparent;
}
```

Loading and done panels receive their own padding rule because they do not have the
same card padding as live process items.

> **Update (2026-06-21, plan 002).** `ProcessSessionControlsProps` later gained an
> optional, source-gated `itemTitle?: string` — the source document heading now
> rides in this band (as the single `h1`) instead of a separate `.pq-source__header`
> band. The band's `border-bottom` divider was replaced by a **full-width progress
> line** (`.pq-progress__bar`, `width: 100%`, `--border` track) that doubles as the
> divider. The "avoid new full-width persistent bars" prevention rule below still
> holds for *route-level* bars; the band's own in-place progress line is the
> deliberate scoped exception. See
> [Process toolbar: full-width progress line as divider, source-gated band title, sr-only readout](../design-patterns/process-toolbar-progress-divider-and-lifted-source-title.md).

## Why This Works

The behavior stays centralized in the process route: progress math, mode changes,
and `End session` navigation still come from `ProcessQueue`. The visible chrome,
however, now belongs to the current process state instead of occupying a permanent
route-level bar.

Keeping `process-progress`, `process-modes`, and `process-end` stable makes the
change layout-only from the test and automation perspective. The tests prove those
controls exist in loading, done, card, source, and extract states, and that ending
a dated session preserves the `asOf` search value when returning to `/queue`.

## Prevention

- Treat `/process` controls as session-local chrome, not global page chrome.
- When removing route-level UI, extract the behavior into a reusable local control
  surface before changing placement.
- Keep behavioral test ids stable across layout moves.
- Test all route states that receive moved chrome: loading, done, card, source,
  and extract.
- Explicitly test scoped return paths such as `asOf` when moving navigation
  controls.
- Avoid adding new full-width persistent bars above the active process item unless
  the behavior cannot live inside the state-specific work area.

## Related Issues

- [Process Queue Source Reader Unframed Workbench](./process-queue-source-reader-unframed-workbench.md) covers removing source-reader framing while preserving contextual extraction.
- [Process Queue Source Reader Metadata Row Chrome](./process-queue-source-reader-metadata-row-chrome.md) covers moving source-local progress metadata into the source header.
- [Process Queue Source Reader Library Header](./process-queue-source-reader-library-header.md) covers source identity and generic process chrome competing in the embedded reader.
- [Queue Route Hides Shell Topbar Without Breaking Global Shortcuts](./hide-queue-route-shell-topbar.md) covers the related pattern of removing route chrome while preserving behavior owned elsewhere.
