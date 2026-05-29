# Design system

Interleave's visual language. The canonical assets live in [`../design/`](../design/); this
doc is the authoritative summary an agent reads before building any UI task. The design is
the **visual source of truth** — UI-bearing tasks must match it.

- Tokens: [`../design/tokens.css`](../design/tokens.css)
- Icons: [`../design/icon-map.md`](../design/icon-map.md) (we use `lucide-react`)
- Prototype reference (read-only): [`../design/kit/`](../design/kit/) — open
  `Incremental Reading.html`, the `screen-*.jsx`, and `screenshots/`.

## Foundations (from `tokens.css`)

- **Type:** IBM Plex superfamily — `--font-ui` (Plex Sans), `--font-read` (Plex Serif, used
  for reading/extract/card faces), `--font-mono` (Plex Mono, for metadata/intervals/kbd).
  Compact pro-tool scale `--t-2xs … --t-3xl` (base 13.5px).
- **Color:** OKLCH cool-neutral palette, blue accent, **light + dark** via
  `[data-theme="dark"]`. Surfaces (`--canvas/surface/surface-2/sunken/raised`), borders,
  three text tiers (`--text/-2/-3`).
- **Domain color tokens** (this is what makes it ours):
  - Priority: `--prio-a/-b/-c/-d` (+ `-soft`). A=red-ish, B=amber, C=blue, D=neutral.
  - Element-type hues: `--el-source` (blue), `--el-extract` (violet), `--el-card` (green),
    `--el-task` (orange), `--el-concept` (cyan), `--el-media` (magenta), `--el-topic`
    (indigo), `--el-synthesis` (green-2).
  - **Scheduler accents:** `--sched-fsrs` (green) vs `--sched-attn` (indigo) — the visible
    split between the two schedulers.
  - Reading marks: `--mark-hl` (highlight), `--mark-extract` / `--mark-extract-bd`
    (extracted span).
- **Spacing** 4px base (`--s-1…--s-12`), **radii** `--r-xs…--r-full`, **layout dims**
  `--sidebar-w: 212px`, `--inspector-w: 296px`, `--topbar-h: 52px`, **motion** `--ease`,
  `--fast 110ms`, `--med 200ms`, shadows, and `--focus-ring`.

### Wiring into the app (Tailwind v4)
Import `tokens.css` once globally. Derive the Tailwind v4 theme **from** these variables
(map `--accent`, `--surface`, the type scale, spacing, radii into `@theme`) rather than
re-declaring values. Components reference tokens (`var(--…)` or Tailwind utilities bound to
them), never hard-coded hex/px. Dark mode is the `data-theme` attribute, not Tailwind's
`dark:` class strategy by default.

## App shell

Matches our charter: **left sidebar** (`--sidebar-w`) · **top command bar** (`--topbar-h`,
⌘K) · **main work area** · **right inspector** (`--inspector-w`) · plus a sidebar foot
(streak + user/vault chip). Keyboard-first: `⌘K` command palette, `g`+letter navigation,
`?` cheat sheet. See `kit/app/shell.jsx` and `kit/app/main.jsx`.

## Component inventory → domain

From `kit/app/components.jsx` (+ `app.css`). Rebuild these as `packages/ui` primitives:

| Component | Role | Maps to |
|-----------|------|---------|
| `TypeIcon` | element-type chip (8 types) | `ElementType` |
| `Prio` | A/B/C/D badge or dot | priority model |
| `Status` | due/overdue/done/**suspended/dismissed/trashed**/new/leech | `ElementStatus` |
| `Stage` | stage badge (Inbox→Topic→Reading→Raw→Clean→Atomic→Card draft→Active→Mature→Synthesis) | `DistillationStage` |
| `SchedulerChip` | **the FSRS vs attention split** — brain+`recall%`+`S{n}d` vs gauge+stage+`postponed×N` | two schedulers |
| `Retr` / `FsrsStats` | retrievability dial; Stability/Difficulty/Retrievability readout | FSRS card state |
| `Pipeline` | distillation stepper (Source→Extract→Clean→Atomic→Card→Mature) | the product north star |
| `LineageTree` | navigable source→extract→sub-extract→card tree | source lineage |
| `BudgetMeter` | daily budget used/target + over-budget | overload mgmt |
| `Banner` | info/warn/danger inline notices | overload + balance warnings |
| `Snackbar` | undo toast | soft-delete / undo |
| `CheatSheet` | `?` keyboard reference | keyboard-first |
| `ConceptTag` / `Tag` | concept pill / flat tag | concepts & tags |
| `MetaRow` | inspector key/value row | element inspector |
| `Btn` / `Segmented` / `Toggle` / `Menu` / `Kbd` / `Metric` / `Spark` / `EmptyState` / `NextAction` | generic primitives | — |

Notable CSS-only patterns (`app.css`): `qitem` (queue row, with `--protected` accent bar),
`refblock` (source reference), `sel-toolbar` (floating selection toolbar), reading marks
(`mark.hl`, `mark.extracted`, `.dimmed`, `.readpoint`), `rcard` + `grades` (review card +
Again/Hard/Good/Easy with interval previews), `qc` (card-quality checks), `split3` (builder),
`filterbar`/`result` (library), `graph`/`gnode` (concept map), `tree` (lineage), `cardprev`.

## The two schedulers (load-bearing invariant)

Every queue/inspector surface must signal *which scheduler an element is on*. The kit encodes
it on the data (`scheduler: 'fsrs' | 'attention'`) and renders `SchedulerChip` accordingly:

- **Cards → FSRS** (memory): `brain` icon, `--sched-fsrs` accent, shows **retrievability %**,
  **stability (days)**, **difficulty**, next-interval previews.
- **Sources / topics / extracts / tasks / synthesis → attention**: `gauge` icon,
  `--sched-attn` accent, shows **stage**, **priority**, **last processed**, **postponed ×N**,
  **stagnant?**, and **yield** (N extracts / M cards).

See [`scheduling-and-priority.md`](./scheduling-and-priority.md) for the rules behind this.

## Screens → routes → roadmap milestones

The kit's screens map onto our routes and the build queue. When you build a milestone, the
matching `screen-*.jsx` + screenshot is the spec for layout/interaction.

| Kit screen | Route | Roadmap |
|------------|-------|---------|
| `screen-queue` (+ `BudgetMeter`, overload `Banner`) | `/queue` | M5 (T029–T031), overload in M16 |
| `screen-inbox` (import previews, dup flag, triage) | `/inbox` | M2 (T012–T014), M9 balance (T046) |
| `screen-reader` (read-point, marks, `sel-toolbar`) | `/source/$id` | M3–M4 (T015–T026) |
| `screen-builder` (extract→card, `qc`, `cardprev`, `Pipeline`) | (builder) | M6 (T032–T035) |
| `screen-review` (`rcard`, `FsrsStats`, `grades`, jump-to-source) | `/review` | M7 (T036–T040) |
| `screen-library` (`filterbar`, results; `concepts` map tab) | `/search`, library, concepts | M8 (T041–T043) |
| `screen-analytics` (forecast, history, yield) | analytics | M9 (T045–T046), M17 |
| `screen-settings` (budget, retention, intervals, theme, backup) | `/settings` | M1 T011 + M9 T047 |
| `screen-extra` → Trash / Synthesis / Task | trash, synthesis, task | trash M9 (T044); synthesis/tasks gold-standard (T092, T095) |

The inspector (`MetaRow`-based) adapts per element type and always surfaces lineage + the
correct scheduler signals (built incrementally; baseline in M1 T010).

## Fidelity expectations

- UI tasks reproduce the kit's **visual output** pixel-for-pixel; they do **not** copy the
  prototype's Babel-in-browser structure (we use React 19 + Vite + TS + Tailwind v4 +
  TanStack Router, with domain logic kept out of components per the layering rules).
- Values come from `tokens.css`; icons from `lucide-react` via `icon-map.md`.
- Light **and** dark must both look correct.
- `kit/` is immutable reference — never edit it to "fix" the app; fix the app.
</content>
