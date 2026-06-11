---
title: "T102 Parked Resurfacing Sweep"
date: "2026-06-11"
type: feat
origin: docs/tasks/M21-honest-exits.md
task: T102
status: ready
---

# T102 Parked Resurfacing Sweep

## Problem Frame

T101 made "Save for later" honest by storing parked sources as `status = "parked"` with
`parkedAt`. T102 closes the loop: parked sources that have passed a configurable resurfacing
window should appear in a calm maintenance sweep where the user explicitly decides whether to
keep them parked, schedule them, or let them go. Nothing should auto-schedule or nag the user,
and parked rows must remain excluded from Inbox, Queue, and Daily Work until a command changes
their lifecycle state.

## Requirements Traceability

- T102 roadmap/task spec: parked items resurface after `parkedAt + resurfaceAfter` with a default
  near 90 days, in a review surface offering keep-parked / schedule / let-go per item, bulk apply,
  and one-batch undo.
- T101 completion notes: reuse `status = "parked"` and `parked_at`; do not reclassify legacy
  dismissed rows.
- `docs/solutions/workflow-issues/save-for-later-first-class-parked-state.md`: parked means
  deferred with intent, visible and dated in Library, excluded from current work routing.
- `docs/solutions/logic-errors/queue-eligibility-inventory-scheduler-state.md`: queue eligibility
  and due labels are backend-owned read-model facts, not renderer date math.
- `docs/solutions/ui-bugs/balance-banner-queue-inbox-action-gating.md`: quiet entry indicators
  must route only from actionable counts and remain dismissible/non-modal.

## Scope Boundaries

- Build the maintenance-hosted sweep now. T110 may later include the same count in the weekly
  ledger, but T102 does not build the weekly session.
- Do not auto-schedule parked sources. The sweep asks; only explicit actions mutate state.
- Do not add a new lifecycle state. T101 already added `parked`; T102 adds resurfacing behavior.
- Do not retroactively infer saved-vs-abandoned intent from historical `dismissed` rows.
- Keep renderer logic UI-only: no direct SQL, filesystem, Electron main imports, or renderer-side
  eligibility math.

## Key Technical Decisions

1. Add a typed app setting `parkedResurfaceAfterDays`, default `90`.
   Rationale: the task calls for a setting, and `packages/core/src/settings.ts` is the existing
   default/coercion surface for durable user/domain settings.

2. Put the read model and apply commands under the existing maintenance surface.
   Rationale: the task spec names maintenance as the first host, and `MaintenanceService` already
   owns trusted read-only reports plus undoable batch cleanup actions.

3. Use a focused local-db service/query for parked resurfacing.
   Rationale: due-boundary math belongs behind IPC and needs unit tests independent of React.
   The query returns only live parked sources whose `parkedAt` is at or before the computed cutoff.

4. Apply bulk decisions with one shared `batchId` using the existing `update_element` op shape.
   Rationale: T077/T099 already use shared batch ids for single undo. Keep-parked and let-go are
   `update_element`; the v1 schedule verb is explicitly `queueNow` and also uses
   `ElementRepository.updateWithin` to set `status`, `dueAt`, and `parkedAt` together so undo has
   the parked timestamp preimage. Do not use `reschedule_element` for this sweep unless it is first
   extended to preserve `parkedAt`, which is out of scope.

5. Extend the Maintenance hub with a quiet "Parked resurfacing" card and drill-down panel.
   Rationale: a badge/count is enough when due items exist; the user chooses to expand and act.

## Existing Patterns To Follow

- Parked actions: `apps/desktop/src/main/db-service.ts` `libraryParkedAction`.
- Maintenance service host: `apps/desktop/src/main/maintenance-service.ts`.
- Maintenance IPC shape: `apps/desktop/src/shared/channels.ts`,
  `apps/desktop/src/shared/contract.ts`, `apps/desktop/src/main/ipc.ts`,
  `apps/desktop/src/preload/index.ts`, `apps/web/src/lib/appApi.ts`.
- Maintenance UI and undo snackbar: `apps/web/src/maintenance/MaintenanceScreen.tsx`.
- Settings defaults/coercion: `packages/core/src/settings.ts` and
  `packages/core/src/settings.test.ts`.
- Batch undo examples: `packages/local-db/src/bulk-action-service.ts`,
  `packages/local-db/src/bulk-action-service.test.ts`,
  `packages/local-db/src/queue-action-service.ts`.
- Existing E2E parked story: `tests/electron/parked-save-for-later.spec.ts`.

## Implementation Units

### U1: Setting And Pure Boundary Math

Goal: Make the resurfacing window a typed setting with a safe default, tested coercion, and a
small visible Settings control.

Files:
- Modify: `packages/core/src/settings.ts`
- Modify: `packages/core/src/settings.test.ts`
- Modify as needed: `apps/desktop/src/shared/contract.ts`
- Modify: `apps/web/src/pages/Settings.tsx`
- Modify as needed: `apps/web/src/pages/Settings.test.tsx`

Approach:
- Add `parkedResurfaceAfterDays` to `AppSettings`, `RendererSettings`, defaults, key mapping,
  coercion, patch serialization, and renderer projection.
- Use a positive integer default of `90`.
- Add one bounded numeric Settings row in the existing scheduling/maintenance-adjacent area. Do
  not refactor Settings layout or create a new section for this task.
- Define eligibility math as exact UTC-duration math: parse ISO timestamps as instants,
  `cutoffMs = Date.parse(asOf) - days * 24 * 60 * 60 * 1000`, compare instants, and keep local
  calendar wording only for display.

Test scenarios:
- Fresh settings resolve `parkedResurfaceAfterDays: 90`.
- Stored valid value round-trips.
- Invalid, zero, negative, fractional, or non-number values fall back or are rejected consistently
  with neighboring integer settings.
- IPC settings patch accepts the new key and rejects invalid values at the boundary.
- Settings UI can persist a changed resurfacing window and shows validation/save failure states.
- Boundary math has a DST-adjacent test proving exact-duration comparison, not local-midnight math.

Verification:
- `pnpm test -- packages/core/src/settings.test.ts`

### U2: Parked Resurfacing Read Model

Goal: Return parked sources due for resurfacing using main-side clock and setting-owned threshold.

Files:
- Create: `packages/local-db/src/parked-resurfacing-query.ts`
- Create: `packages/local-db/src/parked-resurfacing-query.test.ts`
- Modify: `packages/local-db/src/index.ts`
- Modify as needed: `packages/local-db/src/index.test.ts`
- Modify: `apps/desktop/src/main/maintenance-service.ts`
- Modify: `apps/desktop/src/main/db-service.ts`
- Modify: `apps/desktop/src/shared/contract.ts`
- Modify: `apps/web/src/lib/appApi.ts`

Approach:
- Query live source elements with `status = "parked"` and non-null `parkedAt`.
- Compute the cutoff from main-side `asOf - parkedResurfaceAfterDays`; rows with
  `parkedAt <= cutoff` are due, rows after cutoff are not. Production renderer calls omit `asOf`;
  only tests/internal callers may provide it.
- Return compact rows with id, title, priority, priority label, created date, `parkedAt`, age in
  days, and source origin context available from existing ref/library helpers where practical.
- Return drill-down data as `{ rows, totalDue, limit, asOf }` from one main-side cutoff. The
  Maintenance report count uses the same count-only predicate and defaults/fallbacks include
  `parkedResurfacingCount: 0`.
- Add concrete repository integration: construct and export `parkedResurfacing` in
  `packages/local-db/src/index.ts` alongside the existing explicit maintenance repositories.

Test scenarios:
- Parked exactly at the cutoff is included.
- Parked after the cutoff / less than the configured window ago is excluded.
- `dismissed`, `inbox`, `scheduled`, deleted, non-source, and null-`parkedAt` rows are excluded.
- Custom threshold values change eligibility.
- Report count and drill-down `totalDue` agree when a list `limit` is applied.
- Query is read-only: no operation-log rows are appended.

Verification:
- `pnpm test -- packages/local-db/src/parked-resurfacing-query.test.ts`

### U3: Sweep Apply Commands And Batch Undo

Goal: Apply keep-parked, queue-now, and let-go decisions individually or in bulk under one undoable batch.

Files:
- Create: `packages/local-db/src/parked-resurfacing-service.ts`
- Create: `packages/local-db/src/parked-resurfacing-service.test.ts`
- Modify: `packages/local-db/src/index.ts`
- Modify as needed: `packages/local-db/src/index.test.ts`
- Modify: `apps/desktop/src/main/maintenance-service.ts`
- Modify: `apps/desktop/src/main/db-service.ts`

Approach:
- Define decisions:
  - `keepParked`: keep `status = "parked"`, keep `dueAt = null`, reset `parkedAt = now`.
  - `queueNow`: preserve current priority, set `status = "scheduled"`, set `dueAt = now`, clear
    `parkedAt`. This is T102's v1 "set priority + enter scheduling" interpretation: the existing
    parked source priority is retained, and normal queue scoring owns ordering.
  - `letGo`: set `status = "dismissed"`, clear `dueAt`, clear `parkedAt`.
- Validate each id is still a live source, `status = "parked"`, and still due for resurfacing
  under the same main-side cutoff/settings predicate as U2 before mutating. Stale ids are skipped,
  not trusted.
- Mint one `batchId` only when at least one row applies. Every applied mutation carries that batch
  id so `undoLast` reverses the whole sweep. Return `{ applied, skipped, batchId }` where
  `batchId` is `null` when `applied === 0`; skipped rows include `{ id, reason }`.
- All three decisions use `ElementRepository.updateWithin`/`update_element` with shared `batchId`
  and action markers. Do not add a bespoke `resurface_parked` operation type or touch
  `UndoService` unless an implementation discovery proves the existing `update_element` inverse is
  insufficient.
- Avoid two parked lifecycle owners: either the new service owns the shared transition helpers and
  `libraryParkedAction` delegates to them, or it reuses a tiny shared helper with regression tests.

Test scenarios:
- `keepParked` resets the resurfacing clock and remains excluded from queue/inbox.
- `queueNow` makes a source due now through normal queue eligibility and appends an
  `update_element` payload with the action marker and existing priority preserved.
- `letGo` produces a dismissed source with no due date.
- Mixed bulk apply shares one `batchId`.
- `UndoService.undoLast()` restores every row to its prior parked status, due date, and parkedAt.
- Stale/missing/non-parked/no-longer-due ids are skipped without mutating unrelated rows.
- All-skipped apply returns `batchId: null` and does not create an operation-log row.
- A setting-change or keep-parked race makes the affected id skip as no longer due.

Verification:
- `pnpm test -- packages/local-db/src/parked-resurfacing-service.test.ts`
- Relevant existing undo tests if touched.

### U4: Typed IPC And Renderer Client Surface

Goal: Expose the read model and apply command through the narrow typed bridge.

Files:
- Modify: `apps/desktop/src/shared/channels.ts`
- Modify: `apps/desktop/src/shared/contract.ts`
- Modify: `apps/desktop/src/main/ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.test.ts`
- Modify: `apps/web/src/lib/appApi.ts`
- Modify: `apps/web/src/lib/appApi.test.ts`

Approach:
- Add maintenance methods such as `maintenance.parkedResurfacing(request?)` and
  `maintenance.applyParkedResurfacing(request)`.
- Validate `limit` and action payloads with Zod in `contract.ts`; keep `asOf` off the production
  renderer-facing call path unless using a test-only/internal request seam.
- Keep request payloads to ids and bounded decisions (`keepParked`, `queueNow`, `letGo`); never
  expose SQL or raw persistence fields beyond the typed row summaries.
- Apply response shape is `{ applied: number, skipped: readonly { id, reason }[], batchId:
  string | null }`.
- Add `parkedResurfacingCount: 0` to the non-desktop appApi fallback and every maintenance report
  mock.

Test scenarios:
- Preload forwards the exact request payload to the expected channel.
- Renderer fallback returns empty read rows and no-op batch result outside desktop mode.
- Contract rejects unknown decision kinds or malformed ids.

Verification:
- `pnpm test -- apps/desktop/src/preload/index.test.ts apps/web/src/lib/appApi.test.ts`

### U5: Maintenance Sweep UI

Goal: Add a calm parked resurfacing card and drill-down panel with per-item and bulk actions.

Files:
- Modify: `apps/web/src/maintenance/MaintenanceScreen.tsx`
- Modify: `apps/web/src/maintenance/MaintenanceScreen.test.tsx`
- Modify: `apps/web/src/maintenance/maintenance.css`
- Modify as needed: `apps/web/src/components/Icon.tsx`
- Modify as needed: `design/icon-map.md` only if an unmapped icon is needed

Approach:
- Add a `Parked resurfacing` metric card showing count from `maintenance.report()`.
- On expand, fetch due parked rows and render a dense list with age, parked date, title, priority,
  and selection checkboxes.
- Offer a row-level segmented decision control: Keep parked, Queue now, Let go. Selection chooses
  which decided rows are included. Bulk toolbar can set one decision for all selected rows, and
  Apply is disabled until every selected row has a decision. Bulk apply submits the staged decision
  vector and acts only on selected returned ids; there is no "apply all due" command in T102.
- Use the existing Maintenance snackbar and `appApi.undoLast()` for single-batch undo.
- Show Undo only when `batchId` is non-null. For partial success, show "N applied, M skipped" and
  keep skipped rows visible with an inline reason. For all-skipped results, show an inline message
  and no Undo.
- Cover report loading, expanded-panel loading, read error with retry, apply-in-progress disabled
  controls, success row removal/count refresh, empty state, and partial-skip state.
- Keep the dense surface keyboard-accessible: labelled checkboxes, keyboard-operable segmented
  controls/buttons, visible focus states, `aria-expanded`/`aria-controls` on the metric card,
  snackbar/error live regions, and sane focus placement after expand/apply/undo.
- Keep copy calm and concrete. No modal or blocking nag.

Test scenarios:
- Count card renders from report.
- Expanding fetches and lists parked rows.
- Per-row decision calls the apply API with one decision.
- Mixed selected decisions submit the staged decision vector; all-selected quick actions set one
  decision across selected rows.
- Partial/all-skipped responses render the right message and only show Undo when a batch exists.
- Undo dispatches the shared `UNDO_EVENT` and reloads counts/drill-down.
- Empty due set shows a calm empty row.
- Errors keep the rows visible and show an inline error.
- Keyboard and ARIA behavior is covered for expand, row selection, decision controls, apply, and
  snackbar undo.

Verification:
- `pnpm test -- apps/web/src/maintenance/MaintenanceScreen.test.tsx`

### U6: Electron E2E And Documentation Updates

Goal: Prove the complete parked resurfacing story and update roadmap/task docs.

Files:
- Create: `tests/electron/parked-resurfacing.spec.ts`
- Modify as needed: `tests/electron/fixtures` or existing seed helpers
- Modify: `docs/tasks/M21-honest-exits.md`
- Modify: `docs/roadmap.md`

Approach:
- Seed the Electron test database before launch with explicit historical `parkedAt` timestamps via
  existing test helpers or a small local-db seed helper. Do not depend on production renderer
  time-travel for eligibility.
- Exercise all three verbs and undo. Include app restart for at least one applied decision.
- After implementation and verification, mark T102 complete in the roadmap and add concise
  completion notes under the task spec.

Test scenarios:
- A source parked 90+ days ago appears in Maintenance parked resurfacing.
- A source parked after the cutoff / less than the configured window ago does not appear.
- Keep parked resets the clock and removes the item from the due sweep.
- Queue now sends the source to Queue via normal due eligibility.
- Let-go dismisses the source.
- A bulk sweep applies multiple decisions under one undo; undo restores the parked rows.
- State survives Electron app restart.

Verification:
- `pnpm e2e tests/electron/parked-resurfacing.spec.ts`
- Full standard gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant `pnpm e2e`.

## Dependencies And Sequencing

1. U1 first so U2 can consume the typed default.
2. U2 before U5 so the UI card reads a real count.
3. U3 after U2 so apply validation can share the same parked-source predicates.
4. U4 after U2/U3 to expose the real API shape.
5. U5 after U4.
6. U6 last, after behavior is end-to-end complete.

## Risks

- Batch undo can silently be incomplete if schedule and status changes use different op shapes.
  Mitigation: service tests must inspect operation-log payloads and undo all three decisions.
- Renderer date math could drift from trusted eligibility. Mitigation: UI only renders dates; it
  never decides due eligibility.
- Maintenance can become a dashboard dumping ground. Mitigation: keep T102 to one metric card and
  one drill-down panel, with T110 as the future weekly host.
- Settings UI churn can distract from the task. Mitigation: typed setting is required; visible
  Settings control is useful only if it fits an existing section cleanly.

## Definition Of Done

- Parked sources past the configured window appear in a maintenance sweep.
- Nothing appears before the window.
- Keep-parked, schedule, and let-go work per item and in bulk.
- Bulk apply writes one shared `batchId` and a single undo restores the batch.
- Parked sources remain excluded from Inbox, Queue, and Daily Work until explicitly scheduled or
  moved.
- `docs/tasks/M21-honest-exits.md` and `docs/roadmap.md` record T102 completion.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and relevant Electron E2E pass.
