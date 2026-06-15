---
title: "feat: Plan session full-width split layout"
type: feat
date: 2026-06-15
status: ready
depth: standard
origin: none (solo plan from a Claude Design handoff bundle)
design_handoff: "Interleave Home - Plan Session.html (split direction)"
---

# feat: Plan session full-width split layout

## Summary

Redesign the inline **Plan session** panel (`SessionAssemblyPreview`) from its current narrow,
vertically-stacked layout into the full-width two-pane **split** layout the user selected in the
Claude Design handoff. The left rail becomes the time-box chooser: preset cards (15 / 25 / 45 +
custom) each showing their consequence (`N items · X% full`), a live **budget meter** bar with
category-colored segments and a **distillation-floor** marker, and category chips. The right main
pane carries the `Plan N of M due items` summary, the planned-item list, and the `Left out`
section.

This is a **presentational restructure**. All data and behavior stay wired to the existing trusted
read model: `appApi.previewSessionPlan()` → `QueueSessionPlanResult`, the one-shot
`acceptSessionAssembly()` handoff, the StrictMode-safe `loadSeqRef` race guard, and the full
accessibility surface (aria-live status region, role=alert errors, focus management, labeled
controls). No scheduling, eligibility, pricing, or quota logic moves into the renderer.

---

## Problem Frame

The current panel (screenshot in the handoff) is a cramped single column: a row of small preset
buttons, a numeric input, a `Preview` button, then a stacked summary / list / cut block. It does
not use the horizontal room of its real slot (a full-width block in the Home and Queue content
columns, ~900px), and it reads as a generic form rather than a native part of the app.

The user mocked up three full-width directions in Claude Design and **explicitly chose "split"**
(chat2: *"Let's go with split"* → *"Can you please only keep the split layout"*). The split layout
turns the time box into a real chooser with live consequence feedback (the budget meter that fills
with category color as the box changes, with the distillation floor marked on the track) and gives
the assembled deck its own readable column.

**In scope:** the visual + structural redesign of `SessionAssemblyPreview`, its CSS, one new icon,
and the tests that cover it.

**Out of scope:** the planner/quota/estimate backend, the `/process` loop the accepted deck hands
off to, the surrounding Home/Queue chrome, and the narrow `Plan Session.html` variations (A/C) that
were discarded.

---

## Requirements

- **R1.** The panel renders as a full-width, flat (border-only, no shadow) card matching sibling
  panels, with a two-pane split: a fixed-width left rail and a flexible right main, collapsing to a
  single column below a narrow breakpoint.
- **R2.** The left rail shows four time-box cards — `15`, `25`, `45`, and a custom card with an
  inline numeric input — in a 2×2 grid. The active box is highlighted with the accent treatment.
- **R3.** Each preset card shows its consequence: `N items · X% full` for that box, computed from a
  real preview of that box (not faked from row counts). The custom card shows `custom box`.
- **R4.** A live budget meter bar shows category-colored segments (Distillation / Cards / Other)
  proportional to the box, a free-space remainder, and — when the distillation quota is active — a
  floor marker at the reserved-minutes position with a `floor N m` label. A header line shows
  `~N min planned` and `N min free` / `box full`.
- **R5.** Category chips list each non-zero category with its color dot, label, and minutes
  (`Distillation 6m`, `Cards 2m`, `Other work 20m`).
- **R6.** A floor note (`Distillation floor active — N min held.`) appears when the quota is active.
- **R7.** The right main pane shows `Plan N of M due items` + the total, the planned list
  (each row: type icon, ellipsized title, `~N min`), and — when present — a `Left out N items`
  section with its total and rows (each row: type icon, title, a `Didn't fit` tag).
- **R8.** Changing the box (clicking a preset or editing the custom input) re-plans the deck live.
  Selecting a preset whose value already has a fetched preview reuses it.
- **R9.** All existing behavior is preserved: the stale-response guard (`loadSeqRef`), the
  `canStart` gate (`planRequestKey === requestKey`), `acceptSessionAssembly` + navigate to
  `/process?assembled=1`, the invalid / loading / error / empty states, and `onClose`.
- **R10.** All existing accessibility is preserved or improved: `aria-labelledby`, the
  `role="status" aria-live="polite"` results region, `role="alert"` invalid/error regions, focus to
  the results region after each load, the `sr-only` preset legend, list `aria-label`s,
  `aria-pressed` on presets, and the labeled close button.
- **R11.** All load-bearing `data-testid`s are preserved (see Test Contract), and the canonical
  composition copy remains available to assistive tech and the test suite.
- **R12.** Copy uses the project's canonical vocabulary (Distillation, Cards, Source / Other work,
  Session assembly) and respects the learned/default minute-confidence labeling.

---

## Key Technical Decisions

### KTD-1 — Per-preset consequence meta via parallel previews (the main fork)

The design shows `N items · X% full` on each preset card. The prototype computes this synchronously
from a mock `planSession()`; the real planner is async (`previewSessionPlan` per box).

**Decision:** Add a small in-component hook that, whenever the panel is open and the request shape
(filters/mode/asOf) changes, fires `previewSessionPlan` for the three presets `[15, 25, 45]` in
parallel and stores the results in a `Map<minutes, QueueSessionPlanResult>` guarded by its own
monotonic sequence counter (mirroring `loadSeqRef`). Preset cards read their meta from this map;
until a preset resolves, the card shows its minutes with the meta omitted (graceful, no layout
shift reserved via min-height). When the active box equals a preset, the card meta and the main plan
agree because they query the same request.

**Why not drop the meta:** it is the signature element of the "split"/consequence-forward direction
the user chose; dropping it loses the fidelity that motivated the redesign. **Why not synchronous:**
the renderer must not recompute eligibility/quota (read-model rule,
`docs/solutions/architecture-patterns/session-assembly-read-model-accepted-deck-handoff.md`). The
cost is three local IPC previews per open/filter-change — cheap against local SQLite, and naturally
deduped by the request key.

### KTD-2 — Remove the explicit `Preview` button; re-plan live

The current panel has a manual `Preview` button, but it already auto-loads on `target` change via an
effect. The chosen design re-plans live with no Preview button. **Decision:** remove the `Preview`
button; keep the existing effect-driven auto-load (preset click / custom edit → `target` change →
`load()`), which already carries the stale-guard. No test asserts the Preview button. The custom
input keeps the existing per-change load (parity with current behavior); a debounce is explicitly
deferred (see Deferred) to avoid changing the stale-guard test contract.

### KTD-3 — Decompose the composition paragraph; keep its sentence for SR + tests

The new design replaces the single composition paragraph with structured UI (floor note + chips +
meter). But three unit tests assert `data-testid="session-composition"` with exact sentences
(e.g. `"Distillation floor active: 4 min reserved."`, `"Planned 6 min distillation, 2 min cards."`).

**Decision:** keep `sessionCompositionCopy(plan)` and render its full sentence in an **`sr-only`**
element carrying `data-testid="session-composition"` inside the live region. Sighted users get the
richer chips/meter/floor-note; screen-reader users get the canonical one-sentence summary (better
than narrating a bar chart); the test contract holds verbatim. This is a deliberate a11y win, not a
shim.

### KTD-4 — Meter / chips / floor sourced from `composition`, list color from `TypeIcon`

Budget-meter segments and chips come from the backend-trusted `composition.distillationMinutes`,
`composition.cardMinutes`, `composition.otherMinutes`; the floor marker from
`composition.quotaFloorMinutes` (rendered only when `composition.status === "active"`); free space
from `targetMinutes - plannedMinutes` (clamped ≥ 0); `% full` from `plannedMinutes / targetMinutes`.
Per-row item color stays with the existing `TypeIcon` (`tico--*` → `--el-*`) so each row keeps its
element-type cue and the FSRS-card-vs-attention-work distinction. Category colors:
Distillation → `--el-extract`, Cards → `--el-card`, Other → `--el-source`.

### KTD-5 — Add a `ban` icon for the "Didn't fit" tag

The design's left-out rows use a `ban` glyph, which does **not** exist in `Icon.tsx` or
`design/icon-map.md`. **Decision:** add `ban` → Lucide `Ban` to **both** `apps/web/src/components/Icon.tsx`
and `design/icon-map.md` in the same change (required by `design/AGENTS.md`: no raw Lucide import
without an icon-map entry). `Ban` is the exact semantic match for "excluded / didn't fit". The
left-out reason copy changes `Did not fit` → `Didn't fit` to match the design (per-row reason text
is not asserted by any test).

### KTD-6 — Namespace all new CSS under `.q-session-preview__*`; tokens only; hover = border

Replace the old `.q-session-preview__*` flat-layout rules with split-layout rules under the same
page-root namespace (no bare `.card`/`.chip`/`.meter` — `queue.css` is global,
`docs/solutions/design-patterns/scope-ported-design-kit-css-under-page-root.md`). All colors,
spacing, radii, and type come from `design/tokens.css` variables — no hard-coded values. Interactive
elements (preset cards, rows) use `border-color` for hover, never `box-shadow`
(`docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md`); the active
preset uses `--accent-soft` + inset accent ring (matching the prototype's `is-active`).

---

## High-Level Technical Design

### Layout structure (full-width split, collapses < 760px)

```text
.q-session-preview  (flat card: border, no shadow)
├─ __head     "Plan session" + subtitle ............................ [×] close
├─ __split  (grid: 300px | 1fr)
│  ├─ __rail  (border-right)
│  │   ├─ "TIME BOX" label
│  │   ├─ __cards (2×2 grid)         [15][25]   each: minutes + "N items · X% full"
│  │   │                             [45][custom▸input]
│  │   ├─ __meter   "~N min planned ........ N min free"
│  │   │            [▓distill▓cards▓other░░free]  ▲floor 5m
│  │   │            chips: ● Distillation 6m  ● Cards 2m  ● Other work 20m
│  │   └─ __floornote  "⌁ Distillation floor active — 5 min held."
│  └─ __main
│      ├─ __summary  "Plan 4 of 5 due items" ................... ~28 min
│      ├─ __list     [icon] title ........................... ~6 min   (×N)
│      └─ __leftout  "LEFT OUT 1 ITEM" .......................... ~10 min
│                    [icon] title ......................... (⊘ Didn't fit)
└─ __foot  (border-top)  ......................... [Cancel] [▶ Start planned deck]
```

The single-pane states (invalid / loading / error / empty) render in place of `__split`, keeping
the head and foot. The `__split` collapses to one column under `max-width: 760px` (rail gains a
bottom border instead of a right border).

### Data mapping (trusted read model → UI)

| UI element | Source field(s) on `QueueSessionPlanResult` / `composition` |
| --- | --- |
| Preset card `N items · X% full` | per-preset preview: `plannedCount`, `plannedMinutes / targetMinutes` |
| Active-preset highlight | `target === presetMinutes` |
| Meter header `~N min planned` / `free` | `plannedMinutes`; `targetMinutes - plannedMinutes` |
| Meter segments (distill/cards/other) | `composition.distillationMinutes / cardMinutes / otherMinutes` ÷ `targetMinutes` |
| Floor marker + `floor N m` | `composition.quotaFloorMinutes` ÷ `targetMinutes` (only when `status === "active"`) |
| Chips | same three composition minute buckets, `> 0` only |
| Floor note | `composition.status === "active"` → `quotaFloorMinutes` |
| `sr-only` composition sentence (testid) | `sessionCompositionCopy(plan)` (unchanged) |
| Summary `Plan N of M` + total | `plannedCount`, `candidateCount`, `plannedMinutes` |
| Planned rows | `items[]` → `TypeIcon type`, `item.title`, `sessionMinuteLabel(estimatedMinutes, estimateConfidence==="default")` |
| Left-out header + rows | `cut.totalCount`, `cut.totalMinutes`, `cut.items[]` (reason `did_not_fit` → `Didn't fit`) |

### Data flow for preset meta (KTD-1)

```text
open / request(filters,mode,asOf) changes
   └─ presetSeqRef++ ; for box in [15,25,45]:
         previewSessionPlan({...request, targetMinutes: box})
            └─ on resolve, if presetSeqRef unchanged → presetMap.set(box, result)
   (active box still loads through the existing single `load()` + loadSeqRef path)
```

---

## Implementation Units

### U1. Add the `ban` icon

**Goal:** Make the Lucide `Ban` glyph available by its semantic name so the left-out "Didn't fit"
tag can use it without violating the design icon rules.

**Requirements:** R7, KTD-5.

**Dependencies:** none.

**Files:**
- `apps/web/src/components/Icon.tsx` — import `Ban` from `lucide-react`; add `ban: Ban` to the
  `ICONS` map (keep alphabetical-ish placement consistent with neighbors).
- `design/icon-map.md` — add a `` `ban` `` → `` `Ban` `` row following the existing two-pair table
  format.

**Approach:** Mirror the existing `flame` / `trim` entries exactly. No other change.

**Patterns to follow:** existing entries in `Icon.tsx` `ICONS` and the `prototype | lucide-react`
table in `design/icon-map.md`.

**Test scenarios:**
- Rendering `<Icon name="ban" />` produces an SVG (not the `FileText` fallback). Add/extend the
  Icon unit test if one exists; otherwise assert via the SessionAssemblyPreview test that the
  left-out tag contains an svg. *(Covers the icon-map compliance requirement.)*

**Verification:** `<Icon name="ban" />` renders the Ban glyph; `design/icon-map.md` lists it; lint
passes (no unused import).

### U2. Preset-outcome data hook

**Goal:** Provide each preset card with a real `N items · X% full` consequence, fetched async and
guarded against stale responses, without moving any planner logic into the renderer.

**Requirements:** R3, R8, R9, KTD-1.

**Dependencies:** none (used by U3).

**Files:**
- `apps/web/src/pages/queue/SessionAssemblyPreview.tsx` — add a `usePresetOutcomes` hook (or inline
  effect + ref) co-located in the component file: a `presetMapRef`/state keyed by preset minutes, a
  `presetSeqRef` counter, and an effect that re-fetches the three presets when `open` and the
  request key (request shape minus target) change. Export a small `{ items, pct }` accessor per box.

**Approach:** Build a `baseRequestKey` from the request shape excluding `targetMinutes` (so editing
the custom box does not refire preset fetches). On `open` / `baseRequestKey` change, bump
`presetSeqRef`, clear the map, fire `previewSessionPlan` for each preset in parallel; on each
resolve, drop the result if `presetSeqRef` moved. Compute `pct = clamp(round(plannedMinutes /
targetMinutes * 100), 0, 100)`. Keep this strictly read-only.

**Patterns to follow:** the existing `loadSeqRef` guard in the same file
(`docs/solutions/architecture-patterns/session-assembly-read-model-accepted-deck-handoff.md`).
**Do not** introduce a `mountedRef` cleared-only-on-cleanup
(`docs/solutions/ui-bugs/strictmode-mountedref-cleared-only-on-cleanup.md`).

**Test scenarios:**
- Happy path: open with a mocked `previewSessionPlan` returning distinct results per `targetMinutes`
  → each preset card shows the matching `N items · X% full`.
- Stale guard: change the request shape mid-flight → late preset responses for the old request are
  discarded (no cross-contamination of card meta).
- Edge: a preset that has not yet resolved renders minutes with the meta omitted and no layout
  shift; custom-box edits do **not** refire preset fetches (assert call count for preset boxes is
  stable across custom edits).

**Verification:** preset cards display real per-box consequences; editing the custom box re-plans
the main deck but does not refetch presets; no StrictMode double-mount regression.

### U3. Rebuild `SessionAssemblyPreview` markup to the split layout

**Goal:** Replace the stacked JSX with the two-pane split structure, preserving all data, behavior,
test hooks, and accessibility.

**Requirements:** R1–R12, KTD-2, KTD-3, KTD-4, KTD-5.

**Dependencies:** U1 (ban icon), U2 (preset outcomes).

**Files:**
- `apps/web/src/pages/queue/SessionAssemblyPreview.tsx` — rebuild the returned markup: `__head`
  (title + new subtitle + close), `__split` → `__rail` (`Time box` label, `__cards` 2×2 with
  `__card`/`__card--custom`/`is-active`, `__meter` with `__bar`/`__seg`/`__free`/`__floor`,
  `__chips`, `__floornote`) and `__main` (`__summary` + total, `__list` planned rows, `__leftout`).
  Footer `__foot` (Cancel + Start). Render the invalid/loading/error/empty states in place of
  `__split`. Keep `sessionCompositionCopy` and render it `sr-only` with
  `data-testid="session-composition"`. Remove the `Preview` button.

**Approach:**
- Preserve verbatim: `load`/`loadSeqRef`/`requestKey`/`planRequestKey`, the `canStart` gate, the
  Start handler (`acceptSessionAssembly` + `navigate`), `onClose`, the `target` state and input.
- Map `Icon`/`TypeIcon` names: `x` (close), `play` (Start), `flame` (floor note), `ban` (left-out
  tag). Drop the `review` Preview icon usage.
- Keep `sessionMinuteLabel` for all minute displays (honors learned/default confidence).
- Compute meter widths inline as `%` strings from `composition`; guard divide-by-zero when
  `targetMinutes === 0`.
- Keep `data-testid`s: `session-preview`, `session-target-minutes`, `session-preview-start`,
  `session-composition`, `session-planned-minutes`, `session-planned-row-minutes`,
  `session-cut-list`, `session-cut-count` (plus keep `session-preview-error`).

**Technical design (directional):** segment style `style={{ width: pctOf(composition.cardMinutes) }}`
where `pctOf = (m) => (target > 0 ? (m / target) * 100 : 0) + "%"`; floor marker
`style={{ left: pctOf(composition.quotaFloorMinutes) }}`.

**Patterns to follow:** existing component structure; `TypeIcon` for rows;
`docs/solutions/architecture-patterns/queue-time-cost-read-model.md` for confidence labeling and
accessible "about N minutes" wording.

**Test scenarios:**
- Happy path: open → renders split with preset cards, meter segments, chips, floor note, summary,
  planned list, and (when cut non-empty) left-out section.
- Stale guard (existing contract): typing a new box keeps `session-preview-start` disabled until the
  matching plan loads; the old plan's rows are not shown; `session-composition` shows the new copy;
  Start enabled → `navigate({ to:"/process", search:{ assembled:1 } })`.
- Composition variants (existing copy, now `sr-only`): active / returned-empty / filtered-out /
  unavailable all produce the correct `session-composition` text (or its absence when unavailable).
- Edge: `targetMinutes === 0` / empty plan → empty state, no NaN widths, Start disabled.
- Error path: `previewSessionPlan` rejects → `role="alert"` error region focused, Start disabled.
- A11y: results region `role="status" aria-live="polite"`, presets `aria-pressed`, close button
  labeled, lists keep `aria-label`s.

**Verification:** all existing SessionAssemblyPreview / HomeScreen / QueueScreen unit tests pass
unchanged (after test additions in U5); the panel visually matches the handoff in light and dark.

### U4. Replace the `.q-session-preview__*` CSS with split-layout styles

**Goal:** Style the new structure faithfully to the handoff using design tokens, with token-correct
light/dark, responsive collapse, and the app's hover/flatness conventions.

**Requirements:** R1, R2, R4, R5, R7, KTD-6.

**Dependencies:** U3 (class names).

**Files:**
- `apps/web/src/pages/queue/queue.css` — replace the `.q-session-preview*` block (lines ~790–922)
  with: root card (flat, border, no shadow), `__head`/`__title`/`__sub`/`__close`, `__split` grid
  (`300px 1fr`, `gap: var(--s-8)`), `__rail` (`border-right`, column gap), `__rail-label`, `__cards`
  (`grid-template-columns: 1fr 1fr`), `__card` (+ `:hover` border, `.is-active` accent,
  `--custom` inline input), `__meter`/`__meter-head`/`__free`, `__bar`/`__seg`/`__bar-free`,
  `__floor`/marker tick + `em` label, `__chips`/`__chip`/`__dot`, `__floornote`, `__main`,
  `__summary`/`__summary-title`/`__total`, `__list`/`__row`/`__row-title`/`__row-est`/`.is-out`,
  `__tag`, `__leftout`/`__leftout-head`, `__foot`/`__foot--block`, `__btn`/`--ghost`/`--primary`,
  the responsive `@media (max-width:760px)` collapse, and the existing `:focus-visible` ring rule.

**Approach:** Translate the prototype `.fw-*` rules verbatim into the `q-session-preview__*`
namespace, substituting tokens 1:1 (the prototype already uses real token names). Category colors
via `--el-extract` / `--el-card` / `--el-source`; floor tick via a dashed border in a
`color-mix(... var(--text) ...)`; segment inner hairline via `color-mix(... var(--surface) ...)`.
Keep `--shadow-sm` only on the primary button (taxonomy-compliant).

**Patterns to follow:**
`docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md` (hover = border,
keep flatness guards), `docs/solutions/design-patterns/scope-ported-design-kit-css-under-page-root.md`
(namespacing; if Biome `noDescendingSpecificity` trips, reorder, don't unscope).

**Test scenarios:** none directly (styling). Covered by the CSS-contract assertions in U5 and by
typecheck/lint. *(Test expectation: behavioral coverage lives in U5's `queue-css.test.ts`
additions.)*

**Verification:** `pnpm lint` (Biome) passes; panel matches the handoff at ~900px and collapses
cleanly below 760px; dark mode reads correctly; no hard-coded colors.

### U5. Tests — unit + CSS contract + e2e parity

**Goal:** Cover the new structure and lock the conventions, while proving the existing test contract
still holds.

**Requirements:** R3, R4, R6, R7, R9, R10, R11, KTD-3, KTD-6.

**Dependencies:** U2, U3, U4.

**Files:**
- `apps/web/src/pages/queue/SessionAssemblyPreview.test.tsx` — extend: preset cards show real
  per-box meta (U2); budget meter renders segments + floor marker when active; chips render
  non-zero categories; floor note appears only when active; left-out section renders with the
  `ban` tag; the four existing composition-copy tests still pass against the now-`sr-only`
  `session-composition`; the stale-guard test still passes.
- `apps/web/src/pages/queue/queue-css.test.ts` (CSS-contract guard) — add assertions: new
  interactive classes (`__card`, `__row`) use `border-color` hover (no `box-shadow` hover); the
  primary button keeps its shadow; the floor marker class exists and references a token, mirroring
  the `.qitem--protected::before` pinning style.
- Verify (no change expected): `apps/web/src/pages/home/HomeScreen.test.tsx`,
  `apps/web/src/pages/queue/QueueScreen.test.tsx`, `apps/web/src/pages/queue/ProcessQueue.test.tsx`,
  `tests/electron/process-queue.spec.ts`, `tests/electron/home.spec.ts`.

**Approach:** Reuse the existing mock pattern for `appApi.previewSessionPlan` and `useNavigate`. For
preset meta, make the mock return per-`targetMinutes` distinct results. Keep assertions on stable
testids and canonical copy. Run the two Electron specs that exercise this panel.

**Test scenarios:** enumerated above per file. The **Test Contract** (below) lists every selector
and string that must not regress.

**Verification:** `pnpm test` green (including the extended SessionAssemblyPreview suite and the CSS
guard); `pnpm e2e` for `home.spec.ts` + `process-queue.spec.ts` green.

---

## Test Contract (must not regress)

**Preserved `data-testid`s:** `session-preview`, `session-target-minutes`, `session-preview-start`,
`session-composition`, `session-planned-minutes`, `session-planned-row-minutes`, `session-cut-list`,
`session-cut-count` (keep `session-preview-error`). **External triggers:** `home-start-session`,
`queue-start-session`.

**Preserved exact copy (asserted):** `sessionCompositionCopy` outputs, e.g.
`"Distillation floor active: 4 min reserved."`, `"Planned 6 min distillation, 2 min cards."`,
`"Distillation share returned: no due extracts."`, `"Current filter: distillation quota inactive."`,
and the absence of `session-composition` when estimates are unavailable.

**Preserved behavior:** `previewSessionPlan` called with `{ mode:"full", targetMinutes:25 }` (Home),
filter-derived requests (Queue), Start disabled until `planRequestKey === requestKey`, and
`navigate({ to:"/process", search:{ assembled:1 } })`.

---

## Scope Boundaries

### Deferred to Follow-Up Work
- Debouncing the custom-box input (KTD-2) — the current per-change load is kept for parity and to
  avoid touching the stale-guard test contract.
- A visual-regression / screenshot test of the panel in light + dark — beyond the jsdom CSS-contract
  guard added in U5.
- Reworking the per-type left-out breakdown using `cut.byType` — the design shows a flat left-out
  list; the richer breakdown is out of scope.

### Non-Goals
- Any change to the planner, distillation-quota composition, time-estimate pricing, or the
  `/process` loop.
- Any change to Home/Queue chrome beyond the panel itself.
- Resurrecting the discarded "refined" / "launcher" directions or the narrow variations file.

---

## Risks & Mitigations

- **Breaking the test contract during the markup rewrite.** Mitigation: the Test Contract section
  enumerates every pinned selector/string; U3 keeps them and U5 runs the full suite + e2e.
- **StrictMode regression from new async state.** Mitigation: reuse the `loadSeqRef` sequence-guard
  idiom for preset fetches; explicitly forbid the `mountedRef` cleared-only-on-cleanup anti-pattern;
  add stale-guard tests.
- **Global CSS leakage from ported kit classes.** Mitigation: every new class is namespaced under
  `.q-session-preview__*`; no bare generic selectors.
- **Divide-by-zero / NaN meter widths at `targetMinutes === 0`.** Mitigation: `pctOf` guards
  `target > 0`; the zero/empty case is a covered test scenario.
- **Icon-map drift.** Mitigation: U1 adds the `ban` mapping to both `Icon.tsx` and
  `design/icon-map.md` in one change; the project-standards reviewer will catch a miss.

---

## Sources & Research

- Claude Design handoff bundle: `Interleave Home - Plan Session.html` + `iv-plan.jsx` +
  `plan-engine.jsx` (split direction), and `chats/chat2.md` (user chose "split", "only keep split").
- `docs/solutions/architecture-patterns/session-assembly-read-model-accepted-deck-handoff.md`
- `docs/solutions/architecture-patterns/protected-distillation-quota-daily-workload-share.md`
- `docs/solutions/architecture-patterns/queue-time-cost-read-model.md`
- `docs/solutions/ui-bugs/strictmode-mountedref-cleared-only-on-cleanup.md`
- `docs/solutions/conventions/hover-uses-border-not-shadow-and-shadow-taxonomy.md`
- `docs/solutions/design-patterns/scope-ported-design-kit-css-under-page-root.md`
- `design/tokens.css`, `design/icon-map.md`, `design/AGENTS.md`, `apps/web/AGENTS.md`, `CONCEPTS.md`
- Mount sites: `apps/web/src/pages/home/HomeScreen.tsx:571`,
  `apps/web/src/pages/queue/QueueScreen.tsx:1043`.
