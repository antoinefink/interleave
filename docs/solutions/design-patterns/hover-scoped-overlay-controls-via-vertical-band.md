---
title: Scope sibling-overlay controls to one element via cursor vertical band
date: 2026-06-17
category: docs/solutions/design-patterns
module: source-reader
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "per-element action controls live in an absolutely-positioned overlay that is a DOM sibling of the content, not inside it, so CSS :hover cannot cross the subtree boundary"
  - "the content is rendered by a component whose DOM you must not mutate (ProseMirror/Tiptap, CodeMirror, a virtualized list)"
  - "controls should reveal only for the single element under the cursor, not for every element whenever the container is hovered"
  - "the controls are vertically aligned with their element but horizontally offset (margin icons, a side rail) so the user must reach across a gap to click them"
  - "the content scrolls inside an inner scroller rather than the window"
tags:
  - hover-reveal
  - y-band
  - pointermove
  - data-hovered
  - sibling-overlay
  - reach-for-control
  - source-reader
  - prosemirror
  - pointer-events
---

# Scope sibling-overlay controls to one element via cursor vertical band

## Context

In the source reader, every body paragraph has three margin action icons (mark
processed / extract / restore, ignore, needs-later). They are rendered as an
absolutely-positioned React overlay (`.readpara-overlay`) that is a **DOM sibling**
of the live ProseMirror editor — never injected into the editor DOM, because
ProseMirror's MutationObserver would wipe injected nodes on the next reconcile. The
overlay and the paragraphs are joined only by a shared `data-block-id` attribute.

The original reveal was a single CSS rule, `.reader-rail:hover .readpara__mark`,
which lit up **every** paragraph's icons whenever the cursor was anywhere over the
article — a wall of icons on a long source. The goal was to reveal only the icons
of the paragraph the cursor is on (at most one group of three at a time).

The forcing constraint: **two DOM subtrees joined only by a data attribute cannot
share hover state through CSS alone.** There is no selector that says "reveal the
overlay group whose `data-block-id` matches the `<p>` the cursor is over" when the
`<p>` and the group live in separate trees. Injecting wrappers into the editor DOM
is off the table. So the reveal has to be driven by JavaScript/React state.

## Guidance

Track the hovered element by the cursor's **vertical position** against measured
element bands, and tag only the matching overlay group with a `data-hovered`
attribute that CSS keys off. Three steps:

**1. Measure rail-relative bands** on mount / editor transaction / resize / a
`revision` token. Record each element's top and bottom offset relative to the shared
positioning ancestor (the rail), in a single read pass (no interleaved writes, so no
forced reflow):

```ts
const railTop = rail.getBoundingClientRect().top;
for (const block of rail.querySelectorAll(`[${BLOCK_ID_DOM_ATTR}]`)) {
  if (!isParagraph(block)) continue;
  const rect = block.getBoundingClientRect();
  anchors.push({ blockId, top: rect.top - railTop, bottom: rect.bottom - railTop });
}
```

**2. Resolve cursor Y to a band on `pointermove`.** Pad each band by a small
tolerance so adjacent bands meet (inter-paragraph margins would otherwise drop hover
to null mid-gap and flicker). Where padded bands overlap, a nearest-center tiebreak
picks the closer element:

```ts
const HOVER_BAND_TOLERANCE_PX = 24;
function blockIdForY(y: number, anchors: readonly BlockAnchor[]): string | null {
  let best: { blockId: string; distance: number } | null = null;
  for (const a of anchors) {
    if (y >= a.top - HOVER_BAND_TOLERANCE_PX && y <= a.bottom + HOVER_BAND_TOLERANCE_PX) {
      const distance = Math.abs(y - (a.top + a.bottom) / 2);
      if (!best || distance < best.distance) best = { blockId: a.blockId, distance };
    }
  }
  return best ? best.blockId : null;
}
```

**3. Tag one group; let CSS project it.** The overlay renders one group per anchor
with `data-hovered={a.blockId === hoveredBlockId ? "true" : "false"}`. The data
attribute is the *only* bridge between the JS resolution and the visual reveal — no
JS touches `opacity`/`pointer-events` directly:

```css
.readpara__mark                                          { opacity: 0; pointer-events: none; }
.readpara__actions[data-hovered="true"] .readpara__mark  { opacity: 1; pointer-events: auto; }
.readpara__mark[data-processed="true"]                   { opacity: 0.74; pointer-events: auto; }
```

## Why This Matters

**Y-band keying geometrically solves the "reach-for-control" gap without a
close-grace timer.** The icons sit ~88px out in the margin, so an instant
hide-on-`mouseleave` would make them vanish *while the user reaches for them* — the
classic failure mode documented in
[cursor-anchored-context-menu-primitive.md](../design-patterns/cursor-anchored-context-menu-primitive.md),
which solves it with a hover-intent delay plus a safe-triangle. Here, because the
buttons share their paragraph's vertical band, moving the cursor **horizontally**
into the margin barely changes `clientY` — the active band never changes, so the
controls stay revealed with zero timer logic. This is the key design divergence from
the context-menu primitive: **prefer geometric band keying over a grace timer when
the controls are row-scoped and vertically aligned with their element.** Do not
"fix" it by adding a timer.

**Performance: a change-guard ref keeps `pointermove` off the React render path.**
`pointermove` fires 60+/sec. Mirror the hovered id in a ref and only call `setState`
when the resolved id actually changes (i.e. the cursor crosses a band boundary):

```ts
const activeRef = useRef<string | null>(null);
const setActive = useCallback((id: string | null) => {
  if (activeRef.current === id) return; // change-guard: no render on intra-element movement
  activeRef.current = id;
  setHoveredBlockId(id);
}, []);
```

The listener reads the latest anchors via a ref too (`anchorsRef.current`), so it
never re-subscribes when anchors change — the effect deps stay stable.

## When to Apply

- **Apply** when controls must live in a sibling/parallel subtree (third-party or
  editor-owned content DOM), are vertically aligned with their element, and only one
  element's controls should show at a time, on a pointer-driven surface.
- **Do not apply** when the controls *can* live in the same subtree as the element —
  plain CSS `:hover` on a wrapper is simpler and needs no JS.
- **Do not apply** to floating popovers offset *above/below* the trigger (e.g. a
  selection toolbar) — diagonal travel there genuinely crosses a gap, so the
  safe-triangle / close-grace approach fits better.
- Touch / coarse-pointer is out of scope: `pointermove` does not fire on a tap, and
  88px margin icons are a poor touch target regardless. This stays desktop-first.

## Examples

Robustness gotchas worth reusing (each one was a real review finding):

- **Clear hover when the active element leaves the measured set.** Filters can hide
  the hovered paragraph; after remeasure, drop a dangling active id so it never
  points at an unrendered group:
  `if (activeRef.current && !next.some(a => a.blockId === activeRef.current)) setActive(null);`
- **Handle `pointercancel`, not just `pointerleave`.** Touch/pen and OS gesture
  capture fire `pointercancel`; without it a group can stick revealed. Wire the same
  clear handler to both.
- **Re-resolve on the inner scroller's `scroll`, not `window.scroll`.** The reader
  body (`.reader-page`) owns vertical scroll. Wheel-scrolling with a stationary
  cursor fires no `pointermove`, so cache the last pointer Y and re-resolve the band
  on the scroller's scroll event. Coordinates stay viewport-relative
  (`clientY` − `rail.getBoundingClientRect().top`) — never add inner-scroll offsets
  (see [source-reader-scroll-extents-rich-source-rendering.md](../ui-bugs/source-reader-scroll-extents-rich-source-rendering.md)
  and [large-selection-toolbar-visible-viewport-anchoring.md](../ui-bugs/large-selection-toolbar-visible-viewport-anchoring.md)).
- **Hidden controls must be inert** (`pointer-events: none`) so the always-present,
  invisible margin buttons don't intercept clicks; the hovered group flips to
  `pointer-events: auto`.
- **Keep a persistent always-clickable exception** for a control that must stay
  reachable while hidden (the restore button on an already-processed paragraph keeps
  `pointer-events: auto` so undo never requires a hover first).

The reveal is presentation-only state; every action the icons fire still routes
through the durable block-processing service contract — see
[durable-source-block-processing-state.md](../architecture-patterns/durable-source-block-processing-state.md).
Hover affordance on the buttons themselves uses border-color, not box-shadow, per
[hover-uses-border-not-shadow-and-shadow-taxonomy.md](../conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md).

## Related

- [cursor-anchored-context-menu-primitive.md](../design-patterns/cursor-anchored-context-menu-primitive.md) — the timer + safe-triangle alternative; this pattern is the no-timer, row-scoped counterpart.
- [large-selection-toolbar-visible-viewport-anchoring.md](../ui-bugs/large-selection-toolbar-visible-viewport-anchoring.md) — viewport-relative geometry for reader overlays.
- [source-reader-scroll-extents-rich-source-rendering.md](../ui-bugs/source-reader-scroll-extents-rich-source-rendering.md) — the reader's inner-scroller ownership.
- [durable-source-block-processing-state.md](../architecture-patterns/durable-source-block-processing-state.md) — the durable state the icons mutate.
- [hover-uses-border-not-shadow-and-shadow-taxonomy.md](../conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md) — hover affordance convention.
- Implementation: `apps/web/src/pages/source/ProcessedSpanButtons.tsx`, `apps/web/src/pages/source/reader.css`.
