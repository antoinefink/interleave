---
title: "feat: Scope per-paragraph reader action icons to the hovered paragraph"
type: feat
date: 2026-06-17
status: ready
depth: lightweight
area: apps/web (source reader)
---

# feat: Scope per-paragraph reader action icons to the hovered paragraph

## Summary

In the source reader, each body paragraph carries three margin action icons (mark
processed / extract / restore, ignore, needs-later). Today **every** paragraph's icons
appear at once whenever the cursor is anywhere over the article body — a single CSS rule,
`.reader-rail:hover .readpara__mark { opacity: 1 }`, reveals them all. This plan replaces
that with **per-paragraph hover scoping**: only the icons of the paragraph the cursor is
currently on are shown, so the reader sees at most one group of three icons at a time.

The change is presentational only. It introduces React hover state in the existing
`ProcessedSpanButtons` overlay and reworks the reveal/pointer-events rules in `reader.css`.
No block-processing state, IPC, persistence, or icon behavior changes.

---

## Problem Frame

- **Current behavior:** `.reader-rail:hover .readpara__mark` lights up all paragraphs'
  buttons simultaneously while the pointer is anywhere in the rail. With a long article
  this is a wall of icons (see the reported screenshot) — visually noisy and undercuts the
  "calm reading surface" intent.
- **Desired behavior:** the three icons appear only beside the paragraph under the cursor;
  moving down the article moves the single visible icon group with the cursor.
- **Why it isn't a one-line CSS change:** the article body is a live ProseMirror editor.
  The icons are **not** in the editor DOM — they are a sibling absolutely-positioned React
  overlay (`.readpara-overlay`), joined to paragraphs only by a shared `data-block-id`.
  CSS `:hover` cannot cross from a `<p>` in the editor subtree to a `.readpara__actions`
  group in the overlay subtree. Reveal scoping therefore needs React state keyed by block.

---

## Requirements

- **R1.** When the cursor is over a body paragraph, only that paragraph's three icons are
  shown; all other paragraphs' icons are hidden.
- **R2.** When the cursor is not over any body paragraph (cursor outside the article body,
  or over a heading/image/list with no icons), no icon group is shown — except the
  persistent-restore exception in R4.
- **R3.** The user can still reach and click the icons. Because the icons sit ~88px out in
  the right margin, the active paragraph must remain active while the cursor travels
  horizontally from the paragraph text to its icons (no "vanish while reaching" — a
  documented failure mode, see origin learnings below).
- **R4.** Preserve the existing persistent-restore affordance: a paragraph already in a
  processed/terminal state keeps its primary (restore) icon faintly visible
  (`opacity: 0.74`) regardless of hover, so the user can always undo.
- **R5.** Preserve all existing icon behavior, accessibility names, disabled states
  (extracted blocks), filter visibility, and persistence. Only the *reveal trigger*
  changes.
- **R6.** Inactive (hidden) icons must not be clickable — an invisible button in the margin
  must not intercept pointer input. (Today's buttons are `pointer-events: auto` even at
  `opacity: 0`; this is tightened.)

---

## Key Technical Decisions

- **KTD1 — Track the hovered paragraph by the cursor's vertical position, not by
  per-element `:hover`.** A single `pointermove` listener on `.reader-rail` maps the
  cursor's Y (relative to the rail) to the paragraph whose measured vertical band contains
  it, and stores that block id in React state. This is chosen over attaching
  `mouseenter`/`mouseleave` to each `<p>` because:
  - It **inherently satisfies R3**: the icon group shares its paragraph's Y band, so moving
    the cursor horizontally from the text into the margin toward the icons keeps the same
    paragraph active — no close-grace timer or "hover bridge" needed.
  - It is one listener, not N, and avoids wiring React handlers onto ProseMirror-managed
    nodes (which the editor owns and re-renders).
  - The alternative — `mouseover`/`mouseout` delegation plus a close-grace timer plus
    group keep-alive handlers — is the codebase's `cursor-anchored-context-menu` pattern,
    but it is more moving parts for the same outcome here. (See Alternatives.)
- **KTD2 — Guard state updates by a ref.** `pointermove` fires often; keep the
  current active block id in a ref and call `setState` only when the mapped block id
  actually changes. No re-render on intra-paragraph movement.
- **KTD3 — Reveal via a `data-hovered` attribute on the group, not a CSS rail-hover.**
  The active `.readpara__actions` group renders `data-hovered="true"`; CSS reveals
  `.readpara__actions[data-hovered="true"] .readpara__mark`. This mirrors the existing
  `data-processed` attribute convention and is trivially assertable in tests.
- **KTD4 — Pointer-events follow visibility.** Hidden icons get `pointer-events: none`;
  the active group's icons get `pointer-events: auto`; the persistent-restore button
  (`[data-processed="true"]`) keeps `pointer-events: auto` so it is always clickable (R4,
  R6).
- **KTD5 — Band rule with gap tolerance.** A paragraph's active band is
  `[top - TOL, bottom + TOL]` where `TOL` is a small constant (≈ the inter-paragraph
  margin) so adjacent paragraph bands meet and crossing the gap between two paragraphs does
  not flicker. Y outside every band (e.g. mid-heading, below the last paragraph, in the
  bottom breathing room) clears the active block. Bands are derived from each paragraph's
  measured rect; `measureAnchors` is extended to also record `bottom`.

---

## High-Level Technical Design

```
.reader-rail  (positioning context; pointermove listener here)
├── .ProseMirror (editor DOM)        ── paragraphs <p data-block-id=…>  (Y bands)
│        ▲ cursor Y ──────────┐
│                             │ map clientY-railTop → band → blockId (ref-guarded)
└── .readpara-overlay         ▼            setHoveredBlockId(blockId)
     ├── .readpara__actions[top=A]  data-hovered={blockId===hovered}  → reveal A's 3 icons
     ├── .readpara__actions[top=B]  data-hovered=false                → hidden
     └── … (one group per measured paragraph)

Reveal (CSS, replaces `.reader-rail:hover .readpara__mark`):
  .readpara__mark                                   → opacity 0;  pointer-events none
  .readpara__actions[data-hovered="true"] .readpara__mark → opacity 1; pointer-events auto
  .readpara__mark[data-processed="true"]            → opacity 0.74; pointer-events auto (persists)
```

Because the icon group sits at the same `top` as its paragraph, the cursor's Y stays inside
the paragraph's band as it moves right to the icons — that is the whole reason no timer is
required.

---

## Implementation Units

### U1. Per-paragraph hover state + vertical-band pointer tracking

**Goal:** Make `ProcessedSpanButtons` track which paragraph the cursor is on and mark only
that group `data-hovered="true"`.

**Requirements:** R1, R2, R3, R6, KTD1, KTD2, KTD5.

**Dependencies:** none.

**Files:**
- `apps/web/src/pages/source/ProcessedSpanButtons.tsx` (modify)
- `apps/web/src/pages/source/ProcessedSpanButtons.test.tsx` (extend — see U3)

**Approach:**
- Extend `BlockAnchor` with `bottom` (or `height`); record it in `measureAnchors` from the
  same `getBoundingClientRect()` already taken (`bottom - railTop`).
- Add `hoveredBlockId` state and an `activeRef` mirroring it (KTD2).
- In the existing editor-wiring `useEffect`, attach a `pointermove` listener to the
  `.reader-rail` element (the same `rail` already resolved via
  `editor.view.dom.closest(".reader-rail")`) and a `pointerleave` listener that clears the
  hover. On move: compute `y = e.clientY - rail.getBoundingClientRect().top`, find the
  matching anchor by band (KTD5), and `setHoveredBlockId` only when it differs from
  `activeRef.current`. Clean up listeners in the effect teardown alongside the existing
  `transaction`/`ResizeObserver`/`resize` teardown.
- Clear/repair hover when anchors change (e.g. the active block is filtered out): if
  `hoveredBlockId` is no longer in `anchors`, the group simply won't render — ensure no
  stale state causes errors; reset to `null` when anchors become empty.
- Render `data-hovered={a.blockId === hoveredBlockId ? "true" : "false"}` on each
  `.readpara__actions` group.
- Keep the listener cheap: read `railTop` per move (single element, no interleaved writes),
  linear scan of anchors with the change-guard. No `mousemove`-driven re-renders.

**Patterns to follow:** the existing ref + listener + cleanup shape already in this file
(`remeasure`, `editor.on("transaction")`, `ResizeObserver`); the `data-processed` attribute
convention for state-on-element.

**Test scenarios (unit — U3 holds the file):**
- Hovering paragraph A's Y band sets `data-hovered="true"` on A's group and `"false"` on
  B's group.
- Moving the pointer to B's Y band swaps: B `true`, A `false` (only one active at a time).
- Pointer Y between the two paragraphs (within tolerance) keeps the nearer one active (no
  flicker to `null`).
- `pointerleave` on the rail clears hover: all groups `data-hovered="false"`.
- Pointer Y at a paragraph's `top` but far to the right (icon-column X) still resolves to
  that paragraph (band is Y-only) — proves R3.
- State updates are change-guarded: repeated moves within one paragraph's band do not
  change the active id (assert via the resolved attribute remaining stable; a render-count
  probe is optional).

**Verification:** In the running app, hovering one paragraph shows exactly one group of
three icons; moving down the article moves the single group; leaving the body hides all.

---

### U2. Reveal + pointer-events CSS model

**Goal:** Replace the global rail-hover reveal with per-group `data-hovered` reveal and make
pointer-events follow visibility, preserving the processed persistent-restore exception.

**Requirements:** R1, R4, R5, R6, KTD3, KTD4.

**Dependencies:** U1 (groups must emit `data-hovered`).

**Files:**
- `apps/web/src/pages/source/reader.css` (modify, ~lines 571–623)
- `apps/web/src/pages/source/reader-css.test.ts` (extend — see U3)

**Approach:**
- `.readpara__mark`: keep `opacity: 0`; change `pointer-events: auto` → `pointer-events:
  none` (hidden icons are inert, R6).
- Remove `.reader-rail:hover .readpara__mark { opacity: 1 }` (the global reveal).
- Add `.readpara__actions[data-hovered="true"] .readpara__mark { opacity: 1; pointer-events:
  auto; }` (scoped reveal, KTD3/KTD4).
- Keep `.readpara__mark[data-processed="true"] { opacity: 0.74; … }` and add
  `pointer-events: auto` to it so the persistent restore stays clickable even when its group
  is not hovered (R4). The scoped-reveal rule still brightens it to `opacity: 1` when its
  paragraph is hovered.
- Remove the now-redundant `.readpara__actions:hover .readpara__mark` rule (reveal is driven
  by `data-hovered`, not the group's own `:hover`).
- Leave `.readpara__mark:hover` (per-button accent affordance) and the processed-hover rule
  intact — they govern button styling, not group visibility, and already follow the
  border-not-shadow hover convention.
- Do not touch the dimming projection (`p.dimmed`) or any non-overlay reader chrome.

**Patterns to follow:** existing token usage, the `data-processed` attribute selectors
already in this block, and the hover-uses-border-not-shadow convention.

**Test scenarios:** covered by U3's CSS contract assertions.

**Verification:** With U1, the reveal is scoped to the hovered paragraph; processed
paragraphs still show their faint restore icon when not hovered; inactive icons do not
intercept clicks.

---

### U3. Tests — unit, CSS contract, and e2e hover scoping

**Goal:** Pin the new behavior so it cannot silently regress, and update the existing e2e
which clicks icons that are now hidden until hovered.

**Requirements:** R1–R6.

**Dependencies:** U1, U2.

**Files:**
- `apps/web/src/pages/source/ProcessedSpanButtons.test.tsx` (extend)
- `apps/web/src/pages/source/reader-css.test.ts` (extend)
- `tests/electron/processed-spans.spec.ts` (modify)

**Approach & test scenarios:**

*Unit (`ProcessedSpanButtons.test.tsx`):*
- Add the U1 hover scenarios. The existing `buildEditorDom` helper already mounts a
  `.reader-rail` with two `<p>` blocks at known rects (`setRect`); reuse it. Drive hover by
  dispatching `pointermove` on the rail with a `clientY` inside paragraph A's band, then
  inside B's band, then a `pointerleave`. Assert the `data-hovered` attribute on
  `getByTestId("processed-toggle-…").closest(".readpara__actions")`.
- Keep all existing assertions (render/measure, delegate toggle/ignore/needs-later, disabled
  extracted, filter hiding, toggle-failure, not-ready) passing — they assert DOM presence,
  not visibility, and remain valid.

*CSS contract (`reader-css.test.ts`):*
- Assert `.reader-rail:hover .readpara__mark` is **absent** (global reveal removed).
- Assert `.readpara__actions[data-hovered="true"] .readpara__mark` block contains
  `opacity: 1;` and `pointer-events: auto;`.
- Assert default `.readpara__mark` contains `pointer-events: none;` and `opacity: 0;`.
- Assert `.readpara__mark[data-processed="true"]` still contains `opacity: 0.74;` and now
  `pointer-events: auto;` (persistent restore stays clickable).
- Keep the existing `.readpara__mark` shape assertions (no box-shadow, 24px, radius).

*E2E (`tests/electron/processed-spans.spec.ts`):*
- Before each `getByTestId("processed-toggle-…").click()` / restore click, hover the target
  paragraph so its group activates and the button becomes interactive — e.g.
  `await page.locator('.reader .ProseMirror p[data-block-id="blk_intro_p1"]').hover()` then
  click. (Today the click works only because buttons are always `pointer-events: auto`;
  after U2 they are inert until hovered.)
- Add one focused assertion of the new behavior: with two known seeded paragraphs, hover
  one and assert its `.readpara__actions` group has `data-hovered="true"` while another
  paragraph's group has `data-hovered="false"` (or `toHaveCSS('opacity', …)` on the marks).
  Note: Playwright `toBeVisible()` ignores opacity, so assert `data-hovered` / `toHaveCSS`,
  not visibility.
- Preserve the full mark→reload→restart→restore round-trip; only add the hover step and the
  scoping assertion.

**Execution note:** Run the unit/CSS tests first (fast inner loop), then the Electron e2e.

**Verification:** `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit + CSS contract), and
`pnpm e2e` for `processed-spans.spec.ts` all pass.

---

## Alternatives Considered

- **`mouseover`/`mouseout` delegation on each `<p>` + close-grace timer + group keep-alive
  handlers** (the codebase's `cursor-anchored-context-menu-primitive` pattern). Precise to
  the literal element, and the precedented hover-intent shape. Rejected as the default here
  because the icons sit in the margin with an ~88px horizontal gap, so it *requires* a
  grace timer and per-group keep-alive to satisfy R3 — more moving parts and timing
  fragility than KTD1's Y-band mapping, which solves the gap geometrically. Kept as the
  fallback if Y-band edge cases (interspersed headings/images) prove unacceptable in review.
- **Pure CSS** (widen each group's hit area over the paragraph row, `.readpara__actions:hover`).
  Rejected: the hit area would overlap the live editor text with `pointer-events: auto`,
  breaking text selection / extract creation; and the overlay and editor are separate DOM
  subtrees, so CSS `:hover` can't scope reveal by block anyway.

---

## Scope Boundaries

**In scope:** reveal-trigger change for the per-paragraph reader action icons; the
supporting React hover state, CSS reveal/pointer-events rules, and tests.

**Out of scope (non-goals):**
- Any change to block-processing state, IPC, persistence, extraction, or icon actions.
- The selection toolbar, read-point hint, dimming projection, or other reader chrome.
- Touch/coarse-pointer behavior (no `:hover`); the article is a desktop-first surface and
  this preserves the current desktop-only affordance. Not regressing it; not expanding it.

### Deferred to Follow-Up Work
- Keyboard-only reveal of a focused paragraph's icons (accessibility nicety) — current
  behavior is pointer-only both before and after this change; not a regression, so deferred.

---

## Risks & Notes

- **R3 regression risk (icons vanish while reaching).** Mitigated by KTD1/KTD5 (Y-band +
  tolerance) and explicitly covered by the U1 "far-right X stays active" test and the e2e
  hover-then-click. This is the documented failure mode from
  `docs/solutions/design-patterns/cursor-anchored-context-menu-primitive.md`.
- **E2E breakage.** `processed-spans.spec.ts` clicks toggles directly; after U2 those
  buttons are inert until hovered. U3 updates it — this is a required, not optional, change.
- **CSS is global in this renderer.** All new selectors stay namespaced under the existing
  `.readpara*` classes; no new top-level selectors. Follows the global-CSS-leak caution in
  `docs/solutions/ui-bugs/source-reader-scroll-extents-rich-source-rendering.md`.
- **Performance.** `pointermove` is ref-guarded (KTD2); only a block-id change triggers a
  render. One `getBoundingClientRect` read per move, no writes interleaved.

---

## Origin / Research

Solo plan (no upstream brainstorm). Grounded in repo research and these learnings:
- `docs/solutions/architecture-patterns/durable-source-block-processing-state.md` — the
  durable state the icons project; this change stays presentational and routes nothing new.
- `docs/solutions/design-patterns/cursor-anchored-context-menu-primitive.md` — hover-intent
  and the reach-for-control failure mode (R3).
- `docs/solutions/ui-bugs/source-reader-scroll-extents-rich-source-rendering.md` — the body
  is a constrained ProseMirror editor; decorate via overlay, namespace CSS.
- `docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md` — hover
  affordance convention (unchanged here).

Key code: `apps/web/src/pages/source/ProcessedSpanButtons.tsx`,
`apps/web/src/pages/source/reader.css` (lines ~554–623),
`apps/web/src/pages/source/SourceReader.tsx` (mounts the overlay in `.reader-rail`),
`packages/editor/src/block-id.ts` (`BLOCK_ID_DOM_ATTR`).
