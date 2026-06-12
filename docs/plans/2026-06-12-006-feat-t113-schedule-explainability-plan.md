---
title: "T113 Schedule Explainability"
type: feat
date: 2026-06-12
task: T113
---

# T113 Schedule Explainability

## Summary

T113 makes adaptive attention scheduling explain itself wherever the next due date appears. The
trusted read models will carry a structured schedule reason from scheduler and operation-log
evidence, the renderer will format that reason in queue rows and the inspector, and the T112
adaptive interval setting will become default-on only after those explanations are visible.

## Problem Frame

T112 persists bounded adaptive interval changes and records compact diagnostics in
`operation_log`, but the UI still shows due dates without explaining learned deviation from the
priority/stage band. That violates the Part III explainability bar: no learned interval change
should reach the user as silent scheduler drift. T113 closes that gap while preserving the
two-scheduler split: cards stay FSRS-only, and schedule reasons for sources, topics, extracts,
tasks, media fragments, and synthesis notes stay attention-scheduler facts.

## Requirements

- R1. Attention schedule reads must expose a closed structured reason when a heuristic changes an
  element's due date away from the priority/stage band or records a scheduler action that explains
  recession.
- R2. Queue rows and the inspector must show the same one-line explanation for the same attention
  element, derived from the same trusted-side reason payload.
- R3. Band-base schedules must remain quiet by default; the UI should not add noise when the
  due date follows the normal priority/stage cadence.
- R4. The reason vocabulary must be closed and exhaustively formatted, including
  `yield_shortened`, `yield_lengthened`, `recency_damped`, `postpone_recession`,
  `source_unresolved_shortened`, `source_exhausted_lengthened`, `descendant_lapses` as a reserved
  future value, and `band_base`.
- R5. Renderer code may format reason payloads but must not infer scheduler state from `dueAt`,
  `updatedAt`, operation-log payloads, or multiplier fields.
- R6. Existing adaptive diagnostics written by T112 must be readable without schema changes and
  normalized into the T113 vocabulary.
- R7. `scheduler.adaptiveAttentionIntervals` must default to `true` after explanations ship, while
  explicit stored user settings still override the default.
- R8. The implementation must remain read-only for explanation queries: no explanation read writes
  `operation_log`, mutates settings, or changes schedules.
- R9. Documentation and roadmap/task state must be updated after verification.

## Key Technical Decisions

- KTD1. Add a scheduler-owned source reason type in `@interleave/scheduler`, then project it into
  serializable DTO shapes at the desktop IPC contract and renderer wrapper boundaries. Do not add
  an `@interleave/scheduler` dependency to `apps/web`; the renderer keeps its local bridge types
  and formats validated DTOs.
- KTD2. Normalize T112's internal adaptive reasons into user-facing schedule reasons in
  `packages/local-db`, not React. The queue and inspector read models already assemble
  `schedulerSignals`; adding `scheduleReason` there preserves the typed IPC boundary and avoids a
  new renderer authority path.
- KTD3. Use the newest schedule-bearing `reschedule_element` operation payload as evidence for the
  current due date, not the newest adaptive payload in isolation. The projection must verify that
  the op's `dueAt` matches current `elements.due_at`; `choice`, `queueSoon`, unrecognized, or
  mismatched payloads return `null` rather than a stale reason.
- KTD4. Emit `recency_damped` directly from pure scheduler decisions only when last-seen credit
  changes the interval without adaptive yield taking precedence. That makes recency explanations
  testable from math instead of reverse-engineering dates later.
- KTD5. Treat source-processing interval changes as first-class explainable reasons. High-value
  unresolved source shortening maps to `source_unresolved_shortened`; exhausted/no-output source
  lengthening maps to `source_exhausted_lengthened`, in addition to the existing retirement
  suggestion signal.
- KTD6. Keep `band_base` in the payload for attention rows with reliable scheduler evidence, but
  suppress it in visible UI. Attention rows with no reliable scheduler operation evidence carry
  `null`. The renderer suppresses both `band_base` and `null`.
- KTD7. Flip the core default for `adaptiveAttentionIntervals` to `true`; stored settings remain
  authoritative through the existing `settings` table, so users who previously disabled it keep
  that choice.

## Scope Boundaries

- T113 does not implement the T114 descendant-lapse input. It reserves the reason kind so T114 has
  a typechecked UI path.
- T113 does not add new scheduler mutations, settings migrations, operation-log op types, or
  persistent reason tables.
- T113 does not change FSRS card scheduling, review interval preview copy, queue eligibility, or
  queue scoring.
- T113 does not introduce a new IPC command just for reasons unless existing queue/inspector
  payloads prove insufficient.

## Implementation Units

### U1. Scheduler Reason Vocabulary And Emission

- **Goal:** Add a closed schedule-reason vocabulary and have pure scheduler decisions emit
  explainable non-band-base changes.
- **Requirements:** R1, R4, R6
- **Dependencies:** none
- **Files:** Modify `packages/scheduler/src/attention-scheduler.ts`; modify
  `packages/scheduler/src/attention-scheduler.test.ts`; modify `packages/scheduler/src/index.ts`
  if new types need export.
- **Patterns to follow:** Existing `AdaptiveIntervalReason` and table tests in
  `packages/scheduler/src/attention-scheduler.test.ts`; deterministic `now` injection.
- **Approach:** Introduce `AttentionScheduleReason` with `kind`, interval fields, and optional
  evidence counters. Keep T112's adaptive multiplier decision as the internal math object, but
  map visible reasons to the T113 vocabulary. Add recency metadata when last-seen credit shortens
  the base interval. Add reason metadata for both existing source-processing branches before
  recency is applied. Return `band_base` when no visible adjustment applies.
- **Test scenarios:**
  - Productive adaptive visit returns a `yield_shortened` reason with prior/new multiplier and
    productive output count.
  - Barren adaptive visit returns `yield_lengthened` with prior/new multiplier and no productive
    output.
  - Valid older `lastSeenAt` without adaptive yield returns `recency_damped` with base and final
    interval days.
  - High-value unresolved source processing returns `source_unresolved_shortened`.
  - Exhausted/no-output source processing returns `source_exhausted_lengthened`.
  - Invalid/future `lastSeenAt` returns `band_base`.
  - The reserved `descendant_lapses` kind is part of the exported union but is not emitted by any
    T113 scheduler path.
- **Verification:** `pnpm --filter @interleave/scheduler test -- attention-scheduler`.

### U2. Trusted Read-Model Projection

- **Goal:** Carry schedule reasons through queue and inspector scheduler signals without adding a
  mutable explanation surface.
- **Requirements:** R1, R2, R5, R6, R8
- **Dependencies:** U1
- **Files:** Modify `packages/local-db/src/scheduler-service.ts`; modify
  `packages/local-db/src/queue-query.ts`; modify `packages/local-db/src/inspector-query.ts`;
  modify `packages/local-db/src/operation-log-repository.ts`; modify
  `apps/desktop/src/shared/contract.ts`; modify focused tests in
  `packages/local-db/src/scheduler-service.test.ts`, `packages/local-db/src/queue-query.test.ts`,
  `packages/local-db/src/inspector-query.test.ts`, and
  `apps/desktop/src/shared/contract.test.ts`.
- **Patterns to follow:** `retirementSuggestion` projection on queue and inspector signals;
  `latestAttentionAdaptivePayload` in `OperationLogRepository`; queue eligibility lessons in
  `docs/solutions/logic-errors/queue-eligibility-inventory-scheduler-state.md`.
- **Approach:** Persist the scheduler's reason and `dueAt` in existing `reschedule_element`
  payloads when a heuristic decision is applied. Add `scheduleReason` to `QueueSchedulerSignals`
  and `SchedulerSignals`, and define the serializable DTO in the desktop IPC contract before
  mirroring it in `apps/web/src/lib/appApi.ts`. Build the projection from the newest
  schedule-bearing `reschedule_element` op for the element and verify its `dueAt` still equals
  current `elements.due_at`. Map legacy T112 `attentionAdaptive.reason.reasonKind` values as:
  `yield_shortened` -> `yield_shortened`, `yield_lengthened` -> `yield_lengthened`, `yield_held`
  -> `band_base`, and `yield_input_malformed` -> `null`. For postpone, use the canonical
  effective count from `countPostpones`, suppress `postpone_recession` when the count is zero
  after a chronic-postpone reset, and preserve reset-undo behavior.
- **Test scenarios:**
  - A source rescheduled after productive yield exposes `yield_shortened` in both queue and
    inspector reads.
  - A postponed extract exposes `postpone_recession` with the canonical effective postpone count
    and final interval evidence.
  - A chronic-postpone reset suppresses stale `postpone_recession`; reset undo restores it.
  - A normal activation with current scheduler evidence returns `band_base`; rows with no reliable
    scheduler op return `null`.
  - Explicit manual schedules, queue-soon rows, mismatched op due dates, and adaptive-then-manual
    schedules do not reuse stale learned interval copy.
  - `yield_held` maps to hidden `band_base`, and `yield_input_malformed` maps to `null`.
  - Reading queue/inspector schedule reasons appends no `operation_log` entries.
- **Verification:** `pnpm --filter @interleave/local-db test -- scheduler-service queue-query inspector-query`.

### U3. Renderer Formatting In Queue And Inspector

- **Goal:** Render schedule reasons in the queue row and inspector without duplicating scheduler
  logic in React.
- **Requirements:** R2, R3, R4, R5
- **Dependencies:** U2
- **Files:** Modify `apps/web/src/lib/appApi.ts`; modify
  `apps/web/src/components/inspector/primitives.tsx`; modify inspector/queue components as needed
  in `apps/web/src/pages/queue/QueueScreen.tsx`, `apps/web/src/pages/home/HomeScreen.tsx`,
  `apps/web/src/components/inspector/Inspector.tsx`, or shared helper files; modify focused tests
  such as
  `apps/web/src/components/inspector/primitives.test.tsx`,
  `apps/web/src/pages/queue/QueueScreen.test.tsx`,
  `apps/web/src/components/inspector/Inspector.test.tsx`, and
  `apps/web/src/pages/home/HomeScreen.test.tsx`.
- **Patterns to follow:** `SchedulerChip` as the shared FSRS-vs-attention display primitive;
  non-modal advisory copy from `DoneIntentMenu`; no visible instructional text about how the
  feature works.
- **Approach:** Add a shared `ScheduleReasonLine` / formatter that switches exhaustively over the
  schedule reason kind and returns one short line. Queue renders it as a muted secondary line under
  the row meta; inspector renders it directly under the scheduler header before the attention
  summary. `band_base` and `null` do not mount. Reason text must be visible, not tooltip-only; the
  queue row button associates it via `aria-describedby`; inspector keeps it inside the scheduler
  section; CSS preserves a stable dense row while the full text remains available to assistive
  tech.

  Formatter templates:

  | Kind | Visible text |
  | --- | --- |
  | `yield_shortened` | `Returning sooner: last visit produced {productiveOutputCount} output(s).` |
  | `yield_lengthened` | `Receding: recent visit produced no output.` |
  | `recency_damped` | `Returning sooner: untouched for {daysSinceLastSeen}d.` |
  | `postpone_recession` | `Receding after postpone x{postponeCount}.` |
  | `source_unresolved_shortened` | `Returning sooner: source still has unresolved blocks.` |
  | `source_exhausted_lengthened` | `Receding: source produced no extractable output.` |
  | `descendant_lapses` | `Returning sooner: descendant cards are struggling.` |
  | `band_base` / `null` | Hidden. |

  If required evidence for a visible template is missing, return `null` rather than inventing copy.
- **Test scenarios:**
  - Queue row with `yield_shortened` displays a shortened-reason line.
  - Queue row with `band_base` displays no reason line.
  - Inspector attention section displays the same formatter output as queue.
  - FSRS card scheduler signals never render an attention reason.
  - Type tests fail if a new reason kind is added without formatter coverage.
- **Verification:** `pnpm --filter @interleave/web test -- SchedulerChip QueueScreen HomeScreen`.

### U4. Default-On Flag, Documentation, And End-To-End Coverage

- **Goal:** Ship adaptive scheduling default-on with visible reasons and update the roadmap/task
  records after full verification.
- **Requirements:** R7, R9
- **Dependencies:** U1, U2, U3
- **Files:** Modify `packages/core/src/settings.ts`; modify `packages/core/src/settings.test.ts`;
  modify `apps/desktop/src/shared/contract.ts`; modify `apps/desktop/src/shared/contract.test.ts`;
  modify `apps/web/src/pages/Settings.tsx`; modify `apps/web/src/pages/Settings.test.tsx`;
  modify `docs/scheduling-and-priority.md`; modify `docs/tasks/M23-adaptive-scheduler.md`;
  modify `docs/roadmap.md`; add or extend an Electron spec such as
  `tests/electron/schedule-explainability.spec.ts`.
- **Patterns to follow:** T112 completion notes in `docs/tasks/M23-adaptive-scheduler.md`; T103
  and T112 roadmap completion note style.
- **Approach:** Change the core default to `true`, add `adaptiveAttentionIntervals` to the typed
  settings patch schema if still missing, update renderer fallback defaults and settings tests, and
  add an Electron path that creates or uses a productive fixture, verifies the queue or inspector
  reason, restarts, and verifies the persisted evidence still renders. Only mark T113 complete in
  docs after `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant e2e pass.
- **Test scenarios:**
  - Fresh default settings report `adaptiveAttentionIntervals: true`.
  - A stored `false` setting remains false after default flip.
  - `SettingsPatchSchema` accepts boolean `adaptiveAttentionIntervals` and rejects non-booleans.
  - Electron e2e shows a productive source/extract reason in queue or inspector and the reason
    survives app restart.
  - Docs mention that adaptive attention intervals are user-visible because reasons are carried
    with non-band-base schedules.
- **Verification:** `pnpm lint`; `pnpm typecheck`; `pnpm test`; `pnpm e2e -- tests/electron/schedule-explainability.spec.ts`.

## System-Wide Impact

The change affects the contract of queue and inspector scheduler signals and the default scheduler
setting. It should be low-risk for persistence because reason data rides existing
`reschedule_element` payloads and read models remain read-only. The user-visible behavior change is
intentional: adaptive attention intervals become enabled by default only because the UI now states
why learned changes happened.

## Risks & Dependencies

- A reason derived only from dates can lie when later unrelated edits move `updated_at`; use
  scheduler operation payloads where possible.
- Existing T112 payloads may not contain every field ideal for copy. Normalize defensively and
  hide reasons when evidence is too weak rather than inventing detail in React.
- Queue row density is already high. Keep explanation copy short and suppress band-base rows.
- Setting-default changes can break tests with hardcoded fallback settings; update local renderer
  fallback defaults in sync with core defaults.

## Sources / Research

- `docs/tasks/M23-adaptive-scheduler.md` defines T113 scope and M23 invariants.
- `packages/scheduler/src/attention-scheduler.ts` already emits T112 adaptive diagnostics.
- `packages/local-db/src/scheduler-service.ts` writes scheduler diagnostics in
  `reschedule_element` payloads.
- `packages/local-db/src/queue-query.ts` and `packages/local-db/src/inspector-query.ts` are the
  trusted read-model seams for scheduler signals.
- `apps/web/src/components/inspector/primitives.tsx` owns the shared `SchedulerChip`.
- `docs/solutions/architecture-patterns/yield-adaptive-attention-interval-multiplier.md` explains
  the T112 diagnostic/setting pattern.
- `docs/solutions/logic-errors/attention-scheduler-last-seen-clock-semantics.md` explains
  `scheduledAt` and explicit-schedule exclusions.
- `docs/solutions/logic-errors/queue-eligibility-inventory-scheduler-state.md` reinforces that
  backend read models, not React, own scheduler state.
