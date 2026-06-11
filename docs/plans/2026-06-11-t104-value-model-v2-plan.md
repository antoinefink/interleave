---
title: T104 Value Model v2
date: 2026-06-11
type: feat
origin: docs/tasks/M21-honest-exits.md
task: T104
execution: code
---

# T104 Value Model v2

## Problem Frame

T104 corrects the current cards-or-failure value model. Today source yield rewards extracts, cards, and mature cards, while extract stagnation treats an extract as productive only if it advanced to `atomic_statement` or produced a direct child. T095 added synthesis notes as a real output channel using `references` edges, but those links do not affect source yield or stagnation. Extracts also have only generic `status: done`, so the system cannot distinguish reference material, synthesized material, or a deliberate no-card completion.

The change introduces explicit honorable extract fates, counts synthesis-note lineage as productive output, and teaches stagnation and analytics to respect those fates.

## Scope Boundaries

- Build T104 only: reference / synthesized / done-without-card fates for extracts, source-yield v2, stagnation exclusion, analytics, extract UI, process-queue extract actions, and stagnant-extract maintenance UI.
- Do not build T120 batch conversion sessions, T121 extract aging policy, or T112 yield-adaptive interval multipliers.
- Do not create a parallel synthesis table. Synthesis output remains `synthesis_note` elements plus `references` edges from note to material.
- Do not alter the extract stage ladder for extracts that are still heading toward cards.
- Do not make AI decisions or infer synthesized fate from document text. A synthesized fate is explicit user state and synthesis-note `references` edges are explicit lineage.
- Do not add a modal note-picker or batch conversion surface. Linking an extract into synthesis continues to happen through existing synthesis-note flows; T104 only makes that lineage count and keeps a cached fate in sync.

## Requirements Trace

- R1. Extracts can terminate as `reference`, `synthesized`, or `done_without_card`, distinct from delete and reversible through existing undo semantics.
- R2. Fate entry is command-shaped, transactional, clears active attention scheduling, preserves source lineage, and appends `operation_log` in the same transaction.
- R3. Synthesis notes count as productive source yield through live `references` edges from live `synthesis_note` elements to live source material.
- R4. Honorable extract fates count as productive output in source-yield v2.
- R5. Stagnation excludes extracts in honorable fates and extracts linked from live synthesis notes.
- R6. T084 remediation surfaces include keep-as-reference and mark-synthesized alongside rewrite / convert / postpone / delete.
- R7. Analytics/source-yield surfaces display the new categories and recompute from durable tables after restart.
- R8. Standard gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant Electron E2E coverage.

## Traceability

| Requirement | Implementation units | Required evidence |
| --- | --- | --- |
| R1 | U1, U2, U5 | Core/DB fate vocabulary tests, extract-service set/reactivate tests, ExtractView tests, E2E restart coverage |
| R2 | U1, U2 | Single `update_element` preimage tests, undo tests, IPC validation tests |
| R3 | U3 | Source-yield query tests for live `synthesis_note` `references` edges, deleted-note/target exclusions |
| R4 | U3 | Pure scorer tests and source-yield query tests for fated extracts |
| R5 | U4 | Scheduler and query tests excluding fated and synthesis-linked extracts |
| R6 | U2, U4 | ProcessQueue/ExtractView/StagnantExtracts renderer tests for the new actions and labels |
| R7 | U2, U3, U4 | SourceYield/Inspector/StagnantExtracts UI tests and E2E restart coverage |
| R8 | U5 | Standard gates and focused E2E commands |

## Key Decisions

- Use a new nullable `elements.extract_fate` column rather than overloading `status` or `stage`.
  Rationale: fates are terminal meaning attached only to extracts; lifecycle status stays `done`, stage stays the distillation ladder, and future T112/T121 can query fate without ambiguous status strings. A nullable column avoids widening global status semantics for non-extract elements.
- Fate values are a core closed vocabulary: `reference`, `synthesized`, `done_without_card`.
  Rationale: IPC validation, DB CHECK constraints, and typed UI all need the same vocabulary.
- `synthesized` lineage is authoritative. `extract_fate = "synthesized"` is a cached durable state maintained only when a live `synthesis_note` has a live `references` edge to the extract.
  Rationale: the task spec says synthesis is true because a live synthesis note links the extract. `SynthesisService.linkElement` sets the cached fate for extract targets in the same transaction as the relation; `unlinkElement` clears it only when no other live synthesis note still references the extract. Direct `extracts.setFate` accepts `reference` and `done_without_card`; attempts to set `synthesized` directly are rejected unless routed through synthesis linkage.
- Fate entry uses one existing `update_element` operation-log row with a full preimage of `{ status, dueAt, parkedAt, extractFate }`.
  Rationale: no new op type is needed; a single undo must restore the prior fate/status/due/parked state exactly. Fate entry must not split schedule clearing into a separate `reschedule_element`.
- Clearing a fate is a reactivation command, not a null-only terminal command.
  Rationale: `status: done` plus `extractFate: null` recreates the ambiguity T104 removes. The user-facing "Return to distillation" action writes one `update_element` patch with `{ status: "scheduled", dueAt: now, parkedAt: null, extractFate: null }`; undo restores the terminal fate.
- Source yield should track `synthesisNotesCreated`, `fatedExtracts`, `synthesisReferencedExtracts`, and a de-duplicated `productiveExtracts`.
  Rationale: a note and a resolved extract answer different questions, but scoring must not reward one extract multiple times. `productiveExtracts` is the distinct union of fated extracts and live synthesis-referenced extracts. `extractsCreated` remains displayed for continuity but scoring distinguishes unresolved extract output from resolved non-card output.
- Stagnation gets an `honorableFate` signal and a `synthesizedReferenceCount` signal.
  Rationale: the pure scheduler heuristic should know why an extract is not stagnant without importing DB or synthesis concepts.

## Existing Patterns To Follow

- `packages/local-db/src/extract-service.ts` for extract actions that update state and log through `ElementRepository`.
- `packages/local-db/src/source-yield-query.ts` for read-only grouped analytics behind typed IPC.
- `packages/local-db/src/extract-stagnation-query.ts` for read-only grouped scans and op-log-derived signals.
- `packages/local-db/src/synthesis-service.ts` for `synthesis_note` `references` edges.
- `packages/db/drizzle/0030_parked_elements.sql` for data-preserving migration style when changing the `elements` table.
- `apps/web/src/maintenance/StagnantExtracts.tsx` for remediation actions using existing typed `appApi` commands.
- `apps/web/src/reader/ExtractView.tsx` for extract action buttons and desktop-bridge mutations.
- `apps/web/src/pages/queue/ProcessQueue.tsx` for queue-time extract actions using the same typed commands as ExtractView.
- `packages/local-db/src/inspector-query.ts` for read models that ExtractView and the inspector consume after reload/restart.

## Implementation Units

### U1. Durable Extract Fate Vocabulary

**Goal:** Add a nullable extract-fate field shared by core, DB, mappers, repository patches, and migrations.

**Files:**
- Modify `packages/core/src/enums.ts`
- Modify `packages/core/src/element.ts`
- Modify `packages/core/src/index.ts`
- Modify/add `packages/core/src/index.test.ts`
- Modify `packages/db/src/schema/elements.ts`
- Add `packages/db/drizzle/0032_extract_fates.sql`
- Modify `packages/db/drizzle/meta/_journal.json`
- Add `packages/db/drizzle/meta/0032_snapshot.json`
- Modify `packages/local-db/src/mappers.ts`
- Modify `packages/local-db/src/element-repository.ts`
- Add/update tests near `packages/db`, including a migration 0032 test, and `packages/local-db/src/element-repository.test.ts`

**Approach:** Add `EXTRACT_FATES` and `ExtractFate`. Add `extractFate: ExtractFate | null` to `Element` and export it from the core barrel. Add `extract_fate` with a type-coupled CHECK: `extract_fate IS NULL OR (type = 'extract' AND extract_fate IN (...))`. Because SQLite cannot add table CHECK constraints with `ALTER TABLE ADD COLUMN`, use the project migration pattern that preserves dependent side tables and include the Drizzle snapshot. Update create/update/preimage mapping. Existing elements migrate with `NULL`. Repository create should default `extractFate` to `null`.

**Test Scenarios:**
- New elements read back with `extractFate: null`.
- `ElementRepository.update` persists and logs extract fate preimage.
- Migration preserves side-table rows and adds `extract_fate` as nullable.
- DB and repository tests reject a non-extract row with a non-null fate.

### U2. Extract Fate Commands And UI Entry Points

**Goal:** Let users set, see, change, and reactivate honorable fates through typed extract commands and visible extract/process-queue actions.

**Files:**
- Modify `packages/local-db/src/extract-service.ts`
- Modify `packages/local-db/src/extract-service.test.ts`
- Modify `apps/desktop/src/shared/contract.ts`
- Modify `apps/desktop/src/shared/contract.test.ts`
- Modify `apps/desktop/src/shared/channels.ts`
- Modify/add `apps/desktop/src/shared/channels.test.ts`
- Modify `apps/desktop/src/main/ipc.ts`
- Modify `apps/desktop/src/main/ipc.test.ts` or `apps/desktop/src/main/db-service.test.ts`
- Modify `apps/desktop/src/main/db-service.ts`
- Modify `apps/desktop/src/preload/index.ts`
- Modify `apps/desktop/src/preload/index.test.ts`
- Modify `apps/web/src/lib/appApi.ts`
- Modify `apps/web/src/lib/appApi.test.ts`
- Modify `apps/web/src/reader/ExtractView.tsx`
- Modify `apps/web/src/reader/ExtractView.test.tsx`
- Modify `apps/web/src/pages/queue/ProcessQueue.tsx`
- Modify `apps/web/src/pages/queue/ProcessQueue.test.tsx`
- Modify `packages/local-db/src/inspector-query.ts`
- Modify `packages/local-db/src/inspector-query.test.ts`

**Approach:** Add `extracts.setFate({ id, fate })` for `reference` and `done_without_card`; `synthesized` is rejected unless called from the synthesis linkage path. Setting a fate writes one `update_element` patch: `{ status: "done", dueAt: null, parkedAt: null, extractFate: fate }`. Add `extracts.reactivateFate({ id })` or equivalent for "Return to distillation", writing one `update_element` patch with `{ status: "scheduled", dueAt: now, parkedAt: null, extractFate: null }`. Thread `extractFate` through inspector summaries so ExtractView can show the current fate after reload/restart. ExtractView shows a "Fate" control group near status/stage: active fate highlighted, Reference and Done without card visible, Synthesized displayed as active when lineage set it, and Return to distillation available without a modal. ProcessQueue exposes the same Reference / Done without card actions for extract items through the same API. Controls use labeled buttons or existing menu primitives with keyboard focus, busy, disabled, and failure states.

**Test Scenarios:**
- Setting each fate clears `dueAt`, sets `status: "done"`, preserves parent/source lineage, and logs `update_element`.
- Setting a fate clears stale `parkedAt`, and undo restores parked state when that was the preimage.
- Reactivating a fate nulls `extractFate`, schedules the extract due now, and never leaves `status: done` with `extractFate: null` through the new command.
- Contract/preload/appApi expose the new command and reject invalid fates.
- ExtractView and ProcessQueue call the typed command only, show current fate, support change/reactivation, and handle busy/error states.
- `synthesized` direct set is rejected without a live synthesis-note link.

### U3. Source-Yield v2 Scoring And Query

**Goal:** Count honorable fates and synthesis-note lineage as productive output.

**Files:**
- Modify `packages/core/src/source-yield.ts`
- Modify `packages/core/src/source-yield.test.ts`
- Modify `packages/local-db/src/source-yield-query.ts`
- Modify `packages/local-db/src/source-yield-query.test.ts`
- Modify `packages/local-db/src/inspector-query.ts`
- Modify `packages/local-db/src/inspector-query.test.ts`
- Modify `apps/desktop/src/shared/contract.ts`
- Modify `apps/desktop/src/shared/contract.test.ts`
- Modify `apps/web/src/lib/appApi.ts`
- Modify `apps/web/src/analytics/SourceYield.tsx`
- Modify `apps/web/src/analytics/SourceYield.test.tsx`
- Modify `apps/web/src/analytics/AnalyticsScreen.test.tsx` if low-yield assertions depend on v1 scoring
- Modify `apps/web/src/components/inspector/Inspector.tsx`

**Approach:** Extend `SourceYieldInputs` with `honorableExtracts` and `synthesisNotesCreated`. Add documented weights, with synthesized/reference/done-without-card output stronger than raw extract output and synthesis notes between extract and card reward. In `SourceYieldQuery`, compute:
- fated extracts per source from live `extract` rows with non-null `extract_fate`, split into `referenceExtracts`, `synthesizedExtracts`, and `doneWithoutCardExtracts`;
- live synthesis notes per source by joining `element_relations` where live note `references` live target material with `target.source_id = source.id`, counting distinct note ids per source;
- synthesis-referenced extracts per source as distinct live extract targets referenced by live notes, so linked extracts contribute even before the cached `extract_fate` has been set.

Pass de-duplicated `productiveExtracts = distinct(fatedExtracts ∪ synthesisReferencedExtracts)` and `synthesisNotesCreated` into the scorer. Keep legacy extract/card columns for continuity, but score unresolved extracts separately from resolved non-card value so one extract does not receive raw, fated, referenced, and note rewards as if they were all independent extract outputs. SourceYield UI displays a "Non-card value" group with stable labels: Reference, Synthesized, Done without card, and Synthesis notes. Inspector yield can remain compact, but must include a non-card value count or deliberately label the legacy count as extract/card output only; tests pin the chosen display.

**Test Scenarios:**
- A read source with a reference/done-without-card/synthesized extract is not low yield.
- A live synthesis note linked to multiple extracts from one source counts once as a note.
- One synthesis note linked to two sources counts once for each represented source.
- Deleted notes or deleted targets do not count.
- UI renders the new non-card value counts and low-yield count follows v2.
- One extract with both an explicit fate and a synthesis reference counts once at extract level.

### U4. Stagnation v2

**Goal:** Stop flagging honorably-terminal or synthesized extracts as stagnant.

**Files:**
- Modify `packages/scheduler/src/stagnation.ts`
- Modify `packages/scheduler/src/stagnation.test.ts`
- Modify `packages/local-db/src/extract-stagnation-query.ts`
- Modify `packages/local-db/src/extract-stagnation-query.test.ts`
- Modify `apps/desktop/src/shared/contract.ts`
- Modify `apps/desktop/src/shared/contract.test.ts`
- Modify `apps/web/src/lib/appApi.ts`
- Modify `apps/web/src/maintenance/StagnantExtracts.tsx`
- Modify `apps/web/src/maintenance/StagnantExtracts.test.tsx`
- Modify `tests/electron/extract-stagnation.spec.ts`

**Approach:** Extend `ExtractStagnationSignals` with `honorableFate: ExtractFate | null` and `synthesizedReferenceCount`. Treat either as progress: no stagnant verdict and reasons omit `no-progress`/`no-children` as appropriate. In the query, read `extractFate` from `elements` and compute live synthesis-note reference counts grouped by extract id. Expand suggestions to include `keep_as_reference` and `mark_synthesized`, while maintaining existing rewrite/convert/postpone/delete behavior for non-honored extracts.

`keep_as_reference` executes `extracts.setFate({ fate: "reference" })`. `mark_synthesized` is shown as a guided action only when a live synthesis note reference already exists; otherwise the row copy should say "Add to a synthesis note first" and route to the existing extract/synthesis flow rather than setting `synthesized` directly. StagnantExtracts keeps visible labeled buttons, highlights the suggested action without forcing it, disables the row while a command is in flight, removes the row on success, and restores/reloads the row with an inline error on failure. No modal note-picker is introduced.

**Test Scenarios:**
- Each explicit fate prevents stagnation.
- An extract referenced by a live synthesis note prevents stagnation.
- A soft-deleted synthesis note does not prevent stagnation.
- Existing threshold and sorting behavior remains unchanged for normal extracts.
- Stagnant maintenance renders and executes the new suggested actions.
- Stagnant maintenance does not hide a row permanently on failed fate actions.

### U5. E2E, Docs, And Roadmap

**Goal:** Prove the T104 behavior end-to-end and update task records.

**Files:**
- Modify `tests/electron/extract-stagnation.spec.ts`
- Modify `tests/electron/source-yield.spec.ts`
- Modify `tests/electron/extract-review.spec.ts`
- Modify `docs/tasks/M21-honest-exits.md`
- Modify `docs/roadmap.md`

**Approach:** Add focused E2E coverage rather than a broad UI tour: create or use fixture material, apply an honorable fate, verify it leaves stagnant maintenance and appears in source-yield analytics after restart. Update T104 status and completion notes after the final commit hash is known.

**Test Scenarios:**
- Mark an extract as reference/synthesized, restart, verify it remains out of `/maintenance/stagnant`.
- Verify source-yield analytics shows non-card value output for the source and does not classify it as read-but-barren.
- Mark an extract `done_without_card`, restart, verify ExtractView shows the fate, reactivate it, restart again, and verify the fate clears and the extract returns to attention work.

## Verification Plan

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- Relevant E2E:
  - `pnpm e2e tests/electron/extract-stagnation.spec.ts`
  - `pnpm e2e tests/electron/source-yield.spec.ts`

## Risks And Mitigations

- Migration risk: adding a type-coupled CHECK to `elements` affects many dependent tables. Use the existing rebuild-and-restore pattern when needed, and include the Drizzle snapshot.
- Double counting: count distinct synthesis notes per source and distinct synthesized extract ids, not raw relation rows.
- UI scope creep: keep fate controls compact and reuse existing extract/stagnation surfaces; do not build batch sessions.
- Schedule ambiguity after clearing a fate: clearing is a reactivation action that sets due-now scheduled attention work, so the row is not left terminal and ambiguous.
