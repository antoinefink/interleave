---
title: "Theme-adaptive hover fill on --sunken surfaces via color-mix(var(--text))"
date: 2026-06-22
category: docs/solutions/design-patterns
module: apps/web app shell sidebar (shell.css, design/tokens.css, shell-css.test.ts)
problem_type: design_pattern
component: frontend_stimulus
severity: medium
applies_when:
  - "Adding a :hover fill to an interactive item that rests on a recessed surface (--sunken) rather than on --canvas/--surface"
  - "A fixed surface token (e.g. --surface-2) hover is imperceptible in one theme or out-lightens the active card in the other"
  - "You want one hover declaration to self-correct across light and dark without a per-theme override"
  - "A :hover rule on an interactive item overrides its own --on/--active rule and muddies the selected state"
  - "Choosing how an active/selected item should respond to hover without escalating box-shadow"
tags: [color-mix, oklch, hover-state, design-tokens, dark-mode, sunken-surface, specificity, app-shell, regression-test]
related_components:
  - "apps/web/src/shell/shell.css"
  - "design/tokens.css"
  - "apps/web/src/shell/shell-css.test.ts"
---

# Theme-adaptive hover fill on `--sunken` surfaces via `color-mix(var(--text))`

## Context

The app-shell sidebar (`.shell-sidebar`) is painted with `--sunken` — a surface
*below* the canvas. Its interactive items (`.shell-nav__item`, `.shell-userchip`)
took their `:hover` fill from `--surface-2`, the neutral fill that works well on
white `--canvas`/`--surface`. On `--sunken` it has two failure modes:

- **Light-mode imperceptibility.** `--surface-2` (`oklch(0.972 …)`) sits only
  ~0.007 L above `--sunken` (`oklch(0.965 …)`) — below the just-noticeable
  threshold. Hovering a nav item produced no visible change.
- **Dark-mode hierarchy inversion.** Any *fixed* hover value chosen bright enough
  to read in dark mode (the old `--surface-2` at `0.234`, or a naive hardcode like
  `0.255`) lands at or above the active card `--surface` (`0.214`). An inactive
  hovered item then looks *brighter* than the active "you-are-here" item.

A second, independent bug: `.shell-nav__item:hover` (specificity 0,2,0) overrode
`.shell-nav__item--on` (0,1,0), so hovering the **active** item swapped its crisp
white card for the grey hover fill — the muddying the user actually reported.

## Guidance

**Use a `--text` overlay, not a fixed surface token, for hover fills on recessed
surfaces.** Declare it once, referencing the already-theme-aware `--text`:

```css
/* design/tokens.css — base :root, theme-agnostic by construction */
/* Resolves lazily against the active theme's --text (light value, overridden
   under [data-theme="dark"]), so one declaration serves both themes. */
--sidebar-hover: color-mix(in oklch, var(--text) 6%, transparent);
```

Apply it in place of `--surface-2`:

```css
/* before */
.shell-nav__item:hover { background: var(--surface-2); color: var(--text); }
/* after */
.shell-nav__item:hover { background: var(--sidebar-hover); color: var(--text); }
```

Fix the active-item muddying with a **source-ordered** rule of equal specificity,
placed *after* `:hover` and *before* `:focus-visible`:

```css
.shell-nav__item:hover        { background: var(--sidebar-hover); }  /* 0,2,0 */
.shell-nav__item--on          { background: var(--surface); box-shadow: var(--shadow-sm); } /* 0,1,0 */
.shell-nav__item--on:hover    { background: var(--surface); }        /* 0,2,0 — wins by source order */
.shell-nav__item:focus-visible{ box-shadow: var(--focus-ring); }     /* later → focus ring still wins */
```

Do **not** escalate `box-shadow` on the active hover. The `--shadow-sm` on `--on`
is an intentional *selection lift*, not a hover cue — escalating it on hover
violates
[hover-uses-border-not-shadow-and-shadow-taxonomy](../conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md).
Pin the background alone.

Guard the invariants with CSS-string assertions in the per-screen `*-css.test.ts`:

```ts
expect(tokensCss).toMatch(/--sidebar-hover:\s*color-mix\(in oklch, var\(--text\)[^;]*\);/);
expect(cssBlock(".shell-nav__item:hover")).toContain("var(--sidebar-hover)");
expect(cssBlock(".shell-nav__item:hover")).not.toContain("--surface-2");
expect(cssBlock(".shell-nav__item--on:hover")).toContain("var(--surface)");
expect(cssBlock(".shell-nav__item--on:hover")).not.toMatch(/\bbox-shadow\s*:/);
```

## Why This Matters

`color-mix(in oklch, var(--text) N%, transparent)` is *perceptually relative to
the current text color*. In light mode `--text` is dark (`oklch(0.27 …)`), so the
overlay darkens the sidebar a clear ~0.04 L — the "press into the recess" feel. In
dark mode `--text` is near-white (`oklch(0.93 …)`), so it *lightens* `--sunken`
toward ~0.20 — perceptible, yet still below the active card (`--surface` 0.214), so
the hierarchy never inverts. One declaration, zero theme-specific overrides, and
the dark-mode inversion that any fixed value risks is structurally impossible.

`--surface-2` fails here because it is an *absolute* lightness picked for
content-area surfaces; it was never meant to be layered over `--sunken`.

## When to Apply

- The interactive element rests on a surface that differs from the main canvas —
  especially a recessed/`--sunken` one.
- A fixed surface token gives imperceptible contrast in one theme or hierarchy
  inversion in the other.
- One token must serve both themes without duplication.

Typical overlay strength: **5–8%** of `--text` for nav-scale items on a recessed
surface. Verify perceptibility by screenshot at *both* theme extremes — the value
that reads in light may be too strong (or the reverse) in dark, and the overlay
math is the thing that keeps them in balance.

**Do not** reach for this on `--raised` floating surfaces (command palette,
dropdown menus). They have enough lift that `--surface-2` reads correctly there and
remains the right choice — see the scope note in
[hover-uses-border-not-shadow-and-shadow-taxonomy](../conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md).

## Examples

The `--sunken` dark-mode washout that motivates the relative-overlay approach was
first documented for structural lines in
[process-toolbar-progress-divider-and-lifted-source-title](./process-toolbar-progress-divider-and-lifted-source-title.md)
("use `--border`, not `--sunken`, for tracks on the dark canvas"). This learning
extends the same dark-`--sunken` caution to *interactive fill states*: rather than
swap the base token, mix the theme-aware `--text` into the hover so the fill tracks
the canvas it sits on.

The active-vs-hover precedence (selection state must win over the generic hover
cue, resolved by specificity/source order rather than `!important`) mirrors
[inbox-row-cursor-selection-single-border](../ui-bugs/inbox-row-cursor-selection-single-border.md).
