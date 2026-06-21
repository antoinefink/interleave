---
title: Action-bar overflow (kebab) menu + upward-opening popovers for a low bar
date: 2026-06-21
category: docs/solutions/design-patterns
module: apps/web process queue action bar (ProcessOverflowMenu, LineageDeleteMenu overlay, ScheduleMenu, DoneIntentMenu)
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - Collapsing infrequently-used actions behind a "more" (kebab) menu in a crowded action bar
  - Reusing an existing anchored confirm popover from a new trigger without re-implementing it
  - Any anchored popover whose trigger sits low in the work area (would clip if it opened downward)
tags: [action-bar, overflow-menu, kebab, popover, upward-popover, roving, aria, process-queue, pointer-events, overlay-trigger, lineage-delete]
---

# Action-bar overflow (kebab) menu + upward-opening popovers for a low bar

## Context

The `/process` session action bar (`.pq-actions` in `ProcessQueue.tsx`) showed eight buttons
(Open · Raise · Lower · Postpone · Dismiss · Delete · Skip · Done). On narrow windows it
crowded, and several actions (Raise, Lower, Delete) are used rarely. The redesign collapsed the
rare ones behind a "⋯" overflow menu. Three sub-problems came up that recur for any action-bar
menu in this app:

1. How to build the overflow itself without re-deriving the menu primitive.
2. How to keep the descendant-aware **Delete** confirm (`LineageDeleteMenu`) without nesting a
   popover inside the overflow popover, while still anchoring its confirm under the kebab.
3. The action bar sits **low** in the work area, so a downward-opening popover (the default for
   `ScheduleMenu` / `DoneIntentMenu` / `LineageDeleteMenu`) clips below the viewport here.

## Guidance

### 1. The overflow is a plain anchored ARIA action-list — NOT a submit-await surface

`ProcessOverflowMenu` (`apps/web/src/components/queue/ProcessOverflowMenu.tsx`) follows the
codebase's anchored-popover scaffold (`ScheduleMenu`/`DoneIntentMenu`: a `<span>` root, an
icon-only trigger with `Tooltip` + `aria-haspopup="menu"` + `aria-expanded`, outside-click +
Escape close) but is *simpler*: it just lists actions and dispatches on click. Because there is
no submit-then-await cycle, it needs **none** of the in-flight "reset-the-guard-on-`busy`-settling"
machinery the intent menus need (see [non-modal-intent-menu-replacing-confirm-gate](./non-modal-intent-menu-replacing-confirm-gate.md)) — `busy` simply disables the trigger.

It *does* add the ARIA-menu keyboard behavior `ScheduleMenu` lacks (do **not** copy ScheduleMenu's
focus-less Escape handler): on open, focus the first item with `focus({ preventScroll: true })`
(the scroll guard from [popover-autofocus-scrolls-clipped-container](../ui-bugs/popover-autofocus-scrolls-clipped-container.md));
Arrow Up/Down roving over `[data-menu-action]`; Tab closes; Escape closes and restores focus to the
trigger.

### 2. Re-anchor a kept-mounted menu's confirm via a CSS overlay — don't nest, don't `display:none` the wrapper

Delete must stay descendant-aware (a leaf deletes quietly; a node opens a confirm). Rather than
re-implement that, keep `LineageDeleteMenu` mounted and let the overflow's Delete item fire the
existing `deleteSignal` (the same signal the Delete key bumps via `requestDelete`). The trap is
anchoring: `.lindel__pop` is positioned relative to its own `.lindel` span, so a `display:none` or
zero-width trigger lands the confirm at an unpredictable wrapped-flex slot, detached from the "⋯".

The fix is a CSS overlay so the popover's positioning ancestor *is* the kebab's box:

```css
.pq-overflow-host {            /* wraps the kebab + the kept-mounted LineageDeleteMenu */
  position: relative;
  display: inline-flex;
}
.pq-overflow-host .lindel {    /* the lineage menu's root span — stretch it over the kebab */
  position: absolute;
  inset: 0;
  pointer-events: none;        /* so it never intercepts clicks meant for the kebab */
}
.pq-overflow-host .lindel__pop {
  pointer-events: auto;        /* re-enable ONLY the confirm popover, not the inert trigger */
  top: auto;
  bottom: calc(100% + 6px);    /* upward — see section 3 */
}
.pq-overflow__delete-anchor {  /* the inert trigger className passed to LineageDeleteMenu */
  display: none;               /* out of the tab order AND the accessibility tree */
}
```

Two deliberate choices: (a) `display: none` on the inert trigger — not `visibility: hidden`,
which leaves it Tab-reachable and announces a phantom "Delete" button to screen readers; the
trigger is fired programmatically by the signal, so it never needs to be focusable. (b)
`pointer-events: none` on the stretched `.lindel` (so the kebab underneath stays clickable) with
`pointer-events: auto` re-enabled on `.lindel__pop` alone (so the confirm's buttons work).
`.lindel`'s `inset: 0` gives it the kebab's box, so `.lindel__pop`'s `bottom: 100%` anchors under
the kebab regardless of flex wrapping. Give the overflow's Delete item its own testid
(`process-action-delete`) and the inert anchor a different one (`process-delete-anchor`).

### 3. Action-bar popovers open UPWARD, scoped to `.pq-actions`

The bar is the last child of the work area, so it sits near the viewport bottom. The shared menus
default to `top: calc(100% + 6px)` (downward) — correct in a queue row or the source reader, but
here the popover clips off the bottom. Override to upward, scoped to `.pq-actions` so the shared
components keep their downward default everywhere else:

```css
.pq-actions .schedmenu__pop,
.pq-actions .doneintent__pop {
  top: auto;
  bottom: calc(100% + 6px);
}
```

The overflow's own popover and the kebab-anchored delete confirm (section 2) open upward the same
way. This is the structural fix that [popover-autofocus-scrolls-clipped-container](../ui-bugs/popover-autofocus-scrolls-clipped-container.md)
deferred — its `preventScroll: true` treated the focus-yank symptom; opening upward removes the
clip itself.

## Why This Matters

- **Declutter without losing capability or agent-native parity.** Raise/Lower/Delete keep their
  keyboard shortcuts (`+`/`-`, Backspace/Delete) and stable testids — only *where the button
  renders* changed. Any caller/test that clicked them directly must now open the "⋯" first
  (`process-action-more`), so update those call sites in the same change.
- **Accessibility.** `display: none` (not `visibility: hidden`) on the inert delete anchor keeps a
  screen-reader user from hitting a phantom "Delete" button; the visible affordance is the kebab.
- **No clipping.** Upward popovers keep the confirm/schedule/done choices fully on screen at the
  low bar; verify visually (jsdom can't prove geometry — pin the CSS direction in a css-contract
  test and screenshot in Electron).
- **Reuse over re-implementation.** The overlay trick lets a kept-mounted menu's popover re-anchor
  to a new trigger without nesting popovers or forking the component.

## When to Apply

- Collapsing infrequent actions behind a kebab when a bar is crowded — keep the common 4-5 visible.
- Reusing an existing signal-fired confirm popover from a new trigger: overlay its root over the
  new trigger (`position:absolute; inset:0; pointer-events:none` + popover `pointer-events:auto`)
  rather than nesting or re-anchoring by hand.
- Any anchored popover whose trigger sits low in a clipped/`overflow:hidden` work area — open it
  upward, scoped to the local container so shared components keep their default elsewhere.

## When NOT to Apply

- Don't add the in-flight `submittingRef`/`fetchingRef` guard to a plain action-list overflow — it
  has no await cycle, so the guard would only be a deadlock risk. `busy` disabling the trigger is
  enough. (The guard IS needed for submit-await surfaces like `DoneIntentMenu`.)
- A new pointer-events-overlay path into a shared menu is a *new entry point*: cover it for
  StrictMode mount-guard correctness like the other paths
  ([strictmode-mountedref-cleared-only-on-cleanup](../ui-bugs/strictmode-mountedref-cleared-only-on-cleanup.md)).

## Known Gap

The loop's `useProcessShortcuts` binds keys on `window` at the capture phase and does **not**
suppress them while an action-bar popover is open — pressing `n`/Delete/etc. with the overflow (or
ScheduleMenu/DoneIntentMenu/LineageDeleteMenu) open still drives the loop underneath. This is
pre-existing across all those menus; the proper fix is a shared "is any action-bar popover open"
signal read at the top of the capture handler, plus a `target.id`-change reset in
`LineageDeleteMenu` so its confirm can't act on a swapped item. Tracked separately.

## Related

- [popover-autofocus-scrolls-clipped-container](../ui-bugs/popover-autofocus-scrolls-clipped-container.md) — the clipping symptom this upward rule structurally prevents (its deferred follow-up, now implemented).
- [non-modal-intent-menu-replacing-confirm-gate](./non-modal-intent-menu-replacing-confirm-gate.md) — `ScheduleMenu`/`DoneIntentMenu` anchored-popover shape + the in-flight-guard distinction this overflow intentionally skips.
- [cursor-anchored-context-menu-primitive](./cursor-anchored-context-menu-primitive.md) — the signal-driven hidden-trigger precedent for `LineageDeleteMenu`; this doc adds the CSS-overlay re-anchor.
- [strictmode-mountedref-cleared-only-on-cleanup](../ui-bugs/strictmode-mountedref-cleared-only-on-cleanup.md) — every `LineageDeleteMenu` entry point (now including the overlay path) needs the StrictMode mount-guard.
- [process-queue-inline-session-controls](../ui-bugs/process-queue-inline-session-controls.md) — why `.pq-actions` sits low in the work area, the spatial premise for opening upward.
- Plan: `docs/plans/2026-06-21-001-feat-process-session-topbar-redesign-plan.md`.
