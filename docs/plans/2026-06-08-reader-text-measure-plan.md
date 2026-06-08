---
title: "Reader Text Measure Alignment"
status: active
date: "2026-06-08"
origin: "user request"
execution: code
---

# Reader Text Measure Alignment

## Problem Frame

The standalone source reader constrains long-form text, while the source reader embedded in the `/process` queue expands the same text surface to the full available width. The constrained screen should also become slightly wider. Both source-reading surfaces should share one readable text-measure configuration so incremental reading stays calm, scannable, and durable.

## Scope Boundaries

- Do not change source reader scroll ownership. `.reader-page` remains the article scroller.
- Do not re-frame the process source workbench; it should stay full-height and unframed.
- Do not widen all cards or process workbench chrome just to widen prose.
- Do not change PDF/media reader sizing.
- Do not alter extraction lineage, editor persistence, scheduling, or queue actions.

## Requirements Trace

- The full-width process source reader must stop rendering source prose at 100% width.
- The currently constrained source reader must increase its text measure by a small amount.
- The two source-reading screens must use the same text width limit.
- The fix must match gold-standard incremental reading expectations: stable readable measure, generous gutters, and consistent long-form prose behavior across work surfaces.
- The change must be visually checked in the running app.

## Existing Patterns

- `apps/web/src/pages/source/reader.css` defines the canonical reader column with `.reader` and `.reader-rail`.
- `apps/web/src/pages/queue/process-queue.css` currently overrides the embedded source reader with `.pq-source__editor .reader { max-width: none; margin: 0; }`.
- `packages/editor/src/SourceEditor.tsx` always emits the `.reader` class, so route-specific wrappers should control exceptions carefully.
- Prior solution docs warn to preserve source reader scroll ownership and scope process source changes narrowly:
  - `docs/solutions/ui-bugs/source-reader-scroll-extents-rich-source-rendering.md`
  - `docs/solutions/ui-bugs/source-reader-taller-middle-area.md`
  - `docs/solutions/ui-bugs/process-queue-source-reader-unframed-workbench.md`

## Decisions

1. Introduce a shared reader-measure variable in `design/tokens.css`, set slightly wider than the current 680px.
2. Use that variable for both `.reader` and `.reader-rail` so standalone source text, progress/filter rail, marks, and rich images stay aligned.
3. In `apps/web/src/pages/queue/process-queue.css`, keep `.pq-card--source` unframed and full-height, but constrain `.pq-source__editor .reader` to the same reader-measure variable and center it within the workbench.
4. Leave extract distillation overrides alone unless visual or review evidence shows the user’s screenshots were extract-specific. The request describes two source-reading screenshots, and changing extract workbench width would broaden scope.

## Implementation Units

### U1: Shared Source Reader Measure

**Goal:** Replace duplicated `680px` reader text width values with a shared measure that is slightly wider.

**Modify:**
- `design/tokens.css`
- `apps/web/src/pages/source/reader.css`
- `apps/web/src/pages/source/reader-css.test.ts`

**Approach:**
- Define `--reader-text-measure` in the canonical design tokens so routes that do not import `reader.css` directly can still resolve the measure.
- Increase the measure modestly, e.g. `720px`.
- Use `max-width: var(--reader-text-measure)` on `.reader`.
- Use the same variable on `.reader-rail`.

**Test Scenarios:**
- CSS contract proves `.reader` declares the shared measure and uses it for `max-width`.
- CSS contract proves `.reader-rail` uses the same variable.
- Existing scroll-owner assertions still pass.

### U2: Process Source Reader Width Constraint

**Goal:** Stop the embedded source reader from using full-width prose while preserving the full-height unframed workbench.

**Modify:**
- `apps/web/src/pages/queue/process-queue.css`
- `apps/web/src/pages/queue/process-queue-css.test.ts`

**Approach:**
- Keep `.pq-card--source { max-width: none; }` so the workbench itself fills the center area.
- Change `.pq-source__editor .reader` from `max-width: none; margin: 0;` to `max-width: var(--reader-text-measure); margin: 0 auto;`.
- Preserve `width: 100%`, flex fill, `min-height: 0`, `max-height: none`, and `overflow-y: auto`.

**Test Scenarios:**
- CSS contract proves process source card remains unframed and full-height.
- CSS contract proves embedded source `.reader` uses `max-width: var(--reader-text-measure)` and `margin: 0 auto`.
- CSS contract proves embedded source `.reader` no longer contains `max-width: none`.

### U3: Visual Verification

**Goal:** Prove both source-reading surfaces render with matching constrained text measure.

**Verify:**
- Start the app or renderer with the existing development workflow.
- Open the standalone source reader and the `/process` source workbench.
- Inspect screenshots/geometry for both at desktop width.
- Confirm the text column is centered, constrained, and slightly wider than before, with no horizontal overflow and no lost scroll reachability.

## Verification

- `pnpm --filter @interleave/web test -- apps/web/src/pages/source/reader-css.test.ts apps/web/src/pages/queue/process-queue-css.test.ts`
- Relevant broader checks as time permits: `pnpm typecheck`, `pnpm test`.
- Browser/Electron visual check of `/source/$id` and `/process` source item geometry.
