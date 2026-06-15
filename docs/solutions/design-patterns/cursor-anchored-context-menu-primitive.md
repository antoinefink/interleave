---
title: "Cursor-anchored context-menu primitive: measure-hidden-then-flip, and the focus/scroll/blur gotchas that dismiss it"
date: "2026-06-15"
category: "docs/solutions/design-patterns/"
module: "apps/web menu primitive (ContextMenu + LineageContextMenu across the Inspector lineage tree)"
problem_type: "design_pattern"
component: "frontend_stimulus"
severity: "medium"
applies_when:
  - "Building a reusable right-click / cursor-anchored popover that opens at clientX/clientY with position:fixed and must flip + clamp into the viewport"
  - "A menu must render hidden on the first frame, self-measure via getBoundingClientRect, then flip left/up and clamp before the first visible paint"
  - "An open-time focus() (or scroll-into-view) is dismissing the menu, or a scroll while a submenu is open collapses the selection"
  - "Commit-on-blur inline rename can silently lose data or double-fire teardown, and focus-restore can throw because the opener was detached by a refresh"
  - "Cross-component trigger state (target + cursor position + open signal) is racing and needs to be one atomic setState"
related_components:
  - "apps/web/src/components/menu/ContextMenu.tsx"
  - "apps/web/src/components/menu/types.ts"
  - "apps/web/src/components/menu/context-menu.css"
  - "apps/web/src/components/inspector/LineageContextMenu.tsx"
  - "apps/web/src/components/inspector/lineageNodeActions.ts"
  - "apps/web/src/lib/deep-link.ts"
tags:
  - context-menu
  - popover
  - focus-management
  - viewport-flip
  - blur-commit
  - react-renderer
---

# Cursor-anchored context-menu primitive

## Context

When the lineage tree needed a right-click menu, the obvious choice was Electron's native
`Menu`/`popup`. We rejected it: the renderer must stay free of `appApi`/IPC/Node for purely
presentational UI, native menus can't render our token-themed surface (light/dark, our
spacing/radii), and they're hard to test in the renderer's Vitest/jsdom + Playwright loop.
The codebase already had a hand-rolled popover in `LineageDeleteMenu` (outside-click close,
Escape + focus restore, `ArrowUp`/`Down` over `[data-menu-action]`, role/aria, token-only
CSS) — but every popover we had was **trigger-anchored** (positioned relative to a button).
None were **cursor-positioned** at an arbitrary `clientX/clientY`. The primitive at
`apps/web/src/components/menu/ContextMenu.tsx` generalizes the proven `LineageDeleteMenu`
mechanics and adds the missing capability: open at a cursor point with viewport-edge
flipping and one submenu level.

A related convention shipped alongside it: a **deep-link / copy-reference string**
`interleave://element/<id>` (`apps/web/src/lib/deep-link.ts`). There was no prior
copy-reference convention; the canonical string lives in one pure helper so a future OS
protocol handler can reuse it (registering that handler was deferred).

## Guidance

**Controlled, presentational shape.** The parent owns `open` + `position`; the menu reports
its own dismissal via `onClose`. It renders nothing of its own domain logic.

```tsx
function ContextMenu({
  open,
  position,            // { x, y } cursor anchor (clientX/clientY)
  items,               // readonly ContextMenuItem[]  (action | submenu | separator)
  onClose,
  ariaLabel,
  testId = "context-menu",
}): JSX.Element | null
```

**Measure-hidden-first-frame -> flip -> clamp.** You cannot place a `position: fixed` menu
correctly until you know its size, and you don't know its size until it mounts. So render it
at the raw anchor but `visibility: hidden` on the first frame, measure in `useLayoutEffect`,
then compute final coords:

```tsx
const style = rect
  ? { left: rect.left, top: rect.top }
  : { left: position.x, top: position.y, visibility: "hidden" };
```

`resolvePlacement(anchor, size, viewport, margin)` flips left when `anchor.x + width`
overflows the right edge (so the menu's right edge sits at the cursor), flips up
symmetrically on the bottom edge, then clamps into `[margin, viewport - size - margin]`.
Recompute on open only (anchor `x`/`y` and `items` are the deps) — there is no resize/scroll
reposition loop; scrolling simply closes the menu, which is simpler and acceptable for v1.
Submenus open to the side and flip toward whichever side has room
(`flipSubmenuLeft = rect.left > window.innerWidth / 2`).

**One submenu level, no deeper.** Items are a flat union (`action`, `submenu`, `separator`);
a `submenu` renders its parent button plus one nested `.ctxmenu` list. Keep it one level —
deeper nesting multiplies the positioning and focus edge cases for no product need. Model a
destructive confirm (e.g. "Delete permanently…") as a one-child danger submenu so no
top-level item ever fires the irreversible action directly.

**The five hardening gotchas** (all landed in the code-review fix `02b3a977`):

(a) **Inline rename: commit-on-blur + a `doneRef` latch.** "Edit, then click away" must SAVE,
not silently drop the edit — so `onBlur` commits (not cancels). But commit/cancel set
`rename = null`, which unmounts the input and fires a second `blur`; without a guard you'd
run teardown twice. A one-shot ref latch fixes both:

```tsx
const doneRef = useRef(false);
const finish = (commit: boolean) => {
  if (doneRef.current) return;          // unmount-blur after Enter is a no-op
  doneRef.current = true;
  commit ? onCommit(value) : onCancel();
};
// onKeyDown Enter -> finish(true); Escape -> finish(false); onBlur -> finish(true)
```

(b) **Defer scroll-close one rAF + ignore while a submenu is open.** The open-time
`first.focus()` can trigger a `scrollIntoView`, and a naive scroll-closes-the-menu listener
would then dismiss the menu the instant it opens. Attach the scroll listener one frame later,
and ignore scroll entirely while a submenu is open (a stray scroll shouldn't collapse an
in-progress selection):

```tsx
const onScroll = () => { if (!openSubmenuIdRef.current) onClose(); };
const raf = requestAnimationFrame(() =>
  window.addEventListener("scroll", onScroll, true));
return () => { cancelAnimationFrame(raf); /* + removeEventListener */ };
```

`openSubmenuIdRef` is a latest-value ref (`openSubmenuIdRef.current = openSubmenuId` during
render) so the capture-phase handler reads current submenu state without re-subscribing.

(c) **`isConnected` focus-restore guard.** The menu captures `document.activeElement` on open
and restores focus on close — but a mutation (rename/delete) refreshes the tree and
**detaches** the original opener. Focusing a detached node throws or strands focus on `<body>`:

```tsx
const opener = restoreFocusRef.current;
if (opener?.isConnected) opener.focus?.();   // skip if detached
```

(d) **Arrow-nav scoped to the open submenu.** When a submenu is open, `ArrowUp`/`Down` must
cycle the submenu's children, not escape back to the top level. `navItems()` queries the open
`[data-submenu-id="…"]` subtree when one is open; otherwise it queries top-level items only
via `:scope >` (direct actions + submenu-parent buttons), so it stays exactly one level deep.
`moveFocus` wraps with `(idx + delta + len) % len`.

(e) **Atomic cross-component trigger state.** The container drives a *hidden*
`LineageDeleteMenu` by a bumped `signal` rather than a click. Target, anchor position, and
signal must move together — if they were three `useState`s, the consumer's effect could
observe a new signal against a stale target and act on the wrong node. Keep them in ONE state
object updated in ONE `setState`:

```tsx
setDeleteState((prev) => ({
  target: { id: n.id, type: n.type, title: n.title },
  position,
  signal: (prev?.signal ?? 0) + 1,
}));
```

**Stable item identity.** Build the catalog inside a `useMemo` keyed on the right-clicked
node. Without a stable `items` reference, the menu's `useLayoutEffect([items])` re-measures on
every unrelated re-render (a toast, a snackbar) and an open submenu remounts and steals focus.

**Global-CSS-leak rule.** In this Vite renderer `import "./context-menu.css"` is GLOBAL — a
bare `.menu`/`.item` selector would leak app-wide. Namespace EVERY selector under one root
class (`.ctxmenu`). **Tokens only** for spacing/color/radii: the review changed hard-coded
`padding: 6px` to `padding: var(--s-2) var(--s-3)` so the primitive flips correctly under
`[data-theme="dark"]` with nothing branching on theme. (See
[scope-ported-design-kit-css-under-page-root](scope-ported-design-kit-css-under-page-root.md).)

## Why This Matters

Cursor-anchored menus are a swamp of edge cases — off-screen placement, focus theft,
accidental self-dismissal, lost edits, wrong-node actions. Each gotcha here is a real bug a
reviewer caught, not a hypothetical. Getting them wrong produces a menu that *mostly* works
and then loses a user's rename or deletes the wrong subtree under fast interaction. Building
on `LineageDeleteMenu`'s already-tested mechanics (outside-click, Escape, aria, token CSS)
meant only the new surface — positioning + submenu + cross-component trigger — needed
hardening.

## When to Apply

- Any in-app menu/popover anchored to a cursor or arbitrary point rather than a trigger
  element.
- Any popover that performs a mutation which refreshes/replaces the DOM it was opened from
  (restore focus defensively with `isConnected`).
- Any inline edit field that must not lose work on blur (commit-on-blur + one-shot latch).
- Any "fire a hidden controller by a signal bump" pattern across components (keep
  target + signal in one atom).
- Reach for the native Electron menu only when you specifically need OS chrome; otherwise an
  in-app menu stays themeable, testable, and renderer-pure.

## Examples

- Primitive: `apps/web/src/components/menu/ContextMenu.tsx` (`resolvePlacement`, `navItems`,
  the rAF-deferred scroll listener, `flipSubmenuLeft`).
- Host + the five gotchas in use: `apps/web/src/components/inspector/LineageContextMenu.tsx`
  (`RenameInput` with `doneRef`, the memoized `items` catalog, the atomic `deleteState`).
- Pure type-aware catalog: `apps/web/src/components/inspector/lineageNodeActions.ts`.
- CSS: `apps/web/src/components/menu/context-menu.css` (every selector under `.ctxmenu`,
  token-only spacing).
- Hardening commit: `02b3a977`.

## Related

- [non-modal-intent-menu-replacing-confirm-gate](non-modal-intent-menu-replacing-confirm-gate.md)
  — the anchored-popover + focus-management precedent this primitive generalizes.
- [scope-ported-design-kit-css-under-page-root](scope-ported-design-kit-css-under-page-root.md)
  — the global-CSS-leak / root-scoping rule the menu CSS follows.
- [large-selection-toolbar-visible-viewport-anchoring](../ui-bugs/large-selection-toolbar-visible-viewport-anchoring.md)
  — sibling "fixed-position surface must clamp to visible viewport geometry" problem.
- [inspector-deleted-lineage-visibility](../ui-bugs/inspector-deleted-lineage-visibility.md)
  — the LineageTree / tombstone surface this menu is wired into (T135/U2 inline Restore).
