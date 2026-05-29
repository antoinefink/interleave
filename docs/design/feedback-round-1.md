# Design feedback — round 1 (to Claude Design)

> **Status: ✅ resolved in round 2.** The updated kit (now vendored at [`../../design/`](../../design/))
> addressed essentially all of this — FSRS card model, the FSRS/attention `SchedulerChip`
> split, full type/status/stage vocabulary, navigable lineage, the distillation `Pipeline`,
> `BudgetMeter`, undo `Snackbar`, `CheatSheet`, and trash/synthesis/task/settings screens.
> Kept for provenance. See [`../design-system.md`](../design-system.md).

Feedback on the `Incremental Reading` handoff bundle, sent back to the design tool to better
align the next iteration with the product spec. Kept here so the eventual implementation can
trace design decisions. See also [`../../CLAUDE.md`](../../CLAUDE.md) and
[`../roadmap.md`](../roadmap.md).

---

## Context

This is genuinely close — the shell, command palette, token system, and domain-aware color
language are excellent and we want to build on them. The notes below are about making the
design match the product's core mechanics precisely, because small conceptual mismatches in
the prototype get faithfully (and expensively) reproduced in code.

## What's nailed — please keep

- IBM Plex superfamily + OKLCH cool-neutral palette + blue accent, **light and dark**.
- The shell: left sidebar, top ⌘K command bar, main work area, right inspector — and
  `g`-then-key navigation with visible `Kbd` hints. Keep all of this.
- Domain-aware tokens: priority A/B/C/D, element-type hues (source/extract/card/task/
  concept/media), highlight + extract marks, the dashed **read-point** marker.
- Specific touches to keep: the `qitem--protected` left accent bar, the source **reference
  block** (`refblock`), the floating **selection toolbar**, the four-up **grade buttons**
  with interval previews, the **quality-check** (`qc`) chips, the **leech** badge, the
  "Local vault" chip (good local-first signal).

---

## P1 — Highest-priority corrections (conceptual)

### 1. Card scheduling is FSRS, not SM-2
The mock card model uses SM-2 vocabulary (`ease: 2.4`, `rep`, `lapses`) and the "ease
factor" idea. Our product uses **FSRS**. Please re-model card scheduling and surfaces around
FSRS's three components:
- **Stability** (memory strength, shown as ~days/“half-life”)
- **Difficulty** (0–10 or %)
- **Retrievability** (current recall probability %, e.g. "82% recall")
- plus **due date**, **reps**, **lapses**, and the **desired-retention** target.

Drop "ease factor 2.4" from the card inspector/review and show Stability / Difficulty /
Retrievability instead. The Again/Hard/Good/Easy buttons with next-interval previews are
already FSRS-compatible — keep them.

### 2. Show TWO distinct schedulers, visually distinguished
This is our most important invariant. Cards answer *"can I recall this?"* (FSRS).
Sources/topics/extracts answer *"should I process this again, and when?"* (a custom
priority/attention scheduler). Right now every type just shows "Due today" identically.
Please differentiate:
- **Card** inspector/queue chip → memory signals: retrievability %, stability, next interval.
- **Source / extract** inspector/queue chip → attention signals: **priority**, **stage**,
  **last processed**, **postponed ×N**, **stagnant?** (keeps returning, no progress),
  **produced N extracts / M cards** (yield). Different iconography/label so the user always
  knows which scheduler an item is on.

### 3. Use the full canonical vocabulary
The prototype only models part of our enums. Please extend:
- **Element types:** source, topic, extract, card, **task**, concept, **media_fragment**,
  **synthesis_note**. (Topic and synthesis_note are missing; task exists in data but has no
  real surface.)
- **Lifecycle statuses:** inbox, pending, active, scheduled, done, **dismissed**,
  **suspended**, **deleted/trash**. The `Status` component only covers due/overdue/done/new/
  leech — please add visual treatments for **suspended**, **dismissed**, and **trashed**.
- **Distillation stages (full pipeline):** raw_source → rough_topic → raw_extract →
  clean_extract → atomic_statement → card_draft → active_card → **mature_card** →
  **synthesis**. The `Stage` component stops at "Card draft" — add active/mature/synthesis.

### 4. Make lineage *actionable*, not just decorative
Source lineage is sacred in this product (a card must trace back to its extract → source
location → original context). Today the reference block is static text.
- In **review**, make the reference block a button: **"Open source at this location"** that
  implies jumping to the exact paragraph (highlighted) in the reader.
- Add an explicit **lineage/hierarchy tree** (source → extract → sub-extract → card, with
  parent links both directions). The data already hints at this (`parent`, `extractId`,
  `sourceId`) but there's no tree UI.
- Design **sub-extracts**: selecting text *within an extract* creates a child extract; show
  the nesting.

---

## P2 — Important additions

### 5. Overload & queue management (a defining feature, not an edge case)
Overload is core to incremental reading. Please design:
- A **daily-budget** indicator on the Queue (e.g. "42 / 60 today") and what happens when
  exceeded.
- An **auto-postpone / overload banner** using the existing `Banner`: *"38 items over
  budget — postpone low-priority topics? High-priority cards are protected."*
- The **import↔process balance warning**: *"You imported 12 sources this week but processed
  3. Consider triaging before importing."*
- **Catch-up** and **vacation** modes (entry points + the "cost of postponement" shown).

### 6. Local-first data integrity surfaces
Our data rules require no silent data loss. Please add:
- A **trash** view (soft-deleted elements) with restore.
- An **undo toast/snackbar** pattern (e.g. "Extract deleted · Undo") — there's no toast
  component yet.
- A **backup / export** panel (export to JSON + media; import into a fresh vault).

### 7. Real Settings screen
Settings is currently a placeholder. Please design it with: **daily review budget**,
**default desired retention** (FSRS), **default topic interval**, **default source
priority**, **theme**, **keyboard layout**, and **backup/export**.

### 8. Distillation pipeline visual
Given the pipeline is the product's north star, a small **stage stepper/progress** showing
where an element sits (Source → Extract → Clean → Atomic → Card → Mature) would be very
on-brand — usable in the inspector and the builder.

### 9. Synthesis notes & tasks/verification
- A light **synthesis note** surface (incremental writing that collects linked
  extracts/cards and returns for refinement).
- A **task / verification** affordance (the mock has "Verify: …" tasks and an `el-task`
  hue, but no home for them) — e.g. surfaced in the queue and a maintenance view.

---

## P3 — Nice to have / leave room for

- **Keyboard cheat-sheet overlay** on `?`, plus a contextual shortcut footer on the core
  review/extract loop (extract, cloze, postpone, done, delete, raise/lower priority, next).
- **First-run / onboarding** empty states for an empty vault (Queue/Inbox/Library).
- **Hierarchical concepts** (our concepts are a tree) in the Library filter and Concept map,
  not just flat tags.
- Don't hard-bake "text-only cards." Leave structural room for later **image-occlusion**,
  **audio**, and **formula/code** cards (no need to design them now).
- **Mark-processed**: an affordance to dim/collapse already-processed spans in the reader
  (the `.dimmed` style exists; the interaction doesn't).

---

## Per-screen quick notes

- **Queue:** add daily-budget meter + overload banner; make each row's scheduler-signal
  reflect its type (card = retrievability, source/extract = priority+stage+stagnation).
- **Inbox:** keep the rich import previews and duplicate flag; add explicit triage actions
  (keep / set priority / activate / dismiss / delete) and the import-balance warning.
- **Reader:** keep read-point + marks + selection toolbar; add mark-processed (dim/collapse)
  and an extracted-span → "open extract" affordance.
- **Builder (extract → card):** keep split layout + quality checks + card preview; show the
  stage stepper and sub-extract creation; ensure cloze + Q&A both first-class.
- **Review:** switch to FSRS stats; make the reference block "open source at location";
  surface suspend/leech/edit inline (good already), and sibling-burying state.
- **Library/Search:** hierarchical concept filter; result rows should show lineage + type.
- **Concepts (map):** keep the graph; reflect concept hierarchy and per-concept due counts.
- **Analytics:** keep forecast + history sparklines; add retention %, source-yield, and
  extract-stagnation views; tie metrics to the overload story.
- **Settings:** design for real (see #7).

---

## One-line summary to paste

> Love the shell, tokens, and command palette. Three must-fixes: (1) cards are **FSRS**
> (stability/difficulty/retrievability), not SM-2 ease factors; (2) visually distinguish the
> **two schedulers** — memory (cards) vs attention (sources/extracts); (3) use our **full
> vocabulary** (types incl. topic/synthesis_note/task, statuses incl. suspended/dismissed/
> trash, stages through mature_card/synthesis) and make **lineage actionable** (jump-to-
> source-location + hierarchy tree). Then add overload management, trash/undo/backup, and a
> real Settings screen.
</content>
