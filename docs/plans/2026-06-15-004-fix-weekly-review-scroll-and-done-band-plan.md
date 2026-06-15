---
title: "fix: Preserve scroll on Weekly Review section toggle + remove green done band"
type: fix
date: 2026-06-15
status: ready
depth: lightweight
---

# fix: Preserve scroll on Weekly Review section toggle + remove green done band

## Summary

Two small, independent UI fixes on the Weekly Review screen (`/weekly`, "Ledger and
integrity"):

1. **Scroll jump on Done/Skip.** Clicking **Done** (or **Skip**, **Complete**, **Snooze**, or
   applying parked/chronic decisions) currently scrolls the page back to the top. Root cause:
   the toggle handler calls `onReload()`, and `load()` unconditionally flips the screen to a
   full-page `Loading weekly review...` placeholder, **unmounting** the body. The scrollable
   container (`.shell-page`) collapses to zero content height and resets `scrollTop` to 0, then a
   fresh body remounts. Fix with a stale-while-revalidate pattern: keep the current data rendered
   during background refetches so the body never unmounts and scroll is preserved.

2. **Green left band on completed items.** Completed sections render a 3px green vertical bar via
   `.wk-sec--done::before { background: var(--ok); }`. Remove it entirely. The done state stays
   signaled by the existing green-tinted border (`.wk-sec--done` border-color) and the `DONE`
   status pill.

Both fixes are renderer-only (`apps/web`), behind the existing typed `window.appApi` bridge.

---

## Problem Frame

The Weekly Review screen lives entirely in `apps/web/src/weekly/WeeklyReviewScreen.tsx` and is
styled by `apps/web/src/weekly/weekly-review.css`. It renders inside the app shell's single
scroll region, `<main className="shell-page">` (`apps/web/src/shell/Shell.tsx`,
`apps/web/src/shell/shell.css` — `overflow-y: auto`). The `.wk` page container itself does not
scroll; scroll position is owned by `.shell-page`.

**Scroll bug mechanism (confirmed).** `WeeklyReviewScreen` holds a `LoadState` and its `load()`
callback always begins with `setState({ status: "loading" })`. Every section toggle path
(`setSection` → `await onReload()`) and the header actions (`complete`, `dismiss`) call this same
`load()`. So each click tears down `<WeeklyReviewBody>`, renders the `Loading weekly review...`
placeholder for a frame (zeroing the scroll container's content height), then remounts a new body
— losing the user's scroll position. The buttons are plain `type="button"` controls with no
wrapping `<form>`; this is **not** a form-submit or anchor-hash scroll-to-top, and there is no
router scroll restoration in play. The cause is purely the loading-placeholder remount on refetch.

**Green band mechanism (confirmed).** `.wk-sec::before` is a `position:absolute; left:0; width:3px`
rail that is `background: transparent` by default; `.wk-sec--done::before` paints it
`var(--ok)` (green, oklch hue 158). The `wk-sec--done` class is applied by `Section`'s className
builder when the server reports the section `done`.

---

## Requirements

- **R1.** After clicking Done/Skip on a section while scrolled down, the page must keep its scroll
  position (no jump to top). The same must hold for Complete, Snooze, and parked/chronic apply,
  which share the reload path.
- **R2.** Section state still updates correctly and is persisted via
  `appApi.updateWeeklyReviewProgress` (no behavioral regression to the toggle/complete/snooze
  flows). The busy/disabled affordance on the acting button must still show during the in-flight
  request.
- **R3.** A background refetch that fails must surface its error without silently swallowing it and
  without blowing away the rendered screen mid-session. The initial page load failure must still
  show the full-page error state.
- **R4.** Completed sections show **no** green left band. The done state remains visually distinct
  via the existing border tint and the `DONE` pill. The skipped-state grey rail and all other
  weekly state styling (segmented-control active state, pills) are untouched.

---

## Key Technical Decisions

- **KTD1 — Stale-while-revalidate over scroll save/restore.** Make `load()` accept a
  `{ background?: boolean }` option. Only the initial load sets `status: "loading"`; reload calls
  triggered by user actions run in `background` mode, which keeps the current `ready` data
  rendered while refetching and swaps in new data on success. This fixes the root cause (the
  remount) rather than masking it by capturing/restoring `scrollTop`, which is brittle against the
  placeholder's zero-height frame. Bonus: it removes the jarring full-page loading flash on every
  toggle. The acting button already shows a `busySection` disabled state, so responsiveness is
  still signaled.
- **KTD2 — Background-refresh errors propagate to the action handler.** In `background` mode,
  `load()` re-throws on failure instead of switching to the full-page `error` state. The existing
  action handlers (`setSection`, `complete`, `dismiss`) already wrap `await onReload()` in a
  try/catch that sets `actionError` (rendered as an inline banner), so a failed background refresh
  surfaces inline while the body stays mounted (R3). Initial (non-background) load failures still
  set `status: "error"`.
- **KTD3 — Remove the green band, keep the rail.** Delete only the
  `.wk-sec--done::before { background: var(--ok); }` rule. Leave `.wk-sec::before` (the shared
  rail) and `.wk-sec--skipped::before` (grey) intact so skipped styling is unaffected, and keep
  `.wk-sec--done`'s border tint. This is an intentional design call that sits in mild tension with
  the repo's established 3px-left-band state vocabulary (cf. `.qitem--protected::before`); record
  it in the commit and pin it with a CSS-contract assertion so it is not "restored" later by
  analogy. (Per `docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md`,
  do **not** touch the `.wk-seg button[data-active="true"]` selected-state styling or any
  `box-shadow: none;` flatness guards.)

---

## Implementation Units

### U1. Preserve scroll position by making Weekly Review reloads background refreshes

**Goal:** Stop the full-page loading-placeholder remount on user-triggered reloads so the scroll
container keeps its position (R1, R2, R3).

**Requirements:** R1, R2, R3

**Dependencies:** none

**Files:**
- `apps/web/src/weekly/WeeklyReviewScreen.tsx` (modify)
- `apps/web/src/weekly/WeeklyReviewScreen.test.tsx` (modify — add regression test)

**Approach:**
- Change `load` to accept an optional `{ background?: boolean }`. When not background, set
  `status: "loading"` first (unchanged initial-load behavior). When background, skip the loading
  state and keep current data rendered; on success `setState({ status: "ready", data })`; on
  failure, if background **re-throw** (so the calling action handler sets `actionError`), else set
  `status: "error"` as today.
- The initial-load `useEffect` keeps calling `load()` (non-background).
- Pass a background reload into the body: `onReload={() => load({ background: true })}` (the body's
  `onReload: () => Promise<void>` prop contract is unchanged). All body actions (`setSection`,
  `complete`, `dismiss`, parked/chronic apply) inherit scroll preservation through this single
  prop.
- Keep `WeeklyReviewBody` mounted across refreshes; its local state (`busySection`, `message`,
  `actionError`) intentionally persists across a background refresh.

**Patterns to follow:** Existing `useCallback`/`LoadState` shape in this file; inline error banner
already rendered from `actionError`.

**Test scenarios** (`apps/web/src/weekly/WeeklyReviewScreen.test.tsx`, RTL + mocked `appApi`):
- Covers R1/R2. Initial render shows the body (not the loading placeholder); click **Done** on a
  section → `updateWeeklyReviewProgress` called with that section `done`, `getWeeklyReviewSummary`
  re-fetched, and the `Loading weekly review...` placeholder is **never** rendered after the
  initial load (assert `screen.queryByText(/Loading weekly review/i)` is null across the toggle).
  This is the jsdom-provable proxy for "body not remounted → scroll preserved", since jsdom has no
  layout/scroll.
- Covers R2. Toggling a `done` section again sends `pending` (existing toggle behavior preserved).
- Covers R3. A **background** reload that rejects surfaces the error inline (assert the
  `actionError` banner text appears) and the body remains rendered (the section list is still in
  the document, loading placeholder still absent).
- Covers R3. The **initial** load rejecting still renders the full-page error state
  (`weekly-error` testid) — existing behavior preserved.

**Verification:** `pnpm test` green including the new cases; `pnpm typecheck` clean. Manually (or
via the optional Electron geometry test below): with a weekly session tall enough to scroll, scroll
down, click Done, and confirm the page does not jump to the top.

**Execution note:** Add the "no loading flash on toggle" regression test first — it encodes the
exact root cause and should fail against the current `load()` before the fix.

### U2. Remove the green left band on completed sections + pin it with a CSS-contract test

**Goal:** Completed sections no longer render the green vertical band; done-ness stays signaled by
the border tint and `DONE` pill; skipped styling untouched (R4).

**Requirements:** R4

**Dependencies:** none (independent of U1)

**Files:**
- `apps/web/src/weekly/weekly-review.css` (modify — remove `.wk-sec--done::before`)
- `apps/web/src/weekly/weekly-review-css.test.ts` (modify — add guard assertions)

**Approach:**
- Delete the `.wk-sec--done::before { background: var(--ok); }` rule (lines ~256–258). Keep
  `.wk-sec::before` (the transparent rail), `.wk-sec--skipped::before` (grey), and `.wk-sec--done`
  (border tint).
- Add a `cssBlock(selector)` helper to `weekly-review-css.test.ts` mirroring
  `apps/web/src/pages/queue/queue-css.test.ts` (regex-extract a rule body, throw if missing), and
  add assertions that lock the intended design.

**Patterns to follow:** `apps/web/src/pages/queue/queue-css.test.ts` `cssBlock` helper and
property-level presence/absence assertions; the existing token-only contract already in
`weekly-review-css.test.ts`.

**Test scenarios** (`apps/web/src/weekly/weekly-review-css.test.ts`):
- Covers R4. The green done band is gone: assert that the stylesheet contains **no**
  `.wk-sec--done::before` rule that sets `background: var(--ok)` — either the selector block is
  absent, or if present it does not contain `background: var(--ok);`. (Implement as: `cssBlock`
  throws / selector not present ⇒ pass; guard against re-adding the green background.)
- Covers R4. Done-ness is still signaled: `cssBlock(".wk-sec--done")` still contains a
  `border-color` declaration referencing `var(--ok)` (the border tint is retained).
- Covers R4. Skipped styling is untouched: `cssBlock(".wk-sec--skipped::before")` still contains
  `background: var(--border-strong);`.
- The existing token-only / no-hex / structural-class assertions continue to pass.

**Verification:** `pnpm test` green including new CSS-contract cases; `pnpm lint` clean. Visually
confirm in `pnpm dev` that completed sections show no green bar but remain recognizably "done".

---

## Scope Boundaries

- **In scope:** the two fixes above, their tests, and a CSS-contract guard for the band removal.
- **Out of scope / unchanged:** the segmented-control active styling, skipped-state grey rail,
  status pills, the underlying maintenance commands and IPC, and the weekly summary data shape.
- **Deferred to follow-up work:** an Electron/Playwright geometry test that seeds a tall weekly
  session, scrolls `.shell-page`, clicks Done, and asserts `scrollTop` is unchanged. The structural
  fix in U1 (no remount on refetch) is what actually preserves scroll; jsdom cannot prove scroll
  position, so the in-repo regression guard is the "no loading flash on toggle" assertion. A real
  geometry test would be the strongest proof but requires heavier session seeding; add it if the
  `/weekly` screen later gets a dedicated E2E spec (none exists today). Per
  `docs/solutions/design-patterns/three-zone-scroll-owned-review-card-surface.md`, scroll behavior
  that is load-bearing is normally paired with an Electron geometry test — noted here honestly
  rather than claimed as covered.

---

## Risks & Notes

- **Background-refresh staleness:** keeping stale data rendered for the ~1 IPC round-trip is
  intentional and matches the user's expectation (the acting button shows busy). No data
  correctness risk — the server remains the source of truth and the swap happens on resolve.
- **Design-vocabulary tension:** removing the left band departs from the app's 3px-band state
  idiom. Mitigated by the retained border tint + pill and the new contract test, and called out in
  the commit message so a future reviewer does not reintroduce it by analogy to
  `.qitem--protected::before`.
- **Definition of Done:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant Electron
  `pnpm e2e`. No persistence/schema changes, so the persistence-specific DoD items do not apply.
