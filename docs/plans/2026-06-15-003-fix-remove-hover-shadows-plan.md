---
title: "fix: Remove hover-elevation shadows on list/card/tile rows"
type: fix
date: 2026-06-15
status: ready
depth: lightweight
---

# fix: Remove hover-elevation shadows on list/card/tile rows

## Summary

In the queue and home pages, hovering a row currently raises it with a drop
shadow (`box-shadow: var(--shadow-sm)`). The user finds this hover-elevation
noisy and wants it gone there and, more broadly, wherever the app uses the same
hover-shadow idiom on list rows / cards / tiles. Shadows that are *structural*
— selected-state elevation on segmented controls and nav, and depth on floating
overlays (menus, tooltips, popovers, reader toolbars) — are intentionally kept.

The fix is a targeted CSS change: drop the `box-shadow` from the `:hover` rules
that match the hover-elevation idiom, keeping the border-emphasis as the hover
affordance, and resolve the two cases that pair the shadow with a `translateY`
lift so the hover state still reads correctly without a shadow.

## Problem Frame

The hover affordance on interactive list rows uses two cues at once: a stronger
border *and* a drop shadow. The drop shadow is the source of the visual noise —
it makes every row "pop" off the page on mouseover. Removing the shadow while
keeping the border change preserves a clear, calmer hover affordance.

Three components use the exact idiom `:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }`:
queue items (`.qitem`), home priority rows (`.home-prow`), and home tiles
(`.home-tile`). Two more use a near-identical idiom with an added `translateY`
lift: help category cards (`.hc-cat`) and review grade buttons (`.grade`).

## Scope Boundaries

**In scope — remove hover-elevation shadow:**
- `.qitem:hover` (queue page) — reported
- `.home-prow:hover`, `.home-tile:hover` (home page) — reported
- `.hc-cat:hover` (help category cards) — same idiom, "more broadly"
- `.grade:hover` (review grade buttons) — same idiom, "more broadly"

**Out of scope — keep (structural, not hover noise):**
- Selected/active-state elevation on segmented controls and nav:
  `.lib-mode__btn--on`, `.lib-seg__btn--on`, `.wk-seg button[data-active="true"]`,
  `.seg--on`, `.shell-nav__item--on`, `.shell-usermenu__theme-option--on`.
  These communicate *selection*, not hover, and the user explicitly said not all
  shadows need removing.
- Focus-ring composites (`.shell-usermenu__theme-option--on:focus-visible` →
  `box-shadow: var(--shadow-sm), var(--focus-ring)`) — accessibility affordance.
- Floating-overlay depth: context/schedule/done-intent/lineage menus, tooltips,
  inspector, and the reader floating toolbars (`--shadow-lg/md/pop`, including the
  three inline `boxShadow: var(--shadow-lg)` in `SourceReader.tsx`). Depth is
  meaningful for surfaces that genuinely float above content.
- The `--shadow-sm/md/lg/pop` token definitions in `design/tokens.css` are left
  intact — they are still used by the kept cases.

### Deferred to Follow-Up Work
- None.

## Key Technical Decisions

- **Edit the `:hover` rules, not the tokens.** The shadow tokens remain valid for
  selected-state and overlay use. Stripping the token would over-reach and break
  the kept cases. Repo-relative, per-rule edits keep the blast radius minimal.
- **Keep border-emphasis as the hover cue.** `.qitem`, `.home-prow`, `.home-tile`,
  `.hc-cat` already change `border-color` on hover; that remains the affordance.
- **Resolve the `translateY` lift coherently.** `.hc-cat:hover` and `.grade:hover`
  pair the shadow with `transform: translateY(-1px)`. A lift with no shadow reads
  as the element jumping for no reason. For `.hc-cat` (a card, mirrors home/queue),
  drop both the shadow and the lift so hover is border-emphasis only, consistent
  with the other cards. For `.grade` (a button with *no* border-color hover cue),
  removing both would leave zero hover feedback — instead remove the shadow and
  give the button a non-shadow hover cue (background/border emphasis), preserving
  clear interactive feedback. Final exact cue confirmed visually during work.

## Implementation Units

### U1. Remove hover shadow on queue items

**Goal:** `.qitem:hover` no longer casts a drop shadow; border-emphasis remains.
**Files:** `apps/web/src/pages/queue/queue.css`
**Approach:** In the `.qitem:hover` rule (~line 353), remove the
`box-shadow: var(--shadow-sm);` line. Keep `border-color: var(--border-strong);`.
Confirm `.qitem--active` (which already sets `box-shadow: none`) and
`.qitem--protected` are unaffected.
**Patterns to follow:** Matches `.qitem--active { box-shadow: none; }` already in
the same file — the resting/active state already avoids shadow.
**Test scenarios:** Test expectation: none — pure CSS hover-state change, no
behavioral logic. Verified via the queue E2E smoke + visual check in U6.

### U2. Remove hover shadow on home priority rows and tiles

**Goal:** `.home-prow:hover` and `.home-tile:hover` no longer cast a drop shadow.
**Files:** `apps/web/src/pages/home/home.css`
**Approach:** Remove `box-shadow: var(--shadow-sm);` from both `.home-prow:hover`
(~line 181) and `.home-tile:hover` (~line 251). Keep the `border-color` change.
Both elements have `transition: all var(--fast) var(--ease)` on the base rule;
no transition cleanup needed (no dangling shadow-only transition).
**Test scenarios:** Test expectation: none — CSS hover-state only. Verified in U6.

### U3. Remove hover shadow on help category cards

**Goal:** `.hc-cat:hover` no longer casts a shadow; hover is border-emphasis only,
consistent with home/queue cards.
**Files:** `apps/web/src/help/help.css`
**Approach:** In `.hc-cat:hover` (~line 552), remove `box-shadow: var(--shadow-sm);`
and the paired `transform: translateY(-1px);`. Keep `border-color: var(--border-strong);`.
**Test scenarios:** Test expectation: none — CSS hover-state only. Verified in U6.

### U4. Resolve hover feedback on review grade buttons

**Goal:** `.grade:hover` no longer casts a shadow, but still gives clear, calm
hover feedback (grade buttons have no border-color hover cue today).
**Files:** `apps/web/src/review/review.css`
**Approach:** In `.grade:hover` (~line 396), remove `box-shadow: var(--shadow-sm);`.
Replace the shadow-driven lift with a non-shadow hover cue — a subtle background
shift (e.g. `var(--surface-2)`) and/or `border-color: var(--border-strong)`,
matching the app's border/background hover idiom. Decide whether to keep the
`translateY(-1px)` based on the visual check in U6 (drop it if it reads as a
shadowless jump). Ensure `.grade:disabled` and active grade states are unaffected.
**Patterns to follow:** Border/background hover emphasis as used by
`.shell-nav__item:hover { background: var(--surface-2); }`.
**Test scenarios:** Test expectation: none for styling. Existing review E2E must
still pass (grade buttons remain clickable and visually distinct on hover).

### U5. Sweep for any remaining hover-elevation shadows

**Goal:** Confirm no other `:hover`/interactive-row rule reintroduces the same
hover-shadow idiom anywhere in `apps/web/src` or `packages/ui/src`.
**Files:** none (verification unit); fix in place if a stray instance is found.
**Approach:** Re-run the hover-block shadow sweep (grep `:hover` blocks that set
`box-shadow`) across `apps/web/src` and `packages/ui/src`. Confirm only the kept
selected-state / overlay shadows remain. Inspect
`apps/web/src/pages/source/reader.css:310` (`transition: box-shadow ...`) to
confirm it animates a kept structural shadow, not a hover-elevation; leave it if so.
**Test scenarios:** Test expectation: none — audit step.

### U6. Visual + suite verification (light and dark)

**Goal:** Prove the hover states look correct in both themes and the suite is green.
**Files:** none (verification unit).
**Approach:** Run `pnpm lint`, `pnpm typecheck`, `pnpm test`. Launch the app
(`pnpm dev`) or relevant Playwright path; on the queue and home pages, hover rows
and confirm: no drop shadow, border-emphasis hover still reads clearly in light
and dark. Confirm help cards and review grade buttons still have legible hover
feedback. Confirm kept shadows (active nav item, selected segmented tabs, open
menus/tooltips/reader toolbars) are unchanged.
**Verification:** lint/typecheck/test pass; queue/home/help/review hover states
shadow-free with intact affordance in both themes; no regression to kept shadows.

## Verification Strategy

- `pnpm lint` (Biome) clean.
- `pnpm typecheck` clean (no TS touched, but run for safety).
- `pnpm test` green.
- Relevant `pnpm e2e` / Playwright for queue and review still pass.
- Manual/automated screenshot check of hover states in light + dark mode.

## Risks & Dependencies

- **Low risk.** CSS-only, per-rule edits; no logic, schema, IPC, or persistence
  touched, so `operation_log` / transaction / FK invariants are not in play.
- **Main risk: over- or under-reach.** Mitigated by the explicit keep-list above
  and the U5 sweep. The `translateY` cases (`.hc-cat`, `.grade`) are the only
  spots needing a judgment call, handled in U3/U4 with a visual confirmation.
