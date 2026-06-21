---
title: "feat: Full-width progress line, clearer readout, and inline title in the process toolbar"
type: feat
date: 2026-06-21
status: ready
depth: standard
---

# feat: Full-width progress line, clearer readout, and inline title in the process toolbar

## Summary

The `/process` review-session top toolbar (`ProcessSessionControls` / `.pq-session` in
`apps/web/src/pages/queue/ProcessQueue.tsx`) has three rough edges after today's topbar redesign
(`docs/plans/2026-06-21-001-feat-process-session-topbar-redesign-plan.md`):

1. **The progress line is not full width.** `.pq-progress` is capped at `max-width: 360px`, so the
   slim progress bar is a short segment on the left instead of spanning the toolbar.
2. **The progress readout is ambiguous.** `2 / 3` (queue position) and `2 left` (remaining) render
   adjacent with only a flex gap, so `2 / 3 2 left` reads as one run-together block instead of two
   distinct facts.
3. **The source title eats vertical space.** The article title (e.g. "Travel Is No Cure for the
   Mind") sits in its own `.pq-source__header` band *below* the controls. Moving it up into the
   toolbar row reclaims a full header band for the article body.

These resolve into one coherent toolbar layout: a **full-width progress line** at the bottom of the
session band (which doubles as the section divider), a **clarified `2 / 3 · 2 left` readout** on the
top line, and the **source title inline** in that top line. The `.pq-source__header` band is removed
for source items. The change is source-aware: the title slot is a strictly-optional prop that only
source items populate; extract, card, and topic items keep their existing headers and simply gain
the full-width progress line.

Part 3 **reverses KTD1** of the `2026-06-21-001` plan, which deliberately kept the item title out of
the shared session band. The user has explicitly requested it; this plan records the reversal and
its rationale, and updates the three solution docs that assert the old arrangement.

---

## Problem Frame

`ProcessSessionControls` is the **one shared session band** rendered above every queue item (source,
extract, card, topic) by `ProcessCard` (`ProcessQueue.tsx` ~line 2315). Today it is a single flex
row: `[ 2 / 3 · "2 left" · slim bar ]  …  [ Planned deck | Adjust ]  [ End session ]`.

- The progress group `.pq-progress` is `flex: 1; max-width: 360px`, and the bar (`.pq-progress__bar`,
  `flex: 1` *within* that 360px group) therefore never spans the toolbar — the reported "line is not
  full width."
- The readout is two sibling spans, `.pq-progress__count` (`N / total`) and `.pq-progress__est`
  (`N left` / `all done`), separated only by `gap: var(--s-2)`. With no separator glyph the two
  numbers collide visually.
- The source title is an `h1.pq-source__title` inside `header.pq-source__header`
  (`ProcessSourceWorkbench`, `ProcessQueue.tsx` ~line 1878), a `flex: none` band with its own
  `--t-xl` type, padding, and bottom border — a tall band that exists only to show one line of text
  that the toolbar row has room for.

The Inspector SOURCE column already owns all source *identity* (author, URL, status, priority,
scheduler) per `process-queue-source-reader-library-header.md`; the workbench header keeps **only**
the title. So relocating the title moves the last remaining piece of header chrome, after which
`.pq-source__header` can be deleted entirely.

**Goal:** make the progress line full-width, make the readout unambiguous, and move the source title
into the toolbar row — reclaiming a header band for the article — without breaking the three-zone
scroll-ownership invariant, the "title appears exactly once" rule, the shared/per-type session-band
contract, any testid, or any keyboard shortcut.

---

## Scope Boundaries

**In scope**

- Restructuring `.pq-session` so the progress **bar** is a full-width line (own row at the bottom of
  the band, doubling as the divider); removing the off-token `max-width: 360px` cap.
- Clarifying the textual readout (`2 / 3 · 2 left`) with a separator and distinct token colors,
  protected against wrapping.
- Adding a strictly-optional inline **title** slot to `ProcessSessionControls`, populated only for
  source items; removing `.pq-source__header` + its `h1` from `ProcessSourceWorkbench`.
- Using `/ce-frontend-design` to design the toolbar visuals (bar height/treatment, readout
  separation, inline-title sizing/truncation) to genuine design quality, verified by screenshot.
- Updating the pinned tests (component + css-contract) and the Electron geometry/E2E specs.
- Writing supersession notes in the `2026-06-21-001` plan and the three affected solution docs.

**Out of scope**

- Any change to the Inspector SOURCE column (it is the identity owner).
- The action bar (`.pq-actions`), the overflow menu, the read-point button, the rail reading caption
  (`.pq-source__railmeta`) — all landed by `2026-06-21-001` and untouched here.
- Any change to queue assembly, the frozen-order cursor, mutation routing, scheduling, or
  `useProcessShortcuts` / `PROCESS_BOUND_KEYS` / the `sessionHint` footer (no keys change).
- Showing an inline title for **non-source** items (cards/extracts/topics keep their own headers).
  See Deferred.

### Deferred to Follow-Up Work

- A consistent inline title for extract/card/topic items in the session band. Those types have
  divergent, purpose-built headers (review-card surface, extract workbench); unifying them is a
  separate design question and is not what "more space for the main article" asked for.

---

## High-Level Technical Design

Layout restructure of one shared band. Before/after for a **source** item (non-source items differ
only in that they have no inline title — they still gain the full-width bottom line):

```text
BEFORE (source)                                  AFTER (source)
┌──────────────────────────────────────────┐    ┌──────────────────────────────────────────┐
│ 2/3  2 left ▰▰▱▱   Planned deck   End ✕   │    │ 2/3 · 2 left  Travel Is No Cure…  Pl. deck  End ✕ │ ← top line
├──────────────────────────────────────────┤    │▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱│ ← full-width line
│ Travel Is No Cure for the Mind            │    ├──────────────────────────────────────────┤
├──────────────────────────────────────────┤    │ … article body (one band taller) …        │
│ … article body …                          │    │                                            │
└──────────────────────────────────────────┘    └──────────────────────────────────────────┘
        ▲ .pq-source__header  (REMOVED)
```

Two structural moves:

- `.pq-session` goes from a single flex row to a band with a **content row** (readout · optional
  title · modes · End) and a **full-width progress line** beneath it. The line replaces the band's
  current `border-bottom` as the visual divider.
- The source title leaves `.pq-source__header` (deleted) and renders in the content row via a new
  optional `ProcessSessionControls` prop.

```text
.pq-session
├─ .pq-session__row  (flex; align center)
│   ├─ .pq-progress         "2 / 3" · "2 left"   (shrink-0; nowrap)   [data-testid=process-progress]
│   ├─ .pq-session__title   source title only    (flex:1; min-width:0; ellipsis)   ← new, optional
│   ├─ .pq-modes  /  .pq-modes--assembled        (Planned deck | Adjust)  (margin-left:auto)
│   └─ .pq-end                                     End session
└─ .pq-progress__bar  >  .pq-progress__fill        full-width line (aria-hidden)
```

**Shared-band contract.** `ProcessSessionControls` renders for all element types. The new `title`
prop is optional; `ProcessCard` passes it **only** for source items (`isSource`). When absent the
content row is exactly today's `[ readout … modes End ]`, so extract/card/topic items are visually
unchanged except for gaining the full-width line. No `PROCESS_BOUND_KEYS`, `sessionHint`, or
`.pq-actions` change.

---

## Key Technical Decisions

**KTD1 — The progress bar becomes a flush full-width line; the readout text stays compact above it.**
Splitting the band into a content row + a full-width bar resolves the conflict between "make the line
full width" and "put the title on that row": the bar no longer competes with text for horizontal
space. Remove `max-width: 360px` (an off-token magic value) entirely; the bar spans the band's full
width. The bar is a **flush thin line (~2-3px) at the band's bottom edge that replaces the existing
`.pq-session` `border-bottom`** — it is *not* a padded second row. This is what makes the vertical
budget net-positive: U2 removes the entire `.pq-source__header` band (`--t-xl` title line + `--s-3`/
`--s-2` padding + a border ≈ a full text band), and KTD1 adds back only a ~2-3px line, so the article
body genuinely moves up. Keep the existing fill math
(`total === 0 ? 0 : (Math.min(cursor, total) / total) * 100%`) and the `aria-hidden` on the
decorative bar. *Alternative considered:* keep the bar inline and just raise the cap to
`var(--reader-text-measure)`. Rejected — it leaves a short segment when the title also wants the row,
and the user's two end-to-end arrows ask for an edge-to-edge line, not a wider segment.

**KTD1a — The restructure is universal to `ProcessSessionControls`, which renders in three contexts;
verify all three.** `ProcessSessionControls` is rendered not only per-item by `ProcessCard` but also
in the **loading panel** and the **done panel**, both nested in a centered `max-width` `.pq-donepanel`
(`process-queue.css` pins `.pq-donepanel > .pq-session` with its own padding). The content-row + flush
bar restructure is a component-level change, so it lands in all three. The full-width bar is
**full-width-of-its-container**, which is the 520px-ish panel in the done/loading case — acceptable,
not edge-of-viewport. Two guardrails: (a) do **not** remove a border the `.pq-donepanel` relies on for
its own separation — keep `.pq-donepanel > .pq-session` reading correctly (re-pin if needed); (b) the
title slot stays empty in the done/loading panels (they pass no `itemTitle`), so no title appears
there. U3 must screenshot the **done and loading panels**, not only source/extract/card items, so this
shared-component blast radius is verified rather than shipped blind.

**KTD2 — Clarify the readout with a separator and color hierarchy, not new labels.** Render
`2 / 3` (`.pq-progress__count`, `var(--text-2)`) · a muted separator (`·`, `var(--text-3)`) ·
`2 left` (`.pq-progress__est`, `var(--text-3)`). The separator plus the bar moving out from between
them removes the run-together ambiguity without adding width-hungry labels like "position" /
"remaining". Protect each token with `white-space: nowrap` and keep the readout group `shrink-0` so
`2` and `left` can never orphan onto separate lines (convention:
`inbox-row-metadata-nowrap-compact-counts.md`). Keep `data-testid="process-progress"` on the readout
group; `process-progress` must still contain the `N / total` text the component test asserts.
**Accessibility:** the `·` glyph would be announced literally ("middle dot"), so give the readout
group an `aria-label` computed from the same values (e.g. `"2 of 3, 2 remaining"` / `"all done"`) and
mark the visual count/separator/est spans `aria-hidden` underneath it — the bar is already
`aria-hidden`, so the `aria-label` becomes the single clean spoken progress signal.

**KTD3 — The title is a strictly-optional, source-only prop on the shared session band (reverses the
rejected alternative inside `2026-06-21-001` KTD1).** Add `itemTitle?: string` to
`ProcessSessionControlsProps`. The `sessionControls` object is assembled in the **parent**
`ProcessQueue` (~line 1446) and spread into `ProcessCard` / the loading + done panels — so compute
`itemTitle` **there**, gated on the current queue item being a source
(`current && isSource(current) ? (inspector?.element.title ?? current.title) : undefined`, the same
title expression `ProcessSourceWorkbench` uses today). The loading/done panels have no current source,
so they naturally pass `undefined` and render no title. `ProcessSessionControls` renders the title
element only when `itemTitle` is a **non-empty** string (an untitled in-progress import yields an
empty string from `?? current.title`, which is falsy → no title element, no awkward gap; the Inspector
remains the identity surface). This reverses the alternative that `2026-06-21-001` KTD1 *considered and
rejected* (KTD1's main decision was "compact progress in place / don't resurrect the page bar"; the
title-into-session-band merge was its rejected alternative), on two grounds: (a) lifetime coupling
(item vs session) and (b) per-type header divergence. The optional source-gated prop **fully resolves
(b)** — only sources opt in — and **defers, rather than defeats, (a)**: the shared band now carries
one item-lifetime string for sources while staying session-scoped for other types. That asymmetry is
acceptable here (one nullable string, set in the parent where the current item already lives) but is a
real seam the deferred multi-type-title work inherits — see Deferred. The user explicitly wants the
title up to reclaim vertical space, which justifies taking on that seam now.

**KTD3a — Render the relocated title as the document heading (`h1`), exactly once.** The title is the
source's document heading today (`h1.pq-source__title`). Relocating it visually into the toolbar must
not flatten the document outline, so `.pq-session__title` renders as an **`h1`** for source items (it
is still the one document heading, just positioned in the toolbar), not a non-semantic `span`. It is
**display-only** (no link). Truncate with right-side ellipsis (`text-overflow: ellipsis; white-space:
nowrap; overflow: hidden; min-width: 0`) — article titles are front-loaded, so the start stays
visible — and add a native `title` attribute (full text on hover) so truncation never hides the title
irretrievably. Render **exactly once**: it leaves `.pq-source__header` (deleted), and the existing
`{!isSource && !isCard ? … : null}` guard already suppresses the generic `.pq-card__title` for
sources. The component test asserts the title appears exactly once **across all source sub-types**
(text, PDF, video), not just text. *This plan records the supersession in the `2026-06-21-001` plan and
in the two `process-queue-source-reader-*` solution docs.*

**KTD4 — Removing `.pq-source__header` must preserve three-zone scroll ownership.**
`.pq-source__header` is a `flex: none` pinned band in the source height chain
(`process center → .pq-card--source → .pq-source → .pq-source__editor → .reader`). Per
`three-zone-scroll-owned-review-card-surface.md`, every ancestor in the height chain needs
`min-height: 0` and exactly one `overflow-y: auto` owner (`.reader`). Deleting a `flex: none` sibling
is safe **only if** that chain stays intact — verify `min-height: 0` survives on every flex ancestor
and `.reader` remains the sole scroller, and restore it if pinning regresses. The jsdom css-contract
test cannot prove this; the Electron geometry spec (`tests/electron/process-queue.spec.ts`) must be
re-run to confirm the pinned action bar stays reachable while the body scrolls.

**KTD5 — Full-width applies to the toolbar bar only, not the reader prose.** The new full-width line
lives in `.pq-session` (the toolbar), which already spans the main content column. Do **not** touch
`.pq-source__rail` / `.pq-source__pbar` — the reader's own progress bar stays centered on
`var(--reader-text-measure)`, and `.pq-source__rail` must stay `width: 100%` with no `max-width`, or
the dead-gutter scroll bug returns (`process-source-reader-scroll-owner-full-width-measure-on-content.md`).
These are two different bars; this change only widens the toolbar one. All CSS stays token-only with
border-color hover cues (`hover-uses-border-not-shadow-and-shadow-taxonomy.md`); no magic pixels, no
`box-shadow` on hover.

**KTD6 — Migrate the existing responsive overrides to the new structure; define narrow-width title
behavior.** `process-queue.css` already has `@media (max-width: 1120px) { .pq-session { flex-wrap:
wrap } }` and `@media (max-width: 760px) { .pq-progress { order: 3; flex-basis: 100%; max-width:
none } }`, both written against `.pq-progress` as a **direct flex child of `.pq-session`**. Moving the
readout into a new `.pq-session__row` content row would orphan these (the `order`/`flex-basis` would
target the wrong container), silently regressing the inspector-open narrow width that U3 screenshots.
So these media-query blocks are in scope for U1 and must be re-pointed at the new content-row
structure. At narrow (inspector-open) width the readout group stays `shrink-0` and the controls keep
their place; the **title slot absorbs the pressure** — it truncates via its ellipsis, and below a
readable minimum (it would collapse to a lone `…`) it is hidden (`display: none` under the existing
`max-width: 760px` breakpoint) since the full title is still available via its hover `title`
attribute and the rail/Inspector. The mode label "Planned deck" is not abbreviated (no new behavior).

---

## Implementation Units

### U1. Full-width progress line + clarified readout in the session toolbar

**Goal:** Restructure `.pq-session` into a content row plus a full-width progress line, remove the
`max-width: 360px` cap, and separate `2 / 3` from `2 left` with a token-colored `·`. Fixes asks 1
and 2.

**Requirements:** Asks 1 and 2. Honors KTD1, KTD2, KTD5.

**Dependencies:** none.

**Files:**
- `apps/web/src/pages/queue/ProcessQueue.tsx` — `ProcessSessionControls` JSX (~lines 1721-1736):
  move `.pq-progress__bar`/`__fill` out of `.pq-progress` to a full-width sibling line; add the `·`
  separator span between `.pq-progress__count` and `.pq-progress__est`; add the `aria-label` on the
  readout group + `aria-hidden` on the visual spans (KTD2). Keep the `process-session-controls`,
  `process-progress`, `process-modes`/`process-assembled-mode`, `process-end` testids and the fill
  math.
- `apps/web/src/pages/queue/process-queue.css` — `.pq-session` (new content-row + flush bottom-line
  structure), a new `.pq-session__row` content-row rule, `.pq-progress` (drop `max-width: 360px`;
  becomes the text readout group), new separator style, `.pq-progress__bar`/`__fill` (full-width flush
  line replacing the band border, token-only). **Re-point the existing responsive overrides** (KTD6):
  `@media (max-width: 1120px) { .pq-session … }` and `@media (max-width: 760px) { .pq-progress … }`
  must target the new content-row structure, not the old direct-child layout. Verify the
  `.pq-donepanel > .pq-session` override still reads correctly (KTD1a).
- `apps/web/src/pages/queue/process-queue-css.test.ts` — the "uses inline session controls…" test
  (~lines 23-31) pins `.pq-session`; add/adjust pins so the bar is full-width and no `max-width:
  360px` remains, and pin the `.pq-donepanel > .pq-session` override stays intact. Keep `cssBlock`
  calls only for selectors that still exist.
- `apps/web/src/pages/queue/ProcessQueue.test.tsx` — "shows the progress readout (N / total)"
  (~line 703) stays green; extend it to assert the `N left` estimate is present and visually
  separated (e.g. the separator/`est` element renders).

**Approach:** Build with `/ce-frontend-design` for the bar treatment (height, radius, whether it
replaces the band border), the separator weight, and the readout color hierarchy; verify by
screenshot in light and dark. The bar is decorative — keep `aria-hidden`, no click target. Give the
content row a min-height matching the control height so it stays comfortable.

**Patterns to follow:** existing `.pq-session`/`.pq-seg` flex + token usage; the `·`-separated dense
readout pattern from `inbox-row-metadata-nowrap-compact-counts.md`; `--reader-text-measure` token
discipline (no magic pixels) from `source-reader-shared-text-measure.md`.

**Test scenarios:**
- Renders `cursor`/`total` as `N / total` and the `N left` estimate, separated (both present;
  `process-progress` contains the `N / total` text).
- `done` state shows `all done` and the bar fill reflects completion.
- `total === 0` renders a 0%-width fill without dividing by zero.
- css-contract: `.pq-session`/`.pq-progress` are token-only and contain **no** `max-width: 360px`;
  the bar selector resolves (no deleted-selector `cssBlock` throw).

**Verification:** progress reads correctly at start / mid / done; the bar spans the full toolbar
width in the running app (light + dark); `pnpm test` green for both files.

---

### U2. Move the source title into the toolbar row; remove `.pq-source__header`

**Goal:** Add an optional inline title to `ProcessSessionControls`, populate it only for source
items from `ProcessCard`, and delete the `.pq-source__header` band + `h1` from
`ProcessSourceWorkbench`. Fixes ask 3.

**Requirements:** Ask 3. Honors KTD3, KTD4.

**Dependencies:** U1 (both edit `ProcessSessionControls` and `.pq-session`; land U1 first).

**Files:**
- `apps/web/src/pages/queue/ProcessQueue.tsx`
  - `ProcessSessionControlsProps` + `ProcessSessionControls` (~lines 1700-1736): add optional
    `itemTitle?: string`; render the title as `h1.pq-session__title` (testid
    `process-session-title`, native `title` attribute for the full text) in the content row **only
    when `itemTitle` is a non-empty string** (KTD3a).
  - Parent `ProcessQueue` `sessionControls` assembly (~line 1446): set `itemTitle` from the current
    item, gated on it being a source (`current && isSource(current) ? (inspector?.element.title ??
    current.title) : undefined`). The loading/done panels pass `undefined` (no current source), so no
    title renders there (KTD1a).
  - `ProcessSourceWorkbench` (~lines 1850-1883): remove the `sourceHeader` `header.pq-source__header`
    + `h1.pq-source__title`; the workbench now starts at `.pq-source__rail`. Keep the rail caption
    `.pq-source__railmeta` and its `doc.sourceFormat === null` gate untouched.
- `apps/web/src/pages/queue/process-queue.css` — remove `.pq-source__header`; repurpose/remove
  `.pq-source__title` (title style now lives in the session band as `.pq-session__title`: `flex: 1;
  min-width: 0; text-overflow: ellipsis; white-space: nowrap; overflow: hidden`, token type). Verify
  `min-height: 0` survives on every source height-chain ancestor after the band is removed (KTD4);
  restore it if the editor/reader pinning regresses.
- `apps/web/src/pages/queue/process-queue-css.test.ts` — **two** tests reference now-deleted
  selectors, and `cssBlock()` **throws** on a missing selector (not a soft assert), so both must have
  their `cssBlock` calls *removed*, not re-asserted: (1) the "renders source reading as a full-height
  unframed workbench" test (~line 53) calls `cssBlock('.pq-source__header')` and asserts its body
  (~lines 70-72); (2) the "uses tokenized source header spacing…" test (~lines 93-108) calls
  `cssBlock('.pq-source__title')`. Re-pin the new `.pq-session__title` + content-row styling instead.
  Keep the `.pq-source__railmeta` pins.
- `apps/web/src/pages/queue/ProcessQueue.test.tsx` — flip the title-location assertions across **all**
  tests that query the removed `process-source-header` testid (`getByTestId` throws when it is gone),
  not only the title one: (1) "renders a source as an inline reading workbench" (~line 1609) makes
  several `getByTestId('process-source-header')` calls including read-point and `block N of M`
  negative-containment (~1626/1639) — re-point or drop all of them; (2) the PDF/video `it.each`
  ("keeps specialized %s sources out of the inline text reader while preserving header context",
  ~1713-1737) asserts `process-source-title` — re-point its assertion to `process-session-title` and
  update the "header context" intent. The title now lives in `process-session-controls` (testid
  `process-session-title`). Assert the source title appears **exactly once across text, PDF, and video
  sub-types** (not also via `.pq-card__title`).
- `docs/solutions/ui-bugs/process-queue-source-reader-library-header.md` and
  `process-queue-source-reader-metadata-row-chrome.md`, and
  `docs/plans/2026-06-21-001-feat-process-session-topbar-redesign-plan.md` — append dated
  supersession notes (see Documentation Plan).

**Approach:** Build the inline-title sizing/truncation with `/ce-frontend-design` (the title trades
prominence for one inline line; keep it readable — medium weight, `var(--text)`, ellipsis on
overflow). The title slot is purely additive to the shared band; non-source items pass no title and
render exactly as after U1. Confirm PDF/video sources still show no reader-only chrome (the rail
caption stays format-gated) and that the source title still renders for PDF/video sources too (the
title is not format-gated — only the reading caption is).

**Patterns to follow:** the single-owner / "title appears exactly once" rule in
`process-queue-source-reader-library-header.md`; the `min-height: 0` chain in
`three-zone-scroll-owned-review-card-surface.md`; ellipsis-truncation with `min-width: 0` from
`inbox-row-metadata-nowrap-compact-counts.md`.

**Test scenarios:**
- Source item: the title renders inside `process-session-controls` (`process-session-title`), as an
  `h1` (assert it is exposed as a heading), and **not** in any source-header band; it appears exactly
  once in the DOM.
- Title appears exactly once across **text, PDF, and video** source sub-types (no `.pq-card__title`
  duplicate).
- Empty/untitled source (`inspector?.element.title ?? current.title` resolves to `""`): **no** title
  element renders (no empty slot / awkward gap).
- The removed `process-source-header` band is gone; the rail caption + read-point (from
  `2026-06-21-001`) are unaffected.
- Non-source items (extract, card, topic) and the done/loading panels: `ProcessSessionControls`
  renders **no** title element (prop omitted); their own headers are unchanged.
- PDF/video source: title still shows inline; no reading caption (format gate intact).
- css-contract: both deleted-selector `cssBlock` calls (`.pq-source__header`, `.pq-source__title`)
  are removed; `.pq-session__title` is token-only.

**Verification:** the title sits in the toolbar row; the source gains a header band of vertical
space; Inspector still owns identity; no second title; no scroll/pinning regression (confirmed in
U3 via the Electron geometry spec).

---

### U3. Cross-cutting tests, docs supersession, and visual + E2E verification

**Goal:** Prove the toolbar holds for source, extract, and card items in light and dark, keep the
pinned geometry/E2E specs green, and record the decision reversal in the affected docs.

**Requirements:** All three asks; Definition of Done (lint, typecheck, test, e2e).

**Dependencies:** U1, U2.

**Files:**
- `tests/electron/process-queue.spec.ts` — re-run the one-at-a-time / action-advancement /
  three-zone pinned-footer-reachability specs; they must stay green after the header band is
  removed. Adjust selectors only if a removed band changes a query (prefer stable testids).
- `tests/electron/read-points.spec.ts`, `tests/electron/done-intent.spec.ts`,
  `tests/electron/process-editor-focus.spec.ts` — verify reachability/focus still pass.
- `apps/web/src/pages/queue/useProcessShortcuts.test.tsx` — confirm `PROCESS_BOUND_KEYS` unchanged.
- Solution docs + plan (supersession notes) — see Documentation Plan.

**Approach:** Run the full gate (`pnpm lint`, `pnpm typecheck`, `pnpm test`, relevant `pnpm e2e`).
Capture live-app screenshots for a text **source**, an **extract**, and a **card** item, **plus the
done panel and the loading panel** (the two other `ProcessSessionControls` render contexts — KTD1a) —
each in light and dark, plus one narrow (inspector-open) width — confirming: the progress line spans
full width, `2 / 3 · 2 left` reads as two distinct facts, the source title sits inline in the toolbar
with the header band gone, the done/loading panels still read correctly (container-width bar, no
title, separation intact), and non-source items render unchanged except for the full-width line.
Verify keyboard focus order still flows toolbar → article body after the header band is removed (the
tab sequence changes; confirm it stays sensible). Compare against `design/kit` where applicable.

**Test scenarios (Covers the DoD E2E requirement):**
- E2E: a source item processes end-to-end with the relocated title and full-width line; the pinned
  action bar stays reachable while the body scrolls (three-zone geometry spec).
- E2E: card and extract items process inline with the shared band (full-width line present, no
  inline title).
- Geometry: removing `.pq-source__header` does not push the footer off-screen.

**Verification:** all gates green; screenshots for all three element types in both themes (plus a
narrow width) attached; the three solution docs + the `2026-06-21-001` plan carry supersession notes;
no regression in the pinned specs.

---

## Risks & Dependencies

- **Reversing a documented decision (KTD3).** `2026-06-21-001` KTD1 rejected this merge. Mitigation:
  optional source-only prop contains both stated objections; record the supersession in the plan and
  the two solution docs so the record stays coherent.
- **Title rendered twice.** Removing `.pq-source__header` while a generic title path re-surfaces it.
  Mitigation: the `{!isSource ? … : null}` guard already suppresses `.pq-card__title` for sources;
  assert "title appears exactly once" in the component test.
- **Three-zone scroll-ownership regression (KTD4).** Dropping a `flex: none` band can break the
  `min-height: 0` chain and push the pinned action bar off-screen. Mitigation: U2 preserves/restores
  `min-height: 0`; U3 re-runs the Electron geometry spec (jsdom cannot prove this).
- **Shared-band blast radius (KTD1a).** `ProcessSessionControls` renders in three contexts (per-item,
  done panel, loading panel); a `.pq-session` restructure touches all three, including the centered
  `.pq-donepanel`. Mitigation: keep the bar container-width, don't break the done-panel separation,
  pass no title there, and screenshot the done/loading panels in U3.
- **Orphaned responsive overrides (KTD6).** `@media` rules target `.pq-progress` as a direct child of
  `.pq-session`; the content-row restructure would silently regress narrow-width layout. Mitigation:
  U1 re-points the media-query blocks; U3 screenshots the narrow (inspector-open) width.
- **Lost document heading.** Relocating the `h1` into the toolbar could flatten the source document
  outline. Mitigation: render `.pq-session__title` as an `h1` (KTD3a) and assert it is exposed as a
  heading.
- **css-contract harness breakage, not assertion failure.** `cssBlock()` *throws* on deleted selectors,
  and **two** tests reference them (`cssBlock('.pq-source__header')` in the "unframed workbench" test
  and `cssBlock('.pq-source__title')` in the "tokenized source header spacing" test). Likewise several
  `ProcessQueue.test.tsx` tests query `process-source-header` via throwing `getByTestId`. Mitigation:
  U2 removes both `cssBlock` calls and re-points every `process-source-header` query rather than
  re-asserting them.
- **Widening the wrong bar (KTD5).** Re-applying `max-width` to `.pq-source__rail` reintroduces the
  dead-gutter scroll bug. Mitigation: only the toolbar bar widens; the rail/prose measure is
  untouched.
- **Readout still ambiguous.** A bare gap caused the original confusion. Mitigation: explicit `·`
  separator + color hierarchy + `nowrap`/`shrink-0`; verified by screenshot via `/ce-frontend-design`.
- **PDF/media branches.** Mitigation: the reading caption stays gated on `doc.sourceFormat === null`;
  the title is not format-gated and shows for all source formats.

---

## Documentation Plan

Append dated (2026-06-21) supersession notes:

- `docs/plans/2026-06-21-001-feat-process-session-topbar-redesign-plan.md` — KTD1's rejected
  alternative ("don't merge the title into the session band") is reversed; note the new decision and
  why the trade-off changed (explicit user request + optional source-only prop containment).
- `docs/solutions/ui-bugs/process-queue-source-reader-library-header.md` — the line "the workbench
  header keeps only the document title" is now false; the title moved to the session band and
  `.pq-source__header` was removed. The single-owner / "title appears exactly once" rule still holds.
- `docs/solutions/ui-bugs/process-queue-source-reader-metadata-row-chrome.md` — its breakout example
  references `.pq-source__header`; update so it doesn't describe a deleted selector.

If the change yields a reusable lesson (full-width toolbar progress line as the band divider, or
lifting a per-type title into a shared band via an optional prop), capture it via `/ce-compound` at
the end.

---

## Sources & Research

- `apps/web/src/pages/queue/ProcessQueue.tsx` — `ProcessSessionControls` (~1700-1774, props +
  JSX), `ProcessSourceWorkbench`/`sourceHeader` (~1850-1883), `ProcessCard` rendering
  `ProcessSessionControls` + the `{!isSource ? … : null}` title guard (~2315), source title
  expression `inspector?.element.title ?? item.title`.
- `apps/web/src/pages/queue/process-queue.css` — `.pq-session` (~23), `.pq-progress` +
  `max-width: 360px` (~34-56), `.pq-progress__bar`/`__fill`, `.pq-source__header`/`.pq-source__title`
  (~476), `.pq-source__rail`/`.pq-source__pbar`/`.pq-source__railmeta`.
- `apps/web/src/pages/queue/process-queue-css.test.ts` — `.pq-session` pins (~23-31), source-header
  pins with `cssBlock('.pq-source__title')` that throw on deletion (~93-108); `.pq-source__pbar`
  rail pins (~82-91).
- `apps/web/src/pages/queue/ProcessQueue.test.tsx` — progress readout (~703), session-controls
  containment (~709-723), source title-location assertions.
- `apps/web/src/pages/queue/useProcessShortcuts.ts` / `useProcessShortcuts.test.tsx` —
  `PROCESS_BOUND_KEYS` (unchanged).
- Tests: `tests/electron/process-queue.spec.ts` (geometry / footer-pinned), `read-points.spec.ts`,
  `done-intent.spec.ts`, `process-editor-focus.spec.ts`.
- Learnings: `docs/solutions/ui-bugs/process-queue-source-reader-library-header.md`,
  `process-queue-source-reader-metadata-row-chrome.md`,
  `process-source-reader-scroll-owner-full-width-measure-on-content.md`,
  `source-reader-shared-text-measure.md`,
  `inbox-row-metadata-nowrap-compact-counts.md`,
  `docs/solutions/design-patterns/three-zone-scroll-owned-review-card-surface.md`,
  `action-bar-overflow-menu-and-upward-popovers.md`,
  `docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md`.
- Prior plan: `docs/plans/2026-06-21-001-feat-process-session-topbar-redesign-plan.md` (KTD1
  reversal).
- Design: `design/tokens.css`, `design/icon-map.md`, `design/AGENTS.md`; `apps/web/AGENTS.md`.
