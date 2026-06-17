---
title: "Anchored popover autofocus scrolls the reading content up instead of hovering (focus-induced scroll)"
date: "2026-06-17"
category: "docs/solutions/ui-bugs/"
module: "apps/web queue reader popovers (DoneIntentMenu, LineageDeleteMenu)"
problem_type: "ui_bug"
component: "frontend_stimulus"
symptoms:
  - "Clicking Done (or pressing the d shortcut) in the in-session queue reader opened the DoneIntentMenu popover and visibly shoved the article/reading content UP instead of letting the menu hover"
  - "The popover itself was positioned correctly (it appeared anchored below the Done button); only the surrounding content jumped"
  - "The adjacent Postpone menu (ScheduleMenu), using the identical popover CSS, did NOT exhibit the jump"
root_cause: "wrong_api"
resolution_type: "code_fix"
severity: "low"
tags:
  - "popover"
  - "focus-management"
  - "preventscroll"
  - "scroll-ownership"
  - "overflow-hidden"
  - "non-modal-menu"
---

# Anchored popover autofocus scrolls the reading content up instead of hovering

## Problem

Clicking **Done** on a partial source in the in-session queue reader
(`apps/web/src/pages/queue/ProcessQueue.tsx`) opened the `DoneIntentMenu` popover and the
reading content jumped **up** instead of the menu simply hovering over it. The user reported it
as "the menu pushes content up instead of hovering as we would expect."

## Symptoms

- Reading content scrolls/jumps upward the instant the Done intent popover opens.
- The popover is anchored and positioned correctly (`position: absolute; top: calc(100% + 6px); right: 0; z-index: 50` in `done-intent-menu.css`) — the popover is not the thing that moves.
- The sibling **Postpone** menu (`ScheduleMenu`), which uses the *identical* popover CSS, never shows the jump.

## What Didn't Work

- **Suspecting the CSS / flex layout.** The first hypothesis (and a plausible one) was that the
  popover was rendered in normal flow, or that the `.pq-actions` flex container with
  `flex-wrap: wrap` was reserving space and reflowing. Reading the CSS disproved this: the popover
  is `position: absolute`, fully out of flow, so it cannot push siblings. The CSS was already correct.

## Solution

The defect was a **focus-induced scroll**, not a positioning bug. On open, the component focuses
the safe default choice:

```ts
// apps/web/src/components/queue/DoneIntentMenu.tsx — effect on [open]
useEffect(() => {
  if (!open) return;
  laterRef.current?.focus();          // <-- before: default focus() scrolls into view
  ...
}, [open]);
```

A bare `focus()` performs scroll-into-view. The popover is anchored *downward*
(`top: calc(100% + 6px)`) from an action bar at the bottom of a fixed-height `overflow: hidden`
flex column (`.pq-card--source` / `.pq-center--source` in
`apps/web/src/pages/queue/process-queue.css`). The freshly-focused default button sits at or below
the container's clipped bottom edge, so the browser scrolls the nearest scroll container to bring
it into view — dragging the reading content up.

Fix: pass `{ preventScroll: true }` so focus lands without scrolling any ancestor.

```ts
laterRef.current?.focus({ preventScroll: true });   // after: focus, no scroll
```

The same latent bug existed in `apps/web/src/components/lineage/LineageDeleteMenu.tsx`
(`keepRef.current?.focus()` on open) and got the same fix.

**Scope the fix to autofocus-on-open only.** The Escape-handler `triggerRef.current?.focus()` and
the arrow-key navigation `next?.focus()` calls were deliberately left as plain `focus()` — their
targets are already in-viewport (the trigger lives in the always-visible action bar; arrow-nav
moves between buttons inside the open popover), so revealing them via scroll is correct there.

## Why This Works

`focus({ preventScroll: true })` moves focus (preserving keyboard-first hygiene) without invoking
the user-agent's scroll-into-view. Because the popover was already painting in the right place,
removing the scroll side-effect is all that was needed — the menu now hovers.

**The diagnostic key was the sibling contrast.** `ScheduleMenu` (Postpone) uses the same popover
CSS but never calls `focus()` on open, so it never triggered the scroll. That single difference
pinned the root cause to the focus call rather than the CSS — when two near-identical components
differ in one behavior and only one has the bug, that behavior is the cause.

## Prevention

- **For autofocus-on-open in any anchored, non-modal overlay (popover, dropdown, menu) that lives
  inside or is anchored past the edge of an `overflow: hidden`/scrollable container, use
  `focus({ preventScroll: true })`.** A plain `focus()` will scroll the container to reveal the
  focused element, which reads as the overlay "pushing content" rather than hovering.
- Keep the `preventScroll` only on the on-open default-focus call; focus calls whose targets are
  already visible (Escape-return to an in-viewport trigger, intra-popover arrow navigation) should
  keep the default scroll-into-view behavior.
- Regression test contract (jsdom has no layout, so assert the focus *contract*, not a scroll
  offset). Bind the assertion to the **specific** default element via `mock.instances`, not a
  blanket "some focus call passed preventScroll" — the loose form would still pass if an unrelated
  element kept `preventScroll` while the on-open call regressed:

  ```ts
  const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
  // ... open the popover, await activeElement === defaultButton ...
  const defaultFocusedWithoutScroll = focusSpy.mock.instances.some(
    (el, i) =>
      el === defaultButton &&
      (focusSpy.mock.calls[i]?.[0] as FocusOptions | undefined)?.preventScroll === true,
  );
  expect(defaultFocusedWithoutScroll).toBe(true);
  ```

  Confirm the guard with a negative control: reverting the fix should fail *only* this test.

## Deferred / Follow-Up

The deeper architectural smell is the shared "absolute popover inside `overflow: hidden`" pattern
across `DoneIntentMenu` / `ScheduleMenu` / `LineageDeleteMenu`. `preventScroll` fixes the observed
symptom; it does not make the popover escape the clip. If a future viewport configuration clips the
popover, the more robust fix is a portal / `position: fixed` overlay anchored to the trigger's
bounding rect with viewport-edge flipping (open upward when near the bottom). That refactor was out
of scope for this fix.
