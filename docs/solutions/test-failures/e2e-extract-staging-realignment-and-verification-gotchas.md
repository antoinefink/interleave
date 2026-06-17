---
title: "Re-aligning e2e specs after a staging change, and Electron e2e verification gotchas"
date: "2026-06-17"
category: "test-failures"
module: "Electron E2E harness + extract staging"
problem_type: "test_failure"
component: "testing_framework"
symptoms:
  - "Several e2e specs asserted reader-flash \"Extracted\" / stage \"raw_extract\" but got \"Atomic extract ready\" / \"atomic_statement\"."
  - "extract-stagnation reported stagnantCount 0 because the seeded \"never advanced\" extract was born atomic_statement."
  - "A wall of identical 30.0s timeouts hit the FIRST test of ~22 unrelated specs at once."
  - "settings.spec.ts and e2e/smoke.spec.ts failed only in a fresh git worktree but passed on the main checkout."
root_cause: "test_staleness"
resolution_type: "test_fix"
severity: "medium"
related_components:
  - "packages/core extract-shape classifier"
  - "packages/core richSelectionToProseMirrorDoc"
  - "tests/electron specs"
  - "playwright config"
tags:
  - "electron"
  - "playwright"
  - "e2e"
  - "extract-staging"
  - "test-staleness"
  - "worktree"
  - "flakiness"
---

# Re-aligning e2e specs after a staging change, and Electron e2e verification gotchas

Three reusable learnings from fixing a batch of failing Electron Playwright specs.

## 1. When a cross-cutting classification changes, audit ALL specs that assert the old value

T122 shape-aware extract staging (commit `2016a481`) changed how a new extract's
birth-stage is classified: a clean single sentence is now born `atomic_statement`
instead of `raw_extract` (`packages/core/src/extract-shape.ts`). The merge updated
`extraction.spec.ts` and the unit tests, but **left several other e2e specs asserting the
pre-T122 stage/flash text** (`mvp-flow`, `extract-review`, `sub-extract`,
`extract-stagnation`). They surfaced only later, because Playwright `describe.serial`
blocks mark downstream tests "did not run" once an earlier one fails, masking them.

**Lesson:** when a change alters a value that many tests assert (a stage, a status, a
flash string, a route), grep the *entire* `tests/` tree for the old value — the feature's
own verification list is not the full blast radius.

**Guidance for each stale spec:** preserve what the test proves.
- Stage is *incidental* to the test (it just needs an extract + lineage) -> flip the
  assertion to the new value. Match on the toast **string**, not a line number (line
  numbers shift as sibling edits land).
- Stage is the *subject* (the raw -> clean -> atomic walk; a "never advanced" stagnation
  check that requires `stage !== atomic_statement`) -> recreate a genuinely raw extract
  (next section), do **not** flip the assertion.

## 2. Birth a raw_extract deterministically: select multiple seed blocks

`extractions.create` classifies an extract's shape from the reconstructed document, and
`richSelectionToProseMirrorDoc` (`packages/core/src/prosemirror.ts`) rebuilds that
document from the **parent doc by `blockIds` + offsets** — `selectedText` is only a
fallback hint, so changing it alone does nothing if the rich reconstruction succeeds.

The shared demo seed's intro blocks (`blk_intro_p1`, `blk_intro_p2`) are each a single
clean sentence, so selecting one block births `atomic_statement`. To force `raw_extract`,
select **two** blocks — `multiple_paragraphs` / `multiple_blocks` / `multiple_sentences`
each independently make the classifier return `raw_extract`:

```ts
const { extract } = await api.extractions.create({
  sourceElementId,
  selectedText: "<both sentences concatenated>", // fallback hint only
  blockIds: ["blk_intro_p1", "blk_intro_p2"],
  startOffset: 0,
  endOffset: 145, // length of the LAST block's text; do not copy a stale single-block offset
});
```

## 3. Electron e2e verification gotchas

**Constrain workers to read real failures.** Playwright distributes spec *files* across
~`cores/2` workers (8 on a 16-core box), each launching a heavy Electron app. Under
background disk load (a TimeMachine/Arq backup) this produced a wall of `30.0s` app-launch
timeouts on the **first** test of ~22 unrelated specs at once. That signature — many specs,
identical 30.0s duration, all on the first test — is resource contention, **not**
regressions. `pnpm e2e --workers=2` eliminated it. Corollary: verifying a handful of specs
in one concurrent invocation creates artificial contention (a spec timed out at 30s in a
4-spec batch but passed alone in 9.2s) — verify specs **individually** or via the **full
suite**, not in small concurrent batches.

**Verify vec/web-runtime-dependent specs on the main checkout, not a fresh worktree.** A
freshly `pnpm install`-ed git worktree can have a subtly different `apps/web` runtime than
the main checkout: `vecAvailable` came back false (so `settings.spec.ts`, which asserts the
"Semantic search" provider controls are gone, instead rendered the "isn't available" row)
and the chromium dev-server keyboard cheat-sheet (`e2e/smoke.spec.ts`) failed — both passed
on clean `main` under identical load. Implication: vec-dependent specs (e.g.
`semantic-search.spec.ts`, whose assertion is gated on `vecAvailable && embedded > 0` and
silently *skips* when vec is absent) and dev-server specs cannot be trusted from a worktree
— run the definitive full-suite verification on `main` after landing. (Separately, the
original `semantic-search` full-suite failure was contention-induced embedder real->fallback
model-id mismatch under load, not a code bug.)

## Related

- [Stabilize Electron E2E build locks and lineage contracts](./electron-e2e-stale-build-lock-and-lineage-contract.md)
- [Quiet macOS Electron E2E launches](../developer-experience/quiet-macos-electron-e2e-launches.md)
- [A processed-visit reschedule must not triage an untriaged inbox source](../logic-errors/extraction-is-engagement-not-triage-preserve-inbox-status.md)
  — the product fix that cleared the markdown-import and pdf-import failures in this same batch.
