## Interleave design system — how to build with it

Interleave is a desktop-first, local-first incremental-reading workspace: dense, calm,
keyboard-first. Components are real React, exposed on `window.Interleave.*`. Build with
them and style your own layout glue with the tokens below.

### Setup & theming
- **No global provider** — render components directly. Theme is driven by a
  `data-theme` attribute on any ancestor: `data-theme="light"` or `data-theme="dark"`.
  Every token re-themes automatically — **do not** write `dark:` variants or hard-code
  hex colors; use the tokens and theming is free.
- **`Btn` and `Segmented` are scoped components**: their `.btn`/`.segmented` styles only
  apply inside a help/onboarding root. Wrap them in `<div className="welcome">…</div>`
  (or `.hc`, `.coach`, `.tour-rail`). Without that wrapper they render unstyled. Every
  other component styles itself anywhere.

### Styling idiom — tokens first, then the token-mapped utilities
The brand is CSS variables (defined in the bound `_ds/.../styles.css` closure). Style with
`var(--token)` directly, or with the Tailwind utilities that map to them. Real names:

- **Fonts**: `var(--font-ui)` IBM Plex Sans (UI, the default), `var(--font-read)` IBM Plex
  Serif (reading/quotes — utility `font-read`), `var(--font-mono)` IBM Plex Mono (keys/code
  — utility `font-mono`).
- **Surfaces** `--canvas --surface --surface-2 --sunken --raised` → utilities `bg-surface`,
  `bg-surface-2`, `bg-accent-soft`.
- **Text** `--text --text-2 --text-3` (primary→muted) → `text-text`, `text-text-2`,
  `text-text-3`; on accent → `text-text-on-accent` / `text-accent-text`.
- **Borders** `--border --border-strong` → `border-border`, `border-border-strong`.
- **Accent** `--accent --accent-hover --accent-soft` → `bg-accent`; for accent-colored
  text use `var(--accent)` inline (no `text-accent` utility is compiled).
- **Status** `--ok --warn --danger` → `bg-danger` and `text-ok` `text-warn` `text-danger`
  are compiled; for ok/warn backgrounds use `var(--ok)` / `var(--warn)` inline.
- **Domain tokens** (use as `var(--*)`): element-type colors `--el-source --el-topic
  --el-extract --el-card --el-task --el-concept --el-synthesis`; priority `--prio-a --prio-b
  --prio-c`; the two schedulers `--sched-fsrs` (cards) and `--sched-attn` (everything else).
- **Scale** (compact, pro-tool): spacing `gap-2 px-3 py-2` (4px base, `--s-1`…`--s-12`);
  radii `rounded-md` `rounded-lg` (`--r-xs`…`--r-full`); type `text-2xs text-xs text-sm
  text-base text-xl` (`--t-*`, base ≈ 13.5px; for the `--t-md`/`--t-lg` steps use
  `var(--t-md)` / `var(--t-lg)` inline — no `text-md`/`text-lg` utility is compiled).

The available utilities are exactly those the app uses; for anything not covered, use
`var(--token)` inline. The authoritative source is the bound `styles.css` and its imports —
read it before styling. Each component also ships a `.prompt.md` (usage) and `.d.ts` (props).

### The load-bearing distinction: FSRS vs attention
Interleave schedules two ways, and the UI must keep them visibly distinct. **Active-recall
cards** use spaced repetition (FSRS) — show `SchedulerChip`/`FsrsStats` (brain icon,
`--sched-fsrs`). **Sources, topics, extracts, tasks, synthesis** use the attention
scheduler — `SchedulerChip` attention variant (gauge icon, `--sched-attn`). Never style a
card like a source. Element type is also color-coded via `--el-*` (`TypeIcon`).

### Idiomatic snippet
```tsx
// An inspector-style metadata panel, composed of real Interleave components.
<div style={{ width: 280, padding: "var(--s-6)", background: "var(--surface)",
              border: "1px solid var(--border)", borderRadius: "var(--r-lg)",
              fontFamily: "var(--font-ui)" }}>
  <MetaRow k="Type"><TypeIcon type="extract" /></MetaRow>
  <MetaRow k="Priority"><Prio priority={0.92} /></MetaRow>
  <MetaRow k="Status"><Status status="active" /></MetaRow>
  <MetaRow k="Schedule"><SchedulerChip scheduler={{ kind: "attention", stage:
    "clean_extract", postponed: 1, retrievability: null, stability: null,
    difficulty: null, reps: null, lapses: null, fsrsState: null,
    lastProcessedAt: null, scheduleReason: null }} /></MetaRow>
</div>
```
