# Design — visual source of truth

This directory holds the **design system for Interleave**, handed off from Claude Design and
adapted to our product spec. It is the **visual source of truth**: when an agent builds a
UI-bearing roadmap task, the result must match this design.

## Contents

| Path | What it is |
|------|------------|
| `tokens.css` | **Canonical design tokens** (lifted, durable). Colors, type scale, spacing, radii, layout dims, motion, light + dark. This file is consumed by the real app. |
| `icon-map.md` | Prototype icon name → [`lucide-react`](https://lucide.dev) mapping (our chosen icon library). |
| `kit/` | The **vendored prototype**, verbatim — read-only reference. Recreate its *visual output*, not its internal structure. |
| `kit/HANDOFF-README.md` | The original Claude Design handoff instructions. |
| `kit/design-chat-transcript.md` | The full design conversation — where the intent lives. |
| `kit/Incremental Reading.html` | The primary prototype entry point (open this first). |
| `kit/Incremental Reading - Design System.html` | The design-system showcase page. |
| `kit/styles/{tokens,app}.css` | Prototype CSS (`tokens.css` is mirrored at `design/tokens.css`). |
| `kit/app/*.jsx`, `icons.js`, `data.js` | Prototype React screens + shared components + mock data + hand-rolled icon set. |
| `kit/screenshots/*.png` | Rendered reference screenshots for fidelity checks. |

> The prototype is plain React-18-via-Babel-in-the-browser. **Do not ship it.** Our app is
> React 19 + Vite + Tailwind v4 + TanStack Router (see [`../docs/architecture.md`](../docs/architecture.md)).
> Match the pixels; rebuild the structure to fit our stack and layering rules.

## How to use it when building a task

1. Read [`../docs/design-system.md`](../docs/design-system.md) — the authoritative summary
   (tokens, component inventory, screen→milestone map, the FSRS/attention split).
2. Import `tokens.css` globally; derive the Tailwind v4 theme from these variables (don't
   re-invent values).
3. For the specific screen, open the matching `kit/app/screen-*.jsx` and screenshot to see
   intended layout/behavior, then rebuild it in our components.
4. Use `lucide-react` for icons via `icon-map.md`.

## Why this is here, not in `packages/ui` yet

`packages/ui` doesn't exist until the monorepo is scaffolded (roadmap **T001**). Keeping the
kit here means it's available to every agent from day one. **T002/T003** copy `tokens.css`
into the app and wire Tailwind; the component library is rebuilt incrementally as each screen
milestone lands. `kit/` stays as the immutable reference even after the real UI exists.

## Provenance

- Round 1 handoff → feedback in [`../docs/design/feedback-round-1.md`](../docs/design/feedback-round-1.md).
- Round 2 (this kit) resolved that feedback: cards are now **FSRS** (stability/difficulty/
  retrievability), the **two schedulers** are visually split (`SchedulerChip`), the full
  type/status/stage **vocabulary** is present, **lineage is navigable** (`LineageTree`), and
  it adds the distillation **`Pipeline`**, **`BudgetMeter`**, undo **`Snackbar`**, **`CheatSheet`**,
  and **trash / synthesis / task / settings** screens.
</content>
