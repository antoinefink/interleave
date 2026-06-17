# fix: DoneIntentMenu popover scrolls reading content up on open

**Type:** fix
**Depth:** Lightweight
**Date:** 2026-06-17

## Summary

Clicking **Done** on a partial source in the in-session queue reader opens the
`DoneIntentMenu` popover and the reading content jumps **up** instead of the menu simply
hovering. The popover CSS is already correct (`position: absolute`); the regression is a
**focus-induced scroll**. On open the component calls `laterRef.current?.focus()`, and because
the popover is anchored *downward* from an action bar that sits at the bottom of a fixed-height
`overflow: hidden` flex column, the browser scrolls the nearest scroll container to bring the
freshly-focused button into view — dragging the reading content upward.

Fix: pass `{ preventScroll: true }` to the on-open `focus()` call so focus moves without
scrolling any ancestor. Apply the same fix to the sibling `LineageDeleteMenu`, which focuses its
safe-default button on open with the identical latent bug.

## Problem Frame

- **Symptom:** Pressing Done (or the `d` shortcut) on a source with unresolved blocks visibly
  pushes the article text up; the user expects the menu to float over the content.
- **Surface:** In-session queue reader action bar (`ProcessQueue.tsx`), via the shared
  `DoneIntentMenu`. The standalone `SourceReader.tsx` uses the same component and benefits too.
- **Mechanism:** `useEffect` on `open` calls `laterRef.current?.focus()`
  ([`DoneIntentMenu.tsx`](../../apps/web/src/components/queue/DoneIntentMenu.tsx) line ~231).
  Default `focus()` performs scroll-into-view. The popover (`.doneintent__pop`,
  `top: calc(100% + 6px)`) lives below the bottom action bar inside
  `.pq-card--source` / `.pq-center--source` which are `overflow: hidden` fixed-height flex
  columns ([`process-queue.css`](../../apps/web/src/pages/queue/process-queue.css)). The focused
  button is at/below the clipped bottom edge, so the container scrolls and the reading content
  moves up.
- **Why only Done:** `ScheduleMenu` (Postpone), immediately adjacent and using the same popover
  CSS, never calls `.focus()` on open — so it never triggers the scroll. That contrast confirms
  the root cause lives in the focus call, not the CSS.

## Key Technical Decision

- **Use `focus({ preventScroll: true })` rather than re-architecting the popover into a portal.**
  The popover already hovers correctly (absolute positioning works); the only defect is the
  scroll side-effect of `focus()`. `preventScroll` is the minimal, native, well-supported
  (Chromium/Electron) fix that removes the side-effect without touching positioning, the shared
  visual pattern, or the overflow containers. A portal/`position: fixed` rewrite would be a
  larger, riskier change to a shared pattern and is unwarranted for this symptom.

## Implementation Units

### U1. Stop the on-open focus from scrolling the reading content

**Goal:** Prevent the reading content from scrolling up when the Done intent popover opens.

**Files:**
- `apps/web/src/components/queue/DoneIntentMenu.tsx` (modify — the `open` effect's focus call)
- `apps/web/src/components/lineage/LineageDeleteMenu.tsx` (modify — the on-open focus call, same latent bug)

**Approach:** Change `laterRef.current?.focus()` to
`laterRef.current?.focus({ preventScroll: true })` in the `open` effect. Apply the same change to
`keepRef.current?.focus()` in `LineageDeleteMenu`'s on-open effect. Do **not** change the Escape
handler's `triggerRef.current?.focus()` (returning focus to the trigger is in-flow and expected),
nor the arrow-key navigation focus calls (those move between already-visible popover buttons);
keep this change scoped to the on-open default-focus call where the scroll side-effect occurs.

**Patterns to follow:** Mirror the existing focus idiom in each file; only add the options object.

**Test scenarios:**
- `apps/web/src/components/queue/DoneIntentMenu.test.tsx` (modify/extend): opening the popover
  (via trigger click on a source with unresolved blocks) focuses the "Return later" button and
  the focus call is invoked with `{ preventScroll: true }`. Spy on
  `HTMLElement.prototype.focus` (or the button's `focus`) and assert the options argument.
- Regression guard: the default-focus target is still "Return later" (`data-testid="done-intent-later"`)
  and receives focus on open.
- `LineageDeleteMenu` test (if a focus-on-open test exists, extend it; otherwise add one): opening
  the descendant-aware delete menu focuses the safe default with `{ preventScroll: true }`.

**Verification:**
- `pnpm lint`, `pnpm typecheck`, `pnpm test` pass.
- In the running app (`pnpm dev`), pressing Done on a partial source opens the menu and the
  article text does **not** scroll/jump; the menu hovers over the content. Compare against the
  pre-fix behavior to confirm the jump is gone.

## Scope Boundaries

In scope: the `preventScroll` fix on the on-open focus call in `DoneIntentMenu` and
`LineageDeleteMenu`, plus a regression test.

### Deferred to Follow-Up Work
- Re-architecting the shared popover pattern (`DoneIntentMenu` / `ScheduleMenu` /
  `LineageDeleteMenu`) into a portal/anchored-overlay primitive with viewport-edge flipping
  (open upward when near the bottom). Not needed for this symptom; would be a separate refactor.

## Test Expectation

Behavioral change is the suppressed scroll-on-open. jsdom cannot exercise real layout/scroll, so
the regression test asserts the contract (`focus` invoked with `{ preventScroll: true }`) rather
than measuring scroll offset. Real-app manual verification covers the visual outcome.
