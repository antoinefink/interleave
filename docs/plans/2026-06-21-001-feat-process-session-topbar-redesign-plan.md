---
title: "feat: Redesign the process-session top bar to reclaim vertical space"
type: feat
date: 2026-06-21
status: ready
depth: standard
deepened: 2026-06-21
---

# feat: Redesign the process-session top bar to reclaim vertical space

## Summary

The `/process` session view stacks four chrome bands above the article body: the queue
progress + session controls, the source title, a dense metadata line, and a "Set read-point"
button. The metadata line duplicates the right-hand Inspector SOURCE column almost field for
field, and the read-point button + the two-row progress block waste vertical space that the
reader (and the card/extract surfaces) would rather give to content.

This plan reclaims that space with four targeted edits to the single session shell
(`apps/web/src/pages/queue/ProcessQueue.tsx`): move the read-point button into the shared bottom
action bar, delete the duplicated metadata row (relocating only the reading-progress caption to
the reader rail), compact the queue progress into a single inline row inside the existing top
control bar, and collapse the infrequently-used Raise / Lower / Delete actions behind a kebab
overflow menu. Two recent design decisions are reconciled explicitly rather than silently
reverted. All element types (source, extract, card) share the action bar and must be verified
visually and via Playwright.

---

## Problem Frame

The processing loop shows one queue item at a time. For a **source** item the vertical stack
above the editor is, top to bottom:

1. `ProcessSessionControls` (`.pq-session`) — queue progress as a **two-row block** (`2 / 4` and
   `3 left` stacked over a full-width bar), then mode/"Planned deck" controls, then End session.
2. `ProcessSourceWorkbench` header (`.pq-source__header`) — the source title (`h1`).
3. `.pq-source__metarow` — author, source URL, priority chip, status chip, scheduler chip,
   format label, `block N of M · %`, word count.
4. `.pq-source__actions` — the "Set read-point" primary button.

The right-hand Inspector (`apps/web/src/components/inspector/Inspector.tsx`, shell-level, driven
by `useSelection`) **already** renders Type, Status, Priority, Due, Author, URL (via
`ExternalUrlLink`), attention, and scheduler. Bands 3 and 4 are therefore mostly redundant or
relocatable. Band 1's progress block is taller than it needs to be.

The bottom action bar (`.pq-actions`) is shared by every element type and currently shows eight
controls: Open in full · Raise · Lower · Postpone · Dismiss · Delete · Skip · Done. On narrower
windows this is cramped, and several actions (Raise, Lower, Delete) are used rarely.

**Goal:** shrink the header chrome and de-clutter the action bar without losing any capability,
any keyboard shortcut, any source-lineage guard, or the single-owner identity rule — and without
re-introducing the page-level header bar the team deliberately removed.

---

## Scope Boundaries

**In scope**

- Compacting the queue-progress readout into one inline row within `ProcessSessionControls`.
- Removing the `.pq-source__metarow` duplicated metadata; relocating the reading-progress caption
  (`block N of M · %`, **plus word count** — see KTD2) to the reader rail.
- Moving the text-source "Set read-point" button into the shared `.pq-actions` bar.
- A new overflow (kebab `⋯`) menu in `.pq-actions` holding Raise / Lower / Delete; the remaining
  actions stay as visible buttons.
- Updating the two affected solution docs and all pinned tests (component, css-contract, E2E).
- Visual verification across source, extract, and card items in light and dark themes, including
  one narrow-window (inspector-open) width.

**Out of scope**

- Any change to the Inspector SOURCE column itself (it is already the identity owner).
- Any change to queue assembly, the frozen-order cursor, mutation routing
  (`appApi.actOnQueueItem`), or the FSRS/attention scheduler split.
- Adding or removing actions, or changing what any action does. This is a relocation/grouping
  change only.
- Extracting a shared overflow-bar primitive into `packages/ui` (that package is still a stub;
  the new menu lives in `apps/web/src/components/queue/` beside its peers).

### Deferred to Follow-Up Work

- A responsive "auto-collapse to overflow when the bar overflows" behavior (ResizeObserver-driven
  promotion/demotion). This plan uses a **fixed** membership (Raise/Lower/Delete always in the
  menu), which is simpler and matches the user's stated intent; an adaptive version can follow.

---

## High-Level Technical Design

The change is a layout restructure within one component. Before/after for a **source** item
(card and extract differ only in the header region; the action bar is shared):

```text
BEFORE (source)                                AFTER (source)
┌───────────────────────────────────────┐      ┌───────────────────────────────────────┐
│ 2 / 4              Planned deck        │      │ 2/4 · 3 left ▱▱▱▰  Planned deck  End ✕ │  ← 1 compact row
│ 3 left  ▰▰▱▱▱▱     Adjust   End ✕      │      ├───────────────────────────────────────┤
├───────────────────────────────────────┤      │ Science is a strong-link problem…       │  ← title kept
│ Science is a strong-link problem…       │      ├───────────────────────────────────────┤
├───────────────────────────────────────┤      │ ▰▰▱▱  block 1 of 52 · 0% · 2435 words  │  ← reading caption on rail
│ 👤 Adam · 🌐 url · C · SCHEDULED ·      │      │ … article body …                        │
│   Reading · block 1 of 52 · 0% · 2435w  │  ◀── REMOVED (Inspector owns identity)
├───────────────────────────────────────┤      │                                         │
│ 📑 Set read-point                       │  ◀── MOVED to action bar
├───────────────────────────────────────┤      └───────────────────────────────────────┘
│ … article body …                        │      ┌───────────────────────────────────────┐
└───────────────────────────────────────┘      │ 📑 Read-point | Open ┄ ⋯ Dismiss Postpone│  ← action bar
┌───────────────────────────────────────┐      │                          Skip  Done      │
│ Open ┄ Raise Lower Postpone Dismiss     │      └───────────────────────────────────────┘
│      Delete Skip Done                    │           ⋯ overflow → Raise · Lower · Delete
└───────────────────────────────────────┘           (opens UPWARD — bar is pinned at viewport bottom)
```

Net: two full bands removed from the header (metadata row + read-point band) and the progress
band halved, while every capability survives — relocated, not deleted.

**Lockstep contract.** Action membership is referenced in three places that must stay in sync
(documented in learnings): `useProcessShortcuts.ts` (handlers + `PROCESS_BOUND_KEYS`), the
`sessionHint` memo in `ProcessCard`, and the `.pq-actions` JSX. Moving buttons into the overflow
menu changes only *where the button renders* — Raise/Lower/Delete handlers and their keyboard
shortcuts (`+`/`=`, `-`, Backspace/Delete) are untouched, so `PROCESS_BOUND_KEYS` and the
status-bar hint stay exactly as they are.

---

## Key Technical Decisions

**KTD1 — Compact progress in place; don't resurrect the page-level bar.**
`docs/solutions/ui-bugs/process-queue-inline-session-controls.md` (2026-06-09) records that a
dedicated page-level `/process` header bar was deliberately removed and progress moved *into* the
per-item `ProcessSessionControls`. Change (3) therefore **refines** `ProcessSessionControls` —
collapsing `.pq-progress` from a two-row (nums-over-bar) block to a single inline row
(`2/4 · 3 left` + slim bar on one line) — and does **not** add a new top-level bar. The
`ProcessSessionControlsProps` shape (`cursor`, `total`, `done`, `remaining`, `mode`, `assembled`,
`onModeChange`, `onAdjust`, `onEnd`) and the testids `process-session-controls`,
`process-progress`, `process-modes`, `process-end` stay stable. *Alternative considered:* merging
the progress onto the source **title** row to reclaim another band. Rejected — the title belongs to
the *item* and the progress to the *session*; merging them couples two lifetimes, and the title row
is per-type (cards/extracts have different headers), whereas `ProcessSessionControls` is the one
shared session band. Keeping progress in the session band is the semantically correct "main bar."

> **Superseded (2026-06-21, plan 002).** KTD1's *rejected alternative* — pulling the item title
> into the session band — was later adopted in
> `docs/plans/2026-06-21-002-feat-process-session-toolbar-fullwidth-title-plan.md` at the user's
> explicit request (reclaiming the whole `.pq-source__header` band for the article). The two
> objections were contained rather than ignored: per-type divergence is preserved because the title
> is a **strictly-optional, source-only** prop (`ProcessSessionControls.itemTitle`) that other types
> and the done/loading panels never set; the item-vs-session lifetime coupling is reduced to one
> nullable string computed in the parent where the current item already lives (it is *deferred*, not
> eliminated — a constraint the future multi-type-title work inherits). KTD1's primary decision
> (compact progress in place; no page-level bar) still holds; plan 002 additionally makes the
> progress bar a full-width flush line and splits the `N / total` · `N left` readout.

**KTD2 — Inspector is the single identity owner; reading-progress (with word count) moves to the
rail.** `docs/solutions/ui-bugs/process-queue-source-reader-library-header.md` established a
one-owner rule for source identity. After removing `.pq-source__metarow`, the right-hand Inspector
SOURCE column is the sole owner of author / URL / type / status / priority / scheduler — all
already present there (author + `ExternalUrlLink` URL) with an http/https guard. The metarow
content **not** in the Inspector is the *reading position* (`block N of M · %`) **and the word
count** (the only total-length signal — the Inspector shows neither). Per
`docs/solutions/ui-bugs/process-queue-source-reader-metadata-row-chrome.md`, the visual progress
bar is intentionally rail-local (aligned to `--reader-text-measure`); so the full numeric caption
`block N of M · % · N words` moves to sit with that rail (`.pq-source__rail`), keeping reading
context and the length signal while killing the duplicated identity chips. **Decision: word count
is kept**, not dropped. Both solution docs are updated to record this supersession.

**KTD3 — Read-point is a primary source action in the bottom bar; it has no keyboard shortcut in
the loop.** The read-point button is text-source-only (gated `doc.sourceFormat === null`). `doc`
(carrying `doc.sourceFormat`) is **already a prop on `ProcessCard`** (~line 2306, used at
~2584/2596), so the gate needs no new prop threading — the `.pq-actions` JSX can read
`doc.sourceFormat === null` directly. The button moves into `.pq-actions`, rendered only for text
sources, as **icon + label** (`bookmark` icon + "Set read-point", `pq-btn--primary` accent),
keeping `data-testid="process-source-readpoint"`, the `onSetSourceReadPoint` handler, and the exact
disabled condition (`busy || readPoint.saving`). **It does NOT carry a `␣` keyboard hint:** in the
process loop `useProcessShortcuts` binds Space to `next()`/skip for non-card items (see the in-file
comment at ~line 1381, "on a non-card, Space is next/skip"); the Space→read-point binding exists
only in the full-page `SourceReader`, not the loop. The current button's `␣ Kbd` is therefore
already decorative/misleading in the loop — drop it on relocation rather than carry a hint for a
binding that does not exist (and do **not** add a Space→read-point handler, which would collide with
skip). The button keeps its visible label (it is primary); a `Tooltip` + matching `aria-label` is
added only if it ever degrades to icon-only at narrow widths. The three-zone scroll-ownership
invariant (`min-height: 0` on every flex ancestor) must be re-verified when the header loses its
`.pq-source__actions` block (owned by U3).

**KTD4 — Overflow menu is a simple anchored action list (no submit-await guard), opening upward,
with real keyboard nav.** The action bar's existing menus (`ScheduleMenu`, `DoneIntentMenu`,
`LineageDeleteMenu`) are button-anchored trigger+popover components; the new overflow
(`ProcessOverflowMenu` in `apps/web/src/components/queue/`) follows their trigger/positioning
scaffold but is *simpler* — it just lists actions and dispatches on click, so it is **not** a
submit-and-await surface and does **not** need the in-flight "reset-guard-on-busy-settling"
machinery from the intent menus. What it **does** need, and what `ScheduleMenu` does *not* already
provide (so it must be added explicitly, not copied):

- **Disabled when busy:** the `⋯` trigger is disabled while `busy`; individual items are not
  independently disabled (disabling the trigger makes them unreachable mid-flight).
- **Keyboard nav (ARIA menu):** `role="menu"` with `role="menuitem"` rows; on open, focus the
  first item; Arrow Down/Up move focus cyclically; Tab closes the menu and advances page focus;
  Escape closes and restores focus to the trigger. `ScheduleMenu` only does `Escape → setOpen(false)`
  with no focus management — do not mirror that gap.
- **Opens upward:** the action bar is pinned at the viewport bottom, so the popover must open
  upward (`bottom: calc(100% + var(--s-2)); top: auto;`) or it clips off-screen.
- **Icon-only trigger affordances:** `more` (lucide `Ellipsis`) icon with a `Tooltip` and
  `aria-haspopup="menu"` / `aria-expanded`.

Token-only CSS. Open-time `focus()` must not scroll the menu out of view (a documented dismissal
gotcha from `cursor-anchored-context-menu-primitive.md`); set the open state in one atomic update.

**KTD5 — Delete in the overflow reuses the lineage-delete controller and anchors its confirm to
the kebab.** "Delete" is not a plain action — for a node with live descendants it opens a confirm
(`LineageDeleteMenu` / `useLineageDelete`). The overflow's **Delete** item activates that flow via
the existing `deleteSignal` (the same signal Backspace/Delete fires). The naive "keep
`LineageDeleteMenu` mounted with its trigger `display:none`" approach is **rejected**: its popover
is positioned `right: 0` relative to its own trigger span, so a hidden/zero-width trigger lands the
confirm popover at an unpredictable wrapped-flex slot, detached from the `⋯` the user clicked. The
delete affordance must therefore keep a **real, laid-out anchor at the overflow location** — render
the `LineageDeleteMenu` trigger *as* (or co-located with) the `⋯` control so its confirm popover
anchors under the kebab, or drive `useLineageDelete` directly and anchor the confirm to the
overflow trigger's rect. A leaf still deletes quietly. U4 must verify (visual + E2E) that a
node-with-descendants confirm appears anchored to the `⋯` control. Postpone's `ScheduleMenu` and
Done's `DoneIntentMenu` stay as **visible** buttons (they are primary), so no other nested-menu
wiring is needed.

**KTD6 — Fixed overflow membership.** Raise, Lower, Delete are *always* in the overflow menu for
every element type; Open in full, Dismiss, Postpone, Skip, Done are *always* visible. No
responsive promotion/demotion (deferred). This keeps the membership testable with stable testids
and matches the user's "these are used infrequently" framing.

---

## Implementation Units

### U1. Compact the queue progress into one inline row in the top control bar

**Goal:** Collapse `.pq-progress` from a stacked two-row block to a single compact inline row
(`2/4 · 3 left` + slim bar) inside `ProcessSessionControls`, reclaiming header height (change 3).

**Requirements:** Change (3). Honors KTD1.

**Dependencies:** none.

**Files:**
- `apps/web/src/pages/queue/ProcessQueue.tsx` — `ProcessSessionControls` JSX (`.pq-progress`
  block, ~lines 1719-1733). Keep the prop shape and all testids.
- `apps/web/src/pages/queue/process-queue.css` — `.pq-progress`, `.pq-progress__nums`,
  `.pq-progress__est`, `.pq-progress__bar`, `.pq-progress__fill`, `.pq-session`.
- `apps/web/src/pages/queue/ProcessQueue.test.tsx` — the "shows the progress readout (N / total)"
  test.
- `apps/web/src/pages/queue/process-queue-css.test.ts` — token-lint stays green; adjust any pinned
  selector that changes.

**Approach:** Render the fraction, the `N left` estimate, and the bar on one flex row (e.g.
`2 / 4` · `3 left` · slim flex-grow bar) so `.pq-session` becomes a single compact band. Keep the
fill width math (`Math.min(cursor, total) / total`) and the `all done` / `N left` text intact. The
bar is decorative/non-interactive — mark it `aria-hidden` (no click target). Give `.pq-session` a
minimum row height matching the existing control height so the row stays comfortably clickable.
Token-only CSS; hover via border-color if any interactive state is added (convention
`hover-uses-border-not-shadow`).

**Patterns to follow:** existing `.pq-session` flex layout and `pq-seg` controls; token usage in
`process-queue.css`.

**Test scenarios:**
- Renders `cursor`/`total` as `N / total` and the `N left` estimate on the same row (assert both
  present, `process-progress` testid stable).
- `done` state shows `all done` and the bar fill reflects completion.
- `total === 0` renders a 0%-width fill without dividing by zero.
- css-contract test passes with no hard-coded colors.

**Verification:** progress reads correctly at start, mid-session, and done; header band is visibly
shorter; `pnpm test` green for the file.

---

### U2. Remove the duplicated source metadata row; relocate reading-progress to the rail

**Goal:** Delete `.pq-source__metarow` (author, URL, priority/status/scheduler chips, format
label, counts) and move the reading-progress caption (`block N of M · % · N words`) to the reader
rail (change 2). The Inspector becomes the single identity owner.

**Requirements:** Change (2). Honors KTD2.

**Dependencies:** none (independent of U1).

**Files:**
- `apps/web/src/pages/queue/ProcessQueue.tsx` — `ProcessSourceWorkbench` `sourceHeader`
  (~lines 1908-1988): remove `.pq-source__metarow`; render the reading caption near
  `.pq-source__rail` (~line 2006) from the existing `progressLabel` and `wordCount(doc.plainText)`
  values, gated on `doc.sourceFormat === null`. Keep the `process-source-progress` and
  `process-source-words` testids alive at their new (rail) home.
- `apps/web/src/pages/queue/process-queue.css` — remove/repurpose `.pq-source__metarow`,
  `.pq-source__meta`, `.pq-source__meta--link`, `.pq-source__meta--mono`, `.pq-source__dot`
  (`SourceMetaDot`) styling; add a compact rail-caption style. Keep the `.pq-source__rail`/`pbar`
  breakout intact.
- `apps/web/src/pages/queue/process-queue-css.test.ts` — the "uses tokenized source header spacing
  and a solid reader-style read-point button" test calls `cssBlock('.pq-source__metarow')`,
  `'.pq-source__meta'`, `'.pq-source__meta--mono'`, `'.pq-source__dot'`. **`cssBlock()` throws
  "Missing CSS block" on a deleted selector** — so these calls must be *removed*, not merely
  re-asserted; rewrite the test to pin the surviving rail-caption + read-point styling.
- `apps/web/src/pages/queue/ProcessQueue.test.tsx` — two tests invert:
  - "renders a source as an inline reading workbench" (~line 1609) hard-asserts read-point /
    progress / words live inside `process-source-header` and that the rail does **not** contain
    them — flip these containment assertions (progress/words now on `process-source-rail`;
    read-point now in `process-actions`).
  - "renders inspector-backed source metadata with a guarded external URL" and "renders non-http
    source URLs as plain metadata" now assert author/URL are **absent** from the workbench (the
    Inspector owns them).
- `docs/solutions/ui-bugs/process-queue-source-reader-metadata-row-chrome.md` and
  `process-queue-source-reader-library-header.md` — append a supersession note.

**Approach:** Keep the source **title** `h1` (it is the document heading, not duplicated chrome).
Drop the entire metarow. Move only the reading-position caption (`block N of M · % · N words`) to
the rail; do not re-render author/URL/chips anywhere in the workbench. Preserve the
`doc.sourceFormat === null` gate so PDF/video branches never show text-reader counts. **Extract and
card items are unaffected:** they do not render `ProcessSourceWorkbench` and never had a
`.pq-source__metarow`, so removing it changes nothing in their header regions (the shared
`.pq-card__meta` chip row for non-source/non-card attention items is also untouched).

**Patterns to follow:** the rail-local progress decision in
`process-queue-source-reader-metadata-row-chrome.md`; the single-owner rule in
`process-queue-source-reader-library-header.md`; `nowrap` dense-metadata convention from
`inbox-row-metadata-nowrap-compact-counts.md` for the surviving caption (keep digits and their
unit, e.g. `2435 words`, on one line).

**Test scenarios:**
- Text source: workbench renders the title and a rail caption containing `block N of M · %` **and**
  the word count, but **no** author/URL/status/priority chips.
- PDF and video sources (`doc.sourceFormat !== null`): no reading caption (format gate respected);
  specialized-reader copy still shows.
- The guarded-URL behavior is asserted on the Inspector path (unchanged), not the workbench.
- css-contract test passes after the deleted-selector `cssBlock` calls are removed.

**Verification:** the metadata line is gone; reading position + length still legible by the rail;
Inspector still shows full identity; text vs PDF vs media branches all correct.

---

### U3. Move "Set read-point" into the shared bottom action bar

**Goal:** Relocate the text-source read-point button from the workbench header
(`.pq-source__actions`) into `.pq-actions` (change 1), rendered only for text sources.

**Requirements:** Change (1). Honors KTD3.

**Dependencies:** U2 (both edit the source header; sequencing avoids churn). The action-bar edit
overlaps U4 — land U3 before U4.

**Files:**
- `apps/web/src/pages/queue/ProcessQueue.tsx` — remove the `.pq-source__actions` block from
  `sourceHeader` (~lines 1973-1986); add a read-point button to the `.pq-actions` JSX
  (~line 2629) for text-source items. `doc` (with `doc.sourceFormat`) is already a `ProcessCard`
  prop, so render the button when `isSource && doc.sourceFormat === null`; the
  `onSetSourceReadPoint` handler is already passed to `ProcessCard`. Apply the existing disabled
  condition (`busy || readPoint.saving`), the `bookmark` icon, the "Set read-point" label, and the
  `pq-btn--primary` accent. **Do not** render a `␣ Kbd` hint (Space is bound to skip in the loop —
  KTD3).
- `apps/web/src/pages/queue/process-queue.css` — drop `.pq-source__actions`; the read-point button
  reuses `.pq-btn pq-btn--primary` in the bar.
- `apps/web/src/pages/queue/ProcessQueue.test.tsx` — the "sets a source read-point inline without
  advancing the process cursor" test now finds the button in the action bar (and the
  workbench-layout test inverted in U2 covers its new location).
- `tests/electron/read-points.spec.ts` — these specs set the read-point via the IPC bridge
  (`window.appApi.readPoints.set`), **not** by clicking the button, so the read-back/restart specs
  are not affected by the relocation. Keep `process-source-readpoint` stable anyway for the one
  bridge-surface assertion that references it.

**Approach:** Place the read-point button at the leading edge of `.pq-actions` (before "Open in
full") so the primary reading action is prominent. The button appears only for text sources —
extracts, cards, PDF/video sources, and non-source items do not show it. **Re-verify three-zone
scroll ownership:** removing `.pq-source__actions` must not break the `min-height: 0` chain in the
source/card layouts; if pinning regresses, restore/add `min-height: 0` to the affected flex
ancestors (this fix is owned by U3, not just verified). The surviving rail reading-caption (U2)
sits inside the already-scroll-owned column, not the pinned header — confirm it does not become a
second scroll owner.

**Patterns to follow:** existing `.pq-actions` button structure; the read-point handler wiring
already present via `onSetSourceReadPoint`.

**Test scenarios:**
- Text source: the read-point button renders in the action bar (not the header) and clicking it
  calls `onSetSourceReadPoint` **without** advancing the cursor.
- Read-point button is disabled while `busy` or `readPoint.saving`.
- Non-text-source **sources** (PDF, video): no read-point button (format gate).
- Non-source items (extract, card, topic): no read-point button (type gate — not applicable).
- `read-points.spec.ts` read-back + restart specs pass unchanged (IPC-driven).

**Verification:** read-point set/advance works from the bar; survives restart (E2E, IPC path);
header is one band shorter; no scroll/pinning regression.

---

### U4. Collapse Raise / Lower / Delete into a kebab overflow menu

**Goal:** Add a `ProcessOverflowMenu` (`⋯`) to `.pq-actions` holding Raise, Lower, and Delete;
keep Open in full, Dismiss, Postpone, Skip, Done visible (change 4).

**Requirements:** Change (4). Honors KTD4, KTD5, KTD6.

**Dependencies:** U3 (both edit `.pq-actions`).

**Files:**
- `apps/web/src/components/queue/ProcessOverflowMenu.tsx` — new anchored-popover component
  (trigger = `more` icon `⋯` with `Tooltip`; items = Raise / Lower / Delete with icon + label).
  Props: `disabled`/`busy`, `onAction(action)` for raise/lower, `onDelete` (fires `deleteSignal`),
  `triggerTestId="process-action-more"`, `aria-haspopup="menu"`/`aria-expanded`. Implements the
  full keyboard contract from KTD4 (first-item focus on open, Arrow Up/Down roving, Tab/Escape,
  focus restore) and opens upward.
- `apps/web/src/components/queue/process-overflow-menu.css` (or a `.pq-overflow*` block in
  `process-queue.css`) — token-only popover styling, upward-opening
  (`bottom: calc(100% + var(--s-2)); top: auto;`).
- `apps/web/src/pages/queue/ProcessQueue.tsx` — in `.pq-actions`, replace the standalone
  Raise/Lower buttons with the visible cluster (Open in full, Dismiss, Postpone, Skip, Done) plus
  `ProcessOverflowMenu`. Resolve Delete per KTD5 so its confirm popover anchors under the `⋯`
  control; keep `process-action-delete` reachable (open the overflow first). Keep
  `process-action-raise`/`process-action-lower` testids on the menu items.
- `apps/web/src/pages/queue/process-queue.css` — `.pq-actions` layout for the new grouping.
- `apps/web/src/components/queue/ProcessOverflowMenu.test.tsx` — new component test.

**Approach:** Reuse the `ScheduleMenu`/`DoneIntentMenu` trigger/positioning scaffold for the
trigger and outside-click/Escape close, but add the keyboard-menu behavior and upward opening that
those components lack (KTD4) — do not copy `ScheduleMenu`'s focus-less Escape handler verbatim.
Raise/Lower items call the existing `onAction("raise")`/`onAction("lower")`. The Delete item fires
the existing `deleteSignal` so the lineage-aware confirm still governs node deletes, with the
confirm anchored to the kebab (KTD5). Do not touch `useProcessShortcuts.ts`, `PROCESS_BOUND_KEYS`,
or the `sessionHint` memo — keys are unchanged, so the status-bar footer keeps listing them. The
overflow works for all element types. The overflow is a plain action list, so no in-flight
busy-settling guard is needed (KTD4) — `busy` simply disables the trigger.

**Patterns to follow:** `apps/web/src/components/queue/ScheduleMenu.tsx`,
`DoneIntentMenu.tsx` (trigger scaffold), `apps/web/src/components/lineage/LineageDeleteMenu.tsx`
+ `useLineageDelete.ts` (delete flow), `apps/web/src/components/Tooltip.tsx`,
`apps/web/src/components/Icon.tsx` (`more`), and the focus/scroll gotchas in
`cursor-anchored-context-menu-primitive.md`.

**Test scenarios:**
- The `⋯` trigger opens an upward popover with Raise, Lower, Delete; outside-click and Escape
  close it; Escape restores focus to the trigger.
- On open, focus lands on the first item; Arrow Down/Up move focus cyclically through items.
- Raise / Lower items call `onAction("raise")` / `onAction("lower")`.
- The Delete item opens the lineage delete flow (fires `deleteSignal`); a leaf deletes quietly, a
  node with descendants opens the confirm **anchored to the `⋯` control** (assert the confirm
  popover is visible and positioned at the kebab, not detached).
- All five primary buttons (Open in full, Dismiss, Postpone, Skip, Done) remain directly visible.
- The overflow renders for source, extract, and card items.
- Keyboard `+`/`-`/Delete still drive raise/lower/delete with the buttons inside the menu (shortcut
  path unchanged).
- The `⋯` trigger is disabled when `busy`; `aria-haspopup="menu"`/`aria-expanded` present; the
  icon-only trigger has an accessible label/Tooltip.

**Verification:** the bar shows five buttons + a `⋯`; rare actions are one click away; shortcuts
intact; the delete confirm anchors under the kebab; keyboard-only users can reach every item; works
across all three element types.

---

### U5. Cross-cutting tests + visual verification across element types

**Goal:** Prove the redesign holds for source, extract, and card items, in light and dark, and
keep the pinned E2E/geometry specs green (the user explicitly requires multiple visual checks
across element types).

**Requirements:** All four changes; Definition of Done (lint, typecheck, test, e2e).

**Dependencies:** U1–U4.

**Files:**
- `tests/electron/process-queue.spec.ts` — the action-rotation loop (~lines 263-287) calls
  `getByTestId('process-action-raise'|'process-action-lower').click()` **directly**. Since U4 moves
  these into the overflow popover, the spec must now **open `process-action-more` first**, then
  click the item — an interaction-model change, not a selector swap. Keep the one-at-a-time loop,
  action advancement, and three-zone pinned-footer reachability specs passing with the new bar.
- `tests/electron/read-points.spec.ts`, `tests/electron/done-intent.spec.ts`,
  `tests/electron/process-editor-focus.spec.ts` — verify the relocated read-point and action
  reachability still pass; adjust selectors only if needed (prefer keeping testids stable).
- `apps/web/src/pages/queue/useProcessShortcuts.test.tsx` — confirm `PROCESS_BOUND_KEYS` unchanged.

**Approach:** Run the full gate (`pnpm lint`, `pnpm typecheck`, `pnpm test`, relevant `pnpm e2e`).
Capture screenshots of the live app for: a text **source** item, an **extract** item, and a
**card** item — each in light and dark, plus one narrow (inspector-open) window width — confirming
the header is shorter, the metadata line is gone, progress is compact in the top bar, the
read-point button sits in the action bar (source only), and the `⋯` overflow opens **upward** with
Raise/Lower/Delete and a kebab-anchored delete confirm. Compare against `design/kit` reference
where applicable.

**Test scenarios (Covers the DoD E2E requirement):**
- E2E: a source item processes end-to-end (set read-point → Done) with the relocated controls.
- E2E: the action-rotation loop opens the overflow before raise/lower and still advances the
  cursor after each action.
- E2E: a card item reveals + grades inline with the shared bar showing the `⋯` overflow and no
  read-point button.
- E2E: an extract item distills inline with the shared bar; overflow present; no read-point.
- E2E: read-point set on a source survives an app restart (existing IPC-driven spec).
- Geometry: the pinned grade footer / action bar stays reachable while a large body scrolls
  (existing three-zone spec).

**Verification:** all gates green; screenshots for all three element types in both themes (plus a
narrow width) attached to the change; no regression in the pinned specs.

---

## Risks & Dependencies

- **Re-introducing deleted chrome (KTD1).** Mitigation: refine `ProcessSessionControls` in place;
  do not add a page-level bar; keep prop shape + testids. Reviewed against
  `process-queue-inline-session-controls.md`.
- **Misleading "preserved" shortcut (KTD3).** The current `␣` hint on the read-point button does
  not correspond to a loop binding (Space = skip). Mitigation: drop the hint, do not add a
  colliding Space handler, and remove any test that asserts a Space→read-point binding.
- **Losing a capability or shortcut.** Mitigation: Raise/Lower/Delete handlers and
  `PROCESS_BOUND_KEYS` are untouched; the status-bar `sessionHint` keeps listing the keys; tests
  assert each moved control still works by shortcut.
- **Delete confirm mis-anchoring (KTD5).** A `display:none` lineage-delete trigger lands the
  confirm popover at an arbitrary flex slot. Mitigation: keep a real laid-out anchor at the kebab;
  E2E asserts the confirm is visible and positioned under `⋯`. `lineage-deletion.spec.ts` guards
  the delete semantics.
- **Overflow popover clipping / keyboard reachability (KTD4).** The bar is pinned at viewport
  bottom and `ScheduleMenu` lacks menu keyboard nav. Mitigation: open upward; implement
  first-item focus + arrow roving + Escape focus restore; verify with a keyboard E2E.
- **Test harness breakage, not just assertion failure.** `process-queue-css.test.ts` `cssBlock()`
  throws on deleted selectors, and `process-queue.spec.ts` clicks raise/lower directly. Mitigation:
  U2 removes the deleted-selector `cssBlock` calls; U5 opens the overflow before clicking.
- **Scroll-ownership regression (three-zone).** Mitigation: U3 owns restoring `min-height: 0` on
  every flex ancestor when the header sheds bands; the Electron geometry spec catches overlap.
- **PDF/media source branches.** Mitigation: all reading-only chrome stays gated on
  `doc.sourceFormat === null`; PDF/video render neither the reading caption nor the read-point.

---

## Sources & Research

- `apps/web/src/pages/queue/ProcessQueue.tsx` — single session shell; `ProcessSessionControls`
  (~1707), `ProcessSourceWorkbench`/`sourceHeader` (~1868/1908), `ProcessCard` + `.pq-actions`
  (~2263/2629), `doc` prop on `ProcessCard` (~2306), Space=skip comment (~1381).
- `apps/web/src/pages/queue/process-queue.css`; `process-queue-css.test.ts` (token-only + breakout
  contract; `cssBlock` throws on missing selectors).
- `apps/web/src/pages/queue/useProcessShortcuts.ts` (`PROCESS_BOUND_KEYS`; Space → `next()` for
  non-cards).
- `apps/web/src/components/queue/ScheduleMenu.tsx`, `DoneIntentMenu.tsx`;
  `apps/web/src/components/lineage/LineageDeleteMenu.tsx`, `useLineageDelete.ts`;
  `apps/web/src/components/menu/ContextMenu.tsx`; `apps/web/src/components/Tooltip.tsx`,
  `Icon.tsx`.
- `apps/web/src/components/inspector/Inspector.tsx` (identity owner: author + `ExternalUrlLink`).
- `apps/web/src/shell/statusHint.tsx`, `Shell.tsx` (`sessionHint` footer).
- Tests: `tests/electron/process-queue.spec.ts` (direct raise/lower clicks ~263-287),
  `read-points.spec.ts` (IPC-driven), `done-intent.spec.ts`, `process-editor-focus.spec.ts`;
  `apps/web/src/pages/queue/ProcessQueue.test.tsx` (workbench-layout assertions ~1609),
  `useProcessShortcuts.test.tsx`.
- Learnings: `docs/solutions/ui-bugs/process-queue-inline-session-controls.md`,
  `process-queue-source-reader-library-header.md`,
  `process-queue-source-reader-metadata-row-chrome.md`,
  `docs/solutions/design-patterns/non-modal-intent-menu-replacing-confirm-gate.md`,
  `cursor-anchored-context-menu-primitive.md`,
  `three-zone-scroll-owned-review-card-surface.md`,
  `docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md`,
  `docs/solutions/architecture-patterns/shell-shortcut-drift-guard-first-keycap-and-overlay-guarded-history-nav.md`.
- Design: `design/tokens.css`, `design/icon-map.md`, `design/AGENTS.md`; `apps/web/AGENTS.md`.
