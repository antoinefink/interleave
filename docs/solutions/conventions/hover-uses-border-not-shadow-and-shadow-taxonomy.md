---
title: "Hover states use border-color, not box-shadow: the app's shadow taxonomy"
date: "2026-06-15"
category: "docs/solutions/conventions/"
module: "apps/web screen CSS (queue, home, help, review) and per-screen *-css.test.ts"
problem_type: "convention"
component: "frontend_stimulus"
severity: "low"
applies_when:
  - "Adding or changing a :hover state on an interactive row, tile, card, or button in apps/web"
  - "Deciding whether a box-shadow on a surface is decorative noise or structural depth"
  - "A reviewer flags a `box-shadow: none` on an --active/--on rule as dead code"
  - "Writing a per-screen *-css.test.ts to pin a styling invariant against regression"
tags:
  - "box-shadow"
  - "hover-state"
  - "shadow-taxonomy"
  - "css-convention"
  - "regression-test"
  - "border-color"
  - "design-tokens"
related_components:
  - "apps/web/src/pages/queue/queue.css"
  - "apps/web/src/pages/home/home.css"
  - "apps/web/src/review/review.css"
  - "apps/web/src/pages/queue/queue-css.test.ts"
---

# Hover states use border-color, not box-shadow: the app's shadow taxonomy

## Context

Hovering a row on the queue and home pages raised it with a drop shadow
(`box-shadow: var(--shadow-sm)`), which read as visual noise — every row
"popped" off the page on mouseover. The ask was to remove that hover-elevation
there and, more broadly, wherever the same idiom appears — **without** stripping
every shadow from the app. Resolving "which shadows are noise vs. meaningful"
cleanly requires naming the three distinct roles `box-shadow` plays here.

## Guidance

`design/tokens.css` defines four shadow tokens (`--shadow-sm/md/lg/pop`), each
with light- and dark-theme values. They serve **three roles** — and only the
first should be removed:

**Role 1 — Hover-elevation on interactive rows/tiles/cards/buttons → REMOVE.**
A drop shadow on `:hover` communicates nothing the element doesn't already
signal. The hover affordance is a **border-color escalation** to
`var(--border-strong)` (or a per-variant semantic border). Never add
`box-shadow` to a `:hover` rule on an in-flow interactive element.

```css
/* OLD — do not reintroduce */
.qitem:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm); /* noise */
}

/* NEW — border emphasis is the whole hover cue */
.qitem:hover {
  border-color: var(--border-strong);
}
```

Review grade buttons are the variant of this idea: rather than a generic
`.grade:hover` shadow/lift, each grade's border shifts to its own semantic
colour on hover (`.grade--again:hover` → `--danger`, `--hard` → `--warn`,
`--good` → `--accent`, `--easy` → `--ok`). There is intentionally **no**
generic `.grade:hover`.

**Role 2 — Selected / active-state elevation on segmented controls & nav → KEEP.**
A `--on` / `--active` / `[data-active]` variant uses a subtle `var(--shadow-sm)`
to lift the *chosen* item — this communicates selection, not hover, and stays.
Live examples: `.shell-nav__item--on` and `.shell-usermenu__theme-option--on`
(shell.css), `.lib-mode__btn--on` / `.lib-seg__btn--on` (library.css),
`.wk-seg button[data-active="true"]` (weekly-review.css), `.seg--on`
(onboarding.css). Focus-ring composites (`box-shadow: var(--shadow-sm),
var(--focus-ring)`) are an accessibility affordance and also stay.

**Role 3 — Floating-overlay depth → KEEP.** Surfaces that genuinely float above
content use `--shadow-lg/md/pop`: context menus (context-menu.css), tooltips
(tooltip.css), schedule/done-intent/lineage menus, and the reader floating
toolbars (`SourceReader.tsx` inline `boxShadow: var(--shadow-lg)`). Depth is
meaningful here.

The litmus test: **does this surface float above content?** If yes (menu,
tooltip, popover, toolbar) → keep the shadow. If it sits in flow (row, tile,
card, button) → the shadow is noise; use border affordance only.

## Why This Matters

- A flat hover keeps long lists calm and aligns with two already-documented
  conventions: border-color is the single hover/selection cue on flat list rows
  (see [[inbox-row-cursor-selection-single-border]]), and structural shadow is a
  deliberate, machine-pinned signal on elevated surfaces (see
  [[three-zone-scroll-owned-review-card-surface]], where `.pq-card` is pinned
  flat and `.pq-rc` deliberately carries `--shadow-md`).
- **The trap:** once the hover shadow is gone, a `box-shadow: none` on a
  selected/active rule *looks* like dead code — "nothing adds a shadow, so why
  negate it?" It is **not** dead code. It is a deliberate flatness guard that
  documents intent and is **pinned by a contract test**.
  `apps/web/src/pages/queue/queue-css.test.ts` asserts `.qitem--active` contains
  `box-shadow: none;`. Removing it breaks that test and erases the guard, with
  no immediate visual change to warn you. A code reviewer flagged exactly this
  during the change; the suggestion was rejected for these reasons.

## When to Apply

- Adding/changing `:hover` on a row, tile, card, or button → border-color (or a
  per-variant semantic border), never `box-shadow`.
- A reviewer flags `box-shadow: none` on an `--active`/`--on`/selected rule as
  dead code → keep it; it is a test-pinned flatness guard. Point them here.
- Deciding whether a new surface should carry a shadow → apply the floats-above-
  content litmus test above.

## Examples

The repo machine-verifies these styling invariants with a per-screen
`apps/web/src/**/<screen>-css.test.ts`. The helper reads the raw CSS file and
extracts a selector's block; assertions pin both the required affordance and the
absence of a shadow:

```ts
function cssBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`).exec(css);
  const body = match?.groups?.body;
  if (!body) throw new Error(`Missing CSS block for ${selector}`);
  return body;
}

it("keeps the hovered queue row flat (border emphasis, no drop shadow)", () => {
  const hover = cssBlock(".qitem:hover");
  expect(hover).toContain("border-color: var(--border-strong);");
  expect(hover).not.toMatch(/\bbox-shadow\s*:/); // no shadow allowed on hover
});

it("keeps the selected queue row restrained instead of accent-outlined", () => {
  const active = cssBlock(".qitem--active");
  expect(active).toContain("box-shadow: none;"); // flatness guard must be present
});
```

When flattening a hover rule on a new screen, add (or extend) that screen's
`*-css.test.ts` with the same `.not.toMatch(/\bbox-shadow\s*:/)` assertion. This
change extended the pattern to `.qitem:hover` (queue), `.home-prow:hover` /
`.home-tile:hover` (new `home-css.test.ts`), `.hc-cat:hover` (help), and the
grade buttons (review) — converting "no hover shadows" from intent into a
guarded contract.

## Related

- [[inbox-row-cursor-selection-single-border]] — border-color as the single
  list-row hover/selection cue (ring/shadow doubling avoided); cites
  `.qitem--active` as the reference treatment.
- [[three-zone-scroll-owned-review-card-surface]] — structural shadow on the
  review card is deliberate; `.pq-card` is pinned flat by a contract test. This
  doc owns the fuller shadow-taxonomy treatment that one references in passing.
- [[scope-ported-design-kit-css-under-page-root]] — per-screen CSS is appended
  globally by Vite, which is why per-screen `*-css.test.ts` guards (and scoping)
  matter.
- [[renderer-button-cursor-baseline]] — the per-screen CSS-contract test
  discipline this follows.
