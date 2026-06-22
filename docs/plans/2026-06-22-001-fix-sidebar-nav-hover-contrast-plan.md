---
title: "fix: Sidebar nav hover contrast"
date: 2026-06-22
type: fix
depth: lightweight
status: planned
---

# fix: Sidebar nav hover contrast

## Summary

The left sidebar's hover affordance is nearly invisible in light mode and the active item
degrades on hover. Both stem from `--surface-2` being used as the hover fill for interactive
items that rest on the `--sunken` sidebar, where it sits only ~0.007 L away. Fix by introducing
one semantic hover token tuned per theme for the sunken sidebar, applying it to the nav items and
the user chip, and adding a dedicated hover state for the active nav item so it stays crisp.
Minimalist: one new token, three small CSS rules, no markup or component changes.

## Problem Frame

Two defects, same surface (`.shell-sidebar`, background `--sunken`):

1. **Inactive hover is imperceptible (light mode).** `.shell-nav__item:hover` and
   `.shell-userchip:hover` both set `background: var(--surface-2)`. In light mode
   `--sunken` = `oklch(0.965 …)` and `--surface-2` = `oklch(0.972 …)` — a 0.007 lightness step,
   below the just-noticeable threshold. (Dark mode is 0.076 apart and reads fine, so this is
   primarily a light-mode defect.)
2. **Active item muddies on hover.** `.shell-nav__item:hover` (specificity 0,2,0) overrides
   `.shell-nav__item--on` (0,1,0), so hovering the *current* item (e.g. Library while on Library)
   replaces its clean white `--surface` card with grey `--surface-2`, reducing contrast instead
   of reinforcing it. There is no "hover on active" state.

The design kit (`design/kit/styles/app.css`) shares the same `--surface-2` hover, but the kit is
immutable reference and `design/tokens.css` is the editable canonical token source.

## Requirements

- R1: Hovering an inactive sidebar item (nav or user chip) produces a clearly perceptible
  background change in **both** light and dark themes, while staying minimalist (a subtle fill,
  not a heavy block).
- R2: Hovering the **active** nav item keeps it visually distinct (does not muddy to a flat grey);
  hover still gives feedback.
- R3: No hard-coded colors — every value resolves to a design token (per `design/AGENTS.md`).
- R4: No regressions to `--surface-2`'s many other uses (buttons, menus, chips, badges), which
  rest on white `--surface`/`--canvas` and read fine there. The fix must be scoped to the
  sunken-sidebar surface, not a global `--surface-2` change.

## Key Technical Decisions

- **KTD1 — One theme-adaptive `color-mix` overlay token, not a per-theme value or a retuned
  `--surface-2`.** `--surface-2` is correct on white surfaces; only its use on the sunken sidebar
  is broken. Define a single semantic token `--sidebar-hover:
  color-mix(in oklch, var(--text) <n>%, transparent)` **once** (outside the light/dark blocks) so
  it references the already-theme-aware `--text` and adapts automatically. `color-mix` is already
  used in this codebase (e.g. `shell.css` line ~365, `reader/extract-view.css`,
  `trash/trash.css`), so this introduces no new technique. Rejected: a per-theme hardcoded
  `--sidebar-hover` (two reviewers showed a dark hardcode at/above 0.214 inverts the active-item
  hierarchy); reusing `--border-faint` (light-only, no dark fix); inlining the `color-mix` twice
  (a name avoids duplication across the two consumers and keeps the percentage tunable in one
  place).
- **KTD2 — Overlay percentage tuned to a perceptible-but-subtle step in both themes.**
  A low-single-digit `--text` overlay (start at 6%) composites to ~0.92 on the light sidebar
  (`--sunken` 0.965 → ~0.042 step, vs the old 0.007) and to ~0.20 in dark (`--sunken` 0.158 →
  ~0.046 step). Critically, the dark result lands **below** the active card (`--surface` 0.214),
  so an inactive hover never out-lightens the active item — the inversion a hardcoded value risked
  is structurally avoided. Final percentage verified by screenshot in U3.
- **KTD3 — Active-on-hover pins `--surface`; no shadow escalation.**
  `.shell-nav__item--on:hover` pins `background: var(--surface)` to defeat the
  `:hover`-over-`--on` specificity override that muddies the active card. It does **not** touch
  `box-shadow`: per
  `docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md`, hover must
  signal via background/border, and the `--shadow-sm` already on `.shell-nav__item--on` is an
  *intentional selection lift* that hover must not escalate. (An earlier draft added an animated
  `--shadow-md` lift; code review caught the convention violation, and dropping it is also the
  more minimalist result.) The rule is placed *before* `.shell-nav__item:focus-visible` so the
  focus ring still wins for a focused active item (no focus-state regression).

## Implementation Units

### U1. Add the theme-adaptive `--sidebar-hover` token

**Goal:** Introduce one semantic hover-overlay token for interactive items on the sunken sidebar.
**Requirements:** R1, R3, R4.
**Files:** `design/tokens.css`
**Approach:** Add `--sidebar-hover: color-mix(in oklch, var(--text) 6%, transparent);` **once** in
the base `:root` (alongside layout/motion tokens, *outside* the light/dark theme blocks) so it
resolves against the active theme's `--text`. Short comment: "hover fill for interactive items on
the `--sunken` sidebar (nav items, user chip)." The 6% is tuned in U3.
**Patterns to follow:** Existing `color-mix(in oklch, …)` usage in `shell.css` and the base-`:root`
token grouping in `tokens.css`.
**Test scenarios:** `Test expectation: none — token declaration. Covered by the U2 string
assertions and U3 visual verification.`

### U2. Apply `--sidebar-hover` and fix the active-item hover

**Goal:** Use the token for sidebar hovers, fix the muddy active-hover, and animate the lift.
**Requirements:** R1, R2, R3.
**Files:** `apps/web/src/shell/shell.css`, `apps/web/src/shell/shell-css.test.ts`
**Approach:**
- `.shell-nav__item:hover` → `background: var(--sidebar-hover)` (keep `color: var(--text)`).
- `.shell-userchip:hover` → `background: var(--sidebar-hover)`.
- Add `.shell-nav__item--on:hover { background: var(--surface); }` immediately after the
  `.shell-nav__item--on` block — and *before* `.shell-nav__item:focus-visible` — so it wins the
  cascade over `:hover` by source order at equal specificity while leaving the focus ring intact.
  No `box-shadow` (see KTD3).
**Patterns to follow:** Existing `.shell-nav__item--on` block; the existing `transition` shorthand
on `.shell-nav__item`.
**Test scenarios:** These are *new* assertions in `shell-css.test.ts` (no prior nav/hover-token
test exists). Using the file's existing `cssBlock(selector)` helper:
- `tokensCss` matches the `--sidebar-hover: color-mix(in oklch, var(--text) …)` declaration (so a
  rename/regression in `tokens.css` fails rather than silently leaving a dead `var` in `shell.css`).
- `cssBlock(".shell-nav__item:hover")` `.toContain("var(--sidebar-hover)")` and no longer
  `--surface-2`.
- `cssBlock(".shell-userchip:hover")` `.toContain("var(--sidebar-hover)")`.
- `cssBlock(".shell-nav__item--on:hover")` exists, `.toContain("var(--surface)")`, and — per the
  hover convention — neither hover block matches `box-shadow:`.

### U3. Visual verification in light and dark (ce-frontend-design)

**Goal:** Confirm the hover reads clearly and stays minimalist; finalize token values.
**Requirements:** R1, R2.
**Files:** none (verification); may adjust U1 token values.
**Approach:** Run the app, screenshot the sidebar in light and dark with (a) an inactive item
hovered and (b) the active item hovered. Compare against the design kit's calm aesthetic. Nudge
the U1 values if the step is too weak or too heavy. Apply the ce-frontend-design screenshot-verify
loop.
**Test scenarios:** `Test expectation: none — visual verification step.`

## Scope Boundaries

In scope: hover fill for `.shell-nav__item` and `.shell-userchip` (both on `--sunken`), the
active-nav-item hover state, and the one supporting token.

Out of scope: global `--surface-2` retuning; `--surface-2` hovers that rest on white surfaces
(menus, command bar, buttons); any markup/component refactor; editing `design/kit/` (immutable).
Also explicitly **not** changed (pre-existing, unrelated to the contrast complaint): the active
nav item's focus-ring behavior (unchanged — the new `--on:hover` rule is ordered before
`:focus-visible`, which keeps winning), and the user chip's lack of an
`[aria-expanded]`/menu-open persistent state. The `--sunken` status bar has no hovering children,
so the token's "items on `--sunken`" scope is satisfied by the sidebar alone today.

## Verification

`pnpm lint`, `pnpm typecheck`, `pnpm test` (incl. `shell-css.test.ts`), and the existing shell
e2e where it exercises sidebar nav. Plus the U3 light+dark screenshot check.
