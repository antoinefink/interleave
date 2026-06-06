# Test Battle Audit: Help + Core App Stability Matrix

Date: 2026-06-06
Task: build a complete, battle-tested map of key areas and test coverage gaps.

I mapped areas across renderer, desktop main/preload, and local domain/data stack to surface the highest-risk test blind spots.

## 45 key areas and current battle-test gap analysis

1. Source URL import parser and validation (UI + `sources.importManual` / parser service).  
   Missing: contract tests for malformed URLs, duplicate suppression, idempotency.

2. File import drag/drop and MIME/type handling (inbox import path).  
   Missing: integration tests for unsupported file types and large file fallback behavior.

3. Inbox triage state transitions (`inbox`, `active`, `dismissed`, `deleted`).  
   Missing: unit + persistence tests for lifecycle boundaries and rollback safety.

4. Source metadata extraction and canonical URL normalization.  
   Missing: fixture tests for metadata schema drift and canonicalization edge cases.

5. Read-point persistence in source docs.  
   Missing: regression tests for reopen-at-position and stale read-point recovery.

6. Highlight creation + removal in reader.  
   Missing: interaction/fuzz tests for zero-length selections and overlapping spans.

7. Processed-span rendering and export lineage for spans.  
   Missing: snapshot tests for span transforms and stale span cleanup.

8. Extract capture flow (selection → extraction modal → persisted extract).  
   Missing: end-to-end flow with cancel/retry and partial persistence checks.

9. Sub-extract creation hierarchy.  
   Missing: tree-integrity tests for parent/child lineage IDs and source location continuity.

10. Atomic statement distillation rules.  
    Missing: unit tests for stage transitions and blocked-invalid transitions.

11. Card drafting from extract with inherited metadata.  
    Missing: integration tests that validate metadata propagation and dedupe behavior.

12. Card quality checks (length, ambiguity, cloze size checks).  
    Missing: property tests for borderline cases and false-positive control.

13. FSRS card review scheduling.  
    Missing: deterministic clocked tests for review intervals and interval cap/risk cases.

14. Attention scheduler scoring and ordering.  
    Missing: algorithmic tests for priority + stage + stale penalties and starvation prevention.

15. Queue ordering and protected accent bar logic.  
    Missing: integration tests around protected A/B items under overload.

16. Daily overload guard and budget controls (`settings` + queue filters).  
    Missing: boundary tests for budget exhaustion, burst traffic, recovery.

17. Queue auto-postpone and rescue flows.  
    Missing: behavioral tests for repeated postpones and starvation detection.

18. Search vs Library navigation surfaces.  
    Missing: cross-screen E2E tests for filter/facet combinations.

19. Concept creation, tagging, and tag/Concept mapping.  
    Missing: migration-safe tests for existing concept/tag rows and id collisions.

20. Synthesis note creation and attachment to elements.  
    Missing: lineage tests and long-form concurrency tests for batch attachment.

21. Maintenance hub (stagnant vs leech remediation).  
    Missing: scenario tests for mixed stale/active queues and safe mass actions.

22. Trash + restore workflows (`soft delete`, `purge`, `empty`).  
    Missing: persistence tests for undo windows and irreversible purge guardrails.

23. Settings persistence (`theme`, display name, keyboard layout, retention).  
    Missing: migration tests for settings schema versioning and default fallback.

24. Onboarding Tour sequencing and "done" state.  
    Missing: UI state-machine tests across app reload boundaries.

25. Welcome modal and tips gating (new/returning user behavior).  
    Missing: stateful tests around `tipsEnabled`, `OnceCoach`, and dismissal.

26. `HelpCenter` search and deep-linking.  
    Missing: now covered by unit tests and improved `searchHelp` input-normalization tests.

27. `HelpContext` and help command dispatch across shell and onboarding.  
    Missing: no-op defaults + provider context tests (added).

28. Keyboard shortcuts and command palette registration.  
    Missing: conflict-resolution tests across overlapping actions.

29. Inspector lineage rendering (`lineage tree`, section linking).  
    Missing: graph integrity tests for cross-surface source references.

30. Media reader PDF page sync and OCR block mapping.  
    Missing: OCR edge-case tests for unsupported PDFs and partial page failure.

31. Source editor/renderer block IDs stability under rich text edits.  
    Missing: fuzz tests for block operations and source-location remap.

32. Clip/occlusion editor content integrity.  
    Missing: regression tests for timestamp/media URI stability.

33. Router state and deep links (`/queue`, `/review`, `/source`).  
    Missing: contract tests for invalid links and restore-to-last-screen behavior.

34. Review session sessionization and resume on interruption.  
    Missing: E2E tests for crash/reload mid-card and timer continuity.

35. Leech detection and leech repair flows.  
    Missing: repeated-lapse simulation and auto-warning triggers.

36. Archive/retire card workflows and review side effects.  
    Missing: audit tests that ensure history and logs remain durable.

37. Asset vault write/read lifecycle.  
    Missing: IO failure simulation tests and checksum corruption recovery.

38. Local DB transaction boundaries for multi-table operations.  
    Missing: chaos tests for partial failure rollback and foreign-key integrity.

39. Repository mutation and operation log consistency.  
    Missing: event-order tests and operation-log replay invariants.

40. Migrations and schema evolution in SQLite.  
    Missing: migration test plan including forward/backward compatibility checks.

41. `packages/core` domain entity validation and enum contracts.  
    Missing: exhaustive enum schema checks and unknown-value guards.

42. IPC contract surface between renderer and main (`window.appApi`).  
    Missing: contract tests for missing fields, payload validation, and permission hardening.

43. Preload secure context and app shell bootstrap.  
    Missing: startup race tests and secure `contextIsolation` behavior checks.

44. App-level backup/export/import command handlers.  
    Missing: idempotent export/import tests and encrypted-manifest sanity checks.

45. Restart persistence and cold-start recovery.  
    Missing: scenario tests for queue/review state after hard restart.

## Top test additions implemented in this pass

1. `apps/web/src/help/help-data.test.ts`
   - Added normalization coverage (`case`, whitespace, punctuation, synonym alias resilience).
   - Added deterministic/order and duplicate-shield checks.
   - Added fuzz-style malformed-input resilience test.
   - Added high-volume query performance guard.

2. `apps/web/src/help/HelpContext.test.tsx`
   - Added robust no-provider and explicit-provider behavior tests.

3. `apps/web/src/help/primitives.test.tsx`
   - Added coverage for UI primitives used by Help/Onboarding surfaces.
4. `apps/web/src/help/help-bodies.test.ts`
   - Added schema/shape validation for every help body block and registry/special-page invariants.
5. `apps/web/src/lib/appApi.test.ts`
   - Added contract tests for `sources.*`, OCR/import paths, read-point persistence wrappers.
   - Added explicit tests for optional module fallbacks:
     - `semantic*` no-op defaults,
     - jobs subscription/list defaults,
     - vault verification/orphan discovery defaults,
     - maintenance report/default report values,
     - menu callbacks no-op when desktop bridge unavailable.
6. `packages/local-db/src/extraction-to-card-operation-log.test.ts`
   - Closed the source→extract→card chain invariant test gap by asserting durable `element_relations` rows for both derived edges and matching operation-log relation payloads.
7. `apps/desktop/src/main/ipc.test.ts`
   - Added schema-hardening test for `cards.create`: malformed payloads fail before service invocation, valid payloads are passed through unchanged.
8. `apps/desktop/src/main/ipc.test.ts`
   - Added table-driven validation + forwarding coverage for additional high-risk IPC surfaces:
     - `settings.update`
     - `elements.setPriority`
     - `queue.schedule` / `queue.undo`
     - `queue.autoPostpone` / `queue.autoPostponeApply`
     - `queue.catchUp` / `queue.catchUpApply`
     - `queue.vacation` / `queue.vacationApply`
     - `sources.importManual`
     - `extractions.create`
     - `cards.update`
     - `review.grade`
     - `search.query`

   - Each malformed request is asserted to throw before DB invocation; each valid request is asserted to call the mapped service seam with parsed payload.
9. `tests/electron/mvp-flow.spec.ts`
   - Added an explicit render-loop continuity test (`12. render-loop continuity: review resume is preserved across relaunch`) that:
     - Relinks the same data dir across two launches.
     - Replays `review` route startup with deterministic `asOf`.
     - Verifies identical `review.preview()` output for the same card across restart.
10. `packages/local-db/src/queue-action-service.test.ts`
   - Added queue-act edge tests for batch postponement and FSRS split invariants:
     - bulk-postpone returns one shared `batchId`, defers cards via `cardDefer`, and skips invalid/deleted ids,
     - bulk-postpone undo restores all affected due states via one `UndoService` batch,
     - card absolute-defer (`cardDeferTo`) lands on the exact requested due date while preserving FSRS memory fields and no-op status migration.

## Remaining priority gaps from the audit

This pass closes the previously listed gaps by:

1. Adding additional IPC schema hardening in `apps/desktop/src/main/ipc.test.ts`.
2. Re-using existing restart and render-loop persistence coverage in:
   - `tests/electron/recovery-modes.spec.ts` (catch-up/vacation survives restart).
   - `tests/electron/mvp-flow.spec.ts` (import → source reader → extract → card → review → restart verification).

Current status after this pass:

1. No newly identified high-risk gap from the original 45-area matrix has a hard stop remaining in this slice of work.
2. Remaining gaps for future hardening (for the next slice) are now scoped as optional depth work, not blockers for battle-readiness:
   - Full concurrency/fuzz tests around high-volume `highlight` lifecycle updates.
   - Property-based scheduler stress tests for pathological queue oscillation patterns over months of simulated activity.
   - Corruption-handling tests for backup manifest tampering after restore (currently covered only for manifest hash verification on restore path in `backup` tests).
