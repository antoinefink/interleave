---
title: "fix: Repair all currently-failing Electron e2e tests"
type: fix
date: 2026-06-17
status: ready
depth: standard
---

# fix: Repair all currently-failing Electron e2e tests

## Summary

The Electron Playwright suite reports **9 failed, 14 did-not-run, 343 passed**; unit
tests, typecheck, and lint (3 warnings) are green. Investigation traces the 9
failures to **four** root causes — one genuine product regression and three stale
tests left behind by recently-merged features — plus one likely contention flake to
confirm last. The 14 "did not run" are downstream tests in `describe.serial` blocks
gated behind the 9 roots; fixing the roots unblocks them.

This plan fixes the product regression in code (with unit coverage), re-aligns the
stale e2e specs with the intended behavior **without weakening what each test
proves**, cleans up 3 lint warnings, and gates on a fully-green suite.

---

## Problem Frame

Each failure was root-caused against the documented domain model
(`Source → Extract → Clean → Atomic → Card`) and confirmed with code reads and
isolated test re-runs. The distinction that governs every fix: **is the product
regressed (fix code) or is the test stale (fix test, preserving intent)?** — never
flip a test green to mask a real bug, never change product behavior to satisfy a
test that encodes an outdated contract.

| # | Failing test | Root cause | Class |
|---|---|---|---|
| 1 | `markdown-import.spec.ts:217` | extract from inbox source flips it `inbox → scheduled` | **product bug** |
| 2 | `pdf-import.spec.ts:198` | same flip (test 3 extracts → test 4's `firstInboxId` empty) | **product bug** |
| 3 | `extract-review.spec.ts:112` | T122 staging: seeded one-liner now born `atomic_statement` | test stale |
| 4 | `extract-stagnation.spec.ts:165` | T122 staging: "never advanced" extract born atomic → not stagnant | test stale |
| 5 | `mvp-flow.spec.ts:257` | T122 staging: paragraph extract born atomic | test stale |
| 6 | `sub-extract.spec.ts:149` | T122 staging: sub-extract of one-liner born atomic | test stale |
| 7 | `weekly-open-routing.spec.ts:46` | Library now excludes system tasks (commit `0aa7a1f9`) | test orphaned |
| 8 | `schedule-explainability.spec.ts:164` | source ranks 6th, past Home top-5 preview cutoff | test too-strict |
| 9 | `semantic-search.spec.ts:166` | passes in isolation; full-suite contention (embedder model mismatch) | likely flake |

---

## Root-Cause Detail

### A. Inbox source flipped out of the inbox on extract (product regression)

`packages/local-db/src/extraction-service.ts` (~line 344) runs, when extracting from
a top-level source with adaptive intervals enabled:

```
if (this.scheduler.adaptiveAttentionIntervalsEnabled()) {
  this.scheduler.rescheduleProcessedVisitWithin(tx, input.sourceElementId, "extract", scheduledAt, sourceBaseline);
}
```

`rescheduleProcessedVisitWithin` (`scheduler-service.ts:341-380`) hardcodes
`status: "scheduled"`. For a source already in the reading queue this is correct.
For an **untriaged inbox source** (`status === "inbox"`) it silently triages the
source out of the inbox — violating the explicit inbox contract
(`inbox-query.ts`: inbox = `type === "source"` AND `status === "inbox"`).

Introduced by T122/T112 work (commit `d4489520`); its roadmap verification listed
`extraction.spec.ts` + `extract-review.spec.ts` but **not** `markdown-import.spec.ts`,
and the yield-adaptive design doc never mentions the inbox — the inbox interaction
was unconsidered. `extraction.spec.ts` passes because its seeded source is
`status: "active"` (`factories.ts:537`), not `inbox`, so the flip is a no-op there —
the guard below (`status !== "inbox"`) leaves it untouched. The only `inbox`-status
seed is the separate `inboxSource` (`factories.ts:750`); `markdown-import` and
`pdf-import` create genuinely inbox-born sources, which is why only they expose the flip.

This single regression breaks **two** e2e tests: `markdown-import` (source gone from
inbox after restart) and `pdf-import` (serial test 3 extracts page text from the PDF
inbox source → flips it → test 4's `firstInboxId()` returns nothing → the PDF reader
never mounts; the error-context DOM shows the empty text reader + "element no longer
available", exactly consistent).

**Decision: fix the product.** Extracting a passage from an untriaged inbox source
must not remove it from the inbox. Skip the processed-visit reschedule when the
source is still `inbox` (there is nothing to "reschedule" — an untriaged source is
not in the attention queue). Already-scheduled sources are unaffected.

### B. T122 shape-aware staging left e2e specs stale (intended behavior)

T122 (commit `2016a481`) made `extractions.create` classify a selection's shape:
a clean single sentence (1 paragraph, 1 block, ≤1 sentence, 4–40 words, ≤280 chars,
finite verb, …) is born `atomic_statement`; anything multi-block / multi-sentence /
long / structural stays `raw_extract` (`packages/core/src/extract-shape.ts`). The
reader flash follows stage:
`stage === "atomic_statement" ? "Atomic extract ready" : "Extracted"`.

T122 correctly updated `extraction.spec.ts` and unit tests but missed four specs that
still assert pre-T122 `raw_extract` / "Extracted". The seed's intro blocks
(`blk_intro_p1`, `blk_intro_p2`) are each a single clean sentence → atomic when
extracted alone. **Rich reconstruction takes content from the parent doc via
`blockIds`+offsets (`richSelectionToProseMirrorDoc`), so a raw birth requires a
multi-block selection, not just different `selectedText`.**

Per-test intent governs the fix:
- Tests whose **intent requires a raw extract** (the raw→clean→atomic walk;
  "never advanced" stagnation) → make the seeded selection genuinely raw via a
  **two-block** selection. Preserves what the test proves.
- Tests where **stage is incidental** (extract created + lineage; sub-extract
  lineage) → align the assertion to the intended atomic behavior, matching the
  already-updated `extraction.spec.ts`.

### C. Library excludes system-owned tasks (test orphaned)

Commit `0aa7a1f9` made `LibraryQuery.browse()` exclude `weekly_review` /
`reread_region` from Library browse, locked by `library-query.test.ts`.
`weekly-open-routing.spec.ts` drove its regression (the `taskType` field surviving
real renderer↔main IPC so `openQueueItem` routes `weekly_review` → `/weekly`) through
the **Library**, which no longer shows that row. **Decision: re-home, do not revert
the exclusion.** The Queue still shows the weekly task and routes through the same
`openQueueItem` helper — the regression's true subject.

### D. Home preview top-5 cutoff (test too-strict)

`schedule-explainability.spec.ts` seeds the source at priority C, schedules it, then
drives 3 descendant-card lapses (each priority D). At the home `asOf` the source is
at-due while several overdue competitors (the 3 forgotten lapsed cards + the seeded
`verify_claim` task + other seeded due items) outrank it, so it lands ~6th — past
`HomeScreen` `PREVIEW_LIMIT = 5`. (Weekly review is **not** enabled in this spec, so
it is NOT a competitor here; the exact competitor set must be re-derived empirically,
not assumed.) The `/queue` row (line 302) passes; only the home glance
(line 309) fails. **Decision: make the source rank into the top 5** — do **not** change
`PREVIEW_LIMIT` or the scorer. The intent (descendant-lapse reason explained across
queue/home/inspector) is preserved, and the later **negative** assertion (after manual
override, Home must NOT show the reason) only has teeth if the source appears in the
preview first — so ranking it in is load-bearing, not cosmetic. Confirm the exact
lever empirically (prefer shifting the home `asOf` slightly past the source's `dueAt`
to raise its own urgency, over deleting competitors — the latter distorts the realistic
due-load the scenario is meant to model).

### E. semantic-search (likely flake — confirm last)

`semantic-search.spec.ts:166` passed **2/2 in isolation** but failed in the full
suite. The query-palette path is gated on `vecAvailable && embedded > 0`, so the
failure means zero source rows were returned. Most plausible cause: under full-suite
CPU contention the in-test relaunch's query embed falls back to the lexical embedder
(`FALLBACK_MODEL_ID`) while the index was built with the real model, so the KNN
`model_id` filter matches nothing. **Decision: confirm-then-fix.** Re-run the full
suite after A–D land; only if it re-flakes, pin the embedder deterministically for
this spec (a launch-harness env forcing the fallback embedder for both processes).
Note: there is **no existing** force-fallback toggle for Electron e2e (only `VITEST`
is honored in `loadLocalModel`), so this pin requires a small **production** change —
a new env branch in the embedding worker's `loadLocalModel` — not a test-only tweak.
No scheduling change.

---

## Key Technical Decisions

- **KTD-1 — Guard at the extraction call site, not inside `rescheduleProcessedVisitWithin`.**
  The reschedule helper is shared (the extract-rewrite path passes an extract id that
  *should* become `scheduled`). A call-site guard is intent-local and has the smallest
  blast radius: only run the source processed-visit reschedule when the source is not
  in the inbox. (A helper-level "preserve status" change would in practice be safe too —
  the rewrite path never targets an inbox element — but the call-site guard keeps the
  inbox semantics where they're legible.)
- **KTD-2 — Preserve each stale test's assertion strength.** Where a test's purpose is
  the stage machinery, recreate a real raw extract (two-block selection) rather than
  flipping the assertion to `atomic_statement` (which would make the downstream
  raw→clean→atomic steps unreachable). Only flip assertions where stage is genuinely
  incidental.
- **KTD-3 — Confirm the flake before touching it.** Do not add determinism scaffolding
  to `semantic-search` unless the full suite reproduces the failure after A–D. Avoids
  unnecessary production/test changes for a contention artifact.

---

## Implementation Units

### U1. Guard processed-visit reschedule for untriaged inbox sources

- **Goal:** Extracting from a top-level source that is still in the inbox must not
  flip it to `scheduled`. Clears failures #1 (`markdown-import`) and #2 (`pdf-import`).
- **Files:**
  - `packages/local-db/src/extraction-service.ts` (the adaptive reschedule block ~344)
  - `packages/local-db/src/extraction-service.test.ts` (or the nearest existing
    extraction-service unit test) — add coverage
- **Approach:** The source `Element` is **not** already loaded pre-transaction — only
  `sourceBaseline` is captured there. Add an explicit status read
  (`this.elements.findById(input.sourceElementId)?.status`) and run
  `rescheduleProcessedVisitWithin` for the source only when `status !== "inbox"`,
  inside the existing `locationSource === input.sourceElementId` block. Leave the
  extract creation, block-state derivation, lineage edge, marks, and tag inheritance
  untouched — only the source reschedule is gated. Do not alter
  `rescheduleProcessedVisitWithin` itself. (The PDF region/clip extract paths do not
  call the adaptive reschedule, so they need no guard — but confirm that while here.)
- **Patterns to follow:** mirror the existing `adaptiveAttentionIntervalsEnabled()`
  conditional already wrapping the call; status vocabulary per `inbox-query.ts`.
- **Test scenarios:**
  - Extracting from an **inbox** source leaves `status === "inbox"` **and** `dueAt`
    still `null`, and the source is still listed by the inbox query (assert `dueAt`
    too, so a future change that writes a due date but leaves status can't silently pass).
  - Extracting from an already-**active/scheduled** source still reschedules it (a processed
    visit) — behavior unchanged; `extraction.spec.ts:158` must stay green.
  - The extract is still created with correct stage, lineage, and attention due date
    regardless of source status.
  - `operation_log` still records the extract creation transaction.
- **Verification:** `pnpm test` green; isolated `pnpm e2e --project=electron
  tests/electron/markdown-import.spec.ts` and `… tests/electron/pdf-import.spec.ts`
  both fully green.

### U2. Align extract-staging e2e specs with T122 shape-aware staging

- **Goal:** Re-align four stale specs with intended `atomic_statement` birth for clean
  one-liners, preserving each test's intent. Clears #3, #4, #5, #6 and unblocks the 4
  downstream `extract-stagnation` serial tests.
- **Files:**
  - `tests/electron/extract-review.spec.ts` — `createIntroExtract`: two-block
    selection (`blk_intro_p1` + `blk_intro_p2`) so the extract is born `raw_extract`
    and the raw→clean→atomic walk holds.
  - `tests/electron/extract-stagnation.spec.ts` — `makeStagnantExtract`: same two-block
    selection so the "never advanced" extract is born `raw_extract` and the stagnation
    predicate (which excludes `atomic_statement`) fires.
  - `tests/electron/mvp-flow.spec.ts` — flip the line-283 flash assertion to
    "Atomic extract ready" and the line-300 stage assertion to `atomic_statement`
    (the seed's single "forgetting" block is a fixed one-liner → atomic).
  - `tests/electron/sub-extract.spec.ts` — flip the line-168 toast assertion to
    "Atomic sub-extract ready" (the sub-extract of a single sentence is atomic; the
    test's subject is lineage, asserted unchanged below).
- **Approach:** For the two-block selections, set `blockIds: ["blk_intro_p1",
  "blk_intro_p2"]`, `startOffset: 0`, `endOffset: 145` (the length of `blk_intro_p2`'s
  text — do NOT copy the stale `150` from the current single-block call), and
  `selectedText` to the two concatenated sentences (used only as the fallback hint).
  The classifier yields `raw_extract` via `multiple_paragraphs` + `multiple_blocks` +
  `multiple_sentences` (three independent reasons → robust). For the two assertion
  flips, **match on the toast string, not a line number** ("Extracted" → "Atomic
  extract ready"; "Sub-extract created" → "Atomic sub-extract ready") since line
  numbers shift once the two-block edits land. Do not touch the seed
  (`packages/testing/src/factories.ts`) — it is shared, and `extraction.spec.ts` /
  unit tests depend on the current one-liner intro behavior.
- **Patterns to follow:** `extraction.spec.ts:158` is the canonical post-T122 assertion
  shape ("Atomic extract ready" / `atomic_statement`); mirror it for the incidental-
  stage flips.
- **Test scenarios:** (these ARE e2e tests — run them)
  - `extract-review`: extract born `raw_extract`, advances raw→clean→atomic, survives
    restart.
  - `extract-stagnation`: 3× postponed never-advanced extract reports `stagnantCount === 1`;
    downstream maintenance/keep/delete/restart-recompute tests run and pass.
  - `mvp-flow`: pressing `E` flashes "Atomic extract ready", extract is `atomic_statement`,
    lineage source→extract, parent block paints `.extracted`.
  - `sub-extract`: toast "Atomic sub-extract ready", sub-extract lineage
    source→extract→sub at depths 0/1/2 survives restart.
- **Verification:** each of the four specs green in isolation
  (`pnpm e2e --project=electron tests/electron/<spec>`).

### U3. Re-home weekly-open-routing to a surface that shows the weekly task

- **Goal:** Restore the `openQueueItem` `weekly_review → /weekly` IPC regression
  coverage on a surface that still surfaces the task. Clears #7.
- **Files:** `tests/electron/weekly-open-routing.spec.ts`
- **Approach:** Replace the Library navigation/selection with the **Queue**: enable
  weekly review, open `/queue` at the default `asOf` (now), locate the weekly-review
  `queue-item` (rows carry `data-element-id` / `data-element-type`), click its
  `queue-open` button, and assert it lands on `/weekly` (`weekly-review` testid
  visible, URL contains `/weekly`). Confirmed: `openQueueItem` routes
  `taskType === "weekly_review"` → `/weekly`; the queue's display `list()` does NOT
  apply `excludeWeeklyReview` (that filter is planner/session-only), and the weekly
  task is due-now once `hasWeeklyReviewMaterial()` holds (the seeded demo collection
  satisfies it). Caveat: the demo collection has many due items — verify the weekly
  row is actually rendered, not scored past the queue's visible-row limit. Keep the
  docstring's intent; update it to name the Queue as the driving surface and why
  (Library now excludes system tasks). Do **not** revert the Library exclusion.
- **Patterns to follow:** an existing spec that interacts with `queue-item` /
  `queue-open` (e.g. `queue.spec.ts`, `schedule-explainability.spec.ts:316` uses
  `row.getByTestId("queue-open")`).
- **Test scenarios:** weekly-review task appears in `/queue`; opening it routes to
  `/weekly` (not `/process`, not a card detail) across real IPC.
- **Verification:** `pnpm e2e --project=electron tests/electron/weekly-open-routing.spec.ts`
  green.

### U4. Make the schedule-explainability source rank into the Home top-5 preview

- **Goal:** The descendant-lapse source appears in the Home preview with its reason
  line, without changing the scorer or `PREVIEW_LIMIT`. Clears #8.
- **Files:** `tests/electron/schedule-explainability.spec.ts`
- **Approach:** First, empirically dump the actual ranked order
  (`queue.list({ asOf: scheduled.dueAt })`) to learn the real competitor set and the
  source's true rank — do not assume the "6th place" breakdown (the root-cause prose
  enumerates competitors approximately; weekly review is not among them here). Then
  pick the smallest lever that lands the source in the top 5 while keeping the
  descendant-lapse scenario intact — **prefer** opening Home at an `asOf` slightly past
  the source's `dueAt` (raising its own urgency without distorting the competitor
  population) over deleting competitors. Do not relax the assertion to "anywhere on the
  route" unless ranking proves infeasible — the source's own preview row must still
  carry the reason (the later negative assertion depends on it).
- **Test scenarios:** descendant-lapse reason is shown on `/queue` row, the Home
  preview row for the source, and the inspector — all three, until manual override.
- **Verification:** `pnpm e2e --project=electron
  tests/electron/schedule-explainability.spec.ts` green; re-run twice to confirm the
  ranking is stable, not borderline.

### U5. Clean up the 3 biome lint warnings

- **Goal:** Lint reports 0 warnings ("leave it cleaner"). Independent of the e2e work.
- **Files:**
  - `packages/local-db/src/reread-proposal-service.ts` (lines ~241, ~382 — `useOptionalChain`)
  - `tests/electron/reread-proposals.spec.ts` (line ~35 — unused `expect` import)
- **Approach:** Apply the optional-chain rewrites (verify they preserve the
  short-circuit semantics — `!x || x.foo` → `x?.foo`) and drop the unused import.
  `pnpm lint:fix` may apply these; review the diff since biome marks them "unsafe".
- **Test expectation:** none — no behavioral change; covered by existing tests +
  `pnpm lint` / `pnpm typecheck`.
- **Verification:** `pnpm lint` reports 0 warnings; `pnpm typecheck` + `pnpm test`
  still green.

### U6. Full-suite verification and semantic-search contingency

- **Goal:** Prove the entire suite is green; resolve #9 only if it reproduces.
- **Files:** none by default; conditionally `tests/electron/launch.ts` +
  `tests/electron/semantic-search.spec.ts` (+ the embedding worker's fallback toggle)
  **only if** the flake reproduces.
- **Approach:** After U1–U5, run the full `pnpm e2e`. If `semantic-search` passes, no
  change (it was a contention artifact). If it re-fails, pin the embedder
  deterministically for that spec via a launch env that forces the lexical fallback
  embedder for both the index and the relaunched-query processes, so the KNN
  `model_id` filter cannot mismatch — confirm by re-running the full suite.
- **Test scenarios:** full `pnpm e2e` reports 0 failed, 0 did-not-run; `pnpm lint`,
  `pnpm typecheck`, `pnpm test` all green.
- **Verification:** the Definition-of-Done gate (below) holds end-to-end.

---

## Scope Boundaries

**In scope:** the four root-cause fixes (one product guard + stale-test re-alignment),
the lint cleanup, and full-suite verification.

### Deferred to Follow-Up Work
- **Durable embedder-mismatch hardening** (product, known correctness bug — not just a
  latent gap): `semanticSearch` silently returns an empty KNN when the query embed
  resolves to a model space with no stored vectors (e.g. a real-indexed vault degraded
  to the fallback embedder on a query). This is a silent-wrong-answer class bug worth
  scheduling. The proper fix (detect mismatch → degrade gracefully or surface in
  `mode`) is a separate, larger change — note it, don't bundle. The U6 pin only makes
  the e2e deterministic; it does not fix this.
- **Local e2e retries:** Playwright sets `retries: 1` under CI but `0` locally; a local
  retry would absorb contention flakes generally. Out of scope here (a config policy
  decision), but worth recording.

**Non-goals:** changing `PREVIEW_LIMIT`, the queue scorer, the Library system-task
exclusion, the T122 classifier, or `rescheduleProcessedVisitWithin`'s shared contract.

---

## Risks & Mitigations

- **R1 — U1 guard changes scheduling behavior.** Mitigated by guarding only the
  inbox-status case at the call site; `extraction.spec.ts` (scheduled source) and the
  reschedule unit tests must stay green — explicit U1 scenario.
- **R2 — Two-block selection births atomic anyway** (offsets/reconstruction).
  Mitigated by asserting `raw_extract` directly in the e2e and confirming the
  classifier path (`multiple_paragraphs`); verify per-spec in isolation before the
  full run.
- **R3 — schedule-explainability ranking stays borderline.** Mitigated by re-running
  the spec twice and choosing a lever with clear margin, not a one-rank nudge.
- **R4 — semantic-search flake is actually deterministic.** Mitigated by KTD-3:
  confirm via full-suite re-run before concluding; if deterministic, root-cause
  before pinning.

---

## Definition of Done

In the worktree `/Users/antoine/Code/interleave-e2efix`, all green:
1. `pnpm lint` (0 warnings)
2. `pnpm typecheck`
3. `pnpm test`
4. `pnpm e2e` — full suite, 0 failed / 0 did-not-run

Then land as a single commit on `main` (non-destructive) and leave
`~/Code/interleave` clean, on `main`, at that commit.

---

## Sources & Research

- Failing run + isolation re-runs (this session): full `pnpm e2e`; isolated
  `pdf-import` (deterministic fail), `semantic-search` (2/2 pass).
- Code: `extraction-service.ts`, `scheduler-service.ts`, `extract-shape.ts`,
  `prosemirror.ts` (`richSelectionToProseMirrorDoc`), `inbox-query.ts`,
  `library-query.ts`, `HomeScreen` preview, `packages/testing/src/factories.ts` seed.
- History: `d4489520` (T112 yield-adaptive), `2016a481` (T122 shape-aware staging),
  `0aa7a1f9` (Library system-task exclusion); roadmap `T112`/`T122` verification notes.
- Docs: `docs/solutions/architecture-patterns/yield-adaptive-attention-interval-multiplier.md`.
